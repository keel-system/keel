#!/usr/bin/env node
// Conformidad EN VIVO del índice único CONDICIONADO: que la garantía que el diseño declaró
// —«como máximo una fila por esta clave mientras esté en este estado»— la sostenga el motor.
//
// Es el séptimo runner de conformidad, detrás de broker-check, mail-check, mongo-check,
// claim-check, store-check y mapping-check, y cubre el último mecanismo del eje de MOTOR cuya
// única red era una corrida en vivo: un instrumento que no es determinista, no corre en CI y
// solo mide el motor que esa corrida eligió.
//
// **Por qué no bastaba con leerlo.** El appendix `db/partial-indexes.sql` no pasa por ninguna de
// las redes que ya existen: los tests comparan cadenas, `java-syntax` tokeniza Java, `javac` no
// ve SQL, y el arnés de integración no lo ejercita porque el perfil `test` corre sobre H2, que no
// sabe ejecutarlo. Y el modo de fallo es el silencioso de siempre — un índice que se crea sin
// error y no casa con ninguna fila deja el invariante sin efecto, y la ausencia de un rechazo no
// falla ninguna aserción. Pasó, y durante meses: el predicado iba en minúsculas contra una
// columna que guarda la constante del enum, así que el índice indexaba cero filas.
//
// **No arranca la aplicación**, como broker-check, mail-check y mongo-check: lo que mide es DDL y
// DML, así que no necesita JDK. Cubre exactamente lo que es 100% de `build`.
//
// **Lo que NO cubre, y conviene decirlo:** el appendix tiene dos consumidores —`spring.sql.init`
// en los perfiles con ddl-auto, que es el camino que esta red reproduce (todas las sentencias
// sobre una conexión), y el baseline de Flyway, al que `infra/export-schema.sh` lo añade—. El
// segundo exige arrancar el servicio con `PROFILE=local,migrations` sobre un volumen limpio, que
// es la misma prueba que el pase de calidad devuelve como `baselineTested: PENDING` y que hace el
// diseñador. Esa frontera es anterior a esta red y no la mueve.
//
// ─── Falsado ─────────────────────────────────────────────────────────────────
//
// Medido el 2026-09-08 contra mysql:8.0.46, rompiendo el generador de dos formas que CONSERVAN la
// forma (el índice se sigue creando sin error, y todo gate estático sigue verde):
//
//   · quitándole al índice su parte funcional —o sea emitiendo la constraint única normal, que es
//     lo que un motor sin índices parciales invita a hacer— cae `historia`: la versión histórica
//     se rechaza con el 1062 del propio índice. Es la mutación que separa el invariante declarado
//     de su CONTRARIO, y ninguna otra red la ve;
//   · haciendo que el guardia pregunte por un nombre de índice distinto del que crea, cae
//     `idempotencia` en la SEGUNDA pasada, con «Duplicate key name». La primera sigue verde, que
//     es justo por lo que hay que ejecutarlo dos veces: es un defecto que no existe hasta el
//     segundo arranque del servicio.
//
//   node packages/keel-spring/scripts/index-check.js [fixture] [--database=<motor>] [--keep]
//   npm run index-check --workspace packages/keel-spring
//
// Necesita podman o docker. La rama RELACIONAL no necesita JDK: el appendix es un `.sql` que el
// motor sabe ejecutar solo. La DOCUMENTAL sí, y no es un descuido — ahí el índice no vive en un
// fichero de datos sino en `MongoIndexConfig.java`, y la única forma de no medir una copia de sí
// mismo es ejecutar la clase generada. Ver src/lib/document-index-probes.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService, resolveStack } from '../src/scaffold/index.js';
import {
  indexSubject,
  substrateSql,
  assertions,
  statementsOf,
  opacityOf,
  documentIndexSubject,
  documentAssertions
} from '../src/lib/index-probes.js';
import { documentIndexTestClass, CLASS_NAME, LITERAL_CASE } from '../src/lib/document-index-probes.js';
import { DATABASES, databaseHealthProbe } from '../src/lib/stack-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');
const APPENDIX = 'src/main/resources/db/partial-indexes.sql';

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

