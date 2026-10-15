// El adaptador de Stripe (Payment Intents) y su verificador de avisos, para keel-dotnet.
//
// Es la traducción del de keel-spring y keel-nest, caso por caso, y habla el MISMO contrato (keel-core/gen/payment-gateways.js:
// la clave de idempotencia, las claves de metadata, los rechazos, la marca de la captura caducada):
//   * cuerpos application/x-www-form-urlencoded; credencial como Bearer con la clave secreta;
//   * importe entero en la unidad menor, con la tabla de keel-core;
//   * Idempotency-Key en todo POST; un 5xx no se reintenta: queda en duda;
//   * Stripe-Signature: t=…,v1=…[,v1=…]: HMAC-SHA256 de `${t}.${cuerpo}`; solo cuenta v1, puede haber varias durante la
//     rotación del secreto, y se compara en tiempo constante.

import { gatewayTranslation } from 'keel-core/gen/payment-gateways';
import { paymentProbesFor } from 'keel-core/gen/payment-probes';
import { csFile, csString, located, namespaceOf } from '../render.js';
import { PAYMENT_GATEWAY_PORT, NOTICE_VERIFIER_PORT, paymentInfraNamespace, paymentNamespace, reasonMember } from '../payments.js';

const TRANSLATION = gatewayTranslation('stripe');
const PROBES = paymentProbesFor('stripe');

export const place = 'stripe';
export const adapterClass = 'StripePaymentGateway';
export const verifierClass = 'StripeNoticeVerifier';

export function generate(model) {
  const usings = [paymentNamespace(model), paymentInfraNamespace(model), namespaceOf(model, 'ports'), namespaceOf(model, 'enums')];
  const adapter = located(model, place, adapterClass);
  const verifier = located(model, place, verifierClass);
  return [
    { path: adapter.path, content: csFile({ namespace: adapter.namespace, usings: [...usings, 'System.Globalization', 'System.Text.Json'], body: adapterBody(model) }) },
    {
      path: verifier.path,
      content: csFile({ namespace: verifier.namespace, usings: [paymentInfraNamespace(model), 'System.Globalization', 'System.Security.Cryptography', 'System.Text', 'System.Text.Json'], body: verifierBody(model) })
    }
  ];
}

