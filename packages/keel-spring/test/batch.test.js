// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) en keel-spring: la forma de lo que emite build sobre los
// diseños de keel-core/test/helpers/batch-designs.js. Lo que esto NO dice —que cada elemento vaya en su transacción, que
// uno mal formado sea su resultado y no un 400, que un fallo no declarado detenga el lote, que el 207 salga siempre— lo
// mide scripts/batch-check.js contra el motor real (BA-1 a BA-7).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { BATCH_ABORTED_MESSAGE, BATCH_ITEM_MALFORMED_MESSAGE, batchNote } from '@keel-system/keel-core/gen/batch';
import { BATCH_DESIGNS } from '../../keel-core/test/helpers/batch-designs.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { casesOf } from '../src/lib/batch-probes.js';
import { buildModel } from '../src/lib/model.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const design = (name) => BATCH_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  if (mutate) mutate(layers);
  return { manifest, layers, document: layers.persistence?.default?.model === 'document' };
}

function plan(name) {
  const { manifest, layers, document } = load(name);
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: document ? 'mongodb' : 'postgresql' } });
}

const fileOf = (files, suffix) => {
  const found = files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, `no se emitió ${suffix}`);
  return found.content;
};

test('los sujetos pasan la frontera de keel-spring y su sonda ejecuta los casos que les tocan', () => {
  const expected = {
    'catalog-batch': ['BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5', 'BA-7'],
    'catalog-batch-mongo': ['BA-1', 'BA-2', 'BA-3', 'BA-4', 'BA-5', 'BA-7'],
    'catalog-batch-atomic': ['BA-6', 'BA-7']
  };
  for (const { name } of BATCH_DESIGNS) {
    const { manifest, layers, document } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const model = buildModel({ manifest, layers, stack: { database: document ? 'mongodb' : 'postgresql' } });
    assert.deepEqual(casesOf(model), expected[name], name);
  }
});

test('la frontera: async llega en el incremento 6 y la idempotencia del lote entero no la genera nadie todavía', () => {
  const asynchronous = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.batch.execution = 'async';
  });
  assert.match(checkSupportedFeatures(asynchronous.manifest, asynchronous.layers).errors.join('\n'), /importProducts\.batch \(execution: async.*incremento 6/);
  const idempotent = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  });
  assert.match(checkSupportedFeatures(idempotent.manifest, idempotent.layers).errors.join('\n'), /importProducts\.batch con idempotency \(DSL 2\.30, D5\): keel-spring/);
});

test('el handler procesa UN elemento: su mensaje lleva el elemento y devuelve el ItemResult, con la nota neutral', () => {
  const { files, model } = plan('catalog-batch');
  const message = fileOf(files, '/application/commands/ImportProductsCommand.java');
  assert.match(message, /public record ImportProductsCommand\(\s+ProductDraft item\s+\) implements ReturningCommand<ImportProductsItemResult>/);
  assert.doesNotMatch(message, /List</, 'el mensaje no lleva la lista');
  assert.match(fileOf(files, '/application/dtos/ImportProductsItemResult.java'), /public record ImportProductsItemResult\(\s+UUID productId\s+\)/);
  const handler = fileOf(files, '/application/usecases/ImportProductsCommandHandler.java');
  assert.match(handler, /implements ReturningCommandHandler<ImportProductsCommand, ImportProductsItemResult>/);
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'importProducts');
  for (const line of batchNote(operation.batch)) assert.ok(handler.includes(`// ${line}`), `falta en la nota: ${line}`);
});

test('el borde solo valida el SOBRE: los elementos llegan sin leer y los lee BatchRunner uno a uno (D3)', () => {
  const { files } = plan('catalog-batch');
  const request = fileOf(files, '/infrastructure/rest/batch/ImportProductsBatchRequest.java');
  assert.match(request, /@NotEmpty @Size\(max = 500\) List<JsonNode> items/);
  assert.doesNotMatch(request, /ProductDraft/, 'con List<ProductDraft>, Jackson leería todos al leer el cuerpo: el primero mal formado sería un 400');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /public ResponseEntity<BatchResponse> importProducts\(@Valid @RequestBody ImportProductsBatchRequest request\) \{\s+return batchRunner\.perItem\(request\.items\(\), ProductDraft\.class, Set\.of\("SKU_ALREADY_EXISTS"\),\s+item -> mediator\.dispatch\(new ImportProductsCommand\(item\)\)\);/);
  const runner = fileOf(files, '/infrastructure/rest/batch/BatchRunner.java');
  // Los mismos lectores que el borde: el ObjectMapper y el Validator de la aplicación, y el fallo traducido por ApiExceptionHandler.
  assert.match(runner, /item = mapper\.treeToValue\(node, itemType\);/);
  assert.match(runner, /validator\.validate\(item\)/);
  assert.match(runner, /new ExceptionHandlerMethodResolver\(ApiExceptionHandler\.class\)/);
  assert.match(runner, /ResponseEntity\.status\(HttpStatus\.MULTI_STATUS\)/);
  // Sin all-or-nothing no hay transacción abarcadora: la abre el mediator en cada elemento (D2).
  assert.doesNotMatch(runner, /TransactionTemplate/);
  // Los textos del contrato, de keel-core y no a mano.
  assert.ok(runner.includes(JSON.stringify(BATCH_ABORTED_MESSAGE)));
  assert.ok(runner.includes(JSON.stringify(BATCH_ITEM_MALFORMED_MESSAGE)));
  assert.match(runner, /BATCH_ABORTED = "BATCH_ABORTED"/);
  // Las cinco claves del elemento, también con conventions.nulls: omit.
  assert.match(fileOf(files, '/infrastructure/rest/batch/BatchResponse.java'), /@JsonInclude\(JsonInclude\.Include\.ALWAYS\)\s+public record Item\(int index, String status, Object result, String error, String message\)/);
});

test('all-or-nothing: todos los elementos en una transacción y el successStatus del endpoint', () => {
  const { files } = plan('catalog-batch-atomic');
  const controller = fileOf(files, '/ProductV1Controller.java');
  assert.match(controller, /public ResponseEntity<\?> importProducts\(@Valid @RequestBody ImportProductsBatchRequest request\) \{\s+return batchRunner\.allOrNothing\("items", request\.items\(\), ProductDraft\.class, HttpStatus\.valueOf\(200\),/);
  const runner = fileOf(files, '/infrastructure/rest/batch/BatchRunner.java');
  assert.match(runner, /transaction\.execute\(status -> processAll\(items, itemType, process\)\)/);
  assert.match(runner, /List<String> details = List\.of\(over \+ "\[" \+ failure\.index \+ "\]"\);/);
});

test('el contrato formal: 207 con el resultado por elemento, y ningún error del diseño como respuesta del lote', () => {
  const { files } = plan('catalog-batch');
  const document = YAML.parse(fileOf(files, 'docs/openapi.yaml'));
  const post = document.paths['/api/v1/products/batch'].post;
  assert.deepEqual(Object.keys(post.responses).sort(), ['207', '400', ...Object.keys(post.responses).filter((key) => ['401', '403'].includes(key))].sort());
  assert.equal(post.responses['207'].content['application/json'].schema.$ref, '#/components/schemas/ImportProductsBatchResponse');
  assert.deepEqual(document.components.schemas.ImportProductsBatchItem.required, ['index', 'status', 'result', 'error', 'message']);
  assert.ok(document.components.schemas.ImportProductsItemResult, 'el result de cada elemento');
});
