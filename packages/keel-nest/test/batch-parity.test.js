// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) en keel-nest: la forma de lo que emite build sobre los
// diseños de keel-core/test/helpers/batch-designs.js, y su PARIDAD con lo que emite keel-spring del mismo diseño (los
// mismos casos, la misma nota del handler, el mismo contrato). El bucle emitido (batch.ts) se EJECUTA aquí contra la
// referencia de keel-core (`batchResponse`), con el lector del elemento y el filtro de errores emitidos. Lo que esto NO
// dice —que cada elemento vaya en su transacción, que un fallo de la base no deshaga lo anterior, que el sobre sea un
// 400 sin tocar la base— lo miden db-check y doc-check contra el motor real (scripts/lib/batch-probes.js: BA-1 a BA-7).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, batchNote, batchResponse } from '@keel-system/keel-core/gen/batch';
import { BATCH_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { BATCH_TS } from '../src/scaffold/batch.js';
import { batchCases, BATCH_SABOTAGE_SPECS } from '../scripts/lib/batch-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { transpileTree } from './helpers/emitted.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/batch-probes.js';

const design = (name) => BATCH_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name, { generator = planService } = {}) {
  const { manifest, layers, document } = load(name);
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

const NEST_STUB = `
export const Inject = () => () => {};
export const Injectable = () => () => {};
export const Catch = () => () => {};
export class Logger { log() {} warn() {} error() {} debug() {} }
export class HttpException extends Error { getStatus() { return 500; } getResponse() { return {}; } }
export class NotFoundException extends HttpException {}
`;
const TYPEORM_STUB = `
export class QueryFailedError extends Error {}
export class EntityNotFoundError extends Error {}
export class OptimisticLockVersionMismatchError extends Error {}
export class TypeORMError extends Error {}
`;
const stubs = { '@nestjs/common': NEST_STUB, typeorm: TYPEORM_STUB };

test('los sujetos pasan la frontera de keel-nest y su sonda ejecuta los MISMOS casos que la de keel-spring', () => {
  for (const { name } of BATCH_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    assert.deepEqual(batchCases(plan(name).model), springCases(plan(name, { generator: planSpring }).model), name);
  }
});

test('la frontera: async llega en el incremento 7 y la idempotencia del lote entero no la genera nadie todavía', () => {
  const asynchronous = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.batch.execution = 'async';
  });
  assert.match(checkSupportedFeatures(asynchronous.manifest, asynchronous.layers).errors.join('\n'), /importProducts\.batch \(execution: async.*incremento 7/);
  const idempotent = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  });
  assert.match(checkSupportedFeatures(idempotent.manifest, idempotent.layers).errors.join('\n'), /importProducts\.batch con idempotency \(DSL 2\.30, D5\): keel-nest/);
});

test('el handler procesa UN elemento: el mensaje lleva el elemento y devuelve el ItemResult, con la MISMA nota que keel-spring', () => {
  const { files, model } = plan('catalog-batch');
  const message = fileOf(files, 'application/commands/import-products-command.ts');
  assert.match(message, /export class ImportProductsCommand extends ReturningCommand<ImportProductsItemResult>/);
  assert.match(message, /readonly item: ProductDraft;/);
  assert.doesNotMatch(message, /ProductDraft\[\]/, 'el mensaje no lleva la lista');
  assert.match(fileOf(files, 'application/dtos/import-products-item-result.ts'), /readonly productId: string \| null;/);
  const handler = fileOf(files, 'application/usecases/import-products-command-handler.ts');
  assert.match(handler, /implements ReturningCommandHandler<ImportProductsCommand, ImportProductsItemResult>/);
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'importProducts');
  const spring = fileOf(plan('catalog-batch', { generator: planSpring }).files, '/ImportProductsCommandHandler.java');
  // La nota sale partida por el ancho en los dos; se compara sin los saltos y sin el prefijo de comentario.
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) {
    assert.ok(flat(handler).includes(line), `falta en la nota de keel-nest: ${line}`);
    assert.ok(flat(spring).includes(line), `falta en la nota de keel-spring: ${line}`);
  }
});

