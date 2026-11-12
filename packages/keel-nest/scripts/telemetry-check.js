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
//   · con seguridad, el scrape entra sin token mientras la API exige credencial;
//   · PD-3 (DSL 2.28): con un email personal y único, dos altas con el mismo valor por HTTP contra MySQL (cuyo driver
//     copia el valor en el mensaje de la unicidad violada) y ni lo que recibe el colector ni la consola lo llevan.
//
//   node packages/keel-nest/scripts/telemetry-check.js [--keep] [--only=PD-3] [--sabotage=pd-log-value]
//
// --sabotage=pd-log-value rompe lo emitido CONSERVANDO LA FORMA (sigue compilando): el span vuelve a registrar la
// excepción entera, con el mensaje del motor, y PD-3 tiene que salir rojo.
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
import { loadService } from '@keel-system/keel-core';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, TIMER_LAG, TIMER_PARKED, promGauge, promMetric, promTag } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { KEEL_TIMER, TIMER_PARAMETERS, TIMER_PURGE_KIND } from '@keel-system/keel-core/gen/timer-store';
import { GENERATOR_TABLES, schemaStepSql } from '@keel-system/keel-core/gen/schema-steps';
import { trafficPath } from '@keel-system/keel-core/gen/deploy-probes';
import { planService } from '../src/scaffold/index.js';
import { NODE_RUNTIME } from '../src/scaffold/telemetry.js';
import { JOSE_VERSION, MYSQL2_VERSION } from '../src/lib/assets.js';
import { FIXTURES_DIR } from '../test/helpers/workspace.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { DB_NAME, freePort, resolveRuntime, run, startDatabase, stopDatabase } from './lib/database-container.js';
import { PERSONAL_TELEMETRY_DESIGN, personalSentinel } from '../../keel-core/test/helpers/data-lifecycle-designs.js';

const keep = process.argv.includes('--keep');
// --only=PD-3: solo la app de PD-3 (para iterar; la puerta es la corrida entera).
const onlyPersonal = process.argv.includes('--only=PD-3');
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
// [archivo relativo al proyecto de PD-3, texto que se sustituye, sustituto].
const SABOTAGES = {
  'pd-log-value': ['src/infrastructure/telemetry/telemetry.ts', "return error instanceof Error ? { name: error.name } : 'error';", 'return error instanceof Error ? error : String(error);']
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}
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
  'TEL-11': 'con seguridad, el scrape entra sin token mientras la API exige credencial',
  'TEL-12': 'el cronómetro publica su retraso (con el valor de lo vencido), sus aparcados y la duración de cada disparo por kind',
  'PD-3': 'al violar la unicidad de un campo personal por HTTP, ni las trazas ni los logs que salen de la app llevan su valor'
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
function materialize(root, name, stack, nodeModules, derived = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, derived?.from ?? name));
  if (derived) {
    derived.mutate(layers);
    manifest.service.name = derived.name;
  }
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

/**
 * El proyecto de PD-3: el handler de issueCode lo escribe la sonda, como lo haría el agente (crear el código y guardarlo),
 * y el esquema lo pone el ORM al arrancar: un proyecto recién generado no trae la baseline, que exporta el pase de calidad.
 */
