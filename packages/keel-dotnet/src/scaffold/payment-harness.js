// La pasarela de pago de prueba en el arnés (incremento 13d): una API NEUTRA —los mismos helpers con cualquier pasarela,
// y los mismos nombres que el AbstractFlowIT de keel-spring y el payment-gateway.ts de keel-nest— para que los
// escenarios se traduzcan a pruebas una sola vez, igual que el diseño se escribe una sola vez. Por debajo, cada helper
// programa el WireMock de infra/ con la forma de la pasarela elegida (keel-core/gen/payment-probes.js) y firma los
// avisos como los firmaría ella.
//
// No es un doble dentro del proceso: el servidor habla HTTP con WireMock por el mismo socket que con la pasarela real, con
// el mismo adaptador. Lo que se mide es el servidor.
//
// `Support/PaymentGateway.cs` solo usa HttpStubHarness y la biblioteca base: `stub-check` lo compila SOLO, junto a
// Support/HttpStub.cs, y lo ejecuta contra un WireMock real con el adaptador emitido. Los dos helpers que MANDAN el aviso
// necesitan el Post del flujo, así que van en FlowTest.cs (`paymentNoticeMembers`).

import { paymentProbesFor } from '@keel-system/keel-core/gen/payment-probes';
import { CURRENCY_MINOR_UNITS, PAYMENT_NOTICE_PATH, PAYMENT_TEST_SECRETS, gatewayTranslation } from '@keel-system/keel-core/gen/payment-gateways';
import { paymentTestCurrency } from '@keel-system/keel-core/gen/payments-config';
import { csFile, csString, solution } from './render.js';

export function usesPaymentHarness(model) {
  return Boolean(model.payments);
}

export function paymentHarnessPath(model) {
  return `${solution(model).integrationTests.dir}/Support/PaymentGateway.cs`;
}

/** Las llamadas que el servidor le hace a la pasarela, como miembros C# (`SAVE_METHOD` → `SaveMethod`). */
const callMember = (call) => call.toLowerCase().replace(/(^|_)([a-z])/g, (_, __, letter) => letter.toUpperCase());

export function paymentHarnessFile(model, namespace) {
  if (!usesPaymentHarness(model)) return null;
  return {
    path: paymentHarnessPath(model),
    content: csFile({
      namespace,
      usings: ['System.Globalization', 'System.Security.Cryptography', 'System.Text', 'System.Text.Json.Nodes'],
      body: harnessBody(model)
    })
  };
}

/** Los miembros de FlowTest que mandan el aviso: necesitan el Post del flujo, así que van en FlowTest.cs. */
export function paymentNoticeMembers(model) {
  if (!usesPaymentHarness(model)) return [];
  return [
    `    /// <summary>
    /// La pasarela avisa de que algo cambió en el cobro de esa referencia, firmado como lo firma ella. El servidor no se fía
    /// del aviso: le pregunta el estado a la pasarela (programa antes lo que responde con GatewayReports).
    /// </summary>
    protected static Task<FlowResponse> SendGatewayNotice(string reference)
    {
        var notice = PaymentGatewayHarness.Notice(reference, forged: false);
        return Post(notice.Path, notice.Body, notice.Headers);
    }`,
    `    /// <summary>Un aviso con la firma ALTERADA: el servidor tiene que rechazarlo (401) sin consultar nada.</summary>
    protected static Task<FlowResponse> SendForgedGatewayNotice(string reference)
    {
        var notice = PaymentGatewayHarness.Notice(reference, forged: true);
        return Post(notice.Path, notice.Body, notice.Headers);
    }`
  ];
}

