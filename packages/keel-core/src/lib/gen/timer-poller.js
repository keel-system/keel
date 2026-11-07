// La REFERENCIA EJECUTABLE del cronómetro (PLAN-DSL-226-PLAZOS.md, incremento 2): qué hace el sondeador de una réplica,
// como código que se ejecuta y no como prosa. Cada generador escribe el suyo en su lenguaje; esto es lo que sus pruebas
// tienen que reproducir, igual que `circuitScript` lo es del circuito de los clientes salientes.
//
// Dos piezas:
//   · `createMemoryTimerStore`, un almacén con la MISMA semántica que las sentencias de timer-store.js (arriendo, valla,
//     aparcado, rearme): la que sostienen PostgreSQL y MySQL, y que mide `scripts/timer-sql-check.js` contra los dos;
//   · `pollOnce`, una pasada del sondeador: reclama un lote, lo resuelve y devuelve cuánto dormir.
//
// La hora es siempre la de la BASE (T1): el almacén la recibe de `dbNow`, y el sondeador no lee ningún reloj propio.

import { NIL_ENTITY_ID } from './timer-store.js';
import { isDeadlineDue } from './deadlines.js';

/**
 * Un almacén de temporizadores en memoria, compartido por las réplicas de una prueba. `dbNow()` es la hora de la base, en
 * milisegundos. Las operaciones son las sentencias de timer-store.js, una a una.
 */
export function createMemoryTimerStore({ dbNow }) {
  const rows = new Map(); // `${kind}|${entityId}` → fila
  const key = (kind, entityId) => `${kind}|${entityId}`;
  let sequence = 0;
  const reclaimable = (row, now) => row.parkedAt === null && row.dueAt <= now && (row.claimedUntil === null || row.claimedUntil < now);
  return {
    rows: () => [...rows.values()].map((row) => ({ ...row })),
    /** `arm`: inserta o, si ya existe, rearma (borra arriendo, valla, intentos y aparcado). */
    arm({ kind, entityId, dueAt, spec = null }) {
      const existing = rows.get(key(kind, entityId));
      if (existing) Object.assign(existing, { dueAt, claimedUntil: null, claimToken: null, attempts: 0, parkedAt: null });
      else rows.set(key(kind, entityId), { id: `t${++sequence}`, kind, entityId, spec, dueAt, claimedUntil: null, claimToken: null, attempts: 0, parkedAt: null });
    },
    /** `ensureRecurring`: si ya está, solo cambia si su spec cambió. */
    ensureRecurring({ kind, spec, dueAt }) {
      const existing = rows.get(key(kind, NIL_ENTITY_ID));
      if (!existing) this.arm({ kind, entityId: NIL_ENTITY_ID, dueAt, spec });
      else if (existing.spec !== spec) Object.assign(existing, { dueAt, spec });
    },
    /** `claimLock` + `claimMark` + `claimed`, atómicos: lo vencido y libre de los `kinds` dados, en orden de due_at. */
    claim({ kinds, limit, leaseMs, token }) {
      const now = dbNow();
      const claimed = [...rows.values()]
        .filter((row) => kinds.includes(row.kind) && reclaimable(row, now))
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, limit);
      for (const row of claimed) Object.assign(row, { claimedUntil: now + leaseMs, claimToken: token });
      return claimed.map((row) => ({ ...row }));
    },
    /** `complete`: borra, solo con la valla de quien reclamó. Devuelve las filas afectadas. */
    complete({ id, token }) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.claimToken === token);
      if (!row) return 0;
      rows.delete(key(row.kind, row.entityId));
      return 1;
    },
    /** `reschedule`: nuevo vencimiento, libre y con los intentos a cero, solo con la valla. */
    reschedule({ id, token, dueAt }) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.claimToken === token);
      if (!row) return 0;
      Object.assign(row, { dueAt, claimedUntil: null, claimToken: null, attempts: 0 });
      return 1;
    },
    /** `fail`: cuenta el intento, se reintenta tras el retraso y, al agotar los intentos, se aparca. */
    fail({ id, token, maxAttempts, retryDelayMs }) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.claimToken === token);
      if (!row) return 0;
      const now = dbNow();
      Object.assign(row, {
        parkedAt: row.attempts + 1 >= maxAttempts ? now : null,
        attempts: row.attempts + 1,
        dueAt: now + retryDelayMs,
        claimedUntil: null,
        claimToken: null
      });
      return 1;
    },
    /** `nextDueMs`: cuánto falta para lo próximo reclamable de esos `kinds` (null: nada). Puede ser negativo. */
    nextDueMs({ kinds }) {
      const now = dbNow();
      const candidates = [...rows.values()].filter((row) => kinds.includes(row.kind) && row.parkedAt === null);
      if (candidates.length === 0) return null;
      return Math.min(...candidates.map((row) => (row.claimedUntil !== null && row.claimedUntil > row.dueAt ? row.claimedUntil : row.dueAt))) - now;
    }
  };
}

