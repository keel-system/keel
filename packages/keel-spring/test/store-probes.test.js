// Que `store-check` mida al GENERADOR y no a una copia de sí mismo.
//
// Este archivo no juzga si el relay o los almacenes son correctos —eso solo lo puede decir
// `store-check` contra un motor de verdad, y esa es la razón de que exista—. Lo que ata es la
// otra mitad: que las clases, los paquetes y los métodos que el JUnit nombra sean los que el
// generador emite de verdad.
//
// La lección viene de `claim-check`, y costó una medición entera: mientras derivaba las columnas
// por su cuenta, medía una SEGUNDA COPIA de la misma derivación, y romper el arnés a propósito lo
// dejaba en 11/11. Aquí el riesgo es idéntico y peor de ver, porque lo que se nombra son clases
// package-private: si el generador renombra `OutboxRelayStore` o mueve `IdempotencyGuard` de
// paquete, el JUnit deja de compilar y el runner reporta «la suite no llegó a ejecutarse» — un
// rojo que no distingue un generador roto de un check desincronizado.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
// Los nombres del espejo del registro de claves salen del generador, no de este test: es la
// misma fuente que consume store-probes.js para emitir el JUnit.
import { idempotencyRecordNames } from '../src/scaffold/http-idempotency.js';
import { scaffoldService } from '../src/scaffold/index.js';
import {
  storeSubjects,
  storeTestClasses,
  hasSubjects,
  CLASS_OUTBOX,
  CLASS_IDEMPOTENCY,
  BATCH_SIZE,
  MAX_ATTEMPTS,
  CLAIM_TIMEOUT_MS
} from '../src/lib/store-probes.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// El PAR. Mismo diseño byte a byte salvo el `persistence.default.model`, que es lo que hace de
// ellas dos ramas enteras del scaffolding y no dos variantes de la misma.
const PAR = [
  { fixture: 'notification-mailer', engine: 'postgresql', document: false },
  { fixture: 'notification-mailer-mongo', engine: 'mongodb', document: true }
];

/** Genera el proyecto y devuelve el modelo, los sujetos, las clases y el árbol generado. */
function prepara({ fixture, engine }) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-store-probes-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack: { database: engine } });
  const projectDir = path.join(workspace, result.outDir);

  const root = path.join(projectDir, 'src/main/java');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const files = walk(root);
  const paqueteDe = (basename) => {
    const file = files.find((candidate) => path.basename(candidate) === basename);
    assert.ok(file, `${fixture}: el generador no emite ${basename}`);
    return /^package\s+([\w.]+);/m.exec(fs.readFileSync(file, 'utf8'))[1];
  };
  const fuenteDe = (basename) => {
    const file = files.find((candidate) => path.basename(candidate) === basename);
    assert.ok(file, `${fixture}: el generador no emite ${basename}`);
    return fs.readFileSync(file, 'utf8');
  };

  const model = buildModel({ manifest, layers, stack: { database: engine } });
  const subjects = storeSubjects(model);
  const document = subjects.document;
  const packages = {
    outbox: paqueteDe(document ? 'OutboxRelay.java' : 'OutboxRelayStore.java'),
    dedupe: paqueteDe('IdempotencyGuard.java'),
    commandStore: paqueteDe(document ? 'MongoIdempotencyStore.java' : 'JpaIdempotencyStore.java'),
    storePort: paqueteDe('IdempotencyStore.java'),
    conflict: paqueteDe('IdempotencyConflictException.java'),
    ...(document ? { mongoTx: paqueteDe('MongoTransactionConfig.java') } : {})
  };
  const datasource = document
    ? { uri: 'mongodb://x' }
    : { url: 'jdbc:x', username: 'u', password: 'p' };

  const clases = storeTestClasses(model, subjects, { datasource, packages, database: engine });
  return { model, subjects, clases, packages, fuenteDe, paqueteDe };
}

/** La clase de prueba de un mecanismo, por su nombre. */
const claseDe = (clases, nombre) => clases.find((c) => c.className === nombre);

