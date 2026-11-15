// Los lotes con resultado por elemento (DSL 2.30, src/lib/gen/batch.js): qué operaciones son lotes, el modelo que leen
// los generadores, la referencia ejecutable de la respuesta contra los casos del cable, la nota del handler y la frontera
// común de los generadores. Los sujetos son los de test/helpers/batch-designs.js, los mismos que medirán los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS } from '../src/lib/gen/infra-catalog.js';
import { FRAMEWORK_ERRORS } from '../src/lib/framework-errors.js';
import { WIRE_BATCH_CASES, WIRE_BATCH_JOB_CASES, WIRE_RULES, WIRE_SHAPES } from '../src/lib/gen/wire.js';
import { BATCH_ITEM_RESULT, BATCH_JOB, BATCH_JOB_STATUSES, BATCH_SYNC_STALE, batchSyncStatements } from '../src/lib/gen/batch-store.js';
import { GENERATOR_TABLES, schemaStepSql } from '../src/lib/gen/schema-steps.js';
import { batchTimers, generatorPurges, usesTimer } from '../src/lib/gen/timer-plan.js';
import { openapiDocument } from '../src/lib/gen/openapi.js';
import {
  BATCH_ABORTED_MESSAGE,
  BATCH_CASES,
  BATCH_ITEM_STATUSES,
  BATCH_JOB_CASES,
  BATCH_JOB_SABOTAGES,
  BATCH_KEY_CASES,
  BATCH_KEY_SABOTAGES,
  batchJobStoreOperations,
  batchStoredBody,
  batchSyncRepeat,
  keyedSyncBatchOperations,
  BATCH_SABOTAGES,
  batchContractClause,
  batchItem,
  batchJobPaths,
  batchJobRepeat,
  batchJobView,
  batchRequestSignature,
  newBatchJob,
  runBatchChunk,
  batchFrontierErrors,
  batchModelOperations,
  batchNote,
  batchOperations,
  batchPendingErrors,
  batchResponse,
  isItemFailure,
  usesBatch
} from '../src/lib/gen/batch.js';
import { registryOperations } from '../src/lib/gen/request-idempotency.js';
import { idempotencyOutcomeCodes } from '../src/lib/gen/declared-errors.js';
import { BATCH_DESIGNS, BATCH_JOB_DESIGNS, BATCH_KEY_DESIGNS } from './helpers/batch-designs.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function designOf(fixture, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  if (mutate) mutate(layers);
  return { manifest, layers, model: buildModel({ manifest, layers, stack: STACK_DEFAULTS, projection: PROBE }) };
}
const derived = (name, then = null) => {
  const design = BATCH_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, (layers) => {
    design.mutate(layers);
    then?.(layers);
  });
};
const operationOf = (model, name) => model.services.flatMap((group) => group.operations).find((operation) => operation.name === name);
const BATCH_IDS = /BATCH/;
const idsOf = ({ findings, obligations }) => [...findings.map((finding) => finding.id), ...obligations.map((entry) => entry.id)];

test('los sujetos validan sin errores ni hallazgos de los lotes', () => {
  for (const design of BATCH_DESIGNS) {
    const { manifest, layers } = derived(design.name);
    const result = checkCrossRefs({ layers, manifest });
    assert.deepEqual(result.errors, [], design.name);
    assert.deepEqual(idsOf(result).filter((id) => BATCH_IDS.test(id)), [], design.name);
  }
});

