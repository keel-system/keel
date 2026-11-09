// Los almacenes del generador sobre DOCUMENTOS (incremento 12): el outbox con su relay, el registro de mensajes
// procesados, el registro de idempotencia de petición y las purgas por lotes. Cada uno conserva su archivo, su tipo y su
// API —los de la rama relacional: messaging-stores.js, request-idempotency.js, purge.js—, así que el relay, la guarda, el
// reloj y los casos de uso no distinguen el almacén; solo cambia el cuerpo. Los documentos son los de keel-core
// (`storeDocumentKey` y `storeDocumentFields` de gen/document.js), los mismos que escriben keel-spring, keel-nest y
// keel-dotnet:
//   · outbox_event con el `_id` uuid y `claimed_at`: aquí no hay bloqueo de fila, y el reclamo es una MARCA caducable
//     estampada con FindOneAndUpdate —atómico por documento—, el equivalente del SKIP LOCKED. El fallo es un `$inc` con el
//     error como VALOR de un `$set` (un texto que empiece por `$` no se lee como campo), y la rendición se decide con el
//     contador ya incrementado;
//   · processed_event e idempotency_record con un `_id` SUBDOCUMENTO en el orden de la clave de keel-core: MongoDB compara
//     un `_id` subdocumento campo a campo y en orden, así que el orden es contrato. La carrera la arbitra el `_id`;
//   · las purgas, el mismo bucle por lotes sobre la colección: sin condición propia en el outbox, porque un `$lt` sobre una
//     fecha no casa con null, y lo pendiente tiene published_at a null.

import { OUTBOX_EVENT, PROCESSED_EVENT } from '@keel-system/keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD } from '@keel-system/keel-core/gen/request-idempotency';
import { storeDocumentFields, storeDocumentKey } from '@keel-system/keel-core/gen/document';
import { usesDocument } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { GO_OUTBOX_WAKE_LINE, MESSAGING_IMPORT, usesGoOutbox, usesGoProcessedEvents } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { tablePurges } from './purge.js';
import { BSON, MONGO_DRIVER, MONGO_OPTIONS } from './document-persistence.js';

export function generate(model) {
  if (!usesDocument(model)) return [];
  const { store } = layout(model);
  const files = [];
  const imports = ['context', 'errors', 'fmt', 'time', 'github.com/google/uuid', MONGO_DRIVER, BSON, MONGO_OPTIONS, MESSAGING_IMPORT, 'internal/domain'];
  if (usesGoOutbox(model)) files.push({ path: `${store.dir}/outbox.go`, content: packageFile(model, store, { imports, body: outboxBody() }) });
  if (usesGoProcessedEvents(model)) files.push({ path: `${store.dir}/processed_events.go`, content: packageFile(model, store, { imports, body: processedBody() }) });
  if (usesRequestIdempotency(model)) files.push({ path: `${store.dir}/idempotency_store.go`, content: packageFile(model, store, { imports, body: idempotencyBody() }) });
  const purges = tablePurges(model);
  if (purges.length > 0) files.push({ path: `${store.dir}/purges.go`, content: packageFile(model, store, { imports, body: purgesBody(purges) }) });
  return files;
}

/** El `_id` subdocumento de un almacén, en el orden de su clave en keel-core, con los valores en ese orden. */
function keyLiteral(table, values) {
  const key = storeDocumentKey(table);
  if (key.kind !== 'subdocument') throw new Error(`${table.table}: se esperaba una clave compuesta`);
  return `bson.D{${key.columns.map((column, index) => `{Key: ${goString(column)}, Value: ${values[column] ?? values[index]}}`).join(', ')}}`;
}

/** Los campos de un documento de almacén con sus valores, comprobando que no falte ninguno de keel-core. */
function storeFields(table, values) {
  const fields = storeDocumentFields(table);
  const missing = fields.filter((field) => !(field.name in values));
  if (missing.length > 0) throw new Error(`${table.table}: no se escribe ${missing.map((field) => field.name).join(', ')}`);
  return fields.map((field) => `\t\t\t{Key: ${goString(field.name)}, Value: ${values[field.name]}},`);
}

// ─── El outbox ───────────────────────────────────────────────────────────────────────────────────

