// La frontera de keel-dotnet avanza en código: cada capa que todavía no genera se rechaza nombrando el
// incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas; cuando un
// incremento cubra una capa, su caso cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

for (const layer of ['persistence', 'security', 'messaging', 'http-clients', 'dependencies', 'storage', 'mail', 'payments']) {
  test(`capa ${layer}: se rechaza con el incremento que la trae`, () => {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', layer), layersWith('domain', 'use-cases', layer));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`capa ${layer}: .*incremento \\d+`));
  });
}

test('dominio y casos de uso se generan sin aviso; la API se acepta avisando de que llega en el incremento 5', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /capa api: .*aún no emite su código \(llega en el incremento 5/);
});

test('una operación con idempotency, schedule o cache se acepta avisando del incremento de su mecanismo', () => {
  const layers = layersWith('domain', 'use-cases');
  layers['use-cases'] = {
    operations: {
      createThing: { idempotency: { keySource: 'client-key' } },
      sweepThings: { schedule: { cron: '0 * * * * *' } },
      getThing: { cache: { ttlSeconds: 60 } },
      plain: {}
    }
  };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases'), layers);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /createThing declara idempotency .*incremento 10/);
  assert.match(warnings[1], /sweepThings declara schedule .*incremento 10/);
  assert.match(warnings[2], /getThing declara cache .*incremento 13/);
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.match(checkSupportedStack({ telemetry: 'otel' }).errors[0], /incremento 14/);
});
