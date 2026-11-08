// QUÉ corre sobre el cronómetro (PLAN-DSL-226-PLAZOS.md, incremento 7): cuándo existe y qué purgas monta como
// recurrentes en modo clúster, sobre las fixtures reales del repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { PROBE } from './helpers/probe-projection.js';
import { usesDeadlines } from '../src/lib/gen/deadlines.js';
import { GENERATOR_TABLES } from '../src/lib/gen/schema-steps.js';
import { KEEL_TIMER, TIMER_PARAMETERS, TIMER_PURGE_KIND, purgeKind, scheduleKind } from '../src/lib/gen/timer-store.js';
import { scheduleCron, scheduledOperations } from '../src/lib/gen/scheduling.js';
import {
  DRAIN_CASES,
  TIMER_DATABASES,
  batchFull,
  clusterRecurrings,
  drainBudgetMs,
  drainReference,
  generatorPurges,
  generatorSchedules,
  purgedByTimer,
  scheduledByTimer,
  timerPurges,
  timerSchedules,
  usesTimer
} from '../src/lib/gen/timer-plan.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/designs');
const fixtures = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'service.keel.yaml')));

function model(name, database = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES, name));
  const document = layers.persistence?.default?.model === 'document';
  const stack = { ...STACK_DEFAULTS, database: database ?? (document ? 'mongodb' : 'postgresql') };
  // Los generadores cuelgan el stack del modelo después de construirlo; aquí, igual.
  return { ...buildModel({ manifest, layers, stack, projection: PROBE }), stack };
}

test('cada purga del generador es la de una de sus tablas, con su kind en keel_timer y su cron de keel-core', () => {
  const tables = GENERATOR_TABLES.map((table) => table.table);
  let seen = 0;
  for (const name of fixtures) {
    for (const purge of generatorPurges(model(name))) {
      seen += 1;
      assert.ok(tables.includes(purge.table), `${name}: ${purge.table} no es una tabla del generador`);
      assert.notEqual(purge.table, KEEL_TIMER.table, 'la purga de keel_timer no es una purga del generador: es de la propia tabla');
      assert.equal(purge.kind, purgeKind(purge.table));
      assert.equal(purge.cron.cron, true, `${purge.table}: su parámetro no es un cron`);
      assert.match(purge.cron.key, /\.purge\.cron$/);
    }
  }
  assert.ok(seen > 0, 'ninguna fixture tiene purgas: la prueba no mide nada');
});

test('el cronómetro existe con plazos, purgas o schedule, y entonces los lleva TODOS en modo clúster', () => {
  let withPurges = 0;
  for (const name of fixtures) {
    const subject = model(name);
    const purges = generatorPurges(subject);
    const schedules = generatorSchedules(subject);
    const expected = Boolean(subject.layersPresent.persistence) && (usesDeadlines(subject) || purges.length > 0 || schedules.length > 0);
    assert.equal(usesTimer(subject), expected, name);
    if (!usesTimer(subject)) {
      assert.deepEqual(timerPurges(subject), [], name);
      assert.deepEqual(clusterRecurrings(subject), [], name);
      assert.deepEqual(timerSchedules(subject), [], name);
      continue;
    }
    if (purges.length > 0) withPurges += 1;
    assert.deepEqual(timerPurges(subject), purges, name);
    // La purga de la propia tabla (R7) va primero, y después las del generador, sin repetir un kind.
    const kinds = clusterRecurrings(subject).map((recurring) => recurring.kind);
    assert.equal(kinds[0], TIMER_PURGE_KIND, name);
    assert.deepEqual(kinds.slice(1), [...purges, ...schedules].map((recurring) => recurring.kind), name);
    assert.deepEqual(timerSchedules(subject), schedules, name);
    assert.equal(new Set(kinds).size, kinds.length, `${name}: kinds repetidos`);
    for (const purge of purges) assert.ok(purgedByTimer(subject, purge.table), `${name}: ${purge.table}`);
  }
  assert.ok(withPurges >= 4, `solo ${withPurges} fixtures montan purgas en el cronómetro`);
});

