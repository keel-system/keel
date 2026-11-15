// Los lotes SÍNCRONOS con clave (DSL 2.30, D15) en keel-go: la forma de lo que emite build sobre los diseños de
// BATCH_KEY_DESIGNS (keel-core/test/helpers/batch-designs.js) y su PARIDAD con lo que emiten keel-spring, keel-nest y
// keel-dotnet del mismo diseño (los mismos casos, la misma nota, la misma configuración, el mismo contrato, las mismas
// sentencias). Sin Go no se ejecuta nada: que la repetición no procese nada, que la reanudación siga desde el cursor, que un
// todo o nada que falla no deje trabajo, lo miden db-check y doc-check contra el motor real (scripts/lib/batch-key-probes.js:
// BK-1 a BK-5, falsados con los bk-*).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { batchNote } from '@keel-system/keel-core/gen/batch';
import { batchSyncStatements } from '@keel-system/keel-core/gen/batch-store';
import { BATCH_KEY_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { goString } from '../src/lib/go-source.js';
import { BATCH_KEY_SABOTAGE_SPECS, BATCH_KEY_SUBJECTS, batchKeyCases, batchKeyProbeFile, batchKeySabotageSubject } from '../scripts/lib/batch-key-probes.js';
import { applyDbSabotage } from './helpers/db-sabotages.js';
import { applyDocSabotage } from './helpers/doc-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { keyCasesOf as springKeyCases } from '../../keel-spring/src/lib/batch-key-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { batchKeyCases as nestKeyCases } from '../../keel-nest/scripts/lib/batch-key-probes.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { batchKeyCases as dotnetKeyCases } from '../../keel-dotnet/scripts/lib/batch-key-probes.js';

const design = (name) => BATCH_KEY_DESIGNS.find((entry) => entry.name === name);

function load(name) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  manifest.service.name = name;
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

test('los sujetos pasan la frontera de keel-go y su sonda ejecuta los MISMOS casos que las de los otros tres', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const cases = batchKeyCases(plan(name).model);
    assert.deepEqual(cases, springKeyCases(plan(name, { generator: planSpring }).model), name);
    assert.deepEqual(cases, nestKeyCases(plan(name, { generator: planNest }).model), name);
    assert.deepEqual(cases, dotnetKeyCases(plan(name, { generator: planDotnet }).model), name);
    assert.ok(batchKeyProbeFile(plan(name).model), name);
  }
  assert.deepEqual(batchKeyCases(plan('catalog-batch-keyed').model), ['BK-1', 'BK-2', 'BK-3', 'BK-4']);
  assert.deepEqual(batchKeyCases(plan('catalog-batch-atomic-keyed').model), ['BK-5']);
  assert.deepEqual([...BATCH_KEY_SUBJECTS.relational, ...BATCH_KEY_SUBJECTS.document].sort(), BATCH_KEY_DESIGNS.map((entry) => entry.name).sort());
});

test('la nota del handler es la neutral, con la del lote con clave', () => {
  const { model, files } = plan('catalog-batch-keyed');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  const handler = files.find((file) => /import_products(_command)?_handler\.go$/.test(file.path))?.content ?? '';
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) assert.ok(flat(handler).includes(line), line);
  assert.ok(flat(handler).includes('Lote con clave'));
});

test('la configuración es, línea a línea, la de los otros tres: sin chunk y con el umbral del lote muerto', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const mine = plan(name).files;
    const spring = plan(name, { generator: planSpring }).files;
    for (const profile of ['local', 'develop', 'production']) {
      assert.equal(fileOf(mine, `config/parameters/${profile}/batch.yaml`), fileOf(spring, `parameters/${profile}/batch.yaml`), `${name} ${profile}`);
    }
    for (const generator of [planNest, planDotnet]) {
      const other = plan(name, { generator }).files;
      for (const profile of ['local', 'develop', 'production', 'test']) {
        assert.equal(fileOf(mine, `config/parameters/${profile}/batch.yaml`), fileOf(other, `config/parameters/${profile}/batch.yaml`), `${name} ${profile}`);
      }
    }
    const yaml = fileOf(mine, 'config/parameters/local/batch.yaml');
    assert.doesNotMatch(yaml, /chunk-size/, name);
    assert.match(yaml, /sync-stale-ms/, name);
    assert.match(fileOf(mine, '/batch_jobs.go'), /batchPositive\(cfg, "batch\.sync-stale-ms", settings\.SyncStaleMs\)/, name);
  }
});

test('el contrato formal es el MISMO byte a byte que el de los otros tres', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const mine = fileOf(plan(name).files, 'docs/openapi.yaml');
    for (const generator of [planSpring, planNest, planDotnet]) assert.equal(mine, fileOf(plan(name, { generator }).files, 'docs/openapi.yaml'), name);
  }
});

