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
import { WIRE_BATCH_CASES, WIRE_RULES, WIRE_SHAPES } from '../src/lib/gen/wire.js';
import {
  BATCH_ABORTED_MESSAGE,
  BATCH_CASES,
  BATCH_ITEM_STATUSES,
  BATCH_SABOTAGES,
  batchContractClause,
  batchFrontierErrors,
  batchModelOperations,
  batchNote,
  batchOperations,
  batchPendingErrors,
  batchResponse,
  isItemFailure,
  usesBatch
} from '../src/lib/gen/batch.js';
import { BATCH_DESIGNS } from './helpers/batch-designs.js';
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

test('la idempotencia del lote entero (D5) se rechaza en los cuatro con el mismo mensaje, y solo en el lote que la declara', () => {
  const { layers } = derived('catalog-batch');
  assert.deepEqual(batchFrontierErrors(layers, 'keel-spring'), []);
  layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  const [message] = batchFrontierErrors(layers, 'keel-go');
  assert.match(message, /^use-cases: importProducts\.batch con idempotency \(DSL 2\.30, D5\): keel-go todavía no genera/);
  assert.equal(batchFrontierErrors(layers, 'keel-go').length, 1, 'createProduct declara idempotency y no es un lote');
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
