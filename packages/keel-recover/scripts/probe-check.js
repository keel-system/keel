#!/usr/bin/env node
// probe-check: la puerta del incremento 4. `keel-recover introspect` y `probe` contra un sandbox
// REAL del legacy de fixture (fixtures/sandbox/node-effects: Express + MongoDB + RabbitMQ + un
// tercero HTTP en WireMock + correo en Mailpit, cobertura V8).
//
// En verde, la superficie trae las rutas del router montado, la colección y el exchange, y la ronda
// graba CADA efecto donde la fixture lo produce (la puerta sabe qué hace cada sonda). Después, un
// sabotaje por canal de captura, conservando su forma, y la ronda tiene que salir en rojo con
// EXACTAMENTE el criterio de ese canal, en vez de grabar silencio:
//
//   spy-unbound     la cola espía existe pero sin enlace al firehose        → PRB-BROKER
//   journal-off     WireMock arranca con --no-request-journal               → PRB-STUBS
//   mail-wrong-box  sandbox.yaml lee un Mailpit que no es al que envía el
//                   legacy (los dos existen y responden)                    → PRB-MAIL
//   snapshot-gone   el archivo del snapshot desaparece tras verify: la ronda
//                   lo dice una vez, antes de la primera sonda (inc. 9)    → PRB-VERIFY
//   coverage-off    tras verify, la app se reinicia sin la precarga que convierte
//                   SIGTERM en una salida ordenada (inc. 3): Node deja de
//                   escribir la cobertura, y el acumulado de antes sigue ahí → PRB-COVERAGE
//
// Y uno que no es de un canal sino de la concurrencia: la carrera de P-007 (dos cancelaciones de un
// pedido que la fixture lee, comprueba y escribe sin bloqueo) solo se ve si las dos peticiones llegan
// juntas. En verde salen de un solo curl y la carrera aparece; con el fallo parallel-exec (un exec
// por petición, como antes) llegan en serie y deja de verse. Sin este sabotaje, una sonda de
// concurrencia que nunca ve la carrera pasaría por buena (medido en shop-api: 10/10 un desenlace).
//
//   parallel-exec   los pasos paralelos vuelven a un exec por petición     → la carrera de P-007 no se ve
//
// En verde, además, dos ejecuciones de las mismas sondas graban lo mismo una vez normalizado.
//
//   npm run probe-check --workspace packages/keel-recover [-- --only=<id>] [-- --keep]
//
// Necesita podman o docker, y red para construir la imagen y bajar las de los servicios.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderDoc } from '../src/lib/emit.js';
import { fingerprint } from '../src/lib/fingerprint.js';
import { envDeps } from '../src/lib/env-deps.js';
import { loadSandbox } from '../src/lib/sandbox.js';
import { containerRuntime, resolveRuntime } from '../src/lib/containers.js';
import { verify, waitReady } from '../src/lib/verify.js';
import { introspect, mergeSurface } from '../src/lib/introspect.js';
import { loadRound, runRound } from '../src/lib/probe.js';
import { SNAPSHOT_ARCHIVE } from '../src/lib/db/mongodb.js';
import { comparable } from '../src/lib/normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const fixture = path.join(pkgRoot, 'fixtures', 'sandbox', 'node-effects');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const keep = process.argv.includes('--keep');

