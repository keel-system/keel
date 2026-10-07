// Los dos almacenes de la mensajería en keel-nest: el OUTBOX con su relay y el registro de mensajes
// PROCESADOS con su guarda. Las tablas y los parámetros son los de keel-core (`gen/messaging-stores.js`),
// los mismos que emite keel-spring: el servidor de los dos generadores del diseño encuentra en la base
// las mismas tablas y lee las mismas variables (`test/schema-parity.test.js` lo compara con lo que
// EMITE keel-spring).
//
// Lo que se mantiene de keel-spring, porque cada punto le costó un defecto allí:
//   · el relay en TRES pasos —reclamo corto con SKIP LOCKED y un LEASE sobre next_attempt_at,
//     publicación FUERA de toda transacción, desenlace en otra transacción corta—: meter la publicación
//     dentro del reclamo es retener una conexión del pool durante I/O de red;
//   · el backoff initial·2^(n-1) con tope, y la rendición al alcanzar max-attempts con el contador YA
//     incrementado: la fila rendida no se borra ni se reintenta;
//   · el reclamo en READ COMMITTED en MySQL (en REPEATABLE READ toma los huecos y frena las altas);
//   · el respaldo del dispatcher que NO deja arrancar fuera de local y test: marcaría como publicadas
//     filas que nunca salieron;
//   · el registro de procesados en su PROPIA transacción, y la carrera arbitrada por la clave primaria.
//
// El relay es un bucle de retardo FIJO propio, no una tarea del reloj (scheduling.js): su cadencia es un
// retardo entre pasadas, no un cron. Las purgas de outbox_event y processed_event sí van por el reloj (purge.js).

