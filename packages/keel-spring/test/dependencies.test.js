import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/lib/model.js';
import { generate as generateDependencies } from '../src/scaffold/dependencies.js';
import { generate as generateMessaging } from '../src/scaffold/messaging.js';
import { generate as generateServices } from '../src/scaffold/services.js';
import { generate as generateHttpClients } from '../src/scaffold/http-clients.js';
import { generate as generateConfig } from '../src/scaffold/config.js';
import { generate as generateRepositories } from '../src/scaffold/repositories.js';
import { generate as generateLastKnown } from '../src/scaffold/last-known.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { providerFailures, recordedFailures } from '../src/lib/outbound-failures.js';

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
const NL = String.fromCharCode(10);
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

// ─── Compensaciones ──────────────────────────────────────────────────────────
//
// No generan código propio: son una suscripción normal. Lo que cambian es lo que el
// agente tiene que escribir en el handler que despachan, y eso solo se sabe leyendo
// `undoes` — el único dato del DSL que dice QUÉ encargo se deshace y, por tanto, qué
// estado hay que devolver. Mientras se quedaba en el YAML, el stub del compensador era
// indistinguible del de cualquier otro command.

const withCompensation = (layers = baseLayers()) => {
  layers['use-cases'].operations.createOrder.transitions = [{ entity: 'Order', from: ['draft'], to: 'reserved' }];
  layers['use-cases'].operations.applyProductSnapshot.transitions = [
    { entity: 'Order', from: ['reserved'], to: 'draft' }
  ];
  layers.dependencies.dependencies.catalog.activations = {
    reserveStock: {
      triggeredBy: ['createOrder'],
      via: { client: 'catalog', call: 'getProductsByIds' },
      effect: 'El stock del producto queda reservado para el pedido.',
      onFailure: { action: 'ignore' }
    }
  };
  layers.dependencies.dependencies.catalog.compensations = [
    { onEvent: 'ProductUpdated', undoes: 'reserveStock', description: 'Libera la reserva de stock.' }
  ];
  return layers;
};

test('compensación: el stub dice qué encargo deshace, qué estado devuelve y qué la hace irrepetible', () => {
  const model = modelFrom(withCompensation());
  const handler = handlerOf(model, 'ApplyProductSnapshotCommandHandler');

  assert.ok(handler.includes("deshace la activación 'reserveStock'"));
  assert.ok(handler.includes('movió el lifecycle de Order'));
  // La guarda que cubre los dos caminos vive en el dominio, no en el handler.
  assert.ok(handler.includes('la guarda es la transición del agregado'));

  // Y el listener, que es donde se lee por qué existe esa suscripción.
  const message = fileNamed(generateMessaging(model), 'ProductUpdatedMessage').content;
  assert.ok(message.includes("deshaciendo la activación 'reserveStock'"));
  assert.ok(message.includes('tiene que devolver ese estado'));
});

