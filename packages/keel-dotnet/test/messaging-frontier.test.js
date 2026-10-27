// La mensajería sin persistencia: keel-spring y keel-nest la generaban y no publicaba (sin adaptador de repositorio nadie
// drena los eventos del agregado); el incremento 16 la rechaza en los TRES con el mismo motivo, el de
// keel-core/gen/messaging-frontier.js. Aquí, que los tres digan lo mismo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { messagingWithoutPersistenceErrors } from '@keel-system/keel-core/gen/messaging-frontier';
import { checkSupportedFeatures as spring } from '../../keel-spring/src/lib/supported-features.js';
import { checkSupportedFeatures as nest } from '../../keel-nest/src/lib/supported-features.js';
import { checkSupportedFeatures as dotnet } from '../src/lib/supported-features.js';

const manifestOf = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const MESSAGING = { publishing: { reliability: 'best-effort', events: { Paid: { payload: 'Payment' } } } };

test('los tres generadores lo rechazan con el MISMO mensaje, salvo su nombre', () => {
  const manifest = manifestOf('domain', 'use-cases', 'messaging');
  const layers = { domain: {}, 'use-cases': { operations: {} }, messaging: MESSAGING };
  const byGenerator = { 'keel-spring': spring, 'keel-nest': nest, 'keel-dotnet': dotnet };
  for (const [generator, check] of Object.entries(byGenerator)) {
    const expected = messagingWithoutPersistenceErrors(manifest, layers, generator)[0];
    assert.ok(check(manifest, layers).errors.includes(expected), `${generator} no lo rechaza con el mensaje neutral`);
  }
});
