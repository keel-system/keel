// La caché de lectura (incremento 13f), EJECUTADA: el adaptador que emite keel-nest, transpilado y corrido contra
// un store falso, y los lectores de las respuestas contra TODAS las respuestas de TODAS las fixtures. Lo que se
// mide es lo que hace el servidor de keel-spring del mismo diseño con su CacheConfig:
//
//   · las cachés se llaman igual en el store (`<servicio>:<operación>::<clave>`) y con el mismo TTL;
//   · el store caído y la entrada ilegible degradan a miss; lo nulo y los errores no se guardan; una carga por
//     entrada a la vez;
//   · lo que sale de la caché es, en el cable, byte a byte lo que se guardó;
//   · y lo que keel-spring deja al agente y keel-nest no: el vaciado de `invalidatedBy`, tras el commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { cachedOperations, cacheInvalidations, unbackedInvalidations } from 'keel-core/gen/cache-plan';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { cachedResponsesTs, CACHED_RESPONSES_TS } from '../src/scaffold/cache.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export const logs = [];
export class Logger {
  constructor(context) { this.context = context; }
  log(message) { logs.push(['log', this.context, message]); }
  warn(message) { logs.push(['warn', this.context, message]); }
  error(message) { logs.push(['error', this.context, message]); }
}
`;

// Los dos diseños que declaran caché. catalog-extended es relacional: su TransactionContext se carga sin driver.
const SUBJECTS = ['catalog-extended', 'asset-vault'];
const STACK = { cache: 'redis' };

const { files, model } = planFixture('catalog-extended', { stack: STACK });
const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
const { RedisOperationCache, entryKey } = await tree.load('src/infrastructure/cache/redis-operation-cache.ts');
const { GET_PRODUCT_BY_SLUG_CACHE } = await tree.load('src/application/support/cached-operations.ts');
const { RESPONSE_CODECS } = await tree.load(CACHED_RESPONSES_TS);
const { logs } = await tree.load('node_modules/@nestjs/common/index.ts').catch(() => import(path.join(tree.root, 'node_modules', '@nestjs', 'common', 'index.js')));
const { toWireJson } = await tree.load('src/application/support/wire.ts');

/** Un store en memoria con el contrato de CacheStore; `fail` hace fallar la orden que se nombre. */
function memoryStore() {
  const entries = new Map();
  const calls = [];
  const fail = new Set();
  const guard = (command) => {
    calls.push(command);
    if (fail.has(command)) throw new Error(`store caído (${command})`);
  };
  return {
    entries,
    calls,
    fail,
    async get(key) {
      guard('get');
      return entries.get(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      guard('set');
      entries.set(key, { value, ttlSeconds });
    },
    async delete(key) {
      guard('delete');
      entries.delete(key);
    },
    async deleteMatching(pattern) {
      guard('deleteMatching');
      const prefix = pattern.replace(/\*$/, '');
      let deleted = 0;
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) deleted += Number(entries.delete(key));
      return deleted;
    }
  };
}

/** Una transacción de mentira con la API de TransactionContext que usa el adaptador: `afterCommit`. */
function fakeTransactions() {
  const pending = [];
  return {
    open: false,
    pending,
    async afterCommit(callback) {
      if (this.open) pending.push(callback);
      else await callback();
    },
    async commit() {
      this.open = false;
      for (const callback of pending.splice(0)) await callback();
    },
    rollback() {
      this.open = false;
      pending.splice(0);
    }
  };
}

/** Una ficha de producto de catalog-extended tal como la construiría el handler. */
async function productCard(slugSuffix = '') {
  const { GetProductBySlugResponseDto } = await tree.load('src/application/dtos/get-product-by-slug-response-dto.ts');
  const { CurrentPriceDto } = await tree.load('src/application/dtos/current-price-dto.ts');
  const { ProductImageDto } = await tree.load('src/application/dtos/product-image-dto.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const { ProductStatus } = await tree.load('src/domain/enums/product-status.ts');
  return new GetProductBySlugResponseDto({
    id: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f',
    sku: `SKU-1${slugSuffix}`,
    name: 'Silla',
    status: Object.values(ProductStatus)[0],
    version: 9007199254740993n,
    createdAt: new Date('2026-10-09T10:11:12.345Z'),
    categoryId: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e70',
    images: [new ProductImageDto({ id: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e71', storageKey: 'k/1.png', position: 1, primary: true, productId: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f' })],
    currentPrice: new CurrentPriceDto({ amount: Decimal.parse('12.50'), currency: 'EUR' }),
    productCost: null
  });
}

const query = (slug) => ({ slug });

// ─── El nombre y el TTL: los de keel-spring ────────────────────────────────────

test('las cachés se llaman igual que en keel-spring y con el mismo TTL (CacheConfig.java)', () => {
  for (const name of SUBJECTS) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { cache: 'redis' } });
    const config = spring.files.find((file) => file.path.endsWith('/CacheConfig.java'))?.content;
    assert.ok(config, `${name}: keel-spring emite CacheConfig`);
    const nest = byPathOf(name)['src/application/support/cached-operations.ts'];
    for (const cache of cachedOperations(spring.model)) {
      assert.ok(config.includes(`${cache.constant} = "${cache.cacheName}"`), `${name}: keel-spring nombra ${cache.cacheName}`);
      assert.ok(config.includes(`ttls.put(${cache.constant}, Duration.ofSeconds(${cache.ttlSeconds}))`), `${name}: TTL de keel-spring`);
      assert.ok(nest.includes(`export const ${cache.constant}`), `${name}: keel-nest declara ${cache.constant}`);
      assert.ok(nest.includes(`name: '${cache.cacheName}'`) && nest.includes(`ttlSeconds: ${cache.ttlSeconds}`), `${name}: keel-nest con el mismo nombre y TTL`);
    }
  }
});

function byPathOf(name) {
  return Object.fromEntries(planFixture(name, { stack: STACK }).files.map((file) => [file.path, file.content]));
}

test('la entrada en el store es <caché>::<clave>, la de RedisCacheManager, y la clave sale de los keyFields', () => {
  assert.equal(GET_PRODUCT_BY_SLUG_CACHE.name, 'catalog:get-product-by-slug');
  assert.equal(GET_PRODUCT_BY_SLUG_CACHE.keyOf(query('sillas')), 'sillas');
  assert.equal(entryKey(GET_PRODUCT_BY_SLUG_CACHE, 'sillas'), 'catalog:get-product-by-slug::sillas');
  // Y la orden con la que el reset de infra/ las borra casa con ella.
  const flow = byPath['test/integration/support/flow.ts'];
  assert.match(flow, /export function clearCache\(\): void/);
  assert.ok(flow.includes(String.raw`--scan --pattern \'catalog:*\'`), 'clearCache borra catalog:*');
});

