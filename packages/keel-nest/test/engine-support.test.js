// La matriz de paridad de keel-nest se ata al catálogo neutral: una fila por mecanismo, sin
// inventar ids, con el vocabulario de estados común y, en cada celda, una promesa que se pueda
// leer (una red que existe, o un porqué escrito). Es lo que hace que «keel-nest todavía no lo
// genera» se lea mecanismo a mecanismo en vez de suponerse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MECHANISMS, MECHANISM_CATALOG, STATES, NETS, SUPPORTED_DATABASES, cells, pending } from '../src/lib/engine-support.js';
import { MODELS } from 'keel-core/gen/mechanisms';

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
    // Por motor solo los que keel-nest genera: los demás los rechaza el build, no se degradan.
    else assert.ok(SUPPORTED_DATABASES.includes(branch), `${id}: ${branch} está fuera de la frontera de motores`);
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

test('lo que la persistencia relacional genera hoy está ejecutado por db-check', () => {
  assert.equal(MECHANISMS['persistence-adapter'].coverage.relational.net, 'db-check');
  assert.ok(pending().some(({ id, branch }) => id === 'persistence-adapter' && branch === 'document'), 'la rama documental es del incremento 12');
});
