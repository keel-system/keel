// Telemetría del servidor generado (solo con `telemetry: otel` en keel-stack.json): trazas,
// métricas y logs por OTLP a un COLECTOR, con Micrometer Observation + el puente de Micrometer
// Tracing a OpenTelemetry que trae Spring Boot. El servidor solo conoce el endpoint del
// colector: cambiar de backend es cambiar deploy/otel/collector.yaml, nunca este código.
//
// Todo lo de aquí es de build y ninguna pieza depende del broker ni del motor elegidos, salvo
// la instrumentación de Mongo (la de JDBC la aporta datasource-micrometer por autoconfiguración,
// sin clase). Lo único que queda del lado del agente es una línea por listener —el
// `CorrelationContext.runWith(envelope.metadata(), …)` que restaura la traza del mensaje—, y la
// vigila la familia `inboundContext` de check-idempotency.sh.
//
// Tres decisiones que no se ven leyendo el Java y que costaría redescubrir:
//
//   · El appender OTLP de logs se instala POR CÓDIGO sobre el logger raíz, no con un
//     logback-spring.xml. Con un XML, Boot deja de configurar la consola él mismo, y su
//     `console-appender.xml` NO sabe de `logging.structured.format.console`: el JSON de
//     develop/production volvería a texto plano sin que nada fallara.
//   · Las continuaciones de traza (relay del outbox, consumo de un mensaje) son OBSERVACIONES y
//     no spans sueltos del Tracer: así el SQL que ejecuta el handler tiene una observación padre,
//     y el predicado que tira las consultas sin padre (el ruido del reclamo del relay) no se
//     lleva también las del consumo.
//   · El predicado anti-ruido es la mitad de la robustez. El relay dispara cada segundo: sin él,
//     cada tick es una traza raíz, y las probes de Kubernetes otras tantas — el backend se llena
//     de trazas vacías y el muestreo en producción descarta las que importan.

import { javaFile, javaPath, subPackage } from './render.js';

export const TELEMETRY_PKG = 'infrastructure.telemetry';

// Nombres de las observaciones propias. Son también el nombre de sus métricas (timers), así
// que van en el vocabulario `keel.*` que ya usa el gauge del outbox.
export const OBSERVATIONS = {
  useCase: 'keel.use-case',
  outboxPublish: 'keel.outbox.publish',
  messageConsume: 'keel.message.consume'
};

export function usesTelemetry(model) {
  return model.stack?.telemetry === 'otel';
}

/** ¿Hay suscripciones con la envoltura keel, es decir, un `metadata.traceparent` que leer? */
export function consumesKeelEnvelope(model) {
  return Boolean(model.layersPresent?.messaging) && (model.subscriptions ?? []).some((sub) => sub.envelope === 'keel');
}

export function messageTracingImport(model) {
  return `${subPackage(model, TELEMETRY_PKG)}.MessageTracing`;
}

/**
 * La llamada al dispatcher del relay, envuelta en la continuación de la traza que la originó.
 * `payloadExpr` es la expresión Java con la envoltura serializada (de ella sale el
 * `traceparent`), `eventTypeExpr` la del tipo lógico y `dispatchCall` la llamada sin `;`.
 */
export function tracedDispatch(payloadExpr, eventTypeExpr, dispatchCall) {
  return (
    `MessageTracing.continueFrom(MessageTracing.traceparentOfEnvelope(${payloadExpr}), ` +
    `MessageTracing.OUTBOX_PUBLISH, Kind.PRODUCER, ${eventTypeExpr}, () -> ${dispatchCall});`
  );
}

export const TRACED_DISPATCH_IMPORTS = ['io.micrometer.observation.transport.Kind'];

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  return [renderConfig(model), renderMessageTracing(model), renderInstaller(model)];
}