// ─── El adaptador, ejecutado ────────────────────────────────────────────────────

test('un miss carga y guarda con el TTL del diseño; el acierto no vuelve al origen y sale igual en el cable', async () => {
  const store = memoryStore();
  const cache = new RedisOperationCache(store, fakeTransactions());
  const card = await productCard();
  let loads = 0;
  const load = async () => (loads++, card);
  const first = await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), load);
  assert.equal(first, card);
  const entry = store.entries.get('catalog:get-product-by-slug::sillas');
  assert.ok(entry, 'guardó la entrada');
  assert.equal(entry.ttlSeconds, 300);
  const second = await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), load);
  assert.equal(loads, 1, 'el acierto no vuelve al origen');
  assert.equal(second.constructor.name, 'GetProductBySlugResponseDto', 'sale con su tipo, no como un objeto suelto');
  assert.equal(toWireJson(second), toWireJson(card), 'en el cable, byte a byte lo que se guardó');
  assert.match(toWireJson(second), /"amount":12\.50/, 'el decimal conserva su escala');
  assert.match(toWireJson(second), /"version":9007199254740993/, 'el long conserva sus dígitos');
  assert.match(toWireJson(second), /"createdAt":"2026-10-09T10:11:12\.345Z"/);
});

test('lo nulo, lo que el handler marca como no cacheable y los errores de la carga no se guardan', async () => {
  const store = memoryStore();
  const cache = new RedisOperationCache(store, fakeTransactions());
  assert.equal(await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('a'), async () => null), null);
  const card = await productCard();
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('b'), async () => card, { cacheable: () => false });
  await assert.rejects(cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('c'), async () => { throw new Error('404 del dominio'); }), /404 del dominio/);
  assert.equal(store.entries.size, 0);
});

