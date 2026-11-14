// El almacén de los LOTES ASÍNCRONOS (DSL 2.30, fase B de PLAN-DSL-230-LOTES.md: D8-D11 y D13), como DATOS: lo mismo en
// los cuatro generadores, que comparten base y esquema, como el historial (history-store.js) o el cronómetro
// (timer-store.js). Lo que cambia entre lenguajes (el procesador, las dos rutas, la lectura del sobre guardado) es de cada
// uno; las SENTENCIAS por motor son de aquí, porque son contrato de los cuatro, y las mide `scripts/timer-sql-check.js`
// contra PostgreSQL y MySQL.
//
// Dos tablas:
//   · `batch_job`, el trabajo: quién lo creó (D11), su estado, la clave de idempotencia con su firma y su ventana (D13), la
//     petición tal como llegó (el sobre se vuelve a leer con el lector del borde de cada generador) y el CURSOR, el índice
//     del siguiente elemento por procesar, con los contadores;
//   · `batch_item_result`, un resultado por elemento intentado, con la forma del cable (D10). Se va con su trabajo.
//
// Lo que NO tiene: un reclamo propio. Cada trabajo arma un temporizador de una vez en `keel_timer` (`batchKind`), y el
// arriendo, la valla, los reintentos y el aparcado son los del cronómetro, medidos con dos réplicas (D9).
//
// La valla del elemento es el cursor: `advance` solo avanza si sigue donde lo dejó quien procesa (`next_index = :index`), y
// va en la MISMA transacción que el efecto del elemento y su resultado. Si otra réplica le quitó el trabajo (su arriendo
// venció a mitad de chunk), el elemento revierte entero: ningún elemento se aplica dos veces ni se queda sin resultado.

// ─── Las tablas, como DATOS ──────────────────────────────────────────────────

/**
 * `batch_job`. `next_index` y no `cursor`, ni `item_index` y no `index` en la otra: las dos son palabras reservadas de MySQL.
 *
 *   · operation y owner acotan todo: la clave de idempotencia es única por (operation, owner, clave), y un trabajo solo lo
 *     lee quien lo creó (D11). owner es el actor de `authorship` del que lo creó;
 *   · idempotency_key, signature y key_expires_at son la clave del lote (D13): la firma distingue el reintento de la clave
 *     reutilizada, y key_expires_at (null: sin ventana) dice hasta cuándo vale; pasada, el alta siguiente la libera;
 *   · input es el cuerpo de la petición tal como llegó, en texto: el sobre (lo común a todos los elementos) y la lista;
 *   · next_index es el cursor (D9): todo elemento por debajo tiene su resultado guardado;
 *   · finished_at, con su índice, es lo que mira la purga (D10): un trabajo en marcha no se purga nunca.
 */
export const BATCH_JOB = Object.freeze({
  table: 'batch_job',
  columns: Object.freeze([
    { name: 'id', base: 'uuid', nullable: false, primary: true },
    { name: 'operation', base: 'string', length: 160, nullable: false },
    { name: 'owner', base: 'string', length: 255, nullable: false },
    { name: 'status', base: 'string', length: 16, nullable: false },
    { name: 'idempotency_key', base: 'string', length: 255, nullable: true },
    { name: 'signature', base: 'string', length: 128, nullable: true },
    { name: 'key_expires_at', base: 'timestamp', nullable: true },
    { name: 'input', base: 'text', nullable: false },
    { name: 'total', base: 'int', nullable: false },
    { name: 'next_index', base: 'int', nullable: false },
    { name: 'succeeded', base: 'int', nullable: false },
    { name: 'failed', base: 'int', nullable: false },
    { name: 'created_at', base: 'timestamp', nullable: false },
    { name: 'updated_at', base: 'timestamp', nullable: false },
    { name: 'finished_at', base: 'timestamp', nullable: true }
  ]),
  // Dos claves NULL no chocan en una constraint única (PostgreSQL y MySQL): un trabajo sin clave no ocupa ninguna.
  uniques: Object.freeze([{ name: 'uq_batch_job_key', columns: ['operation', 'owner', 'idempotency_key'] }]),
  indexes: Object.freeze([{ name: 'ix_batch_job_finished_at', columns: ['finished_at'] }])
});

/** `batch_item_result`: un resultado por elemento INTENTADO, con las claves del cable (`batchItem` de batch.js). */
export const BATCH_ITEM_RESULT = Object.freeze({
  table: 'batch_item_result',
  columns: Object.freeze([
    { name: 'job_id', base: 'uuid', nullable: false, primary: true, references: { table: 'batch_job', column: 'id', onDelete: 'cascade', name: 'fk_batch_item_result_job' } },
    { name: 'item_index', base: 'int', nullable: false, primary: true },
    { name: 'status', base: 'string', length: 16, nullable: false },
    { name: 'error_code', base: 'string', length: 100, nullable: true },
    { name: 'message', base: 'text', nullable: true },
    // El `result` del elemento serializado con las reglas del cable, y viaja TAL CUAL (como `changes` del historial).
    { name: 'result', base: 'text', nullable: true }
  ]),
  indexes: Object.freeze([])
});

