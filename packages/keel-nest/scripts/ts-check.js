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

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeWorkspace, mountDesign, runCommand, NEST_READY_DESIGN } from '../test/helpers/workspace.js';
import { build } from '../src/commands/build.js';

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
  ['pruebas bajo el perfil test (npm test)', ['test']],
  ['build de producción (npm run build)', ['run', 'build']]
]) {
  const run = npm(projectDir, args);
  if (!step(name, run.ok)) console.error(run.output);
}

if (results.every((result) => result.ok)) {
  const port = await freePort();
  const app = spawn(process.execPath, ['dist/main.js'], {
    cwd: projectDir,
    env: { ...process.env, PROFILE: 'local', SERVER_PORT: String(port) },
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

const failed = results.filter((result) => !result.ok).length;
if (keep) {
  // El directorio temporal se borra al salir; para conservarlo se copia fuera.
  const kept = fs.mkdtempSync(path.join(path.dirname(workspace), 'keel-nest-kept-'));
  fs.cpSync(projectDir, kept, { recursive: true });
  console.log(`Proyecto conservado en ${kept}`);
}
console.log(failed === 0 ? `\nts-check: ${results.length}/${results.length} en verde.` : `\nts-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
