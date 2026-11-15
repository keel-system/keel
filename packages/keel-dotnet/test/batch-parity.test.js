// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) en keel-dotnet: la forma de lo que emite build sobre los
// diseños de keel-core/test/helpers/batch-designs.js, y su PARIDAD con lo que emiten keel-spring y keel-nest del mismo
// diseño (los mismos casos, la misma nota del handler, el mismo contrato). Sin SDK no se ejecuta el C#: lo que el bucle
// RESPONDE —un resultado por elemento, la transacción por elemento, el 400 del sobre sin tocar la base, el error del
// culpable en un lote todo o nada— lo miden db-check y doc-check contra el motor real (scripts/lib/batch-probes.js: BA-1 a
// BA-7, falsados con sus cinco sabotajes).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, batchNote } from '@keel-system/keel-core/gen/batch';
import { BATCH_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { BATCH_SABOTAGE_SPECS, BATCH_SUBJECTS, batchCases, batchProbePatch } from '../scripts/lib/batch-probes.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/batch-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { batchCases as nestCases } from '../../keel-nest/scripts/lib/batch-probes.js';

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

test('los sujetos pasan la frontera de keel-dotnet y su sonda ejecuta los MISMOS casos que las de keel-spring y keel-nest', () => {
  for (const { name } of BATCH_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const cases = batchCases(plan(name).model);
    assert.deepEqual(cases, springCases(plan(name, { generator: planSpring }).model), name);
    assert.deepEqual(cases, nestCases(plan(name, { generator: planNest }).model), name);
  }
  assert.deepEqual([...BATCH_SUBJECTS.relational, ...BATCH_SUBJECTS.document].sort(), BATCH_DESIGNS.map((entry) => entry.name).sort());
});

test('la frontera: async y la clave del lote síncrono pasan (batch-jobs.test.js, batch-keys.test.js); payload-field no', () => {
  const asynchronous = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.batch.execution = 'async';
  });
  assert.doesNotMatch(checkSupportedFeatures(asynchronous.manifest, asynchronous.layers).errors.join('\n'), /importProducts\.batch \(execution: async.*incremento/);
  const idempotent = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  });
  assert.deepEqual(checkSupportedFeatures(idempotent.manifest, idempotent.layers).errors, []);
  const field = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'payload-field', keyField: 'items' };
  });
  assert.match(checkSupportedFeatures(field.manifest, field.layers).errors.join('\n'), /importProducts\.idempotency en un lote \(DSL 2\.30, D13\)/);
});

test('el handler procesa UN elemento: el mensaje lleva el elemento y devuelve el ItemResult, con la MISMA nota que keel-spring y keel-nest', () => {
  const { files, model } = plan('catalog-batch');
  const message = fileOf(files, 'Commands/ImportProductsCommand.cs');
  assert.match(message, /public sealed class ImportProductsCommand : IReturningCommand<ImportProductsItemResult>/);
  assert.match(message, /public required ProductDraft Item \{ get; init; \}/);
  assert.doesNotMatch(message, /IReadOnlyList<ProductDraft>/, 'el mensaje no lleva la lista');
  assert.match(fileOf(files, 'Dtos/ImportProductsItemResult.cs'), /public required Guid\? ProductId \{ get; init; \}/);
  const handler = fileOf(files, 'UseCases/ImportProductsCommandHandler.cs');
  assert.match(handler, /IReturningCommandHandler<ImportProductsCommand, ImportProductsItemResult>/);
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'importProducts');
  const spring = fileOf(plan('catalog-batch', { generator: planSpring }).files, '/ImportProductsCommandHandler.java');
  const nest = fileOf(plan('catalog-batch', { generator: planNest }).files, 'application/usecases/import-products-command-handler.ts');
  // La nota sale partida por el ancho en los tres; se compara sin los saltos y sin el prefijo de comentario.
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) {
    assert.ok(flat(handler).includes(line), `falta en la nota de keel-dotnet: ${line}`);
    assert.ok(flat(spring).includes(line), `falta en la nota de keel-spring: ${line}`);
    assert.ok(flat(nest).includes(line), `falta en la nota de keel-nest: ${line}`);
  }
});

