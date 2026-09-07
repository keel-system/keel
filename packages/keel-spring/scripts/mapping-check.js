#!/usr/bin/env node
// Conformidad EN VIVO del ESPEJO de persistencia: que la columna —o el campo— que el diseño pidió
// sea el que el motor guarda.
//
// Es el sexto runner de conformidad, detrás de broker-check, mail-check, mongo-check, claim-check
// y store-check, y cubre la superficie generada más grande que seguía sin red propia: el mapeo.
// Su red era COMPILAR, y una anotación incompleta compila. El defecto está documentado y ya
// ocurrió: una columna compuesta a mano «se quedaba en el nombre y perdía nullable, length,
// precision/scale y columnDefinition», que es lo único que llega al DDL.
//
// **Dos ramas, dos sujetos, y no es simetría por gusto.**
//
//   relacional  La COTA de la columna. El motor la responde sin ambigüedad: o rechaza la
//               escritura o no la rechaza. Si el @Column perdió su length, la columna es
//               varchar(255) y el servicio ACEPTA lo que el diseño declaró imposible — sin que
//               falle nada.
//   documental  El NOMBRE con el que se guarda el campo. En Mongo la cota no la impone el
//               almacén, así que medirla sería medir Bean Validation. Lo que sí es del mapeo es
//               que el Update del reclamo —que nombra la PROPIEDAD JAVA— acabe escribiendo el
//               @Field. Si no, hay un campo PARALELO en camelCase: el reloj real queda nulo y el
//               rescate no encuentra jamás una fila atascada.
//
// **Lo que se descartó, y por qué.** El primer sujeto candidato fue el desempate de la
// paginación, el otro defecto silencioso famoso de esta capa. Se descartó por método: sin
// desempate el orden que devuelve el motor es ARBITRARIO, no incorrecto, así que un caso que
// buscara la fila repetida saldría verde por suerte más veces de las que saldría rojo — y un check
// que solo falla a veces enseña a ignorarlo.
//
//   node packages/keel-spring/scripts/mapping-check.js [fixture] [--database=<motor>] [--keep]
//   npm run mapping-check --workspace packages/keel-spring
//
// Necesita podman o docker, y JDK.

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
import { mappingSubject, mappingTestClass, hasSubject, PACKAGE_LEAF, CLASS_NAME } from '../src/lib/mapping-probes.js';
import { requiredLiterals } from '../src/lib/claim-probes.js';
import { databaseHealthProbe } from '../src/lib/stack-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'product-catalog';
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
  const subject = mappingSubject(model);
  if (!hasSubject(subject)) {
    throw new Error(
      `la fixture '${fixture}' no tiene ningún campo de texto obligatorio con cota declarada: no hay columna que medir`
    );
  }

  // Sin `--keep` el temporal cuelga de `tmpDir()` y lo barre el propio proceso al salir, también
  // si el runner muere a mitad. Con `--keep` la promesa es que el proyecto SIGA ahí, así que ahí
  // no puede colgar de un directorio autolimpiable.
  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-store-keep-')) : tmpDir('keel-mapping-check-');
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
  // El paquete de cada clase se LEE del proyecto generado, no se supone: si el scaffold
  // reorganiza el layout, este runner lo sigue en vez de escribir un import que no existe.
  // Los paquetes que cada rama necesita: el espejo y su repositorio en la relacional; el
  // documento y el ADAPTADOR en la documental, porque ahí lo que se ejecuta es el reclamo.
  const wanted =
    subject.kind === 'document'
      ? { documents: `${subject.entity.name}Document.java`, adapters: `${subject.entity.name}RepositoryImpl.java` }
      : { entities: `${subject.entity.name}Jpa.java`, jpaRepositories: `${subject.entity.name}JpaRepository.java` };
  const packages = resolvePackages(projectDir, wanted);

  // La MISMA derivación de «qué hay que rellenar para que la fila entre» que usan claim-check y
  // store-check: una segunda copia de esa regla se separaría el día que una fixture añada un campo
  // obligatorio, y el síntoma se disfrazaría de «el motor rechazó» — justo lo que aquí se mide.
  //
  // Lo que se reserva cambia con la rama: en la relacional, el campo cuya cota se mide (lo pone
  // cada caso); en la documental, el ESTADO y el reloj, que los pone la siembra del reclamo.
  const literales =
    subject.kind === 'document'
      ? requiredLiterals({ entity: subject.entity, statusField: subject.statusField }, subject.javaName, null)
      : requiredLiterals({ entity: subject.entity, statusField: null }, null, subject.field.name);

  const clases = [mappingTestClass(model, subject, { datasource, packages, requiredLiterals: literales })];
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

  return { projectDir, subject, clases, probe, engine, container: `${service.manifest.service.name}-db` };
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
    if (!file) throw new Error(`mapping-check: no encuentro ${basename} en el proyecto generado`);
    const declared = /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'));
    if (!declared) throw new Error(`mapping-check: ${basename} no declara paquete`);
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
const { projectDir, subject, clases, probe, engine, container } = prepared;

console.log(`mapping-check · ${fixture} (${engine}) · ${runtimeInfo.runtime}`);
console.log(
  subject.kind === 'document'
    ? `  campo medido: ${subject.entity.name}.${subject.javaName} · nombre almacenado ${subject.storedName}`
    : `  columna medida: ${subject.entity.name}.${subject.field.name} · cota declarada ${subject.maxLength}`
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
    const gradle = run('sh', ['gradlew', 'test', '--tests', `*${CLASS_NAME}`, '--console=plain', '--no-daemon'], {
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
        path.join(here, '..', 'mapping-check.json'),
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
