import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';

const manifest = { keel: '2.3', service: { name: 'demo', version: '0.1.0' } };

test('el camino relacional con token en cabecera no produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    persistence: { default: { model: 'relational' } },
    security: { authentication: { protocol: 'oidc', tokenLocation: 'header' } }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('un diseño que no declara ninguna de las dos cosas tampoco produce nada', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, { persistence: {}, security: {} });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('un modelo de almacenamiento no relacional es error: keel-spring solo genera JPA', () => {
  for (const model of ['document', 'key-value']) {
    const { errors, warnings } = checkSupportedFeatures(manifest, {
      persistence: { default: { model } }
    });

    assert.equal(errors.length, 1, `${model} debería ser error`);
    assert.match(errors[0], /persistence\.default\.model/);
    assert.match(errors[0], new RegExp(model));
    assert.match(errors[0], /relacional/);
    assert.deepEqual(warnings, []);
  }
});

test('tokenLocation cookie es aviso, no error: se genera la cabecera y se dice', () => {
  const { errors, warnings } = checkSupportedFeatures(manifest, {
    security: { authentication: { protocol: 'oidc', tokenLocation: 'cookie' } }
  });

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tokenLocation: cookie/);
  assert.match(warnings[0], /Authorization/);
});
