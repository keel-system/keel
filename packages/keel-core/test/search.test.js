// La búsqueda de DSL 2.32, lo neutral (B2 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): los criterios `in`, `ne` y
// `search` del finder con su referencia (casos FS-*), el orden que pide el cliente (`readClientSort`, casos SO-*), la
// lista en la query (U8), el contrato formal, la clave de la caché (D18) y las columnas de texto que se ordenan (U7).
// Sujeto: `catalog-search` de test/helpers/finder-designs.js, el mismo que medirán las redes de los cuatro generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, binaryCollationFor } from '../src/lib/gen/infra-catalog.js';
import {
  FINDER_SABOTAGES,
  FINDER_SEARCH_CASES,
  FINDER_SEARCH_ROWS,
  criterionText,
  finderNote,
  finderTextProbes,
  foldText,
  matchesFinder
} from '../src/lib/gen/query-filters.js';
import { SO_CASES, SO_SABOTAGES, orderCollationWork, orderedTextColumns, readClientSort, sortParameterValues, sortableOf } from '../src/lib/gen/pagination.js';
import { WIRE_QUERY_LIST_CASES, WIRE_RULES, readQueryList } from '../src/lib/gen/wire.js';
import { openapiDocument } from '../src/lib/gen/openapi.js';
import { cacheKeyExtras } from '../src/lib/gen/cache-plan.js';
import { FRAMEWORK_RESPONSES, invalidSortMessage } from '../src/lib/gen/api-errors.js';
import { SEARCH_DESIGNS } from './helpers/finder-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function modelOf(name, stack = STACK_DEFAULTS) {
  const design = SEARCH_DESIGNS.find((candidate) => candidate.name === name);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  design.mutate(layers);
  return buildModel({ manifest, layers, stack, projection: PROBE });
}

const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);
const searchCatalog = (model = modelOf('catalog-search')) => operationOf(model, 'searchCatalog');

// ─── El finder ───────────────────────────────────────────────────────────────────────────────────────────────

test('searchCatalog tiene finder entero: in, ne y la búsqueda libre, cada uno con su forma', () => {
  const { finder, finderGaps } = searchCatalog();
  assert.equal(finderGaps, null);
  assert.deepEqual(
    finder.criteria.map((criterion) => [criterion.name, criterion.op]),
    [['statuses', 'in'], ['notNotes', 'ne'], ['q', 'search']]
  );
  const q = finder.criteria.find((criterion) => criterion.op === 'search');
  assert.equal(q.target, null);
  assert.deepEqual(q.targets.map((entry) => [entry.target.path, entry.shadow?.name]), [['name', 'nameNormalized'], ['notes', 'notesNormalized']]);
  assert.deepEqual(finder.criteria.map(criterionText), ['status es uno de statuses', 'notes ≠ notNotes (también sin valor)', 'name o notes contiene q (sin mayúsculas ni acentos)']);
  assert.match(finderNote(searchCatalog(), { call: 'repo.searchCatalog(filter)' }), /una lista de in vacía no llega: es 400 en el borde/);
});

test('la búsqueda pide la sombra plegada de cada campo de over, solo para filtrar', () => {
  const model = modelOf('catalog-search');
  const product = model.entities.find((entity) => entity.name === 'Product');
  for (const name of ['name', 'notes']) {
    const field = product.fields.find((candidate) => candidate.name === name);
    assert.equal(field.fold, null);
    assert.deepEqual([field.filterFold?.shadow, field.filterFold?.accents, field.filterFold?.operations], [`${name}Normalized`, true, ['searchCatalog']]);
  }
});

test('un input con search no se enlaza por nombre aunque se llame como un campo', () => {
  const design = SEARCH_DESIGNS[0];
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  design.mutate(layers);
  const fields = layers['use-cases'].operations.searchCatalog.input.fields;
  fields.name = fields.q;
  delete fields.q;
  const model = buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE });
  const name = searchCatalog(model).finder.criteria.find((criterion) => criterion.name === 'name');
  assert.equal(name.op, 'search');
});

