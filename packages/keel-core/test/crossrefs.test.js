import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCrossRefs } from '../src/lib/crossrefs.js';

const entity = (fields = {}, extra = {}) => ({
  fields: { id: { type: 'uuid', id: true, generated: true }, ...fields },
  ...extra,
});

const baseDomain = () => ({
  entities: {
    Order: entity({}, { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }),
    OrderLine: entity(),
    Catalog: entity({}, { relations: { products: { entity: 'Product', cardinality: 'one-to-many' } } }),
    Product: entity(),
  },
  aggregates: {
    Order: { root: 'Order', entities: ['OrderLine'] },
    Catalog: { root: 'Catalog', entities: ['Product'] },
  },
});

const run = (layers, wip = false) => checkCrossRefs({ layers, wip });

test('agregados bien formados no producen errores ni warnings', () => {
  const { errors, warnings } = run({ domain: baseDomain(), 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('spec sin aggregates sigue validando limpio (retrocompatibilidad)', () => {
  const domain = baseDomain();
  delete domain.aggregates;
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('raíz inexistente es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.root = 'Pedido';
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`aggregates.Order.root: la entidad 'Pedido' no existe`)));
});

test('entidad interna inexistente es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.entities = ['Linea'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`aggregates.Order.entities: la entidad 'Linea' no existe`)));
});

test('entidad en dos agregados es error', () => {
  const domain = baseDomain();
  domain.aggregates.Catalog.entities = ['Product', 'OrderLine'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`la entidad 'OrderLine' pertenece a más de un agregado`)));
});

test('raíz repetida en su propio entities es error', () => {
  const domain = baseDomain();
  domain.aggregates.Order.entities = ['Order', 'OrderLine'];
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`la raíz 'Order' es miembro implícito`)));
});

test('entidad fuera de todo agregado es warning', () => {
  const domain = baseDomain();
  delete domain.aggregates.Catalog;
  domain.entities.Catalog.relations = {};
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`la entidad 'Catalog' no pertenece a ningún agregado`)));
  assert.ok(warnings.some((w) => w.includes(`la entidad 'Product' no pertenece a ningún agregado`)));
});

test('relación hacia entidad interna de otro agregado es warning', () => {
  const domain = baseDomain();
  domain.entities.Order.relations.line = { entity: 'Product', cardinality: 'many-to-one' };
  const { warnings } = run({ domain, 'use-cases': {} });
  assert.ok(
    warnings.some((w) =>
      w.includes(`Order.relations.line: apunta a 'Product', entidad interna del agregado 'Catalog'`)
    )
  );
});

test('relación hacia la raíz de otro agregado no avisa', () => {
  const domain = baseDomain();
  domain.entities.Product.relations = { catalog: { entity: 'Catalog', cardinality: 'many-to-one' } };
  const { warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(warnings, []);
});

test('per-aggregate sin aggregates declarados es error, incluso con --wip', () => {
  const domain = baseDomain();
  delete domain.aggregates;
  const layers = {
    domain,
    'use-cases': {},
    persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { transactionalBoundary: 'per-aggregate' } },
  };
  for (const wip of [false, true]) {
    const { errors } = run(layers, wip);
    assert.ok(errors.some((e) => e.includes(`'per-aggregate' exige que domain declare aggregates`)), `wip=${wip}`);
  }
});

test('per-aggregate con aggregates declarados es válido', () => {
  const layers = {
    domain: baseDomain(),
    'use-cases': {},
    persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { transactionalBoundary: 'per-aggregate' } },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

// --- storage: campos file ↔ buckets ---

const domainWithFile = (bucket = 'productImages') => ({
  entities: { Product: entity({ photo: { type: 'file', bucket } }) },
});

const storageLayer = (...bucketNames) => ({
  buckets: Object.fromEntries(bucketNames.map((name) => [name, { allowedContentTypes: ['image/png'] }])),
});

test('campo file cuyo bucket existe en storage no produce errores ni warnings', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage: storageLayer('productImages') };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo file con bucket inexistente en storage es error', () => {
  const layers = { domain: domainWithFile('otroBucket'), 'use-cases': {}, storage: storageLayer('productImages') };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`Product.fields.photo: el bucket 'otroBucket' no está en storage: buckets`)));
});

test('campo file sin capa storage es error (sin --wip)', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {} };
  const { errors, pending } = run(layers, false);
  assert.ok(errors.some((e) => e.includes(`el bucket 'productImages' no está en storage: buckets (no hay capa storage)`)));
  assert.deepEqual(pending, []);
});

test('campo file sin capa storage con --wip va a pending, no a errors', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {} };
  const { errors, pending } = run(layers, true);
  assert.deepEqual(errors, []);
  assert.ok(pending.some((p) => p.includes(`el bucket 'productImages' está pendiente de definir en storage`)));
});

test('bucket declarado sin ningún campo file que lo referencie es warning', () => {
  const layers = { domain: domainWithFile('productImages'), 'use-cases': {}, storage: storageLayer('productImages', 'invoices') };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`storage: buckets.invoices: bucket declarado pero sin ningún campo file`)));
});

// --- messaging: canales ↔ eventos/suscripciones ---

const domainForMessaging = () => ({ entities: { Product: entity() } });
const useCasesForMessaging = () => ({ operations: { retireProduct: { kind: 'command' } } });

test('evento y suscripción cuyo canal existe en channels no produce errores ni warnings', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {}, inventoryEvents: {} },
      publishing: { events: { ProductRetired: { channel: 'productEvents', payload: {} } } },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', channel: 'inventoryEvents', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('evento con canal inexistente en channels es error', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {} },
      publishing: { events: { ProductRetired: { channel: 'otroCanal', payload: {} } } },
    },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`messaging: publishing.events.ProductRetired.channel: el canal 'otroCanal' no está en messaging: channels`)
    )
  );
});

test('suscripción con canal inexistente en channels es error', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {} },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', channel: 'otroCanal', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`messaging: subscriptions.StockDepleted.channel: el canal 'otroCanal' no está en messaging: channels`)
    )
  );
});

test('canal declarado sin ningún evento o suscripción que lo referencie es warning', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      channels: { productEvents: {}, canalHuerfano: {} },
      publishing: { events: { ProductRetired: { channel: 'productEvents', payload: {} } } },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`messaging: channels.canalHuerfano: canal declarado pero sin ningún evento o suscripción que lo referencie`)
    )
  );
});

test('messaging sin channels ni channel sigue validando limpio (retrocompatibilidad)', () => {
  const layers = {
    domain: domainForMessaging(),
    'use-cases': useCasesForMessaging(),
    messaging: {
      publishing: { events: { ProductRetired: { payload: {} } } },
      subscriptions: {
        StockDepleted: { source: 'inventory-service', payload: {}, triggers: 'retireProduct' },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
