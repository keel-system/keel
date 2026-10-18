// La mensajería sin persistencia la rechazan los TRES generadores con el mismo motivo (keel-core/gen/messaging-frontier.js):
// sin adaptador de repositorio nadie publicaría los eventos del agregado. Lo midió el incremento 16 de keel-dotnet, y la
// comparación de los tres vive en keel-dotnet/test/messaging-frontier.test.js (keel-core no importa de los generadores).

import test from 'node:test';
import assert from 'node:assert/strict';
import { messagingWithoutPersistenceErrors } from '../src/lib/gen/messaging-frontier.js';

const manifestOf = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const MESSAGING = { publishing: { reliability: 'best-effort', events: { Paid: { payload: 'Payment' } } } };

test('sin persistencia, la mensajería se rechaza; con ella, o sin mensajería, no', () => {
  assert.equal(messagingWithoutPersistenceErrors(manifestOf('domain', 'messaging'), { messaging: MESSAGING }, 'x').length, 1);
  assert.deepEqual(messagingWithoutPersistenceErrors(manifestOf('domain', 'messaging', 'persistence'), { messaging: MESSAGING, persistence: {} }, 'x'), []);
  assert.deepEqual(messagingWithoutPersistenceErrors(manifestOf('domain'), {}, 'x'), []);
});
