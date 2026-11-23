// Corrida order de prueba-gelsa (G5): una operación que encarga una activación HTTP y la deja esperando
// (`awaitingSince`, `awaits: acknowledgement`) confirma la espera ANTES de llamar, así que el controlador la despacha sin
// transacción abarcadora. La decisión y la nota son de keel-core (`gen/outbound-boundary.js`); aquí se mira que keel-nest
// la aplique en las mismas operaciones que keel-spring y con la misma nota. Silueta: la retirada de catalog-extended
// pasada a `acknowledgement`, como en `keel-spring/test/outbound-boundary.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function filesOf(plan, fixture, mutate = () => {}) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  mutate(patched);
  const { files } = plan({ manifest, layers: patched, workspace: FIXTURES_DIR });
  return files.map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
}

/** La línea del controlador que despacha el mensaje de la operación (lo construye su lector, `read<Mensaje>`). */
function dispatchLine(files, messageClass) {
  const line = files
    .filter((f) => /\/rest\/controllers\//.test(f.path))
    .flatMap((f) => f.content.split('\n'))
    .find((l) => l.includes('this.mediator.') && l.includes(`(read${messageClass}(`));
  assert.ok(line, `ningún controlador despacha ${messageClass}`);
  return line;
}

const boundaryNote = (text) => text.match(/SIN TRANSACCIÓN ABARCADORA: el mediator despacha[^\n]*(?:\n\s*\*?[^\n]*?)*?que reconciliar/)?.[0].replace(/\s*\n\s*(\*|\/\/)\s*/g, ' ');

const acknowledged = (layers) => {
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaits = 'acknowledgement';
};

test('una activación HTTP que deja esperando se despacha sin transacción, con la nota de keel-spring', () => {
  const files = filesOf(planService, 'catalog-extended', acknowledged);
  assert.match(dispatchLine(files, 'RetireProductCommand'), /this\.mediator\.dispatchWithoutTransaction\(/);
  const controllers = files.filter((f) => /\/rest\/controllers\//.test(f.path)).map((f) => f.content).join('\n');
  assert.equal(controllers.split('this.mediator.dispatchWithoutTransaction(').length - 1, 1, 'solo retireProduct cambia');

  const handler = files.find((f) => f.path.endsWith('/retire-product-command-handler.ts')).content;
  assert.match(handler, /compliance\.recordWithdrawal \(marca recordWithdrawalAwaitingSince\)/);
  const spring = filesOf(planSpring, 'catalog-extended', acknowledged).find((f) => f.path.endsWith('/RetireProductCommandHandler.java')).content;
  const nest = boundaryNote(handler);
  assert.ok(nest, 'el handler de keel-nest lleva la nota');
  assert.equal(nest, boundaryNote(spring), 'la misma nota que keel-spring');
});

for (const [fixture, messageClass, handlerFile] of [
  ['catalog-extended', 'RetireProductCommand', 'retire-product-command-handler.ts'],
  ['asset-vault', 'PublishAssetCommand', 'publish-asset-command-handler.ts'],
  ['stock-reservation', 'ConfirmReservationCommand', 'confirm-reservation-command-handler.ts']
]) {
  test(`${fixture}: ${messageClass} (awaits: outcome o activación publicada) conserva la transacción única`, () => {
    const files = filesOf(planService, fixture);
    assert.match(dispatchLine(files, messageClass), /this\.mediator\.dispatch\(/);
    const handler = files.find((f) => f.path.endsWith(`/${handlerFile}`))?.content;
    assert.ok(handler, handlerFile);
    assert.doesNotMatch(handler, /SIN TRANSACCIÓN ABARCADORA: el mediator/);
  });
}
