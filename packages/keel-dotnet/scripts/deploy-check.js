#!/usr/bin/env node
// La RUTA DE PRODUCCIÓN de la telemetría de keel-dotnet (incremento 14f de PLAN-KEEL-DOTNET.md): levanta `deploy/`
// ENTERO —la app en contenedor, el colector y el backend de prueba— con su propio `up.sh` y le pregunta AL BACKEND.
//
// Las preguntas (DEP-2 a DEP-8) son las de keel-spring y keel-nest, en `keel-core/gen/deploy-probes.js`: el backend, el
// panel, las alertas y el contacto son los mismos. Lo de esta plataforma es cómo se prepara la app (antes de construir
// la imagen se crea el baseline del esquema con `dotnet ef`, como lo hace el pase de calidad: sin él, EF se niega a
// migrar y la app no arranca en develop) y la serie de runtime que su scrape tiene que traer (DEP-1).
//
// El sujeto por defecto es el de los otros dos, `job-dispatch`: sin storage, correo, mensajería ni seguridad, arranca sin
// una línea del agente. El tráfico va a un GET del diseño: el handler recién generado lanza su TODO (500), y da igual,
// la observación se cierra con desenlace `error`, que es lo que se mide.
//
//   node packages/keel-dotnet/scripts/deploy-check.js [fixture] [--keep] [--database=mysql]
//   npm run deploy-check --workspace packages/keel-dotnet
//
// Códigos de salida: 0 todo OK · 1 hay casos rojos · 2 el arnés no pudo correr (sin veredicto). Necesita el SDK de .NET
// 10, red (NuGet y las imágenes) y podman o docker; tarda minutos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { ALERTING, TELEMETRY_INFRA } from 'keel-core/gen/infra-catalog';
import { METRICS_TRANSPORT } from 'keel-core/gen/telemetry-vocabulary';
import { DEPLOY_CASES, httpRead, probeDeployBackend, trafficPath } from 'keel-core/gen/deploy-probes';
import { build } from '../src/commands/build.js';
import { planService } from '../src/scaffold/index.js';
import { solution } from '../src/scaffold/render.js';
import { DOTNET_RUNTIME } from '../src/scaffold/telemetry.js';
import { FIXTURES_DIR, makeWorkspace, mountDesign, runCommand } from '../test/helpers/workspace.js';

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'job-dispatch';
const keep = args.includes('--keep');
// El motor relacional del sujeto (sin él, el del modelo de persistencia: PostgreSQL).
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? null;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  const failure = result.error ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : '';
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + failure };
}

const results = [];
const record = (id, ok, detail = '') => {
  const found = DEPLOY_CASES.find((item) => item.id === id);
  results.push({ id, title: found.title, ok, detail });
};

