// Los almacenes del generador sobre MongoDB (incremento 12c): el relay del outbox y la fila que escribe el puente, la
// guarda de los mensajes procesados, el registro de idempotencia de petición, la tienda del reclamo de reconciliación,
// los métodos de reclamo (de barrido y de reconciliación) del adaptador de cada raíz y las purgas.
//
// Cada uno con la MISMA API que su gemelo relacional (mismo archivo, misma clase, mismos métodos): el relay, los
// listeners, los handlers, el reloj y el gate no distinguen el almacén. Los documentos son los de keel-core/gen/document.js
// (`storeDocumentKey`, `storeDocumentFields`), los mismos que escriben keel-spring y keel-nest:
//   · outbox_event con el `_id` uuid y `claimed_at`: aquí no hay lock de fila, y el reclamo es una MARCA caducable
//     estampada con FindOneAndUpdate —atómico por documento—, el equivalente del SKIP LOCKED;
//   · processed_event e idempotency_record con el `_id` SUBDOCUMENTO de su clave compuesta, en su orden: es el `_id` el que
//     arbitra la carrera, y MongoDB compara un subdocumento campo a campo y en orden;
//   · reconciliation_claim con la clave aplanada (`activación|entity_id`) y un upsert sobre la marca caducada: si está
//     viva, el upsert intenta insertar y choca con el `_id` —es de otra réplica—.
//
// Lo que se mantiene de la rama relacional porque cada punto costó un defecto: la publicación del relay fuera de toda
// transacción, el backoff y la rendición con el contador YA incrementado, el registro de procesados independiente de la
// transacción del caso de uso, y escribir los registros como INSERT —un reemplazo o un upsert sobre un `_id` presente
// pisaría en silencio el registro de la otra petición en vez de perder la carrera—.

import { claimOrderField, claimsForEntity, screamingSnake } from 'keel-core/gen';
import { OUTBOX_EVENT, PROCESSED_EVENT } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { RECONCILIATION_CLAIM, reconciliationClaims } from 'keel-core/gen/reconciliation-stores';
import { documentShape, storeDocumentKey, storeDocumentFields } from 'keel-core/gen/document';
import { snakeCase } from 'keel-core/gen/naming';
import { csMember, csString } from './render.js';

/** El valor GUARDADO de un estado del ciclo de vida: la constante del enum, no el literal del diseño. */
function csEnumConstant(model, entity, state) {
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === entity.lifecycle.enumType);
  return enumDef?.values.find((value) => value.literal === state)?.constant ?? screamingSnake(state);
}

/** La clave del documento de un campo del dominio de la raíz. */
function keyOf(model, entity, member) {
  return documentShape(model, entity).find((entry) => entry.member === member)?.name ?? snakeCase(member);
}

/** El `_id` subdocumento de un almacén, como BsonDocument C# con sus valores (en el orden de la clave). */
function keyLiteral(table, values) {
  const key = storeDocumentKey(table);
  return `new BsonDocument { ${key.columns.map((column, index) => `{ ${csString(column)}, ${values[index]} }`).join(', ')} }`;
}

// ─── El outbox ───────────────────────────────────────────────────────────────────────────────────

/**
 * La fila del outbox que escribe el puente, como documento: los campos de keel-core, en su orden. Un campo que keel-core
 * añada y aquí no se escriba rompe el build, no el relay de producción.
 */
export function outboxDocumentLiteral() {
  const values = {
    destination: 'BsonValues.Of(settings.Destination)',
    routing_key: 'BsonValues.Of(routingKey)',
    event_type: 'BsonValues.Of(eventType)',
    payload: 'BsonValues.Of(payload)',
    created_at: 'BsonValues.Of(DateTimeOffset.UtcNow)',
    published_at: 'BsonNull.Value',
    attempts: 'new BsonInt32(0)',
    next_attempt_at: 'BsonNull.Value',
    claimed_at: 'BsonNull.Value',
    last_error: 'BsonNull.Value'
  };
  const fields = storeDocumentFields(OUTBOX_EVENT);
  const missing = fields.filter((field) => !(field.name in values));
  if (missing.length > 0) throw new Error(`outbox_event: el puente no escribe ${missing.map((field) => field.name).join(', ')}`);
  return `new BsonDocument
        {
            { "_id", BsonValues.Of(Guid.CreateVersion7()) },
${fields.map((field) => `            { ${csString(field.name)}, ${values[field.name]} },`).join('\n')}
        }`;
}

