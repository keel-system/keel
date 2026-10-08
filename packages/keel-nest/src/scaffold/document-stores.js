// Los almacenes del generador sobre MongoDB (incremento 12c): el relay del outbox, la guarda de los
// mensajes procesados, el registro de idempotencia de petición, la tienda del reclamo de reconciliación, y
// los métodos de reclamo (de barrido y de reconciliación) del adaptador de cada raíz.
//
// Cada uno con la MISMA API que su gemelo relacional (mismo archivo, misma clase, mismos métodos): el
// relay, los listeners, los handlers y el gate no distinguen el almacén. Los documentos son los de
// keel-core/gen/document.js (`storeDocumentKey`, `storeDocumentFields`), los mismos que escribe keel-spring:
//   · outbox_event con el `_id` uuid y `claimed_at`: aquí no hay lock de fila, y el reclamo es una MARCA
//     caducable estampada con findOneAndUpdate —atómico por documento—, el equivalente del SKIP LOCKED;
//   · processed_event e idempotency_record con el `_id` SUBDOCUMENTO de su clave compuesta, en su orden: es
//     el `_id` el que arbitra la carrera, y MongoDB compara un subdocumento campo a campo y en orden;
//   · reconciliation_claim con la clave aplanada (`activation|entity_id`) y un upsert sobre la marca
//     caducada: si está viva, el upsert intenta insertar y choca con el `_id` —es de otra réplica—.
//
// Lo que se mantiene de la rama relacional porque cada punto costó un defecto: la publicación del relay
// fuera de toda transacción, el backoff y la rendición con el contador YA incrementado, el registro de
// procesados en su PROPIA transacción, y escribir los registros como INSERT —un reemplazo o un upsert
// sobre un `_id` presente pisaría en silencio el registro de la otra petición en vez de perder la carrera—.

import { screamingSnake, claimOrderField, claimsForEntity } from 'keel-core/gen';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { RECONCILIATION_CLAIM, reconciliationClaims } from 'keel-core/gen/reconciliation-stores';
import { documentShape, storeDocumentKey } from 'keel-core/gen/document';
import { snakeCase } from 'keel-core/gen/naming';
import { tsModule, tsString } from './render.js';
import { TRANSACTION_CONTEXT_TS, PERSISTENCE_ERRORS_TS } from './repositories.js';
import { BSON_VALUES_TS } from './document-persistence.js';

// Las rutas son las de la rama relacional: las importan el relay, los listeners y los handlers.
const OUTBOX_RELAY_STORE_TS = 'src/infrastructure/messaging/outbox/outbox-relay-store.ts';
const OUTBOX_BACKOFF_TS = 'src/infrastructure/messaging/outbox/outbox-backoff.ts';

/** La clave subdocumento de un almacén, como literal TypeScript con sus valores (en el orden de la clave). */
function keyLiteral(table, values) {
  const key = storeDocumentKey(table);
  return `{ ${key.columns.map((column, index) => `${column}: ${values[index]}`).join(', ')} }`;
}

// ─── El outbox ───────────────────────────────────────────────────────────────

/** La fila del outbox que escribe el puente, como documento (los campos de keel-core, en su orden). */
export function outboxDocumentLiteral({ id, destination, routingKey, eventType, payload, now }) {
  const values = {
    destination,
    routing_key: routingKey,
    event_type: eventType,
    payload,
    created_at: now,
    published_at: 'null',
    attempts: '0',
    next_attempt_at: 'null',
    claimed_at: 'null',
    last_error: 'null'
  };
  const missing = OUTBOX_EVENT.columns.filter((column) => !column.primary && !(column.name in values));
  if (missing.length > 0) throw new Error(`outbox_event: el puente no escribe ${missing.map((c) => c.name).join(', ')}`);
  return `{
      _id: ${id},
${OUTBOX_EVENT.columns
  .filter((column) => !column.primary)
  .map((column) => `      ${column.name}: ${values[column.name]}`)
  .join(',\n')}
    }`;
}