function harnessBody(model) {
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  const currency = paymentTestCurrency(model);
  const digits = CURRENCY_MINOR_UNITS[currency] ?? 2;
  const calls = Object.keys(probes.calls);
  const routes = Object.entries(probes.calls)
    .map(([call, route]) => `        [GatewayCall.${callMember(call)}] = (${csString(route.method)}, ${csString(route.path)}),`)
    .join('\n');
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes) : mercadopagoSpecific(probes);
  return `/// <summary>Las llamadas que el servidor le hace a la pasarela de pago.</summary>
public enum GatewayCall
{
${calls.map((call) => `    ${callMember(call)},`).join('\n')}
}

/// <summary>Un aviso de la pasarela ya firmado: la ruta (con su query), el cuerpo tal cual viaja y las cabeceras.</summary>
public sealed record GatewayNotice(string Path, string Body, Dictionary<string, string> Headers);

/// <summary>
/// La pasarela de pago de prueba (capa payments, ${gateway.label}): el WireMock de infra/ hablando el protocolo de la pasarela
/// elegida, al que apunta <c>payments.gateway.base-url</c> en el perfil <c>local</c>. La API es NEUTRA —los mismos helpers con
/// cualquier pasarela, porque los escenarios no nombran ninguna— y los flujos llegan a ella por FlowTest.
/// </summary>
public abstract partial class FlowTest
{
    /// <summary>
    /// El id que la pasarela de prueba asigna al cobro de esa referencia. Es determinista para que el escenario pueda
    /// nombrarlo antes de pedir el cobro (para un aviso, por ejemplo).
    /// </summary>
    protected static string GatewayIdFor(string reference) => PaymentGatewayHarness.IdFor(reference);

    /// <summary>El siguiente cobro con esa referencia queda autorizado (importe retenido).</summary>
    protected static Task GatewayAuthorizes(string reference) => PaymentGatewayHarness.ChargeAnswers(reference, "AUTHORIZED");

    /// <summary>El siguiente cobro con esa referencia queda cobrado en el acto.</summary>
    protected static Task GatewayCharges(string reference) => PaymentGatewayHarness.ChargeAnswers(reference, "CAPTURED");

    /// <summary>El siguiente cobro con esa referencia exige que el cliente se autentique (3DS).</summary>
    protected static Task GatewayRequiresAction(string reference) => PaymentGatewayHarness.ChargeAnswers(reference, "ACTION_REQUIRED");

    /// <summary>
    /// El siguiente cobro con esa referencia se rechaza, con un motivo del vocabulario neutro (declined, insufficientFunds,
    /// expiredCard, authenticationFailed, fraudSuspected, invalidPaymentMethod, processingError).
    /// </summary>
    protected static Task GatewayDeclines(string reference, string reason) => PaymentGatewayHarness.Declines(reference, reason);

    /// <summary>La pasarela no contesta a esa llamada: corta la conexión. La acción queda EN DUDA.</summary>
    protected static Task GatewayDoesNotAnswer(GatewayCall call) => PaymentGatewayHarness.DoesNotAnswer(call);

    /// <summary>
    /// Lo que responde la pasarela cuando se le pregunta por el cobro de esa referencia, por su id y por la referencia. Con
    /// "NOT_FOUND" no lo conoce: la petición no le llegó nunca.
    /// </summary>
    protected static Task GatewayReports(string reference, string status) => PaymentGatewayHarness.Reports(reference, status);

    /// <summary>La pasarela captura el cobro de esa referencia en el acto.</summary>
    protected static Task GatewayCaptures(string reference) => PaymentGatewayHarness.Captures(reference);

    /// <summary>La pasarela anula la autorización del cobro de esa referencia en el acto.</summary>
    protected static Task GatewayCancels(string reference) => PaymentGatewayHarness.Cancels(reference);

    /// <summary>
    /// La autorización del cobro de esa referencia caducó antes de capturarse: la captura se rechaza y, preguntada, la
    /// pasarela lo da por anulado. Es el desenlace que la pasarela impone sola pasado su plazo (unos días), y ningún
    /// escenario puede esperarlo.
    /// </summary>
    protected static Task GatewayExpiresAuthorization(string reference) => PaymentGatewayHarness.ExpiresAuthorization(reference);

    /// <summary>
    /// La pasarela rechaza esa llamada (4xx): la acción no se hizo. Tras rechazar una captura, una anulación o una
    /// devolución, el servidor le PREGUNTA a la pasarela el estado real del cobro (el rechazo no lo dice): programa también
    /// <c>GatewayReports(referencia, "AUTHORIZED")</c> —o "CAPTURED" para una devolución—. Sin él la consulta no lo
    /// encuentra (NOT_FOUND), y un rechazo no se distingue de un cobro que la pasarela no conoce.
    /// </summary>
    protected static Task GatewayRejects(GatewayCall call) => PaymentGatewayHarness.Rejects(call);

    /// <summary>La pasarela guarda el medio de pago que se le pase.</summary>
    protected static Task GatewaySavesPaymentMethod() => PaymentGatewayHarness.SavesPaymentMethod();

    /// <summary>La devolución del cobro de esa referencia se completa por ese importe ("5.00").</summary>
    protected static Task GatewayRefunds(string reference, string amount) => PaymentGatewayHarness.Refunds(reference, amount);

    /// <summary>Cuántas veces llamó el servidor a la pasarela por esa llamada.</summary>
    protected static Task<int> GatewayCallCount(GatewayCall call) => PaymentGatewayHarness.CallCount(call);

    /// <summary>Las peticiones que recibió la pasarela por esa llamada (para afirmar cabeceras y cuerpos).</summary>
    protected static Task<IReadOnlyList<StubRequest>> GatewayRequests(GatewayCall call) => PaymentGatewayHarness.Requests(call);
}

/// <summary>
/// Lo que hay debajo de los helpers: los mappings del WireMock con las formas de la pasarela, y los avisos firmados. Solo usa
/// HttpStubHarness y la biblioteca base (stub-check lo compila solo).
/// </summary>
public static partial class PaymentGatewayHarness
{
    private static readonly Dictionary<GatewayCall, (string Method, string Path)> Routes = new()
    {
${routes}
    };

    /// <summary>El secreto con el que el perfil local verifica los avisos (config/parameters/local/payments.yaml).</summary>
    private const string WebhookSecret = ${csString(PAYMENT_TEST_SECRETS.webhookSecret)};

    /// <summary>La ruta del aviso en el servidor.</summary>
    private const string NoticePath = ${csString(PAYMENT_NOTICE_PATH)};

    /// <summary>La moneda de los escenarios (el testValue del parámetro de despliegue, o EUR).</summary>
    private const string Currency = ${csString(currency)};

    /// <summary>Los decimales de su unidad menor (la tabla de keel-core).</summary>
    private const int CurrencyDigits = ${digits};

    public static string IdFor(string reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        return ${csString(probes.idPrefix)} + NonAlphanumeric().Replace(reference, string.Empty);
    }

    public static Task ChargeAnswers(string reference, string status) => Stub(GatewayCall.Charge, null, reference, 200, GatewayObject(reference, status, null, null));

    public static Task DoesNotAnswer(GatewayCall call)
    {
        var (method, path) = Routes[call];
        return HttpStubHarness.MappingAsync(method, path, StubResponse.ConnectionFault());
    }

    public static async Task Reports(string reference, string status)
    {
        if (status == "NOT_FOUND")
        {
            await StubPath(GatewayCall.Status, IdFor(reference), 404, new JsonObject());
            await Stub(GatewayCall.Search, reference, null, 200, new JsonObject { ["data"] = new JsonArray() });
            return;
        }
        await StubPath(GatewayCall.Status, IdFor(reference), 200, GatewayObject(reference, status, null, status == "REFUNDED" ? "10.00" : null));
        await Stub(GatewayCall.Search, reference, null, 200, new JsonObject { ["data"] = new JsonArray(GatewayObject(reference, status, null, status == "REFUNDED" ? "10.00" : null)) });
    }

    public static Task Captures(string reference) => StubPath(GatewayCall.Capture, IdFor(reference), 200, GatewayObject(reference, "CAPTURED", null, null));

    public static Task Cancels(string reference) => StubPath(GatewayCall.Cancel, IdFor(reference), 200, GatewayObject(reference, "CANCELED", null, null));

    public static async Task ExpiresAuthorization(string reference)
    {
        await StubPath(GatewayCall.Capture, IdFor(reference), 400, ExpiredCapture());
        await Reports(reference, "CANCELED");
    }

    public static Task Rejects(GatewayCall call)
    {
        var (method, path) = Routes[call];
        return HttpStubHarness.MappingAsync(method, path, StubResponse.Ok(400, new JsonObject { ["error"] = new JsonObject { ["code"] = "rejected_by_test" } }.ToJsonString()));
    }

    public static async Task SavesPaymentMethod()
    {
        var (saveMethod, savePath) = Routes[GatewayCall.SaveMethod];
        var (attachMethod, attachPath) = Routes[GatewayCall.AttachMethod];
        await HttpStubHarness.MappingAsync(saveMethod, savePath, StubResponse.Ok(200, new JsonObject { ["id"] = "cus_keel_test" }.ToJsonString()));
        await HttpStubHarness.MappingAsync(attachMethod, attachPath, StubResponse.Ok(200, new JsonObject { ["id"] = "card_keel_test" }.ToJsonString()));
    }

    public static Task<int> CallCount(GatewayCall call)
    {
        var (method, path) = Routes[call];
        return HttpStubHarness.CallCountAsync(method, path);
    }

    public static Task<IReadOnlyList<StubRequest>> Requests(GatewayCall call)
    {
        var (method, path) = Routes[call];
        return HttpStubHarness.RequestsAsync(method, path);
    }

    // ─── Mappings ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Un mapping del doble para una llamada: con <paramref name="bodyContains"/> solo casa la petición cuyo cuerpo lo lleve (la
    /// referencia), con <paramref name="queryContains"/> la que lo lleve en su parámetro de búsqueda.
    /// </summary>
    private static Task Stub(GatewayCall call, string? queryContains, string? bodyContains, int status, JsonNode body)
    {
        var (method, path) = Routes[call];
        return Mapping(method, path, queryContains, bodyContains, status, body);
    }

    /// <summary>Igual, sobre la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).</summary>
    private static Task StubPath(GatewayCall call, string gatewayId, int status, JsonNode body)
    {
        var (method, path) = Routes[call];
        var concrete = path.Replace("(?!search)[^/]+", gatewayId, StringComparison.Ordinal).Replace("[^/]+", gatewayId, StringComparison.Ordinal);
        return Mapping(method, concrete, null, null, status, body);
    }

    private static Task Mapping(string method, string pathPattern, string? queryContains, string? bodyContains, int status, JsonNode body)
    {
        var request = new JsonObject { ["method"] = method, ["urlPathPattern"] = pathPattern };
        if (queryContains is not null)
        {
            request["queryParameters"] = new JsonObject { [${csString(probes.calls.SEARCH.query)}] = new JsonObject { ["contains"] = queryContains } };
        }
        if (bodyContains is not null)
        {
            request["bodyPatterns"] = new JsonArray(new JsonObject { ["contains"] = bodyContains });
        }
        return HttpStubHarness.RawMappingAsync(request, HttpStubHarness.Response(status, body.ToJsonString()));
    }

    private static string Hmac(string secret, string payload) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(payload)));

    private static string Secret(bool forged) => forged ? WebhookSecret + "-falso" : WebhookSecret;

    private static string Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);

    /// <summary>Un importe decimal ("10.00") en la unidad menor de la moneda de los escenarios, sin redondear.</summary>
    private static long MinorUnits(string amount)
    {
        var parts = amount.Split('.');
        var fraction = parts.Length > 1 ? parts[1] : string.Empty;
        if (fraction.Length > CurrencyDigits)
        {
            throw new ArgumentException($"El importe {amount} tiene más decimales de los que admite {Currency}", nameof(amount));
        }
        return long.Parse(parts[0] + fraction.PadRight(CurrencyDigits, '0'), CultureInfo.InvariantCulture);
    }

    /// <summary>Un importe decimal ("10") con la escala de la moneda de los escenarios ("10.00").</summary>
    private static string MajorUnits(string amount)
    {
        var parts = amount.Split('.');
        return CurrencyDigits == 0 ? parts[0] : parts[0] + "." + (parts.Length > 1 ? parts[1] : string.Empty).PadRight(CurrencyDigits, '0');
    }

    private static T Known<T>(Dictionary<string, T> table, string key, string what) =>
        table.TryGetValue(key, out var value) ? value : throw new ArgumentException($"{what} desconocido: '{key}'. Los hay: {string.Join(", ", table.Keys)}", nameof(key));

    [System.Text.RegularExpressions.GeneratedRegex("[^A-Za-z0-9]")]
    private static partial System.Text.RegularExpressions.Regex NonAlphanumeric();
${specific}
}`;
}

