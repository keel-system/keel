import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/lib/model.js';
import { generate as generateDependencies } from '../src/scaffold/dependencies.js';

const manifest = {
  keel: '2.2',
  service: { name: 'order-service', version: '0.1.0', description: 'Gestiona los pedidos.', domain: 'commerce' }
};

// Diseño mínimo con una réplica de catalog: entidad propia (Order) + copia (ProductSnapshot)
// alimentada por ProductUpdated y rescatada por el cliente HTTP de catalog.
const baseLayers = () => ({
  domain: {
    entities: {
      Order: {
        fields: {
          id: { type: 'uuid', id: true, generated: true },
          total: { type: 'decimal', required: true }
        }
      },
      ProductSnapshot: {
        description: 'Copia local del producto de catalog.',
        fields: {
          id: { type: 'uuid', id: true, generated: true },
          productId: { type: 'uuid', required: true, unique: true },
          price: { type: 'decimal', required: true },
          occurredAt: { type: 'timestamp', required: true }
        }
      }
    }
  },
  'use-cases': {
    operations: {
      createOrder: {
        description: 'Crea un pedido con los productos elegidos.',
        kind: 'command',
        input: { fields: { productId: { type: 'uuid', required: true } } },
        output: { entity: 'Order' },
        errors: [{ code: 'PRICE_UNAVAILABLE', when: 'No se conoce el precio vigente.', http: 409 }]
      },
      applyProductSnapshot: {
        description: 'Actualiza la copia local del producto con lo que informa catalog.',
        kind: 'command',
        internal: true,
        input: {
          fields: {
            productId: { type: 'uuid', required: true },
            price: { type: 'decimal', required: true },
            occurredAt: { type: 'timestamp', required: true }
          }
        },
        output: 'void'
      }
    }
  },
  messaging: {
    subscriptions: {
      ProductUpdated: {
        source: 'catalog',
        payload: {
          productId: { type: 'uuid', required: true },
          price: { type: 'decimal', required: true },
          occurredAt: { type: 'timestamp', required: true }
        },
        triggers: 'applyProductSnapshot'
      }
    }
  },
  'http-clients': {
    clients: {
      catalog: {
        purpose: 'Resolver productos al construir pedidos.',
        calls: {
          getProductsByIds: {
            contract: 'Productos por id, en lote.',
            method: 'POST',
            path: '/internal/products/batch-get',
            request: { body: { ids: { type: 'uuid', list: true, required: true } } },
            response: { fields: { id: { type: 'uuid', required: true }, price: { type: 'decimal', required: true } } }
          }
        }
      }
    }
  },
  persistence: { default: { model: 'relational' }, entities: { Order: {}, ProductSnapshot: {} } },
  dependencies: {
    dependencies: {
      catalog: {
        description: 'Fuente de verdad de productos y precios.',
        contract: { version: '0.2.0' },
        needs: {
          productPricing: {
            description: 'Precio del producto al construir un pedido.',
            usedBy: ['createOrder'],
            strategy: 'replicated',
            fetchedFrom: { client: 'catalog', call: 'getProductsByIds' },
            replica: {
              entity: 'ProductSnapshot',
              keyField: 'productId',
              fedBy: ['ProductUpdated'],
              freshness: 'Un precio de hasta cinco minutos vale para cotizar.',
              onMiss: { action: 'fetch' }
            }
          }
        },
        compensations: [{ onEvent: 'ProductUpdated', description: 'Revierte la reserva contra catalog.' }]
      }
    }
  }
});

const modelFrom = (layers) => buildModel({ manifest, layers });
const replicaOf = (model) => model.dependencies[0].needs[0].replica;
const fileNamed = (files, name) => files.find((file) => file.path.endsWith(`${name}.java`));

test('modelo: la capa dependencies se resuelve con sus retro-enlaces', () => {
  const model = modelFrom(baseLayers());

  assert.equal(model.layersPresent.dependencies, true);
  assert.equal(model.dependencies.length, 1);

  const [dependency] = model.dependencies;
  assert.equal(dependency.id, 'catalog');
  assert.equal(dependency.contractVersion, '0.2.0');

  const [need] = dependency.needs;
  assert.equal(need.strategy, 'replicated');
  assert.deepEqual(need.usedBy, ['createOrder']);
  assert.equal(need.fetch.clientClass, 'CatalogClient');
  assert.equal(need.fetch.call, 'getProductsByIds');

  const replica = need.replica;
  assert.equal(replica.projectorClass, 'ProductSnapshotProjector');
  assert.equal(replica.readerClass, 'ProductSnapshotReader');
  assert.equal(replica.repositoryPort, 'ProductSnapshotRepository');
  assert.equal(replica.keyGetter, 'getProductId');

  // Retro-enlaces: la entidad sabe que es réplica y la suscripción, qué proyección alimenta.
  const entity = model.entities.find((e) => e.name === 'ProductSnapshot');
  assert.deepEqual(entity.replicaOf, { dependency: 'catalog', need: 'productPricing' });
  const subscription = model.subscriptions.find((s) => s.name === 'ProductUpdated');
  assert.equal(subscription.feedsReplica.projectorClass, 'ProductSnapshotProjector');
  assert.equal(subscription.compensates.dependency, 'catalog');

  // La clave del proveedor se vuelve clave natural: garantiza el finder del repositorio.
  assert.ok(entity.naturalKey.includes('productId'));
});