export function documentRelayStoreBody() {
  const outbox = csString(OUTBOX_EVENT.table);
  return `/// <summary>Lo que el relay necesita de una fila reclamada para publicarla: una copia, no el documento.</summary>
public sealed record ClaimedOutboxEvent(Guid Id, string Destination, string RoutingKey, string EventType, string Payload);

/// <summary>El desenlace de un fallo: cuántos intentos lleva la fila y si se rindió.</summary>
public sealed record MarkFailedOutcome(int Attempts, bool DeadLettered);

/// <summary>
/// Las operaciones del relay sobre ${OUTBOX_EVENT.table}, separadas de la publicación al broker (E/S de red).
/// </summary>
/// <remarks>
/// En MongoDB no hay lock de fila: el reclamo es una MARCA (<c>claimed_at</c>) estampada con FindOneAndUpdate, que filtra y
/// marca en la MISMA operación atómica sobre el documento —con varias réplicas, cada una se lleva un lote disjunto—. La
/// marca CADUCA (claim-timeout-ms): una réplica que muera entre el reclamo y el desenlace no retiene la fila para siempre.
/// Sin transacción ninguna: cada operación ya es atómica, y abrir una solo serviría para mantenerla abierta durante la
/// entrega al broker. Es lo que hacen los servidores de keel-spring y keel-nest.
/// </remarks>
public sealed class OutboxRelayStore(DocumentDatabase database)
{
    private IMongoCollection<BsonDocument> Outbox => database.Collection(${outbox});

    public async Task<IReadOnlyList<ClaimedOutboxEvent>> ClaimBatch(int maxAttempts, int batchSize, int claimTimeoutMs, CancellationToken cancellationToken = default)
    {
        var now = BsonValues.Of(DateTimeOffset.UtcNow);
        var claimCutoff = BsonValues.Of(DateTimeOffset.UtcNow.AddMilliseconds(-claimTimeoutMs));
        var claimed = new List<ClaimedOutboxEvent>();
        for (var i = 0; i < batchSize; i++)
        {
            // Pendiente, sin agotar sus reintentos, con el backoff vencido y sin reclamo vivo; el más viejo primero (sin
            // orden, con más candidatos que el lote los más antiguos podrían no salir nunca).
            var filter = new BsonDocument
            {
                { "published_at", BsonNull.Value },
                { "attempts", new BsonDocument("$lt", maxAttempts) },
                {
                    "$and",
                    new BsonArray
                    {
                        new BsonDocument("$or", new BsonArray { new BsonDocument("next_attempt_at", BsonNull.Value), new BsonDocument("next_attempt_at", new BsonDocument("$lte", now)) }),
                        new BsonDocument("$or", new BsonArray { new BsonDocument("claimed_at", BsonNull.Value), new BsonDocument("claimed_at", new BsonDocument("$lte", claimCutoff)) })
                    }
                }
            };
            var row = await Outbox.FindOneAndUpdateAsync<BsonDocument>(
                filter,
                new BsonDocument("$set", new BsonDocument("claimed_at", now)),
                new FindOneAndUpdateOptions<BsonDocument> { Sort = new BsonDocument("created_at", 1), ReturnDocument = ReturnDocument.After },
                cancellationToken);
            if (row is null)
            {
                break;
            }
            claimed.Add(new ClaimedOutboxEvent(
                BsonValues.Uuid(row["_id"], "outbox_event._id"),
                BsonValues.Text(BsonValues.Field(row, "destination"), "outbox_event.destination"),
                BsonValues.Text(BsonValues.Field(row, "routing_key"), "outbox_event.routing_key"),
                BsonValues.Text(BsonValues.Field(row, "event_type"), "outbox_event.event_type"),
                BsonValues.Text(BsonValues.Field(row, "payload"), "outbox_event.payload")));
        }
        return claimed;
    }

    public Task MarkPublished(Guid id, CancellationToken cancellationToken = default) =>
        Outbox.UpdateOneAsync(
            new BsonDocument("_id", BsonValues.Of(id)),
            new BsonDocument("$set", new BsonDocument { { "published_at", BsonValues.Of(DateTimeOffset.UtcNow) }, { "claimed_at", BsonNull.Value } }),
            cancellationToken: cancellationToken);

    /// <summary>
    /// Incrementa el intento y decide rendición o backoff con el contador YA incrementado, en la MISMA operación atómica: el
    /// relay nunca vuelve a preguntar cuántos intentos lleva.
    /// </summary>
    public async Task<MarkFailedOutcome> MarkFailed(Guid id, string? error, int maxAttempts, int backoffInitialMs, int backoffMaxMs, CancellationToken cancellationToken = default)
    {
        var row = await Outbox.FindOneAndUpdateAsync<BsonDocument>(
            new BsonDocument("_id", BsonValues.Of(id)),
            new BsonDocument
            {
                { "$inc", new BsonDocument("attempts", 1) },
                // Con $set el texto va como valor: uno que empiece por $ no se lee como un campo.
                { "$set", new BsonDocument { { "last_error", BsonValues.Of(error) }, { "claimed_at", BsonNull.Value } } }
            },
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
        // El documento desapareció entre el reclamo y el desenlace: se da por agotado.
        if (row is null)
        {
            return new MarkFailedOutcome(maxAttempts, true);
        }
        var attempts = BsonValues.Int32(BsonValues.Field(row, "attempts"), "outbox_event.attempts");
        var deadLettered = OutboxBackoff.DeadLettered(attempts, maxAttempts);
        if (!deadLettered)
        {
            var next = DateTimeOffset.UtcNow.AddMilliseconds(OutboxBackoff.BackoffMs(attempts, backoffInitialMs, backoffMaxMs));
            await Outbox.UpdateOneAsync(
                new BsonDocument("_id", BsonValues.Of(id)),
                new BsonDocument("$set", new BsonDocument("next_attempt_at", BsonValues.Of(next))),
                cancellationToken: cancellationToken);
        }
        return new MarkFailedOutcome(attempts, deadLettered);
    }

    /// <summary>
    /// Cuántas filas se rindieron: agotaron los reintentos y siguen sin publicar. Es el dato de la única promesa del outbox
    /// —que ningún evento se pierde— justo cuando deja de cumplirse.
    /// </summary>
    public async Task<int> CountDeadLettered(int maxAttempts, CancellationToken cancellationToken = default) =>
        (int)await Outbox.CountDocumentsAsync(
            new BsonDocument { { "published_at", BsonNull.Value }, { "attempts", new BsonDocument("$gte", maxAttempts) } },
            cancellationToken: cancellationToken);
}`;
}

