// Vocabulario de la telemetría: nombres de observación, atributos, interruptores por variable de
// entorno y la forma con la que se le pregunta a un motor de métricas por lo que el servicio emite.
//
// Es fuente ÚNICA a propósito, y por la misma razón que `mail-probes.js` o `mongo-probes.js`: de
// aquí renderizan su Java el scaffolding (`src/scaffold/telemetry.js`, `config.js`,
// `observability-assets.js`) y sus aserciones el runner (`scripts/telemetry-check.js`). Un runner
// con nombres propios comprobaría que OpenTelemetry funciona, no que el generador acierta — que es
// exactamente el modo en que `mongo-check` estuvo meses en verde midiendo una copia de sí mismo.
//
// Dos cosas que no se ven leyendo los nombres:
//
//   · El nombre de una observación NO es el nombre de su serie. Micrometer lo mangla al exponerlo
//     (puntos y guiones a `_`) y le añade la unidad base del registro, que **cambia con el
//     transporte**: el registro OTLP publica los timers en milisegundos y el de Prometheus en
//     SEGUNDOS. Por eso las consultas salen de `promMetric()` y no escritas a mano: al pasar el
//     transporte a scrape, un panel con `keel_use_case_milliseconds` dentro no falla — se queda
//     vacío, que es peor.
//   · Los interruptores son propiedades de Spring leídas con `@ConditionalOnProperty`, así que se
//     resuelven al construir el contexto: cambian con un reinicio, nunca en caliente.

/**
 * ¿Se generó este proyecto con telemetría? Vive aquí, y no en el scaffolding, para que los
 * módulos que solo necesitan la PREGUNTA —`cache.js`, y cualquiera que venga detrás— no tengan
 * que importar el módulo que emite las clases: eso creaba un ciclo con `telemetry.js`, que a su
 * vez le pregunta a `cache.js` quién declara caché.
 */
export function usesTelemetry(model) {
  return model?.stack?.telemetry === 'otel';
}

/**
 * Nombres de las observaciones propias. Son también el nombre de sus métricas (timers), así que
 * van todos en el vocabulario `keel.*` que ya usa el gauge del outbox.
 */
export const OBSERVATIONS = {
  useCase: 'keel.use-case',
  outboxPublish: 'keel.outbox.publish',
  messageConsume: 'keel.message.consume',
  storage: 'keel.storage',
  mailSend: 'keel.mail.send'
};

/**
 * La observación que emite Lettuce por cada comando de Redis. No es nuestra —la pone
 * `io.lettuce.core.tracing.MicrometerTracing`—, pero el predicado anti-ruido de TelemetryConfig la
 * nombra, así que el literal vive aquí y no en dos sitios.
 */
export const REDIS_OBSERVATION = 'spring.data.redis';

/**
 * Atributos que estampa el código generado. Todos de BAJA cardinalidad salvo `correlationId`, que
 * va al span como high-cardinality y jamás a una etiqueta de métrica.
 *
 * <p>Lo que NO está aquí es tan importante como lo que está: la clave de un objeto, el
 * destinatario de un correo y cualquier id de negocio son dato y son alta cardinalidad. El bucket
 * sí entra porque es un nombre LÓGICO del diseño, con un puñado de valores posibles.
 */
export const ATTRIBUTES = {
  operation: 'keel.operation',
  outcome: 'keel.outcome',
  eventType: 'keel.event.type',
  correlationId: 'keel.correlation_id',
  storageOperation: 'keel.storage.operation',
  storageBucket: 'keel.storage.bucket'
};

/**
 * Los subsistemas cuya instrumentación se enciende y se apaga por ENTORNO, y el predicado que dice
 * si a este diseño le toca declarar cada uno.
 *
 * <p>Una variable solo se emite si su subsistema existe en el diseño: declarar
 * `TELEMETRY_INSTRUMENT_STORAGE` en un servicio sin buckets es una palanca que no mueve nada, y
 * eso es peor que no tenerla — quien la ponga creerá que hizo algo.
 *
 * <p>Aquí está el VOCABULARIO y no el predicado: quién declara cada subsistema lo decide
 * `instrumentationFor()` en `src/scaffold/telemetry.js`, que es quien puede preguntárselo a
 * `cachedOperations()` sin que `src/lib` acabe dependiendo del scaffolding.
 */
