// La frontera de keel-nest avanza en código: cada capa que todavía no genera se rechaza nombrando
// el incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas;
// cuando un incremento cubra una capa, su caso cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

for (const layer of ['security', 'messaging', 'http-clients', 'dependencies', 'storage', 'mail', 'payments']) {
  test(`capa ${layer}: se rechaza con el incremento que la trae`, () => {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', layer), layersWith('domain', 'use-cases', layer));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`capa ${layer}: .*incremento \\d+`));
  });
}

test('dominio, casos de uso y API se generan sin aviso', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('lo que una operación declara y cuelga de un incremento futuro se avisa, nombrando operación e incremento', () => {
  const layers = {
    domain: {},
    'use-cases': {
      operations: {
        createOrder: { idempotency: { keySource: 'client-key' } },
        purgeOld: { schedule: { cron: '0 3 * * *' } },
        getOrder: { cache: { ttlSeconds: 60 } },
        listOrders: {}
      }
    }
  };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases'), layers);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /createOrder declara idempotency .*incremento 10/);
  assert.match(warnings[1], /purgeOld declara schedule .*incremento 10/);
  assert.match(warnings[2], /getOrder declara cache .*incremento 13/);
  assert.ok(!warnings.join('\n').includes('listOrders'));
});

test('la persistencia relacional se genera; la documental se rechaza con el incremento que la trae', () => {
  const relational = checkSupportedFeatures(
    manifestWith('domain', 'use-cases', 'persistence'),
    { domain: {}, 'use-cases': {}, persistence: { default: { model: 'relational' } } }
  );
  assert.deepEqual(relational.errors, []);
  assert.deepEqual(relational.warnings, []);
  const document = checkSupportedFeatures(
    manifestWith('domain', 'use-cases', 'persistence'),
    { domain: {}, 'use-cases': {}, persistence: { default: { model: 'document' } } }
  );
  assert.equal(document.errors.length, 1);
  assert.match(document.errors[0], /document .*incremento 12/);
});

test('un índice único condicionado se genera sin aviso (tramo 6c)', () => {
  const layers = {
    domain: {},
    'use-cases': {},
    persistence: { entities: { Template: { indexes: [{ fields: ['key'], unique: true, when: { field: 'status', equals: 'active' } }, ['key']] } } }
  };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('el motor: PostgreSQL y MySQL se generan; los demás del catálogo se rechazan nombrándolos', () => {
  assert.deepEqual(checkSupportedStack({ database: 'postgresql' }).errors, []);
  assert.deepEqual(checkSupportedStack({ database: 'mysql' }).errors, []);
  assert.match(checkSupportedStack({ database: 'oracle' }).errors[0], /database: oracle .*postgresql y mysql/);
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.match(checkSupportedStack({ telemetry: 'otel' }).errors[0], /incremento 14/);
});
