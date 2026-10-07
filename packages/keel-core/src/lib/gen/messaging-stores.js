// Los dos almacenes de la mensajería y los parámetros con los que se gobiernan: la tabla del OUTBOX
// (`messaging.publishing.reliability: outbox`), la de los mensajes ya PROCESADOS por una suscripción
// (`processed_event`) y lo que el relay lee de la configuración. Es lo mismo en los dos generadores —el
// servidor de keel-spring y el de keel-nest del mismo diseño comparten base, esquema y variables de
// entorno—, así que se decide aquí, como `IDEMPOTENCY_RECORD` (request-idempotency.js), y no en cada
// emisor. Lo que cambia entre lenguajes (la entidad, el adaptador, el bucle del relay) es de cada uno.
//
// No confundir `processed_event` con el registro de la idempotencia de PETICIÓN (`idempotency_record`):
// aquel deduplica comandos que llegan por HTTP; este, mensajes que el broker reentrega.

/**
 * ¿Hay outbox? Necesita una transacción de base de datos que compartir con el cambio del agregado
 * (sin `persistence` no hay nada que hacer atómico) y eventos que publicar.
 */
export function usesOutbox(model) {
  return Boolean(
    model.layersPresent?.messaging &&
      model.layersPresent?.persistence &&
      model.messaging?.reliability === 'outbox' &&
      (model.events?.length ?? 0) > 0
  );
}

/**
 * ¿Hay registro de mensajes procesados? Toda suscripción con persistencia lo usa: el broker entrega
 * at-least-once y la deduplicación se registra en la misma transacción que el efecto del mensaje.
 */
export function usesMessageDeduplication(model) {
  return Boolean(
    model.layersPresent?.messaging && model.layersPresent?.persistence && (model.subscriptions?.length ?? 0) > 0
  );
}

// ─── Las tablas, como DATOS ──────────────────────────────────────────────────
//
// Cada columna lleva su tipo del DSL (`base`), su cota y su nulabilidad. Las de texto sin cota en la
// entidad JPA de keel-spring (`destination`, `routing_key`, `event_type`) llevan aquí la que Hibernate
// les pone por defecto, 255: lo que el otro generador tiene que escribir es la columna que existe en la
// base, no la anotación. `onlyIn` marca la columna que solo existe en un modelo de persistencia.

/**
 * La tabla del outbox: un evento pendiente de entregar al broker, escrito en la misma transacción que
 * el cambio que lo provocó.
 *
 *   · payload es la EventEnvelope ya serializada, y viaja TAL CUAL: `text`, sin cota;
 *   · published_at null es lo que distingue una fila por entregar;
 *   · next_attempt_at es a la vez el backoff de una fila que falló y el LEASE de una fila reclamada
 *     cuyo despacho está en vuelo (el SKIP LOCKED solo reparte mientras la transacción del reclamo
 *     sigue abierta, y la publicación va fuera de ella);
 *   · last_error se trunca a su cota antes de escribirse (OUTBOX_LAST_ERROR_LENGTH);
 *   · claimed_at, solo en el modelo documental: ahí no hay lock de fila, y el reclamo es una marca
 *     caducable en el documento;
 *   · el índice (published_at, created_at) es el de la búsqueda de pendientes en orden de llegada.
 */
export const OUTBOX_EVENT = Object.freeze({
  table: 'outbox_event',
  columns: Object.freeze([
    { name: 'id', base: 'uuid', nullable: false, primary: true },
    { name: 'destination', base: 'string', length: 255, nullable: false },
    { name: 'routing_key', base: 'string', length: 255, nullable: false },
    { name: 'event_type', base: 'string', length: 255, nullable: false },
    { name: 'payload', base: 'text', nullable: false },
    { name: 'created_at', base: 'timestamp', nullable: false },
    { name: 'published_at', base: 'timestamp', nullable: true },
    { name: 'attempts', base: 'integer', nullable: false },
    { name: 'next_attempt_at', base: 'timestamp', nullable: true },
    { name: 'claimed_at', base: 'timestamp', nullable: true, onlyIn: 'document' },
    { name: 'last_error', base: 'string', length: 1024, nullable: true }
  ]),
  indexes: Object.freeze([{ name: 'ix_outbox_event_pending', columns: ['published_at', 'created_at'] }])
});

/** La cota de `outbox_event.last_error`: el relay trunca el mensaje del fallo a esta longitud. */
export const OUTBOX_LAST_ERROR_LENGTH = OUTBOX_EVENT.columns.find((c) => c.name === 'last_error').length;

/**
 * La tabla de los mensajes ya procesados por una suscripción.
 *
 *   · clave primaria (handler_id, event_id): es la BASE la que arbitra la carrera entre dos entregas
 *     simultáneas del mismo mensaje — la que pierde el INSERT revierte entera, efecto incluido;
 *   · handler_id identifica al consumidor, de modo que dos suscripciones del mismo evento no se
 *     deduplican entre sí;
 *   · event_id es el id del mensaje (`metadata.eventId` con envoltura Keel, o el `messageId` declarado
 *     para una fuente ajena): 255 y no 64, porque lo elige quien publica y quedarse corto no es un
 *     error de validación sino un mensaje en la DLQ por no caber;
 *   · el índice sobre processed_at es el de la purga.
 */
