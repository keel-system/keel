// La BÚSQUEDA de DSL 2.32 en keel-nest (B4 de PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): la forma de lo que emite
// build sobre los sujetos de keel-core/test/helpers/finder-designs.js (SEARCH_DESIGNS), y lo que se puede EJECUTAR sin
// base: el lector de ?sort= (los casos SO-*, contra readClientSort) y el de la lista en la query (WIRE_QUERY_LIST_CASES,
// contra readQueryList). Que el finder devuelva las filas de los casos FS-* lo miden db-check y doc-check contra el
// motor real (scripts/lib/search-probes.js), con un sabotaje por caso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAMEWORK_RESPONSES } from '@keel-system/keel-core/gen/api-errors';
import { SO_CASES, readClientSort } from '@keel-system/keel-core/gen/pagination';
import { WIRE_QUERY_LIST_CASES } from '@keel-system/keel-core/gen/wire';
import { loadService } from '@keel-system/keel-core';
import fs from 'node:fs';
import path from 'node:path';
import { SEARCH_DESIGNS } from '../../keel-core/test/helpers/finder-designs.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { BASELINE_FILE, MIGRATIONS_DIR, schemaSteps } from '../src/scaffold/schema-baseline.js';

const design = (name) => SEARCH_DESIGNS.find((entry) => entry.name === name);

function plan(name, database = 'postgresql') {
  const { from, mutate } = design(name);
  return planFixture(from, { mutate, stack: { database: name.endsWith('-mongo') ? 'mongodb' : database } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos de la búsqueda pasan la frontera de keel-nest', () => {
  for (const { name, from, mutate } of SEARCH_DESIGNS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, from));
    mutate(layers);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
  }
});

test('el finder relacional: In, ne con la fila nula y la búsqueda como ramas OR sobre las sombras, con el texto literal', () => {
  const adapter = fileOf(plan('catalog-search').files, 'product-repository-impl.ts');
  assert.match(adapter, /and\('status', In\(filter\.statuses\)\);/);
  assert.match(adapter, /and\('notes', Or\(IsNull\(\), Not\(Equal\(filter\.notNotes\)\)\)\);/);
  assert.match(adapter, /const text = TextFold\.foldCaseAndAccents\(filter\.q\);/);
  assert.match(adapter, /\[\['nameNormalized', Like\(LikePattern\.contains\(text\)\)\], \['notesNormalized', Like\(LikePattern\.contains\(text\)\)\]\]/);
  assert.match(adapter, /where: branches as FindOptionsWhere<ProductOrm>\[\]/);
});

test('el finder documental: $in, $ne y un $or de expresiones citadas', () => {
  const adapter = fileOf(plan('catalog-search-mongo').files, 'product-repository-impl.ts');
  assert.match(adapter, /'status': \{ \$in: filter\.statuses\.map\(\(item\) => toEnumName\(ProductStatus, item\)\) \}/);
  assert.match(adapter, /'notes': \{ \$ne: filter\.notNotes \}/);
  assert.match(adapter, /\$or: \[\{ 'name_normalized': \{ \$regex: literalPattern\(TextFold\.foldCaseAndAccents\(filter\.q\)\) \} \}, \{ 'notes_normalized': \{ \$regex: literalPattern\(TextFold\.foldCaseAndAccents\(filter\.q\)\) \} \}\]/);
});

test('el controlador pasa el sortable de la operación y lee la lista con su nombre; sin sortable, ninguno', () => {
  const { files } = plan('catalog-search');
  const controller = files.filter((file) => file.path.includes('/controllers/')).map((file) => file.content).join('\n');
  assert.match(controller, /sortable: \{ 'name': 'name', 'sku': 'sku', 'price\.amount': 'priceAmount' \}/);
  assert.match(controller, /text\.listOf\(text\.enumOf\(ProductStatus\), 'statuses'\)\(query\['statuses'\]\)/);
  // El listado de product-catalog sin sortable: readPageable sin él, y todo ?sort= es 400 (U3).
  assert.match(controller, /readPageable\(query, \{ defaultSize: \d+, maxSize: \d+, defaultSort: \[\{ property: 'sku', direction: 'asc' \}\] \}\)/);
  const routes = fileOf(files, 'src/infrastructure/rest/routes.ts');
  assert.match(routes, /operation: 'searchCatalog'.*query: \['statuses', 'notNotes', 'q', 'page', 'size', 'sort'\]/);
  assert.doesNotMatch(routes, /operation: 'listProducts'.*'sort'/);
  const errors = fileOf(files, 'src/infrastructure/rest/request-errors.ts');
  assert.ok(errors.includes(FRAMEWORK_RESPONSES.invalidSort.message.split('{sort}')[0]));
});

