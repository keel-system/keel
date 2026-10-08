// La pasarela de pago de prueba en el arnés (incremento 13d): una API NEUTRA —los mismos helpers con cualquier
// pasarela, y los mismos nombres que el AbstractFlowIT de keel-spring— para que los escenarios se traduzcan a
// pruebas una sola vez, igual que el diseño se escribe una sola vez. Por debajo, cada helper programa el WireMock
// de infra/ con la forma de la pasarela elegida (keel-core/gen/payment-probes.js) y firma los avisos como los
// firmaría ella.
//
// No es un doble dentro del proceso: el servidor habla HTTP con WireMock por el mismo socket que con la pasarela
// real, con el mismo adaptador. Lo que se mide es el servidor.
//
// `test/integration/support/payment-gateway.ts` no importa Nest ni vitest (solo `node:crypto` y los helpers del
// stub): por eso se puede EJECUTAR en las pruebas de keel-nest contra un admin falso. `flow.ts` lo reexporta, y los
// flujos siguen importando solo de `flow.ts`.

import { paymentProbesFor } from 'keel-core/gen/payment-probes';
import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, gatewayTranslation } from 'keel-core/gen/payment-gateways';
import { tsString } from './render.js';

export const PAYMENT_HARNESS_TS = 'test/integration/support/payment-gateway.ts';

export function usesPaymentHarness(model) {
  return Boolean(model.payments);
}

/** Los nombres que flow.ts reexporta. */
export const PAYMENT_HARNESS_EXPORTS = [
  'GatewayCall',
  'gatewayIdFor',
  'gatewayAuthorizes',
  'gatewayCharges',
  'gatewayRequiresAction',
  'gatewayDeclines',
  'gatewayDoesNotAnswer',
  'gatewayReports',
  'gatewayCaptures',
  'gatewayCancels',
  'gatewayExpiresAuthorization',
  'gatewayRejects',
  'gatewaySavesPaymentMethod',
  'gatewayRefunds',
  'gatewayCallCount',
  'gatewayRequests',
  'sendGatewayNotice',
  'sendForgedGatewayNotice'
];

export function generate(model) {
  return usesPaymentHarness(model) ? [{ path: PAYMENT_HARNESS_TS, content: paymentGatewayTs(model) }] : [];
}

/** La moneda con la que corren los escenarios: el testValue del parámetro, si la moneda sale de uno. */
export function testCurrency(model) {
  const parameter = model.payments.charge.currency?.parameter;
  const found = parameter ? (model.service.parameters ?? []).find((entry) => entry.name === parameter) : null;
  return String(found?.testValue ?? 'EUR').toUpperCase();
}

