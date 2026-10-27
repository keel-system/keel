// La puerta por la que entra una operación (keel-core/gen/entry-gates.js), en los TRES generadores: el mensaje de una
// operación que entra por HTTP y por alguna otra lleva `entryGate`, obligatorio, que el endpoint fija a HTTP y que la nota
// de la suscripción dicta con su valor. Sin ella, cinco corridas de payment-checkout resolvieron `requestCharge` a mano de
// cinco formas. Aquí vive la comparación de los tres porque keel-core no importa de los generadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planDotnet } from '../src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR, fixtureNames, variantStack } from './helpers/workspace.js';

const plan = (generator, name) => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return generator({ manifest, layers, workspace: FIXTURES_DIR, stack: variantStack(layers) }).files;
};
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content ?? '';

test('requestCharge (payment-checkout) lleva su puerta en los tres, la fija el endpoint y la dicta la suscripción', () => {
  const dotnet = plan(planDotnet, 'payment-checkout');
  assert.match(content(dotnet, 'Abstractions/EntryGate.cs'), /public enum EntryGate\s*\{\s*Http,\s*Subscription,\s*Dispatch,\s*Schedule,/);
  assert.match(content(dotnet, 'Commands/RequestChargeCommand.cs'), /public required EntryGate EntryGate \{ get; init; \}/);
  assert.match(content(dotnet, 'Endpoints/PaymentV1Endpoints.cs'), /EntryGate = EntryGate\.Http,/);
  assert.match(content(dotnet, 'Subscriptions/ChargeRequestedMessage.cs'), /PaymentMethodRef = message\.PaymentMethodRef, EntryGate = EntryGate\.Subscription \}/);
  assert.match(content(dotnet, 'UseCases/RequestChargeCommandHandler.cs'), /entra por HTTP y por EntryGate\.Subscription \(ChargeRequested\): command\.EntryGate/);

  const nest = plan(planNest, 'payment-checkout');
  assert.match(content(nest, 'interfaces/entry-gate.ts'), /export enum EntryGate \{\s*HTTP = 'HTTP',\s*SUBSCRIPTION = 'SUBSCRIPTION'/);
  assert.match(content(nest, 'commands/request-charge-command.ts'), /readonly entryGate: EntryGate;[\s\S]*this\.entryGate = props\.entryGate;/);
  assert.match(content(nest, 'controllers/payment-v1-controller.ts'), /entryGate: EntryGate\.HTTP\n {2}\}\);/);
  assert.match(content(nest, 'subscriptions/charge-requested-message.ts'), /paymentMethodRef = payload\.paymentMethodRef, entryGate = EntryGate\.SUBSCRIPTION\)/);
  assert.match(content(nest, 'usecases/request-charge-command-handler.ts'), /entra por HTTP y por EntryGate\.SUBSCRIPTION \(ChargeRequested\): command\.entryGate/);

  const spring = plan(planSpring, 'payment-checkout');
  assert.match(content(spring, 'application/interfaces/EntryGate.java'), /public enum EntryGate \{\s*HTTP,\s*SUBSCRIPTION,\s*DISPATCH,\s*SCHEDULE\s*\}/);
  // En keel-spring el comando ES el cuerpo de la petición: sin @JsonIgnore un cliente elegiría por qué puerta entra.
  assert.match(content(spring, 'commands/RequestChargeCommand.java'), /@JsonIgnore EntryGate entryGate\n\)/);
  assert.match(content(spring, 'PaymentV1Controller.java'), /new RequestChargeCommand\([\s\S]*?command\.paymentMethodRef\(\),\s*EntryGate\.HTTP\)\)/);
  assert.match(content(spring, 'ChargeRequestedMessage.java'), /paymentMethodRef = payload\.paymentMethodRef\(\), entryGate = EntryGate\.SUBSCRIPTION\)/);
  assert.match(content(spring, 'RequestChargeCommandHandler.java'), /entra por HTTP y por EntryGate\.SUBSCRIPTION \(ChargeRequested\): command\.entryGate\(\)/);
});

test('las mismas operaciones llevan su puerta en los tres, y solo esas: hoy requestCharge, no quarantineAsset', () => {
  for (const name of fixtureNames()) {
    const carrying = {
      dotnet: plan(planDotnet, name).filter((file) => /public required EntryGate EntryGate/.test(file.content)).map((file) => path.basename(file.path, '.cs')),
      nest: plan(planNest, name).filter((file) => /readonly entryGate: EntryGate;/.test(file.content) && file.path.includes('/commands/')).map((file) => path.basename(file.path, '.ts')),
      spring: plan(planSpring, name).filter((file) => /@JsonIgnore EntryGate entryGate/.test(file.content)).map((file) => path.basename(file.path, '.java'))
    };
    const expected = name === 'payment-checkout' ? ['RequestChargeCommand'] : [];
    assert.deepEqual(carrying.dotnet, expected, `${name} (keel-dotnet)`);
    assert.deepEqual(carrying.spring, expected, `${name} (keel-spring)`);
    assert.deepEqual(carrying.nest, expected.map(() => 'request-charge-command'), `${name} (keel-nest)`);
  }
});
