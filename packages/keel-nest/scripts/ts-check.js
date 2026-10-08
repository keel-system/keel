#!/usr/bin/env node
// Compila, prueba y ARRANCA de verdad el proyecto que genera keel-nest.
//
// Por qué no está en `npm test`: necesita red (npm instala NestJS la primera vez) y tarda
// minutos. La suite de este paquete compara el texto emitido; esto es lo único que dice que ese
// texto es un proyecto TypeScript que compila con `strict`, que sus pruebas pasan bajo Vitest y
// que el servidor arranca y responde a sus sondas con el contrato de keel-spring. Es el
// equivalente de `compile-check` de keel-spring, y como él se lanza antes de dar por buena
// cualquier cambio en lo que se emite.
//
//   node packages/keel-nest/scripts/ts-check.js [--keep]
//   npm run ts-check --workspace packages/keel-nest
//
// --keep deja el proyecto generado (y dice dónde) para inspeccionarlo.
//
// Además del diseño de referencia, compila con `strict` y ejecuta las pruebas emitidas del árbol que
// emite build para TODAS las fixtures (planService, sin la frontera de build: el dominio y la aplicación de cualquier diseño
// tienen que compilar aunque su API o su persistencia aún no se generen), reutilizando el
// node_modules ya instalado. Es lo que dice que las trece siluetas compilan, no solo una.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, NEST_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { loadService } from 'keel-core';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';
import { resolveRuntime, startDatabase, stopDatabase } from './lib/database-container.js';
import { JOSE_VERSION, AMQPLIB_VERSION, KAFKA_JAVASCRIPT_VERSION, AWS_SDK_VERSION, MONGODB_VERSION, NODEMAILER_VERSION, HANDLEBARS_VERSION } from '../src/lib/assets.js';

const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const results = [];

