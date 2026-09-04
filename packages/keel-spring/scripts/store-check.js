#!/usr/bin/env node
// Ejercita el RELAY DEL OUTBOX y los ALMACENES DE IDEMPOTENCIA generados contra un motor de
// verdad.
//
// Es el quinto runner de conformidad, detrás de `broker-check`, `mail-check`, `mongo-check` y
// `claim-check`, y cubre lo que aquél deja fuera. `claim-check` mide lo que cuelga de una
// OPERACIÓN del diseño —el reclamo de un barrido, la guarda de un efecto irreversible—; esto mide
// lo que cuelga del SERVICIO: el relay que entrega el outbox y los dos registros que impiden
// procesar dos veces lo mismo.
//
// **Qué había hasta ahora: nada.** El JPQL de `findPending`, el lease de `claimBatch`, el
// `findAndModify` del relay documental y las carreras que arbitran `idempotency_record` y
// `processed_event` solo se habían ejercitado dentro de corridas reales, y todas fueron sobre
// PostgreSQL. Sobre MySQL y sobre MongoDB ese código estaba generado y no medido.
//
// Y no es un hueco cómodo, porque el modo de fallo de todas esas cadenas es el mismo y es
// SILENCIOSO. javac da por bueno cualquier JPQL sintácticamente válido; un `Criteria` que no casa
// devuelve null y el relay se comporta como si el outbox estuviera vacío; una clave compuesta a
// la que le falte el `handlerId` deduplica de más y descarta en silencio mensajes que nadie
// procesó. Ninguna de las tres levanta una excepción, escribe un log ni mueve una métrica.
//
// **Qué se ejecuta, y por qué es fiel.** No se traduce nada: el runner escribe dos JUnit DENTRO
// del proyecto generado que llaman a los beans que `build` emitió —`OutboxRelayStore` con su
// lease, la interfaz Spring Data con su `@Query`, `IdempotencyGuard`, el `IdempotencyStore` del
// modelo— y los ejercita contra el motor que levanta `infra/`. Los nombres salen del MODELO, no
// escritos a mano: un runner con nombres propios comprobaría que Postgres responde, no que el
// generador acierta.
//
// **Dos clases y no una**, y no es organización: `OutboxRelayStore` es package-private en
// `…messaging.outbox` y `ProcessedEventWriter` lo es en `…messaging.idempotency`. Cada clase de
// prueba vive en el paquete de lo que mide, y el paquete se LEE del árbol generado.
//
// **Tres motores, que son los del MVP.** Por MOTOR (`--database=`), porque la traducción de una
// violación de integridad a `IdempotencyConflictException` es de Spring pero pasa por el driver,
// y porque el aislamiento del reclamo cambia con el dialecto. Por MODELO DE PERSISTENCIA, que lo
// decide el DISEÑO: con una fixture documental se ejercita la otra rama entera, que no comparte
// una línea con la relacional.
//
//   node packages/keel-spring/scripts/store-check.js [fixture] [--database=<motor>] [--keep]
//   npm run store-check --workspace packages/keel-spring
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
import { storeSubjects, storeTestClasses, hasSubjects, TEST_GLOB } from '../src/lib/store-probes.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'notification-mailer';
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