function paymentGatewayTs(model) {
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  const currency = testCurrency(model);
  const routes = Object.entries(probes.calls)
    .map(([call, route]) => `  ${call}: { method: ${tsString(route.method)}, path: ${tsString(route.path)} }`)
    .join(',\n');
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes, currency) : mercadopagoSpecific(probes, currency);
  return `/**
 * La pasarela de pago de prueba (capa payments, ${gateway.label}): el WireMock de infra/ hablando el protocolo de la
 * pasarela elegida, al que apunta \`payments.gateway.base-url\` en el perfil \`local\`.
 *
 * La API es NEUTRA: los mismos helpers con cualquier pasarela, porque los escenarios no nombran ninguna. Son los
 * mismos que el arnés de keel-spring. Se importan de flow.ts, nunca de aquí.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { stubCallCount, stubConnectionFault, stubFor, stubRawMapping, stubRequests, type StubRequest } from './http-stub.js';

/** Las llamadas que el servidor le hace a la pasarela. */
export const GatewayCall = {
${Object.keys(probes.calls).map((call) => `  ${call}: ${tsString(call)}`).join(',\n')}
} as const;
export type GatewayCall = (typeof GatewayCall)[keyof typeof GatewayCall];

const GATEWAY_ROUTES: Readonly<Record<GatewayCall, { readonly method: string; readonly path: string }>> = {
${routes}
};

/** El secreto con el que el perfil local verifica los avisos (config/parameters/local/payments.yaml). */
const GATEWAY_WEBHOOK_SECRET = ${tsString(PAYMENT_TEST_SECRETS.webhookSecret)};

/** La moneda de los escenarios (testValue del parámetro de despliegue). */
const GATEWAY_CURRENCY = ${tsString(currency)};

/** Los decimales de su unidad menor (la tabla de keel-core). */
const GATEWAY_CURRENCY_DIGITS: number = ${CURRENCY_MINOR_UNITS[currency] ?? 2};

/** Lo mínimo del flujo que necesita un aviso: mandar un POST con su cuerpo literal y sus cabeceras. */
export interface NoticeSender<R> {
  post(path: string, body?: unknown, headers?: Readonly<Record<string, string>>): Promise<R>;
}

/**
 * El id que la pasarela de prueba asigna al cobro de esa referencia. Es determinista para que el escenario pueda
 * nombrarlo antes de pedir el cobro (para un aviso, por ejemplo).
 */
export function gatewayIdFor(reference: string): string {
  return ${tsString(probes.idPrefix)} + reference.replace(/[^A-Za-z0-9]/g, '');
}

/** El siguiente cobro con esa referencia queda autorizado (importe retenido). */
export async function gatewayAuthorizes(reference: string): Promise<void> {
  await gatewayStub('CHARGE', null, reference, 200, gatewayObject(reference, 'AUTHORIZED', null, null));
}

/** El siguiente cobro con esa referencia queda cobrado en el acto. */
export async function gatewayCharges(reference: string): Promise<void> {
  await gatewayStub('CHARGE', null, reference, 200, gatewayObject(reference, 'CAPTURED', null, null));
}

/** El siguiente cobro con esa referencia exige que el cliente se autentique (3DS). */
export async function gatewayRequiresAction(reference: string): Promise<void> {
  await gatewayStub('CHARGE', null, reference, 200, gatewayObject(reference, 'ACTION_REQUIRED', null, null));
}

/**
 * El siguiente cobro con esa referencia se rechaza, con un motivo del vocabulario neutro (declined,
 * insufficientFunds, expiredCard, authenticationFailed, fraudSuspected, invalidPaymentMethod, processingError).
 */
export async function gatewayDeclines(reference: string, reason: string): Promise<void> {
  await gatewayDecline(reference, reason);
}

/** La pasarela no contesta a esa llamada: corta la conexión. La acción queda EN DUDA. */
export async function gatewayDoesNotAnswer(call: GatewayCall): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await stubConnectionFault(route.method, route.path);
}

/**
 * Lo que responde la pasarela cuando se le pregunta por el cobro de esa referencia, por su id y por la referencia.
 * Con 'NOT_FOUND' no lo conoce: la petición no le llegó nunca.
 */
export async function gatewayReports(reference: string, status: string): Promise<void> {
  if (status === 'NOT_FOUND') {
    await gatewayStubPath('STATUS', gatewayIdFor(reference), 404, {});
    await gatewayStub('SEARCH', reference, null, 200, { data: [] });
    return;
  }
  const object = gatewayObject(reference, status, null, status === 'REFUNDED' ? '10.00' : null);
  await gatewayStubPath('STATUS', gatewayIdFor(reference), 200, object);
  await gatewayStub('SEARCH', reference, null, 200, { data: [object] });
}

/** La pasarela captura el cobro de esa referencia en el acto. */
export async function gatewayCaptures(reference: string): Promise<void> {
  await gatewayStubPath('CAPTURE', gatewayIdFor(reference), 200, gatewayObject(reference, 'CAPTURED', null, null));
}

/** La pasarela anula la autorización del cobro de esa referencia en el acto. */
export async function gatewayCancels(reference: string): Promise<void> {
  await gatewayStubPath('CANCEL', gatewayIdFor(reference), 200, gatewayObject(reference, 'CANCELED', null, null));
}

/**
 * La autorización del cobro de esa referencia caducó antes de capturarse: la captura se rechaza y, preguntada, la
 * pasarela lo da por anulado. Es el desenlace que la pasarela impone sola pasado su plazo (unos días), y ningún
 * escenario puede esperarlo.
 */
export async function gatewayExpiresAuthorization(reference: string): Promise<void> {
  await gatewayStubPath('CAPTURE', gatewayIdFor(reference), 400, gatewayExpiredCapture());
  await gatewayReports(reference, 'CANCELED');
}

/** La pasarela rechaza esa llamada (4xx): la acción no se hizo. */
export async function gatewayRejects(call: GatewayCall): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await stubFor(route.method, route.path, 400, { error: { code: 'rejected_by_test' } });
}

/** La pasarela guarda el medio de pago que se le pase. */
export async function gatewaySavesPaymentMethod(): Promise<void> {
  const save = GATEWAY_ROUTES.SAVE_METHOD;
  const attach = GATEWAY_ROUTES.ATTACH_METHOD;
  await stubFor(save.method, save.path, 200, { id: 'cus_keel_test' });
  await stubFor(attach.method, attach.path, 200, { id: 'card_keel_test' });
}

/** Cuántas veces llamó el servidor a la pasarela por esa llamada. */
export async function gatewayCallCount(call: GatewayCall): Promise<number> {
  const route = GATEWAY_ROUTES[call];
  return stubCallCount(route.method, route.path);
}

/** Las peticiones que recibió la pasarela por esa llamada (para afirmar cabeceras y cuerpos). */
export async function gatewayRequests(call: GatewayCall): Promise<StubRequest[]> {
  const route = GATEWAY_ROUTES[call];
  return stubRequests(route.method, route.path);
}

/** La pasarela avisa de que algo cambió en el cobro de esa referencia, firmado como lo firma ella. */
export function sendGatewayNotice<R>(flow: NoticeSender<R>, reference: string): Promise<R> {
  return gatewayNotice(flow, reference, GATEWAY_WEBHOOK_SECRET);
}

/** Un aviso con la firma ALTERADA: el servidor tiene que rechazarlo sin consultar nada. */
export function sendForgedGatewayNotice<R>(flow: NoticeSender<R>, reference: string): Promise<R> {
  return gatewayNotice(flow, reference, \`\${GATEWAY_WEBHOOK_SECRET}-falso\`);
}

// ─── Mappings ────────────────────────────────────────────────────────────────

// Un mapping del doble para una llamada: con \`bodyContains\` solo casa la petición cuyo cuerpo lo lleve (la
// referencia), con \`queryContains\` la que lo lleve en su parámetro de búsqueda.
async function gatewayStub(call: GatewayCall, queryContains: string | null, bodyContains: string | null, status: number, body: unknown): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await gatewayMapping(route.method, route.path, queryContains, bodyContains, status, body);
}

// Igual, sobre la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).
async function gatewayStubPath(call: GatewayCall, gatewayId: string, status: number, body: unknown): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await gatewayMapping(route.method, route.path.replace('(?!search)[^/]+', gatewayId).replace('[^/]+', gatewayId), null, null, status, body);
}

async function gatewayMapping(method: string, pathPattern: string, queryContains: string | null, bodyContains: string | null, status: number, body: unknown): Promise<void> {
  const request: Record<string, unknown> = { method, urlPathPattern: pathPattern };
  if (queryContains != null) request.queryParameters = { ${tsString(probes.calls.SEARCH.query)}: { contains: queryContains } };
  if (bodyContains != null) request.bodyPatterns = [{ contains: bodyContains }];
  const response = { status, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
  await stubRawMapping(request, response);
}

function gatewayHmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

${
    gateway.amountUnit === 'minor'
      ? `
