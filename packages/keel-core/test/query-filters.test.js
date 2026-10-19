// El finder de una búsqueda (DSL 2.22, src/lib/gen/query-filters.js): qué restringe cada input, y que se emite
// ENTERO o no se emite. Sujeto real: listDraftProducts de catalog-extended, la fixture que declara las tres formas
// (enlace por nombre a una relación, filter sobre un rango y where).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { criterionText, finderNote, findersOf } from '../src/lib/gen/query-filters.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function modelOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE });
}

const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);

test('listDraftProducts: la relación por nombre, el rango con filter y el where, en un finder paginado', () => {
  const model = modelOf('catalog-extended');
  const { finder } = operationOf(model, 'listDraftProducts');
  assert.ok(finder, 'listDraftProducts no tiene finder');
  assert.equal(finder.result, 'page');
  assert.equal(finder.filterType, 'ListDraftProductsFilter');
  assert.deepEqual(
    finder.criteria.map((criterion) => [criterion.name, criterion.op, criterion.target.kind, criterion.target.path]),
    [
      ['categoryId', 'eq', 'relation', 'category'],
      ['createdFrom', 'gte', 'field', 'createdAt'],
      ['createdTo', 'lte', 'field', 'createdAt']
    ]
  );
  assert.deepEqual(finder.fixed.map((entry) => [entry.name, entry.value]), [['status', 'draft']]);
  assert.deepEqual(finder.sort.map((criterion) => `${criterion.path}:${criterion.direction}`), ['createdAt:desc']);
  assert.deepEqual(findersOf(model, 'Product').map((each) => each.method), ['listProducts', 'listDraftProducts']);
});

test('un texto plegado se compara contra su sombra: la que pide el filtro de listProducts', () => {
  const { finder } = operationOf(modelOf('catalog-extended'), 'listProducts');
  const [name] = finder.criteria;
  assert.equal(name.match, 'contains');
  assert.equal(name.compare, 'ignore-case-accents');
  assert.equal(name.shadow?.name, 'nameNormalized');
  assert.equal(criterionText(name), 'name contiene name (sin mayúsculas ni acentos)');
});

test('filter nombra el campo que pliega aunque el input se llame de otra forma, y su sombra se deriva igual', () => {
  const model = modelOf('catalog-extended', (layers) => {
    const fields = layers['use-cases'].operations.listProducts.input.fields;
    fields.q = { ...fields.name, filter: { field: 'name', op: 'eq' } };
    delete fields.name;
  });
  const [criterion] = operationOf(model, 'listProducts').finder.criteria;
  assert.equal(criterion.name, 'q');
  assert.equal(criterion.shadow?.name, 'nameNormalized', 'la sombra del filtro no siguió a filter.field');
});

test('un input que no enlaza deja la búsqueda sin finder, nunca a medias, y la nota lo dice', () => {
  const model = modelOf('catalog-extended', (layers) => {
    layers['use-cases'].operations.listDraftProducts.input.fields.search = { type: 'string', constraints: { maxLength: 60 } };
  });
  const operation = operationOf(model, 'listDraftProducts');
  assert.equal(operation.finder, null);
  assert.deepEqual(operation.finderGaps, ['search: no se llama como ningún campo de Product y no declara filter']);
  assert.match(finderNote(operation, { call: 'x' }), /^Sin finder de build: search/);
});

test('la lectura por lote de ids no es una búsqueda: ni finder ni nota (la sirve findAllById)', () => {
  const operation = operationOf(modelOf('catalog-extended'), 'getProductsByIds');
  assert.equal(operation.finder, null);
  assert.equal(operation.finderGaps, null);
  assert.equal(finderNote(operation, { call: 'x' }), null);
});

test('la nota del handler enumera los filtros que aplica el finder, y solo esos', () => {
  const operation = operationOf(modelOf('catalog-extended'), 'listDraftProducts');
  const note = finderNote(operation, { call: 'productRepository.listDraftProducts(filter, pageable)' });
  assert.ok(note.includes('productRepository.listDraftProducts(filter, pageable)'));
  assert.ok(note.includes('category (su id) = categoryId si viene; createdAt ≥ createdFrom si viene; createdAt ≤ createdTo si viene; status = draft'));
  assert.match(note, /designGap/);
});

test('una salida de un solo elemento o sin persistencia no es una búsqueda con finder', () => {
  assert.equal(operationOf(modelOf('catalog-extended'), 'getProductBySlug').finder, null);
  assert.equal(operationOf(modelOf('catalog-extended'), 'getProductBySlug').finderGaps, null);
});
