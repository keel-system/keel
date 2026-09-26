#!/usr/bin/env node
// Ejercita la TELEMETRÍA del servidor generado contra infraestructura real, con la aplicación
// ARRANCADA. Es el único check que la arranca, y la razón es que lo que mide no existe hasta que
// hay un contexto de Spring en pie.
//
// **Qué mide que ninguna otra red puede.** El panel y las alertas que emite `build` consultan
// nombres de serie (`keel_use_case_seconds_count`, `keel_storage_seconds_bucket`) con etiquetas
// concretas (`keel_operation`, `keel_outcome`). Esos nombres NO se escriben: los compone
// Micrometer al exponer la métrica, y dependen del registro —el de OTLP publicaba los timers en
// milisegundos, el de Prometheus los publica en SEGUNDOS—. Nada de lo que ya existe lo puede
// juzgar: los tests del generador comparan cadenas, `java-syntax` tokeniza y javac da por bueno
// cualquier literal dentro de un JSON. Y el modo de fallo es el peor de todos: una alerta que
// consulta una serie que nadie publica **no falla — no dispara nunca**, y nadie se entera.
//
// Lo mismo con los exemplars: que el bean `SpanContext` exista no dice que el exemplar viaje. Se
// ve mirando el texto de la exposición, que es donde aparece —o no— el `# {trace_id=...}` pegado
// al cubo del histograma.
//
// **Cómo lo hace.** Escribe en el proyecto generado una sonda JUnit (renderizada desde
// `src/lib/telemetry-probes.js`, que es el mismo módulo del que el scaffolding saca esos nombres
// — un runner con nombres propios mediría una copia de sí mismo) y la ejecuta con Gradle contra
// la infraestructura de `infra/`. La sonda ejercita los PUERTOS y el mediator directamente, sin
// pasar por HTTP: con capa `security` eso habría metido un proveedor de identidad entero por
// delante de la pregunta.
//
// **Dobles mínimos.** El adaptador de almacenamiento lo escribe el agente, así que en un proyecto
// recién generado no hay ningún `FileStorage` y el contexto no arranca. El runner escribe uno en
// memoria — y es justo el bean que el aspecto tiene que envolver: si no lo envuelve, su caso cae.
//
// **Lo que este check NO mide**, y conviene que esté escrito: el SCRAPE en sí (que el colector
// alcance a la app por la red del compose) y el camino del exemplar hasta el backend. Aquí la
// aplicación corre en el host bajo JUnit, así que lo medido es lo que el servidor PUBLICA, no
// quién viene a buscarlo. Esa mitad se prueba a mano con `deploy/up.sh`.
//
//   node packages/keel-spring/scripts/telemetry-check.js [fixture] [--keep]
//   npm run telemetry-check --workspace packages/keel-spring
//
// Códigos de salida: 0 todo OK · 1 hay casos rojos · 2 el arnés no pudo correr (sin veredicto).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { resolveStack, scaffoldService } from '../src/scaffold/index.js';
import { tmpDir } from '../test/helpers/tmp.js';
import {
  CASES,
  DOUBLES_CLASS,
  DOWN_CLASS,
  PROBE_CLASS,
  SWITCH_CLASS,
  consumerLagFor,
  doublesClass,
  downClass,
  probeClass,
  switchClass
} from '../src/lib/telemetry-probes.js';
import { OBSERVABILITY_DIR } from '../src/lib/stack-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'asset-vault';
const keep = args.includes('--keep');

// ─── Procesos y compose (misma resolución que los scripts generados) ─────────

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  // `result.error` cuando el proceso ni llega a lanzarse (un ENOENT). Sin recogerlo, el fallo
  // llega como salida vacía y código 1, indistinguible de un comando que corrió y falló.
  const failure = result.error ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : '';
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + failure };
}

