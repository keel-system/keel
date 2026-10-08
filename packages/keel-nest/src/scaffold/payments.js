// Cobros con pasarela (capa payments, incremento 13b). La parte NEUTRA: lo que es igual sea cual sea la
// pasarela elegida; el adaptador y el verificador de cada una los emite su módulo en ./payment-gateways/.
//
// Build genera el puerto, el adaptador y el aviso enteros, como keel-spring y por el mismo criterio que el
// correo: lo que llevan dentro son defensas cuya ausencia no rompe ninguna prueba.
//
//   · La FIRMA del aviso se verifica sobre el texto tal como llegó y en tiempo constante. En Fastify eso
//     significa que el lector JSON del contrato del cable NO puede tocar el cuerpo de esa ruta: lo deja
//     pasar como texto (http-platform.ts), y aquí se verifica antes de leer nada.
//   · El aviso NO decide el desenlace: se le pregunta a la pasarela.
//   · La clave de idempotencia sale de la referencia de negocio y de la acción (keel-core/gen/payment-gateways).
//   · El importe se convierte a la unidad de la pasarela con la tabla de unidades menores de keel-core, la
//     del JDK: `Intl` discrepa en 25 monedas.
//   · Los rechazos caen en el vocabulario neutro (FAILURE_REASONS).
//
// Lo que NO genera: la lógica de los casos de uso (cuándo se llama al puerto y qué transición aplica cada
// handler), que es del diseño y la escribe el agente con la skill de la pasarela.

import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS } from 'keel-core/gen/payment-gateways';
import { HTTP_STUB } from 'keel-core/gen/infra-catalog';
import { DIRS, classPath, declType, tsModule, tsString } from './render.js';
import { COMMAND_DISPATCHER_TS } from './mediator.js';
import { DECIMAL_TS, RAW_JSON_TS } from './wire.js';
import { messageComponents, messagePath } from './services.js';
import * as stripe from './payment-gateways/stripe.js';
import * as mercadopago from './payment-gateways/mercadopago.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const DOMAIN_DIR = 'domain/payment';
const APP_DIR = 'application/payment';
const INFRA_DIR = 'infrastructure/payment';
const PROFILES = ['local', 'develop', 'production', 'test'];

export const GATEWAY_STATUS_TS = classPath(DOMAIN_DIR, 'GatewayStatus');
export const GATEWAY_OUTCOME_TS = classPath(DOMAIN_DIR, 'GatewayOutcome');
export const PAYMENT_SOURCE_TS = classPath(DOMAIN_DIR, 'PaymentSource');
export const CHARGE_REQUEST_TS = classPath(DOMAIN_DIR, 'ChargeRequest');
export const UNAVAILABLE_TS = classPath(DOMAIN_DIR, 'PaymentGatewayUnavailableException');
export const PAYMENT_GATEWAY_TS = classPath(DIRS.portOut, 'PaymentGateway');
export const OUTCOME_APPLIER_TS = classPath(APP_DIR, 'PaymentOutcomeApplier');
export const PAYMENT_NOTICES_TS = classPath(APP_DIR, 'PaymentNotices');
export const PAYMENT_RECONCILIATION_TS = classPath(APP_DIR, 'PaymentReconciliation');
export const RECONCILIATION_SETTINGS_TS = classPath(APP_DIR, 'PaymentReconciliationSettings');
export const SETTINGS_TS = classPath(INFRA_DIR, 'PaymentGatewaySettings');
export const GATEWAY_HTTP_TS = classPath(INFRA_DIR, 'PaymentGatewayHttp');
export const MONEY_AMOUNTS_TS = classPath(INFRA_DIR, 'MoneyAmounts');
export const NOTICE_VERIFIER_TS = classPath(INFRA_DIR, 'PaymentNoticeVerifier');
export const INVALID_NOTICE_TS = classPath(INFRA_DIR, 'InvalidPaymentNoticeException');
export const NOTICE_CONTROLLER_TS = classPath(INFRA_DIR, 'PaymentNoticeController');
export const PAYMENTS_MODULE_TS = `src/${INFRA_DIR}/payments-module.ts`;

const GATEWAY_MODULES = { stripe, mercadopago };

export function usesPayments(model) {
  return Boolean(model.payments);
}

/** Las clases de la capa application que cablea el módulo de casos de uso (como los mappers). */
export function paymentApplicationClasses(model) {
  if (!usesPayments(model)) return [];
  return [
    { symbol: 'PaymentOutcomeApplier', from: OUTCOME_APPLIER_TS },
    { symbol: 'PaymentNotices', from: PAYMENT_NOTICES_TS },
    { symbol: 'PaymentReconciliation', from: PAYMENT_RECONCILIATION_TS }
  ];
}

/** El controlador del aviso, para quien registra los controladores (AppModule). */
export function paymentControllers(model) {
  return usesPayments(model) ? [{ symbol: 'PaymentNoticeController', from: NOTICE_CONTROLLER_TS }] : [];
}

/** El módulo de la pasarela del stack (adaptador, verificador y configuración), y su archivo. */
export function gatewayModule(model) {
  const module = GATEWAY_MODULES[model.payments.gateway.id];
  if (!module) throw new Error(`payments: la pasarela '${model.payments.gateway.id}' no tiene módulo de generación en keel-nest`);
  return module;
}

