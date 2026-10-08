#!/usr/bin/env node
// stub-check: el arnés del proveedor de prueba y el adaptador saliente de keel-nest contra un WireMock REAL
// (incremento 11d), y la pasarela de pago de prueba de las dos pasarelas (incremento 13d).
//
//   npm run stub-check --workspace packages/keel-nest [-- --keep]
//
// Lo que `npm test` no puede juzgar: que lo que programan los helpers de `test/integration/support/http-stub.ts`
// lo ENTIENDA el stub de verdad (un mapping mal formado lo rechaza con un 400; uno bien formado que no casa no
// falla nada), y que el corte de conexión, el retraso y la secuencia de WireMock lleguen a `fetch` como el
// arnés promete — transporte, timeout, la segunda respuesta. Se levanta SOLO el WireMock del catálogo (la misma
// imagen que el compose de infra/), y contra él corren los helpers emitidos y el adaptador emitido de
// stock-reservation, con un sustituto de @nestjs/common.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { HTTP_STUB } from 'keel-core/gen/infra-catalog';
import { run, resolveRuntime, freePort } from './lib/database-container.js';
import { planFixture, transpileTree } from '../test/helpers/emitted.js';
import { tmpDir } from '../test/helpers/tmp.js';
import { HTTP_STUB_TS } from '../src/scaffold/http-stub-harness.js';
import { PAYMENT_HARNESS_TS } from '../src/scaffold/payment-harness.js';

