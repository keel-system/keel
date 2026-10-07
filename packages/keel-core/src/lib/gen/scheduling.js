// Lo que corre por RELOJ en un servicio generado, como decisiones neutrales.
//
// Dos servidores del mismo diseño (keel-spring, keel-nest) tienen que disparar sus barridos en el
// mismo segundo del minuto y despacharlos igual —con la transacción del caso de uso o sin ella—, y
// purgar las tablas del generador con los mismos lotes. Aquí se decide una vez; cada generador lo
// escribe en su lenguaje (un `@Scheduled` de seis campos, un `CronJob`).

import { callsPaymentGateway } from './payments-model.js';

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