// ─── La guarda de los mensajes procesados ────────────────────────────────────────────────────────

export function documentGuardBody() {
  const key = keyLiteral(PROCESSED_EVENT, ['BsonValues.Of(handlerId)', 'BsonValues.Of(eventId)']);
  const [handlerColumn, eventColumn] = storeDocumentKey(PROCESSED_EVENT).columns;
  return `/// <summary>
/// Guarda de idempotencia del consumidor. La entrega de cualquier broker es at-least-once y el relay del outbox
/// reintenta: la reentrega no es un caso raro, es lo normal ante cualquier corte.
/// </summary>
/// <remarks>
/// <para>
/// Hay DOS órdenes y no son intercambiables. El registro es independiente de la transacción del caso de uso (sobrevive al
/// fallo del handler), y por eso el orden importa:
///   1. procesar y luego registrar (AlreadyProcessed antes, Record después de que el handler termine bien). Es el
///      predeterminado: un fallo transitorio deja el mensaje sin marcar y la reentrega lo reintenta. Si el proceso muere
///      entre el commit del negocio y el registro, la reentrega se procesa dos veces: por eso este orden pide una guarda
///      de dominio detrás;
///   2. registrar y luego procesar (TryRecord, atómico). Cierra la ventana del duplicado, pero convierte un fallo
///      transitorio en un mensaje PERDIDO. Solo si reprocesar es inaceptable y perder tolerable.
/// Cuál toca lo dice el mensaje de cada suscripción.
/// </para>
/// <para>
/// Con varias réplicas, dos entregas del mismo mensaje pueden procesarse a la vez: el árbitro es el <c>_id</c> de
/// ${PROCESSED_EVENT.table}, el subdocumento { ${handlerColumn}, ${eventColumn} } —en ese orden, que MongoDB compara—. Por eso
/// se INSERTA: un reemplazo o un upsert sobre un <c>_id</c> presente no chocaría nunca. Una inserción suelta ya es atómica:
/// no necesita transacción, y no va en la del caso de uso.
/// </para>
/// </remarks>
public sealed partial class IdempotencyGuard(DocumentDatabase database, ILogger<IdempotencyGuard> logger)
{
    private IMongoCollection<BsonDocument> Processed => database.Collection(${csString(PROCESSED_EVENT.table)});

    /// <summary>¿Ya se procesó este mensaje? Sin efectos, para descartar la reentrega antes de despachar.</summary>
    /// <param name="handlerId">El consumidor (el nombre de la clase del listener).</param>
    /// <param name="eventId">El id del mensaje (el messageId del diseño o Metadata.EventId).</param>
    public async Task<bool> AlreadyProcessed(string handlerId, string eventId, CancellationToken cancellationToken = default)
    {
        var seen = await Processed.CountDocumentsAsync(new BsonDocument("_id", ${key}), new CountOptions { Limit = 1 }, cancellationToken) > 0;
        if (seen)
        {
            LogDuplicate(handlerId, eventId, "ya procesado");
        }
        return seen;
    }

    /// <summary>
    /// Registra el mensaje como procesado. true si lo registró esta llamada; false si otra entrega simultánea llegó primero —
    /// no es un error, es la carrera resuelta en el _id.
    /// </summary>
    public async Task<bool> Record(string handlerId, string eventId, CancellationToken cancellationToken = default)
    {
        try
        {
            await Processed.InsertOneAsync(
                new BsonDocument { { "_id", ${key} }, { "processed_at", BsonValues.Of(DateTimeOffset.UtcNow) } },
                cancellationToken: cancellationToken);
            return true;
        }
        catch (MongoException error) when (PersistenceErrors.DuplicateKeyMessage(error) is not null)
        {
            LogDuplicate(handlerId, eventId, "carrera resuelta en el _id");
            return false;
        }
    }

    /// <summary>
    /// Reclama el mensaje ANTES de procesarlo, de forma atómica: es la MISMA inserción que Record, llamada antes. true si
    /// es la primera vez y hay que procesar; false si es un duplicado.
    /// </summary>
    public Task<bool> TryRecord(string handlerId, string eventId, CancellationToken cancellationToken = default) =>
        Record(handlerId, eventId, cancellationToken);

    /// <summary>El descarte de una reentrega: lo primero que se busca cuando «el evento llegó y no pasó nada».</summary>
    [LoggerMessage(Level = LogLevel.Information, Message = "Mensaje duplicado descartado por {HandlerId} ({Reason}): {EventId}")]
    private partial void LogDuplicate(string handlerId, string eventId, string reason);
}`;
}

