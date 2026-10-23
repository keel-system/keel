import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { containerOf } from './sandbox.js';
import { validateAs } from './schema.js';
import { keepHeaders, toolRequestAsync, toolRequestsParallel } from './tool-http.js';
import { normalizer } from './normalize.js';
import { NO_SNAPSHOT, dbDiff, dbHash, exportDb, hasSnapshot, restoreSnapshot } from './mongo.js';
import * as rabbit from './rabbit.js';
import * as stubs from './stubs.js';
import * as mail from './mail.js';
import { dumpRound, markRound } from './coverage-round.js';

// Paso 1b: el ejecutor de una ronda de sondas. Por sonda: restaura el snapshot de la base, vacía
// los espías, aplica el `setup`, ejecuta los pasos, espera a que el sistema esté quieto, deshace el
// setup y graba la respuesta de cada paso y los efectos (diff de la base, llamadas salientes,
// mensajes publicados y correo), normalizados.
//
// La regla que añade a la del prototipo del inc. 1: un canal de captura que no captura graba
// SILENCIO, y el silencio se lee como «el legacy no hace eso». Por eso cada canal se prueba en cada
// sonda con un CANARIO que viaja por el mismo camino que el efecto del legacy: uno al abrir la
// ventana (prueba que el canal retiene todo desde el principio) y otro al cerrarla, tras deshacer
// el setup (prueba que sigue capturando: el firehose de RabbitMQ, por ejemplo, no sobrevive a un
// reinicio). Si falta un canario, la sonda se graba igual pero marcada, y su criterio sale en rojo.
// Lo mismo con la base: tras cada restauración su huella tiene que ser la del snapshot.

export const PROBE_CRITERIA = ['PRB-VERIFY', 'PRB-CHANNELS', 'PRB-RESTORE', 'PRB-BROKER', 'PRB-STUBS', 'PRB-MAIL', 'PRB-COVERAGE'];

const criterion = (id, ok, detail, extra = {}) => ({ id, ok: Boolean(ok), detail, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lee y valida una ronda (`probes/round-N.yaml`). */
export function loadRound(file) {
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'), { merge: true });
  } catch (err) {
    return { doc: null, errors: [err.code === 'ENOENT' ? `no existe ${file}` : `no es YAML: ${err.message}`] };
  }
  const errors = validateAs('probes', doc ?? {}).map((e) => `${path.basename(file)}: ${e}`);
  const ids = (doc?.probes ?? []).map((p) => p.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`ids repetidos: ${[...new Set(dup)].join(', ')}`);
  return { doc, errors };
}

/** `verify.json` en verde, con snapshot si hay base: sin eso lo que se grabe no es comportamiento. */
export function verifyCriterion(sandbox) {
  const file = path.join(sandbox.dir, 'verify.json');
  if (!fs.existsSync(file)) return criterion('PRB-VERIFY', false, 'no hay verify.json: pasa antes keel-recover verify');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return criterion('PRB-VERIFY', false, 'verify.json no es JSON');
  }
  if (!report.ok) return criterion('PRB-VERIFY', false, `verify.json en rojo: ${report.criteria.filter((c) => !c.ok).map((c) => c.id).join(', ')}`);
  if (sandbox.spec.database && !report.snapshot?.ok) return criterion('PRB-VERIFY', false, 'verify.json no tomó el snapshot de la base');
  return criterion('PRB-VERIFY', true, `verify en verde${report.snapshot?.hash ? `, snapshot ${report.snapshot.hash}` : ''}`, { snapshotHash: report.snapshot?.hash ?? null });
}

// La clase de dependencia de environment.yaml (paso 0b) → la sección de sandbox.yaml que dice dónde
// se lee su efecto. Sin ella, la sonda grabaría silencio donde el legacy sí hace algo.
const CHANNEL_OF = { database: 'database', broker: 'broker', smtp: 'mail' };

