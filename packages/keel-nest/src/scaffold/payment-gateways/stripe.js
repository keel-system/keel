// El adaptador de Stripe (Payment Intents) y su verificador de avisos, para keel-nest.
//
// Es la traducción del de keel-spring, caso por caso, y habla el MISMO contrato (keel-core/gen/payment-gateways.js:
// la clave de idempotencia, las claves de metadata, los rechazos, la marca de la captura caducada):
//   * cuerpos application/x-www-form-urlencoded; credencial como Bearer con la clave secreta;
//   * importe entero en la unidad menor, con la tabla de keel-core (no la de Intl);
//   * Idempotency-Key en todo POST; un 5xx no se reintenta: queda en duda;
//   * Stripe-Signature: t=…,v1=…[,v1=…]: HMAC-SHA256 de `${t}.${cuerpo}`; solo cuenta v1, puede haber varias
//     durante la rotación del secreto, y se compara en tiempo constante.

import { gatewayTranslation, paymentIdempotencyKey, refundTranslation, savedMethodIdempotencyKey, SAVED_METHOD_SEPARATOR, tracksRefundInFlight } from '@keel-system/keel-core/gen/payment-gateways';
import { DIRS, classPath, tsModule, tsString } from '../render.js';
import { savedMethodTsHelpers } from '../payments.js';

// La clave de la devolución (corrida payment-go): con `refund.reference`, una por devolución
// (`<cobro>:refund:<devolución>`, refundIdempotencyKey de keel-core); sin ella, la del cobro.
const refundKeyCall = (p) => (p.refund.reference ? "idempotencyKey(reference, 'refund:' + refundReference)" : "idempotencyKey(reference, 'refund')");
const refundReferenceParam = (p) => (p.refund.reference ? 'refundReference: string, ' : '');
// Cómo se localiza una devolución en Stripe: por su metadata (keel-core: REFUND_TRANSLATIONS).
const REFUND = refundTranslation('stripe');
const tsCases = (values, indent) => values.map((value) => `${indent}case ${tsString(value)}:`).join('\n');


const TRANSLATION = gatewayTranslation('stripe');
const DIR = 'infrastructure/payment/stripe';
const ADAPTER_TS = classPath(DIR, 'StripePaymentGateway');
const VERIFIER_TS = classPath(DIR, 'StripeNoticeVerifier');

export function classes() {
  return {
    adapter: { symbol: 'StripePaymentGateway', from: ADAPTER_TS },
    verifier: { symbol: 'StripeNoticeVerifier', from: VERIFIER_TS }
  };
}

