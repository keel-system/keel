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

import { DEFAULT_SAVED_CARD, paymentProbesFor, saveAuthenticationRejection, savedCardResponse } from '@keel-system/keel-core/gen/payment-probes';
import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, gatewayTranslation, refundTranslation, tracksRefundInFlight } from '@keel-system/keel-core/gen/payment-gateways';
import { tsString } from './render.js';
import { paymentTestCurrency } from '@keel-system/keel-core/gen/payments-config';

export const PAYMENT_HARNESS_TS = 'test/integration/support/payment-gateway.ts';

export function usesPaymentHarness(model) {
  return Boolean(model.payments);
}

/**
 * Los nombres que flow.ts reexporta. Con `refund.reference` (cada devolución por separado) la devolución se programa con
 * `gatewayReportsRefund` y no con el total devuelto (corrida payment-spring).
 */
export function paymentHarnessExports(model) {
  const tracks = tracksRefundInFlight(model.payments);
  return PAYMENT_HARNESS_EXPORTS.map((name) => (tracks && name === 'gatewayReportsRefunded' ? 'gatewayReportsRefund' : name));
}

const PAYMENT_HARNESS_EXPORTS = [
  'GatewayCall',
  'gatewayIdFor',
  'gatewayAuthorizes',
  'gatewayCharges',
  'gatewayRequiresAction',
  'gatewayDeclines',
  'gatewayDoesNotAnswer',
  'gatewayReports',
  'gatewayReportsRefunded',
  'gatewayCancelFails',
  'gatewayAnswersLate',
  'gatewayCaptures',
  'gatewayCancels',
  'gatewayExpiresAuthorization',
  'gatewayRejects',
  'gatewaySavesPaymentMethod',
  'gatewaySavesCard',
  'gatewayRequiresAuthenticationToSave',
  'gatewayRefunds',
  'gatewayCallCount',
  'gatewayRequests',
  'sendGatewayNotice',
  'sendForgedGatewayNotice'
];

export function generate(model) {
  return usesPaymentHarness(model) ? [{ path: PAYMENT_HARNESS_TS, content: paymentGatewayTs(model) }] : [];
}

/** La moneda con la que corren los escenarios (keel-core/gen/payments-config.js: la misma en los tres generadores). */
export const testCurrency = paymentTestCurrency;