for (const caso of PAR) {
  const etiqueta = `${caso.fixture} (${caso.engine})`;

  test(`${etiqueta}: el par declara los tres mecanismos que hay que medir`, () => {
    const { subjects } = prepara(caso);
    // Si el sujeto deja de declarar uno, el check sigue en VERDE midiendo menos — que es
    // exactamente cómo se pierde una medición sin que nadie lo note.
    assert.equal(subjects.outbox, true, 'la fixture dejó de usar outbox: el relay ya no se mide');
    assert.equal(subjects.commandIdempotency, true, 'la fixture dejó de declarar idempotencia de petición');
    assert.equal(subjects.dedupe, true, 'la fixture dejó de tener suscripciones: el dedupe ya no se mide');
    assert.equal(subjects.document, caso.document, 'el modelo de persistencia no es el que declara el diseño');
    assert.ok(hasSubjects(subjects));
  });

  test(`${etiqueta}: cada clase cae en el paquete de lo que mide`, () => {
    const { clases, packages } = prepara(caso);
    // No es organización: `OutboxRelayStore` es package-private en el paquete del outbox y
    // `ProcessedEventWriter` lo es en el de idempotencia. Una sola clase no puede importarlos a
    // los dos, y una que caiga en el paquete equivocado no compila.
    assert.equal(claseDe(clases, CLASS_OUTBOX).package, packages.outbox);
    assert.equal(claseDe(clases, CLASS_IDEMPOTENCY).package, packages.dedupe);
  });

  test(`${etiqueta}: el JUnit nombra métodos que el generador emite de verdad`, () => {
    const { model, clases, subjects, fuenteDe } = prepara(caso);
    const outbox = claseDe(clases, CLASS_OUTBOX).content;
    const idem = claseDe(clases, CLASS_IDEMPOTENCY).content;

    // Los del relay, que son los que cambian de rama a rama.
    if (subjects.document) {
      // El reclamo documental vive DENTRO del relay, y es package-private a propósito para poder
      // medirse. Si volviera a ser privado, el JUnit no compilaría.
      assert.match(fuenteDe('OutboxRelay.java'), /^ {4}List<OutboxEventDocument> claimPending\(\)/m,
        'claimPending dejó de ser alcanzable desde su paquete: el reclamo documental deja de medirse');
      assert.ok(outbox.includes('relay.claimPending()'));
    } else {
      const store = fuenteDe('OutboxRelayStore.java');
      for (const metodo of ['claimBatch', 'markPublished', 'markFailed']) {
        assert.ok(store.includes(`${metodo}(`), `OutboxRelayStore ya no expone ${metodo}`);
        assert.ok(outbox.includes(`store.${metodo}(`), `el JUnit no ejercita ${metodo}`);
      }
      const repo = fuenteDe('OutboxEventJpaRepository.java');
      for (const consulta of ['findPending', 'countDeadLettered']) {
        assert.ok(repo.includes(`${consulta}(`), `el repositorio del outbox ya no expone ${consulta}`);
        assert.ok(outbox.includes(`outbox.${consulta}(`), `el JUnit no ejercita ${consulta}`);
      }
    }

    // Los de idempotencia, idénticos en las dos ramas.
    const guard = fuenteDe('IdempotencyGuard.java');
    for (const metodo of ['alreadyProcessed', 'record', 'tryRecord']) {
      assert.ok(guard.includes(`public boolean ${metodo}(`), `IdempotencyGuard ya no expone ${metodo}`);
      assert.ok(idem.includes(`guarda.${metodo}(`), `el JUnit no ejercita ${metodo}`);
    }
    const puerto = fuenteDe('IdempotencyStore.java');
    for (const metodo of ['find', 'save']) {
      assert.ok(puerto.includes(`${metodo}(String scope`), `IdempotencyStore ya no expone ${metodo}`);
      assert.ok(idem.includes(`claves.${metodo}(`), `el JUnit no ejercita ${metodo}`);
    }
    // La purga del almacén de CLAVES: el método vive en la clase concreta, no en el puerto, y su
    // consulta cambia de nombre con el modelo. Era la última consulta de estos mecanismos sin
    // ejecutar, y su fallo caro es borrar de MÁS: se lleva las claves vivas y un reintento del
    // cliente ejecuta el comando dos veces.
    const registro = idempotencyRecordNames(model);
    const almacenSrc = fuenteDe(`${registro.store}.java`);
    assert.ok(almacenSrc.includes('public void purge()'), `${registro.store} ya no expone purge()`);
    assert.ok(idem.includes('almacen.purge();'), 'el JUnit no ejercita la purga del almacén de claves');

    const consultaPurga = subjects.document ? 'deleteByExpiresAtBefore' : 'deleteExpiredBefore';
    assert.ok(
      fuenteDe(`${registro.repository}.java`).includes(`${consultaPurga}(`),
      `${registro.repository} ya no expone ${consultaPurga}`
    );
    // Y se observa por el repositorio, que es lo único que ve el efecto: `find` filtra por
    // caducidad y devolvería vacío tanto si la fila se borró como si sigue ahí.
    assert.ok(
      idem.includes(`registros.findById(new ${registro.entity}.IdempotencyRecordId(`),
      'el JUnit no observa la fila: no podría distinguir una purga que borra de una que no'
    );

    // Y la purga de PROCESADOS, que cambia de nombre con el modelo y es otra cadena que nadie ejecuta.
    const purga = subjects.document ? 'deleteByProcessedAtBefore' : 'deleteProcessedBefore';
    assert.ok(fuenteDe(subjects.document ? 'ProcessedEventMongoRepository.java' : 'ProcessedEventJpaRepository.java')
      .includes(`${purga}(`), `el repositorio de procesados ya no expone ${purga}`);
    assert.ok(idem.includes(`procesados.${purga}(`), 'el JUnit no ejercita la purga de procesados');
  });

  test(`${etiqueta}: los parámetros de la suite llegan al contexto`, () => {
    const { clases, subjects } = prepara(caso);
    const outbox = claseDe(clases, CLASS_OUTBOX).content;

    // Con los valores de producción (lote 100, 10 intentos) los casos de la cota y del
    // dead-letter necesitarían cien filas y diez fallos. Se bajan, y hay que comprobar que el
    // camino por el que se bajan es el que el relay lee de verdad.
    if (subjects.document) {
      // Aquí van por `@Value`, así que viajan como propiedades del contexto.
      assert.ok(outbox.includes(`"outbox.relay.batch-size=${BATCH_SIZE}"`));
      assert.ok(outbox.includes(`"outbox.relay.max-attempts=${MAX_ATTEMPTS}"`));
      assert.ok(outbox.includes(`"outbox.relay.claim-timeout-ms=${CLAIM_TIMEOUT_MS}"`));
    } else {
      // Aquí son argumentos del método: el store los recibe, no los lee de la configuración.
      assert.ok(outbox.includes(`private static final int LOTE = ${BATCH_SIZE};`));
      assert.ok(outbox.includes(`private static final long LEASE_MS = ${CLAIM_TIMEOUT_MS}L;`));
    }
  });

  test(`${etiqueta}: el vocabulario del JUnit sale del diseño, no escrito a mano`, () => {
    const { model, clases, subjects } = prepara(caso);
    const idem = claseDe(clases, CLASS_IDEMPOTENCY).content;

    // El scope y el handler son entradas de la API, no valores que build emita — pero su
    // vocabulario sí es del diseño, y usar el real hace que la medición pase por las mismas
    // longitudes de columna que la producción. Escritos a mano, el check mediría otro servicio.
    const operacion = (model.services ?? [])
      .flatMap((grupo) => grupo.operations ?? [])
      .find((op) => op.idempotency && op.idempotency.guard !== 'natural-key');
    assert.ok(operacion, 'la fixture dejó de tener una operación con almacén de claves');
    assert.equal(subjects.scope, operacion.name);
    assert.ok(idem.includes(`SCOPE = "${operacion.name}"`));

    assert.equal(subjects.handlerId, model.subscriptions[0].listenerClass);
    assert.ok(idem.includes(`HANDLER = "${model.subscriptions[0].listenerClass}"`));
  });
}

test('las dos ramas siguen siendo el MISMO diseño con otro modelo de persistencia', () => {
  // Sin esto, arreglar una y no la otra dejaría a store-check comparando dos servicios distintos
  // y llamándolo «las dos ramas». Es la misma vigilancia que ya hacen guard-claim.test.js y
  // rescue-shape-coverage.test.js sobre sus propios pares.
  const capas = ['domain', 'use-cases', 'messaging', 'subscriptions', 'api', 'persistence'];
  const [relacional, documental] = PAR.map((caso) => loadService(path.join(fixturesDir, caso.fixture)).layers);

  for (const capa of capas) {
    const a = JSON.stringify(relacional[capa] ?? null);
    const b = JSON.stringify(documental[capa] ?? null);
    if (capa === 'persistence') {
      assert.notEqual(a, b, 'el par dejó de diferir en persistence: entonces no son dos ramas');
      continue;
    }
    assert.equal(a, b, `el par dejó de compartir la capa ${capa}: store-check compararía dos servicios distintos`);
  }
});
