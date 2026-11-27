// La pasarela de pago de prueba en el arnés (AbstractFlowIT): una API NEUTRA —los mismos métodos con
// cualquier pasarela— para que los escenarios se traduzcan a pruebas una sola vez, igual que el
// diseño se escribe una sola vez. Por debajo, cada método programa el WireMock de infra/ con la forma
// de la pasarela elegida (payment-probes.js) y firma los avisos como los firmaría ella.
//
// No es un doble dentro de la JVM: el servidor habla HTTP con WireMock por el mismo socket que con la
// pasarela real, con el mismo adaptador. Lo que se mide es el servidor.

import { DEFAULT_SAVED_CARD, paymentProbesFor, saveAuthenticationRejection, savedCardResponse } from '@keel-system/keel-core/gen/payment-probes';
import { PAYMENT_TEST_SECRETS } from './config.js';
import { PAYMENT_NOTICE_PATH } from './payments.js';
import { paymentTestCurrency as testCurrency } from '@keel-system/keel-core/gen/payments-config';
import { refundTranslation, tracksRefundInFlight } from '@keel-system/keel-core/gen/payment-gateways';

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


export function paymentHarnessSection(model) {
  if (!usesPaymentHarness(model)) return '';
  const gateway = model.payments.gateway;
  const probes = paymentProbesFor(gateway.id);
  // La respuesta de guardar con el resumen en las rutas que lee el adaptador (keel-core: savedCardResponse), como
  // plantilla de String.format: %s para los textos y %d para los meses y años.
  const cardTemplate = JSON.stringify(savedCardResponse(gateway.id, { brand: '@B@', last4: '@L@', expMonth: -71, expYear: -72 }))
    .replace('"@B@"', '"%s"').replace('"@L@"', '"%s"').replace('-71', '%d').replace('-72', '%d')
    .replace(/"/g, '\\"');
  const authentication = saveAuthenticationRejection(gateway.id);
  const card = DEFAULT_SAVED_CARD;
  const currency = testCurrency(model);
  const routes = Object.entries(probes.calls)
    .map(([call, route]) => `            Map.entry(GatewayCall.${call}, new String[] {"${route.method}", "${route.path}"})`)
    .join(',\n');
  const calls = Object.keys(probes.calls).join(', ');
  const tracks = tracksRefundInFlight(model.payments);
  const specific = gateway.id === 'stripe' ? stripeSpecific(probes, currency, tracks) : mercadopagoSpecific(probes, currency, tracks);
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

    /**
     * La pasarela no contesta a esa llamada: la respuesta se corta a mitad. La acción queda EN DUDA, y la pasarela cuenta
     * UNA petición: con un corte antes de responder, el cliente HTTP del JDK repite una consulta (un GET) y
     * {@link #gatewayCallCount} contaría dos (corrida payment-spring, FL-REC-005).
     */
    protected static void gatewayDoesNotAnswer(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        stubBrokenResponse(route[0], route[1]);
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
        if ("REFUNDED".equals(status)) {
${tracks
  ? `            // Con varias devoluciones por cobro, la consulta del cobro no dice nada de una devolución: la contesta la
            // de la devolución en vuelo.
            throw new IllegalArgumentException("gatewayReports: una devolución se programa con gatewayReportsRefund(referencia, "
                    + "referencia de la devolución, desenlace, importe, lo devuelto antes)");`
  : `            gatewayReportsRefunded(reference, new BigDecimal("10.00"));
            return;`}
        }
        gatewayReportsObject(reference, gatewayObject(reference, status, null, null));
    }
${tracks
  ? `
    /**
     * Lo que la pasarela dice de UNA devolución del cobro de esa referencia, la de {@code refundReference}, cuando el
     * servidor le pregunta por ella (una devolución cuya respuesta no llegó y el barrido resuelve consultando):
     * "REFUNDED" (se completó por {@code amount}), "PENDING" (la sigue procesando), "FAILED" (la rechazó) o "MISSING" (no
     * le llegó nunca; {@code amount} no se usa). {@code previouslyRefunded} es lo que la pasarela ya había devuelto del
     * cobro en devoluciones ANTERIORES, ya registradas (cero si es la primera): es lo que distingue el importe de ESTA
     * devolución del acumulado.
     */
    protected static void gatewayReportsRefund(String reference, String refundReference, String outcome, BigDecimal amount,
            BigDecimal previouslyRefunded) {
        if (!List.of("REFUNDED", "PENDING", "FAILED", "MISSING").contains(outcome)) {
            throw new IllegalArgumentException("gatewayReportsRefund: " + outcome + " no es REFUNDED, PENDING, FAILED ni MISSING");
        }
        gatewayRefundsAtGateway(reference, refundReference, outcome, amount, previouslyRefunded);
    }
`
  : `
    /**
     * Preguntada por el cobro de esa referencia, la pasarela lo da por devuelto con ESE total: lo que mide un escenario
     * de devolución parcial, o una devolución cuya respuesta no llegó y el barrido resuelve consultando.
     */
    protected static void gatewayReportsRefunded(String reference, BigDecimal refundedTotal) {
        gatewayReportsObject(reference, gatewayObject(reference, "REFUNDED", null, refundedTotal));
    }
`}
    private static void gatewayReportsObject(String reference, String object) {
        gatewayStubPath(GatewayCall.STATUS, gatewayIdFor(reference), null, 200, object);
        gatewayStub(GatewayCall.SEARCH, reference, null, 200, "{\\"data\\": [" + object + "]}");
    }

    /**
     * La anulación del cobro de esa referencia vuelve como un cobro FALLIDO con un motivo del vocabulario neutro (la del
     * 3DS que el cliente no completó es "authenticationFailed"): el desenlace no es la anulación sino el fallo.
     */
    protected static void gatewayCancelFails(String reference, String reason) {
        gatewayStubPath(GatewayCall.CANCEL, gatewayIdFor(reference), null, 200,
                gatewayObject(reference, "FAILED", GATEWAY_DECLINES.get(reason), null));
    }

    /**
     * La pasarela RETIENE su respuesta a esa llamada {@code delayMs} milisegundos y después contesta con el cobro en ese
     * estado: lo que hace escribible un escenario en el que el aviso llega ANTES que la respuesta (envía el aviso
     * mientras tanto, desde otro hilo). Vale para CHARGE, CAPTURE y CANCEL. El retardo tiene que quedar por debajo del
     * read-timeout del cliente de la pasarela (payments.gateway.read-timeout), o la acción quedará en duda.
     */
    protected static void gatewayAnswersLate(GatewayCall call, String reference, String status, int delayMs) {
        String object = gatewayObject(reference, status, null, null);
        switch (call) {
            case CHARGE -> gatewayStub(GatewayCall.CHARGE, null, reference, 200, object, delayMs);
            case CAPTURE, CANCEL -> gatewayStubPath(call, gatewayIdFor(reference), null, 200, object, delayMs);
            default -> throw new IllegalArgumentException("gatewayAnswersLate: " + call + " no devuelve el cobro; usa CHARGE, CAPTURE o CANCEL");
        }
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

    /**
     * La pasarela rechaza esa llamada (4xx): la acción no se hizo. Tras rechazar una captura, una anulación o una
     * devolución, el servidor le PREGUNTA a la pasarela el estado real del cobro (el rechazo no lo dice): programa también
     * {@code gatewayReports(referencia, "AUTHORIZED")} —o "CAPTURED" para una devolución—. Sin él la consulta no lo
     * encuentra (NOT_FOUND), y un rechazo no se distingue de un cobro que la pasarela no conoce.
     */
    protected static void gatewayRejects(GatewayCall call) {
        String[] route = GATEWAY_ROUTES.get(call);
        stubFor(route[0], route[1], 400, "{\\"error\\": {\\"code\\": \\"rejected_by_test\\"}}");
    }

    /** La pasarela guarda el medio de pago que se le pase, con una tarjeta ${card.brand} terminada en ${card.last4} (${card.expMonth}/${card.expYear}). */
    protected static void gatewaySavesPaymentMethod() {
        gatewaySavesCard("${card.brand}", "${card.last4}", ${card.expMonth}, ${card.expYear});
    }

    /**
     * La pasarela guarda el medio con ESTE resumen de tarjeta: lo que un escenario afirma en la respuesta o en la ficha
     * del medio guardado (savePaymentMethod.cardDetails).
     */
    protected static void gatewaySavesCard(String brand, String last4, int expMonth, int expYear) {
        String[] save = GATEWAY_ROUTES.get(GatewayCall.SAVE_METHOD);
        String[] attach = GATEWAY_ROUTES.get(GatewayCall.ATTACH_METHOD);
        stubFor(save[0], save[1], 200, "{\\"id\\": \\"cus_keel_test\\"}");
        stubFor(attach[0], attach[1], 200, String.format("${cardTemplate}", brand, last4, expMonth, expYear));
    }

    /**
     * La pasarela exige autenticar al cliente (3DS) para guardar la tarjeta.${authentication ? '' : ` ${gateway.name ?? gateway.id} no lo pide al
     * guardar (la autenticación es del cobro), así que un escenario que lo use no se puede ejecutar con ella.`}
     */
    protected static void gatewayRequiresAuthenticationToSave() {
${authentication
  ? `        String[] save = GATEWAY_ROUTES.get(GatewayCall.SAVE_METHOD);
        String[] attach = GATEWAY_ROUTES.get(GatewayCall.ATTACH_METHOD);
        stubFor(save[0], save[1], 200, "{\\"id\\": \\"cus_keel_test\\"}");
        stubFor(attach[0], attach[1], ${authentication.status}, "${JSON.stringify(authentication.body).replace(/"/g, '\\"')}");`
  : `        throw new UnsupportedOperationException("${gateway.id} no pide autenticar al guardar un medio: este escenario no aplica con ella");`}
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
        gatewayStub(call, queryContains, bodyContains, status, json, 0);
    }

    // Con delayMs > 0, la respuesta llega tarde (fixedDelayMilliseconds de WireMock).
    private static void gatewayStub(GatewayCall call, String queryContains, String bodyContains, int status, String json, int delayMs) {
        String[] route = GATEWAY_ROUTES.get(call);
        gatewayMapping(route[0], route[1], queryContains, bodyContains, status, json, delayMs);
    }

    // Igual, sobre la ruta concreta de un id (la de captura, anulación o consulta de ESE cobro).
    private static void gatewayStubPath(GatewayCall call, String gatewayId, String bodyContains, int status, String json) {
        gatewayStubPath(call, gatewayId, bodyContains, status, json, 0);
    }

    private static void gatewayStubPath(GatewayCall call, String gatewayId, String bodyContains, int status, String json, int delayMs) {
        String[] route = GATEWAY_ROUTES.get(call);
        gatewayMapping(route[0], route[1].replace("(?!search)[^/]+", gatewayId).replace("[^/]+", gatewayId), null,
                bodyContains, status, json, delayMs);
    }

    private static void gatewayMapping(String method, String pathPattern, String queryContains, String bodyContains,
            int status, String json, int delayMs) {
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
        String response = "{" + quote("status") + ": " + status + (delayMs > 0 ? ", " + quote("fixedDelayMilliseconds") + ": " + delayMs : "")
                + ", " + quote("headers") + ": {"
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

function stripeSpecific(probes, currency, tracks) {
  const refund = refundTranslation('stripe');
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

${tracks
  ? `    // Las devoluciones del cobro tal como las lista Stripe (GET /v1/refunds?payment_intent=…), con la referencia de cada
    // una en su metadata: es lo que lee StripePaymentGateway.refundStatus.
    private static void gatewayRefundsAtGateway(String reference, String refundReference, String outcome, BigDecimal amount,
            BigDecimal previouslyRefunded) {
        String id = gatewayIdFor(reference);
        List<String> refunds = new java.util.ArrayList<>();
        if (previouslyRefunded != null && previouslyRefunded.signum() > 0) {
            refunds.add(stripeRefund(id + "_previous", "keel-previous-refund", "${refund.succeeded[0]}", previouslyRefunded));
        }
        if (!"MISSING".equals(outcome)) {
            String status = switch (outcome) {
                case "REFUNDED" -> "${refund.succeeded[0]}";
                case "PENDING" -> "${refund.pending[0]}";
                default -> "failed";
            };
            refunds.add(stripeRefund(id + "_" + refundReference.replaceAll("[^A-Za-z0-9]", ""), refundReference, status, amount));
        }
        String list = "{\\"object\\": \\"list\\", \\"has_more\\": false, \\"data\\": [" + String.join(", ", refunds) + "]}";
        String request = "{" + quote("method") + ": " + quote("GET") + ", " + quote("urlPath") + ": " + quote("/v1/refunds") + ", "
                + quote("queryParameters") + ": {" + quote("payment_intent") + ": {" + quote("equalTo") + ": " + quote(id) + "}}}";
        String response = "{" + quote("status") + ": 200, " + quote("headers") + ": {" + quote("Content-Type") + ": "
                + quote("application/json") + "}, " + quote("body") + ": " + quote(list) + "}";
        stubAdmin("/mappings", "{" + quote("request") + ": " + request + ", " + quote("response") + ": " + response + "}");
    }

    private static String stripeRefund(String id, String refundReference, String status, BigDecimal amount) {
        return "{\\"id\\": \\"re_" + id + "\\", \\"object\\": \\"refund\\", \\"status\\": \\"" + status + "\\", \\"amount\\": "
                + amount.movePointRight(2).longValueExact() + ", \\"currency\\": \\"" + GATEWAY_CURRENCY.toLowerCase(Locale.ROOT)
                + "\\", \\"metadata\\": {\\"${refund.referenceKey}\\": \\"" + refundReference + "\\"}}";
    }

`
  : ''}    private Response gatewayNotice(String reference, String secret) {
        String id = gatewayIdFor(reference);
        String body = "{\\"id\\": \\"evt_" + id + "\\", \\"type\\": \\"payment_intent.updated\\", \\"data\\": {\\"object\\": {\\"id\\": \\""
                + id + "\\", \\"object\\": \\"payment_intent\\"}}}";
        long t = Instant.now().getEpochSecond();
        return exchange(HttpMethod.POST, "${PAYMENT_NOTICE_PATH}", body, null, null,
                Map.of("${probes.notice.signatureHeader}", "t=" + t + ",v1=" + gatewayHmac(secret, t + "." + body)));
    }
`;
}

function mercadopagoSpecific(probes, currency, tracks) {
  const refund = refundTranslation('mercadopago');
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
            json.append(", \\"refunds\\": [").append(mercadopagoRefund(id + "-new", "${refund.succeeded[0]}", refunded)).append("]");
        }
        return json.append("}}").toString();
    }

    // Una devolución de la order con la forma que leen el adaptador y su refundStatus: id, importe y estado.
    private static String mercadopagoRefund(String id, String status, BigDecimal amount) {
        return "{\\"id\\": \\"REF" + id + "\\", \\"status\\": \\"" + status + "\\", \\"amount\\": \\"" + amount.toPlainString() + "\\"}";
    }
${tracks
  ? `
    // La order con sus devoluciones: MercadoPago no guarda referencia propia en una devolución, así que refundStatus la
    // localiza por lo procesado por encima de lo que el registro ya cuenta como devuelto.
    private static void gatewayRefundsAtGateway(String reference, String refundReference, String outcome, BigDecimal amount,
            BigDecimal previouslyRefunded) {
        String id = gatewayIdFor(reference);
        List<String> refunds = new java.util.ArrayList<>();
        if (previouslyRefunded != null && previouslyRefunded.signum() > 0) {
            refunds.add(mercadopagoRefund(id + "-previous", "${refund.succeeded[0]}", previouslyRefunded));
        }
        if (!"MISSING".equals(outcome)) {
            String status = switch (outcome) {
                case "REFUNDED" -> "${refund.succeeded[0]}";
                case "PENDING" -> "${refund.pending[0]}";
                default -> "failed";
            };
            refunds.add(mercadopagoRefund(id + "-" + refundReference.replaceAll("[^A-Za-z0-9]", ""), status, amount));
        }
        String order = gatewayObject(reference, "CAPTURED", null, null);
        order = order.substring(0, order.length() - 2) + ", \\"refunds\\": [" + String.join(", ", refunds) + "]}}";
        gatewayReportsObject(reference, order);
    }
`
  : ''}
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
