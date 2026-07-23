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

// --- use-cases: exclude con dot-path (proyección de entidades hijas) ---

// Dominio con relación a hija en el mismo agregado (Order → lines → OrderLine), un campo
// escalar en la hija (costPrice) y un value object compuesto embebido (address → Address).
const domainForExclude = () => ({
  types: {
    Address: { fields: { zip: { type: 'string' }, city: { type: 'string' } } },
  },
  entities: {
    Order: entity(
      { internalNote: { type: 'string' }, address: { type: 'Address' } },
      { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }
    ),
    OrderLine: entity({ costPrice: { type: 'decimal' }, quantity: { type: 'int' } }),
  },
  aggregates: { Order: { root: 'Order', entities: ['OrderLine'] } },
});

const excludeLayers = (exclude) => ({
  domain: domainForExclude(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: { entity: 'Order' },
        output: { entity: 'Order', exclude },
      },
    },
  },
});

test('exclude plano de un campo existente es válido (retrocompatibilidad)', () => {
  const { errors, warnings } = run(excludeLayers(['internalNote']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude con dot-path hacia un campo de la entidad hija es válido', () => {
  const { errors, warnings } = run(excludeLayers(['lines.costPrice']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude con dot-path hacia un campo de un value object es válido', () => {
  const { errors, warnings } = run(excludeLayers(['address.zip']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('exclude de un campo terminal inexistente en la hija es error', () => {
  const { errors } = run(excludeLayers(['lines.nope']));
  assert.ok(
    errors.some((e) =>
      e.includes(`use-cases: getOrder.output.exclude 'lines.nope': el campo 'nope' no existe en la entidad 'OrderLine'`)
    )
  );
});

test('exclude cuyo segmento intermedio no es relación ni value object es error', () => {
  const { errors } = run(excludeLayers(['internalNote.foo']));
  assert.ok(
    errors.some((e) =>
      e.includes(
        `use-cases: getOrder.output.exclude 'internalNote.foo': el campo 'internalNote' de la entidad 'Order' no es una relación ni un value object anidable`
      )
    )
  );
});

test('exclude con dot-path que cruza a otro agregado es warning', () => {
  const domain = domainForExclude();
  // Segundo agregado con su raíz, alcanzable desde OrderLine por relación.
  domain.entities.Product = entity({ costPrice: { type: 'decimal' } });
  domain.entities.OrderLine.relations = { product: { entity: 'Product', cardinality: 'many-to-one' } };
  domain.aggregates.Catalog = { root: 'Product' };
  const layers = {
    domain,
    'use-cases': {
      operations: {
        getOrder: {
          description: 'Recupera un pedido por su id.',
          kind: 'query',
          internal: true,
          input: { entity: 'Order' },
          output: { entity: 'Order', exclude: ['lines.product.costPrice'] },
        },
      },
    },
  };
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`la relación 'product' apunta al agregado 'Catalog', que se serializa por id`)
    )
  );
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

// --- messaging: contrato de recepción de las suscripciones ---

const useCasesForContract = () => ({
  operations: {
    retireProduct: {
      kind: 'command',
      input: { fields: { productId: { type: 'uuid', required: true }, reason: { type: 'string' } } },
    },
  },
});

const contractLayers = (subOverrides = {}, channelOverrides = {}) => ({
  domain: domainForMessaging(),
  'use-cases': useCasesForContract(),
  messaging: {
    channels: { inventoryEvents: { external: true, ...channelOverrides } },
    subscriptions: {
      StockDepleted: {
        source: 'inventory-service',
        channel: 'inventoryEvents',
        contract: {
          envelope: 'wrapped',
          payloadPath: 'data',
          discriminator: { location: 'header', name: 'eventType', value: 'stock.depleted' },
          messageId: { location: 'header', name: 'messageId' },
        },
        payload: { productId: { type: 'uuid', required: true, wireName: 'product_id' } },
        triggers: 'retireProduct',
        ...subOverrides,
      },
    },
  },
});

test('suscripción con contrato de recepción completo no produce errores ni warnings', () => {
  const { errors, warnings } = run(contractLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo requerido del input de triggers que no llega en el payload es error', () => {
  const layers = contractLayers({ payload: { sku: { type: 'string', required: true } } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`el campo requerido 'productId' del input de 'retireProduct' no llega en el payload`)
    )
  );
});

test('input mapea el payload aunque los nombres difieran', () => {
  const layers = contractLayers({
    payload: { itemId: { type: 'uuid', required: true } },
    input: { productId: 'itemId' },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('input que mapea un campo inexistente en el payload es error', () => {
  const layers = contractLayers({ input: { productId: 'itemId' } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.input.productId: el campo 'itemId' no existe en el payload`)
    )
  );
});

test('input que mapea un campo que la operación no declara es error', () => {
  const layers = contractLayers({ input: { productCode: 'productId' } });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.input.productCode: la operación 'retireProduct' no declara ese campo`)
    )
  );
});

test('campo del payload que no alimenta el input de la operación es warning', () => {
  const layers = contractLayers({
    payload: {
      productId: { type: 'uuid', required: true },
      warehouseId: { type: 'uuid' },
    },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`subscriptions.StockDepleted.payload.warehouseId: no alimenta ningún campo del input`)
    )
  );
});

test('suscripción sobre canal external sin contract es warning', () => {
  const layers = contractLayers({ contract: undefined });
  delete layers.messaging.subscriptions.StockDepleted.contract;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`subscriptions.StockDepleted: consume del canal externo 'inventoryEvents' sin contract —`)
    )
  );
});

test('discriminator por campo inexistente en el payload es error sin envoltura', () => {
  const layers = contractLayers({
    contract: {
      envelope: 'none',
      discriminator: { location: 'field', name: 'eventType', value: 'stock.depleted' },
    },
  });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`subscriptions.StockDepleted.contract.discriminator: el campo 'eventType' no existe en el payload`)
    )
  );
});

test('discriminator por campo fuera del payload es warning con envelope wrapped', () => {
  const layers = contractLayers({
    contract: {
      envelope: 'wrapped',
      payloadPath: 'data',
      discriminator: { location: 'field', name: 'eventType', value: 'stock.depleted' },
    },
  });
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) =>
      w.includes(`contract.discriminator: el campo 'eventType' no está en payload — se asume que vive en la envoltura`)
    )
  );
});