/**
 * El motor tarda en aceptar conexiones; se sondea con el comando que declara el CATÁLOGO —la
 * misma tabla que usa el `depends_on` de `deploy/`—. Escribirlo aquí ataría el runner a un motor,
 * y con cualquier otro moriría a los 90 s sin haber ejecutado ni una aserción: un rojo que no
 * distingue «el motor no arrancó» de «este runner no sabe preguntárselo».
 */
function waitForDatabase(runtime, container, probe) {
  const deadline = Date.now() + probe.budgetSeconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const result = run(runtime, ['exec', container, ...probe.argv]);
    if (result.status === 0) return true;
    last = (result.stderr || result.stdout).trim().split('\n').at(-1) ?? '';
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probe.intervalSeconds * 1000);
  }
  if (last) console.error(`  último error del sondeo: ${last}`);
  return false;
}

// ─── El cliente, por la misma vía que el arnés ───────────────────────────────

/**
 * Ejecuta una sentencia con el argv que declara el CATÁLOGO (`cliQueryArgv`), que es el mismo del
 * que salen el sondeo de `validate-infra.sh` y las secciones SQL del arnés. Un runner con su
 * propio cliente comprobaría que el motor responde, no que el generador acierta.
 *
 * Devuelve `{ ok, detail, value }` en vez de lanzar: aquí un fallo del motor no siempre es un
 * fallo del check — la mitad de las aserciones esperan justamente que la sentencia sea RECHAZADA.
 *
 * `value` es lo que RESPONDIÓ, y sale de stdout a solas. Mezclarlo con stderr es el error que ya
 * costó una pasada en rojo: el cliente de MySQL escribe «Using a password on the command line
 * interface can be insecure» por stderr en CADA invocación, así que la última línea del texto
 * concatenado es el aviso y no el número — y `Number(aviso)` es NaN, que se lee como «cero» y da
 * un verde (o un rojo) que no dice nada del motor. Es el mismo modo de fallo que `mongoEval`
 * leyendo cadena vacía como cero. `detail` sí los junta: ahí lo que se quiere es el diagnóstico.
 */
function makeSql({ runtime, container, argv }) {
  const lastLine = (text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  return (statement) => {
    const result = run(runtime, ['exec', '-i', container, ...argv, statement]);
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.status === 0 && !/^ERROR/m.test(output),
      detail: lastLine(output),
      value: lastLine(result.stdout)
    };
  };
}

// Sello del veredicto: cuándo se emitió y sobre QUÉ árbol. Sin él, un artefacto rojo de un
// borrador anterior es indistinguible de un veredicto recién emitido.
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
  if ((service.layers.persistence?.default?.model ?? 'relational') === 'document') return prepareDocument(service);

  const stack = resolveStack({ database }, service.layers, service.manifest);
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
  model.stack = stack;
  const spec = indexSubject(model);
  if (!spec) {
    throw new Error(
      `la fixture '${fixture}' no declara ninguna unicidad condicionada (indexes con 'when'): no hay índice que medir`
    );
  }

  const workspace = tmpDir('keel-index-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  // El appendix se guarda ENTERO: el runner lo manda de una pieza, sobre una sola conexión, como
  // hace `spring.sql.init`. Ver `statementsOf` — partirlo aquí rompería MySQL, cuyas sentencias
  // se comunican por una variable de usuario que muere con la sesión.
  const appendix = fs.readFileSync(path.join(projectDir, APPENDIX), 'utf8');
  const statements = statementsOf(appendix);
  if (statements.length === 0) {
    throw new Error(
      `sobre ${database} el appendix no trae ninguna sentencia: el motor no sostiene la unicidad condicionada ` +
        '(es una degradación anunciada, no un fallo — mírala en `npm run matrix`)'
    );
  }

  const dbName = service.manifest.service.name.replaceAll('-', '_');
  const entry = DATABASES[database];
  const argv = entry.cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName });

  return {
    kind: 'relational',
    engine: database,
    projectDir,
    spec,
    appendix,
    opacity: opacityOf(database, spec),
    statements,
    argv,
    container: `${service.manifest.service.name}-db`,
    probe: databaseHealthProbe(database, dbName),
    headline: `${statements.length} sentencia(s) en el appendix`
  };
}

