// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) en keel-go: la forma de lo que emite build sobre los diseños de
// BATCH_JOB_DESIGNS (keel-core/test/helpers/batch-designs.js) y su PARIDAD con lo que emiten keel-spring, keel-nest y
// keel-dotnet del mismo diseño (los mismos casos, la misma nota, la misma configuración, el mismo contrato, las mismas
// sentencias). Sin Go no se ejecuta nada: que el alta y el temporizador vayan en una transacción, que la valla del cursor
// revierta un elemento, que el trabajo se reanude tras una caída, lo miden db-check y doc-check contra el motor real
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
import { goString } from '../src/lib/go-source.js';
import { generatorTables } from '../src/scaffold/persistence.js';
import { BATCH_JOB_SABOTAGE_SPECS, BATCH_JOB_SUBJECTS, batchJobCases, batchJobProbeFile } from '../scripts/lib/batch-job-probes.js';
import { batchProbeFile } from '../scripts/lib/batch-probes.js';
import { applyDbSabotage } from './helpers/db-sabotages.js';
import { applyDocSabotage } from './helpers/doc-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { jobCasesOf as springJobCases } from '../../keel-spring/src/lib/batch-job-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { batchJobCases as nestJobCases } from '../../keel-nest/scripts/lib/batch-job-probes.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { batchJobCases as dotnetJobCases } from '../../keel-dotnet/scripts/lib/batch-job-probes.js';

const design = (name) => BATCH_JOB_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  manifest.service.name = name;
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

test('los sujetos pasan la frontera de keel-go y su sonda ejecuta los MISMOS casos que las de los otros tres', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const { model } = plan(name);
    const cases = batchJobCases(model);
    assert.equal(cases.length, 9, name);
    assert.deepEqual(cases, springJobCases(plan(name, { generator: planSpring }).model), name);
    assert.deepEqual(cases, nestJobCases(plan(name, { generator: planNest }).model), name);
    assert.deepEqual(cases, dotnetJobCases(plan(name, { generator: planDotnet }).model), name);
    // La sonda de la fase A deja fuera la operación asíncrona: la mide esta.
    assert.equal(batchProbeFile(model), null, name);
    assert.ok(batchJobProbeFile(model), name);
  }
  assert.deepEqual([...BATCH_JOB_SUBJECTS.relational, ...BATCH_JOB_SUBJECTS.document].sort(), BATCH_JOB_DESIGNS.map((entry) => entry.name).sort());
});

test('la nota del handler es la neutral, la misma que escriben los otros tres', () => {
  const { model, files } = plan('catalog-batch-async');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  const handler = fileOf(files, 'internal/application/import_products_command_handler.go');
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) assert.ok(flat(handler).includes(line), line);
});

test('la configuración de los lotes es, línea a línea, la de keel-nest y keel-dotnet', () => {
  const mine = plan('catalog-batch-async').files;
  for (const generator of [planNest, planDotnet]) {
    const theirs = plan('catalog-batch-async', { generator }).files;
    for (const profile of ['local', 'develop', 'production', 'test']) {
      assert.equal(fileOf(mine, `config/parameters/${profile}/batch.yaml`), fileOf(theirs, `config/parameters/${profile}/batch.yaml`), profile);
    }
  }
});

test('el contrato formal es el MISMO byte a byte que el de los otros tres', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const mine = fileOf(plan(name).files, 'docs/openapi.yaml');
    for (const generator of [planSpring, planNest, planDotnet]) assert.equal(mine, fileOf(plan(name, { generator }).files, 'docs/openapi.yaml'), name);
  }
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, en los dos motores, y sus tablas van a la baseline', () => {
  for (const database of ['postgresql', 'mysql']) {
    const { model, files } = plan('catalog-batch-async', { database });
    const store = fileOf(files, `/${database === 'mysql' ? 'mysql' : 'postgres'}/batch_jobs.go`);
    for (const [name, sql] of Object.entries(batchStatements(database))) assert.ok(store.includes(goString(sql)), `${database}: ${name}`);
    assert.deepEqual(generatorTables(model).map((table) => table.table).filter((table) => table.startsWith('batch_')), ['batch_job', 'batch_item_result']);
    const baseline = fileOf(files, '/migrations/00001_baseline.sql');
    assert.match(baseline, /CONSTRAINT uq_batch_job_key UNIQUE \(operation, owner, idempotency_key\)/);
    assert.match(baseline, /fk_batch_item_result_job/);
  }
});