test('reconciliación: el stub del barrido dice qué busca y de dónde sale el umbral', () => {
  const layers = withCompensation();
  layers.dependencies.dependencies.catalog.activations.reserveStock.reconciledBy = 'sweepStaleReservations';
  layers['use-cases'].operations.sweepStaleReservations = {
    description: 'Revisa las reservas encargadas que siguen sin desenlace.',
    kind: 'command',
    internal: true,
    input: 'void',
    output: 'void',
    schedule: { cron: '0 0 * * * *' }
  };

  const handler = handlerOf(modelFrom(layers), 'SweepStaleReservationsCommandHandler');

  assert.ok(handler.includes('Reconciliación de catalog.reserveStock'));
  // Lo que busca sale del estado en que quedó la entidad al encargar el trabajo.
  assert.ok(handler.includes('Order en reserved'));
  // Y el umbral ya no se inventa: desde la 2.8 lo declara el diseño
  // (`unansweredAfterSeconds`) y build lo deja escrito en su parámetro, así que la nota
  // manda LEERLO. Antes decía «sácalo de parameters/», que es lo mismo que decir «elige tú».
  assert.ok(handler.includes('El umbral de "demasiado tiempo" LO DECLARA EL DISEÑO'));
  assert.ok(handler.includes('reconciliation.reserve-stock.unanswered-after-seconds'));
  assert.ok(handler.includes('reconciliation.reserve-stock.claim-timeout-ms'));
  // El barrido corre en todas las réplicas: reclamar, no leer. La transición del
  // agregado es una carrera, no una serialización, y reencargar publicando produce N
  // eventos con eventId distinto que nadie deduplica.
  assert.ok(handler.includes('corre en TODAS las réplicas'));
  assert.ok(handler.includes('RECLAMAR los candidatos'));
  assert.ok(handler.includes('OutboxRelay'));
  assert.ok(handler.includes('metadata.eventId distinto'));
  // El estado dice QUE espera; el barrido necesita DESDE CUÁNDO, y las dos marcas
  // obvias no valen: createdAt no es cuándo empezó a esperar y updatedAt rejuvenece.
  assert.ok(handler.includes('DESDE CUÁNDO'));
  assert.ok(handler.includes('NO uses createdAt'));
  assert.ok(handler.includes('rejuvenece'));
  // El reclamo es una MARCA PERSISTIDA, no un lock: la llamada al proveedor va en
  // medio, y un lock solo aísla mientras dura su transacción. La marca se nombra por
  // la activación, igual que la de espera.
  assert.ok(handler.includes('MARCA PERSISTIDA'));
  assert.ok(handler.includes('reserveStockClaimedAt'));
  // Y como sobrevive al commit, sobrevive a la réplica que muera: tiene que caducar.
  assert.ok(handler.includes('claim-timeout > lote × timeout de llamada'));
  // El híbrido que ningún gate distingue: reclamar con lock y confirmar antes de
  // llamar suelta el lock y deja la fila sin marca — las N vuelven a verla.
  assert.ok(handler.includes('NO vale reclamar con SKIP LOCKED'));
  // Dos commits, no uno: el del reclamo (que lo hace visible) y el del desenlace.
  assert.ok(handler.includes('son DOS commits'));
  // Y la carrera con el camino feliz no es un fallo.
  assert.ok(handler.includes('CARRERA CON EL CAMINO FELIZ'));
});

// La nota genérica de orden («transición primero, llamada después») existe para que la
// guarda del agregado rechace ANTES de una llamada irreversible. En un barrido esa
// arbitración ya la hizo el reclamo y la transición es el DESENLACE de la llamada, no su
// precondición: aplicarla primero resolvería la entidad sin saber si el proveedor aceptó.
// Las dos notas juntas en el mismo stub no son dos consejos, son uno elegido al azar.
test('reconciliación: el barrido no recibe además la nota de orden genérica, que dice lo contrario', () => {
  const layers = withCompensation();
  layers.dependencies.dependencies.catalog.activations.reserveStock.reconciledBy = 'sweepStaleReservations';
  // Reencargar es lo que le da al barrido una llamada saliente propia.
  layers.dependencies.dependencies.catalog.activations.reserveStock.triggeredBy = [
    'createOrder',
    'sweepStaleReservations'
  ];
  layers['use-cases'].operations.sweepStaleReservations = {
    description: 'Revisa las reservas encargadas que siguen sin desenlace.',
    kind: 'command',
    internal: true,
    input: 'void',
    output: 'void',
    schedule: { cron: '0 0 * * * *' },
    transitions: [{ entity: 'Order', from: ['reserved'], to: 'draft' }]
  };

  const handler = handlerOf(modelFrom(layers), 'SweepStaleReservationsCommandHandler');

  // Tiene las dos cosas —transición y llamada saliente—, así que la nota genérica se
  // dispararía de no excluirse. El orden que vale es el del barrido.
  assert.ok(handler.includes('son DOS commits'));
  assert.ok(!handler.includes('ORDEN de los efectos'), handler);

  // Y fuera del barrido la nota genérica sigue intacta: la exclusión es de la
  // reconciliación, no una retirada de la regla.
  const normal = handlerOf(modelFrom(withCompensation()), 'CreateOrderCommandHandler');
  assert.ok(normal.includes('ORDEN de los efectos'));
});

// ─── El reparto de fase de los @Scheduled ────────────────────────────────────
//
// El DSL declara cron de cinco campos y build añade el de segundos. Poniéndolo a 0 en
// todos, varios barridos que comparten cadencia —y compartirla es lo natural: "cada cinco
// minutos" es la declaración obvia— arrancaban en el mismo instante y en todas las
// réplicas a la vez. Lo que se amontona ahí no es la base de datos (el reclamo es un
// UPDATE corto) sino las llamadas salientes, todas empujando a sus proveedores a la vez.

const schedulersOf = (layers) =>
  generateServices(modelFrom(layers))
    .filter((file) => file.path.endsWith('Scheduler.java'))
    .map((file) => file.content)
    .join('\n');

