#!/usr/bin/env node
// Ejercita el RECLAMO generado contra un motor de verdad.
//
// Es el hermano que faltaba de `broker-check`, `mail-check` y `mongo-check`, y le hacía falta
// al mecanismo con menos red de todo el generador. El reclamo vive entero en `main`, y su
// núcleo son dos cadenas: el JPQL de un `@Query` y el predicado que lo acompaña. Ninguna de las
// redes existentes las mira —los tests comparan cadenas, `java-syntax` solo tokeniza— y
// `compile-check`, que desde hoy sí compila `main`, tampoco puede: javac da por bueno cualquier
// JPQL sintácticamente válido. Un predicado que no casa con nada compila, arranca y **reclama
// cero filas sin fallar**, que es el gemelo silencioso del `updateOne` que modifica cero
// documentos y por el que existe `mongo-check`.
//
// Y hay una propiedad que ni siquiera es del JPQL sino del motor: `NULL < :staleBefore` no es
// falso, es UNKNOWN. Una fila en vuelo con el reloj a NULL no entra en ningún lote nunca más —
// el javadoc que emite `claim.js` lo anuncia, y hasta ahora nadie lo había comprobado.
//
// **Qué se ejecuta, y por qué es fiel.** No se traduce nada: el runner escribe un JUnit dentro
// del proyecto generado que llama a los métodos que `build` emitió —el adaptador con su
// `REQUIRES_NEW`, la interfaz Spring Data con su `@Query`— y los ejercita contra el motor que
// levanta `infra/`. Los nombres (entidad, métodos, estados, reloj, claves de `parameters/`)
// salen del MODELO, no escritos a mano: un runner con sus propios nombres comprobaría que
// Postgres responde, no que el generador acierta.
//
// Hibernate valida además todos los `@Query` al arrancar, así que un campo inexistente o un
// error de sintaxis tumba el arranque antes de llegar a ninguna aserción. Eso es gratis y viene
// incluido.
//
// **Dos ejes.** Por MOTOR (`--database=`), porque el literal con el que se nombra una fila y el
// instante rancio con el que se fabrica una precondición cambian con el dialecto —y un literal
// que no casa no falla: se lleva cero filas por delante—. Y por MODELO DE PERSISTENCIA, que lo
// decide el DISEÑO: con una fixture documental lo que se ejercita es la otra rama entera
// (`findAndModify` con su `Criteria`), que no comparte una línea con la relacional y que hasta
// ahora no ejecutaba nadie — `mongo-check` mira los scripts del ARNÉS, no el reclamo.
//
//   node packages/keel-spring/scripts/claim-check.js [fixture] [--database=<motor>] [--keep]
//   npm run claim-check --workspace packages/keel-spring
//
// Necesita podman o docker, y JDK (Gradle compila el proyecto entero, `main` incluido).

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
import { claimScenarios, claimTestClass, CLASS_NAME, PACKAGE_LEAF } from '../src/lib/claim-probes.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'job-dispatch';
const database = args.find((arg) => arg.startsWith('--database='))?.split('=')[1] ?? 'postgresql';

// ─── Procesos y compose (misma resolución que los scripts generados) ─────────

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

function composeUp(frontends, projectDir) {
  const failures = [];
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'db'], {
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

// Sello del veredicto: cuándo se emitió y sobre QUÉ árbol, por lo mismo que en mongo-check —
// un artefacto rojo de un borrador anterior es indistinguible de uno recién emitido.
function verdictStamp() {
  const head = run('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']);
  return {
    generatedAt: new Date().toISOString(),
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null
  };
}

// ─── Preparación ─────────────────────────────────────────────────────────────

