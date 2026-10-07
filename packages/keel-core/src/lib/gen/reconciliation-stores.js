// El almacén del barrido de reconciliación (`dependencies.activations.<a>.reconciledBy`) y los
// parámetros con los que se gobierna: la tabla `reconciliation_claim`, su purga y los tres números
// de cada barrido. Es lo mismo en los dos generadores —el servidor de keel-spring y el de keel-nest
// del mismo diseño comparten base, esquema y variables de entorno—, así que se decide aquí, como
// `OUTBOX_EVENT` (messaging-stores.js) o `IDEMPOTENCY_RECORD` (request-idempotency.js). Lo que cambia
// entre lenguajes (la entidad, el adaptador, cómo se captura la carrera) es de cada uno.
//
// Por qué una tabla y no el lifecycle: el reclamo de una cola es el propio estado de destino, pero aquí
// el estado de espera es justo lo que el barrido busca, y entre reclamar y actuar hay una llamada al
// proveedor —un lock solo aísla mientras dura su transacción—. Hace falta una marca que SOBREVIVA al
// commit y CADUQUE: sin plazo, una réplica que muera con el candidato en vuelo lo retendría siempre.

import { cronPeriodSeconds } from './cron-period.js';
import { kebabCase, screamingSnake } from './naming.js';

// ─── La tabla, como DATOS ────────────────────────────────────────────────────

/**
 * La marca de que una réplica se llevó un candidato.
 *
 *   · clave primaria (activation, entity_id): una entidad puede esperar el desenlace de VARIAS
 *     activaciones a la vez, y cada barrido reclama la suya; y es la BASE la que arbitra la carrera
 *     entre dos réplicas que insertan la misma marca;
 *   · claimed_at es un instante y no un booleano porque la marca CADUCA; su índice es el de la purga.
 *
 * En el modelo documental la clave compuesta va aplanada en el `_id` (`reconciliationClaimDocumentId`),
 * que es lo que hace que el motor arbitre la carrera sin transacción ninguna.
 */
export const RECONCILIATION_CLAIM = Object.freeze({
  table: 'reconciliation_claim',
  columns: Object.freeze([
    { name: 'activation', base: 'string', length: 120, nullable: false, primary: true },
    { name: 'entity_id', base: 'uuid', nullable: false, primary: true },
    { name: 'claimed_at', base: 'timestamp', nullable: false }
  ]),
  indexes: Object.freeze([{ name: 'ix_reconciliation_claim_claimed_at', columns: ['claimed_at'] }])
});

/** El `_id` de la marca en el modelo documental: la clave compuesta aplanada. */
export function reconciliationClaimDocumentId(activation, entityId) {
  return `${activation}|${entityId}`;
}

/**
 * La purga de las marcas viejas. Una marca caducada ya no protege nada —la siguiente pasada la renueva
 * o la ignora—, así que la retención solo evita que la tabla crezca con cada encargo que se reconcilió.
 */
export const RECONCILIATION_PURGE = Object.freeze({
  cron: Object.freeze({ key: 'reconciliation.purge.cron', env: 'RECONCILIATION_PURGE_CRON', default: '0 45 4 * * *', cron: true }),
  retentionDays: Object.freeze({ key: 'reconciliation.purge.retention-days', env: 'RECONCILIATION_PURGE_RETENTION_DAYS', default: 7 })
});

// ─── Los tres números de un barrido ──────────────────────────────────────────
//
// NO son la misma clase de decisión, y por eso solo uno lo declara el diseño:
//
//   · unansweredAfterSeconds — CUÁNTO SILENCIO SE TOLERA. Es del diseño: depende de cuánto tarda ESE
//     proveedor en contestar, que es conocimiento de negocio. Por activación.
//   · claimTimeoutMs — CUÁNTO RETIENE UN CANDIDATO la réplica que lo reclamó. Mecánica de
//     multi-réplica: el generador la resuelve igual que la del relay del outbox.
//   · batchSize — CUÁNTO TRABAJO CABE EN UNA PASADA. Capacidad: se ajusta con datos de producción.

/** El silencio tolerado cuando el diseño no lo escribe. */
export const DEFAULT_UNANSWERED_AFTER_SECONDS = 3600;

/** Lote por pasada: sin cota, una tanda con 50.000 atascados son 50.000 llamadas al proveedor. */
export const RECONCILIATION_BATCH_SIZE = 50;

