// Las decisiones de contrato que comparten los generadores (keel-core/gen): qué valida la entrada de
// un campo (validationRules) y cómo llega y sale una operación por HTTP (api-contract.js). Cada caso
// nombra la decisión; que los dos generadores la RENDERICEN igual lo miden sus propios tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validationRules, DECIMAL_PRECISION } from '../src/lib/gen/constraints.js';
import { requestShape, returnsLocation, locationTarget } from '../src/lib/gen/api-contract.js';

const text = (constraints = {}) => ({ kind: 'base', base: 'string', constraints });

test('la presencia de un texto es notBlank; la de cualquier otra cosa, notNull; la de una lista, notEmpty', () => {
  assert.deepEqual(validationRules({ required: true }, text()), [{ rule: 'notBlank' }]);
  assert.deepEqual(validationRules({ required: true }, { kind: 'base', base: 'int', constraints: {} }), [{ rule: 'notNull' }]);
  assert.deepEqual(validationRules({ required: true }, { kind: 'enum', name: 'Status', constraints: {} }), [{ rule: 'notNull' }]);
  assert.deepEqual(validationRules({ required: true, list: true, constraints: { maxItems: 5 } }, text()), [
    { rule: 'notEmpty' },
    { rule: 'size', min: null, max: 5 }
  ]);
});

test('en la entrada, un campo con default no exige presencia y el formato heredado del tipo no se valida', () => {
  const field = { required: true, default: 'draft' };
  assert.deepEqual(validationRules(field, text()), [{ rule: 'notBlank' }]);
  assert.deepEqual(validationRules(field, text(), { honourDefault: true }), []);
  const sku = text({ pattern: '^[A-Z]{3}$', maxLength: 3 });
  assert.deepEqual(validationRules({}, sku), [{ rule: 'size', min: null, max: 3 }, { rule: 'pattern', regexp: '^[A-Z]{3}$' }]);
  assert.deepEqual(validationRules({}, sku, { inheritTypeFormat: false }), [{ rule: 'size', min: null, max: 3 }]);
  // El que el campo declara por su cuenta sí se conserva.
  assert.deepEqual(validationRules({ constraints: { pattern: '^x$' } }, sku, { inheritTypeFormat: false })[1], { rule: 'pattern', regexp: '^x$' });
});

test('scalePolicy: reject es una regla de dígitos SOLO en la entrada, con la precisión de la columna', () => {
  const amount = { kind: 'base', base: 'decimal', constraints: { min: 0, scale: 2, scalePolicy: 'reject' } };
  assert.deepEqual(validationRules({}, amount), [{ rule: 'min', value: 0, decimal: true }]);
  assert.deepEqual(validationRules({}, amount, { inheritTypeFormat: false }), [
    { rule: 'min', value: 0, decimal: true },
    { rule: 'digits', integer: DECIMAL_PRECISION - 2, fraction: 2 }
  ]);
});

const op = (method, bodyFields, extra = {}) => ({ route: { method, path: '/x', status: 200 }, bodyFields, ...extra });

test('la entrada va en el cuerpo solo si el verbo lo admite y queda algo que no sea la identidad del llamante', () => {
  assert.deepEqual(requestShape(op('POST', [{ name: 'a', required: true }])), { asBody: true, bodyRequired: true });
  assert.deepEqual(requestShape(op('PATCH', [{ name: 'a' }])), { asBody: true, bodyRequired: false });
  assert.deepEqual(requestShape(op('GET', [{ name: 'a', required: true }])), { asBody: false, bodyRequired: false });
  assert.deepEqual(requestShape(op('POST', [{ name: 'caller', required: true, resolvedIdentity: true }])), { asBody: false, bodyRequired: false });
});

test('Location apunta a la operación que lee el recurso, o al padre cuando se añade a su colección', () => {
  const read = { route: { method: 'GET', path: '/products/{id}' }, pathParams: [{ name: 'id' }], responseDto: { entity: 'Product' } };
  const create = { route: { method: 'POST', path: '/products', status: 201 }, pathParams: [], responseDto: { entity: 'Product', fields: [{ name: 'id' }] } };
  const addImage = {
    route: { method: 'POST', path: '/products/{productId}/images', status: 201 },
    pathParams: [{ name: 'productId' }],
    responseDto: { entity: 'Product', fields: [{ name: 'id' }] }
  };
  const model = { api: { routeBase: '/api/v1' }, services: [{ operations: [read, create, addImage] }] };
  assert.deepEqual(locationTarget(model, create), { path: '/api/v1/products/{id}', param: null });
  assert.deepEqual(locationTarget(model, addImage), { path: '/api/v1/products/{id}', param: 'productId' });
  assert.equal(returnsLocation(model, create), true);
  // Sin una lectura por id no hay Location: sería un 404 prometido.
  const alone = { api: { routeBase: '/api/v1' }, services: [{ operations: [create] }] };
  assert.equal(returnsLocation(alone, create), false);
});
