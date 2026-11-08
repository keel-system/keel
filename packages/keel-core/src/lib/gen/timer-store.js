// El cronómetro del servicio (DSL 2.26, PLAN-DSL-226-PLAZOS.md § El cronómetro): UNA tabla de temporizadores y un
// sondeador por réplica, para todo lo que corre por tiempo. Es lo mismo en los cuatro generadores —el servidor de cada
// uno comparte base, esquema y variables de entorno con los demás—, así que se decide aquí: la tabla, sus parámetros, el
// nombre de cada temporizador y las SENTENCIAS, que en este mecanismo son contrato y no detalle de cada lenguaje.
//
// Dos clases de temporizador en la misma tabla:
//   · un PLAZO es de una sola vez y lleva su entidad: se arma al entrar en el estado (en la misma transacción) y se borra
//     al dispararse;
//   · un RECURRENTE es una fila por mecanismo (un `schedule`, una purga, el relay): al dispararse se rearma para el
//     siguiente tick. Lleva el uuid nulo en `entity_id`, y no NULL: la unicidad (kind, entity_id) no se cumpliría con
//     NULL, que en una constraint única nunca choca con otro NULL.
//
// La hora que compara el cronómetro es SIEMPRE la de la base (T1): con varias réplicas sus relojes se desvían, y una sola
// fuente hace que ninguna dispare antes que otra. `due_at` de un plazo es `since + after`, con `since` el valor del campo
// de la entidad; la de un recurrente la calcula el generador desde la hora de la base (`dbNow`) con el cron en UTC (T7).

import { DEADLINE_UNIT_SECONDS } from './deadlines.js';

// ─── La tabla, como DATOS ────────────────────────────────────────────────────

/** El `entity_id` de un temporizador recurrente: no hay entidad, y la unicidad (kind, entity_id) necesita un valor. */
export const NIL_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

/**
 * `keel_timer`.
 *
 *   · due_at, con su índice: lo que reclama el sondeador y lo que le dice cuánto dormir;
 *   · claimed_until es el arriendo: mientras no venza, ninguna otra réplica toma la fila;
 *   · claim_token es la VALLA: la réplica que reclamó escribe su token, y todo lo que hace después (borrar, rearmar,
 *     contar un fallo) lleva `WHERE claim_token = :token`. Comparar el arriendo por su instante no sirve: un lenguaje que
 *     lee la marca en milisegundos no casaría con la columna en microsegundos;
 *   · spec es el cron o el periodo de un recurrente, para ver al arrancar si cambió con el despliegue;
 *   · parked_at: el temporizador que agotó sus intentos se aparca —deja de reclamarse— y lo cuenta una métrica (T5).
 */
export const KEEL_TIMER = Object.freeze({
  table: 'keel_timer',
  columns: Object.freeze([
    { name: 'id', base: 'uuid', nullable: false, primary: true },
    { name: 'kind', base: 'string', length: 160, nullable: false },
    { name: 'entity_id', base: 'uuid', nullable: false },
    { name: 'spec', base: 'string', length: 120, nullable: true },
    { name: 'due_at', base: 'timestamp', nullable: false },
    { name: 'claimed_until', base: 'timestamp', nullable: true },
    { name: 'claim_token', base: 'uuid', nullable: true },
    { name: 'attempts', base: 'int', nullable: false },
    { name: 'parked_at', base: 'timestamp', nullable: true }
  ]),
  uniques: Object.freeze([{ name: 'uq_keel_timer_kind_entity', columns: ['kind', 'entity_id'] }]),
  indexes: Object.freeze([{ name: 'ix_keel_timer_due_at', columns: ['due_at'] }])
});

/**
 * El `_id` del temporizador en el modelo documental: la clave (kind, entity_id) aplanada, como la marca de reconciliación.
 * Es lo que hace que el motor arbitre dos armados a la vez sin transacción ninguna.
 */
export function timerDocumentId(kind, entityId = NIL_ENTITY_ID) {
  return `${kind}|${entityId}`;
}

// ─── Los parámetros ──────────────────────────────────────────────────────────
//
// Mecánica del generador, no del diseño (D6 del plan): la precisión del cronómetro no es contrato porque el rechazo
// tardío lo hace el dominio en el instante exacto.

