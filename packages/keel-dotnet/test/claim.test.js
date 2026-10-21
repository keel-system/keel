// Los reclamos de barrido de keel-dotnet (incremento 10c), sobre el texto emitido. Lo que el reclamo HACE contra el motor
// (orden, lote, SKIP LOCKED, la carrera entre réplicas, la cota del rescate) lo mide `npm run db-check`; aquí, lo que
// tiene que coincidir con keel-spring y keel-nest y lo que el agente lee:
//   · el puerto de cada raíz trae un método por reclamo que el modelo decidió, y el adaptador lo implementa;
//   · sweep.yaml es el de keel-nest byte a byte y dice lo mismo que el de keel-spring, y SweepSettings lee esas claves;
//   · la cola estampa su reloj en el MISMO UPDATE; el rescate no toca el estado y lee su plazo del parámetro;
//   · el handler del barrido dice que el reclamo ya existe y cómo se usa;
//   · el arnés fabrica la precondición del rescate con las MISMAS sentencias que keel-nest.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { sweepClaims } from 'keel-core/gen';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };
const SWEEPING = ['job-dispatch', 'job-dispatch-cycles', 'payout-runs', 'notification-mailer'];

const design = (name) => loadService(path.join(FIXTURES_DIR, name));
const plan = (name, planner = planService) => planner({ ...design(name), workspace: FIXTURES_DIR, stack: STACK });
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;
const pascal = (name) => name[0].toUpperCase() + name.slice(1);

for (const name of SWEEPING) {
  test(`${name}: cada reclamo del modelo está en el puerto y en el adaptador, con SKIP LOCKED y su lote`, () => {
    const { model, files } = plan(name);
    const claims = sweepClaims(model);
    assert.ok(claims.length > 0);
    for (const { claim } of claims) {
      const method = pascal(claim.method);
      assert.match(content(files, `Repository/I${claim.entity}Repository.cs`), new RegExp(`Task<IReadOnlyList<${claim.entity}>> ${method}\\(CancellationToken cancellationToken = default\\);`), method);
      const adapter = content(files, `Repositories/${claim.entity}Repository.cs`);
      assert.match(adapter, new RegExp(`public Task<IReadOnlyList<${claim.entity}>> ${method}\\(CancellationToken cancellationToken = default\\)`), method);
      assert.match(adapter, /FOR UPDATE SKIP LOCKED/);
      assert.ok(adapter.includes(`sweeps.BatchSize["${claim.sweepKey}"]`), `${method}: lee sweep.${claim.sweepKey}.batch-size`);
      assert.ok(adapter.includes(`RequireOwnTransaction("${method}")`), `${method}: no corre dentro de otra transacción`);
    }
  });

  test(`${name}: sweep.yaml es el de keel-nest y dice lo de keel-spring; SweepSettings lee sus claves`, () => {
    const { files } = plan(name);
    const nest = plan(name, planNest).files;
    const spring = plan(name, planSpring).files;
    const settings = content(files, 'Persistence/SweepSettings.cs');
    for (const profile of ['local', 'develop', 'production', 'test']) {
      const file = `config/parameters/${profile}/sweep.yaml`;
      assert.equal(content(files, file), content(nest, file), file);
    }
    for (const profile of ['local', 'develop', 'production']) {
      const ours = parseYaml(content(files, `config/parameters/${profile}/sweep.yaml`));
      const reference = parseYaml(content(spring, `parameters/${profile}/sweep.yaml`));
      assert.deepEqual(ours, reference, profile);
      for (const [key, leaves] of Object.entries(reference.sweep)) {
        for (const leaf of Object.keys(leaves)) assert.ok(settings.includes(`"sweep:${key}:${leaf}"`), `lee sweep.${key}.${leaf}`);
      }
    }
  });
}

