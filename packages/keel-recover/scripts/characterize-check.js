#!/usr/bin/env node
// characterize-check: la puerta en vivo del incremento 6. `keel-recover characterize` contra un
// sandbox REAL del legacy de fixture (fixtures/sandbox/node-mongo: Node + MongoDB; con
// --database=postgresql o --database=mysql, sus gemelos fixtures/sandbox/node-postgres y node-mysql, que por
// HTTP se portan igual), con el diseño
// recuperado de juguete de test/helpers/stock-design.js: dos keep, un fix y un frontier, con sus
// pasos en bloques ```keel-flow```, y un new que no se ejecuta.
//
// En verde, los cuatro flujos pasan contra el legacy, el sello que escribe lo lee el criterio
// `characterized` de keel-core sin nada pendiente y FIDELITY.md sale con sus cuentas. Después, cada
// sabotaje conserva la forma y tiene que sacar en rojo EXACTAMENTE sus flujos:
//
//   expect        un keep afirma un status que el legacy no da          → FL-ITM-001
//   fix-gone      un fix dice que el legacy ya hace lo que el diseño
//                 corrige (el defecto no existiría)                     → FL-ITM-002
//   snapshot-gone el archivo del snapshot desaparece tras verify: ningún
//                 flujo puede partir del estado de partida              → todos
//   snapshot-drift la base restaurada no es la que verify sella (otra
//                 huella): el verde dependería de lo que dejó otro      → todos
//
// El estado de partida es la base VACÍA: verify escribe un artículo para medir VER-WRITE, así que
// tras verify se vacía la base (con el adaptador del motor) y se toma el snapshot otra vez, con su
// huella en verify.json.
//
//   npm run characterize-check --workspace packages/keel-recover [-- --only=<id>] [-- --keep] [-- --database=postgresql|mysql]
//
// Necesita podman o docker, y red para construir la imagen y bajar las de la base y la herramienta.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadCharacterized, loadProvenance, readCharacterization, resolveCharacterized } from 'keel-core';
import { renderDoc } from '../src/lib/emit.js';
import { fingerprint } from '../src/lib/fingerprint.js';
import { envDeps } from '../src/lib/env-deps.js';
import { loadSandbox } from '../src/lib/sandbox.js';
import { containerRuntime, resolveRuntime } from '../src/lib/containers.js';
import { verify } from '../src/lib/verify.js';
import { databaseAdapter } from '../src/lib/db/index.js';
import { runCharacterization } from '../src/lib/characterize.js';
import { legacyContext, prepareCharacterization, verifyGate, writeCharacterization } from '../src/lib/characterize-legacy.js';
import { SCENARIOS as STOCK_SCENARIOS, writeStockDesign } from '../test/helpers/stock-design.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const FIXTURES = { mongodb: { dir: 'node-mongo', project: 'rec-fixture' }, postgresql: { dir: 'node-postgres', project: 'rec-fixture-pg' }, mysql: { dir: 'node-mysql', project: 'rec-fixture-my' } };
const database = process.argv.find((a) => a.startsWith('--database='))?.split('=')[1] ?? 'mongodb';
const fx = FIXTURES[database];
if (!fx) {
  console.error(`--database=${database}: hay fixture para ${Object.keys(FIXTURES).join(', ')}`);
  process.exit(2);
}
const dba = databaseAdapter(database);
const fixture = path.join(pkgRoot, 'fixtures', 'sandbox', fx.dir);
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const keep = process.argv.includes('--keep');

const runtime = resolveRuntime();
if (!runtime) {
  console.error('characterize-check necesita podman o docker en marcha.');
  process.exit(2);
}
const rt = containerRuntime(runtime);
const ALL = ['FL-ITM-001', 'FL-ITM-002', 'FL-ITM-003', 'FL-ITM-004'];