import {
  OUTBOX_EVENT,
  OUTBOX_LAST_ERROR_LENGTH,
  PROCESSED_EVENT,
  storeColumns
} from 'keel-core/gen/messaging-stores';
import { classPath, tsModule, tsString } from './render.js';
import { TRANSFORMERS_TS, engineOf, optionsLiteral, physicalColumn } from './persistence-entities.js';
import { TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';
import {
  IDEMPOTENCY_GUARD_TS,
  MESSAGING_SETTINGS_TS,
  OUTBOX_BACKOFF_TS,
  OUTBOX_DISPATCHER_FALLBACK_TS,
  OUTBOX_DISPATCHER_TS,
  OUTBOX_ORM_TS,
  OUTBOX_RELAY_STORE_TS,
  OUTBOX_RELAY_TS,
  PROCESSED_EVENT_ORM_TS,
  usesNestOutbox,
  usesProcessedEvents
} from './messaging.js';

export function generate(model) {
  const files = [];
  if (usesNestOutbox(model)) {
    files.push(
      { path: OUTBOX_ORM_TS, content: storeEntity(model, OUTBOX_EVENT, 'OutboxEventOrm', OUTBOX_ORM_TS, OUTBOX_DOC) },
      { path: OUTBOX_DISPATCHER_TS, content: dispatcherPort() },
      { path: OUTBOX_DISPATCHER_FALLBACK_TS, content: dispatcherFallback() },
      { path: OUTBOX_BACKOFF_TS, content: backoffFile() },
      { path: OUTBOX_RELAY_STORE_TS, content: relayStore(model) },
      { path: OUTBOX_RELAY_TS, content: relay() }
    );
  }
  if (usesProcessedEvents(model)) {
    files.push(
      { path: PROCESSED_EVENT_ORM_TS, content: storeEntity(model, PROCESSED_EVENT, 'ProcessedEventOrm', PROCESSED_EVENT_ORM_TS, PROCESSED_DOC) },
      { path: IDEMPOTENCY_GUARD_TS, content: guard() }
    );
  }
  return files;
}

/** Las entidades de estas tablas, para el DataSource. */
export function storeEntities(model) {
  const entities = [];
  if (usesNestOutbox(model)) entities.push({ symbol: 'OutboxEventOrm', from: OUTBOX_ORM_TS });
  if (usesProcessedEvents(model)) entities.push({ symbol: 'ProcessedEventOrm', from: PROCESSED_EVENT_ORM_TS });
  return entities;
}

// ─── Las entidades, desde los datos de keel-core ─────────────────────────────

const OUTBOX_DOC = `Fila del outbox: un evento pendiente de entregar al broker. Se escribe en la misma transacción que el
 * cambio del agregado que lo provocó (el puente) y el relay la marca publicada cuando sale. La MISMA
 * tabla que el servidor de keel-spring del diseño (keel-core/gen/messaging-stores.js): published_at null
 * es lo que distingue una fila por entregar, y next_attempt_at es a la vez el backoff de una fila que
 * falló y el lease de una reclamada.`;

const PROCESSED_DOC = `Mensaje ya procesado por un consumidor: el par (handler_id, event_id). La MISMA tabla que el servidor de
 * keel-spring del diseño (keel-core/gen/messaging-stores.js): la clave primaria es la que arbitra la
 * carrera entre dos entregas simultáneas del mismo mensaje, y el índice sobre processed_at es el de la
 * purga.`;

const propertyOf = (column) => column.name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

const TS_TYPES = { timestamp: 'Date', int: 'number' };

function storeEntity(model, spec, className, file, doc) {
  const engine = engineOf(model);
  const transformers = new Set();
  const fields = storeColumns(spec, 'relational').map((column) => {
    const physical = physicalColumn(column, engine);
    for (const symbol of physical.imports ?? []) transformers.add(symbol);
    const options = { name: column.name, ...physical.options, nullable: column.nullable };
    if (physical.transformer) options.transformer = physical.transformer;
    if (column.primary) delete options.nullable;
    const type = TS_TYPES[column.base] ?? 'string';
    return `  @${column.primary ? 'PrimaryColumn' : 'Column'}(${optionsLiteral(options)})\n  ${propertyOf(column)}!: ${column.nullable ? `${type} | null` : type};`;
  });
  const indexes = spec.indexes.map(
    (index) => `@Index(${tsString(index.name)}, [${index.columns.map((name) => tsString(propertyOf({ name }))).join(', ')}])`
  );
  return tsModule(
    file,
    [
      { symbol: 'Column', from: 'typeorm' },
      { symbol: 'Entity', from: 'typeorm' },
      { symbol: 'Index', from: 'typeorm' },
      { symbol: 'PrimaryColumn', from: 'typeorm' },
      ...[...transformers].map((symbol) => ({ symbol, from: TRANSFORMERS_TS }))
    ],
    `/**
 * ${doc}
 */
@Entity({ name: '${spec.table}' })
${indexes.join('\n')}
export class ${className} {
${fields.join('\n\n')}
}`
  );
}

// ─── El dispatcher ───────────────────────────────────────────────────────────

function dispatcherPort() {
  return tsModule(
    OUTBOX_DISPATCHER_TS,
    [],
    `/**
 * Puerto de salida del outbox: entrega al broker una fila ya serializada. Es lo ÚNICO acoplado al broker
 * en todo el patrón; la implementación la escribe el agente (skill keel-nest-<broker>) y la registra en
 * broker-bindings.ts.
 *
 * Es una clase abstracta y no una interfaz porque sirve también de token de inyección.
 */
export abstract class OutboxDispatcher {
  /**
   * Envía el payload (la EventEnvelope ya serializada) al destino y la routing key indicados, con
   * \`eventType\` como tipo nativo del mensaje. Tiene que FALLAR si el broker no confirma la entrega: el
   * relay cuenta el intento y reintenta en la pasada siguiente.
   */
  abstract dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void>;
}`
  );
}

function dispatcherFallback() {
  return tsModule(
    OUTBOX_DISPATCHER_FALLBACK_TS,
    [
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'OutboxDispatcher', from: OUTBOX_DISPATCHER_TS }
    ],
    `/** Perfiles en los que arrancar sin broker es legítimo. */
const TOLERATED = new Set(['local', 'test']);

/**
 * El respaldo del puerto OutboxDispatcher mientras no hay uno real: build lo registra y el que escriba el
 * agente en broker-bindings.ts lo sustituye. No hay que borrar este archivo.
 *
 * Su \`dispatch\` NO lanza —si lanzara, las filas acumularían intentos hasta la rendición—, y eso tiene un
 * precio: el relay marca como publicadas filas que nunca salieron. En local y test es lo que se quiere
 * (arrancar sin broker); en cualquier otro perfil \`reliability: outbox\` se convertiría en perder TODOS los
 * eventos sin un error, así que ahí no deja arrancar.
 */
export function outboxDispatcherFallback(profiles: readonly string[]): OutboxDispatcher {
  if (profiles.length > 0 && !profiles.some((profile) => TOLERATED.has(profile))) {
    throw new Error(
      \`No hay implementación de OutboxDispatcher y el perfil activo es \${profiles.join(',')}: el relay marcaría como publicados \` +
        'eventos que nunca salen del proceso. Impleméntalo con la skill keel-nest-<broker> del stack de keel-stack.json.'
    );
  }
  const logger = new Logger('OutboxDispatcher');
  logger.warn(\`OutboxDispatcher sin implementar: los eventos NO salen del proceso (perfil \${profiles.join(',')})\`);
  return new (class extends OutboxDispatcher {
    async dispatch(destination: string, routingKey: string, eventType: string): Promise<void> {
      // TODO (agente): sustituir por el dispatcher real del broker (skill keel-nest-<broker>), registrado
      //   en broker-bindings.ts: publicar el payload tal cual, con content-type application/json.
      logger.warn(\`OutboxDispatcher no implementado: \${eventType} no salió a \${destination}/\${routingKey}\`);
    }
  })();
}`
  );
}