test('publicar en un canal marcado external es warning', () => {
  const layers = contractLayers();
  layers.messaging.publishing = {
    events: { ProductRetired: { channel: 'inventoryEvents', payload: { productId: { type: 'uuid' } } } },
  };
  const { warnings } = run(layers);
  assert.ok(
    warnings.some((w) =>
      w.includes(`publishing.events.ProductRetired.channel: 'inventoryEvents' está marcado external`)
    )
  );
});

test('wireName en una capa interna es error', () => {
  const layers = {
    domain: { entities: { Product: entity({ sku: { type: 'string', wireName: 'product_sku' } }) } },
    'use-cases': {},
  };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`domain: Product.fields.sku: wireName solo es válido en contratos de sistemas externos`)
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

// --- http-clients: tipado de requests/responses y coherencia path ↔ pathParams ---

const domainForHttp = () => ({
  types: {
    Sku: { type: 'string' },
    Money: { type: 'decimal' },
  },
  entities: { Product: entity() },
});

const httpLayers = (call) => ({
  domain: domainForHttp(),
  'use-cases': {},
  'http-clients': {
    clients: {
      'pricing-service': { purpose: 'Precios vigentes por SKU', calls: { getPrice: call } },
    },
  },
});

test('llamada solo-prosa sigue validando limpio (retrocompatibilidad)', () => {
  const { errors, warnings } = run(httpLayers({ contract: 'GET /prices/{sku} -> { amount: decimal }' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('llamada estructurada bien formada no produce errores ni warnings', () => {
  const { errors, warnings } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices/{sku}',
      request: { pathParams: { sku: { type: 'Sku' } }, queryParams: { currency: { type: 'string' } } },
      response: { fields: { amount: { type: 'Money' } } },
    })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('tipo inexistente en response.fields es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices',
      response: { fields: { amount: { type: 'Price' } } },
    })
  );
  assert.ok(
    errors.some((e) =>
      e.includes(`http-clients: clients.pricing-service.calls.getPrice.response.fields.amount: el tipo 'Price' no existe en domain: types`)
    )
  );
});

test('tipo inexistente en request.body es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Autoriza un cobro',
      method: 'POST',
      path: '/charges',
      request: { body: { amount: { type: 'Importe' } } },
    })
  );
  assert.ok(
    errors.some((e) =>
      e.includes(`http-clients: clients.pricing-service.calls.getPrice.request.body.amount: el tipo 'Importe' no existe en domain: types`)
    )
  );
});

test('variable de path no declarada en pathParams es error', () => {
  const { errors } = run(
    httpLayers({
      contract: 'Precio vigente de un SKU',
      method: 'GET',
      path: '/prices/{sku}',
      request: { pathParams: { other: { type: 'string' } } },
    })
  );
  assert.ok(errors.some((e) => e.includes(`request.pathParams: la variable '{sku}' de path no está declarada`)));
  assert.ok(errors.some((e) => e.includes(`request.pathParams.other: no aparece como '{other}' en path`)));
});

test('path con variables sin request.pathParams es warning', () => {
  const { errors, warnings } = run(
    httpLayers({ contract: 'Precio vigente de un SKU', method: 'GET', path: '/prices/{sku}' })
  );
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`path con variables {…} sin request.pathParams`)));
});

test('response tipada sin method+path es warning', () => {
  const { warnings } = run(
    httpLayers({
      contract: 'GET /prices/{sku} -> { amount: decimal }',
      response: { fields: { amount: { type: 'Money' } } },
    })
  );
  assert.ok(
    warnings.some((w) => w.includes(`declara request/response tipados pero no method+path`))
  );
});

test('circuitBreaker sin fallback es warning y con fallback no', () => {
  const base = { contract: 'GET /prices -> lista de precios', method: 'GET', path: '/prices' };
  const sin = run(httpLayers({ ...base, circuitBreaker: { failureRateThreshold: 50 } }));
  assert.ok(sin.warnings.some((w) => w.includes(`circuitBreaker sin fallback`)));
  const con = run(httpLayers({ ...base, circuitBreaker: { failureRateThreshold: 50 }, fallback: 'usa el último precio cacheado' }));
  assert.ok(!con.warnings.some((w) => w.includes(`circuitBreaker sin fallback`)));
});

test('campo file en request con bucket inexistente es error', () => {
  const layers = httpLayers({
    contract: 'Sube el comprobante del cobro',
    method: 'POST',
    path: '/receipts',
    request: { body: { receipt: { type: 'file', bucket: 'receipts' } } },
  });
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) =>
      e.includes(`request.body.receipt: el bucket 'receipts' no está en storage: buckets (no hay capa storage)`)
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
