// La clase JUnit que ejecuta payment-check (scripts/payment-check.js) dentro de un proyecto generado.
// No forma parte del proyecto: la escribe el script, y por eso vive en src/lib y no en src/scaffold.
//
// Habla con el adaptador y el verificador GENERADOS a través de una pasarela falsa servida por el
// HttpServer del JDK, con las formas de payment-probes.js. Cada caso nombra la defensa que mide.

import fs from 'node:fs';
import path from 'node:path';
import { paymentProbesFor } from './payment-probes.js';
import { PAYMENT_TEST_SECRETS } from '../scaffold/config.js';

const q = (value) => JSON.stringify(value);

function stripeObject(probes, reference, status, extra = {}) {
  const id = `${probes.idPrefix}${reference.replace(/[^A-Za-z0-9]/g, '')}`;
  return JSON.stringify({
    id,
    object: 'payment_intent',
    currency: 'brl',
    status: probes.statuses[status],
    metadata: { keel_reference: reference },
    client_secret: `${id}_secret`,
    ...extra
  });
}

function mercadopagoObject(probes, reference, status, detailOverride = null) {
  const id = `${probes.idPrefix}${reference.replace(/[^A-Za-z0-9]/g, '')}`;
  const [state, detail] = probes.statuses[status];
  const statusDetail = detailOverride ?? detail;
  return JSON.stringify({
    id,
    status: state,
    status_detail: statusDetail,
    external_reference: reference,
    currency: 'BRL',
    transactions: { payments: [{ id: `PAY${id}`, status_detail: statusDetail, payment_method: { type: 'credit_card' } }] }
  });
}