// ─── El relay ────────────────────────────────────────────────────────────────

function backoffFile() {
  return tsModule(
    OUTBOX_BACKOFF_TS,
    [],
    `/** La cota de last_error: el mensaje de un fallo se trunca a ella antes de guardarse. */
export const LAST_ERROR_LENGTH = ${OUTBOX_LAST_ERROR_LENGTH};

/**
 * El aplazamiento tras el fallo número \`attempts\` (1 = el primero): initial·2^(attempts-1), saturado en
 * \`maxMs\`. Es la fórmula de keel-core (outboxBackoffMs), la misma que aplica el relay de keel-spring.
 */
export function outboxBackoffMs(attempts: number, initialMs: number, maxMs: number): number {
  const delay = initialMs * 2 ** Math.max(attempts - 1, 0);
  return Number.isFinite(delay) && delay <= maxMs ? delay : maxMs;
}

/** ¿Se rinde una fila con este número de fallos? Con el contador YA incrementado. */
export function outboxDeadLettered(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/** El mensaje de un fallo, truncado a la cota de la columna. */
export function truncateError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : error == null ? null : String(error);
  return message == null ? null : message.slice(0, LAST_ERROR_LENGTH);
}`
  );
}

function relayStore(model) {
  const mysql = engineOf(model) === 'mysql';
  return tsModule(
    OUTBOX_RELAY_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'IsNull', from: 'typeorm' },
      { symbol: 'MoreThanOrEqual', from: 'typeorm' },
      { symbol: 'OutboxEventOrm', from: OUTBOX_ORM_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'outboxBackoffMs', from: OUTBOX_BACKOFF_TS },
      { symbol: 'outboxDeadLettered', from: OUTBOX_BACKOFF_TS }
    ],
    `/** Lo que el relay necesita de una fila reclamada para publicarla: una copia, no la entidad. */
export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly destination: string;
  readonly routingKey: string;
  readonly eventType: string;
  readonly payload: string;
}

/** El desenlace de un fallo: cuántos intentos lleva la fila y si se rindió. */
export interface MarkFailedOutcome {
  readonly attempts: number;
  readonly deadLettered: boolean;
}

/**
 * Las transacciones CORTAS del relay, separadas de la publicación al broker (I/O de red):
 *   1. claimBatch: reclamo con SKIP LOCKED más un LEASE sobre next_attempt_at, que retira la fila de las
 *      siguientes pasadas mientras dura el despacho. Confirma y suelta el lock en cuanto reclama;
 *   2. markPublished / markFailed: el desenlace, cada uno en su transacción.
 *
 * El lease sustituye a la garantía que el SKIP LOCKED daba solo mientras la transacción seguía abierta:
 * sin él, otra réplica —o esta misma en la pasada siguiente— volvería a ver elegible una fila cuyo
 * despacho sigue en vuelo. Si la réplica muere, el lease caduca y otra la recoge.
 */
@Injectable()
export class OutboxRelayStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  async claimBatch(maxAttempts: number, batchSize: number, claimTimeoutMs: number): Promise<ClaimedOutboxEvent[]> {
    return this.transactions.inNewTransaction(
      async (manager) => {
        const now = new Date();
        // Pendientes, en orden de llegada, que no agotaron sus reintentos y cuyo backoff (o lease) venció.
        // SKIP LOCKED: con varias réplicas cada una se lleva un lote disjunto en vez de esperar a la otra.
        const rows = await manager
          .createQueryBuilder(OutboxEventOrm, 'o')
          .where('o.publishedAt IS NULL')
          .andWhere('o.attempts < :maxAttempts', { maxAttempts })
          .andWhere('(o.nextAttemptAt IS NULL OR o.nextAttemptAt <= :now)', { now })
          .orderBy('o.createdAt', 'ASC')
          .limit(batchSize)
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getMany();
        if (rows.length === 0) return [];
        // El lease: si el despacho sale bien, markPublished la saca del todo; si falla, markFailed lo pisa
        // con el backoff de verdad. Fila a fila y no con In(...): en MySQL el id es binary(16) y lo
        // convierte el transformador de la columna, que un operador de búsqueda no garantiza aplicar.
        const leaseUntil = new Date(now.getTime() + claimTimeoutMs);
        for (const row of rows) await manager.update(OutboxEventOrm, { id: row.id }, { nextAttemptAt: leaseUntil });
        return rows.map(({ id, destination, routingKey, eventType, payload }) => ({ id, destination, routingKey, eventType, payload }));
      },
      ${mysql ? "// READ COMMITTED: en REPEATABLE READ (el default de MySQL) la lectura con bloqueo toma también los\n      // HUECOS entre claves y frena los INSERT de filas nuevas —el puente escribiendo el outbox— hasta el\n      // lock wait timeout.\n      { isolation: 'READ COMMITTED' }" : '{}'}
    );
  }

  async markPublished(id: string): Promise<void> {
    await this.transactions.inNewTransaction((manager) => manager.update(OutboxEventOrm, { id }, { publishedAt: new Date() }));
  }

  /**
   * Incrementa el intento, decide rendición o backoff con el contador YA incrementado y lo aplica, todo en
   * la misma transacción: el relay nunca vuelve a preguntar cuántos intentos lleva con otra consulta.
   */
  async markFailed(id: string, error: string | null, maxAttempts: number, backoffInitialMs: number, backoffMaxMs: number): Promise<MarkFailedOutcome> {
    return this.transactions.inNewTransaction(async (manager) => {
      const row = await manager.findOne(OutboxEventOrm, { where: { id }, lock: { mode: 'pessimistic_write' } });
      // La fila desapareció entre el reclamo y el desenlace: nada que actualizar, y se da por agotada para
      // no reintentar sobre un id que ya no está.
      if (row == null) return { attempts: maxAttempts, deadLettered: true };
      const attempts = row.attempts + 1;
      const deadLettered = outboxDeadLettered(attempts, maxAttempts);
      await manager.update(
        OutboxEventOrm,
        { id },
        deadLettered
          ? { attempts, lastError: error }
          : { attempts, lastError: error, nextAttemptAt: new Date(Date.now() + outboxBackoffMs(attempts, backoffInitialMs, backoffMaxMs)) }
      );
      return { attempts, deadLettered };
    });
  }

  /**
   * Cuántas filas se rindieron: agotaron los reintentos y siguen sin publicar. Es el dato de la única
   * promesa del outbox —que ningún evento se pierde— justo cuando deja de cumplirse.
   */
  async countDeadLettered(maxAttempts: number): Promise<number> {
    return this.transactions.inNewTransaction(
      (manager) => manager.count(OutboxEventOrm, { where: { publishedAt: IsNull(), attempts: MoreThanOrEqual(maxAttempts) } }),
      { readOnly: true }
    );
  }
}`
  );
}

