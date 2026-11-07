#!/usr/bin/env node
// Resuelve, formatea, analiza, compila, prueba y ARRANCA de verdad el proyecto que genera keel-go.
//
// Por qué no está en `npm test`: necesita Go y red (proxy.golang.org descarga los módulos la primera vez), y
// tarda minutos. La suite de este paquete compara el texto emitido; esto es lo único que dice que ese texto es
// un módulo que `go mod tidy` no corrige, que gofmt deja en paz, que vet y staticcheck no tienen nada que
// decir, que compila sin cgo, que sus pruebas pasan (también con el detector de carreras, en un contenedor
// Linux), que todo lo que Go resuelve tiene licencia permisiva —herramientas incluidas— y que el servidor
// arranca y responde a sus sondas con el contrato de los otros tres generadores. Es el equivalente de
// `cs-check` de keel-dotnet, `ts-check` de keel-nest y `compile-check` de keel-spring, y como ellos se lanza
// antes de dar por bueno cualquier cambio en lo que se emite.
//
//   node packages/keel-go/scripts/go-check.js [--keep] [--no-race] [--fixtures] [--jobs=<n>] [--no-cache]
//   npm run go-check --workspace packages/keel-go
//
// --keep deja el proyecto generado (y dice dónde) para inspeccionarlo; --no-race se salta el paso del
// contenedor (sin podman ni docker); --fixtures solo compila y prueba el Go de todas las fixtures (las relacionales,
// también sobre MySQL); --jobs=<n> cuántas fixtures a la vez (por defecto, una por cada 3 GiB libres, hasta 4; cada
// una con su parte de las CPU en GOMAXPROCS). Una fixture cuyo Go emitido no cambió desde su última pasada en verde
// se salta (caché en `node_modules/.cache/keel-go-check/fixtures.json` de la raíz); --no-cache las comprueba todas.
// La caché del contenedor de -race son dos volúmenes `keel-go-race-*`: `podman volume rm` los vacía.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AUTHORSHIP_DESIGNS, TELEMETRY_DESIGNS, UNCOVERED_BRANCHES, makeWorkspace, mountDesign, runCommand, GO_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { ALLOWED_LICENSES, LICENSE_EXCEPTIONS, MODULES, TOOLS } from '../src/lib/go-stack.js';
import { GO_TOOLCHAIN } from '../src/lib/assets.js';
import { WIRE_SABOTAGES, applySabotage } from '../test/helpers/wire-sabotages.js';
import { DOMAIN_SABOTAGES, applySabotage as applyDomainSabotage } from '../test/helpers/domain-sabotages.js';
import { APPLICATION_SABOTAGES, applySabotage as applyApplicationSabotage } from '../test/helpers/application-sabotages.js';
import { API_SABOTAGES, applySabotage as applyApiSabotage } from '../test/helpers/api-sabotages.js';
import { CLIENTS_SABOTAGES, CLIENTS_SUBJECT, applySabotage as applyClientsSabotage } from '../test/helpers/clients-sabotages.js';
import { NEEDS_SABOTAGES, NEEDS_SUBJECT, applyNeedsSabotage } from '../test/helpers/needs-sabotages.js';
import { SCOPE_SABOTAGES, SCOPE_SUBJECT, applyScopeSabotage } from '../test/helpers/scope-sabotages.js';
import { STORAGE_SABOTAGES, STORAGE_SUBJECT, applySabotage as applyStorageSabotage } from '../test/helpers/storage-sabotages.js';
import { CONDITIONAL_SABOTAGES, applySabotage as applyConditionalSabotage } from '../test/helpers/conditional-sabotages.js';
import { TELEMETRY_SABOTAGES, TELEMETRY_SUBJECT, applyTelemetrySabotage } from '../test/helpers/telemetry-sabotages.js';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const keep = process.argv.includes('--keep');
// --fixtures: solo el paso que compila el Go de TODAS las fixtures (el más largo de iterar).
const onlyFixtures = process.argv.includes('--fixtures');
const race = !process.argv.includes('--no-race');
// --jobs=<n>: cuántas fixtures se comprueban a la vez (4 por defecto). Con poca memoria, --jobs=1 es el paso en serie.
const jobsArg = process.argv.find((arg) => arg.startsWith('--jobs='));
// Sin --jobs, una fixture por cada 3 GiB libres, entre 1 y 4: cada una lanza tidy, vet, staticcheck y el enlazado de
// sus binarios de prueba, y con 4 a la vez y la máquina de podman en marcha se agotaban 16 GB. Con una por cada 2 GiB,
// dos a la vez también los agotaron una vez (2026-10-31).
const jobs = jobsArg ? Number(jobsArg.slice('--jobs='.length)) : Math.max(1, Math.min(4, Math.floor(os.freemem() / (3 * 2 ** 30))));
// --no-cache: vuelve a comprobar también las fixtures sin cambios desde su última pasada en verde.
const useCache = !process.argv.includes('--no-cache');
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`--jobs=${jobsArg?.slice('--jobs='.length)}: tiene que ser un entero mayor que 0.`);
  process.exit(2);
}
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, stdout: result.stdout ?? '', error: result.error };
}

const go = (cwd, args, env) => run('go', args, cwd, env);

// Cada fixture en paralelo recibe su parte de las CPU: GOMAXPROCS fija el -p del comando go (cuántos compile, link y
// binarios de prueba a la vez) y lo heredan compile y staticcheck. GOMEMLIMIT es un límite blando: más GC, no un fallo.
const fixtureEnv = {
  ...process.env,
  GOMAXPROCS: String(Math.max(1, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / jobs))),
  GOMEMLIMIT: process.env.GOMEMLIMIT ?? '1536MiB',
};

/** Como run, sin bloquear: para comprobar varias fixtures a la vez. */
function runAsync(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: fixtureEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ ok: false, output: String(error), stdout: '' }));
    child.on('close', (status) => resolve({ ok: status === 0, output: `${stdout}${stderr}`, stdout }));
  });
}

/** Ejecuta work sobre cada elemento, como mucho size a la vez, y devuelve los resultados en el orden de items. */
async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(port, route) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => request.destroy());
  });
}

