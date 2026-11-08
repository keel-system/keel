// El `schedule` de las operaciones sobre el cronómetro (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 8), sin red: lo que
// emite keel-nest es lo que emite keel-spring (el kind, el cron, el temporizador por operación, el aviso del lote lleno en
// los reclamos, fireTimer en el arnés y el registro en el gate), y el drenaje del <Operación>ScheduleTimer EMITIDO se
// ejecuta contra los casos DR de keel-core. Lo que el motor dice —que el tick drena con el reclamo real, que dos réplicas
// no lo ejecutan dos veces— lo dicen `npm run db-check` y `npm run doc-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { scheduledOperations } from '@keel-system/keel-core/gen';
import { DRAIN_CASES, batchFull, drainReference, timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { SWEEP_PASS_TS, scheduleTimerClass, scheduleTimerPath } from '../src/scaffold/timer.js';
import { schedulerPath } from '../src/scaffold/scheduling.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

function spring(name, stack) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files;
}

for (const [name, stack] of [
  ['job-dispatch', STACK],
  ['job-dispatch-mongo', { database: 'mongodb', broker: 'rabbitmq' }],
  ['stock-reservation', STACK],
  ['payment-checkout', STACK],
  ['notification-mailer-mongo', { database: 'mongodb', broker: 'rabbitmq' }]
]) {
  test(`${name}: cada schedule es un <Operación>ScheduleTimer con el kind y el cron de keel-spring, y el scheduler no se registra en el reloj`, () => {
    const { model, files } = planFixture(name, { stack });
    const theirs = spring(name, stack);
    const operations = scheduledOperations(model);
    assert.ok(operations.length > 0);
    assert.equal(timerSchedules(model).length, operations.length);
    for (const schedule of timerSchedules(model)) {
      const timer = content(files, scheduleTimerPath(schedule.operation));
      assert.ok(timer, `keel-nest no emite ${scheduleTimerClass(schedule.operation)}`);
      const springTimer = content(theirs, `/${scheduleTimerClass(schedule.operation)}.java`);
      assert.ok(springTimer, `keel-spring no emite ${scheduleTimerClass(schedule.operation)}`);
      const springCron = /return "([^"]+)";\s+\}\s+@Override\s+public void tick/.exec(springTimer)[1];
      assert.ok(timer.includes(`readonly spec = '${springCron}';`), `${schedule.operation}: el cron no es el de keel-spring (${springCron})`);
      assert.ok(timer.includes(`this.scheduler.${schedule.operation}()`), `${schedule.operation}: el tick no llama a su scheduler`);
      const service = model.services.find((candidate) => candidate.operations.includes(operations.find((operation) => operation.name === schedule.operation)));
      const scheduler = content(files, schedulerPath(service));
      assert.ok(!scheduler.includes(`name: '${schedule.operation}'`), `${schedule.operation}: el scheduler la sigue registrando en el reloj, que corre en todas las réplicas`);
    }
    assert.ok(content(files, SWEEP_PASS_TS), 'sin SweepPass no hay drenaje');
    assert.ok(content(files, 'src/infrastructure/timer/timer-kinds.ts').includes(`'${timerSchedules(model)[0].kind}'`));
  });
}

test('los reclamos generados avisan del lote lleno, en las dos ramas y en la reconciliación, como en keel-spring', () => {
  const relational = content(planFixture('job-dispatch', { stack: STACK }).files, 'job-repository-impl.ts');
  assert.match(relational, /SweepPass\.claimed\(candidates\.length, this\.sweeps\.batchSize\['[\w-]+'\]!\);/);
  const document = content(planFixture('job-dispatch-mongo', { stack: { database: 'mongodb' } }).files, 'job-repository-impl.ts');
  assert.match(document, /SweepPass\.claimed\(claimed\.length, this\.sweeps\.batchSize\['[\w-]+'\]!\);/);
  const reconciling = planFixture('stock-reservation', { stack: STACK }).files.filter((file) => file.path.endsWith('-repository-impl.ts') && file.content.includes('reconciliationClaims.claim('));
  assert.ok(reconciling.length > 0);
  for (const file of reconciling) assert.match(file.content, /SweepPass\.claimed\(candidates\.length, window\.batchSize\);/, file.path);
});