function stripeSpecific(probes) {
  const translation = gatewayTranslation('stripe');
  const statuses = Object.entries(probes.statuses).map(([key, value]) => `        [${csString(key)}] = ${csString(value)},`).join('\n');
  const declines = Object.entries(probes.declines).map(([key, value]) => `        [${csString(key)}] = ${csString(value)},`).join('\n');
  return `
    private static readonly Dictionary<string, string> Statuses = new(StringComparer.Ordinal)
    {
${statuses}
    };

    private static readonly Dictionary<string, string> DeclineCodes = new(StringComparer.Ordinal)
    {
${declines}
    };

    /// <summary>Un PaymentIntent con la forma que lee el adaptador de Stripe.</summary>
    private static JsonObject GatewayObject(string reference, string status, string? declineCode, string? refunded)
    {
        var id = IdFor(reference);
        var intent = new JsonObject
        {
            ["id"] = id,
            ["object"] = "payment_intent",
            ["currency"] = Currency.ToLowerInvariant(),
            ["status"] = Known(Statuses, status, "Estado"),
            ["metadata"] = new JsonObject { [${csString(translation.referenceKey)}] = reference },
            ["client_secret"] = id + "_secret_test"
        };
        if (status == "ACTION_REQUIRED")
        {
            intent["next_action"] = new JsonObject { ["type"] = "use_stripe_sdk" };
        }
        if (status == "FAILED")
        {
            intent["last_payment_error"] = new JsonObject { ["code"] = "card_declined", ["decline_code"] = declineCode ?? "generic_decline" };
        }
        if (refunded is not null)
        {
            intent["latest_charge"] = new JsonObject { ["amount_refunded"] = MinorUnits(refunded), ["currency"] = Currency.ToLowerInvariant() };
        }
        return intent;
    }

    /// <summary>
    /// Stripe rechaza un cobro confirmado con un 402 y el PaymentIntent dentro del error. El de autenticación no: un 402
    /// authentication_required es una ACCIÓN del cliente pendiente, así que ese motivo llega como el PaymentIntent fallido.
    /// </summary>
    public static Task Declines(string reference, string reason)
    {
        var code = Known(DeclineCodes, reason, "Motivo");
        var failed = GatewayObject(reference, "FAILED", code, null);
        if (reason == "authenticationFailed")
        {
            return Stub(GatewayCall.Charge, null, reference, 200, failed);
        }
        return Stub(GatewayCall.Charge, null, reference, 402, new JsonObject
        {
            ["error"] = new JsonObject { ["type"] = "card_error", ["code"] = "card_declined", ["decline_code"] = code, ["payment_intent"] = failed }
        });
    }

    /// <summary>Stripe contesta a capturar una autorización caducada con este código, y el adaptador lo lee.</summary>
    private static JsonObject ExpiredCapture() =>
        new() { ["error"] = new JsonObject { ["type"] = "invalid_request_error", ["code"] = ${csString(translation.expiredCaptureMarker)} } };

    public static Task Refunds(string reference, string amount)
    {
        var id = IdFor(reference);
        return Stub(GatewayCall.Refund, null, id, 200, new JsonObject
        {
            ["id"] = "re_" + id,
            ["status"] = "succeeded",
            ["amount"] = MinorUnits(amount),
            ["currency"] = Currency.ToLowerInvariant(),
            ["payment_intent"] = id
        });
    }

    /// <summary>Un aviso firmado como Stripe: <c>${probes.notice.signatureHeader}: t=…,v1=HMAC(t.cuerpo)</c>.</summary>
    public static GatewayNotice Notice(string reference, bool forged)
    {
        var id = IdFor(reference);
        var body = new JsonObject
        {
            ["id"] = "evt_" + id,
            ["type"] = "payment_intent.updated",
            ["data"] = new JsonObject { ["object"] = new JsonObject { ["id"] = id, ["object"] = "payment_intent" } }
        }.ToJsonString();
        var t = Now();
        return new GatewayNotice(NoticePath, body, new Dictionary<string, string> { [${csString(probes.notice.signatureHeader)}] = $"t={t},v1={Hmac(Secret(forged), t + "." + body)}" });
    }`;
}

