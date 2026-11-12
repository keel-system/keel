// El reloj de keel-go (tramo 10b): las tareas de las operaciones con `schedule` y las purgas por lotes de las tablas del
// generador, sobre el texto emitido.
//
//   · cada operación con `schedule` se dispara en el MISMO segundo y se despacha IGUAL (con la transacción del caso de uso
//     o sin ella) que en el servidor de keel-spring del mismo diseño: se compara con el <Grupo>Scheduler.java que EMITE;
//   · los casos con los que la prueba emitida ejecuta el bucle de la purga, contra la referencia de keel-core;
//   · qué se purga, como en keel-nest; la configuración de las purgas (claves, variables, defaults) contra la de
//     keel-spring, y lo que el YAML declara es lo que lee PurgeSettingsFrom;
//   · scheduling.yaml, el MISMO texto que keel-nest, con el reloj apagado en el perfil test.
// Lo que ejecuta el Go (el cron de cada tarea con robfig/cron, el bucle con testing/synctest y el de la purga) lo mide la
// prueba emitida scheduler_test.go en `npm run go-check`; las purgas contra el motor, `db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { batchedPurgeReference, scheduleSeconds } from '@keel-system/keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { tablePurges as nestTablePurges } from '../../keel-nest/src/scaffold/purge.js';
import { planService } from '../src/scaffold/index.js';
import { PURGE_CASES, PURGE_CASES_CUTOFF, purgeStatements, tablePurges } from '../src/scaffold/purge.js';
import { scheduledServices, tasksPath } from '../src/scaffold/scheduling.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { withoutLifecycle } from '../../keel-core/test/helpers/data-lifecycle-designs.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SCHEDULED = ['payout-runs', 'job-dispatch', 'job-dispatch-cycles', 'metering-digest'];
const SCHEDULER = 'internal/infrastructure/scheduler';

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService, stack = STACK) => planner({ ...design(name), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

/** Del Scheduler de keel-spring: método → { cron, withoutTransaction }. */
function springSchedule(files) {
  const out = new Map();
  const schedulers = files.filter((candidate) => /\/infrastructure\/scheduling\/\w+Scheduler\.java$/.test(candidate.path));
  // Desde el inc. 8 del plan 2.26 el cron vive en el <Operación>ScheduleTimer del cronómetro y el despacho en el método
  // del Scheduler; sin cronómetro, en su @Scheduled.
  const bodyOf = (name) => {
    for (const file of schedulers) {
      const match = new RegExp(`public void ${name}\\(\\) \\{([\\s\\S]*?)\\n    \\}`).exec(file.content);
      if (match) return match[1];
    }
    return '';
  };
  for (const file of files.filter((candidate) => /\/infrastructure\/timer\/\w+ScheduleTimer\.java$/.test(candidate.path))) {
    const cron = /public String spec\(\) \{\s+return "([^"]+)";/.exec(file.content)[1];
    const name = /\w+Scheduler\.(\w+)\(\);/.exec(file.content)[1];
    out.set(name, { cron, withoutTransaction: bodyOf(name).includes('dispatchWithoutTransaction(') });
  }
  for (const file of schedulers) {
    for (const [, cron, name, body] of file.content.matchAll(/@Scheduled\(cron = "([^"]+)"\)\s+public void (\w+)\(\) \{([\s\S]*?)\n    \}/g)) {
      out.set(name, { cron, withoutTransaction: body.includes('dispatchWithoutTransaction(') });
    }
  }
  return out;
}

/** De las tareas de keel-go: operación → { cron, withoutTransaction }, leyendo <Grupo>Tasks y la función que despacha. */
function goSchedule(model, files) {
  const out = new Map();
  for (const { service } of scheduledServices(model)) {
    const source = files.find((file) => file.path === tasksPath(model, service)).content;
    for (const [, name, cron, dispatch] of source.matchAll(/\{Name: "(\w+)", Cron: "([^"]+)", Run: (\w+)\(uc\)\}/g)) {
      const body = source.slice(source.indexOf(`func ${dispatch}(`)).split('\n}')[0];
      out.set(name, { cron, withoutTransaction: body.includes('application.WithoutTransaction(ctx)') });
    }
  }
  return out;
}

for (const name of SCHEDULED) {
  test(`${name}: cada operación por reloj sale en el mismo segundo y se despacha igual que en keel-spring`, () => {
    const { model, files } = plan(name);
    const ours = goSchedule(model, files);
    const theirs = springSchedule(plan(name, planSpring).files);
    assert.ok(ours.size > 0, 'el diseño declara operaciones por reloj');
    assert.deepEqual([...ours.keys()].sort(), [...theirs.keys()].sort());
    for (const [operation, schedule] of ours) {
      assert.deepEqual(schedule, theirs.get(operation), operation);
      assert.equal(schedule.cron.split(' ').length, 6, `${operation}: seis campos, el primero el segundo repartido`);
    }
    // La prueba emitida espera el mismo cron de cada tarea.
    const emitted = content(files, `${SCHEDULER}/scheduler_test.go`);
    for (const [operation, { cron }] of ours) assert.match(emitted, new RegExp(`"${operation}":\\s+"${cron.replaceAll('*', '\\*')}",`));
  });
}

test('el segundo de arranque se reparte: dos operaciones con la misma cadencia no salen a la vez', () => {
  const { model } = plan('payout-runs');
  const seconds = [...scheduleSeconds(model).values()];
  assert.equal(new Set(seconds).size, seconds.length);
});

test('un barrido con reclamo va sin transacción abarcadora; un cierre sin reclamo, con la del caso de uso; y el handler lo dice', () => {
  const { model, files } = plan('payout-runs');
  const schedule = goSchedule(model, files);
  assert.equal(schedule.get('sendPayouts').withoutTransaction, true);
  assert.equal(schedule.get('closePayoutRuns').withoutTransaction, false);
  const handler = content(files, 'internal/application/send_payouts_command_handler.go');
  // Con el cronómetro (inc. 8 del plan 2.26): su tarea, montada con timer.NewSchedule, en UNA réplica por tick.
  assert.match(handler.replace(/\n\s*\/\/\s+/g, ' '), /la dispara el cronómetro \(su tarea de internal\/infrastructure\/scheduler\/payout_tasks\.go, montada con timer\.NewSchedule\) en UNA réplica por tick/);
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
  assert.match(content(files, 'internal/application/close_payout_runs_command_handler.go'), /Corre en UNA transacción/);
});

test('cada pasada abre su correlación y la que está en vuelo no se corta al apagar', () => {
  const scheduler = content(plan('payout-runs').files, `${SCHEDULER}/scheduler.go`);
  assert.match(scheduler, /ctx = correlation\.WithID\(ctx, uuid\.NewString\(\)\)/);
  // La pasada corre sin la cancelación del apagado, y Run espera a todas antes de volver.
  assert.match(scheduler, /s\.RunOnce\(context\.WithoutCancel\(ctx\), t\.task\)/);
  assert.match(scheduler, /wg\.Wait\(\)/);
  assert.match(scheduler, /cron\.NewParser\(cron\.Second \| cron\.Minute \| cron\.Hour \| cron\.Dom \| cron\.Month \| cron\.Dow\)/);
});

// ─── El bucle de la purga ────────────────────────────────────────────────────

/** Una tabla en memoria: instantes (ms), con repetidos. `boundary` y `deleteUpTo` como los haría el motor. */
function fakeTable(instants) {
  let rows = [...instants].sort((a, b) => a - b);
  const calls = { deletes: 0 };
  return {
    calls,
    rows: () => rows,
    port: (cutoff) => ({
      boundary: async (position) => {
        const eligible = rows.filter((at) => at < cutoff.getTime());
        return position < eligible.length ? new Date(eligible[position]) : null;
      },
      deleteUpTo: async (upTo) => {
        calls.deletes += 1;
        const before = rows.length;
        rows = rows.filter((at) => !(at < cutoff.getTime() && at <= upTo.getTime()));
        return before - rows.length;
      }
    })
  };
}

test('los casos de la prueba emitida de la purga son los que da la referencia de keel-core', async () => {
  const cutoff = new Date(PURGE_CASES_CUTOFF);
  assert.ok(PURGE_CASES.some((c) => c.exhausted), 'un caso llega al tope');
  assert.ok(PURGE_CASES.some((c) => new Set(c.instants).size < c.instants.length), 'un caso tiene repetidos');
  for (const c of PURGE_CASES) {
    const table = fakeTable(c.instants);
    const result = await batchedPurgeReference({ batchSize: c.batchSize, maxBatches: c.maxBatches, cutoff, ...table.port(cutoff) });
    assert.equal(c.deleted, result.deleted, JSON.stringify(c.instants));
    assert.equal(c.exhausted, result.exhausted);
    assert.equal(c.deletes, table.calls.deletes, 'los mismos lotes');
    assert.deepEqual(c.remaining, table.rows());
  }
  // Y la prueba emitida los lleva todos, con el corte de la referencia.
  const emitted = content(plan('stock-reservation-events').files, `${SCHEDULER}/scheduler_test.go`);
  assert.equal([...emitted.matchAll(/^\t\t\{\[\]int64\{/gm)].length, PURGE_CASES.length);
  assert.match(emitted, new RegExp(`time\\.UnixMilli\\(${PURGE_CASES_CUTOFF}\\)`));
});

// ─── Qué se purga y con qué configuración ────────────────────────────────────

test('se purga cada tabla del generador que el diseño usa, y solo esas: las mismas que keel-nest', () => {
  for (const name of ['stock-reservation-events', 'stock-reservation', 'product-catalog', 'shop-api', 'payout-runs']) {
    const ours = tablePurges(plan(name).model).map((purge) => purge.what);
    const theirs = nestTablePurges(plan(name, planNest).model).map((purge) => purge.what);
    assert.deepEqual(ours, theirs, name);
  }
  assert.deepEqual(tablePurges(plan('stock-reservation-events').model).map((purge) => purge.what), ['outbox_event', 'processed_event', 'idempotency_record']);
  assert.deepEqual(tablePurges(plan('payout-runs').model), []);
});

test('la purga del outbox no toca lo pendiente; la del registro de idempotencia corta por su caducidad; en los dos motores', () => {
  const postgres = content(plan('stock-reservation-events').files, 'internal/infrastructure/postgres/purges.go');
  assert.match(postgres, /"DELETE FROM outbox_event WHERE published_at IS NOT NULL AND published_at < \$1 AND published_at <= \$2"/);
  assert.match(postgres, /"SELECT published_at FROM outbox_event WHERE published_at IS NOT NULL AND published_at < \$1 ORDER BY published_at LIMIT 1 OFFSET \$2"/);
  assert.match(postgres, /"DELETE FROM idempotency_record WHERE expires_at < \$1 AND expires_at <= \$2"/);
  // La frontera y el borrado llevan la misma condición.
  for (const purge of tablePurges(plan('stock-reservation-events').model)) {
    const { boundary, delete: remove } = purgeStatements(plan('stock-reservation-events').model, purge);
    assert.equal(boundary.split(' WHERE ')[1].split(' ORDER BY ')[0], remove.split(' WHERE ')[1].replace(/ AND \w+ <= \$2$/, ''), purge.what);
  }
  const mysql = content(plan('stock-reservation-events', planService, { database: 'mysql', broker: 'rabbitmq' }).files, 'internal/infrastructure/mysql/purges.go');
  assert.match(mysql, /"SELECT published_at FROM outbox_event WHERE published_at IS NOT NULL AND published_at < \? ORDER BY published_at LIMIT 1 OFFSET \?"/);
  // Sin retención en el registro de idempotencia: cada fila lleva su caducidad.
  const purge = content(plan('stock-reservation-events').files, `${SCHEDULER}/purge.go`);
  assert.doesNotMatch(purge.split('IdempotencyRecord: PurgeSchedule{')[1].split('},')[0], /Retention/);
  // Cada lote en una transacción NUEVA.
  assert.match(postgres, /p\.tx\.fresh\(ctx, sql\.TxOptions\{\}/);
});

test('las purgas leen las claves y los defaults de keel-spring', () => {
  for (const name of ['stock-reservation-events', 'product-catalog']) {
    const { files } = plan(name);
    const settings = content(files, `${SCHEDULER}/purge.go`);
    const theirs = plan(name, planSpring).files;
    for (const profile of ['local', 'develop', 'production']) {
      const reference = {
        ...parseYaml(content(theirs, `parameters/${profile}/messaging.yaml`) ?? ''),
        ...parseYaml(content(theirs, `parameters/${profile}/idempotency.yaml`) ?? '')
      };
      const ours = {
        ...parseYaml(content(files, `config/parameters/${profile}/messaging.yaml`) ?? ''),
        ...parseYaml(content(files, `config/parameters/${profile}/idempotency.yaml`) ?? '')
      };
      for (const prefix of ['outbox', 'processed-event', 'idempotency-record']) {
        assert.deepEqual(ours[prefix]?.purge, reference[prefix]?.purge, `${name} ${profile}: ${prefix}.purge`);
        // Lo que el YAML declara es lo que el código lee.
        for (const leaf of Object.keys(reference[prefix]?.purge ?? {})) assert.ok(settings.includes(`"${prefix}.purge.${leaf}"`), `${name}: lee ${prefix}.purge.${leaf}`);
      }
    }
  }
});

test('scheduling.yaml e idempotency.yaml son los de keel-nest, con el reloj apagado en el perfil test', () => {
  const pairs = [
    ['payout-runs', ['local', 'develop', 'production', 'test'].map((profile) => `config/parameters/${profile}/scheduling.yaml`)],
    ['product-catalog', ['local', 'develop', 'production'].map((profile) => `config/parameters/${profile}/idempotency.yaml`)]
  ];
  for (const [name, paths] of pairs) {
    const ours = plan(name).files;
    const theirs = plan(name, planNest).files;
    for (const file of paths) {
      assert.ok(content(ours, file), `${name}: ${file}`);
      assert.equal(content(ours, file), content(theirs, file), `${name}: ${file}`);
    }
  }
  assert.equal(parseYaml(content(plan('payout-runs').files, 'config/parameters/test/scheduling.yaml')).scheduling.enabled, false);
  assert.match(content(plan('payout-runs').files, `${SCHEDULER}/settings.go`), /cfg\.Value\("scheduling\.enabled"\)/);
});

test('el reloj va en el errgroup del arranque, después de los casos de uso, y trae robfig/cron', () => {
  const { files } = plan('stock-reservation-events');
  const main = content(files, 'cmd/server/main.go');
  assert.ok(main.indexOf('scheduler.New(') > main.indexOf('application.NewUseCases('));
  assert.match(main, /group\.Go\(func\(\) error \{\n\t\treturn clock\.Run\(groupCtx\)\n\t\}\)/);
  // Las purgas ya no van al reloj de cada réplica: la misma tarea es un recurrente del cronómetro, en modo clúster (DSL
  // 2.26, inc. 7), que solo sondea con base.
  assert.doesNotMatch(main, /tasks = append\(tasks,\n\t\t\tscheduler\.PurgeTask\(/);
  assert.ok(main.includes('timer.NewRecurring(timer.KindPurgeOutboxEvent, purges.Outbox.Cron, scheduler.PurgeTask("outbox_event", purges.Outbox, postgres.NewOutboxPurge(transactions), logger).Run)'));
  assert.ok(main.indexOf('timer.NewRecurring(') > main.indexOf('scheduler.PurgeSettingsFrom(cfg)'), 'la configuración de las purgas se lee antes');
  assert.match(content(files, 'go.mod'), /\tgithub\.com\/robfig\/cron\/v3 v3\.0\.1\n/);
  // Y los schedule tampoco (inc. 8): las tareas del grupo son recurrentes del cronómetro, con drenaje.
  const payout = content(plan('payout-runs').files, 'cmd/server/main.go');
  assert.doesNotMatch(payout, /tasks = append\(tasks, scheduler\.PayoutTasks\(useCases\)\.\.\.\)/);
  assert.ok(payout.includes('for _, group := range [][]scheduler.Task{scheduler.PayoutTasks(useCases)} {'));
  assert.ok(payout.includes('timer.NewSchedule(task.Name, task.Cron, task.Run, timerSettings)'));
  assert.ok(payout.includes('append([]timer.Recurring{timerPurge'), 'los schedule van al sondeador con los demás recurrentes');
});

test('sin la capa api (metering-digest) el arranque cablea igual la base, el broker, los listeners y el reloj; HTTP solo sirve las sondas', () => {
  const { files } = plan('metering-digest');
  const main = content(files, 'cmd/server/main.go');
  for (const wired of ['postgres.Migrate(ctx, db, logger)', 'application.NewUseCases(', 'messageListeners(inbound{', 'scheduler.DailyDigestTasks(useCases)', 'scheduler.PurgeTask("processed_event"']) {
    assert.ok(main.includes(wired), wired);
  }
  for (const worker of ['rabbit.Run(groupCtx)', 'listen(groupCtx)', 'clock.Run(groupCtx)']) assert.ok(main.includes(`return ${worker}`), worker);
  // Los registros llevan la correlación del mensaje o de la pasada; la entrada HTTP no despacha nada.
  assert.ok(main.includes('logging.New(logSettings, stdout)'));
  assert.ok(main.includes('httpapi.NewServer(cfg.Server, httpapi.NewHandler(probes))'));
  assert.ok(content(files, 'cmd/server/broker.go'), 'el archivo del agente para el broker');
  assert.ok(content(files, `${SCHEDULER}/daily_digest_tasks.go`).includes('func DailyDigestTasks(uc *application.UseCases) []Task'));
});

test('sin nada que corra por reloj no se genera el reloj', () => {
  // profile-directory sin su retención (DSL 2.28), que es un recurrente del cronómetro.
  const base = design('profile-directory');
  withoutLifecycle(base.layers);
  const { files } = planService({ ...base, workspace: FIXTURES_DIR, stack: STACK });
  assert.ok(!files.some((file) => file.path.startsWith(SCHEDULER)));
  assert.ok(!files.some((file) => file.path.endsWith('scheduling.yaml')));
  assert.doesNotMatch(content(files, 'go.mod'), /robfig/);
  assert.doesNotMatch(content(files, 'cmd/server/main.go'), /scheduler\./);
});
