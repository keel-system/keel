// El adaptador de MercadoPago (API de Orders) y su verificador de avisos, para keel-nest.
//
// Es la traducción del de keel-spring, caso por caso, sobre el MISMO contrato (keel-core/gen/payment-gateways.js):
//   * Orders y no la API clásica de pagos: es la única con cobro sin el cliente delante;
//   * JSON; credencial Bearer (access token); X-Idempotency-Key en las escrituras;
//   * importe decimal en la unidad mayor ("12.50"), con la escala de la tabla de keel-core;
//   * x-signature: ts=…,v1=…: HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. La
//     firma NO cubre el cuerpo: el aviso solo dice de qué order habla, y el estado se consulta.
//
// Lo marcado VERIFICAR EN SANDBOX es lo que la matriz declara `unverified`: build lo genera con la lectura más
// probable, avisando.

import { gatewayTranslation, paymentIdempotencyKey, refundTranslation, savedMethodIdempotencyKey, SAVED_METHOD_SEPARATOR, tracksRefundInFlight } from '@keel-system/keel-core/gen/payment-gateways';
import { DIRS, classPath, tsModule, tsString } from '../render.js';
import { savedMethodTsHelpers } from '../payments.js';

// La clave de la devolución (corrida payment-go): con `refund.reference`, una por devolución
// (`<cobro>:refund:<devolución>`, refundIdempotencyKey de keel-core); sin ella, la del cobro.
const refundKeyCall = (p) => (p.refund.reference ? "idempotencyKey(reference, 'refund:' + refundReference)" : "idempotencyKey(reference, 'refund')");
const refundReferenceParam = (p) => (p.refund.reference ? 'refundReference: string, ' : '');
// MercadoPago no guarda referencia propia en una devolución: se localiza por diferencia (keel-core: REFUND_TRANSLATIONS).
const REFUND = refundTranslation('mercadopago');
const tsSet = (values) => `new Set([${values.map((value) => tsString(value)).join(', ')}])`;


const TRANSLATION = gatewayTranslation('mercadopago');
const DIR = 'infrastructure/payment/mercadopago';
const ADAPTER_TS = classPath(DIR, 'MercadopagoPaymentGateway');
const VERIFIER_TS = classPath(DIR, 'MercadopagoNoticeVerifier');

export function classes() {
  return {
    adapter: { symbol: 'MercadopagoPaymentGateway', from: ADAPTER_TS },
    verifier: { symbol: 'MercadopagoNoticeVerifier', from: VERIFIER_TS }
  };
}

const NEUTRAL = {
  status: 'src/domain/payment/gateway-status.ts',
  outcome: 'src/domain/payment/gateway-outcome.ts',
  request: 'src/domain/payment/charge-request.ts',
  unavailable: 'src/domain/payment/payment-gateway-unavailable-exception.ts',
  port: `src/${DIRS.portOut}/payment-gateway.ts`,
  money: 'src/infrastructure/payment/money-amounts.ts',
  http: 'src/infrastructure/payment/payment-gateway-http.ts',
  settings: 'src/infrastructure/payment/payment-gateway-settings.ts',
  verifier: 'src/infrastructure/payment/payment-notice-verifier.ts',
  invalid: 'src/infrastructure/payment/invalid-payment-notice-exception.ts',
  decimal: 'src/domain/support/decimal.ts'
};

export function generate(model) {
  return [
    { path: ADAPTER_TS, content: adapterTs(model) },
    { path: VERIFIER_TS, content: verifierTs(model) }
  ];
}

