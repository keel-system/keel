// Los lotes SÍNCRONOS con clave (DSL 2.30, D15) en keel-nest: la forma de lo que emite build sobre los diseños de
// BATCH_KEY_DESIGNS (keel-core/test/helpers/batch-designs.js) y su PARIDAD con lo que emite keel-spring del mismo diseño
// (los mismos casos, la misma configuración, el mismo contrato, las mismas sentencias). Lo que esto NO dice —que la
// repetición no procese nada, que la reanudación siga desde el cursor, que un todo o nada que falla no deje trabajo— lo
// miden db-check y doc-check contra el motor real (scripts/lib/batch-key-probes.js: BK-1 a BK-5, y los sabotajes bk-*).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { batchNote } from '@keel-system/keel-core/gen/batch';
import { batchSyncStatements } from '@keel-system/keel-core/gen/batch-store';
import { BATCH_KEY_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { BATCH_JOBS_TS, BATCH_JOB_RUNNER_TS, KEYED_BATCHES_TS, SQL_BATCH_JOB_STORE_TS, MONGO_BATCH_JOB_STORE_TS } from '../src/scaffold/batch-jobs.js';
import { TIMER_MODULE_TS, TIMER_KINDS_TS } from '../src/scaffold/timer.js';
import { batchKeyCases, BATCH_KEY_SABOTAGE_SPECS } from '../scripts/lib/batch-key-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { keyCasesOf as springKeyCases } from '../../keel-spring/src/lib/batch-key-probes.js';

const design = (name) => BATCH_KEY_DESIGNS.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { generator = planService, database = null } = {}) {
  const { manifest, layers, document } = load(name);
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: database ?? (document ? 'mongodb' : 'postgresql') } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-nest y su sonda ejecuta los MISMOS casos que la de keel-spring', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    assert.deepEqual(batchKeyCases(plan(name).model), springKeyCases(plan(name, { generator: planSpring }).model), name);
  }
  assert.deepEqual(batchKeyCases(plan('catalog-batch-keyed').model), ['BK-1', 'BK-2', 'BK-3', 'BK-4']);
  assert.deepEqual(batchKeyCases(plan('catalog-batch-atomic-keyed').model), ['BK-5']);
});

test('la nota del handler es la neutral, con la del lote con clave', () => {
  const { model, files } = plan('catalog-batch-keyed');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  const handler = fileOf(files, 'import-products-command-handler.ts');
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) assert.ok(flat(handler).includes(line), line);
  assert.ok(flat(handler).includes('Lote con clave'));
});

test('la configuración es, línea a línea, la de keel-spring: sin chunk y con el umbral del lote muerto', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const nest = plan(name).files;
    const spring = plan(name, { generator: planSpring }).files;
    for (const profile of ['local', 'develop', 'production']) {
      assert.equal(fileOf(nest, `config/parameters/${profile}/batch.yaml`), fileOf(spring, `parameters/${profile}/batch.yaml`), `${name} ${profile}`);
    }
    const yaml = fileOf(nest, 'config/parameters/local/batch.yaml');
    assert.doesNotMatch(yaml, /chunk-size/, name);
    assert.match(yaml, /sync-stale-ms/, name);
    assert.match(fileOf(nest, 'batch-settings.ts'), /syncStaleMs: positive\(configuration, 'batch\.sync-stale-ms', 60000\)/, name);
  }
});

test('el contrato formal es el MISMO byte a byte que el de keel-spring', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    assert.equal(fileOf(plan(name).files, 'docs/openapi.yaml'), fileOf(plan(name, { generator: planSpring }).files, 'docs/openapi.yaml'), name);
  }
});

test('el almacén relacional lleva también las sentencias del lote síncrono de keel-core TAL CUAL, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const store = fileOf(plan('catalog-batch-keyed', { database }).files, SQL_BATCH_JOB_STORE_TS);
    for (const [name, sql] of Object.entries(batchSyncStatements(database))) {
      assert.ok(store.includes(JSON.stringify(sql).slice(1, -1).replaceAll("'", "\\'")) || store.includes(sql), `${database}: ${name}`);
    }
  }
  assert.match(fileOf(plan('catalog-batch-keyed-mongo').files, MONGO_BATCH_JOB_STORE_TS), /async takeOver\(id: string, staleMs: number\)/);
});

test('un proyecto con solo lotes con clave no lleva el alta, el procesador ni el temporizador del trabajo; sí la purga', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const { files } = plan(name);
    const paths = files.map((file) => file.path);
    assert.ok(!paths.includes(BATCH_JOBS_TS) && !paths.includes(BATCH_JOB_RUNNER_TS), name);
    assert.ok(paths.includes(KEYED_BATCHES_TS), name);
    assert.doesNotMatch(fileOf(files, TIMER_KINDS_TS), /'batch:importProducts'/, name);
    const module = fileOf(files, TIMER_MODULE_TS);
    assert.match(module, /provide: BATCH_SETTINGS/, name);
    assert.match(module, /KeyedBatches/, name);
    assert.doesNotMatch(module, /BatchJobRunner/, name);
    assert.match(fileOf(files, 'batch-job-purge-timer.ts'), /this\.store\.purge\(this\.settings\.retentionDays\)/, name);
  }
});

test('el controlador firma el TEXTO del cuerpo y responde lo guardado en el trabajo', () => {
  const perItem = plan('catalog-batch-keyed').files;
  assert.match(fileOf(perItem, 'http-platform.ts'), /\(request as \{ rawBody\?: string \}\)\.rawBody = body as string;/);
  const controller = fileOf(perItem, 'product-v1-controller.ts');
  assert.match(controller, /@HttpCode\(207\)/);
  assert.match(controller, /const body = rawBodyOf\(request\);/);
  assert.match(controller, /this\.keyedBatches\.perItem\('importProducts', body, 'client-key', idempotencyKeyOf\(request\), 86400,/);
  const atomic = fileOf(plan('catalog-batch-atomic-keyed').files, 'product-v1-controller.ts');
  assert.match(atomic, /this\.keyedBatches\.allOrNothing\('importProducts', 'items', body,/);
  assert.doesNotMatch(atomic, /TransactionContext/, 'la transacción del lote la abre KeyedBatches');
});

test('sin capa security el dueño es el anónimo de keel-core; la clave en curso tiene su code', () => {
  const keyed = fileOf(plan('catalog-batch-keyed').files, KEYED_BATCHES_TS);
  assert.match(keyed, /const OWNER = 'anonymous';/);
  assert.doesNotMatch(keyed, /currentActor/);
  assert.match(keyed, /IDEMPOTENCY_KEY_IN_PROGRESS/);
});

test('lo que depende del stack se rechaza en planService, con el criterio de keel-spring', () => {
  assert.throws(() => plan('catalog-batch-keyed', { database: 'mariadb' }), /idempotency en un lote síncrono.*sentencias medidas para postgresql, mysql/s);
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_KEY_SABOTAGE_SPECS)) {
    const subjects = id === 'bk-keep-failed' ? [['relational', 'catalog-batch-atomic-keyed']] : [['relational', 'catalog-batch-keyed'], ['document', 'catalog-batch-keyed-mongo']];
    for (const [store, subject] of subjects) {
      const [where, from, to] = specs[store];
      const touched = plan(subject).files.filter((file) => typeof file.content === 'string' && where.test(file.path));
      const changed = touched.filter((file) => file.content.replaceAll(from, to) !== file.content);
      assert.ok(changed.length > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});