function relay() {
  return tsModule(
    OUTBOX_RELAY_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'BeforeApplicationShutdown', from: '@nestjs/common', type: true },
      { symbol: 'OnApplicationBootstrap', from: '@nestjs/common', type: true },
      { symbol: 'DataSource', from: 'typeorm', type: true },
      { symbol: 'DATA_SOURCE', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'MESSAGING_SETTINGS', from: MESSAGING_SETTINGS_TS },
      { symbol: 'MessagingSettings', from: MESSAGING_SETTINGS_TS, type: true },
      { symbol: 'OutboxRelaySettings', from: MESSAGING_SETTINGS_TS, type: true },
      { symbol: 'OutboxDispatcher', from: OUTBOX_DISPATCHER_TS },
      { symbol: 'OutboxRelayStore', from: OUTBOX_RELAY_STORE_TS },
      { symbol: 'truncateError', from: OUTBOX_BACKOFF_TS }
    ],
    `/**
 * Reenvía al broker las filas pendientes del outbox, ya fuera de la transacción que las creó.
 *
 * Tres pasos, y la publicación no está dentro de ninguna transacción: OutboxRelayStore.claimBatch
 * reclama el lote en una transacción corta, el dispatcher publica sin conexión retenida, y el desenlace
 * va en otra transacción corta. Un fallo de entrega no revierte nada: cuenta el intento y la fila se
 * reintenta tras su backoff (entrega at-least-once: el consumidor deduplica por metadata.eventId). La
 * que agota max-attempts se rinde: deja de reclamarse y se reporta a ERROR, sin borrarse.
 *
 * Corre con un retardo FIJO entre pasadas (outbox.relay.fixed-delay-ms) desde que la aplicación arranca,
 * y para antes del apagado esperando a la pasada en vuelo. Sin base de datos (el perfil test) no corre.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OutboxRelay');
  private readonly settings: OutboxRelaySettings;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private paused = false;

  constructor(
    @Inject(OutboxRelayStore) private readonly store: OutboxRelayStore,
    @Inject(OutboxDispatcher) private readonly dispatcher: OutboxDispatcher,
    @Inject(MESSAGING_SETTINGS) messaging: MessagingSettings,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource | null
  ) {
    if (messaging.outboxRelay == null) throw new Error('OutboxRelay sin outbox.relay en la configuración de mensajería');
    this.settings = messaging.outboxRelay;
  }

  onApplicationBootstrap(): void {
    if (this.dataSource == null) return;
    this.schedule();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer != null) clearTimeout(this.timer);
    await this.inFlight;
  }

  /** Una pasada: reclama, publica y registra el desenlace de cada fila. Devuelve cuántas reclamó. */
  async relayOnce(): Promise<number> {
    const { maxAttempts, batchSize, claimTimeoutMs, backoffInitialMs, backoffMaxMs } = this.settings;
    const claimed = await this.store.claimBatch(maxAttempts, batchSize, claimTimeoutMs);
    for (const row of claimed) {
      // Apagándose, no se empieza otra publicación: las filas que quedan conservan su lease y otra pasada
      // (de esta réplica al volver o de otra) las recoge cuando caduca. Esperar a todo el lote retendría el
      // apagado una latencia del broker por fila.
      if (this.stopped) break;
      try {
        await this.dispatcher.dispatch(row.destination, row.routingKey, row.eventType, row.payload);
        await this.store.markPublished(row.id);
        this.logger.debug(\`Outbox: \${row.eventType} publicado (\${row.id})\`);
      } catch (error) {
        const reason = truncateError(error);
        const outcome = await this.store.markFailed(row.id, reason, maxAttempts, backoffInitialMs, backoffMaxMs);
        if (outcome.deadLettered) {
          // La rendición: queda parada para inspección, sin borrarse ni bloquear al resto.
          this.logger.error(\`Outbox: \${row.id} agotó \${maxAttempts} reintentos y queda como dead-letter: \${reason}\`);
        } else {
          this.logger.warn(\`Outbox: fallo entregando \${row.id} (intento \${outcome.attempts}): \${reason}\`);
        }
      }
    }
    return claimed.length;
  }

  /**
   * Suspende las pasadas, esperando a la que esté en vuelo. Es para el arnés de integración, que fabrica
   * así la precondición de un escenario del outbox (una fila pendiente que nadie entrega todavía).
   */
  async pause(): Promise<void> {
    this.paused = true;
    await this.inFlight;
  }

  /** Reanuda las pasadas suspendidas con pause(). */
  resume(): void {
    this.paused = false;
  }

  /** Las filas rendidas ahora mismo: la señal de que el outbox perdió algo (la mide el arnés). */
  countDeadLettered(): Promise<number> {
    return this.store.countDeadLettered(this.settings.maxAttempts);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.paused) {
        this.schedule();
        return;
      }
      this.inFlight = this.relayOnce()
        .then(() => undefined)
        .catch((error: unknown) => {
          // Una pasada que falla entera (la base caída) no para el relay: lo intenta en la siguiente.
          this.logger.error(\`Outbox: la pasada del relay falló: \${error instanceof Error ? error.message : String(error)}\`);
        })
        .finally(() => {
          this.inFlight = null;
          this.schedule();
        });
    }, this.settings.fixedDelayMs);
  }
}`
  );
}

