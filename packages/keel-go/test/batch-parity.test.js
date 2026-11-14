// Los LOTES con resultado por elemento (DSL 2.30, modo `sync`) en keel-go: la forma de lo que emite build sobre los
// diseños de keel-core/test/helpers/batch-designs.js, y su PARIDAD con lo que emiten keel-spring, keel-nest y keel-dotnet
// del mismo diseño (los mismos casos, la misma nota del handler, el mismo contrato). Sin Go no se ejecuta el bucle: lo que
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
import { BATCH_SABOTAGE_SPECS, BATCH_SUBJECTS, batchCases, batchProbeFile, batchProbePatch } from '../scripts/lib/batch-probes.js';
import { applyDbSabotage } from './helpers/db-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { casesOf as springCases } from '../../keel-spring/src/lib/batch-probes.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { batchCases as nestCases } from '../../keel-nest/scripts/lib/batch-probes.js';
import { planService as planDotnet } from '../../keel-dotnet/src/scaffold/index.js';
import { batchCases as dotnetCases } from '../../keel-dotnet/scripts/lib/batch-probes.js';

const design = (name) => BATCH_DESIGNS.find((entry) => entry.name === name);

function load(name, mutate = null) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, design(name).from));
  design(name).mutate(layers);
  manifest.service.name = name;
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

test('los sujetos pasan la frontera de keel-go y su sonda ejecuta los MISMOS casos que las de los otros tres', () => {
  for (const { name } of BATCH_DESIGNS) {
    const { manifest, layers } = load(name);
    assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, [], name);
    const cases = batchCases(plan(name).model);
    assert.deepEqual(cases, springCases(plan(name, { generator: planSpring }).model), name);
    assert.deepEqual(cases, nestCases(plan(name, { generator: planNest }).model), name);
    assert.deepEqual(cases, dotnetCases(plan(name, { generator: planDotnet }).model), name);
  }
  assert.deepEqual([...BATCH_SUBJECTS.relational, ...BATCH_SUBJECTS.document].sort(), BATCH_DESIGNS.map((entry) => entry.name).sort());
});

test('la frontera: async llega en el incremento 9 y la idempotencia del lote entero no la genera nadie todavía', () => {
  const asynchronous = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.batch.execution = 'async';
  });
  assert.match(checkSupportedFeatures(asynchronous.manifest, asynchronous.layers).errors.join('\n'), /importProducts\.batch \(execution: async.*incremento 9/);
  const idempotent = load('catalog-batch', (layers) => {
    layers['use-cases'].operations.importProducts.idempotency = { keySource: 'client-key', ttlSeconds: 3600 };
  });
  assert.match(checkSupportedFeatures(idempotent.manifest, idempotent.layers).errors.join('\n'), /importProducts\.batch con idempotency \(DSL 2\.30, D5\): keel-go/);
});

test('el handler procesa UN elemento: el mensaje lleva el elemento y devuelve el ItemResult, con la MISMA nota que los otros tres', () => {
  const { files, model } = plan('catalog-batch');
  const message = fileOf(files, 'internal/application/import_products_command.go');
  assert.match(message, /Item domain\.ProductDraft `json:"item"`/);
  assert.doesNotMatch(message, /\[\]domain\.ProductDraft/, 'el mensaje no lleva la lista');
  assert.match(fileOf(files, 'internal/application/import_products_item_result.go'), /ProductID \*uuid\.UUID `json:"productId"`/);
  const handler = fileOf(files, 'internal/application/import_products_command_handler.go');
  assert.match(handler, /func \(h \*ImportProductsCommandHandler\) Handle\(ctx context\.Context, cmd ImportProductsCommand\) \(ImportProductsItemResult, error\)/);
  const operation = model.services.flatMap((service) => service.operations).find((candidate) => candidate.name === 'importProducts');
  const others = [
    ['keel-spring', fileOf(plan('catalog-batch', { generator: planSpring }).files, '/ImportProductsCommandHandler.java')],
    ['keel-nest', fileOf(plan('catalog-batch', { generator: planNest }).files, 'application/usecases/import-products-command-handler.ts')],
    ['keel-dotnet', fileOf(plan('catalog-batch', { generator: planDotnet }).files, 'UseCases/ImportProductsCommandHandler.cs')]
  ];
  // La nota sale partida por el ancho en los cuatro; se compara sin los saltos y sin el prefijo de comentario.
  const flat = (text) => text.replace(/\n\s*\/\/\s+/g, ' ');
  for (const line of batchNote(operation.batch)) {
    assert.ok(flat(handler).includes(line), `falta en la nota de keel-go: ${line}`);
    for (const [generator, text] of others) assert.ok(flat(text).includes(line), `falta en la nota de ${generator}: ${line}`);
  }
});