export const INSTRUMENTATION = {
  cache: {
    id: 'cache',
    property: 'keel.telemetry.instrumentation.cache.enabled',
    envVar: 'TELEMETRY_INSTRUMENT_CACHE',
    label: 'los comandos de Redis que ejecuta la caché'
  },
  storage: {
    id: 'storage',
    property: 'keel.telemetry.instrumentation.storage.enabled',
    envVar: 'TELEMETRY_INSTRUMENT_STORAGE',
    label: 'las operaciones sobre los buckets'
  },
  mail: {
    id: 'mail',
    property: 'keel.telemetry.instrumentation.mail.enabled',
    envVar: 'TELEMETRY_INSTRUMENT_MAIL',
    label: 'los envíos de correo'
  }
};

// Exemplars: el enlace de un punto de una métrica a una traza de ejemplo.
//
// No hay ninguna constante aquí y no hay ninguna clase que los emita, porque NO HACE FALTA: Boot
// los autoconfigura (`PrometheusExemplarsAutoConfiguration` aporta el `SpanContext` que el registro
// de Prometheus usa para rellenarlos) en cuanto coexisten ese registro y un `Tracer`. Lo único que
// hizo falta fue cambiar el transporte de las métricas a scrape, y el motivo es que el registro
// OTLP de Micrometer no sabe de exemplars hasta la 1.17 —medido sobre los jars de Maven Central:
// 1.15.3 y 1.16.7 no traen ninguna clase de exemplars y 1.17.1 sí—, y Boot 3.5 gestiona la 1.15.
//
// Hubo un bean propio que hacía lo mismo y la falsación por mutación demostró que era código
// muerto: quitándolo, los exemplars seguían saliendo. Queda escrito porque el siguiente que venga
// a «arreglar» los exemplars va a querer añadir ese bean otra vez.
//
// Y una cosa que solo se ve ejecutando: el exemplar viaja SOLO en la exposición OPENMETRICS. Con
// el `Accept` por defecto la respuesta trae las mismas series y las mismas etiquetas, y ni un
// exemplar — así que quien lo mire sin pedir OpenMetrics concluirá que no se emiten.

/**
 * El transporte de las métricas. Con telemetría el camino por defecto es el SCRAPE —el colector
 * viene a buscarlas a `/actuator/prometheus`—, porque es el único que conserva los exemplars.
 *
 * <p>El push por OTLP se queda como salida para quien no pueda scrapear, con su propio
 * interruptor y apagado: es el simétrico exacto de `LOG_EXPORT_OTLP` y por la misma razón, dos
 * caminos a la vez duplican las series en el backend.
 */
export const METRICS_TRANSPORT = {
  scrapePath: '/actuator/prometheus',
  actuatorEndpointId: 'prometheus',
  prometheus: { property: 'management.prometheus.metrics.export.enabled', envVar: 'METRICS_EXPORT_PROMETHEUS' },
  otlp: { property: 'management.otlp.metrics.export.enabled', envVar: 'METRICS_EXPORT_OTLP' }
};

/**
 * El nombre de serie con el que se ve una observación en un motor de métricas, y sus derivadas de
 * histograma.
 *
 * <p>Micrometer mangla el nombre (todo lo que no sea alfanumérico a `_`) y le añade la unidad base
 * del registro. Con el registro de Prometheus los timers van en SEGUNDOS —con el de OTLP iban en
 * milisegundos—, y un histograma se expone en la forma clásica: `_bucket` con su etiqueta `le`,
 * `_sum` y `_count`. De ahí que las consultas del panel no se escriban a mano.
 *
 * @param {string} observation nombre de la observación (p. ej. `keel.use-case`)
 * @returns {{ base: string, bucket: string, sum: string, count: string }}
 */
export function promMetric(observation) {
  const base = `${mangle(observation)}_seconds`;
  return { base, bucket: `${base}_bucket`, sum: `${base}_sum`, count: `${base}_count` };
}

