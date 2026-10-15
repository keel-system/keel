// El adaptador de MercadoPago (API de Orders) y su verificador de avisos, para keel-dotnet.
//
// Es la traducción del de keel-spring y keel-nest, caso por caso, sobre el MISMO contrato (keel-core/gen/payment-gateways.js):
//   * Orders y no la API clásica de pagos: es la única con cobro sin el cliente delante;
//   * JSON; credencial Bearer (access token); X-Idempotency-Key en las escrituras;
//   * importe decimal en la unidad mayor ("12.50"), con la escala de la tabla de keel-core;
//   * x-signature: ts=…,v1=…: HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. La firma NO
//     cubre el cuerpo: el aviso solo dice de qué order habla, y el estado se consulta.
//
// Lo marcado VERIFICAR EN SANDBOX es lo que la matriz declara `unverified`: build lo genera con la lectura más probable,
// avisando.

import { gatewayTranslation } from 'keel-core/gen/payment-gateways';
import { paymentProbesFor } from 'keel-core/gen/payment-probes';
import { csFile, csString, located, namespaceOf } from '../render.js';
import { PAYMENT_GATEWAY_PORT, NOTICE_VERIFIER_PORT, paymentInfraNamespace, paymentNamespace, reasonMember } from '../payments.js';

const TRANSLATION = gatewayTranslation('mercadopago');
const PROBES = paymentProbesFor('mercadopago');

export const place = 'mercadopago';
export const adapterClass = 'MercadopagoPaymentGateway';
export const verifierClass = 'MercadopagoNoticeVerifier';

export function generate(model) {
  const usings = [paymentNamespace(model), paymentInfraNamespace(model), namespaceOf(model, 'ports'), namespaceOf(model, 'enums')];
  const adapter = located(model, place, adapterClass);
  const verifier = located(model, place, verifierClass);
  return [
    {
      path: adapter.path,
      content: csFile({ namespace: adapter.namespace, usings: [...usings, 'System.Globalization', 'System.Text.Json', 'System.Text.Json.Nodes'], body: adapterBody(model) })
    },
    {
      path: verifier.path,
      content: csFile({ namespace: verifier.namespace, usings: [paymentInfraNamespace(model), 'System.Globalization', 'System.Security.Cryptography', 'System.Text'], body: verifierBody(model) })
    }
  ];
}