export function documentRelayStore() {
  return tsModule(
    OUTBOX_RELAY_STORE_TS,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'StoredDocument', from: BSON_VALUES_TS, type: true },
      { symbol: 'fromUuid', from: BSON_VALUES_TS },
      { symbol: 'toUuid', from: BSON_VALUES_TS },
      { symbol: 'outboxBackoffMs', from: OUTBOX_BACKOFF_TS },
      { symbol: 'outboxDeadLettered', from: OUTBOX_BACKOFF_TS }
    ],
    `/** Lo que el relay necesita de una fila reclamada para publicarla: una copia, no el documento. */
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
 * Las operaciones del relay sobre ${OUTBOX_EVENT.table}, separadas de la publicación al broker (I/O de red).
 *
 * En MongoDB no hay lock de fila: el reclamo es una MARCA (\`claimed_at\`) estampada con findOneAndUpdate, que
 * filtra y marca en la MISMA operación atómica sobre el documento —con varias réplicas, cada una se lleva un
 * lote disjunto—. La marca CADUCA (claim-timeout-ms): una réplica que muera entre el reclamo y el desenlace
 * no retiene la fila para siempre. Sin transacción ninguna: cada operación ya es atómica, y abrir una solo
 * serviría para mantenerla abierta durante la entrega al broker. Es lo que hace el servidor de keel-spring.
 */
@Injectable()
export class OutboxRelayStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  private get outbox(): Collection<StoredDocument> {
    return this.transactions.collection<StoredDocument>(${tsString(OUTBOX_EVENT.table)});
  }

  async claimBatch(maxAttempts: number, batchSize: number, claimTimeoutMs: number): Promise<ClaimedOutboxEvent[]> {
    const now = new Date();
    const claimCutoff = new Date(now.getTime() - claimTimeoutMs);
    const claimed: ClaimedOutboxEvent[] = [];
    for (let i = 0; i < batchSize; i++) {
      // Pendiente, sin agotar sus reintentos, con el backoff vencido y sin reclamo vivo; el más viejo primero
      // (sin orden, con más candidatos que el lote los más antiguos podrían no salir nunca).
      const row = await this.outbox.findOneAndUpdate(
        {
          published_at: null,
          attempts: { $lt: maxAttempts },
          $and: [
            { $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] },
            { $or: [{ claimed_at: null }, { claimed_at: { $lte: claimCutoff } }] }
          ]
        },
        { $set: { claimed_at: now } },
        { sort: { created_at: 1 }, returnDocument: 'after' }
      );
      if (row == null) break;
      claimed.push({ id: fromUuid(row._id as never), destination: row.destination, routingKey: row.routing_key, eventType: row.event_type, payload: row.payload });
    }
    return claimed;
  }

  async markPublished(id: string): Promise<void> {
    await this.outbox.updateOne({ _id: toUuid(id) }, { $set: { published_at: new Date(), claimed_at: null } });
  }

  /**
   * Incrementa el intento y decide rendición o backoff con el contador YA incrementado, en la MISMA
   * operación atómica: el relay nunca vuelve a preguntar cuántos intentos lleva.
   */
  async markFailed(id: string, error: string | null, maxAttempts: number, backoffInitialMs: number, backoffMaxMs: number): Promise<MarkFailedOutcome> {
    const row = await this.outbox.findOneAndUpdate(
      { _id: toUuid(id) },
      [
        {
          $set: {
            attempts: { $add: ['$attempts', 1] },
            // $literal: en una actualización por pipeline, un texto que empiece por $ se leería como un campo.
            last_error: { $literal: error },
            claimed_at: null
          }
        }
      ],
      { returnDocument: 'after' }
    );
    // El documento desapareció entre el reclamo y el desenlace: se da por agotado.
    if (row == null) return { attempts: maxAttempts, deadLettered: true };
    const attempts = Number(row.attempts);
    const deadLettered = outboxDeadLettered(attempts, maxAttempts);
    if (!deadLettered) {
      await this.outbox.updateOne({ _id: toUuid(id) }, { $set: { next_attempt_at: new Date(Date.now() + outboxBackoffMs(attempts, backoffInitialMs, backoffMaxMs)) } });
    }
    return { attempts, deadLettered };
  }

  /** Cuántos se rindieron: agotaron los reintentos y siguen sin publicar. */
  countDeadLettered(maxAttempts: number): Promise<number> {
    return this.outbox.countDocuments({ published_at: null, attempts: { $gte: maxAttempts } });
  }
}`
  );
}

