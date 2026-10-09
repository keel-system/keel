// La matriz de las pasarelas de pago y su puerta. La promesa de la capa payments es un único
// diseño para todas las pasarelas del menú; lo que la hace honesta es que una pasarela que no
// cubre lo que el diseño exige NO genere. La matriz es neutral y la mide
// keel-core/test/payment-gateways.test.js; aquí se comprueba que la puerta muerde en keel-spring:
// en planService y en el cuestionario.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STACK_DEFAULTS } from '../src/lib/stack-catalog.js';
import { stackDrift, describeStack } from '../src/lib/stack-config.js';
import { resolveStack, planService } from '../src/scaffold/index.js';

const payments = (extra = {}) => ({ flow: 'authorize-capture', capabilities: [], ...extra });

test('la pasarela es categoría de stack: solo aplica con capa payments, y su deriva se ve', () => {
  const withPayments = { payments: payments() };
  assert.deepEqual(stackDrift({}, withPayments).missing, ['paymentGateway']);
  assert.deepEqual(stackDrift({ paymentGateway: 'stripe' }, {}).stale, ['paymentGateway']);
  assert.equal(resolveStack(null, withPayments, { service: { name: 'x' } }).paymentGateway, STACK_DEFAULTS.paymentGateway);
  assert.equal(resolveStack(null, {}, { service: { name: 'x' } }).paymentGateway, null);
  assert.match(describeStack({ paymentGateway: 'mercadopago' }), /MercadoPago/);
});

test('una pasarela que el catálogo no conoce se rechaza en voz alta', () => {
  assert.throws(() => resolveStack({ paymentGateway: 'paypal' }, { payments: payments() }, { service: { name: 'x' } }), /no está soportada/);
});

test('planService no genera con una pasarela que no cubre el diseño', () => {
  // Que la puerta esté también aquí, y no solo en build, es lo que impide que cualquier otro
  // camino (check, los tests, un refresco) produzca un adaptador a medias.
  const layers = {
    domain: { entities: {} },
    'use-cases': { operations: {} },
    payments: payments({ capabilities: ['partial-capture'] })
  };
  const manifest = { keel: '2.20', service: { name: 'pay', version: '1.0.0', description: 'x' }, layers: {} };
  assert.throws(() => planService({ manifest, layers, workspace: '.', stack: { paymentGateway: 'mercadopago' } }), /partial-capture/);
});