const withSweeps = (crons) => {
  const layers = withCompensation();
  for (const [name, cron] of Object.entries(crons)) {
    layers['use-cases'].operations[name] = {
      description: `Barrido ${name}.`,
      kind: 'command',
      internal: true,
      input: 'void',
      output: 'void',
      schedule: { cron }
    };
  }
  return layers;
};

test('scheduler: dos operaciones programadas no arrancan en el mismo segundo', () => {
  const scheduler = schedulersOf(
    withSweeps({ sweepStaleReservations: '*/5 * * * *', sweepOrphanOrders: '*/5 * * * *' })
  );

  assert.ok(scheduler.includes('@Scheduled(cron = "0 */5 * * * *")'), scheduler);
  assert.ok(scheduler.includes('@Scheduled(cron = "30 */5 * * * *")'), scheduler);
  // Y lo que NO cambia es la cadencia declarada: el reparto es de fase, no de frecuencia.
  assert.equal((scheduler.match(/\*\/5 \* \* \* \*/g) ?? []).length, 2, scheduler);
});

// Con una sola operación no hay nada de lo que separarse, y desplazarla movería el cron
// de todo diseño con un único barrido sin que nadie lo hubiera pedido.
test('scheduler: con una sola operación programada el segundo sigue siendo 0', () => {
  const scheduler = schedulersOf(withSweeps({ sweepStaleReservations: '0 3 * * *' }));
  assert.ok(scheduler.includes('@Scheduled(cron = "0 0 3 * * *")'), scheduler);
});

// ─── El barrido no corre en transacción ──────────────────────────────────────
//
// Un barrido son TRES commits en momentos distintos —reclamar y confirmar, llamar al
// proveedor fuera de toda transacción, confirmar el desenlace— y el mediator los fundía
// en uno envolviendo el handle() entero. El reclamo no se hacía visible a las demás
// réplicas hasta el final del lote, que es cuando ya no aísla a nadie; la llamada al
// tercero retenía una conexión del pool durante lote × latencia; y un error no capturado
// revertía el lote entero. Se vio en la corrida del 14/08/2026: el código tenía la forma
// correcta y un javadoc afirmando "reclamo con commit propio" sobre algo que no lo tenía.
//
// El criterio de qué operación va por cada camino NO es una heurística del generador: es
// `reconciledBy` del diseño, el mismo campo del que `idempotency-check.js` deriva la
// familia `reconciliation`. Que el gate y el scaffolding claven el mismo predicado sobre
// el mismo dato vale más que cualquier precisión extra.

const withReconciledSweep = (name) => {
  const layers = withSweeps({ [name]: '* * * * *' });
  layers.dependencies.dependencies.catalog.activations.reserveStock.reconciledBy = name;
  return layers;
};

test('scheduler: el barrido de una reconciliación se despacha SIN transacción', () => {
  const scheduler = schedulersOf(withReconciledSweep('sweepStaleReservations'));

  assert.ok(
    scheduler.includes('mediator.dispatchWithoutTransaction(new SweepStaleReservationsCommand())'),
    scheduler
  );
  // Y no por el camino transaccional: el reclamo no confirmaría hasta el final del lote.
  assert.ok(!scheduler.includes('mediator.dispatch(new SweepStaleReservationsCommand())'), scheduler);
  // El porqué viaja con el método, o la siguiente lectura lo «unifica por limpieza».
  assert.ok(scheduler.includes('sin transacción abarcadora'), scheduler);
});

// El caso mixto en UNA sola clase es el que de verdad acota el radio: no basta con que el
// barrido cambie, hace falta que la operación programada de al lado NO cambie.
test('scheduler: una operación con schedule que no reconcilia nada sigue en transacción', () => {
  const layers = withReconciledSweep('sweepStaleReservations');
  layers['use-cases'].operations.purgeOldOrders = {
    description: 'Purga pedidos viejos.',
    kind: 'command',
    internal: true,
    input: 'void',
    output: 'void',
    schedule: { cron: '0 4 * * *' }
  };
  const scheduler = schedulersOf(layers);

  assert.ok(scheduler.includes('mediator.dispatch(new PurgeOldOrdersCommand())'), scheduler);
  assert.ok(!scheduler.includes('mediator.dispatchWithoutTransaction(new PurgeOldOrdersCommand())'), scheduler);
  // Y el barrido de la misma clase sigue por el suyo: conviven.
  assert.ok(
    scheduler.includes('mediator.dispatchWithoutTransaction(new SweepStaleReservationsCommand())'),
    scheduler
  );
});

