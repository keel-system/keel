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

// --- persistence: consistency.optimisticLocking ---

const withLocking = (policy, domain = baseDomain()) => ({
  domain,
  'use-cases': {},
  persistence: { default: { model: 'relational' }, entities: { Order: {} }, consistency: { optimisticLocking: policy } },
});

test("optimisticLocking 'declared' sin ninguna raíz que declare lockVersion avisa: equivale a none", () => {
  const { errors, warnings } = run(withLocking('declared'));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("optimisticLocking: 'declared'") && w.includes('lockVersion')));
});

test("optimisticLocking 'declared' con una raíz que declara lockVersion valida limpio", () => {
  const domain = baseDomain();
  domain.entities.Order.fields.lockVersion = { type: 'integer' };
  const { errors, warnings } = run(withLocking('declared', domain));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("optimisticLocking 'all' y 'none' no exigen nada del dominio", () => {
  for (const policy of ['all', 'none']) {
    const { errors, warnings } = run(withLocking(policy));
    assert.deepEqual(errors, [], policy);
    assert.deepEqual(warnings, [], policy);
  }
});

// --- persistence: miembros de naturalKey e indexes → domain ---

// Order tiene un campo escalar, un value object compuesto (total → Money) y una hija;
// OrderLine apunta de vuelta a Order, que es la relación que se indexa.
const domainForPersistenceMembers = () => ({
  types: { Money: { fields: { amount: { type: 'decimal' }, currency: { type: 'string' } } } },
  entities: {
    Order: entity(
      { code: { type: 'string' }, total: { type: 'Money' } },
      { relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many' } } }
    ),
    OrderLine: entity(
      { position: { type: 'int' } },
      { relations: { order: { entity: 'Order', cardinality: 'many-to-one' } } }
    ),
  },
  aggregates: { Order: { root: 'Order', entities: ['OrderLine'] } },
});

const persistenceMembers = (entities) => ({
  domain: domainForPersistenceMembers(),
  'use-cases': {},
  persistence: { default: { model: 'relational' }, entities },
});

test('naturalKey e indexes sobre campos y value objects válidos no producen errores', () => {
  const { errors } = run(
    persistenceMembers({
      Order: { naturalKey: ['code'], indexes: [['code'], ['total.amount']] },
      OrderLine: { indexes: [['position']] },
    })
  );
  assert.deepEqual(errors, []);
});

test('una relación se admite por su nombre y con el sufijo Id indistintamente', () => {
  for (const member of ['order', 'orderId']) {
    const { errors } = run(persistenceMembers({ OrderLine: { indexes: [[member, 'position']] } }));
    assert.deepEqual(errors, [], `miembro '${member}'`);
  }
});

test('un miembro de indexes que no existe en la entidad es error', () => {
  const { errors } = run(persistenceMembers({ OrderLine: { indexes: [['postion']] } }));
  assert.ok(
    errors.some((e) => e.includes(`entities.OrderLine.indexes: 'postion' no es un campo ni una relación`)),
    errors.join('\n')
  );
});

test('un miembro de naturalKey que no existe en la entidad es error', () => {
  const { errors } = run(persistenceMembers({ Order: { naturalKey: ['slug'] } }));
  assert.ok(
    errors.some((e) => e.includes(`entities.Order.naturalKey: 'slug' no es un campo ni una relación`)),
    errors.join('\n')
  );
});

test('un dot-path sobre un campo que no es value type compuesto es error', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['code.amount']] } }));
  assert.ok(
    errors.some((e) => e.includes(`'code.amount': 'code' no es un value type compuesto`)),
    errors.join('\n')
  );
});

