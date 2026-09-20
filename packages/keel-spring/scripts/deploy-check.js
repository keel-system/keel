#!/usr/bin/env node
// Ejercita la RUTA DE PRODUCCIÓN de la telemetría: la que `telemetry-check` no puede tocar.
//
// **Qué mide que ninguna otra red puede.** `telemetry-check` arranca la aplicación en el HOST,
// bajo JUnit, y le pregunta a ella misma qué publica. Eso deja fuera la otra mitad entera, que es
// justo la que se usa en producción:
//
//   · que el COLECTOR alcance a la aplicación por la red del compose y se traiga sus métricas
//     (nadie las empuja: se van a buscar, y un scrape mal configurado no produce ningún error —
//     produce un backend sin esa serie, indistinguible de un servicio parado);
//   · que el EXEMPLAR sobreviva al viaje hasta el backend (el Prometheus de la imagen los acepta
//     y los TIRA si no se arrancó con --enable-feature=exemplar-storage: sin error y sin log);
//   · que con ese exemplar se llegue de verdad a la TRAZA, que es el salto que el panel existe
//     para dar;
//   · que el PANEL y las ALERTAS provisionadas hayan entrado (hoy eso solo se ve mirando la
//     interfaz: un montaje mal puesto deja a Grafana arrancando sin decir nada);
//   · y que el CONTACTO entregue. Esta es la que más barata sale de perder: la URL del contacto
//     viene de `$__env{…}`, así que si esa variable no llega al proceso de Grafana el contacto se
//     provisiona con el literal dentro, la entrega falla y **no hay ningún síntoma** — las alertas
//     se siguen viendo en la interfaz, que es exactamente el estado que había antes de tenerlo.
//
// **Cómo lo hace.** Genera una fixture con telemetría, levanta `deploy/` ENTERO con su propio
// `up.sh` (aplicación en contenedor incluida), manda tráfico HTTP contra un endpoint del diseño
// —el handler es un stub y responde 500, y da igual: la observación se cierra con desenlace
// `error`, que es lo que hay que medir— y después le pregunta AL BACKEND, por la API de Grafana.
// Ningún nombre de serie se escribe: salen de `src/lib/telemetry-probes.js`, el mismo módulo del
// que el panel saca sus consultas.
//
// **El sujeto no es cualquiera.** `job-dispatch` no declara storage, correo, mensajería ni
// seguridad, así que TODOS sus puertos tienen bean recién generado y el contexto arranca sin una
// línea del agente. Con `asset-vault` no arrancaría: el adaptador de `FileStorage` lo escribe el
// agente y un contenedor no admite dobles.
//
// **Lo que NO mide**: las dos plantillas de colector de producción (`collector-agent`,
// `collector-gateway`), que dependen de un clúster de Kubernetes.
//
//   node packages/keel-spring/scripts/deploy-check.js [fixture] [--keep]
//   npm run deploy-check --workspace packages/keel-spring
//
// Códigos de salida: 0 todo OK · 1 hay casos rojos · 2 el arnés no pudo correr (sin veredicto).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { resolveStack, scaffoldService } from '../src/scaffold/index.js';
import { dashboardUid } from '../src/scaffold/observability-assets.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { ALERTING, TELEMETRY_INFRA } from '../src/lib/stack-catalog.js';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, promMetric, promTag } from '../src/lib/telemetry-probes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'job-dispatch';
const keep = args.includes('--keep');

// Las credenciales del backend de prueba de la imagen. No son un secreto: es el Grafana de
// deploy/, que nace con admin/admin y no sale de la máquina.
const GRAFANA_USER = 'admin';
const GRAFANA_PASSWORD = 'admin';

// ─── Procesos ────────────────────────────────────────────────────────────────

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  // `result.error` cuando el proceso ni llega a lanzarse: sin recogerlo, llega como salida vacía
  // y código 1, indistinguible de un comando que corrió y falló.
  const failure = result.error ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : '';
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + failure };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Una lectura HTTP que nunca lanza: un ECONNREFUSED durante el arranque es esperable. */
async function http(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error) };
  }
}

let GRAFANA = '';