test('el borde solo lee el SOBRE: la lista sin leer, con su presencia y su maxItems, y cada elemento lo lee el bucle (D3)', () => {
  const { files } = plan('catalog-batch');
  const endpoints = fileOf(files, 'internal/httpapi/product_endpoints.go');
  assert.match(endpoints, /func readImportProducts\(r \*http\.Request\) \(msg application\.ImportProductsCommand, items \[\]jsontext\.Value, err error\)/);
  // Sin las opciones del cable: leería una cadena como un documento, y un elemento "mal" sería un 400 del lote.
  assert.match(endpoints, /if err = rawList\(fields, "items", &items\); err != nil \{/);
  assert.doesNotMatch(endpoints, /member\(fields, "items"/, 'leer la lista con el lector del elemento haría del primero mal formado un 400 del lote');
  assert.match(endpoints, /if !has\(fields, "items"\) \|\| len\(items\) == 0 \{/);
  assert.match(endpoints, /if n := len\(items\); n > 500 \{/);
  assert.match(endpoints, /response, err := runPerItem\(a, r, items, \[\]string\{"SKU_ALREADY_EXISTS"\}, func\(ctx context\.Context, item domain\.ProductDraft\) \(any, error\) \{\n\t\tmsg := cmd\n\t\tmsg\.Item = item\n\t\treturn a\.useCases\.ImportProducts\.Handle\(ctx, msg\)/);
  assert.match(endpoints, /return writeJSON\(w, batchMultiStatus, response\)/);
  assert.match(fileOf(files, 'internal/httpapi/reading.go'), /func rawList\(fields map\[string\]jsontext\.Value, name string, out \*\[\]jsontext\.Value\) error \{\n\tif !has\(fields, name\) \{\n\t\treturn nil\n\t\}\n\tif err := json\.Unmarshal\(fields\[name\], out\); err != nil \{/);
  const runner = fileOf(files, 'internal/httpapi/batch.go');
  // Sin all-or-nothing no hay transacción abarcadora: la abre el caso de uso en cada elemento (D2).
  assert.doesNotMatch(runner, /func runAllOrNothing/);
  assert.match(runner, /const batchMultiStatus = 207/);
  // El fallo se traduce con el MISMO errorResponse del borde.
  assert.match(runner, /response := a\.errorResponse\(r, err\)/);
  // El elemento se lee con el contrato del cable, y la guarda del value object es su mensaje.
  assert.match(runner, /if err := wire\.Unmarshal\(raw, &item\); err != nil \{/);
  assert.match(runner, /guard\.Code\(\) == validationCode/);
  // Los textos del contrato, de keel-core y no a mano.
  assert.ok(runner.includes(`"${BATCH_ABORTED_MESSAGE}"`));
  assert.ok(runner.includes(`"${BATCH_ITEM_MALFORMED_MESSAGE}"`));
  // El elemento con sus cinco claves siempre: ninguna lleva omitzero.
  assert.doesNotMatch(runner.slice(runner.indexOf('type BatchItem struct'), runner.indexOf('type BatchSummary')), /omit/);
  // El resto de proyectos no cambia.
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  const plain = planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { database: 'postgresql' } }).files;
  assert.ok(!plain.some((file) => file.path === 'internal/httpapi/batch.go'));
  assert.doesNotMatch(fileOf(plain, 'internal/httpapi/reading.go'), /func rawList/);
  assert.doesNotMatch(fileOf(plain, 'internal/application/use_cases.go'), /InTransaction/);
});

test('all-or-nothing: la API abre la transacción del lote con InTransaction y responde el successStatus o el error del culpable', () => {
  const { files } = plan('catalog-batch-atomic');
  const endpoints = fileOf(files, 'internal/httpapi/product_endpoints.go');
  assert.match(endpoints, /body, failed, err := runAllOrNothing\(a, r, "items", items, a\.useCases\.InTransaction, /);
  assert.match(endpoints, /writeErrorResponse\(w, \*failed\)/);
  assert.match(endpoints, /return writeJSON\(w, http\.StatusOK, body\)/);
  const useCases = fileOf(files, 'internal/application/use_cases.go');
  assert.match(useCases, /func \(uc \*UseCases\) InTransaction\(ctx context\.Context, fn func\(context\.Context\) error\) error \{\n\treturn uc\.tx\.Within\(ctx, KindCommand, fn\)\n\}/);
  const runner = fileOf(files, 'internal/httpapi/batch.go');
  assert.match(runner, /err := within\(r\.Context\(\), func\(ctx context\.Context\) error \{/);
  // El índice del culpable en details, y el fallo ya traducido viaja sin causa.
  assert.match(runner, /response\.Details = Details\{fmt\.Sprintf\("%s\[%d\]", over, failure\.index\)\}/);
  assert.match(runner, /return &batchItemFailure\{index: index, response: a\.errorResponse\(r, err\)\}/);
});

test('el contrato formal es el MISMO byte a byte que el de los otros tres, y la tabla de rutas lleva el lote', () => {
  for (const { name } of BATCH_DESIGNS) {
    const mine = fileOf(plan(name).files, 'docs/openapi.yaml');
    for (const generator of [planSpring, planNest, planDotnet]) assert.equal(mine, fileOf(plan(name, { generator }).files, 'docs/openapi.yaml'), name);
    assert.match(fileOf(plan(name).files, 'internal/httpapi/routes.go'), /\{Operation: "importProducts", Method: http\.MethodPost, Path: "\/api\/v1\/products\/batch", Status: http\.Status\w+, Body: "required", handle: \(\*api\)\.importProducts\}/);
  }
});

test('la sonda: el handler de importProducts guarda UN elemento, el archivo va en el paquete del almacén y los sabotajes se aplican a lo emitido hoy', () => {
  for (const name of [...BATCH_SUBJECTS.relational, ...BATCH_SUBJECTS.document]) {
    const { files, model } = plan(name);
    const patched = files.map((file) => batchProbePatch(model, file));
    const handler = fileOf(patched, 'internal/application/import_products_command_handler.go');
    assert.match(handler, /h\.productRepository\.Save\(ctx, domain\.RehydrateProduct\(state\)\)/, name);
    assert.doesNotMatch(handler, /ErrNotImplemented/, name);
    const probe = batchProbeFile(model);
    assert.match(probe.path, /^internal\/infrastructure\/(postgres|mongo)\/batch_probe_test\.go$/, name);
    for (const id of batchCases(model)) assert.ok(probe.content.includes(`func TestBatch_${id.replace('-', '')}_`), `${name}: sin la sonda de ${id}`);
  }
  for (const [id, specs] of Object.entries(BATCH_SABOTAGE_SPECS)) {
    for (const [store, subject] of [['relational', id === 'ba-atomic-no-tx' ? 'catalog-batch-atomic' : 'catalog-batch'], ['document', 'catalog-batch-mongo']]) {
      if (store === 'document' && id === 'ba-atomic-no-tx') continue;
      const { changed } = applyDbSabotage(specs[store], plan(subject).files, 'postgresql');
      assert.ok(changed > 0, `${id} (${store}) no se aplica a ${subject}`);
    }
  }
});