export function channelsCriterion(sandbox) {
  const deps = sandbox.environment?.dependencies ?? [];
  const missing = [];
  for (const d of deps) {
    const section = d.provision?.via === 'wiremock' ? 'stubs' : CHANNEL_OF[d.kind];
    if (section && !sandbox.spec[section]) missing.push(`${d.kind}/${d.tech} (${d.endpoints?.[0]?.evidence ?? 'environment.yaml'}) sin \`${section}\` en sandbox.yaml`);
  }
  if (sandbox.spec.database && sandbox.spec.database.tech !== 'mongodb') missing.push(`base ${sandbox.spec.database.tech}: el diff y la restauración solo existen para mongodb`);
  return criterion('PRB-CHANNELS', missing.length === 0, missing.length ? `efectos del legacy sin canal de captura: ${missing.join('; ')}` : 'cada dependencia del legacy tiene su canal');
}

// ── plantillas {{var}} y capturas ────────────────────────────────────────────────────────────

export const fill = (v, vars) =>
  typeof v === 'string'
    ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
    : Array.isArray(v)
      ? v.map((x) => fill(x, vars))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]))
        : v;

export const pick = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/** La clave del desenlace de una sonda repetida: no depende del orden de los pasos paralelos. */
export function outcomeKey(rec, outcomeField) {
  const serial = rec.steps.filter((x) => !x.parallel).map((x) => x.response?.status ?? (x.response?.routed !== undefined ? `routed=${x.response.routed}` : '?'));
  const par = rec.steps.filter((x) => x.parallel).map((x) => x.response?.status).sort();
  const extra = outcomeField ? `|${outcomeField}=${JSON.stringify(pick(rec.steps.at(-1)?.response?.body, outcomeField))}` : '';
  return [...serial, ...(par.length ? [`{${par.join(',')}}`] : [])].join(',') + extra;
}

// ── la ronda ─────────────────────────────────────────────────────────────────────────────────

function context(sandbox, rt, options) {
  const { spec } = sandbox;
  return {
    rt,
    spec,
    tool: containerOf(sandbox, spec.tool.service),
    app: containerOf(sandbox, spec.app.service),
    db: spec.database ? containerOf(sandbox, spec.database.service) : null,
    brokerC: spec.broker ? containerOf(sandbox, spec.broker.service) : null,
    faults: options.faults ?? new Set(),
    pollMs: options.pollMs ?? 2000,
    baselineHash: options.snapshotHash ?? null,
  };
}

async function waitDb(ctx) {
  for (let i = 0; i < 60; i++) {
    if (dbHash(ctx.rt, ctx.db, ctx.spec.database.name).ok) return true;
    await sleep(ctx.pollMs);
  }
  return false;
}

async function applySetup(ctx, setup = {}, fail) {
  const undo = [];
  for (const m of setup.stubs ?? []) {
    if (!ctx.spec.stubs) {
      fail('PRB-STUBS', 'la sonda programa stubs y sandbox.yaml no declara `stubs`');
      continue;
    }
    const r = stubs.addMapping(ctx.rt, ctx.tool, ctx.spec.stubs, m);
    if (!r.ok) fail('PRB-STUBS', r.error);
    else undo.push(() => stubs.removeMapping(ctx.rt, ctx.tool, ctx.spec.stubs, r.id));
  }
  if (setup.broker === 'down') {
    if (!ctx.brokerC) fail('PRB-BROKER', 'la sonda para el broker y sandbox.yaml no declara `broker`');
    else {
      ctx.rt.stop(ctx.brokerC);
      undo.push(async () => {
        ctx.rt.start(ctx.brokerC);
        const w = await rabbit.waitBroker(ctx.rt, ctx.tool, ctx.spec.broker, { pollMs: ctx.pollMs });
        if (!w.ok) return fail('PRB-BROKER', w.error);
        const s = rabbit.ensureSpy(ctx.rt, ctx.tool, ctx.brokerC, ctx.spec.broker, { unbound: ctx.faults.has('spy-unbound') });
        if (!s.ok) fail('PRB-BROKER', s.error);
      });
    }
  }
  if (setup.db === 'down') {
    if (!ctx.db) fail('PRB-RESTORE', 'la sonda para la base y sandbox.yaml no declara `database`');
    else {
      ctx.rt.stop(ctx.db);
      undo.push(async () => {
        ctx.rt.start(ctx.db);
        if (!(await waitDb(ctx))) fail('PRB-RESTORE', 'la base no volvió tras la sonda');
      });
    }
  }
  return async () => {
    for (const f of undo.reverse()) await f();
  };
}