// ─── El registro de idempotencia de petición ─────────────────────────────────────────────────────

export function documentIdempotencyStoreBody({ adapter, port }) {
  const key = keyLiteral(IDEMPOTENCY_RECORD, ['BsonValues.Of(scope)', 'BsonValues.Of(idempotencyKey)']);
  const columns = storeDocumentKey(IDEMPOTENCY_RECORD).columns;
  return `/// <summary>
/// Adaptador documental del registro de idempotencia. Usa la sesión de la transacción del caso de uso: el registro y el
/// efecto del comando se confirman o revierten juntos, porque una clave marcada sin recurso detrás haría que el reintento
/// devolviese una respuesta que nunca existió.
/// </summary>
/// <remarks>
/// El documento es el de ${IDEMPOTENCY_RECORD.table} de keel-spring y keel-nest: el <c>_id</c> es el subdocumento
/// { ${columns.join(', ')} }, y es él el que arbitra la carrera entre dos peticiones con la misma clave; la que pierde sale
/// como <see cref="IdempotencyConflictException"/>. Por eso se INSERTA: un reemplazo pisaría en silencio el registro de la
/// otra petición. Dentro de una transacción la perdedora puede salir por conflicto de escritura en vez de por la clave
/// duplicada: significa lo mismo y se traduce igual.
/// </remarks>
public sealed class ${adapter}(PersistenceTransactions transactions) : ${port}
{
    private IMongoCollection<BsonDocument> Records => transactions.Collection(${csString(IDEMPOTENCY_RECORD.table)});

    public async Task<StoredRequest?> Find(string scope, string idempotencyKey, CancellationToken cancellationToken = default)
    {
        var filter = new BsonDocument("_id", ${key});
        var found = await (transactions.Session is { } session ? Records.Find(session, filter) : Records.Find(filter)).FirstOrDefaultAsync(cancellationToken);
        // Un registro caducado es como si no estuviera: la ventana la fija el diseño, no la purga.
        if (found is null || BsonValues.Instant(BsonValues.Field(found, "expires_at"), "${IDEMPOTENCY_RECORD.table}.expires_at") <= DateTimeOffset.UtcNow)
        {
            return null;
        }
        return new StoredRequest(
            BsonValues.Text(BsonValues.Field(found, "signature"), "${IDEMPOTENCY_RECORD.table}.signature"),
            BsonValues.TextOrNull(BsonValues.Field(found, "resource_id"), "${IDEMPOTENCY_RECORD.table}.resource_id"));
    }

    public async Task Save(string scope, string idempotencyKey, string signature, string? resourceId, int ttlSeconds, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                var session = transactions.Session!;
                var now = DateTimeOffset.UtcNow;
                // Un registro CADUCADO es como si no estuviera —es lo que ya asume Find—, y tiene que serlo aquí: si no, la
                // clave quedaría inutilizable entre su caducidad y la purga.
                await Records.DeleteOneAsync(
                    session,
                    new BsonDocument { { "_id", ${key} }, { "expires_at", new BsonDocument("$lte", BsonValues.Of(now)) } },
                    cancellationToken: cancellationToken);
                try
                {
                    await Records.InsertOneAsync(
                        session,
                        new BsonDocument
                        {
                            { "_id", ${key} },
                            { "signature", BsonValues.Of(signature) },
                            { "resource_id", BsonValues.Of(resourceId) },
                            { "created_at", BsonValues.Of(now) },
                            { "expires_at", BsonValues.Of(now.AddSeconds(ttlSeconds)) }
                        },
                        cancellationToken: cancellationToken);
                }
                catch (MongoException error) when (PersistenceErrors.DuplicateKeyMessage(error) is not null || PersistenceErrors.IsTransientWriteConflict(error))
                {
                    throw new IdempotencyConflictException(scope, idempotencyKey);
                }
                return true;
            },
            readOnly: false,
            cancellationToken);
    }
}`;
}

