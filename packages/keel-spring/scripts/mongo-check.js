#!/usr/bin/env node
// Conformidad EN VIVO de los scripts de mongosh que emite `build`.
//
// Tercer hermano de broker-check.js y mail-check.js, y el que tiene el argumento más fuerte
// de los tres. En los otros ejes del generador hay una red debajo: `compile-check` compila el
// arnés con javac. Con un script de mongosh **javac no puede ayudar** — el script viaja dentro
// de un literal Java que compone `javaString()`, y esa función escapa siempre, así que un
// `updateOne` con las comillas mal, un `$set` sobre un campo que en el documento se llama de
// otra forma o un `countDocuments` con un predicado que no casa nada salen como literal Java
// perfectamente válido con el script roto dentro. Comprobado rompiéndolo a propósito: compila.
//
// Y lo que un script así produce no es un error, es algo peor: un escenario que pasa en verde
// sin haber probado nada. Un `inFlightWithoutClock` que devuelve siempre cero, un
// `stallInFlight` que no atasca ninguna fila, una espera al drenaje del outbox que vuelve al
// instante porque cuenta cero.
//
// Los scripts NO se escriben aquí: salen de `src/lib/mongo-probes.js`, el mismo módulo del que
// el arnés renderiza su Java. Un runner con scripts propios comprobaría que Mongo responde,
// que no es lo mismo que comprobar que el generador acierta.
//
// **No arranca la aplicación**, a propósito y por la misma razón que sus dos hermanos: el
// `main` recién generado no compila (build deja TODOs para el agente). Lo que sí es 100 % de
// `build` son estos scripts, y es exactamente donde vive el fallo. Los documentos los siembra
// el propio runner.
//
// **Y se ejecutan por la MISMA vía que el arnés**: fichero copiado al contenedor y `mongosh
// <argv sin --eval> /tmp/…`, nunca `--eval`. Ese rodeo existe por un fallo real —las comillas
// no sobreviven al argv en Windows, y mongosh recibe `db.getCollection(x)`—, así que un runner
// que usara `--eval` probaría un camino que nadie recorre.
//
//   node packages/keel-spring/scripts/mongo-check.js [--keep]
//   npm run mongo-check --workspace packages/keel-spring
//
// Salidas: 0 todo OK · 1 hay fallos · 2 la infraestructura no levantó (sin veredicto).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { DATABASES } from '../src/lib/stack-catalog.js';
import {
  OUTBOX,
  CLOCK,
  fill,
  setStateScript,
  ageClockScript,
  missingClockCountScript,
  outboxPendingScript,
  abandonOutboxScript,
  clearAbandonedScript
} from '../src/lib/mongo-probes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const keep = args.includes('--keep');

// El presupuesto agotado del outbox, el mismo valor que emite `abandonOutboxSection`.
const ABANDONED = 1000000;

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

// ─── mongosh, por la misma vía que el arnés ──────────────────────────────────

/**
 * Ejecuta un script copiándolo como FICHERO al contenedor, igual que `mongoEval` en
 * AbstractFlowIT. El argv sale del catálogo (`cliQueryArgv` sin `--eval`), así que si alguien
 * cambia la cadena de conexión o los flags, este runner los sigue.
 */
