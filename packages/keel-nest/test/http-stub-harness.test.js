// El arnés del proveedor de prueba (incremento 11d), EJECUTADO: el `test/integration/support/http-stub.ts` que
// emite keel-nest, transpilado y corrido contra un admin de WireMock FALSO (node:http) que anota lo que recibe.
// Lo que se mide es que cada helper mande al stub exactamente el mapping del vocabulario de keel-core
// (`gen/http-stub-probes.js`), el mismo con el que habla el AbstractFlowIT de keel-spring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadService } from 'keel-core';
import {
  HTTP_STUB_ADMIN,
  HTTP_STUB_ENDPOINTS,
  HTTP_STUB_FAULT,
  HTTP_STUB_INITIAL_STATE,
  stubCriterion,
  stubFaultResponse,
  stubMapping,
  stubOkResponse,
  stubSequenceMappings,
  stubSlowResponse
} from 'keel-core/gen/http-stub-probes';
import { DATABASES } from 'keel-core/gen/infra-catalog';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { HTTP_STUB_TS } from '../src/scaffold/http-stub-harness.js';
import { tsString } from '../src/scaffold/render.js';

const SUBJECT = 'stock-reservation';
const { files } = planFixture(SUBJECT, { stack: { database: 'postgresql', broker: 'rabbitmq' } });
const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));

/** Un admin de WireMock falso: anota cada POST y contesta lo que pida el recurso. */
async function fakeAdmin() {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url.endsWith(HTTP_STUB_ENDPOINTS.count)) response.end(JSON.stringify({ count: 3 }));
      else if (request.url.endsWith(HTTP_STUB_ENDPOINTS.find)) {
        response.end(JSON.stringify({ requests: [{ url: '/x', method: 'DELETE', headers: { 'Idempotency-Key': 'k-1' }, body: '{"a":1}' }] }));
      } else response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, url: `http://127.0.0.1:${server.address().port}/__admin`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Transpila http-stub.ts y lo importa con el admin apuntando al falso. */