// El stub del barrido decía "la llamada ocurre DENTRO de la transacción que abrió el
// UseCaseMediator" en la nota de `awaits: nothing`, justo al lado de la nota de
// reconciliación que le pide colocar sus commits. Dos frases opuestas en el mismo
// comentario es peor que ninguna de las dos.
test('el stub del barrido no promete una transacción que no existe', () => {
  const layers = withReconciledSweep('sweepStaleReservations');
  const handler = handlerOf(modelFrom(layers), 'SweepStaleReservationsCommandHandler');

  assert.ok(handler.includes('SIN TRANSACCIÓN ABARCADORA'), handler);
  assert.ok(!handler.includes('DENTRO de la transacción que abrió el UseCaseMediator'), handler);
  // Y dice lo que el agente tiene que hacer con eso: anotar el reclamo, sin REQUIRES_NEW.
  assert.ok(handler.includes('@Transactional'), handler);
});

test('compensación sin transición de vuelta: el estado que falta se reporta, no se inventa', () => {
  const layers = withCompensation();
  delete layers['use-cases'].operations.applyProductSnapshot.transitions;
  layers.messaging.subscriptions.ProductUpdated.contract = {
    messageId: { location: 'header', name: 'messageId' }
  };

  const handler = handlerOf(modelFrom(layers), 'ApplyProductSnapshotCommandHandler');

  assert.ok(handler.includes('el diseño NO declara transición sobre Order'));
  assert.ok(handler.includes('designGap'));
  // Sin guard de dominio, lo único que queda es la puerta del listener — y se dice cuál es.
  assert.ok(handler.includes('la deduplicación del listener por el id del mensaje'));

  // Y el listener recibe el orden que le toca: sin transición que frene la repetición,
  // la ventana solo se cierra reclamando antes — con su precio escrito.
  const message = fileNamed(generateMessaging(modelFrom(layers)), 'ProductUpdatedMessage').content;
  assert.ok(message.includes('IdempotencyGuard.tryRecord(...) antes de despachar'));
  assert.ok(message.includes('deja el mensaje marcado y perdido'));
});

test('con envoltura Keel la guarda del listener existe sin declarar messageId', () => {
  // `metadata.eventId` es la identidad del mensaje y alimenta el mismo `processed_event`,
  // así que la nota del stub no puede decir que el diseño se quedó sin guarda: lo diría
  // justo cuando el agente tiene que llamar al guard.
  const layers = withCompensation();
  delete layers['use-cases'].operations.applyProductSnapshot.transitions;

  const handler = handlerOf(modelFrom(layers), 'ApplyProductSnapshotCommandHandler');
  assert.ok(handler.includes('la deduplicación del listener por el id del mensaje'));
  assert.ok(!handler.includes('el diseño no declara guarda'));
});

// ─── Idempotencia saliente ───────────────────────────────────────────────────
//
// La cara simétrica: la idempotencia de use-cases evita que un cliente NOS ejecute
// dos veces; esta evita que nuestro propio @Retry ejecute dos veces el trabajo del
// proveedor. Un timeout no distingue "no llegó" de "llegó y se hizo".

const withOutboundKey = (layers, idempotency = { keyFrom: 'payload-hash' }) => {
  const call = layers['http-clients'].clients.catalog.calls.getProductsByIds;
  call.method = 'POST';
  call.idempotency = idempotency;
  call.retry = { maxAttempts: 3, retryOn: ['timeout'] };
  return layers;
};

test('saliente: la clave viaja en la cabecera y firma el MISMO objeto que se envía', () => {
  const adapter = adapterOf(modelFrom(withOutboundKey(baseLayers())));

  // El wire request se hoista: calcular la firma aparte del cuerpo es cómo un día
  // dejan de coincidir.
  assert.ok(adapter.includes('GetProductsByIdsRequest request = mapper.toGetProductsByIdsRequest(ids);'));
  assert.ok(adapter.includes('.body(request)'));
  assert.ok(
    adapter.includes('.header("Idempotency-Key", OutboundIdempotency.fromPayload("getProductsByIds", request))')
  );
});

test('saliente: keyFrom correlation usa la correlación de la ejecución, no el contenido', () => {
  const adapter = adapterOf(modelFrom(withOutboundKey(baseLayers(), { keyFrom: 'correlation', header: 'X-Request-Id' })));

  assert.ok(adapter.includes('.header("X-Request-Id", OutboundIdempotency.correlated("getProductsByIds", request))'));
});