function adapterTs(model) {
  const p = model.payments;
  // Se arma aquí y no al cargar: payments.js importa este módulo, y sus constantes aún no existen entonces.
  const SAVED = savedMethodTsHelpers(TRANSLATION, 'MercadoPago');
  const F = p.record.failureReasonType;
  const constant = (literal) => p.failureReasons.find((entry) => entry.literal === literal).constant;
  const details = TRANSLATION.declines.map(([code, literal]) => `  [${tsString(code)}, ${F}.${constant(literal)}]`).join(',\n');
  const header = p.gateway.idempotencyHeader;
  const ref = TRANSLATION.referenceKey;
  const methods = [];

  methods.push(`  async authorize(request: ChargeRequest): Promise<GatewayOutcome> {
    const amount = MoneyAmounts.toMajorUnits(request.amount, request.currency);
    const paymentMethod: Json = { type: 'credit_card', installments: 1 };
    const payment: Json = { amount, payment_method: paymentMethod };
    const order: Json = {
      type: 'online',
      processing_mode: 'automatic',
      capture_mode: ${tsString(p.captureLater ? 'manual' : 'automatic')},
      ${tsString(ref)}: request.reference,
      total_amount: amount,
      transactions: { payments: [payment] }
    };
    if (request.source.kind === 'SAVED') {
      // VERIFICAR EN SANDBOX (off-session sin verificar). La referencia guardada es "customer_id${SAVED_METHOD_SEPARATOR}card_id"
      // (savePaymentMethod); los pagos automáticos de Orders cobran con el perfil guardado y la credencial
      // almacenada, sin CVV ni token nuevo.
      const [customerId, cardId] = splitSaved(request.source.value);
      order['payer'] = { customer_id: customerId };
      paymentMethod['id'] = cardId;
      payment['stored_credential'] = { payment_initiator: 'merchant', reason: 'unscheduled', first_payment: false };
    } else {
      paymentMethod['token'] = request.source.value;
    }
    const answer = await this.send('authorize', { method: 'POST', path: '/v1/orders', body: jsonBody(order), idempotency: this.key(idempotencyKey(request.reference, 'authorize')) });
    if (answer.status >= 500) throw unavailable('authorize', answer);
    // Un 4xx al crear la order: el token o el medio no sirven.
    if (answer.status >= 400) return GatewayOutcome.failed(request.reference, null, reasonOf(json(answer.text)));
    return this.outcomeOf(json(answer.text), request.reference);
  }`);

  if (p.capture) {
    const amountParam = p.capture.amount ? ', _amount: Decimal | null, _currency: string | null' : '';
    methods.push(`  async capture(reference: string, gatewayPaymentId: string${amountParam}): Promise<GatewayOutcome> {
    return this.followUp(\`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}/capture\`, {}, reference, gatewayPaymentId, 'capture');
  }`);
  }
  if (p.void) {
    methods.push(`  async voidAuthorization(reference: string, gatewayPaymentId: string): Promise<GatewayOutcome> {
    return this.followUp(\`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}/cancel\`, {}, reference, gatewayPaymentId, 'void');
  }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', amount: Decimal | null, currency: string | null' : '';
    const partial = p.refund.amount
      ? `
    if (amount != null) {
      // La devolución parcial nombra la transacción de pago de la order: hay que leerla, y esa lectura falla igual
      // que la devolución —dentro del mismo tratamiento, o un 5xx aquí sale como un 500 con el cobro atascado en
      // refunding—.
      const current = await this.send('refund', { method: 'GET', path: \`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}\` });
      if (current.status >= 400) throw unavailable('refund', current);
      const transaction = firstPayment(json(current.text));
      body['transactions'] = [{ id: text(transaction['id']) ?? '', amount: MoneyAmounts.toMajorUnits(amount, requiredCurrency(currency)) }];
    }`
      : '';
    if (tracksRefundInFlight(p)) {
      methods.push(`  async refund(reference: string, refundReference: string, gatewayPaymentId: string${amountParam}): Promise<GatewayOutcome> {
    const body: Json = {};
    // La lectura previa de la order se hace SIEMPRE: nombra la transacción de una parcial y deja las devoluciones que ya
    // tenía, y la nueva es la que no estaba. Falla igual que la devolución: dentro del mismo tratamiento, o un 5xx aquí
    // sale como un 500 con el cobro atascado en refunding.
    const current = await this.send('refund', { method: 'GET', path: \`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}\` });
    if (current.status >= 400) throw unavailable('refund', current);
    const before = json(current.text);${p.refund.amount ? `
    if (amount != null) {
      const transaction = firstPayment(before);
      body['transactions'] = [{ id: text(transaction['id']) ?? '', amount: MoneyAmounts.toMajorUnits(amount, requiredCurrency(currency)) }];
    }` : ''}
    const known = new Set(refundsOf(before).map((refund) => text(refund['id']) ?? ''));
    const answer = await this.send('refund', { method: 'POST', path: \`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}/refund\`, body: jsonBody(body), idempotency: this.key(${refundKeyCall(p)}) });
    if (answer.status >= 500) throw unavailable('refund', answer);
    // Rechazada: se pregunta el estado real, que con devoluciones es el cobro capturado.
    if (answer.status >= 400) return this.status(reference, gatewayPaymentId);
    return refundResponse(json(answer.text), known, reference, gatewayPaymentId);
  }`);
      methods.push(`  /**
   * La devolución en vuelo, por diferencia: MercadoPago no guarda referencia propia en una devolución, así que es lo
   * procesado por encima de lo que el registro ya cuenta como devuelto (el diseño admite una sola devolución en curso por
   * cobro). La suma de transactions.refunds es el acumulado, no el desenlace de ESTA devolución.
   */
  async refundStatus(reference: string, _refundReference: string, gatewayPaymentId: string, alreadyRefunded: Decimal): Promise<GatewayOutcome> {
    const answer = await this.send('refundStatus', { method: 'GET', path: \`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}\` });
    if (answer.status >= 400) throw unavailable('refundStatus', answer);
    let processed = Decimal.of(0);
    for (const refund of refundsOf(json(answer.text))) {
      const status = text(refund['status']) ?? '';
      if (REFUND_PENDING.has(status)) return GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
      if (REFUND_SUCCEEDED.has(status)) processed = processed.plus(Decimal.parse(text(refund['amount']) ?? '0'));
    }
    const refunded = processed.minus(alreadyRefunded);
    // Nada por encima de lo registrado: la devolución no llegó a la pasarela o la rechazó.
    return refunded.isZero() || refunded.isNegative()
      ? GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId)
      : GatewayOutcome.refunded(reference, gatewayPaymentId, refunded);
  }`);
    } else {
      methods.push(`  async refund(reference: string, ${refundReferenceParam(p)}gatewayPaymentId: string${amountParam}): Promise<GatewayOutcome> {
    const body: Json = {};${partial}
    return this.followUp(\`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}/refund\`, body, reference, gatewayPaymentId, 'refund', ${refundKeyCall(p)});
  }`);
    }
  }

  methods.push(`  async status(reference: string | null, gatewayPaymentId: string | null): Promise<GatewayOutcome> {
    let answer: GatewayAnswer;
    if (gatewayPaymentId != null) {
      answer = await this.send('status', { method: 'GET', path: \`/v1/orders/\${encodeURIComponent(gatewayPaymentId)}\` });
    } else {
      // Sin id: la pasarela no llegó a contestar. Se busca por ${ref}.
      // VERIFICAR EN SANDBOX: la búsqueda de orders por referencia externa.
      const query = new URLSearchParams();
      query.append(${tsString(ref)}, reference ?? '');
      answer = await this.send('status', { method: 'GET', path: \`/v1/orders/search?\${query.toString()}\` });
    }
    if (answer.status === 404) return GatewayOutcome.notFound(reference);
    if (answer.status >= 400) throw unavailable('status', answer);
    const body = json(answer.text);
    if (gatewayPaymentId != null) return this.outcomeOf(body, reference);
    const first = Array.isArray(body['data']) ? (body['data'] as unknown[])[0] : undefined;
    return isObject(first) ? this.outcomeOf(first, reference) : GatewayOutcome.notFound(reference);
  }`);

  if (p.savePaymentMethod) {
    const [customerStep, cardStep] = TRANSLATION.savedMethodSteps;
    methods.push(`  async savePaymentMethod(token: string, payerReference: string): Promise<SavedPaymentMethod> {
    const customer = await this.send('savePaymentMethod', {
      method: 'POST',
      path: '/v1/customers',
      body: jsonBody({ description: payerReference }),
      idempotency: this.key(savedKey(token, ${tsString(customerStep)}))
    });
    rejectedMethod(customer);
    const customerId = text(json(customer.text)['id']) ?? '';
    const card = await this.send('savePaymentMethod', {
      method: 'POST',
      path: \`/v1/customers/\${encodeURIComponent(customerId)}/cards\`,
      body: jsonBody({ token }),
      idempotency: this.key(savedKey(token, ${tsString(cardStep)}))
    });
    rejectedMethod(card);
    const saved = json(card.text);
    return { reference: \`\${customerId}${SAVED_METHOD_SEPARATOR}\${text(saved['id']) ?? ''}\`, card: savedCardOf(saved) };
  }`);
  }

  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: F, from: classPath(DIRS.enums, F) },
    { symbol: 'Decimal', from: NEUTRAL.decimal },
    { symbol: 'ChargeRequest', from: NEUTRAL.request, type: true },
    { symbol: 'GatewayOutcome', from: NEUTRAL.outcome },
    { symbol: 'GatewayStatus', from: NEUTRAL.status },
    { symbol: 'PaymentGatewayUnavailableException', from: NEUTRAL.unavailable },
    ...(p.savePaymentMethod ? SAVED.imports : []),
    { symbol: 'PaymentGateway', from: NEUTRAL.port },
    { symbol: 'MoneyAmounts', from: NEUTRAL.money },
    { symbol: 'GatewayNoAnswer', from: NEUTRAL.http },
    { symbol: 'PaymentGatewayHttp', from: NEUTRAL.http },
    { symbol: 'GatewayAnswer', from: NEUTRAL.http, type: true },
    { symbol: 'GatewayRequest', from: NEUTRAL.http, type: true }
  ];

  const body = `type Json = Record<string, unknown>;

// status_detail de un pago → motivo neutro (keel-core/gen/payment-gateways.js); lo que no está es DECLINED.
const DETAILS = new Map<string, ${F}>([
${details}
]);

/** La clave de una acción sobre un cobro: la misma en cada reintento, por las dos puertas y por los dos servidores. */
export function idempotencyKey(reference: string, action: string): string {
  return \`${paymentIdempotencyKey('${reference}', '${action}')}\`;
}

function savedKey(token: string, step: string): string {
  return \`${savedMethodIdempotencyKey('${token}', '${step}')}\`;
}

/**
 * La pasarela de pago sobre MercadoPago (API de Orders), por HTTP plano.
 *
 * Lo que lleva dentro y no puede faltar:
 *   · la clave de idempotencia sale de la referencia de negocio y la acción (\`<referencia>:authorize\`…), nunca
 *     de un aleatorio;
 *   · un 5xx o un timeout NO se reintenta: lanza PaymentGatewayUnavailableException y la acción queda en duda
 *     para el barrido;
 *   · el importe viaja en unidades mayores con la escala exacta de la moneda, sin redondear;
 *   · los rechazos se traducen al vocabulario neutro de ${F}.
 */
@Injectable()
export class MercadopagoPaymentGateway extends PaymentGateway {
  constructor(@Inject(PaymentGatewayHttp) private readonly http: PaymentGatewayHttp) {
    super();
  }

${methods.join('\n\n')}

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private key(value: string): GatewayRequest['idempotency'] {
    return { header: ${tsString(header)}, key: value };
  }

  private async send(action: string, request: GatewayRequest): Promise<GatewayAnswer> {
    try {
      return await this.http.send(request);
    } catch (error) {
      if (error instanceof GatewayNoAnswer) throw new PaymentGatewayUnavailableException(\`MercadoPago no contestó a \${action}: la acción queda en duda\`, { cause: error });
      throw error;
    }
  }

  /** Captura, anulación y devolución: si MercadoPago la rechaza, se devuelve el estado real de la order. */
  private async followUp(path: string, body: Json, reference: string, gatewayPaymentId: string, action: string, key: string = idempotencyKey(reference, action)): Promise<GatewayOutcome> {
    const answer = await this.send(action, { method: 'POST', path, body: jsonBody(body), idempotency: this.key(key) });
    if (answer.status >= 500) throw unavailable(action, answer);
    if (answer.status >= 400) return this.status(reference, gatewayPaymentId);
    return this.outcomeOf(json(answer.text), reference);
  }

  // ─── Traducción ────────────────────────────────────────────────────────────

  private outcomeOf(order: Json, reference: string | null): GatewayOutcome {
    const id = text(order['id']);
    const ref = text(order[${tsString(ref)}]) ?? reference;
    const payment = firstPayment(order);
    const detail = text(order['status_detail']) ?? text(payment['status_detail']) ?? '';
    const status = text(order['status']) ?? '';
${tracksRefundInFlight(p)
  ? `    if (status === 'refunded' || detail === 'refunded' || detail === 'partially_refunded') {
      // Una order con devoluciones sigue cobrada: la suma de transactions.refunds es el acumulado, no el desenlace de una
      // devolución. La devolución en vuelo la contesta refundStatus.
      return GatewayOutcome.of(GatewayStatus.CAPTURED, ref, id);
    }
`
  : `    if (status === 'refunded' || detail === 'refunded' || detail === 'partially_refunded') {
      let refunded = Decimal.of(0);
      const transactions = isObject(order['transactions']) ? order['transactions'] : {};
      for (const refund of Array.isArray(transactions['refunds']) ? transactions['refunds'] : []) {
        refunded = refunded.plus(Decimal.parse((isObject(refund) ? text(refund['amount']) : null) ?? '0'));
      }
      return GatewayOutcome.refunded(ref, id, refunded);
    }
`}    switch (status) {
      case 'action_required':
        return GatewayOutcome.actionRequired(ref, id, customerAction(payment));
      case 'processed':
        return detail === 'waiting_capture' ? GatewayOutcome.of(GatewayStatus.AUTHORIZED, ref, id) : GatewayOutcome.of(GatewayStatus.CAPTURED, ref, id);
      case 'failed':
        return GatewayOutcome.failed(ref, id, reasonOf(payment));
      case 'canceled':
      case 'expired':
        return GatewayOutcome.of(GatewayStatus.CANCELED, ref, id);
      default:
        return GatewayOutcome.of(GatewayStatus.PENDING, ref, id);
    }
  }
}

${tracksRefundInFlight(p) ? `// Los estados de una devolución de la order (keel-core: REFUND_TRANSLATIONS); cualquier otro es una rechazada.
const REFUND_SUCCEEDED = ${tsSet(REFUND.succeeded)};
const REFUND_PENDING = ${tsSet(REFUND.pending)};

/** Las devoluciones de la order, tal como las lista. */
function refundsOf(order: Json): Json[] {
  const transactions = isObject(order['transactions']) ? order['transactions'] : {};
  return (Array.isArray(transactions['refunds']) ? transactions['refunds'] : []).filter(isObject);
}

/**
 * La respuesta a pedir una devolución es la order entera, con TODAS sus devoluciones: la nueva es la que no estaba en la
 * lectura previa. Sin ninguna nueva, la respuesta no dice nada de ésta y queda en vuelo para el barrido.
 */
function refundResponse(order: Json, known: Set<string>, reference: string, gatewayPaymentId: string): GatewayOutcome {
  let refunded = Decimal.of(0);
  let fresh = false;
  for (const refund of refundsOf(order)) {
    if (known.has(text(refund['id']) ?? '')) continue;
    fresh = true;
    const status = text(refund['status']) ?? '';
    if (REFUND_PENDING.has(status)) return GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
    if (REFUND_SUCCEEDED.has(status)) refunded = refunded.plus(Decimal.parse(text(refund['amount']) ?? '0'));
  }
  if (!fresh) return GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
  return refunded.isZero() ? GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId) : GatewayOutcome.refunded(reference, gatewayPaymentId, refunded);
}

` : ''}/** VERIFICAR EN SANDBOX (customer-action sin verificar): la acción va opaca. Sin medio de pago, no hay acción que dar. */
function customerAction(payment: Json): string | null {
  return payment['payment_method'] === undefined ? null : JSON.stringify(payment['payment_method']);
}

function reasonOf(node: Json): ${F} {
  const cause = Array.isArray(node['cause']) && isObject(node['cause'][0]) ? (node['cause'][0] as Json) : {};
  const detail = text(node['status_detail']) ?? text(cause['code']) ?? '';
  return DETAILS.get(detail) ?? ${F}.${constant('declined')};
}

function firstPayment(order: Json): Json {
  const transactions = isObject(order['transactions']) ? order['transactions'] : {};
  const payments = Array.isArray(transactions['payments']) ? transactions['payments'] : [];
  return isObject(payments[0]) ? payments[0] : {};
}

function jsonBody(body: Json): GatewayRequest['body'] {
  return { contentType: 'application/json', text: JSON.stringify(body) };
}

function json(body: string): Json {
  try {
    const parsed: unknown = JSON.parse(body == null || body.trim() === '' ? '{}' : body);
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error('MercadoPago devolvió un cuerpo que no es JSON', { cause: error });
  }
}

function isObject(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (value == null || typeof value === 'object') return null;
  return String(value);
}

function splitSaved(value: string): [string, string] {
  const at = value.indexOf(${tsString(SAVED_METHOD_SEPARATOR)});
  if (at < 0) throw new Error('Un medio guardado es "<cliente>${SAVED_METHOD_SEPARATOR}<tarjeta>": esta referencia no lo es');
  return [value.slice(0, at), value.slice(at + 1)];
}

function requiredCurrency(currency: string | null): string {
  if (currency == null) throw new Error('Un importe parcial necesita la moneda del cobro');
  return currency;
}

function unavailable(action: string, answer: GatewayAnswer): PaymentGatewayUnavailableException {
  return new PaymentGatewayUnavailableException(\`MercadoPago no contestó a \${action} (HTTP \${answer.status}): la acción queda en duda\`);
}${p.savePaymentMethod ? SAVED.helpers : ''}`;
  return tsModule(ADAPTER_TS, imports, body);
}

function verifierTs(model) {
  const notice = TRANSLATION.notice;
  return tsModule(
    VERIFIER_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'createHmac', from: 'node:crypto' },
      { symbol: 'timingSafeEqual', from: 'node:crypto' },
      { symbol: 'PAYMENT_GATEWAY_SETTINGS', from: NEUTRAL.settings },
      { symbol: 'PaymentGatewaySettings', from: NEUTRAL.settings, type: true },
      { symbol: 'InvalidPaymentNoticeException', from: NEUTRAL.invalid },
      { symbol: 'PaymentNotice', from: NEUTRAL.verifier, type: true },
      { symbol: 'PaymentNoticeVerifier', from: NEUTRAL.verifier }
    ],
    `/**
 * Verifica la cabecera ${model.payments.gateway.webhook.signatureHeader} de MercadoPago: \`${notice.timestampField}=<timestamp>,${notice.signatureField}=<firma>\`.
 *
 * La firma es HMAC-SHA256 del manifiesto \`id:<data.id>;request-id:<${notice.requestIdHeader}>;ts:<ts>;\`, con \`data.id\` sacado
 * de la URL y en minúsculas; lo que falte se quita del manifiesto. Se compara en tiempo constante y un \`ts\` fuera
 * de la tolerancia se rechaza. LA FIRMA NO CUBRE EL CUERPO: por eso de aquí solo sale el id de la order, y su
 * estado se le pregunta a la pasarela.
 */
@Injectable()
export class MercadopagoNoticeVerifier extends PaymentNoticeVerifier {
  /** El reloj, en milisegundos. Una prueba lo sustituye para medir la ventana. */
  clock: () => number = () => Date.now();

  constructor(@Inject(PAYMENT_GATEWAY_SETTINGS) private readonly settings: PaymentGatewaySettings) {
    super();
  }

  verify(notice: PaymentNotice): string | null {
    const header = notice.header(${tsString(model.payments.gateway.webhook.signatureHeader)});
    if (header == null || header.trim() === '') throw new InvalidPaymentNoticeException('sin cabecera de firma');
    let ts: string | null = null;
    let signature: string | null = null;
    for (const part of header.split(',')) {
      const trimmed = part.trim();
      const equals = trimmed.indexOf('=');
      if (equals < 0) continue;
      const [name, value] = [trimmed.slice(0, equals), trimmed.slice(equals + 1)];
      if (name === ${tsString(notice.timestampField)}) ts = value;
      else if (name === ${tsString(notice.signatureField)}) signature = value;
    }
    if (ts == null || signature == null) throw new InvalidPaymentNoticeException('cabecera de firma incompleta');
    const raw = parseLong(ts);
    if (raw == null) throw new InvalidPaymentNoticeException('timestamp ilegible');
    // El ts puede venir en milisegundos: se normaliza antes de comparar con la ventana.
    const seconds = raw > ${notice.millisecondsAbove} ? Math.trunc(raw / 1000) : raw;
    if (Math.abs(Math.floor(this.clock() / 1000) - seconds) > this.settings.noticeToleranceSeconds) {
      throw new InvalidPaymentNoticeException('aviso fuera de la ventana de tolerancia');
    }
    const dataId = notice.param(${tsString(notice.dataIdQuery)});
    const requestId = notice.header(${tsString(notice.requestIdHeader)});
    let manifest = '';
    if (dataId != null && dataId.trim() !== '') manifest += \`id:\${dataId.toLowerCase()};\`;
    if (requestId != null && requestId.trim() !== '') manifest += \`request-id:\${requestId};\`;
    manifest += \`ts:\${ts};\`;
    const expected = Buffer.from(createHmac('sha256', this.settings.webhookSecret).update(manifest, 'utf8').digest('hex'), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidPaymentNoticeException('la firma no verifica');
    return dataId == null || dataId.trim() === '' ? null : dataId;
  }
}

/** Un entero con signo opcional, como Long.parseLong; null si no lo es o no cabe. */
function parseLong(value: string): number | null {
  if (!/^[+-]?\\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}`
  );
}