/** El nombre de serie de un gauge o un contador, que no lleva unidad. */
export function promGauge(name) {
  return mangle(name);
}

/** El nombre de una etiqueta: el mismo manglado, sin unidad. */
export function promTag(attribute) {
  return mangle(attribute);
}

function mangle(name) {
  return String(name).replace(/[^a-zA-Z0-9]+/g, '_');
}

// ─── La sonda que se ejecuta DENTRO del proyecto generado ────────────────────
//
// Misma técnica que `claim-probes.js` y `store-probes.js`: el runner escribe esta clase en el
// proyecto recién generado y la ejecuta con Gradle. Lo que mide no lo puede medir nada más —ni
// comparar cadenas, ni javac—: que la serie que el panel consulta EXISTA con las etiquetas que
// el panel filtra, que el exemplar viaje pegado al cubo del histograma, y que el interruptor
// APAGUE de verdad.
//
// Se ejercitan los puertos y el mediator directamente, sin pasar por HTTP: así no hace falta
// token, que con capa `security` sería un proveedor de identidad entero por delante de la
// pregunta que se quiere contestar.

export const PROBE_CLASS = 'KeelTelemetryProbeIT';
export const SWITCH_CLASS = 'KeelTelemetrySwitchIT';

/**
 * Los casos de la sonda, con su id y el subsistema que los hace aplicables.
 *
 * <p>La lista vive aquí y no en el runner porque las dos cosas que hacen falta —el nombre del
 * método, que es lo que el XML de JUnit devuelve, y el id con el que se reporta— tienen que
 * coincidir. Con dos listas, un caso renombrado desaparece de la matriz sin que nada se ponga
 * rojo: el runner informaría de menos casos y seguiría saliendo en verde.
 */
export const CASES = [
  { id: 'TEL-1', method: 'scrapeIsOpenAndPublishesUseCaseMetric', title: 'el scrape responde sin token y publica la métrica del caso de uso' },
  { id: 'TEL-2', method: 'useCaseCarriesOutcome', title: 'la serie del caso de uso lleva el desenlace que filtra la alerta de errores' },
  { id: 'TEL-3', method: 'histogramCarriesExemplars', title: 'el histograma del caso de uso trae exemplars con un id de traza' },
  { id: 'TEL-4', method: 'correlationIsNotAMetricLabel', title: 'el correlationId no es etiqueta de métrica (cardinalidad sin techo)' },
  { id: 'TEL-5', method: 'storageSpanExists', subsystem: 'storage', title: 'una operación sobre un bucket deja su serie con operación y bucket' },
  { id: 'TEL-6', method: 'storageKeyIsNotALabel', subsystem: 'storage', title: 'la clave del objeto no sale como etiqueta' },
  { id: 'TEL-7', method: 'mailSpanExists', subsystem: 'mail', title: 'una entrega de correo deja su serie con su desenlace y sin el destinatario' },
  { id: 'TEL-8', method: 'cacheStatisticsExist', subsystem: 'cache', title: 'la caché publica su ratio de acierto (miss y luego hit)' },
  { id: 'TEL-9', method: 'switchedOff', subsystem: 'storage', title: 'con el interruptor apagado la serie desaparece y la subida sigue funcionando' }
];

/** El `@DisplayName` de un caso: mismo id con el que se reporta. */
function display(method) {
  const found = CASES.find((entry) => entry.method === method);
  if (!found) throw new Error(`Caso de sonda sin id: ${method}`);
  return `${found.id} · ${found.title}`;
}

/**
 * La clase que mide la instrumentación encendida.
 *
 * @param {object} spec `{ basePackage, appClass, subsystems, cacheConstant, cacheClass }`
 */
