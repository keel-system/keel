import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';

const manifest = { keel: '2.3', service: { name: 'demo', version: '0.1.0' } };

test('el camino relacional con token en cabecera no produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    persistence: { default: { model: 'relational' } },
    security: { authentication: { protocol: 'oidc', tokenLocation: 'header' } }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('un diseño que no declara ninguna de las dos cosas tampoco produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, { persistence: {}, security: {} });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('key-value es error: es el único modelo de almacenamiento que no se genera', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    persistence: { default: { model: 'key-value' } }
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /persistence\.default\.model/);
  assert.match(errors[0], /key-value/);
  assert.deepEqual(warnings, []);
});

test('relational y document pasan la frontera: keel-spring genera los dos', () => {
  // El contrapunto del test anterior. Este módulo existe para que nada del DSL se
  // ignore en silencio, pero el error simétrico —rechazar algo que sí se genera— es
  // igual de caro: deja al diseñador sin camino con un mensaje que miente.
  for (const model of ['relational', 'document']) {
    const { errors, warnings } = checkSupportedFeatures(manifest, {
      persistence: { default: { model } }
    });

    assert.deepEqual(errors, [], `${model} no debería ser error`);
    assert.deepEqual(warnings, []);
  }
});

test('tokenLocation cookie es aviso, no error: se genera la cabecera y se dice', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    security: { authentication: { protocol: 'oidc', tokenLocation: 'cookie' } }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tokenLocation: cookie/);
  assert.match(warnings[0], /Authorization/);
});

// Las dos patas de la robustez que no aterrizan en una clase. El módulo existe para
// que nada del DSL se ignore en silencio, y estas dos eran justo eso: campos que el
// diseñador declara creyendo que se generan y que solo producen doctrina.

test('una compensación avisa de que no genera ninguna clase propia', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: {
      dependencies: {
        payments: {
          activations: { chargeBooking: { triggeredBy: ['bookSeat'] } },
          compensations: [{ onEvent: 'PaymentFailed', undoes: 'chargeBooking' }]
        }
      }
    }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dependencies\.compensations \(payments\.PaymentFailed → chargeBooking\)/);
  assert.match(warnings[0], /suscripción normal/);
});

test('reconciledBy avisa de que queda fuera del gate conductual', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: {
      dependencies: {
        payments: {
          activations: { chargeBooking: { triggeredBy: ['bookSeat'], reconciledBy: 'sweepPendingCharges' } }
        }
      }
    }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /payments\.chargeBooking → sweepPendingCharges/);
  // Lo que el aviso tiene que decir en voz alta: ningún FL-* lo ejercita.
  assert.match(warnings[0], /gate CONDUCTUAL/);
  assert.match(warnings[0], /check-idempotency\.sh/);
});

test('una dependencia sin compensación ni reconciliación no dice nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    dependencies: { dependencies: { payments: { needs: { rate: { usedBy: ['bookSeat'] } } } } }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
