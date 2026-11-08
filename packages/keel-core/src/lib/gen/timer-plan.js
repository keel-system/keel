// QUÉ corre sobre el cronómetro en un diseño (PLAN-DSL-226-PLAZOS.md, § La migración de los relojes). timer-store.js
// dice CÓMO es el cronómetro (la tabla, las sentencias, los parámetros); esto dice CUÁNDO existe y qué recurrentes
// lleva, para que los cuatro generadores monten los mismos sobre la misma tabla —comparten base—.
//
// La migración va por incrementos, y cada uno añade aquí lo suyo:
//   · inc. 3-6: los plazos de negocio y la purga de la propia tabla (R7);
//   · inc. 7: las purgas de las tablas del generador, en modo CLÚSTER (una réplica por tick, la que gana la fila).
//     Antes corrían con su cron en TODAS las réplicas a la vez; borrar es idempotente, así que no rompía nada, pero
//     cada réplica repetía el mismo recorrido de la tabla;
//   · inc. 8: el `schedule` de las operaciones, también en modo CLÚSTER y con DRENAJE (abajo). Antes cada réplica corría
//     su pasada con su cron, y el reclamo por fila repartía el trabajo; el reclamo sigue (el tick es al menos una vez),
//     pero la pasada la hace una sola réplica;
//   · inc. 9: el relay del outbox.
//
// Un motor sin sentencias medidas (MariaDB, SQL Server, Oracle: solo los genera keel-spring) no tiene cronómetro, y sus
// purgas se quedan como estaban, con su cron por réplica: la matriz de paridad lo dice como degradado.

import { usesDeadlines } from './deadlines.js';
import { KEEL_TIMER, TIMER_ENGINES, TIMER_PARAMETERS, TIMER_PURGE_KIND, purgeKind, scheduleKind } from './timer-store.js';
import { scheduleCron, scheduledOperations } from './scheduling.js';
import { OUTBOX_EVENT, OUTBOX_PURGE, PROCESSED_EVENT, PROCESSED_EVENT_PURGE, usesOutbox, usesMessageDeduplication } from './messaging-stores.js';
import { IDEMPOTENCY_RECORD, IDEMPOTENCY_RECORD_PURGE, usesRequestIdempotency } from './request-idempotency.js';
import { RECONCILIATION_CLAIM, RECONCILIATION_PURGE, reconciliationClaims } from './reconciliation-stores.js';

/** Los motores en los que hay cronómetro: los relacionales con sentencias medidas (timer-sql-check) y MongoDB. */
export const TIMER_DATABASES = Object.freeze([...TIMER_ENGINES, 'mongodb']);

/** ¿El motor del stack tiene cronómetro? */
export function timerEngine(model) {
  return model.persistenceKind === 'document' || TIMER_ENGINES.includes(model.stack?.database);
}

/**
 * Las purgas de las tablas del generador que emite este diseño, en un orden fijo (el de creación de las tablas). Cada una
 * con su tabla, su `kind` en `keel_timer` y su cron (la clave, la variable y el default de keel-core: los comparten los
 * cuatro servidores). Lo que hace cada purga no cambia: es la de siempre, con su retención y sus lotes.
 */
export function generatorPurges(model) {
  if (!model.layersPresent?.persistence) return [];
  const purges = [];
  if (usesOutbox(model)) purges.push({ table: OUTBOX_EVENT.table, cron: OUTBOX_PURGE.cron });
  if (usesMessageDeduplication(model)) purges.push({ table: PROCESSED_EVENT.table, cron: PROCESSED_EVENT_PURGE.cron });
  if (usesRequestIdempotency(model)) purges.push({ table: IDEMPOTENCY_RECORD.table, cron: IDEMPOTENCY_RECORD_PURGE.cron });
  if (reconciliationClaims(model).length > 0) purges.push({ table: RECONCILIATION_CLAIM.table, cron: RECONCILIATION_PURGE.cron });
  return purges.map((purge) => Object.freeze({ ...purge, kind: purgeKind(purge.table) }));
}

/**
 * ¿Hay cronómetro? Con persistencia, y con algo que cronometrar: un plazo de negocio, o una purga sobre un motor que lo
 * tiene. Un plazo sobre un motor sin cronómetro no llega aquí: lo rechaza la frontera de cada generador.
 */
export function usesTimer(model) {
  if (!model.layersPresent?.persistence) return false;
  return usesDeadlines(model) || (timerEngine(model) && (generatorPurges(model).length > 0 || generatorSchedules(model).length > 0));
}

/**
 * Los `schedule` de las operaciones del diseño, como recurrentes: su `kind` (`schedule:<operación>`) y su cron de seis
 * campos con el segundo repartido (`scheduleCron`: dos barridos con la misma cadencia siguen sin arrancar a la vez). Sin
 * persistencia no hay tabla en la que arbitrar (R6), y el `schedule` sigue con su reloj por réplica.
 */
export function generatorSchedules(model) {
  if (!model.layersPresent?.persistence) return [];
  return scheduledOperations(model).map((operation) =>
    Object.freeze({ operation: operation.name, kind: scheduleKind(operation.name), cron: scheduleCron(model, operation) })
  );
}