const basic = () => 'Basic ' + Buffer.from(GRAFANA_USER + ':' + GRAFANA_PASSWORD).toString('base64');

async function grafana(pathname, options = {}) {
  const response = await http(GRAFANA + pathname, {
    ...options,
    headers: { Authorization: basic(), 'Content-Type': 'application/json', ...(options.headers ?? {}) }
  });
  let json = null;
  try {
    json = JSON.parse(response.text);
  } catch {
    json = null;
  }
  return { ...response, json };
}

/** Consulta instantánea a un datasource de Prometheus, por el proxy de Grafana. */
async function promQuery(uid, query) {
  const response = await grafana(`/api/datasources/proxy/uid/${uid}/api/v1/query?query=${encodeURIComponent(query)}`);
  return response.json?.data?.result ?? [];
}

// ─── El proyecto y sus puertos ───────────────────────────────────────────────

/**
 * Le da a la aplicación un ESQUEMA con el que arrancar, y hay que decirlo en voz alta.
 *
 * <p>El perfil `develop` arranca con `ddl-auto: validate` y el esquema lo gobiernan las
 * migraciones de `db/migration/`, que en un proyecto RECIÉN GENERADO están vacías: el baseline lo
 * exporta el agente de calidad desde las entidades finales. Sin esto, Hibernate no valida nada
 * contra una base sin tablas y el contexto muere al arrancar — la aplicación no llega a READY y
 * no hay telemetría que medir. Le pasó a la primera pasada de este check.
 *
 * <p>Lo que se mide aquí es el TRANSPORTE de la telemetría, no el esquema, así que el arnés
 * fabrica la precondición igual que `stallInFlight` fabrica un reloj rancio: desactiva Flyway y
 * deja que Hibernate cree las tablas desde las entidades. Las dos son variables que la config
 * generada ya expone, no un parche al proyecto.
 *
 * <p>Y por eso `deploy-check` NO es una prueba de que el proyecto recién generado se despliegue:
 * no lo es, y no pretende serlo. Es una prueba de la ruta de la telemetría.
 */
function giveSchemaToTheApp(projectDir) {
  const file = path.join(projectDir, 'deploy', 'docker-compose.yaml');
  const compose = fs.readFileSync(file, 'utf8');
  const anchor = '      PROFILE: develop\n';
  if (compose.split(anchor).length - 1 !== 1) {
    throw new Error('el compose de deploy/ no declara el perfil de la app como se esperaba');
  }
  fs.writeFileSync(
    file,
    compose.replace(anchor, `${anchor}      FLYWAY_ENABLED: "false"\n      SPRING_JPA_HIBERNATE_DDL_AUTO: update\n`),
    'utf8'
  );
}

/** El frontend de compose que funcione, para poder LEER los logs cuando algo no arranca. */
function composeFrontend() {
  const candidates = [
    { command: 'docker', prefix: ['compose'] },
    { command: 'podman', prefix: ['compose'] },
    { command: 'podman-compose', prefix: [] }
  ];
  return candidates.find((candidate) => run(candidate.command, [...candidate.prefix, 'version']).status === 0) ?? null;
}

/**
 * Los últimos logs de la aplicación.
 *
 * <p>Existe porque el proyecto vive en un temporal que se borra al salir: sin traerlos aquí, el
 * diagnóstico de «no arrancó» exige repetir la pasada entera con --keep, que son otros quince
 * minutos. La causa de un rojo tiene que llegar por stdout.
 */
function appLogs(projectDir) {
  const frontend = composeFrontend();
  if (!frontend) return '(no hay frontend de compose con el que leer los logs)';
  const result = run(
    frontend.command,
    [...frontend.prefix, '-f', 'deploy/docker-compose.yaml', '--env-file', 'deploy/.env', 'logs', '--tail', '40', 'app'],
    { cwd: projectDir }
  );
  return (result.stdout + result.stderr).trim().split('\n').slice(-40).join('\n');
}

