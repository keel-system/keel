// Lo que corre por RELOJ en un servicio generado, como decisiones neutrales.
//
// Dos servidores del mismo diseño (keel-spring, keel-nest) tienen que disparar sus barridos en el
// mismo segundo del minuto y despacharlos igual —con la transacción del caso de uso o sin ella—, y
// purgar las tablas del generador con los mismos lotes. Aquí se decide una vez; cada generador lo
// escribe en su lenguaje (un `@Scheduled` de seis campos, un `CronJob`).

import { callsPaymentGateway } from './payments-model.js';
import { screamingSnake, snakeCase } from './naming.js';

/** Las operaciones con `schedule` del modelo, en el orden de sus servicios. */
export function scheduledOperations(model) {
  return (model.services ?? []).flatMap((service) => (service.operations ?? []).filter((operation) => operation.schedule));
}

/** ¿Declara el diseño alguna operación disparada por reloj? */
export function hasScheduledOperations(model) {
  return scheduledOperations(model).length > 0;
}

/**
 * El segundo de arranque de cada operación con `schedule`, repartido dentro del minuto.
 *
 * El DSL declara un cron de CINCO campos y los dos servidores lo ejecutan con seis: el de segundos lo
 * pone el generador. Ponerlo a 0 en todos hacía que varios barridos que comparten cadencia —y
 * compartirla es lo natural, «cada cinco minutos» es la declaración obvia— arrancaran en el mismo
 * instante, y en todas las réplicas a la vez. Lo que se amontona ahí no es la base de datos (el
 * reclamo es un UPDATE corto) sino las LLAMADAS SALIENTES: todos los barridos empujando a sus
 * proveedores en el mismo segundo.
 *
 * El reparto es por ÍNDICE, no por hash del nombre: lo que se busca es que NO coincidan, y solo el
 * índice lo garantiza. Se calcula para todo el modelo y no por servicio: dos agregados con barrido
 * corren en el mismo proceso y contra los mismos proveedores.
 *
 * Es una mitigación, no una garantía: reparte el ARRANQUE. Dos barridos que duren más que su
 * separación se solapan igual.
 *
 * @returns {Map<string, number>} nombre de la operación → segundo (0–59)
 */
export function scheduleSeconds(model) {
  const scheduled = scheduledOperations(model);
  const seconds = new Map();
  scheduled.forEach((operation, index) => {
    seconds.set(operation.name, Math.round((index * 60) / scheduled.length) % 60);
  });
  return seconds;
}

/** El cron de seis campos con el que se ejecuta la operación: el segundo repartido + los cinco del diseño. */
export function scheduleCron(model, operation) {
  return `${scheduleSeconds(model).get(operation.name) ?? 0} ${operation.schedule.cron}`;
}

/**
 * ¿El lote que este barrido reclama va a parar a una operación con GUARDA de efecto irreversible?
 *
 * El enlace es mecánico: el reclamo del barrido deja las filas en un estado (`accepted → queued`) y
 * la guarda las toma de ESE estado (`queued → sending`), sobre la MISMA entidad. Eso es el diseño
 * diciendo «el barrido alimenta al que produce el efecto». Con una transacción abarcadora del lote,
 * el reclamo por fila no confirma hasta el final, el efecto cae dentro, y una caída revierte la marca:
 * el ciclo siguiente repite un efecto que no se deshace.
 */
export function feedsGuardedEffect(model, operation) {
  const guards = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .map((candidate) => candidate.guardClaim)
    .filter(Boolean);
  if (guards.length === 0) return false;
  return (operation.claim ?? []).some((claim) =>
    guards.some((guard) => guard.entity === claim.entity && (guard.from ?? []).includes(claim.to))
  );
}

/**
 * Cómo se despacha una operación con `schedule`: con la transacción del caso de uso, o SIN
 * transacción abarcadora.
 *
 * Sin ella van los barridos cuya garantía es un ORDEN de commits —reclamar y confirmar, actuar fuera
 * de toda transacción, confirmar el desenlace— y no una transacción única:
 *   · `provider`: reconcilia una activación saliente o llama a la pasarela de pago;
 *   · `irreversible`: alimenta a una operación con guarda de efecto irreversible;
 *   · `claimed`: toma su lote con un reclamo GENERADO, que confirma en su propia transacción antes de
 *     devolver las filas (envolver el lote haría que el fallo de una revirtiera el trabajo de todas).
 * El resto —un cierre, una purga del diseño— va con su transacción única: no llama a nadie en medio.
 *
 * @returns {{ withoutTransaction: boolean, reason: 'provider'|'irreversible'|'claimed'|null }}
 */
