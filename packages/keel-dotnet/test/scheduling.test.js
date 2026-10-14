// El reloj de keel-dotnet (incremento 10b): los schedulers de las operaciones con `schedule` y las purgas por lotes de las
// tablas del generador, sobre el texto emitido.
//
//   · cada operación con `schedule` se dispara en el MISMO segundo y se despacha IGUAL (con la transacción del caso de uso
//     o sin ella) que en el servidor de keel-spring del mismo diseño: se compara con el <Grupo>Scheduler.java que EMITE;
//   · los casos con los que la prueba emitida ejecuta el bucle de la purga, contra la referencia de keel-core;
//   · qué se purga, como en keel-nest; la configuración de las purgas (claves, variables, defaults) contra la de
//     keel-spring, y lo que el YAML declara es lo que lee PurgeSettings;
//   · scheduling.yaml, el MISMO texto que keel-nest, con el reloj apagado en el perfil test.
// Lo que ejecuta el C# (el cron de cada tarea con Cronos, el bucle por lotes) lo mide la prueba emitida SchedulingTests en
// `npm run cs-check`; las purgas contra el motor, `db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { batchedPurgeReference, scheduleSeconds } from 'keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { tablePurges as nestTablePurges } from '../../keel-nest/src/scaffold/purge.js';
import { planService } from '../src/scaffold/index.js';
import { PURGE_CASES, PURGE_CASES_CUTOFF, tablePurges } from '../src/scaffold/purge.js';
import { scheduledServices, schedulerPath } from '../src/scaffold/scheduling.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SCHEDULED = ['payout-runs', 'job-dispatch', 'job-dispatch-cycles', 'metering-digest'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

/** Del Scheduler de keel-spring: método → { cron, withoutTransaction }. */
function springSchedule(files) {
  const out = new Map();
  for (const file of files.filter((candidate) => /\/infrastructure\/scheduling\/\w+Scheduler\.java$/.test(candidate.path))) {
    for (const [, cron, name, body] of file.content.matchAll(/@Scheduled\(cron = "([^"]+)"\)\s+public void (\w+)\(\) \{([\s\S]*?)\n    \}/g)) {
      out.set(name, { cron, withoutTransaction: body.includes('dispatchWithoutTransaction(') });
    }
  }
  return out;
}

/** De los schedulers de keel-dotnet: operación → { cron, withoutTransaction }, leyendo Tasks() y el método que despacha. */
function dotnetSchedule(model, files) {
  const out = new Map();
  for (const { service } of scheduledServices(model)) {
    const source = files.find((file) => file.path === schedulerPath(model, service)).content;
    for (const [, name, cron, method] of source.matchAll(/new\("(\w+)", "([^"]+)", \(services, cancellationToken\) => services\.GetRequiredService<\w+>\(\)\.(\w+)\(cancellationToken\)\)/g)) {
      const body = source.slice(source.indexOf(`public async Task ${method}(`)).split('\n    }')[0];
      out.set(name, { cron, withoutTransaction: body.includes('DispatchWithoutTransaction(') });
    }
  }
  return out;
}

for (const name of SCHEDULED) {
  test(`${name}: cada operación por reloj sale en el mismo segundo y se despacha igual que en keel-spring`, () => {
    const { model, files } = plan(name);
    const ours = dotnetSchedule(model, files);
    const theirs = springSchedule(plan(name, planSpring).files);
    assert.ok(ours.size > 0, 'el diseño declara operaciones por reloj');
    assert.deepEqual([...ours.keys()].sort(), [...theirs.keys()].sort());
    for (const [operation, schedule] of ours) {
      assert.deepEqual(schedule, theirs.get(operation), operation);
      assert.equal(schedule.cron.split(' ').length, 6, `${operation}: seis campos, el primero el segundo repartido`);
    }
    // La prueba emitida espera el mismo cron de cada tarea.
    const emitted = content(files, 'UnitTests/SchedulingTests.cs');
    for (const [operation, { cron }] of ours) assert.match(emitted, new RegExp(`\\["${operation}"\\] = \\(\\w+\\.Tasks\\(\\), "${cron.replaceAll('*', '\\*')}"\\)`));
  });
}

test('el segundo de arranque se reparte: dos operaciones con la misma cadencia no salen a la vez', () => {
  const { model } = plan('payout-runs');
  const seconds = [...scheduleSeconds(model).values()];
  assert.equal(new Set(seconds).size, seconds.length);
});

test('un barrido con reclamo va sin transacción abarcadora; un cierre sin reclamo, con la del caso de uso; y el handler lo dice', () => {
  const { model, files } = plan('payout-runs');
  const schedule = dotnetSchedule(model, files);
  assert.equal(schedule.get('sendPayouts').withoutTransaction, true);
  assert.equal(schedule.get('closePayoutRuns').withoutTransaction, false);
  const handler = content(files, 'UseCases/SendPayoutsCommandHandler.cs');
  assert.match(handler, /Scheduling\/PayoutScheduler\.cs\s+(\/\/\s+)?en TODAS las réplicas/);
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
  assert.match(content(files, 'UseCases/ClosePayoutRunsCommandHandler.cs'), /Corre en UNA transacción/);
});