const keep = process.argv.includes('--keep');
const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const runtime = resolveRuntime();
if (!runtime) {
  console.error('stub-check necesita podman o docker en marcha.');
  process.exit(2);
}

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Global = () => () => {};
export const Module = () => () => {};
export class Logger { constructor() {} log() {} warn() {} error() {} }
`;

const port = await freePort();
const name = `keel-nest-stub-check-${process.pid}`;
const started = run(runtime, ['run', '-d', '--rm', '--name', name, '-p', `${port}:${HTTP_STUB.port}`, HTTP_STUB.image, '--verbose']);
if (!step(`WireMock arranca (${HTTP_STUB.image})`, started.status === 0, started.stderr.trim().slice(-300))) process.exit(1);

const admin = `http://127.0.0.1:${port}/__admin`;
// El paso en curso: si algo lanza (el stub rechaza un mapping, un helper revienta), sale en rojo con su nombre y su
// mensaje, en vez de tumbar el script sin resumen — un check que se cae no se distingue de uno mal montado.
let current = 'arranque';
const baseUrl = `http://127.0.0.1:${port}`;
try {
  // Espera al admin API: el mismo sondeo que validate-infra.sh (`/__admin/mappings`).
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await fetch(`${admin}/mappings`).then((response) => response.ok, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!step('el admin API responde', ready)) process.exit(1);

  const { files } = planFixture('stock-reservation', { stack: { database: 'postgresql', broker: 'rabbitmq' } });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  // Los helpers del arnés, transpilados, con el admin apuntando a este WireMock.
  const helperDir = tmpDir('keel-nest-stub-check-');
  fs.writeFileSync(path.join(helperDir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(helperDir, 'http-stub.js'),
    ts.transpileModule(byPath[HTTP_STUB_TS], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText
  );
  process.env.HTTP_STUB_ADMIN = admin;
  const stub = await import(pathToFileURL(path.join(helperDir, 'http-stub.js')).href);
  // El adaptador emitido, contra el mismo WireMock.
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { InventoryHttpAdapter } = await tree.load('src/infrastructure/clients/inventory-http-adapter.ts');
  const { InventoryMapper } = await tree.load('src/infrastructure/clients/inventory-mapper.ts');
  const adapter = () => new InventoryHttpAdapter({ inventory: { id: 'inventory', baseUrl, timeoutMs: 500, headers: {} } }, new InventoryMapper());
  const ROUTE = '/stock/reservations/.*';
  const ID = '0192f7a4-6c1e-7b3a-9f00-1a2b3c4d5e6f';
  const keysOf = async () => (await stub.stubRequests('DELETE', ROUTE)).map((request) => stub.stubRequestHeader(request, 'Idempotency-Key'));

  current = 'stubFor';
  await stub.resetStubs();
  await stub.stubFor('DELETE', ROUTE, 200, { cancelled: true });
  const happy = await adapter().cancelStock(ID);
  step('stubFor: el adaptador recibe lo programado', happy.cancelled === true, JSON.stringify(happy));
  const [request] = await stub.stubRequests('DELETE', ROUTE);
  step('stubRequests: el stub registró la petición, con su ruta', request?.url === `/stock/reservations/${ID}`, request?.url);
  step('stubRequestHeader: la clave de idempotencia viajó', /^[0-9a-f]{64}$/.test(stub.stubRequestHeader(request, 'idempotency-key') ?? ''));

  current = 'stubConnectionFault';
  await stub.resetStubs();
  await stub.stubConnectionFault('DELETE', ROUTE);
  const cut = await adapter().cancelStock(ID);
  const cutKeys = await keysOf();
  step('stubConnectionFault: llega como transporte, se reintenta 3 veces y cae al fallback', cut.cancelled === null && cutKeys.length === 3, `${cutKeys.length} peticiones`);
  step('…con la MISMA clave en cada intento', new Set(cutKeys).size === 1);

  current = 'stubTimeout';
  await stub.resetStubs();
  await stub.stubTimeout('DELETE', ROUTE, 2_000);
  const slow = await adapter().cancelStock(ID);
  step('stubTimeout: más que el timeout de la llamada es transporte, y se reintenta', slow.cancelled === null && (await stub.stubCallCount('DELETE', ROUTE)) === 3);

  current = 'stubSequence';
  await stub.resetStubs();
  await stub.stubSequence('DELETE', ROUTE, stub.StubResponse.connectionFault(), stub.StubResponse.ok(200, { cancelled: true }));
  const retried = await adapter().cancelStock(ID);
  const retriedKeys = await keysOf();
  step('stubSequence: falla la primera, responde la segunda, y el reintento la recoge', retried.cancelled === true && retriedKeys.length === 2, `${retriedKeys.length} peticiones`);
  step('…y las dos peticiones llevan la misma clave', retriedKeys.length === 2 && retriedKeys[0] === retriedKeys[1]);
  const sticky = await adapter().cancelStock(ID);
  step('…y la última respuesta se queda pegada', sticky.cancelled === true);

  current = 'stubFailure';
  await stub.resetStubs();
  await stub.stubFailure('DELETE', ROUTE, 503);
  const down = adapter();
  for (let i = 0; i < 10; i++) await down.cancelStock(ID);
  const before = await stub.stubCallCount('DELETE', ROUTE);
  const open = await down.cancelStock(ID);
  step('stubFailure: diez 503 abren el circuito y la llamada siguiente ni sale', before === 10 && open.cancelled === null && (await stub.stubCallCount('DELETE', ROUTE)) === 10, `${before} peticiones`);

  current = 'stubFor';
  await stub.resetStubs();
  await stub.stubFor('DELETE', ROUTE, 200, {});
  const broken = await adapter().cancelStock(ID).then(() => null, (error) => error);
  step('un cuerpo que viola el contrato se propaga (no es el proveedor caído)', broken?.name === 'OutboundContractError', broken?.message);

  // La pasarela de pago de prueba (incremento 13d): el arnés de payment-checkout programa ESTE WireMock con la forma
  // de cada pasarela —casando por el cuerpo y por la query, que es lo que solo el stub de verdad puede juzgar— y el
  // adaptador emitido de esa pasarela le habla.
  for (const gateway of ['stripe', 'mercadopago']) {
    current = `pasarela ${gateway}`;
    const payment = planFixture('payment-checkout', { stack: { paymentGateway: gateway, broker: 'rabbitmq' } }).files;
    const paymentByPath = Object.fromEntries(payment.map((file) => [file.path, file.content]));
    const dir = tmpDir(`keel-nest-stub-check-${gateway}-`);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    for (const [file, out] of [[HTTP_STUB_TS, 'http-stub.js'], [PAYMENT_HARNESS_TS, 'payment-gateway.js']]) {
      fs.writeFileSync(path.join(dir, out), ts.transpileModule(paymentByPath[file], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText);
    }
    const harness = await import(pathToFileURL(path.join(dir, 'payment-gateway.js')).href);
    const http = await import(pathToFileURL(path.join(dir, 'http-stub.js')).href);
    const paymentTree = transpileTree(payment, { stubs: { '@nestjs/common': NEST_STUB } });
    const { PaymentGatewayHttp } = await paymentTree.load('src/infrastructure/payment/payment-gateway-http.ts');
    const Adapter = gateway === 'stripe' ? 'StripePaymentGateway' : 'MercadopagoPaymentGateway';
    const gatewayAdapter = new (await paymentTree.load(`src/infrastructure/payment/${gateway}/${gateway}-payment-gateway.ts`))[Adapter](
      new PaymentGatewayHttp({ baseUrl, apiKey: 'k', webhookSecret: 'w', connectTimeoutMs: 1000, readTimeoutMs: 1000, noticeToleranceSeconds: 300, unansweredAfterSeconds: 5 })
    );
    const { ChargeRequest } = await paymentTree.load('src/domain/payment/charge-request.ts');
    const { PaymentSource } = await paymentTree.load('src/domain/payment/payment-source.ts');
    const { Decimal } = await paymentTree.load('src/domain/support/decimal.ts');
    const charge = (reference) => new ChargeRequest(reference, Decimal.parse('25.90'), 'BRL', PaymentSource.token('tok_test'));

    await http.resetStubs();
    await harness.gatewayAuthorizes('pay-1');
    await harness.gatewayDeclines('pay-2', 'insufficientFunds');
    const authorized = await gatewayAdapter.authorize(charge('pay-1'));
    const declined = await gatewayAdapter.authorize(charge('pay-2'));
    step(`${gateway}: cada cobro casa con SU referencia (bodyPatterns del stub real)`, authorized.status === 'AUTHORIZED' && declined.status === 'FAILED' && declined.failureReason === 'insufficientFunds', `${authorized.status} / ${declined.status} ${declined.failureReason}`);
    const [sent] = await harness.gatewayRequests(harness.GatewayCall.CHARGE);
    step(`${gateway}: la clave de idempotencia viajó en la cabecera de la pasarela`, http.stubRequestHeader(sent, gateway === 'stripe' ? 'Idempotency-Key' : 'X-Idempotency-Key') === 'pay-1:authorize');

    await harness.gatewayReports('pay-3', 'CAPTURED');
    const byId = await gatewayAdapter.status(null, harness.gatewayIdFor('pay-3'));
    const byReference = await gatewayAdapter.status('pay-3', null);
    step(`${gateway}: lo que reporta, por id (con su referencia) y por referencia (queryParameters del stub real)`, byId.status === 'CAPTURED' && byId.reference === 'pay-3' && byReference.status === 'CAPTURED', `${byId.status} ${byId.reference} / ${byReference.status}`);
    await harness.gatewayReports('pay-4', 'NOT_FOUND');
    step(`${gateway}: NOT_FOUND por los dos caminos`, (await gatewayAdapter.status('pay-4', null)).status === 'NOT_FOUND' && (await gatewayAdapter.status('pay-4', harness.gatewayIdFor('pay-4'))).status === 'NOT_FOUND');

    await harness.gatewayExpiresAuthorization('pay-5');
    step(`${gateway}: la autorización caducada es un cobro anulado`, (await gatewayAdapter.capture('pay-5', harness.gatewayIdFor('pay-5'))).status === 'CANCELED');
    await harness.gatewayRefunds('pay-6', '5.00');
    const refunded = await gatewayAdapter.refund('pay-6', harness.gatewayIdFor('pay-6'), Decimal.parse('5.00'), 'BRL');
    step(`${gateway}: la devolución parcial`, refunded.status === 'REFUNDED' && refunded.refundedAmount?.toString() === '5.00', `${refunded.status} ${refunded.refundedAmount}`);

    await http.resetStubs();
    await harness.gatewayDoesNotAnswer(harness.GatewayCall.CHARGE);
    const unanswered = await gatewayAdapter.authorize(charge('pay-7')).then(() => null, (error) => error);
    step(`${gateway}: sin respuesta, en duda y sin reintento`, unanswered?.name === 'PaymentGatewayUnavailableException' && (await harness.gatewayCallCount(harness.GatewayCall.CHARGE)) === 1, unanswered?.message);
  }
} catch (error) {
  step(`${current}: el paso no llegó a terminar`, false, error instanceof Error ? error.message : String(error));
} finally {
  if (!keep) run(runtime, ['rm', '-f', name]);
  else console.log(`(contenedor conservado: ${name}, puerto ${port})`);
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nstub-check: ${results.length}/${results.length} en verde.` : `\nstub-check: ${failed} paso(s) en rojo.`);
process.exit(failed === 0 ? 0 : 1);