test('scaffold: una réplica genera Projector y Reader, y nada más', () => {
  const files = generateDependencies(modelFrom(baseLayers()));
  assert.deepEqual(
    files.map((file) => file.path.split('/').pop()).sort(),
    ['ProductSnapshotProjector.java', 'ProductSnapshotReader.java']
  );
  assert.ok(files.every((file) => file.path.includes('application/projection')));
});

test('scaffold: el Projector hace upsert por keyField y no importa Spring', () => {
  const files = generateDependencies(modelFrom(baseLayers()));
  const projector = fileNamed(files, 'ProductSnapshotProjector').content;

  assert.match(projector, /@ApplicationComponent/);
  assert.doesNotMatch(projector, /import org\.springframework/);
  assert.match(projector, /repository\.findByProductId\(productId\)/);
  // El dominio no tiene setters: la creación y la actualización pasan por métodos
  // de dominio que escribe el agente, con su firma exacta en el TODO.
  assert.match(projector, /repository\.save\(ProductSnapshot\.projectionOf\(productId, price, occurredAt\)\)/);
  assert.match(projector, /existing\.applySnapshot\(price, occurredAt\)/);
  assert.match(projector, /TODO \(agente\): añade a ProductSnapshot/);
  assert.match(projector, /public static ProductSnapshot projectionOf\(UUID productId, BigDecimal price, Instant occurredAt\)/);
  // El payload trae occurredAt: se compara para que un hecho viejo no pise a uno nuevo.
  assert.match(projector, /isBefore\(existing\.getOccurredAt\(\)\)/);
});

test('scaffold: sin instante en la entidad, el Projector deja el TODO de ordenación', () => {
  const layers = baseLayers();
  delete layers.domain.entities.ProductSnapshot.fields.occurredAt;
  delete layers['use-cases'].operations.applyProductSnapshot.input.fields.occurredAt;
  const projector = fileNamed(generateDependencies(modelFrom(layers)), 'ProductSnapshotProjector').content;

  assert.doesNotMatch(projector, /isBefore/);
  assert.match(projector, /TODO \(agente\).*instante/s);
});

test('scaffold: onMiss fetch inyecta el puerto del cliente y deja la hidratación al agente', () => {
  const reader = fileNamed(generateDependencies(modelFrom(baseLayers())), 'ProductSnapshotReader').content;

  assert.match(reader, /CatalogClient catalogClient/);
  assert.match(reader, /findByProductId\(productId\)\.or\(\(\) -> hydrate\(productId\)\)/);
  assert.match(reader, /TODO \(agente\): invoca catalogClient\.getProductsByIds/);
});

test('scaffold: onMiss fail lanza la excepción del error declarado', () => {
  const layers = baseLayers();
  layers.dependencies.dependencies.catalog.needs.productPricing.replica.onMiss = {
    action: 'fail',
    error: 'PRICE_UNAVAILABLE'
  };
  const reader = fileNamed(generateDependencies(modelFrom(layers)), 'ProductSnapshotReader').content;

  assert.match(reader, /orElseThrow\(\(\) -> new PriceUnavailableError\(/);
  assert.match(reader, /public ProductSnapshot byKey\(UUID productId\)/);
  assert.doesNotMatch(reader, /CatalogClient/);
});

test('scaffold: onMiss degrade devuelve Optional y documenta el resultado degradado', () => {
  const layers = baseLayers();
  layers.dependencies.dependencies.catalog.needs.productPricing.replica.onMiss = {
    action: 'degrade',
    degradedTo: 'Se cotiza sin descuento y se marca el pedido para revisión.'
  };
  const reader = fileNamed(generateDependencies(modelFrom(layers)), 'ProductSnapshotReader').content;

  assert.match(reader, /public Optional<ProductSnapshot> byKey/);
  assert.match(reader, /Se cotiza sin descuento y se marca el pedido para revisión\./);
  assert.doesNotMatch(reader, /orElseThrow/);
});

test('scaffold: una necesidad on-demand no genera nada', () => {
  const layers = baseLayers();
  const need = layers.dependencies.dependencies.catalog.needs.productPricing;
  need.strategy = 'on-demand';
  delete need.replica;
  delete layers.dependencies.dependencies.catalog.compensations;

  assert.deepEqual(generateDependencies(modelFrom(layers)), []);
});

test('sin capa dependencies el modelo y el scaffold quedan intactos (retrocompatibilidad)', () => {
  const layers = baseLayers();
  delete layers.dependencies;
  const model = modelFrom(layers);

  assert.equal(model.layersPresent.dependencies, false);
  assert.equal(model.dependencies, null);
  assert.deepEqual(generateDependencies(model), []);
  assert.equal(model.entities.find((e) => e.name === 'ProductSnapshot').replicaOf, undefined);
});
