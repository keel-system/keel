// La sombra plegada de un FILTRO: `listProducts.name` pide `compare: ignore-case-accents` y `Product.name` no.
//
// Hasta aquí build no emitía nada: el agente de keel-spring escribía a mano la columna `name_normalized` y el de
// keel-nest plegaba en la consulta con `translate(lower(…))`, otra función de plegado que la de `TextFold` (corridas
// de catalog, 2026-10-10 y 2026-10-11). Ahora el modelo deriva `filterFold` (keel-core/gen/model.js) y los dos
// generadores emiten la columna y la estampan; lo que NO hace es lo que hace el `compare` del propio campo: llevar su
// unicidad, sus búsquedas por clave o su orden.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { textFilterNotes } from 'keel-core/gen/text-filters';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function spring(stack, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  if (mutate) mutate(layers);
  const { files, model } = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack });
  return { model, read: (suffix) => files.find((f) => f.path.endsWith(suffix))?.content };
}

function nest(stack, mutate = null) {
  const { files, model } = planFixture('catalog-extended', { stack, mutate });
  return { model, read: (suffix) => files.find((f) => f.path.endsWith(suffix))?.content };
}

const RELATIONAL = { database: 'postgresql', broker: 'kafka' };
const DOCUMENT = { database: 'mongodb', broker: 'kafka' };

test('el modelo deriva la sombra del filtro, no la del campo', () => {
  const name = nest(RELATIONAL).model.entities.find((e) => e.name === 'Product').fields.find((f) => f.name === 'name');
  assert.equal(name.fold, null);
  assert.deepEqual(name.filterFold, { accents: true, maxLength: name.textMaxLength, shadow: 'nameNormalized', operations: ['listProducts'] });
});