test('el modelo: el lote recorre su campo, con su elemento, su confirmación y lo que devuelve cada uno', () => {
  const { layers, model } = derived('catalog-batch');
  assert.deepEqual(batchOperations(layers).map((entry) => entry.operation), ['importProducts']);
  assert.equal(usesBatch(model), true);
  const operation = operationOf(model, 'importProducts');
  assert.deepEqual(
    { ...operation.batch, resultFields: operation.batch.resultFields.map((field) => field.name) },
    {
      over: 'items',
      itemType: 'ProductDraft',
      atomicity: 'per-item',
      itemErrors: ['SKU_ALREADY_EXISTS'],
      execution: 'sync',
      maxItems: 500,
      idempotency: null,
      resultFields: ['productId']
    }
  );
  // El handler procesa UN elemento: devuelve el <Op>ItemResult de batch.output, y su mensaje es un ReturningCommand. La
  // respuesta HTTP del lote no es un DTO del diseño: la pone cada generador.
  assert.equal(operation.responseDto.name, 'ImportProductsItemResult');
  assert.deepEqual(operation.responseDto.fields.map((field) => field.name), ['productId']);
  assert.equal(operation.messageKind, 'returningCommand');
  // Sin batch.output, ni DTO ni retorno.
  const bare = derived('catalog-batch', (layers) => {
    delete layers['use-cases'].operations.importProducts.batch.output;
  });
  assert.equal(operationOf(bare.model, 'importProducts').responseDto, null);
  assert.equal(operationOf(bare.model, 'importProducts').messageKind, 'command');
  assert.deepEqual(batchModelOperations(model).map((entry) => entry.operation), ['importProducts']);
  // Las demás operaciones no son lotes, y sin lote declarado, nada.
  assert.equal(operationOf(model, 'createProduct').batch, null);
  assert.equal(usesBatch(designOf('product-catalog').model), false);
  // all-or-nothing no tiene itemErrors.
  assert.deepEqual(operationOf(derived('catalog-batch-atomic').model, 'importProducts').batch.itemErrors, []);
});

test('la respuesta: cada caso del cable sale de la referencia ejecutable', () => {
  assert.ok(WIRE_BATCH_CASES.length >= 5);
  const ids = WIRE_BATCH_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of WIRE_BATCH_CASES) {
    assert.ok(WIRE_RULES[entry.rule], `${entry.id}: regla '${entry.rule}' desconocida`);
    assert.deepEqual(batchResponse(entry.plan, entry.outcomes), entry.response, entry.id);
  }
  // Las tres reglas de los lotes tienen su caso.
  for (const rule of ['batch-multi-status', 'batch-item-stable', 'batch-stop']) {
    assert.ok(WIRE_BATCH_CASES.some((entry) => entry.rule === rule), rule);
  }
});

test('la forma: las claves de cada elemento y del resumen, en el orden del cable, y los estados del contrato', () => {
  const { body } = batchResponse({ over: 'items', atomicity: 'per-item', itemErrors: [] }, [
    { ok: true, result: { productId: 'a' } },
    { ok: false, code: 'X', message: 'detiene' },
    { ok: true, result: null }
  ]);
  assert.deepEqual(Object.keys(body), WIRE_SHAPES.batchResponse);
  assert.deepEqual(Object.keys(body.summary), WIRE_SHAPES.batchSummary);
  for (const item of body.items) {
    assert.deepEqual(Object.keys(item), WIRE_SHAPES.batchItem);
    assert.ok(BATCH_ITEM_STATUSES.includes(item.status));
  }
  // El resumen cuadra con los elementos.
  assert.equal(body.summary.total, body.summary.succeeded + body.summary.failed + body.summary.notAttempted);
});

test('qué falla solo su elemento: itemErrors y VALIDATION_ERROR; nada más', () => {
  const plan = { over: 'items', atomicity: 'per-item', itemErrors: ['SKU_ALREADY_EXISTS'] };
  assert.equal(isItemFailure(plan, 'SKU_ALREADY_EXISTS'), true);
  assert.equal(isItemFailure(plan, FRAMEWORK_ERRORS.validation.code), true);
  assert.equal(isItemFailure(plan, FRAMEWORK_ERRORS.concurrency.code), false);
  assert.equal(isItemFailure(plan, null), false);
  // El elemento que detiene el lote sin code lleva BATCH_ABORTED, del catálogo del framework.
  const { body } = batchResponse(plan, [{ ok: false, code: null, message: 'socket' }]);
  assert.equal(body.items[0].error, FRAMEWORK_ERRORS.batchAborted.code);
  assert.equal(body.items[0].message, BATCH_ABORTED_MESSAGE);
  // per-item responde 207 también con todo en verde (D1).
  assert.equal(batchResponse(plan, [{ ok: true }]).status, 207);
});

