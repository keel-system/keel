#!/usr/bin/env node
// verify-check: la puerta del incremento 3. El juez (keel-recover verify) contra un sandbox REAL
// del legacy de fixture (fixtures/sandbox/node-mongo: Node + MongoDB, cobertura v8; con
// --database=postgresql o --database=mysql, sus gemelos fixtures/sandbox/node-postgres y node-mysql), tal cual
// y saboteado. Cada sabotaje rompe el sandbox conservando su forma, y verify tiene que salir en rojo
// con EXACTAMENTE el criterio que lo mide:
//
//   egress     la red del compose sin `internal: true`        → VER-NET-INTERNAL (y no se arranca)
//   coverage   la app sin NODE_V8_COVERAGE                     → VER-COVERAGE
//   5xx        la app apunta a una base que no existe; su
//              /health sigue en 200, como el de orders         → VER-READ, VER-WRITE, VER-DB-TRACE
//   routes     sandbox.yaml no declara de dónde salen las rutas
//              (introspection.routes)                      → VER-ROUTES
//   trace      sandbox.yaml cree que la app escribe en otra
//              base: la escritura responde 201 y no deja rastro → VER-DB-TRACE
//
// Con --database=mysql, uno más y las medidas de la fixture:
//
//   cached-counter  la huella lee el AUTO_INCREMENT de information_schema sin
//                   information_schema_stats_expiry = 0: en caché, no ve
//                   la escritura (M-02)                          → VER-DB-TRACE
//   base            además, tras el juez en verde, las medidas de scripts/mysql-measures.js
//                   (ENUM, CHECK, fecha cero, TIMESTAMP en otra zona, ON UPDATE, MyISAM y trigger,
//                   y la restauración con una transacción abierta, M-01), todas en verde
//
//   npm run verify-check --workspace packages/keel-recover [-- --only=<id>] [-- --keep] [-- --database=postgresql|mysql]
//
// Necesita podman o docker, y red para construir la imagen y bajar las de la base y la herramienta.
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
import { containerRuntime, exec, resolveRuntime } from '../src/lib/containers.js';
import { verify } from '../src/lib/verify.js';
import { databaseAdapter } from '../src/lib/db/index.js';
import { clientArgs } from '../src/lib/db/mysql.js';
import { mysqlMeasures } from './mysql-measures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
// Un legacy de fixture por motor, con lo que cada sabotaje necesita saber de él.
const FIXTURES = {
  mongodb: { dir: 'node-mongo', project: 'rec-fixture', prefix: 'rec-fixture', urlEnv: 'MONGO_URL', nowhere: 'mongodb://nowhere:27017', otherDb: 'stock_legacy_old' },
  // la base equivocada existe (la de mantenimiento de PostgreSQL): la del sandbox responde, pero vacía
  postgresql: { dir: 'node-postgres', project: 'rec-fixture-pg', prefix: 'rec-fixture-pg', urlEnv: 'DATABASE_URL', nowhere: 'postgres://postgres:postgres@nowhere:5432/stock', otherDb: 'postgres' },
  // la base equivocada es sys: existe, la herramienta entra como root, y su única tabla no cambia
  mysql: { dir: 'node-mysql', project: 'rec-fixture-my', prefix: 'rec-fixture-my', urlEnv: 'DATABASE_URL', nowhere: 'mysql://stock:stock@nowhere:3306/stock', otherDb: 'sys' },
};
const database = process.argv.find((a) => a.startsWith('--database='))?.split('=')[1] ?? 'mongodb';
const fx = FIXTURES[database];
if (!fx) {
  console.error(`--database=${database}: hay fixture para ${Object.keys(FIXTURES).join(', ')}`);
  process.exit(2);
}
const fixture = path.join(pkgRoot, 'fixtures', 'sandbox', fx.dir);
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const keep = process.argv.includes('--keep');