// ─── La tienda del reclamo de reconciliación ─────────────────────────────────────────────────────

export function documentReconciliationStoreBody() {
  const key = storeDocumentKey(RECONCILIATION_CLAIM);
  const [activationColumn, entityColumn] = key.columns;
  return `/// <summary>
/// Quién se lleva cada candidato del barrido de reconciliación: la regla de keel-core (reconciliationClaimReference), la
/// misma que en keel-spring y keel-nest. Sin marca, la inserción es el reclamo; con marca, solo si CADUCÓ (claimed_at
/// &lt;= la caducidad).
/// </summary>
/// <remarks>
/// Un solo upsert hace las dos mitades y es atómico por documento: el filtro pide la marca CADUCADA, así que si la marca
/// está viva no casa con nada y MongoDB intenta insertar —choca con el <c>_id</c> y la clave duplicada dice que el
/// candidato es de otra réplica—. Sin transacción ninguna, y sin la sesión del caso de uso: la marca tiene que existir para
/// las demás réplicas ANTES de que esta llame al proveedor. El <c>_id</c> es la clave aplanada
/// <c>&lt;activación&gt;${key.separator}&lt;entidad&gt;</c> y las dos columnas van además como campos, como en keel-spring.
/// </remarks>
public sealed class ReconciliationClaimStore(DocumentDatabase database)
{
    private IMongoCollection<BsonDocument> Claims => database.Collection(${csString(RECONCILIATION_CLAIM.table)});

    /// <summary>
    /// Las entidades de <paramref name="activation"/> con una marca VIVA (posterior a <paramref name="expiredBefore"/>): lo
    /// que la lectura de candidatos excluye, para que la cabeza de la cola —reclamada y aún sin resolver— no ocupe el lote
    /// de cada pasada hasta caducar.
    /// </summary>
    public async Task<IReadOnlyList<BsonValue>> Held(string activation, DateTimeOffset expiredBefore, CancellationToken cancellationToken = default)
    {
        var live = await Claims
            .Find(new BsonDocument { { ${csString(activationColumn)}, activation }, { "claimed_at", new BsonDocument("$gt", BsonValues.Of(expiredBefore)) } })
            .Project(new BsonDocument(${csString(entityColumn)}, 1))
            .ToListAsync(cancellationToken);
        return [.. live.Select(mark => mark.GetValue(${csString(entityColumn)}, BsonNull.Value))];
    }

    /// <param name="activation">qué encargo se reclama (una entidad puede esperar varios)</param>
    /// <param name="entityId">cuál de ellos</param>
    /// <param name="now">la marca que se estampa</param>
    /// <param name="expiredBefore">por debajo de este instante, un reclamo ajeno ya caducó</param>
    /// <returns>true si el candidato es de esta réplica</returns>
    public async Task<bool> Claim(string activation, Guid entityId, DateTimeOffset now, DateTimeOffset expiredBefore, CancellationToken cancellationToken = default)
    {
        var key = activation + ${csString(key.separator)} + entityId.ToString().ToLowerInvariant();
        try
        {
            await Claims.UpdateOneAsync(
                new BsonDocument { { "_id", key }, { "claimed_at", new BsonDocument("$lte", BsonValues.Of(expiredBefore)) } },
                new BsonDocument
                {
                    { "$set", new BsonDocument("claimed_at", BsonValues.Of(now)) },
                    { "$setOnInsert", new BsonDocument { { ${csString(activationColumn)}, activation }, { ${csString(entityColumn)}, BsonValues.Of(entityId) } } }
                },
                new UpdateOptions { IsUpsert = true },
                cancellationToken);
            return true;
        }
        catch (MongoException error) when (PersistenceErrors.DuplicateKeyMessage(error) is not null)
        {
            // La marca sigue viva y es de otra réplica. Ceder de más es benigno: la pasada siguiente lo recoge.
            return false;
        }
    }
}`;
}