/** Un importe decimal ('10.00') en la unidad menor de la moneda de los escenarios, sin redondear. */
function minorUnits(amount: string): number {
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > GATEWAY_CURRENCY_DIGITS) throw new Error(\`El importe \${amount} tiene más decimales de los que admite \${GATEWAY_CURRENCY}\`);
  return Number(\`\${whole}\${fraction.padEnd(GATEWAY_CURRENCY_DIGITS, '0')}\`);
}`
      : `
/** Un importe decimal ('10') con la escala de la moneda de los escenarios ('10.00'). */
function majorUnits(amount: string): string {
  const [whole, fraction = ''] = amount.split('.');
  return GATEWAY_CURRENCY_DIGITS === 0 ? whole! : \`\${whole}.\${fraction.padEnd(GATEWAY_CURRENCY_DIGITS, '0')}\`;
}`
  }
${specific}`;
}

function stripeSpecific(probes) {
  const translation = gatewayTranslation('stripe');
  const statuses = Object.entries(probes.statuses).map(([key, value]) => `  ${key}: ${tsString(value)}`).join(',\n');
  const declines = Object.entries(probes.declines).map(([key, value]) => `  ${key}: ${tsString(value)}`).join(',\n');
  return `
const GATEWAY_STATUSES: Readonly<Record<string, string>> = {
${statuses}
};