test('la nota del handler: un elemento, y qué hacer con cada error', () => {
  const perItem = operationOf(derived('catalog-batch').model, 'importProducts').batch;
  const note = batchNote(perItem).join('\n');
  assert.match(note, /UN elemento de 'items' \(ProductDraft\)/);
  assert.match(note, /Una transacción por elemento/);
  assert.match(note, /SKU_ALREADY_EXISTS y VALIDATION_ERROR/);
  assert.match(note, /productId/);
  const atomic = batchNote(operationOf(derived('catalog-batch-atomic').model, 'importProducts').batch).join('\n');
  assert.match(atomic, /una transacción: el primer error la revierte entera/);
  assert.doesNotMatch(atomic, /SKU_ALREADY_EXISTS/);
});

test('la frontera de los generadores: el mismo mensaje en los cuatro, por modo', () => {
  const { layers } = derived('catalog-batch');
  const [message] = batchPendingErrors(layers, 'keel-nest', { syncIncrement: 2, asyncIncrement: 7 });
  assert.match(message, /importProducts\.batch \(execution: sync, DSL 2\.30\): keel-nest todavía no lo genera — llega en el incremento 2/);
  // Con su modo ya generado no rechaza nada, y el otro modo sigue rechazado.
  assert.deepEqual(batchPendingErrors(layers, 'keel-nest', { syncIncrement: null, asyncIncrement: 7 }), []);
  layers['use-cases'].operations.importProducts.batch.execution = 'async';
  assert.match(batchPendingErrors(layers, 'keel-nest', { syncIncrement: null, asyncIncrement: 7 })[0], /incremento 7/);
  // Sin lotes, nada.
  assert.deepEqual(batchPendingErrors(designOf('product-catalog').layers, 'keel-go', { syncIncrement: 4, asyncIncrement: 9 }), []);
});

test('la idempotencia del lote síncrono (D15) se rechaza con el mismo mensaje hasta que el generador la genera, y solo en el lote que la declara', () => {
  const { layers } = derived('catalog-batch');
  assert.deepEqual(batchFrontierErrors(layers, 'keel-spring'), []);
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  const [message] = batchFrontierErrors(layers, 'keel-go');
  assert.match(message, /^use-cases: importProducts\.batch con idempotency \(DSL 2\.30, D15\): keel-go todavía no genera/);
  assert.equal(batchFrontierErrors(layers, 'keel-go').length, 1, 'createProduct declara idempotency y no es un lote');
  assert.deepEqual(batchFrontierErrors(layers, 'keel-go', { syncIdempotency: true }), []);
  // payload-field sigue fuera aunque el generador genere la clave del lote síncrono.
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'payload-field', keyField: 'items' };
  assert.match(batchFrontierErrors(layers, 'keel-go', { syncIdempotency: true }).join('\n'), /payload-field y partitionBy/);
});

test('la cláusula del contrato: qué falla solo su elemento y qué detiene el lote, o que no queda nada confirmado', () => {
  assert.equal(batchContractClause(null), null);
  const perItem = operationOf(derived('catalog-batch').model, 'importProducts').batch;
  assert.match(batchContractClause(perItem), /siempre 207.*Fallan solo su elemento SKU_ALREADY_EXISTS, VALIDATION_ERROR\..*BATCH_ABORTED si no tiene.*notAttempted/);
  const atomic = operationOf(derived('catalog-batch-atomic').model, 'importProducts').batch;
  assert.match(batchContractClause(atomic), /^Lote todo o nada .*no queda nada confirmado .*details \(items\[0\]\)/);
});

test('los casos y sus sabotajes: ids únicos, y cada sabotaje cae en casos que existen', () => {
  const ids = BATCH_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [sabotage, cases] of Object.entries(BATCH_SABOTAGES)) {
    assert.match(sabotage, /^ba-/);
    for (const id of cases) assert.ok(ids.includes(id), `${sabotage}: ${id}`);
  }
});

// ─── La fase B: lotes asíncronos (D8-D14) ────────────────────────────────────

const derivedJob = (name, then = null) => {
  const design = BATCH_JOB_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, (layers) => {
    design.mutate(layers);
    then?.(layers);
  });
};

test('los sujetos asíncronos validan sin errores ni hallazgos de los lotes', () => {
  for (const design of BATCH_JOB_DESIGNS) {
    const { manifest, layers } = derivedJob(design.name);
    const result = checkCrossRefs({ layers, manifest });
    assert.deepEqual(result.errors, [], design.name);
    assert.deepEqual(idsOf(result).filter((id) => BATCH_IDS.test(id)), [], design.name);
  }
});