test('cada pasada abre su correlación, y un mensaje con argumentos se le deja al agente', () => {
  const { files } = plan('payout-runs');
  const scheduler = content(files, 'Scheduling/PayoutScheduler.cs');
  assert.match(scheduler, /using \(CorrelationContext\.Open\(correlationId\)\)/);
  assert.match(scheduler, /await mediator\.DispatchWithoutTransaction\(new SendPayoutsCommand\(\), cancellationToken\);/);
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
  // Y la prueba emitida los lleva todos.
  const emitted = content(plan('stock-reservation-events').files, 'UnitTests/SchedulingTests.cs');
  assert.equal([...emitted.matchAll(/\[InlineData\(new long\[\]/g)].length, PURGE_CASES.length);
});

// ─── Qué se purga y con qué configuración ────────────────────────────────────

test('se purga cada tabla del generador que el diseño usa, y solo esas: las mismas que keel-nest', () => {
  for (const name of ['stock-reservation-events', 'product-catalog', 'metering-digest', 'payout-runs']) {
    const ours = tablePurges(plan(name).model).map((purge) => purge.what);
    const theirs = nestTablePurges(plan(name, planNest).model).map((purge) => purge.what);
    assert.deepEqual(ours, theirs, name);
  }
  assert.deepEqual(tablePurges(plan('stock-reservation-events').model).map((purge) => purge.what), ['outbox_event', 'processed_event', 'idempotency_record']);
  assert.deepEqual(tablePurges(plan('payout-runs').model), []);
});

test('la purga del outbox no toca lo pendiente; la del registro de idempotencia corta por su caducidad', () => {
  const purges = content(plan('stock-reservation-events').files, 'Purge/TablePurges.cs');
  assert.match(purges, /DELETE FROM outbox_event WHERE published_at IS NOT NULL AND published_at < \{cutoff\} AND published_at <= /);
  assert.match(purges, /SELECT published_at AS \\"Value\\" FROM outbox_event WHERE published_at IS NOT NULL AND published_at < \{cutoff\} ORDER BY published_at OFFSET \{position\} LIMIT 1/);
  assert.match(purges, /PurgeIdempotencyRecords\([\s\S]*?var cutoff = instant;/);
  assert.match(purges, /DELETE FROM idempotency_record WHERE expires_at < \{cutoff\}/);
});

test('las purgas leen las claves y los defaults de keel-spring', () => {
  for (const name of ['stock-reservation-events', 'product-catalog', 'metering-digest']) {
    const { files } = plan(name);
    const settings = content(files, 'Purge/PurgeSettings.cs');
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
        for (const leaf of Object.keys(reference[prefix]?.purge ?? {})) assert.ok(settings.includes(`"${prefix}:purge:${leaf}"`), `${name}: lee ${prefix}.purge.${leaf}`);
      }
    }
  }
});

test('scheduling.yaml es el de keel-nest, con el reloj apagado en el perfil test', () => {
  const ours = plan('payout-runs').files;
  const theirs = plan('payout-runs', planNest).files;
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const file = `config/parameters/${profile}/scheduling.yaml`;
    assert.equal(content(ours, file), content(theirs, file), file);
  }
  assert.equal(parseYaml(content(ours, 'config/parameters/test/scheduling.yaml')).scheduling.enabled, false);
  assert.match(content(ours, 'Scheduling/SchedulingSettings.cs'), /configuration\.Get\("scheduling:enabled"\)/);
});

test('el reloj va el último en Program.cs, trae Cronos y espera a la pasada en vuelo', () => {
  const { files } = plan('payout-runs');
  const program = content(files, 'Api/Program.cs');
  assert.ok(program.indexOf('AddScheduling(configuration)') > program.indexOf('AddPersistence('));
  assert.ok(program.indexOf('AddScheduling(configuration)') > program.indexOf('AddUseCases()'));
  assert.match(content(files, 'Directory.Packages.props'), /<PackageVersion Include="Cronos" Version="0\.13\.0" \/>/);
  assert.match(content(files, 'PayoutRuns.Infrastructure.csproj'), /<PackageReference Include="Cronos" \/>/);
  const scheduling = content(files, 'Scheduling/Scheduling.cs');
  // La pasada que empezó termina: corre sin el token del apagado, y la siguiente ocurrencia se calcula al terminar.
  assert.match(scheduling, /await RunOnce\(task, CancellationToken\.None\);/);
  assert.match(scheduling, /CronFormat\.IncludeSeconds|NextAfter/);
  assert.match(content(files, 'Scheduling/ScheduledTask.cs'), /CronExpression\.Parse\(cron, CronFormat\.IncludeSeconds\)/);
});

test('sin nada que corra por reloj no se genera el reloj', () => {
  const { manifest, layers } = design('product-catalog');
  delete manifest.layers.persistence;
  delete layers.persistence;
  const { model, files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null });
  assert.equal(scheduledServices(model).length, 0);
  assert.ok(!files.some((file) => /Scheduling\//.test(file.path)));
  assert.doesNotMatch(content(files, 'Directory.Packages.props'), /Cronos/);
  assert.doesNotMatch(content(files, 'Api/Program.cs'), /AddScheduling/);
});
