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
import { tmpDir } from '../test/helpers/tmp.js';
import { ALERTING, TELEMETRY_INFRA } from '../src/lib/stack-catalog.js';
import { METRICS_TRANSPORT } from '../src/lib/telemetry-probes.js';
import { DEPLOY_CASES, probeDeployBackend } from 'keel-core/gen/deploy-probes';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'job-dispatch';
const keep = args.includes('--keep');


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

const CASES = DEPLOY_CASES;

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

  // DEP-2 a DEP-8: las preguntas al backend, NEUTRALES (keel-core/gen/deploy-probes.js): las mismas que hace el
  // deploy-check de keel-nest, porque el backend, el panel, las alertas y el contacto son los mismos.
  process.stdout.write('preguntando al backend (espera al scrape del colector y a la entrega de una alerta)… ');
  const warnings = await probeDeployBackend({
    grafanaUrl: GRAFANA,
    sinkUrl: `http://localhost:${sinkPort}`,
    serviceName: service.manifest.service.name,
    record
  });
  console.log('hecho');
  for (const warning of warnings) console.log(`  aviso: ${warning}`);
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
