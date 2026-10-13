// El null de un PATCH sobre un campo que el dominio exige (keel-core/gen/model.js, derivePatchNotNull). En un PATCH
// el opcional del cuerpo tiene tres estados —ausente conserva, null vacía, valor cambia—, pero vaciar `Product.name`
// (required) o la FK de una many-to-one requerida no tiene desenlace válido. La corrida catalog-nest (2026-10-13) lo
// encontró rechazado a mano en los handlers, con la regla en prosa. Ahora los dos generadores lo rechazan a la ENTRADA
// con el 400 de validación y solo cuando el campo viene: keel-spring con `JsonNullable<@NotNull …>` (el extractor
// no mira un ausente) y keel-nest con la regla `notNull` en el lector (`Violations.check` no mira un `undefined`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'postgresql', broker: 'rabbitmq' };

// catalog-extended: updateProduct es PATCH con name (Product.name required), categoryId (category many-to-one
// required) y expectedVersion (no es campo de Product). Se le añade `sku` como control: required en el dominio.
const mutate = (layers) => {
  layers['use-cases'].operations.updateProduct.input.fields.sku = { type: 'string' };
};

function plans() {
  const nest = planFixture('catalog-extended', { stack: STACK, mutate });
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  mutate(layers);
  const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK });
  return { nest, spring };
}

test('el modelo marca solo los opcionales del PATCH cuyo campo del dominio es obligatorio', () => {
  const { nest, spring } = plans();
  for (const model of [nest.model, spring.model]) {
    const operation = model.services.flatMap((service) => service.operations).find((op) => op.name === 'updateProduct');
    const marked = operation.bodyFields.filter((field) => field.patchNotNull).map((field) => field.name).sort();
    assert.deepEqual(marked, ['categoryId', 'name', 'sku']);
    // Fuera de un PATCH no se marca nada: el null de un POST ya lo decide `required`.
    const others = model.services.flatMap((service) => service.operations).filter((op) => op.route?.method !== 'PATCH');
    assert.equal(others.flatMap((op) => op.bodyFields ?? []).some((field) => field.patchNotNull), false);
  }
});

test('keel-spring pone @NotNull DENTRO del JsonNullable, solo en los marcados', () => {
  const record = plans().spring.files.find((file) => file.path.endsWith('/UpdateProductCommand.java')).content;
  assert.match(record, /JsonNullable<@NotNull @Size\(max = 200\) String> name/);
  assert.match(record, /JsonNullable<@NotNull UUID> categoryId/);
  assert.match(record, /JsonNullable<@NotNull String> sku/);
  assert.match(record, /JsonNullable<Long> expectedVersion/);
  assert.match(record, /import jakarta\.validation\.constraints\.NotNull;/);
  // Fuera del genérico la constraint sería del contenedor: HV000030 en toda petición que trajera el campo.
  assert.doesNotMatch(record, /@NotNull JsonNullable/);
});

test('keel-nest rechaza el null y deja pasar el ausente (lector emitido, ejecutado)', async () => {
  const { nest } = plans();
  const controller = nest.files.find((file) => file.path.endsWith('/product-v1-controller.ts')).content;
  const start = controller.indexOf('function readUpdateProductCommand');
  const reader = controller.slice(start, controller.indexOf('\n}\n', start) + 2);
  assert.match(reader, /\.check\('name', name, \[\{ rule: 'notNull' \}/);
  assert.doesNotMatch(reader, /\.check\('expectedVersion'/);
  const probe = {
    path: 'src/patch-probe.ts',
    content: `import { bodyObject, json, text, Violations } from './infrastructure/rest/request-reading.js';
import { UpdateProductCommand } from './application/commands/update-product-command.js';
export ${reader}`
  };
  const { readUpdateProductCommand } = await transpileTree([...nest.files, probe]).load('src/patch-probe.ts');
  const read = (body) => readUpdateProductCommand({ id: '0190c6a4-7c1e-7cc0-8a3e-1b2c3d4e5f60' }, {}, body);
  const rejected = (body) => {
    try {
      read(body);
      return null;
    } catch (error) {
      assert.equal(error.name, 'RequestValidationError');
      return error.details ?? error.violations ?? error.message;
    }
  };
  // Ausente: no se toca, y no se valida.
  assert.equal(read({ expectedVersion: 3 }).name, undefined);
  assert.equal(read({ expectedVersion: 3 }).categoryId, undefined);
  // Presente con valor: pasa, con sus cotas de siempre.
  assert.equal(read({ name: 'Bota' }).name, 'Bota');
  assert.notEqual(rejected({ name: 'x'.repeat(201) }), null);
  // Presente con null: 400 en los marcados, con el mensaje de Bean Validation.
  for (const field of ['name', 'categoryId', 'sku']) {
    const details = rejected({ [field]: null });
    assert.notEqual(details, null, `${field}: null`);
    assert.match(JSON.stringify(details), new RegExp(`${field} must not be null`));
  }
  // El que no es campo de Product conserva el «null vacía».
  assert.equal(read({ expectedVersion: null }).expectedVersion, null);
});
