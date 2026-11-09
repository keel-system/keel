// El `schedule` de las operaciones sobre el cronómetro (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 8), sin Go: lo que
// emite keel-go es lo que emite keel-spring (el kind, el cron, el recurrente por operación, el aviso del lote lleno en los
// reclamos, FireTimer en el arnés y el registro en el gate). Lo que el Go hace —que el tick drena con el reclamo real, que
// dos réplicas no lo ejecutan dos veces— lo dicen `npm run db-check` y `npm run doc-check`; que compila y que su prueba
// emitida (schedules_test.go) pasa, `npm run go-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { scheduledOperations } from '@keel-system/keel-core/gen';
import { timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { scheduleKindConstant } from '../src/scaffold/timer.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const plan = (name, database, planner = planService) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planner({ manifest, layers, workspace: FIXTURES_DIR, stack: { database, ...(layers.messaging ? { broker: 'rabbitmq' } : {}) } });
};
const named = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

for (const [name, database] of [
  ['job-dispatch', 'postgresql'],
  ['job-dispatch', 'mysql'],
  ['job-dispatch-mongo', 'mongodb'],
  ['stock-reservation', 'postgresql'],
  ['payment-checkout', 'postgresql'],
  ['notification-mailer-mongo', 'mongodb']
]) {
  test(`${name} (${database}): cada schedule va al cronómetro con el kind y el cron de keel-spring, y no al reloj`, () => {
    const { model, files } = plan(name, database);
    const theirs = plan(name, database, planSpring).files;
    assert.ok(scheduledOperations(model).length > 0);
    const kinds = named(files, 'internal/infrastructure/timer/kinds.go');
    for (const schedule of timerSchedules(model)) {
      const java = named(theirs, `/${schedule.operation[0].toUpperCase()}${schedule.operation.slice(1)}ScheduleTimer.java`);
      const springCron = /return "([^"]+)";\s+\}\s+@Override\s+public void tick/.exec(java)[1];
      assert.equal(schedule.cron, springCron, `${schedule.operation}: el cron no es el de keel-spring`);
      assert.match(kinds, new RegExp(`${scheduleKindConstant(schedule.operation)}\\s+= "${schedule.kind}"`));
      // El cron lo da la tarea, que es la que fija el segundo repartido.
      assert.ok(files.some((file) => file.path.endsWith('_tasks.go') && file.content.includes(`{Name: "${schedule.operation}", Cron: "${schedule.cron}",`)), schedule.operation);
    }
    const main = named(files, 'cmd/server/main.go');
    assert.ok(main.includes('timer.NewSchedule(task.Name, task.Cron, task.Run, timerSettings)'));
    assert.doesNotMatch(main, /tasks = append\(tasks, scheduler\.\w+Tasks\(useCases\)\.\.\.\)/, 'el reloj no dispara lo que dispara el cronómetro');
    assert.match(named(files, 'internal/infrastructure/timer/schedules.go'), /const ScheduleKindPrefix = "schedule:"/);
    assert.ok(named(files, 'internal/application/sweep_pass.go'), 'sin la señal no hay drenaje');
  });
}

test('los reclamos generados avisan del lote lleno, en las dos ramas y en la reconciliación, como en keel-spring', () => {
  assert.match(named(plan('job-dispatch', 'postgresql').files, 'postgres/job_repository.go'), /application\.SweepClaimed\(ctx, len\(ids\), batch\)/);
  assert.match(named(plan('job-dispatch-mongo', 'mongodb').files, 'mongo/job_repository.go'), /application\.SweepClaimed\(ctx, len\(claimed\), batch\)/);
  const reconciling = plan('stock-reservation', 'postgresql').files.filter((file) => /postgres\/\w+_repository\.go$/.test(file.path) && file.content.includes('claimReconciliation('));
  assert.ok(reconciling.length > 0);
  for (const file of reconciling) assert.match(file.content, /application\.SweepClaimed\(ctx, len\(ids\), window\.BatchSize\)/, file.path);
});

test('el arnés adelanta el barrido en el cronómetro tras fabricar su precondición', () => {
  const flow = (name, database) => named(plan(name, database).files, 'tests/integration/flow_test.go');
  const rescue = flow('job-dispatch', 'postgresql');
  assert.match(rescue, /func \(s \*Scenario\) FireTimer\(kind string\)/);
  const stall = rescue.slice(rescue.indexOf('func (s *Scenario) StallInFlight'), rescue.indexOf('func (s *Scenario) PutInFlight'));
  assert.ok(stall.includes('s.fireSchedule(operation)'), stall);
  const stub = named(plan('stock-reservation', 'postgresql').files, 'tests/integration/flow_test.go');
  const aged = stub.slice(stub.indexOf('func (s *Scenario) AgeForReconciliation'));
  assert.ok(aged.slice(0, aged.indexOf('\n}\n')).includes('s.fireAgedSweeps(activation)'));
  assert.ok(flow('job-dispatch-mongo', 'mongodb').includes('db.getCollection(\\"keel_timer\\").updateMany({ kind: \\"'));
});

test('el gate lleva el registro del barrido de reconciliación en el cronómetro, el mismo sujeto que keel-spring', () => {
  const subjects = (files) => [...named(files, 'infra/check-idempotency.sh').matchAll(/'([A-Za-z]+ScheduleTimer · registro en el cronómetro)'/g)].map((match) => match[1]).sort();
  const ours = subjects(plan('stock-reservation', 'postgresql').files);
  assert.ok(ours.length > 0);
  assert.deepEqual(ours, subjects(plan('stock-reservation', 'postgresql', planSpring).files));
});