function makeEval({ runtime, container, argv }) {
  // El temporal cuelga de `tmpDir()` y no de `os.tmpdir()` a pelo: lo que cuelga de ahí lo
  // barre el propio proceso al salir, también cuando el runner muere a mitad de un escenario.
  const local = path.join(tmpDir('keel-mongo-eval-'), 'keel-check.js');
  return (script) => {
    fs.writeFileSync(local, script, 'utf8');
    const copy = run(runtime, ['cp', local, `${container}:/tmp/keel-check.js`]);
    if (copy.status !== 0) throw new Error(`no se pudo copiar el script al contenedor: ${copy.stderr.trim()}`);
    const result = run(runtime, ['exec', '-i', container, ...argv, '/tmp/keel-check.js']);
    if (result.status !== 0) {
      throw new Error(`mongosh falló: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    return result.stdout.trim();
  };
}

// Sello del veredicto: cuándo se emitió y sobre QUÉ árbol. Sin él, un artefacto rojo de un
// borrador anterior es indistinguible de un veredicto recién emitido — que es exactamente lo que
// pasó con `mongo-check.json` el 2026-09-01: el rojo era de la versión de hace tres minutos.
function verdictStamp() {
  const head = run('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']);
  return {
    generatedAt: new Date().toISOString(),
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null
  };
}

const jsonOf = (text) => JSON.parse(text);

// ─── Preparación de una fixture ──────────────────────────────────────────────

function prepare(fixture, runtimeInfo) {
  const service = loadService(path.join(fixturesDir, fixture));
  if (service.errors.length > 0) throw new Error(`la fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);
  if (service.layers.persistence?.default?.model !== 'document') {
    throw new Error(`la fixture '${fixture}' no es documental: no hay mongosh que comprobar`);
  }

  const workspace = tmpDir('keel-mongo-check-');
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  const projectDir = path.join(workspace, 'services', projectName);

  const dbName = service.manifest.service.name.replaceAll('-', '_');
  const entry = DATABASES.mongodb;
  const argv = entry
    .cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName })
    .filter((part) => part !== '--eval');

  return { projectDir, container: `${service.manifest.service.name}-db`, argv, dbName };
}

async function waitForMongo(evaluate) {
  const deadline = Date.now() + 90000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      // El mismo sondeo que `validate-infra.sh`: rs.status(), no un ping. Una base que
      // responde al ping pero cuyo replica set no ha arrancado falla en la primera
      // transacción, que es el falso positivo que este sondeo existe para evitar.
      if (evaluate('print(rs.status().ok)') === '1') return true;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error(`  último error del sondeo: ${last}`);
  return false;
}

// ─── Escenarios ──────────────────────────────────────────────────────────────

const results = [];

async function check(id, title, fn) {
  try {
    await fn();
    results.push({ id, title, ok: true, detail: '' });
    console.log(`  OK   ${id} ${title}`);
  } catch (error) {
    results.push({ id, title, ok: false, detail: error.message });
    console.log(`  KO   ${id} ${title} — ${error.message}`);
  }
}

/** El id con el que el arnés compone `UUID("…")`: el mismo formato que produce Java. */
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

