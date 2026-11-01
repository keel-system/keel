// La purga POR LOTES de las tablas del generador (tramo 10b): `outbox_event`, `processed_event`, `idempotency_record` y
// `reconciliation_claim` (tramo 11c).
//
// Las mismas que purgan los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño, con la misma forma
// (keel-core/gen/scheduling.js, `BATCHED_PURGE`): un único DELETE sobre todo lo caducado es una transacción del tamaño
// del atraso —tras una caída del broker, millones de filas que retienen sus bloqueos, llenan el WAL y, con el tope de
// transacción del servicio, no terminan nunca—. El lote se acota por INSTANTE: se lee el de la fila que ocupa la
// posición N entre las que hay que purgar y se borra hasta él, cada lote en su propia transacción.
//
// El reparto es el de la mensajería: el bucle, la configuración y el puerto (`PurgeTable`) van en el paquete del reloj
// (scheduling.js), sin SQL, para poder ejecutarlo en la prueba emitida contra los casos de la referencia de keel-core;
// y el SQL de cada tabla, LITERAL, en el paquete del motor (`purges.go`): la tabla y la columna son del generador, y lo
// único que viaja como parámetro son los instantes y la posición.

import { OUTBOX_EVENT, OUTBOX_PURGE, PROCESSED_EVENT, PROCESSED_EVENT_PURGE } from '@keel-system/keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD, IDEMPOTENCY_RECORD_PURGE } from '@keel-system/keel-core/gen/request-idempotency';
import { usesPersistence, usesRelational } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { sqlDialect } from '../lib/relational-engine.js';
import { layout, packageFile } from './render.js';
import { usesGoOutbox, usesGoProcessedEvents } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { RECONCILIATION_CLAIM } from '@keel-system/keel-core/gen/reconciliation-stores';
import { reconciliationPurge } from './reconciliation-claim.js';

/**
 * Las purgas de ESTE diseño, como datos: qué tabla, por qué columna se corta, qué condición propia lleva (lo pendiente
 * del outbox no se toca nunca), con qué retención y bajo qué prefijo de configuración. Las mismas que keel-nest.
 */
export function tablePurges(model) {
  if (!usesPersistence(model)) return [];
  const purges = [];
  if (usesGoOutbox(model)) {
    purges.push({
      field: 'Outbox',
      what: 'outbox_event',
      constructor: 'NewOutboxPurge',
      table: OUTBOX_EVENT.table,
      column: 'published_at',
      predicate: 'published_at IS NOT NULL',
      prefix: 'outbox.purge',
      cron: OUTBOX_PURGE.cron,
      retentionDays: OUTBOX_PURGE.retentionDays
    });
  }
  if (usesGoProcessedEvents(model)) {
    purges.push({
      field: 'ProcessedEvent',
      what: 'processed_event',
      constructor: 'NewProcessedEventPurge',
      table: PROCESSED_EVENT.table,
      column: 'processed_at',
      predicate: null,
      prefix: 'processed-event.purge',
      cron: PROCESSED_EVENT_PURGE.cron,
      retentionDays: PROCESSED_EVENT_PURGE.retentionDays
    });
  }
  if (usesRequestIdempotency(model)) {
    purges.push({
      field: 'IdempotencyRecord',
      what: 'idempotency_record',
      constructor: 'NewIdempotencyRecordPurge',
      table: IDEMPOTENCY_RECORD.table,
      column: 'expires_at',
      predicate: null,
      prefix: 'idempotency-record.purge',
      cron: IDEMPOTENCY_RECORD_PURGE.cron,
      // Sin retención: cada fila lleva su caducidad (expires_at), calculada con el ttlSeconds del diseño.
      retentionDays: null
    });
  }
  // Las marcas del reclamo de reconciliación (tramo 11c): la misma purga que keel-nest y keel-dotnet.
  const reconciliation = reconciliationPurge(model);
  if (reconciliation) purges.push(reconciliation);
  // Las columnas que se nombran tienen que existir en los datos de la tabla: si keel-core renombrara una, la purga
  // borraría por una columna que no está y fallaría cada noche sin que nada lo dijera antes.
  for (const purge of purges) {
    const table = [OUTBOX_EVENT, PROCESSED_EVENT, IDEMPOTENCY_RECORD, RECONCILIATION_CLAIM].find((candidate) => candidate.table === purge.table);
    if (!table.columns.some((column) => column.name === purge.column)) {
      throw new Error(`La purga de ${purge.table} corta por ${purge.column}, que no es columna de la tabla en keel-core`);
    }
  }
  return purges;
}

export function usesTablePurges(model) {
  return tablePurges(model).length > 0;
}