/** Los estados de un trabajo (D8, con D14: un lote asíncrono es `per-item`, así que no hay «revertido»). */
export const BATCH_JOB_STATUSES = Object.freeze({
  // Creado: nada procesado todavía.
  queued: 'queued',
  // Al menos un elemento con su resultado.
  running: 'running',
  // Todos los elementos intentados (cada uno succeeded o failed).
  completed: 'completed',
  // Detenido por un elemento que no falla solo él (D4): los que quedan son notAttempted.
  aborted: 'aborted'
});

/** Los estados terminados: lo único que la purga se lleva. */
export const BATCH_JOB_FINISHED = Object.freeze([BATCH_JOB_STATUSES.completed, BATCH_JOB_STATUSES.aborted]);

/**
 * Las colecciones del modelo documental, con los mismos nombres de campo que las columnas. El trabajo lleva su id (texto)
 * en `_id`; el resultado, la clave aplanada `<job_id>|<item_index>` (`batchResultDocumentId`), que hace que el motor
 * rechace un segundo resultado del mismo elemento. La unicidad de la clave de idempotencia es PARCIAL: solo los trabajos
 * que tienen una (`idempotency_key` de tipo texto), porque en MongoDB dos ausentes sí chocan.
 */
export const BATCH_JOB_COLLECTIONS = Object.freeze({
  job: Object.freeze({
    collection: BATCH_JOB.table,
    indexes: Object.freeze([
      Object.freeze({
        name: 'uq_batch_job_key',
        keys: Object.freeze([['operation', 1], ['owner', 1], ['idempotency_key', 1]]),
        unique: true,
        partialFilter: Object.freeze({ idempotency_key: Object.freeze({ $type: 'string' }) })
      }),
      Object.freeze({ name: 'ix_batch_job_finished_at', keys: Object.freeze([['finished_at', 1]]) })
    ])
  }),
  result: Object.freeze({
    collection: BATCH_ITEM_RESULT.table,
    indexes: Object.freeze([Object.freeze({ name: 'ix_batch_item_result_job', keys: Object.freeze([['job_id', 1], ['item_index', 1]]) })])
  })
});

/** El `_id` de un resultado en el modelo documental: el trabajo y el índice, aplanados. */
export function batchResultDocumentId(jobId, index) {
  return `${jobId}|${index}`;
}

// ─── El temporizador de cada trabajo y los parámetros ────────────────────────

/** `batch:<operación>`: el temporizador de UNA VEZ de cada trabajo de esa operación, con el id del trabajo en entity_id. */
export const batchKind = (operationName) => `batch:${operationName}`;

/**
 * Mecánica del generador, no del diseño, con la clave, la variable y el default que comparten los cuatro:
 *   · chunkSize: cuántos elementos procesa cada disparo del temporizador (el *commit interval* de Spring Batch, D9). Por
 *     debajo del arriendo del cronómetro (`timer.lease-ms`): un chunk que tarda más que su arriendo lo tomaría otra réplica,
 *     y la valla del cursor revertiría lo que esta aún procesa;
 *   · retentionDays: cuánto vive un trabajo TERMINADO con sus resultados (D10);
 *   · purgeCron: cuándo corre esa purga, un recurrente más del cronómetro, en modo clúster.
 */
export const BATCH_PARAMETERS = Object.freeze({
  chunkSize: Object.freeze({ key: 'batch.chunk-size', env: 'BATCH_CHUNK_SIZE', default: 100 }),
  retentionDays: Object.freeze({ key: 'batch.retention-days', env: 'BATCH_RETENTION_DAYS', default: 7 }),
  purgeCron: Object.freeze({ key: 'batch.purge.cron', env: 'BATCH_PURGE_CRON', default: '0 15 5 * * *', cron: true })
});

// ─── Las sentencias (relacional) ─────────────────────────────────────────────
//
// Con marcadores nombrados (`:id`), como las del cronómetro: `bindNamed` (timer-store.js) los pasa al estilo de cada
// driver. Toda hora es la del MOTOR, como en el cronómetro: con varias réplicas sus relojes se desvían.

const JOB_COLUMNS = 'id, operation, owner, status, idempotency_key, signature, key_expires_at, input, total, next_index, succeeded, failed, created_at, updated_at, finished_at';
const RESULT_COLUMNS = 'item_index, status, error_code, message, result';

