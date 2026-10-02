// La pasarela de pago de prueba en el arnés (AbstractFlowIT): una API NEUTRA —los mismos métodos con
// cualquier pasarela— para que los escenarios se traduzcan a pruebas una sola vez, igual que el
// diseño se escribe una sola vez. Por debajo, cada método programa el WireMock de infra/ con la forma
// de la pasarela elegida (payment-probes.js) y firma los avisos como los firmaría ella.
//
// No es un doble dentro de la JVM: el servidor habla HTTP con WireMock por el mismo socket que con la
// pasarela real, con el mismo adaptador. Lo que se mide es el servidor.

import { paymentProbesFor } from '../lib/payment-probes.js';
import { PAYMENT_TEST_SECRETS } from './config.js';
import { PAYMENT_NOTICE_PATH } from './payments.js';

export function usesPaymentHarness(model) {
  return Boolean(model.payments);
}

export function paymentHarnessImports(model) {
  if (!usesPaymentHarness(model)) return [];
  return [
    'java.math.BigDecimal',
    'java.nio.charset.StandardCharsets',
    'java.time.Instant',
    'java.util.HexFormat',
    'java.util.List',
    'java.util.Locale',
    'java.util.Map',
    'java.util.UUID',
    'javax.crypto.Mac',
    'javax.crypto.spec.SecretKeySpec',
    'org.springframework.http.HttpMethod'
  ];
}

/** La moneda con la que corren los escenarios: el testValue del parámetro, si la moneda sale de uno. */
function testCurrency(model) {
  const parameter = model.payments.charge.currency?.parameter;
  const found = parameter ? (model.service.parameters ?? []).find((entry) => entry.name === parameter) : null;
  return String(found?.testValue ?? 'EUR').toUpperCase();
}