export function probeClass(spec) {
  const { basePackage, subsystems } = spec;
  const useCase = promMetric(OBSERVATIONS.useCase);
  const storage = promMetric(OBSERVATIONS.storage);
  const mail = promMetric(OBSERVATIONS.mailSend);

  const storageCase = subsystems.includes('storage')
    ? `
    @Test
    @DisplayName("${display('storageSpanExists')}")
    void storageSpanExists() {
        fileStorage.upload("${spec.storageBucket}", "keel-telemetry-probe.txt", "hola".getBytes(StandardCharsets.UTF_8), "text/plain");
        String exposition = scrape();
        assertThat(exposition).contains("${storage.count}");
        assertThat(exposition).contains("${promTag(ATTRIBUTES.storageOperation)}=\\"upload\\"");
        assertThat(exposition).contains("${promTag(ATTRIBUTES.storageBucket)}=\\"${spec.storageBucket}\\"");
    }

    @Test
    @DisplayName("${display('storageKeyIsNotALabel')}")
    void storageKeyIsNotALabel() {
        fileStorage.upload("${spec.storageBucket}", "secreto-de-alguien.pdf", new byte[] { 1 }, "application/pdf");
        assertThat(scrape()).doesNotContain("secreto-de-alguien");
    }
`
    : '';

  const mailCase = subsystems.includes('mail')
    ? `
    @Test
    @DisplayName("${display('mailSpanExists')}")
    void mailSpanExists() {
        mailSender.send(new MailMessage("${spec.mailFrom}", null, List.of("${spec.mailTo}"), List.of(),
                "Sonda de telemetría", "<p>hola</p>", "hola"${spec.mailAttachments ? ', List.of()' : ''}));
        String exposition = scrape();
        assertThat(exposition).contains("${mail.count}");
        assertThat(exposition).contains("${promTag(ATTRIBUTES.outcome)}=\\"ok\\"");
        // El destinatario es dato: no puede aparecer en ninguna etiqueta.
        assertThat(exposition).doesNotContain("${spec.mailTo}");
    }
`
    : '';

  const cacheCase = subsystems.includes('cache')
    ? `
    @Test
    @DisplayName("${display('cacheStatisticsExist')}")
    void cacheStatisticsExist() {
        Cache cache = cacheManager.getCache(${spec.cacheConstantRef});
        assertThat(cache).as("la caché declarada por el diseño no existe").isNotNull();
        cache.evictIfPresent("sonda");
        cache.get("sonda");
        cache.put("sonda", "valor");
        cache.get("sonda");
        String exposition = scrape();
        assertThat(exposition).contains("cache_gets_total");
        // Los VALORES, no la presencia de las series: sin estadísticas habilitadas en el gestor de
        // cachés, Boot publica \`cache_gets_total{result="hit"}\` igualmente y siempre a CERO. Un caso
        // que solo mirara los nombres saldría verde con la caché sin medir — salió, y la mutación
        // que le quita el \`enableStatistics()\` es la que lo destapó.
        assertThat(counterValue(exposition, "cache_gets_total", "result=\\"miss\\""))
                .as("los fallos de caché no se cuentan: ¿estadísticas habilitadas en el gestor?")
                .isGreaterThan(0d);
        assertThat(counterValue(exposition, "cache_gets_total", "result=\\"hit\\""))
                .as("los aciertos de caché no se cuentan: ¿estadísticas habilitadas en el gestor?")
                .isGreaterThan(0d);
    }
`
    : '';

  return `package ${basePackage};

import static org.assertj.core.api.Assertions.assertThat;

import ${basePackage}.application.interfaces.Command;
import ${basePackage}.infrastructure.configurations.usecase.UseCaseMediator;
${spec.imports.map((value) => `import ${value};`).join('\n')}
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.ActiveProfiles;

/**
 * Sonda de telemetría: la escribe scripts/telemetry-check.js en el proyecto GENERADO y la ejecuta
 * contra la infraestructura real. No es parte de lo que build siembra.
 *
 * <p>Lo que mide no lo ve ninguna otra red: los tests del generador comparan cadenas, java-syntax
 * tokeniza y javac da por bueno cualquier nombre de métrica. Una serie que el panel consulta y que
 * nadie publica no produce ningún error — produce un panel vacío y una alerta que no dispara.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        classes = { ${spec.appClass}.class${spec.doublesClass ? `, ${spec.doublesClass}.class` : ''} },
        properties = {
            // Sin exportador: lo que se mide es la EXPOSICIÓN de Prometheus, que no necesita
            // colector. El muestreo al 100 % sí hace falta, porque un exemplar solo se emite si
            // la traza está muestreada.
            "management.tracing.sampling.probability=1.0"${spec.excludeAutoConfig ? `,
            // Flapdoodle: el source set de pruebas lo trae para el perfil \`test\`, y su
            // autoconfiguración arranca un mongod EMBEBIDO. Sin excluirla, la sonda mediría una
            // base en memoria y saldría en verde sin tocar el contenedor.
            "spring.autoconfigure.exclude=${spec.excludeAutoConfig}"` : ''}
        })
// Boot APAGA la observabilidad en los @SpringBootTest (DisableObservabilityContextCustomizer): sin
// esto no hay registro de métricas ni tracer, y lo que se mediría es un no-op que nunca falla.
@AutoConfigureObservability
@ActiveProfiles("local")
class ${PROBE_CLASS} {

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private UseCaseMediator mediator;
${spec.fields}

    /**
     * La exposición de Prometheus, que es donde se ve QUÉ publica el servicio y con qué etiquetas.
     *
     * <p>Se pide en OPENMETRICS a propósito: los exemplars solo viajan en ese formato. Con el
     * {@code Accept} por defecto la respuesta es el texto clásico —las mismas series, las mismas
     * etiquetas— y ni un exemplar, así que un check que no lo pidiera concluiría que no se emiten.
     */
    private String scrape() {
        return scrape(OPENMETRICS);
    }

    private String scrape(String accept) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.ACCEPT, accept);
        return rest.exchange("http://localhost:" + port + "${METRICS_TRANSPORT.scrapePath}", HttpMethod.GET,
                new HttpEntity<>(headers), String.class).getBody();
    }

    private static final String OPENMETRICS = "application/openmetrics-text; version=1.0.0; charset=utf-8";

    @Test
    @DisplayName("${display('scrapeIsOpenAndPublishesUseCaseMetric')}")
    void scrapeIsOpenAndPublishesUseCaseMetric() {
        dispatchOne();
        String exposition = scrape();
        assertThat(exposition).as("el scrape no respondió: ¿está expuesto y permitido?").isNotNull();
        assertThat(exposition).contains("${useCase.count}");
        assertThat(exposition).contains("${promTag(ATTRIBUTES.operation)}=");
    }

    @Test
    @DisplayName("${display('useCaseCarriesOutcome')}")
    void useCaseCarriesOutcome() {
        dispatchOne();
        // Anclado a la serie del CASO DE USO. Sin el ancla, este caso sale VERDE en cualquier
        // diseño con correo o con almacenamiento —sus series llevan el mismo desenlace—, y lo que
        // la alerta de errores necesita es justo esta.
        boolean anchored = scrape().lines()
                .filter(line -> line.startsWith("${useCase.count}"))
                .anyMatch(line -> line.contains("${promTag(ATTRIBUTES.outcome)}="));
        assertThat(anchored).as("la serie del caso de uso no lleva el desenlace").isTrue();
    }

    @Test
    @DisplayName("${display('histogramCarriesExemplars')}")
    void histogramCarriesExemplars() {
        dispatchOne();
        String exposition = scrape();
        assertThat(exposition).as("sin cubos no hay exemplar donde colgarse").contains("${useCase.bucket}");
        // Anclado a la serie del CASO DE USO, y no a un «hay algún exemplar» en toda la exposición:
        // la propia llamada de esta sonda deja exemplars en http_client_requests, así que sin el
        // ancla el caso pasaría en verde con el histograma del caso de uso sin ninguno.
        boolean anchored = exposition.lines()
                .filter(line -> line.startsWith("${useCase.bucket}"))
                .anyMatch(line -> line.contains("# {") && line.contains("trace_id=\\""));
        assertThat(anchored)
                .as("el histograma del caso de uso no trae exemplars: falta el bean SpanContext, "
                        + "la traza no se muestreó, o la exposición no se pidió en OpenMetrics")
                .isTrue();
    }

    @Test
    @DisplayName("${display('correlationIsNotAMetricLabel')}")
    void correlationIsNotAMetricLabel() {
        dispatchOne();
        assertThat(scrape()).doesNotContain("${promTag(ATTRIBUTES.correlationId)}=");
    }
${storageCase}${mailCase}${cacheCase}
    /**
     * Despacha un caso de uso REAL del diseño. El handler es un stub que lanza, y da igual: la
     * observación se abre antes de llamarlo y se cierra con su desenlace, que es justo lo que hay
     * que medir —de hecho el desenlace \`error\` es el que filtra la alerta de tasa de errores—.
     *
     * <p>El comando se construye por reflexión con los campos a nulo: no se busca que el caso de
     * uso haga nada, sino que ATRAVIESE el mediator. Uno inventado no serviría: el mediator
     * resuelve el handler ANTES de abrir la observación, así que un mensaje sin handler
     * registrado no llega a medirse.
     */
    private void dispatchOne() {
        try {
            Class<?> type = Class.forName("${spec.commandFqn}");
            Constructor<?> constructor = type.getDeclaredConstructors()[0];
            constructor.setAccessible(true);
            Class<?>[] parameters = constructor.getParameterTypes();
            Object[] arguments = new Object[parameters.length];
            for (int index = 0; index < parameters.length; index++) {
                arguments[index] = defaultValue(parameters[index]);
            }
            mediator.dispatch((Command) constructor.newInstance(arguments));
        } catch (ReflectiveOperationException ex) {
            throw new IllegalStateException("La sonda no pudo construir ${spec.commandFqn}", ex);
        } catch (RuntimeException | Error expected) {
            // El stub del agente todavía no está escrito: ese es el desenlace \`error\`.
        }
    }

    /** El mayor valor entre las series que empiezan por {@code prefix} y llevan {@code label}. */
    private static double counterValue(String exposition, String prefix, String label) {
        return exposition.lines()
                .filter(line -> line.startsWith(prefix) && line.contains(label))
                .mapToDouble(line -> Double.parseDouble(line.substring(line.lastIndexOf(' ') + 1).trim()))
                .max()
                .orElse(0d);
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) {
            return null;
        }
        if (type == boolean.class) {
            return Boolean.FALSE;
        }
        if (type == char.class) {
            return (char) 0;
        }
        if (type == long.class) {
            return 0L;
        }
        if (type == double.class) {
            return 0d;
        }
        if (type == float.class) {
            return 0f;
        }
        return 0;
    }
}
`;
}