// ─── Los reclamos del adaptador de una raíz ──────────────────────────────────────────────────────

/**
 * Los métodos de reclamo de barrido del adaptador documental. Sin SKIP LOCKED y sin necesidad: FindOneAndUpdate filtra y
 * marca en la MISMA operación atómica sobre el documento, así que dos réplicas no pueden llevarse el mismo; se repite
 * hasta llenar el lote o quedarse sin candidatos. El orden va SIEMPRE: sin él, con más candidatos que el lote, los más
 * antiguos podrían no reclamarse nunca. Es lo que hacen keel-spring y keel-nest.
 */
export function documentSweepClaimMethods(model, entity) {
  return claimsForEntity(model, entity.name).map((claim) => {
    const field = keyOf(model, entity, entity.lifecycle.field);
    const states = claim.from.map((state) => csString(csEnumConstant(model, entity, state))).join(', ');
    const order = keyOf(model, entity, claimOrderField(entity, claim));
    const setup = [`        var batch = sweeps.BatchSize[${csString(claim.sweepKey)}];`];
    const filter = [`{ ${csString(field)}, new BsonDocument("$in", new BsonArray { ${states} }) }`];
    if (claim.stalled) {
      const seconds = claim.stalled.parameter
        ? `parameters.${csMember(claim.stalled.parameter.name)} * ${claim.stalled.parameter.unitSeconds}`
        : `sweeps.StalledAfterSeconds[${csString(claim.stalled.configKey)}]`;
      setup.push('        // La cota del rescate: solo lo que lleva atascado más que el plazo, dentro del MISMO FindOneAndUpdate.', `        var staleBefore = BsonValues.Of(DateTimeOffset.UtcNow.AddSeconds(-(${seconds})));`);
      filter.push(`{ ${csString(keyOf(model, entity, claim.stalled.stampField))}, new BsonDocument("$lt", staleBefore) }`);
    }
    if (claim.due) {
      setup.push(`        // Solo lo que ya venció (${claim.due.field} <= ahora).`, '        var now = BsonValues.Of(DateTimeOffset.UtcNow);');
      filter.push(`{ ${csString(keyOf(model, entity, claim.due.field))}, new BsonDocument("$lte", now) }`);
    }
    if (claim.stamps || claim.stalled) setup.push('        // El instante con el que se estampa (o se arrienda) DENTRO del reclamo: uno por tanda.', '        var claimedAt = BsonValues.Of(DateTimeOffset.UtcNow);');
    const set = claim.stalled
      ? `new BsonDocument(${csString(keyOf(model, entity, claim.stalled.stampField))}, claimedAt)`
      : `new BsonDocument { { ${csString(field)}, ${csString(csEnumConstant(model, entity, claim.to))} }${claim.stamps ? `, { ${csString(keyOf(model, entity, claim.stamps.field))}, claimedAt }` : ''} }`;
    const what = claim.stalled
      ? `Renueva el reloj SOLO si sigue atascado en ${claim.stalled.state}: el rescate ARRIENDA, no mueve de estado`
      : `Pasa a ${claim.to} SOLO si sigue en su estado de partida`;
    return `    /// <summary>El reclamo del puerto (${claim.stalled ? 'rescate' : 'cola'}): ver I${entity.name}Repository.${csMember(claim.method)}.</summary>
    public async Task<IReadOnlyList<${entity.name}>> ${csMember(claim.method)}(CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(csMember(claim.method))});
${setup.join('\n')}
        var claimed = new List<${entity.name}>();
        for (var i = 0; i < batch; i++)
        {
            // ${what}; null = no quedan candidatos (o los demás se los llevó otra réplica). Sin sesión: el reclamo confirma
            // al volver, antes de que el handler actúe.
            var document = await Collection.FindOneAndUpdateAsync<BsonDocument>(
                new BsonDocument { ${filter.join(', ')} },
                new BsonDocument("$set", ${set}),
                new FindOneAndUpdateOptions<BsonDocument> { Sort = new BsonDocument(${csString(order)}, 1), ReturnDocument = ReturnDocument.After },
                cancellationToken);
            if (document is null)
            {
                break;
            }
            claimed.Add(ToDomain${entity.name}(document));
        }
        return claimed;
    }`;
  });
}

