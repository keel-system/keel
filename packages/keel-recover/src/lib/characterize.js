import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import { EXECUTED_MARKS, conventionsDigest, flowDigests, scenarioBody, scenarioIdOf, splitScenarioBlocks } from 'keel-core';
import { validateAs } from './schema.js';

// Paso 5: los escenarios de caracterización, ejecutados contra el legacy en marcha (prototipo:
// tools/flows.mjs del inc. 1). Cada flujo keep, fix o frontier de validation-scenarios.md lleva sus
// pasos en un bloque ```keel-flow```, en operaciones del DISEÑO; contract-map.yaml los traduce a las
// rutas, envolturas y credenciales del legacy. Por flujo: se restaura el estado de partida, se obtienen
// las credenciales de los actores, se ejecutan los pasos y se comprueba cada expectativa.
//
// Qué se comprueba según la marca: un `keep` y un `frontier`, lo que el escenario afirma (`expect`); un
// `fix`, lo que hace el legacy hoy (`legacy`), porque un fix describe un cambio real solo si el defecto
// sigue ahí. Los `new` no existen en el legacy y no se ejecutan.
//
// Dos reglas medidas en el inc. 1. (1) Un paso sin expectativa no es un paso sin comprobar: la colección
// Postman de RealWorld «pasaba» con un 500 dentro de una petición sin aserciones, así que todo paso
// sin `expect` sale en rojo con un 5xx. (2) Un flujo que no afirma nada no demuestra nada.
//
// Lo que sale es el sello de keel-core (characterized.yaml): cada flujo con el sha256 de su bloque, el
// mismo del careo, porque el bloque ```keel-flow``` vive DENTRO del flujo y el sello cubre lo ejecutado.

const FENCE_OPEN = /^```keel-flow[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;

/**
 * El bloque ```keel-flow``` de un flujo: `{ flow, error }`. Se lee del cuerpo que sella keel-core
 * (`scenarioBody`), no del bloque entero: lo que no entra en el sello no puede ejecutarse.
 */
export function readFlowBlock(block) {
  const lines = scenarioBody(block).split('\n');
  const opens = lines.flatMap((line, i) => (FENCE_OPEN.test(line) ? [i] : []));
  if (opens.length === 0) return { flow: null, error: 'no trae su bloque ```keel-flow``` con los pasos ejecutables' };
  if (opens.length > 1) return { flow: null, error: 'trae más de un bloque ```keel-flow```' };
  const close = lines.findIndex((line, i) => i > opens[0] && FENCE_CLOSE.test(line));
  if (close < 0) {
    // scenarioBody corta en el primer encabezado: un comentario YAML en la columna 0 («# …») lo es.
    const cut = /^#{1,4}\s/m.test(block.slice(block.indexOf('```keel-flow')));
    return { flow: null, error: cut ? 'el bloque ```keel-flow``` tiene una línea que empieza por «# »: corta el flujo (y su sello); sangra el comentario' : 'el bloque ```keel-flow``` no se cierra' };
  }
  let flow;
  try {
    flow = YAML.parse(lines.slice(opens[0] + 1, close).join('\n'));
  } catch (err) {
    return { flow: null, error: `el bloque \`\`\`keel-flow\`\`\` no es YAML: ${err.message.split('\n')[0]}` };
  }
  const errors = validateAs('flow', flow ?? {});
  return errors.length ? { flow: null, error: `el bloque \`\`\`keel-flow\`\`\`: ${errors.join('; ')}` } : { flow, error: null };
}

/** Lee y valida contract-map.yaml: `{ map, errors }`. */
export function loadContractMap(file) {
  let map;
  try {
    map = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { map: null, errors: [err.code === 'ENOENT' ? `no existe ${file}` : `contract-map.yaml no es YAML: ${err.message}`] };
  }
  const errors = validateAs('contract-map', map ?? {}).map((e) => `contract-map.yaml: ${e}`);
  return { map: errors.length ? null : map, errors };
}

/**
 * Los flujos que se ejecutan contra el legacy, con su marca (las del paso 4, que lee keel-core) y su
 * bloque ejecutable. `marked` es provenance.characterization.flows.
 */
export function plannedFlows(scenariosText, marked, { marks = EXECUTED_MARKS } = {}) {
  const markOf = new Map(marked.map((flow) => [flow.id, flow]));
  const digests = new Map(flowDigests(scenariosText).map((entry) => [entry.id, entry.digest]));
  const out = [];
  for (const block of splitScenarioBlocks(scenariosText)) {
    const id = scenarioIdOf(block);
    const marking = markOf.get(id);
    if (!marking || !marks.includes(marking.mark)) continue;
    const { flow, error } = readFlowBlock(block);
    out.push({ id, mark: marking.mark, ref: marking.ref, sha256: digests.get(id), flow, error });
  }
  return out;
}