export const DOUBLES_CLASS = 'KeelTelemetryDoubles';

/**
 * El doble mínimo del puerto de almacenamiento.
 *
 * <p>Existe porque el adaptador de storage lo escribe el AGENTE: en un proyecto recién generado
 * no hay ninguna implementación de `FileStorage`, así que el contexto no arranca —falla por el
 * handler que lo inyecta, mucho antes de llegar a la telemetría—. El doble es del runner y nunca
 * del generador, y es justo el bean que el aspecto tiene que envolver: si el aspecto no lo
 * envuelve, el caso de storage cae.
 *
 * <p>La forma del puerto sale del diseño, no de una lista escrita a mano: los métodos de lectura
 * y de URL solo existen si el diseño declara buckets privados o públicos.
 */
export function doublesClass(spec) {
  const methods = [];
  methods.push(`    /** Guarda en memoria y devuelve cómo quedó: lo justo para que el caso de storage pueda medirse. */
        @Override
        public StoredObject upload(String bucket, String key, byte[] content, String contentType) {
            objects.put(bucket + "/" + key, content);
            return new StoredObject(key, URI.create("http://sonda/" + bucket + "/" + key), contentType, (long) content.length);
        }`);
  if (spec.hasPrivateBucket) {
    methods.push(`        @Override
        public byte[] download(String bucket, String key) {
            return objects.getOrDefault(bucket + "/" + key, new byte[0]);
        }`);
  }
  if (spec.hasPublicBucket) {
    methods.push(`        @Override
        public String publicUrl(String bucket, String key) {
            return "http://sonda/" + bucket + "/" + key;
        }`);
  }
  methods.push(`        @Override
        public void delete(String bucket, String key) {
            objects.remove(bucket + "/" + key);
        }`);
  if (spec.hasPrivateBucket) {
    methods.push(`        @Override
        public String signedUrl(String bucket, String key) {
            return "http://sonda/" + bucket + "/" + key + "?firma=sonda";
        }`);
  }

  return `package ${spec.basePackage};

import ${spec.basePackage}.domain.storage.FileStorage;
import ${spec.basePackage}.domain.storage.StoredObject;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * Dobles mínimos de los puertos que build NO implementa, para que el contexto arranque.
 *
 * <p>La escribe scripts/telemetry-check.js en el proyecto generado; no es parte de lo que build
 * siembra. Ningún doble sustituye a nada que se esté midiendo: el de almacenamiento es el bean al
 * que el aspecto de telemetría se tiene que enganchar.
 */
@TestConfiguration
public class ${DOUBLES_CLASS} {

    @Bean
    public FileStorage fileStorage() {
        return new InMemoryFileStorage();
    }

    /**
     * NO es {@code final}, y no es estilo: con el aspecto de telemetría puesto, Spring proxya este
     * bean, y lo hace por CGLIB —Boot pone {@code proxyTargetClass} a true—, que necesita poder
     * heredar de la clase. Con {@code final} el contexto no arranca y el mensaje habla de CGLIB,
     * no de telemetría.
     * Lo mismo aplica al adaptador que escriba el agente: está en conventions/observability.md.
     */
    static class InMemoryFileStorage implements FileStorage {

        private final Map<String, byte[]> objects = new ConcurrentHashMap<>();

${methods.join('\n\n')}
    }
}
`;
}

