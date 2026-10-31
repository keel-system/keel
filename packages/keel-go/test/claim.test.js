// Los reclamos de barrido de keel-go (tramo 10c), sobre el texto emitido. Lo que el reclamo HACE contra el motor (orden,
// lote, SKIP LOCKED, la carrera entre réplicas, la cota del rescate) lo mide `npm run db-check`; aquí, lo que tiene que
// coincidir con keel-spring, keel-nest y keel-dotnet y lo que el agente lee:
//   · el puerto de cada raíz trae un método por reclamo que el modelo decidió, y el adaptador lo implementa;
//   · sweep.yaml es el de keel-nest y keel-dotnet byte a byte y dice lo mismo que el de keel-spring, y SweepSettings lee
//     esas claves;
//   · la cola estampa su reloj en el MISMO UPDATE; el rescate no toca el estado y lee su plazo del parámetro;
//   · el handler del barrido dice que el reclamo ya existe y cómo se usa;
//   · el arnés fabrica la precondición del rescate con las MISMAS sentencias que keel-nest y keel-dotnet.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { sweepClaims } from '@keel-system/keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql' };
// Las fixtures con barrido que keel-go genera (notification-mailer, la cuarta de keel-dotnet, trae correo: incremento 13).
const SWEEPING = ['job-dispatch', 'job-dispatch-cycles', 'payout-runs'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService, stack = STACK) => planner({ ...design(name), workspace: FIXTURES_DIR, stack });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const pascal = (name) => name[0].toUpperCase() + name.slice(1);
const fileName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

for (const name of SWEEPING) {
  test(`${name}: cada reclamo del modelo está en el puerto y en el adaptador, con SKIP LOCKED, su lote y su transacción propia`, () => {
    const { model, files } = plan(name);
    const claims = sweepClaims(model);
    assert.ok(claims.length > 0);
    for (const { claim } of claims) {
      const method = pascal(claim.method);
      const port = content(files, `internal/domain/${fileName(claim.entity)}_repository.go`);
      assert.ok(port.includes(`\t${method}(ctx context.Context) ([]*${claim.entity}, error)`), method);
      const adapter = content(files, `internal/infrastructure/postgres/${fileName(claim.entity)}_repository.go`);
      assert.ok(adapter.includes(`func (r *${claim.entity}Repository) ${method}(ctx context.Context) ([]*domain.${claim.entity}, error) {`), method);
      assert.ok(adapter.includes(`ownTransaction(ctx, "${method}")`), `${method}: no corre dentro de otra transacción`);
      assert.ok(adapter.includes(`r.sweeps.BatchSize["${claim.sweepKey}"]`), `${method}: lee sweep.${claim.sweepKey}.batch-size`);
      assert.match(adapter, /FOR UPDATE SKIP LOCKED/);
      assert.match(adapter, /r\.tx\.fresh\(ctx, claimOptions,/);
    }
  });

  test(`${name}: sweep.yaml es el de keel-nest y keel-dotnet y dice lo de keel-spring; SweepSettings lee sus claves`, () => {
    const { files } = plan(name);
    const nest = plan(name, planNest).files;
    const dotnet = plan(name, planDotnet).files;
    const spring = plan(name, planSpring).files;
    const settings = content(files, 'internal/infrastructure/postgres/sweep.go');
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const file = `config/parameters/${profile}/sweep.yaml`;
      assert.equal(content(files, file), content(nest, file), file);
      assert.equal(content(files, file), content(dotnet, file), file);
    }
    for (const profile of ['local', 'develop', 'production']) {
      const ours = parseYaml(content(files, `config/parameters/${profile}/sweep.yaml`));
      const reference = parseYaml(content(spring, `parameters/${profile}/sweep.yaml`));
      assert.deepEqual(ours, reference, profile);
      // SweepSettingsFrom recorre las claves de los defaults: cada una del YAML tiene que estar en ellos.
      for (const [key, leaves] of Object.entries(reference.sweep)) {
        assert.ok(settings.includes(`"${key}":`), `los defaults traen sweep.${key}`);
        for (const leaf of Object.keys(leaves)) assert.ok(settings.includes(`"${leaf}"`), `lee sweep.${key}.${leaf}`);
      }
    }
  });
}