test('D13: la clave de un lote asíncrono la lleva su lote, no la operación (ningún generador monta idempotency_record)', () => {
  const { model } = derivedJob('catalog-batch-async');
  const operation = operationOf(model, 'importProducts');
  assert.equal(operation.idempotency, null);
  assert.deepEqual(operation.batch.idempotency, { keySource: 'client-key', ttlSeconds: 86400 });
  assert.equal(registryOperations(model).some((candidate) => candidate.name === 'importProducts'), false);
  // Sus desenlaces siguen en el contrato: IDEMPOTENCY_KEY_REUSED con el code de la operación.
  assert.deepEqual(
    idempotencyOutcomeCodes(model, FRAMEWORK_ERRORS.idempotencyReuse).filter((row) => row.operation === 'importProducts'),
    [{ operation: 'importProducts', code: 'IDEMPOTENCY_KEY_REUSED', declared: false }]
  );
});

test('D14: un lote asíncrono todo o nada es incoherente; por elemento, no', () => {
  const { manifest, layers } = derivedJob('catalog-batch-async', (l) => {
    l['use-cases'].operations.importProducts.batch.atomicity = 'all-or-nothing';
    delete l['use-cases'].operations.importProducts.batch.itemErrors;
  });
  assert.deepEqual(idsOf(checkCrossRefs({ layers, manifest })).filter((id) => BATCH_IDS.test(id)), ['CHK-USECASES-BATCH-ASYNC-ATOMIC']);
});

test('el trabajo: un temporizador de una vez por trabajo, la purga de lo terminado y las dos tablas del generador', () => {
  const { model } = derivedJob('catalog-batch-async');
  assert.ok(usesTimer(model));
  assert.deepEqual(batchTimers(model), [{ operation: 'importProducts', kind: 'batch:importProducts' }]);
  assert.ok(generatorPurges(model).some((purge) => purge.table === BATCH_JOB.table && purge.kind === 'purge:batch_job'));
  // Un lote síncrono no tiene trabajo: ni temporizador ni purga.
  const sync = derived('catalog-batch').model;
  assert.deepEqual(batchTimers(sync), []);
  assert.ok(!generatorPurges(sync).some((purge) => purge.table === BATCH_JOB.table));
  // Las tablas, en orden de creación (la referenciada antes), y en el paso de esquema de una base desplegada.
  assert.ok(GENERATOR_TABLES.indexOf(BATCH_JOB) < GENERATOR_TABLES.indexOf(BATCH_ITEM_RESULT));
  const sql = schemaStepSql('postgresql', [BATCH_JOB, BATCH_ITEM_RESULT]);
  assert.match(sql, /CONSTRAINT uq_batch_job_key UNIQUE \(operation, owner, idempotency_key\)/);
  assert.match(sql, /CONSTRAINT fk_batch_item_result_job FOREIGN KEY \(job_id\) REFERENCES batch_job \(id\) ON DELETE CASCADE/);
  // Ninguna columna se llama como una palabra reservada de MySQL.
  for (const table of [BATCH_JOB, BATCH_ITEM_RESULT]) {
    for (const column of table.columns) assert.ok(!['cursor', 'index', 'error', 'key', 'change'].includes(column.name), column.name);
  }
});

test('el procesador por chunks: reanuda desde el cursor, sin repetir ni perder ningún elemento (D9, BJ-2 a BJ-4)', () => {
  const plan = { itemErrors: ['SKU_ALREADY_EXISTS'] };
  const calls = [];
  const outcomeOf = (index) => {
    calls.push(index);
    return index === 3 ? { ok: false, code: 'SKU_ALREADY_EXISTS', message: 'Ya existe' } : { ok: true, result: { n: index } };
  };
  let step = runBatchChunk(newBatchJob(7), { plan, outcomeOf, chunkSize: 3 });
  assert.equal(step.state.nextIndex, 3);
  assert.ok(step.more);
  // La réplica cae tras confirmar un elemento del segundo chunk: el siguiente disparo sigue desde el cursor.
  step = runBatchChunk(step.state, { plan, outcomeOf, chunkSize: 3, crashAfter: 1 });
  assert.ok(step.crashed);
  assert.equal(step.state.nextIndex, 4);
  while (step.more) step = runBatchChunk(step.state, { plan, outcomeOf, chunkSize: 3 });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6], 'ningún elemento dos veces');
  assert.equal(step.state.status, 'completed');
  assert.deepEqual(step.state.results.map((item) => item.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(batchJobView({ ...step.state, id: 'j', createdAt: 't' }).summary, { total: 7, succeeded: 6, failed: 1, notAttempted: 0 });
});