export const TIMER_PARAMETERS = Object.freeze({
  // Cuánto duerme como mucho el sondeador sin plazos próximos: lo que tarda en ver lo que arma OTRA réplica.
  maxSleepMs: Object.freeze({ key: 'timer.max-sleep-ms', env: 'TIMER_MAX_SLEEP_MS', default: 30000 }),
  batchSize: Object.freeze({ key: 'timer.batch-size', env: 'TIMER_BATCH_SIZE', default: 50 }),
  // Mayor que lo que tarda un lote (T4): si fuera menor, otra réplica le quitaría a una lenta lo que aún procesa.
  leaseMs: Object.freeze({ key: 'timer.lease-ms', env: 'TIMER_LEASE_MS', default: 120000 }),
  maxAttempts: Object.freeze({ key: 'timer.max-attempts', env: 'TIMER_MAX_ATTEMPTS', default: 10 }),
  // Tras un fallo, cuándo se vuelve a intentar: no en el siguiente sueño, que con un handler roto sería en bucle.
  retryDelayMs: Object.freeze({ key: 'timer.retry-delay-ms', env: 'TIMER_RETRY_DELAY_MS', default: 30000 }),
  // Cuánto puede durar como mucho el tick de un `schedule` que DRENA (repite la pasada mientras su lote sale lleno). Menor
  // que el arriendo (T4): un tick más largo que su arriendo lo repetiría otra réplica en paralelo. timer-plan.js.
  drainBudgetMs: Object.freeze({ key: 'timer.drain-budget-ms', env: 'TIMER_DRAIN_BUDGET_MS', default: 60000 }),
  // La purga de la propia tabla (R7): un temporizador vencido hace más que esto y sin reclamar es de un `kind` que ya no
  // existe (R4), o uno aparcado que ya se vio.
  retentionDays: Object.freeze({ key: 'timer.retention-days', env: 'TIMER_RETENTION_DAYS', default: 7 }),
  // Cuándo corre esa purga: un recurrente más de la propia tabla, en modo clúster y con el cron en UTC (T7).
  purgeCron: Object.freeze({ key: 'timer.purge.cron', env: 'TIMER_PURGE_CRON', default: '0 30 5 * * *', cron: true })
});

/**
 * El interruptor del cronómetro (§ Incremento 0, punto 5): uno solo en los cuatro. Apagado, la réplica no sondea —los
 * temporizadores se siguen ARMANDO, porque eso es persistencia y no reloj—. El perfil `test` lo apaga: arranca sin base
 * real o sin la tabla.
 */
export const TIMER_SWITCH = Object.freeze({ key: 'scheduling.enabled', env: 'SCHEDULING_ENABLED', default: true });

// ─── El nombre de cada temporizador ──────────────────────────────────────────

/** `schedule:<operación>`: el `schedule` de una operación del diseño. */
export const scheduleKind = (operationName) => `schedule:${operationName}`;
/** `purge:<tabla>`: la purga de una tabla del generador. */
export const purgeKind = (table) => `purge:${table}`;
/** El relay del outbox, por réplica. */
export const RELAY_KIND = 'relay:outbox';
/** La purga de la propia tabla. */
export const TIMER_PURGE_KIND = purgeKind(KEEL_TIMER.table);

/**
 * Los dos modos (§ La migración de los relojes): en CLÚSTER cada tick lo ejecuta UNA réplica, la que gana la fila; POR
 * RÉPLICA cada una tiene su tick y la tabla no decide nada.
 */
export const TIMER_MODES = Object.freeze({ cluster: 'cluster', replica: 'replica' });

// ─── Las sentencias ──────────────────────────────────────────────────────────
//
// Con marcadores nombrados (`:id`); `bindNamed` los pasa al estilo de cada driver. `:kinds` es una lista y se expande con
// `expandList` antes. El RECLAMO son tres sentencias y no una para que sean las MISMAS en los dos motores: MySQL no deja
// actualizar una tabla con una subconsulta sobre ella misma, y no tiene RETURNING. Las tres van en UNA transacción:
//   1. `claimLock` bloquea los candidatos saltándose los bloqueados (SKIP LOCKED: dos réplicas toman lotes disjuntos);
//   2. `claimMark` les pone el arriendo y la valla;
//   3. `claimed` lee lo que esta réplica reclamó, por su valla.