function resolveRuntime() {
  const preferred = process.env.CONTAINER_RUNTIME;
  for (const runtime of preferred ? [preferred] : ['docker', 'podman']) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends =
      runtime === 'podman'
        ? [
            { command: 'podman', prefix: ['compose'] },
            { command: 'podman-compose', prefix: [] }
          ]
        : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  const failures = [];
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d'], {
      cwd: projectDir
    });
    if (result.status === 0) return { frontend, log: result.stdout + result.stderr };
    failures.push(`${frontend.command}: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  return { frontend: null, log: failures.join('\n') };
}

function composeDown(frontend, projectDir) {
  run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}

// Sello del veredicto: cuándo se emitió y sobre QUÉ árbol. Sin él, un artefacto rojo de un
// borrador anterior es indistinguible de un veredicto recién emitido.
function verdictStamp() {
  const head = run('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']);
  return {
    generatedAt: new Date().toISOString(),
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null
  };
}

// ─── Lo que la sonda necesita saber, LEÍDO DEL ÁRBOL GENERADO ────────────────
//
// Los nombres no se deducen ni se escriben: se leen de lo que build acaba de emitir. Es la misma
// disciplina que `claim-check` con sus paquetes — una lista escrita a mano caduca en silencio, y
// una pasada que mide un nombre que ya no existe no se pone roja, se queda sin medir.

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

function readProjectSpec(projectDir, stack) {
  const mainDir = path.join(projectDir, 'src', 'main', 'java');
  const files = walk(mainDir);
  const byName = (suffix) => files.filter((file) => file.endsWith(suffix));

  // Por la ANOTACIÓN y no por el nombre: en notification-mailer hay un agregado del dominio que
  // también acaba en `Application`, y buscar por sufijo resolvía el paquete base a la mitad del
  // dominio — con lo que todos los imports de la sonda apuntaban a paquetes inexistentes.
  const appFile = files.find((file) => file.endsWith('.java') && fs.readFileSync(file, 'utf8').includes('@SpringBootApplication'));
  if (!appFile) throw new Error('no se encontró ninguna clase @SpringBootApplication en el árbol generado');
  const appClass = path.basename(appFile, '.java');
  const basePackage = /package\s+([\w.]+);/.exec(fs.readFileSync(appFile, 'utf8'))[1];

  // `implements Command` y no «acaba en Command»: la mayoría son `ReturningCommand`, y con uno de
  // esos el cast de la sonda revienta ANTES de llegar al mediator. El caso que lo detectó fue
  // notification-mailer, donde seis de sus siete comandos devuelven algo.
  const commandFile = byName('Command.java')
    .filter((file) => file.includes(`${path.sep}commands${path.sep}`))
    .find((file) => /implements\s+Command\s*\{/.test(fs.readFileSync(file, 'utf8')));
  if (!commandFile) {
    throw new Error('el diseño no tiene ningún Command sin retorno: la sonda no puede atravesar el mediator');
  }
  const commandFqn = `${/package\s+([\w.]+);/.exec(fs.readFileSync(commandFile, 'utf8'))[1]}.${path.basename(commandFile, '.java')}`;

  const spec = { basePackage, appClass, commandFqn, subsystems: [] };

  // La trampa que ya cerraron claim-check y store-check, aquí otra vez: en un proyecto
  // DOCUMENTAL el source set de pruebas trae flapdoodle para el perfil `test`, y su
  // autoconfiguración levanta un mongod embebido. Sin excluirla, la sonda mediría una base en
  // memoria —y saldría en VERDE sin haber tocado el contenedor que acabamos de levantar—.
  const documental =
    byName('MongoTransactionConfig.java').length > 0 || files.some((file) => file.endsWith('MongoRepository.java'));
  if (documental) {
    spec.excludeAutoConfig = 'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration';
  }

  // El modelo de persistencia decide QUÉ pool publica series: Hikari o el del driver de Mongo.
  // Se lee del árbol, como todo lo demás: una lista de fixtures por modelo caduca en silencio.
  spec.persistenceKind = documental ? 'document' : files.some((file) => file.endsWith('Jpa.java')) ? 'relational' : null;
  if (spec.persistenceKind) spec.subsystems.push('pool');

  // El broker sale del stack YA RESUELTO (con sus defaults), no de uno escrito aquí: quien lo
  // resuelve es el mismo `resolveStack` con el que se generó el árbol.
  spec.broker = stack?.broker ?? null;

  // Y la aplicabilidad del retraso se pregunta AL PANEL: si el panel generado no consulta la
  // serie, no hay nada que medir — y si la consulta, medirla es obligatorio. Con dos criterios
  // (uno aquí y otro en observability-assets.js) el día que diverjan el panel pediría una serie
  // que la sonda ya no mira.
  const lagSeries = consumerLagFor(spec.broker)?.series;
  const dashboards = path.join(projectDir, 'deploy', OBSERVABILITY_DIR, 'dashboards');
  const panelQueries = fs.existsSync(dashboards)
    ? fs
        .readdirSync(dashboards)
        .map((name) => fs.readFileSync(path.join(dashboards, name), 'utf8'))
        .join('\n')
    : '';
  if (lagSeries && panelQueries.includes(lagSeries)) spec.subsystems.push('consumerLag');

  const policies = byName('StoragePolicies.java')[0];
  if (policies) {
    spec.subsystems.push('storage');
    const source = fs.readFileSync(policies, 'utf8');
    const bucket = /=\s*"([^"]+)"/.exec(source);
    if (!bucket) throw new Error('StoragePolicies no declara ningún bucket lógico');
    spec.storageBucket = bucket[1];
    const port = fs.readFileSync(byName(`${path.sep}FileStorage.java`)[0] ?? byName('FileStorage.java')[0], 'utf8');
    spec.hasPrivateBucket = port.includes('byte[] download(');
    spec.hasPublicBucket = port.includes('String publicUrl(');
    spec.doublesClass = DOUBLES_CLASS;
  }

  const mailSender = byName('SmtpMailSender.java')[0];
  if (mailSender) {
    spec.subsystems.push('mail');
    spec.mailFrom = 'sonda@keel.test';
    spec.mailTo = 'destino-de-la-sonda@keel.test';
    spec.mailAttachments = fs.readFileSync(byName('MailMessage.java')[0], 'utf8').includes('List<Attachment> attachments');
  }

  // El contexto al saltar de hilo: aplica si build generó el helper. El CorrelationContext solo
  // existe con capa api o messaging, y entonces también se comprueba que cruza.
  const fqnOf = (file) => `${/package\s+([\w.]+);/.exec(fs.readFileSync(file, 'utf8'))[1]}.${path.basename(file, '.java')}`;
  const executors = byName(`${path.sep}ContextPropagatingExecutors.java`)[0];
  if (executors) {
    spec.subsystems.push('context');
    spec.executorsFqn = fqnOf(executors);
    const correlation = byName(`${path.sep}CorrelationContext.java`)[0];
    if (correlation) spec.correlationFqn = fqnOf(correlation);
  }

  const cacheConfig = byName('CacheConfig.java')[0];
  if (cacheConfig) {
    spec.subsystems.push('cache');
    const source = fs.readFileSync(cacheConfig, 'utf8');
    const constant = /public static final String (\w+)\s*=/.exec(source);
    if (!constant) throw new Error('CacheConfig no declara ninguna constante de caché');
    spec.cacheConstantRef = `${/package\s+([\w.]+);/.exec(source)[1]}.CacheConfig.${constant[1]}`;
  }

  spec.imports = [];
  spec.fields = '';
  if (spec.subsystems.includes('pool')) {
    if (spec.persistenceKind === 'relational') {
      spec.imports.push('javax.sql.DataSource');
      spec.fields += '\n\n    @Autowired\n    private DataSource dataSource;';
    } else {
      spec.imports.push('org.springframework.data.mongodb.core.MongoTemplate');
      spec.fields += '\n\n    @Autowired\n    private MongoTemplate mongoTemplate;';
    }
  }
  if (spec.subsystems.includes('consumerLag')) {
    // La factoría DE LA APLICACIÓN: es la que lleva puesto el listener de Micrometer, y por eso
    // el caso mide el contexto generado y no a Kafka.
    spec.imports.push('org.springframework.kafka.core.ConsumerFactory');
    spec.fields += '\n\n    @Autowired\n    private ConsumerFactory<?, ?> consumerFactory;';
  }
  if (spec.subsystems.includes('storage')) {
    spec.imports.push(`${basePackage}.domain.storage.FileStorage`);
    spec.fields += '\n\n    @Autowired\n    private FileStorage fileStorage;';
  }
  if (spec.subsystems.includes('mail')) {
    spec.imports.push(`${basePackage}.application.port.out.MailSender`, `${basePackage}.domain.mail.MailMessage`);
    spec.fields += '\n\n    @Autowired\n    private MailSender mailSender;';
  }
  if (spec.subsystems.includes('cache')) {
    spec.imports.push('org.springframework.cache.Cache', 'org.springframework.cache.CacheManager');
    spec.fields += '\n\n    @Autowired\n    private CacheManager cacheManager;';
  }
  spec.imports.sort();
  return spec;
}

function writeProbes(projectDir, spec) {
  const dir = path.join(projectDir, 'src', 'test', 'java', ...spec.basePackage.split('.'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${PROBE_CLASS}.java`), probeClass(spec), 'utf8');
  fs.writeFileSync(path.join(dir, `${DOWN_CLASS}.java`), downClass(spec), 'utf8');
  if (spec.subsystems.includes('storage')) {
    fs.writeFileSync(path.join(dir, `${DOUBLES_CLASS}.java`), doublesClass(spec), 'utf8');
    fs.writeFileSync(path.join(dir, `${SWITCH_CLASS}.java`), switchClass(spec), 'utf8');
  }
}

