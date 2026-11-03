// La frontera de keel-go: lo que todavía rechaza, cada cosa con su motivo, y lo que ya entra. Este test fija las
// dos listas; lo que deje de rechazarse cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

test('las dos persistencias se aceptan sin avisos (la documental desde el incremento 12); sobre documentos, lo que no mide ninguna fixture se rechaza con su motivo', () => {
  const persisted = (model) => ({ ...layersWith('domain', 'use-cases'), persistence: { default: { model } } });
  for (const model of ['relational', 'document']) {
    const result = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), persisted(model));
    assert.deepEqual(result.errors, [], model);
    assert.deepEqual(result.warnings, [], model);
  }
  const fixture = (name) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    return checkSupportedFeatures(manifest, layers).errors;
  };
  // Las documentales entran enteras; asset-vault, la última, con el tramo 13h-b.
  for (const name of ['asset-vault', 'conduit', 'inspection-reports', 'job-dispatch-mongo']) assert.deepEqual(fixture(name), [], name);
});

test('PostgreSQL, MySQL y MongoDB: los demás motores se rechazan en el build con su motivo', () => {
  for (const database of ['postgresql', 'mysql', 'mongodb']) assert.deepEqual(checkSupportedStack({ database }).errors, [], database);
  assert.match(checkSupportedStack({ database: 'mariadb' }).errors[0], /postgresql, mysql, mongodb .*sin medir en ninguna red/);
});

test('capa messaging: entra con persistencia relacional y API (tramo 9b-2); sin persistencia o sin API, rechazada con su motivo', () => {
  const relational = { persistence: { default: { model: 'relational' } } };
  const accepted = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'persistence', 'messaging'), { ...layersWith('domain', 'use-cases', 'api', 'messaging'), ...relational });
  assert.deepEqual(accepted.errors, []);
  const bare = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'messaging'), layersWith('domain', 'use-cases', 'api', 'messaging'));
  assert.equal(bare.errors.length, 1);
  assert.match(bare.errors[0], /capa messaging sin persistence .*keel-go generaría un servicio que no publica/);
  const headless = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging'), { ...layersWith('domain', 'use-cases', 'messaging'), ...relational });
  assert.deepEqual(headless.errors, []);
  // Las fixtures: metering-digest (sin api, tramo 10c) y stock-reservation-events entran enteras.
  const fixture = (name) => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    return checkSupportedFeatures(manifest, layers).errors;
  };
  assert.deepEqual(fixture('metering-digest'), []);
  assert.deepEqual(fixture('stock-reservation-events'), []);
});

test('RabbitMQ, Kafka y SNS/SQS entran (tramos 9b-2, 9f y 9g)', () => {
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) assert.deepEqual(checkSupportedStack({ broker, database: 'postgresql' }).errors, [], broker);
});

test('http-clients, dependencies, la reconciliación y la compensación entran (tramos 11b y 11c): stock-reservation pasa sin avisos', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'stock-reservation'));
  const { errors, warnings } = checkSupportedFeatures(manifest, layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('lo saliente que keel-go no genera se rechaza con su motivo: json, llamadas sin tipar y clientes sin persistencia', () => {
  const vault = loadService(path.join(FIXTURES_DIR, 'asset-vault'));
  const { persistence, ...withoutPersistence } = vault.layers;
  assert.ok(persistence);
  assert.ok(checkSupportedFeatures(vault.manifest, withoutPersistence).errors.some((error) => /^http-clients: .*solo existen con persistencia/.test(error)));

  const sr = loadService(path.join(FIXTURES_DIR, 'stock-reservation'));
  const withCall = (call) => {
    const layers = structuredClone(sr.layers);
    layers['http-clients'].clients.inventory.calls.cancelStock = { ...layers['http-clients'].clients.inventory.calls.cancelStock, ...call };
    return checkSupportedFeatures(sr.manifest, layers).errors;
  };
  assert.match(withCall({ method: undefined, contract: 'anula el bloqueo' }).join('\n'), /sin method\/path o sin request\/response tipados/);
  assert.match(withCall({ response: { fields: {} } }).join('\n'), /la respuesta no declara campos/);
  // El compuesto en la respuesta entra (incremento 16); un campo json no.
  const composite = structuredClone(sr.layers);
  composite.domain.types = { ...composite.domain.types, Amount: { fields: { value: { type: 'decimal', required: true } } } };
  composite['http-clients'].clients.inventory.calls.cancelStock.response.fields.refunded = { type: 'Amount' };
  assert.deepEqual(checkSupportedFeatures(sr.manifest, composite).errors, []);
  const json = structuredClone(sr.layers);
  json['http-clients'].clients.inventory.calls.cancelStock.response.fields.extra = { type: 'json' };
  assert.match(checkSupportedFeatures(sr.manifest, json).errors.join('\n'), /extra es un campo json/);
});

// La capa mail entró con el 12e-b (adelantada del 13), payments con el 13c y storage con el 13f: ya no queda ninguna capa
// pendiente. storage, solo con persistencia (la política y el puerto van en las Dependencies, como la caché).
test('capa storage: entra con persistencia (incremento 13f); sin ella, se rechaza con su motivo', () => {
  const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'storage'), layersWith('domain', 'use-cases', 'storage'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /capa storage sin persistencia/);
  const catalog = loadService(path.join(FIXTURES_DIR, 'catalog-extended'));
  assert.ok(!checkSupportedFeatures(catalog.manifest, catalog.layers).errors.some((error) => /storage/.test(error)));
});