export function paymentHarnessSection(model) {
  if (!usesPaymentHarness(model)) return '';
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  const currency = testCurrency(model);
  const routes = Object.entries(probes.calls)
    .map(([call, route]) => `            Map.entry(GatewayCall.${call}, new String[] {"${route.method}", "${route.path}"})`)
    .join(',\n');
  const calls = Object.keys(probes.calls).join(', ');
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes, currency) : mercadopagoSpecific(probes, currency);
  return `
    // ── Pasarela de pago de prueba (capa payments, ${gateway.label}) ─────────────
    //
    // La API es NEUTRA: los mismos métodos con cualquier pasarela, porque los escenarios no nombran
    // ninguna. Cada método programa el WireMock de infra/ con la forma de la elegida.

    /** Las llamadas que el servidor le hace a la pasarela. */
    protected enum GatewayCall { ${calls} }

    private static final Map<GatewayCall, String[]> GATEWAY_ROUTES = Map.ofEntries(
${routes});

    /** El secreto con el que el perfil local verifica los avisos (parameters/local/payments.yaml). */
    private static final String GATEWAY_WEBHOOK_SECRET = "${PAYMENT_TEST_SECRETS.webhookSecret}";

    /** La moneda de los escenarios (testValue del parámetro de despliegue). */
    private static final String GATEWAY_CURRENCY = "${currency}";

    /**
     * El id que la pasarela de prueba asigna al cobro de esa referencia. Es determinista para que el
     * escenario pueda nombrarlo antes de pedir el cobro (para un aviso, por ejemplo).
     */
    protected static String gatewayIdFor(String reference) {
        return "${probes.idPrefix}" + reference.replaceAll("[^A-Za-z0-9]", "");
    }

    /** El siguiente cobro con esa referencia queda autorizado (importe retenido). */
    protected static void gatewayAuthorizes(String reference) {
        gatewayStub(GatewayCall.CHARGE, null, reference, 200, gatewayObject(reference, "AUTHORIZED", null, null));
    }

    /** El siguiente cobro con esa referencia queda cobrado en el acto. */
    protected static void gatewayCharges(String reference) {
        gatewayStub(GatewayCall.CHARGE, null, reference, 200, gatewayObject(reference, "CAPTURED", null, null));
    }

    /** El siguiente cobro con esa referencia exige que el cliente se autentique (3DS). */
    protected static void gatewayRequiresAction(String reference) {
        gatewayStub(GatewayCall.CHARGE, null, reference, 200, gatewayObject(reference, "ACTION_REQUIRED", null, null));
    }

    /**
     * El siguiente cobro con esa referencia se rechaza, con un motivo del vocabulario neutro
     * (declined, insufficientFunds, expiredCard, authenticationFailed, fraudSuspected,
     * invalidPaymentMethod, processingError).
     */
    protected static void gatewayDeclines(String reference, String reason) {
        gatewayDecline(reference, reason);
    }

    /** La pasarela no contesta a esa llamada: corta la conexión. La acción queda EN DUDA. */
    protected static void gatewayDoesNotAnswer(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        stubConnectionFault(route[0], route[1]);
    }

    /**
     * Lo que responde la pasarela cuando se le pregunta por el cobro de esa referencia, por su id y
     * por la referencia. Con "NOT_FOUND" no lo conoce: la petición no le llegó nunca.
     */
    protected static void gatewayReports(String reference, String status) {
        if ("NOT_FOUND".equals(status)) {
            gatewayStubPath(GatewayCall.STATUS, gatewayIdFor(reference), null, 404, "{}");
            gatewayStub(GatewayCall.SEARCH, reference, null, 200, "{\\"data\\": []}");
            return;
        }
        String object = gatewayObject(reference, status, null, "REFUNDED".equals(status) ? new BigDecimal("10.00") : null);
        gatewayStubPath(GatewayCall.STATUS, gatewayIdFor(reference), null, 200, object);
        gatewayStub(GatewayCall.SEARCH, reference, null, 200, "{\\"data\\": [" + object + "]}");
    }

    /** La pasarela captura el cobro de esa referencia en el acto. */
    protected static void gatewayCaptures(String reference) {
        gatewayStubPath(GatewayCall.CAPTURE, gatewayIdFor(reference), null, 200, gatewayObject(reference, "CAPTURED", null, null));
    }

    /** La pasarela anula la autorización del cobro de esa referencia en el acto. */
    protected static void gatewayCancels(String reference) {
        gatewayStubPath(GatewayCall.CANCEL, gatewayIdFor(reference), null, 200, gatewayObject(reference, "CANCELED", null, null));
    }

    /**
     * La autorización del cobro de esa referencia caducó antes de capturarse: la captura se
     * rechaza y, preguntada, la pasarela lo da por anulado. Es el desenlace que la pasarela
     * impone sola pasado su plazo (unos días), y ningún escenario puede esperarlo.
     */
    protected static void gatewayExpiresAuthorization(String reference) {
        gatewayStubPath(GatewayCall.CAPTURE, gatewayIdFor(reference), null, 400, gatewayExpiredCapture(reference));
        gatewayReports(reference, "CANCELED");
    }

    /** La pasarela rechaza esa llamada (4xx): la acción no se hizo. */
    protected static void gatewayRejects(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        stubFor(route[0], route[1], 400, "{\\"error\\": {\\"code\\": \\"rejected_by_test\\"}}");
    }

    /** La pasarela guarda el medio de pago que se le pase. */
    protected static void gatewaySavesPaymentMethod() {
        String[] save = GATEWAY_ROUTES.get(GatewayCall.SAVE_METHOD);
        String[] attach = GATEWAY_ROUTES.get(GatewayCall.ATTACH_METHOD);
        stubFor(save[0], save[1], 200, "{\\"id\\": \\"cus_keel_test\\"}");
        stubFor(attach[0], attach[1], 200, "{\\"id\\": \\"card_keel_test\\"}");
    }

    /** Cuántas veces llamó el servidor a la pasarela por esa llamada. */
    protected static int gatewayCallCount(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        return stubCallCount(route[0], route[1]);
    }

    /** Las peticiones que recibió la pasarela por esa llamada (para afirmar cabeceras y cuerpos). */
    protected static List<String> gatewayRequests(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        return stubRequests(route[0], route[1]);
    }

    /** La pasarela avisa de que algo cambió en el cobro de esa referencia, firmado como lo firma ella. */
    protected Response sendGatewayNotice(String reference) {
        return gatewayNotice(reference, GATEWAY_WEBHOOK_SECRET);
    }

    /** Un aviso con la firma ALTERADA: el servidor tiene que rechazarlo sin consultar nada. */
    protected Response sendForgedGatewayNotice(String reference) {
        return gatewayNotice(reference, GATEWAY_WEBHOOK_SECRET + "-falso");
    }

    // Un mapping del doble para una llamada: con \`bodyContains\` solo casa la petición cuyo cuerpo lo
    // lleve (la referencia), con \`queryContains\` la que lo lleve en su parámetro de búsqueda.
    private static void gatewayStub(GatewayCall call, String queryContains, String bodyContains, int status, String json) {
        String[] route = GATEWAY_ROUTES.get(call);
        gatewayMapping(route[0], route[1], queryContains, bodyContains, status, json);
    }

    // Igual, sobre la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).
    private static void gatewayStubPath(GatewayCall call, String gatewayId, String bodyContains, int status, String json) {
        String[] route = GATEWAY_ROUTES.get(call);
        gatewayMapping(route[0], route[1].replace("(?!search)[^/]+", gatewayId).replace("[^/]+", gatewayId), null,
                bodyContains, status, json);
    }

    private static void gatewayMapping(String method, String pathPattern, String queryContains, String bodyContains,
            int status, String json) {
        StringBuilder request = new StringBuilder("{")
                .append(quote("method")).append(": ").append(quote(method)).append(", ")
                .append(quote("urlPathPattern")).append(": ").append(quote(pathPattern));
        if (queryContains != null) {
            request.append(", ").append(quote("queryParameters")).append(": {")
                    .append(quote("${probes.calls.SEARCH.query}")).append(": {").append(quote("contains")).append(": ")
                    .append(quote(queryContains)).append("}}");
        }
        if (bodyContains != null) {
            request.append(", ").append(quote("bodyPatterns")).append(": [{").append(quote("contains")).append(": ")
                    .append(quote(bodyContains)).append("}]");
        }
        request.append("}");
        String response = "{" + quote("status") + ": " + status + ", " + quote("headers") + ": {"
                + quote("Content-Type") + ": " + quote("application/json") + "}, " + quote("body") + ": " + quote(json) + "}";
        stubAdmin("/mappings", "{" + quote("request") + ": " + request + ", " + quote("response") + ": " + response + "}");
    }

    private static String gatewayHmac(String secret, String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
${specific}`;
}

