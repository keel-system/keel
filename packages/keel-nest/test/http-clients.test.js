// Los clientes HTTP salientes (incremento 11b), EJECUTADOS: el adaptador que emite keel-nest para
// stock-reservation, transpilado y corrido contra un proveedor falso de node:http. Lo que se mide es lo que
// el servidor de keel-spring del mismo diseño hace con resilience4j:
//
//   · el retry reintenta SOLO lo que dice `retryOn` (aquí el transporte), con la MISMA clave de idempotencia
//     en cada intento, y nunca un 4xx;
//   · el fallback atiende solo los fallos del proveedor; un cuerpo que viola el contrato se propaga;
//   · el circuito tiene la semántica de resilience4j, comparada paso a paso con la referencia de keel-core;
//   · la configuración (`http-clients.yaml`) es la de keel-spring en los cuatro perfiles.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { circuitBreakerReference, resiliencePolicy, retryWaitMs } from 'keel-core/gen/outbound-resilience';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const SUBJECT = 'stock-reservation';

// Lo mínimo de @nestjs/common para ejecutar el adaptador: decoradores que no hacen nada y un Logger que anota.
const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
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

const { files, model } = planFixture(SUBJECT);
const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
const ORDER_ID = '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f';

/** Un proveedor falso: cada petición la contesta el siguiente guion de la cola (o el último, repetido). */
async function provider() {
  const requests = [];
  let scripts = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      const script = scripts.length > 1 ? scripts.shift() : scripts[0];
      script(request, response);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    reply(...next) {
      scripts = next;
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const json = (status, value) => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
};
const empty = (status) => (_request, response) => {
  response.writeHead(status);
  response.end();
};
const dropConnection = (request) => request.socket.destroy();
const tooSlow = (ms) => (_request, response) => setTimeout(() => json(200, { cancelled: true })(_request, response), ms);

async function adapterFor(baseUrl, { timeoutMs = 300 } = {}) {
  const { InventoryHttpAdapter } = await tree.load('src/infrastructure/clients/inventory-http-adapter.ts');
  const { InventoryMapper } = await tree.load('src/infrastructure/clients/inventory-mapper.ts');
  return new InventoryHttpAdapter({ inventory: { id: 'inventory', baseUrl, timeoutMs, headers: {} } }, new InventoryMapper());
}

async function logs() {
  return (await import(new URL(`file:///${path.join(tree.root, 'node_modules', '@nestjs', 'common', 'index.js').replace(/\\/g, '/')}`).href)).logs;
}

test(`${SUBJECT}: el camino feliz — DELETE a la ruta del diseño, con la clave de idempotencia, y el resultado traducido`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(json(200, { cancelled: true }));
  const result = await (await adapterFor(fake.baseUrl)).cancelStock(ORDER_ID);
  assert.equal(result.cancelled, true);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method, 'DELETE');
  assert.equal(fake.requests[0].url, `/stock/reservations/${ORDER_ID}`);
  assert.match(fake.requests[0].headers['idempotency-key'], /^[0-9a-f]{64}$/);
});

test(`${SUBJECT}: sin conexión reintenta los 3 intentos con la MISMA clave, y el fallback (onFailure: ignore) devuelve el resultado neutro`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(dropConnection);
  const result = await (await adapterFor(fake.baseUrl)).cancelStock(ORDER_ID);
  assert.equal(result.cancelled, null, 'el resultado neutro: el proveedor no dijo nada');
  assert.equal(fake.requests.length, 3, 'max-attempts: 3, como resilience4j');
  assert.equal(new Set(fake.requests.map((request) => request.headers['idempotency-key'])).size, 1, 'la misma clave en cada intento');
  assert.ok((await logs()).some(([level, , message]) => level === 'warn' && /cancelStock no disponible; se continúa sin él/.test(message)));
});

test(`${SUBJECT}: un timeout es transporte — se reintenta y cae al fallback`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(tooSlow(1000));
  const result = await (await adapterFor(fake.baseUrl, { timeoutMs: 150 })).cancelStock(ORDER_ID);
  assert.equal(result.cancelled, null);
  assert.equal(fake.requests.length, 3);
});

test(`${SUBJECT}: un 5xx NO se reintenta (retryOn: [timeout, connection]) pero entra al fallback`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(json(503, { error: 'down' }));
  const result = await (await adapterFor(fake.baseUrl)).cancelStock(ORDER_ID);
  assert.equal(result.cancelled, null);
  assert.equal(fake.requests.length, 1);
});

