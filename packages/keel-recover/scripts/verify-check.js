#!/usr/bin/env node
// verify-check: la puerta del incremento 3. El juez (keel-recover verify) contra un sandbox REAL
// del legacy de fixture (fixtures/sandbox/node-mongo: Node + MongoDB, cobertura v8), tal cual y
// saboteado. Cada sabotaje rompe el sandbox conservando su forma, y verify tiene que salir en rojo
// con EXACTAMENTE el criterio que lo mide:
//
//   egress     la red del compose sin `internal: true`        → VER-NET-INTERNAL (y no se arranca)
//   coverage   la app sin NODE_V8_COVERAGE                     → VER-COVERAGE
//   5xx        la app apunta a una base que no existe; su
//              /health sigue en 200, como el de orders         → VER-READ, VER-WRITE, VER-DB-TRACE
//   trace      sandbox.yaml cree que la app escribe en otra
//              base: la escritura responde 201 y no deja rastro → VER-DB-TRACE
//
//   npm run verify-check --workspace packages/keel-recover [-- --only=<id>] [-- --keep]
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

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const fixture = path.join(pkgRoot, 'fixtures', 'sandbox', 'node-mongo');
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
      c.services.app.environment.MONGO_URL = 'mongodb://nowhere:27017';
    },
  },
  {
    id: 'trace',
    red: ['VER-DB-TRACE'],
    sandbox: (s) => {
      s.database.name = 'stock_legacy_old';
    },
  },
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recover-verify-'));
fs.cpSync(fixture, work, { recursive: true });
fs.mkdirSync(path.join(work, 'sandbox', 'instrument'), { recursive: true });
fs.copyFileSync(path.join(pkgRoot, 'assets', 'sandbox', 'v8-coverage-exit.cjs'), path.join(work, 'sandbox', 'instrument', 'v8-coverage-exit.cjs'));
// Los pasos 0a y 0b, con la propia herramienta: de ahí cruza verify la versión del motor.
fs.writeFileSync(path.join(work, 'runtime.yaml'), renderDoc(fingerprint(path.join(work, 'repo'))).text);
const env = renderDoc(envDeps(path.join(work, 'repo'))).plain;
env.adaptations = [{ what: 'red internal: true', why: 'el runtime no sale a internet (principio 5)' }];
fs.writeFileSync(path.join(work, 'environment.yaml'), YAML.stringify(env));

const composeFile = path.join(work, 'sandbox', 'compose.yaml');
const sandboxFile = path.join(work, 'sandbox', 'sandbox.yaml');
const pristineCompose = fs.readFileSync(composeFile, 'utf8');
const pristineSandbox = fs.readFileSync(sandboxFile, 'utf8');
const down = () => rt.compose(composeFile, 'rec-fixture', ['down', '-v']);

console.log(`runtime: ${runtime}\ntrabajo: ${work}\n── build (con red, aparte del runtime)`);
const build = spawnSync('bash', [path.join(work, 'sandbox', 'build.sh')], { stdio: 'inherit', env: { ...process.env, RUNTIME: runtime, MSYS_NO_PATHCONV: '1' } });
if (build.status !== 0) {
  console.error('el build de la fixture falló');
  process.exit(1);
}

const results = [];
for (const sc of SCENARIOS.filter((s) => !only || s.id === only)) {
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
  const sandbox = loadSandbox(sandboxFile);
  if (sandbox.errors.length) throw new Error(sandbox.errors.join('; '));
  const report = await verify(sandbox, rt, { log: (c) => console.log(`  ${c.ok ? 'OK   ' : c.skipped ? '·    ' : 'ROJO '} ${c.id}  ${c.detail}`) });
  const red = report.criteria.filter((c) => !c.ok && !c.skipped).map((c) => c.id).sort();
  const skipped = report.criteria.filter((c) => c.skipped).map((c) => c.id);
  let ok = JSON.stringify(red) === JSON.stringify([...sc.red].sort()) && report.ok === (sc.red.length === 0);
  if (sc.notRun) ok = ok && skipped.length > 0 && !exec(runtime, ['inspect', 'rec-fixture-app']).stdout.includes('"Running": true');
  if (sc.id === 'base') ok = ok && report.snapshot?.ok === true;
  if (sc.healthLies) {
    // La salud del legacy miente: el juez no la usa, y por eso sale en rojo con /health en 200.
    const h = exec(runtime, ['exec', 'rec-fixture-tool', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://stock:4000/health']).stdout.trim();
    console.log(`  /health del legacy: ${h}`);
    ok = ok && h === '200';
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
