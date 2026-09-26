// El trabajo lanzado a OTRO hilo pierde el contexto del que lo lanzó: el MDC (el correlationId,
// y con telemetría el traceId/spanId) y la observación activa son ThreadLocal, y un executor no
// los copia. `conventions/virtual-threads.md` enseña a paralelizar I/O en los query handlers con
// hilos virtuales, así que sin esto cada tarea paralela escribía logs sin correlación y abría
// spans huérfanos: la traza de la petición se cortaba justo donde estaba el tiempo.
//
// Se genera con y sin telemetría. El correlationId también se pierde sin ella, y así el código
// del agente no cambia al activarla después. Vive en `application/support` porque lo llaman los
// handlers, y la capa application no puede importar infrastructure; context-propagation es de
// Micrometer, no de Spring, así que no rompe la regla de «application sin Spring».
//
// Y el registro de lo que se propaga vive en INFRAESTRUCTURA (`ContextPropagationConfig`), porque
// incluye el ThreadLocal propio de CorrelationContext, que application no puede importar. Se
// registra al ARRANCAR y no al cargar el helper: así vale también para el executor de `@Async` de
// Boot —al que se le aplica `ContextPropagatingTaskDecorator`—, que no pasa nunca por el helper.
// Hasta aquí el correlationId de CorrelationContext NO viajaba a las tareas: el log lo llevaba
// (va en el MDC) pero un evento publicado desde una tarea salía sin él. Con hilos virtuales,
// lanzar trabajo a otro hilo es barato y tentador, así que cada forma de perder el contexto
// acaba apareciendo; el gate de `check-logging.sh` (regla `context`) veta las demás.

import { javaFile, javaPath, subPackage } from './render.js';
import { correlationImport, usesCorrelation } from './correlation.js';

export const CONCURRENCY_PKG = 'application.support';
export const CONTEXT_EXECUTORS_CLASS = 'ContextPropagatingExecutors';
export const PROPAGATION_CONFIG_PKG = 'infrastructure.configurations.concurrency';
export const PROPAGATION_CONFIG_CLASS = 'ContextPropagationConfig';
/** Clave con la que el correlationId de CorrelationContext se registra en el ContextRegistry. */
export const CORRELATION_ACCESSOR_KEY = 'keel.correlation-id';

export function usesContextExecutors(model) {
  return Boolean(model.services?.some((service) => service.operations.length > 0));
}

export function generate(model) {
  if (!usesContextExecutors(model)) return [];
  return [renderExecutors(model), renderPropagationConfig(model)];
}

/**
 * El registro de propagación y el decorador de `@Async`. Una sola clase porque las dos cosas
 * dicen lo mismo —qué viaja de un hilo a otro— y separarlas es la forma de que una se quede atrás.
 */