/**
 * Los métodos de reclamo de reconciliación del adaptador documental: los candidatos, el que más lleva primero, y la marca
 * de cada uno en la tienda (ReconciliationClaimStore). El estado de la raíz NO se toca.
 */
export function documentReconciliationMethods(model, entity) {
  return reconciliationClaims(model)
    .filter((claim) => claim.entity === entity.name)
    .map((claim) => {
      const field = keyOf(model, entity, entity.lifecycle.field);
      const awaiting = keyOf(model, entity, claim.awaitingField);
      const states = claim.states.map((state) => csString(csEnumConstant(model, entity, state))).join(', ');
      const idProp = csMember(entity.idField?.name ?? 'id');
      return `    /// <summary>El reclamo del puerto (reconciliación): ver I${entity.name}Repository.${csMember(claim.method)}.</summary>
    public async Task<IReadOnlyList<${entity.name}>> ${csMember(claim.method)}(CancellationToken cancellationToken = default)
    {
        RequireOwnTransaction(${csString(csMember(claim.method))});
        var window = reconciliation.Windows[${csString(claim.activation)}];
        // Los dos cortes, sobre el MISMO instante: lleva demasiado sin desenlace, y el reclamo ajeno ya caducó.
        var now = DateTimeOffset.UtcNow;
        var unansweredBefore = now.AddSeconds(-window.UnansweredAfterSeconds);
        var claimExpiredBefore = now.AddMilliseconds(-window.ClaimTimeoutMs);
        // Los que ya tienen una marca VIVA no son candidatos: sin excluirlos, la cabeza de la cola ocuparía el lote de cada
        // pasada hasta caducar, y los de detrás no se reconciliarían antes.
        var held = await reconciliationClaims.Held(${csString(claim.activation)}, claimExpiredBefore, cancellationToken);
        var candidates = await Collection
            .Find(new BsonDocument
            {
                { ${csString(field)}, new BsonDocument("$in", new BsonArray { ${states} }) },
                { ${csString(awaiting)}, new BsonDocument("$lt", BsonValues.Of(unansweredBefore)) },
                { "_id", new BsonDocument("$nin", new BsonArray(held)) }
            })
            .Sort(new BsonDocument(${csString(awaiting)}, 1))
            .Limit(window.BatchSize)
            .ToListAsync(cancellationToken);
        var claimed = new List<${entity.name}>();
        foreach (var document in candidates)
        {
            var candidate = ToDomain${entity.name}(document);
            // true = la marca es mía; false = otra réplica la tiene y aún no ha caducado.
            if (await reconciliationClaims.Claim(${csString(claim.activation)}, candidate.${idProp}, now, claimExpiredBefore, cancellationToken))
            {
                claimed.Add(candidate);
            }
        }
        return claimed;
    }`;
    });
}