function stripeSpecific(probes, currency) {
  const statusMap = Object.entries(probes.statuses).map(([key, value]) => `            Map.entry("${key}", "${value}")`).join(',\n');
  const declineMap = Object.entries(probes.declines).map(([key, value]) => `            Map.entry("${key}", "${value}")`).join(',\n');
  return `
    private static final Map<String, String> GATEWAY_STATUSES = Map.ofEntries(
${statusMap});

    private static final Map<String, String> GATEWAY_DECLINES = Map.ofEntries(
${declineMap});

    // Un PaymentIntent con la forma que lee StripePaymentGateway.outcomeOf.
    private static String gatewayObject(String reference, String status, String declineCode, BigDecimal refunded) {
        String id = gatewayIdFor(reference);
        StringBuilder json = new StringBuilder("{\\"id\\": \\"" + id + "\\", \\"object\\": \\"payment_intent\\"")
                .append(", \\"currency\\": \\"").append(GATEWAY_CURRENCY.toLowerCase(Locale.ROOT)).append("\\"")
                .append(", \\"status\\": \\"").append(GATEWAY_STATUSES.get(status)).append("\\"")
                .append(", \\"metadata\\": {\\"keel_reference\\": \\"").append(reference).append("\\"}")
                .append(", \\"client_secret\\": \\"").append(id).append("_secret_test\\"");
        if ("ACTION_REQUIRED".equals(status)) {
            json.append(", \\"next_action\\": {\\"type\\": \\"use_stripe_sdk\\"}");
        }
        if ("FAILED".equals(status)) {
            json.append(", \\"last_payment_error\\": {\\"code\\": \\"card_declined\\", \\"decline_code\\": \\"")
                    .append(declineCode == null ? "generic_decline" : declineCode).append("\\"}");
        }
        if (refunded != null) {
            json.append(", \\"latest_charge\\": {\\"amount_refunded\\": ").append(refunded.movePointRight(2).longValueExact())
                    .append(", \\"currency\\": \\"").append(GATEWAY_CURRENCY.toLowerCase(Locale.ROOT)).append("\\"}");
        }
        return json.append("}").toString();
    }

    // Stripe rechaza un cobro confirmado con un 402 y el PaymentIntent dentro del error. El de
    // autenticación no: un 402 authentication_required es una ACCIÓN del cliente pendiente, así que
    // ese motivo llega como el PaymentIntent fallido que devuelve la consulta.
    private static void gatewayDecline(String reference, String reason) {
        String code = GATEWAY_DECLINES.getOrDefault(reason, "generic_decline");
        String failed = gatewayObject(reference, "FAILED", code, null);
        if ("authenticationFailed".equals(reason)) {
            gatewayStub(GatewayCall.CHARGE, null, reference, 200, failed);
            return;
        }
        gatewayStub(GatewayCall.CHARGE, null, reference, 402,
                "{\\"error\\": {\\"type\\": \\"card_error\\", \\"code\\": \\"card_declined\\", \\"decline_code\\": \\"" + code
                        + "\\", \\"payment_intent\\": " + failed + "}}");
    }

    // Stripe contesta a capturar una autorización caducada con este código, y el adaptador lo lee.
    private static String gatewayExpiredCapture(String reference) {
        return "{\\"error\\": {\\"type\\": \\"invalid_request_error\\", \\"code\\": \\"charge_expired_for_capture\\"}}";
    }

    /** La devolución del cobro de esa referencia se completa por ese importe. */
    protected static void gatewayRefunds(String reference, BigDecimal amount) {
        gatewayStub(GatewayCall.REFUND, null, gatewayIdFor(reference), 200,
                "{\\"id\\": \\"re_" + gatewayIdFor(reference) + "\\", \\"status\\": \\"succeeded\\", \\"amount\\": "
                        + amount.movePointRight(2).longValueExact() + ", \\"currency\\": \\""
                        + GATEWAY_CURRENCY.toLowerCase(Locale.ROOT) + "\\", \\"payment_intent\\": \\"" + gatewayIdFor(reference) + "\\"}");
    }

    private Response gatewayNotice(String reference, String secret) {
        String id = gatewayIdFor(reference);
        String body = "{\\"id\\": \\"evt_" + id + "\\", \\"type\\": \\"payment_intent.updated\\", \\"data\\": {\\"object\\": {\\"id\\": \\""
                + id + "\\", \\"object\\": \\"payment_intent\\"}}}";
        long t = Instant.now().getEpochSecond();
        return exchange(HttpMethod.POST, "${PAYMENT_NOTICE_PATH}", body, null, null,
                Map.of("${probes.notice.signatureHeader}", "t=" + t + ",v1=" + gatewayHmac(secret, t + "." + body)));
    }
`;
}

