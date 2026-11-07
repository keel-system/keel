#!/usr/bin/env node
// EJECUTA la escritura condicional (DSL 2.25, api.concurrency) que emite keel-spring: los casos CW-1 a CW-11 de
// keel-core/gen/conditional-writes.js, con los mismos ids que ejecutan keel-dotnet, keel-nest y keel-go, sobre los MISMOS
// diseños (keel-core/test/helpers/conditional-write-designs.js).
//
// Por qué existe: keel-spring no emite pruebas de la API, y lo que se mide aquí compila diga lo que diga — una
// comparación que acepta cualquier versión, un save que devuelve la versión de antes del flush (T1: el ETag va un número
// por detrás y la siguiente edición encadenada da 412 sin conflicto), un 428 que llega después del 400, un ETag que CORS
// no deja leer. Dos clases JUnit dentro del proyecto generado (src/lib/precondition-probes.js): el ADAPTADOR contra el
// motor real de infra/ (CW-1 a CW-5) y el BORDE sin base (CW-6 a CW-11). CW-12, el gate, lo ejecuta
// test/conditional-writes.test.js con bash.
//
//   node packages/keel-spring/scripts/precondition-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run precondition-check --workspace packages/keel-spring
//
// Diseños: catalog-conditional (relacional), catalog-conditional-mongo (documental) y shop-conditional (seguridad,
// CORS e id de texto). Necesita podman o docker, y JDK.
//
// Los diseños de catalog-extended declaran una réplica, y con ella el `main` no compila recién generado (el projector
// llama a métodos del agente, src/lib/main-compilable.js): aquí el precio del proveedor se pide en el momento, como en
// la silueta documental de keel-go. No toca nada de la escritura condicional.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando) y su caso tiene que salir en rojo: son los
// de CW_SABOTAGES de keel-core, salvo cw-gate, que mide test/conditional-writes.test.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { ADAPTER_CLASS, EDGE_CLASS, PACKAGE_LEAF, adapterTestClass, conditionalRoots, edgeTestClass, namedTypes } from '../src/lib/precondition-probes.js';
import { conditionalWriteCases } from '@keel-system/keel-core/gen/api-cases';
import { CONDITIONAL_WRITE_DESIGNS } from '../../keel-core/test/helpers/conditional-write-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-conditional';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// [archivo (sufijo), texto o expresión, sustituto]. Todos compilan: lo que se mide es la sonda, no javac.
const SABOTAGES = {
  // El adaptador no compara.
  'cw-ignore-expected': ['{root}RepositoryImpl.java', 'if (found.isEmpty() || expectedVersions == null) {', 'if (found.isEmpty() || expectedVersions == null || true) {'],
  // save devuelve, en una actualización, el agregado que recibió: con la versión que cargó (un alta sigue igual).
  'cw-stale-version': ['{root}RepositoryImpl.java', /(public \w+ save\(\w+ entity\) \{[\s\S]*?)return saved;/, '$1return entity.getLockVersion() != null ? entity : saved;'],
  // El conflicto de la ventana sale como 412.
  'cw-collapse-409': [
    '{root}RepositoryImpl.java',
    /public (\w+) save\((\w+) entity\) \{/,
    'public $1 save($2 entity) {\n        try {\n            return saveUnchecked(entity);\n        } catch (org.springframework.dao.OptimisticLockingFailureException conflict) {\n            throw new PreconditionFailedException();\n        }\n    }\n\n    private $1 saveUnchecked($2 entity) {'
  ],
  // El borde no exige la cabecera.
  'cw-no-428': ['IfMatchInterceptor.java', '&& ConditionalRequests.absent(', '&& false && ConditionalRequests.absent('],
  // La comparación acepta W/.
  'cw-weak-match': ['ConditionalRequests.java', 'Pattern.compile("^\\"', 'Pattern.compile("^(?:W/)?\\"'],
  // La precondición sale como 409.
  'cw-error-map': ['PreconditionFailedException.java', 'STATUS = 412;', 'STATUS = 409;'],
  // ETag no se expone.
  'cw-cors': ['CorsConfig.java', /EXPOSED_HEADERS = List\.of\((.*?)(, )?"ETag"\);/, 'EXPOSED_HEADERS = List.of($1);'],
  // La caché guarda solo el cuerpo.
  'cw-cache-etag': ['RedisOperationCache.java', 'store.put(key, mapper.writeValueAsString(value));', 'store.put(key, mapper.writeValueAsString(value instanceof Versioned<?> versioned ? versioned.value() : value));']
};
// Lo que el sabotaje de la caché nombra: el import de Versioned en el adaptador de la caché.
const EXTRA_IMPORTS = { 'cw-cache-etag': ['RedisOperationCache.java', 'application.interfaces.Versioned'] };

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function resolveRuntime() {
  const preferred = process.env.CONTAINER_RUNTIME;
  for (const runtime of preferred ? [preferred] : ['docker', 'podman']) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends = runtime === 'podman' ? [{ command: 'podman', prefix: ['compose'] }, { command: 'podman-compose', prefix: [] }] : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'db'], { cwd: projectDir });
    if (result.status === 0) return frontend;
  }
  return null;
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

