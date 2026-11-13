#!/usr/bin/env node
// EJECUTA el historial de cambios (DSL 2.29: `audit.history` y la query de `output: { history }`) que emite keel-spring:
// los casos HI-1 a HI-10 de keel-core/gen/history.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go,
// sobre los MISMOS diseños (keel-core/test/helpers/history-designs.js). HI-11 (logs y spans) lo mide telemetry-check.
//
// Por qué existe: todo lo que se mide aquí compila diga lo que diga — una entrada que sobrevive al rollback, un diff que
// lo lista todo, un secreto que acaba en otra tabla, un autor que siempre es `system`, una página que desempata al revés,
// el historial de una raíz ajena o borrada, un valor personal que sobrevive a su retención. Ninguno rompe un arranque ni
// un escenario feliz.
//
//   node packages/keel-spring/scripts/history-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run history-check --workspace packages/keel-spring
//
// Diseños: cards-history y cards-history-mongo (la ficha con borrado lógico, restauración y purga), cards-history-anonymize
// (la retención que anonimiza) y vault-history-scoped[-mongo] (un agregado con hijas y su lectura acotada). Necesita
// podman o docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE sus
// casos de HISTORY_SABOTAGES que este diseño ejecuta (casesOf): ni uno más ni uno menos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { HISTORY_SABOTAGES } from '@keel-system/keel-core/gen/history';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { conexionPerezosa } from '../src/lib/claim-probes.js';
import { CLASS_NAME, PACKAGE_LEAF, casesOf, historyTestClass, namedTypes, probedRoots, retentionTimers, wipedEntities } from '../src/lib/history-probes.js';
import { HISTORY_DESIGNS } from '../../keel-core/test/helpers/history-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'cards-history';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

const REQUIRES_NEW = '@org.springframework.transaction.annotation.Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)\n    ';

/**
 * Cada sabotaje: `[archivo (sufijo bajo src/main), texto o expresión, sustituto]`. Todos compilan: lo que se mide es la
 * sonda, no javac. `(model) => [...]` cuando depende del diseño.
 */
const SABOTAGES = {
  // La entrada se escribe en su PROPIA transacción: una escritura que revierte la deja igual.
  'hi-outside-tx': [
    ['JdbcChangeHistory.java', '    @Override\n    public void record(', `    @Override\n    ${REQUIRES_NEW}public void record(`],
    ['MongoChangeHistory.java', '    @Override\n    public void record(', `    @Override\n    ${REQUIRES_NEW}public void record(`]
  ],
  // El diff no compara con lo que había: cada guardado registra el agregado entero.
  'hi-full-snapshot': [['RepositoryImpl.java', 'HistoryDiff.diff(before, historySnapshot(saved))', 'HistoryDiff.diff(null, historySnapshot(saved))']],
  // El id (generated) entra en la instantánea.
  'hi-sensitive': (model) =>
    probedRoots(model).map(({ entity }) => {
      const getter = `get${entity.idField.name[0].toUpperCase()}${entity.idField.name.slice(1)}()`;
      return [`${entity.name}RepositoryImpl.java`, '        Map<String, JsonNode> snapshot = new TreeMap<>();\n', `        Map<String, JsonNode> snapshot = new TreeMap<>();\n        snapshot.put("${entity.idField.name}", changeHistory.value(entity.${getter}));\n`];
    }),
  // El autor no se lee del actor de la petición.
  'hi-author': [
    ['JdbcChangeHistory.java', 'auditor.getCurrentAuditor().orElse("system")', '"system"'],
    ['MongoChangeHistory.java', 'auditor.getCurrentAuditor().orElse("system")', '"system"']
  ],
  // A igual instante, el id menor primero.
  'hi-order': [
    ['JdbcChangeHistory.java', ', h.id DESC', ', h.id ASC'],
    ['MongoChangeHistory.java', 'Sort.Order.desc("_id")', 'Sort.Order.asc("_id")']
  ],
  // El historial se lee con la carga del almacén, sin la vida ni el alcance de la ficha.
  'hi-unscoped': (model) =>
    probedRoots(model).map(({ entity }) => {
      const store = model.persistenceKind === 'document' ? `${entity.name}MongoRepository` : `${entity.name}JpaRepository`;
      const field = `${store[0].toLowerCase()}${store.slice(1)}`;
      return [`${entity.name}RepositoryImpl.java`, /return (?:findById|loadScoped)\((\w+)(?:, scope)?\)\n(\s+)\.map\(root -> changeHistory/g, `return ${field}.findById($1).map(this::toDomain)\n$2.map(root -> changeHistory`];
    }),
  // La anonimización se deja el historial.
  'hi-anonymize-miss': [['Retention.java', /\n\s*\/\/ El historial de la raíz sigue su régimen[^\n]*\n\s*changeHistory\.anonymize\([^\n]*;/, '']],
  // La purga de lo borrado se deja el historial.
  'hi-purge-miss': [['Retention.java', /\n\s*\/\/ El historial de la raíz sigue su régimen[^\n]*\n\s*changeHistory\.purge\([^\n]*;/, '']]
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
  if (!file) throw new Error(`history-check: no encuentro ${className}.java en el proyecto generado`);
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

/** El caso de una prueba por su prefijo: `hi10_ContactCard_…` → HI-10. */
const caseOf = (testName) => {
  const match = /^hi(\d+)_/.exec(testName);
  return match ? `HI-${match[1]}` : '?';
};

const design = HISTORY_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño del historial '${designName}'. Los hay: ${HISTORY_DESIGNS.map((d) => d.name).join(', ')}.`);
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
// Lo que se mide aquí: HI-11 es de telemetry-check.
const measured = new Set(cases);
let expected = null;
if (sabotage) {
  expected = (HISTORY_SABOTAGES[sabotage] ?? []).filter((id) => measured.has(id));
  if (expected.length === 0) {
    console.error(`El sabotaje '${sabotage}' cae en ${(HISTORY_SABOTAGES[sabotage] ?? []).join(', ')}, y ${designName} no ejecuta ninguno (ejecuta ${cases.join(', ')}).`);
    process.exit(2);
  }
}
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-history-keep-')) : tmpDir('keel-history-check-');
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
const timers = retentionTimers(model);
const packages = {
  port: pkgOf(`${anyRoot}Repository`),
  adapters: pkgOf(`${anyRoot}${document ? 'MongoRepository' : 'JpaRepository'}`),
  mirrors: pkgOf(`${anyRoot}${document ? 'Document' : 'Jpa'}`),
  history: pkgOf('ChangeHistory'),
  timer: timers.length > 0 ? pkgOf(timers[0]) : null,
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
fs.writeFileSync(path.join(testDir, `${CLASS_NAME}.java`), historyTestClass(model, { packages, document, engine, properties, doubles }), 'utf8');
const classes = [CLASS_NAME];

console.log(`history-check · ${designName} (${engine}) · ${runtime.runtime} · casos ${cases.join(', ')}`);
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
