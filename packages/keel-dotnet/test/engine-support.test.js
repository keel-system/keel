// La matriz de paridad de keel-dotnet se ata al catálogo neutral: una fila por mecanismo, sin
// inventar ids, con el vocabulario de estados común y, en cada celda, una promesa que se pueda
// leer (una red que existe, o un porqué escrito). Es lo que hace que «keel-dotnet todavía no lo
// genera» se lea mecanismo a mecanismo en vez de suponerse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MECHANISMS, MECHANISM_CATALOG, STATES, NETS, RELATIONAL_ENGINES, cells, pending, unverified } from '../src/lib/engine-support.js';
import { MODELS } from '@keel-system/keel-core/gen/mechanisms';

test('una fila por cada mecanismo del catálogo neutral, y ninguna inventada', () => {
  assert.deepEqual(Object.keys(MECHANISMS).sort(), Object.keys(MECHANISM_CATALOG).sort());
});

test('cada fila o dice el incremento que la trae o declara sus celdas', () => {
  for (const [id, row] of Object.entries(MECHANISMS)) {
    assert.ok(Boolean(row.pending) !== Boolean(row.coverage), `${id}: o pending o coverage, no las dos ni ninguna`);
    if (row.pending) assert.match(row.pending, /incremento \d+/, id);
    else assert.ok(row.emitter, `${id}: una fila generada nombra su emisor`);
  }
});

test('las celdas se indexan por el eje del catálogo y usan el vocabulario común', () => {
  for (const { id, branch, cell } of cells()) {
    const axis = MECHANISM_CATALOG[id].axis;
    if (axis === 'model') assert.ok(MODELS.includes(branch), `${id}: ${branch} no es un modelo`);
    // Por motor solo los que keel-dotnet genera: los demás los rechaza el build, no se degradan.
    else assert.ok(RELATIONAL_ENGINES.includes(branch), `${id}: ${branch} está fuera de la frontera de motores`);
    if (cell.pending) {
      assert.match(cell.pending, /incremento \d+/, `${id}/${branch}`);
      continue;
    }
    assert.ok(STATES[cell.state], `${id}/${branch}: estado ${cell.state}`);
    assert.ok(cell.why, `${id}/${branch}: sin porqué escrito`);
    if (cell.state === 'verificado') {
      assert.ok(NETS[cell.net] && cell.net !== 'ninguna', `${id}/${branch}: verificado por una red que no existe (${cell.net})`);
      assert.equal(typeof cell.falsified, 'boolean', `${id}/${branch}: falsado o no, dicho`);
    }
  }
});

test('las dos persistencias que keel-dotnet genera las ejecuta su red en vivo', () => {
  assert.equal(MECHANISMS['persistence-adapter'].coverage.relational.net, 'db-check');
  // La documental (incremento 12) contra un MongoDB real, almacenes del generador y arnés incluidos.
  for (const id of ['persistence-adapter', 'outbox-relay', 'idempotency-request', 'idempotency-consume', 'reconciliation-claim', 'sweep-claim-queue', 'sweep-claim-rescue']) {
    assert.equal(MECHANISMS[id].coverage.document.net, 'doc-check', id);
  }
  assert.deepEqual(pending().filter(({ branch }) => branch === 'document').map(({ id }) => id), []);
  assert.equal(MECHANISMS['harness-db-probes'].coverage.document.net, 'doc-harness-check');
});

test('no queda ninguna fila pendiente de un incremento (desde el 14f)', () => {
  assert.deepEqual(pending().map(({ id }) => id), []);
});

test('cada motor relacional que la frontera admite tiene su celda en los mecanismos por motor', () => {
  for (const [id, row] of Object.entries(MECHANISMS)) {
    if (MECHANISM_CATALOG[id].axis !== 'engine' || row.pending) continue;
    assert.deepEqual(Object.keys(row.coverage).sort(), [...RELATIONAL_ENGINES].sort(), id);
  }
});

test('ninguna celda generada queda sin ejecutar: lo que keel-dotnet emite lo ejecuta una red', () => {
  // La puerta del incremento 16 («matriz sin `sin ejecutar`»), sostenida desde que se cerraron las tres que la matriz
  // destapó al nacer. Una celda razonada nueva necesita su red, o cambiar este test diciendo por qué.
  assert.deepEqual(unverified().map(({ id, branch }) => `${id}/${branch}`), []);
});