/**
 * La rama DOCUMENTAL. Cambia el artefacto —una clase Java en vez de un `.sql`— y con él cambia
 * todo lo demás: hay que compilar, así que hace falta JDK, y lo que se ejecuta es el
 * `ApplicationRunner` que build escribió, no una redacción suya en mongosh.
 *
 * El motor NO sale del argumento: lo declara el diseño. `--database=` se ignora aquí.
 */
function prepareDocument(service) {
  if (run('java', ['-version']).status !== 0) {
    throw new Error(
      'la rama documental compila y ejecuta un JUnit dentro del proyecto generado, y no hay java en el PATH'
    );
  }

  const stack = resolveStack({ database: 'mongodb' }, service.layers, service.manifest);
  const model = buildModel({ manifest: service.manifest, layers: service.layers, stack });
  model.stack = stack;
  const spec = documentIndexSubject(model);
  if (!spec) {
    throw new Error(
      `la fixture '${fixture}' no declara ninguna unicidad condicionada (indexes con 'when'): no hay índice que medir`
    );
  }

  // Con `--keep` la promesa es que el proyecto SIGA ahí, así que no puede colgar de un directorio
  // que el propio proceso barre al salir.
  const workspace = keep ? fs.mkdtempSync(path.join(os.tmpdir(), 'keel-index-keep-')) : tmpDir('keel-index-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true, stack });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  // La conexión sale del fichero que build EMITIÓ, no de constantes de aquí: es la misma que usa
  // el proyecto contra su propia infraestructura, y si build la cambia este runner la sigue.
  const db = YAML.parse(fs.readFileSync(path.join(projectDir, 'src/main/resources/parameters/local/db.yaml'), 'utf8'));
  const datasource = { uri: db?.spring?.data?.mongodb?.uri };

  const packages = resolvePackages(projectDir, {
    config: 'MongoIndexConfig.java',
    entities: `${spec.documentClass}.java`,
    ...(spec.whenField?.kind === 'enum' ? { enums: `${spec.whenField.javaType}.java` } : {})
  });

  const clase = documentIndexTestClass(model, spec, { datasource, packages });
  const testFile = path.join(projectDir, 'src/test/java', ...clase.package.split('.'), `${clase.className}.java`);
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, clase.content, 'utf8');

  const dbName = service.manifest.service.name.replaceAll('-', '_');
  return {
    kind: 'document',
    engine: 'mongodb',
    projectDir,
    spec,
    clase,
    container: `${service.manifest.service.name}-db`,
    probe: databaseHealthProbe('mongodb', dbName),
    headline: `${spec.collection} · MongoIndexConfig con partialFilterExpression`
  };
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
    if (!file) throw new Error(`index-check: no encuentro ${basename} en el proyecto generado`);
    const declared = /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'));
    if (!declared) throw new Error(`index-check: ${basename} no declara paquete`);
    packages[key] = declared[1];
  }
  return packages;
}

const decodeEntities = (text) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#10;', ' ')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/**
 * Los nombres con los que se imprime cada caso documental.
 *
 * Los ids de EFECTO son los mismos que en la rama relacional y salen de la misma función: uno que
 * existiera en una rama y no en la otra sería una asimetría silenciosa, que es la forma exacta que
 * tenían los ocho defectos que motivaron la matriz de paridad.
 */
function documentCaseNames(spec) {
  const names = {
    seMideLaBaseDelContenedorYNoUnMongodEmbebido: 'sustrato · se mide la base del contenedor, no un mongod embebido',
    idempotenciaPasada1: 'idempotencia · pasada 1',
    idempotenciaPasada2: 'idempotencia · pasada 2',
    idempotenciaRedespliegue: 'idempotencia · con otra forma ya creada, el fallo llega y nombra el índice',
    [LITERAL_CASE]: `literal · el filtro compara ${spec.partialFilter.path} con ${JSON.stringify(
      spec.partialFilter.equals
    )} y eso es lo que el mapeo guarda`
  };
  for (const assertion of documentAssertions(spec)) names[assertion.id] = `${assertion.id} · ${assertion.title}`;
  return names;
}

/**
 * Ejecuta el JUnit dentro del proyecto generado y traduce su XML a los `cases` del veredicto.
 *
 * Sin XML no hay medición: eso es fatal (exit 2) y no «cero fallos», que es como se cuela una
 * suite que no llegó a compilar.
 */
