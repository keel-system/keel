// La caché de lectura de keel-go (tramo 13e), sobre el texto emitido:
//
//   · cache.yaml es el de keel-nest y keel-dotnet en los cuatro perfiles (keel-core/gen/cache-config.js), y SettingsFrom
//     solo lee claves que ese YAML declara;
//   · cada caché se llama, dura y compone su clave como dice keel-core (cachedOperations), la misma que en los otros tres;
//   · qué operación vacía qué caché es la tabla de keel-core (cacheInvalidations): NewUseCases le pasa el vaciado a
//     esas y solo a esas; sin caché, NewUseCases no vacía nada (el asentamiento, en test/after-commit.test.js);
//   · el handler que cachea recibe la caché y la nota, el arranque abre el store solo si el perfil la habilita, y el arnés
//     vacía la caché con la orden de infra/reset-db.sh;
//   · go-redis entra en go.mod solo con caché, sin reintentos y con plazo en cada orden.
// Lo que EJECUTA el Go (la caché contra un store en memoria, la ida y vuelta de cada respuesta) lo mide la prueba emitida
// operation_cache_test.go en `npm run go-check`; lo que dice un Redis o un Valkey de verdad, `npm run cache-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { cachedOperations, cacheInvalidations } from '@keel-system/keel-core/gen/cache-plan';
import { CACHES } from '@keel-system/keel-core/gen/infra-catalog';
import { cacheFlushCmd } from '@keel-system/keel-core/gen/infra-scripts';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { cacheVar } from '../src/scaffold/cache.js';
import { goExported } from '../src/lib/go-projection.js';
import { handlerType, operations, useCaseField } from '../src/scaffold/services.js';
import { goFileName } from '../src/scaffold/render.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const WITH_CACHE = ['asset-vault', 'catalog-extended'];
const PROFILES = ['local', 'develop', 'production', 'test'];

const plan = (name, planner = planService, cache = 'redis') => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack: { cache } });
const plans = new Map(WITH_CACHE.map((name) => [name, plan(name)]));
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const plain = planService({ ...loadService(path.join(FIXTURES_DIR, 'product-catalog')), workspace: FIXTURES_DIR }).files;