function paymentGatewayTs(model) {
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  const currency = testCurrency(model);
  // La respuesta de guardar con el resumen en las rutas que lee el adaptador (keel-core: savedCardResponse): la MISMA
  // que escribe el AbstractFlowIT de keel-spring.
  const cardTemplate = JSON.stringify(savedCardResponse(gateway.id, { brand: '@B@', last4: '@L@', expMonth: -71, expYear: -72 }))
    .replace('"@B@"', 'brand').replace('"@L@"', 'last4').replace('-71', 'expMonth').replace('-72', 'expYear');
  const authentication = saveAuthenticationRejection(gateway.id);
  const card = DEFAULT_SAVED_CARD;
  const routes = Object.entries(probes.calls)
    .map(([call, route]) => `  ${call}: { method: ${tsString(route.method)}, path: ${tsString(route.path)} }`)
    .join(',\n');
  const tracks = tracksRefundInFlight(model.payments);
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes, tracks) : mercadopagoSpecific(probes, tracks);
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
  if (status === 'REFUNDED') {
${tracks
  ? `    // Con varias devoluciones por cobro, la consulta del cobro no dice nada de una devolución: la contesta la de la
    // devolución en vuelo.
    throw new Error('gatewayReports: una devolución se programa con gatewayReportsRefund(referencia, referencia de la devolución, desenlace, importe, lo devuelto antes)');`
  : `    await gatewayReportsRefunded(reference, '10.00');
    return;`}
  }
  await gatewayReportsObject(reference, gatewayObject(reference, status, null, null));
}
${tracks
  ? `
/**
 * Lo que la pasarela dice de UNA devolución del cobro de esa referencia, la de \`refundReference\`, cuando el servidor le
 * pregunta por ella (una devolución cuya respuesta no llegó y el barrido resuelve consultando): 'REFUNDED' (se completó
 * por \`amount\`), 'PENDING' (la sigue procesando), 'FAILED' (la rechazó) o 'MISSING' (no le llegó nunca; \`amount\` no
 * se usa). \`previouslyRefunded\` es lo que la pasarela ya había devuelto del cobro en devoluciones ANTERIORES, ya
 * registradas ('0' si es la primera): es lo que distingue el importe de ESTA devolución del acumulado.
 */
export async function gatewayReportsRefund(reference: string, refundReference: string, outcome: string, amount: string, previouslyRefunded: string): Promise<void> {
  if (!['REFUNDED', 'PENDING', 'FAILED', 'MISSING'].includes(outcome)) {
    throw new Error(\`gatewayReportsRefund: \${outcome} no es REFUNDED, PENDING, FAILED ni MISSING\`);
  }
  await gatewayRefundsAtGateway(reference, refundReference, outcome, amount, previouslyRefunded);
}
`
  : `
/**
 * Preguntada por el cobro de esa referencia, la pasarela lo da por devuelto con ESE total: lo que mide un escenario
 * de devolución parcial, o una devolución cuya respuesta no llegó y el barrido resuelve consultando.
 */
export async function gatewayReportsRefunded(reference: string, refundedTotal: string): Promise<void> {
  await gatewayReportsObject(reference, gatewayObject(reference, 'REFUNDED', null, refundedTotal));
}
`}
async function gatewayReportsObject(reference: string, object: Record<string, unknown>): Promise<void> {
  await gatewayStubPath('STATUS', gatewayIdFor(reference), 200, object);
  await gatewayStub('SEARCH', reference, null, 200, { data: [object] });
}

/**
 * La anulación del cobro de esa referencia vuelve como un cobro FALLIDO con un motivo del vocabulario neutro (la del
 * 3DS que el cliente no completó es 'authenticationFailed'): el desenlace no es la anulación sino el fallo.
 */
export async function gatewayCancelFails(reference: string, reason: string): Promise<void> {
  await gatewayStubPath('CANCEL', gatewayIdFor(reference), 200, gatewayObject(reference, 'FAILED', GATEWAY_DECLINES[reason] ?? null, null));
}

/**
 * La pasarela RETIENE su respuesta a esa llamada \`delayMs\` milisegundos y después contesta con el cobro en ese estado:
 * lo que hace escribible un escenario en el que el aviso llega ANTES que la respuesta (envía el aviso mientras tanto,
 * sin esperar a la petición). Vale para CHARGE, CAPTURE y CANCEL. El retardo tiene que quedar por debajo del
 * read-timeout del cliente de la pasarela (payments.gateway.read-timeout), o la acción quedará en duda.
 */
