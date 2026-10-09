// Los cobros con pasarela (incremento 13b/13c), EJECUTADOS: el adaptador y el verificador que emite keel-nest para
// payment-checkout, transpilados y corridos contra una pasarela falsa de node:http que habla con las formas del doble
// de keel-core (payment-probes.js). Son los casos de `payment-check` de keel-spring, uno a uno, sobre las dos
// pasarelas del catálogo; cada caso nombra la defensa que mide. Y, sin ejecutar, lo que no puede cambiar con la
// pasarela (las piezas neutras), lo que tiene que decir lo mismo que keel-spring (payments.yaml, la ruta del aviso
// abierta) y lo que no se ve sin leer (el despacho sin transacción).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { loadService } from 'keel-core';
import path from 'node:path';
import { paymentProbesFor } from 'keel-core/gen/payment-probes';
import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, paymentIdempotencyKey } from 'keel-core/gen/payment-gateways';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const SUBJECT = 'payment-checkout';
const GATEWAYS = ['stripe', 'mercadopago'];
const SECRET = PAYMENT_TEST_SECRETS.webhookSecret;
const NOW_MS = Date.parse('2026-10-02T12:00:00Z');

const NEST_STUB = `
const noop = () => () => {};
export const Inject = noop, Injectable = noop, Global = noop, Module = noop, Controller = noop, Post = noop, Req = noop, Res = noop;
export class Logger { constructor(context) { this.context = context; } log() {} warn() {} error() {} }
`;

function plan(gateway) {
  return planFixture(SUBJECT, { stack: { paymentGateway: gateway, broker: 'rabbitmq' } });
}

const id = (probes, reference) => `${probes.idPrefix}${reference.replace(/[^A-Za-z0-9]/g, '')}`;

/** Un objeto de la pasarela en el estado neutro pedido, con las formas del doble. */
function gatewayObject(gateway, reference, status, detailOverride = null) {
  const probes = paymentProbesFor(gateway);
  if (gateway === 'stripe') {
    return { id: id(probes, reference), object: 'payment_intent', currency: 'brl', status: probes.statuses[status], metadata: { keel_reference: reference }, client_secret: `${id(probes, reference)}_secret` };
  }
  const [state, detail] = probes.statuses[status];
  const statusDetail = detailOverride ?? detail;
  return {
    id: id(probes, reference),
    status: state,
    status_detail: statusDetail,
    external_reference: reference,
    currency: 'BRL',
    transactions: { payments: [{ id: `PAY${id(probes, reference)}`, status_detail: statusDetail, payment_method: { type: 'credit_card' } }] }
  };
}

/** Lo que cambia entre pasarelas en los casos de abajo. */
function shapesOf(gateway) {
  const probes = paymentProbesFor(gateway);
  if (gateway === 'stripe') {
    return {
      probes,
      adapter: ['src/infrastructure/payment/stripe/stripe-payment-gateway.ts', 'StripePaymentGateway'],
      verifier: ['src/infrastructure/payment/stripe/stripe-notice-verifier.ts', 'StripeNoticeVerifier'],
      declineStatus: 402,
      decline: { error: { type: 'card_error', code: 'card_declined', decline_code: probes.declines.insufficientFunds, payment_intent: gatewayObject(gateway, 'ch-2', 'FAILED') } },
      expiredCapture: { error: { type: 'invalid_request_error', code: 'charge_expired_for_capture' } },
      expiredCaptureRequests: 1,
      amountOnWire: 'amount=2590',
      referenceOnWire: 'metadata%5Bkeel_reference%5D=ch-1',
      notice(secret, timestamp, extraSignature = '') {
        const body = '{"id": "evt_1", "data": {"object": {"id": "pi_ch1", "object": "payment_intent"}}}';
        const signature = hmac(secret, `${timestamp}.${body}`);
        return { body, headers: { [probes.notice.signatureHeader.toLowerCase()]: `t=${timestamp},v1=${extraSignature}${signature}` }, query: {}, id: 'pi_ch1' };
      }
    };
  }
  return {
    probes,
    adapter: ['src/infrastructure/payment/mercadopago/mercadopago-payment-gateway.ts', 'MercadopagoPaymentGateway'],
    verifier: ['src/infrastructure/payment/mercadopago/mercadopago-notice-verifier.ts', 'MercadopagoNoticeVerifier'],
    declineStatus: 200,
    decline: gatewayObject(gateway, 'ch-2', 'FAILED', probes.declines.insufficientFunds),
    expiredCapture: { errors: [{ code: 'order_expired' }] },
    expiredCaptureRequests: 2,
    amountOnWire: '"total_amount":"25.90"',
    referenceOnWire: '"external_reference":"ch-1"',
    notice(secret, timestamp, extraSignature = '') {
      const manifest = `id:ordch1;request-id:req-1;ts:${timestamp};`;
      return {
        body: '{"type": "order", "data": {"id": "ORDch1"}}',
        headers: { [probes.notice.signatureHeader.toLowerCase()]: `ts=${timestamp},v1=${extraSignature}${hmac(secret, manifest)}`, 'x-request-id': 'req-1' },
        query: { 'data.id': 'ORDch1' },
        id: 'ORDch1'
      };
    }
  };
}