function outboxBody() {
  const table = OUTBOX_EVENT.table;
  const fields = storeFields(OUTBOX_EVENT, {
    destination: 'record.Destination',
    routing_key: 'record.RoutingKey',
    event_type: 'record.EventType',
    payload: 'record.Payload',
    created_at: 'instantValue(now)',
    published_at: 'nil',
    attempts: 'int32(0)',
    next_attempt_at: 'nil',
    claimed_at: 'nil',
    last_error: 'nil'
  });
  return `
// outboxCollection es la colección del outbox.
const outboxCollection = ${goString(table)}

// relayWake despierta al relay de ESTA réplica cuando confirma la transacción que escribió filas del outbox (DSL 2.26,
// inc. 9): el evento sale ya, sin esperar al sondeo de respaldo. Si la transacción revierte, el aviso no llega a nadie.
func (t *Transactions) relayWake(ctx context.Context) {
	t.afterCommit(ctx, func(context.Context) {
		if t.outboxAppended != nil {
			${GO_OUTBOX_WAKE_LINE}
		}
	})
}

// OnOutboxAppended hace que appended se llame tras confirmar una transacción que escribe en el outbox: el despertar del
// relay de esta réplica (messaging.Relay.Wake). Se fija en el arranque, antes de servir nada.
func (t *Transactions) OnOutboxAppended(appended func()) {
	t.outboxAppended = appended
}

// appendOutbox escribe los documentos del outbox en la transacción del cambio (la del Save del repositorio, cuya sesión
// viaja en ctx): el evento y el cambio del agregado confirman o abortan juntos. El relay los publica después, fuera de ella.
func appendOutbox(ctx context.Context, tx *Transactions, records []messaging.OutboxRecord) error {
	if len(records) == 0 {
		return nil
	}
	if openTx(ctx) == nil {
		return errors.New("el outbox se escribe en la transacción del cambio, y no hay ninguna abierta")
	}
	documents, err := tx.collection(outboxCollection)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	rows := make([]any, 0, len(records))
	for _, record := range records {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		rows = append(rows, bson.D{
			{Key: "_id", Value: uuidValue(id)},
${fields.join('\n')}
		})
	}
	_, err = documents.InsertMany(ctx, rows)
	return err
}

// Outbox es el adaptador de MongoDB de messaging.OutboxStore sobre la colección ${table}: cada operación es atómica por
// documento y va FUERA de la transacción del contexto, y la publicación al broker fuera de todas.
//
// No hay bloqueo de fila: el reclamo es una MARCA caducable (claimed_at) estampada con FindOneAndUpdate, que filtra y
// marca en la misma operación, así que dos réplicas nunca se llevan el mismo documento. Si la réplica muere, la marca
// caduca (lease) y otra lo recoge.
type Outbox struct {
	tx *Transactions
}

// NewOutbox construye el almacén del relay sobre las transacciones del servicio.
func NewOutbox(tx *Transactions) *Outbox {
	return &Outbox{tx: tx}
}

var _ messaging.OutboxStore = (*Outbox)(nil)

// ClaimBatch implementa messaging.OutboxStore: hasta batchSize pendientes, en orden de llegada, que no agotaron sus
// reintentos, con el backoff vencido y sin un reclamo vivo (uno más viejo que lease ya caducó). Sin orden, con más
// candidatos que el lote los más antiguos podrían no salir nunca.
func (o *Outbox) ClaimBatch(ctx context.Context, maxAttempts, batchSize int, lease time.Duration) ([]messaging.OutboxEvent, error) {
	documents, err := o.tx.collection(outboxCollection)
	if err != nil {
		return nil, err
	}
	ctx = outside(ctx)
	now := time.Now().UTC()
	filter := bson.D{
		{Key: "published_at", Value: nil},
		{Key: "attempts", Value: bson.D{{Key: "$lt", Value: maxAttempts}}},
		{Key: "$and", Value: bson.A{
			bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "next_attempt_at", Value: nil}}, bson.D{{Key: "next_attempt_at", Value: bson.D{{Key: "$lte", Value: instantValue(now)}}}}}}},
			bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "claimed_at", Value: nil}}, bson.D{{Key: "claimed_at", Value: bson.D{{Key: "$lte", Value: instantValue(now.Add(-lease))}}}}}}},
		}},
	}
	update := bson.D{{Key: "$set", Value: bson.D{{Key: "claimed_at", Value: instantValue(now)}}}}
	claim := options.FindOneAndUpdate().SetSort(bson.D{{Key: "created_at", Value: 1}, {Key: "_id", Value: 1}}).SetReturnDocument(options.After)
	var claimed []messaging.OutboxEvent
	for range batchSize {
		raw, err := documents.FindOneAndUpdate(ctx, filter, update, claim).Raw()
		if errors.Is(err, mongodriver.ErrNoDocuments) {
			break
		}
		if err != nil {
			return claimed, fmt.Errorf("reclamar el lote del outbox: %w", err)
		}
		event, err := outboxEventOf(raw)
		if err != nil {
			return claimed, fmt.Errorf("${table}: %w", err)
		}
		claimed = append(claimed, event)
	}
	return claimed, nil
}

// outboxEventOf lee lo que el relay publica de un documento del outbox.
func outboxEventOf(raw bson.Raw) (messaging.OutboxEvent, error) {
	var event messaging.OutboxEvent
	var err error
	if event.ID, err = get(raw, "_id", asUUID); err != nil {
		return event, err
	}
	if event.Destination, err = get(raw, "destination", asText); err != nil {
		return event, err
	}
	if event.RoutingKey, err = get(raw, "routing_key", asText); err != nil {
		return event, err
	}
	if event.EventType, err = get(raw, "event_type", asText); err != nil {
		return event, err
	}
	if event.Payload, err = get(raw, "payload", asText); err != nil {
		return event, err
	}
	return event, nil
}

// MarkPublished implementa messaging.OutboxStore.
func (o *Outbox) MarkPublished(ctx context.Context, id uuid.UUID) error {
	documents, err := o.tx.collection(outboxCollection)
	if err != nil {
		return err
	}
	_, err = documents.UpdateOne(outside(ctx), bson.D{{Key: "_id", Value: uuidValue(id)}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "published_at", Value: instantValue(time.Now().UTC())}, {Key: "claimed_at", Value: nil}}}})
	return err
}

// MarkFailed implementa messaging.OutboxStore: incrementa el intento y decide rendición o backoff con el contador YA
// incrementado, en la MISMA operación atómica que lo lee. Un documento que desapareció entre el reclamo y el desenlace se
// da por agotado, para no reintentar sobre un id que ya no está.
func (o *Outbox) MarkFailed(ctx context.Context, id uuid.UUID, reason string, maxAttempts int, backoffInitial, backoffMax time.Duration) (messaging.FailedOutcome, error) {
	documents, err := o.tx.collection(outboxCollection)
	if err != nil {
		return messaging.FailedOutcome{}, err
	}
	ctx = outside(ctx)
	filter := bson.D{{Key: "_id", Value: uuidValue(id)}}
	// Con $set el texto va como VALOR: un error que empiece por $ no se lee como un campo.
	update := bson.D{
		{Key: "$inc", Value: bson.D{{Key: "attempts", Value: 1}}},
		{Key: "$set", Value: bson.D{{Key: "last_error", Value: reason}, {Key: "claimed_at", Value: nil}}},
	}
	raw, err := documents.FindOneAndUpdate(ctx, filter, update, options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return messaging.FailedOutcome{Attempts: maxAttempts, DeadLettered: true}, nil
	}
	if err != nil {
		return messaging.FailedOutcome{}, err
	}
	attempts, err := get(raw, "attempts", asInt32)
	if err != nil {
		return messaging.FailedOutcome{}, fmt.Errorf("${table}: %w", err)
	}
	outcome := messaging.FailedOutcome{Attempts: int(attempts), DeadLettered: messaging.DeadLettered(int(attempts), maxAttempts)}
	if !outcome.DeadLettered {
		next := time.Now().UTC().Add(messaging.BackoffDelay(int(attempts), backoffInitial, backoffMax))
		outcome.NextAttempt = next
		if _, err := documents.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: bson.D{{Key: "next_attempt_at", Value: instantValue(next)}}}}); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}

// CountDeadLettered implementa messaging.OutboxStore: los documentos que agotaron los reintentos y siguen sin publicar. Es
// el dato de la única promesa del outbox —que ningún evento se pierde— justo cuando deja de cumplirse.
func (o *Outbox) CountDeadLettered(ctx context.Context, maxAttempts int) (int, error) {
	documents, err := o.tx.collection(outboxCollection)
	if err != nil {
		return 0, err
	}
	count, err := documents.CountDocuments(outside(ctx), bson.D{{Key: "published_at", Value: nil}, {Key: "attempts", Value: bson.D{{Key: "$gte", Value: maxAttempts}}}})
	return int(count), err
}
`;
}