export function generate(model) {
  if (!usesPayments(model)) return [];
  return [
    { path: GATEWAY_STATUS_TS, content: gatewayStatusTs() },
    { path: GATEWAY_OUTCOME_TS, content: gatewayOutcomeTs(model) },
    { path: PAYMENT_SOURCE_TS, content: paymentSourceTs() },
    { path: CHARGE_REQUEST_TS, content: chargeRequestTs(model) },
    { path: UNAVAILABLE_TS, content: unavailableTs() },
    { path: PAYMENT_GATEWAY_TS, content: portTs(model) },
    { path: OUTCOME_APPLIER_TS, content: outcomeApplierTs(model) },
    { path: PAYMENT_NOTICES_TS, content: noticesTs() },
    { path: RECONCILIATION_SETTINGS_TS, content: reconciliationSettingsTs(model) },
    { path: PAYMENT_RECONCILIATION_TS, content: reconciliationTs(model) },
    { path: SETTINGS_TS, content: settingsTs() },
    { path: GATEWAY_HTTP_TS, content: gatewayHttpTs() },
    { path: MONEY_AMOUNTS_TS, content: moneyAmountsTs() },
    { path: NOTICE_VERIFIER_TS, content: noticeVerifierTs() },
    { path: INVALID_NOTICE_TS, content: invalidNoticeTs() },
    { path: NOTICE_CONTROLLER_TS, content: noticeControllerTs() },
    { path: PAYMENTS_MODULE_TS, content: paymentsModuleTs(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/payments.yaml`, content: paymentsYaml(model, profile) })),
    ...gatewayModule(model).generate(model)
  ];
}

// ─── Dominio: el vocabulario neutro del puerto ───────────────────────────────

function gatewayStatusTs() {
  return tsModule(
    GATEWAY_STATUS_TS,
    [],
    `/**
 * El estado de un cobro tal como lo ve la pasarela, en un vocabulario que no depende de cuál sea.
 * Cada adaptador traduce a estos valores los estados de la suya.
 */
export enum GatewayStatus {
  /** La pasarela lo tiene, pero todavía no hay desenlace. */
  PENDING = 'PENDING',
  /** Espera a que el cliente se autentique (3DS, redirección). */
  ACTION_REQUIRED = 'ACTION_REQUIRED',
  /** Importe retenido, pendiente de captura. */
  AUTHORIZED = 'AUTHORIZED',
  /** Cobrado. */
  CAPTURED = 'CAPTURED',
  /** Devuelto, todo o en parte. */
  REFUNDED = 'REFUNDED',
  /** La autorización se anuló o caducó. */
  CANCELED = 'CANCELED',
  /** El cobro no se hizo. */
  FAILED = 'FAILED',
  /** La pasarela no conoce el cobro: la petición no le llegó nunca. */
  NOT_FOUND = 'NOT_FOUND'
}`
  );
}

function gatewayOutcomeTs(model) {
  const F = model.payments.record.failureReasonType;
  return tsModule(
    GATEWAY_OUTCOME_TS,
    [
      { symbol: 'Decimal', from: DECIMAL_TS, type: true },
      { symbol: F, from: classPath(DIRS.enums, F), type: true },
      { symbol: 'GatewayStatus', from: GATEWAY_STATUS_TS }
    ],
    `/**
 * Lo que la pasarela dice de un cobro, ya traducido. Es la ÚNICA forma en que un desenlace entra en el
 * servicio, venga de la respuesta síncrona, del aviso o del barrido: el aviso no se lee, se consulta.
 */
export class GatewayOutcome {
  /**
   * @param status           el estado neutro
   * @param reference        la referencia de negocio del cobro, que el adaptador manda a la pasarela y la
   *                         pasarela devuelve; es lo que identifica el cobro en este servicio
   * @param gatewayPaymentId el id que asignó la pasarela, o null si no llegó a asignarlo
   * @param failureReason    con FAILED, el motivo en el vocabulario neutro; null en otro caso
   * @param customerAction   con ACTION_REQUIRED, la acción del cliente, opaca (la consume el componente de
   *                         la pasarela en el navegador); null en otro caso
   * @param refundedAmount   con REFUNDED, lo devuelto en unidades mayores; null en otro caso
   */
  private constructor(
    readonly status: GatewayStatus,
    readonly reference: string | null,
    readonly gatewayPaymentId: string | null,
    readonly failureReason: ${F} | null,
    readonly customerAction: string | null,
    readonly refundedAmount: Decimal | null
  ) {}

  static of(status: GatewayStatus, reference: string | null, gatewayPaymentId: string | null): GatewayOutcome {
    return new GatewayOutcome(status, reference, gatewayPaymentId, null, null, null);
  }

  static failed(reference: string | null, gatewayPaymentId: string | null, reason: ${F}): GatewayOutcome {
    return new GatewayOutcome(GatewayStatus.FAILED, reference, gatewayPaymentId, reason, null, null);
  }

  static actionRequired(reference: string | null, gatewayPaymentId: string | null, customerAction: string | null): GatewayOutcome {
    return new GatewayOutcome(GatewayStatus.ACTION_REQUIRED, reference, gatewayPaymentId, null, customerAction, null);
  }

  static refunded(reference: string | null, gatewayPaymentId: string | null, refundedAmount: Decimal): GatewayOutcome {
    return new GatewayOutcome(GatewayStatus.REFUNDED, reference, gatewayPaymentId, null, null, refundedAmount);
  }

  /** La pasarela no conoce el cobro: la petición no le llegó nunca. */
  static notFound(reference: string | null): GatewayOutcome {
    return new GatewayOutcome(GatewayStatus.NOT_FOUND, reference, null, null, null, null);
  }
}`
  );
}

function paymentSourceTs() {
  return tsModule(
    PAYMENT_SOURCE_TS,
    [],
    `/** TOKEN si lo produjo el componente de la pasarela con el cliente delante; SAVED si es un medio guardado. */
export type PaymentSourceKind = 'TOKEN' | 'SAVED';

/** Con qué se paga, siempre como referencia OPACA de la pasarela. Nunca un dato de tarjeta. */
export class PaymentSource {
  private constructor(
    readonly kind: PaymentSourceKind,
    /** El token, o la referencia que devolvió PaymentGateway.savePaymentMethod. */
    readonly value: string
  ) {
    if (value == null || value.trim() === '') throw new RangeError('Un medio de pago necesita su referencia');
  }

  static token(token: string): PaymentSource {
    return new PaymentSource('TOKEN', token);
  }

  static saved(gatewayReference: string): PaymentSource {
    return new PaymentSource('SAVED', gatewayReference);
  }
}`
  );
}

function chargeRequestTs(model) {
  return tsModule(
    CHARGE_REQUEST_TS,
    [
      { symbol: 'Decimal', from: DECIMAL_TS, type: true },
      { symbol: 'PaymentSource', from: PAYMENT_SOURCE_TS, type: true }
    ],
    `/** Un cobro a pedir a la pasarela. */
export class ChargeRequest {
  /**
   * @param reference la referencia de negocio del cobro (payments.charge.reference: ${model.payments.charge.reference}). De ella sale la
   *                  clave de idempotencia hacia la pasarela, y la pasarela la devuelve en cada consulta: es lo
   *                  que permite reconciliar un cobro sin respuesta
   * @param amount    el importe en unidades mayores (12.50); la conversión es del adaptador
   * @param currency  ISO 4217
   * @param source    con qué se paga
   */
  constructor(
    readonly reference: string,
    readonly amount: Decimal,
    readonly currency: string,
    readonly source: PaymentSource
  ) {
    if (reference == null || amount == null || currency == null || source == null) {
      throw new RangeError('Un cobro necesita referencia, importe, moneda y medio de pago');
    }
    if (amount.isNegative() || amount.isZero()) throw new RangeError('El importe de un cobro tiene que ser positivo');
  }
}`
  );
}

function unavailableTs() {
  return tsModule(
    UNAVAILABLE_TS,
    [],
    `/**
 * La pasarela no contestó, o contestó con un error suyo (5xx, timeout, conexión): NO se sabe si hizo lo que
 * se le pidió. La acción se queda en su estado en vuelo y la resuelve el barrido de reconciliación. Lo que no
 * se hace nunca es repetirla a ciegas: puede cobrar o devolver dos veces.
 */
export class PaymentGatewayUnavailableException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PaymentGatewayUnavailableException';
  }
}`
  );
}

// ─── Puerto ──────────────────────────────────────────────────────────────────

function portTs(model) {
  const p = model.payments;
  const methods = [
    `  /**
   * Pide el cobro (${p.captureLater ? 'solo lo AUTORIZA: flow authorize-capture' : 'autoriza y captura: flow single-step'}).
   * El cobro tiene que estar registrado ANTES de llamar: si esto lanza, se queda en duda.
   *
   * @throws PaymentGatewayUnavailableException si no se sabe qué hizo la pasarela
   */
  abstract authorize(request: ChargeRequest): Promise<GatewayOutcome>;`
  ];
  if (p.capture) {
    methods.push(`  /**
   * Captura lo autorizado${p.capture.amount ? '; con amount, solo esa parte (el resto se libera), en la moneda del cobro' : ''}.
   * El cobro tiene que estar ya en su estado en vuelo (${p.capture.inFlight}).
   */
  abstract capture(reference: string, gatewayPaymentId: string${p.capture.amount ? ', amount: Decimal | null, currency: string | null' : ''}): Promise<GatewayOutcome>;`);
  }
  if (p.void) {
    methods.push(`  /** Anula la autorización. El cobro tiene que estar ya en ${p.void.inFlight}. */
  abstract voidAuthorization(reference: string, gatewayPaymentId: string): Promise<GatewayOutcome>;`);
  }
  if (p.refund) {
    methods.push(`  /**
   * Devuelve lo cobrado${p.refund.amount ? '; con amount null, todo. La moneda es la del cobro: la pasa quien llama,\n   * que la conoce, en vez de pedírsela a la pasarela con una llamada más' : ''}. El cobro tiene que estar ya en
   * ${p.refund.inFlight}. Si la pasarela la rechaza, el resultado NO es REFUNDED.
   */
  abstract refund(reference: string, gatewayPaymentId: string${p.refund.amount ? ', amount: Decimal | null, currency: string | null' : ''}): Promise<GatewayOutcome>;`);
  }
  methods.push(`  /**
   * El estado de un cobro según la pasarela. Con gatewayPaymentId null —la pasarela no llegó a contestar— se
   * busca por la referencia, que el adaptador le mandó al pedirlo.
   */
  abstract status(reference: string | null, gatewayPaymentId: string | null): Promise<GatewayOutcome>;`);
  if (p.savePaymentMethod) {
    methods.push(`  /**
   * Guarda un medio de pago para cobrarlo sin el cliente delante.
   *
   * @return la referencia opaca de la pasarela; no sale nunca del servicio
   */
  abstract savePaymentMethod(token: string, payerReference: string): Promise<string>;`);
  }
  const imports = [
    { symbol: 'ChargeRequest', from: CHARGE_REQUEST_TS, type: true },
    { symbol: 'GatewayOutcome', from: GATEWAY_OUTCOME_TS, type: true }
  ];
  if (p.capture?.amount || p.refund?.amount) imports.push({ symbol: 'Decimal', from: DECIMAL_TS, type: true });
  return tsModule(
    PAYMENT_GATEWAY_TS,
    imports,
    `/**
 * La pasarela de pago, vista desde los casos de uso. No nombra ninguna: la implementación la eligió build con
 * el stack (keel-stack.json → paymentGateway) y se cambia regenerando, sin tocar el diseño. Este archivo es
 * idéntico con cualquier pasarela (test/payments.test.js).
 *
 * Una clase abstracta y no una interfaz porque sirve también de token de inyección.
 */
export abstract class PaymentGateway {
${methods.join('\n\n')}
}`
  );
}

// ─── Aplicación: de un desenlace a la operación del diseño que lo aplica ─────

/** La expresión de un argumento del mensaje de desenlace, ajustada al tipo y a la obligatoriedad del componente. */
function argExpression(arg, component, imports) {
  if (!arg.known) {
    imports.push({ symbol: component.tsType, from: classPath(DIRS.enums, component.tsType), type: true });
    return `todo<${declType(component)}>(${tsString(arg.name)})`;
  }
  const raw = {
    reference: 'outcome.reference',
    gatewayPaymentId: 'outcome.gatewayPaymentId',
    failureReason: 'outcome.failureReason',
    customerAction: 'outcome.customerAction',
    refundedAmount: 'outcome.refundedAmount'
  }[arg.slot];
  const nullable = !(component.required || component.isId);
  const value = nullable ? raw : `required(${raw}, ${tsString(arg.name)})`;
  // El campo `json` del mensaje es un RawJson: la acción del cliente viaja embebida, no como cadena escapada.
  if (component.tsType === 'RawJson') {
    imports.push({ symbol: 'RawJson', from: RAW_JSON_TS });
    return nullable ? `${raw} == null ? null : RawJson.of(${raw})` : `RawJson.of(${value})`;
  }
  return value;
}

function outcomeApplierTs(model) {
  const p = model.payments;
  const imports = [
    { symbol: 'CommandDispatcher', from: COMMAND_DISPATCHER_TS },
    { symbol: 'GatewayOutcome', from: GATEWAY_OUTCOME_TS, type: true },
    { symbol: 'GatewayStatus', from: GATEWAY_STATUS_TS }
  ];
  const operations = new Map(model.services.flatMap((service) => service.operations).map((operation) => [operation.name, operation]));
  let needsTodo = false;
  let needsRequired = false;
  const cases = p.outcomeCommands.map((command) => {
    const operation = operations.get(command.operation);
    imports.push({ symbol: command.messageClass, from: messagePath(operation) });
    const components = new Map(messageComponents(model, operation).map((component) => [component.name, component]));
    const props = command.args.map((arg) => {
      const expression = argExpression(arg, components.get(arg.name), imports);
      if (!arg.known) needsTodo = true;
      else if (expression.includes('required(')) needsRequired = true;
      return `            ${arg.name}: ${expression}`;
    });
    return `      case GatewayStatus.${command.status}:
        await this.dispatcher.dispatch(
          new ${command.messageClass}({
${props.join(',\n')}
          })
        );
        return;`;
  });
  const helpers = [];
  if (needsRequired) {
    helpers.push(`/** Un componente obligatorio de la operación que la pasarela no dio: no se aplica nada a medias. */
function required<T>(value: T | null, component: string): T {
  if (value == null) throw new Error(\`El desenlace de la pasarela no trae '\${component}', que la operación exige\`);
  return value;
}`);
  }
  if (needsTodo) {
    helpers.push(`/**
 * TODO(keel): la capa payments no nombra este componente (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED), así que build no
 * sabe de dónde sale en el desenlace de la pasarela. Decídelo aquí; mientras, ese desenlace falla en voz alta.
 */
function todo<T>(component: string): T {
  throw new Error(\`TODO(keel): '\${component}' no lo nombra la capa payments: decide su valor en PaymentOutcomeApplier\`);
}`);
  }
  return tsModule(
    OUTCOME_APPLIER_TS,
    imports,
    `/**
 * Aplica un desenlace de la pasarela con la operación del diseño que le corresponde (payments.outcomes). Es el
 * único sitio donde un GatewayOutcome se convierte en un cambio del registro, venga de la respuesta síncrona,
 * del aviso o del barrido.
 *
 * Los handlers de esas operaciones tienen que ser IDEMPOTENTES: el mismo desenlace puede llegar por dos caminos,
 * y uno tardío puede encontrar el cobro fuera del estado de origen. En los dos casos no se hace nada y no es un
 * error (docs/dsl/payments.md § Los desenlaces). Dos desenlaces DISTINTOS a la vez los arbitra el bloqueo
 * optimista.
 */
export class PaymentOutcomeApplier {
  static readonly inject = [CommandDispatcher] as const;

  constructor(private readonly dispatcher: CommandDispatcher) {}

  /** PENDING y NOT_FOUND no son desenlaces: el llamante decide qué hacer con ellos. */
  async apply(outcome: GatewayOutcome): Promise<void> {
    switch (outcome.status) {
${cases.join('\n')}
      default:
        // Sin desenlace que aplicar.
        return;
    }
  }
}${helpers.length > 0 ? `\n\n${helpers.join('\n\n')}` : ''}`
  );
}

function noticesTs() {
  return tsModule(
    PAYMENT_NOTICES_TS,
    [
      { symbol: 'GatewayStatus', from: GATEWAY_STATUS_TS },
      { symbol: 'PaymentGateway', from: PAYMENT_GATEWAY_TS },
      { symbol: 'PaymentOutcomeApplier', from: OUTCOME_APPLIER_TS }
    ],
    `/**
 * Lo que se hace con un aviso de la pasarela YA VERIFICADO: preguntarle el estado del cobro y aplicar el
 * desenlace. El contenido del aviso no se usa para nada más que para saber de qué cobro habla.
 */
export class PaymentNotices {
  static readonly inject = [PaymentGateway, PaymentOutcomeApplier] as const;

  constructor(
    private readonly gateway: PaymentGateway,
    private readonly applier: PaymentOutcomeApplier
  ) {}

  async onNotice(gatewayPaymentId: string): Promise<void> {
    const outcome = await this.gateway.status(null, gatewayPaymentId);
    if (outcome.status === GatewayStatus.PENDING || outcome.status === GatewayStatus.NOT_FOUND) return;
    await this.applier.apply(outcome);
  }
}`
  );
}

function reconciliationSettingsTs(model) {
  return tsModule(
    RECONCILIATION_SETTINGS_TS,
    [],
    `/** Token del umbral del barrido de pagos (${model.payments.reconciliation.sweep}). */
export const PAYMENT_RECONCILIATION_SETTINGS = Symbol('PAYMENT_RECONCILIATION_SETTINGS');

/**
 * El silencio tolerado antes de preguntar a la pasarela por un cobro que espera desenlace. Lo declara el
 * diseño (payments.reconciliation.unansweredAfterSeconds) y lo lee la configuración
 * (payments.reconciliation.unanswered-after-seconds); en local y test se acorta para que los escenarios del
 * barrido no esperen un cuarto de hora.
 */
export interface PaymentReconciliationSettings {
  readonly unansweredAfterSeconds: number;
}`
  );
}

function reconciliationTs(model) {
  const p = model.payments;
  const F = p.record.failureReasonType;
  const notReceived = p.failureReasons.find((entry) => entry.literal === 'notReceived').constant;
  return tsModule(
    PAYMENT_RECONCILIATION_TS,
    [
      { symbol: F, from: classPath(DIRS.enums, F) },
      { symbol: 'GatewayOutcome', from: GATEWAY_OUTCOME_TS },
      { symbol: 'GatewayStatus', from: GATEWAY_STATUS_TS },
      { symbol: 'PaymentGateway', from: PAYMENT_GATEWAY_TS },
      { symbol: 'PaymentOutcomeApplier', from: OUTCOME_APPLIER_TS },
      { symbol: 'PAYMENT_RECONCILIATION_SETTINGS', from: RECONCILIATION_SETTINGS_TS },
      { symbol: 'PaymentReconciliationSettings', from: RECONCILIATION_SETTINGS_TS, type: true }
    ],
    `/**
 * La consulta del barrido de reconciliación (${p.reconciliation.sweep}) para UN cobro que espera desenlace: le
 * pregunta a la pasarela y aplica lo que diga.
 *
 * Lo que no hace es elegir los candidatos ni reclamarlos: eso es del handler del barrido. Los candidatos son los
 * cobros en ${p.awaitingStates.join(', ')} cuyo ${p.record.awaitingSince} es anterior a \`staleBefore()\`; y el
 * handler reclama cada uno volviendo a estampar ${p.record.awaitingSince} ANTES de llamar aquí, para que otra
 * réplica no lo consulte en la misma pasada.
 */
export class PaymentReconciliation {
  static readonly inject = [PaymentGateway, PaymentOutcomeApplier, PAYMENT_RECONCILIATION_SETTINGS] as const;

  constructor(
    private readonly gateway: PaymentGateway,
    private readonly applier: PaymentOutcomeApplier,
    private readonly settings: PaymentReconciliationSettings
  ) {}

  /** El corte del barrido: un cobro que espera desde antes de este instante lleva demasiado sin desenlace. */
  staleBefore(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.settings.unansweredAfterSeconds * 1000);
  }

  /**
   * @return el estado que dio la pasarela. Con PENDING no se aplica nada: el cobro se queda para la siguiente
   *         pasada. Con el estado del que salió una acción de seguimiento (AUTHORIZED tras capturing o
   *         canceling, CAPTURED tras refunding), la acción no llegó a hacerse y el handler devuelve el cobro a
   *         ese estado.
   */
  async consult(reference: string, gatewayPaymentId: string | null): Promise<GatewayStatus> {
    const outcome = await this.gateway.status(reference, gatewayPaymentId);
    if (outcome.status === GatewayStatus.NOT_FOUND) {
      // La petición no llegó nunca a la pasarela: el cobro falló sin que nadie cobrara nada.
      await this.applier.apply(GatewayOutcome.failed(reference, null, ${F}.${notReceived}));
      return GatewayStatus.NOT_FOUND;
    }
    if (outcome.status !== GatewayStatus.PENDING) await this.applier.apply(outcome);
    return outcome.status;
  }
}`
  );
}

// ─── Infraestructura común ───────────────────────────────────────────────────

function settingsTs() {
  return tsModule(
    SETTINGS_TS,
    [{ symbol: 'Configuration', from: CONFIG_TS, type: true }],
    `/** Token de la configuración de la pasarela ya resuelta. */
export const PAYMENT_GATEWAY_SETTINGS = Symbol('PAYMENT_GATEWAY_SETTINGS');

/**
 * La configuración de la pasarela (config/parameters/<perfil>/payments.yaml, las MISMAS claves y variables que
 * keel-spring). En producción la credencial y el secreto de firma vienen del entorno sin default; en local la
 * URL apunta a la pasarela de prueba de infra/.
 */
export interface PaymentGatewaySettings {
  /** La URL de la API de la pasarela. */
  readonly baseUrl: string;
  /** La credencial con la que se le habla. */
  readonly apiKey: string;
  /** El secreto con el que firma sus avisos. */
  readonly webhookSecret: string;
  /** Cuánto se espera para conectar. */
  readonly connectTimeoutMs: number;
  /** Cuánto se espera la respuesta; superado, la acción queda EN DUDA. */
  readonly readTimeoutMs: number;
  /** La antigüedad máxima de un aviso firmado (contra la repetición). */
  readonly noticeToleranceSeconds: number;
  /** El silencio tolerado antes de que el barrido pregunte por un cobro. */
  readonly unansweredAfterSeconds: number;
}

export function paymentGatewaySettings(configuration: Configuration): PaymentGatewaySettings {
  return {
    baseUrl: required(configuration, 'payments.gateway.base-url').replace(/\\/+$/, ''),
    apiKey: required(configuration, 'payments.gateway.api-key'),
    webhookSecret: required(configuration, 'payments.gateway.webhook-secret'),
    connectTimeoutMs: duration(configuration, 'payments.gateway.connect-timeout', 2000),
    readTimeoutMs: duration(configuration, 'payments.gateway.read-timeout', 10000),
    noticeToleranceSeconds: positive(configuration, 'payments.gateway.notice-tolerance-seconds', 300),
    unansweredAfterSeconds: positive(configuration, 'payments.reconciliation.unanswered-after-seconds', 900)
  };
}

function text(configuration: Configuration, key: string): string | null {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

function required(configuration: Configuration, key: string): string {
  const value = text(configuration, key);
  if (value == null) throw new Error(\`\${key} es obligatoria: sin ella no se le puede hablar a la pasarela\`);
  return value;
}

function positive(configuration: Configuration, key: string, fallback: number): number {
  const value = text(configuration, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(\`\${key} tiene que ser un entero positivo: '\${value}'\`);
  return parsed;
}

const UNITS_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Una duración con la sintaxis de keel-spring, para que el mismo .env valga para los dos servidores: \`2s\`,
 * \`500ms\`, un número a secas (milisegundos) o ISO-8601 (\`PT10S\`).
 */
function duration(configuration: Configuration, key: string, fallbackMs: number): number {
  const value = text(configuration, key);
  if (value == null) return fallbackMs;
  const simple = /^(\\d+)(ns|us|ms|s|m|h|d)?$/.exec(value);
  if (simple) return Number(simple[1]) * UNITS_MS[simple[2] ?? 'ms']!;
  const iso = /^PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?$/i.exec(value);
  if (iso && value.length > 2) return Math.round(Number(iso[1] ?? 0) * 3_600_000 + Number(iso[2] ?? 0) * 60_000 + Number(iso[3] ?? 0) * 1000);
  throw new Error(\`\${key} no es una duración: '\${value}'\`);
}`
  );
}

function gatewayHttpTs() {
  return tsModule(
    GATEWAY_HTTP_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'PAYMENT_GATEWAY_SETTINGS', from: SETTINGS_TS },
      { symbol: 'PaymentGatewaySettings', from: SETTINGS_TS, type: true }
    ],
    `/** Lo que contestó la pasarela: el status y el cuerpo como texto, sin interpretar. */
export interface GatewayAnswer {
  readonly status: number;
  readonly text: string;
}

/** Una petición a la pasarela. */
export interface GatewayRequest {
  readonly method: 'GET' | 'POST';
  /** La ruta con su query ya codificada. */
  readonly path: string;
  /** El cuerpo ya escrito, con su tipo; sin cuerpo en un GET. */
  readonly body?: { readonly contentType: string; readonly text: string };
  /** La cabecera de idempotencia de la pasarela y su clave, en las escrituras. */
  readonly idempotency?: { readonly header: string; readonly key: string };
}

/**
 * La pasarela no contestó: no se pudo conectar, se cortó la respuesta a medias o venció el plazo. NO se sabe qué
 * hizo, y quien llama lo convierte en PaymentGatewayUnavailableException (la acción queda en duda).
 */
export class GatewayNoAnswer extends Error {
  constructor(cause: unknown) {
    super(\`la pasarela no contestó: \${cause instanceof Error ? cause.message : String(cause)}\`, { cause });
    this.name = 'GatewayNoAnswer';
  }
}

/**
 * El cliente HTTP de la pasarela, sobre fetch. Sin reintentos A PROPÓSITO: reintentar una escritura que la
 * pasarela pudo haber hecho es cobrar dos veces. Una respuesta que no llega deja la acción en duda, y eso lo
 * resuelve el barrido preguntando.
 *
 * El plazo es la suma del de conexión y el de lectura de keel-spring: fetch no los distingue, y el total es el
 * mismo tope que el del otro servidor.
 */
@Injectable()
export class PaymentGatewayHttp {
  constructor(@Inject(PAYMENT_GATEWAY_SETTINGS) private readonly settings: PaymentGatewaySettings) {}

  /** @throws GatewayNoAnswer si no llegó una respuesta entera; cualquier status, también 4xx y 5xx, vuelve como respuesta */
  async send(request: GatewayRequest): Promise<GatewayAnswer> {
    const headers: Record<string, string> = { authorization: \`Bearer \${this.settings.apiKey}\`, accept: 'application/json' };
    if (request.body) headers['content-type'] = request.body.contentType;
    if (request.idempotency) headers[request.idempotency.header] = request.idempotency.key;
    try {
      const response = await fetch(\`\${this.settings.baseUrl}\${request.path}\`, {
        method: request.method,
        headers,
        body: request.body?.text,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.settings.connectTimeoutMs + this.settings.readTimeoutMs)
      });
      // El cuerpo se lee DENTRO del try: un corte a mitad de la respuesta también es «no contestó».
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw new GatewayNoAnswer(error);
    }
  }
}`
  );
}

