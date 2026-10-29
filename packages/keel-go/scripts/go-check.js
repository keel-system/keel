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
//   node packages/keel-go/scripts/go-check.js [--keep] [--no-race] [--fixtures]
//   npm run go-check --workspace packages/keel-go
//
// --keep deja el proyecto generado (y dice dónde) para inspeccionarlo; --no-race se salta el paso del
// contenedor (sin podman ni docker); --fixtures solo compila y prueba el Go de todas las fixtures.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, GO_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { ALLOWED_LICENSES, MODULES, TOOLS } from '../src/lib/go-stack.js';
import { GO_TOOLCHAIN } from '../src/lib/assets.js';
import { WIRE_SABOTAGES, applySabotage } from '../test/helpers/wire-sabotages.js';
import { DOMAIN_SABOTAGES, applySabotage as applyDomainSabotage } from '../test/helpers/domain-sabotages.js';
import { APPLICATION_SABOTAGES, applySabotage as applyApplicationSabotage } from '../test/helpers/application-sabotages.js';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const keep = process.argv.includes('--keep');
// --fixtures: solo el paso que compila el Go de TODAS las fixtures (el más largo de iterar).
const onlyFixtures = process.argv.includes('--fixtures');
const race = !process.argv.includes('--no-race');
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
const fixturesRoot = makeWorkspace('keel-go-fixtures-');
for (const name of fs.readdirSync(FIXTURES_DIR).filter((entry) => fs.existsSync(path.join(FIXTURES_DIR, entry, 'service.keel.yaml')))) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const dir = path.join(fixturesRoot, name);
  for (const file of planService({ manifest, layers, workspace: fixturesRoot }).files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  const problems = [];
  const tidied = go(dir, ['mod', 'tidy']);
  if (!tidied.ok) problems.push(`tidy: ${tidied.output}`);
  const unformatted = run('gofmt', ['-l', '.'], dir);
  if (unformatted.stdout.trim()) problems.push(`gofmt: ${unformatted.stdout.trim()}`);
  for (const args of [['vet', './...'], ['tool', 'staticcheck', './...'], ['test', '-count=1', './...']]) {
    const result = go(dir, args);
    if (!result.ok || (args[1] === 'staticcheck' && result.output.trim())) problems.push(`${args.join(' ')}: ${result.output.trim()}`);
  }
  if (!step(`${name}: el Go emitido pasa tidy, gofmt, vet, staticcheck y sus pruebas`, problems.length === 0)) console.error(problems.join('\n').slice(0, 4000));
}
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
const vet = go(projectDir, ['vet', './...']);
if (!step('go vet ./... limpio', vet.ok)) console.error(vet.output);
const staticcheck = go(projectDir, ['tool', 'staticcheck', './...']);
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

// La APLICACIÓN se mide con su propia prueba emitida (use_cases_test.go: cada operación cableada, el decorador del
// log de frontera deja pasar resultado y error, y un rechazo del dominio va a Info con su code). Cada sabotaje tiene
// que tumbar exactamente las pruebas que nombra.
const appTests = ['test', '-count=1', '-run', 'TestNewUseCases|TestObserve', './internal/application/'];
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

// La frontera hexagonal se falsa: un import plantado del dominio a la entrada HTTP tiene que ponerla en rojo.
const planted = path.join(projectDir, 'internal', 'domain', 'planted.go');
fs.writeFileSync(planted, `package domain\n\nimport "${GO_READY_DESIGN.name}/internal/httpapi"\n\nvar _ = httpapi.ReadTimeout\n`);
const boundary = go(projectDir, ['test', '-count=1', './internal/architecture/']);
fs.rmSync(planted);
step('la frontera sale en rojo con un import plantado (dominio → httpapi)', !boundary.ok && /internal\/domain \(domain\) importa internal\/httpapi/.test(boundary.output));

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

if (race) {
  const runtime = containerRuntime();
  if (!runtime) step('go test -race en contenedor', false, 'sin podman ni docker (o --no-race)');
  else {
    // -race exige cgo, y en Windows no hay gcc: se ejecuta en la imagen oficial, con el mismo toolchain.
    const image = `docker.io/library/golang:${GO_TOOLCHAIN.replace(/^go/, '')}`;
    const raced = run(runtime, ['run', '--rm', '-v', `${projectDir}:/src`, '-w', '/src', '-e', 'GOFLAGS=-mod=mod', image, 'go', 'test', '-race', '-count=1', './...'], projectDir);
    if (!step(`go test -race ./... en ${image}`, raced.ok)) console.error(raced.output.slice(-4000));
  }
}

if (fs.existsSync(binary)) {
  const port = await freePort();
  const app = spawn(binary, [], { cwd: workspace, env: { ...process.env, PROFILE: 'local', SERVER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let appOutput = '';
  app.stdout.on('data', (chunk) => (appOutput += chunk));
  app.stderr.on('data', (chunk) => (appOutput += chunk));
  const exited = new Promise((resolve) => app.on('exit', (code, signal) => resolve({ code, signal })));

  // El binario se lanza desde OTRO directorio: la configuración va embebida, no se lee del de trabajo.
  const livez = await waitFor(port, '/livez', 30_000);
  step('el binario arranca fuera del proyecto y GET /livez → 200 {"status":"UP"}', livez?.status === 200 && livez.body === '{"status":"UP"}', livez ? `${livez.status} ${livez.body}` : 'no respondió en 30 s');
  const readyz = await get(port, '/readyz');
  step('GET /readyz → 200 {"status":"UP"}', readyz?.status === 200 && readyz.body === '{"status":"UP"}', readyz ? `${readyz.status} ${readyz.body}` : 'sin respuesta');
  const missing = await get(port, '/no-existe');
  step('una ruta que no existe → 404', missing?.status === 404, missing ? String(missing.status) : 'sin respuesta');

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

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // El directorio temporal se borra al salir; para conservarlo se copia fuera.
  const kept = fs.mkdtempSync(path.join(path.dirname(workspace), 'keel-go-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\ngo-check: ${results.length}/${results.length} en verde.` : `\ngo-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