const COLUMNS = 'id, kind, entity_id, spec, due_at, claimed_until, claim_token, attempts, parked_at';
const CLAIMABLE = 'kind IN (:kinds) AND parked_at IS NULL AND due_at <= {now} AND (claimed_until IS NULL OR claimed_until < {now})';

const DIALECTS = Object.freeze({
  postgresql: {
    now: 'current_timestamp',
    plusMs: (expression, param) => `${expression} + (CAST(:${param} AS bigint) * interval '1 millisecond')`,
    minusMs: (expression, param) => `${expression} - (CAST(:${param} AS bigint) * interval '1 millisecond')`,
    minusDays: (param) => `current_timestamp - (CAST(:${param} AS integer) * interval '1 day')`,
    upsert: (assignments) =>
      `ON CONFLICT (kind, entity_id) DO UPDATE SET ${assignments.map(([column, value]) => `${column} = ${value.replace(/new\./g, 'EXCLUDED.')}`).join(', ')}`,
    rowAlias: '',
    msUntil: (expression) => `CAST(EXTRACT(EPOCH FROM (${expression} - current_timestamp)) * 1000 AS bigint)`,
    distinct: (a, b) => `${a} IS DISTINCT FROM ${b}`
  },
  mysql: {
    // UTC_TIMESTAMP y no current_timestamp: `datetime` no guarda zona, y los cuatro servidores escriben ahí la hora en
    // UTC (Hibernate, TypeORM, EF y database/sql). current_timestamp sería la de la zona de la SESIÓN, que en un
    // despliegue no tiene por qué ser UTC, y el cronómetro dispararía con horas de diferencia.
    now: 'utc_timestamp(6)',
    plusMs: (expression, param) => `DATE_ADD(${expression}, INTERVAL CAST(:${param} AS SIGNED) * 1000 MICROSECOND)`,
    minusMs: (expression, param) => `DATE_SUB(${expression}, INTERVAL CAST(:${param} AS SIGNED) * 1000 MICROSECOND)`,
    minusDays: (param) => `DATE_SUB(utc_timestamp(6), INTERVAL CAST(:${param} AS SIGNED) DAY)`,
    upsert: (assignments) => `ON DUPLICATE KEY UPDATE ${assignments.map(([column, value]) => `${column} = ${value}`).join(', ')}`,
    // La fila que se intentaba insertar, con nombre: VALUES() está obsoleto desde 8.0.20.
    rowAlias: ' AS new',
    msUntil: (expression) => `TIMESTAMPDIFF(MICROSECOND, utc_timestamp(6), ${expression}) DIV 1000`,
    distinct: (a, b) => `NOT (${a} <=> ${b})`
  }
});

/** Los motores para los que hay sentencias del cronómetro. Otro motor relacional no tiene cronómetro hasta que se mida. */
export const TIMER_ENGINES = Object.freeze(Object.keys(DIALECTS));

/**
 * Las sentencias del cronómetro para un motor relacional. Cada una con marcadores nombrados; las que llevan `:kinds`
 * necesitan `expandList` primero.
 */