function prepare() {
  const service = loadService(path.join(fixturesDir, fixture));
  if (service.errors.length > 0) throw new Error(`la fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);

  // El modelo de persistencia lo declara el DISEÑO, así que el motor sale de él y no del
  // argumento: pedir `--database=postgresql` sobre una fixture documental no significa nada.
  const document = (service.layers.persistence?.default?.model ?? 'relational') === 'document';
  const engine = document ? 'mongodb' : database;

  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack: { database: engine } });
  const scenarios = claimScenarios(model);
  // La guarda cuenta como sujeto por sí sola: un diseño puede no tener barridos y tener un
  // efecto externo irreversible que reclamar, y ahí también hay algo que ejercitar.
  if (scenarios.claims.length === 0 && !scenarios.guard) {
    throw new Error(`la fixture '${fixture}' no genera ningún reclamo: no hay nada que ejercitar`);
  }

  // Sin `--keep` el temporal cuelga de `tmpDir()` y lo barre el propio proceso al salir, también
  // si el runner muere a mitad. Con `--keep` la promesa es que el proyecto SIGA ahí para mirarlo,
  // así que ahí no puede colgar de un directorio autolimpiable — una bandera que borra lo que
  // dice conservar es peor que no tenerla.
  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-claim-keep-')) : tmpDir('keel-claim-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database: engine } });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  // La conexión sale del fichero de parámetros que build EMITIÓ, no de constantes de aquí:
  // es la misma que usa el proyecto contra su propia infraestructura, y si build la cambia
  // este runner la sigue.
  const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
  const datasource = document ? { uri: db?.spring?.data?.mongodb?.uri } : (db?.spring?.datasource ?? {});

  // El paquete de cada clase se LEE del proyecto generado en vez de suponerse: si el scaffold
  // reorganiza el layout, este runner lo sigue en vez de escribir un import que no existe.
  const packages = resolvePackages(projectDir, {
    enums: `${scenarios.enumType}.java`,
    port: `${scenarios.entity.name}Repository.java`,
    // El espejo y su repositorio cambian de nombre con el modelo: son dos ramas del
    // scaffolding que no comparten una línea.
    entities: document ? `${scenarios.entity.name}Document.java` : `${scenarios.entity.name}Jpa.java`,
    repositories: document
      ? `${scenarios.entity.name}RepositoryImpl.java`
      : `${scenarios.entity.name}JpaRepository.java`
  });

  const testFile = path.join(
    projectDir,
    'src/test/java',
    ...model.service.basePackage.split('.'),
    PACKAGE_LEAF,
    `${CLASS_NAME}.java`
  );
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, claimTestClass(model, scenarios, { datasource, packages, database: engine }), 'utf8');

  // El sondeo se resuelve AQUÍ y no en el bucle de espera: si el motor elegido no declara
  // ninguno, la pasada tiene que morir diciendo eso —y no agotando un plazo contra un motor
  // sano, que es un rojo indistinguible de «la base no arranca».
  const probe = databaseHealthProbe(engine, model.service.name.replaceAll('-', '_'));
  if (!probe) {
    throw new Error(`el motor '${engine}' no declara sondeo en el catálogo: no hay a qué esperar`);
  }

  return { projectDir, model, scenarios, probe, engine, container: `${service.manifest.service.name}-db` };
}

/** Busca cada clase en el árbol generado y devuelve su paquete, leído de su propia cabecera. */
function resolvePackages(projectDir, wanted) {
  const root = path.join(projectDir, 'src/main/java');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const files = walk(root);
  const packages = {};
  for (const [key, basename] of Object.entries(wanted)) {
    const file = files.find((candidate) => path.basename(candidate) === basename);
    if (!file) throw new Error(`claim-check: no encuentro ${basename} en el proyecto generado`);
    const declared = /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'));
    if (!declared) throw new Error(`claim-check: ${basename} no declara paquete`);
    packages[key] = declared[1];
  }
  return packages;
}

/**
 * El motor tarda en aceptar conexiones; se sondea con el comando que declara el CATÁLOGO.
 *
 * Aquí había el sondeo de PostgreSQL escrito a mano, y eso ataba el runner entero a ese motor:
 * con cualquier otro, el sondeo no daba 0 nunca y la pasada moría a los 90 s en «el motor no
 * aceptó conexiones a tiempo» sin haber ejecutado ni una aserción. Ese rojo no distingue «el
 * motor no arrancó» de «este runner no sabe preguntárselo», que es la peor forma de fallar.
 *
 * El comando y el plazo salen los dos de `databaseHealthProbe` —la misma tabla que usa el
 * compose de `deploy/`—: escribirlos aquí mediría que el motor responde, no que el generador
 * acierta, que es justo la regla que ya motivó `broker-probes.js` y `mongo-probes.js`.
 */
function waitForDatabase(runtime, container, probe) {
  const deadline = Date.now() + probe.budgetSeconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const result = run(runtime, ['exec', container, ...probe.argv]);
    if (result.status === 0) return true;
    last = (result.stderr || result.stdout).trim().split('\n').at(-1) ?? '';
    // Espera SÍNCRONA sin lanzar un proceso: el runner es secuencial de arriba abajo.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
  }
  if (last) console.error(`  último error del sondeo: ${last}`);
  return false;
}

// ─── Resultados ──────────────────────────────────────────────────────────────

/** Lee el XML de JUnit y devuelve [{ name, ok, detail }]. */
function readResults(projectDir, model) {
  const dir = path.join(projectDir, 'build/test-results/test');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((name) => name.includes(CLASS_NAME) && name.endsWith('.xml'));
  if (!file) return [];
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  const cases = [];
  // Un `<testcase .../>` cerrado en sí mismo pasó; uno con hijos trae el <failure>.
  const re = /<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const body = match[3] ?? '';
    const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(body);
    cases.push({
      name: match[1].replace(/\(\)$/, ''),
      ok: !failure,
      detail: failure ? decodeEntities(failure[2]).split('\n')[0].slice(0, 240) : ''
    });
  }
  return cases;
}

const decodeEntities = (text) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#10;', ' ')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

// ─── Entrada ─────────────────────────────────────────────────────────────────

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}
if (run('java', ['-version']).status !== 0) {
  console.error('No hay JDK en el PATH. Este check compila el proyecto entero con Gradle.');
  process.exit(2);
}

let prepared;
try {
  prepared = prepare();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { projectDir, model, scenarios, probe, engine, container } = prepared;

console.log(`claim-check · ${fixture} (${engine}) · ${runtimeInfo.runtime}`);
console.log(
  `  reclamos ejercitados: ${[
    ...scenarios.claims.map((claim) => claim.method),
    ...(scenarios.guard ? [`${scenarios.guard.method} (guarda)`] : [])
  ].join(', ')}`
);

const { frontend, log } = composeUp(runtimeInfo.frontends, projectDir);
if (!frontend) {
  console.error(`No se pudo levantar la infraestructura:\n${log}`);
  process.exit(2);
}

let exitCode = 2;
try {
  if (!waitForDatabase(runtimeInfo.runtime, container, probe)) {
    console.error('El motor no aceptó conexiones a tiempo.');
  } else {
    const gradle = run('sh', [
      'gradlew',
      'test',
      '--tests',
      `*${CLASS_NAME}`,
      '--console=plain',
      '--no-daemon'
    ], { cwd: projectDir });

    const cases = readResults(projectDir, model);
    if (cases.length === 0) {
      // Sin XML no hay veredicto: o no compiló, o el contexto de Spring no arrancó —y eso
      // último ya es un hallazgo, porque Hibernate valida los @Query al arrancar.
      console.error('La suite no llegó a ejecutarse. Salida de Gradle:');
      console.error((gradle.stdout + gradle.stderr).split('\n').slice(-40).join('\n'));
    } else {
      console.log('');
      for (const item of cases) {
        console.log(`  ${item.ok ? 'OK  ' : 'KO  '} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
      }
      const failed = cases.filter((item) => !item.ok).length;
      console.log(`\n  ${cases.length - failed}/${cases.length} en verde`);
      exitCode = failed > 0 ? 1 : 0;
      fs.writeFileSync(
        path.join(here, '..', 'claim-check.json'),
        `${JSON.stringify({ ...verdictStamp(), fixture, database: engine, cases }, null, 2)}\n`,
        'utf8'
      );
    }
  }
} finally {
  if (keep) {
    console.log(`\n  --keep: el proyecto queda en ${projectDir} y la infraestructura en pie.`);
  } else {
    composeDown(frontend, projectDir);
  }
}

process.exit(exitCode);