const DIALECTS = Object.freeze({
  postgresql: {
    now: 'current_timestamp',
    // Con :ttlMs NULL el resultado es NULL (sin ventana); el CAST le da tipo al parámetro.
    plusMs: (param) => `current_timestamp + (CAST(:${param} AS bigint) * interval '1 millisecond')`,
    minusDays: (param) => `current_timestamp - (CAST(:${param} AS integer) * interval '1 day')`
  },
  mysql: {
    // UTC_TIMESTAMP, como el cronómetro: `datetime` no guarda zona y los cuatro servidores escriben en UTC.
    now: 'utc_timestamp(6)',
    plusMs: (param) => `DATE_ADD(utc_timestamp(6), INTERVAL CAST(:${param} AS SIGNED) * 1000 MICROSECOND)`,
    minusDays: (param) => `DATE_SUB(utc_timestamp(6), INTERVAL CAST(:${param} AS SIGNED) DAY)`
  }
});

/** Los motores para los que hay sentencias de los lotes asíncronos: los del cronómetro. */
export const BATCH_STORE_ENGINES = Object.freeze(Object.keys(DIALECTS));

/** Las sentencias de los lotes asíncronos para un motor relacional. */
export function batchStatements(engine) {
  const d = DIALECTS[engine];
  if (!d) throw new Error(`los lotes asíncronos no tienen sentencias para '${engine}' (las hay para ${BATCH_STORE_ENGINES.join(', ')})`);
  const j = BATCH_JOB.table;
  const r = BATCH_ITEM_RESULT.table;
  const live = `(key_expires_at IS NULL OR key_expires_at > ${d.now})`;
  const ofKey = 'operation = :operation AND owner = :owner AND idempotency_key = :key';
  return Object.freeze({
    // El alta (D8): en la MISMA transacción que el temporizador del trabajo (`arm` de timer-store.js con batchKind). La
    // clave y su firma pueden ser NULL (sin idempotency); :ttlMs NULL deja la clave sin ventana.
    insertJob:
      `INSERT INTO ${j} (${JOB_COLUMNS}) VALUES (:id, :operation, :owner, '${BATCH_JOB_STATUSES.queued}', :key, :signature, ` +
      `${d.plusMs('ttlMs')}, :input, :total, 0, 0, 0, ${d.now}, ${d.now}, NULL)`,
    // La repetición (D13): el trabajo vivo de esa clave, con su firma para distinguir el reintento de la clave reutilizada.
    byKey: `SELECT id, signature FROM ${j} WHERE ${ofKey} AND ${live}`,
    // Pasada la ventana, la clave se libera ANTES del alta, en su transacción: el trabajo viejo sigue legible por su id.
    releaseKey: `UPDATE ${j} SET idempotency_key = NULL WHERE ${ofKey} AND key_expires_at <= ${d.now}`,
    // Lo que lee el procesador al disparar el temporizador.
    job: `SELECT ${JOB_COLUMNS} FROM ${j} WHERE id = :id`,
    // Lo que leen las dos rutas (D11): de otro dueño u otra operación es como si no existiera (404).
    ownedJob: `SELECT ${JOB_COLUMNS} FROM ${j} WHERE id = :id AND operation = :operation AND owner = :owner`,
    // El resultado de un elemento y el avance del cursor, en la transacción del elemento (D9). `advance` es la valla: si no
    // toca una fila, el cursor ya no está donde lo dejó este procesador, y la transacción entera revierte.
    insertResult: `INSERT INTO ${r} (job_id, ${RESULT_COLUMNS}) VALUES (:jobId, :index, :status, :errorCode, :message, :result)`,
    advance:
      `UPDATE ${j} SET next_index = next_index + 1, succeeded = succeeded + :succeeded, failed = failed + :failed, ` +
      `status = '${BATCH_JOB_STATUSES.running}', updated_at = ${d.now} WHERE id = :id AND next_index = :index`,
    // El final: completed cuando el cursor llega al total, aborted cuando un elemento detiene el lote (D4). Solo una vez.
    finish: `UPDATE ${j} SET status = :status, finished_at = ${d.now}, updated_at = ${d.now} WHERE id = :id AND finished_at IS NULL`,
    // Los resultados, en orden de índice, con el sobre de página del cable.
    resultsPage: `SELECT ${RESULT_COLUMNS} FROM ${r} WHERE job_id = :jobId ORDER BY item_index LIMIT :limit OFFSET :offset`,
    resultsCount: `SELECT count(*) FROM ${r} WHERE job_id = :jobId`,
    // La purga (D10): los trabajos terminados hace más de la retención, primero sus resultados. La FK ya borra en cascada,
    // pero no se depende de ella, como en el historial.
    purgeResults: `DELETE FROM ${r} WHERE job_id IN (SELECT id FROM ${j} WHERE finished_at < ${d.minusDays('retentionDays')})`,
    purgeJobs: `DELETE FROM ${j} WHERE finished_at < ${d.minusDays('retentionDays')}`
  });
}