export function timerStatements(engine) {
  const d = DIALECTS[engine];
  if (!d) throw new Error(`el cronómetro no tiene sentencias para '${engine}' (las hay para ${TIMER_ENGINES.join(', ')})`);
  const claimable = CLAIMABLE.replaceAll('{now}', d.now);
  const insert = `INSERT INTO ${KEEL_TIMER.table} (${COLUMNS}) VALUES (:id, :kind, :entityId, :spec, :dueAt, NULL, NULL, 0, NULL)${d.rowAlias}`;
  return Object.freeze({
    // La hora de la base: de ella sale el siguiente tick de un recurrente.
    dbNow: `SELECT ${d.now}`,
    // Armar un plazo (o rearmarlo, si la entidad vuelve a entrar en el estado): borra el arriendo, la valla y los intentos.
    arm:
      `${insert} ` +
      d.upsert([
        ['due_at', 'new.due_at'],
        ['claimed_until', 'NULL'],
        ['claim_token', 'NULL'],
        ['attempts', '0'],
        ['parked_at', 'NULL']
      ]),
    // Asegurar un recurrente al arrancar (R1): si ya está, solo se toca si su spec cambió con el despliegue. En MySQL el
    // orden de las asignaciones importa (se evalúan de izquierda a derecha con los valores ya asignados): due_at antes que
    // spec, para que compare con el spec viejo.
    ensureRecurring:
      `${insert} ` +
      (engine === 'postgresql'
        ? `ON CONFLICT (kind, entity_id) DO UPDATE SET due_at = EXCLUDED.due_at, spec = EXCLUDED.spec WHERE ${d.distinct(`${KEEL_TIMER.table}.spec`, 'EXCLUDED.spec')}`
        : // Calificadas con la tabla: con el alias de fila `new`, MySQL no sabe de cuál es `spec` a secas (ERROR 1052,
          // medido en scripts/timer-sql-check.js).
          d.upsert([
            ['due_at', `IF(${d.distinct(`${KEEL_TIMER.table}.spec`, 'new.spec')}, new.due_at, ${KEEL_TIMER.table}.due_at)`],
            ['spec', 'new.spec']
          ])),
    claimLock: `SELECT id FROM ${KEEL_TIMER.table} WHERE ${claimable} ORDER BY due_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
    claimMark: `UPDATE ${KEEL_TIMER.table} SET claimed_until = ${d.plusMs(d.now, 'leaseMs')}, claim_token = :token WHERE id IN (:ids)`,
    claimed: `SELECT ${COLUMNS} FROM ${KEEL_TIMER.table} WHERE claim_token = :token ORDER BY due_at`,
    // Un plazo cumplido, o descartado por la revalidación: fuera, solo si sigue siendo de quien lo reclamó.
    complete: `DELETE FROM ${KEEL_TIMER.table} WHERE id = :id AND claim_token = :token`,
    // Un recurrente que hizo su tick, o un plazo que la revalidación rearma (el `after` vigente es más largo).
    reschedule: `UPDATE ${KEEL_TIMER.table} SET due_at = :dueAt, claimed_until = NULL, claim_token = NULL, attempts = 0 WHERE id = :id AND claim_token = :token`,
    // Un fallo: cuenta el intento, se vuelve a intentar tras el retraso y, al agotar los intentos, se aparca. parked_at va
    // PRIMERO: en MySQL las asignaciones ven los valores ya asignados, y attempts tiene que ser el de antes.
    fail:
      `UPDATE ${KEEL_TIMER.table} SET parked_at = CASE WHEN attempts + 1 >= :maxAttempts THEN ${d.now} ELSE NULL END, ` +
      `attempts = attempts + 1, due_at = ${d.plusMs(d.now, 'retryDelayMs')}, claimed_until = NULL, claim_token = NULL ` +
      'WHERE id = :id AND claim_token = :token',
    // Cuánto falta para el siguiente vencimiento que esta réplica podría reclamar (null: ninguno). Un temporizador arrendado
    // cuenta desde que vence su arriendo, no desde su due_at.
    nextDueMs:
      `SELECT ${d.msUntil(`min(CASE WHEN claimed_until IS NOT NULL AND claimed_until > due_at THEN claimed_until ELSE due_at END)`)} ` +
      `FROM ${KEEL_TIMER.table} WHERE kind IN (:kinds) AND parked_at IS NULL`,
    // Los aparcados: lo que mide la métrica de T5.
    parkedCount: `SELECT count(*) FROM ${KEEL_TIMER.table} WHERE parked_at IS NOT NULL`,
    // La purga de la tabla (R4 y R7): vencido hace más de la retención y sin reclamar. Un `kind` que ninguna réplica conoce
    // no lo reclama nadie, así que acaba aquí, y nunca lo borra una réplica que no lo conoce (podría ser de otra versión).
    purge: `DELETE FROM ${KEEL_TIMER.table} WHERE due_at < ${d.minusDays('retentionDays')} AND claim_token IS NULL`,
    // El arnés: adelantar un temporizador para no esperar a su vencimiento real.
    fire: `UPDATE ${KEEL_TIMER.table} SET due_at = ${d.now}, claimed_until = NULL, claim_token = NULL WHERE kind = :kind`,
    // El arnés: envejecer el temporizador de una entidad (con su `since`, que lo envejece el arnés en la tabla de la entidad).
    age: `UPDATE ${KEEL_TIMER.table} SET due_at = ${d.minusMs('due_at', 'ageMs')} WHERE kind = :kind AND entity_id = :entityId`
  });
}

/** Expande un marcador de lista (`:kinds`) en `count` marcadores numerados (`:kinds0, :kinds1…`). */
export function expandList(sql, name, count) {
  if (count < 1) throw new Error(`la lista :${name} necesita al menos un elemento`);
  const markers = Array.from({ length: count }, (_, index) => `:${name}${index}`).join(', ');
  return sql.replaceAll(`:${name})`, `${markers})`);
}

/**
 * Pasa los marcadores nombrados al estilo de un driver: `question` (`?`, JDBC, mysql2, MySqlConnector) o `dollar` (`$1`,
 * pg, Npgsql, pgx). Devuelve `{ sql, names }`, con los nombres en el orden en que hay que pasar los valores. Un marcador
 * repetido se repite en `names`.
 */
export function bindNamed(sql, style) {
  const names = [];
  const bound = sql.replace(/(?<![:\w]):([a-zA-Z][a-zA-Z0-9]*)/g, (match, name) => {
    names.push(name);
    return style === 'dollar' ? `$${names.length}` : '?';
  });
  return { sql: bound, names };
}

// ─── El modelo documental ────────────────────────────────────────────────────

/**
 * El temporizador en MongoDB: un documento por (kind, entity_id) con el `_id` aplanado, las mismas claves que las columnas
 * y el índice de `due_at`. El reclamo es `findOneAndUpdate` de uno en uno (no hay SKIP LOCKED); la hora es `$$NOW`, la del
 * servidor, en un update con pipeline.
 */
export const KEEL_TIMER_DOCUMENT = Object.freeze({
  collection: KEEL_TIMER.table,
  indexes: Object.freeze([{ name: 'ix_keel_timer_due_at', keys: { due_at: 1 } }]),
  // El filtro del reclamo, salvo la hora: { due_at <= $$NOW } va como $expr.
  claimFilter: (kinds) =>
    Object.freeze({
      kind: { $in: kinds },
      parked_at: null,
      $expr: { $and: [{ $lte: ['$due_at', '$$NOW'] }, { $or: [{ $eq: ['$claimed_until', null] }, { $lt: ['$claimed_until', '$$NOW'] }] }] }
    }),
  claimUpdate: (leaseMs, token) => [{ $set: { claimed_until: { $add: ['$$NOW', leaseMs] }, claim_token: token } }]
});

/** Los segundos de un plazo con su parámetro ya leído (`value` en la unidad del diseño). */
export function deadlineSeconds(duration, parameterValue = null) {
  return duration.seconds ?? parameterValue * DEADLINE_UNIT_SECONDS[duration.unit];
}

// ─── El cron en UTC (T7) ─────────────────────────────────────────────────────
//
// Hoy cada generador evalúa el cron en la zona del proceso, y dos réplicas con zonas distintas disparan a horas
// distintas. El cronómetro lo evalúa en UTC. Cada generador usa su librería de cron; estos son los casos que todas tienen
// que dar igual (seis campos, el segundo primero, como los escribe `scheduleCron`): `[cron, desde, siguiente]`, el
// siguiente ESTRICTAMENTE posterior a `desde`.
export const CRON_UTC_CASES = Object.freeze([
  ['0 0 3 * * *', '2026-11-07T10:00:00Z', '2026-11-08T03:00:00Z'],
  ['0 0 3 * * *', '2026-11-07T02:59:59Z', '2026-11-07T03:00:00Z'],
  ['0 */5 * * * *', '2026-11-07T10:02:30Z', '2026-11-07T10:05:00Z'],
  ['0 */5 * * * *', '2026-11-07T10:05:00Z', '2026-11-07T10:10:00Z'],
  ['30 * * * * *', '2026-11-07T23:59:45Z', '2026-11-08T00:00:30Z'],
  ['0 45 4 * * *', '2026-12-31T05:00:00Z', '2027-01-01T04:45:00Z']
]);