test('saliente: sin correlación que leer, la clave se degrada al contenido y se avisa', () => {
  const layers = withOutboundKey(baseLayers(), { keyFrom: 'correlation' });
  delete layers.messaging; // ni api ni messaging: nadie abre el contexto
  const model = buildModel({ manifest, layers });

  assert.ok(model.warnings.some((w) => w.includes("keyFrom 'correlation' sin capa api ni messaging")));
  const adapter = adapterOf(model);
  assert.ok(adapter.includes('OutboundIdempotency.fromPayload('));
  assert.ok(!adapter.includes('OutboundIdempotency.correlated('));
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

// El proveedor puede contestar sin cuerpo —un 204 es la respuesta más natural a un
// DELETE— y entonces `body(...)` devuelve null. Sin guarda, el mapper desreferencia y
// sale un NPE que el fallback del circuit breaker se traga por el camino escrito para
// «el proveedor no responde»: una llamada que FUNCIONÓ se registra como caída, y con
// onFailure: fail se convierte en el error de indisponibilidad del diseño. El síntoma
// acusa al proveedor y la causa está en el adaptador. Lo destapó el pase de calidad de
// una corrida real; ningún test de cadenas lo veía porque el texto generado era
// sintácticamente impecable.
test('cuerpo de respuesta ausente: se traduce a valores ausentes, no a caída del proveedor', () => {
  const adapter = adapterOf(modelFrom(withActivation(withBreaker(baseLayers()))));

  assert.ok(adapter.includes('if (response == null) {'), adapter);
  // La guarda va ANTES del mapper: después no sirve de nada.
  assert.ok(adapter.indexOf('if (response == null) {') < adapter.indexOf('mapper.toGetProductsByIdsResult('), adapter);
  // El aviso dice la verdad y NO reutiliza el «no disponible» del fallback: es
  // justamente lo que distingue este caso de una caída, y confundirlos era el bug.
  assert.match(adapter, /log\.warn\("catalog\.getProductsByIds respondió sin cuerpo; el contrato declara 2 campo\(s\)"\)/);
  assert.ok(!/respondió sin cuerpo[^"]*no disponible/.test(adapter), adapter);

  // Y el resultado neutro es EL MISMO que el del fallback `ignore`: son la misma noción
  // («no hay nada que el proveedor haya dicho») y el llamante no distingue los dos
  // caminos, así que dos formas distintas del mismo vacío serían un contrato roto.
  const neutral = 'return new GetProductsByIdsResult(null, null);';
  assert.equal(adapter.split(neutral).length - 1, 2, adapter);
});

test('cuerpo de respuesta ausente: sin campos declarados no se emite guarda', () => {
  const layers = baseLayers();
  // Sin `response.fields`, el mapper devuelve `new XxxResult()` sin tocar la respuesta:
  // no hay NPE posible y la guarda sería ruido.
  delete layers['http-clients'].clients.catalog.calls.getProductsByIds.response;
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(!adapter.includes('if (response == null) {'), adapter);
  assert.ok(!adapter.includes('respondió sin cuerpo'), adapter);
});

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

  // El conflicto se cuenta sobre TODAS las políticas que salen por la llamada, no solo
  // sobre las activaciones: desde la 2.8 un `need` también trae la suya (`onUnavailable`),
  // y una activación más un need por el mismo método es el mismo choque.
  assert.ok(adapter.includes('Varias políticas DISTINTAS salen por esta llamada'));
  assert.ok(adapter.includes('notifications.sendOrderConfirmation (activación, onFailure: ignore)'));
  assert.ok(adapter.includes('billing.chargeOrder (activación, onFailure: fail)'));
  assert.ok(adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});

// ─── El fallback estrecho ────────────────────────────────────────────────────
//
// `fallbackMethod` de resilience4j solía declarar `Throwable`, así que CUALQUIER bug
// del adaptador —un NPE, un ClassCastException, un cuerpo que no deserializa— se
// registraba como «proveedor no disponible», y con onFailure: fail se convertía en el
// error de indisponibilidad del diseño. Es lo que mantuvo un defecto de código meses
// disfrazado de caída ajena. Ahora hay una sobrecarga por excepción que de verdad
// significa algo del proveedor, y lo que ninguna acepta resilience4j lo relanza.

const yamlOf = (model) => {
  const withStack = { ...model, stack: { database: 'postgresql', broker: 'kafka' } };
  return generateConfig(withStack).find((file) => file.path.endsWith('local/http-clients.yaml')).content;
};

test('fallback: sobrecargas tipadas y NINGUNA que declare Throwable', () => {
  const adapter = adapterOf(modelFrom(withActivation(withBreaker(baseLayers()))));

  for (const { simple, fqn } of providerFailures({ circuitBreaker: true })) {
    assert.ok(adapter.includes(`getProductsByIdsFallback(List<UUID> ids, ${simple} throwable)`), simple);
    assert.ok(adapter.includes(`import ${fqn};`), fqn);
  }
  // La prohibición explícita es el punto: un test que solo comprueba lo que SÍ hay no
  // distingue «estrechado» de «estrechado y además el catch-all sigue ahí». Y se
  // prohíbe el TIPO, no un nombre de variable: `Throwable t` colaba con el nombre.
  // (`\b` antes de Exception no casa dentro de HttpClientErrorException.)
  assert.ok(!/Fallback\([^)]*\b(?:Throwable|Exception)\s+\w+\)/.test(adapter), adapter);
});

test('fallback: nunca una sola sobrecarga, ni siquiera sin circuit breaker', () => {
  // Con UN solo método de fallback resilience4j entra por un atajo cuya semántica ha
  // cambiado entre versiones (hoy comprueba el tipo; antes invocaba siempre). Dos o
  // más dejan el comportamiento fijado por el recorrido de superclases, que es estable.
  const layers = withActivation(baseLayers());
  layers['http-clients'].clients.catalog.calls.getProductsByIds.retry = { maxAttempts: 3 };
  layers['http-clients'].clients.catalog.calls.getProductsByIds.fallback = 'Devolver la copia local.';
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(adapter.split('private GetProductsByIdsResult getProductsByIdsFallback(').length - 1 >= 2, adapter);
  // Sin circuito no puede lanzarse: declararla anunciaría un modo de fallo imposible.
  assert.ok(!adapter.includes('CallNotPermittedException'), adapter);
});

test('fallback: sin retry ni circuito no se emiten métodos que nadie invoca', () => {
  // El fallback lo dispara un aspecto. Sin ninguno, serían cinco privados muertos.
  const layers = withActivation(baseLayers());
  layers['http-clients'].clients.catalog.calls.getProductsByIds.fallback = 'Devolver la copia local.';
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(!adapter.includes('getProductsByIdsFallback('), adapter);
  assert.ok(!adapter.includes('getProductsByIdsUnavailable('), adapter);
});

test('fallback: la política vive en un solo cuerpo, no copiada por sobrecarga', () => {
  const adapter = adapterOf(modelFrom(withActivation(withBreaker(baseLayers()))));

  assert.ok(adapter.includes('private GetProductsByIdsResult getProductsByIdsUnavailable(List<UUID> ids, Throwable throwable)'));
  // Una sola vez: N copias del cuerpo es la forma de que un día dejen de decir lo mismo.
  assert.equal(adapter.split('log.warn("catalog.getProductsByIds no disponible').length - 1, 1, adapter);
});

test('fallback: el 4xx se atiende pero NO cuenta como caída del proveedor', () => {
  // Asimetría deliberada, y es justo la que un refactor futuro «unificaría» por error:
  // que nos rechacen no es que estén caídos. Un 401 por credencial caducada abriría el
  // circuito culpando al proveedor de lo nuestro.
  const model = modelFrom(withActivation(withBreaker(baseLayers())));
  const adapter = adapterOf(model);

  assert.ok(adapter.includes('getProductsByIdsFallback(List<UUID> ids, HttpClientErrorException throwable)'));
  assert.ok(adapter.includes('rechazada por el proveedor'));
  const circuit = yamlOf(model).split('circuitbreaker:')[1];
  assert.ok(!circuit.includes('HttpClientErrorException'), circuit);
});

test('circuit breaker: record-exceptions sale de la MISMA tabla que las sobrecargas', () => {
  // La promesa de «no pueden divergir» tiene que ser verificable, o es una intención.
  const model = modelFrom(withActivation(withBreaker(baseLayers())));
  const circuit = yamlOf(model).split('circuitbreaker:')[1];
  const adapter = adapterOf(model);

  assert.ok(circuit.includes('record-exceptions:'), circuit);
  for (const fqn of recordedFailures()) {
    assert.ok(circuit.includes(`- ${fqn}`), fqn);
    // Y todo lo que cuenta para el circuito tiene sobrecarga que lo atienda.
    assert.ok(adapter.includes(`import ${fqn};`), fqn);
  }
});

test('resiliencia: el fallbackMethod va en el aspecto externo, no en el circuito', () => {
  // Orden de aspectos: Retry(CircuitBreaker(llamada)). Con el fallback en el circuito,
  // este atrapaba la excepción, ejecutaba el fallback y le devolvía un valor normal al
  // retry, que veía éxito y NO reintentaba: el retry declarado estaba muerto.
  const layers = withActivation(withBreaker(baseLayers()));
  layers['http-clients'].clients.catalog.calls.getProductsByIds.retry = { maxAttempts: 3 };
  const conRetry = adapterOf(modelFrom(layers));

  assert.ok(conRetry.includes('@Retry(name = "catalog-get-products-by-ids", fallbackMethod = "getProductsByIdsFallback")'));
  assert.ok(conRetry.includes('@CircuitBreaker(name = "catalog-get-products-by-ids")'));
  assert.ok(!/@CircuitBreaker\([^)]*fallbackMethod/.test(conRetry), conRetry);

  // Sin retry, el externo es el circuito y el fallback vuelve ahí.
  const soloCb = adapterOf(modelFrom(withActivation(withBreaker(baseLayers()))));
  assert.ok(soloCb.includes('@CircuitBreaker(name = "catalog-get-products-by-ids", fallbackMethod = "getProductsByIdsFallback")'));
});

// ─── Frontera declarada ──────────────────────────────────────────────────────

test('frontera: contract.version y awaits: outcome se avisan, no se ignoran', () => {
  const layers = withActivation(baseLayers(), { action: 'ignore' }, 'outcome');
  const { errors, warnings } = checkSupportedFeatures(manifest, layers);

  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('contract.version') && w.includes('catalog@0.2.0')));
  assert.ok(warnings.some((w) => w.includes('awaits: outcome') && w.includes('notifications.sendOrderConfirmation')));
});