// ── plantillas, rutas y comparación ───────────────────────────────────────────────────────────

/** `{{var}}` con lo guardado; lo que no está se deja tal cual, para que el fallo lo nombre. */
export const fill = (v, vars) =>
  typeof v === 'string'
    ? v.replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] === undefined || vars[k] === null ? all : String(vars[k])))
    : Array.isArray(v)
      ? v.map((x) => fill(x, vars))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]))
        : v;

/** Ruta con puntos; `length` de una lista es su tamaño. */
export const pick = (obj, p) =>
  p === '' ? obj : String(p).split('.').reduce((o, k) => (o == null ? undefined : k === 'length' && Array.isArray(o) ? o.length : o[k]), obj);

function matches(actual, expected, absentIsNull) {
  if (expected === null) return actual === null || (absentIsNull && actual === undefined);
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('startsWith' in expected) return typeof actual === 'string' && actual.startsWith(expected.startsWith);
    if ('sameMembers' in expected) {
      // Un miembro objeto casa por los campos que afirma: el mismo flujo sirve al legacy y al regenerado,
      // que añade lo suyo (el id del recurso). Los escalares, enteros.
      const member = (x, y) =>
        x && typeof x === 'object' && !Array.isArray(x) && y && typeof y === 'object'
          ? Object.entries(x).every(([k, v]) => JSON.stringify(y[k]) === JSON.stringify(v))
          : JSON.stringify(y) === JSON.stringify(x);
      const used = new Set();
      return (
        Array.isArray(actual) &&
        actual.length === expected.sameMembers.length &&
        expected.sameMembers.every((x) => {
          const i = actual.findIndex((y, n) => !used.has(n) && member(x, y));
          if (i < 0) return false;
          used.add(i);
          return true;
        })
      );
    }
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Los fallos de una expectativa sobre una respuesta ya traducida. */
export function check(expectation, res, { side, semantics = {} }) {
  const fails = [];
  const statusOf = (s) => (typeof s === 'number' ? s : side.statusClasses?.[s]);
  if (expectation.status !== undefined) {
    const want = statusOf(expectation.status);
    if (want === undefined) fails.push(`la clase de status «${expectation.status}» no tiene valor en contract-map.yaml`);
    else if (res.status !== want) fails.push(`status ${res.status}, se esperaba ${want}${typeof expectation.status === 'string' ? ` (${expectation.status})` : ''}`);
  }
  if (expectation.code && side.errorCode) {
    const got = pick(res.raw, side.errorCode);
    if (got !== expectation.code) fails.push(`code ${JSON.stringify(got)}, se esperaba ${expectation.code}`);
  }
  for (const [p, v] of Object.entries(expectation.body ?? {})) {
    const got = pick(res.data, p);
    if (!matches(got, v, semantics.absentIsNull)) fails.push(`${p} = ${JSON.stringify(got)}, se esperaba ${JSON.stringify(v)}`);
  }
  return fails;
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Un JWT HS256 con el secreto de desarrollo del repo: token válido de alguien que no existe. */
export function forgeToken(secret, claims) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(claims);
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

// ── la ejecución ──────────────────────────────────────────────────────────────────────────────

/**
 * Un paso, traducido al lado: la petición y los DATOS de la respuesta en la forma del diseño (el
 * recurso, la página como `{ items, totalElements }` o la lista como `{ items }`).
 */
async function call(ctx, step, vars, tokens) {
  const m = ctx.side.operations[step.op];
  if (!m) throw new Error(`la operación ${step.op} no está en contract-map.yaml → ${ctx.sideName}.operations`);
  const params = fill(step.params ?? {}, vars);
  let url = ctx.base.replace(/\/$/, '') + m.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? `{${k}}`));
  const query = fill(step.query ?? {}, vars);
  if (Object.keys(query).length) url += `?${new URLSearchParams(query).toString()}`;
  let input = fill(step.input, vars);
  if (input !== undefined && m.extraInput && input && typeof input === 'object') input = { ...fill(m.extraInput, input), ...input };
  if (m.unwrap && input && typeof input === 'object') input = input[m.unwrap];
  const body = input === undefined ? (['POST', 'PUT', 'PATCH'].includes(m.method) ? (m.wrap ? { [m.wrap]: {} } : {}) : undefined) : m.wrap ? { [m.wrap]: input } : input;
  const headers = {};
  if (step.as) {
    if (!(step.as in tokens)) throw new Error(`el actor ${step.as} no está en \`actors\` del flujo`);
    if (tokens[step.as] !== null) {
      // una sesión por cookie (Spring Session, express-session): la credencial del actor es el valor de su cookie
      if (ctx.side.auth?.cookie) headers.Cookie = `${ctx.side.auth.cookie}=${tokens[step.as]}`;
      else {
        const scheme = ctx.side.auth?.scheme ?? 'Bearer';
        headers[ctx.side.auth?.header ?? 'Authorization'] = scheme ? `${scheme} ${tokens[step.as]}` : tokens[step.as];
      }
    }
  }
  const res = await ctx.http({ method: m.method, url, headers, body });
  // Un login que renueva la sesión (o un logout que la borra) cambia la cookie del actor para los pasos siguientes.
  if (step.as && ctx.side.auth?.cookie && ctx.side.auth.cookie in (res.cookies ?? {})) tokens[step.as] = res.cookies[ctx.side.auth.cookie] ?? '';
  let data = res.body;
  // Un cuerpo desnudo del lado (`true`, una lista) donde el diseño tiene un objeto: `resultAs` lo pone en su campo.
  if (m.resultAs && res.status > 0 && res.status < 300) data = { [m.resultAs]: data };
  else if (res.status > 0 && res.status < 300 && data && typeof data === 'object') {
    if (m.result) data = pick(data, m.result);
    else if (m.page) data = { items: pick(data, m.page.items), totalElements: pick(data, m.page.total) };
    else if (m.list !== undefined) data = { items: pick(data, m.list) };
  }
  return { request: { method: m.method, url, ...(body !== undefined ? { body } : {}) }, status: res.status, raw: res.body, data, cookies: res.cookies ?? {} };
}

