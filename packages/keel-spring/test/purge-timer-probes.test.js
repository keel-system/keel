// Que la sonda de las purgas en modo clúster (src/lib/purge-timer-probes.js, la escribe store-check) mida al GENERADOR:
// los `<Tabla>PurgeTimer` que nombra son los que build emite, los beans que dobla son los que esos recurrentes inyectan,
// y el sabotaje `timer-every-replica` sigue aplicándose al Java de hoy. Lo que la sonda afirma contra el motor (una fila
// por purga, un tick por réplica, el rearme) solo lo dice `npm run store-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { timerPurges, timerSchedules } from '@keel-system/keel-core/gen/timer-plan';
import { planService } from '../src/scaffold/index.js';
import { purgeTimerClass } from '../src/scaffold/timer.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import {
  CLASS_PURGE_TIMER,
  EVERY_REPLICA_CASES,
  everyReplicaSabotage,
  purgeTargetFiles,
  purgeTimerTestClass,
  usesPurgeTimers
} from '../src/lib/purge-timer-probes.js';

function plan(name, database) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: tmpDir('keel-purge-timer-'), stack: { database } });
}
const javaNamed = (files, basename) => files.find((file) => file.path.endsWith(`/${basename}`));

for (const [name, database] of [['notification-mailer', 'postgresql'], ['notification-mailer', 'mysql'], ['notification-mailer-mongo', 'mongodb']]) {
  test(`${name} (${database}): la sonda nombra los recurrentes y los beans que build emite`, () => {
    const { model, files } = plan(name, database);
    assert.ok(usesPurgeTimers(model), 'el par del MVP monta sus purgas en el cronómetro');
    const purges = timerPurges(model);
    assert.ok(purges.length >= 2, 'outbox y guarda de mensajes, al menos');
    const targets = purgeTargetFiles(model);
    for (const purge of purges) {
      const timer = javaNamed(files, `${purgeTimerClass(purge.table)}.java`);
      assert.ok(timer, `build emite ${purgeTimerClass(purge.table)}`);
      const target = targets[purge.table].replace(/\.java$/, '');
      assert.ok(javaNamed(files, targets[purge.table]), `build emite ${target}`);
      // El recurrente inyecta ESE bean y llama a su purge(): es lo que la sonda sustituye por el doble que cuenta.
      assert.match(timer.content, new RegExp(`public ${purgeTimerClass(purge.table)}\\(${target} \\w+\\)`));
      assert.match(timer.content, /\.purge\(\);/);
      assert.ok(timer.content.includes(`@Value("\${${purge.cron.key}:${purge.cron.default}}")`), `${purge.table}: el cron de keel-core`);
    }
    // El bean que purga ya no lleva su @Scheduled: si lo llevara, la purga correría en todas las réplicas además.
    for (const target of Object.values(targets)) {
      const content = javaNamed(files, target).content;
      assert.ok(!/@Scheduled\(cron = "\$\{[\w.-]*purge\.cron/.test(content), `${target} conserva el cron de su purga`);
    }

    const packages = { timer: 'x.timer', mongoTx: 'x.mongo', targets: Object.fromEntries(purges.map((purge) => [purge.table, 'x.target'])) };
    const datasource = database === 'mongodb' ? { uri: 'mongodb://h/db' } : { url: 'jdbc:x', username: 'u', password: 'p' };
    const probe = purgeTimerTestClass(model, { datasource, packages });
    assert.match(probe, new RegExp(`class ${CLASS_PURGE_TIMER} \\{`));
    for (const id of EVERY_REPLICA_CASES) assert.ok(probe.includes(`void ${id}()`), id);
    assert.ok(probe.includes('void r2_elTickRearmaParaElSiguienteCron()'));
    for (const purge of purges) assert.ok(probe.includes(`new ${purgeTimerClass(purge.table)}(`), purge.table);
    assert.ok(probe.includes(database === 'mongodb' ? 'MongoTimerStore.class' : 'JdbcTimerStore.class'));
  });
}

test('el sabotaje timer-every-replica se aplica a cada recurrente emitido, y solo cambia su kind', () => {
  const { model, files } = plan('notification-mailer', 'postgresql');
  const patches = everyReplicaSabotage(model);
  assert.equal(patches.length, timerPurges(model).length + timerSchedules(model).length);
  assert.ok(timerSchedules(model).length > 0, "notification-mailer tiene que montar su schedule en el cronómetro");
  for (const patch of patches) {
    const content = javaNamed(files, patch.file).content;
    assert.ok(content.includes(patch.find), `${patch.file}: ya no tiene el kind que el sabotaje rompe`);
    assert.ok(content.includes(patch.field.find), `${patch.file}: ya no tiene el ancla del campo`);
    const sabotaged = content.replace(patch.find, patch.replace).replace(patch.field.find, patch.field.replace);
    assert.notEqual(sabotaged, content);
    assert.match(sabotaged, /\+ "@" \+ replica;/);
  }
});

test('sin cronómetro (MariaDB) no hay sonda: las purgas conservan su @Scheduled', () => {
  const { model, files } = plan('notification-mailer', 'mariadb');
  assert.equal(usesPurgeTimers(model), false);
  assert.ok(!files.some((file) => file.path.endsWith('PurgeTimer.java')), 'sin cronómetro no hay recurrentes');
  assert.ok(javaNamed(files, 'OutboxPurge.java').content.includes('@Scheduled(cron = "${outbox.purge.cron:'));
  assert.ok(javaNamed(files, 'IdempotencyGuard.java').content.includes('@Scheduled(cron = "${processed-event.purge.cron:'));
  assert.ok(!files.some((file) => file.path.endsWith('/TimerPoller.java')), 'sin plazos ni cronómetro no hay sondeador');
});
