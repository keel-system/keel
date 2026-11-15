// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) en keel-nest: la forma de lo que emite build sobre los diseños de
// BATCH_JOB_DESIGNS (keel-core/test/helpers/batch-designs.js) y su PARIDAD con lo que emite keel-spring del mismo diseño
// (los mismos casos, la misma configuración, el mismo contrato, las mismas sentencias). Lo que esto NO dice —que el
// alta y el temporizador vayan en una transacción, que la valla del cursor revierta un elemento, que el trabajo se
// reanude tras una caída— lo miden db-check y doc-check contra el motor real (scripts/lib/batch-job-probes.js: BJ-1 a
// BJ-9, y los sabotajes bj-*).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { batchNote } from '@keel-system/keel-core/gen/batch';
import { batchStatements } from '@keel-system/keel-core/gen/batch-store';
import { BATCH_JOB_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { BATCH_JOB_STEPS_TS, SQL_BATCH_JOB_STORE_TS, MONGO_BATCH_JOB_STORE_TS } from '../src/scaffold/batch-jobs.js';
import { TIMER_POLLER_TS, TIMER_MODULE_TS, TIMER_KINDS_TS } from '../src/scaffold/timer.js';
import { batchJobCases, BATCH_JOB_SABOTAGE_SPECS } from '../scripts/lib/batch-job-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { jobCasesOf as springJobCases } from '../../keel-spring/src/lib/batch-job-probes.js';

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

test('los sujetos pasan la frontera de keel-nest y su sonda ejecuta los MISMOS casos que la de keel-spring', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const nest = plan(name);
    assert.deepEqual(batchJobCases(nest.model), springJobCases(plan(name, { generator: planSpring }).model), name);
    assert.equal(batchJobCases(nest.model).length, 9, name);
  }
});

test('la nota del handler es la neutral, la misma que escribe keel-spring', () => {
  const { model, files } = plan('catalog-batch-async');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  const handler = files.find((file) => file.path.endsWith('import-products-command-handler.ts'));
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) assert.ok(flat(handler.content).includes(line), line);
});

test('la configuración de los lotes es, línea a línea, la de keel-spring', () => {
  const nest = plan('catalog-batch-async').files;
  const spring = plan('catalog-batch-async', { generator: planSpring }).files;
  // keel-spring no escribe el fragmento del perfil test (sus pruebas leen los defaults); keel-nest lo escribe con ellos.
  for (const profile of ['local', 'develop', 'production']) {
    assert.equal(fileOf(nest, `config/parameters/${profile}/batch.yaml`), fileOf(spring, `parameters/${profile}/batch.yaml`), profile);
  }
});

test('el contrato formal es el MISMO byte a byte que el de keel-spring', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    assert.equal(fileOf(plan(name).files, 'docs/openapi.yaml'), fileOf(plan(name, { generator: planSpring }).files, 'docs/openapi.yaml'), name);
  }
});

test('el almacén relacional lleva las sentencias de keel-core TAL CUAL, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const store = fileOf(plan('catalog-batch-async', { database }).files, SQL_BATCH_JOB_STORE_TS);
    for (const [name, sql] of Object.entries(batchStatements(database))) {
      assert.ok(store.includes(JSON.stringify(sql).slice(1, -1).replaceAll("'", "\\'")) || store.includes(sql), `${database}: ${name}`);
    }
  }
});

test('el documental guarda la clave sin campo cuando no la hay, y su índice es parcial', () => {
  const { files } = plan('catalog-batch-async-mongo');
  assert.match(fileOf(files, MONGO_BATCH_JOB_STORE_TS), /\.\.\.\(key != null \? \{ idempotency_key: key \} : \{\}\)/);
  assert.match(fileOf(files, 'document-indexes.ts'), /uq_batch_job_key.*partialFilterExpression: \{ 'idempotency_key': \{ \$type: 'string' \} \}/s);
});

test('el cronómetro conoce el temporizador del trabajo, lo dispara fuera de su transacción y purga batch_job', () => {
  for (const { name } of BATCH_JOB_DESIGNS) {
    const { files } = plan(name);
    assert.match(fileOf(files, TIMER_KINDS_TS), /BATCH_IMPORT_PRODUCTS: 'batch:importProducts'/, name);
    assert.match(fileOf(files, TIMER_POLLER_TS), /handler\.inTransaction === false/, name);
    const module = fileOf(files, TIMER_MODULE_TS);
    assert.match(module, /imports: \[UseCaseModule\]/, name);
    assert.match(module, /ImportProductsBatchJob/, name);
    assert.match(module, /provide: BATCH_SETTINGS/, name);
    assert.match(fileOf(files, 'import-products-batch-job.ts'), /readonly inTransaction = false;/, name);
    assert.match(fileOf(files, 'batch-job-purge-timer.ts'), /this\.store\.purge\(this\.settings\.retentionDays\)/, name);
  }
});

test('el alta firma el texto del cuerpo: http-platform lo guarda y el controlador lo lee', () => {
  const { files } = plan('catalog-batch-async');
  assert.match(fileOf(files, 'http-platform.ts'), /\(request as \{ rawBody\?: string \}\)\.rawBody = body as string;/);
  const controller = fileOf(files, 'product-v1-controller.ts');
  assert.match(controller, /@HttpCode\(202\)/);
  assert.match(controller, /rawBodyOf\(request\)/);
  assert.match(controller, /@Get\('products\/batch\/jobs\/:jobId'\)/);
  assert.match(controller, /@Get\('products\/batch\/jobs\/:jobId\/results'\)/);
  // El procesador vuelve a leer el sobre guardado con el MISMO lector que usa el borde.
  assert.match(controller, /export function readImportProductsCommand\(/);
});

test('el avance del cursor (la valla) va ANTES que el resultado, en la transacción del elemento', () => {
  const steps = fileOf(plan('catalog-batch-async').files, BATCH_JOB_STEPS_TS);
  const keep = steps.slice(steps.indexOf('  async keep('));
  assert.ok(keep.length > 0);
  assert.ok(keep.indexOf('this.store.advance(') < keep.indexOf('this.store.insertResult('));
});

test('lo que el trabajo no puede llevarse de la petición se rechaza en planService, con el criterio de keel-spring', () => {
  const routed = (layers) => {
    layers.api.endpoints.importProducts.path = '/categories/{categoryId}/products/batch';
    layers['use-cases'].operations.importProducts.input.fields.categoryId = { type: 'uuid', required: true };
  };
  assert.throws(() => plan('catalog-batch-async', { mutate: routed }), /lleva parámetros que no viajarían/);
  assert.throws(() => plan('catalog-batch-async', { database: 'mariadb' }), /sentencias medidas para postgresql, mysql/);
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_JOB_SABOTAGE_SPECS)) {
    for (const [store, subject] of [['relational', 'catalog-batch-async'], ['document', 'catalog-batch-async-mongo']]) {
      const [where, from, to] = specs[store];
      const touched = plan(subject).files.filter((file) => typeof file.content === 'string' && where.test(file.path));
      const changed = touched.filter((file) => file.content.replaceAll(from, to) !== file.content);
      assert.ok(changed.length > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});
