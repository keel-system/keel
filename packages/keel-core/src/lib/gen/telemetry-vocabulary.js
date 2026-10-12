// Vocabulario NEUTRAL de la telemetría: los nombres de lo que un servicio generado emite —observaciones,
// atributos, interruptores por entorno, el transporte de las métricas— y la forma con la que se ven en un
// motor de métricas. Lo comparten keel-spring y keel-nest (incremento 14 de PLAN-KEEL-NEST.md) por la
// regla de equivalencia del plan: el MISMO panel y las MISMAS alertas tienen que tener datos con
// cualquiera de los dos servidores, así que los nombres de serie no pueden decidirse en dos sitios.
//
// El modo de fallo que este módulo existe para evitar es silencioso: un panel que consulta un nombre que
// nadie publica no falla, se queda VACÍO, y una alerta sobre una serie inexistente no dispara nunca.
//
// Lo que NO está aquí es lo de cada plataforma: las series del runtime (la JVM frente a Node), el pool de
// conexiones de cada driver, el retraso del consumidor que publica (o no) el cliente de cada broker y la
// observación que emite el cliente de Redis. Eso lo pone cada generador junto a su vocabulario.

/** ¿Se generó este proyecto con telemetría? (`telemetry: otel` en el stack). */
export function usesTelemetry(model) {
  return model?.stack?.telemetry === 'otel';
}

/**
 * Nombres de las observaciones propias. Son también el nombre de sus métricas (timers), así que van
 * todos en el vocabulario `keel.*` que ya usa el gauge del outbox.
 */
export const OBSERVATIONS = {
  useCase: 'keel.use-case',
  outboxPublish: 'keel.outbox.publish',
  messageConsume: 'keel.message.consume',
  storage: 'keel.storage',
  mailSend: 'keel.mail.send'
};

/** El gauge de los eventos del outbox que agotaron sus reintentos: no se publicarán nunca. */
export const OUTBOX_DEAD_LETTERED = 'keel.outbox.dead_lettered';

/**
 * Atributos que estampa el código generado. Todos de BAJA cardinalidad salvo `correlationId`, que va
 * al span como alta cardinalidad y jamás a una etiqueta de métrica.
 *
 * La clave de un objeto, el destinatario de un correo y cualquier id de negocio son dato y son alta
 * cardinalidad: no están. El bucket sí, porque es un nombre LÓGICO del diseño con pocos valores.
 */
export const ATTRIBUTES = {
  operation: 'keel.operation',
  outcome: 'keel.outcome',
  eventType: 'keel.event.type',
  correlationId: 'keel.correlation_id',
  storageOperation: 'keel.storage.operation',
  storageBucket: 'keel.storage.bucket'
};

/** Los valores de `keel.outcome`: sin ellos no hay consulta que separe los fallos del resto. */
export const OUTCOMES = ['ok', 'rejected', 'error'];

/**
 * Los subsistemas cuya instrumentación se enciende y se apaga por ENTORNO. Una variable solo se emite si
 * su subsistema existe en el diseño: una palanca que no mueve nada es peor que no tenerla. La clave de
 * configuración es la misma en los dos servidores (un mismo `.env` vale para los dos).
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

/**
 * El transporte de las métricas. El camino por defecto es el SCRAPE —el colector viene a buscarlas a
 * `scrapePath`—, porque es el que conserva los exemplars. El push por OTLP queda como salida con su propio
 * interruptor y apagado: dos caminos a la vez duplican cada serie en el backend. La ruta es la misma en
 * los dos servidores para que el colector de `deploy/` no dependa de cuál lo sirve.
 */
export const METRICS_TRANSPORT = {
  scrapePath: '/actuator/prometheus',
  actuatorEndpointId: 'prometheus',
  prometheus: { property: 'management.prometheus.metrics.export.enabled', envVar: 'METRICS_EXPORT_PROMETHEUS' },
  otlp: { property: 'management.otlp.metrics.export.enabled', envVar: 'METRICS_EXPORT_OTLP' }
};

/**
 * El nombre de serie con el que se ve una observación en un motor de métricas, y sus derivadas de
 * histograma: todo lo que no sea alfanumérico a `_` y la unidad base en SEGUNDOS, en la forma clásica
 * (`_bucket` con `le`, `_sum` y `_count`). Es la forma que fija el panel; cada servidor la publica así.
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