async function runStep(ctx, probe, step, vars, n, parallel) {
  if (step.publish) {
    const p = fill(step.publish, vars);
    const r = ctx.spec.broker
      ? rabbit.publish(ctx.rt, ctx.tool, ctx.spec.broker, { exchange: p.exchange, routingKey: p.routingKey, payload: p.payload, headers: p.headers ?? {}, messageId: `${rabbit.PROBE_ID}${probe.id}-${n}` })
      : { ok: false, error: 'sandbox.yaml no declara `broker`' };
    return { name: step.name, ...(parallel ? { parallel: true } : {}), publish: p, response: r.ok ? { routed: r.routed } : { error: r.error } };
  }
  const req = fill(step.request, vars);
  const url = /^https?:/.test(req.path) ? req.path : ctx.spec.app.base.replace(/\/$/, '') + req.path;
  const r = await toolRequestAsync(ctx.rt, ctx.tool, { method: req.method, url, headers: req.headers ?? {}, body: req.body, timeoutSeconds: req.timeout ?? 15 });
  const response = { status: r.status, _timeSeconds: r.timeSeconds, headers: keepHeaders(r.headers), body: r.body };
  for (const [k, p] of Object.entries(step.capture ?? {})) vars[k] = pick(r.body, p);
  return { name: step.name, ...(parallel ? { parallel: true } : {}), request: req, response };
}

/**
 * Los pasos de un grupo paralelo. Las peticiones salen juntas de UN curl en el contenedor de
 * herramientas (`toolRequestsParallel`): con un exec por petición llegaban en serie y ninguna carrera
 * se veía. Las publicaciones al broker van a la vez por su propio canal. El fallo `parallel-exec`
 * vuelve al exec por paso: es el sabotaje de probe-check que prueba que la diferencia se mide.
 */
async function runParallel(ctx, probe, list, vars, base) {
  if (ctx.faults.has('parallel-exec')) return Promise.all(list.map((s, i) => runStep(ctx, probe, s, vars, base + i + 1, true)));
  const http = list.map((s, i) => ({ s, i })).filter(({ s }) => !s.publish);
  const reqs = http.map(({ s }) => {
    const req = fill(s.request, vars);
    const url = /^https?:/.test(req.path) ? req.path : ctx.spec.app.base.replace(/\/$/, '') + req.path;
    return { req, wire: { method: req.method, url, headers: req.headers ?? {}, body: req.body, timeoutSeconds: req.timeout ?? 15 } };
  });
  const [responses, ...published] = await Promise.all([
    reqs.length ? toolRequestsParallel(ctx.rt, ctx.tool, reqs.map((r) => r.wire)) : [],
    ...list.map((s, i) => (s.publish ? runStep(ctx, probe, s, vars, base + i + 1, true) : null)),
  ]);
  const out = list.map((s, i) => published[i]);
  http.forEach(({ s, i }, k) => {
    const r = responses[k];
    for (const [key, p] of Object.entries(s.capture ?? {})) vars[key] = pick(r.body, p);
    out[i] = { name: s.name, parallel: true, request: reqs[k].req, response: { status: r.status, _timeSeconds: r.timeSeconds, headers: keepHeaders(r.headers), body: r.body } };
  });
  return out;
}

