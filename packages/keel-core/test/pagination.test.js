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

// ─── OBL-QUERY-SORT-UNDECIDED (DSL 2.32, U3) ────────────────────────────────────────────────────────────────────
//
// Sobre fixtures reales: product-catalog pagina Product para personas (audience por defecto, users) y payment-checkout
// sirve a servicios. Un `sortable` cierra la pregunta, y un endpoint para máquinas no la abre.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { undecidedClientSorts } from '../src/lib/gen/pagination.js';
import { searchPendingErrors } from '../src/lib/gen/query-filters.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');
const layersOf = (fixture) => loadService(path.join(FIXTURES, fixture)).layers;

test('un listado paginado para personas sin sortable es una decisión abierta; con sortable o para servicios, no', () => {
  const layers = layersOf('product-catalog');
  const declared = layers['use-cases'].operations.listProducts.output.sortable;
  if (declared) delete layers['use-cases'].operations.listProducts.output.sortable;
  assert.deepEqual(undecidedClientSorts(layers), [{ operation: 'listProducts', entity: 'Product', audience: 'users' }]);

  layers['use-cases'].operations.listProducts.output.sortable = ['sku'];
  assert.deepEqual(undecidedClientSorts(layers), []);

  delete layers['use-cases'].operations.listProducts.output.sortable;
  layers.api.defaultAudience = 'services';
  assert.deepEqual(undecidedClientSorts(layers), []);

  // Sin capa api no hay endpoint, y sin endpoint nadie pide `?sort=`.
  delete layers.api;
  assert.deepEqual(undecidedClientSorts(layers), []);
});

test('la frontera de la búsqueda de 2.32: in, ne, search y sortable, con el incremento que la trae', () => {
  const layers = layersOf('product-catalog');
  assert.deepEqual(searchPendingErrors({ 'use-cases': { operations: { listProducts: { kind: 'query', output: { entity: 'Product', paginated: true } } } } }, 'keel-go', 'B6'), []);
  const operations = layers['use-cases'].operations;
  operations.listProducts.output.sortable = ['sku'];
  operations.listProducts.input = {
    fields: {
      statuses: { type: 'ProductStatus', list: true, filter: { field: 'status', op: 'in' } },
      notSku: { type: 'string', filter: { field: 'sku', op: 'ne' } },
      q: { type: 'string', search: { over: ['name'] } }
    }
  };
  const errors = searchPendingErrors(layers, 'keel-go', 'B6');
  assert.equal(errors.length, 4);
  assert.ok(errors.every((message) => /keel-go todavía no lo genera — llega en el incremento B6/.test(message)));
  assert.match(errors.join('\n'), /statuses\.filter op: in/);
  assert.match(errors.join('\n'), /notSku\.filter op: ne/);
  assert.match(errors.join('\n'), /q\.search/);
  assert.match(errors.join('\n'), /listProducts\.output\.sortable/);
});
