#!/usr/bin/env node
// La telemetría de keel-go con la APLICACIÓN ARRANCADA (incremento 14f): el gemelo del `telemetry-check` de los otros tres.
// `go-check` ya EJECUTA la telemetría emitida pieza a pieza; lo que solo dice el servidor en marcha contra una base real es si lo
// que el scrape publica es lo que de verdad pasó:
//
//   · el caso de uso atravesado por HTTP deja su serie con su desenlace y un exemplar con la traza de QUIEN LLAMÓ;
//   · la entrada HTTP con la plantilla de la ruta; el runtime de Go; el pool REAL de database/sql con el tamaño configurado;
//   · la traza que llega al colector (un receptor OTLP de node:http, que lee el protobuf del exportador) y los logs de consola con
//     su trace.id;
//   · en production, el scrape en el puerto de gestión y no en el principal;
//   · con seguridad, el scrape entra sin token mientras la API exige credencial.
//
//   node packages/keel-go/scripts/telemetry-check.js [--keep] [--sabotage=<id>]
//   npm run telemetry-check --workspace packages/keel-go
//
// --sabotage=<id> rompe lo emitido CONSERVANDO LA FORMA (sigue compilando), y el check tiene que salir rojo en su caso:
//   pool-name       el pool se lee de lo que no es (TEL-7)
//   management      en production el scrape también se sirve en el puerto principal (TEL-10)
//   server-parent   la entrada HTTP no continúa la traza de quien llama (TEL-3, TEL-8, y TEL-9: el log ya no lleva su traza)
//   timer-kind      el disparo del cronómetro se observa sin su kind (TEL-12)
//
// Códigos de salida: 0 todo OK · 1 hay casos rojos · 2 el arnés no pudo correr. Necesita Go, red y podman o docker.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { loadService } from '@keel-system/keel-core';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, TIMER_LAG, TIMER_PARKED, promGauge, promMetric, promTag } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { TIMER_PARAMETERS, TIMER_PURGE_KIND } from '@keel-system/keel-core/gen/timer-store';
import { trafficPath } from '@keel-system/keel-core/gen/deploy-probes';
import { planService } from '../src/scaffold/index.js';
import { GO_RUNTIME } from '../src/scaffold/telemetry.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { DB_NAME, freePort, resolveRuntime, run, startDatabase, stopDatabase } from '../../keel-nest/scripts/lib/database-container.js';
import { decodeTraces } from '../../keel-dotnet/scripts/lib/otlp-traces.js';

const keep = process.argv.includes('--keep');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isWindows = process.platform === 'win32';

// [archivo relativo al proyecto, texto que se sustituye, sustituto]. Si el texto ya no está, el check sale sin veredicto.
const SABOTAGES = {
  'pool-name': ['internal/platform/telemetry/runtime.go', 'return float64(stats().MaxOpenConnections)', 'return float64(stats().OpenConnections)'],
  management: ['internal/platform/telemetry/http.go', 'servesScrape := t.settings.PrometheusEnabled && t.settings.ManagementPort == 0', 'servesScrape := t.settings.PrometheusEnabled'],
  'server-parent': ['internal/platform/telemetry/http.go', 'ctx := t.extract(r.Context(), r.Header)', 'ctx := r.Context()'],
  // Solo donde hay cronómetro (profile-directory no tiene ningún reloj): ver OPTIONAL.
  'timer-kind': ['cmd/server/main.go', 'Labels: map[string]string{telemetry.AttrTimerKind: kind}, ', '']
};
// Los sabotajes que no aplican a todos los proyectos del check: donde su texto no está, no se aplican.
const OPTIONAL = new Set(['timer-kind']);
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const CASES = {
  'TEL-1': 'el scrape responde y publica la serie del caso de uso atravesado por HTTP',
  'TEL-2': 'la serie del caso de uso lleva el desenlace que filtra la alerta de errores',
  'TEL-3': 'el exemplar del histograma apunta a la traza de QUIEN LLAMÓ',
  'TEL-4': 'el correlationId no es etiqueta de métrica',
  'TEL-5': 'http_server_requests lleva la plantilla de la ruta, no la URL con sus valores',
  'TEL-6': 'el runtime de Go: heap usado, su límite, el tiempo en GC y las goroutines',
  'TEL-7': 'el pool de database/sql real, con el tamaño configurado',
  'TEL-8': 'la traza llega al colector y continúa la de quien llamó',
  'TEL-9': 'los logs de consola (ECS) llevan el trace.id y el correlationId de la petición',
  'TEL-10': 'production: el scrape vive en el puerto de gestión y no en el principal; las sondas, en el principal',
  'TEL-11': 'con seguridad, el scrape entra sin token mientras la API exige credencial',
  'TEL-12': 'el cronómetro publica su retraso (con el valor de lo vencido), sus aparcados y la duración de cada disparo por kind'
};

