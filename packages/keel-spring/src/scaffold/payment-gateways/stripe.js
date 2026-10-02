// El adaptador de Stripe (Payment Intents) y su verificador de avisos.
//
// Contrato contrastado con la documentación oficial (docs/pasarelas/fase0-contratos-stripe-mercadopago.md):
//   * cuerpos application/x-www-form-urlencoded; credencial como Bearer con la clave secreta;
//   * importe entero en la unidad menor;
//   * Idempotency-Key en todo POST: guarda también los 500 y caduca a las 24 h, así que NO es la
//     guarda del doble cargo (lo es la naturalKey del registro) y un 5xx no se reintenta: queda en duda;
//   * capture_method=manual para autorizar sin capturar; off_session=true con customer+payment_method
//     para un medio guardado, y authentication_required si el emisor exige autenticar;
//   * Stripe-Signature: t=…,v1=…[,v1=…]: HMAC-SHA256 de `${t}.${cuerpo crudo}`; solo cuenta v1, puede
//     haber varias durante la rotación del secreto, y se compara en tiempo constante.

import { javaFile, javaPath, subPackage } from '../render.js';

// Un corte de conexión a mitad de la respuesta no llega como ResourceAccessException sino como
// RestClientException genérica: se captura la general (después de la de respuesta HTTP, que es más
// específica) o ese caso escapa sin dejar la acción en duda. Lo destapó payment-check.
export function generate(model, ctx) {
  return [renderAdapter(model, ctx), renderVerifier(model, ctx)];
}

const SUB = 'infrastructure.payment.stripe';

// Los códigos de rechazo de Stripe (decline_code, o code si no hay) → vocabulario neutro.
const DECLINES = [
  ['insufficient_funds', 'insufficientFunds'],
  ['expired_card', 'expiredCard'],
  ['fraudulent', 'fraudSuspected'],
  ['stolen_card', 'fraudSuspected'],
  ['lost_card', 'fraudSuspected'],
  ['pickup_card', 'fraudSuspected'],
  ['merchant_blacklist', 'fraudSuspected'],
  ['authentication_required', 'authenticationFailed'],
  ['incorrect_cvc', 'invalidPaymentMethod'],
  ['incorrect_number', 'invalidPaymentMethod'],
  ['invalid_cvc', 'invalidPaymentMethod'],
  ['invalid_expiry_month', 'invalidPaymentMethod'],
  ['invalid_expiry_year', 'invalidPaymentMethod'],
  ['invalid_number', 'invalidPaymentMethod'],
  ['card_not_supported', 'invalidPaymentMethod'],
  ['resource_missing', 'invalidPaymentMethod'],
  ['processing_error', 'processingError'],
  ['try_again_later', 'processingError'],
  ['issuer_not_available', 'processingError']
];

