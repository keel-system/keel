// La referencia ejecutable del cronómetro (gen/timer-poller.js), con dos réplicas sobre el mismo almacén y la hora de la
// base movida a mano. Son los casos RC-* y DL-* que no dependen de un motor: los que sí (SKIP LOCKED, la hora del motor,
// el upsert) los mide scripts/timer-sql-check.js contra PostgreSQL y MySQL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTimerStore, pollOnce, sleepMs, deadlineTick, recurringTick } from '../src/lib/gen/timer-poller.js';
import { NIL_ENTITY_ID, TIMER_PARAMETERS, scheduleKind } from '../src/lib/gen/timer-store.js';
import { deadlineKind, isDeadlineDue } from '../src/lib/gen/deadlines.js';

const settings = Object.fromEntries(Object.entries(TIMER_PARAMETERS).map(([name, parameter]) => [name, parameter.default]));
const MINUTE = 60_000;

function world() {
  let now = Date.UTC(2026, 10, 7, 10, 0, 0);
  const store = createMemoryTimerStore({ dbNow: () => now });
  return { store, advance: (ms) => (now += ms), now: () => now };
}

test('D3: el plazo vence EN el instante, no después', () => {
  assert.equal(isDeadlineDue({ sinceMs: 0, afterSeconds: 900, nowMs: 899_999 }), false);
  assert.equal(isDeadlineDue({ sinceMs: 0, afterSeconds: 900, nowMs: 900_000 }), true);
});

test('RC-1: con dos réplicas sondeando a la vez, cada tick de un recurrente lo ejecuta exactamente una', async () => {
  const { store, advance, now } = world();
  const kind = scheduleKind('sweepPages');
  store.ensureRecurring({ kind, spec: '*/5 * * * *', dueAt: now() + 5 * MINUTE });
  const runs = [];
  const handlers = (replica) => (timer) => recurringTick({ run: () => runs.push(replica), dbNow: now, nextTick: (from) => from + 5 * MINUTE });
  for (let tick = 0; tick < 3; tick += 1) {
    advance(5 * MINUTE);
    await Promise.all([
      pollOnce({ store, kinds: [kind], settings, handlers: handlers('a'), token: `a${tick}` }),
      pollOnce({ store, kinds: [kind], settings, handlers: handlers('b'), token: `b${tick}` })
    ]);
  }
  assert.equal(runs.length, 3);
});

test('RC-2: un tick que dura más que el periodo no se solapa con el siguiente', async () => {
  const { store, advance, now } = world();
  const kind = scheduleKind('slowSweep');
  store.ensureRecurring({ kind, spec: '* * * * *', dueAt: now() });
  // La réplica a reclama y se queda dentro de su tick (no devuelve todavía); b sondea un periodo después.
  const claimed = store.claim({ kinds: [kind], limit: 10, leaseMs: settings.leaseMs, token: 'a' });
  assert.equal(claimed.length, 1);
  advance(MINUTE);
  const second = await pollOnce({ store, kinds: [kind], settings, handlers: () => assert.fail('b no debía ejecutar'), token: 'b' });
  assert.equal(second.claimed, 0);
});

test('RC-3: tras una parada más larga que varios periodos se ejecuta un solo tick, y el siguiente se cuenta desde ahora', async () => {
  const { store, advance, now } = world();
  const kind = scheduleKind('sweepPages');
  store.ensureRecurring({ kind, spec: '*/5 * * * *', dueAt: now() + 5 * MINUTE });
  advance(60 * MINUTE);
  let runs = 0;
  const handlers = () => recurringTick({ run: () => (runs += 1), dbNow: now, nextTick: (from) => from + 5 * MINUTE });
  await pollOnce({ store, kinds: [kind], settings, handlers, token: 't1' });
  await pollOnce({ store, kinds: [kind], settings, handlers, token: 't2' });
  assert.equal(runs, 1);
  assert.equal(store.rows()[0].dueAt, now() + 5 * MINUTE);
});

test('RC-4: un spec cambiado al arrancar recalcula due_at; el mismo spec no lo toca', () => {
  const { store, now } = world();
  const kind = scheduleKind('sweepPages');
  store.ensureRecurring({ kind, spec: '*/5 * * * *', dueAt: now() + 5 * MINUTE });
  store.ensureRecurring({ kind, spec: '*/5 * * * *', dueAt: now() + 99 * MINUTE });
  assert.equal(store.rows()[0].dueAt, now() + 5 * MINUTE);
  store.ensureRecurring({ kind, spec: '*/10 * * * *', dueAt: now() + 10 * MINUTE });
  assert.equal(store.rows()[0].dueAt, now() + 10 * MINUTE);
  assert.equal(store.rows()[0].entityId, NIL_ENTITY_ID);
});

test('RC-5: una réplica ignora un kind que no conoce, y no lo borra', async () => {
  const { store, advance, now } = world();
  store.ensureRecurring({ kind: scheduleKind('retiredSweep'), spec: '* * * * *', dueAt: now() });
  advance(MINUTE);
  const pass = await pollOnce({ store, kinds: [scheduleKind('sweepPages')], settings, handlers: () => assert.fail('no es suyo'), token: 't' });
  assert.equal(pass.claimed, 0);
  assert.equal(store.rows().length, 1);
});

