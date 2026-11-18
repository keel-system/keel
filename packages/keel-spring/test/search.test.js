// La BÚSQUEDA de DSL 2.32 en keel-spring (B3 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): la forma de lo que emite
// build sobre los sujetos de keel-core/test/helpers/finder-designs.js (SEARCH_DESIGNS). Lo que esto NO dice —que el
// finder devuelva las filas de los casos FS-*, que el lector de ?sort= cumpla los SO-*— lo mide
// scripts/finder-check.js contra el motor real, con un sabotaje por caso.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { SEARCH_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { withOrderCollation } from '../src/lib/type-mapper.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => SEARCH_DESIGNS.find((entry) => entry.name === name);

function plan(name, database = 'postgresql') {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  const document = layers.persistence?.default?.model === 'document';
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : database } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos de la búsqueda pasan la frontera de keel-spring', () => {
  for (const { name, from, mutate } of SEARCH_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('el finder relacional: in, ne con la fila nula y la búsqueda como OR sobre las sombras, el texto literal', () => {
  const adapter = fileOf(plan('catalog-search').files, '/ProductRepositoryImpl.java');
  assert.match(adapter, /where\.add\(root\.get\("status"\)\.in\(filter\.statuses\(\)\)\);/);
  assert.match(adapter, /cb\.or\(cb\.isNull\(root\.get\("notes"\)\), cb\.notEqual\(root\.get\("notes"\), filter\.notNotes\(\)\)\)/);
  assert.match(adapter, /String qPattern = likePattern\(TextFold\.foldCaseAndAccents\(filter\.q\(\)\), false\);/);
  assert.match(adapter, /cb\.or\(cb\.like\(root\.<String>get\("nameNormalized"\), qPattern, '\\\\'\), cb\.like\(root\.<String>get\("notesNormalized"\), qPattern, '\\\\'\)\)/);
});

test('el finder documental: $in, $ne y un $or de expresiones citadas', () => {
  const adapter = fileOf(plan('catalog-search-mongo').files, '/ProductRepositoryImpl.java');
  assert.match(adapter, /Criteria\.where\("status"\)\.in\(filter\.statuses\(\)\)/);
  assert.match(adapter, /Criteria\.where\("notes"\)\.ne\(filter\.notNotes\(\)\)/);
  assert.match(adapter, /String qRegex = Pattern\.quote\(TextFold\.foldCaseAndAccents\(filter\.q\(\)\)\);/);
  assert.match(adapter, /new Criteria\(\)\.orOperator\(Criteria\.where\("nameNormalized"\)\.regex\(qRegex\), Criteria\.where\("notesNormalized"\)\.regex\(qRegex\)\)/);
});

test('el controller lee ?sort= y la lista de la query con QueryParameters, de los valores crudos', () => {
  const { files } = plan('catalog-search');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /SEARCH_CATALOG_SORTABLE = Map\.of\("name", "name", "sku", "sku", "price\.amount", "priceAmount"\);/);
  assert.match(controller, /QueryParameters\.list\(request, "statuses", QueryParameters\.enumValue\(ProductStatus\.class\)\)/);
  assert.match(controller, /QueryParameters\.sorted\(pageable, request, SEARCH_CATALOG_SORTABLE, SEARCH_CATALOG_ORDER\)/);
  // La lista ya no es un @RequestParam: Spring la partiría por comas con un valor y no con varios.
  assert.doesNotMatch(controller, /@RequestParam[^,]*List<ProductStatus> statuses/);
  // El listado de product-catalog declara su sortable desde B8; sin él, cualquier ?sort= es 400 (U3, SO-11).
  assert.match(controller, /LIST_PRODUCTS_SORTABLE = Map\.of\("sku", "sku", "name", "name", "price\.amount", "priceAmount"\);/);
  const reader = fileOf(files, '/QueryParameters.java');
  assert.match(reader, /request\.getParameterValues\("sort"\)/);
  assert.match(reader, /value\.split\(",", -1\)/);
  assert.ok(reader.includes(FRAMEWORK_RESPONSES.invalidSort.message.split('{sort}')[0]));
  const handler = fileOf(files, '/ApiExceptionHandler.java');
  assert.match(handler, /@ExceptionHandler\(QueryParameters\.InvalidQuery\.class\)/);
});

test('las columnas de texto ordenables llevan la collation binaria del motor, con su cota (U7)', () => {
  const pg = fileOf(plan('catalog-search').files, '/ProductJpa.java');
  assert.match(pg, /name = "name", nullable = false, columnDefinition = "varchar\(120\) collate \\"C\\""/);
  assert.match(pg, /name = "sku", nullable = false, columnDefinition = "varchar\(8\) collate \\"C\\""/);
  // notes no se ordena: sin collation.
  assert.match(pg, /name = "notes", columnDefinition = "text"\)/);
  const mysql = fileOf(plan('catalog-search', 'mysql').files, '/ProductJpa.java');
  // sku ya la tenía por única (la misma utf8mb4_bin): una sola.
  assert.match(mysql, /name = "sku", nullable = false, columnDefinition = "varchar\(8\) collate utf8mb4_bin"\)/);
  assert.match(mysql, /name = "name", nullable = false, columnDefinition = "varchar\(120\) collate utf8mb4_bin"\)/);
});

test('withOrderCollation conserva la cota y no dobla la collation', () => {
  assert.equal(withOrderCollation('@Column(name = "a", length = 40)', '"C"'), '@Column(name = "a", columnDefinition = "varchar(40) collate \\"C\\"")');
  assert.equal(withOrderCollation('@Column(name = "a", columnDefinition = "text")', 'utf8mb4_bin'), '@Column(name = "a", columnDefinition = "text collate utf8mb4_bin")');
  assert.equal(withOrderCollation('@Column(name = "a")', 'utf8mb4_bin'), '@Column(name = "a", columnDefinition = "varchar(255) collate utf8mb4_bin")');
  const unique = '@Column(name = "a", columnDefinition = "varchar(8) collate utf8mb4_bin")';
  assert.equal(withOrderCollation(unique, 'utf8mb4_bin'), unique);
  assert.equal(withOrderCollation('@Column(name = "a", length = 40)', null), '@Column(name = "a", length = 40)');
});

test('la clave de la caché de un listado paginado suma la página, el tamaño y el orden (D18)', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design('catalog-search').from));
  design('catalog-search').mutate(layers);
  layers['use-cases'].operations.searchCatalog.cache = { ttlSeconds: 60, keyFields: ['q'] };
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql', cache: 'redis' } });
  const cached = fileOf(files, '/CachedOperations.java');
  assert.match(cached, /key\(query\.q\(\), query\.pageable\(\)\.getPageNumber\(\), query\.pageable\(\)\.getPageSize\(\), query\.pageable\(\)\.getSort\(\)\)/);
});