test('job-dispatch: la cola estampa su reloj en el mismo UPDATE; el rescate arrienda sin tocar el estado y lee su plazo del parámetro', () => {
  const { files } = plan('job-dispatch');
  const adapter = content(files, 'internal/infrastructure/postgres/job_repository.go');
  assert.ok(adapter.includes(`"UPDATE jobs SET status = 'RUNNING', running_since = $1 WHERE id = $2 AND status IN ('QUEUED')", claimedAt, id)`));
  assert.ok(adapter.includes(`"UPDATE jobs SET running_since = $1 WHERE id = $2 AND status IN ('RUNNING') AND running_since < $3", claimedAt, id, staleBefore)`));
  assert.ok(adapter.includes('time.Duration(r.parameters.AbandonAfterMinutes()) * 60 * time.Second'));
  // El rescate elige por su propio reloj: el más atascado primero.
  assert.ok(adapter.includes(`"SELECT id FROM jobs WHERE status IN ('RUNNING') AND running_since < $1 ORDER BY running_since LIMIT $2 FOR UPDATE SKIP LOCKED", staleBefore, batch)`));
  assert.ok(adapter.includes('func NewJobRepository(tx *Transactions, sweeps SweepSettings, parameters domain.JobDispatchParameters) *JobRepository {'));
  // El plazo es el del diseño: ninguna clave sweep.*.stalled-after-seconds en paralelo.
  assert.doesNotMatch(content(files, 'config/parameters/local/sweep.yaml'), /stalled-after-seconds/);
});

test('el handler del barrido dice que el reclamo ya está generado y cómo se usa', () => {
  const { files } = plan('job-dispatch');
  const handler = content(files, 'internal/application/dispatch_jobs_command_handler.go').replace(/\n\s*\/\/\s+/g, ' ');
  assert.match(handler, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con h\.jobRepository\.ClaimForDispatchJobsRunning\(ctx\)/);
  assert.match(handler, /EL RESCATE YA ESTÁ GENERADO: h\.jobRepository\.ClaimForStalledDispatchJobsDone\(ctx\)/);
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
  // El handler recibe el puerto del repositorio con el nombre que la nota cita.
  assert.match(handler, /\tjobRepository +domain\.JobRepository/);
});

test('el arranque lee los barridos y se los da al adaptador; sin barridos con reclamo no hay nada de eso', () => {
  const main = content(plan('job-dispatch').files, 'cmd/server/main.go');
  assert.ok(main.indexOf('sweeps, err := postgres.SweepSettingsFrom(cfg)') < main.indexOf('postgres.NewJobRepository(transactions, sweeps, serviceParameters)'));
  const { files } = plan('product-catalog');
  assert.ok(!files.some((file) => file.path.endsWith('/sweep.go') || file.path.endsWith('/sweep.yaml')));
  assert.doesNotMatch(content(files, 'internal/infrastructure/postgres/product_repository.go'), /SweepSettings/);
  assert.doesNotMatch(content(files, 'cmd/server/main.go'), /SweepSettings/);
});

test('el arnés fabrica la precondición del rescate con las mismas sentencias que keel-nest y keel-dotnet', () => {
  const ours = content(plan('job-dispatch-cycles').files, 'tests/integration/flow_test.go');
  const flow = content(plan('job-dispatch-cycles', planNest).files, 'test/integration/support/flow.ts');
  const sentences = [...flow.matchAll(/(stall|put|missing): '((?:[^'\\]|\\.)*)'/g)].map((match) => match[2].replaceAll("\\'", "'"));
  assert.equal(sentences.length, 3);
  for (const sentence of sentences) assert.ok(ours.includes(JSON.stringify(sentence)), sentence);
  const dotnet = content(plan('job-dispatch-cycles', planDotnet).files, 'Support/FlowTest.cs');
  for (const sentence of sentences) assert.ok(dotnet.includes(JSON.stringify(sentence)), `keel-dotnet: ${sentence}`);
  for (const helper of ['func (s *Scenario) StallInFlight(operation, id string) {', 'func (s *Scenario) PutInFlight(operation, id string) {', 'func (s *Scenario) InFlightWithoutClock(operation string) int {']) {
    assert.ok(ours.includes(helper), helper);
  }
  // Sin rescate en el diseño, no hay helpers del rescate.
  assert.doesNotMatch(content(plan('payout-runs').files, 'tests/integration/flow_test.go'), /StallInFlight/);
});

test('MySQL: el reclamo con ? posicional y en READ COMMITTED, y el id del arnés en sus 16 bytes', () => {
  const { files } = plan('job-dispatch', planService, { database: 'mysql' });
  const adapter = content(files, 'internal/infrastructure/mysql/job_repository.go');
  assert.ok(adapter.includes(`"SELECT id FROM jobs WHERE status IN ('RUNNING') AND running_since < ? ORDER BY running_since LIMIT ? FOR UPDATE SKIP LOCKED", staleBefore, batch)`));
  assert.ok(adapter.includes(`"UPDATE jobs SET running_since = ? WHERE id = ? AND status IN ('RUNNING') AND running_since < ?", claimedAt, id, staleBefore)`));
  assert.match(content(files, 'internal/infrastructure/mysql/sweep.go'), /var claimOptions = sql\.TxOptions\{Isolation: sql\.LevelReadCommitted\}/);
  assert.match(content(files, 'tests/integration/flow_test.go'), /return "UUID_TO_BIN\('" \+ id \+ "'\)"/);
});
