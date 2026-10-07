// Las decisiones NEUTRALES de lo que corre por reloj (keel-core/gen/scheduling.js) y del gradiente de los
// parámetros de despliegue (gen/service-parameters.js): las toman una vez y las escriben los dos
// generadores, así que aquí se fija lo que deciden, con modelos sintéticos.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleSeconds,
  scheduleCron,
  scheduleDispatch,
  sweepConfig,
  claimOrderField,
  batchedPurgeReference,
  rescueProbes,
  stallSql,
  missingClockCountSql,
  SWEEP_BATCH_DEFAULT
} from '../src/lib/gen/index.js';
import { parameterProfileValue } from '../src/lib/gen/service-parameters.js';

const op = (name, extra = {}) => ({ name, schedule: { cron: '* * * * *' }, ...extra });
const model = (operations, extra = {}) => ({ services: [{ operations }], entities: [], ...extra });

test('el segundo de arranque se reparte por índice en todo el modelo, y el cron sale de seis campos', () => {
  const m = { services: [{ operations: [op('a'), { name: 'sinReloj' }] }, { operations: [op('b'), op('c')] }] };
  assert.deepEqual([...scheduleSeconds(m)], [['a', 0], ['b', 20], ['c', 40]]);
  assert.equal(scheduleCron(m, m.services[1].operations[0]), '20 * * * * *');
});

test('se despacha sin transacción abarcadora lo que llama a un tercero, alimenta una guarda o reclama su lote', () => {
  const claim = { entity: 'N', from: ['accepted'], to: 'queued' };
  const guard = { name: 'send', guardClaim: { entity: 'N', from: ['queued'] } };
  assert.deepEqual(scheduleDispatch(model([]), op('x', { reconciles: [{}] })), { withoutTransaction: true, reason: 'provider' });
  assert.deepEqual(scheduleDispatch(model([guard]), op('x', { claim: [claim] })), { withoutTransaction: true, reason: 'irreversible' });
  assert.deepEqual(scheduleDispatch(model([]), op('x', { claim: [claim] })), { withoutTransaction: true, reason: 'claimed' });
  assert.deepEqual(scheduleDispatch(model([]), op('x')), { withoutTransaction: false, reason: null });
});

test('sweep.*: lote por operación y plazo por rescate, en el mismo bloque si coinciden; sin plazo propio si lo da un parámetro', () => {
  const queue = { entity: 'J', from: ['queued'], to: 'running', sweepKey: 'dispatch-jobs', suffix: 'DispatchJobsRunning' };
  const rescue = (parameter) => ({
    entity: 'J',
    from: ['running'],
    to: 'done',
    sweepKey: 'dispatch-jobs',
    suffix: 'StalledDispatchJobs',
    stalled: { state: 'running', stampField: 'runningSince', configKey: 'dispatch-jobs', defaultSeconds: 300, parameter }
  });
  const own = sweepConfig(model([op('dispatchJobs', { claim: [queue, rescue(null)] })]));
  assert.equal(own.length, 1, 'un solo bloque: el mismo bloque dos veces es un YAML que no carga');
  assert.deepEqual(
    own[0].entries.map((entry) => [entry.leaf, entry.env, entry.default]),
    [
      ['batch-size', 'SWEEP_DISPATCH_JOBS_BATCH_SIZE', SWEEP_BATCH_DEFAULT],
      ['stalled-after-seconds', 'SWEEP_STALLED_DISPATCH_JOBS_STALLED_AFTER_SECONDS', 300]
    ]
  );
  const linked = sweepConfig(model([op('dispatchJobs', { claim: [queue, rescue({ name: 'abandonAfterMinutes' })] })]));
  assert.deepEqual(linked[0].entries.map((entry) => entry.leaf), ['batch-size']);
});

test('los candidatos salen por el reloj en un rescate, por el primer instante de llegada en una cola y si no por el id', () => {
  const entity = (...names) => ({ fields: names.map((name) => ({ name })) });
  assert.equal(claimOrderField(entity('createdAt'), { stalled: { stampField: 'runningSince' } }), 'runningSince');
  assert.equal(claimOrderField(entity('updatedAt', 'requestedAt'), {}), 'requestedAt');
  assert.equal(claimOrderField(entity('name'), {}), 'id');
});

test('la referencia de la purga: lotes por frontera, el último entero, y el tope', async () => {
  const table = (instants) => {
    let rows = [...instants].sort((a, b) => a - b);
    return {
      rows: () => rows,
      boundary: async (position) => (position < rows.filter((at) => at < 100).length ? rows.filter((at) => at < 100)[position] : null),
      deleteUpTo: async (upTo) => {
        const before = rows.length;
        rows = rows.filter((at) => !(at < 100 && at <= upTo));
        return before - rows.length;
      }
    };
  };
  const all = table([1, 2, 2, 3, 150]);
  assert.deepEqual(await batchedPurgeReference({ batchSize: 2, maxBatches: 10, cutoff: 100, ...all }), { deleted: 4, exhausted: false });
  assert.deepEqual(all.rows(), [150]);
  const capped = table([1, 2, 3, 4, 5]);
  assert.deepEqual(await batchedPurgeReference({ batchSize: 2, maxBatches: 1, cutoff: 100, ...capped }), { deleted: 2, exhausted: true });
});

test('las sondas del rescate: la constante del estado, las columnas en snake y el prefijo al que se pega el id', () => {
  const m = {
    services: [{ operations: [op('dispatchJobs', { claim: [{ entity: 'Job', stalled: { state: 'running', stampField: 'runningSince' } }] })] }],
    entities: [{ name: 'Job', tableName: 'jobs', lifecycle: { field: 'status' } }]
  };
  const [probe] = rescueProbes(m);
  assert.deepEqual(probe, { operation: 'dispatchJobs', table: 'jobs', stateColumn: 'status', state: 'RUNNING', clockColumn: 'running_since' });
  assert.equal(stallSql({ ...probe, clockSql: 'X' }), "UPDATE jobs SET status = 'RUNNING', running_since = X WHERE id = ");
  assert.equal(missingClockCountSql(probe), "SELECT COUNT(*) FROM jobs WHERE status = 'RUNNING' AND running_since IS NULL");
});

test('el gradiente de un parámetro: literal en prueba, variable con default en develop, y en producción pelada si es obligatorio sin default', () => {
  const required = { envVar: 'SVC_CURRENCY', testValue: 'EUR', default: null, requiredInProduction: true };
  assert.equal(parameterProfileValue(required, 'local'), 'EUR');
  assert.equal(parameterProfileValue(required, 'test'), 'EUR');
  assert.equal(parameterProfileValue(required, 'develop'), '${SVC_CURRENCY:EUR}');
  assert.equal(parameterProfileValue(required, 'production'), '${SVC_CURRENCY}');
  const defaulted = { envVar: 'SVC_MINUTES', testValue: 5, default: 5, requiredInProduction: true };
  assert.equal(parameterProfileValue(defaulted, 'production'), '${SVC_MINUTES:5}');
  const optional = { envVar: 'SVC_X', testValue: null, default: null, requiredInProduction: false };
  assert.equal(parameterProfileValue(optional, 'production'), '${SVC_X:}');
});