function renderConfig(model) {
  const document = model.layersPresent?.persistence && model.persistenceKind === 'document';
  const imports = new Set([
    'ch.qos.logback.classic.LoggerContext',
    'io.micrometer.observation.Observation',
    'io.micrometer.observation.ObservationPredicate',
    'io.opentelemetry.api.OpenTelemetry',
    'io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender',
    'org.slf4j.Logger',
    'org.slf4j.LoggerFactory',
    'org.springframework.beans.factory.InitializingBean',
    'org.springframework.beans.factory.ObjectProvider',
    'org.springframework.boot.autoconfigure.condition.ConditionalOnProperty',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.http.server.observation.ServerRequestObservationContext'
  ]);
  if (document) {
    imports.add('org.springframework.boot.autoconfigure.mongo.MongoClientSettingsBuilderCustomizer');
    imports.add('org.springframework.data.mongodb.observability.ContextProviderFactory');
    imports.add('org.springframework.data.mongodb.observability.MongoObservationCommandListener');
    imports.add('io.micrometer.observation.ObservationRegistry');
  }

  // El correlationId en los spans: es el id que recibe el cliente (X-Correlation-Id), así que es
  // por lo que soporte pregunta. Solo donde existe CorrelationContext (capa api o messaging),
  // que es la misma condición con la que lo genera correlation.js.
  const correlated = Boolean(model.layersPresent?.api || model.layersPresent?.messaging);
  if (correlated) {
    imports.add(`${subPackage(model, 'infrastructure.correlation')}.CorrelationContext`);
    imports.add('io.micrometer.common.KeyValue');
    imports.add('io.micrometer.observation.ObservationFilter');
  }
  const correlationFilter = correlated
    ? `

    /**
     * El correlationId como atributo del span HTTP y del de cada caso de uso, para encontrar una
     * traza por el id que recibió el cliente. Alta cardinalidad a propósito: va al SPAN, nunca a
     * una etiqueta de métrica.
     *
     * <p>En el span HTTP se lee de la cabecera de la RESPUESTA y no de CorrelationContext: la
     * observación del servidor se cierra después de que CorrelationFilter haya limpiado su
     * contexto, así que ahí ya no queda nada que leer.
     */
    @Bean
    public ObservationFilter correlationIdOnSpans() {
        return context -> {
            String correlationId = null;
            if (context instanceof ServerRequestObservationContext server && server.getResponse() != null) {
                correlationId = server.getResponse().getHeader("X-Correlation-Id");
            } else if ("${OBSERVATIONS.useCase}".equals(context.getName())) {
                correlationId = CorrelationContext.get();
            }
            if (correlationId != null && !correlationId.isBlank()) {
                context.addHighCardinalityKeyValue(KeyValue.of("keel.correlation_id", correlationId));
            }
            return context;
        };
    }`
    : '';

  const mongo = document
    ? `

    /**
     * Spans de las operaciones de Mongo. Boot publica las MÉTRICAS del driver por su cuenta,
     * pero no las observaciones: sin esto, una traza que atraviesa el repositorio documental
     * tiene un hueco justo donde está el tiempo.
     */
    @Bean
    public MongoClientSettingsBuilderCustomizer mongoObservation(ObservationRegistry observationRegistry) {
        return settings -> settings
                .contextProvider(ContextProviderFactory.create(observationRegistry))
                .addCommandListener(new MongoObservationCommandListener(observationRegistry));
    }`
    : '';

  const body = `/**
 * Telemetría del servidor: lo que la autoconfiguración de Boot no hace sola.
 *
 * <p>El destino de las tres señales es UN colector OpenTelemetry (variable
 * {@code OTEL_EXPORTER_OTLP_ENDPOINT}, ver parameters/<perfil>/telemetry.yaml). El backend real
 * —Tempo, Jaeger, Loki, Prometheus, un SaaS— lo decide la configuración del colector, no este
 * servicio: cambiarlo no toca ni el código ni la configuración de la aplicación.
 */
@Configuration
public class TelemetryConfig {

    /**
     * Envía los logs al colector por OTLP, además de la consola.
     *
     * <p>Se instala POR CÓDIGO sobre el logger raíz y no con un {@code logback-spring.xml}: con
     * un XML, Boot deja de configurar la consola él mismo, y su {@code console-appender.xml} no
     * sabe de {@code logging.structured.format.console} — el JSON de develop y production
     * volvería a texto plano sin que nada fallara.
     *
     * <p>Cada registro lleva el contexto de traza del span activo (lo pone el appender) y el
     * {@code correlationId} del MDC como atributo: los dos hilos con los que se reconstruye una
     * petición.
     *
     * <p>Por {@code ObjectProvider}: donde la telemetría está apagada (el perfil {@code test}, un
     * {@code @SpringBootTest}) puede no haber SDK, y eso no puede impedir arrancar.
     *
     * <p>Y solo si {@code LOG_EXPORT_OTLP} lo pide: el canal primario de los logs es la consola,
     * que recoge la plataforma. Con los dos a la vez cada línea llegaría duplicada al backend, así
     * que el appender ni se cuelga del logger raíz si no se va a usar.
     */
    @Bean
    @ConditionalOnProperty(name = "management.otlp.logging.export.enabled", havingValue = "true")
    public InitializingBean openTelemetryLogAppender(ObjectProvider<OpenTelemetry> openTelemetryProvider) {
        return () -> {
            OpenTelemetry openTelemetry = openTelemetryProvider.getIfAvailable();
            if (openTelemetry == null) {
                return;
            }
            LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
            OpenTelemetryAppender appender = new OpenTelemetryAppender();
            appender.setContext(context);
            appender.setName("OTEL");
            appender.setOpenTelemetry(openTelemetry);
            appender.setCaptureMdcAttributes("correlationId");
            appender.start();
            context.getLogger(Logger.ROOT_LOGGER_NAME).addAppender(appender);
        };
    }

    /**
     * Fuera las peticiones al actuator: las probes de liveness/readiness llegan cada pocos
     * segundos y cada una sería una traza raíz sin nada dentro.
     */
    @Bean
    public ObservationPredicate ignoreActuator() {
        return (name, context) -> !(context instanceof ServerRequestObservationContext server
                && server.getCarrier() != null
                && server.getCarrier().getRequestURI().startsWith("/actuator"));
    }

    /**
     * Fuera las ejecuciones de las tareas programadas y las consultas SIN padre.
     *
     * <p>El relay del outbox corre cada segundo: sin esto, cada tick sería una traza raíz con
     * su consulta de reclamo dentro, aunque no haya nada que publicar. Lo que sí importa de una
     * tarea programada queda igual de visible: cada evento publicado abre su propia observación
     * ({@value MessageTracing#OUTBOX_PUBLISH}) colgada de la traza que lo originó, y cada
     * barrido pasa por el mediator, que abre la de su caso de uso — y el SQL de dentro tiene
     * entonces un padre y no se descarta.
     */
    @Bean
    public ObservationPredicate ignoreBackgroundNoise() {
        return (name, context) -> {
            if ("tasks.scheduled.execution".equals(name)) {
                return false;
            }
            boolean storeCall = name.startsWith("jdbc.") || name.startsWith("spring.data.mongodb") || name.startsWith("spring.data.redis");
            return !storeCall || hasRealParent(context);
        };
    }

    /**
     * Un padre NO-OP no cuenta como padre. Es justo el caso del relay: el tick programado que el
     * predicado de arriba descarta se queda como observación ACTUAL en forma de no-op, así que
     * sus consultas ven un padre no nulo — y sin esto salían como trazas raíz, una por segundo.
     * Medido: con {@code getParentObservation() != null} a secas, el colector recibía una
     * conexión JDBC raíz por cada tick del relay.
     */
    private static boolean hasRealParent(Observation.Context context) {
        return context.getParentObservation() instanceof Observation parent && !parent.isNoop();
    }${correlationFilter}${mongo}
}`;

  return {
    path: javaPath(model, TELEMETRY_PKG, 'TelemetryConfig'),
    content: javaFile(subPackage(model, TELEMETRY_PKG), [...imports], body)
  };
}