// ─── La guarda de los mensajes procesados ────────────────────────────────────

export function documentGuard(guardPath) {
  const key = keyLiteral(PROCESSED_EVENT, ['handlerId', 'eventId']);
  return tsModule(
    guardPath,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Logger', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'KeyedDocument', from: BSON_VALUES_TS, type: true },
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
 * Con varias réplicas, dos entregas del mismo mensaje pueden procesarse a la vez: el árbitro es el \`_id\`
 * de ${PROCESSED_EVENT.table}, el subdocumento ${key.replace(/: \w+/g, '')} —en ese orden, que MongoDB
 * compara—. Por eso se INSERTA: un reemplazo o un upsert sobre un \`_id\` presente no chocaría nunca.
 */
@Injectable()
export class IdempotencyGuard {
  private readonly logger = new Logger('IdempotencyGuard');

  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  private get processed(): Collection<KeyedDocument<{ handler_id: string; event_id: string }>> {
    return this.transactions.collection(${tsString(PROCESSED_EVENT.table)});
  }

  /**
   * ¿Ya se procesó este mensaje? Sin efectos, para descartar la reentrega antes de despachar.
   * @param handlerId el consumidor (el nombre de la clase del listener)
   * @param eventId el id del mensaje (el messageId del diseño o metadata.eventId)
   */
  async alreadyProcessed(handlerId: string, eventId: string): Promise<boolean> {
    const seen = (await this.processed.countDocuments({ _id: ${key} }, { limit: 1 })) > 0;
    if (seen) this.logDuplicate(handlerId, eventId, 'ya procesado');
    return seen;
  }

  /**
   * Registra el mensaje como procesado, en su propia transacción. true si lo registró esta llamada;
   * false si otra entrega simultánea llegó primero — no es un error, es la carrera resuelta en el \`_id\`.
   */
  async record(handlerId: string, eventId: string): Promise<boolean> {
    try {
      await this.transactions.inNewTransaction((session) =>
        this.processed.insertOne({ _id: ${key}, processed_at: new Date() }, { session })
      );
      return true;
    } catch (error) {
      // Dentro de una transacción la perdedora puede salir por conflicto de escritura en vez de por la clave
      // duplicada: es la misma carrera.
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) {
        this.logDuplicate(handlerId, eventId, 'carrera resuelta en el _id');
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

// ─── El registro de idempotencia de petición ─────────────────────────────────

export function documentIdempotencyStore({ storeImplPath, storePath, conflictPath }) {
  const key = keyLiteral(IDEMPOTENCY_RECORD, ['scope', 'idempotencyKey']);
  return tsModule(
    storeImplPath,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'KeyedDocument', from: BSON_VALUES_TS, type: true },
      { symbol: 'IdempotencyStore', from: storePath },
      { symbol: 'StoredRequest', from: storePath, type: true },
      { symbol: 'IdempotencyConflictException', from: conflictPath },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'isIntegrityViolation', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS }
    ],
    `/**
 * Adaptador documental del registro de idempotencia. Usa la sesión de la transacción del caso de uso
 * (TransactionContext): el registro y el efecto del comando se confirman o revierten juntos, porque una
 * clave marcada sin recurso detrás haría que el reintento devolviese una respuesta que nunca existió.
 *
 * El documento es el de ${IDEMPOTENCY_RECORD.table} de keel-spring: el \`_id\` es el subdocumento
 * ${key.replace(/: [\w]+/g, '')}, y es él el que arbitra la carrera entre dos peticiones con la misma clave;
 * la que pierde sale como IdempotencyConflictException. Por eso se INSERTA: un reemplazo pisaría en silencio
 * el registro de la otra petición. Dentro de una transacción la perdedora puede salir por conflicto de
 * escritura en vez de por la clave duplicada: significa lo mismo y se traduce igual.
 */
@Injectable()
export class IdempotencyStoreImpl extends IdempotencyStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {
    super();
  }

  private get records(): Collection<KeyedDocument<{ operation_scope: string; idempotency_key: string }>> {
    return this.transactions.collection(${tsString(IDEMPOTENCY_RECORD.table)});
  }

  async find(scope: string, idempotencyKey: string): Promise<StoredRequest | null> {
    const found = await this.records.findOne({ _id: ${key} }, { session: this.transactions.session() });
    // Un registro caducado es como si no estuviera: la ventana la fija el diseño, no la purga.
    if (found == null || (found.expires_at as Date).getTime() <= Date.now()) return null;
    return { signature: found.signature, resourceId: found.resource_id ?? null };
  }

  async save(scope: string, idempotencyKey: string, signature: string, resourceId: string | null, ttlSeconds: number): Promise<void> {
    const session = this.transactions.session();
    const now = new Date();
    // Un registro CADUCADO es como si no estuviera —es lo que ya asume find—, y tiene que serlo aquí: si no,
    // la clave quedaría inutilizable entre su caducidad y la purga.
    await this.records.deleteOne({ _id: ${key}, expires_at: { $lte: now } }, { session });
    try {
      await this.records.insertOne(
        {
          _id: ${key},
          signature,
          resource_id: resourceId,
          created_at: now,
          expires_at: new Date(now.getTime() + ttlSeconds * 1000)
        },
        { session }
      );
    } catch (error) {
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) {
        throw new IdempotencyConflictException(scope, idempotencyKey);
      }
      throw error;
    }
  }
}`
  );
}

// ─── La tienda del reclamo de reconciliación ─────────────────────────────────

export function documentReconciliationStore(storePath) {
  const [activationColumn, entityColumn] = storeDocumentKey(RECONCILIATION_CLAIM).columns;
  return tsModule(
    storePath,
    [
      { symbol: 'Inject', from: '@nestjs/common' },
      { symbol: 'Injectable', from: '@nestjs/common' },
      { symbol: 'Collection', from: 'mongodb', type: true },
      { symbol: 'KeyedDocument', from: BSON_VALUES_TS, type: true },
      { symbol: 'TransactionContext', from: TRANSACTION_CONTEXT_TS },
      { symbol: 'isIntegrityViolation', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'isTransientWriteConflict', from: PERSISTENCE_ERRORS_TS },
      { symbol: 'toUuid', from: BSON_VALUES_TS }
    ],
    `/**
 * Quién se lleva cada candidato del barrido de reconciliación.
 *
 * Un solo upsert hace las dos mitades y es atómico por documento: el filtro pide la marca CADUCADA, así que
 * si la marca está viva no casa con nada y MongoDB intenta insertar —choca con el \`_id\` y la clave duplicada
 * dice que el candidato es de otra réplica—. Si no existía, la inserción es el reclamo. Sin transacción
 * ninguna, y sin la sesión del caso de uso: la marca tiene que existir para las demás réplicas ANTES de que
 * esta llame al proveedor. Es lo que hace el servidor de keel-spring sobre el mismo documento: el \`_id\` es la
 * clave aplanada \`<activación>|<entidad>\` y las dos columnas van además como campos.
 */
