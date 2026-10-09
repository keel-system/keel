// La caché de lectura como DATOS (keel-core/gen/cache-plan.js): los nombres con los que los dos generadores
// guardan sus cachés y qué operación invalida cada una. Se construye con una proyección que no es de ningún
// lenguaje: el plan no puede depender de cómo se escriba el código.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { cachedOperations, cacheInvalidations, unbackedInvalidations, CACHE_ENTRY_SEPARATOR, CACHE_KEY_PART_SEPARATOR } from '../src/lib/gen/cache-plan.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

const nameOf = (resolved) => resolved.name ?? resolved.base;
const PROBE = {
  projectSuffix: 'probe',
  service: () => ({ module: 'probe' }),
  parameterType: (type) => ({ typeRef: `ref:${type}` }),
  fieldType: (resolved, { list = false } = {}) => ({ typeRef: `ref:${nameOf(resolved)}${list ? '[]' : ''}` }),
  elementType: (resolved) => ({ elementRef: `ref:${nameOf(resolved)}` }),
  namedType: (name, { list = false } = {}) => ({ typeRef: `ref:${name}${list ? '[]' : ''}` }),
  namedElement: (name) => ({ elementRef: `ref:${name}` }),
  renamed: (name) => ({ typeRef: `ref:${name}`, elementRef: `ref:${name}` }),
  typeNameOf: (field) => field?.typeRef?.replace(/^ref:/, ''),
  carryType: (field) => ({ typeRef: field.typeRef }),
  uploadType: () => ({ typeRef: 'ref:upload', elementRef: 'ref:upload' }),
  uploadValidation: () => ({ validation: [], inputValidation: [] }),
  replicaKey: (keyField) => ({ keyRef: keyField?.typeRef ?? 'ref:uuid' }),
  errorBase: (http) => `error-${http}`,
  fieldDetails: () => ({ validation: [], numeric: null, inputValidation: [], inheritedPattern: null, columns: [], elementColumns: [], initializer: null }),
  messages: {
    lockVersionReserved: (entity) => `lockVersion reservado en ${entity}`,
    readQueriesRef: (kind) => `lecturas-${kind}`,
    pathParamFallback: (op, route, name) => `${op}: ${route} sin ${name}`,
    cognitoEmulated: () => 'cognito emulado'
  }
};

function modelOf(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model), cache: 'redis' };
  return buildModel({ manifest, layers, stack, projection: PROBE });
}

test('la forma de la clave es la de RedisCacheManager: <servicio>:<operación>::<clave>, con los keyFields por «:»', () => {
  assert.equal(CACHE_ENTRY_SEPARATOR, '::');
  assert.equal(CACHE_KEY_PART_SEPARATOR, ':');
  const [cache] = cachedOperations(modelOf('catalog-extended'));
  assert.deepEqual(
    { operation: cache.operation, constant: cache.constant, cacheName: cache.cacheName, ttlSeconds: cache.ttlSeconds, keyFields: cache.keyFields },
    { operation: 'getProductBySlug', constant: 'GET_PRODUCT_BY_SLUG_CACHE', cacheName: 'catalog:get-product-by-slug', ttlSeconds: 300, keyFields: ['slug'] }
  );
});

test('una caché la invalida la operación que EMITE uno de sus eventos y la que CONSUME la suscripción a uno', () => {
  const vault = modelOf('asset-vault');
  const byOperation = Object.fromEntries(cacheInvalidations(vault).map((row) => [row.operation, row.caches]));
  assert.deepEqual(Object.keys(byOperation).sort(), ['noteThumbnailDelivery', 'publishAsset', 'uploadAsset']);
  assert.deepEqual(byOperation.noteThumbnailDelivery, [{ cacheName: 'asset-vault:get-asset', constant: 'GET_ASSET_CACHE', events: ['ThumbnailDelivered'] }]);
  assert.deepEqual(unbackedInvalidations(vault), []);
});

test('un evento de invalidatedBy que nadie emite ni consume se dice: la caché solo caducaría por su TTL', () => {
  const vault = modelOf('asset-vault');
  const getAsset = vault.services.flatMap((service) => service.operations).find((operation) => operation.name === 'getAsset');
  getAsset.cache = { ...getAsset.cache, invalidatedBy: [...getAsset.cache.invalidatedBy, 'AssetRenamed'] };
  assert.deepEqual(unbackedInvalidations(vault), [{ operation: 'getAsset', event: 'AssetRenamed' }]);
});

test('sin caché en el diseño, no hay plan', () => {
  const model = modelOf('product-catalog');
  assert.deepEqual(cachedOperations(model), []);
  assert.deepEqual(cacheInvalidations(model), []);
});
