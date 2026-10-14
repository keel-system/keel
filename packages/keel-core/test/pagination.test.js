// La página de un listado con persistencia (keel-core/gen/pagination.js): los defaults del Pageable de Spring Data
// y el orden por defecto que se puede traducir. Los tres generadores responden con esto a quien no pide tamaño ni
// orden, así que es contrato observable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGEABLE_DEFAULT_SIZE, PAGEABLE_MAX_SIZE, translatableSort, pageableDefaults } from '../src/lib/gen/pagination.js';

test('sin paginación en el diseño: el tamaño del @PageableDefault (10) y el tope de Spring Data (2000)', () => {
  assert.equal(PAGEABLE_DEFAULT_SIZE, 10);
  assert.equal(PAGEABLE_MAX_SIZE, 2000);
  assert.deepEqual(pageableDefaults({}, {}), { defaultSize: 10, maxSize: 2000, defaultSort: [] });
});

test('con paginación en el diseño: manda el diseño', () => {
  const model = { pagination: { defaultSize: 20, maxSize: 100 } };
  const sort = [{ property: 'name', direction: 'asc' }];
  assert.deepEqual(pageableDefaults(model, { sort }), { defaultSize: 20, maxSize: 100, defaultSort: sort });
});

test('un criterio sobre un agregado embebido deja el orden ENTERO sin traducir (necesita un join)', () => {
  assert.deepEqual(translatableSort({ sort: [{ property: 'name', direction: 'asc' }, { property: 'brand.name', direction: 'asc', embedded: true }] }), []);
  assert.deepEqual(translatableSort({}), []);
  assert.deepEqual(translatableSort(undefined), []);
});
