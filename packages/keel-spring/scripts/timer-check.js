#!/usr/bin/env node
// Ejecuta el CRONÓMETRO y los PLAZOS generados contra un motor de verdad (DSL 2.26, PLAN-DSL-226-PLAZOS.md, inc. 3).
//
// Lo que build emite para un plazo —el rechazo tardío del dominio, el armado en el adaptador, el almacén con las
// sentencias de keel-core y el sondeador— no lo juzga ninguna otra red: javac da por buena una sentencia SQL dentro de un
// literal, y un reclamo que no casa con nada no falla, devuelve cero temporizadores y el plazo no vence nunca. Aquí se
// escribe un JUnit dentro del proyecto generado (src/lib/timer-probes.js, nombres sacados del MODELO) y se ejecuta con
// Gradle contra la base que levanta su `infra/`. Los casos llevan los ids de keel-core (DEADLINE_CASES).
//
//   node packages/keel-spring/scripts/timer-check.js [fixture] [--database=postgresql|mysql] [--sabotage=<id>] [--keep]
//   npm run timer-check --workspace packages/keel-spring
//
// Con una fixture documental (`verification-codes-mongo`) el motor sale del diseño: MongoDB, la otra rama entera.
// `--sabotage=<id>` rompe a propósito UNA pieza del Java generado (SABOTAGES) y el veredicto se invierte: verde si caen
// exactamente sus casos. Necesita podman o docker, y JDK.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';
import { CLASS_NAME, PACKAGE_LEAF, timerProbePatches, timerTestClass } from '../src/lib/timer-probes.js';
import { conexionPerezosa } from '../src/lib/claim-probes.js';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures', 'designs');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'verification-codes';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';
const sabotage = args.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;

