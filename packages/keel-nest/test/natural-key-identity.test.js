// Corrida order de prueba-gelsa (G6): la réplica `Product` con `keyField: id` metía el id en la clave natural, y el
// puerto de keel-spring salía con un `findById` duplicado. keel-core ya no mete la identidad en la clave; aquí se mira
// que keel-nest tampoco duplique el finder y que la lectura por lote de la copia (la lee un listado) vaya por
// `findAllById`, como en keel-spring (`keel-spring/test/natural-key-identity.test.js`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const PORT = 'src/domain/repository/supplier-price-repository.ts';
const ADAPTER = 'src/infrastructure/persistence/repositories/supplier-price-repository-impl.ts';
const READER = 'src/application/projection/supplier-price-reader.ts';

function render(mutate, stack = { database: 'postgresql', broker: 'kafka' }) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  mutate(patched);
  const { files } = planService({ manifest, layers: patched, workspace: FIXTURES_DIR, stack });
  return (p) => files.find((f) => f.path.split(path.sep).join('/') === p)?.content ?? '';
}

const countOf = (text, needle) => text.split(needle).length - 1;
const idKey = (layers) => {
  layers.dependencies.dependencies.pricing.needs.supplierPrice.replica.keyField = 'id';
};

for (const [title, mutate] of [
  ['la réplica con keyField: id', idKey],
  ['naturalKey: [id] escrito a mano', (layers) => {
    layers.persistence.entities.SupplierPrice = { ...(layers.persistence.entities.SupplierPrice ?? {}), naturalKey: ['id'] };
  }]
]) {
  test(`${title}: el puerto y el adaptador declaran findById una sola vez`, () => {
    const read = render(mutate);
    assert.equal(countOf(read(PORT), ' findById('), 1, read(PORT));
    assert.equal(countOf(read(ADAPTER), ' findById('), 1);
  });
}

test('la réplica con keyField: id conserva su lectura por lote por findAllById, en las dos ramas', () => {
  for (const database of ['postgresql', 'mongodb']) {
    const read = render(idKey, { database, broker: 'kafka' });
    assert.match(read(PORT), /abstract findAllById\(ids: readonly string\[\]\)/, database);
    assert.match(read(PORT), /La usa el byKeys\(\.\.\.\) del lector de la copia/, database);
    assert.doesNotMatch(read(PORT), /findAllByIdIn|findByIdAndSku/, database);
    assert.match(read(READER), /async byKeys\(ids: readonly string\[\]\)[^\n]*\n\s+const copies = await this\.repository\.findAllById\(ids\);/, database);
    assert.match(read(READER), /copies\.map\(\(copy\) => \[copy\.id, copy\]\)/, database);
  }
});

test('la réplica con keyField: id: el snapshot trae el id no nulo y el TODO no pide generarlo, como keel-spring', () => {
  const read = render(idKey);
  const projector = read('src/application/projection/supplier-price-projector.ts');
  assert.match(projector, /export interface SupplierPriceSnapshot \{\n {2}readonly id: string;/);
  assert.match(projector, /la copia nueva; el id es el que informa el proveedor, no lo generes/);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  idKey(layers);
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.find((f) => f.path.endsWith('SupplierPriceProjector.java')).content;
  assert.match(spring, /factory de la copia; el id es el que informa el proveedor, no lo generes/);
  // Con la clave natural de siempre, el id lo genera la copia.
  assert.match(render(() => {})('src/application/projection/supplier-price-projector.ts'), /la copia nueva; genera el id/);
});
