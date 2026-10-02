// El adaptador de MercadoPago (API de Orders) y su verificador de avisos.
//
// Contrato contrastado con la documentación oficial (docs/pasarelas/fase0-contratos-stripe-mercadopago.md):
//   * Orders y no la API clásica de pagos: es la única con cobro sin el cliente delante;
//   * JSON; credencial Bearer (access token); X-Idempotency-Key en las escrituras;
//   * importe decimal en la unidad mayor ("12.50");
//   * capture_mode manual para autorizar sin capturar (solo crédito);
//   * x-signature: ts=…,v1=…: HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
//     La firma NO cubre el cuerpo: el aviso solo dice de qué order habla, y el estado se consulta.
//
// Lo marcado VERIFICAR EN SANDBOX es lo que la matriz de gateway-support.js declara `unverified`: la
// documentación no fija la forma exacta y build lo genera con la lectura más probable, avisando.

import { javaFile, javaPath, subPackage } from '../render.js';

// Un corte de conexión a mitad de la respuesta no llega como ResourceAccessException sino como
// RestClientException genérica: se captura la general (después de la de respuesta HTTP, que es más
// específica) o ese caso escapa sin dejar la acción en duda. Lo destapó payment-check.
export function generate(model, ctx) {
  return [renderAdapter(model, ctx), renderVerifier(model, ctx)];
}

const SUB = 'infrastructure.payment.mercadopago';

// status_detail de un pago de MercadoPago → vocabulario neutro.
const DETAILS = [
  ['cc_rejected_insufficient_amount', 'insufficientFunds'],
  ['insufficient_amount', 'insufficientFunds'],
  ['cc_rejected_bad_filled_date', 'expiredCard'],
  ['expired_card', 'expiredCard'],
  ['cc_rejected_high_risk', 'fraudSuspected'],
  ['cc_rejected_blacklist', 'fraudSuspected'],
  ['high_risk', 'fraudSuspected'],
  ['cc_rejected_3ds_challenge', 'authenticationFailed'],
  ['cc_rejected_3ds_mandatory', 'authenticationFailed'],
  ['cc_rejected_bad_filled_security_code', 'invalidPaymentMethod'],
  ['cc_rejected_bad_filled_card_number', 'invalidPaymentMethod'],
  ['cc_rejected_bad_filled_other', 'invalidPaymentMethod'],
  ['cc_rejected_card_disabled', 'invalidPaymentMethod'],
  ['invalid_card_token', 'invalidPaymentMethod'],
  ['cc_rejected_card_error', 'processingError'],
  ['processing_error', 'processingError']
];