/** El ayudante de los reclamos documentales: confirman al volver, así que no corren dentro de una transacción abierta. */
export function documentOwnTransactionHelper() {
  return `    /// <summary>
    /// Un reclamo confirma al volver, antes de devolver los documentos: dentro de una transacción abierta su marca no
    /// existiría para ninguna otra réplica hasta el commit final, así que todas actuarían sobre los mismos candidatos.
    /// </summary>
    private void RequireOwnTransaction(string method)
    {
        if (transactions.Session is not null)
        {
            throw new InvalidOperationException(
                $"{method} confirma por su cuenta y hay una transacción abierta: despacha la operación con DispatchWithoutTransaction (el scheduler ya lo hace).");
        }
    }`;
}

// ─── Las purgas ──────────────────────────────────────────────────────────────────────────────────

/** El cuerpo de un método de purga sobre documentos (la frontera y el borrado por lotes). */
export function documentPurgeMethod(purge) {
  const cutoff = purge.retentionDays ? `instant - TimeSpan.FromDays(settings.${purge.key}.RetentionDays!.Value)` : 'instant';
  // Sin condición propia aparte: la del outbox (solo lo publicado) es la del corte mismo, porque en MongoDB un $lt sobre una
  // fecha solo casa con fechas, y lo pendiente tiene published_at a null. Lo pendiente no se toca nunca.
  const before = (bound) => `new BsonDocument(${csString(purge.column)}, ${bound})`;
  return `    /// <summary>La purga de ${purge.what}${purge.predicate ? ` (solo ${purge.predicate})` : ''}. Devuelve los documentos borrados.</summary>
    public async Task<long> ${purge.method}(DateTimeOffset? now = null, CancellationToken cancellationToken = default)
    {
        if (!database.Enabled)
        {
            return 0;
        }
        var instant = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var cutoff = ${cutoff};
        var schedule = settings.${purge.key};
        var documents = documentDatabase.Collection(${csString(purge.table)});
        // La frontera y el borrado llevan la MISMA condición: la frontera tiene que contar lo que el borrado se lleva, o el
        // lote deja de medir lo que dice. Cada lote, en su propia operación: un DeleteMany ya es atómico por documento.
        var deleted = await BatchedPurge.Run(
            ${csString(purge.what)},
            schedule.BatchSize,
            schedule.MaxBatches,
            cutoff,
            async position =>
            {
                var edge = await documents
                    .Find(${before('new BsonDocument("$lt", BsonValues.Of(cutoff))')})
                    .Sort(new BsonDocument(${csString(purge.column)}, 1))
                    .Skip(position)
                    .Limit(1)
                    .FirstOrDefaultAsync(cancellationToken);
                return edge is null ? null : BsonValues.InstantOrNull(BsonValues.Field(edge, ${csString(purge.column)}), ${csString(`${purge.table}.${purge.column}`)});
            },
            async upTo => (int)(await documents.DeleteManyAsync(
                ${before('new BsonDocument { { "$lt", BsonValues.Of(cutoff) }, { "$lte", BsonValues.Of(upTo) } }')},
                cancellationToken)).DeletedCount,
            LogExhausted);
        if (deleted > 0)
        {
            Log${purge.key}Purged(deleted, cutoff);
        }
        return deleted;
    }`;
}