/** La credencial que trae el resultado de una operación: una ruta de sus datos, o `cookie:<nombre>` (la que fija la respuesta). */
const credentialFrom = (r, path) => (String(path).startsWith('cookie:') ? r.cookies[String(path).slice(7)] : pick(r.data, path));

async function credentials(ctx, flow, vars) {
  const tokens = {};
  for (const [actor, kind] of Object.entries(flow.actors ?? {})) {
    const how = ctx.side.actors?.[kind];
    if (!how) throw new Error(`la clase de actor «${kind}» (${actor}) no está en contract-map.yaml → ${ctx.sideName}.actors`);
    if (how.via === 'none') tokens[actor] = null;
    else if (how.via === 'forge') tokens[actor] = forgeToken(how.secret, fill(how.claims, { actor, random: ctx.random() }));
    else if (how.via === 'idp') {
      if (!ctx.idpToken) throw new Error(`la clase de actor «${kind}» pide un token del proveedor OIDC y el destino no declara \`idp\``);
      tokens[actor] = await ctx.idpToken(actor, how);
    } else {
      const r = await call(ctx, { op: how.op, input: fill(how.input, { actor }) }, vars, tokens);
      const token = credentialFrom(r, how.token);
      if (r.status >= 300 || typeof token !== 'string') {
        throw new Error(`no se obtuvo la credencial de ${actor} con ${how.op}: status ${r.status}, ${JSON.stringify(r.raw).slice(0, 160)}`);
      }
      tokens[actor] = token;
    }
    if (how.setup) {
      const r = await call(ctx, { op: how.setup.op, as: actor, input: fill(how.setup.input, { actor }) }, vars, tokens);
      if (r.status === 0 || r.status >= 300) throw new Error(`no se pudo preparar a ${actor} con ${how.setup.op}: status ${r.status}, ${JSON.stringify(r.raw).slice(0, 160)}`);
    }
  }
  return tokens;
}

/** Qué expectativa vale en un paso: contra el legacy, un fix comprueba su `legacy:`. */
const expectationOf = (planned, step, sideName) => (sideName === 'legacy' && planned.mark === 'fix' && step.legacy ? step.legacy : step.expect);

/** Errores que impiden ejecutar el flujo, antes de tocar el lado. */
export function flowDefects(planned, sideName = 'legacy') {
  if (planned.error) return [planned.error];
  const steps = planned.flow.steps;
  if (planned.mark === 'fix' && !steps.some((s) => s.legacy)) {
    return ['es un fix y ningún paso dice qué hace el legacy (`legacy:`): no demuestra que el defecto exista'];
  }
  if (planned.mark !== 'fix' && steps.some((s) => s.legacy)) return [`es ${planned.mark} y trae \`legacy:\`, que solo tiene sentido en un fix`];
  if (!steps.some((s) => expectationOf(planned, s, sideName))) return ['ningún paso afirma nada (`expect`): un flujo sin expectativas no demuestra nada'];
  // Una hipótesis sin expectativa del lado legacy no dice qué se supone: no hay nada que confirmar ni que refutar.
  const empty = steps.findIndex((s) => s.hypothesis && !expectationOf(planned, s, 'legacy'));
  if (empty >= 0) return [`paso ${empty + 1} (${steps[empty].op}): marca una hipótesis (${steps[empty].hypothesis}) y no dice qué espera del legacy`];
  return [];
}