function personalProject(root, nodeModules) {
  const project = materialize(root, PERSONAL_TELEMETRY_DESIGN.name, { database: 'mysql', telemetry: 'otel' }, nodeModules, PERSONAL_TELEMETRY_DESIGN);
  const handler = path.join(project.dir, 'src', 'application', 'usecases', 'issue-code-command-handler.ts');
  const text = fs.readFileSync(handler, 'utf8');
  const body = "    throw new Error('TODO: issueCode');";
  if (!text.includes(body)) throw new Error('PD-3: el handler emitido de issueCode ya no es el que la sonda sabe completar');
  fs.writeFileSync(
    handler,
    "import { randomUUID } from 'node:crypto';\n" +
      "import { VerificationCode } from '../../domain/aggregate/verification-code.js';\n" +
      "import { CodeStatus } from '../../domain/enums/code-status.js';\n" +
      text.replace(
        body,
        '    const code = new VerificationCode({ id: randomUUID(), email: command.email, code: \'123456\', status: CodeStatus.PENDING, issuedAt: new Date(), verifiedAt: null, lockVersion: null });\n' +
          '    return this.verificationCodeApplicationMapper.toIssueCodeResponseDto(await this.verificationCodeRepository.save(code));'
      )
  );
  if (sabotage) {
    const [file, from, to] = SABOTAGES[sabotage];
    const target = path.join(project.dir, file);
    const sabotaged = fs.readFileSync(target, 'utf8');
    if (!sabotaged.includes(from)) throw new Error(`el sabotaje '${sabotage}' no se aplica a lo emitido hoy (${file})`);
    fs.writeFileSync(target, sabotaged.replace(from, to));
  }
  const db = path.join(project.dir, 'config', 'parameters', 'develop', 'db.yaml');
  fs.writeFileSync(db, fs.readFileSync(db, 'utf8').replace('synchronize: false', 'synchronize: true').replace('migrations-run: true', 'migrations-run: false'));
  return project;
}

/** Dónde aparece el valor en lo que salió de la app: unos cientos de caracteres alrededor, para el informe. */
const around = (text, value) => {
  const at = text.indexOf(value);
  return text.slice(Math.max(0, at - 300), at + 200);
};

/** PD-3: dos altas con el mismo valor personal; la segunda viola la unicidad en el motor. */
async function personalCase(project, database, receiver) {
  const app = await startApp(project.dir, {
    PROFILE: 'develop',
    DB_URL: database.url,
    DB_USERNAME: database.user,
    DB_PASSWORD: database.password,
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
    TELEMETRY_EXPORT_ENABLED: 'true'
  });
  try {
    const value = personalSentinel(randomBytes(4).toString('hex'));
    const trace = caller();
    const post = async () => {
      const response = await fetch(`${app.base}${project.model.api.routeBase}/codes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', traceparent: trace.traceparent },
        body: JSON.stringify({ email: value })
      });
      return { status: response.status, text: await response.text() };
    };
    const first = await post();
    const second = await post();
    // El exportador agrupa: se espera a que llegue algún span de esta traza.
    for (let attempt = 0; attempt < 30 && !JSON.stringify(receiver.received).includes(trace.traceId); attempt++) await sleep(500);
    const reached = JSON.stringify(receiver.received).includes(trace.traceId);
    const exported = receiver.received.map((entry) => JSON.stringify(entry)).filter((text) => text.includes(value));
    const printed = app.output().split(/\r?\n/).filter((line) => line.includes(value));
    const leaks = [...exported, ...printed].map((text) => around(text, value));
    record(
      `${PERSONAL_TELEMETRY_DESIGN.name}@mysql`,
      'PD-3',
      first.status === 201 && second.status === 409 && reached && leaks.length === 0,
      `altas ${first.status} y ${second.status} (${second.text.slice(0, 160)}); trazas recibidas: ${reached}; el valor sale por OTLP: ${exported.length}, por consola: ${printed.length}` +
        (leaks.length > 0 ? `\n${leaks.slice(0, 3).join('\n---\n')}` : '')
    );
  } finally {
    await app.stop();
  }
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

/**
 * El cronómetro (DSL 2.26, inc. 11). La app corre con el sueño máximo del sondeador a 10 minutos: así, la purga de keel_timer
 * vencida A ESPALDAS del sondeador (por SQL, hace 120 s según la base) se queda sin reclamar, y el retraso se lee con su
 * VALOR. El disparo se mide al rearrancar: la primera pasada reclama la purga ya vencida y la observa.
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
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name} `) || candidate.startsWith(`${name}{`));
  return line == null ? null : Number(line.slice(line.lastIndexOf(' ') + 1));
};

/** La primera mitad, con la app en marcha: el retraso con su valor y la serie de los aparcados. */
async function timerLag(app, engine, database) {
  const scrapeOf = async () => (await get(`${app.base}${METRICS_TRANSPORT.scrapePath}`)).text;
  // La app asegura sus recurrentes al arrancar: hasta que la fila existe, no hay qué vencer.
  let lag = null;
  let text = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    ageTimerPurge(engine, database);
    text = await scrapeOf();
    lag = gaugeValue(text, promGauge(TIMER_LAG));
    if (lag != null && lag >= 100) break;
    await sleep(500);
  }
  return { lag, parked: gaugeValue(text, promGauge(TIMER_PARKED)) };
}