const GATEWAY_DECLINES: Readonly<Record<string, string>> = {
${declines}
};

/** Un PaymentIntent con la forma que lee el adaptador de Stripe. */
function gatewayObject(reference: string, status: string, declineCode: string | null, refunded: string | null): Record<string, unknown> {
  const id = gatewayIdFor(reference);
  const object: Record<string, unknown> = {
    id,
    object: 'payment_intent',
    currency: GATEWAY_CURRENCY.toLowerCase(),
    status: GATEWAY_STATUSES[status],
    metadata: { ${tsString(translation.referenceKey)}: reference },
    client_secret: \`\${id}_secret_test\`
  };
  if (status === 'ACTION_REQUIRED') object.next_action = { type: 'use_stripe_sdk' };
  if (status === 'FAILED') object.last_payment_error = { code: 'card_declined', decline_code: declineCode ?? 'generic_decline' };
  if (refunded != null) object.latest_charge = { amount_refunded: minorUnits(refunded), currency: GATEWAY_CURRENCY.toLowerCase() };
  return object;
}

// Stripe rechaza un cobro confirmado con un 402 y el PaymentIntent dentro del error. El de autenticación no: un 402
// authentication_required es una ACCIÓN del cliente pendiente, así que ese motivo llega como el PaymentIntent fallido
// que devuelve la consulta.
async function gatewayDecline(reference: string, reason: string): Promise<void> {
  const code = GATEWAY_DECLINES[reason] ?? 'generic_decline';
  const failed = gatewayObject(reference, 'FAILED', code, null);
  if (reason === 'authenticationFailed') {
    await gatewayStub('CHARGE', null, reference, 200, failed);
    return;
  }
  await gatewayStub('CHARGE', null, reference, 402, { error: { type: 'card_error', code: 'card_declined', decline_code: code, payment_intent: failed } });
}

// Stripe contesta a capturar una autorización caducada con este código, y el adaptador lo lee.
function gatewayExpiredCapture(): unknown {
  return { error: { type: 'invalid_request_error', code: ${tsString(translation.expiredCaptureMarker)} } };
}

/** La devolución del cobro de esa referencia se completa por ese importe ('5.00'). */
export async function gatewayRefunds(reference: string, amount: string): Promise<void> {
  const id = gatewayIdFor(reference);
  await gatewayStub('REFUND', null, id, 200, { id: \`re_\${id}\`, status: 'succeeded', amount: minorUnits(amount), currency: GATEWAY_CURRENCY.toLowerCase(), payment_intent: id });
}

function gatewayNotice<R>(flow: NoticeSender<R>, reference: string, secret: string): Promise<R> {
  const id = gatewayIdFor(reference);
  const body = JSON.stringify({ id: \`evt_\${id}\`, type: 'payment_intent.updated', data: { object: { id, object: 'payment_intent' } } });
  const t = Math.floor(Date.now() / 1000);
  return flow.post(${tsString(PAYMENT_NOTICE_PATH)}, body, { ${tsString(probes.notice.signatureHeader)}: \`t=\${t},v1=\${gatewayHmac(secret, \`\${t}.\${body}\`)}\` });
}


`;
}

function mercadopagoSpecific(probes) {
  const translation = gatewayTranslation('mercadopago');
  const statuses = Object.entries(probes.statuses)
    .map(([key, [status, detail]]) => `  ${key}: [${tsString(status)}, ${tsString(detail)}]`)
    .join(',\n');
  const declines = Object.entries(probes.declines).map(([key, value]) => `  ${key}: ${tsString(value)}`).join(',\n');
  return `
const GATEWAY_STATUSES: Readonly<Record<string, readonly [string, string]>> = {
${statuses}
};

const GATEWAY_DECLINES: Readonly<Record<string, string>> = {
${declines}
};

/** Una order con la forma que lee el adaptador de MercadoPago. */
function gatewayObject(reference: string, status: string, detail: string | null, refunded: string | null): Record<string, unknown> {
  const id = gatewayIdFor(reference);
  const [state, defaultDetail] = GATEWAY_STATUSES[status]!;
  const statusDetail = detail ?? defaultDetail;
  const transactions: Record<string, unknown> = {
    payments: [{ id: \`PAY\${id}\`, status_detail: statusDetail, payment_method: { type: 'credit_card', url: \`https://pasarela.test/3ds/\${id}\` } }]
  };
  if (refunded != null) transactions.refunds = [{ amount: majorUnits(refunded) }];
  return { id, status: state, status_detail: statusDetail, ${tsString(translation.referenceKey)}: reference, currency: GATEWAY_CURRENCY, transactions };
}

async function gatewayDecline(reference: string, reason: string): Promise<void> {
  const detail = GATEWAY_DECLINES[reason] ?? 'cc_rejected_other_reason';
  await gatewayStub('CHARGE', null, reference, 200, gatewayObject(reference, 'FAILED', detail, null));
}

// MercadoPago no documenta un código para la captura caducada: el adaptador consulta el estado.
function gatewayExpiredCapture(): unknown {
  return { errors: [{ code: 'order_expired' }] };
}

/**
 * La devolución del cobro de esa referencia se completa por ese importe ('5.00'). Programa también la consulta de la
 * order (capturada), porque una devolución parcial la lee antes para nombrar la transacción.
 */
export async function gatewayRefunds(reference: string, amount: string): Promise<void> {
  await gatewayStubPath('STATUS', gatewayIdFor(reference), 200, gatewayObject(reference, 'CAPTURED', null, null));
  await gatewayStubPath('REFUND', gatewayIdFor(reference), 200, gatewayObject(reference, 'REFUNDED', null, amount));
}

function gatewayNotice<R>(flow: NoticeSender<R>, reference: string, secret: string): Promise<R> {
  const id = gatewayIdFor(reference);
  const requestId = randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const manifest = \`id:\${id.toLowerCase()};request-id:\${requestId};ts:\${ts};\`;
  const body = JSON.stringify({ action: 'order.updated', type: 'order', data: { id } });
  return flow.post(\`${PAYMENT_NOTICE_PATH}?${translation.notice.dataIdQuery}=\${id}&type=order\`, body, {
    ${tsString(probes.notice.signatureHeader)}: \`ts=\${ts},v1=\${gatewayHmac(secret, manifest)}\`,
    ${tsString(translation.notice.requestIdHeader)}: requestId
  });
}
`;
}