test('la carrera se anuncia solo cuando existe otro camino que saca del mismo estado', () => {
  // Dos operaciones salen de `awaiting`: la del listener y un barrido. El guard del
  // agregado arbitra, y al perdedor se le rechaza la transición — no es un fallo.
  const layers = baseLayers();
  layers.domain.entities.Order.fields.status = {
    type: 'enum',
    values: ['awaiting', 'confirmed', 'cancelled'],
    default: 'awaiting'
  };
  layers.domain.entities.Order.lifecycle = {
    field: 'status',
    transitions: { awaiting: ['confirmed', 'cancelled'], confirmed: [], cancelled: [] }
  };
  layers['use-cases'].operations.applyProductSnapshot.transitions = [
    { entity: 'Order', from: ['awaiting'], to: 'confirmed' }
  ];

  const solo = fileNamed(generateMessaging(modelFrom(layers)), 'ProductUpdatedMessage').content;
  assert.ok(!solo.includes('Compite con'), solo);

  // Ahora sí: un barrido que también sale de `awaiting`.
  layers['use-cases'].operations.sweepStaleOrders = {
    description: 'Cancela los pedidos que llevan demasiado tiempo esperando.',
    kind: 'command',
    internal: true,
    input: 'void',
    output: 'void',
    schedule: { cron: '0 * * * * *' },
    transitions: [{ entity: 'Order', from: ['awaiting'], to: 'cancelled' }]
  };

  const conCarrera = fileNamed(generateMessaging(modelFrom(layers)), 'ProductUpdatedMessage').content;
  assert.ok(conCarrera.includes('Compite con sweepStaleOrders'), conCarrera);
  assert.ok(conCarrera.includes('es la carrera resuelta y NO un fallo'), conCarrera);
});

