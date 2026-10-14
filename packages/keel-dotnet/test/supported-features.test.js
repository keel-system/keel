// La frontera de keel-dotnet avanza en código: cada capa que todavía no genera se rechaza nombrando el
// incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas; cuando un
// incremento cubra una capa, su caso cambia de bando aquí.

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

test('la persistencia relacional se genera (incremento 6); la documental se rechaza con el incremento 12', () => {
  const relational = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), { ...layersWith('domain', 'use-cases'), persistence: { default: { model: 'relational' } } });
  assert.deepEqual(relational.errors, []);
  const document = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), { ...layersWith('domain', 'use-cases'), persistence: { default: { model: 'document' } } });
  assert.equal(document.errors.length, 1);
  assert.match(document.errors[0], /model: document .*incremento 12/);
});

test('el motor relacional: PostgreSQL entra; cualquier otro se rechaza hasta que una red lo mida', () => {
  assert.deepEqual(checkSupportedStack({ database: 'postgresql' }).errors, []);
  for (const database of ['mysql', 'mariadb', 'sqlserver', 'oracle']) {
    const { errors } = checkSupportedStack({ database });
    assert.equal(errors.length, 1, database);
    assert.match(errors[0], new RegExp(`database: ${database} .*postgresql`));
  }
});

test('dominio, casos de uso y API se generan sin aviso (la API llegó en el incremento 5)', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
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
