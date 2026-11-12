#!/usr/bin/env node
// EJECUTA el ciclo de vida del dato (DSL 2.28: `deletion: logical`, `restorableFor`/`restores`, `retention` y `personal`)
// que emite keel-spring: los casos LC-*, RT-1, RT-2, RT-4 y PD-2 de keel-core/gen/data-lifecycle.js, con los mismos ids
// que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los MISMOS diseños (keel-core/test/helpers/data-lifecycle-designs.js).
// RT-3 (dos réplicas, un barrido) lo mide store-check y PD-3 (el colector) telemetry-check.
//
// Por qué existe: todo lo que se mide aquí compila diga lo que diga — un listado que devuelve la fila borrada, un total
// que la cuenta, una carga por clave que la encuentra, un índice único que no libera la clave, una ventana que no se
// comprueba, un barrido que se adelanta o que se deja un campo personal sin vaciar, el valor del email en el log. Ninguno
// de esos fallos rompe un arranque ni un escenario feliz.
//
//   node packages/keel-spring/scripts/lifecycle-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run lifecycle-check --workspace packages/keel-spring
//
// Diseños: cards-logical y cards-logical-mongo (borrado lógico, restauración, retención desde el borrado, email personal
// y único), codes-anonymize y codes-anonymize-mongo (retención con anonymize), codes-delete (retención con delete) y
// vault-logical-scoped (la vida compuesta con la lectura acotada y la lectura por referencia). Necesita podman o docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE sus
// casos de DATA_LIFECYCLE_SABOTAGES que este diseño ejecuta (casesOf): ni uno más ni uno menos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { DATA_LIFECYCLE_SABOTAGES } from '@keel-system/keel-core/gen/data-lifecycle';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { conexionPerezosa } from '../src/lib/claim-probes.js';
import {
  CLASS_NAME, PACKAGE_LEAF, REPLICA_CLASS, casesOf, lifecycleTestClass, namedTypes, probedRoots, retentionClasses, retentionReplicaTestClass,
  usesRetentionReplica, wipedEntities
} from '../src/lib/lifecycle-probes.js';
import { timerStatements } from '@keel-system/keel-core/gen/timer-store';
import { DATA_LIFECYCLE_DESIGNS } from '../../keel-core/test/helpers/data-lifecycle-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'cards-logical';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

/**
 * Cada sabotaje: `[archivo (sufijo bajo src/main), texto o expresión, sustituto]`. Todos compilan: lo que se mide es la
 * sonda, no javac. `(model) => [...]` cuando depende del diseño.
 */