function moneyAmountsTs() {
  const table = Object.entries(CURRENCY_MINOR_UNITS)
    .reduce((lines, [code, digits], index) => {
      if (index % 12 === 0) lines.push([]);
      lines[lines.length - 1].push(`${code}: ${digits}`);
      return lines;
    }, [])
    .map((line) => `  ${line.join(', ')}`)
    .join(',\n');
  return tsModule(
    MONEY_AMOUNTS_TS,
    [{ symbol: 'Decimal', from: DECIMAL_TS }],
    `/**
 * Los decimales de la unidad menor de cada moneda ISO 4217. Es la tabla de keel-core (la del JDK, la que usa el
 * servidor de keel-spring), escrita aquí tal cual a propósito: \`Intl\` (CLDR) discrepa en 25 monedas —IQD da 0
 * decimales en vez de 3—, y los dos servidores del diseño tienen que convertir el mismo importe a la misma unidad.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = {
${table}
};

/**
 * La conversión entre el importe del diseño (decimal en unidades mayores) y el de la pasarela. Nunca redondea:
 * un importe con más decimales de los que admite la moneda es un error, no un céntimo que se pierde.
 */
export const MoneyAmounts = {
  /** Los decimales de la moneda; una que no está en la tabla no se cobra. */
  digitsOf(currency: string): number {
    const digits = MINOR_UNITS[currency];
    if (digits == null) throw new RangeError(\`Moneda desconocida: \${currency}\`);
    return digits;
  },

  /** 12.50 EUR → 1250n. */
  toMinorUnits(amount: Decimal, currency: string): bigint {
    const text = exact(amount, currency).toString().replace('.', '');
    return BigInt(text);
  },

  /** 1250 EUR → 12.50. */
  fromMinorUnits(minor: bigint | number, currency: string): Decimal {
    const digits = MoneyAmounts.digitsOf(currency);
    return Decimal.parse(\`\${BigInt(minor)}e-\${digits}\`);
  },

  /** El importe como lo escribe una pasarela que trabaja en unidades mayores: "12.50". */
  toMajorUnits(amount: Decimal, currency: string): string {
    return exact(amount, currency).toString();
  }
};

/** El importe con la escala exacta de la moneda, o un error si para eso hubiera que redondear. */
function exact(amount: Decimal, currency: string): Decimal {
  const digits = MoneyAmounts.digitsOf(currency);
  const scaled = amount.setScale(digits, 'DOWN');
  if (scaled.compareTo(amount) !== 0) {
    throw new RangeError(\`El importe \${amount.toString()} tiene más decimales de los que admite \${currency}\`);
  }
  return scaled;
}`
  );
}

