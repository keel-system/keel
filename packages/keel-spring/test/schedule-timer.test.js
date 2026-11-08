// El `schedule` de las operaciones sobre el cronómetro (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 8): lo que build
// emite y lo que las redes en vivo (claim-check, store-check) dan por supuesto. Lo que el motor dice —que un tick drena,
// que dos réplicas no lo ejecutan dos veces— solo lo dicen `npm run claim-check` y `npm run store-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { scheduleKind } from '@keel-system/keel-core/gen/timer-store';
import { scheduledOperations } from '@keel-system/keel-core/gen';
import { timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { planService } from '../src/scaffold/index.js';
import { scheduleTimerClass, schedulerClassOf } from '../src/scaffold/timer.js';
import { claimScenarios, claimTestClass, drainSubject, DRAIN_SABOTAGE_CASES } from '../src/lib/claim-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';

function plan(name, database) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: tmpDir('keel-schedule-timer-'), stack: { database } });
}
const javaNamed = (files, basename) => files.find((file) => file.path.endsWith(`/${basename}`));
const annotation = /^\s*@Scheduled\(/m;

const SUBJECTS = [
  ['job-dispatch', 'postgresql'],
  ['job-dispatch', 'mysql'],
  ['job-dispatch-mongo', 'mongodb'],
  ['stock-reservation', 'postgresql'],
  ['payment-checkout', 'postgresql'],
  ['notification-mailer-mongo', 'mongodb']
];

for (const [name, database] of SUBJECTS) {
  test(`${name} (${database}): cada schedule es un <Operación>ScheduleTimer con su kind y su cron, y el scheduler solo despacha`, () => {
    const { model, files } = plan(name, database);
    const operations = scheduledOperations(model);
    assert.ok(operations.length > 0);
    assert.equal(timerSchedules(model).length, operations.length);
    const kinds = javaNamed(files, 'TimerKinds.java').content;
    for (const schedule of timerSchedules(model)) {
      const timer = javaNamed(files, `${scheduleTimerClass(schedule.operation)}.java`);
      assert.ok(timer, `build no emite ${scheduleTimerClass(schedule.operation)}`);
      assert.match(timer.content, /implements RecurringTimerHandler/);
      assert.ok(timer.content.includes(`return "${schedule.cron}";`), `${schedule.operation}: el spec no es el cron de scheduleCron`);
      assert.ok(timer.content.includes(`.${schedule.operation}();`), `${schedule.operation}: el tick no despacha por el scheduler`);
      // El drenaje: repite mientras el lote salga lleno, con el tope del presupuesto.
      assert.match(timer.content, /SweepPass\.begin\(\);/);
      assert.match(timer.content, /full = SweepPass\.end\(\);/);
      assert.match(timer.content, /Duration\.between\(start, Instant\.now\(\)\)\.toMillis\(\) >= budget/);
      assert.ok(kinds.includes(`= "${scheduleKind(schedule.operation)}";`), `TimerKinds no lleva ${schedule.kind}`);
      const scheduler = javaNamed(files, `${schedulerClassOf(model, schedule.operation)}.java`).content;
      assert.ok(!annotation.test(scheduler), `${schedulerClassOf(model, schedule.operation)} conserva un @Scheduled: el barrido correría también en todas las réplicas`);
    }
    assert.ok(javaNamed(files, 'SweepPass.java'), 'sin SweepPass no hay drenaje');
  });
}

test('sin cronómetro (MariaDB) el schedule conserva su @Scheduled por réplica y no hay ScheduleTimer', () => {
  const { model, files } = plan('job-dispatch', 'mariadb');
  assert.deepEqual(timerSchedules(model), []);
  assert.ok(!files.some((file) => file.path.endsWith('ScheduleTimer.java')));
  assert.ok(!javaNamed(files, 'SweepPass.java'));
  const scheduler = files.find((file) => file.path.endsWith('Scheduler.java')).content;
  assert.ok(annotation.test(scheduler), scheduler);
  const adapter = javaNamed(files, 'JobRepositoryImpl.java').content;
  assert.ok(!adapter.includes('SweepPass'), 'sin tick que drene, el reclamo no avisa de nada');
});

test('los reclamos generados avisan del lote lleno, en las dos ramas y en la reconciliación', () => {
  const relational = javaNamed(plan('job-dispatch', 'postgresql').files, 'JobRepositoryImpl.java').content;
  assert.match(relational, /SweepPass\.claimed\(candidates\.size\(\), \w+BatchSize\);/);
  const document = javaNamed(plan('job-dispatch-mongo', 'mongodb').files, 'JobRepositoryImpl.java').content;
  assert.match(document, /SweepPass\.claimed\(claimed\.size\(\), \w+BatchSize\);/);
  const { files } = plan('stock-reservation', 'postgresql');
  const reconciling = files.filter((file) => file.path.endsWith('RepositoryImpl.java') && file.content.includes('reconciliationClaims.claim('));
  assert.ok(reconciling.length > 0);
  for (const file of reconciling) assert.match(file.content, /SweepPass\.claimed\(candidates\.size\(\), \w+BatchSize\);/, file.path);
});

test('un recurrente que falla se rearma, no se aparca', () => {
  const poller = javaNamed(plan('job-dispatch', 'postgresql').files, 'TimerPoller.java').content;
  const tick = poller.slice(poller.indexOf('private void tick('), poller.indexOf('public void onArmed'));
  assert.ok(!tick.includes('store.fail('), tick);
  assert.match(tick, /store\.reschedule\(timer\.id\(\), token, nextTick\(recurring\.spec\(\), store\.dbNow\(\)\)\);/);
});

test('el arnés adelanta el barrido en el cronómetro tras fabricar su precondición', () => {
  const harnessOf = (name, database) => javaNamed(plan(name, database).files, 'AbstractFlowIT.java').content;
  const rescue = harnessOf('job-dispatch', 'postgresql');
  assert.match(rescue, /protected static void fireTimer\(String kind\)/);
  const stall = rescue.slice(rescue.indexOf('protected static void stallInFlight'), rescue.indexOf('protected static void putInFlight'));
  assert.ok(stall.includes('fireTimer("schedule:dispatchJobs");'), stall);
  const reconciliation = harnessOf('stock-reservation', 'postgresql');
  const aged = reconciliation.slice(reconciliation.indexOf('protected static void ageForReconciliation'));
  assert.match(aged.slice(0, aged.indexOf('\n    }\n')), /fireTimer\("schedule:\w+"\);/);
  const documental = harnessOf('job-dispatch-mongo', 'mongodb');
  assert.ok(documental.includes('db.getCollection(\\"keel_timer\\").updateMany({ kind: \\"" + kind + "\\" }'), 'fireTimer documental');
  // Sin cronómetro no hay qué adelantar.
  assert.ok(!harnessOf('job-dispatch', 'mariadb').includes('fireTimer('));
});

test('claim-check: los casos DR se emiten donde la cola corre sobre el cronómetro, y los sabotajes siguen aplicándose', () => {
  for (const [name, database] of [['job-dispatch', 'postgresql'], ['job-dispatch-mongo', 'mongodb']]) {
    const { model, files } = plan(name, database);
    const scenarios = claimScenarios(model);
    const drain = drainSubject(model, scenarios);
    assert.ok(drain, `${name}: sin sujeto del drenaje`);
    const packages = { enums: 'e', port: 'p', entities: 'x', repositories: 'r', scheduling: 's', timer: 't' };
    const source = claimTestClass(model, scenarios, { datasource: { url: 'u', username: 'u', uri: 'mongodb://x' }, packages, database });
    for (const cases of Object.values(DRAIN_SABOTAGE_CASES)) for (const id of cases) assert.ok(source.includes(`void ${id}()`), id);
    assert.ok(source.includes('void dr2_conElLoteAMediasElTickHaceUnaPasada()'));
    // drain-no-signal quita el aviso del adaptador; drain-no-budget, el tope del tick.
    assert.match(javaNamed(files, `${scenarios.entity.name}RepositoryImpl.java`).content, /^\s*SweepPass\.claimed\(.*\);\n/m);
    assert.ok(javaNamed(files, `${drain.timer}.java`).content.includes(' || Duration.between(start, Instant.now()).toMillis() >= budget'));
  }
  assert.equal(drainSubject(plan('job-dispatch', 'mariadb').model, claimScenarios(plan('job-dispatch', 'mariadb').model)), null);
});
