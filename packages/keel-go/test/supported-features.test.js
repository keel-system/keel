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

for (const layer of ['security', 'messaging', 'http-clients', 'dependencies', 'storage', 'mail', 'payments']) {
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