test('el borde solo lee el SOBRE: la lista sin leer, con su presencia y su maxItems, y cada elemento lo lee el bucle (D3)', () => {
  const { files } = plan('catalog-batch');
  const controller = fileOf(files, 'controllers/product-v1-controller.ts');
  assert.match(controller, /const items = json\.listOf<unknown>\(\(value\) => value\)\(fields\['items'\]\);/);
  assert.match(controller, /\.check\('items', items, \[\{ rule: 'notEmpty' \}, \{ rule: 'size', min: null, max: 500 \}\]\)/);
  assert.doesNotMatch(controller, /json\.listOf\(readProductDraft\)/, 'leer la lista con el lector del elemento haría del primero mal formado un 400 del lote');
  assert.match(controller, /@HttpCode\(207\)\n  async importProducts\(/);
  assert.match(controller, /return perItem\(envelope\.items, readProductDraft, new Set<string>\(\['SKU_ALREADY_EXISTS'\]\), \(item\) => this\.mediator\.dispatch\(envelope\.message\(item\)\)\);/);
  const runner = fileOf(files, BATCH_TS);
  // Sin all-or-nothing no hay transacción abarcadora: la abre el mediator en cada elemento (D2).
  assert.doesNotMatch(runner, /TransactionContext/);
  // Los textos del contrato, de keel-core y no a mano.
  assert.ok(runner.includes(`'${BATCH_ABORTED_MESSAGE}'`));
  assert.ok(runner.includes(`'${BATCH_ITEM_MALFORMED_MESSAGE}'`));
  // El filtro gana su traducción solo con lotes: el resto de proyectos no cambia.
  assert.match(fileOf(files, 'api-exception-filter.ts'), /translate\(exception: unknown\): ErrorResponse \| null/);
  assert.doesNotMatch(fileOf(planService(loadNoBatch()).files, 'api-exception-filter.ts'), /translate\(/);
});

function loadNoBatch() {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  return { manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } };
}

test('all-or-nothing: el controlador abre la transacción del lote y responde el successStatus o el error del culpable', () => {
  const { files } = plan('catalog-batch-atomic');
  const controller = fileOf(files, 'controllers/product-v1-controller.ts');
  assert.match(controller, /@Inject\(TransactionContext\) private readonly transactions: TransactionContext/);
  assert.match(controller, /@HttpCode\(200\)\n  async importProducts\(/);
  assert.match(controller, /const outcome = await allOrNothing\('items', envelope\.items, readProductDraft, this\.transactions,/);
  assert.match(fileOf(files, BATCH_TS), /await transactions\.inTransaction\(\(\) => work\(\)\)/);
});

test('el contrato formal es el MISMO byte a byte que el de keel-spring', () => {
  for (const { name } of BATCH_DESIGNS) {
    assert.equal(fileOf(plan(name).files, 'docs/openapi.yaml'), fileOf(plan(name, { generator: planSpring }).files, 'docs/openapi.yaml'), name);
  }
});

test('los sabotajes de la sonda se aplican a lo emitido hoy', () => {
  for (const [id, specs] of Object.entries(BATCH_SABOTAGE_SPECS)) {
    for (const [store, subject] of [['relational', id === 'ba-atomic-no-tx' ? 'catalog-batch-atomic' : 'catalog-batch'], ['document', 'catalog-batch-mongo']]) {
      if (store === 'document' && id === 'ba-atomic-no-tx') continue;
      const [where, from, to] = specs[store];
      const touched = plan(subject).files.filter((file) => typeof file.content === 'string' && where.test(file.path));
      const changed = touched.filter((file) => (typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to)) !== file.content);
      assert.ok(changed.length > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});

// ─── El bucle emitido, ejecutado contra la referencia de keel-core ────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });

async function emitted(name) {
  const { files, model } = plan(name);
  const tree = transpileTree(files, { stubs });
  const batch = await tree.load(BATCH_TS);
  const { readProductDraft } = await tree.load('src/infrastructure/rest/value-readers.ts');
  const { SkuAlreadyExistsError } = await tree.load('src/domain/errors/sku-already-exists-error.ts');
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.batch);
  // El proceso de la sonda: un sku repetido es SKU_ALREADY_EXISTS y «BOOM», un fallo que nadie declara.
  const seen = new Set();
  const process = async (item) => {
    if (item.name === 'BOOM') throw new Error('sonda');
    if (seen.has(item.sku)) throw new SkuAlreadyExistsError('Ya existe un producto con ese sku');
    seen.add(item.sku);
    return { productId: item.sku };
  };
  return { batch, readProductDraft, process, operation, reset: () => seen.clear() };
}

/** Los desenlaces de la referencia para los mismos elementos y el mismo proceso. */
function outcomesOf(items) {
  const seen = new Set();
  return items.map((item) => {
    if (item == null || !/^[A-Z]{3}-[0-9]{4}$/.test(item.sku) || item.name.length > 120) return { ok: false, code: 'VALIDATION_ERROR' };
    if (item.name === 'BOOM') return { ok: false, code: null };
    if (seen.has(item.sku)) return { ok: false, code: 'SKU_ALREADY_EXISTS', message: 'Ya existe un producto con ese sku' };
    seen.add(item.sku);
    return { ok: true, result: { productId: item.sku } };
  });
}

const LOTS = [
  [draft('AAA-0001'), draft('AAA-0002')],
  [draft('BBB-0001'), draft('BBB-0001'), draft('BBB-0002')],
  [draft('CCC-0001'), draft('mal'), draft('CCC-0003', 'x'.repeat(121)), null, draft('CCC-0005')],
  [draft('DDD-0001'), draft('DDD-0002', 'BOOM'), draft('DDD-0003'), draft('DDD-0004')]
];

test('per-item: el bucle emitido responde lo que la referencia de keel-core, elemento a elemento', async () => {
  const { batch, readProductDraft, process, operation, reset } = await emitted('catalog-batch');
  for (const items of LOTS) {
    reset();
    const answer = JSON.parse(JSON.stringify(await batch.perItem(items, readProductDraft, new Set(operation.batch.itemErrors), process)));
    const reference = batchResponse(operation.batch, outcomesOf(items)).body;
    // El message de los fallos de forma es el de la guarda, y la referencia no lo conoce: se compara aparte.
    const strip = (body) => ({ ...body, items: body.items.map(({ message, ...rest }) => ({ ...rest, message: rest.error === 'VALIDATION_ERROR' ? '<guarda>' : message })) });
    assert.deepEqual(strip(answer), strip(reference), JSON.stringify(items));
    assert.equal(batch.MULTI_STATUS, 207);
  }
});

test('per-item: el message de un elemento mal formado es el de la guarda del value object, o el genérico', async () => {
  const { batch, readProductDraft, process, operation } = await emitted('catalog-batch');
  const answer = await batch.perItem([draft('mal'), null, 5, draft('DDD-0002', 'BOOM')], readProductDraft, new Set(operation.batch.itemErrors), process);
  assert.match(answer.items[0].message, /ProductDraft\.sku/);
  assert.equal(answer.items[1].message, BATCH_ITEM_MALFORMED_MESSAGE);
  assert.equal(answer.items[2].message, BATCH_ITEM_MALFORMED_MESSAGE);
  assert.equal(answer.items[3].error, 'BATCH_ABORTED');
  assert.equal(answer.items[3].message, BATCH_ABORTED_MESSAGE);
});

test('all-or-nothing: con un fallo, el error del culpable con su ruta y la transacción revertida; sin fallos, el cuerpo', async () => {
  const { batch, readProductDraft, process, operation, reset } = await emitted('catalog-batch-atomic');
  const committed = [];
  const transactions = {
    async inTransaction(work) {
      const result = await work();
      committed.push(true);
      return result;
    }
  };
  for (const items of LOTS) {
    reset();
    committed.length = 0;
    const outcome = await batch.allOrNothing('items', items, readProductDraft, transactions, process);
    const reference = batchResponse(operation.batch, outcomesOf(items));
    if (reference.status === 'error') {
      assert.equal(outcome.ok, false, JSON.stringify(items));
      assert.deepEqual(outcome.error.details, reference.details);
      assert.equal(outcome.error.code, reference.code ?? null);
      assert.equal(committed.length, 0, 'un fallo no confirma nada');
    } else {
      assert.equal(outcome.ok, true);
      assert.deepEqual(JSON.parse(JSON.stringify(outcome.body)), reference.body);
      assert.equal(committed.length, 1);
    }
  }
});
