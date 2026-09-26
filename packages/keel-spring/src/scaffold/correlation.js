// Correlación end-to-end: el hilo que une request HTTP → caso de uso → evento
// de dominio → mensaje saliente. El DomainEventBridge (messaging.js) estampa la
// correlación en cada EventEnvelope leyéndola de aquí; sin este generador ese
// valor sería siempre null.
//
// Es transversal al stack: el contexto vive en un ThreadLocal + MDC (para que
// aparezca en todo log) y lo puebla el filtro HTTP en la entrada síncrona. La
// entrada asíncrona (listeners del broker) la puebla el agente con runWith,
// siguiendo la skill keel-spring-<broker>.

import { javaFile, javaPath, subPackage } from './render.js';
import { usesTelemetry, consumesKeelEnvelope, messageTracingImport } from './telemetry.js';

const CORRELATION_PKG = 'infrastructure.correlation';
const WEB_PKG = 'infrastructure.web';

// Sin api ni messaging no hay nada que correlacionar: ni entrada que abra el
// contexto ni salida que lo consuma.
export function usesCorrelation(model) {
  return Boolean(model.layersPresent.api || model.layersPresent.messaging);
}

export function generate(model) {
  if (!usesCorrelation(model)) return [];
  const files = [renderContext(model)];
  // El filtro solo tiene sentido con capa api: es el puente HTTP → contexto.
  if (model.layersPresent.api) files.push(renderFilter(model));
  return files;
}

export function correlationImport(model) {
  return `${subPackage(model, CORRELATION_PKG)}.CorrelationContext`;
}

// La sobrecarga que usa un listener de una suscripción con envoltura keel. Se emite con o sin
// telemetría, y es a propósito: el código del listener es del AGENTE, y así su forma no depende
// de una elección de stack que se puede cambiar después con `build --telemetry`. Lo que cambia
// es lo que hace dentro, y eso es de build.
function metadataOverload(model) {
  if (!consumesKeelEnvelope(model)) return '';
  const body = usesTelemetry(model)
    ? `runWith(metadata.correlationId(), () -> MessageTracing.continueFrom(
                metadata.traceparent(), MessageTracing.MESSAGE_CONSUME, Kind.CONSUMER, metadata.eventType(), action));`
    : 'runWith(metadata.correlationId(), action);';
  return `

    /**
     * La forma que deben usar los listeners de mensajes con envoltura keel: abre la
     * correlación del mensaje de origen.
     * Con telemetría también continúa la traza W3C que el emisor estampó en la
     * envoltura; sin ella solo abre la correlación. Usarla siempre, en vez de la de
     * String, es lo que hace que activar la telemetría no exija tocar el listener.
     */
    public static void runWith(EventMetadata metadata, Runnable action) {
        if (metadata == null) {
            action.run();
            return;
        }
        ${body}
    }`;
}

