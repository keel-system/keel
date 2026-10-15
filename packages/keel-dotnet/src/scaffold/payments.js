// Cobros con pasarela (capa payments, incremento 13). La parte NEUTRA: lo que es igual sea cual sea la pasarela
// elegida; el adaptador y el verificador de cada una los emite su módulo en ./payment-gateways/.
//
// Build genera el puerto, el adaptador y el aviso enteros, como keel-spring y keel-nest y por el mismo criterio que el
// correo: lo que llevan dentro son defensas cuya ausencia no rompe ninguna prueba.
//
//   · La FIRMA del aviso se verifica sobre el texto tal como llegó y en tiempo constante: el endpoint del aviso lee el
//     cuerpo como bytes, sin pasar por el contrato del cable, y lo verifica antes de leer nada.
//   · El aviso NO decide el desenlace: se le pregunta a la pasarela.
//   · La clave de idempotencia sale de la referencia de negocio y de la acción (keel-core/gen/payment-gateways).
//   · El importe se convierte a la unidad de la pasarela con la tabla de unidades menores de keel-core, la del JDK:
//     .NET no trae una tabla ISO 4217 de decimales (RegionInfo no cubre todas las monedas), así que se emite tal cual.
//   · Los rechazos caen en el vocabulario neutro (el enum del motivo de fallo del diseño).
//   · El cliente HTTP NO reintenta: tampoco por debajo (SocketsHttpHandler reenvía por su cuenta una petición cuya
//     conexión se corta, y aquí eso es cobrar dos veces).
//
// Lo que NO genera: la lógica de los casos de uso (cuándo se llama al puerto y qué transición aplica cada handler), que
// es del diseño y la escribe el agente con la skill de la pasarela.

import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, paymentIdempotencyKey, savedMethodIdempotencyKey, SAVED_METHOD_SEPARATOR } from 'keel-core/gen/payment-gateways';
import { PAYMENT_SWEEP_PARAMETERS } from 'keel-core/gen/payments-model';
import { paymentsYaml } from 'keel-core/gen/payments-config';
import { enumMember } from '../lib/cs-projection.js';
import { csFile, csString, located, namespaceOf, solution } from './render.js';
import { componentType, messageComponents, messageNamespace } from './services.js';
import { configNamespace } from './config.js';
import * as stripe from './payment-gateways/stripe.js';
import * as mercadopago from './payment-gateways/mercadopago.js';

const PROFILES = ['local', 'develop', 'production', 'test'];
const GATEWAY_MODULES = { stripe, mercadopago };

export const PAYMENT_GATEWAY_PORT = 'IPaymentGateway';
export const NOTICE_VERIFIER_PORT = 'IPaymentNoticeVerifier';

export function usesPayments(model) {
  return Boolean(model.payments);
}

export function paymentNamespace(model) {
  return namespaceOf(model, 'payment');
}

export function paymentAppNamespace(model) {
  return namespaceOf(model, 'paymentApp');
}

export function paymentInfraNamespace(model) {
  return namespaceOf(model, 'paymentInfra');
}

/** El módulo de la pasarela del stack (adaptador, verificador y los casos de su prueba emitida). */
export function gatewayModule(model) {
  const module = GATEWAY_MODULES[model.payments.gateway.id];
  if (!module) throw new Error(`payments: la pasarela '${model.payments.gateway.id}' no tiene módulo de generación en keel-dotnet`);
  return module;
}

/** El miembro C# de un estado neutro (`ACTION_REQUIRED` → `ActionRequired`). */
export function statusMember(status) {
  return enumMember(String(status).toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()));
}

/** El miembro C# de un motivo neutro (`insufficientFunds` → `InsufficientFunds`), en el enum del motivo del diseño. */
export function reasonMember(model, literal) {
  const entry = model.payments.failureReasons.find((reason) => reason.literal === literal);
  if (!entry) throw new Error(`payments: el motivo '${literal}' no está en el vocabulario del diseño`);
  return `${model.payments.record.failureReasonType}.${enumMember(entry.literal)}`;
}

