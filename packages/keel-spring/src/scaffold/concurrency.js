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
// Lo que NO propaga, y se dice: el ThreadLocal propio de CorrelationContext (infrastructure). Una
// tarea paralela lee el correlationId del MDC —que es lo que usa el log— pero no lo estampa en
// un evento; publicar desde una tarea paralela no es un patrón del generador.

import { javaFile, javaPath, subPackage } from './render.js';

export const CONCURRENCY_PKG = 'application.support';
export const CONTEXT_EXECUTORS_CLASS = 'ContextPropagatingExecutors';

export function usesContextExecutors(model) {
  return Boolean(model.services?.some((service) => service.operations.length > 0));
}

export function generate(model) {
  if (!usesContextExecutors(model)) return [];
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
        // La observación activa ya la registra micrometer-observation por ServiceLoader.
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
  return [
    {
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
    }
  ];
}
