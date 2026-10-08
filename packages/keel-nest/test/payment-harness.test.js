// El arnés de la pasarela de pago (incremento 13d), EJECUTADO de punta a punta sin contenedores: el
// `test/integration/support/payment-gateway.ts` que emite keel-nest programa un WireMock MÍNIMO de node:http (admin y
// respuestas por mapping: método, patrón de ruta, «el cuerpo contiene», «la query contiene», corte de conexión), y
// el ADAPTADOR emitido de la misma pasarela le habla. Lo que se mide es lo que importa en una corrida: que lo que
// programa cada helper sea lo que el adaptador lee como el desenlace pedido —si el doble devolviera una forma que el
// adaptador no lee, los escenarios medirían el doble y no el servidor—, y que los avisos que firma el arnés los
// acepte el verificador emitido (y el falsificado no).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { HTTP_STUB_ENDPOINTS } from 'keel-core/gen/http-stub-probes';
import { PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS } from 'keel-core/gen/payment-gateways';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { tmpDir } from './helpers/tmp.js';
import { HTTP_STUB_TS } from '../src/scaffold/http-stub-harness.js';
import { PAYMENT_HARNESS_EXPORTS, PAYMENT_HARNESS_TS } from '../src/scaffold/payment-harness.js';

const SUBJECT = 'payment-checkout';
const NEST_STUB = `
const noop = () => () => {};
export const Inject = noop, Injectable = noop, Global = noop, Module = noop, Controller = noop, Post = noop, Req = noop, Res = noop;
export class Logger { constructor(context) { this.context = context; } log() {} warn() {} error() {} }
`;

/** Un WireMock mínimo: el admin que usa http-stub.ts y las respuestas por mapping (gana el último que casa). */
async function miniWireMock() {
  const mappings = [];
  const requests = [];
  const matches = (criterion, method, url, body) => {
    if (criterion.method !== method) return false;
    if (!new RegExp(`^${criterion.urlPathPattern}$`).test(url.pathname)) return false;
    for (const [name, rule] of Object.entries(criterion.queryParameters ?? {})) {
      if (!(url.searchParams.get(name) ?? '').includes(rule.contains)) return false;
    }
    return (criterion.bodyPatterns ?? []).every((pattern) => body.includes(pattern.contains));
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://x');
      const json = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith('/__admin')) {
        const sub = url.pathname.slice('/__admin'.length);
        const payload = body ? JSON.parse(body) : {};
        if (sub === HTTP_STUB_ENDPOINTS.mappings) mappings.push(payload);
        else if (sub === HTTP_STUB_ENDPOINTS.reset) {
          mappings.length = 0;
          requests.length = 0;
        } else if (sub === HTTP_STUB_ENDPOINTS.count) return json(200, { count: requests.filter((entry) => matches(payload, entry.method, entry.url, entry.body)).length });
        else if (sub === HTTP_STUB_ENDPOINTS.find) {
          return json(200, { requests: requests.filter((entry) => matches(payload, entry.method, entry.url, entry.body)).map((entry) => ({ url: entry.url.pathname + entry.url.search, method: entry.method, headers: entry.headers, body: entry.body })) });
        }
        return json(200, {});
      }
      requests.push({ method: request.method, url, headers: request.headers, body });
      const mapping = mappings.filter((candidate) => matches(candidate.request, request.method, url, body)).at(-1);
      if (!mapping) return json(404, {});
      if (mapping.response.fault) return request.socket.destroy();
      response.writeHead(mapping.response.status, mapping.response.headers ?? {});
      response.end(mapping.response.body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, admin: `${base}/__admin`, mappings, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Transpila http-stub.ts y payment-gateway.ts juntos y carga el segundo con el admin apuntando al falso. */
async function loadHarness(byPath, adminUrl) {
  const dir = tmpDir('keel-nest-payment-harness-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [file, name] of [[HTTP_STUB_TS, 'http-stub.js'], [PAYMENT_HARNESS_TS, 'payment-gateway.js']]) {
    const { outputText } = ts.transpileModule(byPath[file], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } });
    fs.writeFileSync(path.join(dir, name), outputText);
  }
  process.env.HTTP_STUB_ADMIN = adminUrl;
  try {
    return await import(pathToFileURL(path.join(dir, 'payment-gateway.js')).href);
  } finally {
    delete process.env.HTTP_STUB_ADMIN;
  }
}