async function rescueScenarios(evaluate) {
  const jobs = { collection: 'jobs', stateField: 'status', state: 'RUNNING', clockField: 'running_since' };
  const seed = () =>
    evaluate(`
      db.getCollection("jobs").deleteMany({});
      db.getCollection("jobs").insertMany([
        { _id: UUID("${ID}"), reference: "a", status: "QUEUED" },
        { _id: UUID("${OTHER_ID}"), reference: "b", status: "QUEUED" }
      ]);
      print("ok");
    `);
  const readJob = (id) =>
    jsonOf(evaluate(`print(JSON.stringify(db.getCollection("jobs").findOne({ _id: UUID("${id}") })))`));

  // El transporte, primero: si esto cae, todo lo demás miente. Un script con comillas dobles
  // que llegara mutilado daría `ReferenceError`, no un resultado incorrecto — pero el arnés
  // solo vería una excepción sin relación con el servicio.
  await check('MONGO-1', 'un script con comillas dobles llega intacto y devuelve lo que debe', () => {
    const out = evaluate('print(db.getCollection("una_coleccion_que_no_existe").countDocuments({ x: "y" }))');
    if (out !== '0') throw new Error(`salida inesperada: ${JSON.stringify(out)} (¿se comieron las comillas?)`);
  });

  await check('MONGO-2', 'el literal UUID("…") CASA con el documento sembrado', () => {
    if (seed() !== 'ok') throw new Error('la siembra no confirmó');
    const found = readJob(ID);
    if (!found) {
      throw new Error('UUID("…") no encuentra el documento: un updateOne con este id modificaría CERO sin fallar');
    }
  });

  await check('MONGO-3', 'atascar deja el estado Y el reloj que el rescate busca', () => {
    seed();
    evaluate(fill(setStateScript({ ...jobs, clock: CLOCK.stale }), ID));
    const found = readJob(ID);
    if (found.status !== 'RUNNING') throw new Error(`estado ${JSON.stringify(found.status)}, esperaba RUNNING`);
    // Se lee el campo POR SU NOMBRE: un $set sobre un nombre equivocado no falla, crea otro.
    if (found.running_since === undefined) {
      throw new Error(`no hay running_since; el documento quedó: ${JSON.stringify(found)}`);
    }
    const stamped = new Date(found.running_since.$date ?? found.running_since).getTime();
    if (stamped !== 0) throw new Error(`el reloj rancio vale ${found.running_since}, esperaba la época`);
  });

  await check('MONGO-4', 'y el reloj a AHORA es distinto del rancio', () => {
    seed();
    evaluate(fill(setStateScript({ ...jobs, clock: CLOCK.now }), ID));
    const found = readJob(ID);
    const stamped = new Date(found.running_since.$date ?? found.running_since).getTime();
    if (stamped === 0) throw new Error('putInFlight estampó la época: sería el mismo helper que stallInFlight');
    if (Math.abs(Date.now() - stamped) > 120000) {
      throw new Error(`el reloj «a ahora» vale ${found.running_since}: no es el instante de la escritura`);
    }
  });

  // La discriminación. Un predicado que devolviera siempre cero pasa el escenario del rescate
  // sin ver el defecto para el que existe — la fila que se quedó en vuelo SIN reloj, que es
  // irrescatable para siempre.
  await check('MONGO-5', 'el conteo de las que quedaron sin reloj discrimina', () => {
    evaluate(`
      db.getCollection("jobs").deleteMany({});
      db.getCollection("jobs").insertMany([
        { _id: UUID("${ID}"), reference: "sin-reloj", status: "RUNNING", running_since: null },
        { _id: UUID("${OTHER_ID}"), reference: "con-reloj", status: "RUNNING", running_since: new Date() },
        { reference: "en-cola", status: "QUEUED" }
      ]);
      print("ok");
    `);
    const count = evaluate(`print(${missingClockCountScript(jobs)})`);
    if (count !== '1') {
      throw new Error(`cuenta ${JSON.stringify(count)} con 1 sin reloj, 1 con reloj y 1 en cola: el predicado no discrimina`);
    }
  });
}

