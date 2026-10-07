// El reloj de keel-nest (incremento 10b): los schedulers de las operaciones con `schedule` y las purgas
// por lotes de las tablas del generador.
//
//   · cada operación con `schedule` se dispara en el MISMO segundo y se despacha IGUAL (con la transacción
//     del caso de uso o sin ella) que en el servidor de keel-spring del mismo diseño: se compara con el
//     <Servicio>Scheduler.java que EMITE keel-spring;
//   · el bucle de la purga, EJECUTADO contra la referencia de keel-core sobre una tabla en memoria;
//   · la configuración de las purgas (claves, variables, defaults) contra la de keel-spring, y el reloj
//     apagado en el perfil test.
// Lo que importa Nest, cron o TypeORM (el registro de tareas, las purgas contra el motor) lo compila
// `npm run ts-check` y lo ejecuta `npm run db-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { batchedPurgeReference, BATCHED_PURGE, scheduleSeconds } from 'keel-core/gen';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { BATCHED_PURGE_TS, TABLE_PURGES_TS, tablePurges } from '../src/scaffold/purge.js';
import { SCHEDULING_MODULE_TS, SCHEDULING_TS, scheduledServices, schedulerPath } from '../src/scaffold/scheduling.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SCHEDULED = ['payout-runs', 'job-dispatch', 'metering-digest'];

function spring(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
}

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

