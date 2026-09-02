// Que el par `job-dispatch` / `job-dispatch-mongo` siga siendo el sujeto que compila el
// rescate — en sus DOS modelos de persistencia.
//
// Ninguna otra fixture genera un reclamo de rescate, así que ni `compile-check` ni
// `java-syntax.test.js` miraban ese Java: el reclamo con su cota temporal, su @Value y los
// tres helpers del arnés se apoyaban solo en comparaciones de cadenas sobre modelos
// sintéticos. Con estas dos, `java-syntax` tokeniza las dos ramas y `compile-check` compila
// con javac la mitad que puede —el arnés—, porque `main` recién generado no compila a
// propósito: build deja ahí los TODO del agente. Dos veces esta semana lo que pasó todos
// los `includes(...)` lo cazó javac —una excepción comprobada y unas comillas de mongosh—,
// y el verde de esa zona no distinguía «no hay errores» de «no mira».
//
// Este archivo es el nivel de arriba de ese mismo fallo. `java-syntax.test.js` y el script
// de `compile-check` nombran las fixtures, pero ninguno comprueba que sigan teniendo la
// forma por la que se añadieron: basta con quitarles el reloj `runningSince`, o con
// volverlas el `reconciledBy` de una activación, para que build deje de generar el rescate
// y los dos comprobadores sigan en verde compilando un proyecto que ya no lo lleva. La
// cobertura se evaporaría sin que nada lo dijera.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService } from '../src/scaffold/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SWEEP = 'dispatchJobs';

const RELACIONAL = { fixture: 'job-dispatch', database: 'postgresql' };
const DOCUMENTAL = { fixture: 'job-dispatch-mongo', database: 'mongodb' };
const AMBAS = [RELACIONAL, DOCUMENTAL];

function load(fixture) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  return { manifest, layers };
}

/** Los reclamos que `classifyClaims` le atribuye al barrido. */
function claimsOf({ fixture, database }) {
  const { manifest, layers } = load(fixture);
  const model = buildModel({ manifest, layers, stack: { database } });
  const sweep = model.services
    .flatMap((service) => service.operations)
    .find((operation) => operation.name === SWEEP);
  assert.ok(sweep, `${fixture} ya no declara ${SWEEP}`);
  return { sweep, claims: sweep.claim ?? [] };
}