// ─── La guarda de los mensajes procesados ────────────────────────────────────────────────────────

function processedBody() {
  const table = PROCESSED_EVENT.table;
  const key = keyLiteral(PROCESSED_EVENT, { handler_id: 'handlerID', event_id: 'eventID' });
  const fields = storeFields(PROCESSED_EVENT, { processed_at: 'instantValue(time.Now().UTC())' });
  return `
// processedCollection es la colección del registro de mensajes procesados.
const processedCollection = ${goString(table)}

// ProcessedEvents es el adaptador de MongoDB de messaging.ProcessedEvents sobre la colección ${table}, la MISMA que los
// servidores de keel-spring, keel-nest y keel-dotnet del diseño. Su _id es el subdocumento {handler_id, event_id}, en ese
// orden. Cada operación va FUERA de la transacción del contexto: el registro sobrevive al fallo del handler.
type ProcessedEvents struct {
	tx *Transactions
}

// NewProcessedEvents construye el registro sobre las transacciones del servicio.
func NewProcessedEvents(tx *Transactions) *ProcessedEvents {
	return &ProcessedEvents{tx: tx}
}

var _ messaging.ProcessedEvents = (*ProcessedEvents)(nil)

// Exists implementa messaging.ProcessedEvents.
func (p *ProcessedEvents) Exists(ctx context.Context, handlerID, eventID string) (bool, error) {
	documents, err := p.tx.collection(processedCollection)
	if err != nil {
		return false, err
	}
	count, err := documents.CountDocuments(outside(ctx), bson.D{{Key: "_id", Value: ${key}}}, options.Count().SetLimit(1))
	return count > 0, err
}

// Insert implementa messaging.ProcessedEvents: false si el par ya estaba. Con dos entregas a la vez, la que pierde choca
// con el _id. Una inserción suelta ya es atómica: no necesita transacción.
func (p *ProcessedEvents) Insert(ctx context.Context, handlerID, eventID string) (bool, error) {
	documents, err := p.tx.collection(processedCollection)
	if err != nil {
		return false, err
	}
	_, err = documents.InsertOne(outside(ctx), bson.D{
		{Key: "_id", Value: ${key}},
${fields.map((line) => line.slice(1)).join('\n')}
	})
	if mongodriver.IsDuplicateKeyError(err) {
		return false, nil
	}
	return err == nil, err
}
`;
}