test('el store caído degrada a miss con un WARN: la lectura va al origen y no falla', async () => {
  const store = memoryStore();
  store.fail.add('get').add('set');
  const cache = new RedisOperationCache(store, fakeTransactions());
  const card = await productCard();
  logs.length = 0;
  assert.equal(await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => card), card);
  const warnings = logs.filter(([level]) => level === 'warn').map(([, , message]) => message);
  assert.ok(warnings.some((message) => /no disponible al leer: se sirve desde el origen/.test(message)), warnings.join('\n'));
  assert.ok(warnings.some((message) => /no disponible al escribir/.test(message)), warnings.join('\n'));
});

test('una entrada ilegible es un miss (con su WARN), y la carga la reescribe', async () => {
  const store = memoryStore();
  store.entries.set('catalog:get-product-by-slug::sillas', { value: '{"id":42}', ttlSeconds: 300 });
  const cache = new RedisOperationCache(store, fakeTransactions());
  const card = await productCard();
  logs.length = 0;
  let loads = 0;
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => (loads++, card));
  assert.equal(loads, 1);
  assert.ok(logs.some(([level, , message]) => level === 'warn' && /entrada ilegible/.test(message)));
  assert.equal(store.entries.get('catalog:get-product-by-slug::sillas').value, toWireJson(card));
});

test('una carga por entrada a la vez: diez lecturas simultáneas van UNA vez al origen', async () => {
  const cache = new RedisOperationCache(memoryStore(), fakeTransactions());
  const card = await productCard();
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const reads = Array.from({ length: 10 }, () => cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => (loads++, await gate, card)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(reads);
  assert.equal(loads, 1);
  assert.ok(results.every((result) => toWireJson(result) === toWireJson(card)));
});

test('vaciar y desalojar esperan al COMMIT: con rollback no se toca nada', async () => {
  const store = memoryStore();
  const transactions = fakeTransactions();
  const cache = new RedisOperationCache(store, transactions);
  const card = await productCard();
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => card);
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('mesas'), async () => card);
  transactions.open = true;
  await cache.clear(GET_PRODUCT_BY_SLUG_CACHE);
  assert.equal(store.entries.size, 2, 'dentro de la transacción no se vacía');
  transactions.rollback();
  assert.equal(store.entries.size, 2, 'con rollback, nunca');
  transactions.open = true;
  await cache.evict(GET_PRODUCT_BY_SLUG_CACHE, 'sillas');
  await cache.clear(GET_PRODUCT_BY_SLUG_CACHE);
  await transactions.commit();
  assert.equal(store.entries.size, 0, 'tras el commit, vacía');
  // Sin transacción abierta (un despacho sin ella), en el acto.
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => card);
  await cache.evict(GET_PRODUCT_BY_SLUG_CACHE, 'sillas');
  assert.equal(store.entries.size, 0);
});

test('una carga que empezó ANTES de vaciar no guarda lo que leyó (pudo leerlo antes del commit)', async () => {
  const store = memoryStore();
  const cache = new RedisOperationCache(store, fakeTransactions());
  const card = await productCard();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const read = cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => (await gate, card));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cache.clear(GET_PRODUCT_BY_SLUG_CACHE);
  release();
  assert.equal(await read, card, 'la lectura responde igual');
  assert.equal(store.entries.size, 0, 'pero no guarda un valor que puede ser anterior al vaciado');
});

test('sin store (perfil test) toda lectura va al origen, y vaciar no falla', async () => {
  const cache = new RedisOperationCache(null, fakeTransactions());
  const card = await productCard();
  let loads = 0;
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => (loads++, card));
  await cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, query('sillas'), async () => (loads++, card));
  assert.equal(loads, 2);
  await cache.clear(GET_PRODUCT_BY_SLUG_CACHE);
  const yaml = parseYaml(byPath['config/parameters/test/cache.yaml']);
  assert.equal(yaml.cache.enabled, false);
});

// ─── La invalidación: derivada del diseño y aplicada por el mediator ───────────

