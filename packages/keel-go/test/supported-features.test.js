// La frontera de keel-go avanza en código: cada capa que todavía no genera se rechaza nombrando el
// incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas; cuando un
// incremento cubra una capa, su caso cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

test('la persistencia relacional se acepta sin avisos; la documental se rechaza con su incremento', () => {
  const persisted = (model) => ({ ...layersWith('domain', 'use-cases'), persistence: { default: { model } } });
  const relational = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), persisted('relational'));
  assert.deepEqual(relational.errors, []);
  assert.deepEqual(relational.warnings, []);
  const document = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), persisted('document'));
  assert.equal(document.errors.length, 1);
  assert.match(document.errors[0], /persistencia documental .*incremento 12/);
});

test('PostgreSQL y MySQL: los demás motores se rechazan en el build con su motivo', () => {
  assert.deepEqual(checkSupportedStack({ database: 'postgresql' }).errors, []);
  assert.deepEqual(checkSupportedStack({ database: 'mysql' }).errors, []);
  assert.match(checkSupportedStack({ database: 'mariadb' }).errors[0], /postgresql, mysql/);
  assert.match(checkSupportedStack({ database: 'mongodb' }).errors[0], /incremento 12/);
});

test('capa messaging: entra con persistencia relacional y API (tramo 9b-2); sin persistencia o sin API, rechazada con su motivo', () => {
  const relational = { persistence: { default: { model: 'relational' } } };
  const accepted = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'persistence', 'messaging'), { ...layersWith('domain', 'use-cases', 'api', 'messaging'), ...relational });
  assert.deepEqual(accepted.errors, []);
  const bare = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'messaging'), layersWith('domain', 'use-cases', 'api', 'messaging'));
  assert.equal(bare.errors.length, 1);
  assert.match(bare.errors[0], /capa messaging sin persistence .*keel-go generaría un servicio que no publica/);
  const headless = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging'), { ...layersWith('domain', 'use-cases', 'messaging'), ...relational });
  assert.equal(headless.errors.length, 1);
  assert.match(headless.errors[0], /capa messaging sin api .*incremento 10/);
  // Las fixtures: metering-digest (sin api) se rechaza; stock-reservation-events entra entera.
  const fixture = (name) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    return checkSupportedFeatures(manifest, layers).errors;
  };
  assert.ok(fixture('metering-digest').some((error) => /capa messaging sin api/.test(error)));
  assert.deepEqual(fixture('stock-reservation-events'), []);
});

test('RabbitMQ: Kafka y SNS/SQS se rechazan en el build con su tramo', () => {
  assert.deepEqual(checkSupportedStack({ broker: 'rabbitmq', database: 'postgresql' }).errors, []);
  assert.match(checkSupportedStack({ broker: 'kafka' }).errors[0], /broker: kafka .*tramo 9f/);
  assert.match(checkSupportedStack({ broker: 'snssqs' }).errors[0], /broker: snssqs .*tramo 9g/);
});

for (const layer of ['http-clients', 'dependencies', 'storage', 'mail', 'payments']) {
  test(`capa ${layer}: se rechaza con el incremento que la trae`, () => {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', layer), layersWith('domain', 'use-cases', layer));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`capa ${layer}: .*incremento \\d+`));
  });
}

test('capa security: entra (incremento 8); la clave de API, el alcance, resolvedBy y una identidad que no es texto se rechazan con su motivo', () => {
  const manifest = manifestWith('domain', 'use-cases', 'api', 'security');
  const withSecurity = (authentication, fields = {}) => ({
    ...layersWith('domain', 'api'),
    'use-cases': { operations: { getMine: { input: { fields } } } },
    security: { authentication }
  });
  const oidc = { protocol: 'oidc', callerIdentity: { field: 'caller', from: { source: 'claim', name: 'sub' } } };
  assert.deepEqual(checkSupportedFeatures(manifest, withSecurity(oidc, { caller: { type: 'string' } })).errors, []);
  assert.deepEqual(checkSupportedFeatures(manifest, withSecurity({ protocol: 'none' })).errors, []);
  const rejected = (authentication, fields) => checkSupportedFeatures(manifest, withSecurity(authentication, fields)).errors;
  assert.match(rejected({ protocol: 'api-key' })[0], /clave de API .*sin red que mida/);
  assert.match(rejected({ protocol: 'oidc', serviceAuth: { protocol: 'api-key' } })[0], /clave de API/);
  assert.match(rejected({ protocol: 'oidc', scoping: { claim: 'vaults' } })[0], /alcance por recurso .*asset-vault/);
  const resolved = { protocol: 'oidc', callerIdentity: { field: 'caller', from: { source: 'serviceClient', resolvedBy: 'Application.keys' } } };
  assert.match(rejected(resolved)[0], /resolvedBy\) .*incremento 13/);
  assert.match(rejected(oidc, { caller: { type: 'uuid' } })[0], /use-cases.getMine.input.caller: uuid .*string/);
});

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

test('con persistencia relacional, la idempotencia ya sale: solo avisa de la purga y del gate del incremento 10', () => {
  const layers = layersWith('domain', 'api', 'persistence');
  layers['use-cases'] = { operations: { pay: { idempotency: {} } } };
  const { warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'persistence'), layers);
  const warning = warnings.find((w) => w.includes('idempotency'));
  assert.match(warning, /^use-cases: pay declara idempotency; keel-go genera el registro, la firma del mensaje y la cabecera/);
  assert.match(warning, /purga .* check-idempotency\.sh .*incremento 10/);
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.match(checkSupportedStack({ telemetry: 'otel' }).errors[0], /incremento 14/);
});

test('la persistencia rechaza, con su motivo, el value object persistido con otro dentro o con un campo opcional', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'product-catalog'));
  const types = layers.domain.types;
  const nested = structuredClone(layers);
  nested.domain.types.Price = { description: 'Precio con su origen.', fields: { money: { type: 'Money', required: true }, source: { type: 'string', required: true } } };
  nested.domain.entities.Product.fields.price.type = 'Price';
  assert.match(checkSupportedFeatures(manifest, nested).errors.join('\n'), /Product\.price guarda Price, que lleva otro value object \(money\).*sin red/);
  const optional = structuredClone(layers);
  optional.domain.types.Money.fields.currency.required = false;
  assert.match(checkSupportedFeatures(manifest, optional).errors.join('\n'), /Product\.price guarda Money, que lleva un campo opcional \(currency\)/);
  assert.ok(types.Money, 'la fixture sigue declarando Money');
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
});