test('un subcampo inexistente del value object es error', () => {
  const { errors } = run(persistenceMembers({ Order: { indexes: [['total.importe']] } }));
  assert.ok(
    errors.some((e) => e.includes(`el tipo 'Money' no declara el campo 'importe'`)),
    errors.join('\n')
  );
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

// --- use-cases: embed (referencia a otro agregado proyectada como objeto) ---

// Order (agregado propio) → customer, la raíz de otro agregado; y lines, hija
// del propio agregado.
const domainForEmbed = () => ({
  entities: {
    Order: entity(
      {},
      {
        relations: {
          lines: { entity: 'OrderLine', cardinality: 'one-to-many' },
          customer: { entity: 'Customer', cardinality: 'many-to-one' },
        },
      }
    ),
    OrderLine: entity(),
    Customer: entity({ name: { type: 'string' } }, { relations: { referrer: { entity: 'Customer', cardinality: 'many-to-one' } } }),
  },
  aggregates: {
    Order: { root: 'Order', entities: ['OrderLine'] },
    Customer: { root: 'Customer' },
  },
});

const embedLayers = (embed, { direction = 'output' } = {}) => ({
  domain: domainForEmbed(),
  'use-cases': {
    operations: {
      getOrder: {
        description: 'Recupera un pedido por su id.',
        kind: 'query',
        internal: true,
        input: direction === 'input' ? { entity: 'Order', embed } : { entity: 'Order' },
        output: direction === 'output' ? { entity: 'Order', embed } : { entity: 'Order' },
      },
    },
  },
});

test('embed de una relación hacia la raíz de otro agregado es válido', () => {
  const { errors, warnings } = run(embedLayers(['customer']));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('embed de una auto-referencia es válido: apunta a otra instancia, su propio agregado', () => {
  const layers = embedLayers([]);
  layers['use-cases'].operations.getCustomer = {
    description: 'Recupera un cliente por su id.',
    kind: 'query',
    internal: true,
    input: { entity: 'Customer' },
    output: { entity: 'Customer', embed: ['referrer'] },
  };
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

test('embed de una relación inexistente es error', () => {
  const { errors } = run(embedLayers(['nope']));
  assert.ok(errors.some((e) => e.includes(`getOrder.output.embed 'nope': la entidad 'Order' no declara esa relación`)));
});

test('embed de una entidad hija del propio agregado es error: ya se proyecta anidada', () => {
  const { errors } = run(embedLayers(['lines']));
  assert.ok(errors.some((e) => e.includes(`getOrder.output.embed 'lines': 'OrderLine' es una entidad interna del agregado 'Order'`)));
});

test('embed de una relación to-many hacia otro agregado es error', () => {
  const layers = embedLayers(['customer']);
  layers.domain.entities.Order.relations.customer.cardinality = 'one-to-many';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`solo se pueden embeber relaciones many-to-one/one-to-one`)));
});

test('embed en el input es error: en la entrada la referencia viaja por id', () => {
  const { errors } = run(embedLayers(['customer'], { direction: 'input' }));
  assert.ok(errors.some((e) => e.includes(`getOrder.input.embed 'customer': embed solo aplica al output`)));
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

// --- Cardinalidad en campos (DSL 2.1: list) ---

const domainForList = () => ({
  entities: { Product: entity({ name: { type: 'string' } }) },
  aggregates: { Catalog: { root: 'Product' } },
});

const batchLayers = (idsField) => ({
  domain: domainForList(),
  'use-cases': {
    operations: {
      getProductsByIds: {
        description: 'Resuelve varios productos por sus identificadores en una sola llamada.',
        kind: 'query',
        internal: true,
        input: { fields: { ids: idsField } },
        output: { entity: 'Product', list: true },
      },
    },
  },
});

test('campo list en el input de una operación es válido', () => {
  const { errors, warnings } = run(
    batchLayers({ type: 'uuid', list: true, required: true, constraints: { minItems: 1, maxItems: 100 } })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo list de escalar y de value object en una entidad es válido', () => {
  const domain = domainForList();
  domain.types = { Discount: { fields: { code: { type: 'string' }, percentage: { type: 'decimal' } } } };
  domain.entities.Product.fields.tags = { type: 'string', list: true };
  domain.entities.Product.fields.discounts = { type: 'Discount', list: true, constraints: { maxItems: 10 } };
  const { errors, warnings } = run({ domain, 'use-cases': {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('campo list de un tipo inexistente sigue siendo error de tipo', () => {
  const domain = domainForList();
  domain.entities.Product.fields.discounts = { type: 'Discount', list: true };
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(errors.some((e) => e.includes(`domain: Product.fields.discounts: el tipo 'Discount' no existe`)));
});

test('campo list dentro de un value object es error', () => {
  const domain = domainForList();
  domain.types = { Address: { fields: { zip: { type: 'string' }, lines: { type: 'string', list: true } } } };
  const { errors } = run({ domain, 'use-cases': {} });
  assert.ok(
    errors.some((e) =>
      e.includes(`domain: types.Address.fields.lines: list no es válido dentro de un value object`)
    )
  );
});

test('campo list en pathParams de un http-client es error', () => {
  const layers = {
    domain: domainForList(),
    'use-cases': {},
    'http-clients': {
      clients: {
        pricing: {
          baseUrl: 'https://pricing.example.com',
          calls: {
            getPrices: {
              contract: 'GET /prices/{sku} -> precio del producto',
              method: 'GET',
              path: '/prices/{sku}',
              request: { pathParams: { sku: { type: 'string', list: true } } },
            },
          },
        },
      },
    },
  };
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`request.pathParams.sku: list no es válido en pathParams`)));
});

test('minItems mayor que maxItems es error', () => {
  const { errors } = run(batchLayers({ type: 'uuid', list: true, constraints: { minItems: 10, maxItems: 5 } }));
  assert.ok(
    errors.some((e) => e.includes(`getProductsByIds.input.ids: minItems (10) no puede ser mayor que maxItems (5)`))
  );
});

// --- CORS: coherencia con la capa api y con tokenLocation ---

const corsLayers = (cors, securityOverrides = {}) => ({
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
    cors,
    ...securityOverrides,
  },
});

test('cors bien formado con capa api no produce errores ni warnings', () => {
  const { errors, warnings } = run(corsLayers({ description: 'Consumido por la SPA de back-office.' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('cors sin capa api es error', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.' });
  delete layers.api;
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('cors declarado sin capa api')));
});

test('cors con tokenLocation cookie y allowCredentials false es error', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.' });
  layers.security.authentication.tokenLocation = 'cookie';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('cors.allowCredentials debe ser true con tokenLocation cookie')));
});

test('cors con tokenLocation cookie y allowCredentials true es válido', () => {
  const layers = corsLayers({ description: 'Consumido por la SPA de back-office.', allowCredentials: true });
  layers.security.authentication.tokenLocation = 'cookie';
  const { errors } = run(layers);
  assert.deepEqual(errors, []);
});

// --- dependencies: qué otros servidores necesita este y cómo lee su dato ---

const depsLayers = () => ({
  domain: {
    entities: {
      Order: entity({ total: { type: 'decimal', required: true } }),
      ProductSnapshot: entity({
        productId: { type: 'uuid', required: true, unique: true },
        price: { type: 'decimal', required: true },
      }),
    },
  },
  'use-cases': {
    operations: {
      createOrder: {
        description: 'Crea un pedido a partir de los productos elegidos.',
        kind: 'command',
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: { entity: 'Order' },
        errors: [{ code: 'PRICE_UNAVAILABLE', when: 'No se conoce el precio vigente del producto.' }],
      },
      applyProductSnapshot: {
        description: 'Actualiza la copia local del producto con lo que informa catalog.',
        kind: 'command',
        internal: true,
        input: { fields: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } } },
        output: 'void',
      },
    },
  },
  api: { endpoints: { createOrder: { method: 'POST', path: '/orders' } } },
  security: { authentication: { protocol: 'oidc' }, access: { default: { level: 'required' } } },
  messaging: {
    subscriptions: {
      ProductUpdated: {
        source: 'catalog',
        payload: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } },
        triggers: 'applyProductSnapshot',
      },
    },
  },
  'http-clients': {
    clients: {
      catalog: {
        purpose: 'Resolver la información de productos al construir pedidos.',
        calls: { getProductsByIds: { contract: 'POST /internal/products/batch-get -> lista de productos.' } },
      },
    },
  },
  dependencies: {
    dependencies: {
      catalog: {
        description: 'Fuente de verdad de productos y precios.',
        contract: { version: '0.2.0' },
        needs: {
          productPricing: {
            description: 'Precio y estado del producto al construir un pedido.',
            usedBy: ['createOrder'],
            strategy: 'replicated',
            fetchedFrom: { client: 'catalog', call: 'getProductsByIds' },
            replica: {
              entity: 'ProductSnapshot',
              keyField: 'productId',
              fedBy: ['ProductUpdated'],
              onMiss: { action: 'fetch' },
            },
          },
        },
      },
    },
  },
  persistence: { default: { model: 'relational' }, entities: { Order: {}, ProductSnapshot: {} } },
});

const need = (layers) => layers.dependencies.dependencies.catalog.needs.productPricing;

test('dependencies coherente no produce errores ni warnings', () => {
  const { errors, warnings } = run(depsLayers());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('spec sin capa dependencies sigue validando limpio (retrocompatibilidad)', () => {
  const layers = depsLayers();
  delete layers.dependencies;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('usedBy hacia una operación inexistente es error', () => {
  const layers = depsLayers();
  need(layers).usedBy = ['repriceOrder'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`usedBy: la operación 'repriceOrder' no existe en use-cases`)));
});

test('fetchedFrom con cliente inexistente es error', () => {
  const layers = depsLayers();
  need(layers).fetchedFrom.client = 'pricing';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`fetchedFrom: el cliente 'pricing' no está en http-clients: clients`)));
});

test('fetchedFrom sin capa http-clients queda pendiente con --wip', () => {
  const layers = depsLayers();
  delete layers['http-clients'];
  const { errors, pending } = run(layers, true);
  assert.deepEqual(errors, []);
  assert.ok(pending.some((p) => p.includes(`fetchedFrom: el cliente 'catalog' está pendiente de definir`)));
});

test('fetchedFrom sin capa http-clients es error sin --wip', () => {
  const layers = depsLayers();
  delete layers['http-clients'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes('(no hay capa http-clients)')));
});

