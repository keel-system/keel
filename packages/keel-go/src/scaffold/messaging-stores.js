// Los almacenes de la mensajería sobre el motor relacional (incremento 9): el OUTBOX con su relay y el registro de
// mensajes PROCESADOS. Las tablas son DATOS de keel-core (`gen/messaging-stores.js`: OUTBOX_EVENT y PROCESSED_EVENT),
// las mismas que crean los servidores de keel-spring, keel-nest y keel-dotnet del diseño; aquí solo va el SQL que las
// lee y las escribe, en el paquete del adaptador (`postgres` o `mysql`), que implementa los puertos de
// `internal/infrastructure/messaging`:
//
//   · appendOutbox — las filas del outbox, en la transacción del CAMBIO (la del Save del repositorio): el evento y el
//     cambio confirman o revierten juntos;
//   · Outbox (messaging.OutboxStore) — las transacciones CORTAS del relay, cada una PROPIA aunque el contexto traiga
//     otra abierta: el reclamo con SKIP LOCKED más un LEASE sobre next_attempt_at, y el desenlace. En MySQL el reclamo
//     va en READ COMMITTED: en REPEATABLE READ el FOR UPDATE toma también los huecos entre claves, y dos réplicas se
//     esperarían en vez de repartirse el lote (la medida de keel-dotnet);
//   · ProcessedEvents (messaging.ProcessedEvents) — el registro de la guarda, también en su propia transacción: tiene
//     que sobrevivir al fallo del handler. La carrera entre dos entregas la arbitra la clave primaria.

import { OUTBOX_EVENT, PROCESSED_EVENT, storeColumns } from '@keel-system/keel-core/gen/messaging-stores';
import { goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { MYSQL_DRIVER } from './persistence-runtime.js';
import { layout, packageFile } from './render.js';
import { MESSAGING_IMPORT, usesGoOutbox, usesGoProcessedEvents } from './messaging.js';

/** Las tablas de los almacenes que el diseño usa, como las espera el baseline (persistence.js). */
export function storeTables(model) {
  const tables = [];
  if (usesGoOutbox(model)) tables.push(OUTBOX_EVENT);
  if (usesGoProcessedEvents(model)) tables.push(PROCESSED_EVENT);
  return tables.map((table) => ({ ...table, columns: storeColumns(table, 'relational') }));
}

export function generate(model) {
  const files = [];
  const { store } = layout(model);
  const engineImport = sqlDialect(model).mysql ? MYSQL_DRIVER : 'github.com/jackc/pgx/v5/pgconn';
  const imports = ['context', 'database/sql', 'errors', 'fmt', 'strings', 'time', 'github.com/google/uuid', engineImport, MESSAGING_IMPORT];
  if (usesGoOutbox(model)) files.push({ path: `${store.dir}/outbox.go`, content: packageFile(model, store, { imports, body: outboxBody(model) }) });
  if (usesGoProcessedEvents(model)) files.push({ path: `${store.dir}/processed_events.go`, content: packageFile(model, store, { imports, body: processedBody(model) }) });
  return files;
}

function outboxBody(model) {
  const d = sqlDialect(model);
  const p = d.param;
  const table = OUTBOX_EVENT.table;
  const claimOptions = d.mysql ? 'sql.TxOptions{Isolation: sql.LevelReadCommitted}' : 'sql.TxOptions{}';
  return `
// appendOutbox escribe las filas del outbox en la transacción del cambio (q): el evento y el cambio del agregado
// confirman o revierten juntos. El relay las publica después, fuera de ella.
func appendOutbox(ctx context.Context, q DBTX, records []messaging.OutboxRecord) error {
	now := time.Now().UTC()
	for _, record := range records {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table} (id, destination, routing_key, event_type, payload, created_at, attempts) VALUES (${[1, 2, 3, 4, 5, 6, 7].map(p).join(', ')})`)},
			id, record.Destination, record.RoutingKey, record.EventType, record.Payload, now, 0); err != nil {
			return err
		}
	}
	return nil
}