export function generate(model) {
  if (!usesPayments(model)) return [];
  const p = model.payments;
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const enums = namespaceOf(model, 'enums');
  const domain = paymentNamespace(model);
  const app = paymentAppNamespace(model);
  const ports = namespaceOf(model, 'ports');
  const infra = paymentInfraNamespace(model);
  const gateway = gatewayModule(model);
  const files = [
    file('payment', 'GatewayStatus', [], gatewayStatusBody()),
    file('payment', 'GatewayOutcome', [enums], gatewayOutcomeBody(model)),
    file('payment', 'PaymentSource', [], paymentSourceBody()),
    file('payment', 'ChargeRequest', [], chargeRequestBody(model)),
    file('payment', 'PaymentGatewayUnavailableException', [], unavailableBody()),
    ...(p.savePaymentMethod ? [file('payment', 'GatewayRejectedPaymentMethodException', ['System.Globalization'], methodRejectedBody())] : []),
    file('ports', PAYMENT_GATEWAY_PORT, [domain], portBody(model)),
    outcomeApplierFile(model),
    file('paymentApp', 'PaymentNotices', [domain, ports], noticesBody()),
    file('paymentApp', 'PaymentReconciliationSettings', [], reconciliationSettingsBody(model)),
    file('paymentApp', 'PaymentReconciliation', [domain, enums, ports], reconciliationBody(model)),
    file('paymentInfra', 'PaymentGatewaySettings', ['System.Globalization', 'System.Text.RegularExpressions', configNamespace(model)], settingsBody()),
    file('paymentInfra', 'PaymentGatewayHttp', ['System.Globalization', 'System.Net.Http.Headers', 'System.Net.Sockets', 'System.Runtime.CompilerServices', 'System.Text'], gatewayHttpBody()),
    file('paymentInfra', 'GatewayJson', ['System.Globalization', 'System.Text', 'System.Text.Encodings.Web', 'System.Text.Json', 'System.Text.Json.Nodes'], gatewayJsonBody()),
    file('paymentInfra', 'GatewayKeys', [], gatewayKeysBody()),
    file('paymentInfra', 'MoneyAmounts', ['System.Globalization'], moneyAmountsBody()),
    file('paymentInfra', 'PaymentNotice', [], noticeBody()),
    file('paymentInfra', 'InvalidPaymentNoticeException', [], invalidNoticeBody()),
    file('paymentInfra', 'PaymentsRegistration', ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.DependencyInjection.Extensions', app, ports, namespaceOf(model, gateway.place)], registrationBody(model)),
    noticeEndpointFile(model),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/payments.yaml`, content: paymentsYaml(model, profile) })),
    ...gateway.generate(model),
    paymentTestsFile(model),
    noticeEndpointTestsFile(model)
  ];
  return files;
}

// ─── Dominio: el vocabulario neutro del puerto ───────────────────────────────────────────────────

function gatewayStatusBody() {
  return `/// <summary>
/// El estado de un cobro tal como lo ve la pasarela, en un vocabulario que no depende de cuál sea. Cada adaptador
/// traduce a estos valores los estados de la suya.
/// </summary>
public enum GatewayStatus
{
    /// <summary>La pasarela lo tiene, pero todavía no hay desenlace.</summary>
    Pending,

    /// <summary>Espera a que el cliente se autentique (3DS, redirección).</summary>
    ActionRequired,

    /// <summary>Importe retenido, pendiente de captura.</summary>
    Authorized,

    /// <summary>Cobrado.</summary>
    Captured,

    /// <summary>Devuelto, todo o en parte.</summary>
    Refunded,

    /// <summary>La autorización se anuló o caducó.</summary>
    Canceled,

    /// <summary>El cobro no se hizo.</summary>
    Failed,

    /// <summary>La pasarela no conoce el cobro: la petición no le llegó nunca.</summary>
    NotFound
}`;
}

function gatewayOutcomeBody(model) {
  const F = model.payments.record.failureReasonType;
  return `/// <summary>
/// Lo que la pasarela dice de un cobro, ya traducido. Es la ÚNICA forma en que un desenlace entra en el servicio, venga
/// de la respuesta síncrona, del aviso o del barrido: el aviso no se lee, se consulta.
/// </summary>
public sealed class GatewayOutcome
{
    private GatewayOutcome(GatewayStatus status, string? reference, string? gatewayPaymentId, ${F}? failureReason, string? customerAction, decimal? refundedAmount)
    {
        Status = status;
        Reference = reference;
        GatewayPaymentId = gatewayPaymentId;
        FailureReason = failureReason;
        CustomerAction = customerAction;
        RefundedAmount = refundedAmount;
    }

    /// <summary>El estado neutro.</summary>
    public GatewayStatus Status { get; }

    /// <summary>
    /// La referencia de negocio del cobro, que el adaptador manda a la pasarela y la pasarela devuelve: es lo que
    /// identifica el cobro en este servicio.
    /// </summary>
    public string? Reference { get; }

    /// <summary>El id que asignó la pasarela, o null si no llegó a asignarlo.</summary>
    public string? GatewayPaymentId { get; }

    /// <summary>Con Failed, el motivo en el vocabulario neutro; null en otro caso.</summary>
    public ${F}? FailureReason { get; }

    /// <summary>
    /// Con ActionRequired, la acción del cliente como JSON opaco (la consume el componente de la pasarela en el navegador);
    /// null en otro caso.
    /// </summary>
    public string? CustomerAction { get; }

    /// <summary>Con Refunded, lo devuelto en unidades mayores; null en otro caso.</summary>
    public decimal? RefundedAmount { get; }

    public static GatewayOutcome Of(GatewayStatus status, string? reference, string? gatewayPaymentId) =>
        new(status, reference, gatewayPaymentId, null, null, null);

    public static GatewayOutcome Failed(string? reference, string? gatewayPaymentId, ${F} reason) =>
        new(GatewayStatus.Failed, reference, gatewayPaymentId, reason, null, null);

    public static GatewayOutcome ActionRequired(string? reference, string? gatewayPaymentId, string? customerAction) =>
        new(GatewayStatus.ActionRequired, reference, gatewayPaymentId, null, customerAction, null);

    public static GatewayOutcome Refunded(string? reference, string? gatewayPaymentId, decimal refundedAmount) =>
        new(GatewayStatus.Refunded, reference, gatewayPaymentId, null, null, refundedAmount);

    /// <summary>La pasarela no conoce el cobro: la petición no le llegó nunca.</summary>
    public static GatewayOutcome NotFound(string? reference) => new(GatewayStatus.NotFound, reference, null, null, null, null);
}`;
}

function paymentSourceBody() {
  return `/// <summary>TOKEN si lo produjo el componente de la pasarela con el cliente delante; SAVED si es un medio guardado.</summary>
public enum PaymentSourceKind
{
    Token,
    Saved
}

/// <summary>Con qué se paga, siempre como referencia OPACA de la pasarela. Nunca un dato de tarjeta.</summary>
public sealed class PaymentSource
{
    private PaymentSource(PaymentSourceKind kind, string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Un medio de pago necesita su referencia", nameof(value));
        }
        Kind = kind;
        Value = value;
    }

    public PaymentSourceKind Kind { get; }

    /// <summary>El token, o la referencia que devolvió IPaymentGateway.SavePaymentMethod.</summary>
    public string Value { get; }

    public static PaymentSource Token(string token) => new(PaymentSourceKind.Token, token);

    public static PaymentSource Saved(string gatewayReference) => new(PaymentSourceKind.Saved, gatewayReference);
}`;
}

function chargeRequestBody(model) {
  return `/// <summary>Un cobro a pedir a la pasarela.</summary>
public sealed class ChargeRequest
{
    /// <param name="reference">
    /// La referencia de negocio del cobro (payments.charge.reference: ${model.payments.charge.reference}). De ella sale la clave
    /// de idempotencia hacia la pasarela, y la pasarela la devuelve en cada consulta: es lo que permite reconciliar un
    /// cobro sin respuesta.
    /// </param>
    /// <param name="amount">El importe en unidades mayores (12.50); la conversión es del adaptador.</param>
    /// <param name="currency">ISO 4217.</param>
    /// <param name="source">Con qué se paga.</param>
    public ChargeRequest(string reference, decimal amount, string currency, PaymentSource source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reference);
        ArgumentException.ThrowIfNullOrWhiteSpace(currency);
        ArgumentNullException.ThrowIfNull(source);
        if (amount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(amount), "El importe de un cobro tiene que ser positivo");
        }
        Reference = reference;
        Amount = amount;
        Currency = currency;
        Source = source;
    }

    public string Reference { get; }

    public decimal Amount { get; }

    public string Currency { get; }

    public PaymentSource Source { get; }
}`;
}

function methodRejectedBody() {
  return `/// <summary>
/// La pasarela CONTESTÓ y no acepta el medio de pago que se le pidió guardar (un 4xx). Es una respuesta, no una duda: el
/// caso de uso la traduce al error que declare el diseño. Tiene su propio tipo para que el handler la capture a ella y
/// solo a ella: un fallo de programación que cayera en el mismo catch saldría como un rechazo del medio, y no como el 500
/// que es.
/// </summary>
public sealed class GatewayRejectedPaymentMethodException(int status)
    : Exception(string.Create(CultureInfo.InvariantCulture, $"La pasarela no acepta el medio de pago: HTTP {status}"))
{
    public int Status { get; } = status;
}`;
}

function unavailableBody() {
  return `/// <summary>
/// La pasarela no contestó, o contestó con un error suyo (5xx, timeout, conexión): NO se sabe si hizo lo que se le pidió.
/// La acción se queda en su estado en vuelo y la resuelve el barrido de reconciliación. Lo que no se hace nunca es
/// repetirla a ciegas: puede cobrar o devolver dos veces.
/// </summary>
public sealed class PaymentGatewayUnavailableException(string message, Exception? cause = null) : Exception(message, cause);`;
}

// ─── Puerto ──────────────────────────────────────────────────────────────────────────────────────

function portBody(model) {
  const p = model.payments;
  const ct = 'CancellationToken cancellationToken = default';
  const methods = [
    `    /// <summary>
    /// Pide el cobro (${p.captureLater ? 'solo lo AUTORIZA: flow authorize-capture' : 'autoriza y captura: flow single-step'}). El cobro tiene que estar
    /// registrado ANTES de llamar: si esto lanza, se queda en duda.
    /// </summary>
    /// <exception cref="PaymentGatewayUnavailableException">Si no se sabe qué hizo la pasarela.</exception>
    Task<GatewayOutcome> Authorize(ChargeRequest request, ${ct});`
  ];
  if (p.capture) {
    methods.push(`    /// <summary>
    /// Captura lo autorizado${p.capture.amount ? '; con amount, solo esa parte (el resto se libera), en la moneda del cobro' : ''}. El cobro
    /// tiene que estar ya en su estado en vuelo (${p.capture.inFlight}).
    /// </summary>
    Task<GatewayOutcome> Capture(string reference, string gatewayPaymentId${p.capture.amount ? ', decimal? amount, string? currency' : ''}, ${ct});`);
  }
  if (p.void) {
    methods.push(`    /// <summary>Anula la autorización. El cobro tiene que estar ya en ${p.void.inFlight}.</summary>
    Task<GatewayOutcome> VoidAuthorization(string reference, string gatewayPaymentId, ${ct});`);
  }
  if (p.refund) {
    methods.push(`    /// <summary>
    /// Devuelve lo cobrado${p.refund.amount ? '; con amount null, todo. La moneda es la del cobro: la pasa quien llama, que la conoce, en\n    /// vez de pedírsela a la pasarela con una llamada más' : ''}. El cobro tiene que estar ya en ${p.refund.inFlight}. Si la
    /// pasarela la rechaza, el resultado NO es Refunded.
    /// </summary>
    Task<GatewayOutcome> Refund(string reference, string gatewayPaymentId${p.refund.amount ? ', decimal? amount, string? currency' : ''}, ${ct});`);
  }
  methods.push(`    /// <summary>
    /// El estado de un cobro según la pasarela. Con gatewayPaymentId null —la pasarela no llegó a contestar— se busca por
    /// la referencia, que el adaptador le mandó al pedirlo.
    /// </summary>
    Task<GatewayOutcome> Status(string? reference, string? gatewayPaymentId, ${ct});`);
  if (p.savePaymentMethod) {
    methods.push(`    /// <summary>Guarda un medio de pago para cobrarlo sin el cliente delante.</summary>
    /// <returns>La referencia opaca de la pasarela; no sale nunca del servicio.</returns>
    /// <exception cref="GatewayRejectedPaymentMethodException">Si la pasarela no acepta el medio (captura esta y solo esta).</exception>
    /// <exception cref="PaymentGatewayUnavailableException">Si no se sabe qué hizo la pasarela.</exception>
    Task<string> SavePaymentMethod(string token, string payerReference, ${ct});`);
  }
  return `/// <summary>