test('el almacén relacional lleva también las sentencias del lote síncrono de keel-core TAL CUAL, en los dos motores', () => {
  for (const database of ['postgresql', 'mysql']) {
    const store = plan('catalog-batch-keyed', { database }).files.find((file) => /^internal\/infrastructure\/\w+\/batch_jobs\.go$/.test(file.path)).content;
    for (const [name, sql] of Object.entries(batchSyncStatements(database))) assert.ok(store.includes(goString(sql)), `${database}: ${name}`);
    assert.match(store, /func NewBatchJobStore\(tx \*Transactions, syncStaleMs int\) \*BatchJobStore/);
  }
  const document = fileOf(plan('catalog-batch-keyed-mongo').files, 'internal/infrastructure/mongo/batch_jobs.go');
  assert.match(document, /func \(s \*BatchJobStore\) TakeOver\(ctx context\.Context, id uuid\.UUID\) \(bool, error\)/);
  assert.match(fileOf(plan('catalog-batch-keyed').files, 'internal/domain/batch_job.go'), /TakeOver\(ctx context\.Context, id uuid\.UUID\) \(bool, error\)/);
});

test('un proyecto con solo lotes con clave no lleva el alta, el procesador ni el temporizador del trabajo; sí la purga', () => {
  for (const { name } of BATCH_KEY_DESIGNS) {
    const { files } = plan(name);
    const http = fileOf(files, 'internal/httpapi/batch_jobs.go');
    assert.doesNotMatch(http, /BatchJobRunner|submitBatchJob/, name);
    assert.match(http, /func repeatKeyedBatch\(/, name);
    assert.ok(!files.some((file) => file.path.endsWith('internal/infrastructure/timer/batch_job.go')), name);
    assert.doesNotMatch(fileOf(files, 'internal/infrastructure/timer/kinds.go'), /"batch:importProducts"/, name);
    const main = files.find((file) => /^cmd\/server\/(main|run)\.go$/.test(file.path) && file.content.includes('batchSettings'))?.content ?? '';
    assert.match(main, /batchJobStore := \w+\.NewBatchJobStore\(transactions, batchSettings\.SyncStaleMs\)/, name);
    assert.match(main, /batchJobStore\.Purge\(ctx, batchSettings\.RetentionDays\)/, name);
    assert.doesNotMatch(main, /NewBatchJobRunner/, name);
  }
});

test('el endpoint firma los BYTES del cuerpo y responde lo guardado en el trabajo', () => {
  const endpoints = (name) => plan(name).files.filter((file) => file.path.startsWith('internal/httpapi/') && file.content.includes('readBatchBody(r)')).map((file) => file.content).join('\n');
  const perItem = endpoints('catalog-batch-keyed');
  assert.match(perItem, /body, envelope, err := readBatchBody\(r\)/);
  assert.match(perItem, /runKeyedPerItem\(a, r, keyedBatchSpec\{operation: "importProducts", keySource: "client-key", ttlSeconds: 86400, reused: domain\.ErrIdempotencyKeyReused, inProgress: domain\.ErrIdempotencyKeyInProgress\}, body, cmd, items,/);
  assert.match(perItem, /return writeJSON\(w, batchMultiStatus, response\)/);
  // El 400 del sobre es el de las restricciones declaradas (invalidParams), como el del asíncrono y el de los otros tres.
  assert.match(perItem, /inBody := violations\{params: true\}/);
  assert.match(endpoints('catalog-batch-atomic-keyed'), /runKeyedAllOrNothing\(a, r, keyedBatchSpec\{[^}]+\}, "items", body, cmd, items,/);
});

test('sin capa security el dueño es el anónimo de keel-core y no se emite el actor de autoría', () => {
  for (const name of ['catalog-batch-keyed', 'catalog-batch-keyed-mongo']) {
    const { files } = plan(name);
    const store = files.find((file) => /^internal\/infrastructure\/\w+\/batch_jobs\.go$/.test(file.path)).content;
    assert.match(store, /const batchJobOwnerAnonymous = "anonymous"/, name);
    assert.doesNotMatch(store, /auditActor/, name);
    assert.ok(!files.some((file) => file.path.endsWith('/audit_actor.go')), name);
  }
});

test('lo que depende del stack se rechaza en planService, con el criterio de los otros tres', () => {
  assert.throws(() => plan('catalog-batch-keyed', { database: 'mariadb' }), /idempotency en un lote síncrono.*sentencias medidas para postgresql, mysql/s);
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_KEY_SABOTAGE_SPECS)) {
    const relational = batchKeySabotageSubject(id, false);
    assert.ok(applyDbSabotage(specs.relational, plan(relational).files, 'postgresql').changed > 0, `${id} (relacional)`);
    assert.ok(applyDbSabotage(specs.relational, plan(relational, { database: 'mysql' }).files, 'mysql').changed > 0, `${id} (mysql)`);
    if (id !== 'bk-keep-failed') assert.ok(applyDocSabotage(specs.document, plan(batchKeySabotageSubject(id, true)).files).changed > 0, `${id} (documental)`);
  }
});