/** Cuánto duerme el sondeador: hasta lo próximo, con el tope (para ver lo que arman otras réplicas) y nunca negativo. */
export function sleepMs(nextDueMs, maxSleepMs) {
  if (nextDueMs === null) return maxSleepMs;
  return Math.max(0, Math.min(nextDueMs, maxSleepMs));
}

/**
 * Una pasada del sondeador de una réplica. `handlers` resuelve cada temporizador reclamado por su `kind` y devuelve el
 * desenlace: `{ done: true }` (borrarlo), `{ dueAt }` (rearmarlo: un recurrente tras su tick, o un plazo que la
 * revalidación aplaza). Si el handler lanza, es un fallo: cuenta el intento y, al agotarlos, se aparca. Devuelve
 * `{ claimed, sleepMs }`.
 *
 * Solo reclama los `kinds` que conoce (R4): un temporizador de otra versión no lo toca, ni para borrarlo.
 */
export async function pollOnce({ store, kinds, settings, handlers, token }) {
  const claimed = store.claim({ kinds, limit: settings.batchSize, leaseMs: settings.leaseMs, token });
  for (const timer of claimed) {
    try {
      const outcome = await handlers(timer);
      if (outcome?.done) store.complete({ id: timer.id, token });
      else store.reschedule({ id: timer.id, token, dueAt: outcome.dueAt });
    } catch {
      store.fail({ id: timer.id, token, maxAttempts: settings.maxAttempts, retryDelayMs: settings.retryDelayMs });
    }
  }
  return { claimed: claimed.length, sleepMs: sleepMs(store.nextDueMs({ kinds }), settings.maxSleepMs) };
}

/**
 * Lo que hace el sondeador con el temporizador de un PLAZO (paso 4 de § Cómo funciona): revalidar con la hora de la base
 * y el `after` VIGENTE, y solo entonces despachar la operación `by`.
 *
 *   · la entidad ya no existe o ya no está en el estado → `{ done }`, sin despachar (DL-8);
 *   · el plazo, con el `after` de ahora, todavía no vence → `{ dueAt }`, rearmado (DL-9, T6);
 *   · vencido → despacha y `{ done }`.
 */
export async function deadlineTick({ timer, loadEntity, state, afterSeconds, dbNowMs, dispatch }) {
  const entity = await loadEntity(timer.entityId);
  if (!entity || entity.state !== state) return { done: true };
  if (!isDeadlineDue({ sinceMs: entity.sinceMs, afterSeconds, nowMs: dbNowMs })) return { dueAt: entity.sinceMs + afterSeconds * 1000 };
  await dispatch(timer.entityId);
  return { done: true };
}

/**
 * Lo que hace el sondeador con un RECURRENTE en modo clúster: ejecutar el tick y rearmarlo para el siguiente, calculado
 * desde la hora de AHORA y no desde el `due_at` anterior (R2): tras una parada larga se ejecuta un tick, no todos los que
 * se perdieron. `nextTick(fromMs)` es el cron en UTC (T7).
 */
export async function recurringTick({ run, dbNow, nextTick }) {
  await run();
  // La hora de DESPUÉS del tick: con la de antes, un tick más largo que su periodo dejaría el siguiente ya vencido.
  return { dueAt: nextTick(dbNow()) };
}