test('relacional: los dos generadores emiten y estampan name_normalized, sin unicidad sobre ella', () => {
  const s = spring(RELATIONAL);
  const n = nest(RELATIONAL);
  assert.match(s.read('/ProductJpa.java'), /@Column\(name = "name_normalized", nullable = false\)\n\s+private String nameNormalized;/);
  assert.ok(s.read('/ProductRepositoryImpl.java').includes('jpa.setNameNormalized(TextFold.foldCaseAndAccents(domain.getName()));'));
  assert.match(n.read('product-orm.ts'), /@Column\(\{ name: 'name_normalized', type: 'varchar', length: 255, nullable: false \}\)/);
  assert.ok(n.read('product-repository-impl.ts').includes('orm.nameNormalized = TextFold.foldCaseAndAccents(entity.name);'));
  // La unicidad sigue en la clave natural, y nada se pone sobre la sombra.
  assert.ok(s.read('/ProductJpa.java').includes('@UniqueConstraint(name = "uk_products_natural", columnNames = { "sku" })'));
  assert.ok(!/name_normalized"? *\}\)/.test(s.read('/ProductJpa.java').split('\n').find((l) => l.includes('@Table')) ?? ''));
  assert.ok(n.read('product-orm.ts').includes("@Unique('uk_products_natural', ['sku'])"));
});

test('documental: el documento lleva name_normalized y el adaptador lo estampa', () => {
  assert.ok(spring(DOCUMENT).read('/ProductDocument.java').includes('@Field(name = "name_normalized")'));
  assert.ok(spring(DOCUMENT).read('/ProductRepositoryImpl.java').includes('doc.setNameNormalized(TextFold.foldCaseAndAccents(domain.getName()));'));
  assert.match(nest(DOCUMENT).read('product-repository-impl.ts'), /name_normalized: TextFold\.foldCaseAndAccents\(entity\.name\)/);
});

// Una búsqueda SIN finder (DSL 2.22: un input que no enlaza): la consulta es del agente, y la nota le dice cómo plegar.
// Con todos los inputs enlazados, el finder ya pliega y la nota del handler es la del finder (test/finders.test.js).
const withoutFinder = (layers) => {
  layers['use-cases'].operations.listProducts.input.fields.search = { type: 'string', constraints: { maxLength: 60 } };
};

test('la nota del handler es la MISMA en los dos y manda contra la sombra, nunca con lower()/translate()', () => {
  const { model } = nest(RELATIONAL, withoutFinder);
  const operation = model.services.flatMap((s) => s.operations).find((o) => o.name === 'listProducts');
  const [note] = textFilterNotes(model, operation);
  assert.match(note, /pliega el parámetro con TextFold\.foldCaseAndAccents\(\.\.\.\) y compáralo contra Product\.nameNormalized/);
  const flat = (text) => text.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(flat(spring(RELATIONAL, withoutFinder).read('/ListProductsQueryHandler.java')).includes('compáralo contra Product.nameNormalized'));
  assert.ok(flat(nest(RELATIONAL, withoutFinder).read('list-products-query-handler.ts')).includes('compáralo contra Product.nameNormalized'));
});

test('un campo unique sin compare conserva su unicidad sobre la columna cruda aunque un filtro lo pliegue', () => {
  const unique = (layers) => (layers.domain.entities.Product.fields.name.unique = true);
  const s = spring(RELATIONAL, unique);
  const n = nest(RELATIONAL, unique);
  assert.ok(s.read('/ProductJpa.java').includes('@UniqueConstraint(name = "uk_products_name", columnNames = { "name" })'), 'spring');
  assert.ok(n.read('product-orm.ts').includes("@Unique('uk_products_name', ['name'])"), 'nest');
  // Y el finder del campo único busca el valor tal cual, no por la sombra.
  assert.ok(s.read('/ProductJpaRepository.java').includes('Optional<ProductJpa> findByName(String name);'));
  assert.match(n.read('product-repository-impl.ts'), /async findByName\(name: string\)[\s\S]*?where: \{ name \}/);
  const d = spring(DOCUMENT, unique).read('/MongoIndexConfig.java');
  assert.match(d, /\.on\("name", Sort\.Direction\.ASC\)[\s\S]*?\.named\("uk_products_name"\)/);
});

test('dos filtros con plegados distintos sobre el mismo campo: ninguna sombra, y se avisa', () => {
  const twice = (layers) => {
    const list = layers['use-cases'].operations.listProducts;
    layers['use-cases'].operations.searchProducts = {
      ...structuredClone(list),
      input: { fields: { name: { ...list.input.fields.name, compare: 'ignore-case' } } }
    };
  };
  const { model } = nest(RELATIONAL, twice);
  const name = model.entities.find((e) => e.name === 'Product').fields.find((f) => f.name === 'name');
  assert.equal(name.filterFold, null);
  assert.ok(model.warnings.some((w) => w.startsWith('Product.name: los filtros de listProducts, searchProducts')), model.warnings.join('\n'));
});

test('un filtro por patrón: el texto buscado es LITERAL, en la nota de los dos y en el LikePattern que emite keel-nest', async () => {
  // El agente de keel-nest escribió su escape con un template literal que nunca interpolaba: ?name=50% buscaba
  // «50${character}», y la barra no se escapaba. Ningún escenario buscaba un comodín (corrida catalog-nest, 2026-10-13).
  const { model } = nest(RELATIONAL, withoutFinder);
  const operation = model.services.flatMap((s) => s.operations).find((o) => o.name === 'listProducts');
  const [note] = textFilterNotes(model, operation);
  assert.match(note, /el texto buscado es LITERAL: un %, un _ o una barra invertida/);
  const flat = (text) => text.replace(/\n\s*\/\/\s*/g, ' ');
  assert.ok(flat(spring(RELATIONAL, withoutFinder).read('/ListProductsQueryHandler.java')).includes('el texto buscado es LITERAL'));
  assert.ok(flat(nest(RELATIONAL, withoutFinder).read('list-products-query-handler.ts')).includes('LikePattern.prefix(...)/contains(...)'));

  const { files } = planFixture('catalog-extended', { stack: RELATIONAL });
  const tree = transpileTree(files);
  const { LikePattern } = await tree.load('src/infrastructure/persistence/like-pattern.ts');
  // String.raw: lo que se lee es lo que viaja al motor, barra a barra.
  assert.equal(LikePattern.contains('50%'), String.raw`%50\%%`);
  assert.equal(LikePattern.prefix('a_b'), String.raw`a\_b%`);
  assert.equal(LikePattern.contains(String.raw`c\d`), String.raw`%c\\d%`);
  assert.equal(LikePattern.prefix('bota'), 'bota%');
  // Sin base relacional no hay LIKE: el documental no lo emite.
  assert.equal(planFixture('catalog-extended', { stack: DOCUMENT }).files.some((f) => f.path.endsWith('like-pattern.ts')), false);
});