test(`${SUBJECT}: un 4xx no se reintenta, entra al fallback con su línea de rechazo y es un ÉXITO para el circuito`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(json(404, { error: 'no existe' }));
  const adapter = await adapterFor(fake.baseUrl);
  for (let i = 0; i < 12; i++) assert.equal((await adapter.cancelStock(ORDER_ID)).cancelled, null);
  assert.equal(fake.requests.length, 12, 'uno por llamada: ni se reintenta ni corta el circuito');
  assert.equal(adapter.cancelStockCircuit.state, 'closed');
  assert.ok((await logs()).some(([, , message]) => /cancelStock rechazada por el proveedor \(404\)/.test(message)));
});

test(`${SUBJECT}: un cuerpo que viola el contrato NO es el proveedor caído — se propaga y no cuenta para el circuito`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  const { OutboundContractError } = await tree.load('src/infrastructure/clients/response-reading.ts');
  const adapter = await adapterFor(fake.baseUrl);
  fake.reply(json(200, {}));
  await assert.rejects(adapter.cancelStock(ORDER_ID), (error) => error instanceof OutboundContractError && /no trae 'cancelled'/.test(error.message));
  fake.reply(json(200, { cancelled: 'sí' }));
  await assert.rejects(adapter.cancelStock(ORDER_ID), OutboundContractError);
  fake.reply(json(200, 'esto no es json'));
  await assert.rejects(adapter.cancelStock(ORDER_ID), OutboundContractError);
  for (let i = 0; i < 10; i++) await adapter.cancelStock(ORDER_ID).catch(() => {});
  assert.equal(adapter.cancelStockCircuit.state, 'closed');
});

test(`${SUBJECT}: sin cuerpo (204) devuelve el resultado neutro y lo dice`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(empty(204));
  assert.equal((await (await adapterFor(fake.baseUrl)).cancelStock(ORDER_ID)).cancelled, null);
  assert.ok((await logs()).some(([, , message]) => /respondió sin cuerpo; el contrato declara 1 campo/.test(message)));
});

test(`${SUBJECT}: diez 5xx abren el circuito (ventana 10, umbral 50) y la llamada siguiente ni sale`, async (t) => {
  const fake = await provider();
  t.after(fake.close);
  fake.reply(json(500, {}));
  const adapter = await adapterFor(fake.baseUrl);
  for (let i = 0; i < 10; i++) await adapter.cancelStock(ORDER_ID);
  assert.equal(adapter.cancelStockCircuit.state, 'open');
  assert.equal(fake.requests.length, 10);
  assert.equal((await adapter.cancelStock(ORDER_ID)).cancelled, null, 'el circuito abierto cae al fallback del diseño');
  assert.equal(fake.requests.length, 10, 'abierto: la llamada no se intentó');
});

// ─── La referencia de keel-core ──────────────────────────────────────────────