/**
 * Cuánto retiene un candidato la réplica que lo reclamó. Tiene que cubrir la pasada ENTERA —el lote por
 * lo que tarda cada llamada con sus reintentos— o una réplica viva ve caducar su propio reclamo a mitad
 * de lote y otra repite la llamada; y al menos dos ticks del cron, para que el siguiente no lo recoja
 * mientras la primera sigue. Era un 60000 fijo, igual a la cadencia de un barrido por minuto
 * (asset-vault, R8).
 */
export function reconciliationClaimTimeoutMs(activation, sweeper) {
  const call = activation?.http?.callRef;
  const attempts = call?.retry?.maxAttempts ?? 1;
  const perCallMs = (call?.timeoutMs ?? 5000) * attempts;
  const cadenceMs = (cronPeriodSeconds(sweeper?.schedule?.cron) ?? 60) * 1000;
  return Math.max(2 * cadenceMs, RECONCILIATION_BATCH_SIZE * perCallMs + 10000);
}

/**
 * Los parámetros del barrido de UNA activación, con su clave de configuración, su variable de entorno
 * y su default. Un generador lee de aquí el default que escribe en su configuración Y el que pone en el
 * código como respaldo: si salieran de sitios distintos, el diseño diría un número y el binario otro en
 * cuanto faltase el fichero.
 */
export function reconciliationParameters(activation, sweeper) {
  const key = `reconciliation.${kebabCase(activation.name)}`;
  const env = `RECONCILIATION_${screamingSnake(activation.name)}`;
  return Object.freeze({
    unansweredAfterSeconds: Object.freeze({
      key: `${key}.unanswered-after-seconds`,
      env: `${env}_UNANSWERED_AFTER_SECONDS`,
      default: activation.unansweredAfterSeconds ?? DEFAULT_UNANSWERED_AFTER_SECONDS
    }),
    claimTimeoutMs: Object.freeze({
      key: `${key}.claim-timeout-ms`,
      env: `${env}_CLAIM_TIMEOUT_MS`,
      default: reconciliationClaimTimeoutMs(activation, sweeper)
    }),
    batchSize: Object.freeze({ key: `${key}.batch-size`, env: `${env}_BATCH_SIZE`, default: RECONCILIATION_BATCH_SIZE })
  });
}

/** Las activaciones con barrido declarado, con su dependencia y la operación que barre. */
export function reconciledActivations(model) {
  const operations = (model.services ?? []).flatMap((service) => service.operations ?? []);
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const activation of dependency.activations ?? []) {
      if (!activation.reconciledBy) continue;
      const sweeper = operations.find((operation) => operation.name === activation.reconciledBy) ?? null;
      found.push({ dependency: dependency.id, activation, sweeper });
    }
  }
  return found;
}

/** Los reclamos de reconciliación que build pudo generar en este diseño (el descriptor del modelo). */
export function reconciliationClaims(model) {
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .flatMap((operation) => operation.reconciles ?? [])
    .map((reconcile) => reconcile.claim)
    .filter(Boolean);
}

// ─── La REFERENCIA ejecutable del reclamo ────────────────────────────────────

/**
 * Los dos cortes de una pasada, medidos sobre el MISMO instante: por debajo de `staleBefore` un
 * encargo lleva demasiado sin desenlace; por debajo de `claimExpiredBefore`, el reclamo ajeno ya caducó.
 */
export function reconciliationWindow({ now, unansweredAfterSeconds, claimTimeoutMs }) {
  const at = now.getTime();
  return {
    staleBefore: new Date(at - unansweredAfterSeconds * 1000),
    claimExpiredBefore: new Date(at - claimTimeoutMs)
  };
}

/**
 * ¿Se lleva esta réplica el candidato? `claimedAt` es la marca que ya existe (o null si no hay fila).
 * Sin fila, la inserción es el reclamo —y si dos la insertan a la vez, la clave primaria deja una sola—;
 * con fila, solo si la marca caducó (`claimed_at <= claimExpiredBefore`, el mismo `<=` que el UPDATE
 * condicional). Cada generador escribe esto en su lenguaje y sus pruebas lo comparan con esta.
 */
export function reconciliationClaimReference(claimedAt, claimExpiredBefore) {
  return claimedAt == null || claimedAt.getTime() <= claimExpiredBefore.getTime();
}
