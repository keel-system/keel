// La frontera de keel-dotnet avanza en código: cada capa que todavía no genera se rechaza nombrando el
// incremento que la trae, y las que acepta sin emitir se avisan. Este test fija las dos listas; cuando un
// incremento cubra una capa, su caso cambia de bando aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupportedFeatures, checkSupportedStack } from '../src/lib/supported-features.js';

const manifestWith = (...layers) => ({ layers: Object.fromEntries(layers.map((layer) => [layer, `${layer}.keel.yaml`])) });
const layersWith = (...layers) => Object.fromEntries(layers.map((layer) => [layer, {}]));

for (const layer of ['storage']) {
  test(`capa ${layer}: se rechaza con el incremento que la trae`, () => {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', layer), layersWith('domain', 'use-cases', layer));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(`capa ${layer}: .*incremento \\d+`));
  });
}

test('capa payments: se genera (incremento 13, como en keel-nest)', () => {
  const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'payments'), layersWith('domain', 'use-cases', 'payments'));
  assert.deepEqual(errors, []);
});

test('capa mail: se genera (adelantada al incremento 12e, como en keel-nest)', () => {
  const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'mail'), layersWith('domain', 'use-cases', 'mail'));
  assert.deepEqual(errors, []);
});

test('los clientes salientes y las activaciones se generan (incremento 11); needs, oauth2 y el compuesto en una llamada se rechazan con su incremento', () => {
  const layers = ['domain', 'use-cases', 'http-clients', 'dependencies'];
  const call = { method: 'GET', path: '/p/{sku}', request: { pathParams: { sku: { type: 'string', required: true } } }, response: { fields: { price: { type: 'decimal' } } } };
  const base = {
    ...layersWith('domain', 'use-cases'),
    domain: { types: { Money: { fields: { amount: { type: 'decimal' } } } } },
    'http-clients': { clients: { pricing: { calls: { getPrice: call } } } },
    dependencies: { dependencies: { pricing: { activations: { quote: { triggeredBy: ['x'], via: { client: 'pricing', call: 'getPrice' } } } } } }
  };
  assert.deepEqual(checkSupportedFeatures(manifestWith(...layers), base), { errors: [], warnings: [] });

  const needs = structuredClone(base);
  needs.dependencies.dependencies.pricing.needs = { price: { strategy: 'on-demand' } };
  assert.match(checkSupportedFeatures(manifestWith(...layers), needs).errors.join('\n'), /dependencies\.pricing\.needs \(price\) .*incremento 13/);

  const oauth = structuredClone(base);
  oauth['http-clients'].clients.pricing.auth = { type: 'oauth2-client-credentials', tokenUrl: 'https://auth/token' };
  assert.match(checkSupportedFeatures(manifestWith(...layers), oauth).errors.join('\n'), /pricing\.auth: oauth2-client-credentials .*incremento 13/);

  const inBody = structuredClone(base);
  inBody['http-clients'].clients.pricing.calls.getPrice.response.fields.price = { type: 'Money' };
  assert.match(checkSupportedFeatures(manifestWith(...layers), inBody).errors.join('\n'), /getPrice: price es un value object compuesto en el cuerpo o en la respuesta .*incremento 13/);

  // En la URL, el rechazo NEUTRAL: el mismo mensaje que keel-spring y keel-nest.
  const inPath = structuredClone(base);
  inPath['http-clients'].clients.pricing.calls.getPrice.request.pathParams.sku = { type: 'Money' };
  assert.match(checkSupportedFeatures(manifestWith(...layers), inPath).errors.join('\n'), /getPrice: sku es un value object compuesto en la ruta, la query o una cabecera.*keel-dotnet/);

  // La reconciliación y la compensación se generan (11c): ni error ni aviso.
  const swept = structuredClone(base);
  swept.dependencies.dependencies.pricing.activations.quote.reconciledBy = 'sweep';
  swept.dependencies.dependencies.pricing.compensations = [{ onEvent: 'Rejected', undoes: 'quote' }];
  assert.deepEqual(checkSupportedFeatures(manifestWith(...layers), swept), { errors: [], warnings: [] });
});

test('la persistencia relacional (incremento 6) y la documental (12b) se generan', () => {
  for (const model of ['relational', 'document']) {
    const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence'), { ...layersWith('domain', 'use-cases'), persistence: { default: { model } } });
    assert.deepEqual(errors, [], model);
    // Con el arnés documental (12d), tampoco hay nada que avisar.
    assert.deepEqual(warnings, [], model);
  }
});

