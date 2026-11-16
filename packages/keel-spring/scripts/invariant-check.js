#!/usr/bin/env node
// EJECUTA la guarda del agregado (DSL 2.31: `entities.<E>.checks`, las cotas de la entidad y `computed: { sum, count }`)
// que emite keel-spring: ensureInvariants() en la entidad y su llamada en el save de los dos adaptadores, con los
// vectores IC-* y CP-* de keel-core (test/helpers/entity-check-designs.js), los mismos que ejecutarán keel-nest,
// keel-dotnet y keel-go sobre el MISMO sujeto.
//
// Por qué existe: todo lo que se mide aquí compila diga lo que diga — un lte que es lt, un nulo que rompe una
// comparación, una cadena vacía que cuenta como presente, una hija que no se comprueba, un code que no es el del check,
// un save que no llama a la guarda, una suma que redondea línea a línea o al par, una columna con el derivado de antes.
// Ninguno rompe un arranque ni un escenario feliz.
//
//   node packages/keel-spring/scripts/invariant-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run invariant-check --workspace packages/keel-spring
//
// Diseños: catalog-invariants (relacional) y catalog-invariants-mongo, sin la réplica del precio del proveedor (ver más
// abajo). Necesita podman o docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando), y verde significa que cae en EXACTAMENTE sus
// casos de INVARIANT_SABOTAGES o COMPUTED_SABOTAGES: ni uno más ni uno menos.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { INVARIANT_SABOTAGES } from '@keel-system/keel-core/gen/entity-checks';
import { COMPUTED_SABOTAGES } from '@keel-system/keel-core/gen/computed';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { conexionPerezosa } from '../src/lib/claim-probes.js';
import { CLASS_NAME, PACKAGE_LEAF, SUBJECT_ROOT, casesOf, invariantTestClass } from '../src/lib/invariant-probes.js';
import { ENTITY_CHECK_DESIGNS, INVARIANT_VECTORS } from '../../keel-core/test/helpers/entity-check-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-invariants';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

/**
 * Cada sabotaje: `[dónde, texto o expresión, sustituto]`; `dónde` es un sufijo de archivo bajo src/main, o `/domain/` para
 * las entidades. Todos compilan: lo que se mide es la sonda, no javac. `(model) => [...]` cuando depende del diseño.
 */
const ENTITIES = '/domain/';
const GUARD_CALL = /\n        \/\/ La guarda del agregado \(DSL 2\.31\)[^\n]*\n        entity\.ensureInvariants\(\);/;
const SABOTAGES = {
  // lte se evalúa como lt (y gte como gt).
  'ic-boundary': [[ENTITIES, / (<|>)= 0\)\) \{/g, ' $1 0)) {']],
  // Una comparación con un operando ausente se rompe.
  'ic-null-fails': [[ENTITIES, /Objects\.isNull\(([^()]+)\) \|\| /g, 'Objects.nonNull($1) && ']],
  // Solo el nulo cuenta como ausente.
  'ic-absent-null-only': [[ENTITIES, 'return value == null || value.isEmpty();', 'return value == null;']],
  // La entidad no hace cumplir sus cotas.
  'ic-no-bounds': [[ENTITIES, /^        \/\/ Las cotas de sus campos[^\n]*\n[\s\S]*?(?=^        \/\/ Sus checks|^    \}$)/gm, '']],
  // La guarda no baja a las hijas.
  'ic-children': [[ENTITIES, /\n        for \(\w+ child : \w+\) \{\n            child\.ensureInvariants\(\);\n        \}/g, '']],
  // Ignora el error del check.
  'ic-default-code': [[ENTITIES, /throw new (?!InvariantViolatedException|InvalidStateTransitionException)(\w+Error)\(/g, 'throw new InvariantViolatedException(']],
  // El save no llama a ensureInvariants().
  'ic-no-call': [['RepositoryImpl.java', GUARD_CALL, '']],
  // La guarda corre después de escribir, justo antes de devolver.
  'ic-after-write': [['RepositoryImpl.java', new RegExp(`${GUARD_CALL.source}([\\s\\S]*?)\\n        return saved;`), '$1\n        entity.ensureInvariants();\n        return saved;']],
  // Redondea cada línea antes de sumar.
  'cp-round-each': [[ENTITIES, /total = total\.add\(line\);([\s\S]*?)return total\.setScale\((\d+), RoundingMode\.HALF_UP\)/g, 'total = total.add(line.setScale($2, RoundingMode.HALF_UP));$1return total.setScale($2, RoundingMode.HALF_UP)']],
  // Redondea la mitad al par.
  'cp-half-even': [[ENTITIES, 'RoundingMode.HALF_UP', 'RoundingMode.HALF_EVEN']],
  // No comprueba que el resultado quepa.
  'cp-no-overflow': [[ENTITIES, 'if (exceedsDecimal(', 'if (false && exceedsDecimal(']],
  // El save no escribe el derivado recalculado: la columna conserva lo que la fila traía (o nada, en documental).
  'cp-stale': (model) =>
    model.entities.flatMap((entity) =>
      entity.fields
        .filter((field) => field.computedSpec)
        .map((field) => {
          const name = `${field.name[0].toUpperCase()}${field.name.slice(1)}`;
          return ['RepositoryImpl.java', `.set${name}(domain.get${name}())`, model.persistenceKind === 'document' ? `.set${name}(null)` : `.set${name}(jpa.get${name}())`];
        })
    )
};
const BREAKS = Object.fromEntries([...Object.entries(INVARIANT_SABOTAGES), ...Object.entries(COMPUTED_SABOTAGES)].map(([id, entry]) => [id, entry.breaks]));

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
  if (!file) throw new Error(`invariant-check: no encuentro ${className}.java en el proyecto generado`);
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