test('el documental guarda la clave sin campo cuando no la hay, y su índice es parcial', () => {
  const { files } = plan('catalog-batch-async-mongo');
  assert.match(fileOf(files, '/mongo/batch_jobs.go'), /if job\.Key != nil \{\n\t\tdocument = append\(document, bson\.E\{Key: "idempotency_key", Value: \*job\.Key\}\)/);
  assert.match(
    fileOf(files, '/mongo/indexes.go'),
    /SetName\("uq_batch_job_key"\)\.SetUnique\(true\)\.SetPartialFilterExpression\(bson\.D\{\{Key: "idempotency_key", Value: bson\.D\{\{Key: "\$type", Value: "string"\}\}\}\}\)/
  );
});

test('el cronómetro conoce el temporizador del trabajo, lo dispara fuera de su transacción y purga batch_job', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { files } = plan(name);
    assert.match(fileOf(files, 'internal/infrastructure/timer/kinds.go'), /KindBatchImportProducts += "batch:importProducts"/, name);
    assert.match(fileOf(files, 'internal/infrastructure/timer/batch_job.go'), /func \(b \*BatchJob\) InTransaction\(\) bool \{\n\treturn false\n\}/, name);
    assert.match(fileOf(files, 'internal/infrastructure/timer/poller.go'), /\} else if detached\(p\.handlers\[timer\.Kind\]\) \{/, name);
    const server = fileOf(files, 'cmd/server/main.go');
    assert.match(server, /batchJobs := httpapi\.NewBatchJobRunner\(useCases, logger, batchSettings\.ChunkSize\)/, name);
    assert.match(server, /timer\.NewBatchJob\(timer\.KindBatchImportProducts, batchJobs\.ImportProducts\),/, name);
    assert.match(server, /_, err := batchJobStore\.Purge\(ctx, batchSettings\.RetentionDays\)/, name);
    assert.match(server, /BatchJobs: +batchJobStore,/, name);
  }
});

test('el alta firma los bytes del cuerpo y el procesador vuelve a leer el sobre con el MISMO lector del endpoint', () => {
  const { files } = plan('catalog-batch-async');
  const endpoints = fileOf(files, 'internal/httpapi/product_endpoints.go');
  assert.match(endpoints, /return a\.submitBatchJob\(w, r, batchJobSpec\{operation: "importProducts", kind: "batch:importProducts", keySource: "client-key", ttlSeconds: 86400,/);
  // Una cota de la lista incumplida es el 400 del sobre con el mensaje de las restricciones (invalidParams), como keel-spring.
  assert.match(endpoints, /inBody := violations\{params: true\}/);
  const jobs = fileOf(files, 'internal/httpapi/batch_jobs.go');
  assert.match(jobs, /body, err := io\.ReadAll\(r\.Body\)/);
  assert.match(jobs, /digest := sha256\.Sum256\(body\)/);
  assert.match(jobs, /return writeJSON\(w, http\.StatusAccepted, batchJobView\(created\)\)/);
  assert.match(jobs, /return runBatchChunk\(ctx, b, jobID, readImportProducts, \[\]string\{"SKU_ALREADY_EXISTS"\}/);
  const routes = fileOf(files, 'internal/httpapi/routes.go');
  assert.match(routes, /\{Operation: "importProducts", Method: http\.MethodPost, Path: "\/api\/v1\/products\/batch", Status: http\.StatusAccepted, Location: true,/);
  assert.match(routes, /\{Operation: "importProductsJob", Method: http\.MethodGet, Path: "\/api\/v1\/products\/batch\/jobs\/\{jobId\}", Status: http\.StatusOK, handle: \(\*api\)\.importProductsJob\},/);
  assert.match(routes, /\{Operation: "importProductsJobResults", Method: http\.MethodGet, Path: "\/api\/v1\/products\/batch\/jobs\/\{jobId\}\/results", Status: http\.StatusOK, Query: \[\]string\{"page", "size"\}, handle: \(\*api\)\.importProductsJobResults\},/);
});

test('el avance del cursor (la valla) va ANTES que el resultado, en la transacción del elemento, y el dueño es el actor de autoría', () => {
  const jobs = fileOf(plan('catalog-batch-async').files, 'internal/httpapi/batch_jobs.go');
  const keep = jobs.slice(jobs.indexOf('func keepBatchItem('));
  assert.ok(keep.indexOf('store.Advance(') > 0 && keep.indexOf('store.Advance(') < keep.indexOf('store.InsertResult('));
  // El procesador corre como el dueño: un principal de token cuyo sujeto es él.
  assert.match(jobs, /security\.WithPrincipal\(ctx, &security\.Principal\{Kind: security\.TokenPrincipal, Name: owner,/);
  for (const name of ['catalog-batch-async', 'catalog-batch-async-mongo']) {
    const { files } = plan(name);
    const store = fileOf(files, '/batch_jobs.go');
    assert.match(store, /"owner": auditActor\(ctx\)|\{Key: "owner", Value: auditActor\(ctx\)\}/, name);
    assert.ok(files.some((file) => file.path.endsWith('/audit_actor.go')), name);
  }
});

test('lo que el trabajo no puede llevarse de la petición se rechaza en planService, con el criterio de los otros tres', () => {
  const routed = (layers) => {
    layers.api.endpoints.importProducts.path = '/categories/{categoryId}/products/batch';
    layers['use-cases'].operations.importProducts.input.fields.categoryId = { type: 'uuid', required: true };
  };
  assert.throws(() => plan('catalog-batch-async', { mutate: routed }), /lleva parámetros que no viajarían/);
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_JOB_SABOTAGE_SPECS)) {
    assert.ok(applyDbSabotage(specs.relational, plan('catalog-batch-async').files, 'postgresql').changed > 0, `${id} (relacional)`);
    assert.ok(applyDbSabotage(specs.relational, plan('catalog-batch-async', { database: 'mysql' }).files, 'mysql').changed > 0, `${id} (mysql)`);
    assert.ok(applyDocSabotage(specs.document, plan('catalog-batch-async-mongo').files).changed > 0, `${id} (documental)`);
  }
});