/// La pasarela de pago, vista desde los casos de uso. No nombra ninguna: la implementación la eligió build con el stack
/// (keel-stack.json → paymentGateway) y se cambia regenerando, sin tocar el diseño. Este archivo es idéntico con
/// cualquier pasarela.
/// </summary>
public interface ${PAYMENT_GATEWAY_PORT}
{
${methods.join('\n\n')}
}`;
}

// ─── Aplicación: de un desenlace a la operación del diseño que lo aplica ─────────────────────────

/** El tipo C# de lo que da cada hueco del desenlace. */
const SLOT_TYPES = {
  reference: 'string',
  gatewayPaymentId: 'string',
  failureReason: 'reason',
  customerAction: 'string',
  refundedAmount: 'decimal'
};

/** La expresión de un argumento del mensaje de desenlace, ajustada al tipo y a la obligatoriedad del componente. */
function argExpression(model, operation, arg, component, needs) {
  const type = componentType(operation, component, model);
  if (!arg.known) {
    needs.todo = true;
    return `Todo<${type}>(${csString(arg.name)})`;
  }
  const raw = `outcome.${arg.slot[0].toUpperCase()}${arg.slot.slice(1)}`;
  const nullable = type.endsWith('?');
  const valueSlot = SLOT_TYPES[arg.slot] !== 'string';
  // La acción del cliente viaja EMBEBIDA en el mensaje (un campo json del diseño), no como cadena escapada.
  if (component.csType === 'JsonElement') {
    needs.json = true;
    if (nullable) return `${raw} is null ? null : Json(${raw})`;
    needs.required = true;
    return `Json(Required(${raw}, ${csString(arg.name)}))`;
  }
  if (nullable) return raw;
  needs.required = true;
  return `${valueSlot ? 'RequiredValue' : 'Required'}(${raw}, ${csString(arg.name)})`;
}

function outcomeApplierFile(model) {
  const p = model.payments;
  const { namespace, path } = located(model, 'paymentApp', 'PaymentOutcomeApplier');
  const usings = [paymentNamespace(model), namespaceOf(model, 'ports'), namespaceOf(model, 'enums')];
  const operations = new Map(model.services.flatMap((service) => service.operations).map((operation) => [operation.name, operation]));
  const needs = { todo: false, required: false, json: false };
  const cases = p.outcomeCommands.map((command) => {
    const operation = operations.get(command.operation);
    usings.push(messageNamespace(model, operation));
    const components = new Map(messageComponents(operation, model).map((component) => [component.name, component]));
    const props = command.args.map((arg) => {
      const component = components.get(arg.name);
      if (!component) throw new Error(`payments: ${command.operation} no tiene el componente '${arg.name}' que nombra el desenlace`);
      return `                        ${component.name[0].toUpperCase()}${component.name.slice(1)} = ${argExpression(model, operation, arg, component, needs)},`;
    });
    return `            case GatewayStatus.${statusMember(command.status)}:
                await dispatcher.Dispatch(
                    new ${command.messageClass}
                    {
${props.join('\n')}
                    },
                    cancellationToken);
                return;`;
  });
  if (needs.json) usings.push('System.Text.Json');
  const helpers = [];
  if (needs.required) {
    helpers.push(`    /// <summary>Un componente obligatorio de la operación que la pasarela no dio: no se aplica nada a medias.</summary>
    private static T Required<T>(T? value, string component)
        where T : class =>
        value ?? throw new InvalidOperationException($"El desenlace de la pasarela no trae '{component}', que la operación exige");

    private static T RequiredValue<T>(T? value, string component)
        where T : struct =>
        value ?? throw new InvalidOperationException($"El desenlace de la pasarela no trae '{component}', que la operación exige");`);
  }
  if (needs.json) {
    helpers.push(`    /// <summary>La acción del cliente, que el adaptador dejó como JSON opaco, embebida en el mensaje.</summary>
    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }`);
  }
  if (needs.todo) {
    helpers.push(`    /// <summary>
    /// TODO(keel): la capa payments no nombra este componente (CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED), así que build no sabe
    /// de dónde sale en el desenlace de la pasarela. Decídelo aquí; mientras, ese desenlace falla en voz alta.
    /// </summary>
    private static T Todo<T>(string component) =>
        throw new NotImplementedException($"TODO(keel): '{component}' no lo nombra la capa payments: decide su valor en PaymentOutcomeApplier");`);
  }
  const body = `/// <summary>