function noticeVerifierTs() {
  return tsModule(
    NOTICE_VERIFIER_TS,
    [],
    `/**
 * Un aviso de la pasarela tal como llegó: el cuerpo como TEXTO (la firma se calcula sobre él, no sobre un JSON
 * re-serializado), las cabeceras y los parámetros de la URL.
 */
export class PaymentNotice {
  private constructor(
    readonly body: string,
    private readonly headers: ReadonlyMap<string, string>,
    private readonly query: ReadonlyMap<string, string>
  ) {}

  static of(body: string, headers: Readonly<Record<string, unknown>>, query: Readonly<Record<string, unknown>>): PaymentNotice {
    return new PaymentNotice(body, firstValues(headers, true), firstValues(query, false));
  }

  /** Una cabecera, sin distinguir mayúsculas (como HTTP); null si no vino. */
  header(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  /** Un parámetro de la URL; null si no vino. */
  param(name: string): string | null {
    return this.query.get(name) ?? null;
  }
}

function firstValues(values: Readonly<Record<string, unknown>>, lowerCase: boolean): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(values ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) map.set(lowerCase ? key.toLowerCase() : key, String(first));
  }
  return map;
}

/**
 * Verifica un aviso de la pasarela y dice de qué cobro habla. Cada pasarela firma a su manera; la implementación
 * es la de la pasarela elegida. Una clase abstracta porque sirve también de token de inyección.
 */
export abstract class PaymentNoticeVerifier {
  /**
   * @return el id de la pasarela del cobro del que habla el aviso, o null si es un aviso válido que no habla de
   *         ningún cobro
   * @throws InvalidPaymentNoticeException si la firma no verifica o el aviso es demasiado antiguo
   */
  abstract verify(notice: PaymentNotice): string | null;
}`
  );
}