function mercadopagoSpecific(probes, currency) {
  const statusMap = Object.entries(probes.statuses)
    .map(([key, [status, detail]]) => `            Map.entry("${key}", new String[] {"${status}", "${detail}"})`)
    .join(',\n');
  const declineMap = Object.entries(probes.declines).map(([key, value]) => `            Map.entry("${key}", "${value}")`).join(',\n');
  return `
    private static final Map<String, String[]> GATEWAY_STATUSES = Map.ofEntries(
${statusMap});

    private static final Map<String, String> GATEWAY_DECLINES = Map.ofEntries(
${declineMap});

    // Una order con la forma que lee MercadopagoPaymentGateway.outcomeOf.
    private static String gatewayObject(String reference, String status, String detail, BigDecimal refunded) {
        String id = gatewayIdFor(reference);
        String[] state = GATEWAY_STATUSES.get(status);
        String statusDetail = detail != null ? detail : state[1];
        StringBuilder json = new StringBuilder("{\\"id\\": \\"" + id + "\\"")
                .append(", \\"status\\": \\"").append(state[0]).append("\\"")
                .append(", \\"status_detail\\": \\"").append(statusDetail).append("\\"")
                .append(", \\"external_reference\\": \\"").append(reference).append("\\"")
                .append(", \\"currency\\": \\"").append(GATEWAY_CURRENCY).append("\\"")
                .append(", \\"transactions\\": {\\"payments\\": [{\\"id\\": \\"PAY").append(id)
                .append("\\", \\"status_detail\\": \\"").append(statusDetail)
                .append("\\", \\"payment_method\\": {\\"type\\": \\"credit_card\\", \\"url\\": \\"https://pasarela.test/3ds/")
                .append(id).append("\\"}}]");
        if (refunded != null) {
            json.append(", \\"refunds\\": [{\\"amount\\": \\"").append(refunded.toPlainString()).append("\\"}]");
        }
        return json.append("}}").toString();
    }

    private static void gatewayDecline(String reference, String reason) {
        String detail = GATEWAY_DECLINES.getOrDefault(reason, "cc_rejected_other_reason");
        gatewayStub(GatewayCall.CHARGE, null, reference, 200, gatewayObject(reference, "FAILED", detail, null));
    }

    // MercadoPago no documenta un código para la captura caducada: el adaptador consulta el estado.
    private static String gatewayExpiredCapture(String reference) {
        return "{\\"errors\\": [{\\"code\\": \\"order_expired\\"}]}";
    }

    /**
     * La devolución del cobro de esa referencia se completa por ese importe. Programa también la
     * consulta de la order (capturada), porque una devolución parcial la lee antes para nombrar la
     * transacción.
     */
    protected static void gatewayRefunds(String reference, BigDecimal amount) {
        gatewayStubPath(GatewayCall.STATUS, gatewayIdFor(reference), null, 200, gatewayObject(reference, "CAPTURED", null, null));
        gatewayStubPath(GatewayCall.REFUND, gatewayIdFor(reference), null, 200, gatewayObject(reference, "REFUNDED", null, amount));
    }

    private Response gatewayNotice(String reference, String secret) {
        String id = gatewayIdFor(reference);
        String requestId = UUID.randomUUID().toString();
        long ts = Instant.now().getEpochSecond();
        String manifest = "id:" + id.toLowerCase(Locale.ROOT) + ";request-id:" + requestId + ";ts:" + ts + ";";
        String body = "{\\"action\\": \\"order.updated\\", \\"type\\": \\"order\\", \\"data\\": {\\"id\\": \\"" + id + "\\"}}";
        return exchange(HttpMethod.POST, "${PAYMENT_NOTICE_PATH}?data.id=" + id + "&type=order", body, null, null,
                Map.of("${probes.notice.signatureHeader}", "ts=" + ts + ",v1=" + gatewayHmac(secret, manifest), "x-request-id", requestId));
    }
`;
}
