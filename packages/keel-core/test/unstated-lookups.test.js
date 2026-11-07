// Las tres reglas de lo que una operación no dice y su código tendría que adivinar (crossrefs.js, checkUnstatedLookups).
// Salieron de la serie de corridas de control de catalog-extended (2026-11-07): los cuatro agentes eligieron cada uno por
// su cuenta qué producto devolver por el slug de su categoría, qué motivo mandar a compliance y si una categoría
// inexistente es un error al editar. Cada regla se prueba en las dos direcciones, con los falsos positivos que destapó su
// prototipo sobre todas las fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', '..', '..', 'fixtures', 'designs');

function findings(fixture, mutate = () => {}) {
  const { layers } = loadService(path.join(FIXTURES, fixture));
  mutate(layers);
  return checkCrossRefs({ layers }).findings ?? [];
}
const scopesOf = (list, id) => list.filter((finding) => finding.id === id).map((finding) => finding.scope);

test('CHK-USECASES-SINGLE-NOT-IDENTIFIED: un solo producto por el slug de su categoría', () => {
  assert.deepEqual(scopesOf(findings('catalog-extended'), 'CHK-USECASES-SINGLE-NOT-IDENTIFIED'), ['use-cases.operations.getProductBySlug']);
  // Por lo que sí lo identifica —su clave natural, un campo único o su id— no avisa.
  const bySku = findings('catalog-extended', (layers) => {
    layers['use-cases'].operations.getProductBySlug.input = { fields: { sku: { type: 'string', required: true } } };
  });
  assert.deepEqual(scopesOf(bySku, 'CHK-USECASES-SINGLE-NOT-IDENTIFIED'), []);
  // Y una lista no promete uno.
  const asList = findings('catalog-extended', (layers) => {
    layers['use-cases'].operations.getProductBySlug.output.list = true;
  });
  assert.deepEqual(scopesOf(asList, 'CHK-USECASES-SINGLE-NOT-IDENTIFIED'), []);
});

test('CHK-USECASES-SINGLE-NOT-IDENTIFIED no avisa de lo que busca por la identidad del llamante', () => {
  // getMyProfile (callerSubject), getMyCard y getCart: el registro de quien llama, uno solo por construcción.
  for (const fixture of ['conduit', 'profile-directory', 'shop-api']) {
    assert.deepEqual(scopesOf(findings(fixture), 'CHK-USECASES-SINGLE-NOT-IDENTIFIED'), [], fixture);
  }
});

test('CHK-DEPS-CALL-FIELD-UNSOURCED: compliance exige un motivo que retireProduct no recibe', () => {
  const list = findings('catalog-extended');
  assert.deepEqual(scopesOf(list, 'CHK-DEPS-CALL-FIELD-UNSOURCED'), ['dependencies.compliance.activations.recordWithdrawal.reason']);
  // El barrido no tiene entrada propia: productId le llega de Product, la entidad de la operación que encargó el trabajo.
  const message = list.find((finding) => finding.id === 'CHK-DEPS-CALL-FIELD-UNSOURCED').message;
  assert.match(message, /retireProduct, reconcileWithdrawals/);
  assert.doesNotMatch(message, /'productId'/);
  // Con el motivo en la entrada de la operación que dispara la activación, deja de avisar por esa operación.
  const withReason = findings('catalog-extended', (layers) => {
    layers['use-cases'].operations.retireProduct.input.fields.reason = { type: 'string', required: true };
  });
  assert.match(withReason.find((finding) => finding.id === 'CHK-DEPS-CALL-FIELD-UNSOURCED').message, /de reconcileWithdrawals lo da/);
});

test('CHK-DEPS-CALL-FIELD-UNSOURCED casa por sufijo: un barrido sobre la entidad que lo encargó no avisa (asset-vault)', () => {
  // reconcileScans no tiene entrada: assetId y storageKey le llegan de Asset, la entidad de la operación que pidió el escaneo.
  assert.deepEqual(scopesOf(findings('asset-vault'), 'CHK-DEPS-CALL-FIELD-UNSOURCED'), []);
});

test('CHK-USECASES-REF-ERROR-ASYMMETRY: updateProduct recibe categoryId sin el CATEGORY_NOT_FOUND de createProduct', () => {
  // La v1.1.0 de la fixture ya lo declara: sin él, como estaba en la v1.0.0 de la serie de control, avisa.
  const undeclared = findings('catalog-extended', (layers) => {
    const operation = layers['use-cases'].operations.updateProduct;
    operation.errors = operation.errors.filter((error) => error.code !== 'CATEGORY_NOT_FOUND');
  });
  assert.deepEqual(scopesOf(undeclared, 'CHK-USECASES-REF-ERROR-ASYMMETRY'), ['use-cases.operations.updateProduct.categoryId']);
  // createProduct la recibe por su entidad (input: { entity: Product }), y por eso cuenta como la que la declara.
  assert.deepEqual(scopesOf(findings('catalog-extended'), 'CHK-USECASES-REF-ERROR-ASYMMETRY'), []);
});

test('CHK-USECASES-REF-ERROR-ASYMMETRY no mira operaciones internal: su error no lo ve ningún cliente (inspection-reports)', () => {
  // closePendingReports la dispara InspectorDeactivated; submitReport declara INSPECTOR_NOT_FOUND para el mismo inspectorId.
  assert.deepEqual(scopesOf(findings('inspection-reports'), 'CHK-USECASES-REF-ERROR-ASYMMETRY'), []);
  // La misma operación pública sí avisa: el corte es internal, no el nombre ni la fixture.
  const exposed = findings('inspection-reports', (layers) => {
    delete layers['use-cases'].operations.closePendingReports.internal;
  });
  assert.deepEqual(scopesOf(exposed, 'CHK-USECASES-REF-ERROR-ASYMMETRY'), ['use-cases.operations.closePendingReports.inspectorId']);
});

test('CHK-USECASES-REF-ERROR-ASYMMETRY solo mira commands:filtrar un listado por una categoría que no existe da vacío', () => {
  // listDraftProducts recibe categoryId como filtro y no declara CATEGORY_NOT_FOUND: no es una referencia que escribir.
  const list = findings('catalog-extended');
  assert.ok(!scopesOf(list, 'CHK-USECASES-REF-ERROR-ASYMMETRY').some((scope) => scope.includes('listDraftProducts')));
});
