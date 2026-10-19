#!/usr/bin/env node
// EJECUTA los finders de las búsquedas (DSL 2.22) que emite keel-spring contra el motor real de infra/.
//
// Por qué existe: el finder es una Specification de JPA o un Criteria de Spring Data MongoDB, y las dos cosas compilan
// digan lo que digan — una propiedad mal nombrada revienta en ejecución, un LIKE sin escape casa de más, un `where`
// que no se aplica devuelve filas de más sin fallar. Es el gemelo del db-check/doc-check de keel-dotnet y keel-nest
// sobre los MISMOS diseños (keel-core/test/helpers/finder-designs.js) y con las mismas preguntas
// (keel-core/gen/query-filters.js): una fila que cumple el `where` y otra que no; por criterio, lo que la encuentra y
// lo que no.
//
//   node packages/keel-spring/scripts/finder-check.js [diseño] [--database=<motor>] [--sabotage=<id>] [--keep]
//   npm run finder-check --workspace packages/keel-spring
//
// Diseños: product-catalog-finder (relacional: lista y página) y jobs-mongo-finder (documental). Necesita podman o
// docker, y JDK.
//
// --sabotage=<id> rompe lo emitido conservando la forma (sigue compilando) y la sonda tiene que salir en rojo:
//   finder-where    la Specification / el Criteria pierde su filtro fijo
//   finder-literal  el patrón LIKE (relacional) o la expresión regular (documental) deja de escapar el texto

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from 'keel-core';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { CLASS_NAME, PACKAGE_LEAF, finderTestClass, namedTypes } from '../src/lib/finder-probes.js';
import { FINDER_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const designName = args.find((arg) => !arg.startsWith('--')) ?? 'product-catalog-finder';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// [archivo (sufijo), texto o expresión, sustituto], por modelo.
const SABOTAGES = {
  'finder-where': {
    relational: ['RepositoryImpl.java', /^ {12}where\.add\(cb\.equal\(root\.get\("\w+"\), \w+\.\w+\)\);\n/m, ''],
    document: ['RepositoryImpl.java', /^ {8}where\.add\(Criteria\.where\("\w+"\)\.is\(\w+\.\w+\)\);\n/m, '']
  },
  'finder-literal': {
    relational: ['RepositoryImpl.java', '.replace("%", "\\\\%").replace("_", "\\\\_")', ''],
    document: ['RepositoryImpl.java', 'Pattern.quote(', '(']
  }
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

/** Busca cada clase en el árbol generado y devuelve su paquete, leído de su propia cabecera. */
function packageOf(projectDir, className) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === `${className}.java`);
  if (!file) throw new Error(`finder-check: no encuentro ${className}.java en el proyecto generado`);
  return /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'))[1];
}

function readResults(projectDir) {
  const dir = path.join(projectDir, 'build/test-results/test');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((name) => name.includes(CLASS_NAME) && name.endsWith('.xml'));
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

const design = FINDER_DESIGNS.find((candidate) => candidate.name === designName);
if (!design) {
  console.error(`No hay ningún diseño '${designName}'. Los hay: ${FINDER_DESIGNS.map((candidate) => candidate.name).join(', ')}.`);
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
const model = buildModel({ manifest: service.manifest, layers: service.layers, stack: { database: engine } });
const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-finder-keep-')) : tmpDir('keel-finder-check-');
scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database: engine } });
const projectDir = path.join(workspace, 'services', fs.readdirSync(path.join(workspace, 'services'))[0]);

if (sabotage) {
  const entry = SABOTAGES[sabotage]?.[document ? 'document' : 'relational'];
  if (!entry) {
    console.error(`No hay ningún sabotaje '${sabotage}'. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
    process.exit(2);
  }
  const [suffix, from, to] = entry;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => (item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]));
  let applied = 0;
  for (const file of walk(path.join(projectDir, 'src/main/java')).filter((candidate) => candidate.endsWith(suffix))) {
    const text = fs.readFileSync(file, 'utf8');
    const changed = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
    if (changed !== text) {
      fs.writeFileSync(file, changed);
      applied += 1;
    }
  }
  if (applied === 0) {
    console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
    process.exit(2);
  }
  console.log(`(sabotaje: ${sabotage})`);
}

const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
const datasource = document ? { uri: db?.spring?.data?.mongodb?.uri } : (db?.spring?.datasource ?? {});
const roots = model.entities.filter((entity) => entity.persisted && entity.isAggregateRoot);
const anyRoot = roots[0].name;
const packages = {
  port: packageOf(projectDir, `${anyRoot}Repository`),
  adapters: packageOf(projectDir, `${anyRoot}RepositoryImpl`),
  types: Object.fromEntries(namedTypes(model).map((name) => [name, packageOf(projectDir, name)]))
};
const testFile = path.join(projectDir, 'src/test/java', ...model.service.basePackage.split('.'), PACKAGE_LEAF, `${CLASS_NAME}.java`);
fs.mkdirSync(path.dirname(testFile), { recursive: true });
fs.writeFileSync(testFile, finderTestClass(model, { packages, document, datasource }), 'utf8');

console.log(`finder-check · ${designName} (${engine}) · ${runtime.runtime}`);
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
    const gradle = run('sh', ['gradlew', 'test', '--tests', `*${CLASS_NAME}`, '--console=plain', '--no-daemon'], { cwd: projectDir });
    const cases = readResults(projectDir);
    if (cases.length === 0) {
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-40).join('\n'));
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