/** Busca la clase en el árbol generado y devuelve su archivo y su paquete, leído de su propia cabecera. */
function classOf(projectDir, className) {
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === `${className}.java`);
  if (!file) throw new Error(`precondition-check: no encuentro ${className}.java en el proyecto generado`);
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, pkg: /^package\s+([\w.]+);/m.exec(text)[1] };
}

function readResults(projectDir, className) {
  const dir = path.join(projectDir, 'build/test-results/test');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((name) => name.includes(className) && name.endsWith('.xml'));
  if (!file) return [];
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  const cases = [];
  const re = /<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(match[3] ?? '');
    cases.push({ name: match[1].replace(/\(\)$/, ''), ok: !failure, detail: failure ? failure[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').slice(0, 300) : '' });
  }
  return cases;
}

const design = CONDITIONAL_WRITE_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño '${designName}'. Los hay: ${CONDITIONAL_WRITE_DESIGNS.map((candidate) => candidate.name).join(', ')}.`);
  process.exit(2);
}
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')} (cw-gate, en test/conditional-writes.test.js).`);
  process.exit(2);
}
const runtime = resolveRuntime();
if (!runtime) {
  console.error('No hay docker ni podman en el PATH.');
  process.exit(2);
}
if (run('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH.');
  process.exit(2);
}

const service = loadService(path.join(fixturesDir, design.from));
design.mutate(service.layers);
// La réplica deja el main sin compilar recién generado: el precio, en el momento (ver la cabecera).
const supplierPrice = service.layers.dependencies?.dependencies?.pricing?.needs?.supplierPrice;
if (supplierPrice?.strategy === 'replicated') {
  delete supplierPrice.replica;
  supplierPrice.strategy = 'on-demand';
}
const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
const engine = document ? 'mongodb' : database;
const model = buildModel({ manifest: service.manifest, layers: service.layers, stack: { database: engine } });
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-precondition-keep-')) : tmpDir('keel-precondition-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database: engine } });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