/** Los valores de deploy/.env, que es de donde salen los puertos publicados. */
function readEnv(projectDir) {
  const values = {};
  for (const line of fs.readFileSync(path.join(projectDir, 'deploy', '.env'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Una petición con la que atravesar un caso de uso, LEÍDA del controller generado.
 *
 * <p>Se prefiere un GET: un POST con el cuerpo vacío lo rechaza la validación del borde y no
 * llega al mediator, así que no dejaría ninguna observación — el caso mediría el 400, no la
 * telemetría.
 */
function trafficPath(projectDir) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const controllers = walk(path.join(projectDir, 'src', 'main', 'java')).filter((file) =>
    file.endsWith('Controller.java')
  );
  for (const file of controllers) {
    const source = fs.readFileSync(file, 'utf8');
    const base = /@RequestMapping\("([^"]+)"\)/.exec(source)?.[1] ?? '';
    const get = /@GetMapping\((?:"([^"]*)")?\)/.exec(source);
    if (!get) continue;
    const suffix = get[1] ?? '';
    // Un {segmento} se sustituye por un uuid: no existe, y tampoco hace falta — el stub lanza
    // antes de mirarlo y la observación se cierra igual con su desenlace.
    return (base + suffix).replace(/\{[^}]+\}/g, '11111111-1111-1111-1111-111111111111');
  }
  return null;
}

// ─── Los casos ───────────────────────────────────────────────────────────────

const CASES = [
  { id: 'DEP-1', title: 'el perfil develop expone el scrape que el colector viene a buscar' },
  { id: 'DEP-2', title: 'la serie del caso de uso llegó al backend por el scrape, con su servicio' },
  { id: 'DEP-3', title: 'el exemplar sobrevivió al viaje y trae un id de traza' },
  { id: 'DEP-4', title: 'esa traza existe en el backend de trazas: el salto métrica→traza se cierra' },
  { id: 'DEP-5', title: 'los logs del servicio llegaron al backend de logs' },
  { id: 'DEP-6', title: 'el panel provisionado entró con su uid' },
  { id: 'DEP-7', title: 'las alertas provisionadas están cargadas y la política enruta al contacto' },
  { id: 'DEP-8', title: 'una alerta que dispara recorre la política y LLEGA al contacto' }
];

const results = [];
const record = (id, ok, detail = '') => {
  const found = CASES.find((item) => item.id === id);
  results.push({ id, title: found.title, ok, detail });
};

// ─── Entrada ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${fixturesDir}`);
  process.exit(2);
}