const SABOTAGES = {
  // El listado entero y los finders no dejan fuera lo borrado: las filas y el total.
  'lc-no-filter': [
    ['RepositoryImpl.java', '.findAllByDeletedAtIsNull(withStableOrder(pageable))', '.findAll(withStableOrder(pageable))'],
    ['RepositoryImpl.java', '            where.add(cb.isNull(root.get("deletedAt")));\n', ''],
    ['RepositoryImpl.java', '        where.add(Criteria.where("deletedAt").is(null));\n', '']
  ],
  // El total cuenta todas las filas; las de la página siguen siendo las vivas.
  'lc-count': [
    [
      'RepositoryImpl.java',
      /return (\w+)\.findAllByDeletedAtIsNull\(withStableOrder\(pageable\)\)\.map\(this::toDomain\);/g,
      'return new org.springframework.data.domain.PageImpl<>($1.findAllByDeletedAtIsNull(withStableOrder(pageable)).getContent().stream().map(this::toDomain).toList(), withStableOrder(pageable), $1.count());'
    ],
    [
      'RepositoryImpl.java',
      /return (\w+)\.findAll\(specification, withStableOrder\(pageable\)\)\.map\(this::toDomain\);/g,
      'return new org.springframework.data.domain.PageImpl<>($1.findAll(specification, withStableOrder(pageable)).getContent().stream().map(this::toDomain).toList(), withStableOrder(pageable), $1.count());'
    ],
    ['RepositoryImpl.java', /long total = mongoTemplate\.count\(query, (\w+)\.class\);/g, 'long total = mongoTemplate.count(new Query(), $1.class);']
  ],
  // Las cargas de una fila (por id y por clave) no dejan fuera lo borrado: la del id pasa al findById heredado, y las de
  // una clave cambian el sufijo por una condición sobre el id que siempre se cumple. No `findByIdAndIdIsNotNull`: en
  // MongoDB dos criterios sobre la misma clave revientan en ejecución, y el sabotaje rompería mucho más que la carga.
  'lc-get-leak': (model) =>
    probedRoots(model)
      .filter(({ root }) => root.logical)
      .flatMap(({ entity }) => {
        const idCond = `And${entity.idField.name[0].toUpperCase()}${entity.idField.name.slice(1)}IsNotNull(`;
        return [
          [`${entity.name}RepositoryImpl.java`, `.findById${'AndDeletedAtIsNull'}(${entity.idField.name}).map(this::toDomain)`, `.findById(${entity.idField.name}).map(this::toDomain)`],
          ...['JpaRepository.java', 'MongoRepository.java', 'RepositoryImpl.java'].map((suffix) => [
            `${entity.name}${suffix}`,
            /(find\w*By(?!Id)\w+?)AndDeletedAtIsNull\(/g,
            `$1${idCond}`
          ])
        ];
      }),
  // Los índices únicos cuentan también las filas borradas.
  'lc-unique-all-rows': [
    ['partial-indexes.sql', /[`"]?deleted_at[`"]? IS NULL/g, '1 = 1'],
    ['MongoIndexConfig.java', /\.partial\(PartialIndexFilter\.of\(Criteria\.where\("deletedAt"\)\.is\(null\)\)\)/g, ''],
    ['MongoIndexConfig.java', '.and("deletedAt").is(null)', '']
  ],
  // La ventana de la restauración no se comprueba.
  'lc-restore-window': [['RepositoryImpl.java', ')).isAfter(Instant.now())) {', ')).isAfter(Instant.EPOCH)) {']],
  // La lectura por referencia deja fuera lo borrado.
  'lc-embed-hidden': (model) =>
    probedRoots(model)
      .filter(({ root, batch }) => root.logical && batch)
      .map(({ entity }) => [`${entity.name}RepositoryImpl.java`, '.findAllById(ids).stream()', '.findAllById(ids).stream().filter(row -> row.getDeletedAt() == null)']),
  // El predicado de vida SUSTITUYE a los demás en vez de sumarse.
  'lc-implicit-replace': [
    ['RepositoryImpl.java', '            where.add(cb.isNull(root.get("deletedAt")));', '            where.clear();\n            where.add(cb.isNull(root.get("deletedAt")));'],
    ['RepositoryImpl.java', '        where.add(Criteria.where("deletedAt").is(null));', '        where.clear();\n        where.add(Criteria.where("deletedAt").is(null));']
  ],
  // El corte se adelanta: vence lo que aún está dentro de la retención.
  'rt-early': [['RetentionTimer.java', 'Instant cutoff = now.minus(', 'Instant cutoff = now.plus(']],
  // La anonimización se deja un campo personal obligatorio.
  'rt-anonymize-miss': [['Retention.java', /\n\s*(row|document)\.set\w+\("anon-" \+ \w+\);/, '']],
  // Cada réplica arbitra con su propia fila del cronómetro: el kind de la retención lleva un id por instancia, así que
  // las dos barren (la forma de timer-every-replica en store-check).
  'rt-every-replica': (model) =>
    probedRoots(model)
      .filter(({ root }) => root.retention)
      .flatMap(({ entity }) => {
        const constant = `RETENTION_${entity.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
        return [
          [`${entity.name}RetentionTimer.java`, `        return TimerKinds.${constant};`, `        return TimerKinds.${constant} + "@" + replica;`],
          [`${entity.name}RetentionTimer.java`, '    @Override\n    public String kind() {', '    private final String replica = java.util.UUID.randomUUID().toString();\n\n    @Override\n    public String kind() {']
        ];
      }),
  // El valor personal vuelve al log: la copia de Hibernate y el detalle del aspecto.
  'pd-log-value': [
    ['logging.yaml', /\n\s*# Hibernate 7 copia al log[^\n]*\n\s*org\.hibernate\.orm\.jdbc\.error: OFF/, ''],
    // El texto sustituto lleva sus propios dos puntos: el ternario se recorta hasta el getMessage(), no hasta el primero.
    ['LogExceptionsAspect.java', /String detail = exception instanceof DataAccessException[\s\S]*?:\s*exception\.getMessage\(\);/, 'String detail = exception.getMessage();']
  ]
};

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

function classOf(projectDir, className) {
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === `${className}.java`);
  if (!file) throw new Error(`lifecycle-check: no encuentro ${className}.java en el proyecto generado`);
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
    const skipped = /<skipped/.test(match[3] ?? '');
    cases.push({
      name: match[1].replace(/\(.*\)$/, ''),
      ok: !failure,
      skipped,
      detail: failure ? failure[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').slice(0, 300) : skipped ? 'saltado' : ''
    });
  }
  return cases;
}

/** El caso de una prueba por su prefijo: `lc10_Asset_…` → LC-10, `rt2_…` → RT-2, `pd2_…` → PD-2. */
const caseOf = (testName) => {
  const match = /^(lc|rt|pd)(\d+)_/.exec(testName);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : '?';
};

const design = DATA_LIFECYCLE_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño del ciclo de vida '${designName}'. Los hay: ${DATA_LIFECYCLE_DESIGNS.map((d) => d.name).join(', ')}.`);
  process.exit(2);
}
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
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
const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
const engine = document ? 'mongodb' : database;
const stack = { database: engine, ...(Object.values(service.layers['use-cases']?.operations ?? {}).some((op) => op.cache) ? { cache: 'redis' } : {}) };
const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
const cases = casesOf(model);
// Lo que se mide aquí: RT-3 es de store-check, PD-1 de un test unitario y PD-3 de telemetry-check.
const measured = new Set(cases);
let expected = null;
if (sabotage) {
  expected = (DATA_LIFECYCLE_SABOTAGES[sabotage] ?? []).filter((id) => measured.has(id));
  if (expected.length === 0) {
    console.error(`El sabotaje '${sabotage}' cae en ${(DATA_LIFECYCLE_SABOTAGES[sabotage] ?? []).join(', ')}, y ${designName} no ejecuta ninguno (ejecuta ${cases.join(', ')}).`);
    process.exit(2);
  }
}
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-lifecycle-keep-')) : tmpDir('keel-lifecycle-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

if (sabotage) {
  const entries = typeof SABOTAGES[sabotage] === 'function' ? SABOTAGES[sabotage](model) : SABOTAGES[sabotage];
  let applied = 0;
  for (const [suffix, from, to] of entries) {
    for (const file of walk(path.join(projectDir, 'src/main')).filter((candidate) => candidate.endsWith(suffix))) {
      const text = fs.readFileSync(file, 'utf8');
      const changed = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
      if (changed !== text) {
        fs.writeFileSync(file, changed);
        applied += 1;
      }
    }
  }
  if (applied === 0) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy para ${designName} (¿cambió el texto?).`);
    process.exit(2);
  }
  console.log(`(sabotaje: ${sabotage}; tiene que caer en ${expected.join(', ')})`);
}

const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
// En documental, sin el mongod EMBEBIDO del classpath de test (flapdoodle): la sonda mediría una base en memoria
// standalone, sin transacciones, como en timer-check.
const properties = document
  ? ['"spring.autoconfigure.exclude=de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration"']
  : conexionPerezosa(db?.spring?.datasource ?? {});
const pkgOf = (name) => classOf(projectDir, name).pkg;
const anyRoot = wipedEntities(model)[0];
const packages = {
  port: pkgOf(`${anyRoot}Repository`),
  adapters: pkgOf(`${anyRoot}${document ? 'MongoRepository' : 'JpaRepository'}`),
  mirrors: pkgOf(`${anyRoot}${document ? 'Document' : 'Jpa'}`),
  errors: pkgOf('DomainException'),
  annotations: pkgOf('LogExceptions'),
  logging: pkgOf('LogExceptionsAspect'),
  timer: retentionClasses(model).length > 0 ? pkgOf(retentionClasses(model)[1]) : null,
  types: Object.fromEntries(namedTypes(model).map((name) => [name, pkgOf(name)]))
};

// Los puertos que implementa el AGENTE (el almacenamiento, el envío al broker): sin ellos el contexto no arranca, y lo
// que mide la sonda no pasa por ellos. Una interfaz del proyecto sin implementación ni @Bean que alguien recibe por
// constructor se sustituye por un doble de Mockito; las que solo se reciben en una lista (TimerHandler) no.
function agentPorts(projectDir) {
  const sources = walk(path.join(projectDir, 'src/main/java')).filter((file) => file.endsWith('.java')).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const all = sources.map(({ text }) => text).join('\n');
  const ports = [];
  for (const { text } of sources) {
    const match = /^public interface (\w+)(?:<[^>]*>)?\s*(?:extends ([^{]+))?\{/m.exec(text);
    if (!match) continue;
    const name = match[1];
    if (/Repository</.test(match[2] ?? '') || /<[^>]*>/.test(match[0].split('interface')[1].split('{')[0].split('extends')[0])) continue;
    if (new RegExp(`implements\\s[^{]*\\b${name}\\b`).test(all) || new RegExp(`interface \\w+[^{]*extends\\s[^{]*\\b${name}\\b`).test(all)) continue;
    if (new RegExp(`public ${name} \\w+\\(`).test(all)) continue;
    if (!new RegExp(`[(,]\\s*${name}\\s+\\w+\\s*[,)]`).test(all)) continue;
    ports.push({ type: name, fqn: `${/^package\s+([\w.]+);/m.exec(text)[1]}.${name}` });
  }
  return ports;
}

const testDir = path.join(projectDir, 'src/test/java', ...model.service.basePackage.split('.'), PACKAGE_LEAF);
fs.mkdirSync(testDir, { recursive: true });
const doubles = agentPorts(projectDir);
if (doubles.length > 0) console.log(`  (dobles de los puertos del agente: ${doubles.map((port) => port.type).join(', ')})`);
fs.writeFileSync(path.join(testDir, `${CLASS_NAME}.java`), lifecycleTestClass(model, { packages, document, properties, doubles }), 'utf8');
const classes = [CLASS_NAME];
// RT-3 en el paquete del cronómetro: el constructor de pruebas del TimerPoller y su pollOnce son package-private.
if (usesRetentionReplica(model)) {
  const timerDir = path.join(projectDir, 'src/test/java', ...packages.timer.split('.'));
  fs.mkdirSync(timerDir, { recursive: true });
  const replicaPackages = { ...packages, retention: pkgOf(retentionClasses(model)[0]), operationCache: (() => { try { return pkgOf('OperationCache'); } catch { return null; } })() };
  const fire = document ? null : timerStatements(engine).fire;
  fs.writeFileSync(path.join(timerDir, `${REPLICA_CLASS}.java`), retentionReplicaTestClass(model, { packages: replicaPackages, document, properties, fire, doubles }), 'utf8');
  classes.push(REPLICA_CLASS);
}

console.log(`lifecycle-check · ${designName} (${engine}) · ${runtime.runtime} · casos ${cases.join(', ')}`);
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
    const gradle = run('sh', ['gradlew', 'test', ...classes.flatMap((className) => ['--tests', `*.${className}`]), '--console=plain', '--no-daemon'], { cwd: projectDir });
    const results = classes.flatMap((className) => readResults(projectDir, className));
    if (results.length === 0) {
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-60).join('\n'));
    } else {
      for (const item of results) console.log(`  ${item.skipped ? 'SALTA' : item.ok ? 'OK  ' : 'KO  '} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
      const fell = [...new Set(results.filter((item) => !item.ok).map((item) => caseOf(item.name)))].sort();
      const missing = cases.filter((id) => !results.some((item) => caseOf(item.name) === id && !item.skipped));
      if (sabotage) {
        const want = [...expected].sort();
        const exact = fell.length === want.length && fell.every((id, at) => id === want[at]);
        console.log(`\n  cayeron ${fell.join(', ') || 'ninguno'}; tenían que caer ${want.join(', ')} → ${exact ? 'VERDE (el sabotaje se ve, y solo en sus casos)' : 'ROJO'}`);
        exitCode = exact ? 0 : 1;
      } else {
        if (missing.length > 0) console.log(`\n  sin prueba (o saltada): ${missing.join(', ')}`);
        const failed = results.filter((item) => !item.ok).length;
        console.log(`\n  ${results.length - failed}/${results.length} en verde`);
        exitCode = failed > 0 || missing.length > 0 ? 1 : 0;
      }
    }
  }
} finally {
  if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir} y la base en pie.`);
  else run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}
process.exit(exitCode);