test('una búsqueda plegada sobre un subcampo de value object no tiene sombra: sin finder, y la nota lo dice', () => {
  const design = SEARCH_DESIGNS[0];
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design.from));
  design.mutate(layers);
  layers['use-cases'].operations.searchCatalog.input.fields.q.search.over = ['name', 'price.currency'];
  const operation = searchCatalog(buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }));
  assert.equal(operation.finder, null);
  assert.match(operation.finderGaps.join('\n'), /q: search con compare ignore-case-accents sin columna sombra de price\.currency/);
});

/** Lo que devuelve el finder de referencia sobre las filas del caso, en el orden del diseño (name:asc, por punto de código). */
function run(finder, inputs, sabotage = null) {
  return FINDER_SEARCH_ROWS.filter((row) => matchesFinder(finder, row, inputs, { sabotage }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((row) => row.sku);
}

test('los casos FS-* se cumplen en la referencia', () => {
  const { finder } = searchCatalog();
  for (const testCase of FINDER_SEARCH_CASES) assert.deepEqual(run(finder, testCase.inputs), testCase.expect, `${testCase.id}: ${testCase.what}`);
});

test('cada sabotaje del finder cae en exactamente sus casos FS-*', () => {
  const { finder } = searchCatalog();
  for (const [sabotage, { breaks }] of Object.entries(FINDER_SABOTAGES)) {
    const fallen = FINDER_SEARCH_CASES.filter((testCase) => JSON.stringify(run(finder, testCase.inputs, sabotage)) !== JSON.stringify(testCase.expect)).map((testCase) => testCase.id);
    assert.deepEqual(fallen, breaks, sabotage);
  }
});

test('el plegado de referencia es el de TextFold, y las sondas de texto cubren la búsqueda', () => {
  assert.equal(foldText('Ñandú ÁÉ', 'ignore-case-accents'), 'nandu ae');
  assert.equal(foldText('Ñandú', 'ignore-case'), 'ñandú');
  assert.equal(foldText('Ñandú', 'exact'), 'Ñandú');
  const q = searchCatalog().finder.criteria.find((criterion) => criterion.op === 'search');
  assert.deepEqual(finderTextProbes(q), { hit: 'NDU 5%_.', misses: ['NDU 5_%', 'NDU 5%_..'] });
});

// ─── El orden del cliente ────────────────────────────────────────────────────────────────────────────────────

test('sortable se resuelve con la misma columna que el orden por defecto, y el contrato lista sus valores', () => {
  const operation = searchCatalog();
  assert.deepEqual(sortableOf(operation), ['name', 'sku', 'price.amount']);
  assert.deepEqual(operation.sortable.map((entry) => [entry.path, entry.property]), [['name', 'name'], ['sku', 'sku'], ['price.amount', 'priceAmount']]);
  const mongo = searchCatalog(modelOf('catalog-search-mongo', { ...STACK_DEFAULTS, database: 'mongodb' }));
  assert.equal(mongo.sortable[2].property, 'price.amount');
  assert.deepEqual(sortParameterValues(operation).slice(0, 3), ['name', 'name,asc', 'name,desc']);
  assert.deepEqual(sortableOf({}), []);
});

const SUBJECT = { sortable: ['name', 'sku', 'price.amount'], defaultSort: [{ path: 'name', direction: 'asc' }] };
const outcome = (result) => (result.rejected !== undefined ? 400 : result.sort.map(({ path, direction }) => [path, direction]));
const runSort = (testCase, sabotage = null) => outcome(readClientSort(testCase.values, { ...SUBJECT, ...(testCase.sortable ? { sortable: testCase.sortable } : {}) }, { sabotage }));

test('los casos SO-* se cumplen en la referencia', () => {
  for (const testCase of SO_CASES) assert.deepEqual(runSort(testCase), testCase.expect, `${testCase.id}: ${testCase.what}`);
  assert.deepEqual(readClientSort(['apiToken'], SUBJECT), { rejected: 'apiToken' });
  assert.equal(invalidSortMessage('apiToken'), "No se puede ordenar por 'apiToken'");
  assert.equal(FRAMEWORK_RESPONSES.invalidSort.status, 400);
});

test('cada sabotaje del orden cae en exactamente sus casos SO-*', () => {
  for (const [sabotage, { breaks }] of Object.entries(SO_SABOTAGES)) {
    const fallen = SO_CASES.filter((testCase) => JSON.stringify(runSort(testCase, sabotage)) !== JSON.stringify(testCase.expect)).map((testCase) => testCase.id);
    assert.deepEqual(fallen, breaks, sabotage);
  }
});

// ─── El cable, el contrato y la caché ────────────────────────────────────────────────────────────────────────

test('la lista en la query: repetida o con comas, ausente no filtra, vacía es 400', () => {
  for (const testCase of WIRE_QUERY_LIST_CASES) {
    assert.ok(WIRE_RULES[testCase.rule], testCase.id);
    assert.deepEqual(readQueryList(testCase.values), testCase.read, testCase.id);
  }
});

test('el contrato: sort solo con sortable, con su enum; la lista del in repetida y no vacía', () => {
  const document = openapiDocument(modelOf('catalog-search'));
  const parameters = (route) => document.paths[route].get.parameters;
  const search = parameters('/api/v1/products/search');
  const sort = search.find((parameter) => parameter.name === 'sort');
  assert.deepEqual([sort.style, sort.explode], ['form', true]);
  assert.equal(sort.schema.items.enum.length, 9);
  const statuses = search.find((parameter) => parameter.name === 'statuses');
  assert.deepEqual([statuses.style, statuses.explode, statuses.schema.minItems], ['form', true, 1]);
  // listProducts declara su sortable desde B8; la página de resultados de un trabajo de lote no, y no ofrece sort.
  assert.equal(parameters('/api/v1/products').find((parameter) => parameter.name === 'sort').schema.items.enum.length, 9);
  const results = Object.keys(document.paths).filter((route) => route.endsWith('/results'));
  assert.ok(results.length > 0, 'el sujeto tiene la página de resultados de un trabajo');
  for (const route of results) {
    assert.ok(parameters(route).some((parameter) => parameter.name === 'page'));
    assert.equal(parameters(route).some((parameter) => parameter.name === 'sort'), false, `${route}: sin sortable, sin sort`);
  }
});

test('la clave de la caché de un listado paginado suma la página y, con sortable, el orden (D18)', () => {
  const operation = searchCatalog();
  assert.deepEqual(cacheKeyExtras(operation), ['page', 'size', 'sort']);
  assert.deepEqual(cacheKeyExtras({ ...operation, sortable: null }), ['page', 'size']);
  assert.deepEqual(cacheKeyExtras({ paginated: false }), []);
});

test('las columnas de texto que se ordenan llevan la collation binaria del motor (U7)', () => {
  const model = modelOf('catalog-search');
  // name y sku son texto (sku por su value type SKU); price.amount es un número.
  assert.deepEqual(orderedTextColumns(model, 'Product').map((entry) => entry.property), ['sku', 'name']);
  assert.deepEqual(['postgresql', 'mysql', 'mariadb', 'mongodb'].map(binaryCollationFor), ['"C"', 'utf8mb4_bin', 'utf8mb4_bin', null]);
});

test('una base desplegada sin la collation del orden es trabajo de esquema pendiente, y una con ella no', () => {
  const model = modelOf('catalog-search');
  const before = ['CREATE TABLE products (', '    id uuid NOT NULL,', '    sku character varying(8) NOT NULL,', '    name character varying(120) NOT NULL,', '    notes text', ');'].join('\n');
  const work = orderCollationWork(model, before, '"C"');
  assert.equal(work.length, 2);
  assert.match(work[0], /`products\.sku`/);
  assert.match(work[1], /`products\.name`.*"C"/);
  const after = before.replace(/\) NOT NULL,/g, ') COLLATE pg_catalog."C" NOT NULL,');
  assert.deepEqual(orderCollationWork(model, after, '"C"'), []);
  // La propiedad `name = '…'` de la clase de una migración de TypeORM no es la columna `name` (lo destapó B8).
  assert.deepEqual(orderCollationWork(model, `  name = 'BaselineSchema1000000000000';\n${after}`, '"C"'), []);
  // Sin baseline (todavía no se exportó) o en un motor que ya ordena por punto de código, nada.
  assert.deepEqual(orderCollationWork(model, null, '"C"'), []);
  assert.deepEqual(orderCollationWork(model, before, null), []);
});