function measureDocument(prepared) {
  const gradle = run('sh', ['gradlew', 'test', '--tests', `*${CLASS_NAME}`, '--console=plain', '--no-daemon'], {
    cwd: prepared.projectDir
  });
  const dir = path.join(prepared.projectDir, 'build/test-results/test');
  const file = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((name) => name.includes(CLASS_NAME) && name.endsWith('.xml'))
    : null;
  if (!file) {
    const log = `${gradle.stdout}${gradle.stderr}`.trim().split('\n').slice(-40).join('\n');
    throw new Error(`la suite no llegó a ejecutarse:\n${log}`);
  }

  const names = documentCaseNames(prepared.spec);
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  const re = /<testcase[^>]*\bname="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  const cases = [];
  let match;
  while ((match = re.exec(xml)) !== null) {
    const method = match[1].replace(/\(\)$/, '');
    const failure = /<(failure|error)[^>]*message="([^"]*)"/.exec(match[3] ?? '');
    cases.push({
      name: names[method] ?? method,
      ok: !failure,
      detail: failure ? decodeEntities(failure[2]).split('\n')[0].slice(0, 240) : ''
    });
  }

  // La opacidad no tiene gemelo aquí y se dice en voz alta en vez de omitirse: un caso ausente no
  // distingue «no aplica» de «nadie lo miró». Sin Hibernate ni introspección JDBC no hay
  // `DatabaseMetaData#getIndexInfo` que pueda quedarse ciego ante una key part sin nombre.
  cases.push({
    name: 'opacidad · no aplica en mongodb: no hay Hibernate ni introspección JDBC que pueda quedarse ciega',
    ok: true,
    skipped: true,
    detail: ''
  });
  return cases;
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