test('RC-6 y DL-7: lo que una réplica dejó arrendado al morir lo retoma otra al vencer el arriendo, y no antes', async () => {
  const { store, advance, now } = world();
  const kind = deadlineKind('Reservation', 'pending');
  store.arm({ kind, entityId: 'r1', dueAt: now() });
  store.claim({ kinds: [kind], limit: 10, leaseMs: settings.leaseMs, token: 'muerta' });
  let dispatched = 0;
  const handlers = async () => {
    dispatched += 1;
    return { done: true };
  };
  advance(settings.leaseMs - 1);
  assert.equal((await pollOnce({ store, kinds: [kind], settings, handlers, token: 'viva' })).claimed, 0);
  advance(2);
  assert.equal((await pollOnce({ store, kinds: [kind], settings, handlers, token: 'viva2' })).claimed, 1);
  assert.equal(dispatched, 1);
  // La valla: la réplica muerta, si resucita, ya no puede borrar ni rearmar lo que otra se llevó.
  assert.equal(store.complete({ id: 't1', token: 'muerta' }), 0);
});

test('DL-5: el reclamo devuelve solo lo vencido, en orden de due_at', () => {
  const { store, now } = world();
  const kind = deadlineKind('Reservation', 'pending');
  store.arm({ kind, entityId: 'tarde', dueAt: now() - 1000 });
  store.arm({ kind, entityId: 'antes', dueAt: now() - 5000 });
  store.arm({ kind, entityId: 'futuro', dueAt: now() + 1000 });
  const claimed = store.claim({ kinds: [kind], limit: 10, leaseMs: settings.leaseMs, token: 't' });
  assert.deepEqual(claimed.map((timer) => timer.entityId), ['antes', 'tarde']);
});

test('DL-8 y DL-9: la revalidación descarta la entidad que ya salió del estado y rearma el plazo alargado', async () => {
  const { store, now } = world();
  const kind = deadlineKind('Reservation', 'pending');
  const entities = {
    salio: { state: 'confirmed', sinceMs: now() - 20 * MINUTE },
    alargado: { state: 'pending', sinceMs: now() - 20 * MINUTE },
    vencido: { state: 'pending', sinceMs: now() - 20 * MINUTE }
  };
  for (const id of Object.keys(entities)) store.arm({ kind, entityId: id, dueAt: now() - 5 * MINUTE });
  const dispatched = [];
  const afterSecondsOf = { salio: 900, alargado: 3600, vencido: 900 };
  await pollOnce({
    store,
    kinds: [kind],
    settings,
    token: 't',
    handlers: (timer) =>
      deadlineTick({
        timer,
        loadEntity: (id) => entities[id],
        state: 'pending',
        afterSeconds: afterSecondsOf[timer.entityId],
        dbNowMs: now(),
        dispatch: (id) => dispatched.push(id)
      })
  });
  assert.deepEqual(dispatched, ['vencido']);
  assert.deepEqual(store.rows().map((row) => [row.entityId, row.dueAt]), [['alargado', entities.alargado.sinceMs + 3600 * 1000]]);
});

test('DL-10: el sondeador duerme hasta el siguiente vencimiento, con el tope, y aparca tras max-attempts fallos', async () => {
  const { store, advance, now } = world();
  const kind = deadlineKind('Reservation', 'pending');
  assert.equal(sleepMs(null, settings.maxSleepMs), settings.maxSleepMs);
  assert.equal(sleepMs(-50, settings.maxSleepMs), 0);
  store.arm({ kind, entityId: 'r1', dueAt: now() + 7000 });
  assert.equal((await pollOnce({ store, kinds: [kind], settings, handlers: () => ({ done: true }), token: 't0' })).sleepMs, 7000);
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    advance(settings.retryDelayMs + 7000);
    await pollOnce({ store, kinds: [kind], settings, handlers: () => { throw new Error('el handler falla'); }, token: `t${attempt}` });
  }
  const [row] = store.rows();
  assert.equal(row.attempts, settings.maxAttempts);
  assert.notEqual(row.parkedAt, null, 'agotados los intentos, se aparca');
  advance(MINUTE);
  assert.equal((await pollOnce({ store, kinds: [kind], settings, handlers: () => assert.fail('aparcado'), token: 'tx' })).claimed, 0);
});

test('armar otra vez el mismo plazo lo rearma: borra el arriendo, los intentos y el aparcado', () => {
  const { store, now } = world();
  const kind = deadlineKind('Reservation', 'pending');
  store.arm({ kind, entityId: 'r1', dueAt: now() - 1 });
  store.claim({ kinds: [kind], limit: 1, leaseMs: settings.leaseMs, token: 't' });
  store.arm({ kind, entityId: 'r1', dueAt: now() + 1000 });
  const [row] = store.rows();
  assert.equal(store.rows().length, 1);
  assert.deepEqual([row.claimToken, row.claimedUntil, row.attempts, row.parkedAt], [null, null, 0, null]);
});