export function scheduleDispatch(model, operation) {
  if ((operation.reconciles ?? []).length > 0 || callsPaymentGateway(model, operation.name)) {
    return { withoutTransaction: true, reason: 'provider' };
  }
  if (feedsGuardedEffect(model, operation)) return { withoutTransaction: true, reason: 'irreversible' };
  if ((operation.claim ?? []).length > 0) return { withoutTransaction: true, reason: 'claimed' };
  return { withoutTransaction: false, reason: null };
}

/**
 * La purga POR LOTES de las tablas del generador (`outbox_event`, `processed_event`,
 * `idempotency_record`, `reconciliation_claim`) en la rama relacional.
 *
 * Un único DELETE sobre todo lo caducado es una transacción del tamaño del atraso: tras una caída,
 * millones de filas que retienen sus bloqueos hasta el final, llenan el undo o el WAL y, con el tope de
 * transacción del servicio, no terminan nunca. El lote se acota por INSTANTE (el de la fila que ocupa
 * la posición N entre las que hay que purgar), así que vale para claves compuestas y recorre el índice
 * que la tabla ya tiene sobre ese campo.
 */
export const BATCHED_PURGE = Object.freeze({
  /** Filas por lote: lo bastante pocas para que un lote quepa holgado en el tope de transacción. */
  batchSize: 1000,
  /** Lotes por pasada (medio millón de filas): alcanzado, se avisa y la siguiente pasada sigue. */
  maxBatches: 500
});

/** Las claves de configuración del lote de una purga, bajo su prefijo (`outbox.purge`…). */
export function batchedPurgeParameters(prefix) {
  return Object.freeze({
    batchSize: Object.freeze({ key: `${prefix}.batch-size`, default: BATCHED_PURGE.batchSize }),
    maxBatches: Object.freeze({ key: `${prefix}.max-batches`, default: BATCHED_PURGE.maxBatches })
  });
}

/**
 * La REFERENCIA ejecutable del bucle de la purga, contra la que cada generador prueba el suyo.
 *
 * @param boundary   (posición) → el instante de esa fila entre las que hay que purgar, o null
 * @param deleteUpTo (instante) → filas borradas hasta ese instante incluido (y antes del corte)
 * @returns {{ deleted: number, exhausted: boolean }} `exhausted`: llegó al tope con filas pendientes
 */
export async function batchedPurgeReference({ batchSize, maxBatches, boundary, deleteUpTo, cutoff }) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const edge = await boundary(batchSize - 1);
    if (edge == null) return { deleted: deleted + (await deleteUpTo(cutoff)), exhausted: false };
    deleted += await deleteUpTo(edge);
  }
  return { deleted, exhausted: true };
}

// ─── Los reclamos de un barrido ──────────────────────────────────────────────
//
// Un barrido corre en TODAS las réplicas, así que su lote no se LEE: se RECLAMA, fila a fila con una
// escritura condicional (`... WHERE id = :id AND estado IN :desde`: una fila afectada = es mía). Qué
// reclama cada barrido lo decide el modelo (`operation.claim[]`, con `stalled` para el rescate de un estado
// en vuelo); aquí, lo que tiene que coincidir entre generadores para que los dos servidores repartan igual:
// en qué orden se eligen los candidatos y de qué claves de configuración salen el lote y el plazo.

/** La cota del lote de una pasada si nadie la ajusta por entorno. Capacidad, no diseño. */
export const SWEEP_BATCH_DEFAULT = 100;

/** Todos los reclamos de barrido del modelo, con la operación que los dispara. */
export function sweepClaims(model) {
  return (model.services ?? []).flatMap((service) =>
    (service.operations ?? []).flatMap((operation) => (operation.claim ?? []).map((claim) => ({ operation, claim })))
  );
}

/** Los reclamos que apuntan a una entidad, venga de la operación que venga. */
export function claimsForEntity(model, entityName) {
  return sweepClaims(model)
    .map(({ claim }) => claim)
    .filter((claim) => claim.entity === entityName);
}

/**
 * Por qué campo se eligen los candidatos, del más antiguo al más nuevo.
 *
 * En un rescate, por el propio reloj de la cota: el que más lleva atascado, primero. Cualquier otro
 * campo haría que una tanda con más atascados que el lote volviera a mirar siempre las mismas filas y
 * las más viejas no se rescataran nunca. En una cola, por el primer instante de llegada que declare la
 * entidad; sin ninguno, por el id (que es UUIDv7: también ordena por llegada).
 */