async function waitFor(port, route, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const response = await get(port, route);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

/** Los requisitos DIRECTOS y las herramientas de un go.mod: lo que build declara y tidy no puede mover. */
function declared(goMod) {
  return goMod
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('// indirect') && !/^(module|go|toolchain|require|tool) ?\(?$/.test(line) && line !== ')');
}

function containerRuntime() {
  for (const candidate of ['podman', 'docker']) {
    if (run(candidate, ['--version'], process.cwd()).ok) return candidate;
  }
  return null;
}

const version = go(process.cwd(), ['version']);
const [, major, minor] = version.output.match(/go(\d+)\.(\d+)/) ?? [];
if (!step('Go disponible', version.ok && (Number(major) > 1 || Number(minor) >= 27), version.ok ? version.output.trim() : 'instala Go: winget install GoLang.Go')) {
  process.exit(1);
}

// El Go de TODAS las fixtures, no solo el del diseño de referencia: planService no pasa por la frontera, así que
// también lo que se emite para un diseño que build todavía rechaza. Una rama que solo sale con cierta silueta (un
// lifecycle opcional, un value object con listas, un evento sin campos) no compila en otra fixture, y go-syntax no
// ve tipos. Cada fixture es su propio módulo: tidy (de la caché, tras el primero), gofmt, vet, staticcheck y sus
// pruebas emitidas.
//
// Las fixtures se generan en orden y se comprueban de `jobs` en `jobs` (cada una en su módulo: no comparten nada salvo
// las cachés de Go, que admiten acceso concurrente), y se informan en orden. Es el paso largo: en serie eran ~11 min.
const fixturesRoot = makeWorkspace('keel-go-fixtures-');
const fixtureDirs = [];
const checkedDesigns = [
  ...fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml'))).map((name) => ({ name, from: name, mutate: null })),
  // Lo que ninguna fixture declara: la autoría de política sobre product-catalog y la declarada (13g).
  ...AUTHORSHIP_DESIGNS,
  // Y las ramas que ninguna fixture declara (incremento 16): el parche que mide keel-dotnet, aquí compilado y con sus pruebas.
  ...UNCOVERED_BRANCHES
];
for (const { name, from, mutate } of checkedDesigns) {
  // Cada fixture con persistencia relacional, también sobre MySQL (tramo 6d): otro paquete, otro driver y otro SQL. Si es
  // relacional lo dice su stack por defecto: un MySQL pedido para un diseño documental no es un caso.
  let relational = false;
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
  if (mutate) mutate(manifest, layers);
  // Con capa messaging, con cada broker que keel-go conecta: sin broker en el stack no se emite su paquete, y su gofmt
  // no lo miraba nadie (corrida 9e, 2026-10-30: topology.go y rabbitmq_test.go sin formatear). Kafka (9f) y SNS/SQS (9g),
  // solo sobre el motor por defecto: lo que cambia con el motor no toca la conexión con el broker.
  const brokers = layers.messaging ? ['rabbitmq', 'kafka', 'snssqs'] : [null];
  for (const database of [null, 'mysql']) {
    if (database && !relational) continue;
    for (const broker of brokers) {
      if (database && (broker === 'kafka' || broker === 'snssqs')) continue;
      const stack = { ...(database ? { database } : {}), ...(broker ? { broker } : {}) };
      const plan = planService({ manifest, layers, workspace: fixturesRoot, ...(Object.keys(stack).length > 0 ? { stack } : {}) });
      relational ||= usesRelational(plan.model);
      const variant = [database, broker === 'kafka' || broker === 'snssqs' ? broker : null].filter(Boolean);
      const label = variant.length > 0 ? `${name} (${variant.join(', ')})` : name;
      const dir = path.join(fixturesRoot, [name, ...variant].join('-'));
      for (const file of plan.files) {
        const out = path.join(dir, file.path);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, file.content);
      }
      const hash = crypto.createHash('sha256').update(version.output);
      // Sin el markdown (skills, agentes, docs), que ningún paso lee: retocar una doc no vuelve a comprobar el Go. El de
      // config/ sí entra, porque va embebido en el binario.
      const checked = plan.files.filter((file) => !file.path.endsWith('.md') || file.path.startsWith('config/'));
      for (const file of checked.sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`\0${file.path}\0${file.content}`);
      fixtureDirs.push({ name: label, dir, digest: hash.digest('hex') });
    }
  }
}
// Las siluetas con telemetría (incremento 14): ninguna fixture la pide, y cada punto de paso observado cambia lo que compila.
for (const { name, from, stack } of TELEMETRY_DESIGNS) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
  const plan = planService({ manifest, layers, workspace: fixturesRoot, stack });
  const dir = path.join(fixturesRoot, name);
  for (const file of plan.files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const hash = crypto.createHash('sha256').update(version.output);
  const checked = plan.files.filter((file) => !file.path.endsWith('.md') || file.path.startsWith('config/'));
  for (const file of checked.sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`\0${file.path}\0${file.content}`);
  fixtureDirs.push({ name, dir, digest: hash.digest('hex') });
}
// Una fixture cuyo Go emitido es byte a byte el de su última pasada en verde, con el mismo `go version`, daría lo mismo:
// se salta. go.mod fija las versiones de las dependencias y de las herramientas, así que ya entran en la huella.
const cacheFile = path.join(here, '..', '..', '..', 'node_modules', '.cache', 'keel-go-check', 'fixtures.json');
let greenCache = {};
try {
  if (useCache) greenCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
} catch {
  greenCache = {};
}
const pending = fixtureDirs.filter(({ name, digest }) => greenCache[name] !== digest);
console.log(
  `Fixtures: ${fixtureDirs.length} variantes, ${fixtureDirs.length - pending.length} sin cambios desde su última pasada en verde; ` +
    `${pending.length} a comprobar, ${jobs} a la vez con GOMAXPROCS=${fixtureEnv.GOMAXPROCS}.`
);
const pendingProblems = await pool(pending, jobs, async ({ dir }) => {
  const problems = [];
  const tidied = await runAsync('go', ['mod', 'tidy'], dir);
  if (!tidied.ok) problems.push(`tidy: ${tidied.output}`);
  const unformatted = await runAsync('gofmt', ['-l', '.'], dir);
  if (unformatted.stdout.trim()) problems.push(`gofmt: ${unformatted.stdout.trim()}`);
  // vet y staticcheck, también sobre las pruebas de flujo (tras la restricción integration: sin ella no las ven). go test
  // con -vet=off: el vet entero ya pasó, y el subconjunto que lanza go test lo repetía paquete a paquete.
  for (const args of [['vet', '-tags', 'integration', './...'], ['tool', 'staticcheck', '-tags', 'integration', './...'], ['test', '-count=1', '-vet=off', './...']]) {
    const result = await runAsync('go', args, dir);
    if (!result.ok || (args[1] === 'staticcheck' && result.output.trim())) problems.push(`${args.join(' ')}: ${result.output.trim()}`);
  }
  return problems;
});
const problemsOf = new Map(pending.map(({ name }, index) => [name, pendingProblems[index]]));
for (const { name, digest } of fixtureDirs) {
  const label = `${name}: el Go emitido pasa tidy, gofmt, vet, staticcheck y sus pruebas`;
  const problems = problemsOf.get(name);
  if (!problems) step(label, true, 'sin cambios desde su última pasada en verde');
  else if (step(label, problems.length === 0)) greenCache[name] = digest;
  else {
    delete greenCache[name];
    console.error(problems.join('\n').slice(0, 4000));
  }
}
fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
fs.writeFileSync(cacheFile, `${JSON.stringify(greenCache, null, 2)}\n`);
if (onlyFixtures) {
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? `\ngo-check --fixtures: ${results.length}/${results.length} en verde.` : `\ngo-check --fixtures: ${failed} paso(s) en rojo.`);
  process.exit(failed === 0 ? 0 : 1);
}

