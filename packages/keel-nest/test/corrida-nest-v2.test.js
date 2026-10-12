// Lo que las corridas de control de keel-nest (asset-vault y catalog, 2026-10-11) escribieron a mano o destaparon:
//
//   - la lectura por lote del `embed` (el <Raíz>RefResolver de keel-spring sobre findAllById), que keel-nest no
//     emitía: sus dos corridas de asset-vault la escribieron (findAllByIds, findAllByIdIn);
//   - la lectura por lote de una query que recibe la lista de ids de la raíz que devuelve (getProductsByIds): las
//     cuatro corridas de catalog, en los dos generadores;
//   - la nota y los puertos del handler de una subida: el límite de negocio del bucket lo comprueba el handler;
//   - las FK entre agregados en el baseline de keel-nest, que el de keel-spring sí lleva.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { idBatchReason } from 'keel-core/gen/ref-targets';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const ASSET_VAULT = { database: 'mongodb', broker: 'rabbitmq' };
const CATALOG = { database: 'postgresql', broker: 'kafka' };

function springRead(name, stack) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
  return (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
}

function nest(name, stack) {
  const plan = planFixture(name, { stack });
  return { ...plan, read: (suffix) => plan.files.find((f) => f.path.endsWith(suffix))?.content };
}

const flat = (text) => text.replace(/\n\s*\/\/\s*/g, ' ');

test('el modelo decide por qué una raíz se lee por lote: el embed o la lista de ids', () => {
  const { model } = nest('catalog-extended', CATALOG);
  const reason = (name) => idBatchReason(model, model.entities.find((e) => e.name === name));
  assert.equal(reason('Category'), 'embed');
  assert.equal(reason('Product'), 'listed-ids');
  assert.equal(reason('SupplierPrice'), null);
});

test('asset-vault: el embed de Owner se resuelve por lote en keel-nest, como en keel-spring', async () => {
  const { files, read } = nest('asset-vault', ASSET_VAULT);
  assert.match(read('owner-repository.ts'), /abstract findAllById\(ids: readonly string\[\]\): Promise<Owner\[\]>;/);
  assert.match(read('owner-repository-impl.ts'), /async findAllById\(ids: readonly string\[\]\): Promise<Owner\[\]> \{/);
  // El resolver se registra en el módulo y se inyecta en los handlers que embeben Owner, con su nota.
  assert.ok(read('use-case-module.ts').includes('OwnerRefResolver'));
  const listing = read('list-assets-query-handler.ts');
  assert.match(listing, /static readonly inject = \[AssetRepository, OwnerRefResolver, AssetApplicationMapper\] as const;/);
  assert.ok(flat(listing).includes('UNA llamada a await this.ownerRefResolver.resolveAll(ids)'));
  assert.ok(springRead('asset-vault', ASSET_VAULT)('/OwnerRefResolver.java'), 'keel-spring lo emitía ya');

  // EJECUTADO: una consulta para toda la página, nulos y repetidos fuera, indexado por id.
  const { load } = transpileTree(files);
  const { OwnerRefResolver } = await load('src/application/support/owner-ref-resolver.ts');
  const calls = [];
  const repository = {
    findAllById: async (ids) => {
      calls.push(ids);
      return ids.filter((id) => id !== 'nadie').map((id) => ({ id, code: `C-${id}` }));
    },
    findById: async (id) => (id === 'nadie' ? null : { id, code: `C-${id}` })
  };
  const mapper = { toOwnerRefDto: (owner) => ({ id: owner.id, code: owner.code }) };
  const resolver = new OwnerRefResolver(repository, mapper);
  const map = await resolver.resolveAll(['a', 'b', 'a', null, 'nadie']);
  assert.deepEqual(calls, [['a', 'b', 'nadie']], 'una sola consulta, sin repetidos ni nulos');
  assert.deepEqual([...map.keys()], ['a', 'b']);
  assert.deepEqual(map.get('a'), { id: 'a', code: 'C-a' });
  assert.equal((await resolver.resolveAll([null])).size, 0);
  assert.deepEqual(await resolver.resolve('b'), { id: 'b', code: 'C-b' });
  assert.equal(await resolver.resolve('nadie'), null);
});

test('catalog: getProductsByIds tiene findAllById y la nota del lote en los dos generadores', () => {
  const { read } = nest('catalog-extended', CATALOG);
  assert.match(read('product-repository.ts'), /abstract findAllById\(ids: readonly string\[\]\): Promise<Product\[\]>;/);
  assert.match(read('product-repository-impl.ts'), /where: \{ id: In\(\[\.\.\.ids\]\) \}/);
  assert.ok(flat(read('get-products-by-ids-query-handler.ts')).includes('UNA consulta, await this.productRepository.findAllById(query.ids)'));
  const spring = springRead('catalog-extended', CATALOG);
  assert.ok(spring('/ProductRepository.java').includes('List<Product> findAllById(Collection<UUID> ids);'));
  assert.ok(flat(spring('/GetProductsByIdsQueryHandler.java')).includes('UNA consulta, productRepository.findAllById(query.ids())'));
});

test('la subida: el handler recibe StoragePolicies y FileStorage, y la nota del límite del bucket, en los dos', () => {
  const { read } = nest('catalog-extended', CATALOG);
  const nestHandler = read('add-product-image-command-handler.ts');
  assert.match(nestHandler, /private readonly storagePolicies: StoragePolicies, private readonly fileStorage: FileStorage/);
  const spring = springRead('catalog-extended', CATALOG)('/AddProductImageCommandHandler.java');
  assert.ok(spring.includes('private final StoragePolicies storagePolicies;') && spring.includes('private final FileStorage fileStorage;'));
  for (const handler of [flat(nestHandler), flat(spring)]) {
    assert.ok(handler.includes('storagePolicies.forBucket(StoragePolicies.PRODUCT_IMAGES)'), handler);
    assert.ok(handler.includes('el límite de este bucket (5 MB) lo compruebas TÚ, lo primero, con allowsSize(tamaño) → FILE_TOO_LARGE (413)'), handler);
  }
});

test('el baseline de keel-nest lleva las FK entre agregados con los nombres de keel-spring', () => {
  const baseline = nest('catalog-extended', CATALOG).read('schema-baseline.ts');
  assert.ok(baseline.includes('[{"name":"fk_categories_parent","table":"categories","column":"parent_id","refTable":"categories","refColumn":"id"},{"name":"fk_products_category","table":"products","column":"category_id","refTable":"categories","refColumn":"id"}]'));
  assert.ok(baseline.includes('const diff = log.upQueries.filter((statement) => !dropsCrossAggregateKey(statement));'));
  const appendix = springRead('catalog-extended', CATALOG)('infra/export-schema.sh');
  for (const name of ['fk_categories_parent', 'fk_products_category']) assert.ok(appendix.includes(name), `keel-spring también: ${name}`);
});