async function outboxScenarios(evaluate) {
  const pending = outboxPendingScript();
  const DEST = 'asset-vault.events';
  const OTHER_DEST = 'otro.events';
  const seed = () =>
    evaluate(`
      db.getCollection("${OUTBOX.collection}").deleteMany({});
      db.getCollection("${OUTBOX.collection}").insertMany([
        { ${OUTBOX.eventType}: "AssetPublished", ${OUTBOX.destination}: "${DEST}", ${OUTBOX.publishedAt}: null, ${OUTBOX.attempts}: 0 },
        { ${OUTBOX.eventType}: "AssetPublished", ${OUTBOX.destination}: "${DEST}", ${OUTBOX.publishedAt}: null, ${OUTBOX.attempts}: 3 },
        { ${OUTBOX.eventType}: "AssetPublished", ${OUTBOX.destination}: "${DEST}", ${OUTBOX.publishedAt}: new Date(), ${OUTBOX.attempts}: 1 },
        { ${OUTBOX.eventType}: "OtroEvento", ${OUTBOX.destination}: "${OTHER_DEST}", ${OUTBOX.publishedAt}: null, ${OUTBOX.attempts}: 0 }
      ]);
      print("ok");
    `);
  const pendingOf = (destination) => evaluate(`print(${fill(pending, destination)})`);

  // Si esto contara de más, la espera al drenaje no terminaría nunca; si contara de menos
  // —o cero—, volvería al instante sin esperar a nada, que es lo que ya pasó consultando por
  // el canal lógico en vez de por el destino físico.
  await check('MONGO-6', 'el conteo del outbox cuenta lo pendiente DE ESE destino', () => {
    seed();
    const mine = pendingOf(DEST);
    if (mine !== '2') throw new Error(`cuenta ${JSON.stringify(mine)} con 2 pendientes, 1 publicado y 1 de otro destino`);
    const other = pendingOf(OTHER_DEST);
    if (other !== '1') throw new Error(`el otro destino cuenta ${JSON.stringify(other)}, esperaba 1`);
  });

  await check('MONGO-7', 'abandonar saca del pendiente, y limpiar borra SOLO lo abandonado', () => {
    seed();
    evaluate(fill(abandonOutboxScript(ABANDONED), 'AssetPublished'));
    // El relay deja de reclamarlas, pero siguen sin publicar: el conteo de pendientes no las
    // ve porque el gauge las cuenta aparte, y ese es justo el desenlace que el escenario del
    // dead-letter afirma.
    const abandoned = evaluate(
      `print(db.getCollection("${OUTBOX.collection}").countDocuments({ ${OUTBOX.attempts}: { $gte: ${ABANDONED} } }))`
    );
    if (abandoned !== '2') throw new Error(`abandonó ${JSON.stringify(abandoned)} de 2 pendientes de ese tipo`);
    const otherStill = pendingOf(OTHER_DEST);
    if (otherStill !== '1') throw new Error('abandonar se llevó por delante eventos de otro tipo');

    evaluate(clearAbandonedScript(ABANDONED));
    const left = evaluate(`print(db.getCollection("${OUTBOX.collection}").countDocuments({}))`);
    // Quedan el publicado y el pendiente del otro destino: limpiar solo retira lo abandonado.
    if (left !== '2') throw new Error(`tras limpiar quedan ${JSON.stringify(left)} documentos, esperaba 2`);
  });

  await check('MONGO-8', 'la purga del catálogo vacía los documentos y PRESERVA los índices', () => {
    seed();
    evaluate(`db.getCollection("${OUTBOX.collection}").createIndex({ ${OUTBOX.destination}: 1 }, { name: "ix_check" });print("ok")`);
    const reset = DATABASES.mongodb.cliResetCmd;
    const script = reset.slice(reset.indexOf("--eval '") + 8, reset.lastIndexOf("'"));
    evaluate(`${script};print("ok")`);

    const left = evaluate(`print(db.getCollection("${OUTBOX.collection}").countDocuments({}))`);
    if (left !== '0') throw new Error(`quedan ${JSON.stringify(left)} documentos tras la purga`);
    const indexes = evaluate(
      `print(db.getCollection("${OUTBOX.collection}").getIndexes().map(function (ix) { return ix.name; }).join(","))`
    );
    if (!indexes.includes('ix_check')) {
      throw new Error(`la purga se llevó los índices (quedan: ${indexes}): sería un dropDatabase, no un reset`);
    }
  });
}

/**
 * Envejecer la marca de espera de un barrido de reconciliación.
 *
 * Es la última de las precondiciones que el arnés FABRICA en vez de esperar, y la que llegó
 * tarde: mientras el gate de `reconciliationAgingSection` fue el del eje relacional
 * (`staleTimestamp` + `uuidLiteral`, dos literales SQL que Mongo no declara), un diseño
 * documental con `reconciledBy` se quedaba sin el helper EN SILENCIO y no podía tener el
 * escenario que `crossrefs.js` le exige.
 *
 * Lo que se mide aquí es lo que javac no puede: que el `$set` CASE. Un nombre de campo
 * equivocado no falla —crea otro campo—, y entonces el barrido no ve candidato, el `Then`
 * espera su tick y el escenario pasa en verde sin haber envejecido nada.
 */
