// `operationError`: lo que UNA operación declara de un code, cuando otra declara otro `http` u otro `when`. La entrada de
// `model.errors` lleva los de la primera operación que lo declaró. Que los cuatro generadores lo escriban en la nota de su handler
// lo mide keel-go/test/error-notes.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { operationError } from '../src/lib/gen/declared-errors.js';

const model = {
  errors: [
    {
      code: 'TEMPLATE_NOT_FOUND',
      http: 404,
      when: 'por id',
      dynamicStatus: true,
      statuses: new Map([[404, ['publishTemplate']], [422, ['requestNotification']]]),
      whenByOperation: new Map([['publishTemplate', 'por id'], ['requestNotification', 'por clave'], ['silent', null]])
    },
    { code: 'FRAMEWORK', http: 409, when: 'siempre' }
  ]
};

test('cada operación lee su http y su when', () => {
  assert.deepEqual(
    ['publishTemplate', 'requestNotification'].map((name) => {
      const { http, when } = operationError(model, name, 'TEMPLATE_NOT_FOUND');
      return [http, when];
    }),
    [[404, 'por id'], [422, 'por clave']]
  );
  assert.equal(operationError(model, 'requestNotification', 'TEMPLATE_NOT_FOUND').dynamicStatus, true, 'conserva el resto del error');
});

test('una operación que declara el code sin when no hereda el de otra', () => {
  assert.equal(operationError(model, 'silent', 'TEMPLATE_NOT_FOUND').when, null);
});

test('sin el rastro por operación, los del error; y un code desconocido es null, sin distinguir la caja', () => {
  assert.deepEqual([operationError(model, 'x', 'FRAMEWORK').http, operationError(model, 'x', 'FRAMEWORK').when], [409, 'siempre']);
  assert.equal(operationError(model, 'x', 'NO_EXISTE'), null);
  assert.equal(operationError(model, 'requestNotification', 'template_not_found').http, 422);
});

test('no modifica el error del modelo', () => {
  operationError(model, 'requestNotification', 'TEMPLATE_NOT_FOUND');
  assert.equal(model.errors[0].http, 404);
});
