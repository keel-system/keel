#!/usr/bin/env node
// La telemetría de keel-nest con la APLICACIÓN ARRANCADA (incremento 14f de PLAN-KEEL-NEST.md): el gemelo del
// `telemetry-check` de keel-spring. `npm test` ya EJECUTA la telemetría emitida pieza a pieza
// (test/telemetry.test.js, test/observability-assets.test.js); lo que solo dice el servidor en marcha contra un motor
// real es si lo que el scrape publica es lo que de verdad pasó:
//
//   · el caso de uso atravesado por HTTP deja su serie con su desenlace y un exemplar con la traza de QUIEN LLAMÓ;
//   · la entrada HTTP con la plantilla de la ruta; el runtime de Node; el pool del driver REAL (pg y mysql2: el de
//     mysql2 se lee de campos internos de su pool, y esto es lo único que dice que siguen ahí) con el tamaño
//     configurado;
//   · la traza que llega al colector (un receptor OTLP de node:http) y los logs de consola con su trace.id;
//   · en production, el scrape en el puerto de gestión y no en el principal;
//   · con seguridad, el scrape entra sin token mientras la API exige credencial.
//
//   node packages/keel-nest/scripts/telemetry-check.js [--keep]
//   npm run telemetry-check --workspace packages/keel-nest
//
// Códigos de salida: 0 todo OK · 1 hay casos rojos · 2 el arnés no pudo correr. Necesita red (npm) y podman o docker.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { loadService } from 'keel-core';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, promMetric, promTag } from 'keel-core/gen/telemetry-vocabulary';
import { trafficPath } from 'keel-core/gen/deploy-probes';
import { planService } from '../src/scaffold/index.js';
import { NODE_RUNTIME } from '../src/scaffold/telemetry.js';
import { JOSE_VERSION, MYSQL2_VERSION } from '../src/lib/assets.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { freePort, resolveRuntime, startDatabase, stopDatabase } from './lib/database-container.js';

const keep = process.argv.includes('--keep');
const isWindows = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CASES = {
  'TEL-1': 'el scrape responde y publica la serie del caso de uso atravesado por HTTP',
  'TEL-2': 'la serie del caso de uso lleva el desenlace que filtra la alerta de errores',
  'TEL-3': 'el exemplar del histograma apunta a la traza de QUIEN LLAMÓ',
  'TEL-4': 'el correlationId no es etiqueta de métrica',
  'TEL-5': 'http_server_requests lleva la plantilla de la ruta, no la URL con sus valores',
  'TEL-6': 'el runtime de Node: heap usado, su límite y el tiempo en GC',
  'TEL-7': 'el pool del driver real, con el tamaño configurado',
  'TEL-8': 'la traza llega al colector y continúa la de quien llamó',
  'TEL-9': 'los logs de consola (ECS) llevan el trace.id y el correlationId de la petición',
  'TEL-10': 'production: el scrape vive en el puerto de gestión y no en el principal; las sondas, en el principal',
  'TEL-11': 'con seguridad, el scrape entra sin token mientras la API exige credencial'
};

const results = [];
function record(variant, id, ok, detail = '') {
  results.push({ variant, id, ok, detail });
  console.log(`${ok ? 'OK   ' : 'FALLA'} [${variant}] ${id} ${CASES[id]}${ok ? '' : ` — ${detail}`}`);
}

function npm(dir, args) {
  const result = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', shell: isWindows });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: 0, text: String(error) };
  }
}

/** Escribe el proyecto de una fixture (planService, como ts-check) y lo compila con el node_modules compartido. */
function materialize(root, name, stack, nodeModules) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const { files, model } = planService({ manifest, layers, workspace: root, stack });
  const dir = path.join(root, `${name}-${stack.database ?? 'nodb'}`);
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  if (nodeModules) fs.symlinkSync(nodeModules, path.join(dir, 'node_modules'), 'junction');
  return { dir, model, manifest };
}

function compile(dir) {
  const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: dir, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${dir} no compila:\n${run.stdout}${run.stderr}`);
}

/** El colector: un receptor OTLP/HTTP que guarda lo que le llega. */
async function startReceiver() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      try {
        received.push({ path: request.url, body: JSON.parse(body.toString('utf8')) });
      } catch {
        received.push({ path: request.url, body: null });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, received, close: () => server.close() };
}

async function startApp(dir, env) {
  const port = await freePort();
  const managementPort = await freePort();
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: dir,
    env: { ...process.env, SERVER_PORT: String(port), MANAGEMENT_PORT: String(managementPort), SERVER_ADDRESS: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await get(`${base}/livez`)).status === 200) break;
    if (child.exitCode != null) break;
    await sleep(500);
  }
  if ((await get(`${base}/livez`)).status !== 200) {
    child.kill('SIGKILL');
    throw new Error(`la app no arrancó:\n${output.split('\n').slice(-30).join('\n')}`);
  }
  return {
    base,
    management: `http://127.0.0.1:${managementPort}`,
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      await sleep(1000);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  };
}