const workspace = makeWorkspace('keel-go-go-check-');
mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${GO_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${GO_READY_DESIGN.name}-go`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}

// tidy escribe los indirectos y go.sum (lo que build no puede calcular sin Go), pero no puede mover nada de lo
// que build declaró: un requisito directo de más, de menos o en otra versión es un defecto del generador.
const emittedGoMod = fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf8');
const tidy = go(projectDir, ['mod', 'tidy']);
if (!step('go mod tidy', tidy.ok)) {
  console.error(tidy.output);
  process.exit(1);
}
const before = declared(emittedGoMod);
const after = declared(fs.readFileSync(path.join(projectDir, 'go.mod'), 'utf8'));
step(
  'tidy no cambia ningún requisito directo ni ninguna herramienta',
  JSON.stringify(before) === JSON.stringify(after),
  JSON.stringify(before) === JSON.stringify(after) ? `${before.length} líneas` : `build: ${before.join(', ')} | tidy: ${after.join(', ')}`
);
const tidyDiff = go(projectDir, ['mod', 'tidy', '-diff']);
step('go mod tidy -diff vacío (tidy es estable)', tidyDiff.ok && tidyDiff.stdout.trim() === '', tidyDiff.stdout.trim().slice(0, 300));
const verify = go(projectDir, ['mod', 'verify']);
if (!step('go mod verify', verify.ok)) console.error(verify.output);

const unformatted = run('gofmt', ['-l', '.'], projectDir);
step('gofmt -l vacío', unformatted.ok && unformatted.stdout.trim() === '', unformatted.stdout.trim().split('\n').join(', '));
// Con la restricción integration: las pruebas de flujo (tests/integration) también pasan vet y staticcheck.
const vet = go(projectDir, ['vet', '-tags', 'integration', './...']);
if (!step('go vet -tags integration ./... limpio', vet.ok)) console.error(vet.output);
const staticcheck = go(projectDir, ['tool', 'staticcheck', '-tags', 'integration', './...']);
if (!step('staticcheck sin hallazgos', staticcheck.ok && staticcheck.output.trim() === '')) console.error(staticcheck.output);

const binary = path.join(projectDir, 'bin', isWindows ? 'server.exe' : 'server');
const compiled = go(projectDir, ['build', '-trimpath', '-ldflags=-s -w', '-o', binary, './cmd/server'], { CGO_ENABLED: '0' });
if (!step('go build sin cgo (CGO_ENABLED=0, -trimpath)', compiled.ok)) console.error(compiled.output);
const allBuilt = go(projectDir, ['build', './...'], { CGO_ENABLED: '0' });
if (!step('go build ./...', allBuilt.ok)) console.error(allBuilt.output);

// Las pruebas por gotestsum, que es como las leerá score-scenarios.sh (su JUnit).
const junit = path.join(projectDir, 'build', 'test-results.xml');
const tested = go(projectDir, ['tool', 'gotestsum', '--format', 'testname', '--junitfile', junit, '--junitfile-testcase-classname', 'short', '--', '-count=1', './...']);
if (!step('go test ./... (gotestsum, con su JUnit)', tested.ok && fs.existsSync(junit))) console.error(tested.output);

// El contrato del cable se falsa: cada sabotaje rompe una regla en el Go emitido y su prueba tiene que salir en
// rojo. Se restaura el archivo pase lo que pase, porque los pasos siguientes miden el proyecto tal cual.
for (const sabotage of WIRE_SABOTAGES) {
  const file = path.join(projectDir, sabotage.file);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = applySabotage(sabotage, original);
  if (!mutated) {
    step(`cable falsado: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
    continue;
  }
  fs.writeFileSync(file, mutated);
  const sabotaged = go(projectDir, ['test', '-count=1', './internal/platform/wire/']);
  fs.writeFileSync(file, original);
  const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1]);
  step(`cable falsado: ${sabotage.id} (${sabotage.what}) → ${sabotage.fails} en rojo`, !sabotaged.ok && failed.includes(sabotage.fails), failed.join(' ').slice(0, 200));
}