/** Las dos sentencias de una purga: la frontera del lote y el borrado, con la MISMA condición. */
export function purgeStatements(model, purge) {
  const p = sqlDialect(model).param;
  const where = (cutoff) => [purge.predicate, `${purge.column} < ${cutoff}`].filter(Boolean).join(' AND ');
  return {
    boundary: `SELECT ${purge.column} FROM ${purge.table} WHERE ${where(p(1))} ORDER BY ${purge.column} LIMIT 1 OFFSET ${p(2)}`,
    delete: `DELETE FROM ${purge.table} WHERE ${where(p(1))} AND ${purge.column} <= ${p(2)}`
  };
}

/**
 * Los casos con los que la prueba emitida ejecuta el bucle: instantes en ms (con repetidos en la frontera y con tope), el
 * corte en 1000, y lo que sale según la REFERENCIA de keel-core (`batchedPurgeReference`). `test/scheduling.test.js`
 * vuelve a calcular cada resultado con la referencia: si alguien toca un número aquí, cae allí. Son los de keel-dotnet.
 */
export const PURGE_CASES = Object.freeze([
  { instants: [], batchSize: 3, maxBatches: 5, deleted: 0, deletes: 1, exhausted: false, remaining: [] },
  { instants: [10, 20], batchSize: 3, maxBatches: 5, deleted: 2, deletes: 1, exhausted: false, remaining: [] },
  { instants: [10, 20, 20, 20, 30, 40, 50, 60, 1500, 2000], batchSize: 3, maxBatches: 5, deleted: 8, deletes: 3, exhausted: false, remaining: [1500, 2000] },
  {
    instants: Array.from({ length: 20 }, (_, i) => i * 10),
    batchSize: 2,
    maxBatches: 3,
    deleted: 6,
    deletes: 3,
    exhausted: true,
    remaining: Array.from({ length: 14 }, (_, i) => 60 + i * 10)
  }
]);
export const PURGE_CASES_CUTOFF = 1000;

/** El SQL de las purgas, en el paquete del motor. */
export function generate(model) {
  const purges = tablePurges(model);
  // Sobre documentos, el bucle por lotes de document-stores.js.
  if (purges.length === 0 || !usesRelational(model)) return [];
  const { store } = layout(model);
  return [{ path: `${store.dir}/purges.go`, content: packageFile(model, store, { imports: ['context', 'database/sql', 'time'], body: storeBody(model, purges) }) }];
}

function storeBody(model, purges) {
  const d = sqlDialect(model);
  const constructors = purges.map((purge) => {
    const sql = purgeStatements(model, purge);
    return `// ${purge.constructor} es la purga de ${purge.what}${purge.predicate ? ` (solo ${purge.predicate}: lo pendiente no se toca nunca)` : ''}, cortada por
// ${purge.column}.
func ${purge.constructor}(tx *Transactions) *TablePurge {
	return &TablePurge{
		tx:       tx,
		boundary: ${goString(sql.boundary)},
		delete:   ${goString(sql.delete)},
	}
}`;
  });
  return `
// TablePurge es la purga por lotes de una tabla del generador sobre ${d.label}: el puerto scheduler.PurgeTable. La
// frontera y el borrado llevan la MISMA condición: la frontera tiene que contar las filas que el borrado se lleva, o el
// lote deja de medir lo que dice.
type TablePurge struct {
	tx       *Transactions
	boundary string
	delete   string
}

${constructors.join('\n\n')}

// Boundary es el instante de la fila en la posición position entre las anteriores a cutoff, y false si quedan menos.
func (p *TablePurge) Boundary(ctx context.Context, cutoff time.Time, position int) (time.Time, bool, error) {
	q, err := p.tx.conn(ctx)
	if err != nil {
		return time.Time{}, false, err
	}
	rows, err := q.QueryContext(ctx, p.boundary, cutoff.UTC(), position)
	if err != nil {
		return time.Time{}, false, translate(err)
	}
	defer rows.Close()
	if !rows.Next() {
		return time.Time{}, false, translate(rows.Err())
	}
	var at time.Time
	if err := rows.Scan(&at); err != nil {
		return time.Time{}, false, err
	}
	return at, true, translate(rows.Err())
}

// DeleteUpTo borra lo anterior a cutoff hasta upTo incluido, en una transacción PROPIA (con el tope de transacción del
// servicio): confirma y suelta sus bloqueos antes del lote siguiente. Devuelve las filas borradas.
func (p *TablePurge) DeleteUpTo(ctx context.Context, cutoff, upTo time.Time) (int64, error) {
	var deleted int64
	err := p.tx.fresh(ctx, sql.TxOptions{}, func(ctx context.Context, q DBTX) error {
		result, err := q.ExecContext(ctx, p.delete, cutoff.UTC(), upTo.UTC())
		if err != nil {
			return err
		}
		deleted, err = result.RowsAffected()
		return err
	})
	return deleted, err
}
`;
}