/** Una ejecución de una sonda: `{ rec, failures }`, sin normalizar. */
export async function runProbe(ctx, probe, roundVars, tag) {
  const { rt, spec, tool } = ctx;
  const failures = {};
  const fail = (id, detail) => {
    (failures[id] ??= []).push(detail);
  };
  const open = `${tag}-${probe.id}-open`;
  const close = `${tag}-${probe.id}-close`;
  const brokerDown = probe.setup?.broker === 'down';

  // 1. la base, al snapshot, y su huella comprobada
  if (ctx.db) {
    const r = restoreSnapshot(rt, ctx.db, spec.database.name);
    if (!r.ok) fail('PRB-RESTORE', `no se pudo restaurar el snapshot: ${r.error}`);
    else {
      const h = dbHash(rt, ctx.db, spec.database.name);
      if (!h.ok) fail('PRB-RESTORE', h.error);
      else if (ctx.baselineHash === null) ctx.baselineHash = h.value;
      else if (h.value !== ctx.baselineHash) fail('PRB-RESTORE', `la base restaurada (${h.value}) no es la del snapshot (${ctx.baselineHash})`);
    }
  }
  // 2. los espías, vacíos, y el canario de apertura
  if (spec.stubs) {
    const r = stubs.resetJournal(rt, tool, spec.stubs);
    if (!r.ok) fail('PRB-STUBS', r.error);
    stubs.sendCanary(rt, tool, spec.stubs, open);
  }
  if (spec.broker) {
    const r = rabbit.purgeSpy(rt, tool, spec.broker);
    if (!r.ok) fail('PRB-BROKER', r.error);
    const c = rabbit.publishCanary(rt, tool, spec.broker, open);
    if (!c.ok) fail('PRB-BROKER', c.error);
  }
  if (spec.mail) {
    const r = mail.clearMail(rt, tool, spec.mail);
    if (!r.ok) fail('PRB-MAIL', r.error);
    const c = mail.sendCanary(rt, tool, spec.mail, open);
    if (!c.ok) fail('PRB-MAIL', c.error);
  }

  // 3. la base de antes, el setup y los pasos
  const before = ctx.db ? exportDb(rt, ctx.db, spec.database.name) : null;
  if (before && !before.ok) fail('PRB-RESTORE', `no se pudo exportar la base: ${before.error}`);
  const teardown = await applySetup(ctx, probe.setup, fail);
  const vars = { ...roundVars, ...(probe.vars ?? {}) };
  const steps = [];
  let n = 0;
  try {
    const serial = async (list) => {
      for (const s of list ?? []) steps.push(await runStep(ctx, probe, s, vars, ++n, false));
    };
    const parallel = async (list) => {
      const base = n;
      n += list.length;
      steps.push(...(await runParallel(ctx, probe, list, vars, base)));
    };
    if (probe.parallel) await parallel(probe.steps);
    else await serial(probe.steps);
    if (probe.then_parallel?.length) await parallel(probe.then_parallel);
    await serial(probe.after);
    await sleep(probe.settleMs ?? spec.probe?.settle_ms ?? 1500);
  } finally {
    // 4. primero se deshace el setup: los efectos se leen con el sistema otra vez entero
    await teardown();
  }

  // 5. canario de cierre y lectura de los efectos
  const effects = {};
  if (spec.stubs) {
    const tags = [...(stubs.canaryTags(spec.stubs, open)), ...stubs.sendCanary(rt, tool, spec.stubs, close)];
    const j = stubs.readJournal(rt, tool, spec.stubs);
    if (!j.ok) fail('PRB-STUBS', j.error);
    else {
      const seen = new Set(j.value.filter((e) => e.canary).map((e) => e.canary));
      const lost = tags.filter((t) => !seen.has(t));
      if (lost.length) fail('PRB-STUBS', `canario sin llegar al diario: ${lost.join(', ')}`);
      effects.outbound = j.value.filter((e) => !e.canary);
    }
  }
  if (spec.broker) {
    const c = rabbit.publishCanary(rt, tool, spec.broker, close);
    if (!c.ok) fail('PRB-BROKER', c.error);
    await sleep(200);
    const s = rabbit.readSpy(rt, tool, spec.broker);
    if (!s.ok) fail('PRB-BROKER', s.error);
    else {
      const seen = new Set(s.value.filter((m) => m.origin === 'canary').map((m) => String(m.properties.message_id).slice(rabbit.CANARY_ID.length)));
      const expected = brokerDown ? [close] : [open, close];
      const lost = expected.filter((t) => !seen.has(t));
      if (lost.length) fail('PRB-BROKER', `canario sin llegar a la cola espía: ${lost.join(', ')}`);
      effects.messages = s.value.filter((m) => m.origin !== 'canary');
    }
  }
  if (spec.mail) {
    const c = mail.sendCanary(rt, tool, spec.mail, close);
    if (!c.ok) fail('PRB-MAIL', c.error);
    await sleep(200);
    const m = mail.readMail(rt, tool, spec.mail);
    if (!m.ok) fail('PRB-MAIL', m.error);
    else {
      const seen = new Set(m.value.filter((x) => x.canary).map((x) => x.canary));
      const lost = [open, close].filter((t) => !seen.has(t));
      if (lost.length) fail('PRB-MAIL', `canario sin llegar al buzón: ${lost.join(', ')}`);
      effects.mail = m.value.filter((x) => !x.canary);
    }
  }
  if (ctx.db) {
    const after = exportDb(rt, ctx.db, spec.database.name);
    if (!after.ok) fail('PRB-RESTORE', `no se pudo exportar la base: ${after.error}`);
    else if (before?.ok) effects.db = dbDiff(before.value, after.value);
  }

  const rec = { id: probe.id, class: probe.class ?? 'basic', why: probe.why, ...(probe.setup ? { setup: probe.setup } : {}), steps, effects };
  return { rec, failures };
}

