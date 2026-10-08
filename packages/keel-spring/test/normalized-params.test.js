// El formato heredado del value type se valida en la frontera, también por ruta y por query (desde la
// corrida notification-mailer-mongo, 2026-10-08). Lo que sigue abajo es la historia de por qué no se hacía.
//
// Un `pattern` que el campo hereda de su tipo describe el valor YA NORMALIZADO: el diseño pasa el
// sku a mayúsculas —o el código a minúsculas— ANTES de comparar, y Bean Validation corre antes de
// que el handler normalice nada. Eso ya lo sabían los mensajes de command y query (`inputValidation`
// en model.js), pero el controller construía los `@PathVariable` y los `@RequestParam` desde la
// lista COMPLETA, así que el mismo valor que se aceptaba en el cuerpo se rechazaba con un 400 al
// llegar por la ruta. En una corrida real eso cerraba `GET /applications/Billing`, que por diseño
// resuelve igual que `/applications/billing`.
//
// Lo que NO cambia: el `pattern` que el campo declara por su cuenta sigue emitiéndose — es una
// restricción de esa entrada concreta, no la forma del tipo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixturesDir = path.join(FIXTURES_DIR);
const CONTROLLER =
  'src/main/java/com/commerce/catalog/infrastructure/rest/controllers/product/v1/ProductV1Controller.java';

/**
 * `getProductBySlug` con el segmento tipado como SKU (que aporta el pattern del value type) y con
 * un filtro de query que declara pattern POR SU CUENTA, para poder distinguir los dos casos.
 */
function generate() {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, 'catalog-extended'));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched['use-cases'].operations.getProductBySlug.input.fields.slug = { type: 'SKU', required: true };
  patched['use-cases'].operations.listProducts.input = {
    fields: { tag: { type: 'string', constraints: { pattern: '^[a-z]+$' } } }
  };

  const workspace = tmpDir('keel-normalized-params-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, 'services', 'catalog-spring');
  return fs.readFileSync(path.join(root, CONTROLLER), 'utf8');
}

/** La línea de la firma del método: el binding viaja ahí entero, en una sola línea. */
function signatureOf(controller, method) {
  const lines = controller.split(/\r?\n/);
  return lines.find((line) => line.includes('public ') && line.includes(`${method}(`)) ?? '';
}

test('el @PathVariable lleva el @Pattern heredado del value type, como el cuerpo', () => {
  const signature = signatureOf(generate(), 'getProductBySlug');
  assert.ok(signature, 'no se generó el endpoint por slug');

  assert.ok(signature.includes('@PathVariable'), 'el segmento dejó de bindearse');
  // Desde la corrida notification-mailer-mongo el formato es contrato de la entrada, venga por el
  // cuerpo, la ruta o la query: el mismo valor no puede aceptarse por un sitio y rechazarse por otro.
  assert.ok(signature.includes('@Pattern(regexp = '), 'la ruta valida distinto que el cuerpo');
});

test('pero el @RequestParam conserva el pattern que el campo declara por su cuenta', () => {
  const signature = signatureOf(generate(), 'listProducts');
  assert.ok(signature, 'no se generó el listado');

  assert.ok(signature.includes('@RequestParam'), 'el filtro dejó de bindearse');
  assert.ok(
    signature.includes('@Pattern(regexp = "^[a-z]+$")'),
    'se llevó por delante una restricción de la entrada, no del tipo'
  );
});
