// La caché de lectura de keel-dotnet (incremento 13f), sobre el texto emitido:
//
//   · cache.yaml es el de keel-nest en los cuatro perfiles (keel-core/gen/cache-config.js), y CacheSettings solo lee claves
//     que ese YAML declara;
//   · cada caché se llama, dura y compone su clave como dice keel-core (cachedOperations), la misma para los tres servidores;
//   · qué operación vacía qué caché es la tabla de keel-core (cacheInvalidations), y la aplica el mediator dentro de la
//     transacción del caso de uso; sin caché, el mediator no cambia;
//   · el handler que cachea recibe el puerto y la nota, la prueba del contenedor registra la caché, Program.cs la arranca y
//     el arnés vacía la caché con la orden de infra/reset-db.sh.
// Lo que EJECUTA el C# (el adaptador contra un store en memoria, la ida y vuelta de cada respuesta) lo mide la prueba
// emitida OperationCacheTests en `npm run cs-check`; lo que dice un Redis o un Valkey de verdad, `npm run cache-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { cachedOperations, cacheInvalidations } from 'keel-core/gen/cache-plan';
import { CACHES } from 'keel-core/gen/infra-catalog';
import { cacheFlushCmd } from 'keel-core/gen/infra-scripts';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const WITH_CACHE = ['asset-vault', 'catalog-extended'];
const PROFILES = ['local', 'develop', 'production', 'test'];
const stack = (cache = 'redis') => ({ database: 'postgresql', broker: 'rabbitmq', cache });

const plan = (name, planner = planService, cache = 'redis') => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack: stack(cache) });
const plans = new Map(WITH_CACHE.map((name) => [name, plan(name)]));
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}:`) : [`${prefix}${key}`]));
}

test('cache.yaml es el de keel-nest en los cuatro perfiles, y CacheSettings solo lee claves que declara', () => {
  for (const name of WITH_CACHE) {
    const { files } = plans.get(name);
    const nest = plan(name, planNest).files;
    for (const profile of PROFILES) {
      const suffix = `config/parameters/${profile}/cache.yaml`;
      assert.ok(content(files, suffix), `${name}/${profile}`);
      assert.equal(content(files, suffix), content(nest, suffix), `${name}/${profile}`);
    }
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/cache.yaml'))));
    const read = [...content(files, '/Cache/CacheSettings.cs').matchAll(/\(configuration, "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(read.length >= 5, name);
    for (const key of read) assert.ok(declared.has(key), `${name}: CacheSettings lee ${key}, que cache.yaml no declara`);
  }
});

test('cada caché se llama, dura y compone su clave como dice keel-core, igual que en keel-nest', () => {
  for (const [name, { files, model }] of plans) {
    const emitted = content(files, '/Support/CachedOperations.cs');
    const nest = content(plan(name, planNest).files, 'cached-operations.ts');
    for (const cache of cachedOperations(model)) {
      assert.ok(emitted.includes(`new(${JSON.stringify(cache.cacheName)}, ${cache.ttlSeconds}, `), `${name}: ${cache.operation}`);
      assert.ok(nest.includes(`name: ${JSON.stringify(cache.cacheName).replaceAll('"', "'")}`), `${name}: keel-nest nombra igual ${cache.operation}`);
      for (const field of cache.keyFields) assert.match(emitted, new RegExp(`CacheKey\\.Of\\([^)]*message\\.${field[0].toUpperCase()}${field.slice(1)}`), `${name}: ${field}`);
    }
  }
});

test('qué operación vacía qué caché es la tabla de keel-core, y la aplica el mediator dentro del caso de uso', () => {
  for (const [name, { files, model }] of plans) {
    const table = content(files, '/Cache/CacheInvalidations.cs');
    const rows = cacheInvalidations(model);
    assert.ok(rows.length > 0, name);
    for (const row of rows) assert.match(table, new RegExp(`\\[typeof\\(${row.messageClass}\\)\\] = \\[`), `${name}: ${row.operation}`);
    assert.equal([...table.matchAll(/\[typeof\(/g)].length, rows.length, `${name}: ni una fila de más`);
    const mediator = content(files, '/UseCase/UseCaseMediator.cs');
    assert.match(mediator, /await Invalidate\(command, cancellationToken\);[\s\S]*await Invalidate\(command, cancellationToken\);/, `${name}: los dos Handled invalidan`);
    assert.match(mediator, /CacheInvalidations\.Of\(message\)/);
  }
  // Sin caché, el mediator es el de siempre.
  const plain = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR }).files;
  assert.doesNotMatch(content(plain, '/UseCase/UseCaseMediator.cs'), /Invalidate|Cache/);
  assert.ok(!plain.some((file) => file.path.includes('/Cache/')));
});

test('el vaciado espera al commit: las dos transacciones ofrecen AfterCommitOrNow y el adaptador la usa', () => {
  const { files } = plans.get('asset-vault');
  assert.match(content(files, '/Persistence/PersistenceTransactions.cs'), /public Task AfterCommitOrNow\(Func<Task> action\)/);
  assert.match(content(files, '/Cache/RedisOperationCache.cs'), /transactions\.AfterCommitOrNow\(work\)/);
});

test('el handler que cachea recibe el puerto y la nota; el contenedor de prueba, Program.cs y el arnés la registran', () => {
  for (const [name, { files, model }] of plans) {
    for (const cache of cachedOperations(model)) {
      const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === cache.operation);
      const handler = content(files, `/UseCases/${operation.handlerClass}.cs`);
      assert.match(handler, /IOperationCache operationCache\)/, `${name}: ${operation.handlerClass}`);
      assert.match(handler, new RegExp(`operationCache\\.GetOrLoad\\(CachedOperations\\.${cache.operation[0].toUpperCase()}${cache.operation.slice(1)}, `), `${name}: la nota`);
    }
    assert.match(content(files, '/UseCasesTests.cs'), /services\.AddOperationCache\(CacheSettings\.Disabled\);/, name);
    assert.match(content(files, '/Program.cs'), /builder\.Services\.AddOperationCache\(CacheSettings\.From\(configuration\)\);/, name);
    const flow = content(files, '/Support/FlowTest.cs');
    assert.ok(flow.includes('protected static void ClearCache() =>'), name);
    assert.ok(flow.includes(JSON.stringify(cacheFlushCmd(CACHES.redis, model.service))), `${name}: la orden de reset-db.sh`);
  }
});

test('el cliente es StackExchange.Redis, solo con caché, y falla en el acto sin conexión', () => {
  const { files } = plans.get('catalog-extended');
  assert.match(content(files, '.Infrastructure.csproj'), /<PackageReference Include="StackExchange.Redis" \/>/);
  const store = content(files, '/Cache/RedisCacheStore.cs');
  assert.match(store, /AbortOnConnectFail = false/);
  assert.match(store, /BacklogPolicy = BacklogPolicy\.FailFast/);
  const plain = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR }).files;
  assert.doesNotMatch(content(plain, '.Infrastructure.csproj'), /StackExchange/);
});

test('la skill se instala con redis y con valkey, y no sin caché', () => {
  for (const cache of ['redis', 'valkey']) {
    assert.ok(plan('asset-vault', planService, cache).files.some((file) => file.path.endsWith('skills/keel-dotnet-redis/SKILL.md')), cache);
  }
  const plain = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR }).files;
  assert.ok(!plain.some((file) => file.path.includes('keel-dotnet-redis')));
});