/** Las formas de la pasarela falsa para este caso: rutas, cuerpos y cómo se ve el importe en el cable. */
function gatewayShapes(gateway) {
  const probes = paymentProbesFor(gateway);
  if (gateway === 'stripe') {
    return {
      probes,
      adapter: 'StripePaymentGateway',
      verifier: 'StripeNoticeVerifier',
      verifierArgs: 'properties(), new ObjectMapper(), clock',
      authorized: stripeObject(probes, 'ch-1', 'AUTHORIZED'),
      captured: stripeObject(probes, 'ch-9', 'CAPTURED'),
      declineStatus: 402,
      decline: JSON.stringify({
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: probes.declines.insufficientFunds,
          payment_intent: JSON.parse(stripeObject(probes, 'ch-2', 'FAILED'))
        }
      }),
      // «Cualquier aviso pasa»: la decisión final del verificador deja de mirar la firma.
      signatureSabotage: { from: 'boolean valid = signatures.stream()', to: 'boolean valid = true || signatures.stream()' },
      expiredCapture: JSON.stringify({ error: { type: 'invalid_request_error', code: 'charge_expired_for_capture' } }),
      canceled: stripeObject(probes, 'ch-7', 'CANCELED'),
      // Stripe dice qué pasó en la respuesta: no hace falta otra petición.
      expiredCaptureRequests: 1,
      // Deja de reconocer la captura caducada: consulta el estado (una petición de más).
      expiredSabotage: { from: 'contains("charge_expired_for_capture")', to: 'contains("__sabotaje__")' },
      // Vuelve el defecto de la corrida: una lectura previa a la pasarela fuera del try.
      prefetchSabotage: {
        from: 'Long.toString(MoneyAmounts.toMinorUnits(amount, currency))',
        to: 'Long.toString(MoneyAmounts.toMinorUnits(amount, http.get().uri("/v1/payment_intents/" + gatewayPaymentId).retrieve().body(String.class) == null ? currency : currency))'
      },
      amountOnWire: 'amount=2590',
      referenceOnWire: 'ch-1',
      searchMarker: 'ch-9',
      notice: `
        String body = "{\\"id\\": \\"evt_1\\", \\"data\\": {\\"object\\": {\\"id\\": \\"pi_ch1\\", \\"object\\": \\"payment_intent\\"}}}";
        long t = timestamp;
        String signature = hmac(secret, t + "." + body);
        HttpHeaders headers = new HttpHeaders();
        headers.set("${probes.notice.signatureHeader}", "t=" + t + ",v1=" + extraSignature + signature);
        return new Notice(body.getBytes(StandardCharsets.UTF_8), headers, Map.of(), "pi_ch1");`
    };
  }
  return {
    probes,
    adapter: 'MercadopagoPaymentGateway',
    verifier: 'MercadopagoNoticeVerifier',
    verifierArgs: 'properties(), clock',
    authorized: mercadopagoObject(probes, 'ch-1', 'AUTHORIZED'),
    captured: mercadopagoObject(probes, 'ch-9', 'CAPTURED'),
    declineStatus: 200,
    decline: mercadopagoObject(probes, 'ch-2', 'FAILED', probes.declines.insufficientFunds),
    signatureSabotage: {
      from: 'if (!MessageDigest.isEqual(expected, signature.getBytes(StandardCharsets.UTF_8))) {',
      to: 'if (false && !MessageDigest.isEqual(expected, signature.getBytes(StandardCharsets.UTF_8))) {'
    },
    expiredCapture: JSON.stringify({ errors: [{ code: 'order_expired' }] }),
    canceled: mercadopagoObject(probes, 'ch-7', 'CANCELED'),
    // MercadoPago no documenta el código: el adaptador consulta la order.
    expiredCaptureRequests: 2,
    // Una captura rechazada deja de ser una respuesta: queda en duda en vez de anulada.
    expiredSabotage: {
      from: '            return status(reference, gatewayPaymentId);\n        } catch (RestClientException noAnswer) {\n            throw unavailable(action, noAnswer);',
      to: '            throw unavailable(action, error);\n        } catch (RestClientException noAnswer) {\n            throw unavailable(action, noAnswer);'
    },
    // Vuelve el defecto de la corrida: la lectura de la order fuera del tratamiento de «sin respuesta».
    prefetchSabotage: { from: '} catch (RestClientException noAnswer) {\n                throw unavailable("refund"', to: '} catch (IllegalStateException noAnswer) {\n                throw unavailable("refund"' },
    amountOnWire: '"total_amount":"25.90"',
    referenceOnWire: '"external_reference":"ch-1"',
    searchMarker: 'ch-9',
    notice: `
        String requestId = "req-1";
        long ts = timestamp;
        String manifest = "id:ordch1;request-id:" + requestId + ";ts:" + ts + ";";
        HttpHeaders headers = new HttpHeaders();
        headers.set("${probes.notice.signatureHeader}", "ts=" + ts + ",v1=" + extraSignature + hmac(secret, manifest));
        headers.set("x-request-id", requestId);
        String body = "{\\"type\\": \\"order\\", \\"data\\": {\\"id\\": \\"ORDch1\\"}}";
        return new Notice(body.getBytes(StandardCharsets.UTF_8), headers, Map.of("data.id", "ORDch1"), "ORDch1");`
  };
}

/** Los sabotajes con los que se falsa la red: cada uno rompe UNA defensa conservando la forma. */
const SABOTAGES = {
  // La comparación de la firma deja de mirar: cualquier aviso pasa.
  signature: { file: (s) => `${s.verifier}.java`, from: (s) => s.signatureSabotage.from, to: (s) => s.signatureSabotage.to },
  // La clave de idempotencia sale de un aleatorio: un reintento cobra dos veces.
  idempotency: {
    file: (s) => `${s.adapter}.java`,
    from: 'return reference + ":" + action;',
    to: 'return java.util.UUID.randomUUID().toString();'
  },
  // La ventana del aviso deja de aplicarse: un aviso repetido días después pasa.
  tolerance: { file: (s) => `${s.verifier}.java`, from: '> properties.noticeToleranceSeconds()', to: '> Long.MAX_VALUE' },
  // La autorización caducada deja de leerse como un cobro anulado.
  expired: { file: (s) => `${s.adapter}.java`, from: (s) => s.expiredSabotage.from, to: (s) => s.expiredSabotage.to },
  // Una lectura previa a la devolución escapa del tratamiento de «sin respuesta».
  prefetch: { file: (s) => `${s.adapter}.java`, from: (s) => s.prefetchSabotage.from, to: (s) => s.prefetchSabotage.to }
};

