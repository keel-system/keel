// Las purgas de las tablas del generador sobre el cronómetro (DSL 2.26, incremento 7), sin red: cada purga es un
// recurrente `<Tabla>PurgeTimer` con el kind de keel-core y el cron de su configuración, TablePurges ya no las registra en
// el reloj, y el sabotaje de db-check y doc-check se sigue aplicando a lo emitido. Lo que dicen contra el motor (una fila
// por purga, un tick por réplica, el rearme) lo miden `db-check` y `doc-check` (scripts/lib/timer-probes.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { timerPurges } from '@keel-system/keel-core/gen/timer-plan';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { purgeTimerClass as springPurgeTimerClass } from '../../keel-spring/src/scaffold/timer.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { tmpDir } from './helpers/tmp.js';
import { purgeTimerClass, purgeTimerPath } from '../src/scaffold/timer.js';
import { TABLE_PURGES_TS, tablePurges } from '../src/scaffold/purge.js';
import { PURGE_TIMER_SABOTAGES } from '../scripts/lib/timer-probes.js';

const fileAt = (files, path) => files.find((file) => file.path === path);

for (const name of ['notification-mailer', 'notification-mailer-mongo', 'stock-reservation']) {
  test(`${name}: cada purga es un recurrente del cronómetro, y TablePurges no la registra en el reloj`, () => {
    const { model, files } = planFixture(name);
    const purges = timerPurges(model);
    assert.ok(purges.length > 0, 'la fixture monta purgas en el cronómetro');
    assert.deepEqual(purges.map((purge) => purge.table).sort(), tablePurges(model).map((purge) => purge.table).sort(), 'todas las de TablePurges');
    for (const purge of purges) {
      const timer = fileAt(files, purgeTimerPath(purge.table));
      assert.ok(timer, `build emite ${purgeTimerClass(purge.table)}`);
      assert.match(timer.content, new RegExp(`export class ${purgeTimerClass(purge.table)} implements RecurringTimerHandler`));
      const entry = tablePurges(model).find((candidate) => candidate.table === purge.table);
      assert.ok(timer.content.includes(`await this.purges.${entry.method}();`), `${purge.table}: llama a TablePurges.${entry.method}`);
      assert.ok(timer.content.includes(`this.spec = settings.${entry.key}.cron;`), `${purge.table}: el cron de su configuración`);
    }
    const tablePurgesFile = fileAt(files, TABLE_PURGES_TS).content;
    assert.ok(!tablePurgesFile.includes('this.scheduling.register('), 'TablePurges sigue registrando purgas en el reloj de todas las réplicas');
    assert.ok(!tablePurgesFile.includes('@Inject(Scheduling)'));
    // El módulo del reloj es global y exporta lo que el recurrente inyecta.
    const schedulingModule = files.find((file) => file.path.endsWith('scheduling-module.ts')).content;
    assert.match(schedulingModule, /global: true/);
    // Y los schedulers cuyas operaciones dispara el cronómetro (inc. 8): sus <Operación>ScheduleTimer los inyectan.
    assert.match(schedulingModule, /exports: \[Scheduling, TablePurges, PURGE_SETTINGS(, \w+Scheduler)*\]/);
  });
}

test('el sabotaje timer-every-replica se aplica a cada recurrente emitido de una purga', () => {
  const { files } = planFixture('notification-mailer');
  const [suffix, from, to] = PURGE_TIMER_SABOTAGES['timer-every-replica'].spec;
  const targets = files.filter((file) => file.path.endsWith(suffix));
  assert.ok(targets.length >= 2, 'outbox y guarda de mensajes, al menos');
  for (const file of targets) {
    const sabotaged = file.content.replace(from, to);
    assert.notEqual(sabotaged, file.content, `${file.path}: ya no tiene el kind que el sabotaje rompe`);
  }
});

test('paridad con keel-spring: los mismos recurrentes de purga, con el mismo nombre', () => {
  for (const name of ['notification-mailer', 'notification-mailer-mongo']) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const database = name.endsWith('-mongo') ? 'mongodb' : 'postgresql';
    const spring = planSpring({ manifest, layers, workspace: tmpDir('keel-nest-purge-timer-'), stack: { database } });
    const nest = planFixture(name);
    assert.deepEqual(timerPurges(nest.model), timerPurges(spring.model), name);
    for (const purge of timerPurges(nest.model)) {
      assert.equal(purgeTimerClass(purge.table), springPurgeTimerClass(purge.table));
      assert.ok(spring.files.some((file) => file.path.endsWith(`/${springPurgeTimerClass(purge.table)}.java`)), `${name}: keel-spring emite ${purge.table}`);
    }
  }
});
