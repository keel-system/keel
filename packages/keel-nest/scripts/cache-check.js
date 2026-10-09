#!/usr/bin/env node
// cache-check: la caché de lectura de keel-nest contra un Redis y un Valkey REALES (incremento 13f).
//
//   npm run cache-check --workspace packages/keel-nest [-- --cache=redis|valkey] [-- --keep] [-- --sabotage=<id>]
//
// Lo que `npm test` no puede juzgar, porque allí el store es un Map: que el cliente oficial, con la configuración
// que emite build, guarde y lea en el servidor de verdad lo que el adaptador cree, y que una caché CAÍDA no retenga
// a quien lee. Se levanta la imagen del catálogo (la misma que el compose de infra/) y contra ella corren,
// transpilados y con un sustituto de @nestjs/common, el store, el adaptador y los lectores de catalog-extended.
//
// Mide: la entrada en el servidor con su clave (`<caché>::<clave>`), su TTL y el JSON del cable; el acierto sin
// volver al origen y byte a byte en el cable; el vaciado de una caché sin tocar las demás; la orden de
// infra/reset-db.sh borrando lo de este servicio y nada más; con el store parado, la lectura va al origen en el
// acto; y con el store de vuelta, la caché vuelve a guardar sin reiniciar nada.
//
// `--sabotage=<id>` rompe lo emitido CONSERVANDO LA FORMA (sigue transpilando) y el check tiene que salir rojo:
//   offline     el cliente encola las órdenes sin conexión (sin disableOfflineQueue): la lectura espera al plazo
//   ttl         la entrada se guarda sin caducidad
//   reconnect   el cliente deja de reconectar tras la caída

import { CACHES } from 'keel-core/gen/infra-catalog';
import { cacheFlushCmd } from 'keel-core/gen/infra-scripts';
import { run, resolveRuntime, freePort } from './lib/database-container.js';
import { planFixture, transpileTree } from '../test/helpers/emitted.js';

const keep = process.argv.includes('--keep');
const only = process.argv.find((arg) => arg.startsWith('--cache='))?.split('=')[1] ?? null;
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Optional = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

const STORE_TS = 'src/infrastructure/cache/redis-cache-store.ts';
const SABOTAGES = {
  offline: [STORE_TS, 'disableOfflineQueue: true,', 'disableOfflineQueue: false,'],
  ttl: [STORE_TS, "await this.client.set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });", 'void ttlSeconds;\n    await this.client.set(key, value);'],
  reconnect: [STORE_TS, 'reconnectStrategy: (retries: number) => Math.min(2 ** retries * 50, 2000) + Math.floor(Math.random() * 200)', 'reconnectStrategy: (retries: number) => (retries > 0 ? false : 50)']
};

const runtime = resolveRuntime();
if (!runtime) {
  console.error('cache-check necesita podman o docker en marcha.');
  process.exit(2);
}

const subject = 'catalog-extended';
const SLUG = 'sillas';
let current = 'arranque';