test('el borde solo lee el SOBRE: la lista sin leer, con su presencia y su maxItems, y cada elemento lo lee el bucle (D3)', () => {
  const { files } = plan('catalog-batch');
  const endpoints = fileOf(files, 'Endpoints/ProductV1Endpoints.cs');
  assert.match(endpoints, /var items = JsonBodyReader\.List\(requestFields, "items", element => element\);/);
  assert.match(endpoints, /bodyChecks\.Check\("items", items, InputRule\.NotEmpty, InputRule\.Size\(null, 500\)\);/);
  assert.doesNotMatch(endpoints, /JsonBodyReader\.List\(requestFields, "items", element => JsonBodyReader\.Present\(ValueReaders\.ReadProductDraft/, 'leer la lista con el lector del elemento haría del primero mal formado un 400 del lote');
  assert.match(endpoints, /private static async Task<BatchEnvelope<ProductDraft, ImportProductsCommand>> ReadImportProducts\(HttpRequest httpRequest\)/);
  assert.match(endpoints, /var response = await BatchRunner\.PerItem<ProductDraft>\(\s+envelope\.Items,\s+ValueReaders\.ReadProductDraft,\s+\["SKU_ALREADY_EXISTS"\],/);
  assert.match(endpoints, /error => ApiErrorMiddleware\.Translate\(http, error\)/);
  assert.match(endpoints, /await HttpReply\.Json\(http, BatchRunner\.MultiStatus, response\);/);
  const runner = fileOf(files, 'Rest/Batch.cs');
  // Sin all-or-nothing no hay transacción abarcadora: la abre el mediator en cada elemento (D2).
  assert.doesNotMatch(runner, /IUseCaseTransactions/);
  assert.match(runner, /public const int MultiStatus = 207;/);
  // Los textos del contrato, de keel-core y no a mano.
  assert.ok(runner.includes(`"${BATCH_ABORTED_MESSAGE}"`));
  assert.ok(runner.includes(`"${BATCH_ITEM_MALFORMED_MESSAGE}"`));
  // El elemento con sus cinco claves siempre: sin la marca [OmitNulls].
  assert.doesNotMatch(runner, /^\s*\[OmitNulls\]\s*$/m);
  // El middleware gana su traducción solo con lotes: el resto de proyectos no cambia.
  assert.match(fileOf(files, 'Rest/ApiErrorMiddleware.cs'), /public static ErrorResponse Translate\(HttpContext context, Exception exception\)/);
  assert.match(fileOf(files, 'Rest/ApiErrorMiddleware.cs'), /middleware\.ToResponse\(PersistenceErrors\.Translate\(exception\) \?\? exception\)/);
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  const plain = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.doesNotMatch(fileOf(plain, 'Rest/ApiErrorMiddleware.cs'), /Translate\(HttpContext/);
  assert.ok(!plain.some((file) => file.path.endsWith('Rest/Batch.cs')));
});

test('all-or-nothing: el bucle abre la transacción del lote y el endpoint responde el successStatus o el error del culpable', () => {
  const { files } = plan('catalog-batch-atomic');
  const endpoints = fileOf(files, 'Endpoints/ProductV1Endpoints.cs');
  assert.match(endpoints, /var outcome = await BatchRunner\.AllOrNothing<ProductDraft>\(\s+"items",/);
  assert.match(endpoints, /http\.RequestServices\.GetRequiredService<IUseCaseTransactions>\(\)/);
  assert.match(endpoints, /await HttpReply\.Json\(http, error\.Status, error\);/);
  assert.match(endpoints, /await HttpReply\.Json\(http, 200, outcome\.Body\);/);
  const runner = fileOf(files, 'Rest/Batch.cs');
  assert.match(runner, /var results = await transactions\.Run\(/);
  // El fallo del culpable sale ya traducido y SIN causa: la traducción de la persistencia mira la cadena de causas, y si la
  // transacción que revierte lo tradujera otra vez perdería el índice.
  assert.match(runner, /throw new ItemFailure\(index, translate\(error\)\);/);
  assert.match(runner, /private sealed class ItemFailure\(int index, ErrorResponse response\) : Exception\(response\.Message\)/);
});

test('el contrato formal es el MISMO byte a byte que el de keel-spring y keel-nest, y la tabla de rutas lleva el lote', () => {
  for (const { name } of BATCH_DESIGNS) {
    const mine = fileOf(plan(name).files, 'docs/openapi.yaml');
    assert.equal(mine, fileOf(plan(name, { generator: planSpring }).files, 'docs/openapi.yaml'), name);
    assert.equal(mine, fileOf(plan(name, { generator: planNest }).files, 'docs/openapi.yaml'), name);
    assert.match(fileOf(plan(name).files, 'Rest/ApiRoutes.cs'), /new\("importProducts", "POST", "\/api\/v1\/products\/batch", \d+, Location: false, Query: \[\], Body: "required", Handler: ProductV1Endpoints\.ImportProducts\)/);
  }
});

test('la sonda: el handler de importProducts se sustituye por el que guarda UN elemento, y los sabotajes se aplican a lo emitido hoy', () => {
  for (const name of [...BATCH_SUBJECTS.relational, ...BATCH_SUBJECTS.document]) {
    const { files, model } = plan(name);
    const patched = files.map((file) => batchProbePatch(model, file, files));
    const handler = fileOf(patched, 'UseCases/ImportProductsCommandHandler.cs');
    assert.match(handler, /var saved = await productRepository\.Save\(/, name);
    assert.match(handler, /return new ImportProductsItemResult \{ ProductId = saved\.Id \};/, name);
    assert.doesNotMatch(handler, /NotImplementedException/, name);
  }
  for (const [id, specs] of Object.entries(BATCH_SABOTAGE_SPECS)) {
    for (const [store, subject] of [['relational', id === 'ba-atomic-no-tx' ? 'catalog-batch-atomic' : 'catalog-batch'], ['document', 'catalog-batch-mongo']]) {
      if (store === 'document' && id === 'ba-atomic-no-tx') continue;
      const [where, from, to] = specs[store];
      const touched = plan(subject).files.filter((file) => typeof file.content === 'string' && file.path.startsWith('src/') && file.path.includes(where));
      const changed = touched.filter((file) => (typeof from === 'string' ? file.content.replaceAll(from, to) : file.content.replace(from, to)) !== file.content);
      assert.ok(changed.length > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});