function invalidNoticeTs() {
  return tsModule(
    INVALID_NOTICE_TS,
    [],
    `/** Un aviso que no firma la pasarela, o que llega fuera de su ventana. */
export class InvalidPaymentNoticeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPaymentNoticeException';
  }
}`
  );
}

function noticeControllerTs() {
  return tsModule(
    NOTICE_CONTROLLER_TS,
    [
      { symbol: 'Controller', from: '@nestjs/common' },
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'Post', from: '@nestjs/common' },
      { symbol: 'Req', from: '@nestjs/common' },
      { symbol: 'Res', from: '@nestjs/common' },
      { symbol: 'FastifyReply', from: 'fastify', type: true },
      { symbol: 'FastifyRequest', from: 'fastify', type: true },
      { symbol: 'PaymentNotices', from: PAYMENT_NOTICES_TS },
      { symbol: 'InvalidPaymentNoticeException', from: INVALID_NOTICE_TS },
      { symbol: 'PaymentNotice', from: NOTICE_VERIFIER_TS },
      { symbol: 'PaymentNoticeVerifier', from: NOTICE_VERIFIER_TS }
    ],
    `/** La ruta del aviso. Fuera de la API versionada; la deja pasar sin credencial el plan de acceso neutral. */
export const PAYMENT_NOTICE_PATH = ${tsString(PAYMENT_NOTICE_PATH)};

/**
 * El aviso de la pasarela. Entra sin credencial —quien llama es la pasarela, que no tiene identidad aquí— y lo
 * protege la FIRMA: se verifica sobre el texto tal como llegó antes de hacer nada (el lector JSON del contrato del
 * cable deja pasar esta ruta sin leerla, http-platform.ts). Un aviso que no verifica se responde con 401 y no se
 * consulta nada; uno que verifica tampoco decide nada: el desenlace se le pregunta a la pasarela (PaymentNotices).
 */
@Controller()
export class PaymentNoticeController {
  private readonly logger = new Logger(PaymentNoticeController.name);

  constructor(
    @Inject(PaymentNoticeVerifier) private readonly verifier: PaymentNoticeVerifier,
    @Inject(PaymentNotices) private readonly notices: PaymentNotices
  ) {}

  @Post(PAYMENT_NOTICE_PATH)
  async receive(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const body = typeof request.body === 'string' ? request.body : '';
    const notice = PaymentNotice.of(body, request.headers, (request.query ?? {}) as Record<string, unknown>);
    let gatewayPaymentId: string | null;
    try {
      gatewayPaymentId = this.verifier.verify(notice);
    } catch (error) {
      if (!(error instanceof InvalidPaymentNoticeException)) throw error;
      this.logger.warn(\`Aviso de la pasarela rechazado: \${error.message}\`);
      await reply.status(401).send();
      return;
    }
    if (gatewayPaymentId != null) await this.notices.onNotice(gatewayPaymentId);
    await reply.status(200).send();
  }
}`
  );
}