test('fetchedFrom con llamada inexistente es error', () => {
  const layers = depsLayers();
  need(layers).fetchedFrom.call = 'getProduct';
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`fetchedFrom: la llamada 'getProduct' no existe en http-clients: clients.catalog.calls`))
  );
});

test('replica hacia una entidad inexistente es error', () => {
  const layers = depsLayers();
  need(layers).replica.entity = 'ProductCopy';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`replica.entity: la entidad 'ProductCopy' no existe en domain: entities`)));
});

test('replica.keyField que no es campo de la entidad es error', () => {
  const layers = depsLayers();
  need(layers).replica.keyField = 'sku';
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`replica.keyField: el campo 'sku' no existe en la entidad 'ProductSnapshot'`)));
});

test('replica sin capa persistence es error incluso con --wip', () => {
  const layers = depsLayers();
  delete layers.persistence;
  const { errors } = run(layers, true);
  assert.ok(errors.some((e) => e.includes('replica: una copia local exige capa persistence')));
});

test('replica cuya entidad no está en persistence.entities es warning', () => {
  const layers = depsLayers();
  delete layers.persistence.entities.ProductSnapshot;
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`'ProductSnapshot' no aparece en persistence: entities`)));
});

test('replica.keyField sin unique es warning', () => {
  const layers = depsLayers();
  delete layers.domain.entities.ProductSnapshot.fields.productId.unique;
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`replica.keyField: 'productId' no es unique`)));
});

