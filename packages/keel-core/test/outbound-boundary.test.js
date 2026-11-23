// La frontera transaccional de lo que encarga trabajo y lo deja esperando (G5 del plan de prueba-gelsa).

import test from 'node:test';
import assert from 'node:assert/strict';
import { commitsBeforeOutbound, outboundBoundaryNote } from '../src/lib/gen/outbound-boundary.js';

const activation = (extra = {}) => ({
  name: 'chargeOrder',
  http: { client: 'payment', call: 'requestCharge' },
  awaitingSince: 'chargeOrderAwaitingSince',
  awaits: 'acknowledgement',
  ...extra
});
const modelWith = (operation, payments = null) => ({ payments, services: [{ operations: [operation] }] });

test('una activación HTTP que deja esperando se despacha sin transacción, y su handler lo sabe', () => {
  const op = { name: 'createOrder', dependencyActivations: [{ dependency: 'payment', activation: activation() }] };
  const model = modelWith(op);
  assert.equal(commitsBeforeOutbound(model, 'createOrder'), true);
  const note = outboundBoundaryNote(model, op);
  assert.match(note, /SIN TRANSACCIÓN ABARCADORA/);
  assert.match(note, /payment\.chargeOrder \(marca chargeOrderAwaitingSince\)/);
});

test('sin awaitingSince, con awaits: outcome o por evento, la transacción única sigue', () => {
  for (const extra of [{ awaitingSince: null }, { awaits: 'outcome' }, { http: null }]) {
    const op = { name: 'createOrder', dependencyActivations: [{ dependency: 'payment', activation: activation(extra) }] };
    assert.equal(commitsBeforeOutbound(modelWith(op), 'createOrder'), false, JSON.stringify(extra));
    assert.equal(outboundBoundaryNote(modelWith(op), op), null);
  }
});

test('la pasarela de pagos sigue sin transacción, y su nota no es esta', () => {
  const op = { name: 'requestCharge' };
  const model = modelWith(op, { charge: { operation: 'requestCharge' } });
  assert.equal(commitsBeforeOutbound(model, 'requestCharge'), true);
  assert.equal(outboundBoundaryNote(model, op), null);
});

test('el barrido que reconcilia no lleva esta nota: su orden es el contrario', () => {
  const op = {
    name: 'reconcileStalledOrders',
    reconciles: [{}],
    dependencyActivations: [{ dependency: 'payment', activation: activation() }]
  };
  assert.equal(outboundBoundaryNote(modelWith(op), op), null);
});