function renderPropagationConfig(model) {
  const correlated = usesCorrelation(model);
  const imports = [
    'io.micrometer.context.ContextRegistry',
    'io.micrometer.context.integration.Slf4jThreadLocalAccessor',
    'org.springframework.context.annotation.Bean',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.core.task.TaskDecorator',
    'org.springframework.core.task.support.ContextPropagatingTaskDecorator'
  ];
  if (correlated) imports.push(correlationImport(model));
  const correlationAccessor = correlated
    ? `
        // El correlationId de CorrelationContext, que no es el del MDC: es el que estampa un evento
        // al publicarse. Restaurarlo con set() también lo pone en el MDC; limpiarlo con clear()
        // lo quita de los dos.
        registry.registerThreadLocalAccessor("${CORRELATION_ACCESSOR_KEY}",
                CorrelationContext::get, CorrelationContext::set, CorrelationContext::clear);`
    : '';
  const body = `/**
 * Qué viaja del hilo que lanza un trabajo al hilo que lo ejecuta.
 *
 * <p>El MDC (correlationId, y con telemetría traceId/spanId), la observación activa —que es la
 * traza— y el correlationId de CorrelationContext son ThreadLocal: un hilo nuevo, virtual o no,
 * empieza sin ellos. Aquí se registran en el {@code ContextRegistry} de Micrometer AL ARRANCAR
 * (la observación la registra micrometer-observation por ServiceLoader), y de ese registro leen
 * los dos caminos por los que el código lanza trabajo a otro hilo:
 *
 * <ul>
 *   <li>{@code ContextPropagatingExecutors} ({@code application/support}), para paralelizar dentro
 *       de un handler;</li>
 *   <li>el executor de {@code @Async} de Boot, al que Boot aplica el {@link TaskDecorator} de abajo.</li>
 * </ul>
 */
@Configuration(proxyBeanMethods = false)
public class ${PROPAGATION_CONFIG_CLASS} {

    static {
        ContextRegistry registry = ContextRegistry.getInstance();
        // El MDC entero, no una lista de claves: así viajan también las que añada la telemetría.
        registry.registerThreadLocalAccessor(new Slf4jThreadLocalAccessor());${correlationAccessor}
    }

    /**
     * Captura el contexto al ENCOLAR la tarea y lo restaura al ejecutarla. Boot lo aplica a su
     * executor de tareas, así que un {@code @Async} hereda traza, MDC y correlación sin que el
     * código haga nada.
     */
    @Bean
    public TaskDecorator contextPropagatingTaskDecorator() {
        return new ContextPropagatingTaskDecorator();
    }
}`;
  return {
    path: javaPath(model, PROPAGATION_CONFIG_PKG, PROPAGATION_CONFIG_CLASS),
    content: javaFile(subPackage(model, PROPAGATION_CONFIG_PKG), imports, body)
  };
}

function renderExecutors(model) {
  const body = `/**
 * Executors que llevan el contexto del hilo que lanza la tarea al hilo que la ejecuta.
 *
 * <p>Úsalo SIEMPRE en vez de {@code Executors.newVirtualThreadPerTaskExecutor()}: el MDC
 * (correlationId, y con telemetría traceId/spanId) y la observación activa son ThreadLocal, y un
 * executor normal no los copia. Sin esto, los logs de una tarea paralela salen sin correlación y
 * sus spans quedan huérfanos, separados de la traza de la petición. Lo vigila
 * {@code infra/check-logging.sh}.
 *
 * <pre>{@code
 * try (ExecutorService exec = ContextPropagatingExecutors.newVirtualThreadPerTaskExecutor()) {
 *     Future<A> a = exec.submit(() -> port.findA(id));
 *     Future<B> b = exec.submit(() -> port.findB(id));
 *     ...
 * }
 * }</pre>
 */
public final class ${CONTEXT_EXECUTORS_CLASS} {

    static {
        // El MDC entero, no una lista de claves: así viajan también las que añada la telemetría.
        // La observación activa ya la registra micrometer-observation por ServiceLoader, y el
        // correlationId de CorrelationContext lo registra ContextPropagationConfig al arrancar
        // (vive en infrastructure, que esta capa no puede importar). Registrar el MDC también
        // aquí deja el helper usable fuera de un contexto de Spring; repetirlo no duplica nada.
        ContextRegistry.getInstance().registerThreadLocalAccessor(new Slf4jThreadLocalAccessor());
    }

    private static final ContextSnapshotFactory SNAPSHOTS = ContextSnapshotFactory.builder().build();

    private ${CONTEXT_EXECUTORS_CLASS}() {
        // Clase de utilidad.
    }

    /** Un hilo virtual por tarea, con el contexto del hilo que la lanza. */
    public static ExecutorService newVirtualThreadPerTaskExecutor() {
        return ContextExecutorService.wrap(Executors.newVirtualThreadPerTaskExecutor(), () -> SNAPSHOTS.captureAll());
    }
}`;
  return {
      path: javaPath(model, CONCURRENCY_PKG, CONTEXT_EXECUTORS_CLASS),
      content: javaFile(
        subPackage(model, CONCURRENCY_PKG),
        [
          'io.micrometer.context.ContextExecutorService',
          'io.micrometer.context.ContextRegistry',
          'io.micrometer.context.ContextSnapshotFactory',
          'io.micrometer.context.integration.Slf4jThreadLocalAccessor',
          'java.util.concurrent.ExecutorService',
          'java.util.concurrent.Executors'
        ],
        body
      )
  };
}
