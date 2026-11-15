// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) en keel-dotnet: la forma de lo que emite build sobre los diseños de
// BATCH_JOB_DESIGNS (keel-core/test/helpers/batch-designs.js) y su PARIDAD con lo que emiten keel-spring y keel-nest del
// mismo diseño (los mismos casos, la misma nota, la misma configuración, el mismo contrato, las mismas sentencias). Sin SDK
// no se ejecuta el C#: que el alta y el temporizador vayan en una transacción, que la valla del cursor revierta un
// elemento, que el trabajo se reanude tras una caída, lo miden db-check y doc-check contra el motor real
// (scripts/lib/batch-job-probes.js: BJ-1 a BJ-9, falsados con bj-no-resume, bj-cursor-outside-tx y bj-foreign-reader).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { batchNote } from '@keel-system/keel-core/gen/batch';
import { batchStatements } from '@keel-system/keel-core/gen/batch-store';
import { BATCH_JOB_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { csString } from '../src/scaffold/render.js';
import { generatorTables } from '../src/scaffold/schema-baseline.js';
import { BATCH_JOB_SABOTAGE_SPECS, BATCH_JOB_SUBJECTS, batchJobCases } from '../scripts/lib/batch-job-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { jobCasesOf as springJobCases } from '../../keel-spring/src/lib/batch-job-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { batchJobCases as nestJobCases } from '../../keel-nest/scripts/lib/batch-job-probes.js';

const design = (name) => BATCH_JOB_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { generator = planService, database = null, mutate = null } = {}) {
  const { manifest, layers, document } = load(name, mutate);
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-dotnet y su sonda ejecuta los MISMOS casos que las de keel-spring y keel-nest', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const cases = batchJobCases(plan(name).model);
    assert.equal(cases.length, 9, name);
    assert.deepEqual(cases, springJobCases(plan(name, { generator: planSpring }).model), name);
    assert.deepEqual(cases, nestJobCases(plan(name, { generator: planNest }).model), name);
  }
  assert.deepEqual([...BATCH_JOB_SUBJECTS.relational, ...BATCH_JOB_SUBJECTS.document].sort(), BATCH_JOB_DESIGNS.map((entry) => entry.name).sort());
});

test('la nota del handler es la neutral, la misma que escriben keel-spring y keel-nest', () => {
  const { model, files } = plan('catalog-batch-async');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  const handler = fileOf(files, 'UseCases/ImportProductsCommandHandler.cs');
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) assert.ok(flat(handler).includes(line), line);
});

test('la configuración de los lotes es, línea a línea, la de keel-spring y keel-nest', () => {
  const mine = plan('catalog-batch-async').files;
  const spring = plan('catalog-batch-async', { generator: planSpring }).files;
  const nest = plan('catalog-batch-async', { generator: planNest }).files;
  for (const profile of ['local', 'develop', 'production']) {
    assert.equal(fileOf(mine, `config/parameters/${profile}/batch.yaml`), fileOf(spring, `parameters/${profile}/batch.yaml`), profile);
  }
  for (const profile of ['local', 'develop', 'production', 'test']) {
    assert.equal(fileOf(mine, `config/parameters/${profile}/batch.yaml`), fileOf(nest, `config/parameters/${profile}/batch.yaml`), profile);
  }
});

test('el contrato formal es el MISMO byte a byte que el de keel-spring y keel-nest', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const mine = fileOf(plan(name).files, 'docs/openapi.yaml');
    assert.equal(mine, fileOf(plan(name, { generator: planSpring }).files, 'docs/openapi.yaml'), name);
    assert.equal(mine, fileOf(plan(name, { generator: planNest }).files, 'docs/openapi.yaml'), name);
  }
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, en los dos motores, y sus tablas van al esquema', () => {
  for (const database of ['postgresql', 'mysql']) {
    const { files } = plan('catalog-batch-async', { database });
    const store = fileOf(files, 'Persistence/Batch/BatchJobStore.cs');
    for (const [name, sql] of Object.entries(batchStatements(database))) assert.ok(store.includes(csString(sql)), `${database}: ${name}`);
    // Las dos tablas, mapeadas solo para el esquema: el paso de esquema de build las ve.
    assert.deepEqual(generatorTables(files).map((table) => table.table).filter((table) => table.startsWith('batch_')), ['batch_job', 'batch_item_result']);
    assert.match(fileOf(files, 'Rows/BatchJobRow.cs'), /\.IsUnique\(\)\.HasDatabaseName\("uq_batch_job_key"\)/);
  }
});