function adapterBody(model) {
  const p = model.payments;
  const F = p.record.failureReasonType;
  const ct = 'CancellationToken cancellationToken = default';
  const ref = TRANSLATION.referenceKey;
  const details = TRANSLATION.declines.map(([code, literal]) => `        [${csString(code)}] = ${reasonMember(model, literal)},`).join('\n');
  const methods = [];

  methods.push(`    public async Task<GatewayOutcome> Authorize(ChargeRequest request, ${ct})
    {
        ArgumentNullException.ThrowIfNull(request);
        var amount = MoneyAmounts.ToMajorUnits(request.Amount, request.Currency);
        var paymentMethod = new JsonObject { ["type"] = "credit_card", ["installments"] = 1 };
        var payment = new JsonObject { ["amount"] = amount, ["payment_method"] = paymentMethod };
        var order = new JsonObject
        {
            ["type"] = "online",
            ["processing_mode"] = "automatic",
            ["capture_mode"] = ${csString(p.captureLater ? 'manual' : 'automatic')},
            [ReferenceKey] = request.Reference,
            ["total_amount"] = amount,
            ["transactions"] = new JsonObject { ["payments"] = new JsonArray(payment) }
        };
        if (request.Source.Kind == PaymentSourceKind.Saved)
        {
            // VERIFICAR EN SANDBOX (off-session sin verificar). La referencia guardada es "customer_id|card_id"
            // (SavePaymentMethod); los pagos automáticos de Orders cobran con el perfil guardado y la credencial almacenada,
            // sin CVV ni token nuevo.
            var (customerId, cardId) = GatewayKeys.SplitSaved(request.Source.Value);
            order["payer"] = new JsonObject { ["customer_id"] = customerId };
            paymentMethod["id"] = cardId;
            payment["stored_credential"] = new JsonObject { ["payment_initiator"] = "merchant", ["reason"] = "unscheduled", ["first_payment"] = false };
        }
        else
        {
            paymentMethod["token"] = request.Source.Value;
        }
        var answer = await Send("authorize", new GatewayRequest("POST", "/v1/orders", GatewayJson.JsonBody(order), Key(GatewayKeys.Idempotency(request.Reference, "authorize"))), cancellationToken);
        if (answer.Status >= 500)
        {
            throw Unavailable("authorize", answer);
        }
        // Un 4xx al crear la order: el token o el medio no sirven.
        return answer.Status >= 400
            ? GatewayOutcome.Failed(request.Reference, null, ReasonOf(GatewayJson.Parse(answer.Text, Gateway)))
            : OutcomeOf(GatewayJson.Parse(answer.Text, Gateway), request.Reference);
    }`);

  if (p.capture) {
    // La captura parcial no la cubre MercadoPago (la matriz la rechaza): con amount en el puerto, se ignora.
    const amountParam = p.capture.amount ? ', decimal? amount, string? currency' : '';
    methods.push(`    public Task<GatewayOutcome> Capture(string reference, string gatewayPaymentId${amountParam}, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        return FollowUp($"/v1/orders/{Uri.EscapeDataString(gatewayPaymentId)}/capture", new JsonObject(), reference, gatewayPaymentId, "capture", cancellationToken);
    }`);
  }
  if (p.void) {
    methods.push(`    public Task<GatewayOutcome> VoidAuthorization(string reference, string gatewayPaymentId, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        return FollowUp($"/v1/orders/{Uri.EscapeDataString(gatewayPaymentId)}/cancel", new JsonObject(), reference, gatewayPaymentId, "void", cancellationToken);
    }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', decimal? amount, string? currency' : '';
    const partial = p.refund.amount
      ? `
        if (amount is { } partial)
        {
            // La devolución parcial nombra la transacción de pago de la order: hay que leerla, y esa lectura falla igual que
            // la devolución —dentro del mismo tratamiento, o un 5xx aquí sale como un 500 con el cobro atascado en refunding—.
            var current = await Send("refund", new GatewayRequest("GET", $"/v1/orders/{Uri.EscapeDataString(gatewayPaymentId)}"), cancellationToken);
            if (current.Status >= 400)
            {
                throw Unavailable("refund", current);
            }
            var transaction = FirstPayment(GatewayJson.Parse(current.Text, Gateway));
            body["transactions"] = new JsonArray(new JsonObject
            {
                ["id"] = GatewayJson.Text(transaction, "id") ?? string.Empty,
                ["amount"] = MoneyAmounts.ToMajorUnits(partial, GatewayKeys.RequiredCurrency(currency))
            });
        }`
      : '';
    methods.push(`    public ${p.refund.amount ? 'async ' : ''}Task<GatewayOutcome> Refund(string reference, string gatewayPaymentId${amountParam}, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        var body = new JsonObject();${partial}
        return ${p.refund.amount ? 'await ' : ''}FollowUp($"/v1/orders/{Uri.EscapeDataString(gatewayPaymentId)}/refund", body, reference, gatewayPaymentId, "refund", cancellationToken);
    }`);
  }

  methods.push(`    public async Task<GatewayOutcome> Status(string? reference, string? gatewayPaymentId, ${ct})
    {
        GatewayAnswer answer;
        if (gatewayPaymentId is not null)
        {
            answer = await Send("status", new GatewayRequest("GET", $"/v1/orders/{Uri.EscapeDataString(gatewayPaymentId)}"), cancellationToken);
        }
        else
        {
            // Sin id: la pasarela no llegó a contestar. Se busca por ${ref}.
            // VERIFICAR EN SANDBOX: la búsqueda de orders por referencia externa.
            answer = await Send("status", new GatewayRequest("GET", "/v1/orders/search?" + GatewayJson.Form([new(ReferenceKey, reference ?? string.Empty)])), cancellationToken);
        }
        if (answer.Status == 404)
        {
            return GatewayOutcome.NotFound(reference);
        }
        if (answer.Status >= 400)
        {
            throw Unavailable("status", answer);
        }
        var body = GatewayJson.Parse(answer.Text, Gateway);
        if (gatewayPaymentId is not null)
        {
            return OutcomeOf(body, reference);
        }
        var data = GatewayJson.Array(body, "data");
        return data.Count > 0 && data[0].ValueKind == JsonValueKind.Object ? OutcomeOf(data[0], reference) : GatewayOutcome.NotFound(reference);
    }`);

  if (p.savePaymentMethod) {
    const [customerStep, cardStep] = TRANSLATION.savedMethodSteps;
    methods.push(`    public async Task<string> SavePaymentMethod(string token, string payerReference, ${ct})
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(payerReference);
        var customer = await Send(
            "savePaymentMethod",
            new GatewayRequest("POST", "/v1/customers", GatewayJson.JsonBody(new JsonObject { ["description"] = payerReference }), Key(GatewayKeys.SavedMethod(token, ${csString(customerStep)}))),
            cancellationToken);
        RejectedMethod(customer);
        var customerId = GatewayJson.Text(GatewayJson.Parse(customer.Text, Gateway), "id") ?? string.Empty;
        var card = await Send(
            "savePaymentMethod",
            new GatewayRequest("POST", $"/v1/customers/{Uri.EscapeDataString(customerId)}/cards", GatewayJson.JsonBody(new JsonObject { ["token"] = token }), Key(GatewayKeys.SavedMethod(token, ${csString(cardStep)}))),
            cancellationToken);
        RejectedMethod(card);
        return GatewayKeys.Saved(customerId, GatewayJson.Text(GatewayJson.Parse(card.Text, Gateway), "id") ?? string.Empty);
    }`);
  }

  return `/// <summary>La pasarela de pago sobre MercadoPago (API de Orders), por HTTP plano.</summary>
/// <remarks>
/// Lo que lleva dentro y no puede faltar: la clave de idempotencia sale de la referencia de negocio y la acción
/// (<c>&lt;referencia&gt;:authorize</c>…), nunca de un aleatorio; un 5xx o un timeout NO se reintenta: lanza
/// PaymentGatewayUnavailableException y la acción queda en duda para el barrido; el importe viaja en unidades mayores con
/// la escala exacta de la moneda, sin redondear; y los rechazos se traducen al vocabulario neutro de ${F}.
/// </remarks>
public sealed class ${adapterClass}(PaymentGatewayHttp http) : ${PAYMENT_GATEWAY_PORT}
{
    /// <summary>El campo de la order con el que viaja la referencia del cobro; es lo que permite buscarlo.</summary>
    public const string ReferenceKey = ${csString(ref)};

    private const string Gateway = "MercadoPago";

    /// <summary>status_detail de un pago → motivo neutro (keel-core/gen/payment-gateways.js); lo que no está es el rechazo genérico.</summary>
    private static readonly Dictionary<string, ${F}> Details = new(StringComparer.Ordinal)
    {
${details}
    };

${methods.join('\n\n')}

    // ─── HTTP ─────────────────────────────────────────────────────────────────

    private static KeyValuePair<string, string> Key(string value) => new(${csString(p.gateway.idempotencyHeader)}, value);

    private async Task<GatewayAnswer> Send(string action, GatewayRequest request, CancellationToken cancellationToken)
    {
        try
        {
            return await http.Send(request, cancellationToken);
        }
        catch (GatewayNoAnswerException error)
        {
            throw new PaymentGatewayUnavailableException($"{Gateway} no contestó a {action}: la acción queda en duda", error);
        }
    }

    /// <summary>Captura, anulación y devolución: si MercadoPago la rechaza, se devuelve el estado real de la order.</summary>
    private async Task<GatewayOutcome> FollowUp(string path, JsonObject body, string reference, string gatewayPaymentId, string action, CancellationToken cancellationToken)
    {
        var answer = await Send(action, new GatewayRequest("POST", path, GatewayJson.JsonBody(body), Key(GatewayKeys.Idempotency(reference, action))), cancellationToken);
        if (answer.Status >= 500)
        {
            throw Unavailable(action, answer);
        }
        if (answer.Status >= 400)
        {
            return await Status(reference, gatewayPaymentId, cancellationToken);
        }
        return OutcomeOf(GatewayJson.Parse(answer.Text, Gateway), reference);
    }

    // ─── Traducción ───────────────────────────────────────────────────────────

    private static GatewayOutcome OutcomeOf(JsonElement order, string? reference)
    {
        var id = GatewayJson.Text(order, "id");
        var known = GatewayJson.Text(order, ReferenceKey) ?? reference;
        var payment = FirstPayment(order);
        var detail = GatewayJson.Text(order, "status_detail") ?? GatewayJson.Text(payment, "status_detail") ?? string.Empty;
        var status = GatewayJson.Text(order, "status") ?? string.Empty;
        if (status == "refunded" || detail is "refunded" or "partially_refunded")
        {
            var refunded = 0m;
            foreach (var refund in GatewayJson.Array(GatewayJson.Object(order, "transactions"), "refunds"))
            {
                refunded += decimal.Parse(GatewayJson.Text(refund, "amount") ?? "0", NumberStyles.Number | NumberStyles.AllowExponent, CultureInfo.InvariantCulture);
            }
            return GatewayOutcome.Refunded(known, id, refunded);
        }
        return status switch
        {
            "action_required" => GatewayOutcome.ActionRequired(known, id, CustomerAction(payment)),
            "processed" => detail == "waiting_capture" ? GatewayOutcome.Of(GatewayStatus.Authorized, known, id) : GatewayOutcome.Of(GatewayStatus.Captured, known, id),
            "failed" => GatewayOutcome.Failed(known, id, ReasonOf(payment)),
            "canceled" or "expired" => GatewayOutcome.Of(GatewayStatus.Canceled, known, id),
            _ => GatewayOutcome.Of(GatewayStatus.Pending, known, id)
        };
    }

    /// <summary>VERIFICAR EN SANDBOX (customer-action sin verificar): la acción va opaca. Sin medio de pago, no hay acción que dar.</summary>
    private static string? CustomerAction(JsonElement payment) =>
        GatewayJson.Get(payment, "payment_method") is { } method ? GatewayJson.Compact(method) : null;

    private static ${F} ReasonOf(JsonElement node)
    {
        var causes = GatewayJson.Array(node, "cause");
        var cause = causes.Count > 0 && causes[0].ValueKind == JsonValueKind.Object ? causes[0] : GatewayJson.Empty();
        var detail = GatewayJson.Text(node, "status_detail") ?? GatewayJson.Text(cause, "code") ?? string.Empty;
        return Details.TryGetValue(detail, out var reason) ? reason : ${reasonMember(model, 'declined')};
    }

    private static JsonElement FirstPayment(JsonElement order)
    {
        var payments = GatewayJson.Array(GatewayJson.Object(order, "transactions"), "payments");
        return payments.Count > 0 && payments[0].ValueKind == JsonValueKind.Object ? payments[0] : GatewayJson.Empty();
    }

    private static PaymentGatewayUnavailableException Unavailable(string action, GatewayAnswer answer) =>
        new(string.Create(CultureInfo.InvariantCulture, $"{Gateway} no contestó a {action} (HTTP {answer.Status}): la acción queda en duda"));${
    p.savePaymentMethod
      ? `

    /// <summary>Guardar un medio: un 5xx deja la operación en duda; un 4xx es que la pasarela no acepta el medio.</summary>
    private static void RejectedMethod(GatewayAnswer answer)
    {
        if (answer.Status >= 500)
        {
            throw Unavailable("savePaymentMethod", answer);
        }
        if (answer.Status >= 400)
        {
            throw new GatewayRejectedPaymentMethodException(answer.Status);
        }
    }`
      : ''
  }
}`;
}

function verifierBody(model) {
  const notice = TRANSLATION.notice;
  const header = model.payments.gateway.webhook.signatureHeader;
  return `/// <summary>
/// Verifica la cabecera ${header} de MercadoPago: <c>${notice.timestampField}=&lt;timestamp&gt;,${notice.signatureField}=&lt;firma&gt;</c>.
/// </summary>
/// <remarks>
/// La firma es HMAC-SHA256 del manifiesto <c>id:&lt;data.id&gt;;request-id:&lt;${notice.requestIdHeader}&gt;;ts:&lt;ts&gt;;</c>, con
/// <c>data.id</c> sacado de la URL y en minúsculas; lo que falte se quita del manifiesto. Se compara en tiempo constante y un
/// <c>ts</c> fuera de la tolerancia se rechaza. LA FIRMA NO CUBRE EL CUERPO: por eso de aquí solo sale el id de la order, y
/// su estado se le pregunta a la pasarela.
/// </remarks>
public sealed class ${verifierClass}(PaymentGatewaySettings settings, TimeProvider clock) : ${NOTICE_VERIFIER_PORT}
{
    /// <summary>Un ts por encima de esto viene en milisegundos y se normaliza a segundos antes de comparar.</summary>
    private const long MillisecondsAbove = ${notice.millisecondsAbove};

    public string? Verify(PaymentNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        var header = notice.Header(${csString(header)});
        if (string.IsNullOrWhiteSpace(header))
        {
            throw new InvalidPaymentNoticeException("sin cabecera de firma");
        }
        string? ts = null;
        string? signature = null;
        foreach (var part in header.Split(','))
        {
            var trimmed = part.Trim();
            var equals = trimmed.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0)
            {
                continue;
            }
            var name = trimmed[..equals];
            var value = trimmed[(equals + 1)..];
            if (name == ${csString(notice.timestampField)})
            {
                ts = value;
            }
            else if (name == ${csString(notice.signatureField)})
            {
                signature = value;
            }
        }
        if (ts is null || signature is null)
        {
            throw new InvalidPaymentNoticeException("cabecera de firma incompleta");
        }
        if (!long.TryParse(ts, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var raw))
        {
            throw new InvalidPaymentNoticeException("timestamp ilegible");
        }
        // El ts puede venir en milisegundos: se normaliza antes de comparar con la ventana.
        var seconds = raw > MillisecondsAbove ? raw / 1000 : raw;
        if (Math.Abs(clock.GetUtcNow().ToUnixTimeSeconds() - seconds) > settings.NoticeToleranceSeconds)
        {
            throw new InvalidPaymentNoticeException("aviso fuera de la ventana de tolerancia");
        }
        var dataId = notice.Param(${csString(notice.dataIdQuery)});
        var requestId = notice.Header(${csString(notice.requestIdHeader)});
        var manifest = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(dataId))
        {
            manifest.Append("id:").Append(dataId.ToLowerInvariant()).Append(';');
        }
        if (!string.IsNullOrWhiteSpace(requestId))
        {
            manifest.Append("request-id:").Append(requestId).Append(';');
        }
        manifest.Append("ts:").Append(ts).Append(';');
        var expected = Encoding.UTF8.GetBytes(Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(settings.WebhookSecret), Encoding.UTF8.GetBytes(manifest.ToString()))));
        var given = Encoding.UTF8.GetBytes(signature);
        if (given.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(given, expected))
        {
            throw new InvalidPaymentNoticeException("la firma no verifica");
        }
        return string.IsNullOrWhiteSpace(dataId) ? null : dataId;
    }
}`;
}

/** Un aviso firmado con el secreto de prueba que no habla de ninguna order (PaymentNoticeEndpointTests): sin data.id. */
export function signedNotice(model) {
  const header = model.payments.gateway.webhook.signatureHeader;
  return `    private static HttpRequestMessage Signed()
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var request = new HttpRequestMessage(HttpMethod.Post, Path) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        request.Headers.Add(${csString(header)}, $"${TRANSLATION.notice.timestampField}={ts},${TRANSLATION.notice.signatureField}={Hmac($"ts:{ts};")}");
        return request;
    }`;
}

// ─── Los casos de la prueba emitida (PaymentGatewayTests) ───────────────────────────────────────

const raw = (value) => `"""${JSON.stringify(value)}"""`;

export function testCases(model) {
  const p = model.payments;
  const S = PROBES.statuses;
  const header = csString(p.gateway.idempotencyHeader);
  const ref = TRANSLATION.referenceKey;
  const order = (id, [status, detail], reference, extra = {}) => ({ id, status, status_detail: detail, [ref]: reference, ...extra });
  const translated = new Map(TRANSLATION.declines);
  const declineRows = Object.values(PROBES.declines)
    .filter((code, index, all) => all.indexOf(code) === index)
    .map((code) => `    [InlineData(${csString(code)}, ${csString(reasonMember(model, translated.get(code) ?? 'declined').split('.')[1])})]`);
  const cases = [];
  cases.push(`
    [Fact]
    public async Task LaClaveSaleDeLaReferenciaYElImporteVaEnLaUnidadDeLaPasarela()
    {
        var fake = FakeGateway.Json(HttpStatusCode.Created, ${raw(order('ORD1', S.AUTHORIZED, 'ch-1'))});
        var outcome = await Gateway(fake).Authorize(Charge("ch-1"), Token);
        Assert.Equal(GatewayStatus.Authorized, outcome.Status);
        Assert.Equal("ORD1", outcome.GatewayPaymentId);
        Assert.Equal("ch-1", outcome.Reference);
        var (request, body) = Assert.Single(fake.Requests);
        Assert.Equal("ch-1:authorize", request.Headers.GetValues(${header}).Single());
        Assert.Equal("Bearer clave", request.Headers.Authorization!.ToString());
        Assert.Equal("application/json", request.Content!.Headers.ContentType!.ToString());
        Assert.Contains("\\"total_amount\\":\\"12.50\\"", body, StringComparison.Ordinal);
        Assert.Contains("\\"${ref}\\":\\"ch-1\\"", body, StringComparison.Ordinal);
        Assert.Contains("\\"capture_mode\\":\\"${p.captureLater ? 'manual' : 'automatic'}\\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReintentarConLaMismaReferenciaRepiteLaClave()
    {
        var fake = FakeGateway.Json(HttpStatusCode.ServiceUnavailable, "{}");
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Authorize(Charge("ch-2"), Token));
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Authorize(Charge("ch-2"), Token));
        Assert.Equal(2, fake.Requests.Count);
        Assert.All(fake.Requests, sent => Assert.Equal("ch-2:authorize", sent.Request.Headers.GetValues(${header}).Single()));
    }

    [Theory]