// ─── El registro de idempotencia de petición ─────────────────────────────────────────────────────

function idempotencyBody() {
  const table = IDEMPOTENCY_RECORD.table;
  const key = keyLiteral(IDEMPOTENCY_RECORD, { operation_scope: 'scope', idempotency_key: 'key' });
  const fields = storeFields(IDEMPOTENCY_RECORD, {
    signature: 'signature',
    resource_id: 'orNull(resourceID, func(v string) any { return v })',
    created_at: 'instantValue(now)',
    expires_at: 'instantValue(now.Add(time.Duration(ttlSeconds) * time.Second))'
  });
  return `
// idempotencyCollection es la colección del registro de idempotencia.
const idempotencyCollection = ${goString(table)}

// IdempotencyStore es el adaptador de MongoDB del registro de idempotencia (domain.IdempotencyStore) sobre la colección
// ${table}, la MISMA que los servidores de keel-spring, keel-nest y keel-dotnet del diseño, con el _id subdocumento
// {operation_scope, idempotency_key}. Se une a la transacción del caso de uso: el registro y el efecto del comando
// confirman o abortan juntos, porque una clave marcada sin recurso detrás haría que el reintento devolviese una respuesta
// que nunca existió.
//
// La carrera la arbitra el _id: dos peticiones simultáneas con la misma clave insertan el mismo, y la que pierde choca
// (o aborta con un conflicto transitorio, se repite y encuentra el registro). Sale como domain.IdempotencyConflict —su
// code, no un 409 anónimo indistinguible de un conflicto de negocio—.
type IdempotencyStore struct {
	tx *Transactions
}

// NewIdempotencyStore construye el registro sobre las transacciones del servicio.
func NewIdempotencyStore(tx *Transactions) *IdempotencyStore {
	return &IdempotencyStore{tx: tx}
}

var _ domain.IdempotencyStore = (*IdempotencyStore)(nil)

// Find implementa domain.IdempotencyStore. Un registro caducado es como si no estuviera: la ventana la fija el diseño, no
// la purga.
func (s *IdempotencyStore) Find(ctx context.Context, scope, key string) (domain.StoredRequest, bool, error) {
	documents, err := s.tx.collection(idempotencyCollection)
	if err != nil {
		return domain.StoredRequest{}, false, err
	}
	raw, err := documents.FindOne(ctx, bson.D{{Key: "_id", Value: ${key}}, {Key: "expires_at", Value: bson.D{{Key: "$gt", Value: instantValue(time.Now().UTC())}}}}).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return domain.StoredRequest{}, false, nil
	}
	if err != nil {
		return domain.StoredRequest{}, false, translate(err)
	}
	var stored domain.StoredRequest
	if stored.Signature, err = get(raw, "signature", asText); err != nil {
		return domain.StoredRequest{}, false, fmt.Errorf("${table}: %w", err)
	}
	if stored.ResourceID, err = get(raw, "resource_id", optional(asText)); err != nil {
		return domain.StoredRequest{}, false, fmt.Errorf("${table}: %w", err)
	}
	return stored, true, nil
}

// Save implementa domain.IdempotencyStore.
func (s *IdempotencyStore) Save(ctx context.Context, scope, key, signature string, resourceID *string, ttlSeconds int) error {
	return s.tx.write(ctx, func(ctx context.Context) error {
		documents, err := s.tx.collection(idempotencyCollection)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		// Un registro CADUCADO es como si no estuviera —es lo que ya asume Find—, y tiene que serlo aquí: si no, la clave
		// quedaría inutilizable entre su caducidad y la purga, con el conflicto de clave en curso todo ese tiempo.
		if _, err := documents.DeleteOne(ctx, bson.D{{Key: "_id", Value: ${key}}, {Key: "expires_at", Value: bson.D{{Key: "$lte", Value: instantValue(now)}}}}); err != nil {
			return err
		}
		_, err = documents.InsertOne(ctx, bson.D{
			{Key: "_id", Value: ${key}},
${fields.join('\n')}
		})
		if mongodriver.IsDuplicateKeyError(err) {
			return domain.IdempotencyConflict(scope, key)
		}
		return err
	})
}
`;
}