test('el procesador: lo que no falla solo su elemento detiene el trabajo, y lo que queda cuenta como notAttempted (BJ-3)', () => {
  const step = runBatchChunk(newBatchJob(10), { plan: { itemErrors: [] }, outcomeOf: (index) => (index === 4 ? { ok: false, code: null } : { ok: true }), chunkSize: 100 });
  assert.equal(step.state.status, 'aborted');
  assert.ok(!step.more);
  assert.deepEqual(step.state.results.at(-1), batchItem(4, 'failed', { error: FRAMEWORK_ERRORS.batchAborted.code, message: BATCH_ABORTED_MESSAGE }));
  assert.deepEqual(batchJobView({ ...step.state, id: 'j', createdAt: 't' }).summary, { total: 10, succeeded: 4, failed: 1, notAttempted: 5 });
});

test('el trabajo en el cable: cada caso sale de la referencia, con la forma de WIRE_SHAPES.batchJob', () => {
  for (const entry of WIRE_BATCH_JOB_CASES) {
    const job = batchJobView(entry.row);
    assert.deepEqual(job, entry.job, entry.id);
    assert.deepEqual(Object.keys(job), WIRE_SHAPES.batchJob, entry.id);
    assert.ok(WIRE_RULES[entry.rule], entry.id);
  }
});

test('la repetición (D13): la misma firma es el mismo trabajo, otra es la clave reutilizada, y pasada la ventana es uno nuevo', () => {
  const body = '{"items":[{"sku":"ABC-0001"}]}';
  const signature = batchRequestSignature(body);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(batchRequestSignature(body), signature);
  assert.notEqual(batchRequestSignature('{"items": [{"sku":"ABC-0001"}]}'), signature, 'otros bytes, otra petición');
  assert.equal(batchJobRepeat(null, signature, 100), 'create');
  assert.equal(batchJobRepeat({ signature, keyExpiresAt: null }, signature, 100), 'same');
  assert.equal(batchJobRepeat({ signature: 'otra', keyExpiresAt: null }, signature, 100), 'reused');
  assert.equal(batchJobRepeat({ signature, keyExpiresAt: 99 }, signature, 100), 'create');
  assert.equal(batchJobRepeat({ signature, keyExpiresAt: 101 }, signature, 100), 'same');
});

test('la frontera de la fase B: la clave de un lote solo con client-key o payload-hash, y sin la identidad en el input', () => {
  const { layers } = derivedJob('catalog-batch-async');
  assert.deepEqual(batchFrontierErrors(layers, 'keel-go'), [], 'client-key en un lote asíncrono es D13');
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', partitionBy: ['items'] };
  assert.match(batchFrontierErrors(layers, 'keel-go')[0], /importProducts\.idempotency en un lote \(DSL 2\.30, D13\): keel-go genera la clave de un lote con keySource client-key o payload-hash/);
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'payload-hash' };
  layers.security.authentication.callerIdentity = { field: 'requestedBy', from: { source: 'claim', name: 'sub' } };
  layers['use-cases'].operations.importProducts.input.fields.requestedBy = { type: 'string', required: true };
  assert.match(batchFrontierErrors(layers, 'keel-go')[0], /importProducts\.batch \(execution: async\) con la identidad del llamante en el input \(requestedBy/);
});