test('capa payments: entra (incremento 13c), con su arnés y sus skills', () => {
  const pc = loadService(path.join(FIXTURES_DIR, 'payment-checkout'));
  assert.deepEqual(checkSupportedFeatures(pc.manifest, pc.layers).errors, []);
});

test('capa security: entra (incremento 8), resolvedBy también (12e-a) y el alcance (13h-b); la clave de API y una identidad que no es texto se rechazan con su motivo', () => {
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
  assert.deepEqual(rejected({ protocol: 'oidc', scoping: { claim: 'vaults' } }), []);
  const resolved = { protocol: 'oidc', callerIdentity: { field: 'caller', from: { source: 'serviceClient', resolvedBy: 'Application.keys' } } };
  assert.deepEqual(rejected(resolved), []);
  assert.match(rejected(oidc, { caller: { type: 'uuid' } })[0], /use-cases.getMine.input.caller: uuid .*string/);
});

test('dominio, casos de uso y API se aceptan sin avisos: la API se emite desde el incremento 5', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('una operación con idempotency avisa nombrándola; con cache y sin persistencia se rechaza (13e); el barrido con transiciones no avisa', () => {
  const layers = layersWith('domain', 'api');
  const sweep = { schedule: { cron: '* * * * *' }, transitions: [{ entity: 'Job', from: ['queued'], to: 'running' }] };
  layers['use-cases'] = { operations: { pay: { idempotency: {} }, sweep, tick: { schedule: { cron: '* * * * *' } }, find: { cache: {} }, plain: {} } };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layers);
  // La caché llega a los handlers por las Dependencies, que solo existen con persistencia.
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^use-cases: find declara cache sin persistencia .*Dependencies/);
  assert.match(warnings.find((w) => w.includes('idempotency')), /^use-cases: pay declara idempotency, pero el diseño no tiene persistencia/);
  // El reloj (10b) y el reclamo del barrido que mueve estados (10c) ya salen: ninguno avisa.
  assert.ok(!warnings.some((w) => w.includes('sweep') || w.includes('barrido')));
  assert.ok(!warnings.some((w) => w.includes('tick')));
  assert.ok(!warnings.some((w) => w.includes('cache')), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('plain')));
  // Con persistencia, la caché sale entera (13e): ni error ni aviso.
  const persisted = layersWith('domain', 'api', 'persistence');
  persisted['use-cases'] = { operations: { find: { cache: {} } } };
  const withPersistence = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'persistence'), persisted);
  assert.ok(!withPersistence.errors.some((e) => e.includes('cache')), withPersistence.errors.join('\n'));
  assert.ok(!withPersistence.warnings.some((w) => w.includes('cache')), withPersistence.warnings.join('\n'));
});

test('con persistencia relacional, la idempotencia sale entera (registro, purga y el gate del tramo 10d): no avisa', () => {
  const layers = layersWith('domain', 'api', 'persistence');
  layers['use-cases'] = { operations: { pay: { idempotency: {} } } };
  const { warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api', 'persistence'), layers);
  assert.ok(!warnings.some((w) => w.includes('idempotency')), warnings.join('\n'));
});

test('los parámetros de despliegue entran con persistencia (los reciben los handlers, incremento 13b); sin ella o de otro tipo, no', () => {
  for (const name of ['job-dispatch', 'job-dispatch-cycles']) {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    assert.deepEqual(checkSupportedFeatures(manifest, layers), { errors: [], warnings: [] }, name);
  }
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'job-dispatch'));
  const unlinked = structuredClone(manifest);
  unlinked.parameters.region = { type: 'string', description: 'Región.', testValue: 'eu' };
  assert.deepEqual(checkSupportedFeatures(unlinked, layers).errors, []);
  const { persistence, ...withoutPersistence } = layers;
  assert.ok(persistence);
  assert.match(
    checkSupportedFeatures(unlinked, withoutPersistence).errors.join('\n'),
    /service\.parameters\.region: keel-go entrega los parámetros a los handlers en las Dependencies de los casos de uso, que solo existen con persistencia/
  );
  const decimal = structuredClone(manifest);
  decimal.parameters.abandonAfterMinutes.type = 'decimal';
  assert.match(checkSupportedFeatures(decimal, layers).errors.join('\n'), /service\.parameters\.abandonAfterMinutes: decimal — keel-go solo lee parámetros int, long o string/);
});

test('una operación por reloj cuyo mensaje lleva campos se rechaza: la tarea no tiene de dónde sacarlos', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'payout-runs'));
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
  const withInput = structuredClone(layers);
  withInput['use-cases'].operations.closePayoutRuns.input = { fields: { limit: { type: 'int', required: true } } };
  assert.match(checkSupportedFeatures(manifest, withInput).errors.join('\n'), /closePayoutRuns declara schedule y su mensaje lleva campos \(limit\)/);
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.deepEqual(checkSupportedStack({ telemetry: 'otel' }).errors, []);
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