function renderAdapter(model, ctx) {
  const p = model.payments;
  const F = ctx.failureEnumName;
  const detailCases = DETAILS.map(([code, literal]) => `            case "${code}" -> ${F}.${ctx.failureConstant(literal)};`).join('\n');
  const methods = [];

  methods.push(`    @Override
    public GatewayOutcome authorize(ChargeRequest request) {
        String amount = MoneyAmounts.toMajorUnits(request.amount(), request.currency());
        ObjectNode order = mapper.createObjectNode();
        order.put("type", "online");
        order.put("processing_mode", "automatic");
        order.put("capture_mode", "${p.captureLater ? 'manual' : 'automatic'}");
        order.put("external_reference", request.reference());
        order.put("total_amount", amount);
        ObjectNode payment = order.putObject("transactions").putArray("payments").addObject();
        payment.put("amount", amount);
        ObjectNode method = payment.putObject("payment_method");
        method.put("type", "credit_card");
        method.put("installments", 1);
        if (request.source().kind() == PaymentSource.Kind.SAVED) {
            // VERIFICAR EN SANDBOX (gateway-support.js: off-session sin verificar). La referencia
            // guardada es "customer_id|card_id" (savePaymentMethod); los pagos automáticos de Orders
            // cobran con el perfil guardado y la credencial almacenada, sin CVV ni token nuevo.
            String[] saved = request.source().value().split("\\\\|", 2);
            order.putObject("payer").put("customer_id", saved[0]);
            method.put("id", saved[1]);
            ObjectNode stored = payment.putObject("stored_credential");
            stored.put("payment_initiator", "merchant");
            stored.put("reason", "unscheduled");
            stored.put("first_payment", false);
        } else {
            method.put("token", request.source().value());
        }
        return write(http.post().uri("/v1/orders"), order, idempotencyKey(request.reference(), "authorize"), request.reference());
    }`);

  if (p.capture) {
    const amountParam = p.capture.amount ? ', BigDecimal amount' : '';
    methods.push(`    @Override
    public GatewayOutcome capture(String reference, String gatewayPaymentId${amountParam}) {
        return followUp("/v1/orders/" + gatewayPaymentId + "/capture", mapper.createObjectNode(), reference, gatewayPaymentId,
                "capture");
    }`);
  }
  if (p.void) {
    methods.push(`    @Override
    public GatewayOutcome voidAuthorization(String reference, String gatewayPaymentId) {
        return followUp("/v1/orders/" + gatewayPaymentId + "/cancel", mapper.createObjectNode(), reference, gatewayPaymentId,
                "void");
    }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', BigDecimal amount' : '';
    const partial = p.refund.amount
      ? `
        if (amount != null) {
            // La devolución parcial nombra la transacción de pago de la order y su importe.
            JsonNode current = fetch(gatewayPaymentId);
            JsonNode transaction = current.path("transactions").path("payments").path(0);
            ObjectNode partial = body.putArray("transactions").addObject();
            partial.put("id", transaction.path("id").asText());
            partial.put("amount", MoneyAmounts.toMajorUnits(amount, current.path("currency").asText("BRL")));
        }`
      : '';
    methods.push(`    @Override
    public GatewayOutcome refund(String reference, String gatewayPaymentId${amountParam}) {
        ObjectNode body = mapper.createObjectNode();${partial}
        return followUp("/v1/orders/" + gatewayPaymentId + "/refund", body, reference, gatewayPaymentId, "refund");
    }`);
  }

  methods.push(`    @Override
    public GatewayOutcome status(String reference, String gatewayPaymentId) {
        try {
            if (gatewayPaymentId != null) {
                return outcomeOf(fetch(gatewayPaymentId), reference);
            }
            // Sin id: la pasarela no llegó a contestar. Se busca por external_reference.
            // VERIFICAR EN SANDBOX: la búsqueda de orders por referencia externa.
            JsonNode found = json(http.get()
                    .uri(uri -> uri.path("/v1/orders/search").queryParam("external_reference", reference).build())
                    .headers(headers -> credentials(headers, null))
                    .retrieve()
                    .body(String.class));
            JsonNode first = found.path("data").path(0);
            return first.isMissingNode() ? GatewayOutcome.notFound(reference) : outcomeOf(first, reference);
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().value() == 404) {
                return GatewayOutcome.notFound(reference);
            }
            throw unavailable("status", error);
        } catch (RestClientException noAnswer) {
            throw unavailable("status", noAnswer);
        }
    }`);

  if (p.savePaymentMethod) {
    methods.push(`    @Override
    public String savePaymentMethod(String token, String payerReference) {
        try {
            ObjectNode customerBody = mapper.createObjectNode();
            customerBody.put("description", payerReference);
            JsonNode customer = json(http.post().uri("/v1/customers")
                    .headers(headers -> credentials(headers, "save:" + token + ":customer"))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(customerBody.toString())
                    .retrieve()
                    .body(String.class));
            String customerId = customer.path("id").asText();
            ObjectNode cardBody = mapper.createObjectNode();
            cardBody.put("token", token);
            JsonNode card = json(http.post().uri("/v1/customers/{id}/cards", customerId)
                    .headers(headers -> credentials(headers, "save:" + token + ":card"))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(cardBody.toString())
                    .retrieve()
                    .body(String.class));
            return customerId + "|" + card.path("id").asText();
        } catch (RestClientResponseException rejected) {
            if (rejected.getStatusCode().is5xxServerError()) {
                throw unavailable("savePaymentMethod", rejected);
            }
            throw new IllegalArgumentException("La pasarela no acepta el medio de pago: " + rejected.getStatusText(), rejected);
        } catch (RestClientException noAnswer) {
            throw unavailable("savePaymentMethod", noAnswer);
        }
    }`);
  }

  const body = `/**
 * La pasarela de pago sobre MercadoPago (API de Orders), por HTTP plano.
 *
 * <p>Lo que lleva dentro y no puede faltar:
 * <ul>
 *   <li>la clave de idempotencia sale de la referencia de negocio y la acción
 *       ({@code <referencia>:authorize}…), nunca de un aleatorio;</li>
 *   <li>un 5xx o un timeout NO se reintenta: lanza {@link PaymentGatewayUnavailableException} y la
 *       acción queda en duda para el barrido;</li>
 *   <li>el importe viaja en unidades mayores con la escala exacta de la moneda, sin redondear;</li>
 *   <li>los rechazos se traducen al vocabulario neutro de ${F}.</li>
 * </ul>
 */
@Component
public class MercadopagoPaymentGateway implements PaymentGateway {

    private final RestClient http;
    private final PaymentGatewayProperties properties;
    private final ObjectMapper mapper;

    public MercadopagoPaymentGateway(RestClient paymentGatewayRestClient, PaymentGatewayProperties properties,
            ObjectMapper mapper) {
        this.http = paymentGatewayRestClient;
        this.properties = properties;
        this.mapper = mapper;
    }

${methods.join('\n\n')}

    // ─── HTTP ────────────────────────────────────────────────────────────────

    private JsonNode fetch(String orderId) {
        return json(http.get().uri("/v1/orders/{id}", orderId)
                .headers(headers -> credentials(headers, null))
                .retrieve()
                .body(String.class));
    }

    private GatewayOutcome write(RestClient.RequestBodySpec request, ObjectNode body, String idempotencyKey, String reference) {
        try {
            return outcomeOf(json(request
                    .headers(headers -> credentials(headers, idempotencyKey))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body.toString())
                    .retrieve()
                    .body(String.class)), reference);
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().is5xxServerError()) {
                throw unavailable("authorize", error);
            }
            // Un 4xx al crear la order: el token o el medio no sirven.
            return GatewayOutcome.failed(reference, null, reasonOf(json(error.getResponseBodyAsString())));
        } catch (RestClientException noAnswer) {
            throw unavailable("authorize", noAnswer);
        }
    }

    /** Captura, anulación y devolución: si MercadoPago la rechaza, se devuelve el estado real de la order. */
    private GatewayOutcome followUp(String path, ObjectNode body, String reference, String gatewayPaymentId, String action) {
        try {
            return outcomeOf(json(http.post().uri(path)
                    .headers(headers -> credentials(headers, idempotencyKey(reference, action)))
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body.toString())
                    .retrieve()
                    .body(String.class)), reference);
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().is5xxServerError()) {
                throw unavailable(action, error);
            }
            return status(reference, gatewayPaymentId);
        } catch (RestClientException noAnswer) {
            throw unavailable(action, noAnswer);
        }
    }

    private void credentials(HttpHeaders headers, String idempotencyKey) {
        headers.setBearerAuth(properties.apiKey());
        if (idempotencyKey != null) {
            headers.set("${p.gateway.idempotencyHeader}", idempotencyKey);
        }
    }

    /** La clave de una acción sobre un cobro: la misma en cada reintento y por las dos puertas. */
    static String idempotencyKey(String reference, String action) {
        return reference + ":" + action;
    }

    // ─── Traducción ──────────────────────────────────────────────────────────

    private GatewayOutcome outcomeOf(JsonNode order, String reference) {
        String id = order.path("id").asText(null);
        String ref = order.path("external_reference").asText(reference);
        JsonNode payment = order.path("transactions").path("payments").path(0);
        String detail = order.path("status_detail").asText(payment.path("status_detail").asText(""));
        String status = order.path("status").asText("");
        if (status.equals("refunded") || detail.equals("refunded") || detail.equals("partially_refunded")) {
            BigDecimal refunded = BigDecimal.ZERO;
            for (JsonNode refund : order.path("transactions").path("refunds")) {
                refunded = refunded.add(new BigDecimal(refund.path("amount").asText("0")));
            }
            return GatewayOutcome.refunded(ref, id, refunded);
        }
        return switch (status) {
            case "action_required" -> GatewayOutcome.actionRequired(ref, id, customerAction(payment));
            case "processed" -> detail.equals("waiting_capture")
                    ? GatewayOutcome.of(GatewayStatus.AUTHORIZED, ref, id)
                    : GatewayOutcome.of(GatewayStatus.CAPTURED, ref, id);
            case "failed" -> GatewayOutcome.failed(ref, id, reasonOf(payment));
            case "canceled", "expired" -> GatewayOutcome.of(GatewayStatus.CANCELED, ref, id);
            default -> GatewayOutcome.of(GatewayStatus.PENDING, ref, id);
        };
    }

    /** VERIFICAR EN SANDBOX (gateway-support.js: customer-action sin verificar): la acción va opaca. */
    private String customerAction(JsonNode payment) {
        return payment.path("payment_method").toString();
    }

    private ${F} reasonOf(JsonNode node) {
        String detail = node.path("status_detail").asText(node.path("cause").path(0).path("code").asText(""));
        return switch (detail) {
${detailCases}
            default -> ${F}.${ctx.failureConstant('declined')};
        };
    }

    private JsonNode json(String body) {
        try {
            return mapper.readTree(body == null || body.isBlank() ? "{}" : body);
        } catch (JsonProcessingException unreadable) {
            throw new IllegalStateException("MercadoPago devolvió un cuerpo que no es JSON", unreadable);
        }
    }

    private PaymentGatewayUnavailableException unavailable(String action, Exception cause) {
        return new PaymentGatewayUnavailableException("MercadoPago no contestó a " + action + ": la acción queda en duda", cause);
    }
}`;
  const imports = [
    `${ctx.domainPkg}.ChargeRequest`,
    `${ctx.domainPkg}.GatewayOutcome`,
    `${ctx.domainPkg}.GatewayStatus`,
    `${ctx.domainPkg}.PaymentGatewayUnavailableException`,
    `${ctx.domainPkg}.PaymentSource`,
    ctx.failureEnum,
    `${ctx.portPkg}.PaymentGateway`,
    `${ctx.infraPkg}.MoneyAmounts`,
    `${ctx.infraPkg}.PaymentGatewayProperties`,
    'com.fasterxml.jackson.core.JsonProcessingException',
    'com.fasterxml.jackson.databind.JsonNode',
    'com.fasterxml.jackson.databind.ObjectMapper',
    'com.fasterxml.jackson.databind.node.ObjectNode',
    'java.math.BigDecimal',
    'org.springframework.http.HttpHeaders',
    'org.springframework.http.MediaType',
    'org.springframework.stereotype.Component',
    'org.springframework.web.client.RestClientException',
    'org.springframework.web.client.RestClient',
    'org.springframework.web.client.RestClientResponseException'
  ];
  return { path: javaPath(model, SUB, 'MercadopagoPaymentGateway'), content: javaFile(subPackage(model, SUB), imports, body) };
}

function renderVerifier(model, ctx) {
  const body = `/**
 * Verifica la cabecera x-signature de MercadoPago: {@code ts=<timestamp>,v1=<firma>}.
 *
 * <p>La firma es HMAC-SHA256 del manifiesto {@code id:<data.id>;request-id:<x-request-id>;ts:<ts>;},
 * con {@code data.id} sacado de la URL y en minúsculas; lo que falte se quita del manifiesto. Se
 * compara en tiempo constante y un {@code ts} fuera de la tolerancia se rechaza. <b>La firma no cubre
 * el cuerpo</b>: por eso de aquí solo sale el id de la order, y su estado se le pregunta a la pasarela.
 */
