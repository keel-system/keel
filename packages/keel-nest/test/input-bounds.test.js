// Lo que la ENTRADA rechaza y se escapaba en los dos generadores (corridas asset-vault y catalog de keel-nest,
// 2026-10-10). Las tres reglas salen de keel-core/gen, así que se miden en keel-nest y en keel-spring a la vez:
//
//   · una relación `required` es presencia como cualquier campo: sin `categoryId` el alta llegaba al handler con
//     null y respondía 500 (keel-spring tampoco ponía el @NotNull);
//   · la cota de CADA ELEMENTO de una lista (`labels: { maxItems: 20, maxLength: 40 }`): solo se validaba el
//     contenedor, y una etiqueta de 41 caracteres entraba;
//   · una parte binaria obligatoria que llega vacía es 400 FILE_UNREADABLE, no un null para el handler (ni el
//     VALIDATION_ERROR del @NotNull en keel-spring). La lectura multipart se ejecuta en storage.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const nestFiles = (name, stack) => Object.fromEntries(planFixture(name, stack ? { stack } : {}).files.map((f) => [f.path, f.content]));
const springFile = (name, stack, suffix) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.find((f) => f.path.endsWith(suffix)).content;
};

test('una relación obligatoria de la entrada se valida como presencia, en los dos generadores', () => {
  const controller = nestFiles('catalog-extended')['src/infrastructure/rest/controllers/product-v1-controller.ts'];
  const reader = controller.slice(controller.indexOf('function readCreateProductCommand'), controller.indexOf('function readGetProductBySlugQuery'));
  assert.match(reader, /\.check\('categoryId', categoryId, \[\{ rule: 'notNull' \}\]\)/);
  // La salida no: un DTO de respuesta no se valida.
  const spring = springFile('catalog-extended', { database: 'postgresql', broker: 'rabbitmq' }, 'CreateProductCommand.java');
  assert.match(spring, /@NotNull UUID categoryId/);
});

test('la relación opcional de un PATCH sigue sin presencia', () => {
  const controller = nestFiles('catalog-extended')['src/infrastructure/rest/controllers/product-v1-controller.ts'];
  const reader = controller.slice(controller.indexOf('function readUpdateProductCommand'));
  assert.doesNotMatch(reader.slice(0, reader.indexOf('return new')), /\.check\('categoryId'/);
});

test('cada elemento de una lista lleva su cota, además de la del contenedor', async () => {
  const controller = nestFiles('asset-vault')['src/infrastructure/rest/controllers/asset-v1-controller.ts'];
  assert.match(controller, /\.check\('uploadAsset\.labels', labels, \[\{ rule: 'size', min: null, max: 20 \}\]\)/);
  assert.match(controller, /\.checkEach\('uploadAsset\.labels', labels, \[\{ rule: 'size', min: null, max: 40 \}\]\)/);
  const spring = springFile('asset-vault', { database: 'mongodb', broker: 'rabbitmq' }, 'UploadAssetCommand.java');
  assert.match(spring, /@Size\(max = 20\) List<@Size\(max = 40\) String> labels/);

  // Y checkEach EJECUTADO: el camino de cada elemento, con el mensaje de Bean Validation.
  const { Violations } = await transpileTree(planFixture('asset-vault').files).load('src/infrastructure/rest/request-reading.ts');
  const rules = [{ rule: 'size', min: null, max: 40 }];
  assert.doesNotThrow(() => new Violations('params').checkEach('labels', ['ok', 'x'.repeat(40)], rules).throwIfAny());
  assert.doesNotThrow(() => new Violations('params').checkEach('labels', null, rules).throwIfAny());
  assert.throws(
    () => new Violations('params').checkEach('labels', ['ok', 'x'.repeat(41)], rules).throwIfAny(),
    (error) => error.details.length === 1 && error.details[0].startsWith('labels[1] ')
  );
});

test('la parte binaria obligatoria vacía es FILE_UNREADABLE también en keel-spring', () => {
  const spring = springFile('asset-vault', { database: 'mongodb', broker: 'rabbitmq' }, 'AssetV1Controller.java');
  assert.match(spring, /toFileUpload\(binary, true\)/);
  assert.match(spring, /if \(required\) \{\n\s+throw new BadRequestException\("El archivo enviado está vacío", "FILE_UNREADABLE", 400, null\);/);
});