test('qué vacía cada operación sale del diseño: la que emite y la que consume un evento de invalidatedBy', () => {
  const vault = planFixture('asset-vault', { stack: STACK }).model;
  const rows = Object.fromEntries(cacheInvalidations(vault).map((row) => [row.operation, row.caches.flatMap((cache) => cache.events)]));
  assert.deepEqual(rows.uploadAsset, ['AssetUploaded']);
  assert.deepEqual(rows.publishAsset, ['AssetPublished']);
  // ThumbnailDelivered no lo emite nadie: es un evento CONSUMIDO, y lo invalida la operación que dispara.
  assert.deepEqual(rows.noteThumbnailDelivery, ['ThumbnailDelivered']);
  assert.deepEqual(unbackedInvalidations(vault), []);
  const catalog = Object.fromEntries(cacheInvalidations(model).map((row) => [row.operation, row.caches.flatMap((cache) => cache.events)]));
  assert.ok(Object.keys(catalog).length >= 3, JSON.stringify(catalog));
  for (const event of ['ProductCreated', 'ProductUpdated', 'ProductImagesChanged']) {
    assert.ok(Object.values(catalog).some((events) => events.includes(event)), `alguien vacía por ${event}`);
  }
});

test('el mediator vacía tras el handler, dentro de la transacción (o sea, al commit), las cachés de su operación', () => {
  const mediator = byPath['src/infrastructure/usecase/use-case-mediator.ts'];
  assert.match(mediator, /@Inject\(OperationCache\) private readonly cache: OperationCache/);
  assert.match(mediator, /this\.inTransaction\(message, \(\) => this\.handle\(handler, message\)\)/);
  assert.match(mediator, /CACHE_INVALIDATIONS\.get\(message\.constructor\) \?\? \[\]\) await this\.cache\.clear\(cache\)/);
  const invalidations = byPath['src/infrastructure/cache/cache-invalidations.ts'];
  for (const row of cacheInvalidations(model)) {
    const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === row.operation);
    assert.ok(invalidations.includes(`[${operation.messageClass}, [GET_PRODUCT_BY_SLUG_CACHE]]`), row.operation);
  }
  // Sin caché, el mediator no cambia.
  const plain = Object.fromEntries(planFixture('product-catalog').files.map((file) => [file.path, file.content]));
  assert.doesNotMatch(plain['src/infrastructure/usecase/use-case-mediator.ts'], /OperationCache|CACHE_INVALIDATIONS/);
  assert.ok(!('src/infrastructure/cache/cache-module.ts' in plain));
});

test('la configuración usa las variables de keel-spring (REDIS_HOST, REDIS_PORT) con su gradiente', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  const spring = Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: { cache: 'redis' } }).files.map((file) => [file.path, file.content]));
  for (const profile of ['local', 'develop', 'production']) {
    const springRedis = parseYaml(Object.entries(spring).find(([file]) => file.endsWith(`/${profile}/redis.yaml`))[1]).spring.data.redis;
    const nest = parseYaml(byPath[`config/parameters/${profile}/cache.yaml`]).cache.redis;
    assert.equal(String(nest.host), String(springRedis.host), `${profile}: host`);
    assert.equal(String(nest.port), String(springRedis.port), `${profile}: port`);
  }
  assert.match(byPath['package.json'], /"@redis\/client": "\^6\.2\.1"/);
  assert.match(byPath['src/app.module.ts'], /CacheModule\.register\(configuration\)/);
});

// ─── Los lectores: ida y vuelta sobre TODAS las respuestas de TODAS las fixtures ─