test('un motor sin sentencias del cronómetro conserva el cron por réplica de sus purgas (degradado)', () => {
  // notification-mailer tiene outbox y guarda de mensajes: sobre MariaDB no hay cronómetro, y sus purgas se quedan fuera.
  for (const database of ['mariadb', 'sqlserver', 'oracle']) {
    assert.ok(!TIMER_DATABASES.includes(database));
    const subject = model('notification-mailer', database);
    assert.ok(generatorPurges(subject).length > 0);
    assert.equal(usesTimer(subject), false, database);
    assert.deepEqual(timerPurges(subject), [], database);
    assert.equal(purgedByTimer(subject, 'outbox_event'), false);
  }
  for (const database of TIMER_DATABASES.filter((id) => id !== 'mongodb')) {
    const subject = model('notification-mailer', database);
    assert.equal(usesTimer(subject), true, database);
    assert.ok(purgedByTimer(subject, 'outbox_event'), database);
  }
  assert.ok(purgedByTimer(model('notification-mailer-mongo'), 'outbox_event'));
});

test('cada schedule del diseño es un recurrente del cronómetro, con su kind y el cron de seis campos de scheduleCron', () => {
  let seen = 0;
  for (const name of fixtures) {
    const subject = model(name);
    const operations = scheduledOperations(subject);
    const schedules = timerSchedules(subject);
    assert.equal(schedules.length, operations.length, `${name}: un schedule que no llega al cronómetro`);
    for (const operation of operations) {
      seen += 1;
      const schedule = schedules.find((entry) => entry.operation === operation.name);
      assert.equal(schedule.kind, scheduleKind(operation.name));
      assert.equal(schedule.cron, scheduleCron(subject, operation));
      assert.equal(schedule.cron.split(' ').length, 6, `${name}: el cron no lleva el segundo repartido`);
      assert.ok(scheduledByTimer(subject, operation.name));
    }
  }
  assert.ok(seen >= 10, `solo ${seen} schedule en las fixtures: la prueba no mide nada`);
});

test('un schedule sobre un motor sin cronómetro conserva su reloj por réplica', () => {
  for (const database of ['mariadb', 'sqlserver', 'oracle']) {
    const subject = model('job-dispatch', database);
    assert.ok(generatorSchedules(subject).length > 0);
    assert.deepEqual(timerSchedules(subject), [], database);
    assert.equal(scheduledByTimer(subject, generatorSchedules(subject)[0].operation), false);
  }
  const subject = model('job-dispatch');
  assert.ok(usesTimer(subject));
  assert.ok(timerSchedules(subject).length > 0);
});

test('batchFull: el lote lleno deja candidatos; uno a medias, no', () => {
  assert.equal(batchFull(100, 100), true);
  assert.equal(batchFull(99, 100), false);
  assert.equal(batchFull(0, 100), false);
  assert.equal(batchFull(0, 0), false, 'sin cota no hay drenaje: un lote vacío no puede llenarse');
});

test('el presupuesto del drenaje: hasta el siguiente tick y nunca más que timer.drain-budget-ms (menor que el arriendo)', () => {
  assert.ok(TIMER_PARAMETERS.drainBudgetMs.default < TIMER_PARAMETERS.leaseMs.default, 'T4: el tick tiene que caber en su arriendo');
  assert.equal(drainBudgetMs({ startMs: 0, nextTickMs: 300000, maxBudgetMs: 60000 }), 60000);
  assert.equal(drainBudgetMs({ startMs: 0, nextTickMs: 20000, maxBudgetMs: 60000 }), 20000);
  assert.equal(drainBudgetMs({ startMs: 50, nextTickMs: 10, maxBudgetMs: 60000 }), 0);
});

/** Un barrido de referencia: `pending` candidatos, lotes de `batch`; cada pasada reclama y dice si salió lleno. */
function sweep(pending, batch, clock, msPerPass = 1) {
  const state = { pending, claimed: [] };
  state.pass = () => {
    const taken = Math.min(batch, state.pending);
    state.pending -= taken;
    state.claimed.push(taken);
    clock.now += msPerPass;
    return batchFull(taken, batch);
  };
  return state;
}

