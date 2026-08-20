// La parte del arnés de integración que sabe leer el buzón de correo.
//
// Vive aparte de integration-tests.js —que ya es el módulo más grande del
// generador— pero es exactamente el mismo tipo de código: Java por plantilla que
// se incrusta en AbstractFlowIT, con las mismas dos redes detrás
// (test/java-syntax.test.js sin JDK, `npm run compile-check` con javac).
//
// Por qué existe la sección. Sin ella, el Then de un escenario que termina en un
// correo solo puede afirmar sobre el 2xx que devolvió la API: que la petición se
// aceptó, no que el correo saliera ni que dijera lo que tenía que decir. La API del
// buzón es lo que separa «lo he mirado y se ve bien» de una prueba de regresión.
//
// Las rutas y los nombres de campo salen de lib/mail-probes.js, nunca de literales
// escritos aquí: es el mismo módulo del que se renderizan el sondeo de
// validate-infra.sh, la purga de reset-db.sh y el runner de conformidad. Escritos a
// mano en cada sitio, el gate en vivo comprobaría algo distinto de lo que se genera.

import { HOST_BASE, ROUTES, FIELDS, HTTP_PORT, SEARCH_PREFIX, searchSuffix } from '../lib/mail-probes.js';
import { fastestSchedulePeriod } from '../lib/cron-period.js';

export function hasMail(model) {
  return Boolean(model.layersPresent.mail);
}

// Suelo de la espera cuando nada la empuja desde un barrido: la entrega ocurre justo
// después de la respuesta y 15 s cubren de sobra el viaje al relay.
const MAIL_AWAIT_FLOOR = 15;

// Margen sobre el periodo del barrido. Cubre las dos cosas que se suman al periodo
// nominal: el desfase de fase que `scheduleSeconds()` reparte entre barridos de la
// misma cadencia (hasta 60 s) y el envío en sí.
const MAIL_AWAIT_MARGIN = 15;

// Techo por encima del cual una espera deja de ser una prueba y pasa a ser un cuelgue.
const MAIL_AWAIT_CAP = 300;

/**
 * Cuántos segundos espera el arnés a que llegue un correo, derivado del contrato.
 *
 * No es un número de estilo. Si la única forma de que un mensaje llegue a la bandeja es
 * un barrido con `schedule`, una espera inferior a su periodo falla según la fase del
 * minuto en que arranque la suite: verde o rojo por el reloj, no por el código. Un
 * literal fijo aquí hace intermitente cualquier diseño cuyo barrido sea más lento que él.
 *
 * Solo cuenta cuando alguna operación de `sentBy` es interna: si el correo sale dentro
 * de la operación que atiende la petición, la espera no depende de ningún cron.
 */
function mailAwaitSeconds(model) {
  const drivenBySweep = (model.mail?.sentBy ?? []).some((name) =>
    (model.services ?? []).some((service) =>
      (service.operations ?? []).some((operation) => operation.name === name && (operation.internal || operation.schedule))
    )
  );
  if (!drivenBySweep) return { seconds: MAIL_AWAIT_FLOOR, period: null };

  const period = fastestSchedulePeriod(model);
  if (period == null) return { seconds: MAIL_AWAIT_FLOOR, period: null };
  return { seconds: Math.min(MAIL_AWAIT_CAP, Math.max(MAIL_AWAIT_FLOOR, period + MAIL_AWAIT_MARGIN)), period };
}

/**
 * Imports que la sección añade a AbstractFlowIT. Van aparte porque el emisor de la
 * clase los necesita ANTES de renderizar el cuerpo, y porque un import que sobra en
 * los proyectos sin capa mail lo marca cualquier análisis estático.
 */
export const MAIL_IMPORTS = ['java.net.URLEncoder', 'java.nio.charset.StandardCharsets'];

