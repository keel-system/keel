// Los reclamos de barrido de keel-nest (incremento 10c). Lo que el reclamo HACE contra el motor (orden,
// lote, SKIP LOCKED, la carrera entre réplicas, la cota del rescate) lo mide `npm run db-check`; aquí, lo
// que tiene que coincidir con keel-spring y lo que el agente lee:
//   · el puerto de cada raíz trae un método por reclamo que el modelo decidió, y el adaptador lo implementa;
//   · sweep.yaml dice lo mismo que el de keel-spring (lote por operación, plazo por rescate, y ningún plazo
//     propio para el rescate enlazado a un parámetro del diseño), y el adaptador lee esas claves;
//   · el handler del barrido dice que el reclamo ya existe y cómo se usa;
//   · la cola estampa su reloj en el MISMO UPDATE; el rescate no toca el estado.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { sweepClaims } from 'keel-core/gen';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { SWEEP_SETTINGS_TS } from '../src/scaffold/claim.js';
import { adapterPath, portPath } from '../src/scaffold/repositories.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const SWEEPING = ['job-dispatch', 'job-dispatch-cycles', 'payout-runs', 'notification-mailer'];

function spring(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
}

for (const name of SWEEPING) {
  test(`${name}: cada reclamo del modelo está en el puerto y en el adaptador`, () => {
    const { model, files } = planFixture(name, { stack: STACK });
    const claims = sweepClaims(model);
    assert.ok(claims.length > 0);
    for (const { claim } of claims) {
      const entity = model.entities.find((candidate) => candidate.name === claim.entity);
      assert.match(content(files, portPath(entity)), new RegExp(`abstract ${claim.method}\\(\\): Promise<${claim.entity}\\[\\]>`), claim.method);
      const adapter = content(files, adapterPath(entity));
      assert.match(adapter, new RegExp(`async ${claim.method}\\(\\): Promise<${claim.entity}\\[\\]> \\{`), claim.method);
      assert.match(adapter, /setOnLocked\('skip_locked'\)/);
      assert.ok(adapter.includes(`this.sweeps.batchSize['${claim.sweepKey}']`), `${claim.method}: lee sweep.${claim.sweepKey}.batch-size`);
    }
  });

  test(`${name}: sweep.yaml es el de keel-spring y el código lee sus claves`, () => {
    const { files } = planFixture(name, { stack: STACK });
    const theirs = spring(name);
    const settings = content(files, SWEEP_SETTINGS_TS);
    for (const profile of ['local', 'develop', 'production']) {
      const ours = parseYaml(content(files, `config/parameters/${profile}/sweep.yaml`));
      const reference = parseYaml(content(theirs, `parameters/${profile}/sweep.yaml`));
      assert.deepEqual(ours, reference, profile);
      for (const [key, leaves] of Object.entries(reference.sweep)) {
        for (const leaf of Object.keys(leaves)) assert.ok(settings.includes(`'sweep.${key}.${leaf}'`), `lee sweep.${key}.${leaf}`);
      }
    }
  });
}

test('job-dispatch: la cola estampa su reloj en el mismo UPDATE; el rescate arrienda sin tocar el estado y lee su plazo del parámetro', () => {
  const { files } = planFixture('job-dispatch', { stack: STACK });
  const adapter = content(files, 'src/infrastructure/persistence/repositories/job-repository-impl.ts');
  assert.match(adapter, /\.set\(\{ status: JobStatus\.RUNNING, runningSince: claimedAt \}\)/);
  assert.match(adapter, /\.set\(\{ runningSince: claimedAt \}\)/);
  assert.match(adapter, /this\.parameters\.abandonAfterMinutes \* 60/);
  // El plazo es el del diseño: ninguna clave sweep.*.stalled-after-seconds en paralelo.
  assert.doesNotMatch(content(files, 'config/parameters/local/sweep.yaml'), /stalled-after-seconds/);
  // MySQL: el reclamo en READ COMMITTED.
  const mysql = content(planFixture('job-dispatch', { stack: { database: 'mysql' } }).files, 'src/infrastructure/persistence/repositories/job-repository-impl.ts');
  assert.match(mysql, /\{ isolation: 'READ COMMITTED' \}/);
  assert.doesNotMatch(adapter, /READ COMMITTED/);
});

test('el handler del barrido dice que el reclamo ya está generado y cómo se usa', () => {
  const { files } = planFixture('job-dispatch', { stack: STACK });
  const handler = content(files, 'src/application/usecases/dispatch-jobs-command-handler.ts');
  assert.match(handler, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con this\.jobRepository\.claimForDispatchJobsRunning\(\)/);
  assert.match(handler, /EL RESCATE YA ESTÁ GENERADO: this\.jobRepository\.claimForStalledDispatchJobsDone\(\)/);
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
});

test('sin barridos con reclamo no hay configuración de barridos', () => {
  const { files } = planFixture('product-catalog', { stack: STACK });
  assert.ok(!files.some((file) => file.path === SWEEP_SETTINGS_TS || file.path.endsWith('/sweep.yaml')));
});

// Preparación de la corrida 10e: con una operación EXPUESTA que también saca la fila de `running` (el
// ejecutor que confirma), el modelo tomaba `running` por una «espera con plazo» aunque la transición del
// barrido declara `stalledAfter`. Resultado: el rescate sin plazo (todo lo que estuviera en running, al
// minuto) y la cola con el predicado del índice sobre filas sin reloj (no tomaba ninguna). Nada avisaba.
test('job-dispatch-cycles: con stalledAfter es un RESCATE aunque una operación expuesta saque la fila del estado', () => {
  const { model } = planFixture('job-dispatch-cycles', { stack: STACK });
  const [queue, rescue] = sweepClaims(model).map(({ claim }) => claim);
  assert.deepEqual(queue.from, ['queued']);
  assert.equal(queue.due, undefined, 'la cola se vacía por estado, sin predicado de plazo');
  assert.equal(queue.stamps?.field, 'runningSince', 'y estampa el reloj que vigila el rescate');
  assert.equal(rescue.stalled?.state, 'running');
  assert.equal(rescue.stalled?.parameter?.name, 'abandonAfterMinutes');
  assert.equal(rescue.due, undefined);
});

// Corrida job-dispatch-cycles (2026-10-07): dentro de la plantilla, la barra de `\s` se perdía y el arnés
// emitía `split(/s+/)`, que parte por la letra «s». Pasaba porque psql devuelve el número solo.
test('el arnés del rescate parte la salida del motor por espacios, no por la letra s', async () => {
  const { files } = planFixture('job-dispatch-cycles', { stack: STACK });
  const flow = content(files, 'test/integration/support/flow.ts');
  assert.ok(flow.includes(String.raw`split(/\s+/).pop()`), 'la expresión con su barra');
  assert.ok(!flow.includes('split(/s+/)'));
});