test('fedBy hacia un evento no suscrito es error', () => {
  const layers = depsLayers();
  need(layers).replica.fedBy = ['ProductRetired'];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`fedBy: el evento 'ProductRetired' no está en messaging: subscriptions`)));
});

test('fedBy sin capa messaging queda pendiente con --wip', () => {
  const layers = depsLayers();
  delete layers.messaging;
  delete layers['use-cases'].operations.applyProductSnapshot;
  const { pending } = run(layers, true);
  assert.ok(pending.some((p) => p.includes(`fedBy: el evento 'ProductUpdated' está pendiente de definir`)));
});

test('fedBy cuyo source no coincide con la dependencia es warning', () => {
  const layers = depsLayers();
  layers.messaging.subscriptions.ProductUpdated.source = 'inventory';
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`declara source 'inventory', distinto de la dependencia 'catalog'`)));
});

test('onMiss.error que no declara ninguna operación es error', () => {
  const layers = depsLayers();
  need(layers).replica.onMiss = { action: 'fail', error: 'PRODUCT_UNKNOWN' };
  const { errors } = run(layers);
  assert.ok(
    errors.some((e) => e.includes(`onMiss.error: el código 'PRODUCT_UNKNOWN' no lo declara ninguna operación`))
  );
});

test('onMiss.error declarado fuera de las operaciones de usedBy es warning', () => {
  const layers = depsLayers();
  need(layers).replica.onMiss = { action: 'fail', error: 'PRICE_UNAVAILABLE' };
  need(layers).usedBy = ['applyProductSnapshot'];
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes(`'PRICE_UNAVAILABLE' no lo declara ninguna de las operaciones de usedBy`)));
});