test(`${DRAIN_CASES[0].id}: ${DRAIN_CASES[0].what}`, async () => {
  const clock = { now: 0 };
  const subject = sweep(250, 100, clock);
  const passes = await drainReference({ pass: subject.pass, budgetMs: 60000, nowMs: () => clock.now });
  assert.equal(subject.pending, 0);
  assert.deepEqual(subject.claimed, [100, 100, 50]);
  assert.equal(passes, 3);
});

test('DR-1 en el borde: con candidatos múltiplo del lote, la última pasada sale vacía y para', async () => {
  const clock = { now: 0 };
  const subject = sweep(200, 100, clock);
  assert.equal(await drainReference({ pass: subject.pass, budgetMs: 60000, nowMs: () => clock.now }), 3);
  assert.deepEqual(subject.claimed, [100, 100, 0]);
});

test(`${DRAIN_CASES[1].id}: ${DRAIN_CASES[1].what}`, async () => {
  const clock = { now: 0 };
  const subject = sweep(40, 100, clock);
  assert.equal(await drainReference({ pass: subject.pass, budgetMs: 60000, nowMs: () => clock.now }), 1);
  assert.equal(subject.pending, 0);
});

test(`${DRAIN_CASES[2].id}: ${DRAIN_CASES[2].what}`, async () => {
  const clock = { now: 0 };
  const subject = sweep(10000, 100, clock, 1000);
  const passes = await drainReference({ pass: subject.pass, budgetMs: 3000, nowMs: () => clock.now });
  assert.equal(passes, 3);
  assert.equal(subject.pending, 10000 - 300, 'lo que quede pasa al siguiente tick');
});

test('el drenaje sin presupuesto hace igualmente UNA pasada: el tick nunca se queda sin trabajar', async () => {
  const clock = { now: 0 };
  const subject = sweep(500, 100, clock);
  assert.equal(await drainReference({ pass: subject.pass, budgetMs: 0, nowMs: () => clock.now }), 1);
});

test('claimDrains: avisan del lote lleno los reclamos generados de un barrido o de una reconciliación sobre el cronómetro', async () => {
  const { claimDrains } = await import('../src/lib/gen/timer-plan.js');
  const { reconciliationClaims } = await import('../src/lib/gen/reconciliation-stores.js');
  let seen = 0;
  for (const name of fixtures) {
    const subject = model(name);
    const operations = subject.services.flatMap((service) => service.operations ?? []);
    for (const operation of operations) {
      for (const claim of operation.claim ?? []) {
        seen += 1;
        assert.equal(claimDrains(subject, claim), scheduledByTimer(subject, operation.name), `${name}: ${claim.method}`);
      }
    }
    for (const claim of reconciliationClaims(subject)) {
      seen += 1;
      assert.ok(claimDrains(subject, claim), `${name}: el reclamo de reconciliación ${claim.method} no drena`);
    }
  }
  assert.ok(seen >= 4, `solo ${seen} reclamos generados en las fixtures`);
  const mariadb = model('job-dispatch', 'mariadb');
  const claim = mariadb.services.flatMap((service) => service.operations).flatMap((operation) => operation.claim ?? [])[0];
  assert.equal(claimDrains(mariadb, claim), false, 'sin cronómetro no hay tick que drene');
});

test('agingSweeps: lo que envejece el arnés lo recoge el barrido que reconcilia esa activación, o el de pagos', async () => {
  const { agingSweeps, relationalAgingTargets } = await import('../src/lib/gen/aging-targets.js');
  for (const name of ['stock-reservation', 'payment-checkout']) {
    const subject = model(name);
    const sweeps = agingSweeps(subject);
    for (const key of relationalAgingTargets(subject).keys()) {
      const operations = sweeps.get(key) ?? [];
      assert.ok(operations.length > 0, `${name}: nadie recoge lo envejecido de ${key}`);
      for (const operation of operations) assert.ok(scheduledOperations(subject).some((candidate) => candidate.name === operation), operation);
    }
  }
});