/** Los `schedule` que corren sobre el cronómetro (modo clúster, con drenaje): todos, si hay cronómetro; ninguno, si no. */
export function timerSchedules(model) {
  return usesTimer(model) ? generatorSchedules(model) : [];
}

/** ¿El `schedule` de esta operación lo dispara el cronómetro? Si no, conserva su reloj por réplica. */
export function scheduledByTimer(model, operationName) {
  return timerSchedules(model).some((schedule) => schedule.operation === operationName);
}

/** Las purgas que corren sobre el cronómetro (modo clúster): todas, si hay cronómetro; ninguna, si no. */
export function timerPurges(model) {
  return usesTimer(model) ? generatorPurges(model) : [];
}

/** ¿Esta tabla del generador se purga con el cronómetro? Si no, su purga conserva el cron por réplica. */
export function purgedByTimer(model, table) {
  return timerPurges(model).some((purge) => purge.table === table);
}

/**
 * Los recurrentes en modo clúster del cronómetro de este diseño, con su `kind` y su cron: la purga de la propia tabla
 * (R7), las de las tablas del generador y los `schedule` de las operaciones. Es lo que cada réplica asegura al arrancar
 * (R1). El cron de una purga es un parámetro (clave, variable y default); el de un `schedule`, el literal del diseño.
 */
export function clusterRecurrings(model) {
  if (!usesTimer(model)) return [];
  return [
    Object.freeze({ table: KEEL_TIMER.table, kind: TIMER_PURGE_KIND, cron: TIMER_PARAMETERS.purgeCron }),
    ...timerPurges(model),
    ...timerSchedules(model)
  ];
}

// ─── El drenaje de un `schedule` (decisión 7 del plan) ───────────────────────
//
// En modo clúster un tick lo ejecuta UNA réplica. Antes, con tres réplicas, un tick de un barrido reclamaba hasta tres
// lotes; ahora el tick repite la pasada mientras su lote salga LLENO, hasta que no queden candidatos o hasta agotar su
// presupuesto. Cuándo salió lleno solo lo sabe quien reclama: lo avisan los reclamos que genera build (el del barrido y
// el de la reconciliación), y el handler del agente cuando reclama él (el barrido de pagos, un barrido sin reclamo
// generado). Sin aviso, una pasada por tick, como antes en cada réplica.

/**
 * ¿Avisa este reclamo GENERADO del lote lleno? Sí si es de una operación cuyo `schedule` corre sobre el cronómetro: el
 * reclamo de un barrido (`operation.claim[]`) o el de una reconciliación (`operation.reconciles[].claim`), por identidad.
 */
export function claimDrains(model, claim) {
  const owner = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .find((operation) => (operation.claim ?? []).includes(claim) || (operation.reconciles ?? []).some((reconcile) => reconcile.claim === claim));
  return Boolean(owner) && scheduledByTimer(model, owner.name);
}

/**
 * ¿Una pasada que reclamó `claimed` filas con la cota `batchSize` deja candidatos? Con el lote lleno puede que sí, y el
 * tick repite; con menos, no queda nada.
 */
export function batchFull(claimed, batchSize) {
  return batchSize > 0 && claimed >= batchSize;
}

/**
 * El presupuesto de un tick que drena: hasta el SIGUIENTE tick de su cron (no puede solaparse con él), y nunca más que
 * `timer.drain-budget-ms`, que es menor que el arriendo (T4): con un tick más largo que su arriendo, otra réplica lo
 * repetiría en paralelo.
 *
 * @param startMs    cuándo empezó el tick
 * @param nextTickMs el siguiente tick de su cron desde `startMs`
 */
export function drainBudgetMs({ startMs, nextTickMs, maxBudgetMs }) {
  return Math.max(0, Math.min(nextTickMs - startMs, maxBudgetMs));
}

/**
 * La REFERENCIA ejecutable del tick que drena, contra la que cada generador prueba el suyo. `pass()` ejecuta una pasada y
 * devuelve si su lote salió lleno. Se repite mientras salga lleno y quede presupuesto; la primera pasada va siempre.
 *
 * @returns el número de pasadas
 */
export async function drainReference({ pass, budgetMs, nowMs }) {
  const start = nowMs();
  let passes = 0;
  for (;;) {
    const full = await pass();
    passes += 1;
    if (!full || nowMs() - start >= budgetMs) return passes;
  }
}

/** Los casos del drenaje que miden las redes de los cuatro (DR-*), sobre un reclamo real. */
export const DRAIN_CASES = Object.freeze([
  Object.freeze({ id: 'DR-1', what: 'con más candidatos que el lote, UN tick los drena todos, en varias pasadas' }),
  Object.freeze({ id: 'DR-2', what: 'con menos candidatos que el lote, el tick hace una sola pasada' }),
  Object.freeze({ id: 'DR-3', what: 'agotado el presupuesto, el tick para aunque el lote siga saliendo lleno' })
]);
