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
// Necesita podman o docker. No necesita JDK.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { tmpDir } from '../test/helpers/tmp.js';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService, resolveStack } from '../src/scaffold/index.js';
import { indexSubject, substrateSql, assertions, statementsOf, opacityQuery } from '../src/lib/index-probes.js';
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
  if (service.layers.persistence?.default?.model === 'document') {
    // La rama documental tiene su propio mecanismo (`partialFilterExpression` en
    // MongoIndexConfig) y su propia red: no hay appendix de SQL que ejecutar aquí.
    throw new Error(`la fixture '${fixture}' es documental: su índice condicionado lo mide mongo-check`);
  }

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
    projectDir,
    spec,
    appendix,
    opacity: opacityQuery(database, spec),
    statements,
    argv,
    container: `${service.manifest.service.name}-db`,
    probe: databaseHealthProbe(database, dbName)
  };
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

console.log(`index-check · ${fixture} (${database}) · ${runtimeInfo.runtime}`);
console.log(`  índice: ${prepared.spec.name} · ${prepared.statements.length} sentencia(s) en el appendix\n`);

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
    fatal = `${database} no aceptó conexiones en ${prepared.probe.budgetSeconds} s`;
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
      if (!prepared.opacity) {
        cases.push({
          name: `opacidad · ${database} no sabe decir si el índice es opaco a la introspección JDBC`,
          ok: false,
          detail: 'sin consulta de opacidad en index-probes.js, este motor no puede contrastar nada'
        });
      } else {
        const answer = sql(prepared.opacity);
        // Se exige un NÚMERO: una respuesta que no lo sea (o vacía) no es «cero opacas», es que la
        // consulta no midió nada — y eso tiene que ser rojo, no un verde por omisión.
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
  console.log(`  ${c.ok ? 'OK  ' : 'KO  '}${c.name}`);
  if (!c.ok && c.detail) console.log(`        ${c.detail}`);
}

const failures = cases.filter((c) => !c.ok).length;
console.log(`\n  ${cases.length - failures}/${cases.length} en verde${fatal ? ` · ${fatal}` : ''}`);

fs.writeFileSync(
  path.join(here, '..', 'index-check.json'),
  `${JSON.stringify({ ...verdictStamp(), fixture, database, index: prepared.spec.name, fatal, cases }, null, 2)}\n`
);

if (fatal) process.exit(2);
process.exit(failures > 0 ? 1 : 0);
