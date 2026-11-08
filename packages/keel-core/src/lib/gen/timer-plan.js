// QUÉ corre sobre el cronómetro en un diseño (PLAN-DSL-226-PLAZOS.md, § La migración de los relojes). timer-store.js
// dice CÓMO es el cronómetro (la tabla, las sentencias, los parámetros); esto dice CUÁNDO existe y qué recurrentes
// lleva, para que los cuatro generadores monten los mismos sobre la misma tabla —comparten base—.
//
// La migración va por incrementos, y cada uno añade aquí lo suyo:
//   · inc. 3-6: los plazos de negocio y la purga de la propia tabla (R7);
//   · inc. 7: las purgas de las tablas del generador, en modo CLÚSTER (una réplica por tick, la que gana la fila).
//     Antes corrían con su cron en TODAS las réplicas a la vez; borrar es idempotente, así que no rompía nada, pero
//     cada réplica repetía el mismo recorrido de la tabla;
//   · inc. 8 y 9: el `schedule` de las operaciones y el relay del outbox.
//
// Un motor sin sentencias medidas (MariaDB, SQL Server, Oracle: solo los genera keel-spring) no tiene cronómetro, y sus
// purgas se quedan como estaban, con su cron por réplica: la matriz de paridad lo dice como degradado.

import { usesDeadlines } from './deadlines.js';
import { KEEL_TIMER, TIMER_ENGINES, TIMER_PARAMETERS, TIMER_PURGE_KIND, purgeKind } from './timer-store.js';
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
  return usesDeadlines(model) || (timerEngine(model) && generatorPurges(model).length > 0);
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
 * (R7) y las de las tablas del generador. Es lo que cada réplica asegura al arrancar (R1).
 */
export function clusterRecurrings(model) {
  if (!usesTimer(model)) return [];
  return [Object.freeze({ table: KEEL_TIMER.table, kind: TIMER_PURGE_KIND, cron: TIMER_PARAMETERS.purgeCron }), ...timerPurges(model)];
}