function renderContext(model) {
  const overload = metadataOverload(model);
  const imports = ['java.util.UUID', 'java.util.regex.Pattern', 'org.slf4j.MDC'];
  if (overload) imports.push(`${subPackage(model, 'domain.events')}.EventMetadata`);
  if (overload && usesTelemetry(model)) {
    imports.push(messageTracingImport(model), 'io.micrometer.observation.transport.Kind');
  }
  const body = `/**
 * Contexto de correlación del hilo actual.
 *
 * El valor se escribe a la vez en un ThreadLocal y en el MDC de SLF4J: el
 * primero lo lee el código (el bridge de eventos, al estampar la EventEnvelope)
 * y el segundo hace que aparezca en cada línea de log sin pasarlo por parámetro.
 *
 * Lo abre CorrelationFilter en la entrada HTTP; en la entrada asíncrona lo abre
 * el listener del broker con {@link #runWith(String, Runnable)}, de modo que los
 * eventos que provoque el consumo hereden la correlación del mensaje de origen.
 *
 * Los hilos son de un pool y se reutilizan: quien abre el contexto SIEMPRE debe
 * cerrarlo, o la próxima petición atendida por ese hilo heredará una
 * correlación ajena. Por eso runWith es preferible a set/clear a mano.
 */
public final class CorrelationContext {

    /** Clave con la que el correlationId aparece en el MDC y en el patrón de log. */
    public static final String MDC_KEY = "correlationId";

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private CorrelationContext() {
        // Clase de utilidad.
    }

    /**
     * Lo que se acepta como correlationId. El valor llega de FUERA (una cabecera HTTP, la
     * metadata de un mensaje ajeno) y acaba en cada línea de log, en la cabecera de respuesta,
     * en el atributo del span y en los eventos que salen: sin cota, un cliente podía meter
     * saltos de línea en los logs de texto o un valor de kilobytes en cada registro.
     */
    private static final Pattern ACCEPTED = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    /**
     * Fija la correlación del hilo actual; no hace nada si viene nula o en blanco. Un valor que no
     * cumple el formato no se rechaza ni se trunca: se sustituye por uno nuevo, igual que si no
     * hubiera llegado, porque truncar produciría ids que se confunden entre sí.
     */
    public static void set(String correlationId) {
        if (correlationId == null || correlationId.isBlank()) {
            return;
        }
        String accepted = ACCEPTED.matcher(correlationId).matches() ? correlationId : UUID.randomUUID().toString();
        CURRENT.set(accepted);
        MDC.put(MDC_KEY, accepted);
    }

    /** @return la correlación del hilo actual, o null si no hay ninguna abierta. */
    public static String get() {
        return CURRENT.get();
    }

    /** Cierra el contexto. Va siempre en un finally. */
    public static void clear() {
        CURRENT.remove();
        MDC.remove(MDC_KEY);
    }

    /**
     * Ejecuta la acción con la correlación indicada y cierra el contexto pase lo
     * que pase. Es la forma que deben usar los listeners del broker.
     */
    public static void runWith(String correlationId, Runnable action) {
        try {
            set(correlationId);
            action.run();
        } finally {
            clear();
        }
    }${overload}
}`;

  return {
    path: javaPath(model, CORRELATION_PKG, 'CorrelationContext'),
    content: javaFile(subPackage(model, CORRELATION_PKG), imports, body)
  };
}

function renderFilter(model) {
  const body = `/**
 * Abre el contexto de correlación en cada petición HTTP.
 *
 * Toma el header X-Correlation-Id; si el cliente no lo envía, genera uno. Si lo envía
 * con un formato que no se acepta, CorrelationContext lo sustituye por uno nuevo. El valor
 * EFECTIVO se devuelve en la respuesta para que quien llamó pueda registrarlo y
 * rastrear después la petición en los logs y en los eventos que haya provocado.
 *
 * Se ordena casi al principio de la cadena para que hasta los fallos de
 * autenticación queden correlacionados.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class CorrelationFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String correlationId = request.getHeader(HEADER);
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = UUID.randomUUID().toString();
        }
        try {
            CorrelationContext.set(correlationId);
            // El efectivo, no el recibido: si no cumplía el formato, CorrelationContext puso otro.
            response.setHeader(HEADER, CorrelationContext.get());
            chain.doFilter(request, response);
        } finally {
            CorrelationContext.clear();
        }
    }
}`;

  return {
    path: javaPath(model, WEB_PKG, 'CorrelationFilter'),
    content: javaFile(
      subPackage(model, WEB_PKG),
      [
        correlationImport(model),
        'jakarta.servlet.FilterChain',
        'jakarta.servlet.ServletException',
        'jakarta.servlet.http.HttpServletRequest',
        'jakarta.servlet.http.HttpServletResponse',
        'java.io.IOException',
        'java.util.UUID',
        'org.springframework.core.Ordered',
        'org.springframework.core.annotation.Order',
        'org.springframework.stereotype.Component',
        'org.springframework.web.filter.OncePerRequestFilter'
      ],
      body
    )
  };
}