test('el readPageable emitido cumple los casos SO-* de keel-core (y la referencia también)', async () => {
  const { files, model } = plan('catalog-search');
  const { readPageable } = await transpileTree(files).load('src/infrastructure/rest/pageable-reading.ts');
  const operation = model.services.flatMap((group) => group.operations).find((candidate) => candidate.name === 'searchCatalog');
  const property = new Map([...operation.sort, ...operation.sortable].map((entry) => [entry.path, entry.property]));
  const defaultSort = operation.sort.map((entry) => ({ property: entry.property, direction: entry.direction }));
  for (const entry of SO_CASES) {
    const paths = entry.sortable ?? operation.sortable.map((sortable) => sortable.path);
    const sortable = Object.fromEntries(paths.map((path) => [path, property.get(path)]));
    const reference = readClientSort(entry.values, { sortable: paths, defaultSort: operation.sort });
    assert.equal(reference.rejected !== undefined, entry.expect === 400, `${entry.id}: la referencia`);
    const read = () => readPageable(entry.values === null ? {} : { sort: entry.values }, { defaultSize: 10, maxSize: 100, defaultSort, sortable }).sort;
    if (entry.expect === 400) {
      assert.throws(read, (error) => error.name === 'InvalidSortError', `${entry.id}: ${entry.what}`);
    } else {
      assert.deepEqual(read().map((order) => [order.property, order.direction]), entry.expect.map(([path, direction]) => [property.get(path), direction]), `${entry.id}: ${entry.what}`);
    }
  }
});

test('la lista de la query emitida cumple WIRE_QUERY_LIST_CASES (U8 y D10)', async () => {
  const { files } = plan('catalog-search');
  const { text } = await transpileTree(files).load('src/infrastructure/rest/request-reading.ts');
  const reader = text.listOf(text.string, 'statuses');
  for (const entry of WIRE_QUERY_LIST_CASES) {
    const value = entry.values === null ? undefined : entry.values.length === 1 ? entry.values[0] : entry.values;
    if (entry.read === 400) {
      assert.throws(() => reader(value), (error) => error.name === 'RequestValidationError' && error.details[0] === 'statuses', entry.id);
    } else {
      assert.deepEqual(reader(value), entry.read, entry.id);
    }
  }
});

test('las columnas de texto ordenables llevan la collation binaria del motor (U7)', () => {
  const pg = fileOf(plan('catalog-search').files, 'product-orm.ts');
  assert.match(pg, /name: 'name', type: 'varchar', length: 120, collation: 'C', nullable: false/);
  assert.match(pg, /name: 'sku', type: 'varchar', length: 8, collation: 'C', nullable: false/);
  // notes no se ordena: sin collation.
  assert.match(pg, /name: 'notes', type: 'text', nullable: true/);
  const mysql = fileOf(plan('catalog-search', 'mysql').files, 'product-orm.ts');
  assert.match(mysql, /name: 'name', type: 'varchar', length: 120, collation: 'utf8mb4_bin', nullable: false/);
  // sku ya la tenía por única (la misma utf8mb4_bin): una sola.
  assert.match(mysql, /name: 'sku', type: 'varchar', length: 8, collation: 'utf8mb4_bin', nullable: false/);
});

test('la clave de la caché de un listado paginado suma la página, el tamaño y el orden (D18)', () => {
  const { from, mutate } = design('catalog-search');
  const { files } = planFixture(from, {
    mutate: (layers) => {
      mutate(layers);
      layers['use-cases'].operations.searchCatalog.cache = { ttlSeconds: 60, keyFields: ['q'] };
    },
    stack: { database: 'postgresql', cache: 'redis' }
  });
  const cached = fileOf(files, 'cached-operations.ts');
  assert.match(cached, /cacheKey\(message\.q, message\.pageable\.page, message\.pageable\.size, message\.pageable\.sort\.map\(\(order\) => `\$\{order\.property\},\$\{order\.direction\}`\)\.join\(';'\)\)/);
});

test('una base desplegada sin la collation del orden deja su ALTER en el trabajo de esquema de EVOLUTION.md (U7)', () => {
  const { files, model } = plan('catalog-search');
  const projectDir = tmpDir('keel-nest-order-collation-');
  fs.mkdirSync(path.join(projectDir, MIGRATIONS_DIR), { recursive: true });
  // El baseline que exportó una versión anterior: name sin collation; sku ya la llevaba (la de la unicidad).
  const baseline = 'await queryRunner.query(`CREATE TABLE \\"products\\" (\\"id\\" uuid NOT NULL, \\"name\\" character varying(120) NOT NULL, \\"sku\\" character varying(8) COLLATE \\"C\\" NOT NULL)`);';
  fs.writeFileSync(path.join(projectDir, MIGRATIONS_DIR, BASELINE_FILE), baseline);
  const { work } = schemaSteps(model, files, projectDir);
  const collation = work.filter((line) => line.includes('collation binaria'));
  assert.equal(collation.length, 1, collation.join('\n'));
  assert.match(collation[0], /`products\.name`/);
});
