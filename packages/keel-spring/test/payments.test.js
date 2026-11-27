// La capa payments generada: las defensas que build emite porque su ausencia no rompe ninguna
// prueba (constitution.md § Contenido de origen externo). Cada aserción nombra la defensa que
// protege; que el Java compile lo comprueba compile-check con las dos pasarelas, y que la firma se
// verifique de verdad, payment-check contra la pasarela de prueba.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { PAYMENT_GATEWAYS } from '../src/lib/stack-catalog.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));

function project(gateway) {
  const { files, model } = planService({ manifest, layers, workspace: '.', stack: { paymentGateway: gateway, broker: 'rabbitmq' } });
  const file = (suffix) => {
    const found = files.find((entry) => entry.path.endsWith(suffix));
    assert.ok(found, `${gateway}: no se generó ${suffix}`);
    return found.content;
  };
  return { files, model, file };
}

for (const gateway of Object.keys(PAYMENT_GATEWAYS)) {
  const { file, files } = project(gateway);
  const adapterName = `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}PaymentGateway.java`;
  const verifierName = `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}NoticeVerifier.java`;

  test(`${gateway}: solo se genera el adaptador de la pasarela elegida`, () => {
    const adapters = files.filter((entry) => /infrastructure\/payment\/[a-z]+\/[A-Za-z]+PaymentGateway\.java$/.test(entry.path));
    assert.deepEqual(adapters.map((entry) => path.basename(entry.path)), [adapterName]);
  });

  test(`${gateway}: la clave de idempotencia sale de la referencia y la acción, nunca de un aleatorio`, () => {
    const adapter = file(adapterName);
    assert.match(adapter, /return reference \+ ":" \+ action;/);
    assert.match(adapter, /idempotencyKey\(request\.reference\(\), "authorize"\)/);
    assert.doesNotMatch(adapter, /UUID\.randomUUID/);
    assert.match(adapter, new RegExp(`headers\\.set\\("${PAYMENT_GATEWAYS[gateway].idempotencyHeader}"`));
  });

  test(`${gateway}: un 5xx o un timeout deja la acción en duda, no se reintenta`, () => {
    const adapter = file(adapterName);
    assert.match(adapter, /is5xxServerError\(\)\) \{\s+throw unavailable/);
    assert.match(adapter, /catch \(RestClientException noAnswer\) \{\s+throw unavailable/);
    assert.doesNotMatch(adapter, /ResourceAccessException/, 'un corte a mitad de respuesta llega como RestClientException genérica');
    assert.doesNotMatch(adapter, /@Retry|retryTemplate|RetryTemplate/);
    assert.doesNotMatch(file('PaymentGatewayHttpConfig.java'), /Retry/);
  });

  test(`${gateway}: los rechazos caen en el vocabulario neutro, con declined por defecto`, () => {
    const adapter = file(adapterName);
    assert.match(adapter, /default -> PaymentFailureReason\.DECLINED;/);
    assert.match(adapter, /PaymentFailureReason\.INSUFFICIENT_FUNDS/);
  });

  test(`${gateway}: la firma se verifica sobre el cuerpo crudo y en tiempo constante, con ventana`, () => {
    const verifier = file(verifierName);
    assert.match(verifier, /MessageDigest\.isEqual/);
    assert.doesNotMatch(verifier, /\.equals\(signature|signature\.equals/);
    assert.match(verifier, /noticeToleranceSeconds\(\)/);
    assert.match(verifier, /HmacSHA256/);
    const controller = file('PaymentNoticeController.java');
    assert.match(controller, /@RequestBody\(required = false\) byte\[\] body/);
    assert.match(controller, /HttpStatus\.UNAUTHORIZED/);
  });

  test(`${gateway}: el aviso no decide el desenlace, se le pregunta a la pasarela`, () => {
    const notices = file('PaymentNotices.java');
    assert.match(notices, /gateway\.status\(null, gatewayPaymentId\)/);
    assert.match(notices, /applier\.apply\(outcome\)/);
  });
}

test('el aviso entra sin credencial, y solo esa ruta', () => {
  const security = project('stripe').file('SecurityConfig.java');
  assert.match(security, /\.requestMatchers\(HttpMethod\.POST, "\/webhooks\/payments"\)\.permitAll\(\)/);
});

test('en production las credenciales vienen del entorno sin default; en local, los secretos de prueba', () => {
  const { file } = project('mercadopago');
  const production = file('parameters/production/payments.yaml');
  assert.match(production, /api-key: \$\{MERCADOPAGO_ACCESS_TOKEN\}\n/);
  assert.match(production, /webhook-secret: \$\{MERCADOPAGO_WEBHOOK_SECRET\}\n/);
  assert.match(production, /base-url: \$\{MERCADOPAGO_BASE_URL:https:\/\/api\.mercadopago\.com\}/);
  const local = file('parameters/local/payments.yaml');
  assert.match(local, /base-url: http:\/\/localhost:8090/);
  assert.match(local, /webhook-secret: keel-test-webhook-secret/);
});

test('el aplicador de desenlaces cubre cada desenlace del diseño y deja TODO lo que la capa no nombra', () => {
  const applier = project('stripe').file('PaymentOutcomeApplier.java');
  for (const status of ['AUTHORIZED', 'ACTION_REQUIRED', 'CAPTURED', 'FAILED', 'REFUNDED', 'CANCELED']) {
    assert.match(applier, new RegExp(`case ${status} ->`));
  }
  assert.match(applier, /new MarkFailedCommand\(\s+outcome\.reference\(\),\s+outcome\.failureReason\(\),\s+outcome\.gatewayPaymentId\(\)\)/);
  // cancelReason no lo nombra la capa: la fixture lo acepta por escrito (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED).
  assert.match(applier, /null \/\* TODO\(keel\): 'cancelReason'/);
});

test('el barrido de pagos no recibe el reclamo genérico: tiene el suyo (re-estampar awaitingSince)', () => {
  const { model } = project('stripe');
  const sweep = model.services.flatMap((group) => group.operations).find((op) => op.name === 'sweepPendingPayments');
  assert.equal(sweep.claim, null);
  assert.deepEqual(model.payments.awaitingStates, ['pending', 'actionRequired', 'capturing', 'canceling', 'refunding']);
});

// Corridas payment-checkout (Stripe y MercadoPago): lo que destaparon y quedó arreglado en build.
for (const gateway of Object.keys(PAYMENT_GATEWAYS)) {
  const { file } = project(gateway);
  const adapterName = `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}PaymentGateway.java`;

  test(`${gateway}: el importe parcial viaja con su moneda; ninguna consulta a la pasarela fuera del try`, () => {
    assert.match(file('PaymentGateway.java'), /GatewayOutcome refund\(String reference, String refundReference, String gatewayPaymentId, BigDecimal amount, String currency\);/);
    const adapter = file(adapterName);
    assert.doesNotMatch(adapter, /currencyOf/);
    if (gateway === 'mercadopago') {
      assert.match(adapter, /try \{\s+current = fetch\(gatewayPaymentId\);\s+\} catch \(RestClientException noAnswer\) \{\s+throw unavailable\("refund"/);
    }
  });

  test(`${gateway}: el arnés simula la autorización caducada y envejece un cobro para el barrido`, () => {
    const harness = file('AbstractFlowIT.java');
    assert.match(harness, /protected static void gatewayExpiresAuthorization\(String reference\)/);
    assert.match(harness, /if \("sweepPendingPayments"\.equals\(activation\)\) \{\s+statements\.add\("UPDATE payments SET awaiting_since = /);
  });
}

test('stripe: capturar una autorización caducada se traduce a CANCELED sin otra consulta', () => {
  assert.match(project('stripe').file('StripePaymentGateway.java'),
    /contains\("charge_expired_for_capture"\)\) \{\s+return GatewayOutcome\.of\(GatewayStatus\.CANCELED/);
});

test('mercadopago: gatewayRefunds programa también la consulta de la order que la devolución parcial lee', () => {
  const harness = project('mercadopago').file('AbstractFlowIT.java');
  assert.match(harness, /gatewayStubPath\(GatewayCall\.STATUS, gatewayIdFor\(reference\), null, 200, gatewayObject\(reference, "CAPTURED", null, null\)\);\s+gatewayStubPath\(GatewayCall\.REFUND/);
});

// ─── La devolución en vuelo (corrida payment-spring, 2026-11-27) ─────────────
//
// payment-checkout declara partial-refund con refund.reference: cada devolución se sigue por separado. La consulta del
// cobro solo sabe el acumulado devuelto, y leerla como el desenlace de la devolución en curso daba el acumulado como
// importe y daba por hecha una devolución que no llegó (había otra antes). Que el adaptador acierte lo ejecuta
// payment-check (RF-1 a RF-9); aquí se fija la forma que lo hace posible.

for (const gateway of Object.keys(PAYMENT_GATEWAYS)) {
  const { file } = project(gateway);
  const adapterName = `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}PaymentGateway.java`;

  test(`${gateway}: el puerto y el barrido consultan la devolución en vuelo por su referencia`, () => {
    assert.match(file('application/port/out/PaymentGateway.java'),
      /GatewayOutcome refundStatus\(String reference, String refundReference, String gatewayPaymentId, BigDecimal alreadyRefunded\);/);
    const reconciliation = file('PaymentReconciliation.java');
    assert.match(reconciliation, /public GatewayStatus consultRefund\(String reference, String refundReference, String gatewayPaymentId, BigDecimal alreadyRefunded\)/);
    assert.match(reconciliation, /gateway\.refundStatus\(reference, refundReference, gatewayPaymentId, alreadyRefunded\)/);
  });

  test(`${gateway}: la consulta del cobro deja de deducir la devolución del acumulado`, () => {
    const adapter = file(adapterName);
    assert.doesNotMatch(adapter, /path\("amount_refunded"\)/);
    assert.doesNotMatch(adapter, /return GatewayOutcome\.refunded\(ref, id/);
    assert.match(adapter, /public GatewayOutcome refundStatus\(/);
  });

  test(`${gateway}: la nota del barrido manda consultar la devolución con consultRefund`, () => {
    const sweep = file('SweepPendingPaymentsCommandHandler.java');
    assert.match(sweep, /paymentReconciliation\.consultRefund\(reference, refundReference, gatewayPaymentId, alreadyRefunded\)/);
  });

  test(`${gateway}: la pasarela de prueba programa la devolución con su referencia y lo devuelto antes`, () => {
    const harness = file('AbstractFlowIT.java');
    assert.match(harness, /protected static void gatewayReportsRefund\(String reference, String refundReference, String outcome, BigDecimal amount,/);
    assert.doesNotMatch(harness, /protected static void gatewayReportsRefunded\(/);
    // G2: «no contesta» corta la respuesta a mitad; un corte antes de responder el JDK lo repite en un GET.
    assert.match(harness, /protected static void gatewayDoesNotAnswer\(GatewayCall call\) \{\s+String\[\] route = GATEWAY_ROUTES\.get\(call\);\s+stubBrokenResponse\(/);
  });
}

test('stripe: la referencia de la devolución viaja en su metadata y se busca por ella', () => {
  const adapter = project('stripe').file('StripePaymentGateway.java');
  assert.match(adapter, /form\.add\("metadata\[" \+ REFUND_REFERENCE_KEY \+ "\]", refundReference\);/);
  assert.match(adapter, /static final String REFUND_REFERENCE_KEY = "keel_refund_reference";/);
  assert.match(adapter, /queryParam\("payment_intent", gatewayPaymentId\)/);
});

test('mercadopago: la devolución en vuelo es lo procesado por encima de lo registrado, y la nueva la que no estaba', () => {
  const adapter = project('mercadopago').file('MercadopagoPaymentGateway.java');
  assert.match(adapter, /processed\.subtract\(alreadyRefunded == null \? BigDecimal\.ZERO : alreadyRefunded\)/);
  assert.match(adapter, /Set<String> known = refundIds\(current\);/);
  assert.match(adapter, /return refundResponse\(order, known, reference, gatewayPaymentId\);/);
});
