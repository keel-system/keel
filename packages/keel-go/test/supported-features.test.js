// La frontera de keel-go avanza en código: cada capa que todavía no genera se rechaza nombrando el
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

test('dominio, casos de uso y API se aceptan sin avisos: la API se emite desde el incremento 5', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('una operación con idempotency, schedule o cache avisa nombrándola: sale el handler, no el mecanismo', () => {
  const layers = layersWith('domain', 'api');
  layers['use-cases'] = { operations: { pay: { idempotency: {} }, sweep: { schedule: {} }, find: { cache: {} }, plain: {} } };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layers);
  assert.deepEqual(errors, []);
  assert.match(warnings.find((w) => w.includes('idempotency')), /^use-cases: pay declara idempotency .*incremento 10/);
  assert.match(warnings.find((w) => w.includes('schedule (')), /^use-cases: sweep declara schedule .*incremento 10/);
  assert.match(warnings.find((w) => w.includes('cache (')), /^use-cases: find declara cache .*incremento 13/);
  assert.ok(!warnings.some((w) => w.includes('plain')));
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.match(checkSupportedStack({ telemetry: 'otel' }).errors[0], /incremento 14/);
});