for (const gateway of ['stripe', 'mercadopago']) {
  const { files } = planFixture(SUBJECT, { stack: { paymentGateway: gateway, broker: 'rabbitmq' } });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const Adapter = gateway === 'stripe' ? 'StripePaymentGateway' : 'MercadopagoPaymentGateway';
  const Verifier = gateway === 'stripe' ? 'StripeNoticeVerifier' : 'MercadopagoNoticeVerifier';
  const settings = (baseUrl) => ({ baseUrl, apiKey: 'k', webhookSecret: PAYMENT_TEST_SECRETS.webhookSecret, connectTimeoutMs: 1000, readTimeoutMs: 1000, noticeToleranceSeconds: 300, unansweredAfterSeconds: 5 });

  const wiremock = await miniWireMock();
  test.after(wiremock.close);
  const harness = await loadHarness(byPath, wiremock.admin);
  const { PaymentGatewayHttp } = await tree.load('src/infrastructure/payment/payment-gateway-http.ts');
  const adapter = new (await tree.load(`src/infrastructure/payment/${gateway}/${gateway}-payment-gateway.ts`))[Adapter](new PaymentGatewayHttp(settings(wiremock.base)));
  const { GatewayStatus } = await tree.load('src/domain/payment/gateway-status.ts');
  const { PaymentFailureReason } = await tree.load('src/domain/enums/payment-failure-reason.ts');
  const { PaymentGatewayUnavailableException } = await tree.load('src/domain/payment/payment-gateway-unavailable-exception.ts');
  const { ChargeRequest } = await tree.load('src/domain/payment/charge-request.ts');
  const { PaymentSource } = await tree.load('src/domain/payment/payment-source.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const { PaymentNotice } = await tree.load('src/infrastructure/payment/payment-notice-verifier.ts');
  const { InvalidPaymentNoticeException } = await tree.load('src/infrastructure/payment/invalid-payment-notice-exception.ts');
  const verifier = new (await tree.load(`src/infrastructure/payment/${gateway}/${gateway}-notice-verifier.ts`))[Verifier](settings('http://unused'));
  const charge = (reference) => new ChargeRequest(reference, Decimal.parse('25.90'), 'BRL', PaymentSource.token('tok_test'));
  const fresh = async () => {
    wiremock.mappings.length = 0;
    wiremock.requests.length = 0;
    await harness.gatewayReports('nadie', 'NOT_FOUND');
  };

  test(`${gateway}: el arnés exporta la misma API que flow.ts reexporta`, () => {
    for (const name of PAYMENT_HARNESS_EXPORTS) assert.ok(name in harness, `falta ${name}`);
    assert.match(byPath['test/integration/support/flow.ts'], new RegExp(`export \\{ ${PAYMENT_HARNESS_EXPORTS.join(', ')} \\} from './payment-gateway\\.js';`));
  });

  test(`${gateway}: lo que programa cada helper de cobro es el desenlace que lee el adaptador`, async () => {
    await fresh();
    await harness.gatewayAuthorizes('ch-1');
    await harness.gatewayCharges('ch-2');
    await harness.gatewayRequiresAction('ch-3');
    await harness.gatewayDeclines('ch-4', 'insufficientFunds');
    await harness.gatewayDeclines('ch-5', 'authenticationFailed');
    assert.equal((await adapter.authorize(charge('ch-1'))).status, GatewayStatus.AUTHORIZED);
    assert.equal((await adapter.authorize(charge('ch-2'))).status, GatewayStatus.CAPTURED);
    const action = await adapter.authorize(charge('ch-3'));
    assert.equal(action.status, GatewayStatus.ACTION_REQUIRED);
    assert.ok(action.customerAction != null && JSON.parse(action.customerAction), 'la acción del cliente llega y es JSON');
    const declined = await adapter.authorize(charge('ch-4'));
    assert.equal(declined.status, GatewayStatus.FAILED);
    assert.equal(declined.failureReason, PaymentFailureReason.INSUFFICIENT_FUNDS);
    const authentication = await adapter.authorize(charge('ch-5'));
    assert.equal(authentication.status, GatewayStatus.FAILED);
    assert.equal(authentication.failureReason, PaymentFailureReason.AUTHENTICATION_FAILED);
    // Cada mapping casa SOLO con su referencia: los cinco cobros conviven en el mismo flujo.
    assert.equal(declined.reference, 'ch-4');
  });

  test(`${gateway}: lo que reporta la pasarela por id y por referencia, incluido NOT_FOUND`, async () => {
    await fresh();
    for (const status of ['PENDING', 'AUTHORIZED', 'CAPTURED', 'CANCELED']) {
      const reference = `rep-${status.toLowerCase()}`;
      await harness.gatewayReports(reference, status);
      assert.equal((await adapter.status(reference, harness.gatewayIdFor(reference))).status, GatewayStatus[status], `${status} por id`);
      assert.equal((await adapter.status(reference, null)).status, GatewayStatus[status], `${status} por referencia`);
      // El aviso pregunta SOLO por el id (status(null, id)): la referencia del cobro tiene que salir del objeto.
      assert.equal((await adapter.status(null, harness.gatewayIdFor(reference))).reference, reference, `${status}: la referencia viaja en el objeto`);
    }
    await harness.gatewayReports('rep-refunded', 'REFUNDED');
    const refunded = await adapter.status('rep-refunded', harness.gatewayIdFor('rep-refunded'));
    assert.equal(refunded.status, GatewayStatus.REFUNDED);
    assert.equal(refunded.refundedAmount.toString(), '10.00');
    await harness.gatewayReports('rep-missing', 'NOT_FOUND');
    assert.equal((await adapter.status('rep-missing', null)).status, GatewayStatus.NOT_FOUND);
    assert.equal((await adapter.status('rep-missing', harness.gatewayIdFor('rep-missing'))).status, GatewayStatus.NOT_FOUND);
  });

  test(`${gateway}: captura, anulación, autorización caducada y devolución`, async () => {
    await fresh();
    await harness.gatewayCaptures('ch-6');
    assert.equal((await adapter.capture('ch-6', harness.gatewayIdFor('ch-6'))).status, GatewayStatus.CAPTURED);
    await harness.gatewayCancels('ch-7');
    assert.equal((await adapter.voidAuthorization('ch-7', harness.gatewayIdFor('ch-7'))).status, GatewayStatus.CANCELED);
    await harness.gatewayExpiresAuthorization('ch-8');
    assert.equal((await adapter.capture('ch-8', harness.gatewayIdFor('ch-8'))).status, GatewayStatus.CANCELED);
    await harness.gatewayRefunds('ch-9', '5.00');
    const refund = await adapter.refund('ch-9', harness.gatewayIdFor('ch-9'), Decimal.parse('5.00'), 'BRL');
    assert.equal(refund.status, GatewayStatus.REFUNDED);
    assert.equal(refund.refundedAmount.toString(), '5.00');
  });

  test(`${gateway}: sin respuesta queda en duda; un rechazo de la llamada no es una respuesta de éxito; las cuentas y las peticiones`, async () => {
    await fresh();
    await harness.gatewayDoesNotAnswer(harness.GatewayCall.CHARGE);
    await assert.rejects(adapter.authorize(charge('ch-10')), PaymentGatewayUnavailableException);
    assert.equal(await harness.gatewayCallCount(harness.GatewayCall.CHARGE), 1);
    const [sent] = await harness.gatewayRequests(harness.GatewayCall.CHARGE);
    assert.ok(sent.body.includes('ch-10'), 'la petición lleva la referencia');
    await harness.gatewayRejects(harness.GatewayCall.CAPTURE);
    await harness.gatewayReports('ch-11', 'AUTHORIZED');
    assert.equal((await adapter.capture('ch-11', harness.gatewayIdFor('ch-11'))).status, GatewayStatus.AUTHORIZED, 'rechazada: el estado real se consulta');
    await harness.gatewaySavesPaymentMethod();
    assert.match(await adapter.savePaymentMethod('tok_x', 'payer-1'), /\|/);
  });

  test(`${gateway}: el aviso que firma el arnés lo acepta el verificador; el falsificado, no`, async () => {
    const sent = [];
    const flow = { post: async (route, body, headers) => (sent.push({ route, body, headers }), { status: 200 }) };
    await harness.sendGatewayNotice(flow, 'ch-12');
    await harness.sendForgedGatewayNotice(flow, 'ch-12');
    const noticeOf = ({ route, body, headers }) => {
      const url = new URL(route, 'http://x');
      assert.equal(url.pathname, PAYMENT_NOTICE_PATH);
      return PaymentNotice.of(body, headers, Object.fromEntries(url.searchParams));
    };
    assert.equal(verifier.verify(noticeOf(sent[0])), harness.gatewayIdFor('ch-12'));
    assert.throws(() => verifier.verify(noticeOf(sent[1])), InvalidPaymentNoticeException);
  });
}