// La sonda del dominio: Go de verdad que ejecuta lo que el texto no deja ver (la escala normalizada, el rechazo con
// 400, el ancla del formato, la transición negada con 409, los centinelas). Va dentro de internal/domain como
// prueba interna, y cada sabotaje tiene que tumbar exactamente la prueba que nombra.
const probe = path.join(projectDir, 'internal', 'domain', 'domain_probe_test.go');
fs.copyFileSync(path.join(here, 'probes', 'domain_probe_test.go'), probe);
const probed = go(projectDir, ['test', '-count=1', '-run', 'Probe', './internal/domain/']);
if (!step('la sonda del dominio en verde (escala, cotas, enum, formato, lifecycle, centinelas)', probed.ok)) console.error(probed.output);
for (const sabotage of DOMAIN_SABOTAGES) {
  const file = path.join(projectDir, sabotage.file);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = applyDomainSabotage(sabotage, original);
  if (!mutated) {
    step(`dominio falsado: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
    continue;
  }
  fs.writeFileSync(file, mutated);
  const sabotaged = go(projectDir, ['test', '-count=1', '-run', 'Probe', './internal/domain/']);
  fs.writeFileSync(file, original);
  const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
  const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].sort().join(' ');
  const exact = [...new Set(failed)].sort().join(' ') === expected;
  step(`dominio falsado: ${sabotage.id} (${sabotage.what}) → ${expected} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
}
fs.rmSync(probe);

// La APLICACIÓN se mide con sus pruebas emitidas (use_cases_test.go: cada operación cableada, el decorador del log de
// frontera deja pasar resultado y error, y un rechazo del dominio va a Info con su code; idempotency_test.go: la forma
// canónica de la firma y el code de cada conflicto). Cada sabotaje tiene que tumbar exactamente las pruebas que nombra.
const appTests = ['test', '-count=1', './internal/application/'];
const wired = go(projectDir, appTests);
if (!step('la prueba emitida del cableado de la aplicación en verde', wired.ok)) console.error(wired.output);
for (const sabotage of APPLICATION_SABOTAGES) {
  const file = path.join(projectDir, sabotage.file);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = applyApplicationSabotage(sabotage, original);
  if (!mutated) {
    step(`aplicación falsada: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
    continue;
  }
  fs.writeFileSync(file, mutated);
  const sabotaged = go(projectDir, appTests);
  fs.writeFileSync(file, original);
  const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
  const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].sort().join(' ');
  const exact = [...new Set(failed)].sort().join(' ') === expected;
  step(`aplicación falsada: ${sabotage.id} (${sabotage.what}) → ${expected} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
}

// La API se mide con sus pruebas emitidas (api_test.go, el contrato sobre el enrutador real; edge_test.go, el borde
// por dentro). Cada sabotaje tiene que tumbar exactamente las pruebas que nombra.
const apiTests = ['test', '-count=1', './internal/httpapi/'];
const served = go(projectDir, apiTests);
if (!step('las pruebas emitidas de la API en verde (contrato, 404/405/413, correlación, borde)', served.ok)) console.error(served.output);
for (const sabotage of API_SABOTAGES) {
  const file = path.join(projectDir, sabotage.file);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = applyApiSabotage(sabotage, original);
  if (!mutated) {
    step(`API falsada: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
    continue;
  }
  fs.writeFileSync(file, mutated);
  const sabotaged = go(projectDir, apiTests);
  fs.writeFileSync(file, original);
  const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
  const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].sort().join(' ');
  const exact = [...new Set(failed)].sort().join(' ') === expected;
  step(`API falsada: ${sabotage.id} (${sabotage.what}) → ${expected} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
}

// Los clientes salientes (incremento 11b) se falsan sobre stock-reservation, el único diseño en alcance con http-clients:
// la prueba emitida en verde y cada sabotaje en rojo con su prueba, y solo ella.
{
  const clientsDir = path.join(makeWorkspace('keel-go-clients-'), CLIENTS_SUBJECT);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, CLIENTS_SUBJECT));
  for (const file of planService({ manifest, layers, workspace: clientsDir }).files) {
    const out = path.join(clientsDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const clientsTests = ['test', '-count=1', './internal/infrastructure/clients/'];
  const tidied = go(clientsDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(clientsDir, clientsTests) : tidied;
  if (step(`clientes salientes: la prueba emitida de ${CLIENTS_SUBJECT} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    for (const sabotage of CLIENTS_SABOTAGES) {
      const file = path.join(clientsDir, sabotage.file);
      const original = fs.readFileSync(file, 'utf8');
      const mutated = applyClientsSabotage(sabotage, original);
      if (!mutated) {
        step(`clientes falsados: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
        continue;
      }
      fs.writeFileSync(file, mutated);
      const sabotaged = go(clientsDir, clientsTests);
      fs.writeFileSync(file, original);
      const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
      const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].sort().join(' ');
      const exact = [...new Set(failed)].sort().join(' ') === expected;
      step(`clientes falsados: ${sabotage.id} (${sabotage.what}) → ${expected} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
    }
  }
}

// Los needs y OAuth2 (tramo 13h) se falsan sobre catalog-extended, la fixture que los declara: la prueba emitida de los
// clientes en verde, y cada sabotaje en rojo con sus pruebas, y solo ellas.
{
  const needsDir = path.join(makeWorkspace('keel-go-needs-'), NEEDS_SUBJECT);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, NEEDS_SUBJECT));
  const files = planService({ manifest, layers, workspace: needsDir }).files;
  const write = (list) => {
    for (const file of list) {
      const out = path.join(needsDir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content);
    }
  };
  write(files);
  const clientsTests = ['test', '-count=1', './internal/infrastructure/clients/'];
  const tidied = go(needsDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(needsDir, clientsTests) : tidied;
  if (step(`needs y OAuth2: la prueba emitida de los clientes de ${NEEDS_SUBJECT} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    for (const [id, sabotage] of Object.entries(NEEDS_SABOTAGES)) {
      write(applyNeedsSabotage(sabotage, files).filter((file) => file.path === sabotage.file));
      const sabotaged = go(needsDir, clientsTests);
      write(files.filter((file) => file.path === sabotage.file));
      const failed = [...new Set([...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]))];
      step(`needs y OAuth2 falsados: ${id} → ${failed.join(' ')}`, !sabotaged.ok && failed.length > 0 && failed.every((name) => sabotage.expect.test(name)), failed.join(' ').slice(0, 300));
    }
  }
}

// El compuesto de una llamada saliente (incremento 16) se falsa sobre su parche: el lector sin exigir un obligatorio le pasaría
// al constructor su valor cero, y el contrato roto del proveedor llegaría al dominio como un importe de 0.
{
  const design = UNCOVERED_BRANCHES.find((candidate) => candidate.name === 'stock-reservation-compuesto-saliente');
  const compositeDir = path.join(makeWorkspace('keel-go-composite-'), design.name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  design.mutate(manifest, layers);
  for (const file of planService({ manifest, layers, workspace: compositeDir }).files) {
    const out = path.join(compositeDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const clientsTests = ['test', '-count=1', './internal/infrastructure/clients/'];
  const tidied = go(compositeDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(compositeDir, clientsTests) : tidied;
  if (step(`compuesto saliente: la prueba emitida de ${design.name} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    const file = path.join(compositeDir, 'internal/domain/refund.go');
    const original = fs.readFileSync(file, 'utf8');
    const find = 'return Errorf(ErrInvalidValue, "Refund.amount es obligatorio")';
    const mutated = original.replace(find, () => 'zero := wire.MustDecimal("0")\n\t\tin.Amount = &zero');
    fs.writeFileSync(file, mutated);
    const sabotaged = mutated === original ? null : go(compositeDir, clientsTests);
    fs.writeFileSync(file, original);
    const failed = [...new Set([...(sabotaged?.output ?? '').matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]))];
    step(`compuesto saliente falsado: el obligatorio sin exigir → ${failed.join(' ')}`, sabotaged != null && !sabotaged.ok && failed.length > 0 && failed.every((name) => /QueNoSeConstruyeViolaElContrato$/.test(name)), failed.join(' ').slice(0, 300));
  }
}

// El alcance por recurso (tramo 13h-b) se falsa sobre asset-vault, la fixture que lo declara: la prueba emitida en verde, y cada
// sabotaje en rojo con sus pruebas, y solo ellas.
{
  const scopeDir = path.join(makeWorkspace('keel-go-scope-'), SCOPE_SUBJECT);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SCOPE_SUBJECT));
  const files = planService({ manifest, layers, workspace: scopeDir }).files;
  const write = (list) => {
    for (const file of list) {
      const out = path.join(scopeDir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content);
    }
  };
  write(files);
  const scopeTests = ['test', '-count=1', './internal/platform/security/'];
  const tidied = go(scopeDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(scopeDir, scopeTests) : tidied;
  if (step(`alcance: la prueba emitida de ${SCOPE_SUBJECT} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    for (const [id, sabotage] of Object.entries(SCOPE_SABOTAGES)) {
      write(applyScopeSabotage(sabotage, files).filter((file) => file.path === sabotage.file));
      const sabotaged = go(scopeDir, scopeTests);
      write(files.filter((file) => file.path === sabotage.file));
      const failed = [...new Set([...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]))];
      step(`alcance falsado: ${id} → ${failed.join(' ')}`, !sabotaged.ok && failed.length > 0 && failed.every((name) => sabotage.expect.test(name)), failed.join(' ').slice(0, 300));
    }
  }
}

// El almacenamiento (tramo 13f) se falsa sobre catalog-extended, la fixture con una subida de campos con muestra y un
// bucket público: las pruebas emitidas de la subida (internal/httpapi) y de la política (internal/domain) en verde, y cada
// sabotaje en rojo con sus pruebas, y solo ellas. Con licencias y vulnerabilidades del SDK de S3 que entra con la capa.
{
  const storageDir = path.join(makeWorkspace('keel-go-storage-'), STORAGE_SUBJECT);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, STORAGE_SUBJECT));
  for (const file of planService({ manifest, layers, workspace: storageDir }).files) {
    const out = path.join(storageDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const storageTests = (packages) => ['test', '-count=1', ...packages];
  const tidied = go(storageDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(storageDir, storageTests(['./internal/httpapi/', './internal/domain/'])) : tidied;
  if (step(`almacenamiento: las pruebas emitidas de ${STORAGE_SUBJECT} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    for (const sabotage of STORAGE_SABOTAGES) {
      const file = path.join(storageDir, sabotage.file);
      const original = fs.readFileSync(file, 'utf8');
      const mutated = applyStorageSabotage(sabotage, original);
      if (!mutated) {
        step(`almacenamiento falsado: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
        continue;
      }
      fs.writeFileSync(file, mutated);
      const sabotaged = go(storageDir, storageTests([sabotage.packages]));
      fs.writeFileSync(file, original);
      const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
      const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].sort().join(' ');
      const exact = [...new Set(failed)].sort().join(' ') === expected;
      step(`almacenamiento falsado: ${sabotage.id} (${sabotage.what}) → ${expected} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
    }
  }
  const storageVuln = go(storageDir, ['tool', 'govulncheck', './...']);
  if (!step(`almacenamiento: govulncheck sin vulnerabilidades en ${STORAGE_SUBJECT}`, storageVuln.ok)) console.error(storageVuln.output);
  const storageLicenses = go(storageDir, ['tool', 'go-licenses', 'check', '--ignore', 'catalog', `--allowed_licenses=${ALLOWED_LICENSES.join(',')}`, './...']);
  if (!step(`almacenamiento: licencias permisivas en ${STORAGE_SUBJECT} (SDK de S3 incluido)`, storageLicenses.ok)) console.error(storageLicenses.output);
}

// La escritura condicional (DSL 2.25) se falsa sobre sus siluetas (keel-core/test/helpers/conditional-write-designs.js): las
// pruebas emitidas del borde y de la caché en verde (CW-6 a CW-11), y cada sabotaje en rojo con su prueba, y solo ella.
{
  const subjects = [...new Set(CONDITIONAL_SABOTAGES.map((sabotage) => sabotage.subject))];
  for (const subject of subjects) {
    const branch = UNCOVERED_BRANCHES.find((candidate) => candidate.name === subject);
    const dir = path.join(makeWorkspace('keel-go-conditional-'), subject);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, branch.from));
    branch.mutate(manifest, layers);
    for (const file of planService({ manifest, layers, workspace: dir }).files) {
      const out = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, file.content);
    }
    const conditionalTests = (packages) => ['test', '-count=1', ...packages];
    const tidied = go(dir, ['mod', 'tidy']);
    const baseline = tidied.ok ? go(dir, conditionalTests(['./internal/httpapi/', './internal/application/'])) : tidied;
    if (!step(`escritura condicional: las pruebas emitidas de ${subject} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) continue;
    for (const sabotage of CONDITIONAL_SABOTAGES.filter((candidate) => candidate.subject === subject)) {
      const file = path.join(dir, sabotage.file);
      const original = fs.readFileSync(file, 'utf8');
      const mutated = applyConditionalSabotage(sabotage, original);
      if (!mutated) {
        step(`escritura condicional falsada: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
        continue;
      }
      fs.writeFileSync(file, mutated);
      const sabotaged = go(dir, conditionalTests([sabotage.packages]));
      fs.writeFileSync(file, original);
      const failed = [...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]);
      const exact = [...new Set(failed)].sort().join(' ') === sabotage.fails;
      step(`escritura condicional falsada: ${sabotage.id} (${sabotage.what}) → ${sabotage.fails} en rojo, y solo eso`, !sabotaged.ok && exact, failed.join(' ').slice(0, 200) || sabotaged.output.slice(0, 300));
    }
  }
}

// La telemetría y los logs (incremento 14) se falsan sobre una silueta con telemetría y mensajería: las pruebas emitidas en verde,
// y cada sabotaje en rojo con sus pruebas, y solo ellas. Con licencias y vulnerabilidades de lo que entra con el stack.
{
  const telemetryDir = path.join(makeWorkspace('keel-go-telemetry-'), TELEMETRY_SUBJECT.from);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, TELEMETRY_SUBJECT.from));
  for (const file of planService({ manifest, layers, workspace: telemetryDir, stack: TELEMETRY_SUBJECT.stack }).files) {
    const out = path.join(telemetryDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const packages = ['./internal/platform/telemetry/', './internal/platform/logging/', './internal/infrastructure/messaging/'];
  const tidied = go(telemetryDir, ['mod', 'tidy']);
  const baseline = tidied.ok ? go(telemetryDir, ['test', '-count=1', ...packages]) : tidied;
  if (step(`telemetría y logs: las pruebas emitidas de ${TELEMETRY_SUBJECT.from} en verde`, baseline.ok, baseline.ok ? '' : baseline.output.slice(0, 600))) {
    for (const sabotage of TELEMETRY_SABOTAGES) {
      const file = path.join(telemetryDir, sabotage.file);
      const original = fs.readFileSync(file, 'utf8');
      const mutated = applyTelemetrySabotage(sabotage, original);
      if (!mutated) {
        step(`telemetría falsada: ${sabotage.id}`, false, `el sabotaje ya no se aplica a ${sabotage.file}`);
        continue;
      }
      fs.writeFileSync(file, mutated);
      const sabotaged = go(telemetryDir, ['test', '-count=1', sabotage.packages]);
      fs.writeFileSync(file, original);
      const failed = [...new Set([...sabotaged.output.matchAll(/--- FAIL: (\S+)/g)].map((match) => match[1].split('/')[0]))].sort();
      const optional = sabotage.optional ?? [];
      const expected = [sabotage.fails, ...(sabotage.alsoFails ?? [])].filter((name) => !optional.includes(name)).sort();
      const exact = sabotage.anyFailure ? failed.length > 0 : failed.filter((name) => !optional.includes(name)).join(' ') === expected.join(' ');
      step(`telemetría falsada: ${sabotage.id} (${sabotage.what}) → ${sabotage.anyFailure ? 'en rojo' : `${expected.join(' ')} en rojo, y solo eso`}`, !sabotaged.ok && exact, failed.join(' ').slice(0, 300) || sabotaged.output.slice(0, 300));
    }
    const telemetryVuln = go(telemetryDir, ['tool', 'govulncheck', './...']);
    if (!step('telemetría: govulncheck sin vulnerabilidades (OpenTelemetry y client_golang)', telemetryVuln.ok)) console.error(telemetryVuln.output);
    const telemetryLicenses = go(telemetryDir, ['tool', 'go-licenses', 'check', '--ignore', TELEMETRY_SUBJECT.from, `--allowed_licenses=${ALLOWED_LICENSES.join(',')}`, './...']);
    if (!step('telemetría: licencias permisivas (OpenTelemetry, client_golang y sus transitivos)', telemetryLicenses.ok)) console.error(telemetryLicenses.output);
  }
}

// La frontera hexagonal se falsa: un import plantado del dominio a otro paquete de la plataforma (solo puede usar
// wire) tiene que ponerla en rojo. No a httpapi: httpapi importa el dominio, y ese import cerraría un ciclo que Go
// rechaza antes de que la prueba de arquitectura diga nada.
const planted = path.join(projectDir, 'internal', 'domain', 'planted.go');
fs.writeFileSync(planted, `package domain\n\nimport "${GO_READY_DESIGN.name}/internal/platform/health"\n\nvar _ health.Probes\n`);
const boundary = go(projectDir, ['test', '-count=1', './internal/architecture/']);
fs.rmSync(planted);
step(
  'la frontera sale en rojo con un import plantado (dominio → platform/health)',
  !boundary.ok && /internal\/domain \(domain\) importa internal\/platform\/health/.test(boundary.output),
  boundary.ok ? '' : boundary.output.slice(0, 300)
);

const vuln = go(projectDir, ['tool', 'govulncheck', './...']);
if (!step('govulncheck sin vulnerabilidades', vuln.ok)) console.error(vuln.output);

// Las licencias de todo lo que Go resuelve: el servicio y las herramientas, transitivos incluidos. El propio
// módulo no tiene LICENSE (es del equipo que lo despliega) y se ignora.
const allowed = `--allowed_licenses=${ALLOWED_LICENSES.join(',')}`;
const toolPackages = TOOLS.map((module) => MODULES[module].tool);
const licenses = go(projectDir, ['tool', 'go-licenses', 'check', '--ignore', GO_READY_DESIGN.name, allowed, './...', ...toolPackages]);
if (!step('licencias permisivas en el servicio y en las herramientas (go-licenses)', licenses.ok)) console.error(licenses.output);
// Y se falsa: con una licencia que sí aparece fuera de la lista, el mismo check tiene que salir en rojo.
const narrowed = go(projectDir, ['tool', 'go-licenses', 'check', '--ignore', GO_READY_DESIGN.name, '--allowed_licenses=MIT,Apache-2.0', './...', ...toolPackages]);
step('el check de licencias sale en rojo sin BSD-3-Clause en la lista (falsado)', !narrowed.ok);

// MySQL: el driver es MPL-2.0, admitido como EXCEPCIÓN de ese módulo (LICENSE_EXCEPTIONS de go-stack.js), nunca en la
// lista. go-licenses lo perdona por nombre y todo lo demás —transitivos del driver incluidos— cumple la lista; y se
// falsa: sin perdonarlo, el mismo check sale en rojo.
const mysqlDir = path.join(makeWorkspace('keel-go-licenses-mysql-'), GO_READY_DESIGN.name);
{
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, GO_READY_DESIGN.name));
  for (const file of planService({ manifest, layers, workspace: mysqlDir, stack: { database: 'mysql' } }).files) {
    const out = path.join(mysqlDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
}
const mysqlTidy = go(mysqlDir, ['mod', 'tidy']);
if (step('MySQL: go mod tidy del diseño de referencia', mysqlTidy.ok, mysqlTidy.ok ? '' : mysqlTidy.output.slice(0, 1000))) {
  const forgiven = Object.keys(LICENSE_EXCEPTIONS).flatMap((module) => ['--ignore', module]);
  const mysqlLicenses = go(mysqlDir, ['tool', 'go-licenses', 'check', '--ignore', GO_READY_DESIGN.name, ...forgiven, allowed, './...']);
  if (!step(`MySQL: licencias permisivas salvo la excepción escrita (${Object.keys(LICENSE_EXCEPTIONS).join(', ')})`, mysqlLicenses.ok)) console.error(mysqlLicenses.output);
  const unforgiven = go(mysqlDir, ['tool', 'go-licenses', 'check', '--ignore', GO_READY_DESIGN.name, allowed, './...']);
  step('MySQL: sin perdonar la excepción, el check sale en rojo con MPL-2.0 (falsado)', !unforgiven.ok && /MPL-2\.0/.test(unforgiven.output), unforgiven.ok ? 'salió verde' : '');
}

// La mensajería con RabbitMQ: el cliente (amqp091-go) y lo que trae, contra la misma lista. El diseño de referencia no
// tiene mensajería, así que se mide sobre stock-reservation-events.
const MESSAGING_DESIGN = 'stock-reservation-events';
const rabbitDir = path.join(makeWorkspace('keel-go-licenses-rabbit-'), MESSAGING_DESIGN);
{
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, MESSAGING_DESIGN));
  for (const file of planService({ manifest, layers, workspace: rabbitDir, stack: { broker: 'rabbitmq', database: 'postgresql' } }).files) {
    const out = path.join(rabbitDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
}
const rabbitTidy = go(rabbitDir, ['mod', 'tidy']);
if (step(`RabbitMQ: go mod tidy de ${MESSAGING_DESIGN}`, rabbitTidy.ok, rabbitTidy.ok ? '' : rabbitTidy.output.slice(0, 1000))) {
  const rabbitLicenses = go(rabbitDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, allowed, './...']);
  if (!step('RabbitMQ: licencias permisivas con el cliente amqp091-go', rabbitLicenses.ok)) console.error(rabbitLicenses.output);
  // Falsado: amqp091-go es BSD-2-Clause, la única con ella en el grafo; sin ella en la lista, rojo.
  const narrowedRabbit = go(rabbitDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, `--allowed_licenses=${ALLOWED_LICENSES.filter((id) => id !== 'BSD-2-Clause').join(',')}`, './...']);
  step('RabbitMQ: sin BSD-2-Clause en la lista, el check sale en rojo con amqp091-go (falsado)', !narrowedRabbit.ok && /amqp091-go/.test(narrowedRabbit.output), narrowedRabbit.ok ? 'salió verde' : '');
}

// Kafka (9f): franz-go y lo que trae (su protocolo y la compresión), contra la misma lista.
const kafkaDir = path.join(makeWorkspace('keel-go-licenses-kafka-'), MESSAGING_DESIGN);
{
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, MESSAGING_DESIGN));
  for (const file of planService({ manifest, layers, workspace: kafkaDir, stack: { broker: 'kafka', database: 'postgresql' } }).files) {
    const out = path.join(kafkaDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
}
const kafkaDeclared = declared(fs.readFileSync(path.join(kafkaDir, 'go.mod'), 'utf8'));
const kafkaTidy = go(kafkaDir, ['mod', 'tidy']);
const kafkaMoved = kafkaTidy.ok ? JSON.stringify(declared(fs.readFileSync(path.join(kafkaDir, 'go.mod'), 'utf8'))) !== JSON.stringify(kafkaDeclared) : false;
if (step(`Kafka: go mod tidy de ${MESSAGING_DESIGN}, sin mover ningún requisito directo`, kafkaTidy.ok && !kafkaMoved, kafkaTidy.ok ? (kafkaMoved ? 'tidy movió un requisito directo' : '') : kafkaTidy.output.slice(0, 1000))) {
  const kafkaLicenses = go(kafkaDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, allowed, './...']);
  if (!step('Kafka: licencias permisivas con el cliente franz-go y sus transitivos', kafkaLicenses.ok)) console.error(kafkaLicenses.output);
  // Falsado: franz-go es BSD-3-Clause; sin ella en la lista, rojo nombrando el módulo.
  const narrowedKafka = go(kafkaDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, `--allowed_licenses=${ALLOWED_LICENSES.filter((id) => id !== 'BSD-3-Clause').join(',')}`, './...']);
  step('Kafka: sin BSD-3-Clause en la lista, el check sale en rojo con franz-go (falsado)', !narrowedKafka.ok && /franz-go/.test(narrowedKafka.output), narrowedKafka.ok ? 'salió verde' : '');
}

// SNS/SQS (9g): el SDK de AWS para Go, publicado por módulos que salen juntos en cada release, y lo que trae (smithy-go y
// sus módulos internos). Los directos fijados son los de UNA release: tidy no puede mover ninguno.
const snsDir = path.join(makeWorkspace('keel-go-licenses-snssqs-'), MESSAGING_DESIGN);
{
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, MESSAGING_DESIGN));
  for (const file of planService({ manifest, layers, workspace: snsDir, stack: { broker: 'snssqs', database: 'postgresql' } }).files) {
    const out = path.join(snsDir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
}
const snsDeclared = declared(fs.readFileSync(path.join(snsDir, 'go.mod'), 'utf8'));
const snsTidy = go(snsDir, ['mod', 'tidy']);
const snsMoved = snsTidy.ok ? JSON.stringify(declared(fs.readFileSync(path.join(snsDir, 'go.mod'), 'utf8'))) !== JSON.stringify(snsDeclared) : false;
if (step(`SNS/SQS: go mod tidy de ${MESSAGING_DESIGN}, sin mover ningún requisito directo`, snsTidy.ok && !snsMoved, snsTidy.ok ? (snsMoved ? 'tidy movió un requisito directo' : '') : snsTidy.output.slice(0, 1000))) {
  const snsLicenses = go(snsDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, allowed, './...']);
  if (!step('SNS/SQS: licencias permisivas con el SDK de AWS y sus transitivos', snsLicenses.ok)) console.error(snsLicenses.output);
  // Falsado: el SDK es Apache-2.0; sin ella en la lista, rojo nombrando el módulo.
  const narrowedSns = go(snsDir, ['tool', 'go-licenses', 'check', '--ignore', MESSAGING_DESIGN, `--allowed_licenses=${ALLOWED_LICENSES.filter((id) => id !== 'Apache-2.0').join(',')}`, './...']);
  step('SNS/SQS: sin Apache-2.0 en la lista, el check sale en rojo con aws-sdk-go-v2 (falsado)', !narrowedSns.ok && /aws-sdk-go-v2/.test(narrowedSns.output), narrowedSns.ok ? 'salió verde' : '');
}

if (race) {
  const runtime = containerRuntime();
  if (!runtime) step('go test -race en contenedor', false, 'sin podman ni docker (o --no-race)');
  else {
    // -race exige cgo, y en Windows no hay gcc: se ejecuta en la imagen oficial, con el mismo toolchain. Los módulos y
    // la caché de compilación van en volúmenes con nombre, que sobreviven al contenedor: sin ellos, cada corrida volvía a
    // descargar el grafo entero y a recompilar con la instrumentación de -race la stdlib y todas las dependencias. Un
    // volumen por toolchain, para que una caché de otra versión no se cruce.
    const image = `docker.io/library/golang:${GO_TOOLCHAIN.replace(/^go/, '')}`;
    const caches = ['-v', `keel-go-race-mod-${GO_TOOLCHAIN}:/go/pkg/mod`, '-v', `keel-go-race-build-${GO_TOOLCHAIN}:/root/.cache/go-build`];
    const raced = run(runtime, ['run', '--rm', '-v', `${projectDir}:/src`, ...caches, '-w', '/src', '-e', 'GOFLAGS=-mod=mod', image, 'go', 'test', '-race', '-count=1', './...'], projectDir);
    if (!step(`go test -race ./... en ${image}`, raced.ok)) console.error(raced.output.slice(-4000));
  }
}

// El binario arranca contra un PostgreSQL de verdad (el diseño tiene persistencia): sin base no arranca, y al arrancar
// aplica las migraciones de goose. En el perfil develop, que toma DB_URL del entorno.
const database = await startDatabase();
if (fs.existsSync(binary) && database) {
  const port = await freePort();
  const app = spawn(binary, [], { cwd: workspace, env: { ...process.env, ...database.env, PROFILE: 'develop', SERVER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let appOutput = '';
  app.stdout.on('data', (chunk) => (appOutput += chunk));
  app.stderr.on('data', (chunk) => (appOutput += chunk));
  const exited = new Promise((resolve) => app.on('exit', (code, signal) => resolve({ code, signal })));

  // El binario se lanza desde OTRO directorio: la configuración va embebida, no se lee del de trabajo.
  const livez = await waitFor(port, '/livez', 30_000);
  step('el binario arranca fuera del proyecto y GET /livez → 200 {"status":"UP"}', livez?.status === 200 && livez.body === '{"status":"UP"}', livez ? `${livez.status} ${livez.body}` : 'no respondió en 30 s');
  const applied = database.query('SELECT count(*) FROM goose_db_version WHERE version_id > 0; SELECT count(*) FROM information_schema.tables WHERE table_name = \'products\';');
  step('al arrancar, goose aplica la baseline (goose_db_version y la tabla products)', applied.ok && applied.stdout.trim().split(/\s+/).join(',') === '1,1', applied.output.trim().slice(0, 300));
  const readyz = await get(port, '/readyz');
  step('GET /readyz → 200 {"status":"UP"}', readyz?.status === 200 && readyz.body === '{"status":"UP"}', readyz ? `${readyz.status} ${readyz.body}` : 'sin respuesta');
  const missing = await get(port, '/no-existe');
  step('una ruta que no existe → 404 con ErrorResponse', missing?.status === 404 && /"error":"Not Found"/.test(missing.body), missing ? `${missing.status} ${missing.body}` : 'sin respuesta');
  // Una operación recién generada llega a su handler, que todavía no está escrito: 500 con ErrorResponse, no un 404.
  const operation = await get(port, '/api/v1/products/0192f1d2-0000-7000-8000-000000000001');
  step(
    'GET /api/v1/products/{id} llega a su handler sin escribir → 500 con ErrorResponse y su correlación',
    operation?.status === 500 && /"code":null/.test(operation.body) && /"correlationId":"[0-9a-f-]{36}"/.test(operation.body),
    operation ? `${operation.status} ${operation.body}` : 'sin respuesta'
  );

  // Fuera de local la consola es JSON ECS, línea a línea: también las del arranque.
  const consoleLines = appOutput.split(/\r?\n/).filter(Boolean);
  const notEcs = consoleLines.filter((line) => {
    try {
      const parsed = JSON.parse(line);
      return !(parsed['@timestamp'] && parsed.log?.level && parsed.log?.logger && parsed.message && parsed.service?.name && parsed.ecs?.version);
    } catch {
      return true;
    }
  });
  step(`la consola en develop es JSON ECS línea a línea (${consoleLines.length} líneas)`, consoleLines.length > 0 && notEcs.length === 0, notEcs.slice(0, 3).join(' | ').slice(0, 400));
  const correlated = consoleLines.some((line) => /"correlationId":"[0-9a-f-]{36}"/.test(line));
  step('una línea de una petición lleva su correlationId', correlated);

  app.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  if (isWindows) {
    // En Windows SIGTERM termina el proceso sin dejarle ejecutar nada: el apagado ordenado no se puede observar
    // aquí. Se dice en voz alta en vez de darlo por bueno; lo cubre la prueba emitida del arranque, que cancela el
    // contexto y recorre el mismo camino.
    console.log('(no medido) apagado ordenado tras SIGTERM — en Windows la señal mata el proceso sin ejecutar nada');
  } else {
    step('SIGTERM → apagado ordenado con salida 0', end?.code === 0, end ? `code=${end.code} signal=${end.signal}` : 'no terminó en 15 s');
  }
  if (!end) app.kill('SIGKILL');
  if (results.some((result) => !result.ok)) console.error(appOutput);
}
database?.stop();

/** Un PostgreSQL efímero en un puerto libre, o null (con su paso en rojo) si no hay contenedores. */
async function startDatabase() {
  const runtime = containerRuntime();
  if (!step('podman o docker para el PostgreSQL del arranque', Boolean(runtime))) return null;
  const engine = DATABASES.postgresql;
  const dbPort = await freePort();
  const name = `keel-go-check-${process.pid}`;
  const started = run(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${dbPort}:5432`, '-e', `POSTGRES_PASSWORD=${engine.password}`, engine.image], process.cwd());
  if (!step(`PostgreSQL (${engine.image}) en el puerto ${dbPort}`, started.ok, started.output.slice(0, 300))) return null;
  const query = (sql) => run(runtime, ['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-c', sql], process.cwd());
  const until = Date.now() + 60_000;
  while (Date.now() < until && !query('SELECT 1').ok) await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    env: { DB_URL: `jdbc:postgresql://127.0.0.1:${dbPort}/postgres`, DB_USERNAME: 'postgres', DB_PASSWORD: engine.password },
    query,
    stop: () => run(runtime, ['rm', '-f', name], process.cwd())
  };
}

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // El directorio temporal se borra al salir; para conservarlo se copia fuera.
  const kept = fs.mkdtempSync(path.join(path.dirname(workspace), 'keel-go-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ngo-check: ${results.length}/${results.length} en verde.` : `\ngo-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