// ─── La guarda de los mensajes procesados ────────────────────────────────────

function guard() {
  return tsModule(
    IDEMPOTENCY_GUARD_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'ProcessedEventOrm', from: PROCESSED_EVENT_ORM_TS },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'isIntegrityViolation', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS }
    ],
    `/**
 * Guarda de idempotencia del consumidor. La entrega de cualquier broker es at-least-once y el relay del
 * outbox reintenta: la reentrega no es un caso raro, es lo normal ante cualquier corte.
 *
 * Hay DOS órdenes y no son intercambiables. El registro va en su PROPIA transacción (sobrevive al fallo
 * del handler), y por eso el orden importa:
 *   1. procesar y luego registrar (alreadyProcessed antes, record después de que el handler termine
 *      bien). Es el predeterminado: un fallo transitorio deja el mensaje sin marcar y la reentrega lo
 *      reintenta. Si el proceso muere entre el commit del negocio y el registro, la reentrega se procesa
 *      dos veces: por eso este orden pide una guarda de dominio detrás;
 *   2. registrar y luego procesar (tryRecord, atómico). Cierra la ventana del duplicado, pero convierte
 *      un fallo transitorio en un mensaje PERDIDO. Solo si reprocesar es inaceptable y perder tolerable.
 * Cuál toca lo dice la clase del mensaje de cada suscripción.
 *
 * Con varias réplicas, dos entregas del mismo mensaje pueden procesarse a la vez: el árbitro es la clave
 * primaria de processed_event, que es compartida.
 */
@Injectable()
export class IdempotencyGuard {
  private readonly logger = new Logger('IdempotencyGuard');

  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  /**
   * ¿Ya se procesó este mensaje? Sin efectos, para descartar la reentrega antes de despachar.
   * @param handlerId el consumidor (el nombre de la clase del listener)
   * @param eventId el id del mensaje (el messageId del diseño o metadata.eventId)
   */
  async alreadyProcessed(handlerId: string, eventId: string): Promise<boolean> {
    const seen = await this.transactions.inNewTransaction(
      async (manager) => (await manager.count(ProcessedEventOrm, { where: { handlerId, eventId } })) > 0,
      { readOnly: true }
    );
    if (seen) this.logDuplicate(handlerId, eventId, 'ya procesado');
    return seen;
  }

  /**
   * Registra el mensaje como procesado, en su propia transacción. true si lo registró esta llamada;
   * false si otra entrega simultánea llegó primero — no es un error, es la carrera resuelta en la clave.
   */
  async record(handlerId: string, eventId: string): Promise<boolean> {
    try {
      await this.transactions.inNewTransaction((manager) => manager.insert(ProcessedEventOrm, { handlerId, eventId, processedAt: new Date() }));
      return true;
    } catch (error) {
      // Con MySQL la perdedora puede salir por interbloqueo en vez de por la clave duplicada: es la misma carrera.
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) {
        this.logDuplicate(handlerId, eventId, 'carrera resuelta en la clave');
        return false;
      }
      throw error;
    }
  }

  /**
   * Reclama el mensaje ANTES de procesarlo, de forma atómica: es la MISMA inserción que record, llamada
   * antes. true si es la primera vez y hay que procesar; false si es un duplicado.
   */
  tryRecord(handlerId: string, eventId: string): Promise<boolean> {
    return this.record(handlerId, eventId);
  }

  /** El descarte de una reentrega: lo primero que se busca cuando «el evento llegó y no pasó nada». */
  private logDuplicate(handlerId: string, eventId: string, reason: string): void {
    this.logger.log(\`Mensaje duplicado descartado por \${handlerId} (\${reason}): \${eventId}\`);
  }
}`
  );
}