const results = [];
function record(variant, id, ok, detail = '') {
  results.push({ variant, id, ok, detail });
  console.log(`${ok ? 'OK   ' : 'FALLA'} [${variant}] ${id} ${CASES[id]}${ok ? '' : ` — ${detail}`}`);
}

function go(dir, args, env = {}) {
  const result = spawnSync('go', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, CGO_ENABLED: '0', ...env }, maxBuffer: 64 * 1024 * 1024 });
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

/** Escribe el proyecto de una fixture, aplica el sabotaje y lo compila. */
function materialize(root, name, stack, dirName = name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const { files, model } = planService({ manifest, layers, workspace: root, stack });
  const dir = path.join(root, dirName);
  for (const file of files) {
    const out = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
  }
  if (sabotage) {
    const [file, from, to] = SABOTAGES[sabotage];
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(from) && !OPTIONAL.has(sabotage)) throw new Error(`el sabotaje '${sabotage}' no se aplica a lo emitido hoy (${file})`);
    fs.writeFileSync(target, text.replace(from, to));
  }
  const binary = path.join(dir, 'bin', isWindows ? 'server.exe' : 'server');
  for (const args of [['mod', 'tidy'], ['build', '-o', binary, './cmd/server']]) {
    const step = go(dir, args);
    if (!step.ok) throw new Error(`${name}: go ${args.join(' ')}\n${step.output.split('\n').slice(-40).join('\n')}`);
  }
  return { dir, model, binary };
}

/** El colector: un receptor OTLP/HTTP que guarda los spans que le llegan (protobuf, el formato del exportador). */
async function startReceiver() {
  const spans = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      if (request.url === '/v1/traces') {
        try {
          spans.push(...decodeTraces(body));
        } catch {
          // Un cuerpo que no se lee no aporta spans: el caso que los espera lo dirá.
        }
      }
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, spans, close: () => server.close() };
}