/** La segunda mitad, tras rearrancar: el histograma del disparo con su kind y su desenlace. */
async function timerTicked(app) {
  const tick = promMetric(OBSERVATIONS.timerTick);
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = (await get(`${app.base}${METRICS_TRANSPORT.scrapePath}`)).text;
    const hit = text
      .split('\n')
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
  const personal = personalProject(root, nodeModules);
  compile(personal.dir);

  const postgres = await startDatabase(runtime, 'postgresql');
  databases.push(postgres);
  const mysql = await startDatabase(runtime, 'mysql');
  databases.push(mysql);
  const dbEnv = (database) => ({ DB_URL: database.url, DB_USERNAME: database.user, DB_PASSWORD: database.password });
  // keel_timer, con el paso de esquema del generador (gen/schema-steps.js): en develop el esquema lo ponen las
  // migraciones, y un proyecto recién generado no trae la baseline (la exporta el agente). Sin la tabla no hay retraso
  // que leer ni disparo que observar.
  for (const [engine, database] of [['postgresql', postgres], ['mysql', mysql]]) {
    const step = schemaStepSql(engine, GENERATOR_TABLES.filter((table) => table.table === KEEL_TIMER.table));
    const args =
      engine === 'postgresql'
        ? ['exec', '-i', database.name, 'psql', '-U', DB_NAME, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1']
        : ['exec', '-i', database.name, 'mysql', '-h', '127.0.0.1', '-u', 'root', `-p${database.password}`, DB_NAME];
    const created = run(runtime, args, { input: step });
    if (created.status !== 0) throw new Error(`no se pudo crear keel_timer en ${engine}: ${created.stderr}`);
  }

  for (const [variant, project, database, poolMax] of onlyPersonal ? [] : [
    ['job-dispatch@postgresql', base, postgres, 7],
    ['job-dispatch@mysql', onMysql, mysql, 5]
  ]) {
    const app = await startApp(project.dir, {
      PROFILE: 'develop',
      ...dbEnv(database),
      DB_POOL_MAX_SIZE: String(poolMax),
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      TELEMETRY_EXPORT_ENABLED: 'true',
      ...LONG_SLEEP
    });
    const engine = variant.endsWith('@mysql') ? 'mysql' : 'postgresql';
    let timer;
    try {
      const trace = caller();
      const correlationId = `tel-check-${randomBytes(4).toString('hex')}`;
      for (let i = 0; i < 3; i++) {
        await get(`${app.base}${trafficPath(project.model)}`, { traceparent: trace.traceparent, 'x-correlation-id': correlationId });
      }
      await developCases(variant, app, project.model, receiver, trace, correlationId, poolMax);
      timer = await timerLag(app, engine, database);
    } finally {
      await app.stop();
    }
    const again = await startApp(project.dir, { PROFILE: 'develop', ...dbEnv(database), ...LONG_SLEEP });
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

  if (!onlyPersonal) {
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
  }

  await personalCase(personal, mysql, receiver);
} catch (error) {
  fatal = String(error?.message ?? error);
} finally {
  receiver.close();
  for (const database of databases) stopDatabase(runtime, database);
  if (keep) console.log(`  (--keep) proyectos en ${root}`);
}

const expected = onlyPersonal ? 1 : ['TEL-1', 'TEL-2', 'TEL-3', 'TEL-4', 'TEL-5', 'TEL-6', 'TEL-7', 'TEL-8', 'TEL-9', 'TEL-12'].length * 2 + 3;
const failed = results.filter((result) => !result.ok).length;
if (fatal) {
  console.error(`\nsin veredicto: ${fatal}`);
  process.exit(2);
}
console.log(failed === 0 && results.length === expected ? `\ntelemetry-check: ${results.length}/${expected} en verde.` : `\ntelemetry-check: ${failed} caso(s) en rojo de ${results.length} (esperados ${expected}).`);
process.exit(failed === 0 && results.length === expected ? 0 : 1);