// ─── Espera de la infraestructura ────────────────────────────────────────────
//
// Los puertos publicados salen del compose que build acaba de emitir, no de una lista: con una
// lista, un servicio nuevo del stack se quedaría sin esperar y la sonda fallaría por conexión
// rechazada, que es un rojo que no habla de telemetría.

function publishedPorts(projectDir) {
  const compose = fs.readFileSync(path.join(projectDir, 'infra', 'docker-compose.yaml'), 'utf8');
  const ports = new Set();
  for (const match of compose.matchAll(/^\s*-\s*["']?(\d+):\d+["']?\s*$/gm)) ports.add(Number(match[1]));
  return [...ports].sort((a, b) => a - b);
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function waitForInfra(ports, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  const pending = new Set(ports);
  while (Date.now() < deadline && pending.size > 0) {
    for (const port of [...pending]) {
      if (await tcpOpen(port)) pending.delete(port);
    }
    if (pending.size === 0) return { ok: true, pending: [] };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: pending.size === 0, pending: [...pending] };
}

// ─── Ejecución de la sonda y lectura del veredicto ───────────────────────────

/**
 * Gradle se invoca por el wrapper de SHELL (`sh gradlew`), igual que compile-check, y no por el
 * `.bat`: Node no sabe lanzar un `.bat` sin `shell: true` y falla con EINVAL, que llega como una
 * salida vacía y no dice nada de lo que se estaba midiendo.
 */
function runProbe(projectDir, spec) {
  // DOWN_CLASS va siempre: el colector caído no depende de ningún subsistema del diseño.
  const classes = [PROBE_CLASS, DOWN_CLASS, ...(spec.subsystems.includes('storage') ? [SWITCH_CLASS] : [])];
  const testArgs = classes.flatMap((name) => ['--tests', `${spec.basePackage}.${name}`]);
  return run('sh', ['gradlew', 'test', ...testArgs, '--console=plain', '--no-daemon'], { cwd: projectDir });
}

/**
 * La matriz sale del XML de JUnit y de la lista de casos, cruzadas por el ID.
 *
 * <p>Se cruza por el id y no por el nombre del método porque el `name` del XML es el
 * `@DisplayName` —que empieza por el id justo para esto—, no la firma. Un caso declarado que el
 * XML no trae es ROJO y se dice con esas palabras: «no lo ejecutó nadie» y «pasó» son dos cosas
 * distintas, y confundirlas es la forma más barata de tener un check que no mide nada.
 */
function readResults(projectDir, spec) {
  const dir = path.join(projectDir, 'build', 'test-results', 'test');
  if (!fs.existsSync(dir)) return null;
  const executed = new Map();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.xml'))) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    // El cuantificador va PEREZOSO y la etiqueta de apertura se captura entera. Con `[^>]*`
    // codicioso, un `<testcase … />` autocerrado deja que la clase de caracteres se coma la barra,
    // la alternativa casa el `>` y el cuerpo se traga los testcase SIGUIENTES: el que pasó heredaba
    // el fallo del de más abajo y los tragados salían como «no llegó a ejecutarse». Salió en la
    // primera pasada y es el defecto que más se parece a un resultado legítimo.
    for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = /\sname="([^"]+)"/.exec(match[1]);
      if (!name) continue;
      const body = match[3] ?? '';
      const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(body);
      const id = decode(name[1]).split(' ')[0];
      executed.set(id, failure ? decode(failure[2]).split('\n')[0].slice(0, 300) : null);
    }
  }
  const applicable = CASES.filter((item) => !item.subsystem || spec.subsystems.includes(item.subsystem));
  return applicable.map((item) => {
    if (!executed.has(item.id)) {
      return { id: item.id, title: item.title, ok: false, detail: 'el caso no llegó a ejecutarse' };
    }
    const detail = executed.get(item.id);
    return { id: item.id, title: item.title, ok: detail === null, detail: detail ?? '' };
  });
}

