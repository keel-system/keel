// La frontera de keel-nest avanza en código: cada capa que todavía no genera se rechaza nombrando
// el incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas;
// cuando un incremento cubra una capa, su caso cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

test('capa storage (incremento 13g): se genera', () => {
  const manifest = manifestWith('domain', 'use-cases', 'api', 'storage');
  assert.deepEqual(checkSupportedFeatures(manifest, layersWith('domain', 'use-cases', 'api', 'storage')), { errors: [], warnings: [] });
});

test('capa payments (incremento 13): se genera; lo que la pasarela no cubre lo decide la matriz, no la frontera', () => {
  const manifest = manifestWith('domain', 'use-cases', 'api', 'persistence', 'payments');
  assert.deepEqual(checkSupportedFeatures(manifest, layersWith('domain', 'use-cases', 'api', 'persistence', 'payments')), { errors: [], warnings: [] });
});

test('capa mail (adelantada al 12e): se genera', () => {
  const manifest = manifestWith('domain', 'use-cases', 'persistence', 'mail');
  assert.deepEqual(checkSupportedFeatures(manifest, layersWith('domain', 'use-cases', 'persistence', 'mail')), { errors: [], warnings: [] });
});

test('capa security (incremento 8): se genera, también la identidad resuelta por varias credenciales (12e)', () => {
  const manifest = manifestWith('domain', 'use-cases', 'api', 'security');
  const plain = { ...layersWith('domain', 'use-cases', 'api'), security: { authentication: { protocol: 'oidc', callerIdentity: { field: 'tenant', from: { source: 'claim', name: 'sub' } } } } };
  assert.deepEqual(checkSupportedFeatures(manifest, plain), { errors: [], warnings: [] });
  const resolved = structuredClone(plain);
  resolved.security.authentication.callerIdentity.from = { source: 'serviceClient', resolvedBy: 'Application.credentialKeys' };
  assert.deepEqual(checkSupportedFeatures(manifest, resolved), { errors: [], warnings: [] });
});

test('capa messaging (incremento 9): se genera sobre la persistencia relacional, y no sin ella', () => {
  const withPersistence = manifestWith('domain', 'use-cases', 'persistence', 'messaging');
  assert.deepEqual(checkSupportedFeatures(withPersistence, layersWith('domain', 'use-cases', 'persistence', 'messaging')), { errors: [], warnings: [] });
  const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'messaging'), layersWith('domain', 'use-cases', 'messaging'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /messaging sin persistence/);
});

test('messaging: la identidad del emisor resuelta por varias credenciales se genera (12e)', () => {
  const manifest = manifestWith('domain', 'use-cases', 'persistence', 'messaging');
  const layers = {
    ...layersWith('domain', 'use-cases', 'persistence'),
    messaging: { subscriptions: { Requested: { identity: { field: 'app', from: { location: 'field', name: 'metadata.source' }, resolvedBy: 'Application.keys' } } } }
  };
  assert.deepEqual(checkSupportedFeatures(manifest, layers).errors, []);
});

test('el broker: los tres del catálogo se generan; uno que keel-nest no conoce se rechaza', () => {
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) assert.deepEqual(checkSupportedStack({ broker }).errors, [], broker);
  const { errors } = checkSupportedStack({ broker: 'pulsar' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broker: pulsar — .*rabbitmq, kafka, snssqs/);
});

test('dominio, casos de uso y API se generan sin aviso', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('lo que una operación declara y keel-nest no puede generar se avisa, nombrando la operación', () => {
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
  // Sin persistencia, la idempotencia no tiene dónde registrar la clave: se dice. El reloj y los reclamos se
  // generan (10b, 10c), así que un schedule no avisa; la caché, tampoco (13f).
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /createOrder declara idempotency, pero el diseño no tiene persistencia/);
  assert.ok(!warnings.join(' ').includes('purgeOld'));
  assert.ok(!warnings.join(' ').includes('getOrder'));
  assert.ok(!warnings.join('\n').includes('listOrders'));
});

test('las dos persistencias se generan enteras, con los almacenes del generador (incremento 12c)', () => {
  for (const model of ['relational', 'document']) {
    const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging', 'dependencies'), {
      domain: {},
      'use-cases': {
        operations: {
          sweep: { schedule: { cron: '*/5 * * * *' } },
          place: { idempotency: { keySource: 'client-key' } }
        }
      },
      persistence: { default: { model } },
      messaging: {},
      dependencies: { dependencies: { stock: { activations: { reserve: { reconciledBy: 'sweep' } } } } }
    });
    assert.deepEqual(errors, [], model);
    assert.deepEqual(warnings, [], model);
  }
});

test('la autoría de política se rechaza en los dos modelos: ningún adaptador estampa quién', () => {
  for (const model of ['relational', 'document']) {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), {
      domain: {},
      'use-cases': {},
      persistence: { default: { model }, audit: { authorship: 'all' } }
    });
    assert.equal(errors.length, 1, model);
    assert.match(errors[0], /persistence\.audit\.authorship: all .*authorship: declared/);
  }
  const declared = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), {
    domain: {},
    'use-cases': {},
    persistence: { audit: { authorship: 'declared' } }
  });
  assert.deepEqual(declared.errors, [], 'la autoría declarada es del dominio y se genera');
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

test('con persistencia, la idempotencia de petición se genera y no se avisa', () => {
  const { warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), {
    domain: {},
    'use-cases': { operations: { createOrder: { idempotency: { keySource: 'client-key' } } } },
    persistence: { default: { model: 'relational' } }
  });
  assert.deepEqual(warnings, []);
});

test('capas http-clients y dependencies (incrementos 11b y 11c): se generan; needs, oauth2 y los compuestos se rechazan', async () => {
  const { loadService } = await import('keel-core');
  const path = await import('node:path');
  const { FIXTURES_DIR } = await import('./helpers/workspace.js');
  const load = (name) => loadService(path.join(FIXTURES_DIR, name));

  // stock-reservation: la llamada, el barrido de reconciliación y la compensación se generan (11b y 11c).
  const stock = load('stock-reservation');
  assert.deepEqual(checkSupportedFeatures(stock.manifest, stock.layers), { errors: [], warnings: [] });

  // asset-vault y catalog-extended declaran needs (con réplica y lastKnown), que no tienen sujeto en la frontera.
  const vault = checkSupportedFeatures(load('asset-vault').manifest, load('asset-vault').layers);
  assert.ok(vault.errors.some((error) => /dependencies\.\w+\.needs/.test(error)), vault.errors.join(' | '));
  const extended = checkSupportedFeatures(load('catalog-extended').manifest, load('catalog-extended').layers);
  assert.ok(extended.errors.some((error) => /auth: oauth2-client-credentials/.test(error)), 'oauth2');
  // Ninguna fixture lleva un value object compuesto en una llamada: el caso es sintético.
  const composite = structuredClone(stock.layers);
  composite.domain.types.Money = { fields: { amount: { type: 'decimal' }, currency: { type: 'string' } } };
  composite['http-clients'].clients.inventory.calls.cancelStock.response.fields.refund = { type: 'Money' };
  const rejected = checkSupportedFeatures(stock.manifest, composite).errors;
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /calls\.cancelStock: refund es un value object compuesto/);
});