function adapterBody(model) {
  const p = model.payments;
  const F = p.record.failureReasonType;
  const ct = 'CancellationToken cancellationToken = default';
  const declines = TRANSLATION.declines.map(([code, literal]) => `        [${csString(code)}] = ${reasonMember(model, literal)},`).join('\n');
  const methods = [];

  methods.push(`    public async Task<GatewayOutcome> Authorize(ChargeRequest request, ${ct})
    {
        ArgumentNullException.ThrowIfNull(request);
        var form = new List<KeyValuePair<string, string>>
        {
            new("amount", MoneyAmounts.ToMinorUnits(request.Amount, request.Currency).ToString(CultureInfo.InvariantCulture)),
            new("currency", request.Currency.ToLowerInvariant()),
            new("capture_method", ${csString(p.captureLater ? 'manual' : 'automatic')}),
            new("confirm", "true"),
            new("payment_method_types[]", "card"),
            new($"metadata[{ReferenceKey}]", request.Reference)
        };
        if (request.Source.Kind == PaymentSourceKind.Saved)
        {
            // La referencia guardada es "customer${'|'}payment_method" (SavePaymentMethod).
            var (customer, paymentMethod) = GatewayKeys.SplitSaved(request.Source.Value);
            form.Add(new("customer", customer));
            form.Add(new("payment_method", paymentMethod));
            form.Add(new("off_session", "true"));
        }
        else
        {
            form.Add(new("payment_method", request.Source.Value));
        }
        var answer = await Send("authorize", new GatewayRequest("POST", "/v1/payment_intents", GatewayJson.FormBody(form), Key(GatewayKeys.Idempotency(request.Reference, "authorize"))), cancellationToken);
        if (answer.Status >= 500)
        {
            throw Unavailable("authorize", answer);
        }
        return answer.Status >= 400 ? Declined(answer, request.Reference) : OutcomeOf(GatewayJson.Parse(answer.Text, Gateway), request.Reference);
    }`);

  if (p.capture) {
    const amountParam = p.capture.amount ? ', decimal? amount, string? currency' : '';
    const amountLine = p.capture.amount
      ? `
        if (amount is { } partial)
        {
            form.Add(new("amount_to_capture", MoneyAmounts.ToMinorUnits(partial, GatewayKeys.RequiredCurrency(currency)).ToString(CultureInfo.InvariantCulture)));
        }`
      : '';
    methods.push(`    public Task<GatewayOutcome> Capture(string reference, string gatewayPaymentId${amountParam}, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        var form = new List<KeyValuePair<string, string>>();${amountLine}
        return FollowUp($"/v1/payment_intents/{Uri.EscapeDataString(gatewayPaymentId)}/capture", form, reference, gatewayPaymentId, "capture", cancellationToken);
    }`);
  }
  if (p.void) {
    methods.push(`    public Task<GatewayOutcome> VoidAuthorization(string reference, string gatewayPaymentId, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        return FollowUp($"/v1/payment_intents/{Uri.EscapeDataString(gatewayPaymentId)}/cancel", [], reference, gatewayPaymentId, "void", cancellationToken);
    }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', decimal? amount, string? currency' : '';
    const amountLine = p.refund.amount
      ? `
        if (amount is { } partial)
        {
            form.Add(new("amount", MoneyAmounts.ToMinorUnits(partial, GatewayKeys.RequiredCurrency(currency)).ToString(CultureInfo.InvariantCulture)));
        }`
      : '';
    methods.push(`    public async Task<GatewayOutcome> Refund(string reference, string gatewayPaymentId${amountParam}, ${ct})
    {
        ArgumentNullException.ThrowIfNull(gatewayPaymentId);
        var form = new List<KeyValuePair<string, string>> { new("payment_intent", gatewayPaymentId) };${amountLine}
        var answer = await Send("refund", new GatewayRequest("POST", "/v1/refunds", GatewayJson.FormBody(form), Key(GatewayKeys.Idempotency(reference, "refund"))), cancellationToken);
        if (answer.Status >= 500)
        {
            throw Unavailable("refund", answer);
        }
        if (answer.Status >= 400)
        {
            // Rechazada: el cobro sigue capturado.
            return GatewayOutcome.Of(GatewayStatus.Captured, reference, gatewayPaymentId);
        }
        var refund = GatewayJson.Parse(answer.Text, Gateway);
        return GatewayJson.Text(refund, "status") switch
        {
            "succeeded" => GatewayOutcome.Refunded(reference, gatewayPaymentId, MoneyAmounts.FromMinorUnits(GatewayJson.Minor(refund, "amount"), Upper(GatewayJson.Text(refund, "currency")))),
            "pending" or "requires_action" => GatewayOutcome.Of(GatewayStatus.Pending, reference, gatewayPaymentId),
            _ => GatewayOutcome.Of(GatewayStatus.Captured, reference, gatewayPaymentId)
        };
    }`);
  }

  methods.push(`    public async Task<GatewayOutcome> Status(string? reference, string? gatewayPaymentId, ${ct})
    {
        GatewayAnswer answer;
        if (gatewayPaymentId is not null)
        {
            answer = await Send("status", new GatewayRequest("GET", $"/v1/payment_intents/{Uri.EscapeDataString(gatewayPaymentId)}?expand[]=latest_charge"), cancellationToken);
        }
        else
        {
            // Sin id: la pasarela no llegó a contestar. Se busca por la referencia que se le mandó en metadata. La búsqueda de
            // Stripe es eventualmente consistente (puede tardar un minuto en ver un PaymentIntent recién creado): por eso el
            // barrido solo mira lo que lleva más del umbral esperando, y un NotFound aquí significa que no llegó.
            var query = GatewayJson.Form([new("query", $"metadata['{ReferenceKey}']:'{reference}'"), new("expand[]", "data.latest_charge")]);
            answer = await Send("status", new GatewayRequest("GET", "/v1/payment_intents/search?" + query), cancellationToken);
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
    const [customerStep, attachStep] = TRANSLATION.savedMethodSteps;
    methods.push(`    public async Task<string> SavePaymentMethod(string token, string payerReference, ${ct})
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(payerReference);
        var customer = await Send(
            "savePaymentMethod",
            new GatewayRequest("POST", "/v1/customers", GatewayJson.FormBody([new(${csString(`metadata[${TRANSLATION.payerKey}]`)}, payerReference)]), Key(GatewayKeys.SavedMethod(token, ${csString(customerStep)}))),
            cancellationToken);
        RejectedMethod(customer);
        var customerId = GatewayJson.Text(GatewayJson.Parse(customer.Text, Gateway), "id") ?? string.Empty;
        var attach = await Send(
            "savePaymentMethod",
            new GatewayRequest("POST", $"/v1/payment_methods/{Uri.EscapeDataString(token)}/attach", GatewayJson.FormBody([new("customer", customerId)]), Key(GatewayKeys.SavedMethod(token, ${csString(attachStep)}))),
            cancellationToken);
        RejectedMethod(attach);
        return GatewayKeys.Saved(customerId, token);
    }`);
  }

  return `/// <summary>La pasarela de pago sobre Stripe (Payment Intents), por HTTP plano.</summary>
/// <remarks>
/// Lo que lleva dentro y no puede faltar: la clave de idempotencia sale de la referencia de negocio y la acción
/// (<c>&lt;referencia&gt;:authorize</c>…), nunca de un aleatorio, así que un reintento repite la clave; un 5xx o un timeout
/// NO se reintenta: lanza PaymentGatewayUnavailableException y la acción queda en duda para el barrido (Stripe guarda
/// también los 500 con su clave); el importe se convierte a la unidad menor sin redondear; y los rechazos se traducen al
/// vocabulario neutro de ${F}.
/// </remarks>
public sealed class ${adapterClass}(PaymentGatewayHttp http) : ${PAYMENT_GATEWAY_PORT}
{
    /// <summary>La clave de metadata con la que viaja la referencia del cobro; es lo que permite buscarlo.</summary>
    public const string ReferenceKey = ${csString(TRANSLATION.referenceKey)};

    private const string Gateway = "Stripe";

    /// <summary>decline_code (o code si no hay) → motivo neutro (keel-core/gen/payment-gateways.js); lo que no está es el rechazo genérico.</summary>
    private static readonly Dictionary<string, ${F}> Declines = new(StringComparer.Ordinal)
    {
${declines}
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

    /// <summary>Captura y anulación: si Stripe la rechaza por el estado del cobro, se devuelve el estado real.</summary>
    private async Task<GatewayOutcome> FollowUp(string path, List<KeyValuePair<string, string>> form, string reference, string gatewayPaymentId, string action, CancellationToken cancellationToken)
    {
        var answer = await Send(action, new GatewayRequest("POST", path, GatewayJson.FormBody(form), Key(GatewayKeys.Idempotency(reference, action))), cancellationToken);
        if (answer.Status >= 500)
        {
            throw Unavailable(action, answer);
        }
        if (answer.Status >= 400)
        {
            // La autorización caducó: es la respuesta de la pasarela y no hace falta preguntarle. Se busca en el texto y no se
            // lee como JSON: un 4xx con un cuerpo que no es JSON no puede convertir una respuesta en una excepción.
            if (answer.Text.Contains(${csString(TRANSLATION.expiredCaptureMarker)}, StringComparison.Ordinal))
            {
                return GatewayOutcome.Of(GatewayStatus.Canceled, reference, gatewayPaymentId);
            }
            // payment_intent_unexpected_state y compañía (ya se capturó…): el estado real se consulta.
            return await Status(reference, gatewayPaymentId, cancellationToken);
        }
        return OutcomeOf(GatewayJson.Parse(answer.Text, Gateway), reference);
    }

    // ─── Traducción ───────────────────────────────────────────────────────────

    private static GatewayOutcome OutcomeOf(JsonElement intent, string? reference)
    {
        var id = GatewayJson.Text(intent, "id");
        var known = GatewayJson.Text(GatewayJson.Object(intent, "metadata"), ReferenceKey) ?? reference;
        if (GatewayJson.IsObject(intent, "latest_charge"))
        {
            var charge = GatewayJson.Object(intent, "latest_charge");
            var refunded = GatewayJson.Minor(charge, "amount_refunded");
            if (refunded > 0)
            {
                return GatewayOutcome.Refunded(known, id, MoneyAmounts.FromMinorUnits(refunded, Upper(GatewayJson.Text(charge, "currency"))));
            }
        }
        return GatewayJson.Text(intent, "status") switch
        {
            "requires_capture" => GatewayOutcome.Of(GatewayStatus.Authorized, known, id),
            "succeeded" => GatewayOutcome.Of(GatewayStatus.Captured, known, id),
            "requires_action" => GatewayOutcome.ActionRequired(known, id, CustomerAction(intent)),
            "canceled" => GatewayOutcome.Of(GatewayStatus.Canceled, known, id),
            "requires_payment_method" => GatewayJson.IsObject(intent, "last_payment_error")
                ? GatewayOutcome.Failed(known, id, ReasonOf(GatewayJson.Object(intent, "last_payment_error")))
                : GatewayOutcome.Of(GatewayStatus.Pending, known, id),
            _ => GatewayOutcome.Of(GatewayStatus.Pending, known, id)
        };
    }

    /// <summary>Un 4xx al pedir el cobro: un rechazo del emisor (402) o un medio que no sirve (400).</summary>
    private static GatewayOutcome Declined(GatewayAnswer answer, string reference)
    {
        var error = GatewayJson.Object(GatewayJson.Parse(answer.Text, Gateway), "error");
        var hasIntent = GatewayJson.IsObject(error, "payment_intent");
        var intent = GatewayJson.Object(error, "payment_intent");
        var id = hasIntent ? GatewayJson.Text(intent, "id") : null;
        if (CodeOf(error) == "authentication_required" && hasIntent)
        {
            // Un cobro sin el cliente delante que el emisor quiere autenticar: no es un fallo, es una acción del cliente
            // pendiente (docs/dsl/payments.md § Dos puertas).
            return GatewayOutcome.ActionRequired(reference, id, CustomerAction(intent));
        }
        return GatewayOutcome.Failed(reference, id, ReasonOf(error));
    }

    private static string CustomerAction(JsonElement intent) =>
        GatewayJson.Write([new("clientSecret", GatewayJson.Value(GatewayJson.Text(intent, "client_secret"))), new("nextAction", GatewayJson.Get(intent, "next_action"))]);

    private static string CodeOf(JsonElement error) => GatewayJson.Text(error, "decline_code") ?? GatewayJson.Text(error, "code") ?? string.Empty;

    private static ${F} ReasonOf(JsonElement error) => Declines.TryGetValue(CodeOf(error), out var reason) ? reason : ${reasonMember(model, 'declined')};

    private static string Upper(string? value) => (value ?? string.Empty).ToUpperInvariant();

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
/// Verifica la cabecera ${header}: <c>${notice.timestampField}=&lt;timestamp&gt;,${notice.signatureField}=&lt;firma&gt;[,${notice.signatureField}=&lt;firma&gt;]</c>.
/// </summary>
/// <remarks>
/// La firma es HMAC-SHA256 de <c>&lt;t&gt;.&lt;cuerpo&gt;</c> con el secreto del endpoint. Solo cuenta <c>${notice.signatureField}</c> (el resto se
/// ignora, contra el downgrade); puede haber varias durante la rotación del secreto y basta con que verifique una; se
/// compara en tiempo constante; y un <c>t</c> más antiguo que la tolerancia se rechaza aunque la firma sea buena, porque
/// es un aviso repetido.
/// </remarks>
public sealed class ${verifierClass}(PaymentGatewaySettings settings, TimeProvider clock) : ${NOTICE_VERIFIER_PORT}
{
    public string? Verify(PaymentNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        var header = notice.Header(${csString(header)});
        if (string.IsNullOrWhiteSpace(header))
        {
            throw new InvalidPaymentNoticeException("sin cabecera de firma");
        }
        long? timestamp = null;
        var signatures = new List<string>();
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
                timestamp = long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var parsed)
                    ? parsed
                    : throw new InvalidPaymentNoticeException("timestamp ilegible");
            }
            else if (name == ${csString(notice.signatureField)})
            {
                signatures.Add(value);
            }
        }
        if (timestamp is not { } seconds || signatures.Count == 0)
        {
            throw new InvalidPaymentNoticeException("cabecera de firma incompleta");
        }
        if (Math.Abs(clock.GetUtcNow().ToUnixTimeSeconds() - seconds) > settings.NoticeToleranceSeconds)
        {
            throw new InvalidPaymentNoticeException("aviso fuera de la ventana de tolerancia");
        }
        var signed = string.Create(CultureInfo.InvariantCulture, $"{seconds}.{notice.Body}");
        var expected = Encoding.UTF8.GetBytes(Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(settings.WebhookSecret), Encoding.UTF8.GetBytes(signed))));
        var valid = signatures.Exists(signature =>
        {
            var given = Encoding.UTF8.GetBytes(signature);
            return given.Length == expected.Length && CryptographicOperations.FixedTimeEquals(given, expected);
        });
        if (!valid)
        {
            throw new InvalidPaymentNoticeException("la firma no verifica");
        }
        return PaymentIntentOf(notice.Body);
    }

    /// <summary>El PaymentIntent del que habla el evento: el propio objeto, o el payment_intent de un cargo o una devolución.</summary>
    private static string? PaymentIntentOf(string body)
    {
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(body);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new InvalidPaymentNoticeException("el cuerpo no es JSON");
        }
        if (GatewayJson.Get(GatewayJson.Object(root, "data"), "object") is not { ValueKind: JsonValueKind.Object } data)
        {
            return null;
        }
        var field = GatewayJson.Text(data, "object") == "payment_intent" ? "id" : "payment_intent";
        return GatewayJson.Get(data, field) is { ValueKind: JsonValueKind.String } id ? id.GetString() : null;
    }
}`;
}

/** Un aviso firmado con el secreto de prueba que no habla de ningún cobro (PaymentNoticeEndpointTests). */
export function signedNotice(model) {
  const header = model.payments.gateway.webhook.signatureHeader;
  return `    private static HttpRequestMessage Signed()
    {
        const string body = ${raw({ type: 'customer.created', data: { object: { object: 'customer', id: 'cus_1' } } })};
        var t = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var request = new HttpRequestMessage(HttpMethod.Post, Path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add(${csString(header)}, $"${TRANSLATION.notice.timestampField}={t},${TRANSLATION.notice.signatureField}={Hmac($"{t}.{body}")}");
        return request;
    }`;
}

// ─── Los casos de la prueba emitida (PaymentGatewayTests) ───────────────────────────────────────

/** Una respuesta del doble como literal C# crudo ("""…"""), con el JSON de las formas de payment-probes. */
const raw = (value) => `"""${JSON.stringify(value)}"""`;

export function testCases(model) {
  const p = model.payments;
  const S = PROBES.statuses;
  const header = csString(p.gateway.idempotencyHeader);
  const intent = (id, status, reference, extra = {}) => ({ id, object: 'payment_intent', status, metadata: { [TRANSLATION.referenceKey]: reference }, ...extra });
  // Cada código de rechazo del doble tiene que volver como su motivo: el que dice la traducción, o el genérico.
  const translated = new Map(TRANSLATION.declines);
  const declineRows = Object.values(PROBES.declines)
    .filter((code, index, all) => all.indexOf(code) === index)
    .map((code) => `    [InlineData(${csString(code)}, ${csString(reasonMember(model, translated.get(code) ?? 'declined').split('.')[1])})]`);
  const cases = [];
  cases.push(`
    [Fact]
    public async Task LaClaveSaleDeLaReferenciaYElImporteVaEnLaUnidadDeLaPasarela()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw(intent('pi_1', S.AUTHORIZED, 'ch-1'))});
        var outcome = await Gateway(fake).Authorize(Charge("ch-1"), Token);
        Assert.Equal(GatewayStatus.Authorized, outcome.Status);
        Assert.Equal("pi_1", outcome.GatewayPaymentId);
        Assert.Equal("ch-1", outcome.Reference);
        var (request, body) = Assert.Single(fake.Requests);
        Assert.Equal("ch-1:authorize", request.Headers.GetValues(${header}).Single());
        Assert.Equal("Bearer clave", request.Headers.Authorization!.ToString());
        Assert.Equal("application/x-www-form-urlencoded", request.Content!.Headers.ContentType!.ToString());
        Assert.Contains("amount=1250", body, StringComparison.Ordinal);
        Assert.Contains("currency=eur", body, StringComparison.Ordinal);
        Assert.Contains("metadata%5B${TRANSLATION.referenceKey}%5D=ch-1", body, StringComparison.Ordinal);
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
    public async Task UnRechazoCaeEnElVocabularioNeutro(string code, string reason)
    {
        // La forma del doble (payment-probes): el PaymentIntent fallido con su último error.
        var fake = FakeGateway.Json(HttpStatusCode.OK, "{\\"id\\":\\"pi_d\\",\\"status\\":\\"${S.FAILED}\\",\\"last_payment_error\\":{\\"code\\":\\"card_declined\\",\\"decline_code\\":\\"" + code + "\\"}}");
        var outcome = await Gateway(fake).Status("ch-d", "pi_d", Token);
        Assert.Equal(GatewayStatus.Failed, outcome.Status);
        Assert.Equal(reason, outcome.FailureReason?.ToString());
        Assert.Equal("pi_d", outcome.GatewayPaymentId);
    }

    [Fact]
    public async Task UnRechazoDelEmisorAlPedirElCobroEsUnCobroFallido()
    {
        var fake = FakeGateway.Json(HttpStatusCode.PaymentRequired, ${raw({ error: { type: 'card_error', code: 'card_declined', decline_code: PROBES.declines.insufficientFunds, payment_intent: { id: 'pi_e' } } })});
        var outcome = await Gateway(fake).Authorize(Charge("ch-e"), Token);
        Assert.Equal(GatewayStatus.Failed, outcome.Status);
        Assert.Equal(${csString(reasonMember(model, 'insufficientFunds').split('.')[1])}, outcome.FailureReason?.ToString());
        Assert.Equal("pi_e", outcome.GatewayPaymentId);
    }

    [Fact]
    public async Task UnCobroSinElClienteQuePideAutenticarseEsUnaAccionDelCliente()
    {
        var fake = FakeGateway.Json(HttpStatusCode.PaymentRequired, ${raw({ error: { code: 'authentication_required', payment_intent: { id: 'pi_a', client_secret: 'sec', next_action: { type: 'use_stripe_sdk' } } } })});
        var outcome = await Gateway(fake).Authorize(Charge("ch-a"), Token);
        Assert.Equal(GatewayStatus.ActionRequired, outcome.Status);
        Assert.Equal("""{"clientSecret":"sec","nextAction":{"type":"use_stripe_sdk"}}""", outcome.CustomerAction);
    }

    [Fact]
    public async Task SinIdSeBuscaPorLaReferencia()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw({ data: [intent('pi_3', S.CAPTURED, 'ch-3')] })});
        var outcome = await Gateway(fake).Status("ch-3", null, Token);
        Assert.Equal(GatewayStatus.Captured, outcome.Status);
        Assert.Equal("pi_3", outcome.GatewayPaymentId);
        var (request, _) = Assert.Single(fake.Requests);
        Assert.Equal("/v1/payment_intents/search", request.RequestUri!.AbsolutePath);
        Assert.Contains("query=metadata%5B%27${TRANSLATION.referenceKey}%27%5D%3A%27ch-3%27", request.RequestUri.Query, StringComparison.Ordinal);
        Assert.Equal(GatewayStatus.NotFound, (await Gateway(FakeGateway.Json(HttpStatusCode.OK, """{"data":[]}""")).Status("ch-4", null, Token)).Status);
    }

    [Fact]
    public async Task UnCobroDevueltoSeLeeDeSuUltimoCargo()
    {
        var fake = FakeGateway.Json(HttpStatusCode.OK, ${raw(intent('pi_r', S.REFUNDED, 'ch-r', { latest_charge: { amount_refunded: 500, currency: 'eur' } }))});
        var outcome = await Gateway(fake).Status("ch-r", "pi_r", Token);
        Assert.Equal(GatewayStatus.Refunded, outcome.Status);
        Assert.Equal("5.00", outcome.RefundedAmount?.ToString(CultureInfo.InvariantCulture));
    }`);
  if (p.capture) {
    const args = p.capture.amount ? 'null, null, ' : '';
    cases.push(`
    [Fact]
    public async Task CapturarUnaAutorizacionCaducadaEsUnCobroAnulado()
    {
        var fake = FakeGateway.Json(HttpStatusCode.BadRequest, ${raw({ error: { code: TRANSLATION.expiredCaptureMarker } })});
        var outcome = await Gateway(fake).Capture("ch-e", "pi_e", ${args}Token);
        Assert.Equal(GatewayStatus.Canceled, outcome.Status);
        var (request, _) = Assert.Single(fake.Requests);
        Assert.Equal("ch-e:capture", request.Headers.GetValues(${header}).Single());
    }

    [Fact]
    public async Task UnaCapturaQueLaPasarelaRechazaPorSuEstadoConsultaElEstadoReal()
    {
        var fake = new FakeGateway((request, _) => request.Method == HttpMethod.Post
            ? Reply(HttpStatusCode.BadRequest, """{"error":{"code":"payment_intent_unexpected_state"}}""")
            : Reply(HttpStatusCode.OK, ${raw(intent('pi_u', S.CAPTURED, 'ch-u'))}));
        var outcome = await Gateway(fake).Capture("ch-u", "pi_u", ${args}Token);
        Assert.Equal(GatewayStatus.Captured, outcome.Status);
        Assert.Equal(2, fake.Requests.Count);
    }`);
  }
  if (p.refund) {
    const amount = p.refund.amount ? '5.00m, "EUR", ' : '';
    cases.push(`
    [Fact]
    public async Task UnaDevolucionConUn5xxQuedaEnDudaYNoSeRepite()
    {
        var fake = FakeGateway.Json(HttpStatusCode.BadGateway, "{}");
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(fake).Refund("ch-f", "pi_f", ${amount}Token));
        var (request, body) = Assert.Single(fake.Requests);
        Assert.Equal("ch-f:refund", request.Headers.GetValues(${header}).Single());${p.refund.amount ? '\n        Assert.Contains("amount=500", body, StringComparison.Ordinal);' : '\n        Assert.Contains("payment_intent=pi_f", body, StringComparison.Ordinal);'}
    }

    [Fact]
    public async Task UnaDevolucionHechaDiceLoDevueltoYUnaRechazadaDejaElCobroCapturado()
    {
        var done = await Gateway(FakeGateway.Json(HttpStatusCode.OK, """{"status":"succeeded","amount":500,"currency":"eur"}""")).Refund("ch-g", "pi_g", ${amount}Token);
        Assert.Equal(GatewayStatus.Refunded, done.Status);
        Assert.Equal(5.00m, done.RefundedAmount);
        var rejected = await Gateway(FakeGateway.Json(HttpStatusCode.BadRequest, "{}")).Refund("ch-g", "pi_g", ${amount}Token);
        Assert.Equal(GatewayStatus.Captured, rejected.Status);
    }`);
  }
  if (p.savePaymentMethod) {
    cases.push(`
    [Fact]
    public async Task GuardarUnMedioQueLaPasarelaRechazaEsSuExcepcionYSinRespuestaQuedaEnDuda()
    {
        var rejected = await Assert.ThrowsAsync<GatewayRejectedPaymentMethodException>(() => Gateway(FakeGateway.Json(HttpStatusCode.PaymentRequired, "{}")).SavePaymentMethod("tok", "payer-1", Token));
        Assert.Equal(402, rejected.Status);
        await Assert.ThrowsAsync<PaymentGatewayUnavailableException>(() => Gateway(FakeGateway.Json(HttpStatusCode.ServiceUnavailable, "{}")).SavePaymentMethod("tok", "payer-1", Token));
        var fake = FakeGateway.Json(HttpStatusCode.OK, """{"id":"cus_1"}""");
        Assert.Equal("cus_1|tok", await Gateway(fake).SavePaymentMethod("tok", "payer-1", Token));
        Assert.Equal(2, fake.Requests.Count);
        Assert.Equal("/v1/payment_methods/tok/attach", fake.Requests[1].Request.RequestUri!.AbsolutePath);
        Assert.Equal(${csString(`save:tok:${TRANSLATION.savedMethodSteps[1]}`)}, fake.Requests[1].Request.Headers.GetValues(${header}).Single());
    }`);
  }
  const noticeBody = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pi_9' } } });
  cases.push(`
    private static PaymentNotice Signed(string body, long timestamp, params string[] signatures) =>
        PaymentNotice.Of(
            body,
            [new(${csString(p.gateway.webhook.signatureHeader.toLowerCase())}, string.Create(CultureInfo.InvariantCulture, $"t={timestamp},") + string.Join(',', signatures.Select(signature => "v1=" + signature)))],
            []);

    [Fact]
    public void UnAvisoFirmadoPorLaPasarelaVerificaYDiceDeQueCobroHabla()
    {
        const string body = ${raw(JSON.parse(noticeBody))};
        var now = Now.ToUnixTimeSeconds();
        Assert.Equal("pi_9", Verifier().Verify(Signed(body, now, Hmac(string.Create(CultureInfo.InvariantCulture, $"{now}.{body}")))));
        // Durante la rotación del secreto llegan dos firmas: basta con que verifique una.
        Assert.Equal("pi_9", Verifier().Verify(Signed(body, now, new string('0', 64), Hmac(string.Create(CultureInfo.InvariantCulture, $"{now}.{body}")))));
        const string charge = """{"data":{"object":{"object":"charge","payment_intent":"pi_7"}}}""";
        Assert.Equal("pi_7", Verifier().Verify(Signed(charge, now, Hmac(string.Create(CultureInfo.InvariantCulture, $"{now}.{charge}")))));
    }

    [Fact]
    public void UnAvisoConOtraFirmaOFueraDeLaVentanaSeRechaza()
    {
        const string body = ${raw(JSON.parse(noticeBody))};
        var now = Now.ToUnixTimeSeconds();
        Assert.Throws<InvalidPaymentNoticeException>(() => Verifier().Verify(Signed(body, now, Hmac(string.Create(CultureInfo.InvariantCulture, $"{now}.{body} ")))));
        var old = now - Settings.NoticeToleranceSeconds - 1;
        Assert.Throws<InvalidPaymentNoticeException>(() => Verifier().Verify(Signed(body, old, Hmac(string.Create(CultureInfo.InvariantCulture, $"{old}.{body}")))));
    }`);
  return { body: cases.join('\n'), usings: [] };
}