async function loadStubModule(adminUrl) {
  const dir = tmpDir('keel-nest-http-stub-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const { outputText } = ts.transpileModule(byPath[HTTP_STUB_TS], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } });
  const out = path.join(dir, 'http-stub.js');
  fs.writeFileSync(out, outputText);
  process.env.HTTP_STUB_ADMIN = adminUrl;
  try {
    return await import(`${pathToFileURL(out).href}?${Date.now()}`);
  } finally {
    delete process.env.HTTP_STUB_ADMIN;
  }
}

test(`${SUBJECT}: cada helper manda al stub el mapping del vocabulario de keel-core`, async (t) => {
  const admin = await fakeAdmin();
  t.after(admin.close);
  const stub = await loadStubModule(admin.url);
  const mapped = () => admin.received.filter((entry) => entry.path.endsWith(HTTP_STUB_ENDPOINTS.mappings)).map((entry) => entry.body);

  await stub.stubFor('GET', '/prices/.*', 200, { amount: '2.50' });
  await stub.stubFailure('GET', '/prices/.*', 503);
  await stub.stubConnectionFault('DELETE', '/stock/.*');
  await stub.stubTimeout('DELETE', '/stock/.*', 4000);
  assert.deepEqual(mapped(), [
    stubMapping({ method: 'GET', pathPattern: '/prices/.*', response: stubOkResponse(200, { amount: '2.50' }) }),
    stubMapping({ method: 'GET', pathPattern: '/prices/.*', response: stubOkResponse(503, {}) }),
    stubMapping({ method: 'DELETE', pathPattern: '/stock/.*', response: stubFaultResponse() }),
    stubMapping({ method: 'DELETE', pathPattern: '/stock/.*', response: stubSlowResponse(4000) })
  ]);

  admin.received.length = 0;
  await stub.stubSequence('DELETE', '/stock/reservations/.*', stub.StubResponse.connectionFault(), stub.StubResponse.timeout(5000), stub.StubResponse.ok(200, { cancelled: true }));
  const sequence = mapped();
  assert.equal(sequence.length, 3);
  const scenario = sequence[0].scenarioName;
  assert.match(scenario, /^seq-/);
  assert.deepEqual(
    sequence,
    stubSequenceMappings({
      method: 'DELETE',
      pathPattern: '/stock/reservations/.*',
      responses: [stubFaultResponse(), stubSlowResponse(5000), stubOkResponse(200, { cancelled: true })],
      scenario
    })
  );
  assert.equal(sequence[0].requiredScenarioState, HTTP_STUB_INITIAL_STATE);
  assert.equal(sequence[2].newScenarioState, undefined, 'la última se queda pegada');
});

test(`${SUBJECT}: la secuencia exige dos respuestas y una sola por ruta; el reset la libera`, async (t) => {
  const admin = await fakeAdmin();
  t.after(admin.close);
  const stub = await loadStubModule(admin.url);
  await assert.rejects(stub.stubSequence('GET', '/a', stub.StubResponse.ok(200, {})), /menos de dos respuestas/);
  await stub.stubSequence('GET', '/a', stub.StubResponse.failure(500), stub.StubResponse.ok(200, {}));
  await assert.rejects(stub.stubSequence('GET', '/a', stub.StubResponse.failure(500), stub.StubResponse.ok(200, {})), /ya hay una secuencia programada/);
  await stub.resetStubs();
  assert.ok(admin.received.some((entry) => entry.path.endsWith(HTTP_STUB_ENDPOINTS.reset)));
  await stub.stubSequence('GET', '/a', stub.StubResponse.failure(500), stub.StubResponse.ok(200, {}));
});

test(`${SUBJECT}: cuenta y lee lo recibido con el MISMO criterio, y las cabeceras sin distinguir mayúsculas`, async (t) => {
  const admin = await fakeAdmin();
  t.after(admin.close);
  const stub = await loadStubModule(admin.url);
  assert.equal(await stub.stubCallCount('DELETE', '/stock/.*'), 3);
  const [request] = await stub.stubRequests('DELETE', '/stock/.*');
  const criteria = admin.received.map((entry) => entry.body);
  assert.deepEqual(criteria, [stubCriterion('DELETE', '/stock/.*'), stubCriterion('DELETE', '/stock/.*')]);
  assert.equal(stub.stubRequestHeader(request, 'idempotency-key'), 'k-1');
  assert.equal(stub.stubRequestHeader(request, 'X-Otra'), null);
  assert.deepEqual(stub.stubRequestBody(request), { a: 1 });
});

test(`${SUBJECT}: el admin por defecto es el del catálogo, y el arnés de keel-spring habla el mismo vocabulario`, () => {
  assert.ok(byPath[HTTP_STUB_TS].includes(`'${HTTP_STUB_ADMIN}'`));
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.find((file) => file.path.endsWith('/AbstractFlowIT.java')).content;
  assert.ok(spring.includes(`"${HTTP_STUB_ADMIN}"`), 'el admin');
  for (const endpoint of Object.values(HTTP_STUB_ENDPOINTS)) assert.ok(spring.includes(`"${endpoint}"`), endpoint);
  assert.ok(spring.includes(HTTP_STUB_FAULT), 'el corte de conexión');
  assert.ok(spring.includes(`"${HTTP_STUB_INITIAL_STATE}"`), 'el estado inicial');
  for (const key of ['scenarioName', 'requiredScenarioState', 'newScenarioState', 'urlPathPattern', 'fixedDelayMilliseconds']) {
    assert.ok(spring.includes(key), key);
  }
});

test(`${SUBJECT}: flow.ts reexporta los helpers, ageForReconciliation envejece la marca del diseño, y el humo programa el stub`, () => {
  const flow = byPath['test/integration/support/flow.ts'];
  assert.match(flow, /export \{ StubResponse, stubFor, .*resetStubs \} from '\.\/http-stub\.js';/);
  assert.match(flow, /forgetSequences\(\);/);
  const entry = DATABASES.postgresql;
  assert.ok(flow.includes(tsString(`UPDATE reservations SET reserve_stock_awaiting_since = ${entry.staleTimestamp} WHERE id = `)), 'la sentencia');
  assert.match(flow, /export function ageForReconciliation\(activation: string, id: string\): void/);
  // Y su inverso, para «lo que acaba de entrar en vuelo no se toca» (corrida payment-checkout, FL-REC-002-B).
  assert.ok(flow.includes(tsString(`UPDATE reservations SET reserve_stock_awaiting_since = ${entry.heldTimestamp} WHERE id = `)), 'la sentencia de retener');
  assert.match(flow, /export function holdFromReconciliation\(activation: string, id: string\): void/);
  assert.match(byPath['test/integration/harness-smoke.test.ts'], /SMOKE-6: el proveedor de prueba se deja programar/);
});

test('sin http-clients no hay proveedor de prueba en el arnés', () => {
  const bare = Object.fromEntries(planFixture('product-catalog').files.map((file) => [file.path, file.content]));
  assert.equal(bare[HTTP_STUB_TS], undefined);
  assert.doesNotMatch(bare['test/integration/support/flow.ts'], /http-stub/);
});
