// Corrida order de prueba-gelsa (G6): la réplica `Product` con `keyField: id`. keel-core ya no mete la identidad en la
// clave natural; aquí se mira que keel-dotnet busque la copia por FindById (lo hacía por la clave natural de persistencia
// pasándole el id: Guid contra string, no compilaba), que la copia NUEVA conserve el id del proveedor (uno nuevo crearía
// otra copia en cada evento) y que su lote vaya por FindAllById, como keel-spring y keel-nest.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planFixture, UNCOVERED_BRANCHES } from './helpers/workspace.js';

const gelsa = UNCOVERED_BRANCHES.find((branch) => branch.name === 'catalog-gelsa-order');

async function render(mutate, stack = null) {
  const { files } = await planFixture('catalog-extended', { stack, mutate: mutate && ((manifest, layers) => mutate(manifest, layers, 'catalog-extended')) });
  return (suffix) => files.find((f) => f.path.split(path.sep).join('/').endsWith(suffix))?.content ?? '';
}

const countOf = (text, needle) => text.split(needle).length - 1;

test('la réplica con keyField: id se busca por FindById, y la copia nueva lleva el id del snapshot', async () => {
  const read = await render(gelsa.mutate);
  const port = read('/ISupplierPriceRepository.cs');
  assert.equal(countOf(port, ' FindById('), 1, port);
  const projector = read('/SupplierPriceProjector.cs');
  assert.match(projector, /var existing = await repository\.FindById\(snapshot\.Id, cancellationToken\);/);
  assert.match(projector, /\n\s+Id = snapshot\.Id,/, 'la copia nueva conserva el id que informa el proveedor');
  assert.match(projector, /\n\s+Id = existing\.Id,/);
  assert.match(read('/SupplierPriceReader.cs'), /await repository\.FindById\(id, cancellationToken\)/);
});

test('la réplica con keyField: id lee su lote por FindAllById, en las dos ramas', async () => {
  for (const database of ['postgresql', 'mongodb']) {
    const read = await render(gelsa.mutate, { database, broker: 'kafka' });
    assert.match(read('/ISupplierPriceRepository.cs'), /FindAllById\(IReadOnlyCollection<Guid> ids/, database);
    const reader = read('/SupplierPriceReader.cs');
    assert.match(reader, /ByKeys\(IReadOnlyCollection<Guid> ids, [^\n]*\n\s+\{\n\s+var copies = await repository\.FindAllById\(ids, cancellationToken\);/, database);
    assert.match(reader, /copies\.ToDictionary\(copy => copy\.Id\)/, database);
  }
});

test('con la clave natural de siempre nada cambia: la copia se busca por sku y nace con id nuevo', async () => {
  const read = await render(null);
  const projector = read('/SupplierPriceProjector.cs');
  assert.match(projector, /repository\.FindBySku\(snapshot\.Sku, cancellationToken\)/);
  assert.doesNotMatch(projector, /Id = snapshot\.Id/);
});
