// Corrida order de prueba-gelsa (G6): la réplica `Product` con `keyField: id` metía el id en la clave natural, y el puerto
// salía con un `findById` duplicado que no compila. La clave que es la identidad no da finder propio; la lectura por lote
// de la réplica (la lee un listado) sí sigue, porque ningún otro método la cubre.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function render(mutate) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  mutate(patched);
  const { files } = planService({ manifest, layers: patched, workspace: FIXTURES_DIR });
  return (suffix) => files.find((f) => f.path.split(path.sep).join('/').endsWith(suffix))?.content ?? '';
}

const countOf = (text, needle) => text.split(needle).length - 1;

for (const [title, mutate] of [
  ['la réplica con keyField: id', (layers) => {
    layers.dependencies.dependencies.pricing.needs.supplierPrice.replica.keyField = 'id';
  }],
  ['naturalKey: [id] escrito a mano', (layers) => {
    layers.persistence.entities.SupplierPrice = { ...(layers.persistence.entities.SupplierPrice ?? {}), naturalKey: ['id'] };
  }]
]) {
  test(`${title}: el puerto declara findById una sola vez y compila`, () => {
    const find = render(mutate);
    const port = find('/domain/repository/SupplierPriceRepository.java');
    assert.ok(port, 'el puerto de la réplica existe');
    assert.equal(countOf(port, ' findById('), 1, port);
    const adapter = find('/SupplierPriceRepositoryImpl.java');
    assert.equal(countOf(adapter, ' findById('), 1);
  });
}

test('la réplica con keyField: id conserva su lectura por lote, y el proyector lee por findById', () => {
  const find = render((layers) => {
    layers.dependencies.dependencies.pricing.needs.supplierPrice.replica.keyField = 'id';
  });
  const port = find('/domain/repository/SupplierPriceRepository.java');
  assert.match(port, /findAllById\(Collection<UUID> ids\)/);
  assert.doesNotMatch(port, /findByIdAndSku|findAllByIdIn/);
  const reader = find('/SupplierPriceReader.java');
  assert.match(reader, /repository\.findAllById\(ids\)/);
  assert.match(find('/SupplierPriceProjector.java'), /repository\.findById\(id\)/);
});