export function claimOrderField(entity, claim) {
  if (claim?.stalled) return claim.stalled.stampField;
  for (const candidate of ['createdAt', 'requestedAt', 'updatedAt']) {
    if ((entity.fields ?? []).some((field) => field.name === candidate)) return candidate;
  }
  return 'id';
}

/**
 * Las claves de `sweep.*` del servicio, agrupadas por bloque: la cota del lote va por OPERACIÓN (una
 * pasada es una unidad de trabajo y sus reclamos se la reparten) y el plazo de abandono por RESCATE (que
 * es donde se mide). Las dos pueden caer en el mismo bloque —un rescate de una sola transición toma el
 * nombre de su operación—, y por eso se agrupan: el mismo bloque dos veces es un YAML que no carga.
 * Un rescate enlazado a un parámetro del diseño (`stalledAfter`, DSL 2.18) no tiene clave aquí: su plazo
 * ya es esa propiedad, y dos plazos para el mismo rescate es uno sin leer.
 *
 * @returns {Array<{ key: string, entries: Array<{ leaf, env, default, kind: 'batch'|'stalled', operation, claim }> }>}
 */
export function sweepConfig(model) {
  const blocks = new Map();
  const block = (key) => {
    if (!blocks.has(key)) blocks.set(key, []);
    return blocks.get(key);
  };
  const seen = new Set();
  for (const { operation, claim } of sweepClaims(model)) {
    if (!claim.sweepKey || seen.has(claim.sweepKey)) continue;
    seen.add(claim.sweepKey);
    block(claim.sweepKey).push({
      leaf: 'batch-size',
      env: `SWEEP_${screamingSnake(claim.sweepKey)}_BATCH_SIZE`,
      default: SWEEP_BATCH_DEFAULT,
      kind: 'batch',
      operation,
      claim
    });
  }
  for (const { operation, claim } of sweepClaims(model)) {
    if (!claim.stalled || claim.stalled.parameter) continue;
    block(claim.stalled.configKey).push({
      leaf: 'stalled-after-seconds',
      env: `SWEEP_${screamingSnake(claim.suffix)}_STALLED_AFTER_SECONDS`,
      default: claim.stalled.defaultSeconds,
      kind: 'stalled',
      operation,
      claim
    });
  }
  return [...blocks].map(([key, entries]) => ({ key, entries }));
}


// ─── Las sondas del rescate (el arnés de integración) ────────────────────────
//
// Un flujo `FL-*` que pruebe el rescate tiene que FABRICAR su precondición —una fila en vuelo que una réplica
// muerta dejó a medias— sin sembrarla entera: mueve una creada por la API. Las sentencias son las mismas en
// los dos arneses (el de keel-spring y el de keel-nest las lanzan por la CLI del motor), y el literal del
// instante y del id lo pone el catálogo de cada motor (`staleTimestamp`, `nowTimestamp`, `uuidLiteral`).

/** Dónde vive el rescate en la tabla: la columna del estado (por la CONSTANTE del enum) y la del reloj. */
export function rescueShape(entity, claim) {
  return {
    table: entity.tableName,
    stateColumn: snakeCase(entity.lifecycle.field),
    state: screamingSnake(claim.stalled.state),
    clockColumn: snakeCase(claim.stalled.stampField)
  };
}

/** Deja una fila EN VUELO con el reloj que se le pase. Devuelve el prefijo: el llamante concatena el literal del id. */
export function stallSql({ table, stateColumn, state, clockColumn, clockSql }) {
  return `UPDATE ${table} SET ${stateColumn} = '${state}', ${clockColumn} = ${clockSql} WHERE id = `;
}

/**
 * Cuántas filas quedaron en el estado con el reloj SIN estampar. Tiene que valer cero siempre: un reclamo
 * que mueve el estado sin estampar la marca en el mismo UPDATE deja la fila irrescatable.
 */
export function missingClockCountSql({ table, stateColumn, state, clockColumn }) {
  return `SELECT COUNT(*) FROM ${table} WHERE ${stateColumn} = '${state}' AND ${clockColumn} IS NULL`;
}

/** Los rescates que build generó, con la operación que los dispara y dónde viven en su tabla. */
export function rescueProbes(model) {
  const probes = [];
  for (const { operation, claim } of sweepClaims(model)) {
    if (!claim.stalled) continue;
    const entity = (model.entities ?? []).find((candidate) => candidate.name === claim.entity);
    if (!entity?.tableName || !entity.lifecycle?.field) continue;
    probes.push({ operation: operation.name, ...rescueShape(entity, claim) });
  }
  return probes;
}