export function mailSection(model) {
  if (!hasMail(model)) return '';
  const senders = model.mail.sentBy.map((op) => `{@code ${op}}`).join(', ');
  const parts = model.mail.multipart
    ? 'las dos partes del cuerpo (HTML y texto)'
    : model.mail.hasHtml
      ? 'solo el cuerpo HTML'
      : 'solo el cuerpo en texto';

  const wait = mailAwaitSeconds(model);
  const tooSlow = wait.period != null && wait.period + MAIL_AWAIT_MARGIN > MAIL_AWAIT_CAP;

  return `
    /** API del buzón de prueba (Mailpit de infra/docker-compose.yaml). */
    private static final String MAIL_API = "${HOST_BASE}";

    private static final HttpClient MAIL_HTTP = HttpClient.newHttpClient();

    /**
     * Techo de cualquier espera de correo.${
       wait.period == null
         ? `
     *
     * <p>El correo sale dentro de la operación que atiende la petición, así que no hay
     * ningún barrido de por medio: lo único que cubre esta espera es el viaje al relay.`
         : `
     *
     * <p>Sale del contrato, no de un número redondo: el correo lo empuja un barrido con
     * cadencia de ${wait.period} s (el \`schedule\` más rápido del diseño), y una espera
     * más corta que su periodo falla según la fase en que arranque la suite — verde o
     * rojo por el reloj y no por el código. Lleva ${MAIL_AWAIT_MARGIN} s de margen por el
     * desfase que build reparte entre barridos de la misma cadencia.`
     }${
       tooSlow
         ? `
     *
     * <p><b>Ojo</b>: ese periodo excede el techo de ${MAIL_AWAIT_CAP} s y se ha recortado
     * ahí. Ningún escenario que dependa del barrido va a pasar tal cual, y no es algo que
     * se arregle en la prueba: si tiene que ser verificable, el diseño necesita exponer un
     * disparador de ese trabajo además del \`schedule\`.`
         : ''
     }
     */
    private static final int MAIL_AWAIT_SECONDS = ${wait.seconds};

    /**
     * Espera a que haya {@code count} correos para esa dirección y devuelve sus ids,
     * el más reciente primero.
     *
     * <p><b>Es el helper con el que empieza cualquier Then sobre correo, y la espera
     * no es opcional.</b> Las operaciones que lo mandan (${senders}) responden
     * aceptando el encargo, no habiéndolo cumplido: la entrega ocurre DESPUÉS de la
     * respuesta, y es lo que evita que la disponibilidad del proveedor entre en la
     * transacción de quien llama. Una lectura seca justo tras el 2xx es una carrera, y
     * el escenario fallaría unas veces sí y otras no — que es peor que fallar siempre.
     *
     * @throws AssertionError si en {@value #MAIL_AWAIT_SECONDS} s no han llegado los que se esperaban
     */
    protected static List<String> awaitMailTo(String address, int count) {
        List<String> ids = new ArrayList<>();
        Instant deadline = Instant.now().plusSeconds(MAIL_AWAIT_SECONDS);
        while (Instant.now().isBefore(deadline)) {
            ids = mailIdsTo(address);
            if (ids.size() >= count) {
                return ids;
            }
            try {
                Thread.sleep(200L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Espera de correo interrumpida", e);
            }
        }
        throw new AssertionError("Se esperaban " + count + " correo(s) para " + address + " y llegaron "
                + ids.size() + " en " + MAIL_AWAIT_SECONDS + " s. El buzón se mira en http://localhost:${HTTP_PORT}");
    }

    /** El correo más reciente para esa dirección, ya resuelto a su detalle completo. */
    protected static Map<String, Object> lastMailTo(String address) {
        return mailMessage(awaitMailTo(address, 1).get(0));
    }

    /**
     * Cuántos correos hay AHORA para esa dirección, sin esperar.
     *
     * <p>Para el Then que afirma que no se duplicó: se espera primero al que sí debe
     * llegar (con {@link #awaitMailTo}) y solo entonces se cuenta. Contar sin haber
     * esperado nada mide el estado de antes de que ocurriera lo que se quería medir, y
     * eso sale verde siempre.
     */
    protected static int mailCount(String address) {
        return mailIdsTo(address).size();
    }

    /**
     * Que NO salió ningún correo para esa dirección. Es el Then de los rechazos, y el
     * único que puede afirmar que el rechazo llegó ANTES del envío y no después.
     *
     * <p>Espera un margen a propósito: sin él, «no ha llegado» y «todavía no ha llegado»
     * son indistinguibles, y el escenario pasaría en verde también cuando el correo acaba
     * saliendo un momento más tarde. El margen es el MISMO techo que
     * {@link #awaitMailTo}${
       wait.period == null
         ? ', porque es lo que tarda el camino que se está negando.'
         : `, y por la misma razón: si el correo lo empuja un barrido de ${wait.period} s,
     * un margen menor que su periodo hace que este Then salga verde SIEMPRE — también
     * cuando el correo sale, que es justo lo que dice estar comprobando.`
     }
     */
    protected static void assertNoMailTo(String address) {
        sleepQuietly(MAIL_AWAIT_SECONDS * 1000L);
        int count = mailCount(address);
        if (count > 0) {
            throw new AssertionError("No debía salir ningún correo para " + address + " y salieron " + count);
        }
    }

    /** Asunto tal como lo lee quien recibe el correo: ya interpolado y ya saneado. */
    protected static String mailSubject(Map<String, Object> message) {
        return (String) message.get("Subject");
    }

    /** Cuerpo HTML. Cadena vacía si el mensaje no lleva parte HTML. */
    protected static String mailHtml(Map<String, Object> message) {
        Object value = message.get("HTML");
        return value == null ? "" : (String) value;
    }

    /**
     * Cuerpo en texto plano. Este servicio envía ${parts}${
       model.mail.multipart
         ? ', y afirmar solo sobre el\n     * HTML deja sin cubrir la mitad que miran los filtros antispam'
         : ''
     }.
     */
    protected static String mailText(Map<String, Object> message) {
        Object value = message.get("Text");
        return value == null ? "" : (String) value;
    }

    /** Dirección desde la que salió el correo: el remitente que el diseño resuelve por envío. */
    @SuppressWarnings("unchecked")
    protected static String mailFrom(Map<String, Object> message) {
        Map<String, Object> from = (Map<String, Object>) message.get("From");
        return from == null ? null : (String) from.get("Address");
    }

    /** Ids de los correos para esa dirección, más reciente primero. */
    private static List<String> mailIdsTo(String address) {
        String body = mailApi("${SEARCH_PREFIX}" + urlEncode("to:" + address) + "${searchSuffix()}");
        List<String> ids = JsonPath.read(body, "${FIELDS.searchIds}");
        return new ArrayList<>(ids);
    }

    /**
     * El mensaje COMPLETO por su id. La búsqueda solo devuelve el resumen de cada uno:
     * sin esta segunda llamada no hay forma de afirmar sobre el cuerpo, que es justo lo
     * que separa «ha salido un correo» de «ha salido el correo correcto».
     */
    private static Map<String, Object> mailMessage(String id) {
        return JsonPath.read(mailApi("${ROUTES.message('')}" + id), "$");
    }

    private static String mailApi(String path) {
        try {
            HttpResponse<String> response = MAIL_HTTP.send(
                    HttpRequest.newBuilder(URI.create(MAIL_API + path)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 300) {
                throw new AssertionError("El buzón de prueba rechazó " + path + " (HTTP "
                        + response.statusCode() + "): " + response.body());
            }
            return response.body();
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AssertionError("No se pudo hablar con el buzón de prueba en " + MAIL_API
                    + ". ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh)", e);
        }
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Espera interrumpida", e);
        }
    }
`;
}
