#!/usr/bin/env node
// EJECUTA los lotes con resultado por elemento (DSL 2.30: `use-cases.<op>.batch`, modo `sync`) que emite keel-spring: los
// casos BA-* de keel-core/gen/batch.js, con los mismos ids que ejecutarán keel-nest, keel-dotnet y keel-go, sobre los
// MISMOS diseños (keel-core/test/helpers/batch-designs.js).
//
// Por qué existe: todo lo que se mide aquí compila diga lo que diga — un lote en una sola transacción, un elemento mal
// formado que tumba el lote entero con un 400, un fallo no declarado que el bucle se salta, un 200 cuando todo salió
// bien. Ninguno rompe un arranque ni el camino feliz de una petición suelta.
//
//   node packages/keel-spring/scripts/batch-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run batch-check --workspace packages/keel-spring
//
// Diseños: catalog-batch (relacional, per-item), catalog-batch-mongo (documental, per-item) y catalog-batch-atomic
// (relacional, all-or-nothing). Necesita podman o docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE sus
// casos de BATCH_SABOTAGES que este diseño ejecuta (casesOf): ni uno más ni uno menos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { BATCH_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { conexionPerezosa } from '../src/lib/claim-probes.js';
import { CLASS_NAME, PACKAGE_LEAF, batchOperations, batchTestClass, casesOf, probeHandler } from '../src/lib/batch-probes.js';
import { BATCH_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-batch';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

const PER_ITEM = 'public <T> ResponseEntity<BatchResponse> perItem(';

/** Cada sabotaje: `[archivo (sufijo bajo src/main), texto, sustituto]`. Todos compilan: lo que se mide es la sonda. */
const SABOTAGES = {
  // El lote entero en UNA transacción: el primer elemento que falla deja la de todos marcada para revertir.
  'ba-one-tx': [['BatchRunner.java', PER_ITEM, `@org.springframework.transaction.annotation.Transactional\n    ${PER_ITEM}`]],
  // Un elemento mal formado tumba el lote entero con un 400, como si el borde validara el DTO completo.
  'ba-validate-whole': [
    [
      'BatchRunner.java',
      'results.add(BatchResponse.Item.failed(index, VALIDATION_ERROR, invalid.getMessage()));\n                continue;',
      'throw new jakarta.validation.ConstraintViolationException(invalid.getMessage(), java.util.Set.of());'
    ]
  ],
  // Un fallo que no es de su elemento no detiene el lote.
  'ba-continue-on-undeclared': [['BatchRunner.java', 'stopped = true;', 'stopped = false;']],
  // 200 cuando todo salió bien: el status depende del desenlace.
  'ba-status': [
    [
      'BatchRunner.java',
      'ResponseEntity.status(HttpStatus.MULTI_STATUS)',
      'ResponseEntity.status(results.stream().allMatch(done -> "succeeded".equals(done.status())) ? HttpStatus.OK : HttpStatus.MULTI_STATUS)'
    ]
  ],
  // all-or-nothing sin la transacción que abarca el lote: cada elemento se confirma en la suya.
  'ba-atomic-no-tx': [['BatchRunner.java', 'transaction.execute(status -> processAll(items, itemType, process))', 'processAll(items, itemType, process)']]
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
  if (!file) throw new Error(`batch-check: no encuentro ${className}.java en el proyecto generado`);
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

/** El caso de una prueba por su prefijo: `ba7_sobre_perItem` → BA-7. */
const caseOf = (testName) => {
  const match = /^ba(\d+)_/.exec(testName);
  return match ? `BA-${match[1]}` : '?';
};

const design = BATCH_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño de lotes '${designName}'. Los hay: ${BATCH_DESIGNS.map((d) => d.name).join(', ')}.`);
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
let expected = null;
if (sabotage) {
  expected = (BATCH_SABOTAGES[sabotage] ?? []).filter((id) => cases.includes(id));
  if (expected.length === 0) {
    console.error(`El sabotaje '${sabotage}' cae en ${(BATCH_SABOTAGES[sabotage] ?? []).join(', ')}, y ${designName} no ejecuta ninguno (ejecuta ${cases.join(', ')}).`);
    process.exit(2);
  }
}
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-batch-keep-')) : tmpDir('keel-batch-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

if (sabotage) {
  let applied = 0;
  for (const [suffix, from, to] of SABOTAGES[sabotage]) {
    for (const file of walk(path.join(projectDir, 'src/main')).filter((candidate) => candidate.endsWith(suffix))) {
      const text = fs.readFileSync(file, 'utf8');
      const changed = text.replaceAll(from, to);
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
// standalone, sin transacciones.
const properties = document
  ? ['"spring.autoconfigure.exclude=de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration"']
  : conexionPerezosa(db?.spring?.datasource ?? {});
const pkgOf = (name) => classOf(projectDir, name).pkg;
const operation = batchOperations(model)[0];
const packages = {
  handler: pkgOf(operation.handlerClass),
  commands: pkgOf(operation.messageClass),
  dtos: operation.responseDto ? pkgOf(operation.responseDto.name) : null,
  annotations: pkgOf('ApplicationComponent'),
  interfaces: pkgOf('ReturningCommandHandler'),
  aggregate: pkgOf('Product'),
  enums: pkgOf('ProductStatus'),
  errors: pkgOf('SkuAlreadyExistsError'),
  identity: pkgOf('Uuids'),
  port: pkgOf('ProductRepository'),
  valueobject: pkgOf('ProductDraft'),
  adapters: pkgOf(document ? 'ProductMongoRepository' : 'ProductJpaRepository')
};
// El handler de la sonda, en el lugar del stub: lo que escribiría el agente para UN elemento.
fs.writeFileSync(classOf(projectDir, operation.handlerClass).file, probeHandler(model, { packages }), 'utf8');

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
fs.writeFileSync(path.join(testDir, `${CLASS_NAME}.java`), batchTestClass(model, { packages, document, properties, doubles }), 'utf8');
const classes = [CLASS_NAME];

console.log(`batch-check · ${designName} (${engine}) · ${runtime.runtime} · casos ${cases.join(', ')}`);
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
