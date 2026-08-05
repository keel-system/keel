import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/lib/model.js';
import { generate as generateDependencies } from '../src/scaffold/dependencies.js';
import { generate as generateMessaging } from '../src/scaffold/messaging.js';
import { generate as generateServices } from '../src/scaffold/services.js';
import { generate as generateHttpClients } from '../src/scaffold/http-clients.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';

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

test('scaffold: la compensación declarada se lee en el contrato de la suscripción', () => {
  // compensations no cambia el código (es una suscripción normal), pero sí explica
  // por qué existe: si no llega al proyecto generado, es dato muerto del modelo.
  const message = fileNamed(generateMessaging(modelFrom(baseLayers())), 'ProductUpdatedMessage').content;

  assert.ok(message.includes('Compensa la dependencia de catalog'));
  assert.ok(message.includes('Revierte la reserva contra catalog.'));
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

// Activación con canal síncrono, añadida sobre el diseño base.
const withActivation = (layers, onFailure = { action: 'ignore' }, awaits = 'acknowledgement') => {
  layers.dependencies.dependencies.notifications = {
    description: 'Servicio de avisos al comprador.',
    contract: { version: '1.2.0' },
    activations: {
      sendOrderConfirmation: {
        triggeredBy: ['createOrder'],
        via: { client: 'catalog', call: 'getProductsByIds' },
        effect: 'Sale un correo de confirmación hacia el comprador.',
        awaits,
        onFailure
      }
    }
  };
  return layers;
};

test('una dependencia solo de activación no genera archivos, pero sí obligación', () => {
  const layers = withActivation(baseLayers());
  // El código del canal ya sale de http-clients y messaging: no hay ninguna
  // clase que materializar. Lo que no puede perderse es el ENLACE con el caso
  // de uso, que es lo único que el DSL declara sobre el trabajo delegado.
  const model = modelFrom(layers);
  const notifications = model.dependencies.find((dependency) => dependency.id === 'notifications');

  assert.equal(notifications.contractVersion, '1.2.0');
  assert.deepEqual(notifications.needs, []);
  assert.deepEqual(notifications.compensations, []);
  assert.equal(notifications.activations.length, 1);

  const [activation] = notifications.activations;
  assert.equal(activation.name, 'sendOrderConfirmation');
  assert.equal(activation.awaits, 'acknowledgement');
  assert.equal(activation.onFailure.action, 'ignore');
  assert.equal(activation.http.clientClass, 'CatalogClient');
  assert.equal(activation.event, null);

  // Retro-enlace hacia la operación: lo lee el stub del handler.
  const createOrder = model.services.flatMap((s) => s.operations).find((op) => op.name === 'createOrder');
  assert.equal(createOrder.dependencyActivations.length, 1);
  assert.equal(createOrder.dependencyActivations[0].dependency, 'notifications');

  // Retro-enlace hacia la llamada: lo lee el fallback del adaptador.
  const call = model.httpClients[0].calls.find((c) => c.name === 'getProductsByIds');
  assert.equal(call.activations.length, 1);

  // Y la réplica del otro proveedor sigue generándose: una cosa no tapa la otra.
  assert.ok(generateDependencies(model).some((file) => file.path.endsWith('ProductSnapshotProjector.java')));
});

test('modelo: una activación por evento propio no inyecta nada y resuelve su clase', () => {
  const layers = baseLayers();
  layers.messaging.publishing = {
    events: {
      OrderPlaced: {
        description: 'Se registró un pedido.',
        payload: { orderId: { type: 'uuid', required: true } }
      }
    }
  };
  layers['use-cases'].operations.createOrder.emits = ['OrderPlaced'];
  layers.dependencies.dependencies.notifications = {
    description: 'Servicio de avisos al comprador.',
    activations: {
      announceOrder: {
        triggeredBy: ['createOrder'],
        via: { publishes: 'OrderPlaced' },
        effect: 'Sale un aviso hacia el comprador.'
      }
    }
  };

  const model = modelFrom(layers);
  const [activation] = model.dependencies.find((d) => d.id === 'notifications').activations;

  assert.equal(activation.http, null);
  assert.equal(activation.event.name, 'OrderPlaced');
  // Sin onFailure declarado: publicar no devuelve resultado, así que no hay
  // política de fallo que materializar (lo impone el schema).
  assert.equal(activation.onFailure, null);
  assert.equal(activation.awaits, 'acknowledgement');
});

test('modelo: una necesidad on-demand aterriza en la operación que la declara', () => {
  const layers = baseLayers();
  const need = layers.dependencies.dependencies.catalog.needs.productPricing;
  need.strategy = 'on-demand';
  delete need.replica;
  delete layers.dependencies.dependencies.catalog.compensations;

  const model = modelFrom(layers);
  const createOrder = model.services.flatMap((s) => s.operations).find((op) => op.name === 'createOrder');

  assert.equal(createOrder.dependencyNeeds.length, 1);
  assert.equal(createOrder.dependencyNeeds[0].need.strategy, 'on-demand');
  assert.equal(createOrder.dependencyNeeds[0].need.fetch.clientClass, 'CatalogClient');
});

test('modelo: onFailure resuelve la excepción del catálogo de use-cases', () => {
  const layers = withActivation(baseLayers(), { action: 'fail', error: 'PRICE_UNAVAILABLE' }, 'outcome');
  const model = modelFrom(layers);
  const [activation] = model.dependencies.find((d) => d.id === 'notifications').activations;

  assert.equal(activation.awaits, 'outcome');
  assert.equal(activation.onFailure.exceptionClass, 'PriceUnavailableError');
  assert.equal(activation.onFailure.httpStatus, 409);
  assert.equal(activation.onFailure.dynamicStatus, false);
});

test('modelo: un onFailure con un error que nadie declara avisa en vez de romper', () => {
  const layers = withActivation(baseLayers(), { action: 'fail', error: 'NO_EXISTE' });
  const model = modelFrom(layers);
  const [activation] = model.dependencies.find((d) => d.id === 'notifications').activations;

  assert.equal(activation.onFailure.exceptionClass, null);
  assert.ok(model.warnings.some((w) => w.includes('NO_EXISTE')));
});

// ─── El stub del handler: donde aterriza la obligación ───────────────────────
//
// Es el único sitio del proyecto generado donde el agente ve lo que la operación
// debe. Que la capa `dependencies` no llegara aquí era el hueco: el diseño
// declaraba una obligación y nadie la veía al escribir el código.

const handlerOf = (model, className) =>
  generateServices(model).find((file) => file.path.endsWith(`${className}.java`)).content;

test('stub: una necesidad on-demand inyecta el puerto del cliente y lo dice', () => {
  const layers = baseLayers();
  const need = layers.dependencies.dependencies.catalog.needs.productPricing;
  need.strategy = 'on-demand';
  delete need.replica;
  delete layers.dependencies.dependencies.catalog.compensations;

  const handler = handlerOf(modelFrom(layers), 'CreateOrderCommandHandler');

  assert.ok(handler.includes('import com.commerce.orderservice.domain.clients.CatalogClient;'));
  assert.ok(handler.includes('private final CatalogClient catalogClient;'));
  assert.ok(handler.includes('Dependencia catalog.productPricing (on-demand)'));
  assert.ok(handler.includes('catalogClient.getProductsByIds(...)'));
  // La resiliencia no se repite en el handler: ya está en el adaptador.
  assert.ok(handler.includes('no los repitas'));
});

test('stub: una necesidad replicada inyecta el Reader, nunca el repositorio de la copia', () => {
  const handler = handlerOf(modelFrom(baseLayers()), 'CreateOrderCommandHandler');

  assert.ok(handler.includes('private final ProductSnapshotReader productSnapshotReader;'));
  assert.ok(handler.includes('productSnapshotReader.byKey(...)'));
  assert.ok(handler.includes('onMiss: fetch'));
  // El repositorio de la réplica saltaría la política onMiss declarada.
  assert.ok(!handler.includes('ProductSnapshotRepository'));
});

test('stub: una activación por cliente inyecta el puerto y explica awaits y onFailure', () => {
  const layers = withActivation(baseLayers(), { action: 'fail', error: 'PRICE_UNAVAILABLE' }, 'outcome');
  const handler = handlerOf(modelFrom(layers), 'CreateOrderCommandHandler');

  assert.ok(handler.includes('private final CatalogClient catalogClient;'));
  assert.ok(handler.includes('Activación notifications.sendOrderConfirmation'));
  assert.ok(handler.includes('Sale un correo de confirmación hacia el comprador.'));
  assert.ok(handler.includes('awaits: outcome'));
  assert.ok(handler.includes('falla con PriceUnavailableError'));
});

test('stub: una activación por evento no inyecta nada y remite a raise(...)', () => {
  const layers = baseLayers();
  layers.messaging.publishing = {
    events: {
      OrderPlaced: { description: 'Se registró un pedido.', payload: { orderId: { type: 'uuid', required: true } } }
    }
  };
  layers['use-cases'].operations.createOrder.emits = ['OrderPlaced'];
  layers.dependencies.dependencies.notifications = {
    description: 'Servicio de avisos al comprador.',
    activations: {
      announceOrder: {
        triggeredBy: ['createOrder'],
        via: { publishes: 'OrderPlaced' },
        effect: 'Sale un aviso hacia el comprador.'
      }
    }
  };

  const handler = handlerOf(modelFrom(layers), 'CreateOrderCommandHandler');

  assert.ok(handler.includes('Activación notifications.announceOrder'));
  assert.ok(handler.includes('se delega publicando OrderPlaced'));
  assert.ok(handler.includes('El handler no publica nada'));
});

// ─── El fallback del circuit breaker ─────────────────────────────────────────

const adapterOf = (model) =>
  generateHttpClients(model).find((file) => file.path.endsWith('CatalogHttpAdapter.java')).content;

// La llamada base no declara circuitBreaker: sin él no hay fallback que escribir.
const withBreaker = (layers) => {
  layers['http-clients'].clients.catalog.calls.getProductsByIds.circuitBreaker = {
    failureRateThreshold: 50,
    slidingWindowSize: 10,
    waitDurationMs: 30000
  };
  return layers;
};

test('fallback: onFailure ignore devuelve resultado neutro y lo registra', () => {
  const adapter = adapterOf(modelFrom(withActivation(withBreaker(baseLayers()))));

  assert.ok(adapter.includes('private static final Logger log ='));
  assert.ok(adapter.includes('Política declarada por la activación notifications.sendOrderConfirmation'));
  assert.ok(adapter.includes('log.warn("catalog.getProductsByIds no disponible'));
  assert.ok(adapter.includes('return new GetProductsByIdsResult(null, null);'));
  assert.ok(!adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});

test('fallback: onFailure fail lanza la excepción declarada en el diseño', () => {
  const layers = withActivation(withBreaker(baseLayers()), { action: 'fail', error: 'PRICE_UNAVAILABLE' }, 'outcome');
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(adapter.includes('import com.commerce.orderservice.domain.errors.PriceUnavailableError;'));
  assert.ok(
    adapter.includes('throw new PriceUnavailableError("notifications no está disponible para sendOrderConfirmation");')
  );
});

test('fallback: onFailure degrade cita la prosa y deja el resultado al agente', () => {
  const layers = withActivation(withBreaker(baseLayers()), {
    action: 'degrade',
    degradedTo: 'El pedido se registra sin confirmación y se avisa después.'
  });
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(adapter.includes('El pedido se registra sin confirmación y se avisa después.'));
  assert.ok(adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});

test('fallback: con dos activaciones por la misma llamada, build no elige por el agente', () => {
  const layers = withActivation(withBreaker(baseLayers()));
  layers.dependencies.dependencies.billing = {
    description: 'Servicio de facturación.',
    activations: {
      chargeOrder: {
        triggeredBy: ['createOrder'],
        via: { client: 'catalog', call: 'getProductsByIds' },
        effect: 'Se emite el cargo del pedido.',
        onFailure: { action: 'fail', error: 'PRICE_UNAVAILABLE' }
      }
    }
  };
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(adapter.includes('Varias activaciones salen por esta llamada'));
  assert.ok(adapter.includes('notifications.sendOrderConfirmation (onFailure: ignore)'));
  assert.ok(adapter.includes('billing.chargeOrder (onFailure: fail)'));
  assert.ok(adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});

// ─── Frontera declarada ──────────────────────────────────────────────────────

test('frontera: contract.version y awaits: outcome se avisan, no se ignoran', () => {
  const layers = withActivation(baseLayers(), { action: 'ignore' }, 'outcome');
  const { errors, warnings } = checkSupportedFeatures(manifest, layers);

  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('contract.version') && w.includes('catalog@0.2.0')));
  assert.ok(warnings.some((w) => w.includes('awaits: outcome') && w.includes('notifications.sendOrderConfirmation')));
});