/// Aplica un desenlace de la pasarela con la operación del diseño que le corresponde (payments.outcomes). Es el único sitio
/// donde un GatewayOutcome se convierte en un cambio del registro, venga de la respuesta síncrona, del aviso o del barrido.
/// </summary>
/// <remarks>
/// Los handlers de esas operaciones tienen que ser IDEMPOTENTES: el mismo desenlace puede llegar por dos caminos, y uno
/// tardío puede encontrar el cobro fuera del estado de origen. En los dos casos no se hace nada y no es un error
/// (docs/dsl/payments.md § Los desenlaces). Dos desenlaces DISTINTOS a la vez los arbitra el bloqueo optimista.
/// </remarks>
public sealed class PaymentOutcomeApplier(ICommandDispatcher dispatcher)
{
    /// <summary>Pending y NotFound no son desenlaces: el llamante decide qué hacer con ellos.</summary>
    public async Task Apply(GatewayOutcome outcome, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        switch (outcome.Status)
        {
${cases.join('\n')}
            default:
                // Sin desenlace que aplicar.
                return;
        }
    }${helpers.length > 0 ? `\n\n${helpers.join('\n\n')}` : ''}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function noticesBody() {
  return `/// <summary>
/// Lo que se hace con un aviso de la pasarela YA VERIFICADO: preguntarle el estado del cobro y aplicar el desenlace. El
/// contenido del aviso no se usa para nada más que para saber de qué cobro habla.
/// </summary>
public sealed class PaymentNotices(${PAYMENT_GATEWAY_PORT} gateway, PaymentOutcomeApplier applier)
{
    public async Task OnNotice(string gatewayPaymentId, CancellationToken cancellationToken = default)
    {
        var outcome = await gateway.Status(null, gatewayPaymentId, cancellationToken);
        if (outcome.Status is GatewayStatus.Pending or GatewayStatus.NotFound)
        {
            return;
        }
        await applier.Apply(outcome, cancellationToken);
    }
}`;
}

function reconciliationSettingsBody(model) {
  return `/// <summary>
/// El silencio tolerado antes de preguntar a la pasarela por un cobro que espera desenlace (${model.payments.reconciliation.sweep}). Lo declara
/// el diseño (payments.reconciliation.unansweredAfterSeconds) y lo lee la configuración
/// (payments.reconciliation.unanswered-after-seconds); en local y test se acorta para que los escenarios del barrido no
/// esperen un cuarto de hora.
/// </summary>
/// <param name="UnansweredAfterSeconds">El silencio tolerado, en segundos.</param>
/// <param name="BatchSize">Cuántos cobros consulta una pasada como máximo (payments.reconciliation.batch-size): capacidad, no diseño.</param>
public sealed record PaymentReconciliationSettings(int UnansweredAfterSeconds, int BatchSize);`;
}

function reconciliationBody(model) {
  const p = model.payments;
  return `/// <summary>
/// La consulta del barrido de reconciliación (${p.reconciliation.sweep}) para UN cobro que espera desenlace: le pregunta a la
/// pasarela y aplica lo que diga.
/// </summary>
/// <remarks>
/// Lo que no hace es elegir los candidatos ni reclamarlos: eso es del handler del barrido. Los candidatos son los cobros en
/// ${p.awaitingStates.join(', ')} cuyo ${p.record.awaitingSince} es anterior a <see cref="StaleBefore()"/>; y el handler reclama cada uno volviendo a
/// estampar ${p.record.awaitingSince} ANTES de llamar aquí, para que otra réplica no lo consulte en la misma pasada.
/// </remarks>
public sealed class PaymentReconciliation(${PAYMENT_GATEWAY_PORT} gateway, PaymentOutcomeApplier applier, PaymentReconciliationSettings settings)
{
    /// <summary>El corte del barrido: un cobro que espera desde antes de este instante lleva demasiado sin desenlace.</summary>
    public DateTimeOffset StaleBefore() => StaleBefore(DateTimeOffset.UtcNow);

    public DateTimeOffset StaleBefore(DateTimeOffset now) => now.AddSeconds(-settings.UnansweredAfterSeconds);

    /// <summary>
    /// Cuántos cobros consulta una pasada como máximo (<c>${PAYMENT_SWEEP_PARAMETERS.batchSize.key}</c>): capacidad, no diseño. Sin cota,
    /// una tanda con miles de atascados son miles de llamadas a la pasarela en una sola pasada.
    /// </summary>
    public int BatchSize() => settings.BatchSize;

    /// <returns>
    /// El estado que dio la pasarela. Con Pending no se aplica nada: el cobro se queda para la siguiente pasada. Con el
    /// estado del que salió una acción de seguimiento (Authorized tras capturing o canceling, Captured tras refunding), la
    /// acción no llegó a hacerse y el handler devuelve el cobro a ese estado.
    /// </returns>
    public async Task<GatewayStatus> Consult(string reference, string? gatewayPaymentId, CancellationToken cancellationToken = default)
    {
        var outcome = await gateway.Status(reference, gatewayPaymentId, cancellationToken);
        if (outcome.Status == GatewayStatus.NotFound)
        {
            // La petición no llegó nunca a la pasarela: el cobro falló sin que nadie cobrara nada.
            await applier.Apply(GatewayOutcome.Failed(reference, null, ${reasonMember(model, 'notReceived')}), cancellationToken);
            return GatewayStatus.NotFound;
        }
        if (outcome.Status != GatewayStatus.Pending)
        {
            await applier.Apply(outcome, cancellationToken);
        }
        return outcome.Status;
    }
}`;
}

// ─── Infraestructura común ───────────────────────────────────────────────────────────────────────

function settingsBody() {
  return String.raw`/// <summary>
/// La configuración de la pasarela (config/parameters/&lt;perfil&gt;/payments.yaml, las MISMAS claves y variables que
/// keel-spring y keel-nest). En producción la credencial y el secreto de firma vienen del entorno sin default; en local
/// la URL apunta a la pasarela de prueba de infra/.
/// </summary>
/// <param name="BaseUrl">La URL de la API de la pasarela, sin la barra final.</param>
/// <param name="ApiKey">La credencial con la que se le habla.</param>
/// <param name="WebhookSecret">El secreto con el que firma sus avisos.</param>
/// <param name="ConnectTimeout">Cuánto se espera para conectar.</param>
/// <param name="ReadTimeout">Cuánto se espera la respuesta; superado, la acción queda EN DUDA.</param>
/// <param name="NoticeToleranceSeconds">La antigüedad máxima de un aviso firmado (contra la repetición).</param>
/// <param name="UnansweredAfterSeconds">El silencio tolerado antes de que el barrido pregunte por un cobro.</param>
/// <param name="BatchSize">Cuántos cobros consulta una pasada del barrido como máximo.</param>
public sealed partial record PaymentGatewaySettings(
    string BaseUrl,
    string ApiKey,
    string WebhookSecret,
    TimeSpan ConnectTimeout,
    TimeSpan ReadTimeout,
    int NoticeToleranceSeconds,
    int UnansweredAfterSeconds,
    int BatchSize)
{
    public static PaymentGatewaySettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new PaymentGatewaySettings(
            Required(configuration, "payments:gateway:base-url").TrimEnd('/'),
            Required(configuration, "payments:gateway:api-key"),
            Required(configuration, "payments:gateway:webhook-secret"),
            Duration(configuration, "payments:gateway:connect-timeout", TimeSpan.FromSeconds(2)),
            Duration(configuration, "payments:gateway:read-timeout", TimeSpan.FromSeconds(10)),
            Positive(configuration, "payments:gateway:notice-tolerance-seconds", 300),
            Positive(configuration, "PAYMENT_UNANSWERED_KEY", 900),
            Positive(configuration, "PAYMENT_BATCH_KEY", PAYMENT_BATCH_DEFAULT));
    }

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    private static string Required(ServiceConfiguration configuration, string key) =>
        Text(configuration, key) ?? throw new InvalidOperationException($"{key.Replace(':', '.')} es obligatoria: sin ella no se le puede hablar a la pasarela");

    private static int Positive(ServiceConfiguration configuration, string key, int fallback)
    {
        var value = Text(configuration, key);
        if (value is null)
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un entero positivo: '{value}'");
    }

    /// <summary>
    /// Una duración con la sintaxis de keel-spring, para que el mismo .env valga para los tres servidores: <c>2s</c>,
    /// <c>500ms</c>, un número a secas (milisegundos) o ISO-8601 (<c>PT10S</c>).
    /// </summary>
    private static TimeSpan Duration(ServiceConfiguration configuration, string key, TimeSpan fallback)
    {
        var value = Text(configuration, key);
        if (value is null)
        {
            return fallback;
        }
        var simple = SimpleDuration().Match(value);
        if (simple.Success)
        {
            var amount = double.Parse(simple.Groups[1].Value, CultureInfo.InvariantCulture);
            return simple.Groups[2].Value switch
            {
                "ns" => TimeSpan.FromMilliseconds(amount / 1_000_000),
                "us" => TimeSpan.FromMilliseconds(amount / 1000),
                "s" => TimeSpan.FromSeconds(amount),
                "m" => TimeSpan.FromMinutes(amount),
                "h" => TimeSpan.FromHours(amount),
                "d" => TimeSpan.FromDays(amount),
                _ => TimeSpan.FromMilliseconds(amount)
            };
        }
        var iso = IsoDuration().Match(value);
        if (iso.Success && value.Length > 2)
        {
            double Part(int group) => iso.Groups[group].Success ? double.Parse(iso.Groups[group].Value, CultureInfo.InvariantCulture) : 0;
            return TimeSpan.FromHours(Part(1)) + TimeSpan.FromMinutes(Part(2)) + TimeSpan.FromSeconds(Part(3));
        }
        throw new InvalidOperationException($"{key.Replace(':', '.')} no es una duración: '{value}'");
    }

    [GeneratedRegex(@"^(\d+)(ns|us|ms|s|m|h|d)?$")]
    private static partial Regex SimpleDuration();

    [GeneratedRegex(@"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$", RegexOptions.IgnoreCase)]
    private static partial Regex IsoDuration();
}`
    .replace('"PAYMENT_UNANSWERED_KEY"', csString(PAYMENT_SWEEP_PARAMETERS.unansweredAfterSeconds.key.replaceAll('.', ':')))
    .replace('"PAYMENT_BATCH_KEY"', csString(PAYMENT_SWEEP_PARAMETERS.batchSize.key.replaceAll('.', ':')))
    .replace('PAYMENT_BATCH_DEFAULT', String(PAYMENT_SWEEP_PARAMETERS.batchSize.default));
}

function gatewayHttpBody() {
  return String.raw`/// <summary>Lo que contestó la pasarela: el status y el cuerpo como texto, sin interpretar.</summary>
public sealed record GatewayAnswer(int Status, string Text);

/// <summary>El cuerpo de una petición ya escrito, con su tipo.</summary>
public sealed record GatewayBody(string ContentType, string Text);

/// <summary>
/// Una petición a la pasarela: el método, la ruta con su query ya codificada, el cuerpo (ninguno en un GET) y, en las
/// escrituras, la cabecera de idempotencia de la pasarela con su clave.
/// </summary>
public sealed record GatewayRequest(string Method, string Path, GatewayBody? Body = null, KeyValuePair<string, string>? Idempotency = null);

/// <summary>
/// La pasarela no contestó: no se pudo conectar, se cortó la respuesta a medias o venció el plazo. NO se sabe qué hizo, y
/// quien llama lo convierte en PaymentGatewayUnavailableException (la acción queda en duda).
/// </summary>
public sealed class GatewayNoAnswerException(string message, Exception cause) : Exception(message, cause);

/// <summary>
/// El cliente HTTP de la pasarela. Sin reintentos A PROPÓSITO: reintentar una escritura que la pasarela pudo haber hecho es
/// cobrar dos veces. Una respuesta que no llega deja la acción en duda, y eso lo resuelve el barrido preguntando.
/// </summary>
/// <remarks>
/// Tampoco reintenta el transporte por debajo: SocketsHttpHandler reenvía por su cuenta una petición cuya conexión se corta
/// antes de la respuesta (medido en los clientes salientes: un DELETE llegaba CUATRO veces). Cada petición va en su propia
/// conexión (<c>Connection: close</c>) y <see cref="DefaultHandler"/> no deja abrir una segunda para la misma. El plazo
/// es la suma del de conexión y el de lectura, el mismo tope que el de los otros dos servidores.
/// </remarks>
public sealed class PaymentGatewayHttp(PaymentGatewaySettings settings, HttpMessageHandler handler) : IDisposable
{
    private static readonly HttpRequestOptionsKey<StrongBox<int>> OpenedConnections = new("keel.payment-connections");

    private readonly HttpClient http = new(handler, disposeHandler: true) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    /// <summary>El manejador del servidor: sin redirecciones, con el plazo de conexión de la configuración y sin reintentos propios.</summary>
    public static SocketsHttpHandler DefaultHandler(PaymentGatewaySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = settings.ConnectTimeout,
            ConnectCallback = async (context, cancellationToken) =>
            {
                if (context.InitialRequestMessage.Options.TryGetValue(OpenedConnections, out var opened) && Interlocked.Increment(ref opened.Value) > 1)
                {
                    throw new IOException("el transporte no reintenta por su cuenta: una escritura a la pasarela no se repite");
                }
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(context.DnsEndPoint, cancellationToken);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
        };
    }

    /// <summary>Envía la petición. Cualquier status, también 4xx y 5xx, vuelve como respuesta.</summary>
    /// <exception cref="GatewayNoAnswerException">Si no llegó una respuesta entera.</exception>
    public async Task<GatewayAnswer> Send(GatewayRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        using var message = new HttpRequestMessage(new HttpMethod(request.Method), new Uri(settings.BaseUrl + request.Path));
        message.Headers.ConnectionClose = true;
        message.Options.Set(OpenedConnections, new StrongBox<int>(0));
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.ApiKey);
        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (request.Idempotency is { } idempotency)
        {
            message.Headers.TryAddWithoutValidation(idempotency.Key, idempotency.Value);
        }
        if (request.Body is { } body)
        {
            message.Content = new StringContent(body.Text, Encoding.UTF8, new MediaTypeHeaderValue(body.ContentType));
            // Sin «; charset=utf-8»: la pasarela recibe el tipo tal cual, como de los otros dos servidores.
            message.Content.Headers.ContentType = new MediaTypeHeaderValue(body.ContentType);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(settings.ConnectTimeout + settings.ReadTimeout);
        try
        {
            using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            // El cuerpo se lee DENTRO del try: un corte a mitad de la respuesta también es «no contestó».
            return new GatewayAnswer((int)response.StatusCode, await response.Content.ReadAsStringAsync(timeout.Token));
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new GatewayNoAnswerException(
                string.Create(CultureInfo.InvariantCulture, $"la pasarela no contestó en {(settings.ConnectTimeout + settings.ReadTimeout).TotalMilliseconds} ms"),
                error);
        }
        catch (Exception error) when (error is HttpRequestException or IOException)
        {
            throw new GatewayNoAnswerException($"la pasarela no contestó: {error.Message}", error);
        }
    }

    public void Dispose() => http.Dispose();
}`;
}

function gatewayJsonBody() {
  return String.raw`/// <summary>
/// La lectura y la escritura de lo que se cruza con la pasarela, igual para todas: el JSON se lee como lo leen los otros
/// dos servidores (un campo que falta, que es null o que no es un escalar no tiene valor; un número vale su texto) y se
/// escribe sin espacios y sin escapar lo que no hace falta.
/// </summary>
public static class GatewayJson
{
    /// <summary>Las opciones de escritura: compacto y sin escapar lo que no es ASCII ni lo que es HTML.</summary>
    public static JsonSerializerOptions Options { get; } = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>El cuerpo de la pasarela como objeto; vacío si no trae nada o no es un objeto.</summary>
    /// <exception cref="InvalidOperationException">Si el cuerpo no es JSON: un 500, no una duda.</exception>
    public static JsonElement Parse(string? text, string gateway)
    {
        try
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.Clone() : Empty();
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"{gateway} devolvió un cuerpo que no es JSON", error);
        }
    }

    /// <summary>Un objeto vacío.</summary>
    public static JsonElement Empty()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    /// <summary>Una propiedad de un objeto, o null si falta o no es un objeto lo que se mira.</summary>
    public static JsonElement? Get(JsonElement node, string name) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty(name, out var value) ? value : null;

    /// <summary>Una propiedad que es un objeto, o un objeto vacío.</summary>
    public static JsonElement Object(JsonElement node, string name) =>
        Get(node, name) is { ValueKind: JsonValueKind.Object } value ? value : Empty();

    /// <summary>¿La propiedad es un objeto?</summary>
    public static bool IsObject(JsonElement node, string name) => Get(node, name) is { ValueKind: JsonValueKind.Object };

    /// <summary>Los elementos de una propiedad que es una lista; ninguno si no lo es.</summary>
    public static IReadOnlyList<JsonElement> Array(JsonElement node, string name) =>
        Get(node, name) is { ValueKind: JsonValueKind.Array } value ? [.. value.EnumerateArray()] : [];

    /// <summary>Un escalar como texto: una cadena, un número (su texto) o un booleano. Lo demás, null.</summary>
    public static string? Text(JsonElement node, string name) => Get(node, name) is { } value ? Text(value) : null;

    public static string? Text(JsonElement value) =>
        value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };

    /// <summary>Un importe entero (unidad menor). Uno que falta o no es entero es 0, como el asLong() de keel-spring.</summary>
    public static long Minor(JsonElement node, string name) =>
        Text(node, name) is { } text && long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value) ? value : 0;

    /// <summary>Un valor JSON reescrito compacto, como JSON.stringify.</summary>
    public static string Compact(JsonElement value)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            value.WriteTo(writer);
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>Un objeto escrito con el orden de sus propiedades; un valor null se escribe como null.</summary>
    public static string Write(IEnumerable<KeyValuePair<string, JsonElement?>> properties)
    {
        ArgumentNullException.ThrowIfNull(properties);
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            foreach (var (name, value) in properties)
            {
                writer.WritePropertyName(name);
                if (value is { } present)
                {
                    present.WriteTo(writer);
                }
                else
                {
                    writer.WriteNullValue();
                }
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>Un texto como valor JSON (o null).</summary>
    public static JsonElement? Value(string? text) => text is null ? null : JsonSerializer.SerializeToElement(text, Options);

    /// <summary>Un cuerpo JSON.</summary>
    public static GatewayBody JsonBody(JsonNode body)
    {
        ArgumentNullException.ThrowIfNull(body);
        return new GatewayBody("application/json", body.ToJsonString(Options));
    }

    /// <summary>
    /// Un cuerpo application/x-www-form-urlencoded, en el orden dado y con la codificación de un formulario (el espacio como
    /// <c>+</c>), como URLSearchParams y FormUrlEncodedContent.
    /// </summary>
    public static GatewayBody FormBody(IEnumerable<KeyValuePair<string, string>> fields) =>
        new("application/x-www-form-urlencoded", Form(fields));

    /// <summary>Los pares codificados como formulario: también la query de una URL.</summary>
    public static string Form(IEnumerable<KeyValuePair<string, string>> fields)
    {
        ArgumentNullException.ThrowIfNull(fields);
        return string.Join('&', fields.Select(field => $"{Encode(field.Key)}={Encode(field.Value)}"));
    }

    private static string Encode(string value) => Uri.EscapeDataString(value).Replace("%20", "+", StringComparison.Ordinal);
}`;
}

function gatewayKeysBody() {
  return `/// <summary>
/// Las claves que viajan a la pasarela, las MISMAS que mandan los otros dos servidores del diseño (keel-core/gen/payment-gateways):
/// un reintento por cualquiera de las dos puertas y por cualquiera de los tres servidores repite la clave.
/// </summary>
public static class GatewayKeys
{
    /// <summary>El separador de la referencia de un medio guardado: <c>&lt;cliente&gt;${SAVED_METHOD_SEPARATOR}&lt;medio&gt;</c>.</summary>
    public const char SavedMethodSeparator = '${SAVED_METHOD_SEPARATOR}';

    /// <summary>La clave de una acción sobre un cobro: sale de la referencia de NEGOCIO, nunca de un aleatorio.</summary>
    public static string Idempotency(string reference, string action) => $"${paymentIdempotencyKey('{reference}', '{action}')}";

    /// <summary>La clave de cada paso de guardar un medio de pago.</summary>
    public static string SavedMethod(string token, string step) => $"${savedMethodIdempotencyKey('{token}', '{step}')}";

    /// <summary>La referencia opaca de un medio guardado, a partir de sus dos ids.</summary>
    public static string Saved(string customer, string method) => customer + SavedMethodSeparator + method;

    /// <summary>Los dos ids de la referencia de un medio guardado.</summary>
    public static (string Customer, string Method) SplitSaved(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var at = value.IndexOf(SavedMethodSeparator, StringComparison.Ordinal);
        return at < 0
            ? throw new ArgumentException($"Un medio guardado es \\"<cliente>{SavedMethodSeparator}<medio>\\": esta referencia no lo es", nameof(value))
            : (value[..at], value[(at + 1)..]);
    }

    /// <summary>La moneda de un importe parcial, que quien llama tiene que dar.</summary>
    public static string RequiredCurrency(string? currency) =>
        currency ?? throw new ArgumentException("Un importe parcial necesita la moneda del cobro", nameof(currency));
}`;
}

function moneyAmountsBody() {
  const entries = Object.entries(CURRENCY_MINOR_UNITS);
  const lines = [];
  for (let index = 0; index < entries.length; index += 8) {
    lines.push(`        ${entries.slice(index, index + 8).map(([code, digits]) => `[${csString(code)}] = ${digits}`).join(', ')},`);
  }
  return `/// <summary>
/// La conversión entre el importe del diseño (decimal en unidades mayores) y el de la pasarela. Nunca redondea: un importe
/// con más decimales de los que admite la moneda es un error, no un céntimo que se pierde.
/// </summary>
public static class MoneyAmounts
{
    /// <summary>
    /// Los decimales de la unidad menor de cada moneda ISO 4217. Es la tabla de keel-core (la del JDK, la que usa el
    /// servidor de keel-spring), escrita aquí tal cual a propósito: los tres servidores del diseño tienen que convertir el
    /// mismo importe a la misma unidad, y .NET no trae una tabla completa.
    /// </summary>
    private static readonly Dictionary<string, int> MinorUnits = new(StringComparer.Ordinal)
    {
${lines.join('\n')}
    };

    /// <summary>Los decimales de la moneda; una que no está en la tabla no se cobra.</summary>
    public static int DigitsOf(string currency)
    {
        ArgumentNullException.ThrowIfNull(currency);
        return MinorUnits.TryGetValue(currency, out var digits)
            ? digits
            : throw new ArgumentException($"Moneda desconocida: {currency}", nameof(currency));
    }

    /// <summary>12.50 EUR → 1250.</summary>
    public static long ToMinorUnits(decimal amount, string currency)
    {
        var digits = DigitsOf(currency);
        Exact(amount, digits, currency);
        return decimal.ToInt64(amount * Pow10(digits));
    }

    /// <summary>1250 EUR → 12.50, con la escala de la moneda.</summary>
    public static decimal FromMinorUnits(long minor, string currency)
    {
        var digits = DigitsOf(currency);
        var magnitude = minor < 0 ? (ulong)(-(minor + 1)) + 1 : (ulong)minor;
        return new decimal((int)(magnitude & 0xFFFFFFFF), (int)(magnitude >> 32), 0, minor < 0, (byte)digits);
    }

    /// <summary>El importe como lo escribe una pasarela que trabaja en unidades mayores: "12.50".</summary>
    public static string ToMajorUnits(decimal amount, string currency)
    {
        var digits = DigitsOf(currency);
        Exact(amount, digits, currency);
        return amount.ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
    }

    /// <summary>Un importe que para ir en la unidad de la moneda habría que redondear es un error.</summary>
    private static void Exact(decimal amount, int digits, string currency)
    {
        if (decimal.Round(amount, digits, MidpointRounding.ToZero) != amount)
        {
            throw new ArgumentOutOfRangeException(nameof(amount), amount, $"El importe tiene más decimales de los que admite {currency}");
        }
    }

    private static decimal Pow10(int digits)
    {
        var result = 1m;
        for (var i = 0; i < digits; i++)
        {
            result *= 10;
        }
        return result;
    }
}`;
}

function noticeBody() {
  return `/// <summary>
/// Un aviso de la pasarela tal como llegó: el cuerpo como TEXTO (la firma se calcula sobre él, no sobre un JSON
/// re-serializado), las cabeceras y los parámetros de la URL.
/// </summary>
public sealed class PaymentNotice
{
    private readonly Dictionary<string, string> headers;

    private readonly Dictionary<string, string> query;

    private PaymentNotice(string body, Dictionary<string, string> headers, Dictionary<string, string> query)
    {
        Body = body;
        this.headers = headers;
        this.query = query;
    }

    public string Body { get; }

    /// <summary>El aviso, con el PRIMER valor de cada cabecera y de cada parámetro.</summary>
    public static PaymentNotice Of(string? body, IEnumerable<KeyValuePair<string, string?>> headers, IEnumerable<KeyValuePair<string, string?>> query) =>
        new(body ?? string.Empty, FirstValues(headers, StringComparer.OrdinalIgnoreCase), FirstValues(query, StringComparer.Ordinal));

    /// <summary>Una cabecera, sin distinguir mayúsculas (como HTTP); null si no vino.</summary>
    public string? Header(string name) => headers.TryGetValue(name, out var value) ? value : null;

    /// <summary>Un parámetro de la URL; null si no vino.</summary>
    public string? Param(string name) => query.TryGetValue(name, out var value) ? value : null;

    private static Dictionary<string, string> FirstValues(IEnumerable<KeyValuePair<string, string?>> values, StringComparer comparer)
    {
        var map = new Dictionary<string, string>(comparer);
        foreach (var (key, value) in values ?? [])
        {
            if (value is not null)
            {
                map.TryAdd(key, value);
            }
        }
        return map;
    }
}

/// <summary>Verifica un aviso de la pasarela y dice de qué cobro habla. Cada pasarela firma a su manera.</summary>
public interface ${NOTICE_VERIFIER_PORT}
{
    /// <returns>El id de la pasarela del cobro del que habla el aviso, o null si es un aviso válido que no habla de ningún cobro.</returns>
    /// <exception cref="InvalidPaymentNoticeException">Si la firma no verifica o el aviso es demasiado antiguo.</exception>
    string? Verify(PaymentNotice notice);
}`;
}

function invalidNoticeBody() {
  return `/// <summary>Un aviso que no firma la pasarela, o que llega fuera de su ventana.</summary>
public sealed class InvalidPaymentNoticeException(string message) : Exception(message);`;
}

function registrationBody(model) {
  const gateway = gatewayModule(model);
  return `/// <summary>
/// La pasarela de pago del stack (${model.payments.gateway.label}) en el contenedor: su adaptador, su verificador de avisos, la
/// configuración del perfil y las clases de aplicación que la usan. Cambiar de pasarela es regenerar con otra en
/// keel-stack.json.
/// </summary>
public static class PaymentsRegistration
{
    public static IServiceCollection AddPayments(this IServiceCollection services, PaymentGatewaySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddSingleton(new PaymentReconciliationSettings(settings.UnansweredAfterSeconds, settings.BatchSize));
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton(provider => new PaymentGatewayHttp(settings, PaymentGatewayHttp.DefaultHandler(settings)));
        services.AddSingleton<${PAYMENT_GATEWAY_PORT}, ${gateway.adapterClass}>();
        services.AddSingleton<${NOTICE_VERIFIER_PORT}, ${gateway.verifierClass}>();
        // Lo de aplicación va por petición, como el despachador con el que aplica cada desenlace.
        services.AddScoped<PaymentOutcomeApplier>();
        services.AddScoped<PaymentNotices>();
        services.AddScoped<PaymentReconciliation>();
        return services;
    }
}`;
}

// ─── La entrada del aviso (Api) ──────────────────────────────────────────────────────────────────

function noticeEndpointFile(model) {
  const { namespace, path } = located(model, 'rest', 'PaymentNoticeEndpoint');
  const usings = ['System.Text', 'Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Logging', paymentAppNamespace(model), paymentInfraNamespace(model)];
  const body = `/// <summary>
/// El aviso de la pasarela. Entra sin credencial —quien llama es la pasarela, que no tiene identidad aquí; el plan de acceso
/// neutral deja pasar esta ruta— y lo protege la FIRMA: se verifica sobre el cuerpo tal como llegó, leído como texto y sin
/// pasar por el contrato del cable, antes de hacer nada. Un aviso que no verifica se responde con 401 vacío y no se
/// consulta nada; uno que verifica tampoco decide nada: el desenlace se le pregunta a la pasarela (PaymentNotices).
/// </summary>
public static partial class PaymentNoticeEndpoint
{
    /// <summary>La ruta del aviso. Fuera de la API versionada: es la URL que se registra en el panel de la pasarela.</summary>
    public const string Path = ${csString(PAYMENT_NOTICE_PATH)};

    public static IEndpointRouteBuilder MapPaymentNotice(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(Path, (RequestDelegate)Receive);
        return endpoints;
    }

    private static async Task Receive(HttpContext context)
    {
        string body;
        using (var reader = new StreamReader(context.Request.Body, Encoding.UTF8))
        {
            body = await reader.ReadToEndAsync(context.RequestAborted);
        }
        var notice = PaymentNotice.Of(
            body,
            context.Request.Headers.Select(header => new KeyValuePair<string, string?>(header.Key, header.Value.FirstOrDefault())),
            context.Request.Query.Select(param => new KeyValuePair<string, string?>(param.Key, param.Value.FirstOrDefault())));
        string? gatewayPaymentId;
        try
        {
            gatewayPaymentId = context.RequestServices.GetRequiredService<${NOTICE_VERIFIER_PORT}>().Verify(notice);
        }
        catch (InvalidPaymentNoticeException rejected)
        {
            LogRejected(context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(PaymentNoticeEndpoint)), rejected.Message);
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        if (gatewayPaymentId is not null)
        {
            await context.RequestServices.GetRequiredService<PaymentNotices>().OnNotice(gatewayPaymentId, context.RequestAborted);
        }
        context.Response.StatusCode = StatusCodes.Status200OK;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Aviso de la pasarela rechazado: {Reason}")]
    private static partial void LogRejected(ILogger logger, string reason);
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── La prueba emitida: el adaptador y el verificador EJECUTADOS contra una pasarela falsa ────────

function paymentTestsFile(model) {
  const sln = solution(model);
  const gateway = gatewayModule(model);
  const cases = gateway.testCases(model);
  const usings = [
    'System.Globalization',
    'System.Net',
    'System.Security.Cryptography',
    'System.Text',
    'Xunit',
    paymentNamespace(model),
    paymentInfraNamespace(model),
    namespaceOf(model, 'enums'),
    namespaceOf(model, gateway.place),
    ...(cases.usings ?? [])
  ];
  const body = `/// <summary>
/// La pasarela de pago EJECUTADA sin red: el adaptador de ${model.payments.gateway.label} y su verificador de avisos contra una
/// pasarela falsa que contesta con las formas del doble de infra/ (keel-core/gen/payment-probes.js). Lo que dice la
/// pasarela DE VERDAD lo mide su sandbox (la skill de la pasarela).
/// </summary>
public sealed class PaymentGatewayTests
{
    private static readonly PaymentGatewaySettings Settings = new(
        "http://pasarela.test", "clave", "secreto", TimeSpan.FromMilliseconds(200), TimeSpan.FromMilliseconds(300), 300, 900, 50);

    /// <summary>Una pasarela falsa: contesta lo que diga <c>answer</c> y guarda cada petición con su cuerpo.</summary>
    private sealed class FakeGateway(Func<HttpRequestMessage, string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add((request, body));
            return answer(request, body);
        }

        public static FakeGateway Json(HttpStatusCode status, string json) => new((_, _) => Reply(status, json));

        public static FakeGateway Cut() => new((_, _) => throw new HttpRequestException("conexión cortada"));
    }

    /// <summary>Una pasarela que no contesta nunca: solo la suelta el plazo del cliente.</summary>
    private sealed class SilentGateway : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }

    private static HttpResponseMessage Reply(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    /// <summary>Un reloj fijo, para medir la ventana del aviso.</summary>
    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);

    private static ${gateway.adapterClass} Gateway(FakeGateway fake) => new(new PaymentGatewayHttp(Settings, fake));

    private static ${gateway.verifierClass} Verifier() => new(Settings, new FixedClock(Now));

    private static string Hmac(string text) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Settings.WebhookSecret), Encoding.UTF8.GetBytes(text)));

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    [Fact]
    public void LasUnidadesMenoresSonLasDeKeelCoreYNoSeRedondea()
    {
        Assert.Equal(1250, MoneyAmounts.ToMinorUnits(12.50m, "EUR"));
        Assert.Equal(12500, MoneyAmounts.ToMinorUnits(12.5m, "IQD"));
        Assert.Equal(1250, MoneyAmounts.ToMinorUnits(1250m, "JPY"));
        Assert.Equal("12.50", MoneyAmounts.FromMinorUnits(1250, "EUR").ToString(CultureInfo.InvariantCulture));
        Assert.Equal("12.500", MoneyAmounts.FromMinorUnits(12500, "IQD").ToString(CultureInfo.InvariantCulture));
        Assert.Equal("12.500", MoneyAmounts.ToMajorUnits(12.5m, "IQD"));
        Assert.Throws<ArgumentOutOfRangeException>(() => MoneyAmounts.ToMinorUnits(12.505m, "EUR"));
        Assert.Throws<ArgumentException>(() => MoneyAmounts.DigitsOf("XXX"));
    }

    [Fact]
    public void LaClaveDeIdempotenciaEsLaDeKeelCore()
    {
        Assert.Equal(${csString(paymentIdempotencyKey('ch-1', 'authorize'))}, GatewayKeys.Idempotency("ch-1", "authorize"));
        Assert.Equal(${csString(savedMethodIdempotencyKey('tok', 'customer'))}, GatewayKeys.SavedMethod("tok", "customer"));
    }

    [Fact]
    public async Task UnErrorDeLaPasarelaDejaLaAccionEnDudaYNoSeReintenta()
    {
        var fake = FakeGateway.Json(HttpStatusCode.ServiceUnavailable, "{}");
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Authorize(Charge("ch-5xx"), Token));
        Assert.Single(fake.Requests);
    }

    [Fact]
    public async Task UnCorteDeConexionDejaLaAccionEnDuda()
    {
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(FakeGateway.Cut()).Authorize(Charge("ch-cut"), Token));
    }

    [Fact]
    public async Task UnaPasarelaQueNoContestaATiempoDejaLaAccionEnDuda()
    {
        using var http = new PaymentGatewayHttp(Settings, new SilentGateway());
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => new ${gateway.adapterClass}(http).Authorize(Charge("ch-slow"), Token));
    }

    [Fact]
    public async Task UnImporteConMasDecimalesQueLaMonedaNoSeManda()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, "{}");
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => Gateway(fake).Authorize(new ChargeRequest("ch-dec", 12.505m, "EUR", PaymentSource.Token("tok")), Token));
        Assert.Empty(fake.Requests);
    }

    [Fact]
    public async Task LoQueLaPasarelaNoConoceEsNotFound()
    {
        var outcome = await Gateway(FakeGateway.Json(HttpStatusCode.NotFound, "{}")).Status("ch-x", "id-x", Token);
        Assert.Equal(GatewayStatus.NotFound, outcome.Status);
        Assert.Equal("ch-x", outcome.Reference);
    }

    [Fact]
    public void SinCabeceraDeFirmaNoSeMiraNadaMas()
    {
        Assert.Throws<InvalidPaymentNoticeException>(() => Verifier().Verify(PaymentNotice.Of("{}", [], [])));
    }

    private static ChargeRequest Charge(string reference) => new(reference, 12.50m, "EUR", PaymentSource.Token("tok_visa"));