test('el contrato asíncrono: 202 con Location, el 409 de la clave reutilizada sin el de en curso, y las dos rutas con su 404', () => {
  const { model } = derivedJob('catalog-batch-async');
  const document = openapiDocument(model);
  const post = document.paths['/api/v1/products/batch'].post;
  assert.deepEqual(Object.keys(post.responses), ['202', '400', '401', '403', '409']);
  assert.equal(post.responses['202'].content['application/json'].schema.$ref, '#/components/schemas/BatchJob');
  assert.ok(post.responses['202'].headers.Location);
  assert.match(post.responses['409'].description, /IDEMPOTENCY_KEY_REUSED/);
  assert.doesNotMatch(post.responses['409'].description, /IDEMPOTENCY_KEY_IN_PROGRESS/);
  const paths = batchJobPaths('/api/v1/products/batch');
  for (const [path, operationId] of [[paths.status, 'importProductsJob'], [paths.results, 'importProductsJobResults']]) {
    const get = document.paths[path].get;
    assert.equal(get.operationId, operationId);
    assert.match(get.responses['404'].description, /BATCH_JOB_NOT_FOUND/);
    assert.deepEqual(get.security, post.security, `${operationId}: la regla de la operación (D11)`);
  }
  assert.deepEqual(document.components.schemas.BatchJob.required, WIRE_SHAPES.batchJob);
  assert.deepEqual(document.components.schemas.BatchJob.properties.status.enum, Object.values(BATCH_JOB_STATUSES));
});

test('los casos de la fase B y sus sabotajes: ids únicos, y cada sabotaje cae en casos que existen', () => {
  const ids = BATCH_JOB_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [sabotage, cases] of Object.entries(BATCH_JOB_SABOTAGES)) {
    assert.match(sabotage, /^bj-/);
    for (const id of cases) assert.ok(ids.includes(id), `${sabotage}: ${id}`);
  }
});

// ─── La idempotencia del lote síncrono (D15, inc. 10b) ───────────────────────

const derivedKeyed = (name, then = null) => {
  const design = BATCH_KEY_DESIGNS.find((entry) => entry.name === name);
  return designOf(design.from, (layers) => {
    design.mutate(layers);
    then?.(layers);
  });
};

test('los sujetos con clave validan sin errores ni hallazgos de los lotes', () => {
  for (const design of BATCH_KEY_DESIGNS) {
    const { manifest, layers } = derivedKeyed(design.name);
    const result = checkCrossRefs({ layers, manifest });
    assert.deepEqual(result.errors, [], design.name);
    assert.deepEqual(idsOf(result).filter((id) => BATCH_IDS.test(id)), [], design.name);
  }
});

test('D15: la clave del lote síncrono la lleva su lote y la guarda el trabajo, con su purga y sin temporizador', () => {
  const { model } = derivedKeyed('catalog-batch-keyed');
  const operation = operationOf(model, 'importProducts');
  assert.equal(operation.idempotency, null);
  assert.deepEqual(operation.batch.idempotency, { keySource: 'client-key', ttlSeconds: 86400 });
  assert.equal(registryOperations(model).some((candidate) => candidate.name === 'importProducts'), false);
  assert.deepEqual(keyedSyncBatchOperations(model).map(({ operation: name }) => name), ['importProducts']);
  assert.deepEqual(batchJobStoreOperations(model).map(({ operation: name }) => name), ['importProducts']);
  assert.deepEqual(batchTimers(model), [], 'un lote síncrono no se procesa por el cronómetro');
  assert.ok(generatorPurges(model).some((purge) => purge.table === BATCH_JOB.table), 'pero sus trabajos se purgan');
  // La purga va por el cronómetro del motor que el generador elige (el modelo de estas pruebas no lleva stack).
  assert.equal(usesTimer({ ...model, stack: { database: 'postgresql' } }), true);
  // Sin clave, un lote síncrono no usa el almacén.
  assert.deepEqual(batchJobStoreOperations(derived('catalog-batch').model), []);
});

test('D15, la repetición: create, reused, replay, in-progress y resume, con la hora del motor', () => {
  const now = 1_000_000;
  const staleMs = BATCH_SYNC_STALE.default;
  const row = (over) => ({ signature: 'f1', keyExpiresAt: null, finishedAt: null, updatedAt: now - 1000, ...over });
  assert.equal(batchSyncRepeat(null, 'f1', now, staleMs), 'create');
  assert.equal(batchSyncRepeat(row({ keyExpiresAt: now - 1 }), 'f1', now, staleMs), 'create');
  assert.equal(batchSyncRepeat(row(), 'f2', now, staleMs), 'reused');
  assert.equal(batchSyncRepeat(row({ finishedAt: now - 5 }), 'f1', now, staleMs), 'replay');
  assert.equal(batchSyncRepeat(row(), 'f1', now, staleMs), 'in-progress');
  assert.equal(batchSyncRepeat(row({ updatedAt: now - staleMs }), 'f1', now, staleMs), 'resume');
});