async function startApp(project, env) {
  const port = await freePort();
  const managementPort = await freePort();
  const child = spawn(project.binary, [], {
    cwd: project.dir,
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

/** Los casos de un servidor en develop, con tráfico ya enviado con la traza `trace`. */
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
  const template = `${model.api.routeBase}${model.services.flatMap((s) => s.operations).find((o) => o.route?.method === 'GET').route.path}`;
  const httpCounts = lines.filter((line) => line.startsWith(promMetric('http.server.requests').count));
  record(
    variant,
    'TEL-5',
    httpCounts.some((line) => line.includes(`uri="${template}"`)) && !httpCounts.some((line) => line.includes('11111111-1111')),
    httpCounts.join(' | ').slice(0, 300)
  );
  const value = (series) => Number(lines.find((line) => line.startsWith(`${series} `))?.split(' ')[1]);
  const runtime = { used: value(GO_RUNTIME.heapUsed), limit: value(GO_RUNTIME.heapLimit), gc: value(GO_RUNTIME.gcSeconds), goroutines: value(GO_RUNTIME.goroutines) };
  record(variant, 'TEL-6', runtime.used > 0 && runtime.limit > runtime.used && runtime.gc >= 0 && runtime.goroutines >= 1, JSON.stringify(runtime));
  const { active, idle, max, saturation } = GO_RUNTIME.pool;
  const pool = { active: value(active), idle: value(idle), max: value(max), pending: value(saturation) };
  // Terminado el tráfico, las conexiones VUELVEN al pool: «libres ≥ 1» es lo que distingue una lectura correcta de una a cero.
  record(variant, 'TEL-7', pool.max === poolMax && pool.idle >= 1 && pool.active >= 0 && pool.pending === 0, JSON.stringify(pool));
  // El exportador agrupa (BatchSpanProcessor, cada 5 s por defecto): se espera a que llegue.
  let server = null;
  for (let attempt = 0; attempt < 30 && !server; attempt++) {
    server = receiver.spans.find((span) => span.traceId === trace.traceId && span.kind === 2);
    if (!server) await sleep(500);
  }
  record(variant, 'TEL-8', Boolean(server && server.parentSpanId === trace.spanId), `${receiver.spans.length} span(s) recibidos; ${server ? `el SERVER cuelga de ${server.parentSpanId}` : `ninguno SERVER en ${trace.traceId}`}`);
  const logLine = app
    .output()
    .split(/\r?\n/)
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
if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
  console.error('telemetry-check necesita Go.');
  process.exit(2);
}

/**
 * El cronómetro (DSL 2.26, inc. 11), como en keel-nest. La app corre con el sueño máximo del sondeador a 10 minutos: la purga
 * de keel_timer vencida A ESPALDAS del sondeador (por SQL, hace 120 s según la base) se queda sin reclamar, y el retraso se
 * lee con su VALOR. El disparo se mide al rearrancar: la primera pasada reclama la purga ya vencida y la observa.
 */
const LONG_SLEEP = { [TIMER_PARAMETERS.maxSleepMs.env]: '600000' };

function ageTimerPurge(engine, database) {
  const statement =
    engine === 'postgresql'
      ? `UPDATE keel_timer SET due_at = current_timestamp - interval '120 seconds' WHERE kind = '${TIMER_PURGE_KIND}'`
      : `UPDATE keel_timer SET due_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 120 SECOND) WHERE kind = '${TIMER_PURGE_KIND}'`;
  const args =
    engine === 'postgresql'
      ? ['exec', database.name, 'psql', '-U', DB_NAME, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-c', statement]
      : ['exec', database.name, 'mysql', '-h', '127.0.0.1', '-u', 'root', `-p${database.password}`, DB_NAME, '-e', statement];
  const result = run(runtime, args);
  if (result.status !== 0) throw new Error(`no se pudo vencer la purga de keel_timer: ${result.stderr}`);
}

const gaugeValue = (text, name) => {
  const line = text.split(String.fromCharCode(10)).find((candidate) => candidate.startsWith(`${name} `) || candidate.startsWith(`${name}{`));
  return line == null ? null : Number(line.slice(line.lastIndexOf(' ') + 1));
};

/** La primera mitad, con la app en marcha: el retraso con su valor y la serie de los aparcados. */
async function timerLag(app, engine, database) {
  let lag = null;
  let text = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    ageTimerPurge(engine, database);
    text = (await get(`${app.base}${METRICS_TRANSPORT.scrapePath}`)).text;
    lag = gaugeValue(text, promGauge(TIMER_LAG));
    if (lag != null && lag >= 100) break;
    await sleep(500);
  }
  return { lag, parked: gaugeValue(text, promGauge(TIMER_PARKED)) };
}

/** La segunda mitad, tras rearrancar: el histograma del disparo con su kind y su desenlace. */
async function timerTicked(app) {
  const tick = promMetric(OBSERVATIONS.timerTick);
  for (let attempt = 0; attempt < 60; attempt++) {
    const text = (await get(`${app.base}${METRICS_TRANSPORT.scrapePath}`)).text;
    const hit = text
      .split(String.fromCharCode(10))
      .some(
        (line) =>
          line.startsWith(tick.bucket) &&
          line.includes(`${promTag(ATTRIBUTES.timerKind)}="${TIMER_PURGE_KIND}"`) &&
          line.includes(`${promTag(ATTRIBUTES.outcome)}="ok"`)
      );
    if (hit) return true;
    await sleep(500);
  }
  return false;
}

/** TEL-12 de una variante: el retraso con la app que ya corrió los casos de develop, y el disparo al rearrancar. */
async function timerCase(variant, project, engine, database, env, timer) {
  const again = await startApp(project, { PROFILE: 'develop', ...env, ...LONG_SLEEP });
  try {
    const ticked = await timerTicked(again);
    record(
      variant,
      'TEL-12',
      timer.lag >= 100 && timer.lag < 600 && timer.parked === 0 && ticked,
      `retraso ${timer.lag} s (se esperaban unos 120), aparcados ${timer.parked}, disparo de ${TIMER_PURGE_KIND} observado: ${ticked}`
    );
  } finally {
    await again.stop();
  }
}

const root = tmpDir('kg-tel-');
const databases = [];
let fatal = null;
const receiver = await startReceiver();
try {
  if (sabotage) console.log(`(sabotaje: ${sabotage})`);
  process.stdout.write('compilando job-dispatch y profile-directory con telemetría… ');
  const project = materialize(root, 'job-dispatch', { database: 'postgresql', telemetry: 'otel' });
  const secured = materialize(root, 'profile-directory', { database: 'postgresql', telemetry: 'otel', auth: 'keycloak' });
  // El mismo servicio sobre MySQL: otro driver, el mismo pool de database/sql.
  const onMysql = materialize(root, 'job-dispatch', { database: 'mysql', telemetry: 'otel' }, 'job-dispatch-mysql');
  console.log('OK');

  const postgres = await startDatabase(runtime, 'postgresql');
  databases.push(postgres);
  const dbEnv = { DB_URL: postgres.url, DB_USERNAME: postgres.user, DB_PASSWORD: postgres.password };

  const poolMax = 7;
  const app = await startApp(project, {
    PROFILE: 'develop',
    ...dbEnv,
    DB_POOL_MAX_SIZE: String(poolMax),
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
    TELEMETRY_EXPORT_ENABLED: 'true',
    ...LONG_SLEEP
  });
  let timer;
  try {
    const trace = caller();
    const correlationId = `tel-check-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 3; i++) {
      await get(`${app.base}${trafficPath(project.model)}`, { traceparent: trace.traceparent, 'x-correlation-id': correlationId });
    }
    await developCases('job-dispatch@postgresql', app, project.model, receiver, trace, correlationId, poolMax);
    timer = await timerLag(app, 'postgresql', postgres);
  } finally {
    await app.stop();
  }
  await timerCase('job-dispatch@postgresql', project, 'postgresql', postgres, dbEnv, timer);

  const mysql = await startDatabase(runtime, 'mysql');
  databases.push(mysql);
  const mysqlApp = await startApp(onMysql, {
    PROFILE: 'develop',
    DB_URL: mysql.url,
    DB_USERNAME: mysql.user,
    DB_PASSWORD: mysql.password,
    DB_POOL_MAX_SIZE: String(poolMax),
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
    TELEMETRY_EXPORT_ENABLED: 'true',
    ...LONG_SLEEP
  });
  let mysqlTimer;
  try {
    const trace = caller();
    const correlationId = `tel-check-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 3; i++) {
      await get(`${mysqlApp.base}${trafficPath(onMysql.model)}`, { traceparent: trace.traceparent, 'x-correlation-id': correlationId });
    }
    await developCases('job-dispatch@mysql', mysqlApp, onMysql.model, receiver, trace, correlationId, poolMax);
    mysqlTimer = await timerLag(mysqlApp, 'mysql', mysql);
  } finally {
    await mysqlApp.stop();
  }
  await timerCase('job-dispatch@mysql', onMysql, 'mysql', mysql, { DB_URL: mysql.url, DB_USERNAME: mysql.user, DB_PASSWORD: mysql.password }, mysqlTimer);

  // production: el scrape solo en el puerto de gestión.
  const production = await startApp(project, { PROFILE: 'production', ...dbEnv, OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint });
  try {
    for (let attempt = 0; attempt < 20 && (await get(`${production.management}${METRICS_TRANSPORT.scrapePath}`)).status !== 200; attempt++) await sleep(250);
    const onManagement = await get(`${production.management}${METRICS_TRANSPORT.scrapePath}`);
    const onMain = await get(`${production.base}${METRICS_TRANSPORT.scrapePath}`);
    const ready = await get(`${production.base}/readyz`);
    record(
      'job-dispatch@production',
      'TEL-10',
      onManagement.status === 200 && onManagement.text.includes(GO_RUNTIME.heapUsed) && onMain.status === 404 && ready.status === 200,
      `gestión ${onManagement.status}, principal ${onMain.status}, /readyz ${ready.status}`
    );
  } finally {
    await production.stop();
  }

  // Con seguridad: el colector no tiene token; la API sí lo exige. Sin proveedor de identidad (el JWKS se lee perezoso), basta
  // con que el rechazo sea el 401 del plan de acceso.
  const securedApp = await startApp(secured, { PROFILE: 'develop', ...dbEnv, OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint });
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
  if (keep) console.log(`  (--keep) proyectos en ${root} (se borran al salir del proceso)`);
}

// Los diez casos de develop en cada motor (TEL-12 incluido), production y la seguridad.
const expected = 22;
const failed = results.filter((result) => !result.ok).length;
if (fatal) {
  console.error(`\nsin veredicto: ${fatal}`);
  process.exit(2);
}
console.log(failed === 0 && results.length === expected ? `\ntelemetry-check: ${results.length}/${expected} en verde.` : `\ntelemetry-check: ${failed} caso(s) en rojo de ${results.length} (esperados ${expected}).`);
process.exit(failed === 0 && results.length === expected ? 0 : 1);