export async function gatewayAnswersLate(call: GatewayCall, reference: string, status: string, delayMs: number): Promise<void> {
  const object = gatewayObject(reference, status, null, null);
  if (call === 'CHARGE') return gatewayStub('CHARGE', null, reference, 200, object, delayMs);
  if (call === 'CAPTURE' || call === 'CANCEL') return gatewayStubPath(call, gatewayIdFor(reference), 200, object, delayMs);
  throw new Error(\`gatewayAnswersLate: \${call} no devuelve el cobro; usa CHARGE, CAPTURE o CANCEL\`);
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

/**
 * La pasarela rechaza esa llamada (4xx): la acción no se hizo. Tras rechazar una captura, una anulación o una
 * devolución, el servidor le PREGUNTA a la pasarela el estado real del cobro (el rechazo no lo dice): programa también
 * \`gatewayReports(referencia, 'AUTHORIZED')\` —o 'CAPTURED' para una devolución—. Sin él la consulta no lo encuentra
 * (NOT_FOUND), y un rechazo no se distingue de un cobro que la pasarela no conoce.
 */
export async function gatewayRejects(call: GatewayCall): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await stubFor(route.method, route.path, 400, { error: { code: 'rejected_by_test' } });
}

/** La pasarela guarda el medio de pago que se le pase, con una tarjeta ${card.brand} terminada en ${card.last4} (${card.expMonth}/${card.expYear}). */
export async function gatewaySavesPaymentMethod(): Promise<void> {
  await gatewaySavesCard(${tsString(card.brand)}, ${tsString(card.last4)}, ${card.expMonth}, ${card.expYear});
}

/**
 * La pasarela guarda el medio con ESTE resumen de tarjeta: lo que un escenario afirma en la respuesta o en la ficha
 * del medio guardado (savePaymentMethod.cardDetails).
 */
export async function gatewaySavesCard(brand: string, last4: string, expMonth: number, expYear: number): Promise<void> {
  const save = GATEWAY_ROUTES.SAVE_METHOD;
  const attach = GATEWAY_ROUTES.ATTACH_METHOD;
  await stubFor(save.method, save.path, 200, { id: 'cus_keel_test' });
  await stubFor(attach.method, attach.path, 200, ${cardTemplate});
}

/**
 * La pasarela exige autenticar al cliente (3DS) para guardar la tarjeta.${authentication ? '' : ` ${gateway.name ?? gateway.id} no lo pide al
 * guardar (la autenticación es del cobro), así que un escenario que lo use no se puede ejecutar con ella.`}
 */
export async function gatewayRequiresAuthenticationToSave(): Promise<void> {
${authentication
  ? `  const save = GATEWAY_ROUTES.SAVE_METHOD;
  const attach = GATEWAY_ROUTES.ATTACH_METHOD;
  await stubFor(save.method, save.path, 200, { id: 'cus_keel_test' });
  await stubFor(attach.method, attach.path, ${authentication.status}, ${JSON.stringify(authentication.body)});`
  : `  throw new Error(${tsString(`${gateway.id} no pide autenticar al guardar un medio: este escenario no aplica con ella`)});`}
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
async function gatewayStub(call: GatewayCall, queryContains: string | null, bodyContains: string | null, status: number, body: unknown, delayMs = 0): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await gatewayMapping(route.method, route.path, queryContains, bodyContains, status, body, delayMs);
}

// Igual, sobre la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).
async function gatewayStubPath(call: GatewayCall, gatewayId: string, status: number, body: unknown, delayMs = 0): Promise<void> {
  const route = GATEWAY_ROUTES[call];
  await gatewayMapping(route.method, route.path.replace('(?!search)[^/]+', gatewayId).replace('[^/]+', gatewayId), null, null, status, body, delayMs);
}

// Con delayMs > 0, la respuesta llega tarde (fixedDelayMilliseconds de WireMock).
async function gatewayMapping(method: string, pathPattern: string, queryContains: string | null, bodyContains: string | null, status: number, body: unknown, delayMs = 0): Promise<void> {
  const request: Record<string, unknown> = { method, urlPathPattern: pathPattern };
  if (queryContains != null) request.queryParameters = { ${tsString(probes.calls.SEARCH.query)}: { contains: queryContains } };
  if (bodyContains != null) request.bodyPatterns = [{ contains: bodyContains }];
  const response: Record<string, unknown> = { status, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
  if (delayMs > 0) response.fixedDelayMilliseconds = delayMs;
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

function stripeSpecific(probes, tracks) {
  const translation = gatewayTranslation('stripe');
  const refund = refundTranslation('stripe');
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

${tracks
  ? `// Las devoluciones del cobro tal como las lista Stripe (GET /v1/refunds?payment_intent=…), con la referencia de cada
// una en su metadata: es lo que lee el refundStatus del adaptador.
async function gatewayRefundsAtGateway(reference: string, refundReference: string, outcome: string, amount: string, previouslyRefunded: string): Promise<void> {
  const id = gatewayIdFor(reference);
  const refunds: Record<string, unknown>[] = [];
  if (minorUnits(previouslyRefunded) > 0) refunds.push(stripeRefund(\`\${id}_previous\`, 'keel-previous-refund', ${tsString(refund.succeeded[0])}, previouslyRefunded));
  if (outcome !== 'MISSING') {
    const status = outcome === 'REFUNDED' ? ${tsString(refund.succeeded[0])} : outcome === 'PENDING' ? ${tsString(refund.pending[0])} : 'failed';
    refunds.push(stripeRefund(\`\${id}_\${refundReference.replace(/[^A-Za-z0-9]/g, '')}\`, refundReference, status, amount));
  }
  await stubRawMapping(
    { method: 'GET', urlPath: '/v1/refunds', queryParameters: { payment_intent: { equalTo: id } } },
    { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'list', has_more: false, data: refunds }) }
  );
}

function stripeRefund(id: string, refundReference: string, status: string, amount: string): Record<string, unknown> {
  return { id: \`re_\${id}\`, object: 'refund', status, amount: minorUnits(amount), currency: GATEWAY_CURRENCY.toLowerCase(), metadata: { ${tsString(refund.referenceKey)}: refundReference } };
}

`
  : ''}function gatewayNotice<R>(flow: NoticeSender<R>, reference: string, secret: string): Promise<R> {
  const id = gatewayIdFor(reference);
  const body = JSON.stringify({ id: \`evt_\${id}\`, type: 'payment_intent.updated', data: { object: { id, object: 'payment_intent' } } });
  const t = Math.floor(Date.now() / 1000);
  return flow.post(${tsString(PAYMENT_NOTICE_PATH)}, body, { ${tsString(probes.notice.signatureHeader)}: \`t=\${t},v1=\${gatewayHmac(secret, \`\${t}.\${body}\`)}\` });
}


`;
}

function mercadopagoSpecific(probes, tracks) {
  const translation = gatewayTranslation('mercadopago');
  const refund = refundTranslation('mercadopago');
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
  if (refunded != null) transactions.refunds = [mercadopagoRefund(\`\${id}-new\`, ${tsString(refund.succeeded[0])}, refunded)];
  return { id, status: state, status_detail: statusDetail, ${tsString(translation.referenceKey)}: reference, currency: GATEWAY_CURRENCY, transactions };
}

// Una devolución de la order con la forma que leen el adaptador y su refundStatus: id, importe y estado.
function mercadopagoRefund(id: string, status: string, amount: string): Record<string, unknown> {
  return { id: \`REF\${id}\`, status, amount: majorUnits(amount) };
}
${tracks
  ? `
// La order con sus devoluciones: MercadoPago no guarda referencia propia en una devolución, así que refundStatus la
// localiza por lo procesado por encima de lo que el registro ya cuenta como devuelto.
async function gatewayRefundsAtGateway(reference: string, refundReference: string, outcome: string, amount: string, previouslyRefunded: string): Promise<void> {
  const id = gatewayIdFor(reference);
  const refunds: Record<string, unknown>[] = [];
  if (Number(previouslyRefunded) > 0) refunds.push(mercadopagoRefund(\`\${id}-previous\`, ${tsString(refund.succeeded[0])}, previouslyRefunded));
  if (outcome !== 'MISSING') {
    const status = outcome === 'REFUNDED' ? ${tsString(refund.succeeded[0])} : outcome === 'PENDING' ? ${tsString(refund.pending[0])} : 'failed';
    refunds.push(mercadopagoRefund(\`\${id}-\${refundReference.replace(/[^A-Za-z0-9]/g, '')}\`, status, amount));
  }
  const order = gatewayObject(reference, 'CAPTURED', null, null);
  (order['transactions'] as Record<string, unknown>)['refunds'] = refunds;
  await gatewayReportsObject(reference, order);
}
`
  : ''}
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