/** Todos los .java del proyecto generado, indexados por nombre de archivo. */
function generate({ fixture }) {
  const { manifest, layers } = load(fixture);
  const workspace = tmpDir('keel-rescue-shape-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, result.outDir);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const files = new Map(walk(root).map((file) => [path.basename(file), fs.readFileSync(file, 'utf8')]));
  return (name) => {
    const content = files.get(name);
    assert.ok(content !== undefined, `${fixture} ya no genera ${name}`);
    return content;
  };
}

// ── Lo que las dos comparten: la forma del diseño ────────────────────────────

for (const caso of AMBAS) {
  test(`${caso.fixture}: el barrido sigue produciendo las DOS clases de reclamo`, () => {
    const { sweep, claims } = claimsOf(caso);
    assert.equal(sweep.sweep, true);

    // Una COLA: `queued` no es destino de ninguna transición del lifecycle, así que las
    // filas se acumulan ahí y el barrido se lleva el lote entero.
    const queue = claims.find((claim) => !claim.stalled);
    assert.ok(queue, 'desapareció el reclamo de la cola');
    assert.deepEqual(queue.from, ['queued']);

    // EN VUELO: a `running` sí se llega, así que puede haber otra réplica trabajando en
    // esas filas ahora mismo. Ese es el reclamo que ninguna otra fixture genera, y el
    // único motivo por el que estas dos existen.
    const rescue = claims.find((claim) => claim.stalled);
    assert.ok(rescue, 'desapareció el RESCATE: la fixture dejó de cubrir lo que vino a cubrir');
    assert.equal(rescue.stalled.state, 'running');
    assert.equal(rescue.stalled.stampField, 'runningSince', 'el rescate se quedó sin reloj que medir');
  });

  // El agujero que una corrida destapó: si el reclamo de la cola mueve la fila a `running`
  // sin estampar el reloj en el MISMO update, la que caiga en esa ventana queda
  // irrescatable para siempre —quien la busca filtra por `< :staleBefore`, y con la marca
  // sin estampar esa comparación no es falsa, es indefinida—.
  test(`${caso.fixture}: y el reclamo de la cola estampa el reloj que el rescate va a leer`, () => {
    const queue = claimsOf(caso).claims.find((claim) => !claim.stalled);
    assert.equal(queue.stamps?.field, 'runningSince');
  });

  // El plazo es del generador —la caducidad de un reclamo, no una decisión de negocio—, y
  // por eso vive en `parameters/` en los dos modelos.
  test(`${caso.fixture}: el plazo del rescate sale por parámetro`, () => {
    assert.match(generate(caso)('JobRepositoryImpl.java'), /sweep\.dispatch-jobs-done\.stalled-after-seconds/);
  });
}

// ── Lo que cambia con el modelo, que es todo el motivo del par ────────────────

test('relacional: el reclamo del rescate es un UPDATE condicional sobre el reloj', () => {
  const repository = generate(RELACIONAL)('JobJpaRepository.java');
  assert.match(repository, /@Modifying/);
  assert.match(repository, /claimForStalledDispatchJobsDone/);
  assert.match(repository, /runningSince < :staleBefore/);
});

test('documental: el mismo reclamo es un findAndModify con su Criteria', () => {
  // Aquí no hay JPQL ni @Modifying: el reclamo atómico lo da el propio driver.
  const adapter = generate(DOCUMENTAL)('JobRepositoryImpl.java');
  assert.match(adapter, /public List<Job> claimForStalledDispatchJobsDone\(\)/);
  assert.match(adapter, /Criteria\.where\("status"\)\.in\(List\.of\(JobStatus\.RUNNING\)\)/);
  assert.match(adapter, /\.and\("runningSince"\)\.lt\(staleBefore\)/);
  assert.match(adapter, /mongoTemplate\.findAndModify\(/);
});

// ── La palanca del arnés, que es lo que compila `compile-check` ───────────────

test('relacional: el arnés atasca, pone a ahora y cuenta, hablando SQL', () => {
  const harness = generate(RELACIONAL)('AbstractFlowIT.java');

  // Atascar: el estado exacto en el que queda una réplica que murió con la fila en la mano.
  assert.match(harness, /UPDATE jobs SET status = 'RUNNING', running_since = TIMESTAMP/);
  // Y el reloj a ahora: un rescate sin cota pasa el primer escenario y falla este.
  assert.match(harness, /UPDATE jobs SET status = 'RUNNING', running_since = CURRENT_TIMESTAMP/);
  // El contador del instante anterior, el único que ve la ventana de arriba.
  assert.match(harness, /SELECT COUNT\(\*\) FROM jobs WHERE status = 'RUNNING' AND running_since IS NULL/);

  for (const helper of ['stallInFlight', 'putInFlight', 'inFlightWithoutClock']) {
    assert.ok(harness.includes(helper), `el arnés perdió ${helper}`);
  }
});

test('documental: los mismos tres, hablando mongosh y con las comillas escapadas', () => {
  const harness = generate(DOCUMENTAL)('AbstractFlowIT.java');

  // Las comillas son el punto, y aquí NO hay red debajo. El script de mongosh viaja dentro
  // de un literal Java que a su vez sale de un template literal —tres niveles—, pero lo
  // compone `javaString()`, que escapa siempre: un escape de más o de menos sale como Java
  // perfectamente válido con el script roto dentro. Es decir, `compile-check` cubre la
  // ESTRUCTURA del arnés (comprobado rompiéndola a propósito) y no puede cubrir esto.
  //
  // Y ya pasó dos veces en este mismo sitio: primero las comillas se perdieron, luego se
  // duplicaron. Un `includes('mongoEval')` no distingue ninguna de las tres versiones —solo
  // lo hace mirar el escape literal, que es lo que hacen estas cuatro líneas.
  assert.ok(harness.includes(String.raw`mongoEval("db.getCollection(\"jobs\").updateOne(`), harness);
  assert.ok(harness.includes(String.raw`{ $set: { status: \"RUNNING\", running_since: new Date(0) } }`), harness);
  assert.ok(harness.includes(String.raw`{ $set: { status: \"RUNNING\", running_since: new Date() } }`), harness);
  assert.ok(harness.includes(String.raw`countDocuments({ status: \"RUNNING\", running_since: null })`), harness);

  for (const helper of ['stallInFlight', 'putInFlight', 'inFlightWithoutClock']) {
    assert.ok(harness.includes(helper), `el arnés perdió ${helper}`);
  }
});

// ── Que el par siga siendo un par ────────────────────────────────────────────

// Las dos fixtures son el mismo diseño con una única diferencia: el modelo de persistencia.
// Si alguien arregla el diseño en una y no en la otra, las dos siguen validando y los dos
// comprobadores siguen en verde — pero ya no estarían compilando «el mismo diseño con otro
// motor», que es lo único que el par afirma. Esto convierte la duplicación en un invariante
// comprobado, y el fallo dice qué capa se desincronizó.
test('las dos fixtures comparten diseño byte a byte salvo el modelo de persistencia', () => {
  for (const layer of ['domain.keel.yaml', 'use-cases.keel.yaml', 'api.keel.yaml']) {
    const [relacional, documental] = AMBAS.map((caso) =>
      fs.readFileSync(path.join(fixturesDir, caso.fixture, layer), 'utf8')
    );
    assert.equal(documental, relacional, `${layer} se desincronizó entre las dos fixtures del par`);
  }

  // Y la diferencia que sí existe sigue siendo esa y no otra.
  const modelOf = (caso) =>
    fs
      .readFileSync(path.join(fixturesDir, caso.fixture, 'persistence.keel.yaml'), 'utf8')
      .match(/^\s*model:\s*(\w+)/m)?.[1];
  assert.equal(modelOf(RELACIONAL), 'relational');
  assert.equal(modelOf(DOCUMENTAL), 'document');
});