@Injectable()
export class ReconciliationClaimStore {
  constructor(@Inject(TransactionContext) private readonly transactions: TransactionContext) {}

  private get claims(): Collection<KeyedDocument<string>> {
    return this.transactions.collection(${tsString(RECONCILIATION_CLAIM.table)});
  }

  /**
   * @param activation    qué encargo se reclama (una entidad puede esperar varios)
   * @param entityId      cuál de ellos
   * @param now           la marca que se estampa
   * @param expiredBefore por debajo de este instante, un reclamo ajeno ya caducó
   * @returns true si el candidato es de esta réplica
   */
  async claim(activation: string, entityId: string, now: Date, expiredBefore: Date): Promise<boolean> {
    const key = \`\${activation}${storeDocumentKey(RECONCILIATION_CLAIM).separator}\${entityId.toLowerCase()}\`;
    try {
      await this.claims.updateOne(
        { _id: key, claimed_at: { $lte: expiredBefore } },
        { $set: { claimed_at: now }, $setOnInsert: { ${activationColumn}: activation, ${entityColumn}: toUuid(entityId) } },
        { upsert: true }
      );
      return true;
    } catch (error) {
      // La marca sigue viva y es de otra réplica. Ceder de más es benigno —la pasada siguiente lo recoge—.
      if (isIntegrityViolation(error) || isTransientWriteConflict(error)) return false;
      throw error;
    }
  }
}`
  );
}