/**
 * La clase que mide el interruptor APAGADO, que es la otra mitad y la que contesta la pregunta
 * del operador: ¿puedo decidir por variable de entorno si el bucket se instrumenta?
 *
 * <p>Va en una clase aparte y no en un caso más porque `@ConditionalOnProperty` se resuelve al
 * construir el contexto: apagarlo exige OTRO contexto, no otra llamada.
 */
export function switchClass(spec) {
  const storage = promMetric(OBSERVATIONS.storage);
  return `package ${spec.basePackage};

import static org.assertj.core.api.Assertions.assertThat;

import ${spec.basePackage}.domain.storage.FileStorage;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.ActiveProfiles;

/**
 * El interruptor de la instrumentación de almacenamiento, APAGADO.
 *
 * <p>Las dos mitades importan y por separado no dicen nada: que la serie desaparezca prueba que
 * el interruptor se lee, y que la subida SIGA funcionando prueba que lo que se apagó fue la
 * observación y no el puerto.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        classes = { ${spec.appClass}.class${spec.doublesClass ? `, ${spec.doublesClass}.class` : ''} },
        properties = {
            "management.tracing.sampling.probability=1.0",
            "${INSTRUMENTATION.storage.property}=false"${spec.excludeAutoConfig ? `,
            "spring.autoconfigure.exclude=${spec.excludeAutoConfig}"` : ''}
        })
@AutoConfigureObservability
@ActiveProfiles("local")
class ${SWITCH_CLASS} {

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private FileStorage fileStorage;

    @Test
    @DisplayName("${display('switchedOff')}")
    void switchedOff() {
        fileStorage.upload("${spec.storageBucket}", "keel-switch-probe.txt", "hola".getBytes(StandardCharsets.UTF_8), "text/plain");
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.ACCEPT, "application/openmetrics-text; version=1.0.0; charset=utf-8");
        String exposition = rest.exchange("http://localhost:" + port + "${METRICS_TRANSPORT.scrapePath}",
                HttpMethod.GET, new HttpEntity<>(headers), String.class).getBody();
        assertThat(exposition).as("el scrape sigue teniendo que responder").isNotNull();
        assertThat(exposition)
                .as("la instrumentación de storage está apagada: su serie no puede existir")
                .doesNotContain("${storage.count}");
    }
}
`;
}