test('el documental guarda la clave sin campo cuando no la hay, y su índice es parcial', () => {
  const { files } = plan('catalog-batch-async-mongo');
  assert.match(fileOf(files, 'Persistence/Batch/BatchJobStore.cs'), /if \(key is not null\)\s+\{\s+document\["idempotency_key"\] = key;/);
  assert.match(fileOf(files, 'Persistence/DocumentIndexes.cs'), /Name = "uq_batch_job_key", Unique = true, PartialFilterExpression = new BsonDocument\("idempotency_key", new BsonDocument\("\$type", "string"\)\)/);
});

test('el cronómetro conoce el temporizador del trabajo, lo dispara fuera de su transacción y purga batch_job', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { files } = plan(name);
    assert.match(fileOf(files, 'Timers/TimerKinds.cs'), /public const string BatchImportProducts = "batch:importProducts";/, name);
    assert.match(fileOf(files, 'Timers/ITimerHandler.cs'), /bool InTransaction => true;/, name);
    assert.match(fileOf(files, 'Timers/TimerPoller.cs'), /if \(!handler\.InTransaction\)/, name);
    assert.match(fileOf(files, 'Rest/ImportProductsBatchJob.cs'), /public bool InTransaction => false;/, name);
    assert.match(fileOf(files, 'Rest/BatchJobRegistration.cs'), /services\.AddScoped<ITimerHandler, ImportProductsBatchJob>\(\);/, name);
    assert.match(fileOf(files, 'Timers/BatchJobPurgeTimer.cs'), /store\.Purge\(settings\.RetentionDays, cancellationToken\)/, name);
    const program = fileOf(files, 'Program.cs');
    assert.match(program, /builder\.Services\.AddSingleton\(BatchSettings\.From\(configuration\)\);\nbuilder\.Services\.AddBatchJobs\(\);/, name);
  }
});

test('el alta firma los bytes del cuerpo y el procesador vuelve a leer el sobre con el MISMO lector del endpoint', () => {
  const { files } = plan('catalog-batch-async');
  const endpoints = fileOf(files, 'Endpoints/ProductV1Endpoints.cs');
  assert.match(endpoints, /var body = await BatchJobRequests\.Body\(http\.Request\);/);
  assert.match(endpoints, /await HttpReply\.Json\(http, 202, job\);/);
  assert.match(endpoints, /public static BatchEnvelope<ProductDraft, ImportProductsCommand> ReadImportProducts\(ReadOnlyMemory<byte> body\)/);
  // Una cota de la lista incumplida es el 400 del sobre con el mensaje de las restricciones (invalidParams), como keel-spring.
  assert.match(endpoints, /new InputViolations\(ViolationSource\.Params\)/);
  assert.match(fileOf(files, 'Rest/ImportProductsBatchJob.cs'), /ProductV1Endpoints\.ReadImportProducts, ValueReaders\.ReadProductDraft/);
  const routes = fileOf(files, 'Rest/ApiRoutes.cs');
  assert.match(routes, /new\("importProducts", "POST", "\/api\/v1\/products\/batch", 202, Location: true,/);
  assert.match(routes, /new\("importProductsJob", "GET", "\/api\/v1\/products\/batch\/jobs\/\{jobId\}", 200,/);
  assert.match(routes, /new\("importProductsJobResults", "GET", "\/api\/v1\/products\/batch\/jobs\/\{jobId\}\/results", 200, Location: false, Query: \["page", "size"\],/);
});

test('el avance del cursor (la valla) va ANTES que el resultado, en la transacción del elemento', () => {
  const { files } = plan('catalog-batch-async');
  const jobs = fileOf(files, 'Rest/BatchJobs.cs');
  // El paso de un elemento lo comparten el procesador y el lote síncrono con clave (D15): BatchJobSteps.
  const steps = fileOf(files, 'Rest/BatchJobSteps.cs');
  const keep = steps.slice(steps.indexOf('internal static async Task Keep('));
  assert.ok(keep.indexOf('own.Advance(') > 0 && keep.indexOf('own.Advance(') < keep.indexOf('own.InsertResult('));
  // El dueño es el actor de autoría, en el alta y en las rutas.
  assert.match(jobs, /var owner = AuditActor\.Current\(\);/);
  assert.match(jobs, /store\.Owned\(jobId, operation, AuditActor\.Current\(\), cancellationToken\)/);
});

test('un proyecto solo asíncrono no lleva lo del lote síncrono con clave (D15): ni la toma, ni el descarte, ni su umbral', () => {
  for (const name of ['catalog-batch-async', 'catalog-batch-async-mongo']) {
    const { files } = plan(name);
    assert.doesNotMatch(fileOf(files, 'Batch/IBatchJobStore.cs'), /TakeOver|Discard/, name);
    assert.doesNotMatch(fileOf(files, 'Batch/BatchSettings.cs'), /SyncStaleMs/, name);
    assert.ok(!files.some((file) => file.path.endsWith('Rest/KeyedBatches.cs')), name);
  }
});

test('lo que el trabajo no puede llevarse de la petición se rechaza en planService, con el criterio de keel-spring', () => {
  const routed = (layers) => {
    layers.api.endpoints.importProducts.path = '/categories/{categoryId}/products/batch';
    layers['use-cases'].operations.importProducts.input.fields.categoryId = { type: 'uuid', required: true };
  };
  assert.throws(() => plan('catalog-batch-async', { mutate: routed }), /lleva parámetros que no viajarían/);
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_JOB_SABOTAGE_SPECS)) {
    for (const [store, subject] of [['relational', 'catalog-batch-async'], ['document', 'catalog-batch-async-mongo']]) {
      const [where, from, to] = specs[store];
      const touched = plan(subject).files.filter((file) => typeof file.content === 'string' && file.path.startsWith('src/') && file.path.includes(where));
      const changed = touched.filter((file) => file.content.replaceAll(from, to) !== file.content);
      assert.ok(changed.length > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});