const caller = () => {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
};

/** Los casos de un servidor en develop, con tráfico ya enviado por `traffic` con la traza `trace`. */
async function developCases(variant, app, model, receiver, trace, correlationId, poolMax) {
  const scrape = await get(`${app.base}${METRICS_TRANSPORT.scrapePath}`);
  const lines = scrape.text.split('\n');
  const useCase = promMetric(OBSERVATIONS.useCase);
  const counts = lines.filter((line) => line.startsWith(useCase.count));
  record(variant, 'TEL-1', scrape.status === 200 && counts.length > 0, `scrape ${scrape.status}, ${counts.length} serie(s) de ${useCase.count}`);
  record(variant, 'TEL-2', counts.some((line) => line.includes(`${promTag(ATTRIBUTES.outcome)}="`)), counts.join(' | ').slice(0, 200));
  const exemplar = lines.some((line) => line.startsWith(useCase.bucket) && line.includes(`trace_id="${trace.traceId}"`));
  record(variant, 'TEL-3', exemplar, `ningún cubo de ${useCase.bucket} con el exemplar de ${trace.traceId}`);
  record(variant, 'TEL-4', !scrape.text.includes(promTag(ATTRIBUTES.correlationId)) && !scrape.text.includes(correlationId), 'el correlationId sale en el scrape');
  const route = trafficPath(model).replace(model.api.routeBase, '');
  const template = `${model.api.routeBase}${model.services.flatMap((s) => s.operations).find((o) => o.route?.method === 'GET').route.path}`;
  const http = lines.filter((line) => line.startsWith(promMetric('http.server.requests').count));
  record(
    variant,
    'TEL-5',
    http.some((line) => line.includes(`uri="${template}"`)) && !http.some((line) => line.includes('11111111-1111')),
    `${route}: ${http.join(' | ').slice(0, 300)}`
  );
  const has = (series) => lines.some((line) => line.startsWith(series));
  const limit = Number(lines.find((line) => line.startsWith(`${NODE_RUNTIME.heapLimit} `))?.split(' ')[1]);
  record(variant, 'TEL-6', has(NODE_RUNTIME.heapUsed) && limit > 0 && has(NODE_RUNTIME.gcSeconds), `heap usado ${has(NODE_RUNTIME.heapUsed)}, límite ${limit}, gc ${has(NODE_RUNTIME.gcSeconds)}`);
  const value = (series) => Number(lines.find((line) => line.startsWith(`${series} `))?.split(' ')[1]);
  const { active, idle, max, saturation } = NODE_RUNTIME.pool;
  const pool = { active: value(active), idle: value(idle), max: value(max), pending: value(saturation) };
  // Terminado el tráfico, las conexiones VUELVEN al pool: «libres ≥ 1» es lo que distingue una lectura correcta de un
  // campo interno que ya no existe (con él, libres sale 0 y todas parecen en uso).
  record(variant, 'TEL-7', pool.max === poolMax && pool.idle >= 1 && pool.active >= 0 && pool.pending === 0, JSON.stringify(pool));
  await sleep(6500);
  const spans = receiver.received
    .filter((entry) => entry.path === '/v1/traces' && entry.body)
    .flatMap((entry) => entry.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
  const server = spans.find((span) => span.traceId === trace.traceId && span.kind === 2);
  record(variant, 'TEL-8', Boolean(server && server.parentSpanId === trace.spanId), `${spans.length} span(s) recibidos; ninguno SERVER en ${trace.traceId} hijo de ${trace.spanId}`);
  const logLine = app
    .output()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((line) => line?.correlationId === correlationId && line?.trace?.id === trace.traceId);
  record(variant, 'TEL-9', Boolean(logLine), 'ninguna línea ECS con el correlationId y el trace.id de la petición');
}

const runtime = resolveRuntime();
if (!runtime) {
  console.error('telemetry-check necesita podman o docker en marcha.');
  process.exit(2);
}

const root = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nest-telemetry-keep-')) : tmpDir('keel-nest-telemetry-check-');
const databases = [];
let fatal = null;
const receiver = await startReceiver();
try {
  // El proyecto base: job-dispatch sobre PostgreSQL, con su npm install. Los demás comparten su node_modules.
  const base = materialize(root, 'job-dispatch', { database: 'postgresql', telemetry: 'otel' });
  process.stdout.write('npm install del proyecto base… ');
  const install = npm(base.dir, ['install', '--no-audit', '--no-fund']);
  if (!install.ok) throw new Error(install.output.slice(-2000));
  const extra = npm(base.dir, ['install', '--no-save', '--no-audit', '--no-fund', `mysql2@${MYSQL2_VERSION}`, `jose@${JOSE_VERSION}`]);
  if (!extra.ok) throw new Error(extra.output.slice(-2000));
  console.log('OK');
  compile(base.dir);
  const nodeModules = path.join(base.dir, 'node_modules');
  const onMysql = materialize(root, 'job-dispatch', { database: 'mysql', telemetry: 'otel' }, nodeModules);
  compile(onMysql.dir);
  const secured = materialize(root, 'profile-directory', { database: 'postgresql', telemetry: 'otel', auth: 'keycloak' }, nodeModules);
  compile(secured.dir);

  const postgres = await startDatabase(runtime, 'postgresql');
  databases.push(postgres);
  const mysql = await startDatabase(runtime, 'mysql');
  databases.push(mysql);
  const dbEnv = (database) => ({ DB_URL: database.url, DB_USERNAME: database.user, DB_PASSWORD: database.password });

  for (const [variant, project, database, poolMax] of [
    ['job-dispatch@postgresql', base, postgres, 7],
    ['job-dispatch@mysql', onMysql, mysql, 5]
  ]) {
    const app = await startApp(project.dir, {
      PROFILE: 'develop',
      ...dbEnv(database),
      DB_POOL_MAX_SIZE: String(poolMax),
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      TELEMETRY_EXPORT_ENABLED: 'true'
    });
    try {
      const trace = caller();
      const correlationId = `tel-check-${randomBytes(4).toString('hex')}`;
      for (let i = 0; i < 3; i++) {
        await get(`${app.base}${trafficPath(project.model)}`, { traceparent: trace.traceparent, 'x-correlation-id': correlationId });
      }
      await developCases(variant, app, project.model, receiver, trace, correlationId, poolMax);
    } finally {
      await app.stop();
    }
  }

  // production: el scrape solo en el puerto de gestión.
  const production = await startApp(base.dir, { PROFILE: 'production', ...dbEnv(postgres), OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint });
  try {
    for (let attempt = 0; attempt < 20 && (await get(`${production.management}${METRICS_TRANSPORT.scrapePath}`)).status !== 200; attempt++) await sleep(250);
    const onManagement = await get(`${production.management}${METRICS_TRANSPORT.scrapePath}`);
    const onMain = await get(`${production.base}${METRICS_TRANSPORT.scrapePath}`);
    const ready = await get(`${production.base}/readyz`);
    record(
      'job-dispatch@production',
      'TEL-10',
      onManagement.status === 200 && onManagement.text.includes(NODE_RUNTIME.heapUsed) && onMain.status === 404 && ready.status === 200,
      `gestión ${onManagement.status}, principal ${onMain.status}, /readyz ${ready.status}`
    );
  } finally {
    await production.stop();
  }

  // Con seguridad: el colector no tiene token; la API sí lo exige. Sin proveedor de identidad (el JWKS se resuelve
  // perezoso), basta con que el rechazo sea el 401 del plan de acceso.
  const securedApp = await startApp(secured.dir, { PROFILE: 'develop', ...dbEnv(postgres), OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint });
  try {
    const scrape = await get(`${securedApp.base}${METRICS_TRANSPORT.scrapePath}`);
    const api = await get(`${securedApp.base}${trafficPath(secured.model)}`);
    record('profile-directory@postgresql', 'TEL-11', scrape.status === 200 && api.status === 401, `scrape ${scrape.status}, API sin token ${api.status}`);
  } finally {
    await securedApp.stop();
  }
} catch (error) {
  fatal = String(error?.message ?? error);
} finally {
  receiver.close();
  for (const database of databases) stopDatabase(runtime, database);
  if (keep) console.log(`  (--keep) proyectos en ${root}`);
}

const expected = ['TEL-1', 'TEL-2', 'TEL-3', 'TEL-4', 'TEL-5', 'TEL-6', 'TEL-7', 'TEL-8', 'TEL-9'].length * 2 + 2;
const failed = results.filter((result) => !result.ok).length;
if (fatal) {
  console.error(`\nsin veredicto: ${fatal}`);
  process.exit(2);
}
console.log(failed === 0 && results.length === expected ? `\ntelemetry-check: ${results.length}/${expected} en verde.` : `\ntelemetry-check: ${failed} caso(s) en rojo de ${results.length} (esperados ${expected}).`);
process.exit(failed === 0 && results.length === expected ? 0 : 1);