let prepared;
try {
  prepared = prepare();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

console.log(`index-check · ${fixture} (${prepared.engine}) · ${runtimeInfo.runtime}`);
console.log(`  índice: ${prepared.spec.name} · ${prepared.headline}\n`);

process.stdout.write('  levantando el motor… ');
const up = composeUp(runtimeInfo.frontends, prepared.projectDir);
if (!up.frontend) {
  console.error(`no levanta:\n${up.log}`);
  process.exit(2);
}
console.log(`OK (${up.frontend.command})`);

const cases = [];
let fatal = null;

try {
  if (!waitForDatabase(runtimeInfo.runtime, prepared.container, prepared.probe)) {
    fatal = `${prepared.engine} no aceptó conexiones en ${prepared.probe.budgetSeconds} s`;
  } else if (prepared.kind === 'document') {
    // La rama documental no manda sentencias: compila y ejecuta el JUnit que ejercita la clase
    // generada. Las preguntas son las mismas y los ids de efecto también; lo que cambia es quién
    // las contesta.
    process.stdout.write('  compilando y ejecutando el JUnit… ');
    cases.push(...measureDocument(prepared));
    console.log('OK');
  } else {
    const sql = makeSql({ runtime: runtimeInfo.runtime, container: prepared.container, argv: prepared.argv });

    // El sustrato. Si esto falla no hay check: es preparación, no medición.
    for (const statement of substrateSql(prepared.spec)) {
      const result = sql(statement);
      if (!result.ok) throw new Error(`no se pudo montar la tabla del sustrato: ${result.detail}`);
    }

    // 1) IDEMPOTENCIA. El appendix corre en CADA arranque con continue-on-error: false, así que
    //    se ejecuta DOS veces: la segunda es la que mide el guardia.
    for (const pass of [1, 2]) {
      const result = sql(prepared.appendix);
      cases.push({ name: `idempotencia · pasada ${pass}`, ok: result.ok, detail: result.detail });
    }

    // 2) EL EFECTO. Solo tiene sentido si el índice llegó a existir.
    if (cases.every((c) => c.ok)) {
      for (const assertion of assertions(prepared.spec)) {
        const wrong = assertion.steps
          .map((step) => ({ step, result: sql(step.sql) }))
          .find(({ step, result }) => (step.expect === 'ok') !== result.ok);
        cases.push({
          name: `${assertion.id} · ${assertion.title}`,
          ok: !wrong,
          detail: wrong
            ? wrong.step.expect === 'ok'
              ? `la sentencia tenía que entrar y el motor la rechazó: ${wrong.result.detail}`
              : 'la sentencia tenía que ser RECHAZADA y el motor la aceptó: el invariante no lo sostiene nadie'
            : ''
        });
      }

      // 3) LA OPACIDAD. Se le pregunta al MOTOR si alguna key part del índice que acaba de crear
      //    no tiene nombre de columna, y la respuesta tiene que ser NO.
      //
      //    No es una preferencia de estilo. Un índice opaco a `DatabaseMetaData#getIndexInfo`
      //    hace que Hibernate, con `ddl-auto: update`, aborte la carga del ApplicationContext al
      //    reconciliar sus @UniqueConstraint — y no en el primer arranque, sino en el segundo y en
      //    cada réplica nueva. La única mitigación disponible
      //    (`hibernate.schema_update.unique_constraint_strategy: SKIP`) resultó ser PEOR: en MySQL
      //    los @UniqueConstraint se crean por ALTER TABLE dentro de esa misma reconciliación, así
      //    que saltársela no los conserva, impide que existan. Cambiar un arranque que muere a
      //    gritos por la pérdida silenciosa de la clave natural del agregado no es un arreglo.
      //    Por eso aquí no se admite ni «opaco pero mitigado»: se exige que no sea opaco.
      //
      //    Y tres desenlaces, no dos — ver `opacityOf` en index-probes.js.
      if (!prepared.opacity) {
        cases.push({
          name: `opacidad · ${database} no declara si su índice puede ser opaco a la introspección JDBC`,
          ok: false,
          detail: 'sin declaración en index-probes.js no se sabe, y no saberlo no es lo mismo que estar bien'
        });
      } else if (prepared.opacity.cannotBeOpaque) {
        // Ni verde ni rojo: aquí no hay nada que medir, y contarlo como verde inflaría el marcador
        // con una comprobación que no se hizo. Es el `no-aplica` de la matriz de paridad.
        cases.push({
          name: `opacidad · no aplica en ${database}: ${prepared.opacity.cannotBeOpaque}`,
          ok: true,
          skipped: true,
          detail: ''
        });
      } else {
        const answer = sql(prepared.opacity.query);
        // Se exige un NÚMERO: una respuesta que no lo sea (o vacía) no es «cero opacas», es que
        // la consulta no midió nada — y eso tiene que ser rojo, no un verde por omisión.
        const contadas = Number(answer.value);
        const medido = answer.ok && answer.value !== '' && Number.isInteger(contadas);
        cases.push({
          name: 'opacidad · ninguna key part del índice es opaca a la introspección JDBC',
          ok: medido && contadas === 0,
          detail: !medido
            ? `el motor no respondió un número a la consulta de opacidad: ${answer.detail}`
            : contadas === 0
              ? ''
              : `${contadas} key part(s) sin nombre de columna: con ddl-auto: update el servicio no ` +
                'arranca dos veces, y la mitigación conocida se lleva por delante los @UniqueConstraint'
        });
      }
    }
  }
} catch (error) {
  fatal = error.message;
} finally {
  if (!keep) composeDown(up.frontend, prepared.projectDir);
}

console.log();
for (const c of cases) {
  console.log(`  ${c.skipped ? '--  ' : c.ok ? 'OK  ' : 'KO  '}${c.name}`);
  if (!c.ok && c.detail) console.log(`        ${c.detail}`);
}

// Lo omitido no entra NI en el numerador ni en el denominador: contarlo como verde diría que se
// midió algo que no se midió, que es la forma más barata de inflar un marcador.
const medidos = cases.filter((c) => !c.skipped);
const omitidos = cases.length - medidos.length;
const failures = medidos.filter((c) => !c.ok).length;
console.log(
  `\n  ${medidos.length - failures}/${medidos.length} en verde` +
    (omitidos > 0 ? ` · ${omitidos} no aplica(n)` : '') +
    (fatal ? ` · ${fatal}` : '')
);

fs.writeFileSync(
  path.join(here, '..', 'index-check.json'),
  `${JSON.stringify(
    { ...verdictStamp(), fixture, database: prepared.engine, model: prepared.kind, index: prepared.spec.name, fatal, cases },
    null,
    2
  )}\n`
);

if (fatal) process.exit(2);
process.exit(failures > 0 ? 1 : 0);