const SCENARIOS = [
  { id: 'base', red: [] },
  { id: 'expect', red: ['FL-ITM-001'], scenarios: (s) => s.replace('expect: { status: created, body: { sku: a } }', 'expect: { status: ok, body: { sku: a } }') },
  { id: 'fix-gone', red: ['FL-ITM-002'], scenarios: (s) => s.replace('legacy: { status: 422 }', 'legacy: { status: 400 }') },
  { id: 'snapshot-gone', red: ALL, message: /no se pudo restaurar el estado de partida/, before: (db) => rt.exec(db, ['rm', '-f', dba.snapshotFile]) },
  { id: 'snapshot-drift', red: ALL, message: /no es el snapshot de verify/, snapshotHash: 'f'.repeat(32) },
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-characterize-'));
const legacyDir = path.join(work, 'legacy', 'stock');
fs.mkdirSync(legacyDir, { recursive: true });
fs.cpSync(fixture, legacyDir, { recursive: true });
fs.mkdirSync(path.join(legacyDir, 'sandbox', 'instrument'), { recursive: true });
for (const f of ['v8-coverage-exit.cjs', 'express-routes.cjs']) fs.copyFileSync(path.join(pkgRoot, 'assets', 'sandbox', f), path.join(legacyDir, 'sandbox', 'instrument', f));
fs.writeFileSync(path.join(legacyDir, 'runtime.yaml'), renderDoc(fingerprint(path.join(legacyDir, 'repo'))).text);
const env = renderDoc(envDeps(path.join(legacyDir, 'repo'))).plain;
env.adaptations = [{ what: 'red internal: true', why: 'el runtime no sale a internet (principio 5)' }];
fs.writeFileSync(path.join(legacyDir, 'environment.yaml'), YAML.stringify(env));
const { specDir } = writeStockDesign(work);

const composeFile = path.join(legacyDir, 'sandbox', 'compose.yaml');
const down = () => rt.compose(composeFile, fx.project, ['down', '-v']);

console.log(`base: ${database} (fixtures/sandbox/${fx.dir})`);
console.log(`runtime: ${runtime}\ntrabajo: ${work}\n── build (con red, aparte del runtime)`);
const build = spawnSync('bash', [path.join(legacyDir, 'sandbox', 'build.sh')], { stdio: 'inherit', env: { ...process.env, RUNTIME: runtime, MSYS_NO_PATHCONV: '1' } });
if (build.status !== 0) {
  console.error('el build de la fixture falló');
  process.exit(1);
}

const sandbox = loadSandbox(path.join(legacyDir, 'sandbox'));
if (sandbox.errors.length) throw new Error(sandbox.errors.join('; '));
const db = `${fx.project}-db`;

/** verify en verde, y el estado de partida de los flujos: la base vacía, con su snapshot. */
async function freshSandbox() {
  down();
  const report = await verify(sandbox, rt, { log: (c) => !c.ok && console.log(`  ROJO ${c.id}  ${c.detail}`) });
  if (!report.ok) throw new Error('verify salió en rojo: la puerta no puede medir characterize');
  const clear = dba.empty(rt, db, sandbox.spec.database);
  if (!clear.ok) throw new Error(`no se pudo vaciar la base: ${clear.error}`);
  report.snapshot = dba.takeSnapshot(rt, db, sandbox.spec.database);
  if (!report.snapshot.ok) throw new Error(`snapshot: ${report.snapshot.error}`);
  fs.writeFileSync(path.join(legacyDir, 'sandbox', 'verify.json'), JSON.stringify(report, null, 2));
}

await freshSandbox();
const results = [];
for (const sc of SCENARIOS.filter((s) => !only || s.id === only)) {
  console.log(`\n── ${sc.id}`);
  const scenarios = sc.scenarios ? sc.scenarios(STOCK_SCENARIOS) : STOCK_SCENARIOS;
  if (sc.scenarios && scenarios === STOCK_SCENARIOS) throw new Error(`el sabotaje ${sc.id} no se aplica`);
  fs.writeFileSync(path.join(specDir, 'validation-scenarios.md'), scenarios);
  fs.rmSync(path.join(specDir, 'characterized.yaml'), { force: true });
  if (sc.before) sc.before(db);

  const prep = prepareCharacterization(legacyDir);
  if (prep.errors.length) throw new Error(prep.errors.join('; '));
  const gate = verifyGate(prep);
  if (!gate.ok) throw new Error(gate.detail);
  const ctx = legacyContext(prep, rt, { snapshotHash: sc.snapshotHash ?? gate.snapshotHash });
  const records = await runCharacterization(ctx, prep.planned, {
    log: (r) => console.log(`  ${r.ok ? 'OK   ' : 'ROJO '} ${r.id} ${r.mark}${r.ok ? '' : `  ${r.failures[0]}`}`),
  });
  writeCharacterization(prep, records, { snapshotHash: gate.snapshotHash });

  const red = records.filter((r) => !r.ok).map((r) => r.id);
  let ok = JSON.stringify(red) === JSON.stringify(sc.red) && records.length === ALL.length;
  if (sc.message) ok = ok && records.every((r) => sc.message.test(r.failures.join('\n')));
  // El sello lo lee keel-core igual que `keel validate --ready`: en verde no queda nada pendiente,
  // y en rojo lo que falla son exactamente los flujos saboteados.
  const verdict = resolveCharacterized(loadCharacterized(specDir), scenarios, readCharacterization(scenarios, loadProvenance(specDir).doc).flows, 'stock');
  ok = ok && JSON.stringify(verdict.failed.map((f) => f.id)) === JSON.stringify(sc.red) && verdict.notRun.length + verdict.changed.length + verdict.orphans.length + verdict.errors.length === 0;
  if (sc.id === 'base') {
    const fidelity = fs.readFileSync(path.join(legacyDir, 'FIDELITY.md'), 'utf8');
    ok = ok && /\| `keep` \| \*\*2 \/ 2\*\* \|/.test(fidelity) && /\| `fix` \| \*\*1 \/ 1\*\* \|/.test(fidelity) && /\| `frontier` \| \*\*1 \/ 1\*\* \|/.test(fidelity);
    // Lo que se graba son los datos reales del legacy: la cantidad que no llega es 0 (`|| 0`).
    const listed = JSON.parse(fs.readFileSync(path.join(legacyDir, 'recordings', 'characterization', 'FL-ITM-003.json'), 'utf8')).steps[2].data.items;
    ok = ok && listed.some((i) => i.sku === 'b' && i.quantity === 0);
  }
  if (sc.before) await freshSandbox();
  results.push({ id: sc.id, ok, red });
  console.log(`  ${ok ? '✓' : '✗'} ${sc.id}: rojo en [${red.join(', ')}], se esperaba [${sc.red.join(', ')}]`);
}

if (!keep) {
  down();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log('\n' + results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}`).join('\n'));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} escenario(s) en rojo` : `\ncharacterize falsado: ${results.length} escenario(s) en su color`);
process.exit(failed ? 1 : 0);