// Cada sabotaje: el archivo, qué se cambia y los casos que TIENEN que caer (los de keel-core/gen/deadlines.js, con la
// rama en la que aplica). `dl-wrong-field` y `dl-app-clock` no tienen sujeto aquí: la fixture solo tiene una marca de
// tiempo con la que contar, y la hora de la instancia y la de la base son la misma máquina.
const GUARD = /if \(!(\w+\.plus\(deadlines\.\w+\(\)\))\.isAfter\(now\)\) \{/;
const SABOTAGES = {
  'dl-boundary': { file: '{entity}.java', find: GUARD, replace: 'if ($1.isBefore(now)) {', breaks: ['dl2_enElInstanteExactoSeRechaza'] },
  'dl-no-guard': { file: '{entity}.java', find: GUARD, replace: 'if (false) {', breaks: ['dl2_enElInstanteExactoSeRechaza'] },
  'dl-no-revalidate': {
    file: '{entity}{State}Deadline.java',
    find: /if \(found\.isEmpty\(\) \|\| (.*?)\) \{\n\s*return TimerOutcome\.finished\(\);\n\s*\}([\s\S]*?)if \(due\.isAfter\(dbNow\)\) \{/,
    replace: 'if (found.isEmpty()) {\n            return TimerOutcome.finished();\n        }$2if (false) {',
    breaks: ['dl8_unaEntidadQueYaSalioSeDescarta', 'dl9_conElPlazoVigenteMasLargoSeRearma']
  },
  'dl-no-lease': {
    relational: { file: 'JdbcTimerStore.java', find: '.param("leaseMs", leaseMs)', replace: '.param("leaseMs", 0L)' },
    // En documental cae además DL-5, y es lo correcto: sin arriendo, el bucle de findOneAndUpdate vuelve a llevarse en
    // el MISMO lote el documento que acaba de reclamar (en relacional el lote es una sola sentencia y no lo ve).
    document: {
      file: 'MongoTimerStore.java',
      find: 'List.of("$$NOW", leaseMs)',
      replace: 'List.of("$$NOW", 0L)',
      breaks: ['dl5_elReclamoDevuelveSoloLoVencidoEnOrden', 'dl6_dosReplicasNoReclamanElMismo', 'dl7_unArriendoVencidoLoRetomaOtra']
    },
    breaks: ['dl6_dosReplicasNoReclamanElMismo', 'dl7_unArriendoVencidoLoRetomaOtra']
  },
  'dl-outside-tx': {
    relational: {
      file: 'JdbcTimerStore.java',
      find: '    public void arm(String kind, UUID entityId, Instant dueAt) {\n        jdbc.sql(ARM)',
      replace:
        '    public void arm(String kind, UUID entityId, Instant dueAt) {\n        ownTransaction.executeWithoutResult(status -> armNow(kind, entityId, dueAt));\n    }\n\n    private void armNow(String kind, UUID entityId, Instant dueAt) {\n        jdbc.sql(ARM)'
    },
    breaks: ['dl4_entrarEnElEstadoArmaEnLaMismaTransaccion']
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

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function patchFile(projectDir, basename, find, replace) {
  const file = walk(path.join(projectDir, 'src/main/java')).find((candidate) => path.basename(candidate) === basename);
  if (!file) throw new Error(`timer-check: no encuentro ${basename} en el proyecto generado`);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(find, replace);
  // Un parche que no aplica no puede pasar por bueno: el caso se mediría sobre el Java sin tocar.
  if (after === before) throw new Error(`timer-check: el parche no aplica en ${basename} (${String(find).slice(0, 80)})`);
  fs.writeFileSync(file, after, 'utf8');
}

function prepare() {
  const service = loadService(path.join(fixturesDir, fixture));
  if (service.errors.length > 0) throw new Error(`la fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);
  const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
  const engine = document ? 'mongodb' : database;
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack: { database: engine } });
  model.stack = { ...(model.stack ?? {}), database: engine };

  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-timer-keep-')) : tmpDir('keel-timer-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database: engine } });
  const projectName = fs.readdirSync(path.join(workspace, 'services'), { withFileTypes: true }).find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  for (const patch of timerProbePatches(model)) patchFile(projectDir, patch.file, patch.find, patch.replace);

  let expected = null;
  if (sabotage) {
    const spec = SABOTAGES[sabotage];
    if (!spec) throw new Error(`sabotaje desconocido: ${sabotage} (hay ${Object.keys(SABOTAGES).join(', ')})`);
    const branch = spec[document ? 'document' : 'relational'] ?? (spec.file ? spec : null);
    if (!branch) throw new Error(`el sabotaje ${sabotage} no tiene sujeto en la rama ${document ? 'documental' : 'relacional'}`);
    const { entity, deadline } = model.entities
      .flatMap((candidate) => (candidate.lifecycle?.deadlines ?? []).map((d) => ({ entity: candidate, deadline: d })))[0];
    const file = branch.file
      .replace('{entity}', entity.name)
      .replace('{State}', deadline.stateName[0].toUpperCase() + deadline.stateName.slice(1));
    patchFile(projectDir, file, branch.find, branch.replace);
    expected = branch.breaks ?? spec.breaks;
  }

  // La conexión perezosa del perfil, como en producción (claim-probes.js): el reclamo corre detrás del proxy.
  const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
  // En documental, sin el mongod EMBEBIDO del classpath de test (flapdoodle): la sonda mediría una base en memoria
  // standalone, sin transacciones. DL-4 (el temporizador revierte con la transacción) es lo que hace fallable esto.
  const properties = document
    ? ['"spring.autoconfigure.exclude=de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration"']
    : conexionPerezosa(db?.spring?.datasource ?? {});
  const testFile = path.join(projectDir, 'src/test/java', ...model.service.basePackage.split('.'), ...PACKAGE_LEAF.split('.'), `${CLASS_NAME}.java`);
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, timerTestClass(model, { properties }), 'utf8');

  const probe = databaseHealthProbe(engine, model.service.name.replaceAll('-', '_'));
  if (!probe) throw new Error(`el motor '${engine}' no declara sondeo en el catálogo`);
  return { projectDir, probe, engine, expected, container: `${service.manifest.service.name}-db` };
}

function waitForDatabase(runtime, container, probe) {
  const deadline = Date.now() + probe.budgetSeconds * 1000;
  while (Date.now() < deadline) {
    if (run(runtime, ['exec', container, ...probe.argv]).status === 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
  }
  return false;
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
    cases.push({ name: match[1].replace(/\(\)$/, ''), ok: !failure, detail: failure ? failure[2].replaceAll('&quot;', '"').replaceAll('&#10;', ' ').slice(0, 240) : '' });
  }
  return cases;
}

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman en el PATH.');
  process.exit(2);
}
let prepared;
try {
  prepared = prepare();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { projectDir, probe, engine, expected, container } = prepared;
console.log(`timer-check · ${fixture} (${engine}) · ${runtimeInfo.runtime}${sabotage ? ` · sabotaje ${sabotage}` : ''}`);

let frontend = null;
for (const candidate of runtimeInfo.frontends) {
  if (run(candidate.command, [...candidate.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'db'], { cwd: projectDir }).status === 0) {
    frontend = candidate;
    break;
  }
}
if (!frontend) {
  console.error('No se pudo levantar la base de infra/.');
  process.exit(2);
}

let exitCode = 2;
try {
  if (!waitForDatabase(runtimeInfo.runtime, container, probe)) {
    console.error('El motor no aceptó conexiones a tiempo.');
  } else {
    const gradle = run('sh', ['gradlew', 'test', '--tests', `*${CLASS_NAME}`, '--console=plain', '--no-daemon'], { cwd: projectDir });
    const cases = readResults(projectDir);
    if (cases.length === 0) {
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-40).join('\n'));
    } else {
      for (const item of cases) console.log(`  ${item.ok ? 'OK  ' : 'KO  '} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
      const failed = cases.filter((item) => !item.ok).map((item) => item.name).sort();
      if (expected) {
        const want = [...expected].sort();
        const exact = failed.length === want.length && failed.every((name, index) => name === want[index]);
        console.log(`\n  sabotaje ${sabotage}: ${exact ? 'cae en exactamente sus casos' : `esperaba [${want.join(', ')}], cayeron [${failed.join(', ')}]`}`);
        exitCode = exact ? 0 : 1;
      } else {
        console.log(`\n  ${cases.length - failed.length}/${cases.length} en verde`);
        exitCode = failed.length > 0 ? 1 : 0;
      }
    }
  }
} finally {
  if (keep) console.log(`\n  --keep: el proyecto queda en ${projectDir} y la base en pie.`);
  else run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}
process.exit(exitCode);