/** Las rutas de los archivos que ya genera la parte neutra (payments.js), para no importarla en círculo. */
const NEUTRAL = {
  status: 'src/domain/payment/gateway-status.ts',
  outcome: 'src/domain/payment/gateway-outcome.ts',
  source: 'src/domain/payment/payment-source.ts',
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
  const SAVED = savedMethodTsHelpers(TRANSLATION, 'Stripe');
  const F = p.record.failureReasonType;
  const constant = (literal) => p.failureReasons.find((entry) => entry.literal === literal).constant;
  const declines = TRANSLATION.declines.map(([code, literal]) => `  [${tsString(code)}, ${F}.${constant(literal)}]`).join(',\n');
  const header = p.gateway.idempotencyHeader;
  const methods = [];

  methods.push(`  async authorize(request: ChargeRequest): Promise<GatewayOutcome> {
    const form = new URLSearchParams();
    form.append('amount', MoneyAmounts.toMinorUnits(request.amount, request.currency).toString());
    form.append('currency', request.currency.toLowerCase());
    form.append('capture_method', ${tsString(p.captureLater ? 'manual' : 'automatic')});
    form.append('confirm', 'true');
    form.append('payment_method_types[]', 'card');
    form.append(\`metadata[\${REFERENCE_KEY}]\`, request.reference);
    if (request.source.kind === 'SAVED') {
      // La referencia guardada es "customer${SAVED_METHOD_SEPARATOR}payment_method" (savePaymentMethod).
      const [customer, paymentMethod] = splitSaved(request.source.value);
      form.append('customer', customer);
      form.append('payment_method', paymentMethod);
      form.append('off_session', 'true');
    } else {
      form.append('payment_method', request.source.value);
    }
    return this.post('/v1/payment_intents', form, idempotencyKey(request.reference, 'authorize'), request.reference);
  }`);

  if (p.capture) {
    const amountParam = p.capture.amount ? ', amount: Decimal | null, currency: string | null' : '';
    const amountLine = p.capture.amount
      ? `
    if (amount != null) form.append('amount_to_capture', MoneyAmounts.toMinorUnits(amount, requiredCurrency(currency)).toString());`
      : '';
    methods.push(`  async capture(reference: string, gatewayPaymentId: string${amountParam}): Promise<GatewayOutcome> {
    const form = new URLSearchParams();${amountLine}
    return this.followUp(\`/v1/payment_intents/\${encodeURIComponent(gatewayPaymentId)}/capture\`, form, reference, gatewayPaymentId, 'capture');
  }`);
  }
  if (p.void) {
    methods.push(`  async voidAuthorization(reference: string, gatewayPaymentId: string): Promise<GatewayOutcome> {
    return this.followUp(\`/v1/payment_intents/\${encodeURIComponent(gatewayPaymentId)}/cancel\`, new URLSearchParams(), reference, gatewayPaymentId, 'void');
  }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', amount: Decimal | null, currency: string | null' : '';
    const amountLine = p.refund.amount
      ? `
    if (amount != null) form.append('amount', MoneyAmounts.toMinorUnits(amount, requiredCurrency(currency)).toString());`
      : '';
    methods.push(`  async refund(reference: string, ${refundReferenceParam(p)}gatewayPaymentId: string${amountParam}): Promise<GatewayOutcome> {
    const form = new URLSearchParams();
    form.append('payment_intent', gatewayPaymentId);${amountLine}${tracksRefundInFlight(p) ? `
    // La referencia de ESTA devolución viaja en su metadata: es lo que permite encontrarla si la respuesta se pierde.
    form.append(\`metadata[\${REFUND_REFERENCE_KEY}]\`, refundReference);` : ''}
    const answer = await this.send('refund', { method: 'POST', path: '/v1/refunds', body: formBody(form), idempotency: this.key(${refundKeyCall(p)}) });
    if (answer.status >= 500) throw unavailable('refund', answer);
    // Rechazada: el cobro sigue capturado.
    if (answer.status >= 400) return GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
    const refund = json(answer.text);
    switch (text(refund['status'])) {
${tsCases(REFUND.succeeded, '      ')}
        return GatewayOutcome.refunded(reference, gatewayPaymentId, MoneyAmounts.fromMinorUnits(minor(refund['amount']), upper(refund['currency'])));
${tsCases(REFUND.pending, '      ')}
        return GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
      default:
        return GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
    }
  }`);
  }
  if (tracksRefundInFlight(p)) {
    methods.push(`  /**
   * La devolución en vuelo se busca entre las del cobro por la referencia que lleva en su metadata: la consulta del cobro
   * solo sabe el acumulado devuelto (latest_charge.amount_refunded), que no es el desenlace de ESTA devolución. Stripe
   * guarda la referencia, así que alreadyRefunded no hace falta aquí.
   */
  async refundStatus(reference: string, refundReference: string, gatewayPaymentId: string, _alreadyRefunded: Decimal): Promise<GatewayOutcome> {
    const query = new URLSearchParams();
    query.append('payment_intent', gatewayPaymentId);
    query.append('limit', '100');
    const answer = await this.send('refundStatus', { method: 'GET', path: \`/v1/refunds?\${query.toString()}\` });
    if (answer.status >= 400) throw unavailable('refundStatus', answer);
    const body = json(answer.text);
    for (const refund of Array.isArray(body['data']) ? body['data'] : []) {
      if (!isObject(refund)) continue;
      const metadata = isObject(refund['metadata']) ? refund['metadata'] : {};
      if (text(metadata[REFUND_REFERENCE_KEY]) !== refundReference) continue;
      switch (text(refund['status'])) {
${tsCases(REFUND.succeeded, '        ')}
          return GatewayOutcome.refunded(reference, gatewayPaymentId, MoneyAmounts.fromMinorUnits(minor(refund['amount']), upper(refund['currency'])));
${tsCases(REFUND.pending, '        ')}
          return GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
        default:
          return GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
      }
    }
    // No está: la devolución no llegó a la pasarela, y el cobro sigue como estaba.
    return GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
  }`);
  }

  methods.push(`  async status(reference: string | null, gatewayPaymentId: string | null): Promise<GatewayOutcome> {
    let answer: GatewayAnswer;
    if (gatewayPaymentId != null) {
      answer = await this.send('status', { method: 'GET', path: \`/v1/payment_intents/\${encodeURIComponent(gatewayPaymentId)}?expand[]=latest_charge\` });
    } else {
      // Sin id: la pasarela no llegó a contestar. Se busca por la referencia que se le mandó en metadata. La
      // búsqueda de Stripe es eventualmente consistente (puede tardar un minuto en ver un PaymentIntent recién
      // creado): por eso el barrido solo mira lo que lleva más del umbral esperando, y un NOT_FOUND aquí
      // significa que no llegó.
      const query = new URLSearchParams();
      query.append('query', \`metadata['\${REFERENCE_KEY}']:'\${reference ?? ''}'\`);
      query.append('expand[]', 'data.latest_charge');
      answer = await this.send('status', { method: 'GET', path: \`/v1/payment_intents/search?\${query.toString()}\` });
    }
    if (answer.status === 404) return GatewayOutcome.notFound(reference);
    if (answer.status >= 400) throw unavailable('status', answer);
    const body = json(answer.text);
    if (gatewayPaymentId != null) return this.outcomeOf(body, reference);
    const first = Array.isArray(body['data']) ? (body['data'] as unknown[])[0] : undefined;
    return isObject(first) ? this.outcomeOf(first, reference) : GatewayOutcome.notFound(reference);
  }`);

  if (p.savePaymentMethod) {
    const [customerStep, attachStep] = TRANSLATION.savedMethodSteps;
    methods.push(`  async savePaymentMethod(token: string, payerReference: string): Promise<SavedPaymentMethod> {
    const customerForm = new URLSearchParams();
    customerForm.append(${tsString(`metadata[${TRANSLATION.payerKey}]`)}, payerReference);
    const customer = await this.send('savePaymentMethod', {
      method: 'POST',
      path: '/v1/customers',
      body: formBody(customerForm),
      idempotency: this.key(savedKey(token, ${tsString(customerStep)}))
    });
    rejectedMethod(customer);
    const customerId = text(json(customer.text)['id']) ?? '';
    const attachForm = new URLSearchParams();
    attachForm.append('customer', customerId);
    const attach = await this.send('savePaymentMethod', {
      method: 'POST',
      path: \`/v1/payment_methods/\${encodeURIComponent(token)}/attach\`,
      body: formBody(attachForm),
      idempotency: this.key(savedKey(token, ${tsString(attachStep)}))
    });
    rejectedMethod(attach);
    // El attach devuelve el PaymentMethod con su card: de ahí sale el resumen de la tarjeta.
    return { reference: \`\${customerId}${SAVED_METHOD_SEPARATOR}\${token}\`, card: savedCardOf(json(attach.text)) };
  }`);
  }

  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: F, from: classPath(DIRS.enums, F) },
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
  if (p.capture?.amount || p.refund?.amount || tracksRefundInFlight(p)) imports.push({ symbol: 'Decimal', from: NEUTRAL.decimal, type: true });

  const body = `/** La clave de metadata con la que viaja la referencia del cobro; es lo que permite buscarlo. */
export const REFERENCE_KEY = ${tsString(TRANSLATION.referenceKey)};
${tracksRefundInFlight(p) ? `
/** La clave de metadata con la que viaja la referencia de UNA devolución; es lo que permite encontrarla. */
export const REFUND_REFERENCE_KEY = ${tsString(REFUND.referenceKey)};
` : ''}
type Json = Record<string, unknown>;

// decline_code (o code si no hay) → motivo neutro (keel-core/gen/payment-gateways.js); lo que no está es DECLINED.
const DECLINES = new Map<string, ${F}>([
${declines}
]);

/** La clave de una acción sobre un cobro: la misma en cada reintento, por las dos puertas y por los dos servidores. */
export function idempotencyKey(reference: string, action: string): string {
  return \`${paymentIdempotencyKey('${reference}', '${action}')}\`;
}

function savedKey(token: string, step: string): string {
  return \`${savedMethodIdempotencyKey('${token}', '${step}')}\`;
}

/**
 * La pasarela de pago sobre Stripe (Payment Intents), por HTTP plano.
 *
 * Lo que lleva dentro y no puede faltar:
 *   · la clave de idempotencia sale de la referencia de negocio y la acción (\`<referencia>:authorize\`…), nunca
 *     de un aleatorio: un reintento repite la clave;
 *   · un 5xx o un timeout NO se reintenta: lanza PaymentGatewayUnavailableException y la acción queda en duda
 *     para el barrido (Stripe guarda también los 500 con su clave);
 *   · el importe se convierte a la unidad menor sin redondear;
 *   · los rechazos se traducen al vocabulario neutro de ${F}.
 */
@Injectable()
export class StripePaymentGateway extends PaymentGateway {
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
      if (error instanceof GatewayNoAnswer) throw new PaymentGatewayUnavailableException(\`Stripe no contestó a \${action}: la acción queda en duda\`, { cause: error });
      throw error;
    }
  }

  private async post(path: string, form: URLSearchParams, key: string, reference: string): Promise<GatewayOutcome> {
    const answer = await this.send(path, { method: 'POST', path, body: formBody(form), idempotency: this.key(key) });
    if (answer.status >= 500) throw unavailable(path, answer);
    if (answer.status >= 400) return this.declined(answer, reference);
    return this.outcomeOf(json(answer.text), reference);
  }

  /** Captura y anulación: si Stripe la rechaza por el estado del cobro, se devuelve el estado real. */
  private async followUp(path: string, form: URLSearchParams, reference: string, gatewayPaymentId: string, action: string): Promise<GatewayOutcome> {
    const answer = await this.send(action, { method: 'POST', path, body: formBody(form), idempotency: this.key(idempotencyKey(reference, action)) });
    if (answer.status >= 500) throw unavailable(action, answer);
    if (answer.status >= 400) {
      // La autorización caducó: es la respuesta de la pasarela y no hace falta preguntarle. Se busca en el texto
      // y no se parsea: un 4xx con un cuerpo que no es JSON no puede convertir una respuesta en una excepción.
      if (answer.text.includes(${tsString(TRANSLATION.expiredCaptureMarker)})) return GatewayOutcome.of(GatewayStatus.CANCELED, reference, gatewayPaymentId);
      // payment_intent_unexpected_state y compañía (ya se capturó…): el estado real se consulta.
      return this.status(reference, gatewayPaymentId);
    }
    return this.outcomeOf(json(answer.text), reference);
  }

  // ─── Traducción ────────────────────────────────────────────────────────────

  private outcomeOf(intent: Json, reference: string | null): GatewayOutcome {
    const id = text(intent['id']);
    const metadata = isObject(intent['metadata']) ? intent['metadata'] : {};
    const ref = text(metadata[REFERENCE_KEY]) ?? reference;
${tracksRefundInFlight(p)
  ? `    // Sin deducir la devolución del acumulado (latest_charge.amount_refunded): con varias devoluciones no dice cuál terminó
    // ni si la que está en vuelo llegó. La devolución en vuelo la contesta refundStatus.
`
  : `    const charge = intent['latest_charge'];
    if (isObject(charge) && minor(charge['amount_refunded']) > 0n) {
      return GatewayOutcome.refunded(ref, id, MoneyAmounts.fromMinorUnits(minor(charge['amount_refunded']), upper(charge['currency'])));
    }
`}    switch (text(intent['status'])) {
      case 'requires_capture':
        return GatewayOutcome.of(GatewayStatus.AUTHORIZED, ref, id);
      case 'succeeded':
        return GatewayOutcome.of(GatewayStatus.CAPTURED, ref, id);
      case 'requires_action':
        return GatewayOutcome.actionRequired(ref, id, customerAction(intent));
      case 'canceled':
        return GatewayOutcome.of(GatewayStatus.CANCELED, ref, id);
      case 'requires_payment_method': {
        const error = intent['last_payment_error'];
        return isObject(error) ? GatewayOutcome.failed(ref, id, reasonOf(error)) : GatewayOutcome.of(GatewayStatus.PENDING, ref, id);
      }
      default:
        return GatewayOutcome.of(GatewayStatus.PENDING, ref, id);
    }
  }

  /** Un 4xx al pedir el cobro: un rechazo del emisor (402) o un medio que no sirve (400). */
  private declined(answer: GatewayAnswer, reference: string): GatewayOutcome {
    const body = json(answer.text);
    const error = isObject(body['error']) ? body['error'] : {};
    const intent = error['payment_intent'];
    const id = isObject(intent) ? text(intent['id']) : null;
    if (codeOf(error) === 'authentication_required' && isObject(intent)) {
      // Un cobro sin el cliente delante que el emisor quiere autenticar: no es un fallo, es una acción del cliente
      // pendiente (docs/dsl/payments.md § Dos puertas).
      return GatewayOutcome.actionRequired(reference, id, customerAction(intent));
    }
    return GatewayOutcome.failed(reference, id, reasonOf(error));
  }
}

function customerAction(intent: Json): string {
  return JSON.stringify({ clientSecret: text(intent['client_secret']), nextAction: intent['next_action'] ?? null });
}

function codeOf(error: Json): string {
  return text(error['decline_code']) ?? text(error['code']) ?? '';
}

function reasonOf(error: Json): ${F} {
  return DECLINES.get(codeOf(error)) ?? ${F}.${constant('declined')};
}

function formBody(form: URLSearchParams): GatewayRequest['body'] {
  return { contentType: 'application/x-www-form-urlencoded', text: form.toString() };
}

function json(body: string): Json {
  try {
    const parsed: unknown = JSON.parse(body == null || body.trim() === '' ? '{}' : body);
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error('Stripe devolvió un cuerpo que no es JSON', { cause: error });
  }
}

function isObject(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (value == null || typeof value === 'object') return null;
  return String(value);
}

/** Un importe entero de Stripe (unidad menor). Uno que falta o no es entero es 0, como el asLong() de keel-spring. */
function minor(value: unknown): bigint {
  const raw = text(value);
  return raw != null && /^-?\\d+$/.test(raw) ? BigInt(raw) : 0n;
}

function upper(value: unknown): string {
  return (text(value) ?? '').toUpperCase();
}

function splitSaved(value: string): [string, string] {
  const at = value.indexOf(${tsString(SAVED_METHOD_SEPARATOR)});
  if (at < 0) throw new Error('Un medio guardado es "<cliente>${SAVED_METHOD_SEPARATOR}<medio>": esta referencia no lo es');
  return [value.slice(0, at), value.slice(at + 1)];
}

function requiredCurrency(currency: string | null): string {
  if (currency == null) throw new Error('Un importe parcial necesita la moneda del cobro');
  return currency;
}

function unavailable(action: string, answer: GatewayAnswer): PaymentGatewayUnavailableException {
  return new PaymentGatewayUnavailableException(\`Stripe no contestó a \${action} (HTTP \${answer.status}): la acción queda en duda\`);
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
 * Verifica la cabecera ${model.payments.gateway.webhook.signatureHeader}: \`${notice.timestampField}=<timestamp>,${notice.signatureField}=<firma>[,${notice.signatureField}=<firma>]\`.
 *
 * La firma es HMAC-SHA256 de \`<t>.<cuerpo>\` con el secreto del endpoint. Solo cuenta \`${notice.signatureField}\` (el resto se
 * ignora, contra el downgrade); puede haber varias durante la rotación del secreto y basta con que verifique una;
 * se compara en tiempo constante; y un \`t\` más antiguo que la tolerancia se rechaza aunque la firma sea buena,
 * porque es un aviso repetido.
 */
@Injectable()
export class StripeNoticeVerifier extends PaymentNoticeVerifier {
  /** El reloj, en milisegundos. Una prueba lo sustituye para medir la ventana. */
  clock: () => number = () => Date.now();

  constructor(@Inject(PAYMENT_GATEWAY_SETTINGS) private readonly settings: PaymentGatewaySettings) {
    super();
  }

  verify(notice: PaymentNotice): string | null {
    const header = notice.header(${tsString(model.payments.gateway.webhook.signatureHeader)});
    if (header == null || header.trim() === '') throw new InvalidPaymentNoticeException('sin cabecera de firma');
    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const trimmed = part.trim();
      const equals = trimmed.indexOf('=');
      if (equals < 0) continue;
      const [name, value] = [trimmed.slice(0, equals), trimmed.slice(equals + 1)];
      if (name === ${tsString(notice.timestampField)}) {
        timestamp = parseLong(value);
        if (timestamp == null) throw new InvalidPaymentNoticeException('timestamp ilegible');
      } else if (name === ${tsString(notice.signatureField)}) {
        signatures.push(value);
      }
    }
    if (timestamp == null || signatures.length === 0) throw new InvalidPaymentNoticeException('cabecera de firma incompleta');
    if (Math.abs(Math.floor(this.clock() / 1000) - timestamp) > this.settings.noticeToleranceSeconds) {
      throw new InvalidPaymentNoticeException('aviso fuera de la ventana de tolerancia');
    }
    const expected = Buffer.from(createHmac('sha256', this.settings.webhookSecret).update(\`\${timestamp}.\${notice.body}\`, 'utf8').digest('hex'), 'utf8');
    const valid = signatures.some((signature) => {
      const given = Buffer.from(signature, 'utf8');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!valid) throw new InvalidPaymentNoticeException('la firma no verifica');
    return paymentIntentOf(notice.body);
  }
}

/** El PaymentIntent del que habla el evento: el propio objeto, o el payment_intent de un cargo o una devolución. */
function paymentIntentOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidPaymentNoticeException('el cuerpo no es JSON');
  }
  const data = (parsed as { data?: { object?: Record<string, unknown> } } | null)?.data?.object;
  if (data == null || typeof data !== 'object') return null;
  if (data['object'] === 'payment_intent') return typeof data['id'] === 'string' ? data['id'] : null;
  return typeof data['payment_intent'] === 'string' ? data['payment_intent'] : null;
}

/** Un entero con signo opcional, como Long.parseLong; null si no lo es o no cabe. */
function parseLong(value: string): number | null {
  if (!/^[+-]?\\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}`
  );
}
