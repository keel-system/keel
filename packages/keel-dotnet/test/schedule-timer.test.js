// El `schedule` de las operaciones sobre el cronómetro (DSL 2.26, PLAN-DSL-226-PLAZOS.md, incremento 8), sin SDK: lo que
// emite keel-dotnet es lo que emite keel-spring (el kind, el cron, el temporizador por operación, el aviso del lote lleno
// en los reclamos, FireTimer en el arnés y el registro en el gate). Lo que el C# hace —que el tick drena con el reclamo
// real, que dos réplicas no lo ejecutan dos veces— lo dicen `npm run db-check` y `npm run doc-check`; que compila,
// `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { scheduledOperations } from '@keel-system/keel-core/gen';
import { timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { scheduleTimerClass } from '../src/scaffold/timer.js';
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
  test(`${name} (${database}): cada schedule es un <Operación>ScheduleTimer con el kind y el cron de keel-spring, fuera de las tareas del reloj`, () => {
    const { model, files } = plan(name, database);
    const theirs = plan(name, database, planSpring).files;
    assert.ok(scheduledOperations(model).length > 0);
    for (const schedule of timerSchedules(model)) {
      const timer = named(files, `/${scheduleTimerClass(schedule.operation)}.cs`);
      assert.ok(timer, `keel-dotnet no emite ${scheduleTimerClass(schedule.operation)}`);
      const springCron = /return "([^"]+)";\s+\}\s+@Override\s+public void tick/.exec(named(theirs, `/${scheduleTimerClass(schedule.operation)}.java`))[1];
      assert.ok(timer.includes(`public string Spec => "${springCron}";`), `${schedule.operation}: el cron no es el de keel-spring`);
      assert.match(timer, /: IRecurringTimerHandler/);
      assert.match(timer, /var full = await SweepPass\.Run\(\(\) => scheduler\.\w+\(cancellationToken\)\);/);
      assert.ok(named(files, 'Timers/TimerKinds.cs').includes(`= "${schedule.kind}";`));
      assert.ok(named(files, 'Timers/TimerRegistration.cs').includes(`services.AddScoped<IRecurringTimerHandler, ${scheduleTimerClass(schedule.operation)}>();`));
    }
    // El scheduler ya no da sus tareas al reloj de Scheduling: las dispara el cronómetro.
    for (const file of files.filter((candidate) => /\/Scheduling\/\w+Scheduler\.cs$/.test(candidate.path))) {
      assert.match(file.content, /public static IReadOnlyList<ScheduledTask> Tasks\(\) =>\s+\[\];/, file.path);
    }
    assert.ok(named(files, 'Support/SweepPass.cs'), 'sin SweepPass no hay drenaje');
  });
}

test('los reclamos generados avisan del lote lleno, en las dos ramas y en la reconciliación, como en keel-spring', () => {
  assert.match(named(plan('job-dispatch', 'postgresql').files, 'Repositories/JobRepository.cs'), /SweepPass\.Claimed\(candidates\.Count, batch\);/);
  assert.match(named(plan('job-dispatch-mongo', 'mongodb').files, 'Repositories/JobRepository.cs'), /SweepPass\.Claimed\(claimed\.Count, batch\);/);
  const reconciling = plan('stock-reservation', 'postgresql').files.filter((file) => /Repositories\/\w+Repository\.cs$/.test(file.path) && file.content.includes('reconciliationClaims.Claim('));
  assert.ok(reconciling.length > 0);
  for (const file of reconciling) {
    assert.match(file.content, /SweepPass\.Claimed\(candidates\.Count, window\.BatchSize\);/, file.path);
    assert.match(file.content, /using \w+\.Application\.Support;/, `${file.path}: sin el using de SweepPass`);
  }
});

test('el arnés adelanta el barrido en el cronómetro tras fabricar su precondición', () => {
  const flow = (name, database) => named(plan(name, database).files, 'Support/FlowTest.cs');
  const rescue = flow('job-dispatch', 'postgresql');
  assert.match(rescue, /protected static void FireTimer\(string kind\)/);
  const stall = rescue.slice(rescue.indexOf('protected static void StallInFlight'), rescue.indexOf('protected static void PutInFlight'));
  assert.ok(stall.includes('FireSchedule(operation);'), stall);
  const reconciliation = flow('stock-reservation', 'postgresql');
  const aged = reconciliation.slice(reconciliation.indexOf('protected static void AgeForReconciliation'));
  assert.ok(aged.slice(0, aged.indexOf('\n    }\n')).includes('FireAgedSweeps(activation);'));
  assert.ok(flow('job-dispatch-mongo', 'mongodb').includes('db.getCollection(\\"keel_timer\\").updateMany({ kind: \\"'));
});

test('el gate lleva el registro del barrido de reconciliación en el cronómetro, el mismo sujeto que keel-spring', () => {
  const subjects = (files) => [...named(files, 'infra/check-idempotency.sh').matchAll(/'([A-Za-z]+ScheduleTimer · registro en el cronómetro)'/g)].map((match) => match[1]).sort();
  const ours = subjects(plan('stock-reservation', 'postgresql').files);
  assert.ok(ours.length > 0);
  assert.deepEqual(ours, subjects(plan('stock-reservation', 'postgresql', planSpring).files));
});