async function agingScenarios(evaluate) {
  // Colección y campo del diseño de asset-vault: `scanAsset.awaitingSince = lastScannedAt`
  // sobre el agregado Asset, que se almacena en `assets` con `@Field(name = "last_scanned_at")`.
  const assets = { collection: 'assets', clockField: 'last_scanned_at' };
  const seed = () =>
    evaluate(`
      db.getCollection("assets").deleteMany({});
      db.getCollection("assets").insertMany([
        { _id: UUID("${ID}"), slug: "envejecido", status: "PUBLISHED", last_scanned_at: new Date() },
        { _id: UUID("${OTHER_ID}"), slug: "intacto", status: "PUBLISHED", last_scanned_at: new Date() }
      ]);
      print("ok");
    `);
  const readAsset = (id) =>
    jsonOf(evaluate(`print(JSON.stringify(db.getCollection("assets").findOne({ _id: UUID("${id}") })))`));
  const millis = (value) => new Date(value?.$date ?? value).getTime();

  await check('MONGO-9', 'envejecer la marca de espera CASA con el documento y discrimina', () => {
    if (seed() !== 'ok') throw new Error('la siembra no confirmó');
    evaluate(fill(ageClockScript(assets), ID));

    const aged = readAsset(ID);
    // Se lee el campo POR SU NOMBRE, igual que en MONGO-3: un $set sobre un nombre que no
    // existe no falla, crea otro campo y deja el original donde estaba.
    if (aged.last_scanned_at === undefined) {
      throw new Error(`no hay last_scanned_at; el documento quedó: ${JSON.stringify(aged)}`);
    }
    if (millis(aged.last_scanned_at) !== 0) {
      throw new Error(`la marca vale ${JSON.stringify(aged.last_scanned_at)}, esperaba la época`);
    }
    // Y que no haya nacido un campo nuevo al lado del que se quería tocar, que es exactamente
    // el modo de fallo silencioso: el barrido seguiría sin candidato y nadie se enteraría.
    const extra = Object.keys(aged).filter((key) => /scanned/i.test(key) && key !== 'last_scanned_at');
    if (extra.length > 0) {
      throw new Error(`el $set creó campos nuevos en vez de tocar el existente: ${extra.join(', ')}`);
    }

    // La discriminación: envejecer UNA fila es lo que hace quirúrgico al escenario. Bajar el
    // umbral por configuración es global y se lleva por delante las filas de los demás.
    const untouched = readAsset(OTHER_ID);
    if (millis(untouched.last_scanned_at) === 0) {
      throw new Error('envejecer una fila envejeció también la vecina: el filtro por _id no discrimina');
    }
  });
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

const PLAN = [
  { fixture: 'job-dispatch-mongo', scenarios: rescueScenarios },
  {
    fixture: 'asset-vault',
    // Dos tandas sobre el mismo Mongo: levantar el contenedor es lo caro, y las dos miran
    // scripts que el arnés de esta misma fixture emite.
    scenarios: async (evaluate) => {
      await outboxScenarios(evaluate);
      await agingScenarios(evaluate);
    }
  }
];

let fatal = null;

for (const { fixture, scenarios } of PLAN) {
  let prepared = null;
  let frontend = null;
  try {
    prepared = prepare(fixture, runtimeInfo);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  console.log(`\n${fixture}`);
  process.stdout.write('  levantando Mongo… ');
  const up = composeUp(runtimeInfo.frontends, prepared.projectDir);
  if (!up.frontend) {
    console.error(`no levanta:\n${up.log}`);
    process.exit(2);
  }
  frontend = up.frontend;
  console.log(`OK (${up.frontend.command})`);

  const evaluate = makeEval({
    runtime: runtimeInfo.runtime,
    container: prepared.container,
    argv: prepared.argv
  });

  try {
    if (!(await waitForMongo(evaluate))) {
      fatal = `${fixture}: Mongo no llegó a servir en 90 s`;
      console.error(`  ${fatal}`);
    } else {
      await scenarios(evaluate);
    }
  } finally {
    if (!keep) composeDown(frontend, prepared.projectDir);
    else console.log(`  (--keep) proyecto en ${prepared.projectDir}`);
  }
  if (fatal) break;
}

console.log('\nMatriz de escenarios');
for (const result of results) console.log(`  ${result.id}  ${result.ok ? 'OK' : 'KO'}  ${result.title}`);

fs.writeFileSync(
  path.join(process.cwd(), 'mongo-check.json'),
  JSON.stringify({ ...verdictStamp(), results, fatal }, null, 2),
  'utf8'
);

if (fatal) process.exit(2);
process.exit(results.some((result) => !result.ok) ? 1 : 0);