/** Un generador pseudoaleatorio con semilla: las secuencias son las mismas en cada ejecución. */
function seeded(seed) {
  let state = seed;
  return () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test('el circuito emitido recorre las mismas secuencias que circuitBreakerReference de keel-core', async () => {
  const { CircuitBreaker } = await tree.load('src/infrastructure/clients/circuit-breaker.ts');
  const specs = [
    { failureRateThreshold: 50, slidingWindowSize: 10, minimumNumberOfCalls: 10, waitDurationMs: 20, halfOpenCalls: 10 },
    { failureRateThreshold: 100, slidingWindowSize: 3, minimumNumberOfCalls: 3, waitDurationMs: 5, halfOpenCalls: 1 },
    { failureRateThreshold: 25, slidingWindowSize: 8, minimumNumberOfCalls: 4, waitDurationMs: 10, halfOpenCalls: 3 }
  ];
  for (const [index, spec] of specs.entries()) {
    const random = seeded(index + 7);
    let clock = 0;
    const emitted = new CircuitBreaker(spec, () => clock);
    const reference = circuitBreakerReference(spec, () => clock);
    for (let step = 0; step < 2000; step++) {
      const roll = random();
      if (roll < 0.1) {
        clock += Math.ceil(random() * spec.waitDurationMs * 1.5);
        continue;
      }
      const acquired = emitted.tryAcquire();
      assert.equal(acquired, reference.tryAcquire(), `spec ${index}, paso ${step}: tryAcquire`);
      if (acquired) {
        const failed = roll < 0.55;
        emitted.record(failed);
        reference.record(failed);
      }
      assert.equal(emitted.state, reference.state, `spec ${index}, paso ${step}: estado`);
    }
  }
});

test('la espera entre intentos es la de keel-core, y el retry no reintenta lo que su política no nombra', async () => {
  const { retryWaitMs: emittedWait, withResilience } = await tree.load('src/infrastructure/clients/outbound-resilience.ts');
  const { ProviderStatusError, ProviderTransportError } = await tree.load('src/infrastructure/clients/provider-failures.ts');
  for (const retry of [
    { maxAttempts: 5, initialDelayMs: 200, multiplier: 2, maxDelayMs: 1000 },
    { maxAttempts: 4, initialDelayMs: 500, multiplier: 2, maxDelayMs: null },
    { maxAttempts: 3, initialDelayMs: 300, multiplier: null, maxDelayMs: null }
  ]) {
    for (const attempt of [1, 2, 3, 4, 5]) assert.equal(emittedWait(attempt, retry), retryWaitMs(attempt, retry));
  }
  const waits = [];
  const sleep = async (ms) => void waits.push(ms);
  const policy = { instance: 'x', retry: { maxAttempts: 4, initialDelayMs: 100, multiplier: 2, maxDelayMs: null, retries: ['transport'] }, circuitBreaker: null };
  let calls = 0;
  await assert.rejects(withResilience(policy, null, async () => (calls++, Promise.reject(new ProviderTransportError('x'))), sleep));
  assert.equal(calls, 4);
  assert.deepEqual(waits, [100, 200, 400]);
  calls = 0;
  await assert.rejects(withResilience(policy, null, async () => (calls++, Promise.reject(new ProviderStatusError(500, ''))), sleep));
  assert.equal(calls, 1, 'un 5xx sin 5xx en retryOn no se reintenta');
  calls = 0;
  await assert.rejects(withResilience(policy, null, async () => (calls++, Promise.reject(new TypeError('bug'))), sleep), TypeError);
  assert.equal(calls, 1, 'un bug nuestro se propaga a la primera');
});

test(`${SUBJECT}: la política del adaptador es la de keel-core`, () => {
  const call = model.httpClients[0].calls[0];
  const policy = resiliencePolicy(call);
  const adapter = byPath['src/infrastructure/clients/inventory-http-adapter.ts'];
  assert.ok(adapter.includes(`maxAttempts: ${policy.retry.maxAttempts}, initialDelayMs: ${policy.retry.initialDelayMs}`));
  assert.ok(adapter.includes(`retries: [${policy.retry.retries.map((kind) => `'${kind}'`).join(', ')}]`));
  const cb = policy.circuitBreaker;
  assert.ok(adapter.includes(`failureRateThreshold: ${cb.failureRateThreshold}, slidingWindowSize: ${cb.slidingWindowSize}, minimumNumberOfCalls: ${cb.minimumNumberOfCalls}, waitDurationMs: ${cb.waitDurationMs}, halfOpenCalls: ${cb.halfOpenCalls}`));
});

// ─── Configuración y cableado ────────────────────────────────────────────────

test(`${SUBJECT}: http-clients.yaml es el de keel-spring (sin el bloque de resilience4j) en los cuatro perfiles`, () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const spring = Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.map((file) => [file.path, file.content]));
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const nest = parseYaml(byPath[`config/parameters/${profile}/http-clients.yaml`]);
    const theirs = parseYaml(spring[`src/main/resources/parameters/${profile}/http-clients.yaml`]);
    assert.deepEqual(nest['http-clients'], theirs['http-clients'], profile);
  }
});

test(`${SUBJECT}: el handler que dispara la activación recibe el puerto inyectado y la nota de cómo llamarlo`, () => {
  const handler = byPath['src/application/usecases/reconcile-reservations-command-handler.ts'];
  assert.match(handler, /static readonly inject = \[ReservationRepository, InventoryClient\]/);
  // Las notas se parten en líneas de comentario: se leen unidas.
  const notes = handler.replace(/\n\s*\/\/\s*/g, ' ');
  assert.match(notes, /this\.inventoryClient\.cancelStock\(\.\.\.\) \(con await\)/);
  assert.match(byPath['src/app.module.ts'], /HttpClientsModule\.register\(configuration\)/);
  // El puerto vive en el dominio y no importa nada de infraestructura.
  const portImports = byPath['src/domain/clients/inventory-client.ts'].split('\n').filter((line) => line.startsWith('import'));
  assert.ok(portImports.every((line) => !/infrastructure|@nestjs/.test(line)), portImports.join('\n'));
});

// ts-check lo destapó (2026-10-07): la prueba de casos de uso emitida monta sus módulos a mano, y sin este los
// handlers que inyectan un puerto de cliente no se resolvían.
test(`${SUBJECT}: la prueba de casos de uso emitida monta HttpClientsModule`, () => {
  assert.match(byPath['test/use-cases.test.ts'], /HttpClientsModule\.register\(loadConfiguration\(\{ \.\.\.process\.env, PROFILE: 'test' \}\)\)/);
});

test('sin http-clients no se emite nada de lo saliente', () => {
  const bare = planFixture('product-catalog').files.map((file) => file.path);
  assert.ok(!bare.some((file) => file.includes('/clients/') || file.endsWith('http-clients.yaml')));
});