/** De los schedulers de keel-nest: método → { cron, withoutTransaction }. */
function nestSchedule(model, files) {
  const out = new Map();
  for (const { service } of scheduledServices(model)) {
    const source = content(files, schedulerPath(service));
    for (const [, name, cron] of source.matchAll(/register\(\{ name: '(\w+)', cron: '([^']+)'/g)) {
      const body = source.slice(source.indexOf(`  ${name}(): Promise<void> {`)).split('\n  }')[0];
      out.set(name, { cron, withoutTransaction: body.includes('dispatchWithoutTransaction(') });
    }
  }
  return out;
}

for (const name of SCHEDULED) {
  test(`${name}: cada operación por reloj sale en el mismo segundo y se despacha igual que en keel-spring`, () => {
    const { model, files } = planFixture(name, { stack: STACK });
    const ours = nestSchedule(model, files);
    const theirs = springSchedule(spring(name));
    assert.ok(ours.size > 0, 'el diseño declara operaciones por reloj');
    assert.deepEqual([...ours.keys()].sort(), [...theirs.keys()].sort());
    for (const [operation, schedule] of ours) {
      assert.deepEqual(schedule, theirs.get(operation), operation);
      assert.equal(schedule.cron.split(' ').length, 6, `${operation}: seis campos, el primero el segundo repartido`);
    }
  });
}

test('el segundo de arranque se reparte: dos operaciones con la misma cadencia no salen a la vez', () => {
  const { model } = planFixture('payout-runs', { stack: STACK });
  const seconds = [...scheduleSeconds(model).values()];
  assert.equal(new Set(seconds).size, seconds.length);
});

test('un barrido con reclamo va sin transacción abarcadora; un cierre sin reclamo, con la del caso de uso', () => {
  const { model, files } = planFixture('payout-runs', { stack: STACK });
  const schedule = nestSchedule(model, files);
  assert.equal(schedule.get('sendPayouts').withoutTransaction, true);
  assert.equal(schedule.get('closePayoutRuns').withoutTransaction, false);
  // La nota del handler dice lo mismo que el scheduler.
  const handler = content(files, 'src/application/usecases/send-payouts-command-handler.ts');
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
  assert.match(content(files, 'src/application/usecases/close-payout-runs-command-handler.ts'), /Corre en UNA transacción/);
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

test('la purga por lotes borra lo mismo, en los mismos lotes, que la referencia de keel-core', async () => {
  const plan = planFixture('product-catalog', { stack: STACK });
  const { batchedPurge, PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } = await transpileTree(plan.files).load(BATCHED_PURGE_TS);
  assert.equal(PURGE_BATCH_SIZE, BATCHED_PURGE.batchSize);
  assert.equal(PURGE_MAX_BATCHES, BATCHED_PURGE.maxBatches);
  const cutoff = new Date(1_000);
  const cases = [
    { instants: [], batchSize: 3, maxBatches: 5 },
    { instants: [10, 20], batchSize: 3, maxBatches: 5 },
    // Con repetidos en la frontera: caen en el mismo lote.
    { instants: [10, 20, 20, 20, 30, 40, 50, 60, 1_500, 2_000], batchSize: 3, maxBatches: 5 },
    // El tope: quedan filas y se avisa.
    { instants: Array.from({ length: 20 }, (_, i) => i * 10), batchSize: 2, maxBatches: 3 }
  ];
  for (const { instants, batchSize, maxBatches } of cases) {
    const ours = fakeTable(instants);
    const reference = fakeTable(instants);
    const warnings = [];
    const deleted = await batchedPurge({ what: 'tabla', batchSize, maxBatches, cutoff, ...ours.port(cutoff), warn: (m) => warnings.push(m) });
    const expected = await batchedPurgeReference({ batchSize, maxBatches, cutoff, ...reference.port(cutoff) });
    assert.equal(deleted, expected.deleted, JSON.stringify(instants));
    assert.deepEqual(ours.rows(), reference.rows());
    assert.equal(ours.calls.deletes, reference.calls.deletes, 'los mismos lotes');
    assert.equal(warnings.length, expected.exhausted ? 1 : 0);
    // Lo que no ha caducado no se toca nunca.
    assert.ok(ours.rows().filter((at) => at >= cutoff.getTime()).length === instants.filter((at) => at >= cutoff.getTime()).length);
  }
  await assert.rejects(
    batchedPurge({ what: 'tabla', batchSize: 0, maxBatches: 1, cutoff, ...fakeTable([]).port(cutoff), warn: () => {} }),
    /enteros positivos/
  );
});

// ─── Qué se purga y con qué configuración ────────────────────────────────────

test('se purga cada tabla del generador que el diseño usa, y solo esas', () => {
  const keys = (name) => tablePurges(planFixture(name, { stack: STACK }).model).map((purge) => purge.what);
  assert.deepEqual(keys('stock-reservation-events'), ['outbox_event', 'processed_event', 'idempotency_record']);
  assert.deepEqual(keys('product-catalog'), ['idempotency_record']);
  // Best-effort y con suscripciones: sin outbox, con registro de procesados.
  assert.deepEqual(keys('metering-digest'), ['processed_event']);
  assert.deepEqual(keys('payout-runs'), []);
});

test('la purga del outbox no toca lo pendiente; la del registro de idempotencia corta por su caducidad', () => {
  const { files } = planFixture('stock-reservation-events', { stack: STACK });
  const purges = content(files, TABLE_PURGES_TS);
  assert.match(purges, /'published_at IS NOT NULL'/);
  const product = content(planFixture('product-catalog', { stack: STACK }).files, TABLE_PURGES_TS);
  assert.match(product, /purgeIdempotencyRecords\(now: Date = new Date\(\)\): Promise<number> \{\n    const cutoff = now;/);
  assert.match(product, /'expires_at'/);
});

test('las purgas leen las claves y los defaults de keel-spring', () => {
  for (const name of ['stock-reservation-events', 'product-catalog', 'metering-digest']) {
    const { files } = planFixture(name, { stack: STACK });
    const purges = content(files, TABLE_PURGES_TS);
    const theirs = spring(name);
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
        for (const leaf of Object.keys(reference[prefix]?.purge ?? {})) assert.ok(purges.includes(`'${prefix}.purge.${leaf}'`), `${name}: lee ${prefix}.purge.${leaf}`);
      }
    }
  }
});

test('el reloj se apaga en el perfil test, va el último en el módulo raíz y trae su dependencia', () => {
  const { files } = planFixture('payout-runs', { stack: STACK });
  assert.equal(parseYaml(content(files, 'config/parameters/test/scheduling.yaml')).scheduling.enabled, false);
  assert.match(content(files, 'config/parameters/production/scheduling.yaml'), /enabled: \$\{SCHEDULING_ENABLED:true\}/);
  const app = content(files, 'src/app.module.ts');
  assert.match(app, /UseCaseModule, SchedulingModule\.register\(configuration\)\]/);
  assert.ok(JSON.parse(content(files, 'package.json')).dependencies.cron);
  // Al apagar, se espera a la pasada en vuelo; un tick con la anterior en curso se salta.
  const scheduling = content(files, SCHEDULING_TS);
  assert.match(scheduling, /waitForCompletion: true/);
  assert.match(scheduling, /beforeApplicationShutdown[\s\S]*job\.stop\(\)/);
  assert.match(content(files, SCHEDULING_MODULE_TS), /imports: \[UseCaseModule\]/);
});

test('sin nada que corra por reloj no se genera el reloj', () => {
  const { model, files } = planFixture('product-catalog', { stack: STACK, withoutLayers: ['persistence'] });
  assert.equal(scheduledServices(model).length, 0);
  assert.ok(!files.some((file) => file.path === SCHEDULING_TS));
  assert.ok(!JSON.parse(content(files, 'package.json')).dependencies.cron);
});