function decode(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#10;', '\n')
    .replaceAll('&amp;', '&');
}

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

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

// Con --keep el temporal NO puede colgar de tmpDir(): esa raíz se borra al salir el proceso, que
// es justo lo que --keep quiere evitar. Misma salida que usa claim-check.
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-telemetry-keep-')) : tmpDir('keel-telemetry-check-');
let frontend = null;
let projectDir = null;
let results = [];
let fatal = null;

try {
  // El stack se resuelve UNA vez y se pasa tal cual: así el árbol generado y la sonda hablan del
  // mismo broker y del mismo motor, sin que ninguno de los dos vuelva a aplicar defaults.
  const stack = resolveStack({ telemetry: 'otel' }, service.layers, service.manifest);
  scaffoldService({
    manifest: service.manifest,
    layers: service.layers,
    workspace,
    force: true,
    stack
  });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  projectDir = path.join(workspace, 'services', projectName);

  const spec = readProjectSpec(projectDir, stack);
  console.log(`sonda sobre ${fixture}: subsistemas ${spec.subsystems.join(', ') || '(ninguno)'}`);
  writeProbes(projectDir, spec);

  process.stdout.write('levantando la infraestructura… ');
  const up = composeUp(runtimeInfo.frontends, projectDir);
  if (!up.frontend) {
    console.error(`\nno levanta:\n${up.log}`);
    process.exit(2);
  }
  frontend = up.frontend;
  console.log(`OK (${up.frontend.command})`);

  const ports = publishedPorts(projectDir);
  process.stdout.write(`esperando ${ports.length} puerto(s)… `);
  const ready = await waitForInfra(ports);
  if (!ready.ok) {
    console.log('KO');
    fatal = `la infraestructura no aceptó conexiones en ${ready.pending.join(', ')}`;
  } else {
    console.log('OK');
    process.stdout.write('arrancando la aplicación y midiendo… ');
    const probe = runProbe(projectDir, spec);
    results = readResults(projectDir, spec) ?? [];
    if (results.length === 0) {
      console.log('KO');
      fatal = 'la sonda no dejó resultados de JUnit: la aplicación no llegó a arrancar';
      console.error((probe.stderr || probe.stdout).trim().split('\n').slice(-25).join('\n'));
    } else {
      console.log('hecho');
      for (const result of results) {
        console.log(`  ${result.ok ? 'OK  ' : 'KO  '} ${result.id} ${result.title}${result.ok ? '' : ` — ${result.detail}`}`);
      }
    }
  }
} finally {
  if (frontend && projectDir && !keep) composeDown(frontend, projectDir);
  if (keep && projectDir) console.log(`  (--keep) proyecto en ${projectDir}`);
}

console.log('\nMatriz de escenarios');
for (const result of results) console.log(`  ${result.id}  ${result.ok ? 'OK' : 'KO'}  ${result.title}`);

fs.writeFileSync(
  path.join(process.cwd(), 'telemetry-check.json'),
  JSON.stringify({ ...verdictStamp(), fixture, results, fatal }, null, 2),
  'utf8'
);

if (fatal) process.exit(2);
process.exit(results.some((result) => !result.ok) ? 1 : 0);