function flatKeys(tree, prefix = '') {
  return Object.entries(tree ?? {}).flatMap(([key, value]) => (value && typeof value === 'object' ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

test('las dos fixtures con caché ya no la avisan: la caché sale entera', () => {
  for (const name of WITH_CACHE) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const { errors, warnings } = checkSupportedFeatures(manifest, layers);
    assert.ok(![...errors, ...warnings].some((text) => /\bcache\b/.test(text)), `${name}:\n${[...errors, ...warnings].join('\n')}`);
  }
});

test('cache.yaml es el de keel-nest y keel-dotnet en los cuatro perfiles, y SettingsFrom solo lee claves que declara', () => {
  for (const name of WITH_CACHE) {
    const { files } = plans.get(name);
    const nest = plan(name, planNest).files;
    const dotnet = plan(name, planDotnet).files;
    for (const profile of PROFILES) {
      const suffix = `config/parameters/${profile}/cache.yaml`;
      assert.ok(content(files, suffix), `${name}/${profile}`);
      assert.equal(content(files, suffix), content(nest, suffix), `${name}/${profile}: keel-nest`);
      assert.equal(content(files, suffix), content(dotnet, suffix), `${name}/${profile}: keel-dotnet`);
    }
    const declared = new Set(flatKeys(parseYaml(content(files, 'config/parameters/local/cache.yaml'))));
    const read = [...content(files, 'internal/infrastructure/cache/settings.go').matchAll(/(?:text|number)\("([^"]+)"/g)].map((match) => match[1]);
    assert.equal(read.length, 5, name);
    for (const key of read) assert.ok(declared.has(key), `${name}: SettingsFrom lee ${key}, que cache.yaml no declara`);
  }
});

test('cada caché se llama, dura y compone su clave como dice keel-core, igual que en keel-nest y keel-dotnet', () => {
  for (const [name, { files, model }] of plans) {
    const emitted = content(files, 'internal/application/cached_operations.go');
    const nest = content(plan(name, planNest).files, 'cached-operations.ts');
    const dotnet = content(plan(name, planDotnet).files, '/Support/CachedOperations.cs');
    const caches = cachedOperations(model);
    assert.equal([...emitted.matchAll(/^var \w+Cache = CachedOperation\[/gm)].length, caches.length, `${name}: ni una caché de más`);
    for (const cache of caches) {
      const block = emitted.slice(emitted.indexOf(`var ${cacheVar(cache.operation)} = `));
      assert.match(block, new RegExp(`^\\tName: ${JSON.stringify(cache.cacheName)},$`, 'm'), `${name}: ${cache.operation}`);
      assert.match(block, new RegExp(`^\\tTTL: +${cache.ttlSeconds} \\* time\\.Second,$`, 'm'), `${name}: ${cache.operation}`);
      assert.match(block, new RegExp(`return CacheKey\\(${cache.keyFields.map((field) => `\\w+\\.${goExported(field)}`).join(', ')}\\)`), `${name}: la clave`);
      assert.ok(nest.includes(`name: '${cache.cacheName}'`), `${name}: keel-nest nombra igual ${cache.operation}`);
      assert.ok(dotnet.includes(`new(${JSON.stringify(cache.cacheName)}, ${cache.ttlSeconds}, `), `${name}: keel-dotnet nombra igual ${cache.operation}`);
    }
  }
});

test('qué operación vacía qué caché es la tabla de keel-core: NewUseCases le pasa el vaciado a esas, y todas van en settle', () => {
  for (const [name, { files, model }] of plans) {
    const wiring = content(files, 'internal/application/use_cases.go');
    const rows = new Map(cacheInvalidations(model).map((row) => [row.operation, row]));
    assert.ok(rows.size > 0, name);
    for (const operation of operations(model)) {
      const line = wiring.split('\n').find((candidate) => candidate.startsWith(`\tuc.${useCaseField(operation)} = `));
      assert.match(line, /= settle(Command)?\(logger, observe(Command)?\(/, `${name}: ${operation.name} sin asentamiento`);
      const row = rows.get(operation.name);
      if (row) {
        const vars = row.caches.map((cache) => cacheVar(cachedOperations(model).find((candidate) => candidate.cacheName === cache.cacheName).operation));
        assert.ok(line.endsWith(`, deps.OperationCache.clearing(${vars.join(', ')}))`), `${name}: ${operation.name} no vacía ${vars.join(', ')}: ${line}`);
      } else {
        assert.ok(!line.includes('clearing('), `${name}: ${operation.name} vacía una caché que no invalida`);
      }
    }
    assert.match(wiring, /^\tOperationCache +\*OperationCache$/m, `${name}: el campo de Dependencies`);
  }
  // Sin caché, ni vaciado ni caché en el cableado.
  const wiring = content(plain, 'internal/application/use_cases.go');
  assert.doesNotMatch(wiring, /OperationCache|clearing/);
  assert.ok(!plain.some((file) => file.path.endsWith('operation_cache.go') || file.path.includes('/infrastructure/cache/') || file.path.endsWith('cache.yaml')));
});

test('el handler que cachea recibe la caché y la nota con GetOrLoad; los demás, no', () => {
  for (const [name, { files, model }] of plans) {
    const cached = new Set(cachedOperations(model).map((cache) => cache.operation));
    for (const operation of operations(model)) {
      // Las notas van partidas en líneas de comentario: se leen deshechas.
      const handler = content(files, `internal/application/${goFileName(handlerType(operation))}.go`).replace(/\n\t\/\/ +/g, ' ');
      if (cached.has(operation.name)) {
        assert.match(handler, /\toperationCache \*OperationCache\n/, `${name}: ${operation.name}`);
        assert.ok(handler.includes(`GetOrLoad(ctx, h.operationCache, ${cacheVar(operation.name)}, query, func(ctx context.Context)`), `${name}: la nota de ${operation.name}`);
        assert.ok(handler.includes('Lo que depende de QUIÉN llama'), `${name}: la nota de keel-core`);
      } else {
        assert.doesNotMatch(handler, /operationCache/, `${name}: ${operation.name}`);
      }
    }
  }
});

test('el arranque abre el store solo si el perfil la habilita, lo cierra al apagar y se lo da a la caché', () => {
  for (const [name, { files }] of plans) {
    const main = content(files, 'cmd/server/main.go');
    assert.match(main, /cacheSettings, err := cache\.SettingsFrom\(cfg\)/, name);
    assert.match(main, /if cacheSettings\.Enabled \{\n\t\tstore := cache\.NewStore\(cacheSettings, logger\)\n\t\tdefer func\(\) \{\n\t\t\tif err := store\.Close\(\)/, name);
    assert.match(main, /OperationCache: +application\.NewOperationCache\(cacheStore, logger\),/, name);
  }
  assert.doesNotMatch(content(plain, 'cmd/server/main.go'), /cache\./);
});

test('el arnés vacía la caché con la orden de infra/reset-db.sh, con redis y con valkey', () => {
  for (const id of ['redis', 'valkey']) {
    const { files, model } = plan('catalog-extended', planService, id);
    const harness = content(files, 'tests/integration/cache_test.go');
    assert.ok(harness.startsWith('// Code generated by keel-go. DO NOT EDIT.\n\n//go:build integration'), id);
    assert.ok(harness.includes(`const cacheFlush = ${JSON.stringify(cacheFlushCmd(CACHES[id], model.service))}`), `${id}: la orden de reset-db.sh`);
    assert.ok(content(files, 'infra/reset-db.sh').includes(cacheFlushCmd(CACHES[id], model.service).slice(0, 20)), id);
    assert.match(harness, /^func \(s \*Scenario\) ClearCache\(\) \{$/m, id);
  }
  assert.ok(!plain.some((file) => file.path.endsWith('tests/integration/cache_test.go')));
});

test('go-redis entra solo con caché, sin reintentos, con plazo en cada orden y el mismo saludo con Redis y Valkey', () => {
  const { files } = plans.get('catalog-extended');
  assert.match(content(files, 'go.mod'), /^\tgithub\.com\/redis\/go-redis\/v9 v9\.23\.0$/m);
  assert.doesNotMatch(content(plain, 'go.mod'), /go-redis/);
  const store = content(files, 'internal/infrastructure/cache/store.go');
  for (const option of ['MaxRetries: +-1,', 'DialTimeout: +settings\\.ConnectTimeout,', 'ReadTimeout: +settings\\.CommandTimeout,', 'WriteTimeout: +settings\\.CommandTimeout,', 'PoolTimeout: +settings\\.CommandTimeout,', 'ContextTimeoutEnabled: true,', 'DisableIdentity: +true,', 'ModeDisabled']) {
    assert.match(store, new RegExp(option), option);
  }
  // Nada de application conoce Redis: lo vigila además la prueba de arquitectura emitida.
  for (const file of files.filter((candidate) => candidate.path.startsWith('internal/application/'))) assert.doesNotMatch(file.content, /go-redis/, file.path);
});

test('la skill se instala con redis y con valkey, y no sin caché', () => {
  for (const id of ['redis', 'valkey']) {
    assert.ok(plan('asset-vault', planService, id).files.some((file) => file.path.endsWith('skills/keel-go-redis/SKILL.md')), id);
  }
  assert.ok(!plain.some((file) => file.path.includes('keel-go-redis')));
});
