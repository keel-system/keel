// El finder de una clave natural con `compare: ignore-case` busca por la SOMBRA plegada, que es lo que la
// unicidad indexa (corrida catalog de keel-nest, 2026-10-10: `CategoryRepositoryImpl.findBySlug` comparaba
// `slug` crudo y «Tools» no encontraba la categoría «tools» que el índice daba por existente). El puerto sigue
// recibiendo el valor tal cual; el adaptador lo pliega. Se mide en las cuatro ramas —keel-nest y keel-spring,
// relacional y documental— porque el defecto estaba en las cuatro.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const BRANCHES = [
  {
    database: 'postgresql',
    nest: /findBySlug\(slug: string\): Promise<Category \| null> \{\n\s+const found = await this\.manager\.findOne\(CategoryOrm, \{ where: \{ slugNormalized: TextFold\.foldCase\(slug\) \} \}\);/,
    store: 'CategoryJpaRepository.java',
    springAdapter: /categoryJpaRepository\.findBySlugNormalized\(TextFold\.foldCase\(slug\)\)/
  },
  {
    database: 'mongodb',
    nest: /findBySlug\(slug: string\): Promise<Category \| null> \{\n\s+const found = await this\.collection\.findOne\(\{ 'slug_normalized': TextFold\.foldCase\(slug\) \}/,
    store: 'CategoryMongoRepository.java',
    springAdapter: /categoryMongoRepository\.findBySlugNormalized\(TextFold\.foldCase\(slug\)\)/
  }
];

for (const { database, nest, store, springAdapter } of BRANCHES) {
  test(`${database}: la clave natural plegada se busca por su sombra, con el puerto intacto`, () => {
    const stack = { database, broker: 'rabbitmq' };
    const files = Object.fromEntries(planFixture('catalog-extended', { stack }).files.map((f) => [f.path, f.content]));
    assert.match(files['src/domain/repository/category-repository.ts'], /abstract findBySlug\(slug: string\): Promise<Category \| null>;/);
    const adapter = files['src/infrastructure/persistence/repositories/category-repository-impl.ts'];
    assert.match(adapter, nest);
    assert.match(adapter, /import \{ TextFold \} from '\.\.\/text-fold\.js';/);

    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
    const read = (name) => spring.find((f) => f.path.endsWith(`/${name}`)).content;
    assert.match(read('CategoryRepository.java'), /Optional<Category> findBySlug\(String slug\);/, 'el puerto de keel-spring no cambia');
    assert.match(read(store), /findBySlugNormalized\(String slugNormalized\);/, 'Spring Data deriva la consulta sobre la sombra');
    assert.doesNotMatch(read(store), /findBySlug\(String slug\)/);
    assert.match(read('CategoryRepositoryImpl.java'), springAdapter);
  });
}

test('un campo sin pliegue sigue buscándose por su valor', () => {
  const files = Object.fromEntries(planFixture('catalog-extended', { stack: { database: 'postgresql', broker: 'rabbitmq' } }).files.map((f) => [f.path, f.content]));
  assert.match(files['src/infrastructure/persistence/repositories/product-repository-impl.ts'], /findOne\(ProductOrm, \{ where: \{ sku \}/);
});