// ─── Los reclamos del adaptador de una raíz ──────────────────────────────────

/** El valor GUARDADO de un estado del ciclo de vida: la constante del enum, no el literal del diseño. */
function storedState(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/** La clave del documento de un campo del dominio de la raíz. */
function keyOf(model, entity, member) {
  return documentShape(model, entity).find((entry) => entry.member === member)?.name ?? snakeCase(member);
}

/**
 * Los métodos de reclamo de barrido del adaptador documental. Sin SKIP LOCKED y sin necesidad:
 * findOneAndUpdate filtra y marca en la MISMA operación atómica sobre el documento, así que dos réplicas no
 * pueden llevarse el mismo; se repite hasta llenar el lote o quedarse sin candidatos. El orden va SIEMPRE: sin
 * él, con más candidatos que el lote, los más antiguos podrían no reclamarse nunca. Es lo que hace keel-spring.
 */
export function documentSweepClaimMethods(model, entity) {
  const claims = claimsForEntity(model, entity.name);
  return claims.map((claim) => {
    const field = keyOf(model, entity, entity.lifecycle.field);
    const states = claim.from.map((state) => JSON.stringify(storedState(model, entity, state))).join(', ');
    const order = keyOf(model, entity, claimOrderField(entity, claim));
    const setup = [];
    const filter = [`${tsString(field)}: { $in: [${states}] }`];
    if (claim.stalled) {
      const seconds = claim.stalled.parameter
        ? `this.parameters.${claim.stalled.parameter.name} * ${claim.stalled.parameter.unitSeconds}`
        : `this.sweeps.stalledAfterSeconds[${tsString(claim.stalled.configKey)}]!`;
      setup.push('    // La cota del rescate: solo lo que lleva atascado más que el plazo, dentro del MISMO findOneAndUpdate.', `    const staleBefore = new Date(Date.now() - (${seconds}) * 1000);`);
      filter.push(`${tsString(keyOf(model, entity, claim.stalled.stampField))}: { $lt: staleBefore }`);
    }
    if (claim.due) {
      setup.push(`    // Solo lo que ya venció (${claim.due.field} <= ahora).`, '    const now = new Date();');
      filter.push(`${tsString(keyOf(model, entity, claim.due.field))}: { $lte: now }`);
    }
    if (claim.stamps || claim.stalled) setup.push('    // El instante con el que se estampa (o se arrienda) DENTRO del reclamo: uno por tanda.', '    const claimedAt = new Date();');
    const set = claim.stalled
      ? `{ ${tsString(keyOf(model, entity, claim.stalled.stampField))}: claimedAt }`
      : `{ ${tsString(field)}: ${JSON.stringify(storedState(model, entity, claim.to))}${claim.stamps ? `, ${tsString(keyOf(model, entity, claim.stamps.field))}: claimedAt` : ''} }`;
    return `  /** El reclamo del puerto (${claim.stalled ? 'rescate' : 'cola'}): ver ${entity.name}Repository.${claim.method}. */
  async ${claim.method}(): Promise<${entity.name}[]> {
${setup.join('\n')}${setup.length > 0 ? '\n' : ''}    const claimed: ${entity.name}[] = [];
    for (let i = 0; i < this.sweeps.batchSize[${tsString(claim.sweepKey)}]!; i++) {
      // ${claim.stalled ? `Renueva el reloj SOLO si sigue atascado en ${claim.stalled.state}: el rescate ARRIENDA, no mueve de estado` : `Pasa a ${claim.to} SOLO si sigue en su estado de partida`}; null = no
      // quedan candidatos (o los demás se los llevó otra réplica). Sin sesión: el reclamo confirma al volver.
      const document = await this.collection.findOneAndUpdate(
        { ${filter.join(', ')} },
        { $set: ${set} },
        { sort: { ${tsString(order)}: 1 }, returnDocument: 'after' }
      );
      if (document == null) break;
      claimed.push(toDomain${entity.name}(document));
    }
    return claimed;
  }`;
  });
}

/**
 * Los métodos de reclamo de reconciliación del adaptador documental: los candidatos, el que más lleva
 * primero, y la marca de cada uno en la tienda (ReconciliationClaimStore). El estado de la raíz NO se toca.
 */
export function documentReconciliationMethods(model, entity) {
  const claims = reconciliationClaims(model).filter((claim) => claim.entity === entity.name);
  return claims.map((claim) => {
    const field = keyOf(model, entity, entity.lifecycle.field);
    const awaiting = keyOf(model, entity, claim.awaitingField);
    const states = claim.states.map((state) => JSON.stringify(storedState(model, entity, state))).join(', ');
    return `  /** El reclamo del puerto (reconciliación): ver ${entity.name}Repository.${claim.method}. */
  async ${claim.method}(): Promise<${entity.name}[]> {
    const window = this.reconciliation[${tsString(claim.activation)}]!;
    // Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - window.unansweredAfterSeconds * 1000);
    const claimExpiredBefore = new Date(now.getTime() - window.claimTimeoutMs);
    const candidates = await this.collection
      .find({ ${tsString(field)}: { $in: [${states}] }, ${tsString(awaiting)}: { $lt: staleBefore } })
      .sort({ ${tsString(awaiting)}: 1 })
      .limit(window.batchSize)
      .toArray();
    const claimed: ${entity.name}[] = [];
    for (const document of candidates) {
      const candidate = toDomain${entity.name}(document);
      // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
      if (await this.reconciliationClaims.claim(${tsString(claim.activation)}, String(candidate.id), now, claimExpiredBefore)) claimed.push(candidate);
    }
    return claimed;
  }`;
  });
}

// ─── Las purgas ──────────────────────────────────────────────────────────────

/** La condición propia de cada purga, como filtro de MongoDB: lo pendiente del outbox no se toca nunca. */
export const DOCUMENT_PURGE_PREDICATES = {
  outbox_event: '{ published_at: { $ne: null } }'
};

/** El método privado `purge` de table-purges.ts sobre MongoDB: la frontera y el borrado por lotes. */
export function documentPurgeMethod() {
  return `  private purge(
    what: string,
    collection: string,
    field: string,
    predicate: Document | null,
    cutoff: Date,
    batch: { readonly batchSize: number; readonly maxBatches: number }
  ): Promise<number> {
    const documents = this.transactions.collection(collection);
    // La frontera y el borrado llevan la MISMA condición: la frontera tiene que contar lo que el borrado se
    // lleva, o el lote deja de medir lo que dice.
    const before = (bound: Document) => ({ ...(predicate ?? {}), [field]: bound });
    return batchedPurge({
      what,
      batchSize: batch.batchSize,
      maxBatches: batch.maxBatches,
      cutoff,
      boundary: async (position) => {
        const [edge] = await documents
          .find(before({ $lt: cutoff }), { projection: { [field]: 1 } })
          .sort({ [field]: 1 })
          .skip(position)
          .limit(1)
          .toArray();
        return edge?.[field] == null ? null : new Date(edge[field]);
      },
      // Cada lote en su propia operación (un deleteMany ya es atómico por documento y no abre transacción).
      deleteUpTo: async (upTo) => (await documents.deleteMany(before({ $lt: cutoff, $lte: upTo }))).deletedCount,
      warn: (message) => this.logger.warn(message)
    });
  }`;
}