const service = loadService(path.join(fixturesDir, fixture));
if (service.errors.length > 0) {
  console.error(`La fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);
  process.exit(2);
}

const runtime = ['docker', 'podman'].find((candidate) => run(candidate, ['--version']).status === 0);
if (!runtime) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-deploy-keep-')) : tmpDir('keel-deploy-check-');
let projectDir = null;
let fatal = null;

try {
  const stack = resolveStack({ telemetry: 'otel' }, service.layers, service.manifest);
  const result = scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack
  });
  projectDir = path.join(workspace, result.outDir);
  console.log(`sujeto: ${fixture} (${stack.database}${stack.broker ? ', ' + stack.broker : ''}) con telemetría`);

  const env = readEnv(projectDir);
  const appPort = env.APP_PORT ?? '8080';
  const grafanaPort = env.GRAFANA_PORT ?? String(TELEMETRY_INFRA.backend.grafanaPublishedPort);
  const sinkPort = env[ALERTING.sink.portVar] ?? String(ALERTING.sink.publishedPort);
  GRAFANA = `http://localhost:${grafanaPort}`;

  giveSchemaToTheApp(projectDir);
  process.stdout.write('levantando deploy/ (construye la imagen: esto tarda)… ');
  const up = run('bash', ['deploy/up.sh'], { cwd: projectDir, timeout: 20 * 60 * 1000 });
  if (up.status !== 0) {
    console.log('KO');
    console.error((up.stderr || up.stdout).trim().split('\n').slice(-25).join('\n'));
    throw new Error('deploy/up.sh no levantó el stack');
  }
  console.log('OK');

  process.stdout.write('esperando a que la aplicación esté lista… ');
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    const health = await http(`http://localhost:${appPort}/actuator/health/readiness`);
    ready = health.ok && health.text.includes('UP');
    if (!ready) await sleep(5000);
  }
  if (!ready) {
    console.log('KO');
    console.error(`\nlos últimos logs de la app:\n${appLogs(projectDir)}`);
    throw new Error('la aplicación no llegó a responder READY: sin app no hay telemetría que medir');
  }
  console.log('OK');

  // DEP-1. Lo que el colector viene a buscar tiene que estar expuesto en este perfil. Si no lo
  // está, Boot responde 404 haya la regla de seguridad que haya, y el backend se queda sin
  // ninguna métrica sin que nada falle.
  const scrape = await http(`http://localhost:${appPort}${METRICS_TRANSPORT.scrapePath}`);
  record(
    'DEP-1',
    scrape.ok && scrape.text.includes('jvm_memory_used_bytes'),
    scrape.ok ? '' : `el scrape respondió ${scrape.status}: ¿expuesto en el perfil develop?`
  );

  // Tráfico: un caso de uso REAL, por HTTP, desde fuera del contenedor.
  const traffic = trafficPath(projectDir);
  if (!traffic) {
    throw new Error('el diseño no expone ningún GET: la sonda no puede atravesar un caso de uso por HTTP');
  }
  for (let i = 0; i < 5; i++) await http(`http://localhost:${appPort}${traffic}`);
  console.log(`tráfico enviado a ${traffic} (el stub responde 500: el desenlace es 'error', que es lo que se mide)`);

  // Los datasources, por TIPO: sus uids son de la imagen del backend y pueden cambiar con ella.
  const datasources = (await grafana('/api/datasources')).json ?? [];
  const uidOf = (type) => datasources.find((item) => item.type === type)?.uid ?? null;
  const prometheusUid = uidOf('prometheus');
  const tempoUid = uidOf('tempo');
  const lokiUid = uidOf('loki');
  if (!prometheusUid) {
    throw new Error('Grafana no tiene datasource de Prometheus: el backend de prueba no arrancó como se esperaba');
  }

  const useCase = promMetric(OBSERVATIONS.useCase);
  process.stdout.write('esperando al scrape del colector… ');
  let series = [];
  for (let attempt = 0; attempt < 24 && series.length === 0; attempt++) {
    series = await promQuery(prometheusUid, useCase.count);
    if (series.length === 0) await sleep(5000);
  }
  console.log(series.length > 0 ? 'OK' : 'KO');

  // DEP-2. Con `service_name`: un scrape no trae los atributos de recurso, los pone el procesador
  // `resource/scrape` del colector. Sin él la serie llega igual y el panel no puede filtrar por
  // servicio — otro fallo que no se ve hasta que hay dos servicios.
  const conServicio = series.some((item) => item.metric?.service_name);
  record(
    'DEP-2',
    series.length > 0 && conServicio,
    series.length === 0
      ? `el backend no tiene ${useCase.count}: el colector no alcanzó a la app, o su scrape no está configurado`
      : conServicio
        ? ''
        : 'la serie llegó sin service_name: falta el procesador resource/scrape del colector'
  );
  const conDesenlace = series.some((item) => item.metric?.[promTag(ATTRIBUTES.outcome)]);

  // DEP-3. El exemplar: lo que hace que del punto se pueda saltar a la petición concreta.
  const ahora = Math.floor(Date.now() / 1000);
  const exemplars = await grafana(
    `/api/datasources/proxy/uid/${prometheusUid}/api/v1/query_exemplars` +
      `?query=${encodeURIComponent(useCase.bucket)}&start=${ahora - 900}&end=${ahora}`
  );
  const traceId = exemplars.json?.data
    ?.flatMap((item) => item.exemplars ?? [])
    .map((item) => item.labels?.trace_id ?? item.labels?.traceID)
    .find(Boolean);
  record(
    'DEP-3',
    Boolean(traceId),
    traceId
      ? ''
      : 'ningún exemplar en el backend: el Prometheus de la imagen los acepta y los TIRA sin ' +
          '--enable-feature=exemplar-storage, y tampoco hay exemplar si la traza no se muestreó'
  );

  // DEP-4. Y que ese id lleve de verdad a una traza: el salto completo.
  if (traceId && tempoUid) {
    const trace = await grafana(`/api/datasources/proxy/uid/${tempoUid}/api/traces/${traceId}`);
    record('DEP-4', trace.ok && trace.text.length > 2, trace.ok ? '' : `Tempo respondió ${trace.status} para ${traceId}`);
  } else {
    record('DEP-4', false, traceId ? 'no hay datasource de trazas' : 'sin exemplar no hay traza a la que saltar');
  }

  // DEP-5. Los logs. En deploy/ van por OTLP a propósito, porque allí nadie recoge la consola.
  if (lokiUid) {
    const query = `{service_name="${service.manifest.service.name}"}`;
    const logs = await grafana(
      `/api/datasources/proxy/uid/${lokiUid}/loki/api/v1/query_range` +
        `?query=${encodeURIComponent(query)}&start=${(ahora - 900) * 1e9}&end=${ahora * 1e9}&limit=5`
    );
    const lineas = (logs.json?.data?.result ?? []).flatMap((item) => item.values ?? []);
    record('DEP-5', lineas.length > 0, lineas.length > 0 ? '' : 'Loki no tiene logs del servicio: ¿LOG_EXPORT_OTLP?');
  } else {
    record('DEP-5', false, 'no hay datasource de logs');
  }

  // DEP-6. El panel: un montaje mal puesto deja a Grafana arrancando sin decir nada.
  const uid = dashboardUid({ service: { artifactId: service.manifest.service.name } });
  const panel = await grafana(`/api/dashboards/uid/${uid}`);
  record('DEP-6', panel.ok, panel.ok ? '' : `el panel ${uid} no entró (${panel.status})`);

  // DEP-7. Las reglas y la política.
  const reglas = (await grafana('/api/v1/provisioning/alert-rules')).json ?? [];
  const mias = reglas.filter((regla) => String(regla.uid ?? '').startsWith(`keel-${service.manifest.service.name}`));
  const politica = (await grafana('/api/v1/provisioning/policies')).json ?? {};
  const enruta = politica.receiver === ALERTING.contactPoint;
  record(
    'DEP-7',
    mias.length > 0 && enruta,
    mias.length === 0
      ? 'ninguna regla provisionada llegó a Grafana'
      : enruta
        ? ''
        : `la política no enruta a ${ALERTING.contactPoint}: las alertas se verían en la interfaz y no saldrían`
  );

  // DEP-8. Y la entrega. Se prueba el contacto TAL COMO QUEDÓ PROVISIONADO —se lee de Grafana— y
  // no uno compuesto aquí: si `$__env{…}` no se resolvió, su url es el literal y la entrega falla,
  // que es exactamente el fallo que no produce ningún síntoma.
  const contactos = (await grafana('/api/v1/provisioning/contact-points')).json ?? [];
  const contacto = contactos.find((item) => item.name === ALERTING.contactPoint);
  const contar = (texto) => (texto.match(new RegExp(ALERTING.sink.path, 'g')) ?? []).length;
  if (!contacto) {
    record('DEP-8', false, 'el contacto no llegó a provisionarse');
  } else if (String(contacto.settings?.url ?? '').includes('$__env')) {
    record(
      'DEP-8',
      false,
      `la url del contacto quedó sin resolver (${contacto.settings.url}): la variable no llegó al proceso de Grafana`
    );
  } else {
    const previas = contar((await http(`http://localhost:${sinkPort}/__admin/requests`)).text);

    // Se dispara una alerta DE VERDAD en vez de usar el botón «Test» de Grafana, y no es un
    // rodeo: (a) esa API cambia de versión en versión —en la 13 los dos endpoints que había
    // responden 410 y 404—, y (b) el botón manda al contacto DIRECTAMENTE, saltándose la
    // política. Lo que aquí se quiere medir es el camino entero: regla → política → contacto →
    // webhook. Una regla temporal con una condición siempre cierta y `for: 0s` lo recorre.
    //
    // La regla se crea en el MISMO grupo y carpeta que las provisionadas —se leen de una de
    // ellas— para heredar su intervalo de evaluación: en un grupo nuevo habría que fijarlo aparte.
    const provisionada = mias[0];
    const sonda = {
      title: 'KeelDeployCheckProbe',
      ruleGroup: provisionada?.ruleGroup,
      folderUID: provisionada?.folderUID,
      orgID: 1,
      condition: 'B',
      for: '0s',
      noDataState: 'OK',
      execErrState: 'OK',
      labels: { severity: 'warning' },
      annotations: { summary: 'Sonda de deploy-check: comprobando que el contacto entrega' },
      data: [
        {
          refId: 'A',
          datasourceUid: '__expr__',
          relativeTimeRange: { from: 600, to: 0 },
          model: { refId: 'A', type: 'math', expression: '1', datasource: { type: '__expr__', uid: '__expr__' } }
        },
        {
          refId: 'B',
          datasourceUid: '__expr__',
          model: {
            refId: 'B',
            type: 'threshold',
            expression: 'A',
            conditions: [{ evaluator: { type: 'gt', params: [0] } }],
            datasource: { type: '__expr__', uid: '__expr__' }
          }
        }
      ]
    };
    const creada = await grafana('/api/v1/provisioning/alert-rules', {
      method: 'POST',
      // Sin esto la regla queda marcada como provisionada y no se puede borrar luego por API.
      headers: { 'X-Disable-Provenance': 'true' },
      body: JSON.stringify(sonda)
    });

    // Evaluación (el grupo va a un minuto) más el `group_wait` de la política: hasta tres minutos.
    let entregadas = previas;
    if (creada.ok) {
      for (let attempt = 0; attempt < 36 && entregadas === previas; attempt++) {
        await sleep(5000);
        entregadas = contar((await http(`http://localhost:${sinkPort}/__admin/requests`)).text);
      }
      const uidSonda = creada.json?.uid;
      if (uidSonda) await grafana(`/api/v1/provisioning/alert-rules/${uidSonda}`, { method: 'DELETE' });
    }
    record(
      'DEP-8',
      entregadas > previas,
      creada.ok
        ? 'la alerta disparó y la política la enrutó, pero el webhook no llegó al sumidero: mira la url del contacto y la red del compose'
        : `no se pudo crear la regla de sonda (${creada.status}): sin ella no hay alerta que recorra la política`
    );
  }
  if (!conDesenlace && series.length > 0) {
    console.log(
      `  aviso: la serie llegó sin la etiqueta ${promTag(ATTRIBUTES.outcome)}; la alerta de tasa de error filtra por ella`
    );
  }
} catch (error) {
  fatal = String(error?.message ?? error);
} finally {
  if (projectDir && !keep) run('bash', ['deploy/down.sh'], { cwd: projectDir, timeout: 10 * 60 * 1000 });
  if (keep && projectDir) console.log(`  (--keep) proyecto en ${projectDir} (bájalo con bash deploy/down.sh)`);
}

console.log('\nMatriz de la ruta de producción');
for (const item of results) {
  console.log(`  ${item.id}  ${item.ok ? 'OK' : 'KO'}  ${item.title}${item.ok ? '' : ' — ' + item.detail}`);
}
// Un caso declarado que no llegó a medirse se dice con esas palabras: «no lo ejecutó nadie» y
// «pasó» son dos cosas distintas, y confundirlas es la forma más barata de no medir nada.
for (const item of CASES.filter((caso) => !results.some((hecho) => hecho.id === caso.id))) {
  console.log(`  ${item.id}  --  ${item.title} (no llegó a medirse)`);
}

const stamp = () => {
  const head = run('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']);
  return {
    generatedAt: new Date().toISOString(),
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null
  };
};

fs.writeFileSync(
  path.join(process.cwd(), 'deploy-check.json'),
  JSON.stringify({ ...stamp(), fixture, results, fatal }, null, 2),
  'utf8'
);

if (fatal) {
  console.error(`\nsin veredicto: ${fatal}`);
  process.exit(2);
}
process.exit(results.some((item) => !item.ok) || results.length < CASES.length ? 1 : 0);