test('réplica: el save() de la copia local abre su propia transacción', () => {
  const model = modelFrom(baseLayers());
  const files = generateRepositories(model);

  // La hidratación (onMiss: fetch) escribe dentro del camino de LECTURA: el query
  // handler abrió su transacción como readOnly=true, y la propagación por defecto se
  // uniría a ella. REQUIRES_NEW la suspende, que es lo único que hace posible escribir
  // ahí.
  const replica = fileNamed(files, 'ProductSnapshotRepositoryImpl');
  assert.ok(replica);
  assert.ok(
    replica.content.includes(
      '@Transactional(propagation = Propagation.REQUIRES_NEW)' + NL + '    public ProductSnapshot save('
    )
  );
  assert.ok(replica.content.includes('import org.springframework.transaction.annotation.Propagation;'));

  // Y NO se generaliza: un agregado normal se une a la transacción del caso de uso, que
  // es lo que hace que su escritura y sus eventos compartan commit. Emitir REQUIRES_NEW
  // ahí rompería esa atomicidad sin que nadie lo pidiera.
  const aggregate = fileNamed(files, 'OrderRepositoryImpl');
  assert.ok(aggregate);
  assert.ok(!aggregate.content.includes('REQUIRES_NEW'));
  assert.ok(aggregate.content.includes('@Transactional' + NL + '    public Order save('));
});