function readEnv(projectDir) {
  const values = {};
  for (const line of fs.readFileSync(path.join(projectDir, 'deploy', '.env'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** Los últimos logs de la app: la causa de un rojo tiene que llegar por stdout, el proyecto se borra al salir. */
function appLogs(projectDir) {
  for (const [command, prefix] of [['podman', ['compose']], ['docker', ['compose']], ['podman-compose', []]]) {
    const result = run(command, [...prefix, '-f', 'deploy/docker-compose.yaml', '--env-file', 'deploy/.env', 'logs', '--tail', '40', 'app'], { cwd: projectDir });
    if (result.status === 0) return (result.stdout + result.stderr).trim().split('\n').slice(-40).join('\n');
  }
  return '(no hay frontend de compose con el que leer los logs)';
}

if (!fs.existsSync(path.join(FIXTURES_DIR, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${FIXTURES_DIR}`);
  process.exit(2);
}
const runtime = ['podman', 'docker'].find((candidate) => run(candidate, ['--version']).status === 0);
if (!runtime || run(runtime, ['ps']).status !== 0) {
  console.error('deploy-check necesita podman o docker en marcha.');
  process.exit(2);
}

let fatal = null;
let projectDir = null;
try {
  const workspace = makeWorkspace('kd-deploy-');
  mountDesign(workspace, fixture);
  if (database) {
    // El motor, en el keel-stack.json del proyecto: build lo lee antes de preguntar.
    const target = path.join(workspace, 'services', `${fixture}-dotnet`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keel-stack.json'), JSON.stringify({ database }));
  }
  const generated = await runCommand(workspace, build, `specs/${fixture}`, { defaults: true, acceptUnready: true, telemetry: 'otel' });
  projectDir = path.join(workspace, 'services', `${fixture}-dotnet`);
  if (generated.exitCode !== undefined || !fs.existsSync(projectDir)) throw new Error(`build no generó el proyecto:\n${generated.output}`);
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-deploy-keep-'));
    fs.cpSync(projectDir, kept, { recursive: true });
    projectDir = kept;
  }
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const { model } = planService({ manifest, layers, workspace, stack: JSON.parse(fs.readFileSync(path.join(projectDir, 'keel-stack.json'), 'utf8')) });
  console.log(`sujeto: ${fixture} (${model.stack.database ?? 'sin persistencia'}) con telemetría`);

  if (['postgresql', 'mysql'].includes(model.stack.database)) {
    process.stdout.write('dotnet ef: el baseline del esquema (sin él, la app no arranca en develop)… ');
    const env = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
    for (const step of [['restore'], ['tool', 'restore'], ['ef', 'migrations', 'add', 'Baseline', '--project', solution(model).infrastructure.dir]]) {
      const done = run('dotnet', step, { cwd: projectDir, env });
      if (done.status !== 0) throw new Error(`dotnet ${step.join(' ')} falló:\n${(done.stdout + done.stderr).slice(-2000)}`);
    }
    console.log('OK');
  }

  const env = readEnv(projectDir);
  const appPort = env.APP_PORT ?? '8080';
  const grafanaPort = env.GRAFANA_PORT ?? String(TELEMETRY_INFRA.backend.grafanaPublishedPort);
  const sinkPort = env[ALERTING.sink.portVar] ?? String(ALERTING.sink.publishedPort);

  process.stdout.write('levantando deploy/ (construye la imagen: esto tarda)… ');
  const up = run('bash', ['deploy/up.sh'], { cwd: projectDir, timeout: 25 * 60 * 1000 });
  if (up.status !== 0) {
    console.log('KO');
    console.error((up.stderr || up.stdout).trim().split('\n').slice(-25).join('\n'));
    throw new Error('deploy/up.sh no levantó el stack');
  }
  console.log('OK');

  // DEP-1. El scrape en el perfil develop, con la serie de runtime de .NET: si no está, el backend se queda sin ninguna
  // métrica sin que nada falle.
  const scrape = await httpRead(`http://localhost:${appPort}${METRICS_TRANSPORT.scrapePath}`);
  record(
    'DEP-1',
    scrape.ok && scrape.text.includes(DOTNET_RUNTIME.heapUsed),
    scrape.ok ? (scrape.text.includes(DOTNET_RUNTIME.heapUsed) ? '' : `el scrape no trae ${DOTNET_RUNTIME.heapUsed}`) : `el scrape respondió ${scrape.status}`
  );

  const traffic = trafficPath(model);
  if (!traffic) throw new Error('el diseño no expone ningún GET: la sonda no puede atravesar un caso de uso por HTTP');
  for (let i = 0; i < 5; i++) await httpRead(`http://localhost:${appPort}${traffic}`);
  console.log(`tráfico enviado a ${traffic} (el handler recién generado responde 500: el desenlace es 'error', que es lo que se mide)`);

  process.stdout.write('preguntando al backend (espera al scrape del colector y a la entrega de una alerta)… ');
  const warnings = await probeDeployBackend({
    grafanaUrl: `http://localhost:${grafanaPort}`,
    sinkUrl: `http://localhost:${sinkPort}`,
    serviceName: manifest.service.name,
    record
  });
  console.log('hecho');
  for (const warning of warnings) console.log(`  aviso: ${warning}`);
  if (results.some((item) => !item.ok)) console.error(`\nlos últimos logs de la app:\n${appLogs(projectDir)}`);
} catch (error) {
  fatal = String(error?.message ?? error);
  if (projectDir) console.error(`\nlos últimos logs de la app:\n${appLogs(projectDir)}`);
} finally {
  if (projectDir && !keep) run('bash', ['deploy/down.sh', '-v'], { cwd: projectDir, timeout: 10 * 60 * 1000 });
  if (keep && projectDir) console.log(`  (--keep) proyecto en ${projectDir} (bájalo con bash deploy/down.sh -v)`);
}

console.log('\nMatriz de la ruta de producción (keel-dotnet)');
for (const item of results) console.log(`  ${item.id}  ${item.ok ? 'OK' : 'KO'}  ${item.title}${item.ok ? '' : ' — ' + item.detail}`);
for (const item of DEPLOY_CASES.filter((caso) => !results.some((hecho) => hecho.id === caso.id))) {
  console.log(`  ${item.id}  --  ${item.title} (no llegó a medirse)`);
}
if (fatal) {
  console.error(`\nsin veredicto: ${fatal}`);
  process.exit(2);
}
const failed = results.filter((item) => !item.ok).length;
console.log(failed === 0 && results.length === DEPLOY_CASES.length ? `\ndeploy-check: ${results.length}/${DEPLOY_CASES.length} en verde.` : `\ndeploy-check: ${failed} caso(s) en rojo.`);
process.exit(failed === 0 && results.length === DEPLOY_CASES.length ? 0 : 1);
