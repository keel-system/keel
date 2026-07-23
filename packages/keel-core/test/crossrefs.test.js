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

// --- M2M: audience ↔ reglas de acceso, serviceAuth y serviceClients ---

const domainForM2m = () => ({ entities: { Product: entity() } });
const useCasesForM2m = () => ({
  operations: {
    getProduct: { kind: 'query' },
    getProductPrice: { kind: 'query' },
  },
});

const m2mLayers = (apiOverrides = {}, securityOverrides = {}) => ({
  domain: domainForM2m(),
  'use-cases': useCasesForM2m(),
  api: {
    endpoints: {
      getProduct: { method: 'GET', path: '/products/{id}' },
      getProductPrice: { method: 'GET', path: '/products/{id}/price', audience: 'services' },
    },
    ...apiOverrides,
  },
  security: {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'client-credentials', validateAudience: true },
    },
    permissions: { 'product:read': { description: 'Leer productos y precios' } },
    serviceClients: {
      'billing-service': { description: 'Consulta precios para facturar', scopes: ['product:read'] },
    },
    access: {
      default: { level: 'public' },
      rules: {
        getProductPrice: { level: 'service', scopes: ['product:read'] },
      },
    },
    ...securityOverrides,
  },
});

test('diseño M2M bien formado no produce errores ni warnings', () => {
  const { errors, warnings } = run(m2mLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('api + security sin campos M2M sigue validando limpio (retrocompatibilidad)', () => {
  const layers = {
    domain: domainForM2m(),
    'use-cases': useCasesForM2m(),
    api: {
      endpoints: {
        getProduct: { method: 'GET', path: '/products/{id}' },
        getProductPrice: { method: 'GET', path: '/products/{id}/price' },
      },
    },
    security: {
      authentication: { protocol: 'oidc' },
      access: { default: { level: 'required' } },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('level service sobre endpoint audience users es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'users';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`access.rules.getProductPrice: level 'service' pero el endpoint de la operación es audience 'users'`)
    )
  );
});

test('level service sobre endpoint audience both es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'both';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`access.rules.getProductPrice: level 'service' en un endpoint audience 'both' excluiría a los usuarios`)
    )
  );
});

test('endpoint audience services con regla level required es error', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice = { level: 'required' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: endpoints.getProductPrice: audience 'services' pero su regla de acceso (access.rules.getProductPrice) es level 'required'`)
    )
  );
});

test('endpoint audience services cuya regla efectiva es un default humano es error', () => {
  const layers = m2mLayers();
  delete layers.security.access.rules;
  layers.security.access.default = { level: 'required' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: endpoints.getProductPrice: audience 'services' pero su regla de acceso (access.default) es level 'required'`)
    )
  );
});

test('scope inexistente en una regla de acceso es error', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice.scopes = ['price:read'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProductPrice: el scope 'price:read' no existe en security: permissions`)
    )
  );
});

test('scope inexistente en un serviceClient es error', () => {
  const layers = m2mLayers();
  layers.security.serviceClients['billing-service'].scopes = ['price:read'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: serviceClients.billing-service: el scope 'price:read' no existe en security: permissions`)
    )
  );
});

test('level service con roles es error', () => {
  const layers = m2mLayers();
  layers.security.roles = { admin: { description: 'Administrador del sistema' } };
  layers.security.access.rules.getProductPrice.roles = ['admin'];
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProductPrice: level 'service' no admite roles`)
    )
  );
});

test('scopes en una regla que ni es service ni cubre un endpoint both es error', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProduct.audience = 'users';
  layers.security.access.rules.getProduct = { level: 'required', scopes: ['product:read'] };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`security: access.rules.getProduct: declara scopes pero ni es level 'service' ni su endpoint es audience 'both'`)
    )
  );
});

test('endpoint audience both con required + scopes es válido', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'both';
  layers.security.access.rules.getProductPrice = { level: 'required', scopes: ['product:read'] };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

test('endpoints máquina sin serviceAuth es error', () => {
  const layers = m2mLayers();
  delete layers.security.authentication.serviceAuth;
  delete layers.security.serviceClients;
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`api: hay endpoints con audience 'services' o 'both' pero security: authentication no declara serviceAuth`)
    )
  );
});

test('serviceClients sin serviceAuth es error', () => {
  const layers = m2mLayers();
  delete layers.security.authentication.serviceAuth;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`security: serviceClients declarado sin authentication.serviceAuth`)));
});

test('serviceClients sin ningún endpoint máquina es warning', () => {
  const layers = m2mLayers();
  layers.api.endpoints.getProductPrice.audience = 'users';
  layers.security.access.rules.getProductPrice = { level: 'required' };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) => w.includes(`security: serviceClients declarado pero ningún endpoint es audience 'services' ni 'both'`))
  );
});

test('level service sin scopes es warning', () => {
  const layers = m2mLayers();
  delete layers.security.access.rules.getProductPrice.scopes;
  delete layers.security.serviceClients;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: access.rules.getProductPrice: level 'service' sin scopes`)
    )
  );
});

test('endpoint audience services con level public es warning', () => {
  const layers = m2mLayers();
  layers.security.access.rules.getProductPrice = { level: 'public' };
  delete layers.security.serviceClients;
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`api: endpoints.getProductPrice: audience 'services' con level 'public'`)
    )
  );
});

test('scope concedido a un serviceClient que ninguna regla exige es warning', () => {
  const layers = m2mLayers();
  layers.security.permissions['product:write'] = { description: 'Modificar productos' };
  layers.security.serviceClients['billing-service'].scopes.push('product:write');
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: serviceClients.billing-service: el scope 'product:write' no lo exige ninguna regla de acceso`)
    )
  );
});

test('scope exigido por una regla sin ningún serviceClient que lo tenga es warning', () => {
  const layers = m2mLayers();
  layers.security.serviceClients['billing-service'].scopes = ['product:write'];
  layers.security.permissions['product:write'] = { description: 'Modificar productos' };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`security: el scope 'product:read' exigido por las reglas de acceso no está concedido a ningún serviceClient`)
    )
  );
});

test('defaultAudience services aplica a los endpoints derivados por auto', () => {
  const layers = m2mLayers({ auto: true, defaultAudience: 'services', endpoints: undefined });
  delete layers.api.endpoints;
  layers.security.access = {
    default: { level: 'service', scopes: ['product:read'] },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
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