/**
 * Ejecuta un flujo planificado contra un lado. `ctx` = `{ side, sideName, semantics, base, http,
 * reset, random, idpToken? }`: `http({ method, url, headers, body })` → `{ status, body }` y `reset()` →
 * `{ ok, error }` vienen de fuera, para poder falsar el comprobador sin contenedores.
 */
export async function runFlow(ctx, planned) {
  const record = { id: planned.id, mark: planned.mark, ...(planned.ref ? { ref: planned.ref } : {}), sha256: planned.sha256, ok: false, failures: [], steps: [], hypotheses: { confirmed: [], refuted: [] } };
  const defects = flowDefects(planned, ctx.sideName);
  if (defects.length) {
    record.failures.push(...defects);
    return record;
  }
  const reset = await ctx.reset();
  if (!reset.ok) {
    record.failures.push(`no se pudo restaurar el estado de partida: ${reset.error}`);
    return record;
  }
  const vars = {};
  try {
    const tokens = await credentials(ctx, planned.flow, vars);
    for (const [i, step] of planned.flow.steps.entries()) {
      const res = await call(ctx, step, vars, tokens);
      for (const [k, p] of Object.entries(step.save ?? {})) vars[k] = pick(res.data, p);
      const expectation = expectationOf(planned, step, ctx.sideName);
      const fails = expectation
        ? check(fill(expectation, vars), res, { side: ctx.side, semantics: ctx.semantics })
        : res.status === 0 || res.status >= 500
          ? [`status ${res.status || 'sin respuesta'} en un paso sin expectativa`]
          : [];
      // Contra el legacy, una expectativa leída del código (`hypothesis`) se confirma o se refuta: refutada, el flujo sigue
      // en rojo —el diseño dice algo que el legacy no hace—, pero el motivo lo dice y trae lo que el legacy hizo de verdad.
      const hypothesis = ctx.sideName === 'legacy' && expectation ? step.hypothesis : null;
      if (hypothesis && fails.length) {
        record.hypotheses.refuted.push({ step: i + 1, op: step.op, at: hypothesis, observed: { status: res.status, data: res.data } });
        record.failures.push(...fails.map((f) => `paso ${i + 1} (${step.op}): hipótesis refutada (${hypothesis}): ${f}`));
      } else {
        if (hypothesis) record.hypotheses.confirmed.push({ step: i + 1, op: step.op, at: hypothesis });
        record.failures.push(...fails.map((f) => `paso ${i + 1} (${step.op}): ${f}`));
      }
      // Los datos se guardan siempre: la paridad del paso 7 compara todo, no solo lo afirmado.
      record.steps.push({ op: step.op, ...(step.as ? { as: step.as } : {}), request: res.request, status: res.status, data: res.data, ...(fails.length ? { raw: res.raw, fails } : {}) });
    }
  } catch (err) {
    record.failures.push(err.message);
  }
  record.ok = record.failures.length === 0;
  return record;
}

/** Todos los flujos, en orden. `log(record)` por flujo. */
export async function runCharacterization(ctx, planned, { log = () => {} } = {}) {
  const records = [];
  for (const p of planned) {
    const record = await runFlow(ctx, p);
    records.push(record);
    log(record);
  }
  return records;
}

/** Cuántos de cada marca, y cuántos en verde. */
export function tally(records, marks = EXECUTED_MARKS) {
  const out = {};
  for (const mark of marks) {
    const of = records.filter((r) => r.mark === mark);
    out[mark] = { ok: of.filter((r) => r.ok).length, total: of.length };
  }
  return out;
}

/** Las hipótesis (expectativas leídas del código) de todos los flujos: cuántas confirmó el legacy y cuáles refutó. */
export function hypothesisTally(records) {
  const refuted = records.flatMap((r) => (r.hypotheses?.refuted ?? []).map((h) => ({ id: r.id, ...h })));
  const confirmed = records.reduce((n, r) => n + (r.hypotheses?.confirmed?.length ?? 0), 0);
  return { confirmed, refuted };
}

/** El documento characterized.yaml que lee el criterio `characterized` de keel-core. */
export function sealDocument({ legacy, scenariosText, records }) {
  return {
    kind: 'characterized',
    schema: 1,
    legacy: Object.fromEntries(Object.entries(legacy).filter(([, v]) => v)),
    conventionsSha256: conventionsDigest(scenariosText),
    flows: records.map((r) => ({ id: r.id, mark: r.mark, sha256: r.sha256, ok: r.ok, ...(r.ok ? {} : { failures: r.failures }) }))
  };
}
