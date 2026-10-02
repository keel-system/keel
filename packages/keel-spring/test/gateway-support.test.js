// La matriz de las pasarelas de pago y su puerta. La promesa de la capa payments es un único
// diseño para todas las pasarelas del menú; lo que la hace honesta es que una pasarela que no
// cubre lo que el diseño exige NO genere. Aquí se comprueba que la puerta muerde, en build, en
// planService y en el cuestionario.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_REQUIREMENTS, GATEWAY_STATES, checkGatewaySupport, gatewayCoverage, gatewayRequirements } from '../src/lib/gateway-support.js';
import { PAYMENT_GATEWAYS, STACK_DEFAULTS } from '../src/lib/stack-catalog.js';
import { stackDrift, describeStack } from '../src/lib/stack-config.js';
import { resolveStack, planService } from '../src/scaffold/index.js';

const payments = (extra = {}) => ({ flow: 'authorize-capture', capabilities: [], ...extra });

test('toda celda de la matriz existe para TODAS las pasarelas del catálogo, con estado y porqué', () => {
  // Una pasarela nueva sin su columna entera sería una pasarela que genera sin que nadie haya
  // dicho qué cubre: la forma exacta del fallo que la matriz existe para impedir.
  for (const [key, row] of Object.entries(GATEWAY_REQUIREMENTS)) {
    for (const id of Object.keys(PAYMENT_GATEWAYS)) {
      const cell = row[id];
      assert.ok(cell, `${key}: sin celda para ${id}`);
      assert.ok(GATEWAY_STATES.includes(cell.state), `${key}/${id}: estado desconocido`);
      assert.ok(cell.why?.length > 10, `${key}/${id}: el porqué tiene que decir algo`);
    }
  }
});

test('la matriz cubre todo lo que la capa puede exigir', async () => {
  const fs = await import('node:fs');
  const { schemaPathFor } = await import('keel-core');
  const schema = JSON.parse(fs.readFileSync(schemaPathFor('payments'), 'utf8'));
  const declarable = [
    ...schema.properties.flow.enum.map((flow) => `flow:${flow}`),
    ...schema.properties.capabilities.items.enum
  ];
  assert.deepEqual(declarable.filter((key) => !GATEWAY_REQUIREMENTS[key]), []);
});

test('lo que exige un diseño son su flujo y sus capacidades', () => {
  assert.deepEqual(gatewayRequirements(payments({ capabilities: ['partial-refund'] })), ['flow:authorize-capture', 'partial-refund']);
  assert.deepEqual(gatewayRequirements(undefined), []);
});

test('una capacidad no cubierta es error, una sin verificar es aviso', () => {
  const layers = { payments: payments({ capabilities: ['partial-capture', 'off-session'] }) };
  const stripe = checkGatewaySupport(layers, 'stripe');
  assert.deepEqual(stripe, { errors: [], warnings: [] });
  const mp = checkGatewaySupport(layers, 'mercadopago');
  assert.equal(mp.errors.length, 1);
  assert.match(mp.errors[0], /partial-capture/);
  assert.equal(mp.warnings.length, 1);
  assert.match(mp.warnings[0], /off-session/);
});

test('la cobertura dice qué pasarelas pueden servir el diseño', () => {
  const coverage = gatewayCoverage({ payments: payments({ capabilities: ['partial-capture'] }) }, Object.keys(PAYMENT_GATEWAYS));
  assert.deepEqual(coverage.filter((entry) => entry.errors.length === 0).map((entry) => entry.id), ['stripe']);
});

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
  const manifest = { keel: '2.19', service: { name: 'pay', version: '1.0.0', description: 'x' }, layers: {} };
  assert.throws(() => planService({ manifest, layers, workspace: '.', stack: { paymentGateway: 'mercadopago' } }), /partial-capture/);
});