function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function npm(projectDir, args) {
  // En Windows npm es un .cmd: sin shell, spawnSync no lo encuentra.
  const result = spawnSync('npm', args, { cwd: projectDir, encoding: 'utf8', shell: isWindows });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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

const workspace = makeWorkspace('keel-nest-ts-check-');
mountDesign(workspace, NEST_READY_DESIGN.name, NEST_READY_DESIGN);
const generated = await runCommand(workspace, build, `specs/${NEST_READY_DESIGN.name}`, { defaults: true, acceptUnready: true });
const projectDir = path.join(workspace, 'services', `${NEST_READY_DESIGN.name}-nest`);
if (!step('build genera el proyecto', generated.exitCode === undefined && fs.existsSync(projectDir), generated.exitCode ? generated.output : '')) {
  process.exit(1);
}

const install = npm(projectDir, ['install', '--no-audit', '--no-fund']);
if (!step('npm install', install.ok)) {
  console.error(install.output);
  process.exit(1);
}

for (const [name, args] of [
  ['tipos con strict (npm run typecheck)', ['run', 'typecheck']],
  ['frontera hexagonal (npm run check:architecture)', ['run', 'check:architecture']],
  ['pruebas bajo el perfil test (npm test)', ['test']],
  ['build de producción (npm run build)', ['run', 'build']]
]) {
  const run = npm(projectDir, args);
  if (!step(name, run.ok)) console.error(run.output);
}

// Las dependencias que el diseño de referencia no pide y alguna silueta sí (la seguridad: jose), sin
// tocar su package.json: el node_modules se comparte con todas.
const extra = npm(projectDir, [
  'install',
  '--no-save',
  '--no-audit',
  '--no-fund',
  `jose@${JOSE_VERSION}`,
  `amqplib@${AMQPLIB_VERSION}`,
  `@confluentinc/kafka-javascript@${KAFKA_JAVASCRIPT_VERSION}`,
  `@aws-sdk/client-sns@${AWS_SDK_VERSION}`,
  `@aws-sdk/client-sqs@${AWS_SDK_VERSION}`,
  // La persistencia documental (incremento 12): el driver de MongoDB.
  `mongodb@${MONGODB_VERSION}`,
  // El correo (incremento 12e): el transporte SMTP y el motor de plantillas.
  `nodemailer@${NODEMAILER_VERSION}`,
  `handlebars@${HANDLEBARS_VERSION}`
]);
if (!step('dependencias de las demás siluetas (jose, amqplib, kafka, aws, mongodb, nodemailer, handlebars)', extra.ok)) console.error(extra.output);

// Las trece siluetas: cada fixture entera, renderizada al lado y compilada con el mismo node_modules.
const tsc = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');
const vitest = path.join(projectDir, 'node_modules', 'vitest', 'vitest.mjs');
const failedFixtures = [];
const failedTests = [];
const silhouettes = fs.readdirSync(FIXTURES_DIR).flatMap((name) => {
  const { layers } = loadService(path.join(FIXTURES_DIR, name));
  // Con mensajería, sobre cada broker que keel-nest genera; con pagos, además, con la otra pasarela del catálogo
  // (sobre un solo broker: lo que cambia entre pasarelas es su adaptador y su verificador).
  const brokers = layers.messaging ? ['rabbitmq', 'kafka', 'snssqs'] : [null];
  const silhouettesOf = brokers.map((broker) => ({ name, broker, paymentGateway: null }));
  if (layers.payments) silhouettesOf.push({ name, broker: brokers[0], paymentGateway: 'mercadopago' });
  return silhouettesOf;
});
for (const { name: fixture, broker, paymentGateway } of silhouettes) {
  const name = [fixture, broker, paymentGateway].filter(Boolean).join('-');
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const stack = broker || paymentGateway ? { ...(broker ? { broker } : {}), ...(paymentGateway ? { paymentGateway } : {}) } : null;
  const { files } = planService({ manifest, layers, workspace: workspace, stack });
  const dir = path.join(workspace, 'fixtures-tsc', name);
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) {
    failedFixtures.push(name);
    console.error(`--- ${name}\n${run.stdout}${run.stderr}`);
    continue;
  }
  // Y sus pruebas emitidas: el servidor de esa silueta arranca y su API cumple el contrato.
  const tests = spawnSync(process.execPath, [vitest, 'run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PROFILE: 'test' } });
  if (tests.status !== 0) {
    failedTests.push(name);
    console.error(`--- ${name} (pruebas)\n${tests.stdout}${tests.stderr}`);
  }
}
step(
  'dominio, aplicación y API de TODAS las fixtures compilan con strict',
  failedFixtures.length === 0,
  failedFixtures.length > 0 ? `en rojo: ${failedFixtures.join(', ')}` : `${silhouettes.length} siluetas (fixture × broker)`
);
step(
  'las pruebas emitidas de TODAS las fixtures pasan (arranque, casos de uso y API)',
  failedTests.length === 0 && failedFixtures.length === 0,
  failedTests.length > 0 ? `en rojo: ${failedTests.join(', ')}` : ''
);

// El diseño de referencia persiste: el servidor no arranca sin su base (el DataSource se inicializa al
// arrancar). Se levanta un PostgreSQL en contenedor y el servidor arranca con el perfil `develop`, que
// lee DB_URL, DB_USERNAME y DB_PASSWORD del entorno: así se mide también el gradiente de configuración.
let database = null;
const runtime = results.every((result) => result.ok) ? resolveRuntime() : null;
if (results.every((result) => result.ok)) {
  if (!runtime) {
    step('una base de datos para arrancar (podman o docker en marcha)', false, 'sin podman ni docker: el servidor no puede arrancar sin su base');
  } else {
    try {
      database = await startDatabase(runtime, 'postgresql');
    } catch (error) {
      step('PostgreSQL en contenedor para arrancar', false, error.message);
    }
  }
}

if (results.every((result) => result.ok) && database) {
  const port = await freePort();
  const app = spawn(process.execPath, ['dist/main.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      PROFILE: 'develop',
      SERVER_PORT: String(port),
      DB_URL: database.url,
      DB_USERNAME: database.user,
      DB_PASSWORD: database.password
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appOutput = '';
  app.stdout.on('data', (chunk) => (appOutput += chunk));
  app.stderr.on('data', (chunk) => (appOutput += chunk));
  const exited = new Promise((resolve) => app.on('exit', (code, signal) => resolve({ code, signal })));

  const livez = await waitFor(port, '/livez', 30_000);
  step('arranca y GET /livez → 200 {"status":"UP"}', livez?.status === 200 && livez.body === '{"status":"UP"}', livez ? `${livez.status} ${livez.body}` : 'no respondió en 30 s');
  const readyz = await get(port, '/readyz');
  step('GET /readyz → 200 {"status":"UP"}', readyz?.status === 200 && readyz.body === '{"status":"UP"}', readyz ? `${readyz.status} ${readyz.body}` : 'sin respuesta');
  // La API del servidor arrancado: una ruta que no existe responde con el ErrorResponse del contrato.
  const missing = await get(port, '/api/v1/keel-ruta-que-no-existe');
  let missingBody = null;
  try {
    missingBody = JSON.parse(missing?.body ?? 'null');
  } catch {
    missingBody = null;
  }
  step(
    'GET de una ruta de la API que no existe → 404 con ErrorResponse',
    missing?.status === 404 && missingBody?.status === 404 && missingBody?.error === 'Not Found' && typeof missingBody?.correlationId === 'string',
    missing ? `${missing.status} ${missing.body}` : 'sin respuesta'
  );

  app.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  if (isWindows) {
    // En Windows SIGTERM termina el proceso sin dejarle ejecutar nada: el apagado ordenado no se
    // puede observar aquí. Se dice en voz alta en vez de darlo por bueno.
    console.log(`(no medido) apagado ordenado tras SIGTERM — en Windows la señal mata el proceso sin ejecutar sus hooks`);
  } else {
    step('SIGTERM → apagado ordenado con salida 0', end?.code === 0, end ? `code=${end.code} signal=${end.signal}` : 'no terminó en 15 s');
  }
  if (!end) app.kill('SIGKILL');
  if (results.some((result) => !result.ok)) console.error(appOutput);
}
if (database) stopDatabase(runtime, database);

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // La raíz temporal de los tests se borra al salir del proceso: para conservarlo se copia FUERA de ella.
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nts-check: ${results.length}/${results.length} en verde.` : `\nts-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