function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** La pasarela falsa: rutas (la última que casa gana, como en payment-check) y lo que recibió. */
async function fakeGateway(idempotencyHeader) {
  const routes = [];
  const recorded = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://x');
      recorded.push({ method: request.method, path: url.pathname, query: url.search.slice(1), key: request.headers[idempotencyHeader.toLowerCase()] ?? null, body });
      const route = routes.filter((candidate) => candidate.method === request.method && new RegExp(`^${candidate.path}$`).test(url.pathname)).at(-1);
      if (!route) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (route.drop) {
        request.socket.destroy();
        return;
      }
      response.writeHead(route.status, { 'content-type': 'application/json' });
      response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    recorded,
    route: (call, status, body) => routes.push({ ...call, status, body }),
    drop: (method, pathRegex) => routes.push({ method, path: pathRegex, drop: true }),
    reset() {
      routes.length = 0;
      recorded.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

for (const gateway of GATEWAYS) {
  const { files, model } = plan(gateway);
  const shapes = shapesOf(gateway);
  const calls = shapes.probes.calls;
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const settings = (baseUrl) => ({
    baseUrl,
    apiKey: 'test-key',
    webhookSecret: SECRET,
    connectTimeoutMs: 1000,
    readTimeoutMs: 1000,
    noticeToleranceSeconds: 300,
    unansweredAfterSeconds: 5
  });

  async function gatewayAt(baseUrl) {
    const { PaymentGatewayHttp } = await tree.load('src/infrastructure/payment/payment-gateway-http.ts');
    const adapter = (await tree.load(shapes.adapter[0]))[shapes.adapter[1]];
    return new adapter(new PaymentGatewayHttp(settings(baseUrl)));
  }

  async function charge(reference, amount) {
    const { ChargeRequest } = await tree.load('src/domain/payment/charge-request.ts');
    const { PaymentSource } = await tree.load('src/domain/payment/payment-source.ts');
    const { Decimal } = await tree.load('src/domain/support/decimal.ts');
    return new ChargeRequest(reference, Decimal.parse(amount), 'BRL', PaymentSource.token('tok_test'));
  }

  const { GatewayStatus } = await tree.load('src/domain/payment/gateway-status.ts');
  const { PaymentGatewayUnavailableException } = await tree.load('src/domain/payment/payment-gateway-unavailable-exception.ts');
  const { PaymentFailureReason } = await tree.load('src/domain/enums/payment-failure-reason.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  const fake = await fakeGateway(model.payments.gateway.idempotencyHeader);
  test.after(fake.close);

  test(`${gateway}: la clave de idempotencia sale de la referencia y el importe va en la unidad de la pasarela`, async () => {
    fake.reset();
    fake.route(calls.CHARGE, 200, gatewayObject(gateway, 'ch-1', 'AUTHORIZED'));
    const outcome = await (await gatewayAt(fake.baseUrl)).authorize(await charge('ch-1', '25.90'));
    assert.equal(outcome.status, GatewayStatus.AUTHORIZED);
    assert.equal(outcome.reference, 'ch-1');
    assert.equal(fake.recorded.length, 1);
    assert.equal(fake.recorded[0].key, paymentIdempotencyKey('ch-1', 'authorize'));
    assert.ok(fake.recorded[0].body.includes(shapes.amountOnWire), fake.recorded[0].body);
    assert.ok(fake.recorded[0].body.includes(shapes.referenceOnWire), fake.recorded[0].body);
  });

  test(`${gateway}: reintentar con la misma referencia repite la clave`, async () => {
    fake.reset();
    fake.route(calls.CHARGE, 200, gatewayObject(gateway, 'ch-1', 'AUTHORIZED'));
    const adapter = await gatewayAt(fake.baseUrl);
    await adapter.authorize(await charge('ch-1', '25.90'));
    await adapter.authorize(await charge('ch-1', '25.90'));
    assert.equal(fake.recorded[0].key, fake.recorded[1].key);
  });

  test(`${gateway}: un rechazo cae en el vocabulario neutro`, async () => {
    fake.reset();
    fake.route(calls.CHARGE, shapes.declineStatus, shapes.decline);
    const outcome = await (await gatewayAt(fake.baseUrl)).authorize(await charge('ch-2', '10.00'));
    assert.equal(outcome.status, GatewayStatus.FAILED);
    assert.equal(outcome.failureReason, PaymentFailureReason.INSUFFICIENT_FUNDS);
  });

  test(`${gateway}: un error de la pasarela deja la acción en duda y NO se reintenta`, async () => {
    fake.reset();
    fake.route(calls.CHARGE, 503, {});
    await assert.rejects((await gatewayAt(fake.baseUrl)).authorize(await charge('ch-3', '10.00')), PaymentGatewayUnavailableException);
    assert.equal(fake.recorded.length, 1, 'un 5xx no se reintenta: puede haber cobrado');
  });

  test(`${gateway}: un corte de conexión deja la acción en duda`, async () => {
    fake.reset();
    fake.drop(calls.CHARGE.method, calls.CHARGE.path);
    await assert.rejects((await gatewayAt(fake.baseUrl)).authorize(await charge('ch-4', '10.00')), PaymentGatewayUnavailableException);
  });

  test(`${gateway}: sin id se busca por la referencia`, async () => {
    fake.reset();
    fake.route(calls.SEARCH, 200, { data: [gatewayObject(gateway, 'ch-9', 'CAPTURED')] });
    const outcome = await (await gatewayAt(fake.baseUrl)).status('ch-9', null);
    assert.equal(outcome.status, GatewayStatus.CAPTURED);
    assert.ok(decodeURIComponent(fake.recorded[0].query).includes('ch-9'), `la búsqueda tiene que llevar la referencia: ${fake.recorded[0].query}`);
    assert.ok(fake.recorded[0].query.includes(`${calls.SEARCH.query}=`), 'por el parámetro que lee el doble');
  });

  test(`${gateway}: lo que la pasarela no conoce es NOT_FOUND`, async () => {
    fake.reset();
    fake.route(calls.SEARCH, 200, { data: [] });
    assert.equal((await (await gatewayAt(fake.baseUrl)).status('ch-404', null)).status, GatewayStatus.NOT_FOUND);
  });

  test(`${gateway}: un importe con más decimales que la moneda no se redondea ni se manda`, async () => {
    fake.reset();
    await assert.rejects(async () => (await gatewayAt(fake.baseUrl)).authorize(await charge('ch-5', '10.555')), /más decimales/);
    assert.equal(fake.recorded.length, 0);
  });

  test(`${gateway}: una devolución parcial sin respuesta queda en duda aunque falle una lectura previa`, async () => {
    fake.reset();
    fake.drop('GET', '.*');
    fake.drop('POST', '.*');
    await assert.rejects((await gatewayAt(fake.baseUrl)).refund('ch-6', 'pay6', Decimal.parse('5.00'), 'BRL'), PaymentGatewayUnavailableException);
  });

  test(`${gateway}: una devolución parcial con un 5xx de la pasarela queda en duda y no se repite`, async () => {
    fake.reset();
    fake.route(calls.STATUS, 503, {});
    fake.route(calls.REFUND, 503, {});
    await assert.rejects((await gatewayAt(fake.baseUrl)).refund('ch-6', 'pay6', Decimal.parse('5.00'), 'BRL'), PaymentGatewayUnavailableException);
    assert.equal(fake.recorded.length, 1, 'ni la devolución ni la lectura previa se reintentan');
  });

  if (gateway === 'stripe') {
    test('stripe: un cobro sin el cliente delante que el emisor quiere autenticar es una acción pendiente, no un fallo', async () => {
      fake.reset();
      const intent = { ...gatewayObject(gateway, 'ch-8', 'ACTION_REQUIRED'), next_action: { type: 'use_stripe_sdk' } };
      fake.route(calls.CHARGE, 402, { error: { type: 'card_error', code: 'authentication_required', decline_code: 'authentication_required', payment_intent: intent } });
      const outcome = await (await gatewayAt(fake.baseUrl)).authorize(await charge('ch-8', '10.00'));
      assert.equal(outcome.status, GatewayStatus.ACTION_REQUIRED);
      assert.deepEqual(JSON.parse(outcome.customerAction), { clientSecret: 'pi_ch8_secret', nextAction: { type: 'use_stripe_sdk' } });
    });
  }

  test(`${gateway}: guardar un medio que la pasarela rechaza es SU excepción, con tipo; sin respuesta, en duda`, async () => {
    // Corridas payment-checkout en keel-nest: con un Error sin tipo, los dos agentes capturaron CUALQUIER error
    // como rechazo del medio, y un fallo de programación habría salido como 422 en vez de 500.
    const { GatewayRejectedPaymentMethodException } = await tree.load('src/domain/payment/gateway-rejected-payment-method-exception.ts');
    fake.reset();
    fake.route(calls.SAVE_METHOD, 400, { error: { code: 'rejected_by_test' } });
    const rejected = await (await gatewayAt(fake.baseUrl)).savePaymentMethod('tok_x', 'cli-1').then(() => null, (error) => error);
    assert.ok(rejected instanceof GatewayRejectedPaymentMethodException, String(rejected));
    assert.equal(rejected.status, 400);
    fake.reset();
    fake.route(calls.SAVE_METHOD, 503, {});
    await assert.rejects((await gatewayAt(fake.baseUrl)).savePaymentMethod('tok_x', 'cli-1'), PaymentGatewayUnavailableException);
  });

  test(`${gateway}: capturar una autorización caducada es un cobro anulado`, async () => {
    fake.reset();
    fake.route(calls.CAPTURE, 400, shapes.expiredCapture);
    fake.route(calls.STATUS, 200, gatewayObject(gateway, 'ch-7', 'CANCELED'));
    assert.equal((await (await gatewayAt(fake.baseUrl)).capture('ch-7', 'pay7')).status, GatewayStatus.CANCELED);
    assert.equal(fake.recorded.length, shapes.expiredCaptureRequests);
  });

  // ─── El aviso ──────────────────────────────────────────────────────────────

  async function verifier() {
    const { PaymentNotice } = await tree.load('src/infrastructure/payment/payment-notice-verifier.ts');
    const type = (await tree.load(shapes.verifier[0]))[shapes.verifier[1]];
    const instance = new type(settings('http://unused'));
    instance.clock = () => NOW_MS;
    return { instance, of: (notice) => PaymentNotice.of(notice.body, notice.headers, notice.query) };
  }
  const { InvalidPaymentNoticeException } = await tree.load('src/infrastructure/payment/invalid-payment-notice-exception.ts');
  const nowSeconds = Math.floor(NOW_MS / 1000);

  test(`${gateway}: un aviso firmado por la pasarela verifica y dice de qué cobro habla`, async () => {
    const { instance, of } = await verifier();
    const notice = shapes.notice(SECRET, nowSeconds);
    assert.equal(instance.verify(of(notice)), notice.id);
  });

  test(`${gateway}: un aviso con otra firma se rechaza`, async () => {
    const { instance, of } = await verifier();
    assert.throws(() => instance.verify(of(shapes.notice(`${SECRET}-falso`, nowSeconds))), InvalidPaymentNoticeException);
  });

  test(`${gateway}: un aviso fuera de la ventana se rechaza aunque la firma sea buena`, async () => {
    const { instance, of } = await verifier();
    assert.throws(() => instance.verify(of(shapes.notice(SECRET, nowSeconds - 3600))), InvalidPaymentNoticeException);
  });

  test(`${gateway}: sin cabecera de firma no se mira nada más`, async () => {
    const { instance, of } = await verifier();
    const notice = shapes.notice(SECRET, nowSeconds);
    assert.throws(() => instance.verify(of({ ...notice, headers: {} })), /sin cabecera de firma/);
  });
}

// ─── Lo neutro y lo que tiene que decir lo mismo que keel-spring ─────────────

test('el mismo diseño genera lo mismo con cada pasarela, salvo su adaptador y su verificador', () => {
  const [stripe, mercadopago] = GATEWAYS.map((gateway) => new Map(plan(gateway).files.map((file) => [file.path, file.content])));
  const differing = [...new Set([...stripe.keys(), ...mercadopago.keys()])].filter((file) => stripe.get(file) !== mercadopago.get(file));
  const allowed = [
    /^src\/infrastructure\/payment\/(stripe|mercadopago)\//,
    // La sección del arnés que imita su protocolo (la API que usan los escenarios es la misma).
    /^test\/integration\/support\/payment-gateway\.ts$/,
    // El módulo nombra el adaptador elegido.
    /^src\/infrastructure\/payment\/payments-module\.ts$/,
    // Las variables de su credencial y su URL pública, fuera de local y test.
    /^config\/parameters\/(develop|production)\/payments\.yaml$/,
    // Lo que nombra el stack elegido.
    /^(README|AGENTS|CLAUDE)\.md$/,
    /^\.[a-z]+\/skills\//,
    /^keel-stack\.json$/
  ];
  assert.deepEqual(differing.filter((file) => !allowed.some((pattern) => pattern.test(file))), []);
  assert.ok(differing.some((file) => file.endsWith('-payment-gateway.ts')), 'los adaptadores tendrían que diferir');
});

test('payments.yaml dice lo mismo que el de keel-spring en los cuatro perfiles (un mismo .env para los dos)', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
  for (const gateway of GATEWAYS) {
    const spring = planSpring({ manifest, layers, workspace: '.', stack: { paymentGateway: gateway, broker: 'rabbitmq' } }).files;
    const nest = plan(gateway).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const springYaml = spring.find((file) => file.path.endsWith(`parameters/${profile}/payments.yaml`))?.content;
      const nestYaml = nest.find((file) => file.path === `config/parameters/${profile}/payments.yaml`)?.content;
      assert.ok(springYaml && nestYaml, `${gateway}/${profile}: falta uno de los dos`);
      assert.equal(nestYaml, springYaml, `${gateway}/${profile}`);
    }
  }
});

test('la ruta del aviso entra sin credencial, y solo con POST', () => {
  const rules = plan('stripe').files.find((file) => file.path.endsWith('access-rules.ts'))?.content ?? '';
  assert.match(rules, new RegExp(`\\{ method: 'POST', path: '${PAYMENT_NOTICE_PATH}', requirement: \\{ kind: 'public' \\} \\}`));
});

test('el lector JSON deja pasar el cuerpo del aviso sin leerlo, y solo el de esa ruta', () => {
  const platform = plan('stripe').files.find((file) => file.path === 'src/infrastructure/http/http-platform.ts').content;
  assert.match(platform, new RegExp(`if \\(request\\.url\\.split\\('\\?'\\)\\[0\\] === '${PAYMENT_NOTICE_PATH}'\\) \\{\\s+done\\(null, body\\);\\s+return;`));
  // Sin pagos, el lector no cambia.
  const plain = planFixture('job-dispatch').files.find((file) => file.path === 'src/infrastructure/http/http-platform.ts').content;
  assert.doesNotMatch(plain, /webhooks/);
});

test('lo que llama a la pasarela se despacha SIN transacción abarcadora, como en keel-spring', () => {
  const { files, model } = plan('stripe');
  const controllers = files.filter((file) => file.path.startsWith('src/infrastructure/rest/controllers/')).map((file) => file.content).join('\n');
  for (const name of [model.payments.charge.operation, model.payments.capture.operation, model.payments.refund.operation, model.payments.savePaymentMethod.operation]) {
    const messageClass = model.services.flatMap((service) => service.operations).find((operation) => operation.name === name).messageClass;
    assert.match(controllers, new RegExp(`this\\.mediator\\.dispatchWithoutTransaction\\(read${messageClass}\\(`), name);
  }
  assert.match(controllers, /this\.mediator\.dispatch\(readGetPaymentQuery\(/, 'una consulta sigue con su transacción');
  const scheduler = files.find((file) => file.path.endsWith('payment-scheduler.ts')).content;
  assert.match(scheduler, /dispatchWithoutTransaction\(new SweepPendingPaymentsCommand\(\)\)/);
});

test('la tabla de unidades menores que se emite es la de keel-core, y convierte sin redondear', async () => {
  const { files } = plan('stripe');
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { MoneyAmounts } = await tree.load('src/infrastructure/payment/money-amounts.ts');
  const { Decimal } = await tree.load('src/domain/support/decimal.ts');
  for (const [code, digits] of Object.entries(CURRENCY_MINOR_UNITS)) assert.equal(MoneyAmounts.digitsOf(code), digits, code);
  assert.equal(MoneyAmounts.toMinorUnits(Decimal.parse('12.500'), 'IQD'), 12500n, 'IQD tiene tres decimales (Intl diría cero)');
  assert.equal(MoneyAmounts.toMinorUnits(Decimal.parse('25.9'), 'BRL'), 2590n);
  assert.equal(MoneyAmounts.toMinorUnits(Decimal.parse('1000'), 'JPY'), 1000n);
  assert.equal(MoneyAmounts.toMajorUnits(Decimal.parse('25.9'), 'BRL'), '25.90');
  assert.equal(MoneyAmounts.fromMinorUnits(1250n, 'EUR').toString(), '12.50');
  assert.equal(MoneyAmounts.fromMinorUnits(7, 'JPY').toString(), '7');
  assert.throws(() => MoneyAmounts.toMinorUnits(Decimal.parse('1.5'), 'JPY'), /más decimales/);
  assert.throws(() => MoneyAmounts.digitsOf('XAU'), /desconocida/);
});

test('el aplicador despacha la operación de cada desenlace; lo que la capa no nombra falla en voz alta', async () => {
  const { files } = plan('stripe');
  const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
  const { PaymentOutcomeApplier } = await tree.load('src/application/payment/payment-outcome-applier.ts');
  const { GatewayOutcome } = await tree.load('src/domain/payment/gateway-outcome.ts');
  const { GatewayStatus } = await tree.load('src/domain/payment/gateway-status.ts');
  const { PaymentReconciliation } = await tree.load('src/application/payment/payment-reconciliation.ts');
  const { PaymentNotices } = await tree.load('src/application/payment/payment-notices.ts');
  const { PaymentFailureReason } = await tree.load('src/domain/enums/payment-failure-reason.ts');
  const dispatched = [];
  const applier = new PaymentOutcomeApplier({ dispatch: async (message) => dispatched.push(message) });

  await applier.apply(GatewayOutcome.actionRequired('ch-1', 'pi_1', '{"type":"redirect"}'));
  assert.equal(dispatched[0].constructor.name, 'MarkActionRequiredCommand');
  assert.equal(dispatched[0].customerAction.text, '{"type":"redirect"}', 'la acción viaja como RawJson: embebida, no escapada');
  await applier.apply(GatewayOutcome.failed('ch-2', null, PaymentFailureReason.DECLINED));
  assert.equal(dispatched[1].constructor.name, 'MarkFailedCommand');
  assert.equal(dispatched[1].gatewayPaymentId, null, 'el id que la pasarela no llegó a dar es opcional en markFailed');
  await assert.rejects(applier.apply(GatewayOutcome.of(GatewayStatus.AUTHORIZED, 'ch-3', null)), /no trae 'gatewayPaymentId'/);
  await assert.rejects(applier.apply(GatewayOutcome.of(GatewayStatus.CANCELED, 'ch-4', 'pi_4')), /TODO\(keel\): 'cancelReason'/);
  const before = dispatched.length;
  await applier.apply(GatewayOutcome.of(GatewayStatus.PENDING, 'ch-5', 'pi_5'));
  assert.equal(dispatched.length, before, 'PENDING no es un desenlace');

  // El barrido: lo que la pasarela no conoce es un cobro que falló sin cobrar (notReceived).
  const reconciliation = new PaymentReconciliation({ status: async () => GatewayOutcome.notFound('ch-6') }, applier, { unansweredAfterSeconds: 900, batchSize: 50 });
  assert.equal(await reconciliation.consult('ch-6', null), GatewayStatus.NOT_FOUND);
  assert.equal(dispatched.at(-1).failureReason, PaymentFailureReason.NOT_RECEIVED);
  assert.equal(reconciliation.staleBefore(new Date(NOW_MS)).getTime(), NOW_MS - 900_000);
  assert.equal(reconciliation.batchSize(), 50, 'el lote del barrido sale de la configuración, no de una constante del agente');

  // El aviso no decide: se pregunta, y PENDING no se aplica.
  const asked = [];
  const notices = new PaymentNotices({ status: async (reference, gatewayPaymentId) => (asked.push([reference, gatewayPaymentId]), GatewayOutcome.of(GatewayStatus.PENDING, 'ch-7', gatewayPaymentId)) }, applier);
  const count = dispatched.length;
  await notices.onNotice('pi_7');
  assert.deepEqual(asked, [[null, 'pi_7']]);
  assert.equal(dispatched.length, count);
});

test('la clave de idempotencia emitida es la de keel-core', async () => {
  for (const gateway of GATEWAYS) {
    const { files } = plan(gateway);
    const tree = transpileTree(files, { stubs: { '@nestjs/common': NEST_STUB } });
    const { idempotencyKey } = await tree.load(shapesOf(gateway).adapter[0]);
    assert.equal(idempotencyKey('ch-1', 'refund'), paymentIdempotencyKey('ch-1', 'refund'), gateway);
  }
});