function mercadopagoSpecific(probes) {
  const translation = gatewayTranslation('mercadopago');
  const statuses = Object.entries(probes.statuses)
    .map(([key, [status, detail]]) => `        [${csString(key)}] = (${csString(status)}, ${csString(detail)}),`)
    .join('\n');
  const declines = Object.entries(probes.declines).map(([key, value]) => `        [${csString(key)}] = ${csString(value)},`).join('\n');
  return `
    private static readonly Dictionary<string, (string Status, string Detail)> Statuses = new(StringComparer.Ordinal)
    {
${statuses}
    };

    private static readonly Dictionary<string, string> DeclineDetails = new(StringComparer.Ordinal)
    {
${declines}
    };

    /// <summary>Una order con la forma que lee el adaptador de MercadoPago.</summary>
    private static JsonObject GatewayObject(string reference, string status, string? detail, string? refunded)
    {
        var id = IdFor(reference);
        var (state, defaultDetail) = Known(Statuses, status, "Estado");
        var statusDetail = detail ?? defaultDetail;
        var transactions = new JsonObject
        {
            ["payments"] = new JsonArray(new JsonObject
            {
                ["id"] = "PAY" + id,
                ["status_detail"] = statusDetail,
                ["payment_method"] = new JsonObject { ["type"] = "credit_card", ["url"] = "https://pasarela.test/3ds/" + id }
            })
        };
        if (refunded is not null)
        {
            transactions["refunds"] = new JsonArray(new JsonObject { ["amount"] = MajorUnits(refunded) });
        }
        return new JsonObject
        {
            ["id"] = id,
            ["status"] = state,
            ["status_detail"] = statusDetail,
            [${csString(translation.referenceKey)}] = reference,
            ["currency"] = Currency,
            ["transactions"] = transactions
        };
    }

    public static Task Declines(string reference, string reason) =>
        Stub(GatewayCall.Charge, null, reference, 200, GatewayObject(reference, "FAILED", Known(DeclineDetails, reason, "Motivo"), null));

    /// <summary>MercadoPago no documenta un código para la captura caducada: el adaptador consulta el estado.</summary>
    private static JsonObject ExpiredCapture() => new() { ["errors"] = new JsonArray(new JsonObject { ["code"] = "order_expired" }) };

    /// <summary>
    /// Programa también la consulta de la order (capturada), porque una devolución parcial la lee antes para nombrar la
    /// transacción.
    /// </summary>
    public static async Task Refunds(string reference, string amount)
    {
        await StubPath(GatewayCall.Status, IdFor(reference), 200, GatewayObject(reference, "CAPTURED", null, null));
        await StubPath(GatewayCall.Refund, IdFor(reference), 200, GatewayObject(reference, "REFUNDED", null, amount));
    }

    /// <summary>
    /// Un aviso firmado como MercadoPago: la firma es del manifiesto <c>id:&lt;data.id&gt;;request-id:&lt;x-request-id&gt;;ts:&lt;ts&gt;;</c>,
    /// no del cuerpo, y el id viaja en la query.
    /// </summary>
    public static GatewayNotice Notice(string reference, bool forged)
    {
        var id = IdFor(reference);
        var requestId = Guid.NewGuid().ToString();
        var ts = Now();
        var manifest = $"id:{id.ToLowerInvariant()};request-id:{requestId};ts:{ts};";
        var body = new JsonObject { ["action"] = "order.updated", ["type"] = "order", ["data"] = new JsonObject { ["id"] = id } }.ToJsonString();
        return new GatewayNotice(
            $"{NoticePath}?${translation.notice.dataIdQuery}={id}&type=order",
            body,
            new Dictionary<string, string>
            {
                [${csString(probes.notice.signatureHeader)}] = $"ts={ts},v1={Hmac(Secret(forged), manifest)}",
                [${csString(translation.notice.requestIdHeader)}] = requestId
            });
    }`;
}