export function paymentCheckTest(model, gateway) {
  const shapes = gatewayShapes(gateway);
  const { probes } = shapes;
  const base = model.service.basePackage;
  const failure = model.payments.record.failureReasonType;
  const calls = probes.calls;
  const content = `package ${base};

import ${base}.domain.enums.${failure};
import ${base}.domain.payment.ChargeRequest;
import ${base}.domain.payment.GatewayOutcome;
import ${base}.domain.payment.GatewayStatus;
import ${base}.domain.payment.PaymentGatewayUnavailableException;
import ${base}.domain.payment.PaymentSource;
import ${base}.application.port.out.PaymentGateway;
import ${base}.infrastructure.payment.InvalidPaymentNoticeException;
import ${base}.infrastructure.payment.PaymentGatewayHttpConfig;
import ${base}.infrastructure.payment.PaymentGatewayProperties;
import ${base}.infrastructure.payment.${gateway}.${shapes.adapter};
import ${base}.infrastructure.payment.${gateway}.${shapes.verifier};
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** payment-check (${gateway}): el adaptador y el verificador generados, ejecutados. */
class PaymentCheckTest {

    private static final String SECRET = ${q(PAYMENT_TEST_SECRETS.webhookSecret)};
    private static final Instant NOW = Instant.parse("2026-10-02T12:00:00Z");

    record Recorded(String method, String path, String query, String idempotencyKey, String body) {}

    record Route(String method, String pathRegex, int status, String body, boolean drop) {}

    record Notice(byte[] body, HttpHeaders headers, Map<String, String> query, String id) {}

    private static HttpServer server;
    private static final List<Route> ROUTES = new CopyOnWriteArrayList<>();
    private static final List<Recorded> RECORDED = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String path = exchange.getRequestURI().getPath();
            RECORDED.add(new Recorded(exchange.getRequestMethod(), path, exchange.getRequestURI().getRawQuery(),
                    exchange.getRequestHeaders().getFirst(${q(model.payments.gateway.idempotencyHeader)}), body));
            Route route = ROUTES.stream()
                    .filter(candidate -> candidate.method().equals(exchange.getRequestMethod()) && path.matches(candidate.pathRegex()))
                    .reduce((first, second) -> second)
                    .orElse(new Route("", "", 404, "{}", false));
            if (route.drop()) {
                exchange.close(); // sin respuesta: la conexión se corta
                return;
            }
            byte[] out = route.body().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(route.status(), out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
        });
        server.start();
    }

    @AfterAll
    static void stop() {
        server.stop(0);
    }

    @BeforeEach
    void reset() {
        ROUTES.clear();
        RECORDED.clear();
    }

    private static void route(String method, String pathRegex, int status, String body) {
        ROUTES.add(new Route(method, pathRegex, status, body, false));
    }

    private static PaymentGatewayProperties properties() {
        return new PaymentGatewayProperties("http://127.0.0.1:" + server.getAddress().getPort(), "test-key", SECRET,
                Duration.ofSeconds(2), Duration.ofSeconds(2), 300);
    }

    private static PaymentGateway gateway() {
        return new ${shapes.adapter}(new PaymentGatewayHttpConfig().paymentGatewayRestClient(properties()), properties(),
                new ObjectMapper());
    }

    private static ChargeRequest charge(String reference, String amount) {
        return new ChargeRequest(reference, new BigDecimal(amount), "BRL", PaymentSource.token("tok_test"));
    }

    @Test
    void laClaveDeIdempotenciaSaleDeLaReferenciaYElImporteVaEnLaUnidadDeLaPasarela() {
        route(${q(calls.CHARGE.method)}, ${q(calls.CHARGE.path)}, 200, ${q(shapes.authorized)});
        GatewayOutcome outcome = gateway().authorize(charge("ch-1", "25.90"));
        assertEquals(GatewayStatus.AUTHORIZED, outcome.status());
        assertEquals("ch-1", outcome.reference());
        assertEquals(1, RECORDED.size());
        assertEquals("ch-1:authorize", RECORDED.get(0).idempotencyKey());
        assertTrue(RECORDED.get(0).body().contains(${q(shapes.amountOnWire)}), RECORDED.get(0).body());
        assertTrue(RECORDED.get(0).body().contains(${q(shapes.referenceOnWire)}), RECORDED.get(0).body());
    }

    @Test
    void reintentarConLaMismaReferenciaRepiteLaClave() {
        route(${q(calls.CHARGE.method)}, ${q(calls.CHARGE.path)}, 200, ${q(shapes.authorized)});
        gateway().authorize(charge("ch-1", "25.90"));
        gateway().authorize(charge("ch-1", "25.90"));
        assertEquals(RECORDED.get(0).idempotencyKey(), RECORDED.get(1).idempotencyKey());
    }

    @Test
    void unRechazoCaeEnElVocabularioNeutro() {
        route(${q(calls.CHARGE.method)}, ${q(calls.CHARGE.path)}, ${shapes.declineStatus}, ${q(shapes.decline)});
        GatewayOutcome outcome = gateway().authorize(charge("ch-2", "10.00"));
        assertEquals(GatewayStatus.FAILED, outcome.status());
        assertEquals(${failure}.INSUFFICIENT_FUNDS, outcome.failureReason());
    }

    @Test
    void unErrorDeLaPasarelaDejaLaAccionEnDudaYNoSeReintenta() {
        route(${q(calls.CHARGE.method)}, ${q(calls.CHARGE.path)}, 503, "{}");
        assertThrows(PaymentGatewayUnavailableException.class, () -> gateway().authorize(charge("ch-3", "10.00")));
        assertEquals(1, RECORDED.size(), "un 5xx no se reintenta: puede haber cobrado");
    }

    @Test
    void unCorteDeConexionDejaLaAccionEnDuda() {
        ROUTES.add(new Route(${q(calls.CHARGE.method)}, ${q(calls.CHARGE.path)}, 0, "", true));
        assertThrows(PaymentGatewayUnavailableException.class, () -> gateway().authorize(charge("ch-4", "10.00")));
    }

    @Test
    void sinIdSeBuscaPorLaReferencia() {
        route(${q(calls.SEARCH.method)}, ${q(calls.SEARCH.path)}, 200, ${q(`{"data": [${shapes.captured}]}`)});
        GatewayOutcome outcome = gateway().status("ch-9", null);
        assertEquals(GatewayStatus.CAPTURED, outcome.status());
        assertTrue(RECORDED.get(0).query() != null && RECORDED.get(0).query().contains(${q(shapes.searchMarker)}),
                "la búsqueda tiene que llevar la referencia: " + RECORDED.get(0).query());
    }

    @Test
    void loQueLaPasarelaNoConoceEsNotFound() {
        route(${q(calls.SEARCH.method)}, ${q(calls.SEARCH.path)}, 200, "{\\"data\\": []}");
        assertEquals(GatewayStatus.NOT_FOUND, gateway().status("ch-404", null).status());
    }

    @Test
    void unImporteConMasDecimalesQueLaMonedaNoSeRedondea() {
        assertThrows(IllegalArgumentException.class, () -> gateway().authorize(charge("ch-5", "10.555")));
        assertEquals(0, RECORDED.size(), "no se llama a la pasarela con un importe que no se puede representar");
    }

${model.payments.refund?.amount ? `    @Test
    void unaDevolucionParcialSinRespuestaQuedaEnDudaAunqueFalleUnaLecturaPrevia() {
        // Corrida payment-checkout: una consulta previa (la moneda en Stripe, la order en
        // MercadoPago) fuera del tratamiento de «sin respuesta» salía como un 500.
        ROUTES.add(new Route("GET", ".*", 0, "", true));
        ROUTES.add(new Route("POST", ".*", 0, "", true));
        assertThrows(PaymentGatewayUnavailableException.class,
                () -> gateway().refund("ch-6", "pay6", new BigDecimal("5.00"), "BRL"));
    }

` : ''}${model.payments.capture ? `    @Test
    void capturarUnaAutorizacionCaducadaEsUnCobroAnulado() {
        route(${q(calls.CAPTURE.method)}, ${q(calls.CAPTURE.path)}, 400, ${q(shapes.expiredCapture)});
        route(${q(calls.STATUS.method)}, ${q(calls.STATUS.path)}, 200, ${q(shapes.canceled)});
        assertEquals(GatewayStatus.CANCELED, gateway().capture("ch-7", "pay7"${model.payments.capture.amount ? ', null, "BRL"' : ''}).status());
        assertEquals(${shapes.expiredCaptureRequests}, RECORDED.size());
    }

` : ''}    // ─── El aviso ────────────────────────────────────────────────────────────

    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);

    private static ${shapes.verifier} verifier() {
        try {
            var constructor = ${shapes.verifier}.class.getDeclaredConstructor(PaymentGatewayProperties.class${gateway === 'stripe' ? ', ObjectMapper.class' : ''}, Clock.class);
            constructor.setAccessible(true);
            Clock clock = CLOCK;
            return constructor.newInstance(${shapes.verifierArgs});
        } catch (ReflectiveOperationException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static Notice notice(String secret, long timestamp, String extraSignature) {${shapes.notice}
    }

    private static String hmac(String secret, String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @Test
    void unAvisoFirmadoPorLaPasarelaVerificaYDiceDeQueCobroHabla() {
        Notice notice = notice(SECRET, NOW.getEpochSecond(), "");
        assertEquals(notice.id(), verifier().verify(notice.body(), notice.headers(), notice.query()).orElseThrow());
    }

    @Test
    void unAvisoConOtraFirmaSeRechaza() {
        Notice forged = notice(SECRET + "-falso", NOW.getEpochSecond(), "");
        assertThrows(InvalidPaymentNoticeException.class, () -> verifier().verify(forged.body(), forged.headers(), forged.query()));
    }

    @Test
    void unAvisoFueraDeLaVentanaSeRechazaAunqueLaFirmaSeaBuena() {
        Notice stale = notice(SECRET, NOW.getEpochSecond() - 3600, "");
        assertThrows(InvalidPaymentNoticeException.class, () -> verifier().verify(stale.body(), stale.headers(), stale.query()));
    }
}
`;
  const relativePath = `src/test/java/${base.replaceAll('.', '/')}/PaymentCheckTest.java`;
  const saboteur = (projectDir, kind) => {
    const sabotage = SABOTAGES[kind];
    if (!sabotage) throw new Error(`sabotaje desconocido: ${kind} (${Object.keys(SABOTAGES).join(', ')})`);
    const target = findFile(path.join(projectDir, 'src', 'main', 'java'), sabotage.file(shapes));
    const text = fs.readFileSync(target, 'utf8');
    const from = typeof sabotage.from === 'function' ? sabotage.from(shapes) : sabotage.from;
    const to = typeof sabotage.to === 'function' ? sabotage.to(shapes) : sabotage.to;
    if (!text.includes(from)) throw new Error(`el sabotaje '${kind}' ya no se aplica a ${path.basename(target)}`);
    fs.writeFileSync(target, text.replace(from, to));
  };
  return { relativePath, content, saboteur };
}

export const PAYMENT_CHECK_SABOTAGES = Object.keys(SABOTAGES);

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