test('job-dispatch: la cola estampa su reloj en el mismo UPDATE; el rescate arrienda sin tocar el estado y lee su plazo del parámetro', () => {
  const { files } = plan('job-dispatch');
  const adapter = content(files, 'Repositories/JobRepository.cs');
  assert.match(adapter, /UPDATE jobs SET status = 'RUNNING', running_since = \{claimedAt\} WHERE id = \{id\} AND status IN \('QUEUED'\)"/);
  assert.match(adapter, /UPDATE jobs SET running_since = \{claimedAt\} WHERE id = \{id\} AND status IN \('RUNNING'\) AND running_since < \{staleBefore\}"/);
  assert.match(adapter, /parameters\.AbandonAfterMinutes \* 60/);
  // El rescate elige por su propio reloj: el más atascado primero.
  assert.match(adapter, /ORDER BY running_since LIMIT \{batch\} FOR UPDATE SKIP LOCKED/);
  assert.match(adapter, /JobDispatchParameters parameters\) : IJobRepository/);
  // El plazo es el del diseño: ninguna clave sweep.*.stalled-after-seconds en paralelo.
  assert.doesNotMatch(content(files, 'config/parameters/local/sweep.yaml'), /stalled-after-seconds/);
});

test('el handler del barrido dice que el reclamo ya está generado y cómo se usa', () => {
  const { files } = plan('job-dispatch');
  const handler = content(files, 'UseCases/DispatchJobsCommandHandler.cs').replace(/\n\s*\/\/\s+/g, ' ');
  assert.match(handler, /EL RECLAMO YA ESTÁ GENERADO: toma el lote con jobRepository\.ClaimForDispatchJobsRunning\(cancellationToken\)/);
  assert.match(handler, /EL RESCATE YA ESTÁ GENERADO: jobRepository\.ClaimForStalledDispatchJobsDone\(cancellationToken\)/);
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA/);
  // Corrida job-dispatch-cycles (10e): el rescate cortaba el lote entero al primer Save que perdía la carrera.
  assert.match(handler, /Un fallo en una fila NO corta el lote: cada Save va en su try/);
  // El handler recibe el puerto del repositorio con el nombre que la nota cita.
  assert.match(handler, /private readonly IJobRepository jobRepository = jobRepository;/);
});

test('los barridos se registran: los del perfil en Program.cs y, si nadie lo hizo, los defaults', () => {
  const { files } = plan('job-dispatch');
  const program = content(files, 'Api/Program.cs');
  assert.ok(program.indexOf('AddSingleton(SweepSettings.From(configuration))') < program.indexOf('AddPersistence('));
  assert.match(content(files, 'Persistence/PersistenceRegistration.cs'), /services\.TryAddSingleton\(SweepSettings\.Defaults\);/);
  // El contenedor de la prueba de los casos de uso tiene los parámetros que el adaptador del rescate inyecta.
  assert.match(content(files, 'UnitTests/UseCasesTests.cs'), /services\.AddSingleton\(new JobDispatchParameters\(5\)\);/);
});

test('sin barridos con reclamo no hay configuración de barridos ni dependencia en el adaptador', () => {
  const { files } = plan('product-catalog');
  assert.ok(!files.some((file) => file.path.endsWith('/SweepSettings.cs') || file.path.endsWith('/sweep.yaml')));
  assert.doesNotMatch(content(files, 'Repositories/ProductRepository.cs'), /SweepSettings/);
  assert.doesNotMatch(content(files, 'Api/Program.cs'), /SweepSettings/);
});

test('el arnés fabrica la precondición del rescate con las mismas sentencias que keel-nest', () => {
  const ours = content(plan('job-dispatch-cycles').files, 'Support/FlowTest.cs');
  const flow = content(plan('job-dispatch-cycles', planNest).files, 'test/integration/support/flow.ts');
  const sentences = [...flow.matchAll(/(stall|put|missing): '((?:[^'\\]|\\.)*)'/g)].map((match) => match[2].replaceAll("\\'", "'"));
  assert.equal(sentences.length, 3);
  for (const sentence of sentences) assert.ok(ours.includes(JSON.stringify(sentence)), sentence);
  for (const helper of ['protected static void StallInFlight(string operation, string id)', 'protected static void PutInFlight(string operation, string id)', 'protected static int InFlightWithoutClock(string operation)']) {
    assert.ok(ours.includes(helper), helper);
  }
  // Sin rescate en el diseño, no hay helpers del rescate.
  assert.doesNotMatch(content(plan('payout-runs').files, 'Support/FlowTest.cs'), /StallInFlight/);
});

test('MySQL: el reclamo y la purga con el alias entre acentos graves, el reclamo en READ COMMITTED y la purga con LIMIT antes de OFFSET', () => {
  const { files } = planService({ ...design('job-dispatch'), workspace: FIXTURES_DIR, stack: { database: 'mysql' } });
  const adapter = content(files, 'Repositories/JobRepository.cs');
  assert.match(adapter, /SELECT id AS `Value` FROM jobs WHERE status IN \('QUEUED'\) ORDER BY [a-z_]+ LIMIT \{batch\} FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(adapter, /AS \\"Value\\"/);
  assert.match(adapter, /cancellationToken,\s*PersistenceTransactions\.ClaimIsolation\);/);
  const purges = content(files, 'Purge/TablePurges.cs');
  if (purges) {
    // MySQL no admite OFFSET antes de LIMIT; PostgreSQL admite los dos órdenes, así que va el mismo en los dos.
    assert.match(purges, /AS `Value` FROM \w+ WHERE [^"]* LIMIT 1 OFFSET \{position\}/);
  }
});
