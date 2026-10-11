// El puerto de la caché de lectura es el mismo contrato en los dos generadores (2026-10-11).
//
// keel-nest lo emitía desde el incremento 13f; en keel-spring lo escribía el agente, y las dos corridas de
// keel-spring lo escribieron con dos nombres y dos formas (GetAssetCache, ResponseCache). Aquí se compara lo que
// emiten los dos para el mismo diseño: el nombre de cada caché, su clave y qué operación la invalida.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { CACHED_OPERATIONS_TS, CACHE_INVALIDATIONS_TS } from '../src/scaffold/cache.js';

const SUBJECTS = [
  { name: 'asset-vault', stack: { database: 'mongodb', broker: 'rabbitmq' } },
  { name: 'catalog-extended', stack: { database: 'postgresql', broker: 'kafka' } }
];

function springFiles(name, stack) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
  return (suffix) => files.find((f) => f.path.endsWith(suffix))?.content;
}

for (const { name, stack } of SUBJECTS) {
  test(`${name}: las mismas cachés, con el mismo nombre en el store, en los dos generadores`, () => {
    const nest = planFixture(name, { stack }).files;
    const nestCaches = nest.find((f) => f.path === CACHED_OPERATIONS_TS).content;
    const spring = springFiles(name, stack)('/CachedOperations.java');
    const nestNames = [...nestCaches.matchAll(/name: '([^']+)'/g)].map((m) => m[1]).sort();
    const springNames = [...spring.matchAll(/public static final String \w+_CACHE = "([^"]+)";/g)].map((m) => m[1]).sort();
    assert.ok(nestNames.length > 0, name);
    assert.deepEqual(springNames, nestNames);
  });

  test(`${name}: las mismas operaciones vacían cada caché al confirmar`, () => {
    const nest = planFixture(name, { stack }).files.find((f) => f.path === CACHE_INVALIDATIONS_TS).content;
    const mediator = springFiles(name, stack)('/UseCaseMediator.java');
    const nestRows = [...nest.matchAll(/\[(\w+), \[([^\]]+)\]\]/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    const springRows = [...mediator.matchAll(/Map\.entry\((\w+)\.class, List\.of\(([^)]+)\)\)/g)]
      .map((m) => `${m[1]}:${m[2].replaceAll('CachedOperations.', '')}`)
      .sort();
    assert.ok(nestRows.length > 0, name);
    assert.deepEqual(springRows, nestRows);
  });
}

test('keel-spring: el handler de la operación cacheada recibe el puerto; la clave sale de los keyFields', () => {
  const read = springFiles('asset-vault', SUBJECTS[0].stack);
  const handler = read('/GetAssetQueryHandler.java');
  assert.ok(handler.includes('private final OperationCache operationCache;'), handler);
  assert.ok(handler.replace(/\n\s*\/\/\s*/g, ' ').includes('operationCache.getOrLoad(CachedOperations.GET_ASSET_CACHE, CachedOperations.getAssetKey(query), () -> ...)'), handler);
  const cached = read('/CachedOperations.java');
  assert.ok(cached.includes('public static String getAssetKey(GetAssetQuery query) {\n        return key(query.id());'), cached);
  const adapter = read('/RedisOperationCache.java');
  assert.ok(adapter.includes('new TypeReference<GetAssetResponseDto>() {}'), adapter);
  assert.ok(adapter.includes('if (value != null && cacheable.test(value)) {'), adapter);
  // El handler que no cachea no lo recibe.
  assert.ok(!read('/ListAssetsQueryHandler.java').includes('OperationCache'));
  // Y la nota es la misma que la de keel-nest (keel-core/gen/cache-plan.js, cacheNote).
  const nestHandler = planFixture('asset-vault', { stack: SUBJECTS[0].stack }).files.find((f) => f.path.endsWith('get-asset-query-handler.ts')).content;
  assert.match(nestHandler.replace(/\n\s*\/\/\s*/g, ' '), /await this\.operationCache\.getOrLoad\(GET_ASSET_CACHE, query, \(\) => \.\.\.\)/);
});