for (const id of only ? [only] : Object.keys(CACHES)) {
  const entry = CACHES[id];
  console.log(`\n── ${entry.label} (${entry.image})`);
  const { files, model } = planFixture(subject, { stack: { cache: id } });
  if (sabotage) {
    const [file, from, to] = SABOTAGES[sabotage] ?? [];
    const target = files.find((candidate) => candidate.path === file);
    if (!target || !target.content.includes(from)) {
      console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
      process.exit(2);
    }
    target.content = target.content.replace(from, to);
    console.log(`(sabotaje: ${sabotage})`);
  }

  const port = await freePort();
  const name = `keel-nest-cache-check-${id}-${process.pid}`;
  const started = run(runtime, ['run', '-d', '--name', name, '-p', `${port}:${entry.port}`, entry.image]);
  if (!step(`${entry.label} arranca`, started.status === 0, started.status === 0 ? '' : started.stderr.trim().slice(-300))) process.exit(1);
  const cli = (...args) => run(runtime, ['exec', name, 'redis-cli', ...args]);
  let store = null;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = cli('PING').stdout.trim() === 'PONG';
      if (!ready) await sleep(500);
    }
    if (!step('responde a PING', ready)) process.exit(1);

    const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
    const { RedisCacheStore } = await tree.load(STORE_TS);
    const { RedisOperationCache } = await tree.load('src/infrastructure/cache/redis-operation-cache.ts');
    const { GET_PRODUCT_BY_SLUG_CACHE } = await tree.load('src/application/support/cached-operations.ts');
    const { toWireJson } = await tree.load('src/application/support/wire.ts');
    const card = await sampleCard(tree);
    // La configuración del perfil local (cache.yaml), con el puerto de este contenedor.
    store = new RedisCacheStore({ enabled: true, host: '127.0.0.1', port, connectTimeoutMs: 2000, commandTimeoutMs: 2000 });
    const cache = new RedisOperationCache(store, null);
    const key = `${GET_PRODUCT_BY_SLUG_CACHE.name}::${SLUG}`;
    let loads = 0;
    const load = async () => (loads++, card);
    const read = () => cache.getOrLoad(GET_PRODUCT_BY_SLUG_CACHE, { slug: SLUG }, load);
    for (let i = 0; i < 40; i++) {
      if (await store.get('sonda').then(() => true, () => false)) break;
      await sleep(250);
    }

    current = 'miss';
    await read();
    const stored = cli('GET', key).stdout.replace(/\r?\n$/, '');
    step(`el miss guarda ${key} con el JSON del cable`, stored === toWireJson(card), stored.slice(0, 120));
    const ttl = Number(cli('TTL', key).stdout.trim());
    step('con el TTL del diseño (300 s)', ttl > 290 && ttl <= 300, `TTL ${ttl}`);

    current = 'acierto';
    const hit = await read();
    step('el acierto no vuelve al origen', loads === 1, `${loads} cargas`);
    step('y sale byte a byte igual en el cable', toWireJson(hit) === toWireJson(card));

    current = 'vaciado';
    cli('SET', `${model.service.artifactId}:otra-cache::x`, '1');
    cli('SET', 'otro-servicio:get-x::x', '1');
    await cache.clear(GET_PRODUCT_BY_SLUG_CACHE);
    step(
      'vaciar una caché borra sus entradas y ninguna más',
      cli('EXISTS', key).stdout.trim() === '0' && cli('EXISTS', `${model.service.artifactId}:otra-cache::x`).stdout.trim() === '1'
    );

    current = 'reset de infra/';
    await read();
    const flush = cacheFlushCmd(entry, model.service).replaceAll(`-h ${entry.serviceKey}`, '-h 127.0.0.1');
    const flushed = run(runtime, ['exec', name, 'sh', '-c', flush]);
    step(
      'la orden de infra/reset-db.sh borra lo de este servicio y nada más',
      flushed.status === 0 && cli('EXISTS', key).stdout.trim() === '0' && cli('EXISTS', 'otro-servicio:get-x::x').stdout.trim() === '1',
      flushed.stderr.trim().slice(-200)
    );

    current = 'store parado';
    run(runtime, ['stop', '-t', '0', name]);
    await sleep(500);
    const before = loads;
    const started = performance.now();
    let answered = null;
    try {
      answered = await read();
    } catch (error) {
      answered = error;
    }
    const elapsed = Math.round(performance.now() - started);
    step('con el store parado, la lectura va al origen y no falla', answered === card && loads === before + 1, answered instanceof Error ? answered.message : '');
    step('y en el acto, sin esperar al plazo de la orden', elapsed < 1000, `${elapsed} ms`);

    current = 'store de vuelta';
    run(runtime, ['start', name]);
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      await sleep(500);
      await read();
      back = cli('EXISTS', key).stdout.trim() === '1';
    }
    step('con el store de vuelta, la caché vuelve a guardar sin reiniciar nada', back);
  } catch (error) {
    step(`sin excepciones (${current})`, false, error.stack ?? String(error));
  } finally {
    store?.onApplicationShutdown();
    if (!keep) run(runtime, ['rm', '-f', name]);
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} en verde${sabotage ? ` (sabotaje: ${sabotage})` : ''}`);
process.exit(failed.length > 0 ? 1 : 0);

/** Una ficha de catalog-extended como la construiría el handler: decimal con escala, long grande e instante. */
async function sampleCard(tree) {
  const { GetProductBySlugResponseDto } = await tree.load('src/application/dtos/get-product-by-slug-response-dto.ts');
  const { CurrentPriceDto } = await tree.load('src/application/dtos/current-price-dto.ts');
  const { ProductImageDto } = await tree.load('src/application/dtos/product-image-dto.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const { ProductStatus } = await tree.load('src/domain/enums/product-status.ts');
  return new GetProductBySlugResponseDto({
    id: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f',
    sku: 'SKU-1',
    name: 'Silla «Ñandú»',
    status: Object.values(ProductStatus)[0],
    version: 9007199254740993n,
    createdAt: new Date('2026-10-09T10:11:12.345Z'),
    categoryId: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e70',
    images: [new ProductImageDto({ id: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e71', storageKey: 'k/1.png', position: 1, primary: true, productId: '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f' })],
    currentPrice: new CurrentPriceDto({ amount: Decimal.parse('12.50'), currency: 'EUR' }),
    productCost: null
  });
}
