// Corrida order de prueba-gelsa (G5): `createOrder` encarga `chargeOrder` (HTTP, awaitingSince, acknowledgement) y
// tiene que confirmar la espera ANTES de llamar; el agente cambió a mano el controller a dispatchWithoutTransaction.
// Ninguna fixture tiene esa forma: la silueta es la retirada de catalog-extended (HTTP, con awaitingSince) pasada a
// `awaits: acknowledgement`. Con `awaits: outcome` (la fixture tal cual, y publishAsset de asset-vault) y con una
// activación publicada (confirmReservation de stock-reservation) la transacción única sigue.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function filesOf(fixture, mutate = () => {}) {
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  mutate(patched);
  const { files } = planService({ manifest, layers: patched, workspace: FIXTURES_DIR });
  return files.map((f) => ({ path: f.path.split(path.sep).join('/'), content: f.content }));
}

/** La línea del controller que despacha el mensaje de la operación. */
function dispatchLine(files, messageClass) {
  const line = files
    .filter((f) => /\/rest\/controllers\//.test(f.path))
    .flatMap((f) => f.content.split('\n'))
    .find((l) => l.includes(`mediator.`) && l.includes(`new ${messageClass}(`));
  assert.ok(line, `ningún controller despacha ${messageClass}`);
  return line;
}

const acknowledged = (layers) => {
  layers.dependencies.dependencies.compliance.activations.recordWithdrawal.awaits = 'acknowledgement';
};

test('una activación HTTP que deja esperando se despacha sin transacción y su handler dice por qué', () => {
  const files = filesOf('catalog-extended', acknowledged);
  assert.match(dispatchLine(files, 'RetireProductCommand'), /mediator\.dispatchWithoutTransaction\(/);
  const handler = files.find((f) => f.path.endsWith('/RetireProductCommandHandler.java')).content;
  assert.match(handler, /SIN TRANSACCIÓN ABARCADORA: el mediator despacha este caso de uso sin transacción/);
  assert.match(handler, /compliance\.recordWithdrawal \(marca recordWithdrawalAwaitingSince\)/);
  // Lo que no la dispara no cambia.
  const controllers = files.filter((f) => /\/rest\/controllers\//.test(f.path)).map((f) => f.content).join('\n');
  assert.equal(controllers.split('mediator.dispatchWithoutTransaction(').length - 1, 1, 'solo retireProduct cambia');
});

for (const [fixture, messageClass] of [
  ['catalog-extended', 'RetireProductCommand'],
  ['asset-vault', 'PublishAssetCommand'],
  ['stock-reservation', 'ConfirmReservationCommand']
]) {
  test(`${fixture}: ${messageClass} (awaits: outcome o activación publicada) conserva la transacción única`, () => {
    const files = filesOf(fixture);
    assert.match(dispatchLine(files, messageClass), /mediator\.dispatch\(/);
    const handler = files.find((f) => f.path.endsWith(`/${messageClass}Handler.java`)).content;
    assert.doesNotMatch(handler, /SIN TRANSACCIÓN ABARCADORA: el mediator/);
  });
}