// ─── Las purgas ──────────────────────────────────────────────────────────────────────────────────

function purgesBody(purges) {
  const constructors = purges.map(
    (purge) => `// ${purge.constructor} es la purga de ${purge.what}${purge.predicate ? ` (solo ${purge.predicate}: lo pendiente no se toca nunca, y un $lt sobre una fecha no casa con null)` : ''}, cortada
// por ${purge.column}.
func ${purge.constructor}(tx *Transactions) *TablePurge {
	return &TablePurge{tx: tx, collection: ${goString(purge.table)}, field: ${goString(purge.column)}}
}`
  );
  return `
// TablePurge es la purga por lotes de una colección del generador sobre MongoDB: el puerto scheduler.PurgeTable. La
// frontera y el borrado llevan la MISMA condición: la frontera tiene que contar los documentos que el borrado se lleva, o
// el lote deja de medir lo que dice.
type TablePurge struct {
	tx         *Transactions
	collection string
	field      string
}

${constructors.join('\n\n')}

// Boundary es el instante del documento en la posición position entre los anteriores a cutoff, y false si quedan menos.
func (p *TablePurge) Boundary(ctx context.Context, cutoff time.Time, position int) (time.Time, bool, error) {
	documents, err := p.tx.collection(p.collection)
	if err != nil {
		return time.Time{}, false, err
	}
	edge := options.FindOne().SetSort(bson.D{{Key: p.field, Value: 1}}).SetSkip(int64(position)).SetProjection(bson.D{{Key: p.field, Value: 1}})
	raw, err := documents.FindOne(outside(ctx), bson.D{{Key: p.field, Value: bson.D{{Key: "$lt", Value: instantValue(cutoff)}}}}, edge).Raw()
	if errors.Is(err, mongodriver.ErrNoDocuments) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	at, err := get(raw, p.field, asInstant)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("%s: %w", p.collection, err)
	}
	return at, true, nil
}

// DeleteUpTo borra lo anterior a cutoff hasta upTo incluido, en su propia operación (un DeleteMany es atómico por
// documento, y fuera de toda transacción). Devuelve los documentos borrados.
func (p *TablePurge) DeleteUpTo(ctx context.Context, cutoff, upTo time.Time) (int64, error) {
	documents, err := p.tx.collection(p.collection)
	if err != nil {
		return 0, err
	}
	result, err := documents.DeleteMany(outside(ctx), bson.D{{Key: p.field, Value: bson.D{{Key: "$lt", Value: instantValue(cutoff)}, {Key: "$lte", Value: instantValue(upTo)}}}})
	if err != nil {
		return 0, err
	}
	return result.DeletedCount, nil
}
`;
}