${cases.body}
}`;
  return { path: `${sln.unitTests.dir}/PaymentGatewayTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

/**
 * El aviso de punta a punta, en el servidor en memoria del perfil test: la ruta entra sin credencial y solo por POST, un
 * aviso sin firma se responde con 401 VACÍO (el ResponseEntity de keel-spring, el reply de keel-nest) y uno firmado con el
 * secreto del perfil se acepta. Firma con el secreto de prueba compartido (keel-core: PAYMENT_TEST_SECRETS).
 */
function noticeEndpointTestsFile(model) {
  const sln = solution(model);
  const gateway = gatewayModule(model);
  const body = `/// <summary>El aviso de la pasarela por HTTP, en el servidor en memoria: sin credencial, solo POST y protegido por la firma.</summary>
public sealed class PaymentNoticeEndpointTests(InMemoryServer server) : IClassFixture<InMemoryServer>
{
    /// <summary>El secreto con el que firma la pasarela de prueba (config/parameters/test/payments.yaml).</summary>
    private const string Secret = ${csString(PAYMENT_TEST_SECRETS.webhookSecret)};

    private const string Path = ${csString(PAYMENT_NOTICE_PATH)};

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    private static string Hmac(string text) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes(text)));

    [Fact]
    public async Task UnAvisoSinFirmaSeRespondeCon401VacioYSinCredencial()
    {
        using var client = server.CreateClient();
        using var response = await client.PostAsync(Path, new StringContent("{}", Encoding.UTF8, "application/json"), Token);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(string.Empty, await response.Content.ReadAsStringAsync(Token));
    }

    [Fact]
    public async Task UnAvisoFirmadoQueNoHablaDeNingunCobroSeAcepta()
    {
        using var client = server.CreateClient();
        using var request = Signed();
        using var response = await client.SendAsync(request, Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(string.Empty, await response.Content.ReadAsStringAsync(Token));
    }

    [Fact]
    public async Task LaRutaDelAvisoSoloEstaAbiertaAlPost()
    {
        using var client = server.CreateClient();
        using var response = await client.GetAsync(Path, Token);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

${gateway.signedNotice(model)}
}`;
  const usings = ['System.Globalization', 'System.Net', 'System.Security.Cryptography', 'System.Text', 'Xunit'];
  return { path: `${sln.unitTests.dir}/PaymentNoticeEndpointTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

/** Program.cs: lo que añade la capa payments al arranque. */
export function paymentsProgram(model) {
  if (!usesPayments(model)) return { usings: [], registration: '', mapping: '' };
  return {
    usings: [paymentInfraNamespace(model), namespaceOf(model, 'rest')],
    registration: `
// La pasarela de pago del stack (capa payments): el adaptador, el verificador de avisos y la configuración del perfil.
builder.Services.AddPayments(PaymentGatewaySettings.From(configuration));`,
    mapping: '\n// El aviso de la pasarela: fuera de la API versionada, sin credencial y protegido por su firma.\napp.MapPaymentNotice();'
  };
}