@Component
public class MercadopagoNoticeVerifier implements PaymentNoticeVerifier {

    private final PaymentGatewayProperties properties;
    private final Clock clock;

    @Autowired
    public MercadopagoNoticeVerifier(PaymentGatewayProperties properties) {
        this(properties, Clock.systemUTC());
    }

    MercadopagoNoticeVerifier(PaymentGatewayProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
    }

    @Override
    public Optional<String> verify(byte[] body, HttpHeaders headers, Map<String, String> query) {
        String header = headers.getFirst("${model.payments.gateway.webhook.signatureHeader}");
        if (header == null || header.isBlank()) {
            throw new InvalidPaymentNoticeException("sin cabecera de firma");
        }
        String ts = null;
        String signature = null;
        for (String part : header.split(",")) {
            String[] pair = part.trim().split("=", 2);
            if (pair.length != 2) {
                continue;
            }
            if ("ts".equals(pair[0])) {
                ts = pair[1];
            } else if ("v1".equals(pair[0])) {
                signature = pair[1];
            }
        }
        if (ts == null || signature == null) {
            throw new InvalidPaymentNoticeException("cabecera de firma incompleta");
        }
        long seconds;
        try {
            long raw = Long.parseLong(ts);
            // El ts puede venir en milisegundos: se normaliza antes de comparar con la ventana.
            seconds = raw > 100_000_000_000L ? raw / 1000 : raw;
        } catch (NumberFormatException malformed) {
            throw new InvalidPaymentNoticeException("timestamp ilegible");
        }
        if (Math.abs(clock.instant().getEpochSecond() - seconds) > properties.noticeToleranceSeconds()) {
            throw new InvalidPaymentNoticeException("aviso fuera de la ventana de tolerancia");
        }
        String dataId = query.get("data.id");
        String requestId = headers.getFirst("x-request-id");
        StringBuilder manifest = new StringBuilder();
        if (dataId != null && !dataId.isBlank()) {
            manifest.append("id:").append(dataId.toLowerCase(Locale.ROOT)).append(';');
        }
        if (requestId != null && !requestId.isBlank()) {
            manifest.append("request-id:").append(requestId).append(';');
        }
        manifest.append("ts:").append(ts).append(';');
        byte[] expected = hmac(manifest.toString());
        if (!MessageDigest.isEqual(expected, signature.getBytes(StandardCharsets.UTF_8))) {
            throw new InvalidPaymentNoticeException("la firma no verifica");
        }
        return Optional.ofNullable(dataId == null || dataId.isBlank() ? null : dataId);
    }

    private byte[] hmac(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(properties.webhookSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8))).getBytes(StandardCharsets.UTF_8);
        } catch (java.security.GeneralSecurityException impossible) {
            throw new IllegalStateException("HmacSHA256 no disponible", impossible);
        }
    }
}`;
  const imports = [
    `${ctx.infraPkg}.InvalidPaymentNoticeException`,
    `${ctx.infraPkg}.PaymentGatewayProperties`,
    `${ctx.infraPkg}.PaymentNoticeVerifier`,
    'java.nio.charset.StandardCharsets',
    'java.security.MessageDigest',
    'java.time.Clock',
    'java.util.HexFormat',
    'java.util.Locale',
    'java.util.Map',
    'java.util.Optional',
    'javax.crypto.Mac',
    'javax.crypto.spec.SecretKeySpec',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.http.HttpHeaders',
    'org.springframework.stereotype.Component'
  ];
  return { path: javaPath(model, SUB, 'MercadopagoNoticeVerifier'), content: javaFile(subPackage(model, SUB), imports, body) };
}