function paymentsModuleTs(model) {
  const gateway = gatewayModule(model);
  const { adapter, verifier } = gateway.classes(model);
  return tsModule(
    PAYMENTS_MODULE_TS,
    [
      { symbol: 'Global', from: '@nestjs/common' },
      { symbol: 'Module', from: '@nestjs/common' },
      { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
      { symbol: 'Configuration', from: CONFIG_TS, type: true },
      { symbol: 'PAYMENT_GATEWAY_SETTINGS', from: SETTINGS_TS },
      { symbol: 'paymentGatewaySettings', from: SETTINGS_TS },
      { symbol: 'PAYMENT_RECONCILIATION_SETTINGS', from: RECONCILIATION_SETTINGS_TS },
      { symbol: 'PaymentGateway', from: PAYMENT_GATEWAY_TS },
      { symbol: 'PaymentNoticeVerifier', from: NOTICE_VERIFIER_TS },
      { symbol: 'PaymentGatewayHttp', from: GATEWAY_HTTP_TS },
      adapter,
      verifier
    ],
    `/**
 * La pasarela de pago del stack (${model.payments.gateway.label}): su adaptador, su verificador de avisos y la
 * configuración del perfil. Global: los handlers de application inyectan el puerto PaymentGateway, y el módulo
 * de casos de uso, el umbral del barrido. Cambiar de pasarela es regenerar con otra en keel-stack.json.
 */
@Global()
@Module({})
export class PaymentsModule {
  static register(configuration: Configuration): DynamicModule {
    const settings = paymentGatewaySettings(configuration);
    return {
      module: PaymentsModule,
      providers: [
        { provide: PAYMENT_GATEWAY_SETTINGS, useValue: settings },
        { provide: PAYMENT_RECONCILIATION_SETTINGS, useValue: { unansweredAfterSeconds: settings.unansweredAfterSeconds } },
        PaymentGatewayHttp,
        { provide: PaymentGateway, useClass: ${adapter.symbol} },
        { provide: PaymentNoticeVerifier, useClass: ${verifier.symbol} }
      ],
      exports: [PAYMENT_GATEWAY_SETTINGS, PAYMENT_RECONCILIATION_SETTINGS, PaymentGateway, PaymentNoticeVerifier]
    };
  }
}`
  );
}

// ─── config/parameters/<perfil>/payments.yaml ────────────────────────────────

/**
 * Las MISMAS claves, variables y defaults que el payments.yaml de keel-spring (lo compara test/payments.test.js):
 * un mismo .env sirve a los dos servidores. En production la credencial y el secreto no tienen default —un
 * despliegue que los olvide no arranca, en vez de cobrar contra otra cuenta—; en local y test, la pasarela de
 * prueba de infra/ con el secreto que usa el arnés para firmar los avisos.
 */
export function paymentsYaml(model, profile) {
  const gateway = model.payments.gateway;
  const isLocalish = profile === 'local' || profile === 'test';
  const baseUrl = isLocalish ? `http://localhost:${HTTP_STUB.publishedPort}` : gateway.baseUrl;
  const lines = [
    'payments:',
    '  gateway:',
    `    base-url: ${isLocalish ? baseUrl : envWithDefault(profile, gateway.env.baseUrl, gateway.baseUrl)}`,
    `    api-key: ${envValue(profile, gateway.env.apiKey, PAYMENT_TEST_SECRETS.apiKey)}`,
    `    webhook-secret: ${envValue(profile, gateway.env.webhookSecret, PAYMENT_TEST_SECRETS.webhookSecret)}`,
    `    connect-timeout: ${envWithDefault(profile, 'PAYMENT_GATEWAY_CONNECT_TIMEOUT', '2s')}`,
    `    read-timeout: ${envWithDefault(profile, 'PAYMENT_GATEWAY_READ_TIMEOUT', '10s')}`,
    `    notice-tolerance-seconds: ${envWithDefault(profile, 'PAYMENT_NOTICE_TOLERANCE_SECONDS', gateway.webhook.toleranceSeconds)}`,
    '  reconciliation:',
    '    # Lo decide el diseño (payments.reconciliation.unansweredAfterSeconds); en local y test se acorta',
    '    # para que los escenarios del barrido no esperen un cuarto de hora.',
    `    unanswered-after-seconds: ${isLocalish ? 5 : envWithDefault(profile, 'PAYMENT_UNANSWERED_AFTER_SECONDS', model.payments.reconciliation.unansweredAfterSeconds)}`
  ];
  return `${lines.join('\n')}\n`;
}

function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  if (profile === 'local') return String(value);
  return `\${${name}:${value}}`;
}