const runtime = resolveRuntime();
if (!runtime) {
  console.error('verify-check necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);

// Cada escenario: qué cambia y qué criterios tienen que salir en rojo (el resto, en verde o sin
// ejecutar porque el sandbox no se arranca).
const SCENARIOS = [
  { id: 'base', red: [] },
  {
    id: 'egress',
    red: ['VER-NET-INTERNAL'],
    notRun: true,
    compose: (c) => {
      c.networks.sandbox.internal = false;
    },
  },
  {
    id: 'coverage',
    red: ['VER-COVERAGE'],
    compose: (c) => {
      delete c.services.app.environment.NODE_V8_COVERAGE;
    },
  },
  {
    id: '5xx',
    red: ['VER-READ', 'VER-WRITE', 'VER-DB-TRACE'],
    healthLies: true,
    compose: (c) => {
      c.services.app.environment[fx.urlEnv] = fx.nowhere;
    },
  },
  {
    id: 'routes',
    red: ['VER-ROUTES'],
    sandbox: (s) => {
      delete s.introspection;
    },
  },
  {
    id: 'trace',
    red: ['VER-DB-TRACE'],
    sandbox: (s) => {
      s.database.name = fx.otherDb;
    },
  },
  // La huella que una implementación ingenua leería: el contador y las filas de information_schema.tables, con la
  // caché de un día por defecto. Además de salir en rojo, la lectura fresca de los mismos números tiene que cambiar:
  // el rojo es de la caché, no de una escritura que no llegó.
  {
    id: 'cached-counter',
    only: 'mysql',
    red: ['VER-DB-TRACE'],
    adapter: (dba) => {
      const sql = 'select table_name, auto_increment, table_rows from information_schema.tables where table_schema = database() order by 1;';
      const readings = [];
      const read = (rt, c, db, fresh) => rt.exec(c, clientArgs(db, 'mysql', ['-N', '-B', db.name]), { input: (fresh ? 'set session information_schema_stats_expiry = 0;\n' : '') + sql }).stdout;
      dba.fingerprint = (rt, c, db) => {
        const cached = read(rt, c, db, false);
        readings.push({ cached, fresh: read(rt, c, db, true) });
        return { ok: true, value: cached };
      };
      return () => {
        const [before, after] = readings.slice(-2);
        const ok = before.cached === after.cached && before.fresh !== after.fresh;
        console.log(`  contador en caché ${before.cached === after.cached ? 'igual' : 'distinto'} y fresco ${before.fresh !== after.fresh ? 'distinto' : 'igual'} tras la escritura`);
        return ok;
      };
    },
  },
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-verify-'));
fs.cpSync(fixture, work, { recursive: true });
fs.mkdirSync(path.join(work, 'sandbox', 'instrument'), { recursive: true });
for (const f of ['v8-coverage-exit.cjs', 'express-routes.cjs']) fs.copyFileSync(path.join(pkgRoot, 'assets', 'sandbox', f), path.join(work, 'sandbox', 'instrument', f));
// Los pasos 0a y 0b, con la propia herramienta: de ahí cruza verify la versión del motor.
fs.writeFileSync(path.join(work, 'runtime.yaml'), renderDoc(fingerprint(path.join(work, 'repo'))).text);
const env = renderDoc(envDeps(path.join(work, 'repo'))).plain;
env.adaptations = [{ what: 'red internal: true', why: 'el runtime no sale a internet (principio 5)' }];
fs.writeFileSync(path.join(work, 'environment.yaml'), YAML.stringify(env));

const composeFile = path.join(work, 'sandbox', 'compose.yaml');
const sandboxFile = path.join(work, 'sandbox', 'sandbox.yaml');
const pristineCompose = fs.readFileSync(composeFile, 'utf8');
const pristineSandbox = fs.readFileSync(sandboxFile, 'utf8');
const down = () => rt.compose(composeFile, fx.project, ['down', '-v']);

console.log(`base: ${database} (fixtures/sandbox/${fx.dir})`);
console.log(`runtime: ${runtime}\ntrabajo: ${work}\n── build (con red, aparte del runtime)`);
const build = spawnSync('bash', [path.join(work, 'sandbox', 'build.sh')], { stdio: 'inherit', env: { ...process.env, RUNTIME: runtime, MSYS_NO_PATHCONV: '1' } });
if (build.status !== 0) {
  console.error('el build de la fixture falló');
  process.exit(1);
}

const results = [];
const dba = databaseAdapter(database);
const pristineFingerprint = dba.fingerprint;
for (const sc of SCENARIOS.filter((s) => (!only || s.id === only) && (!s.only || s.only === database))) {
  console.log(`\n── ${sc.id}`);
  fs.writeFileSync(composeFile, pristineCompose);
  fs.writeFileSync(sandboxFile, pristineSandbox);
  if (sc.compose) {
    const c = YAML.parse(pristineCompose);
    sc.compose(c);
    fs.writeFileSync(composeFile, YAML.stringify(c));
  }
  if (sc.sandbox) {
    const s = YAML.parse(pristineSandbox);
    sc.sandbox(s);
    fs.writeFileSync(sandboxFile, YAML.stringify(s));
  }
  down();
  dba.fingerprint = pristineFingerprint;
  const sabotaged = sc.adapter ? sc.adapter(dba) : null;
  const sandbox = loadSandbox(sandboxFile);
  if (sandbox.errors.length) throw new Error(sandbox.errors.join('; '));
  const report = await verify(sandbox, rt, { log: (c) => console.log(`  ${c.ok ? 'OK   ' : c.skipped ? '·    ' : 'ROJO '} ${c.id}  ${c.detail}`) });
  const red = report.criteria.filter((c) => !c.ok && !c.skipped).map((c) => c.id).sort();
  const skipped = report.criteria.filter((c) => c.skipped).map((c) => c.id);
  let ok = JSON.stringify(red) === JSON.stringify([...sc.red].sort()) && report.ok === (sc.red.length === 0);
  if (sc.notRun) ok = ok && skipped.length > 0 && !exec(runtime, ['inspect', `${fx.prefix}-app`]).stdout.includes('"Running": true');
  if (sc.id === 'base') ok = ok && report.snapshot?.ok === true;
  if (sc.healthLies) {
    // La salud del legacy miente: el juez no la usa, y por eso sale en rojo con /health en 200.
    const h = exec(runtime, ['exec', `${fx.prefix}-tool`, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://stock:4000/health']).stdout.trim();
    console.log(`  /health del legacy: ${h}`);
    ok = ok && h === '200';
  }
  if (sabotaged) ok = ok && sabotaged();
  if (sc.id === 'base' && database === 'mysql' && report.snapshot?.ok) {
    const measures = await mysqlMeasures({ rt, db: `${fx.prefix}-db`, tool: `${fx.prefix}-tool`, base: sandbox.spec.app.base, database: sandbox.spec.database, adapter: dba, snapshotHash: report.snapshot.hash });
    for (const m of measures) console.log(`  ${m.ok ? 'OK   ' : 'ROJO '} ${m.id}  ${m.detail}`);
    ok = ok && measures.every((m) => m.ok);
  }
  results.push({ id: sc.id, ok, red });
  console.log(`  ${ok ? '✓' : '✗'} ${sc.id}: rojo en [${red.join(', ')}], se esperaba [${sc.red.join(', ')}]`);
}

if (!keep) {
  down();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log('\n' + results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}`).join('\n'));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} escenario(s) en rojo` : `\nverify falsado: ${results.length} escenario(s) en su color`);
process.exit(failed ? 1 : 0);