export const PROCESSED_EVENT = Object.freeze({
  table: 'processed_event',
  columns: Object.freeze([
    { name: 'handler_id', base: 'string', length: 128, nullable: false, primary: true },
    { name: 'event_id', base: 'string', length: 255, nullable: false, primary: true },
    { name: 'processed_at', base: 'timestamp', nullable: false }
  ]),
  indexes: Object.freeze([{ name: 'ix_processed_event_processed_at', columns: ['processed_at'] }])
});

/** Las columnas de una de estas tablas en un modelo de persistencia (`relational` o `document`). */
export function storeColumns(table, persistenceKind = 'relational') {
  return table.columns.filter((column) => !column.onlyIn || column.onlyIn === persistenceKind);
}

// ─── Los parámetros ──────────────────────────────────────────────────────────
//
// Cada uno con su clave de configuración (la de `application-<perfil>.yaml` en keel-spring, y la que
// cualquier otro generador expone con el mismo nombre), su variable de entorno y su valor por defecto;
// `local` es el valor del perfil `local` cuando difiere. Un generador lee de aquí el default que
// escribe en su configuración Y el que pone en el código como respaldo: si los dos salieran de sitios
// distintos, divergirían.

/** Lo que gobierna el relay del outbox. */
export const OUTBOX_RELAY = Object.freeze({
  /** Cada cuánto busca filas pendientes. */
  fixedDelayMs: Object.freeze({ key: 'outbox.relay.fixed-delay-ms', env: 'OUTBOX_RELAY_DELAY_MS', default: 1000 }),
  /** Cuántas reclama en una pasada. */
  batchSize: Object.freeze({ key: 'outbox.relay.batch-size', env: 'OUTBOX_RELAY_BATCH_SIZE', default: 100 }),
  /**
   * Tras cuántos fallos una fila se rinde: deja de reclamarse y queda para inspección, sin borrarse.
   * En `local` son más, no por tolerancia sino por PRESUPUESTO: ahí el broker caído es un PASO del
   * escenario de outbox, y la fila tiene que aguantar un reinicio entero del contenedor. El producto
   * de este valor y del tope del backoff es ese presupuesto.
   */
  maxAttempts: Object.freeze({ key: 'outbox.relay.max-attempts', env: 'OUTBOX_RELAY_MAX_ATTEMPTS', default: 10, local: 40 }),
  /** El primer aplazamiento tras un fallo (ver `outboxBackoffMs`). */
  backoffInitialMs: Object.freeze({ key: 'outbox.relay.backoff.initial-ms', env: 'OUTBOX_RELAY_BACKOFF_INITIAL_MS', default: 1000 }),
  /**
   * El tope del aplazamiento. Corto en `local` porque es la LATENCIA de la reentrega tras la
   * recuperación del broker, y el escenario de outbox la espera.
   */
  backoffMaxMs: Object.freeze({ key: 'outbox.relay.backoff.max-ms', env: 'OUTBOX_RELAY_BACKOFF_MAX_MS', default: 60000, local: 2000 }),
  /**
   * Cuánto retiene una fila reclamada mientras su despacho está en vuelo: el lease sobre
   * `next_attempt_at` en el modelo relacional, la caducidad de `claimed_at` en el documental. Tiene
   * que superar con holgura la latencia peor del broker; por debajo, dos pasadas entregan lo mismo.
   */
  claimTimeoutMs: Object.freeze({ key: 'outbox.relay.claim-timeout-ms', env: 'OUTBOX_RELAY_CLAIM_TIMEOUT_MS', default: 60000 })
});

/** La purga de lo ya publicado del outbox (lo pendiente no se toca nunca). */
export const OUTBOX_PURGE = Object.freeze({
  cron: Object.freeze({ key: 'outbox.purge.cron', env: 'OUTBOX_PURGE_CRON', default: '0 0 3 * * *', cron: true }),
  retentionDays: Object.freeze({ key: 'outbox.purge.retention-days', env: 'OUTBOX_PURGE_RETENTION_DAYS', default: 7 })
});

/**
 * La purga del registro de mensajes procesados. La retención solo tiene que cubrir la ventana en la
 * que el broker puede reentregar: pasada, una reentrega se procesa como nueva.
 */
export const PROCESSED_EVENT_PURGE = Object.freeze({
  cron: Object.freeze({ key: 'processed-event.purge.cron', env: 'PROCESSED_EVENT_PURGE_CRON', default: '0 0 4 * * *', cron: true }),
  retentionDays: Object.freeze({ key: 'processed-event.purge.retention-days', env: 'PROCESSED_EVENT_PURGE_RETENTION_DAYS', default: 14 })
});

/** El valor de un parámetro en un perfil: el de `local` si lo tiene y es ese perfil; si no, el default. */
export function parameterValue(parameter, profile) {
  return profile === 'local' && parameter.local !== undefined ? parameter.local : parameter.default;
}

/**
 * El aplazamiento tras el fallo número `attempts` (1 = el primero): `initialMs · 2^(attempts-1)`,
 * saturado en `maxMs`. Es la REFERENCIA ejecutable de la fórmula: cada generador la escribe en su
 * lenguaje y sus pruebas la comparan con esta.
 */
export function outboxBackoffMs(attempts, initialMs, maxMs) {
  const delay = initialMs * 2 ** Math.max(attempts - 1, 0);
  return Number.isFinite(delay) && delay <= maxMs ? delay : maxMs;
}

/** ¿Se rinde una fila con este número de fallos? Con el contador YA incrementado. */
export function outboxDeadLettered(attempts, maxAttempts) {
  return attempts >= maxAttempts;
}