${declineRows.join('\n')}
    public async Task UnRechazoCaeEnElVocabularioNeutro(string detail, string reason)
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, "{\\"id\\":\\"ORD2\\",\\"status\\":\\"failed\\",\\"transactions\\":{\\"payments\\":[{\\"status_detail\\":\\"" + detail + "\\"}]}}");
        var outcome = await Gateway(fake).Status("ch-d", "ORD2", Token);
        Assert.Equal(GatewayStatus.Failed, outcome.Status);
        Assert.Equal(reason, outcome.FailureReason?.ToString());
        var rejected = await Gateway(FakeGateway.Json(HttpStatusCode.BadRequest, "{\\"status_detail\\":\\"" + detail + "\\"}")).Authorize(Charge("ch-d"), Token);
        Assert.Equal(reason, rejected.FailureReason?.ToString());
    }

    [Fact]
    public async Task SinIdSeBuscaPorLaReferencia()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw({ data: [order('ORD3', S.CAPTURED, 'ch-3')] })});
        var outcome = await Gateway(fake).Status("ch-3", null, Token);
        Assert.Equal(GatewayStatus.Captured, outcome.Status);
        Assert.Equal("ORD3", outcome.GatewayPaymentId);
        var (request, _) = Assert.Single(fake.Requests);
        Assert.Equal("/v1/orders/search", request.RequestUri!.AbsolutePath);
        Assert.Equal("?${ref}=ch-3", request.RequestUri.Query);
        Assert.Equal(GatewayStatus.NotFound, (await Gateway(FakeGateway.Json(HttpStatusCode.OK, """{"data":[]}""")).Status("ch-4", null, Token)).Status);
    }

    [Fact]
    public async Task UnaOrderDevueltaSumaSusDevoluciones()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw(order('ORDR', S.REFUNDED, 'ch-r', { transactions: { refunds: [{ amount: '2.50' }, { amount: '2.50' }] } }))});
        var outcome = await Gateway(fake).Status("ch-r", "ORDR", Token);
        Assert.Equal(GatewayStatus.Refunded, outcome.Status);
        Assert.Equal("5.00", outcome.RefundedAmount?.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task UnaAccionDelClienteVaOpacaYSinMedioNoHayAccion()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw(order('ORDA', S.ACTION_REQUIRED, 'ch-a', { transactions: { payments: [{ payment_method: { type: 'credit_card', redirect_url: 'https://3ds' } }] } }))});
        Assert.Equal("""{"type":"credit_card","redirect_url":"https://3ds"}""", (await Gateway(fake).Status("ch-a", "ORDA", Token)).CustomerAction);
        var bare = FakeGateway.Json(HttpStatusCode.OK, ${raw(order('ORDB', S.ACTION_REQUIRED, 'ch-b'))});
        Assert.Null((await Gateway(bare).Status("ch-b", "ORDB", Token)).CustomerAction);
    }`);
  if (p.capture) {
    const args = p.capture.amount ? 'null, null, ' : '';
    cases.push(`
    [Fact]
    public async Task UnaCapturaQueLaPasarelaRechazaConsultaElEstadoReal()
    {
        var fake = new FakeGateway((request, _) => request.Method == HttpMethod.Post
            ? Reply(HttpStatusCode.Conflict, "{}")
            : Reply(HttpStatusCode.OK, ${raw(order('ORDC', S.CANCELED, 'ch-c'))}));
        var outcome = await Gateway(fake).Capture("ch-c", "ORDC", ${args}Token);
        Assert.Equal(GatewayStatus.Canceled, outcome.Status);
        Assert.Equal(2, fake.Requests.Count);
        Assert.Equal("ch-c:capture", fake.Requests[0].Request.Headers.GetValues(${header}).Single());
    }`);
  }
  if (p.refund) {
    if (p.refund.amount) {
      cases.push(`
    [Fact]
    public async Task UnaDevolucionParcialSinRespuestaQuedaEnDudaAunqueFalleLaLecturaPrevia()
    {
        var fake = FakeGateway.Json(HttpStatusCode.ServiceUnavailable, "{}");
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Refund("ch-f", "ORDF", 5.00m, "EUR", Token));
        var (request, _) = Assert.Single(fake.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
    }

    [Fact]
    public async Task UnaDevolucionParcialConUn5xxQuedaEnDudaYNoSeRepite()
    {
        var fake = new FakeGateway((request, _) => request.Method == HttpMethod.Get
            ? Reply(HttpStatusCode.OK, """{"id":"ORDG","transactions":{"payments":[{"id":"PAY1"}]}}""")
            : Reply(HttpStatusCode.BadGateway, "{}"));
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Refund("ch-g", "ORDG", 5.00m, "EUR", Token));
        Assert.Equal(2, fake.Requests.Count);
        var (refund, body) = fake.Requests[1];
        Assert.Equal("ch-g:refund", refund.Headers.GetValues(${header}).Single());
        Assert.Equal("""{"transactions":[{"id":"PAY1","amount":"5.00"}]}""", body);
    }`);
    } else {
      cases.push(`
    [Fact]
    public async Task UnaDevolucionConUn5xxQuedaEnDudaYNoSeRepite()
    {
        var fake = FakeGateway.Json(HttpStatusCode.BadGateway, "{}");
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Refund("ch-g", "ORDG", Token));
        Assert.Single(fake.Requests);
    }`);
    }
  }
  if (p.savePaymentMethod) {
    cases.push(`
    [Fact]
    public async Task GuardarUnMedioQueLaPasarelaRechazaEsSuExcepcionYSinRespuestaQuedaEnDuda()
    {
        var rejected = await Assert.ThrowsAsync<GatewayRejectedPaymentMethodException>(() => Gateway(FakeGateway.Json(HttpStatusCode.BadRequest, "{}")).SavePaymentMethod("tok", "payer-1", Token));
        Assert.Equal(400, rejected.Status);
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(FakeGateway.Json(HttpStatusCode.ServiceUnavailable, "{}")).SavePaymentMethod("tok", "payer-1", Token));
        var fake = new FakeGateway((request, _) => Reply(HttpStatusCode.Created, request.RequestUri!.AbsolutePath.EndsWith("/cards", StringComparison.Ordinal) ? """{"id":"card_1"}""" : """{"id":"cus_1"}"""));
        Assert.Equal("cus_1|card_1", await Gateway(fake).SavePaymentMethod("tok", "payer-1", Token));
        Assert.Equal("/v1/customers/cus_1/cards", fake.Requests[1].Request.RequestUri!.AbsolutePath);
        Assert.Equal(${csString(`save:tok:${TRANSLATION.savedMethodSteps[1]}`)}, fake.Requests[1].Request.Headers.GetValues(${header}).Single());
    }`);
  }
  const notice = TRANSLATION.notice;
  cases.push(`
    private static PaymentNotice Signed(string dataId, string requestId, string ts, string signature) =>
        PaymentNotice.Of(
            "{}",
            [new(${csString(p.gateway.webhook.signatureHeader)}, $"${notice.timestampField}={ts},${notice.signatureField}={signature}"), new(${csString(notice.requestIdHeader)}, requestId)],
            [new(${csString(notice.dataIdQuery)}, dataId)]);

    [Fact]
    public void UnAvisoFirmadoPorLaPasarelaVerificaYDiceDeQueCobroHabla()
    {
        var ts = Now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        Assert.Equal("ORD9", Verifier().Verify(Signed("ORD9", "req-1", ts, Hmac($"id:ord9;request-id:req-1;ts:{ts};"))));
        // El ts en milisegundos se normaliza para la ventana, y se firma tal como llegó.
        var ms = Now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
        Assert.Equal("ORD9", Verifier().Verify(Signed("ORD9", "req-1", ms, Hmac($"id:ord9;request-id:req-1;ts:{ms};"))));
    }

    [Fact]
    public void UnAvisoConOtraFirmaOFueraDeLaVentanaSeRechaza()
    {
        var ts = Now.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        Assert.Throws<InvalidPaymentNoticeException>(() => Verifier().Verify(Signed("ORD9", "req-1", ts, Hmac($"id:ord8;request-id:req-1;ts:{ts};"))));
        var old = (Now.ToUnixTimeSeconds() - Settings.NoticeToleranceSeconds - 1).ToString(CultureInfo.InvariantCulture);
        Assert.Throws<InvalidPaymentNoticeException>(() => Verifier().Verify(Signed("ORD9", "req-1", old, Hmac($"id:ord9;request-id:req-1;ts:{old};"))));
    }`);
  return { body: cases.join('\n'), usings: [] };
}