test('toda respuesta de toda fixture vuelve de la caché igual en el cable (lector generado ∘ toWireJson)', async () => {
  let checked = 0;
  for (const name of fs.readdirSync(FIXTURES_DIR)) {
    const { files: fixtureFiles, model: fixtureModel } = planFixture(name, { stack: STACK });
    const operations = fixtureModel.services.flatMap((service) => service.operations).filter((operation) => operation.responseDto);
    if (operations.length === 0) continue;
    // El lector de TODAS sus respuestas, aunque la fixture no cachee ninguna: el lector no sabe de quién es.
    const responses = cachedResponsesTs(fixtureModel, operations);
    const withAll = [...fixtureFiles.filter((file) => file.path !== CACHED_RESPONSES_TS), { path: CACHED_RESPONSES_TS, content: responses }];
    const fixtureTree = transpileTree(withAll, { stubs: { '@nestjs/common': NEST_STUB } });
    const { RESPONSE_CODECS: codecs } = await fixtureTree.load(CACHED_RESPONSES_TS);
    for (const operation of operations) {
      const text = sampleResponse(fixtureModel, operation);
      const cached = cachedOperations(fixtureModel).find((cache) => cache.operation === operation.name);
      const codec = codecs.get(cached?.cacheName ?? operation.name);
      assert.ok(codec, `${name}.${operation.name}: tiene lector`);
      let decoded;
      try {
        decoded = codec.decode(text);
      } catch (error) {
        assert.fail(`${name}.${operation.name}: no lee ${text}\n${error.stack}`);
      }
      assert.equal(codec.encode(decoded), text, `${name}.${operation.name}`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `solo ${checked} respuestas`);
});

// ── Una respuesta de ejemplo, como TEXTO del cable (los números con su texto exacto) ──

function sampleResponse(fixtureModel, operation) {
  const dto = (name) => dtoIndex(fixtureModel).get(name);
  const item = objectText(fixtureModel, dto(operation.responseDto.name).fields, dto);
  if (operation.paginated) return `{"items":[${item}],"page":0,"size":20,"totalElements":1,"totalPages":1}`;
  if (operation.returnsList) return `[${item}]`;
  return item;
}

function dtoIndex(fixtureModel) {
  const index = new Map();
  for (const service of fixtureModel.services) for (const operation of service.operations) if (operation.responseDto) index.set(operation.responseDto.name, operation.responseDto);
  for (const list of [fixtureModel.childDtos, fixtureModel.refDtos, fixtureModel.refVariants, fixtureModel.needDtos]) for (const entry of list ?? []) index.set(entry.name, entry);
  return index;
}

function objectText(fixtureModel, fields, dto) {
  return `{${fields.map((field) => `${JSON.stringify(field.name)}:${valueText(fixtureModel, field, dto)}`).join(',')}}`;
}

function valueText(fixtureModel, field, dto) {
  if (field.list) return `[${valueText(fixtureModel, { ...field, list: false }, dto)}]`;
  const name = String(field.elementTsType ?? field.tsType).replace(/\[\]$/, '');
  if (field.kind === 'enum') return JSON.stringify(fixtureModel.enums.find((candidate) => candidate.name === name).values[0].literal);
  if (field.kind === 'composite') return objectText(fixtureModel, fixtureModel.valueObjects.find((vo) => vo.name === name).fields, dto);
  if (['childDto', 'refDto', 'needDto'].includes(field.kind)) return objectText(fixtureModel, dto(name).fields, dto);
  switch (field.base) {
    case 'int':
      return String(bounded(field, 7));
    case 'long':
      return field.numeric?.max != null ? String(bounded(field, 7)) : '9007199254740993';
    case 'decimal': {
      const scale = field.numeric?.scale ?? 2;
      const whole = bounded(field, 12);
      return scale > 0 ? `${whole}.${'5'.padEnd(scale, '0')}` : String(whole);
    }
    case 'boolean':
      return 'true';
    case 'date':
      return '"2026-10-09"';
    case 'timestamp':
      return '"2026-10-09T10:11:12.345Z"';
    case 'json':
      return '{"a":1.10,"b":[true,null]}';
    case 'uuid':
      return '"0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f"';
    default:
      return JSON.stringify(sampleText(field));
  }
}

/** Un entero dentro de las cotas del campo (por debajo del máximo, para que quepa la parte decimal). */
function bounded(field, preferred) {
  const min = field.numeric?.min ?? null;
  const max = field.numeric?.max ?? null;
  if (min != null && preferred < min) return Math.ceil(min);
  if (max != null && preferred >= max) return Math.floor(max) - 1;
  return preferred;
}

const TEXT_CANDIDATES = ['EUR', 'abc', 'es-ES', 'ABC-1234', 'A-1', 'user@example.com', 'sillas-de-roble', '+34600000000', 'ES9121000418450200051332'];

function sampleText(field) {
  const text = field.text ?? {};
  const pattern = text.pattern ? new RegExp(text.pattern) : null;
  const fits = (candidate) =>
    (!pattern || pattern.test(candidate)) && (text.minLength == null || candidate.length >= text.minLength) && (text.maxLength == null || candidate.length <= text.maxLength);
  const found = TEXT_CANDIDATES.find(fits);
  if (found) return found;
  if (!pattern) return 'x'.repeat(Math.max(text.minLength ?? 1, 1));
  throw new Error(`sin texto de ejemplo para el patrón ${text.pattern}: añádelo a TEXT_CANDIDATES`);
}