function renderMessageTracing(model) {
  const body = `/**
 * El contexto de traza W3C ({@code traceparent}) a través de los mensajes.
 *
 * <p>Viaja en {@code metadata.traceparent} de la envoltura keel, que es parte del contrato
 * público del evento: lo estampa {@code EventEnvelope.of(...)} al publicar y lo restaura
 * {@code CorrelationContext.runWith(metadata, ...)} al consumir. Va en el SOBRE y no solo en
 * las cabeceras nativas del broker por dos razones: con {@code reliability: outbox} la
 * publicación ocurre en otro hilo y otro instante —el contexto de la petición ya no existe, y lo
 * único que lo conserva es la fila—, y no todos los brokers tienen propagación nativa (SNS/SQS
 * no la tiene en Spring Cloud AWS). Donde sí la hay (Kafka, RabbitMQ), el consumo ya llega con la
 * traza abierta y aquí no se abre otra.
 *
 * <p>Estático porque lo usan dos piezas estáticas ({@code EventEnvelope.of} y
 * {@code CorrelationContext}); lo puebla {@code MessageTracingInstaller} al arrancar. Antes de
 * eso, o sin tracer, todo degrada a no hacer nada: nunca impide publicar ni consumir.
 */
public final class MessageTracing {

    /** Clave W3C del contexto de traza (https://www.w3.org/TR/trace-context/). */
    public static final String TRACEPARENT = "traceparent";

    /** Observación de la publicación de un evento del outbox. */
    public static final String OUTBOX_PUBLISH = "${OBSERVATIONS.outboxPublish}";

    /** Observación del consumo de un mensaje con envoltura keel. */
    public static final String MESSAGE_CONSUME = "${OBSERVATIONS.messageConsume}";

    private static final ObjectMapper JSON = new ObjectMapper();

    private static volatile Tracer tracer;
    private static volatile Propagator propagator;
    private static volatile ObservationRegistry registry = ObservationRegistry.NOOP;

    private MessageTracing() {
        // Clase de utilidad.
    }

    static void install(Tracer tracer, Propagator propagator, ObservationRegistry registry) {
        MessageTracing.tracer = tracer;
        MessageTracing.propagator = propagator;
        MessageTracing.registry = registry == null ? ObservationRegistry.NOOP : registry;
    }

    /** @return el traceparent del span activo, o null si no hay ninguno (o no hay telemetría). */
    public static String currentTraceparent() {
        Tracer current = tracer;
        Propagator format = propagator;
        if (current == null || format == null) {
            return null;
        }
        Span span = current.currentSpan();
        if (span == null || span.isNoop()) {
            return null;
        }
        Map<String, String> carrier = new HashMap<>();
        format.inject(span.context(), carrier, Map::put);
        return carrier.get(TRACEPARENT);
    }

    /**
     * El traceparent de una envoltura ya serializada (la fila del outbox guarda el JSON entero).
     * Un payload que no se deja leer pierde la traza, nunca el evento: devuelve null.
     */
    public static String traceparentOfEnvelope(String envelopeJson) {
        if (envelopeJson == null || envelopeJson.isBlank()) {
            return null;
        }
        try {
            JsonNode value = JSON.readTree(envelopeJson).path("metadata").path(TRACEPARENT);
            return value.isTextual() ? value.asText() : null;
        } catch (JsonProcessingException ex) {
            return null;
        }
    }

    /**
     * Ejecuta la acción dentro de una observación hija del contexto remoto. Sin traceparent
     * abre una raíz (el evento se sigue viendo); si el span activo YA es de esa traza —llegó por
     * la cabecera nativa del broker— no abre otra.
     */
    public static void continueFrom(String traceparent, String name, Kind kind, String eventType, Runnable action) {
        if (traceparent != null && sameTraceAsCurrent(traceparent)) {
            action.run();
            return;
        }
        Map<String, String> carrier = traceparent == null ? Map.of() : Map.of(TRACEPARENT, traceparent);
        ReceiverContext<Map<String, String>> context = new ReceiverContext<>((source, key) -> source.get(key), kind);
        context.setCarrier(carrier);
        String type = eventType == null || eventType.isBlank() ? "unknown" : eventType;
        Observation.createNotStarted(name, () -> context, registry)
                .contextualName(name + " " + type)
                .lowCardinalityKeyValue("keel.event.type", type)
                .observe(action);
    }

    private static boolean sameTraceAsCurrent(String traceparent) {
        Tracer current = tracer;
        if (current == null) {
            return false;
        }
        Span span = current.currentSpan();
        if (span == null || span.isNoop()) {
            return false;
        }
        String[] parts = traceparent.split("-");
        return parts.length >= 2 && parts[1].equals(span.context().traceId());
    }
}`;

  return {
    path: javaPath(model, TELEMETRY_PKG, 'MessageTracing'),
    content: javaFile(
      subPackage(model, TELEMETRY_PKG),
      [
        'com.fasterxml.jackson.core.JsonProcessingException',
        'com.fasterxml.jackson.databind.JsonNode',
        'com.fasterxml.jackson.databind.ObjectMapper',
        'io.micrometer.observation.Observation',
        'io.micrometer.observation.ObservationRegistry',
        'io.micrometer.observation.transport.Kind',
        'io.micrometer.observation.transport.ReceiverContext',
        'io.micrometer.tracing.Span',
        'io.micrometer.tracing.Tracer',
        'io.micrometer.tracing.propagation.Propagator',
        'java.util.HashMap',
        'java.util.Map'
      ],
      body
    )
  };
}