// Outbox es el adaptador de ${d.label} de messaging.OutboxStore sobre la tabla ${table}: cada método en su PROPIA
// transacción, corta, y la publicación al broker fuera de todas.
//
// El lease sustituye a la garantía que el SKIP LOCKED da solo mientras la transacción sigue abierta: sin él, otra réplica
// —o esta misma en la pasada siguiente— volvería a ver elegible una fila cuyo despacho sigue en vuelo. Si la réplica
// muere, el lease caduca y otra la recoge.
type Outbox struct {
	tx *Transactions
}

// NewOutbox construye el almacén del relay sobre las transacciones del servicio.
func NewOutbox(tx *Transactions) *Outbox {
	return &Outbox{tx: tx}
}

var _ messaging.OutboxStore = (*Outbox)(nil)

// ClaimBatch implementa messaging.OutboxStore: las pendientes, en orden de llegada, que no agotaron sus reintentos y
// cuyo backoff (o lease) venció. SKIP LOCKED: con varias réplicas cada una se lleva un lote disjunto en vez de esperar a
// la otra. El lease se pone en la misma transacción; si el despacho sale bien, MarkPublished la saca del todo, y si
// falla, MarkFailed lo pisa con el backoff de verdad.
func (o *Outbox) ClaimBatch(ctx context.Context, maxAttempts, batchSize int, lease time.Duration) ([]messaging.OutboxEvent, error) {
	var claimed []messaging.OutboxEvent
	err := o.tx.apart(ctx, ${claimOptions}, func(q DBTX) error {
		claimed = nil
		now := time.Now().UTC()
		rows, err := q.QueryContext(ctx, ${goString(`SELECT id, destination, routing_key, event_type, payload FROM ${table} WHERE published_at IS NULL AND attempts < ${p(1)} AND (next_attempt_at IS NULL OR next_attempt_at <= ${p(2)}) ORDER BY created_at LIMIT ${p(3)} FOR UPDATE SKIP LOCKED`)}, maxAttempts, now, batchSize)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var event messaging.OutboxEvent
			if err := rows.Scan(&event.ID, &event.Destination, &event.RoutingKey, &event.EventType, &event.Payload); err != nil {
				return err
			}
			claimed = append(claimed, event)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, event := range claimed {
			if _, err := q.ExecContext(ctx, ${goString(`UPDATE ${table} SET next_attempt_at = ${p(1)} WHERE id = ${p(2)}`)}, now.Add(lease), event.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("reclamar el lote del outbox: %w", err)
	}
	return claimed, nil
}

// MarkPublished implementa messaging.OutboxStore.
func (o *Outbox) MarkPublished(ctx context.Context, id uuid.UUID) error {
	return o.tx.apart(ctx, sql.TxOptions{}, func(q DBTX) error {
		_, err := q.ExecContext(ctx, ${goString(`UPDATE ${table} SET published_at = ${p(1)} WHERE id = ${p(2)}`)}, time.Now().UTC(), id)
		return err
	})
}

// MarkFailed implementa messaging.OutboxStore: incrementa el intento, decide rendición o backoff con el contador YA
// incrementado y lo aplica, todo en la misma transacción. Una fila que desapareció entre el reclamo y el desenlace se da
// por agotada, para no reintentar sobre un id que ya no está.
func (o *Outbox) MarkFailed(ctx context.Context, id uuid.UUID, reason string, maxAttempts int, backoffInitial, backoffMax time.Duration) (messaging.FailedOutcome, error) {
	var outcome messaging.FailedOutcome
	err := o.tx.apart(ctx, sql.TxOptions{}, func(q DBTX) error {
		var attempts int
		err := q.QueryRowContext(ctx, ${goString(`SELECT attempts FROM ${table} WHERE id = ${p(1)} FOR UPDATE`)}, id).Scan(&attempts)
		if errors.Is(err, sql.ErrNoRows) {
			outcome = messaging.FailedOutcome{Attempts: maxAttempts, DeadLettered: true}
			return nil
		}
		if err != nil {
			return err
		}
		attempts++
		outcome = messaging.FailedOutcome{Attempts: attempts, DeadLettered: messaging.DeadLettered(attempts, maxAttempts)}
		var next *time.Time
		if !outcome.DeadLettered {
			at := time.Now().UTC().Add(messaging.BackoffDelay(attempts, backoffInitial, backoffMax))
			next = &at
		}
		_, err = q.ExecContext(ctx, ${goString(`UPDATE ${table} SET attempts = ${p(1)}, last_error = ${p(2)}, next_attempt_at = ${d.mysql ? `COALESCE(${p(3)}, next_attempt_at)` : `COALESCE(${p(3)}::timestamptz, next_attempt_at)`} WHERE id = ${p(4)}`)}, attempts, reason, next, id)
		return err
	})
	return outcome, err
}

// CountDeadLettered implementa messaging.OutboxStore: las filas que agotaron los reintentos y siguen sin publicar. Es el
// dato de la única promesa del outbox —que ningún evento se pierde— justo cuando deja de cumplirse.
func (o *Outbox) CountDeadLettered(ctx context.Context, maxAttempts int) (int, error) {
	var count int
	err := o.tx.apart(ctx, sql.TxOptions{ReadOnly: true}, func(q DBTX) error {
		return q.QueryRowContext(ctx, ${goString(`SELECT COUNT(*) FROM ${table} WHERE published_at IS NULL AND attempts >= ${p(1)}`)}, maxAttempts).Scan(&count)
	})
	return count, err
}
`;
}

function processedBody(model) {
  const d = sqlDialect(model);
  const p = d.param;
  const table = PROCESSED_EVENT.table;
  const duplicate = d.mysql
    ? `	var engine *mysqldriver.MySQLError
	// MySQL llama PRIMARY a toda clave primaria, y solo la nombra en el texto del mensaje.
	return errors.As(err, &engine) && engine.Number == 1062 && strings.Contains(engine.Message, ${goString(`'${table}.PRIMARY'`)})`
    : `	var engine *pgconn.PgError
	return errors.As(err, &engine) && engine.Code == "23505" && engine.ConstraintName == ${goString(`${table}_pkey`)}`;
  return `
// errAlreadyProcessed es la clave primaria de ${table} repetida dentro de Insert: otra entrega registró antes.
var errAlreadyProcessed = errors.New("mensaje ya registrado")

// ProcessedEvents es el adaptador de ${d.label} de messaging.ProcessedEvents sobre la tabla ${table}, la MISMA que los
// servidores de keel-spring, keel-nest y keel-dotnet del diseño. Cada operación va en su PROPIA transacción, aunque el
// contexto traiga otra abierta: el registro sobrevive al fallo del handler.
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
	found := false
	err := p.tx.apart(ctx, sql.TxOptions{ReadOnly: true}, func(q DBTX) error {
		var one int
		switch err := q.QueryRowContext(ctx, ${goString(`SELECT 1 FROM ${table} WHERE handler_id = ${p(1)} AND event_id = ${p(2)}`)}, handlerID, eventID).Scan(&one); {
		case errors.Is(err, sql.ErrNoRows):
			found = false
			return nil
		case err != nil:
			return err
		}
		found = true
		return nil
	})
	return found, err
}

// Insert implementa messaging.ProcessedEvents: false si el par ya estaba. Con dos entregas a la vez, la que pierde el
// INSERT espera a que la otra confirme y choca con la clave primaria.
func (p *ProcessedEvents) Insert(ctx context.Context, handlerID, eventID string) (bool, error) {
	err := p.tx.apart(ctx, sql.TxOptions{}, func(q DBTX) error {
		_, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table} (handler_id, event_id, processed_at) VALUES (${p(1)}, ${p(2)}, ${p(3)})`)}, handlerID, eventID, time.Now().UTC())
		if duplicateProcessedEvent(err) {
			return errAlreadyProcessed
		}
		return err
	})
	if errors.Is(err, errAlreadyProcessed) {
		return false, nil
	}
	return err == nil, err
}

// duplicateProcessedEvent dice si err es la clave primaria del registro repetida: la carrera.
func duplicateProcessedEvent(err error) bool {
${duplicate}
}
`;
}