test('dos needs replicando la misma entidad es warning', () => {
  const layers = depsLayers();
  layers.dependencies.dependencies.catalog.needs.productAvailability = {
    usedBy: ['createOrder'],
    strategy: 'replicated',
    replica: {
      entity: 'ProductSnapshot',
      keyField: 'productId',
      fedBy: ['ProductUpdated'],
      onMiss: { action: 'degrade', degradedTo: 'Se asume disponible y se revisa al confirmar.' },
    },
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`'ProductSnapshot' ya la replica el need 'productPricing'`)));
});

test('compensations hacia un evento no suscrito es error', () => {
  const layers = depsLayers();
  layers.dependencies.dependencies.catalog.compensations = [
    { onEvent: 'OrderPaymentFailed', description: 'Revierte la reserva contra catalog.' },
  ];
  const { errors } = run(layers);
  assert.ok(errors.some((e) => e.includes(`el evento 'OrderPaymentFailed' no está en messaging: subscriptions`)));
});

test('cliente http que ningún need usa es warning', () => {
  const layers = depsLayers();
  layers['http-clients'].clients.shipping = {
    purpose: 'Calcular los gastos de envío del pedido.',
    calls: { quote: { contract: 'POST /quotes -> coste de envío.' } },
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes('clients.shipping: ningún need de dependencies lo usa')));
});

test('suscripción cuyo source no está en dependencies es warning', () => {
  const layers = depsLayers();
  layers.messaging.subscriptions.StockDepleted = {
    source: 'inventory',
    payload: { productId: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } },
    triggers: 'applyProductSnapshot',
  };
  const { warnings } = run(layers);
  assert.ok(warnings.some((w) => w.includes(`subscriptions.StockDepleted: su source 'inventory' no está declarado`)));
});

test('strategy on-demand no arrastra persistence ni messaging', () => {
  const layers = depsLayers();
  delete layers.messaging;
  delete layers.persistence;
  delete layers.domain.entities.ProductSnapshot;
  delete layers['use-cases'].operations.applyProductSnapshot;
  const spec = need(layers);
  spec.strategy = 'on-demand';
  delete spec.replica;
  const { errors, warnings } = run(layers);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