/**
 * Una ronda entera. `{ ok, criteria, recordings: [{ id, recording }], coverage }`. Las grabaciones
 * salen aunque algún canal falle: van marcadas (`untrusted`) y la ronda en rojo.
 */
export async function runRound(sandbox, rt, round, { tag, only = null, faults, log = () => {}, pollMs, previous = null } = {}) {
  const report = { kind: 'probe-round', schema: 1, round: tag, ok: false, criteria: [], probes: [] };
  const v = verifyCriterion(sandbox);
  const ch = channelsCriterion(sandbox);
  report.criteria.push(v, ch);
  if (!v.ok || !ch.ok) {
    for (const id of PROBE_CRITERIA.slice(2)) report.criteria.push(criterion(id, false, 'no se ejecutó: el sandbox no está listo para sondear', { skipped: true }));
    return { ...report, recordings: [] };
  }
  const ctx = context(sandbox, rt, { faults, pollMs, snapshotHash: v.snapshotHash });
  const { spec } = sandbox;
  // Sin snapshot, ninguna sonda puede partir del estado de verify: se dice una vez, en el criterio de verify.
  if (ctx.db && !hasSnapshot(rt, ctx.db)) {
    report.criteria[0] = criterion(v.id, false, NO_SNAPSHOT(ctx.db, path.relative(process.cwd(), sandbox.dir).replace(/\\/g, '/')));
    for (const id of PROBE_CRITERIA.slice(2)) report.criteria.push(criterion(id, false, 'no se ejecutó: el sandbox no está listo para sondear', { skipped: true }));
    return { ...report, recordings: [] };
  }
  const failures = {};
  const note = (probeId, f) => {
    for (const [id, list] of Object.entries(f)) for (const d of list) (failures[id] ??= []).push(`${probeId}: ${d}`);
  };

  if (spec.broker) {
    const s = rabbit.ensureSpy(rt, ctx.tool, ctx.brokerC, spec.broker, { unbound: ctx.faults.has('spy-unbound') });
    if (!s.ok) note('ronda', { 'PRB-BROKER': [s.error] });
  }
  const mark = markRound(rt, sandbox, tag);
  if (!mark.ok) note('ronda', { 'PRB-COVERAGE': [mark.error] });

  const norm = (x) => normalizer(spec.probe?.normalize ?? [])(x);
  const recordings = [];
  const roundVars = Object.fromEntries(Object.entries(round.vars ?? {}).filter(([, x]) => x === null || typeof x !== 'object'));
  for (const probe of round.probes) {
    if (only && !only.has(probe.id)) continue;
    const first = await runProbe(ctx, probe, roundVars, tag);
    note(probe.id, first.failures);
    const untrusted = Object.keys(first.failures);
    const rec = norm(first.rec);
    if ((probe.repeat ?? 1) > 1) {
      const outcomes = { [outcomeKey(first.rec, probe.outcome)]: 1 };
      for (let i = 1; i < probe.repeat; i++) {
        const again = await runProbe(ctx, probe, roundVars, `${tag}-r${i + 1}`);
        note(probe.id, again.failures);
        untrusted.push(...Object.keys(again.failures));
        const k = outcomeKey(again.rec, probe.outcome);
        outcomes[k] = (outcomes[k] ?? 0) + 1;
      }
      rec.outcomes = Object.fromEntries(Object.entries(outcomes).sort());
    }
    if (untrusted.length) rec.untrusted = [...new Set(untrusted)].sort();
    recordings.push({ id: probe.id, recording: rec });
    report.probes.push(summarize(rec));
    log(summarize(rec));
  }

  const cov = await dumpRound(rt, sandbox, tag, { pollMs: ctx.pollMs });
  if (cov.ok) {
    report.coverage = { unit: cov.cumulative.unit, round: pickCov(cov.round), cumulative: pickCov(cov.cumulative) };
    if (previous) {
      report.coverage.delta = cov.cumulative.covered - previous.covered;
      report.coverage.stalled = report.coverage.delta <= 0;
    }
    report.uncovered = cov.uncovered;
  }

  const covFailure = !cov.ok ? cov.error : cov.round.covered > 0 ? null : `${spec.coverage.kind}: la ronda no grabó nada del código de la app (el acumulado, ${cov.cumulative.covered}/${cov.cumulative.total}, es de antes): el medidor dejó de grabar`;
  const counted = recordings.length;
  const detailOk = {
    'PRB-RESTORE': ctx.db ? `${counted} sonda(s) desde el snapshot ${ctx.baselineHash}` : 'el legacy no tiene base',
    'PRB-BROKER': spec.broker ? `los canarios de ${counted} sonda(s) llegaron a la cola espía` : 'sin broker en sandbox.yaml',
    'PRB-STUBS': spec.stubs ? `los canarios de ${counted} sonda(s) llegaron al diario de WireMock` : 'sin stubs en sandbox.yaml',
    'PRB-MAIL': spec.mail ? `los canarios de ${counted} sonda(s) llegaron al buzón` : 'sin correo en sandbox.yaml',
  };
  for (const id of ['PRB-RESTORE', 'PRB-BROKER', 'PRB-STUBS', 'PRB-MAIL']) {
    const f = failures[id];
    report.criteria.push(criterion(id, !f, f ? `${f.length} fallo(s): ${f.slice(0, 3).join(' · ')}${f.length > 3 ? ' …' : ''}` : detailOk[id]));
  }
  if (failures['PRB-COVERAGE'] || covFailure) report.criteria.push(criterion('PRB-COVERAGE', false, [...(failures['PRB-COVERAGE'] ?? []), covFailure].filter(Boolean).join(' · ')));
  else report.criteria.push(criterion('PRB-COVERAGE', true, `ronda ${cov.round.covered}/${cov.round.total}, acumulado ${cov.cumulative.covered}/${cov.cumulative.total} ${cov.cumulative.unit}${report.coverage.delta !== undefined ? ` (${report.coverage.delta >= 0 ? '+' : ''}${report.coverage.delta} sobre la ronda anterior${report.coverage.stalled ? ': estancada' : ''})` : ''}`));

  report.ok = report.criteria.every((c) => c.ok);
  return { ...report, recordings };
}

const pickCov = (c) => ({ covered: c.covered, total: c.total, files: c.files });

/** Una línea por sonda: estados de los pasos y recuento de efectos. */
export function summarize(rec) {
  const codes = rec.steps.map((s) => s.response?.status ?? (s.response?.routed !== undefined ? `pub` : '?')).join(',');
  const e = rec.effects ?? {};
  const db = e.db ? Object.entries(e.db).map(([c, d]) => `${c}+${d.added.length}~${d.changed.length}-${d.removed.length}`) : [];
  const parts = [...db];
  if (e.outbound) parts.push(`out:${e.outbound.length}`);
  if (e.messages) parts.push(`msg:${e.messages.filter((m) => m.origin === 'legacy').length}`);
  if (e.mail) parts.push(`mail:${e.mail.length}`);
  return { id: rec.id, class: rec.class, codes, effects: parts.join(' '), ...(rec.outcomes ? { outcomes: rec.outcomes } : {}), ...(rec.untrusted ? { untrusted: rec.untrusted } : {}) };
}