// Sello del veredicto: cuándo se emitió y sobre QUÉ árbol. Un artefacto rojo de un borrador
// anterior es indistinguible de uno recién emitido si no lo lleva.
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
  const subjects = storeSubjects(model);
  if (!hasSubjects(subjects)) {
    throw new Error(
      `la fixture '${fixture}' no genera outbox ni almacén de idempotencia: no hay nada que ejercitar`
    );
  }

  // Sin `--keep` el temporal cuelga de `tmpDir()` y lo barre el propio proceso al salir, también
  // si el runner muere a mitad. Con `--keep` la promesa es que el proyecto SIGA ahí, así que ahí
  // no puede colgar de un directorio autolimpiable.
  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-store-keep-')) : tmpDir('keel-store-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack: { database: engine } });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  // La conexión sale del fichero de parámetros que build EMITIÓ, no de constantes de aquí: es la
  // misma que usa el proyecto contra su propia infraestructura, y si build la cambia este runner
  // la sigue.
  const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
  const datasource = document ? { uri: db?.spring?.data?.mongodb?.uri } : (db?.spring?.datasource ?? {});

  // El paquete de cada clase se LEE del proyecto generado en vez de suponerse: si el scaffold
  // reorganiza el layout, este runner lo sigue en vez de escribir un import que no existe.
  const wanted = {};
  if (subjects.outbox) {
    // El paquete del outbox sale de la clase que va a medirse, que cambia con el modelo: en la
    // rama relacional el reclamo vive en un bean aparte y en la documental dentro del relay.
    wanted.outbox = subjects.document ? 'OutboxRelay.java' : 'OutboxRelayStore.java';
  }
  if (subjects.dedupe) wanted.dedupe = 'IdempotencyGuard.java';
  if (subjects.commandIdempotency) {
    wanted.commandStore = subjects.document ? 'MongoIdempotencyStore.java' : 'JpaIdempotencyStore.java';
    wanted.storePort = 'IdempotencyStore.java';
    wanted.conflict = 'IdempotencyConflictException.java';
  }
  // Sin suscripciones no hay guard, y entonces la clase de idempotencia cae en el paquete del
  // almacén de mando: es el único que queda.
  if (!subjects.dedupe && subjects.commandIdempotency) wanted.dedupe = wanted.commandStore;
  if (subjects.document) wanted.mongoTx = 'MongoTransactionConfig.java';
  if (subjects.reconciliation) {
    // El paquete del reclamo, y el del agregado que espera: la clase de prueba cae en el primero
    // —`ReconciliationClaimWriter` es package-private ahí— y nombra clases de los otros cuatro.
    const espera = subjects.reconciliation.entity;
    wanted.reconciliation = 'ReconciliationClaimStore.java';
    wanted.enums = `${modelEnumOf(model, subjects.reconciliation)}.java`;
    wanted.entities = subjects.document ? `${espera}Document.java` : `${espera}Jpa.java`;
    wanted.port = `${espera}Repository.java`;
    wanted.adapters = `${espera}RepositoryImpl.java`;
    if (!subjects.document) wanted.jpaRepositories = `${espera}JpaRepository.java`;
  }

  const packages = resolvePackages(projectDir, wanted);

  const clases = storeTestClasses(model, subjects, { datasource, packages, database: engine });
  for (const clase of clases) {
    const testFile = path.join(projectDir, 'src/test/java', ...clase.package.split('.'), `${clase.className}.java`);
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, clase.content, 'utf8');
  }

  // El sondeo se resuelve AQUÍ y no en el bucle de espera: si el motor elegido no declara
  // ninguno, la pasada tiene que morir diciendo eso —y no agotando un plazo contra un motor sano,
  // que es un rojo indistinguible de «la base no arranca».
  const probe = databaseHealthProbe(engine, model.service.name.replaceAll('-', '_'));
  if (!probe) {
    throw new Error(`el motor '${engine}' no declara sondeo en el catálogo: no hay a qué esperar`);
  }

  return { projectDir, subjects, clases, probe, engine, container: `${service.manifest.service.name}-db` };
}

/** El enum del lifecycle de la entidad que espera: es lo que la siembra necesita importar. */
function modelEnumOf(model, claim) {
  const entity = (model.entities ?? []).find((candidate) => candidate.name === claim.entity);
  if (!entity?.lifecycle?.enumType) {
    throw new Error(`store-check: ${claim.entity} no declara lifecycle y el barrido lo necesita`);
  }
  return entity.lifecycle.enumType;
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
    if (!file) throw new Error(`store-check: no encuentro ${basename} en el proyecto generado`);
    const declared = /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'));
    if (!declared) throw new Error(`store-check: ${basename} no declara paquete`);
    packages[key] = declared[1];
  }
  return packages;
}

/**
 * El motor tarda en aceptar conexiones; se sondea con el comando que declara el CATÁLOGO.
 *
 * Escribirlo aquí ataría el runner a un motor: con cualquier otro, el sondeo no daría 0 nunca y
 * la pasada moriría a los 90 s sin haber ejecutado ni una aserción. Ese rojo no distingue «el
 * motor no arrancó» de «este runner no sabe preguntárselo», que es la peor forma de fallar.
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

/** Lee el XML de JUnit de cada clase escrita y devuelve [{ name, ok, detail }]. */
function readResults(projectDir, clases) {
  const dir = path.join(projectDir, 'build/test-results/test');
  if (!fs.existsSync(dir)) return [];
  const cases = [];
  for (const clase of clases) {
    const file = fs.readdirSync(dir).find((name) => name.includes(clase.className) && name.endsWith('.xml'));
    if (!file) continue;
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    // Un `<testcase .../>` cerrado en sí mismo pasó; uno con hijos trae el <failure>.
    const re = /<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const body = match[3] ?? '';
      const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(body);
      cases.push({
        name: `${clase.className.replace('StoreCheckTest', '')}.${match[1].replace(/\(\)$/, '')}`,
        ok: !failure,
        detail: failure ? decodeEntities(failure[2]).split('\n')[0].slice(0, 240) : ''
      });
    }
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
const { projectDir, subjects, clases, probe, engine, container } = prepared;

console.log(`store-check · ${fixture} (${engine}) · ${runtimeInfo.runtime}`);
console.log(
  `  mecanismos ejercitados: ${[
    ...(subjects.outbox ? ['relay del outbox'] : []),
    ...(subjects.commandIdempotency ? ['almacén de claves de petición'] : []),
    ...(subjects.dedupe ? ['deduplicación de consumo'] : []),
    ...(subjects.reconciliation ? [`reclamo de reconciliación (${subjects.reconciliation.activation})`] : [])
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
    const gradle = run('sh', ['gradlew', 'test', '--tests', TEST_GLOB, '--console=plain', '--no-daemon'], {
      cwd: projectDir
    });

    const cases = readResults(projectDir, clases);
    if (cases.length === 0) {
      // Sin XML no hay veredicto: o no compiló, o el contexto de Spring no arrancó —y eso último
      // ya es un hallazgo, porque Hibernate valida los @Query al arrancar.
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
        path.join(here, '..', 'store-check.json'),
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