test('el arnés adelanta el barrido en el cronómetro tras fabricar su precondición', () => {
  const flow = (name, stack) => content(planFixture(name, { stack }).files, 'test/integration/support/flow.ts');
  const rescue = flow('job-dispatch', STACK);
  assert.match(rescue, /export function fireTimer\(kind: string\): void/);
  const stall = rescue.slice(rescue.indexOf('export function stallInFlight'), rescue.indexOf('export function putInFlight'));
  assert.ok(stall.includes('fireSchedule(operation);'), stall);
  const reconciliation = flow('stock-reservation', STACK);
  const aged = reconciliation.slice(reconciliation.indexOf('export function ageForReconciliation'));
  assert.ok(aged.slice(0, aged.indexOf('\n}\n')).includes('fireAgedSweeps(activation);'), aged.slice(0, 400));
  const documental = flow('job-dispatch-mongo', { database: 'mongodb' });
  assert.ok(documental.includes('db.getCollection("keel_timer").updateMany({ kind: "'), 'fireTimer documental');
  assert.ok(documental.includes('fireSchedule(operation);'));
});

test('el gate lleva el registro del barrido de reconciliación en el cronómetro, el mismo sujeto que keel-spring', () => {
  const ours = content(planFixture('stock-reservation', { stack: STACK }).files, 'infra/check-idempotency.sh');
  const theirs = content(spring('stock-reservation', STACK), 'infra/check-idempotency.sh');
  const subjects = (script) => [...script.matchAll(/'([A-Za-z]+ScheduleTimer · registro en el cronómetro)'/g)].map((match) => match[1]).sort();
  assert.ok(subjects(ours).length > 0);
  assert.deepEqual(subjects(ours), subjects(theirs));
});

const STUBS = {
  '@nestjs/common': `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export class Logger { log() {} warn() {} error() {} }`,
  // El sondeador arrastra la transacción, que arrastra la traducción de errores del ORM: solo hace falta el nombre.
  typeorm: 'export class QueryFailedError extends Error {}',
  // El siguiente tick de un cron de cada minuto: lo que importa aquí es el presupuesto, no la librería.
  cron: `
export class CronTime {
  constructor(spec) { this.spec = spec; }
  getNextDateFrom(from) { return { toJSDate: () => new Date(from.getTime() + 60_000) }; }
}`
};

test('el <Operación>ScheduleTimer EMITIDO drena como la referencia de keel-core (DR-1 a DR-3)', async () => {
  const { files } = planFixture('job-dispatch', { stack: STACK });
  const tree = transpileTree(files, { stubs: STUBS });
  const { DispatchJobsScheduleTimer } = await tree.load(scheduleTimerPath('dispatchJobs'));
  const { SweepPass } = await tree.load(SWEEP_PASS_TS);
  /** Un barrido de `pending` candidatos con lotes de `batch`, reclamado por un scheduler doblado que avisa del lote. */
  const run = async (pending, batch, budget) => {
    let passes = 0;
    const scheduler = {
      dispatchJobs: async () => {
        passes += 1;
        const taken = Math.min(batch, pending);
        pending -= taken;
        SweepPass.claimed(taken, batch);
      }
    };
    await new DispatchJobsScheduleTimer(scheduler, { drainBudgetMs: budget }).tick();
    return { passes, pending };
  };
  // Lo mismo, contra la referencia.
  const reference = async (pending, batch, budget) => {
    let left = pending;
    let now = 0;
    const passes = await drainReference({
      pass: () => {
        const taken = Math.min(batch, left);
        left -= taken;
        now += budget === 0 ? 1 : 0;
        return batchFull(taken, batch);
      },
      budgetMs: budget,
      nowMs: () => now
    });
    return { passes, pending: left };
  };
  for (const [id, pending, batch, budget] of [
    [DRAIN_CASES[0].id, 7, 3, 60_000],
    [DRAIN_CASES[1].id, 2, 3, 60_000],
    [DRAIN_CASES[2].id, 9, 3, 0]
  ]) {
    assert.deepEqual(await run(pending, batch, budget), await reference(pending, batch, budget), id);
  }
  // Fuera de un tick, avisar no hace nada: un despacho por otra puerta no arrastra a nadie.
  SweepPass.claimed(10, 3);
  assert.equal(await SweepPass.run(async () => {}), false);
});