function renderAdapter(model, ctx) {
  const p = model.payments;
  const F = ctx.failureEnumName;
  const declineCases = DECLINES.map(([code, literal]) => `            case "${code}" -> ${F}.${ctx.failureConstant(literal)};`).join('\n');
  const methods = [];

  methods.push(`    @Override
    public GatewayOutcome authorize(ChargeRequest request) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("amount", Long.toString(MoneyAmounts.toMinorUnits(request.amount(), request.currency())));
        form.add("currency", request.currency().toLowerCase(Locale.ROOT));
        form.add("capture_method", "${p.captureLater ? 'manual' : 'automatic'}");
        form.add("confirm", "true");
        form.add("payment_method_types[]", "card");
        form.add("metadata[" + REFERENCE_KEY + "]", request.reference());
        if (request.source().kind() == PaymentSource.Kind.SAVED) {
            // La referencia guardada es "customer|payment_method" (savePaymentMethod).
            String[] saved = request.source().value().split("\\\\|", 2);
            form.add("customer", saved[0]);
            form.add("payment_method", saved[1]);
            form.add("off_session", "true");
        } else {
            form.add("payment_method", request.source().value());
        }
        return post("/v1/payment_intents", form, idempotencyKey(request.reference(), "authorize"), request.reference());
    }`);

  if (p.capture) {
    const amountParam = p.capture.amount ? ', BigDecimal amount' : '';
    const amountLine = p.capture.amount
      ? `
        if (amount != null) {
            form.add("amount_to_capture", Long.toString(MoneyAmounts.toMinorUnits(amount, currencyOf(gatewayPaymentId))));
        }`
      : '';
    methods.push(`    @Override
    public GatewayOutcome capture(String reference, String gatewayPaymentId${amountParam}) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();${amountLine}
        return followUp("/v1/payment_intents/" + gatewayPaymentId + "/capture", form, reference, gatewayPaymentId, "capture");
    }`);
  }
  if (p.void) {
    methods.push(`    @Override
    public GatewayOutcome voidAuthorization(String reference, String gatewayPaymentId) {
        return followUp("/v1/payment_intents/" + gatewayPaymentId + "/cancel", new LinkedMultiValueMap<>(), reference,
                gatewayPaymentId, "void");
    }`);
  }
  if (p.refund) {
    const amountParam = p.refund.amount ? ', BigDecimal amount' : '';
    const amountLine = p.refund.amount
      ? `
        if (amount != null) {
            form.add("amount", Long.toString(MoneyAmounts.toMinorUnits(amount, currencyOf(gatewayPaymentId))));
        }`
      : '';
    methods.push(`    @Override
    public GatewayOutcome refund(String reference, String gatewayPaymentId${amountParam}) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("payment_intent", gatewayPaymentId);${amountLine}
        JsonNode refund;
        try {
            refund = json(http.post().uri("/v1/refunds")
                    .headers(headers -> credentials(headers, idempotencyKey(reference, "refund")))
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(String.class));
        } catch (RestClientResponseException rejected) {
            if (rejected.getStatusCode().is5xxServerError()) {
                throw unavailable("refund", rejected);
            }
            // Rechazada: el cobro sigue capturado.
            return GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
        } catch (RestClientException noAnswer) {
            throw unavailable("refund", noAnswer);
        }
        return switch (refund.path("status").asText()) {
            case "succeeded" -> GatewayOutcome.refunded(reference, gatewayPaymentId,
                    MoneyAmounts.fromMinorUnits(refund.path("amount").asLong(), refund.path("currency").asText().toUpperCase(Locale.ROOT)));
            case "pending", "requires_action" -> GatewayOutcome.of(GatewayStatus.PENDING, reference, gatewayPaymentId);
            default -> GatewayOutcome.of(GatewayStatus.CAPTURED, reference, gatewayPaymentId);
        };
    }`);
  }

  methods.push(`    @Override
    public GatewayOutcome status(String reference, String gatewayPaymentId) {
        try {
            if (gatewayPaymentId != null) {
                return outcomeOf(json(http.get().uri("/v1/payment_intents/{id}?expand[]=latest_charge", gatewayPaymentId)
                        .headers(headers -> credentials(headers, null))
                        .retrieve()
                        .body(String.class)), reference);
            }
            // Sin id: la pasarela no llegó a contestar. Se busca por la referencia que se le mandó en
            // metadata. La búsqueda de Stripe es eventualmente consistente (puede tardar un minuto en
            // ver un PaymentIntent recién creado): por eso el barrido solo mira lo que lleva más del
            // umbral esperando, y un NOT_FOUND aquí significa que no llegó.
            JsonNode found = json(http.get()
                    .uri(uri -> uri.path("/v1/payment_intents/search")
                            .queryParam("query", "metadata['" + REFERENCE_KEY + "']:'" + reference + "'")
                            .queryParam("expand[]", "data.latest_charge")
                            .build())
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
            MultiValueMap<String, String> customerForm = new LinkedMultiValueMap<>();
            customerForm.add("metadata[keel_payer]", payerReference);
            JsonNode customer = json(http.post().uri("/v1/customers")
                    .headers(headers -> credentials(headers, "save:" + token + ":customer"))
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(customerForm)
                    .retrieve()
                    .body(String.class));
            String customerId = customer.path("id").asText();
            MultiValueMap<String, String> attachForm = new LinkedMultiValueMap<>();
            attachForm.add("customer", customerId);
            http.post().uri("/v1/payment_methods/{pm}/attach", token)
                    .headers(headers -> credentials(headers, "save:" + token + ":attach"))
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(attachForm)
                    .retrieve()
                    .toBodilessEntity();
            return customerId + "|" + token;
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

  const needsCurrency = p.capture?.amount || p.refund?.amount;
  const currencyHelper = needsCurrency
    ? `

    /** La moneda del PaymentIntent, para convertir un importe parcial a su unidad. */
    private String currencyOf(String gatewayPaymentId) {
        return json(http.get().uri("/v1/payment_intents/{id}", gatewayPaymentId)
                .headers(headers -> credentials(headers, null))
                .retrieve()
                .body(String.class)).path("currency").asText().toUpperCase(Locale.ROOT);
    }`
    : '';

  const body = `/**
 * La pasarela de pago sobre Stripe (Payment Intents), por HTTP plano.
 *
 * <p>Lo que lleva dentro y no puede faltar:
 * <ul>
 *   <li>la clave de idempotencia sale de la referencia de negocio y la acción
 *       ({@code <referencia>:authorize}…), nunca de un aleatorio: un reintento repite la clave;</li>
 *   <li>un 5xx o un timeout NO se reintenta: lanza {@link PaymentGatewayUnavailableException} y la
 *       acción queda en duda para el barrido (Stripe guarda también los 500 con su clave);</li>
 *   <li>el importe se convierte a la unidad menor sin redondear;</li>
 *   <li>los rechazos se traducen al vocabulario neutro de ${F}.</li>
 * </ul>
 */
@Component
public class StripePaymentGateway implements PaymentGateway {

    /** La clave de metadata con la que viaja la referencia del cobro; es lo que permite buscarlo. */
    static final String REFERENCE_KEY = "keel_reference";

    private final RestClient http;
    private final PaymentGatewayProperties properties;
    private final ObjectMapper mapper;

    public StripePaymentGateway(RestClient paymentGatewayRestClient, PaymentGatewayProperties properties, ObjectMapper mapper) {
        this.http = paymentGatewayRestClient;
        this.properties = properties;
        this.mapper = mapper;
    }

${methods.join('\n\n')}

    // ─── HTTP ────────────────────────────────────────────────────────────────

    private GatewayOutcome post(String path, MultiValueMap<String, String> form, String idempotencyKey, String reference) {
        try {
            return outcomeOf(json(http.post().uri(path)
                    .headers(headers -> credentials(headers, idempotencyKey))
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(String.class)), reference);
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().is5xxServerError()) {
                throw unavailable(path, error);
            }
            return declined(error, reference);
        } catch (RestClientException noAnswer) {
            throw unavailable(path, noAnswer);
        }
    }

    /** Captura y anulación: si Stripe la rechaza por el estado del cobro, se devuelve el estado real. */
    private GatewayOutcome followUp(String path, MultiValueMap<String, String> form, String reference, String gatewayPaymentId,
            String action) {
        try {
            return outcomeOf(json(http.post().uri(path)
                    .headers(headers -> credentials(headers, idempotencyKey(reference, action)))
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(String.class)), reference);
        } catch (RestClientResponseException error) {
            if (error.getStatusCode().is5xxServerError()) {
                throw unavailable(action, error);
            }
            // payment_intent_unexpected_state y compañía: la autorización caducó, ya se capturó…
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

    private GatewayOutcome outcomeOf(JsonNode intent, String reference) {
        String id = intent.path("id").asText(null);
        String ref = intent.path("metadata").path(REFERENCE_KEY).asText(reference);
        JsonNode charge = intent.path("latest_charge");
        if (charge.isObject() && charge.path("amount_refunded").asLong() > 0) {
            return GatewayOutcome.refunded(ref, id, MoneyAmounts.fromMinorUnits(charge.path("amount_refunded").asLong(),
                    charge.path("currency").asText().toUpperCase(Locale.ROOT)));
        }
        return switch (intent.path("status").asText()) {
            case "requires_capture" -> GatewayOutcome.of(GatewayStatus.AUTHORIZED, ref, id);
            case "succeeded" -> GatewayOutcome.of(GatewayStatus.CAPTURED, ref, id);
            case "requires_action" -> GatewayOutcome.actionRequired(ref, id, customerAction(intent));
            case "canceled" -> GatewayOutcome.of(GatewayStatus.CANCELED, ref, id);
            case "requires_payment_method" -> {
                JsonNode error = intent.path("last_payment_error");
                yield error.isMissingNode() || error.isNull()
                        ? GatewayOutcome.of(GatewayStatus.PENDING, ref, id)
                        : GatewayOutcome.failed(ref, id, reasonOf(error));
            }
            default -> GatewayOutcome.of(GatewayStatus.PENDING, ref, id);
        };
    }

    /** Un 4xx al pedir el cobro: un rechazo del emisor (402) o un medio que no sirve (400). */
    private GatewayOutcome declined(RestClientResponseException rejected, String reference) {
        JsonNode error = json(rejected.getResponseBodyAsString()).path("error");
        JsonNode intent = error.path("payment_intent");
        String id = intent.path("id").asText(null);
        String code = error.path("decline_code").asText(error.path("code").asText(""));
        if ("authentication_required".equals(code) && intent.isObject()) {
            // Un cobro sin el cliente delante que el emisor quiere autenticar: no es un fallo, es una
            // acción del cliente pendiente (docs/dsl/payments.md § Dos puertas).
            return GatewayOutcome.actionRequired(reference, id, customerAction(intent));
        }
        return GatewayOutcome.failed(reference, id, reasonOf(error));
    }

    private String customerAction(JsonNode intent) {
        ObjectNode action = mapper.createObjectNode();
        action.put("clientSecret", intent.path("client_secret").asText(null));
        action.set("nextAction", intent.path("next_action"));
        return action.toString();
    }

    private ${F} reasonOf(JsonNode error) {
        String code = error.path("decline_code").asText(error.path("code").asText(""));
        return switch (code) {
${declineCases}
            default -> ${F}.${ctx.failureConstant('declined')};
        };
    }

    private JsonNode json(String body) {
        try {
            return mapper.readTree(body == null || body.isBlank() ? "{}" : body);
        } catch (JsonProcessingException unreadable) {
            throw new IllegalStateException("Stripe devolvió un cuerpo que no es JSON", unreadable);
        }
    }

    private PaymentGatewayUnavailableException unavailable(String action, Exception cause) {
        return new PaymentGatewayUnavailableException("Stripe no contestó a " + action + ": la acción queda en duda", cause);
    }${currencyHelper}
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
    'java.util.Locale',
    'org.springframework.http.HttpHeaders',
    'org.springframework.http.MediaType',
    'org.springframework.stereotype.Component',
    'org.springframework.util.LinkedMultiValueMap',
    'org.springframework.util.MultiValueMap',
    'org.springframework.web.client.RestClientException',
    'org.springframework.web.client.RestClient',
    'org.springframework.web.client.RestClientResponseException'
  ];
  if (p.capture?.amount || p.refund?.amount) imports.push('java.math.BigDecimal');
  return { path: javaPath(model, SUB, 'StripePaymentGateway'), content: javaFile(subPackage(model, SUB), imports, body) };
}

function renderVerifier(model, ctx) {
  const body = `/**
 * Verifica la cabecera Stripe-Signature: {@code t=<timestamp>,v1=<firma>[,v1=<firma>]}.
 *
 * <p>La firma es HMAC-SHA256 de {@code <t>.<cuerpo crudo>} con el secreto del endpoint. Solo cuenta
 * {@code v1} (el resto se ignora, contra el downgrade); puede haber varias durante la rotación del
 * secreto y basta con que verifique una; se compara en tiempo constante; y un {@code t} más antiguo
 * que la tolerancia se rechaza aunque la firma sea buena, porque es un aviso repetido.
 */
@Component
public class StripeNoticeVerifier implements PaymentNoticeVerifier {

    private final PaymentGatewayProperties properties;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    public StripeNoticeVerifier(PaymentGatewayProperties properties, ObjectMapper mapper) {
        this(properties, mapper, Clock.systemUTC());
    }

    StripeNoticeVerifier(PaymentGatewayProperties properties, ObjectMapper mapper, Clock clock) {
        this.properties = properties;
        this.mapper = mapper;
        this.clock = clock;
    }

    @Override
    public Optional<String> verify(byte[] body, HttpHeaders headers, Map<String, String> query) {
        String header = headers.getFirst("${model.payments.gateway.webhook.signatureHeader}");
        if (header == null || header.isBlank()) {
            throw new InvalidPaymentNoticeException("sin cabecera de firma");
        }
        Long timestamp = null;
        List<String> signatures = new ArrayList<>();
        for (String part : header.split(",")) {
            String[] pair = part.trim().split("=", 2);
            if (pair.length != 2) {
                continue;
            }
            if ("t".equals(pair[0])) {
                try {
                    timestamp = Long.parseLong(pair[1]);
                } catch (NumberFormatException malformed) {
                    throw new InvalidPaymentNoticeException("timestamp ilegible");
                }
            } else if ("v1".equals(pair[0])) {
                signatures.add(pair[1]);
            }
        }
        if (timestamp == null || signatures.isEmpty()) {
            throw new InvalidPaymentNoticeException("cabecera de firma incompleta");
        }
        if (Math.abs(clock.instant().getEpochSecond() - timestamp) > properties.noticeToleranceSeconds()) {
            throw new InvalidPaymentNoticeException("aviso fuera de la ventana de tolerancia");
        }
        byte[] expected = hmac(timestamp + "." + new String(body, StandardCharsets.UTF_8));
        boolean valid = signatures.stream()
                .anyMatch(signature -> MessageDigest.isEqual(expected, signature.getBytes(StandardCharsets.UTF_8)));
        if (!valid) {
            throw new InvalidPaymentNoticeException("la firma no verifica");
        }
        return paymentIntentOf(body);
    }

    /** El PaymentIntent del que habla el evento: el propio objeto, o el payment_intent de un cargo o una devolución. */
    private Optional<String> paymentIntentOf(byte[] body) {
        try {
            JsonNode object = mapper.readTree(body).path("data").path("object");
            if ("payment_intent".equals(object.path("object").asText())) {
                return Optional.ofNullable(object.path("id").asText(null));
            }
            return Optional.ofNullable(object.path("payment_intent").asText(null));
        } catch (java.io.IOException unreadable) {
            throw new InvalidPaymentNoticeException("el cuerpo no es JSON");
        }
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
    'com.fasterxml.jackson.databind.JsonNode',
    'com.fasterxml.jackson.databind.ObjectMapper',
    'java.nio.charset.StandardCharsets',
    'java.security.MessageDigest',
    'java.time.Clock',
    'java.util.ArrayList',
    'java.util.HexFormat',
    'java.util.List',
    'java.util.Map',
    'java.util.Optional',
    'javax.crypto.Mac',
    'javax.crypto.spec.SecretKeySpec',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.http.HttpHeaders',
    'org.springframework.stereotype.Component'
  ];
  return { path: javaPath(model, SUB, 'StripeNoticeVerifier'), content: javaFile(subPackage(model, SUB), imports, body) };
}
