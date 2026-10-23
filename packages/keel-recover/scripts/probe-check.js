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
//   npm run probe-check --workspace packages/keel-recover [-- --only=<id>] [-- --keep] [-- --database=postgresql]
//
// Con --database=postgresql la fixture es fixtures/sandbox/node-postgres (solo base, sin broker, stubs
// ni correo): el diff por clave primaria, las secuencias como efecto, la introspección relacional y
// los sabotajes que no son de un canal (snapshot-gone, parallel-exec y coverage-off).
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
import { comparable } from '../src/lib/normalize.js';
import { databaseAdapter } from '../src/lib/db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const keep = process.argv.includes('--keep');
const database = process.argv.find((a) => a.startsWith('--database='))?.split('=')[1] ?? 'mongodb';

const runtime = resolveRuntime();
if (!runtime) {
  console.error('probe-check necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);

// ── lo común a las dos fixtures ───────────────────────────────────────────────────────────────
const legacyMessages = (r) => (r.effects.messages ?? []).filter((m) => m.origin === 'legacy');
const added = (r, c) => r.effects.db?.[c]?.added ?? [];
const changed = (r, c) => r.effects.db?.[c]?.changed ?? [];
const codes = (r) => r.steps.map((s) => s.response.status).join(',');
const noDbEffects = (r) => Object.keys(r.effects.db ?? {}).length === 0;

// La carrera de cada fixture: cuántas de las repeticiones de su sonda de concurrencia la muestran.
const RACE_MIN = 0.5;
const RACE_MAX_SERIAL = 0.2;
function raceShare(rec, isRace) {
  const total = Object.values(rec?.outcomes ?? {}).reduce((a, b) => a + b, 0);
  const race = Object.entries(rec?.outcomes ?? {}).filter(([k]) => isRace(k)).reduce((a, [, v]) => a + v, 0);
  return total ? race / total : 0;
}
function raceCheck(report, visible) {
  const share = raceShare(report.recordings.find((x) => x.id === fx.race.probe)?.recording, fx.race.isRace);
  return visible
    ? [`la carrera se ve (${Math.round(share * 100)} % de las repeticiones, mínimo ${RACE_MIN * 100} %)`, share >= RACE_MIN]
    : [`sin un curl paralelo la carrera no se ve (${Math.round(share * 100)} %, máximo ${RACE_MAX_SERIAL * 100} %)`, share <= RACE_MAX_SERIAL];
}
const raceExpect = (id) => (r) => [['diez desenlaces contados', Object.values(r.outcomes ?? {}).reduce((a, b) => a + b, 0) === 10], raceCheck({ recordings: [{ id, recording: r }] }, true)];

// Los sabotajes que no son de un canal: valen igual para cualquier motor.
function commonScenarios(f) {
  return [
    {
      id: 'snapshot-gone',
      red: ['PRB-VERIFY'],
      expect: (report) => [['PRB-VERIFY dice que falta el snapshot', new RegExp(`no hay snapshot en ${f.prefix}-db`).test(report.criteria.find((c) => c.id === 'PRB-VERIFY')?.detail ?? '')]],
      afterVerify: async () => rt.exec(`${f.prefix}-db`, ['rm', '-f', databaseAdapter(database).snapshotFile]),
    },
    { id: 'parallel-exec', red: [], faults: ['parallel-exec'], only: new Set([f.race.probe]), expect: (report) => [raceCheck(report, false)] },
    {
      id: 'coverage-off',
      red: ['PRB-COVERAGE'],
      afterVerify: async (sandbox) => {
        fs.writeFileSync(path.join(work, 'sandbox', 'instrument', 'v8-coverage-exit.cjs'), '// saboteado: sin manejador de SIGTERM\n');
        rt.stop(`${f.prefix}-app`);
        rt.start(`${f.prefix}-app`);
        const r = await waitReady(rt, `${f.prefix}-tool`, sandbox.spec, 2000);
        return { status: r.ok ? 0 : 1, stderr: r.detail };
      },
    },
  ];
}

// ── MongoDB: node-effects, con los cuatro canales ─────────────────────────────────────────────
const MONGODB = {
  dir: 'node-effects',
  prefix: 'rec-effects',
  // En los sabotajes basta con las sondas que tocan todos los canales.
  sabotageProbes: new Set(['P-001', 'P-002']),
  // Las que no dependen del azar de una carrera: su grabación normalizada se repite byte a byte.
  repeatable: new Set(['P-002', 'P-004', 'P-005', 'P-006']),
  adaptations: [{ what: 'rabbitmq:3.13-management', why: 'la 3.13 de la CI con la API de gestión, por la que se espía' }],
  race: { probe: 'P-007', isRace: (k) => k.includes('{200,200}') },
  scenarios: [
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
  ],
  // lo que la fixture hace, sonda a sonda
  expect: {
    'P-001': (r) => [
      ['estados', codes(r) === '200'],
      ['sin efectos', noDbEffects(r) && r.effects.outbound.length === 0 && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
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
      ['sin efectos', noDbEffects(r) && r.effects.outbound.length === 0 && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
    ],
    'P-004': (r) => [
      ['estados', codes(r) === '502'],
      ['el cobro vio el 500 del setup', r.effects.outbound.length === 1 && r.effects.outbound[0].status === 500],
      ['sin pedido, evento ni correo', noDbEffects(r) && legacyMessages(r).length === 0 && r.effects.mail.length === 0],
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
    'P-007': raceExpect('P-007'),
    'P-008': (r) => [
      ['el evento entrante, como de la sonda', (r.effects.messages ?? []).filter((m) => m.origin === 'probe').length === 1 && legacyMessages(r).length === 0],
      ['publicado en orders', r.effects.messages?.[0]?.exchange === 'orders' && r.effects.messages[0].routingKeys[0] === 'order.audited'],
    ],
  },
  checkSurface: (s) => {
    const routes = new Set((s.http?.routes ?? []).map((r) => `${r.method} ${r.path}`));
    return [
      ['rutas del router montado en /api', ['GET /api/orders', 'GET /api/orders/:id', 'POST /api/orders', 'POST /api/orders/:id/cancel', 'GET /health'].every((r) => routes.has(r))],
      ['colección orders con su índice', s.data?.collections?.some((c) => c.name === 'orders' && c.indexes.some((i) => i.name === '_id_'))],
      ['sin la cola espía de la herramienta', !(s.broker?.queues ?? []).some((q) => q.name.startsWith('keel-recover.'))],
    ];
  },
  // La superficie perezosa: el exchange lo declara el legacy al publicar la primera vez, y tras verify
  // puede no existir aún (si el broker tardó más que la app). Tras la ronda tiene que estar, fundido.
  checkMergedSurface: (s) => {
    const ex = (s.broker?.exchanges ?? []).find((e) => e.name === 'orders');
    return [
      ['exchange orders (topic, durable) tras la ronda', ex?.type === 'topic' && ex?.durable === true && ['introspect', 'check-base'].includes(ex.seen)],
      ['las rutas conservan la pasada en que aparecieron', (s.http?.routes ?? []).every((r) => r.seen === 'introspect')],
      ['las dos pasadas registradas', JSON.stringify(s.passes) === JSON.stringify(['introspect', 'check-base'])],
    ];
  },
};

// ── PostgreSQL: node-postgres, solo base ──────────────────────────────────────────────────────
// Lo que solo tiene una base relacional y el ejecutor tiene que grabar bien: el diff por clave
// primaria, el id que sale de la secuencia (y que vuelve igual tras restaurar: si el snapshot no
// devolviera las secuencias, Q-002 dejaría de grabarse igual dos veces), la UNIQUE que rechaza y
// aun así consume un id, el CHECK del ciclo de vida y la clave ajena.
const seq = (r, name) => (r.effects.db?._sequences?.changed ?? []).find((c) => c.after.name === name);
const PG_TABLE = (s, name) => (s.data?.tables ?? []).find((t) => t.name === name);
const POSTGRESQL = {
  dir: 'node-postgres',
  prefix: 'rec-fixture-pg',
  sabotageProbes: new Set(['Q-001', 'Q-002']),
  repeatable: new Set(['Q-002', 'Q-004', 'Q-005']),
  adaptations: [],
  // con la carrera, las dos salidas dan 200 y queda una unidad (se pierde un descuento)
  race: { probe: 'Q-006', isRace: (k) => k.endsWith('|quantity=1') },
  scenarios: [],
  expect: {
    'Q-001': (r) => [['estados', codes(r) === '200'], ['sin efectos', noDbEffects(r)]],
    'Q-002': (r) => {
      const item = added(r, 'items')[0];
      const mov = added(r, 'movements')[0];
      const s = seq(r, 'items_id_seq');
      return [
        ['estados', codes(r) === '201,200'],
        ['base: el artículo y su movimiento', added(r, 'items').length === 1 && item.sku === 'a' && item.quantity === 2 && item.status === 'AVAILABLE' && mov?.item_id === item.id && mov?.delta === 2],
        ['el id es el que dio la secuencia', s && s.after.last_value === item.id && s.after.last_value === s.before.last_value + 1],
        ['las dos secuencias, como efecto', (r.effects.db._sequences?.changed ?? []).length === 2],
      ];
    },
    'Q-003': (r) => [['estados', codes(r) === '422'], ['sin efectos (ni la secuencia)', noDbEffects(r)]],
    'Q-004': (r) => {
      const s = seq(r, 'items_id_seq');
      return [
        ['estados', codes(r) === '201,409'],
        ['un solo artículo', added(r, 'items').length === 1 && added(r, 'movements').length === 1],
        ['el alta rechazada consumió un id', s && s.after.last_value === s.before.last_value + 2],
      ];
    },
    'Q-005': (r) => [
      ['estados', codes(r) === '201,200,409,200'],
      ['base: agotado y en SOLD', added(r, 'items').length === 1 && added(r, 'items')[0].status === 'SOLD' && added(r, 'items')[0].quantity === 0],
      ['los dos movimientos', added(r, 'movements').map((m) => m.delta).sort().join(',') === '-2,2'],
    ],
    'Q-006': raceExpect('Q-006'),
  },
  checkSurface: (s) => {
    const routes = new Set((s.http?.routes ?? []).map((r) => `${r.method} ${r.path}`));
    const items = PG_TABLE(s, 'items');
    const movements = PG_TABLE(s, 'movements');
    return [
      ['rutas de la app', ['GET /items', 'GET /items/:sku', 'POST /items', 'POST /items/:sku/take', 'GET /health'].every((r) => routes.has(r))],
      ['items: clave primaria, UNIQUE de sku y el CHECK del estado', JSON.stringify(items?.primaryKey) === '["id"]' && JSON.stringify(items?.unique) === '[["sku"]]' && (items?.checks ?? []).some((c) => /status/.test(c) && /AVAILABLE/.test(c) && /SOLD/.test(c))],
      ['movements: clave ajena a items con borrado en cascada', movements?.foreignKeys?.some((f) => f.references.table === 'items' && f.onDelete === 'cascade')],
      ['las dos secuencias', ['items_id_seq', 'movements_id_seq'].every((n) => (s.data?.sequences ?? []).some((x) => x.name === n))],
      ['el tipo de cada columna', items?.columns.find((c) => c.name === 'quantity')?.type === 'jsonb' && items?.columns.find((c) => c.name === 'status')?.length === 20],
    ];
  },
  checkMergedSurface: (s) => [
    ['las tablas conservan la pasada en que aparecieron', (s.data?.tables ?? []).length === 2 && s.data.tables.every((t) => t.seen === 'introspect')],
    ['las rutas conservan la pasada en que aparecieron', (s.http?.routes ?? []).every((r) => r.seen === 'introspect')],
    ['las dos pasadas registradas', JSON.stringify(s.passes) === JSON.stringify(['introspect', 'check-base'])],
  ],
};

const FIXTURES = { mongodb: MONGODB, postgresql: POSTGRESQL };
const fx = FIXTURES[database];
if (!fx) {
  console.error(`--database=${database}: hay fixture para ${Object.keys(FIXTURES).join(', ')}`);
  process.exit(2);
}
const fixture = path.join(pkgRoot, 'fixtures', 'sandbox', fx.dir);
const PROJECT = fx.prefix;
const SABOTAGE_PROBES = fx.sabotageProbes;
const REPEATABLE = fx.repeatable;
const EXPECT = fx.expect;
const { checkSurface, checkMergedSurface } = fx;
const SCENARIOS = [{ id: 'base', red: [] }, ...fx.scenarios, ...commonScenarios(fx)];

// ── preparación ───────────────────────────────────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-probe-'));
fs.cpSync(fixture, work, { recursive: true });
const instrument = () => {
  fs.mkdirSync(path.join(work, 'sandbox', 'instrument'), { recursive: true });
  for (const f of ['v8-coverage-exit.cjs', 'express-routes.cjs']) fs.copyFileSync(path.join(pkgRoot, 'assets', 'sandbox', f), path.join(work, 'sandbox', 'instrument', f));
};
fs.writeFileSync(path.join(work, 'runtime.yaml'), renderDoc(fingerprint(path.join(work, 'repo'))).text);
const env = renderDoc(envDeps(path.join(work, 'repo'))).plain;
env.adaptations = [{ what: 'red internal: true', why: 'el runtime no sale a internet (principio 5)' }, ...fx.adaptations];
fs.writeFileSync(path.join(work, 'environment.yaml'), YAML.stringify(env));

const composeFile = path.join(work, 'sandbox', 'compose.yaml');
const sandboxFile = path.join(work, 'sandbox', 'sandbox.yaml');
const pristineCompose = fs.readFileSync(composeFile, 'utf8');
const pristineSandbox = fs.readFileSync(sandboxFile, 'utf8');
const { doc: round, errors } = loadRound(path.join(work, 'probes', 'round-1.yaml'));
if (errors.length) throw new Error(errors.join('; '));
const down = () => rt.compose(composeFile, PROJECT, ['down', '-v']);

console.log(`base: ${database} (fixtures/sandbox/${fx.dir})`);
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