test('sobre documentos, lo que guarda su estado en una colección del generador se genera (incremento 12c), igual que sobre la relacional', () => {
  const layers = {
    ...layersWith('domain', 'use-cases', 'messaging'),
    persistence: { default: { model: 'document' } },
    'use-cases': {
      operations: {
        sweep: { schedule: { cron: '0 * * * * *' } },
        create: { idempotency: { keySource: 'client-key' } },
        upsert: { idempotency: { guard: 'natural-key' } }
      }
    },
    dependencies: { dependencies: { pricing: { activations: { quote: { reconciledBy: 'sweep' } } } } }
  };
  for (const model of ['document', 'relational']) {
    const { errors } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging', 'dependencies'), { ...layers, persistence: { default: { model } } });
    assert.deepEqual(errors, [], model);
  }
});

test('la mensajería se genera sobre persistencia relacional con los tres brokers (incremento 9); sin persistencia se rechaza', () => {
  const layers = { ...layersWith('domain', 'use-cases', 'messaging'), persistence: { default: { model: 'relational' } } };
  assert.deepEqual(checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging'), layers).errors, []);
  const bare = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'messaging'), layersWith('domain', 'use-cases', 'messaging'));
  assert.equal(bare.errors.length, 1);
  assert.match(bare.errors[0], /capa messaging sin persistence/);
  const resolved = { ...layers, messaging: { subscriptions: { Paid: { identity: { resolvedBy: { entity: 'Merchant' } } } } } };
  // La identidad del emisor resuelta contra las credenciales de un recurso se genera desde el 12e (el finder).
  assert.deepEqual(checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging'), resolved).errors, []);
  const caller = { ...layers, security: { authentication: { callerIdentity: { field: 'merchantKey', from: { resolvedBy: { entity: 'Merchant', field: 'keys' } } } } } };
  assert.deepEqual(checkSupportedFeatures(manifestWith('domain', 'use-cases', 'persistence', 'messaging', 'security'), caller).errors, []);
  for (const broker of ['rabbitmq', 'kafka', 'snssqs']) assert.deepEqual(checkSupportedStack({ broker }).errors, [], broker);
  assert.match(checkSupportedStack({ broker: 'pulsar' }).errors[0], /broker: pulsar .*rabbitmq/);
});

test('el motor: PostgreSQL y MongoDB entran; cualquier otro se rechaza hasta que una red lo mida', () => {
  assert.deepEqual(checkSupportedStack({ database: 'postgresql' }).errors, []);
  assert.deepEqual(checkSupportedStack({ database: 'mongodb' }).errors, []);
  for (const database of ['mysql', 'mariadb', 'sqlserver', 'oracle']) {
    const { errors } = checkSupportedStack({ database });
    assert.equal(errors.length, 1, database);
    assert.match(errors[0], new RegExp(`database: ${database} .*postgresql, mongodb`));
  }
});

test('dominio, casos de uso y API se generan sin aviso (la API llegó en el incremento 5)', () => {
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases', 'api'), layersWith('domain', 'use-cases', 'api'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('una operación con idempotency sin persistencia se acepta avisando del incremento de su mecanismo; el reloj y la caché ya no avisan', () => {
  const layers = layersWith('domain', 'use-cases');
  layers['use-cases'] = {
    operations: {
      createThing: { idempotency: { keySource: 'client-key' } },
      // El reloj (10b) y el reclamo de su lote (10c) ya se generan: ni el barrido ni el cierre avisan.
      sweepThings: { schedule: { cron: '* * * * *' }, transitions: [{ entity: 'Thing', from: ['new'], to: 'taken' }] },
      closeDay: { schedule: { cron: '0 3 * * *' } },
      getThing: { cache: { ttlSeconds: 60 } },
      plain: {}
    }
  };
  const { errors, warnings } = checkSupportedFeatures(manifestWith('domain', 'use-cases'), layers);
  assert.deepEqual(errors, []);
  // La caché (13f) ya se genera: getThing no avisa.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /createThing declara idempotency .*incremento 10/);
});

test('la telemetría se rechaza en vez de estamparse sin efecto', () => {
  assert.deepEqual(checkSupportedStack({ telemetry: 'none' }).errors, []);
  assert.match(checkSupportedStack({ telemetry: 'otel' }).errors[0], /incremento 14/);
});