// ─── onUnavailable: la política del `need` (DSL 2.8) ─────────────────────────
//
// El hueco que cerró: un dato que se PIDE al proveedor no tenía dónde declarar qué ve
// el cliente si esa llamada falla, así que la respuesta vivía en la prosa del `fallback`
// de http-clients —capa técnica— y la acababa eligiendo quien construía. En una corrida
// real eso produjo una caché del último valor SIN expiración.

const withOnUnavailable = (policy) => {
  const layers = withBreaker(baseLayers());
  layers.dependencies.dependencies.catalog.needs.productPricing.onUnavailable = policy;
  return layers;
};

test('onUnavailable fail: el fallback lanza el error del diseño en vez de dejar un TODO', () => {
  const adapter = adapterOf(modelFrom(withOnUnavailable({ action: 'fail', error: 'PRICE_UNAVAILABLE' })));

  assert.ok(adapter.includes('Política declarada por el need catalog.productPricing (onUnavailable: fail)'));
  assert.ok(adapter.includes('throw new PriceUnavailableError('));
  assert.ok(!adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});

test('onUnavailable lastKnown: build escribe las DOS mitades, servir y rendirse', () => {
  const model = modelFrom(withOnUnavailable({ action: 'lastKnown', maxAgeSeconds: 900, error: 'PRICE_UNAVAILABLE' }));
  const adapter = adapterOf(model);

  // El almacén se inyecta solo donde el diseño lo pide.
  assert.ok(adapter.includes('private final LastKnownValues lastKnown;'), adapter);
  // Y se alimenta del camino FELIZ: si solo se escribiera al fallar no habría nada que
  // recordar.
  assert.ok(adapter.includes('lastKnown.remember("getProductsByIds", ids, result);'), adapter);
  // La ventana declarada, y el error con el que se acaba. Sin la segunda mitad esto es
  // la caché sin expiración que el DSL acaba de prohibir.
  assert.ok(adapter.includes('lastKnown.recall("getProductsByIds", ids, Duration.ofSeconds(900), GetProductsByIdsResult.class)'), adapter);
  assert.ok(adapter.includes('.orElseThrow(() -> new PriceUnavailableError('), adapter);

  // Y el almacén existe, acotado por edad Y por tamaño.
  const store = generateLastKnown(model).find((file) => file.path.endsWith('LastKnownValues.java'));
  assert.ok(store, 'no se generó LastKnownValues');
  assert.ok(store.content.includes('MAX_ENTRIES'), store.content);
  assert.ok(store.content.includes('Duration.between(entry.storedAt(), Instant.now()).compareTo(maxAge) > 0'), store.content);
});

test('sin ningún need lastKnown no se genera el almacén ni se inyecta', () => {
  // Un almacén que nadie usa es un bean de más y un campo muerto en el adaptador.
  const model = modelFrom(withOnUnavailable({ action: 'fail', error: 'PRICE_UNAVAILABLE' }));
  assert.equal(generateLastKnown(model).length, 0);
  assert.ok(!adapterOf(model).includes('LastKnownValues'));
});

test('una activación y un need por la misma llamada: build no elige entre las dos políticas', () => {
  // Es el mismo choque que dos activaciones: un único método no puede hacer dos cosas
  // distintas, y elegir sería decidir en silencio cuál de las dos promesas se rompe.
  const layers = withActivation(withOnUnavailable({ action: 'fail', error: 'PRICE_UNAVAILABLE' }));
  const adapter = adapterOf(modelFrom(layers));

  assert.ok(adapter.includes('Varias políticas DISTINTAS salen por esta llamada'), adapter);
  assert.ok(adapter.includes('catalog.productPricing (need, onUnavailable: fail)'), adapter);
  assert.ok(adapter.includes('notifications.sendOrderConfirmation (activación, onFailure: ignore)'), adapter);
  assert.ok(adapter.includes('throw new UnsupportedOperationException("TODO: fallback getProductsByIds")'));
});