/** El caso de una prueba por su prefijo: `ic10_1` → IC-10, `cp2_1` → CP-2. */
const caseOf = (testName) => {
  const match = /^(ic|cp)(\d+)_/.exec(testName);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : '?';
};

const design = ENTITY_CHECK_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño de invariantes '${designName}'. Los hay: ${ENTITY_CHECK_DESIGNS.map((d) => d.name).join(', ')}.`);
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
// La réplica de catalog-extended deja el main sin compilar recién generado (el projector llama a métodos del agente,
// src/lib/main-compilable.js): el precio del proveedor, en el momento, como en precondition-check. No toca la guarda.
const supplierPrice = service.layers.dependencies?.dependencies?.pricing?.needs?.supplierPrice;
if (supplierPrice?.strategy === 'replicated') {
  delete supplierPrice.replica;
  supplierPrice.strategy = 'on-demand';
}
const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
const engine = document ? 'mongodb' : database;
const stack = { database: engine };
const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
const cases = casesOf(INVARIANT_VECTORS);
let expected = sabotage ? (BREAKS[sabotage] ?? []).filter((id) => cases.includes(id)) : null;
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-invariant-keep-')) : tmpDir('keel-invariant-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

// Lo que keel-spring enmascara de ic-after-write, leído de lo emitido: un save con @Transactional revierte la fila que la
// guarda rechaza después de escribirla (IC-10 no lo puede ver), y Decimal128 guarda la suma que desborda la columna
// relacional, así que en documental la base no la rechaza antes que la guarda (CP-4 tampoco).
if (sabotage === 'ic-after-write') {
  const adapter = walk(path.join(projectDir, 'src/main/java')).find((file) => file.endsWith(`${SUBJECT_ROOT}RepositoryImpl.java`));
  const transactional = /@Transactional\n    public \w+ save\(/.test(fs.readFileSync(adapter, 'utf8'));
  const masks = [...(transactional ? ['IC-10'] : []), ...(document ? ['CP-4'] : [])];
  const why = [transactional ? 'el save es transaccional' : null, document ? 'Decimal128 admite la suma' : null].filter(Boolean).join('; ');
  if (masks.length > 0) console.log(`(ic-after-write: keel-spring enmascara ${masks.join(', ')}: ${why})`);
  expected = expected.filter((id) => !masks.includes(id));
}

if (sabotage) {
  const entries = typeof SABOTAGES[sabotage] === 'function' ? SABOTAGES[sabotage](model) : SABOTAGES[sabotage];
  let applied = 0;
  for (const [where, from, to] of entries) {
    const inScope = (file) => (where.startsWith('/') ? file.replaceAll('\\', '/').includes(where) && file.endsWith('.java') : file.endsWith(where));
    for (const file of walk(path.join(projectDir, 'src/main')).filter(inScope)) {
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
  console.log(`(sabotaje: ${sabotage}; tiene que caer en ${expected.join(', ') || 'ninguno'})`);
}

const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
// En documental, sin el mongod EMBEBIDO del classpath de test (flapdoodle): la sonda mediría una base en memoria
// standalone, sin transacciones, como en history-check.
const properties = document
  ? ['"spring.autoconfigure.exclude=de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration"']
  : conexionPerezosa(db?.spring?.datasource ?? {});
const pkgOf = (name) => classOf(projectDir, name).pkg;
const child = model.entities.find((entity) => entity.internalOf && entity.rootEntity === SUBJECT_ROOT);
const enums = model.entities.filter((entity) => [SUBJECT_ROOT, child.name].includes(entity.name)).flatMap((entity) => entity.fields).filter((field) => field.kind === 'enum').map((field) => field.namedType);
const packages = {
  port: pkgOf(`${SUBJECT_ROOT}Repository`),
  adapters: pkgOf(`${SUBJECT_ROOT}${document ? 'MongoRepository' : 'JpaRepository'}`),
  errors: pkgOf('DomainException'),
  types: Object.fromEntries([SUBJECT_ROOT, child.name, ...enums].map((name) => [name, pkgOf(name)]))
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
fs.writeFileSync(path.join(testDir, `${CLASS_NAME}.java`), invariantTestClass(model, { vectors: INVARIANT_VECTORS, packages, document, properties, doubles }), 'utf8');
const classes = [CLASS_NAME];

console.log(`invariant-check · ${designName} (${engine}) · ${runtime.runtime} · casos ${cases.join(', ')}`);
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
        console.log(`\n  cayeron ${fell.join(', ') || 'ninguno'}; tenían que caer ${want.join(', ')} → ${!exact ? 'ROJO' : want.length === 0 ? 'VERDE (sin efecto observable en keel-spring: no cae nada, como se esperaba)' : 'VERDE (el sabotaje se ve, y solo en sus casos)'}`);
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