if (sabotage) {
  const [pattern, from, to] = SABOTAGES[sabotage];
  // Los del adaptador, solo en el de las raíces que carga una escritura condicional: los demás no importan su excepción.
  const suffixes = pattern.includes('{root}') ? conditionalRoots(model).map((root) => `${path.sep}${pattern.replace('{root}', root.name)}`) : [pattern];
  let applied = 0;
  for (const file of walk(path.join(projectDir, 'src/main/java')).filter((candidate) => suffixes.some((suffix) => candidate.endsWith(suffix)))) {
    const text = fs.readFileSync(file, 'utf8');
    let changed = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
    if (changed !== text && EXTRA_IMPORTS[sabotage]) {
      const fqn = `${model.service.basePackage}.${EXTRA_IMPORTS[sabotage][1]}`;
      changed = changed.replace(/^(package [\w.]+;\n)/m, `$1\nimport ${fqn};\n`);
    }
    if (changed !== text) {
      fs.writeFileSync(file, changed);
      applied += 1;
    }
  }
  if (applied === 0) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy para ${designName} (¿cambió el texto, o este diseño no tiene la pieza?).`);
    process.exit(2);
  }
  console.log(`(sabotaje: ${sabotage})`);
}

const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
const datasource = document ? { uri: db?.spring?.mongodb?.uri } : (db?.spring?.datasource ?? {});
if (document && !datasource.uri) throw new Error('el db.yaml generado no trae spring.mongodb.uri: ¿cambió la clave de la conexión?');
const anyRoot = conditionalRoots(model)[0].name;
const pkgOf = (name) => classOf(projectDir, name).pkg;
const packages = {
  port: pkgOf(`${anyRoot}Repository`),
  adapters: pkgOf(`${anyRoot}RepositoryImpl`),
  errors: pkgOf('PreconditionFailedException'),
  rest: pkgOf('ConditionalRequests'),
  interfaces: pkgOf('Versioned'),
  types: Object.fromEntries(namedTypes(model).map((name) => [name, pkgOf(name)]))
};
// Paquetes que solo existen con su pieza.
const optional = (name) => {
  try {
    return pkgOf(name);
  } catch {
    return null;
  }
};
packages.security = optional('CorsConfig');
packages.cache = optional('RedisOperationCache');
packages.support = optional('CachedOperations');
packages.dtos = optional('PagedResponse') ?? `${model.service.basePackage}.application.dtos`;

// El controller de la escritura de CW-6, con los tipos de su constructor para doblarlos.
let controller = null;
const write = conditionalWriteCases(model)?.write;
if (write) {
  const operation = model.services.flatMap((group) => group.operations.map((op) => ({ group, op }))).find(({ op }) => op.name === write.operation);
  const found = classOf(projectDir, operation.group.controllerClass);
  const ctor = new RegExp(`public ${operation.group.controllerClass}\\(([^)]*)\\)`).exec(found.text);
  const params = ctor[1].split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).map((type) => ({ type, fqn: `${pkgOf(type)}.${type}` }));
  controller = { name: operation.group.controllerClass, pkg: found.pkg, params };
}

// Lo que el adaptador pide y la rebanada de Spring Data no trae: sus colaboradores del proyecto, y con la tienda del
// reclamo de reconciliación su paquete entero (su escritor es package-private); en documental, la configuración de transacciones.
const collaborators = [];
for (const entity of conditionalRoots(model)) {
  const impl = classOf(projectDir, `${entity.name}RepositoryImpl`);
  const ctor = new RegExp(`public ${entity.name}RepositoryImpl\\(([^)]*)\\)`).exec(impl.text);
  const types = ctor[1].split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
  if (document) types.push('MongoTransactionConfig');
  // Con autoría, el AuditorAware: sin él la rebanada deja created_by a null y la columna es NOT NULL.
  types.push('AuditorAwareConfig');
  for (const type of types) {
    const pkg = optional(type);
    if (pkg && !type.endsWith('JpaRepository') && !type.endsWith('MongoRepository') && !collaborators.some((c) => c.type === type)) collaborators.push({ type, fqn: `${pkg}.${type}` });
  }
}

const testDir = path.join(projectDir, 'src/test/java', ...model.service.basePackage.split('.'), PACKAGE_LEAF);
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(path.join(testDir, `${ADAPTER_CLASS}.java`), adapterTestClass(model, { packages, document, datasource, collaborators }), 'utf8');
fs.writeFileSync(path.join(testDir, `${EDGE_CLASS}.java`), edgeTestClass(model, { packages, controller }), 'utf8');

console.log(`precondition-check · ${designName} (${engine}) · ${runtime.runtime}`);
const frontend = composeUp(runtime.frontends, projectDir);
if (!frontend) {
  console.error('No se pudo levantar la base de infra/.');
  process.exit(2);
}
let exitCode = 2;
try {
  const probe = databaseHealthProbe(engine, model.service.name.replaceAll('-', '_'));
  const deadline = Date.now() + probe.budgetSeconds * 1000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = run(runtime.runtime, ['exec', `${service.manifest.service.name}-db`, ...probe.argv]).status === 0;
    if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
  }
  if (!ready) {
    console.error('El motor no aceptó conexiones a tiempo.');
  } else {
    const gradle = run('sh', ['gradlew', 'test', '--tests', `*.${PACKAGE_LEAF}.*`, '--console=plain', '--no-daemon'], { cwd: projectDir });
    const cases = [...readResults(projectDir, ADAPTER_CLASS), ...readResults(projectDir, EDGE_CLASS)];
    if (cases.length === 0) {
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-60).join('\n'));
    } else {
      for (const item of cases) console.log(`  ${item.ok ? 'OK  ' : 'KO  '} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
      const failed = cases.filter((item) => !item.ok).length;
      console.log(`\n  ${cases.length - failed}/${cases.length} en verde`);
      exitCode = failed > 0 ? 1 : 0;
    }
  }
} finally {
  if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir} y la base en pie.`);
  else run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}
process.exit(exitCode);