const runtime = resolveRuntime();
if (!runtime) {
  console.error('probe-check necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);
const PROJECT = 'rec-effects';

// En los sabotajes basta con las sondas que tocan todos los canales.
const SABOTAGE_PROBES = new Set(['P-001', 'P-002']);
// Las que no dependen del azar de una carrera: su grabación normalizada se repite byte a byte.
const REPEATABLE = new Set(['P-002', 'P-004', 'P-005', 'P-006']);
const SCENARIOS = [
  { id: 'base', red: [] },
  { id: 'spy-unbound', red: ['PRB-BROKER'], faults: ['spy-unbound'] },
  {
    id: 'journal-off',
    red: ['PRB-STUBS'],
    compose: (c) => {
      c.services.payment.command = ['--no-request-journal'];
    },
  },
  {
    id: 'mail-wrong-box',
    red: ['PRB-MAIL'],
    compose: (c) => {
      c.services['mail-b'] = { ...c.services.mail, container_name: 'rec-effects-mail-b', networks: { sandbox: { aliases: ['mail-b'] } } };
    },
    sandbox: (s) => {
      s.mail.service = 'mail-b';
      s.mail.api = 'http://mail-b:8025/api/v1';
    },
  },
  {
    id: 'snapshot-gone',
    red: ['PRB-VERIFY'],
    expect: (report) => [['PRB-VERIFY dice que falta el snapshot', /no hay snapshot en rec-effects-db/.test(report.criteria.find((c) => c.id === 'PRB-VERIFY')?.detail ?? '')]],
    afterVerify: async () => rt.exec('rec-effects-db', ['rm', '-f', SNAPSHOT_ARCHIVE]),
  },
  { id: 'parallel-exec', red: [], faults: ['parallel-exec'], only: new Set(['P-007']), expect: (report) => [raceCheck(report, false)] },
  {
    id: 'coverage-off',
    red: ['PRB-COVERAGE'],
    afterVerify: async (sandbox) => {
      fs.writeFileSync(path.join(work, 'sandbox', 'instrument', 'v8-coverage-exit.cjs'), '// saboteado: sin manejador de SIGTERM\n');
      rt.stop('rec-effects-app');
      rt.start('rec-effects-app');
      const r = await waitReady(rt, 'rec-effects-tool', sandbox.spec, 2000);
      return { status: r.ok ? 0 : 1, stderr: r.detail };
    },
  },
];

// ── lo que la fixture hace, sonda a sonda ─────────────────────────────────────────────────────
const legacyMessages = (r) => (r.effects.messages ?? []).filter((m) => m.origin === 'legacy');
const added = (r, c) => r.effects.db?.[c]?.added ?? [];
const changed = (r, c) => r.effects.db?.[c]?.changed ?? [];
const codes = (r) => r.steps.map((s) => s.response.status).join(',');
const EXPECT = {
  'P-001': (r) => [
    ['estados', codes(r) === '200'],
    ['sin efectos', Object.keys(r.effects.db).length === 0 && r.effects.outbound.length === 0 && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
  ],
  'P-002': (r) => {
    const doc = added(r, 'orders')[0];
    const msg = legacyMessages(r)[0];
    const call = r.effects.outbound[0];
    const mail = r.effects.mail[0];
    return [
      ['estados', codes(r) === '201,200'],
      ['base: un pedido PAID', added(r, 'orders').length === 1 && doc.status === 'PAID' && doc.paymentId === 'pay-0001'],
      ['cobro: POST /payments con el importe', r.effects.outbound.length === 1 && call.method === 'POST' && call.url === '/payments' && call.body?.amount === 30 && call.matched === true],
      ['evento: order.created en orders', legacyMessages(r).length === 1 && msg.exchange === 'orders' && msg.routingKeys[0] === 'order.created' && msg.payload.status === 'PAID'],
      ['correo: confirmación a ana', r.effects.mail.length === 1 && mail.to[0] === 'ana@shop.invalid' && /confirmado/.test(mail.subject)],
      // la normalización etiqueta el mismo id igual en la respuesta, la base, el evento y el correo
      ['normalización coherente', r.steps[0].response.body.id === doc._id && msg.payload.id === doc._id && mail.subject.includes(doc._id) && /^<oid#\d+>$/.test(doc._id) && doc.createdAt === '<date>'],
    ];
  },
  'P-003': (r) => [
    ['estados', codes(r) === '422'],
    ['sin efectos', Object.keys(r.effects.db).length === 0 && r.effects.outbound.length === 0 && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
  ],
  'P-004': (r) => [
    ['estados', codes(r) === '502'],
    ['el cobro vio el 500 del setup', r.effects.outbound.length === 1 && r.effects.outbound[0].status === 500],
    ['sin pedido, evento ni correo', Object.keys(r.effects.db).length === 0 && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
  ],
  'P-005': (r) => [
    ['estados', codes(r) === '201,200,409'],
    ['eventos: creado y cancelado', legacyMessages(r).map((m) => m.routingKeys[0]).join(',') === 'order.created,order.cancelled'],
    ['base: el pedido nace cancelado al final de la sonda', added(r, 'orders').length === 1 && added(r, 'orders')[0].status === 'CANCELLED'],
  ],
  'P-006': (r) => [
    ['estados', codes(r) === '201'],
    ['broker caído: el evento se pierde', legacyMessages(r).length === 0],
    ['el pedido y el correo sí', added(r, 'orders').length === 1 && r.effects.mail.length === 1],
  ],
  'P-007': (r) => [['diez desenlaces contados', Object.values(r.outcomes ?? {}).reduce((a, b) => a + b, 0) === 10], raceCheck({ recordings: [{ id: 'P-007', recording: r }] }, true)],
  'P-008': (r) => [
    ['el evento entrante, como de la sonda', (r.effects.messages ?? []).filter((m) => m.origin === 'probe').length === 1 && legacyMessages(r).length === 0],
    ['publicado en orders', r.effects.messages?.[0]?.exchange === 'orders' && r.effects.messages[0].routingKeys[0] === 'order.audited'],
  ],
};

// La carrera de P-007: cuántas de las repeticiones dieron las dos cancelaciones en 200.
const RACE_MIN = 0.5;
const RACE_MAX_SERIAL = 0.2;
function raceShare(rec) {
  const total = Object.values(rec?.outcomes ?? {}).reduce((a, b) => a + b, 0);
  const race = Object.entries(rec?.outcomes ?? {}).filter(([k]) => k.includes('{200,200}')).reduce((a, [, v]) => a + v, 0);
  return total ? race / total : 0;
}
function raceCheck(report, visible) {
  const share = raceShare(report.recordings.find((x) => x.id === 'P-007')?.recording);
  return visible
    ? [`la carrera se ve (${Math.round(share * 100)} % de las repeticiones, mínimo ${RACE_MIN * 100} %)`, share >= RACE_MIN]
    : [`sin un curl paralelo la carrera no se ve (${Math.round(share * 100)} %, máximo ${RACE_MAX_SERIAL * 100} %)`, share <= RACE_MAX_SERIAL];
}

function checkSurface(s) {
  const routes = new Set((s.http?.routes ?? []).map((r) => `${r.method} ${r.path}`));
  return [
    ['rutas del router montado en /api', ['GET /api/orders', 'GET /api/orders/:id', 'POST /api/orders', 'POST /api/orders/:id/cancel', 'GET /health'].every((r) => routes.has(r))],
    ['colección orders con su índice', s.data?.collections?.some((c) => c.name === 'orders' && c.indexes.some((i) => i.name === '_id_'))],
    ['sin la cola espía de la herramienta', !(s.broker?.queues ?? []).some((q) => q.name.startsWith('keel-recover.'))],
  ];
}

// La superficie perezosa: el exchange lo declara el legacy al publicar la primera vez, y tras verify
// puede no existir aún (si el broker tardó más que la app). Tras la ronda tiene que estar, fundido.
function checkMergedSurface(s) {
  const ex = (s.broker?.exchanges ?? []).find((e) => e.name === 'orders');
  return [
    ['exchange orders (topic, durable) tras la ronda', ex?.type === 'topic' && ex?.durable === true && ['introspect', 'check-base'].includes(ex.seen)],
    ['las rutas conservan la pasada en que aparecieron', (s.http?.routes ?? []).every((r) => r.seen === 'introspect')],
    ['las dos pasadas registradas', JSON.stringify(s.passes) === JSON.stringify(['introspect', 'check-base'])],
  ];
}

// ── preparación ───────────────────────────────────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-probe-'));
fs.cpSync(fixture, work, { recursive: true });
const instrument = () => {
  fs.mkdirSync(path.join(work, 'sandbox', 'instrument'), { recursive: true });
  for (const f of ['v8-coverage-exit.cjs', 'express-routes.cjs']) fs.copyFileSync(path.join(pkgRoot, 'assets', 'sandbox', f), path.join(work, 'sandbox', 'instrument', f));
};
fs.writeFileSync(path.join(work, 'runtime.yaml'), renderDoc(fingerprint(path.join(work, 'repo'))).text);
const env = renderDoc(envDeps(path.join(work, 'repo'))).plain;
env.adaptations = [
  { what: 'red internal: true', why: 'el runtime no sale a internet (principio 5)' },
  { what: 'rabbitmq:3.13-management', why: 'la 3.13 de la CI con la API de gestión, por la que se espía' },
];
fs.writeFileSync(path.join(work, 'environment.yaml'), YAML.stringify(env));

const composeFile = path.join(work, 'sandbox', 'compose.yaml');
const sandboxFile = path.join(work, 'sandbox', 'sandbox.yaml');
const pristineCompose = fs.readFileSync(composeFile, 'utf8');
const pristineSandbox = fs.readFileSync(sandboxFile, 'utf8');
const { doc: round, errors } = loadRound(path.join(work, 'probes', 'round-1.yaml'));
if (errors.length) throw new Error(errors.join('; '));
const down = () => rt.compose(composeFile, PROJECT, ['down', '-v']);

console.log(`runtime: ${runtime}\ntrabajo: ${work}\n── build (con red, aparte del runtime)`);
const build = spawnSync('bash', [path.join(work, 'sandbox', 'build.sh')], { stdio: 'inherit', env: { ...process.env, RUNTIME: runtime, MSYS_NO_PATHCONV: '1' } });
if (build.status !== 0) {
  console.error('el build de la fixture falló');
  process.exit(1);
}

const results = [];
for (const sc of SCENARIOS.filter((s) => !only || s.id === only)) {
  console.log(`\n── ${sc.id}`);
  instrument();
  fs.writeFileSync(composeFile, pristineCompose);
  if (sc.compose) {
    const c = YAML.parse(pristineCompose);
    sc.compose(c);
    fs.writeFileSync(composeFile, YAML.stringify(c, { lineWidth: 0 }));
  }
  if (sc.sandbox) {
    const s = YAML.parse(pristineSandbox);
    sc.sandbox(s);
    fs.writeFileSync(sandboxFile, YAML.stringify(s));
  } else fs.writeFileSync(sandboxFile, pristineSandbox);
  fs.rmSync(path.join(work, 'sandbox', 'verify.json'), { force: true });
  down();
  const sandbox = loadSandbox(sandboxFile);
  if (sandbox.errors.length) throw new Error(sandbox.errors.join('; '));

  const v = await verify(sandbox, rt, { log: (c) => !c.ok && console.log(`  ROJO  ${c.id}  ${c.detail}`) });
  fs.writeFileSync(path.join(work, 'sandbox', 'verify.json'), JSON.stringify(v, null, 2));
  if (!v.ok) {
    results.push({ id: sc.id, ok: false, why: 'verify en rojo' });
    console.log(`  ✗ verify en rojo: el escenario no se puede medir`);
    continue;
  }
  console.log(`  verify en verde, snapshot ${v.snapshot.hash}`);
  const checks = [];
  let surface = null;
  if (sc.id === 'base') {
    const s = introspect(sandbox, rt);
    for (const e of s.errors) console.log(`  ROJO  introspect: ${e}`);
    checks.push(['introspect sin errores', s.ok], ...checkSurface(s.surface));
    surface = mergeSurface(null, s.surface, 'introspect');
  }
  if (sc.afterVerify) {
    const r = await sc.afterVerify(sandbox);
    if (r.status !== 0) throw new Error(`el sabotaje ${sc.id} no se aplicó: ${r.stderr}`);
  }

  const report = await runRound(loadSandbox(sandboxFile), rt, round, {
    tag: `check-${sc.id}`,
    only: sc.only ?? (sc.id === 'base' ? null : SABOTAGE_PROBES),
    faults: new Set(sc.faults ?? []),
    log: (p) => console.log(`  ${p.id.padEnd(6)} [${p.codes}] ${p.effects}${p.outcomes ? ` ${JSON.stringify(p.outcomes)}` : ''}${p.untrusted ? `  sin fiar: ${p.untrusted.join(', ')}` : ''}`),
  });
  for (const c of report.criteria) console.log(`  ${c.ok ? 'OK   ' : 'ROJO '} ${c.id}  ${c.detail}`);
  if (sc.id === 'base') {
    for (const { id, recording } of report.recordings) for (const [what, ok] of EXPECT[id](recording)) checks.push([`${id} ${what}`, ok]);
    checks.push(['cobertura de la ronda > 0', report.coverage?.round?.covered > 0], ['lo no cubierto, por archivo', Object.keys(report.uncovered ?? {}).some((f) => f.endsWith('/src/server.js'))]);
    // dos ejecuciones de las mismas sondas graban lo mismo, una vez normalizado
    const twice = await runRound(loadSandbox(sandboxFile), rt, round, { tag: 'check-base-2', only: REPEATABLE });
    for (const { id, recording } of twice.recordings) {
      const first = report.recordings.find((x) => x.id === id).recording;
      checks.push([`${id} se graba igual dos veces`, JSON.stringify(comparable(first)) === JSON.stringify(comparable(recording))]);
    }
    const again = introspect(sandbox, rt);
    checks.push(['introspect tras la ronda sin errores', again.ok], ...checkMergedSurface(mergeSurface(surface, again.surface, 'check-base')));
  } else {
    // el canal saboteado marca sus grabaciones como no fiables
    const ch = sc.red[0];
    if (sc.expect) checks.push(...sc.expect(report));
    if (ch && ch !== 'PRB-COVERAGE') checks.push([`grabaciones marcadas sin fiar por ${ch}`, report.recordings.every((r) => r.recording.untrusted?.includes(ch))]);
  }
  for (const [what, ok] of checks) if (!ok) console.log(`  ✗ ${what}`);
  const red = report.criteria.filter((c) => !c.ok && !c.skipped).map((c) => c.id).sort();
  const ok = JSON.stringify(red) === JSON.stringify([...sc.red].sort()) && report.ok === (sc.red.length === 0) && checks.every(([, x]) => x);
  results.push({ id: sc.id, ok, red });
  console.log(`  ${ok ? '✓' : '✗'} ${sc.id}: rojo en [${red.join(', ')}], se esperaba [${sc.red.join(', ')}]; ${checks.filter(([, x]) => x).length}/${checks.length} comprobaciones`);
  if (sc.id === 'base' && keep) fs.writeFileSync(path.join(work, 'base-round.json'), JSON.stringify(report, null, 2));
}

if (!keep) {
  down();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log('\n' + results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}`).join('\n'));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} escenario(s) en rojo` : `\nintrospect y probe falsados: ${results.length} escenario(s) en su color`);
process.exit(failed ? 1 : 0);