function renderInstaller(model) {
  const body = `/**
 * Puebla {@link MessageTracing} con el tracer, el propagador W3C y el registro de observaciones
 * que construye Boot. Es la única vía por la que las piezas estáticas de la mensajería llegan a
 * la telemetría.
 *
 * <p>Todo por {@code ObjectProvider}, y no es prudencia genérica: con las trazas apagadas (el
 * perfil {@code test}, y cualquier {@code @SpringBootTest}, que Boot arranca sin trazas) Boot
 * aporta un {@code Tracer} no-op pero NINGÚN {@code Propagator}. Pedirlo por constructor haría
 * que el contexto no arrancara justo donde la telemetría no importa. Sin él, MessageTracing
 * degrada a no hacer nada.
 */
@Component
class MessageTracingInstaller {

    MessageTracingInstaller(
            ObjectProvider<Tracer> tracer,
            ObjectProvider<Propagator> propagator,
            ObjectProvider<ObservationRegistry> observationRegistry) {
        MessageTracing.install(tracer.getIfAvailable(), propagator.getIfAvailable(), observationRegistry.getIfAvailable());
    }
}`;
  return {
    path: javaPath(model, TELEMETRY_PKG, 'MessageTracingInstaller'),
    content: javaFile(
      subPackage(model, TELEMETRY_PKG),
      [
        'io.micrometer.observation.ObservationRegistry',
        'io.micrometer.tracing.Tracer',
        'io.micrometer.tracing.propagation.Propagator',
        'org.springframework.beans.factory.ObjectProvider',
        'org.springframework.stereotype.Component'
      ],
      body
    )
  };
}