test('D15, el 207 rehecho desde lo guardado es el mismo que da batchResponse, también si se detuvo o se reanudó', () => {
  const plan = operationOf(derived('catalog-batch').model, 'importProducts').batch;
  const outcomes = [
    { ok: true, result: { productId: 'p-0' } },
    { ok: false, code: 'SKU_ALREADY_EXISTS', message: 'repetido' },
    { ok: true, result: { productId: 'p-2' } },
    { ok: false, code: null },
    { ok: true, result: { productId: 'p-4' } }
  ];
  const expected = batchResponse(plan, outcomes).body;
  // El lote como lo procesa el síncrono con clave: un chunk del tamaño del lote, cortado a mitad y reanudado desde el cursor.
  let job = newBatchJob(outcomes.length);
  job = runBatchChunk(job, { plan, outcomeOf: (index) => outcomes[index], chunkSize: outcomes.length, crashAfter: 2 }).state;
  job = runBatchChunk(job, { plan, outcomeOf: (index) => outcomes[index], chunkSize: outcomes.length }).state;
  assert.equal(job.status, 'aborted');
  assert.deepEqual(batchStoredBody(job, [...job.results].reverse()), expected);
  // Sin fallos que detengan: completed y sin notAttempted.
  const clean = outcomes.slice(0, 3);
  const done = runBatchChunk(newBatchJob(3), { plan, outcomeOf: (index) => clean[index], chunkSize: 3 }).state;
  assert.deepEqual(batchStoredBody(done, done.results), batchResponse(plan, clean).body);
});

test('D15, el contrato: la cláusula lo cuenta, y el lote con clave responde el 409 en curso y el de la clave reutilizada', () => {
  for (const name of ['catalog-batch-keyed', 'catalog-batch-atomic-keyed']) {
    const { model } = derivedKeyed(name);
    const operation = operationOf(model, 'importProducts');
    assert.match(batchContractClause(operation.batch), /Con idempotency, repetir la clave/, name);
    assert.match(batchContractClause(operation.batch), /Mientras el primero sigue en marcha, responde 409/, name);
    const document = openapiDocument(model);
    const op = Object.values(document.paths).flatMap((methods) => Object.values(methods)).find((candidate) => candidate.operationId === 'importProducts');
    const errors = Object.entries(op.responses).filter(([status]) => Number(status) >= 400).map(([, response]) => response.description).join('\n');
    assert.match(errors, /IDEMPOTENCY_KEY_IN_PROGRESS/, name);
    assert.match(errors, /IDEMPOTENCY_KEY_REUSED/, name);
  }
  assert.doesNotMatch(batchContractClause(operationOf(derived('catalog-batch').model, 'importProducts').batch), /idempotency/);
});

test('D15, las sentencias: la toma de un lote muerto y el descarte del todo o nada, en los dos motores', () => {
  for (const engine of ['postgresql', 'mysql']) {
    const statements = batchSyncStatements(engine);
    assert.match(statements.takeOver, /finished_at IS NULL AND updated_at <= /, engine);
    assert.equal(statements.discardJob, 'DELETE FROM batch_job WHERE id = :id AND finished_at IS NULL', engine);
  }
});

test('los casos de la clave y sus sabotajes: ids únicos, y cada sabotaje cae en casos que existen', () => {
  const ids = BATCH_KEY_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [sabotage, cases] of Object.entries(BATCH_KEY_SABOTAGES)) {
    assert.match(sabotage, /^bk-/);
    for (const id of cases) assert.ok(ids.includes(id), `${sabotage}: ${id}`);
  }
});

test('D15, la nota: el handler sabe que la repetición no le llega', () => {
  const keyed = operationOf(derivedKeyed('catalog-batch-keyed').model, 'importProducts').batch;
  assert.ok(batchNote(keyed).some((line) => /^Lote con clave: la repetición la resuelve el generador/.test(line)));
  const plain = operationOf(derived('catalog-batch').model, 'importProducts').batch;
  assert.ok(!batchNote(plain).some((line) => /^Lote con clave/.test(line)));
});
