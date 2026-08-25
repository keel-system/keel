// Regresiones del informe de generación de catalog-spring: cada caso reproduce
// un bug determinista del scaffolding con la fixture catalog-extended (binding
// HTTP, status de éxito, paginación, payload de eventos, DTOs con relaciones,
// multipart, mapeo bidireccional, errores con status por operación, caché e
// infraestructura de validación).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { cacheFlushCmd } from '../src/scaffold/devtools.js';
import { CACHES } from '../src/lib/stack-catalog.js';
import { fixedFrameworkErrors } from 'keel-core';
import { emptyReadJava, collapseToSingleLineJava } from '../src/lib/broker-probes.js';
import { providerFailures } from '../src/lib/outbound-failures.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
const JAVA = 'src/main/java/com/commerce/catalog';

function scaffoldExtended() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-regression-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  return { workspace, result, read };
}

const controllerPath = (group) => `${JAVA}/infrastructure/rest/controllers/${group}/v1/${group === 'product' ? 'Product' : 'ProductImage'}V1Controller.java`;

test('binding HTTP: un @PathVariable por segmento de la ruta declarada', () => {
  const { read } = scaffoldExtended();
  const product = read(controllerPath('product'));
  const image = read(controllerPath('productimage'));

  // {slug} es un path param aunque no se llame "id", y con el tipo del diseño.
  assert.ok(product.includes('getProductBySlug(@PathVariable String slug)'));
  assert.ok(!product.includes('@RequestParam String slug'));
  // Dos segmentos en la misma ruta, ambos ligados, y sin body en un DELETE.
  assert.ok(image.includes('removeProductImage(@PathVariable UUID productId, @PathVariable UUID imageId)'));
  assert.ok(!image.includes('@RequestBody RemoveProductImageCommand'));
});

test('binding HTTP: un POST con cuerpo usa @RequestBody aunque sea una query', () => {
  const { read } = scaffoldExtended();
  const product = read(controllerPath('product'));
  assert.ok(product.includes('@RequestBody GetProductsByIdsQuery'));
  assert.ok(!product.includes('@RequestParam List<UUID> ids'));
});

test('status de éxito: 201 solo al crear; un POST de transición responde 200', () => {
  const { read, result } = scaffoldExtended();
  const product = read(controllerPath('product'));
  const createBlock = product.slice(product.indexOf('@PostMapping("/products")'), product.indexOf('getProductBySlug'));
  const retireBlock = product.slice(product.indexOf('@PostMapping("/products/{id}/retire")'));

  // El 201 lo pone ResponseEntity.created(...), que además emite Location: con
  // @ResponseStatus encima se declararía dos veces el mismo status.
  assert.ok(createBlock.includes('ResponseEntity.created('));
  assert.ok(!createBlock.includes('@ResponseStatus'));
  assert.ok(!retireBlock.includes('@ResponseStatus'));
  assert.ok(result.warnings.some((w) => w.includes("'retireProduct'") && w.includes('sin successStatus')));
});

test('§1.3: toda creación con id en la salida devuelve la cabecera Location', () => {
  const { read } = scaffoldExtended();
  const product = read(controllerPath('product'));
  const image = read(controllerPath('productimage'));

  assert.ok(product.includes('public ResponseEntity<CreateProductResponseDto> createProduct('));
  assert.ok(
    product.includes(
      'ServletUriComponentsBuilder.fromCurrentRequest().path("/{id}").buildAndExpand(response.id()).toUri()'
    )
  );
  assert.ok(product.includes('import org.springframework.web.servlet.support.ServletUriComponentsBuilder;'));

  // addProductImage crea un SUB-RECURSO y devuelve el agregado padre: el `id` de la
  // respuesta es el del producto, no el de la imagen. La regla general (URI de la
  // petición + id del output) daba `/products/{productId}/images/{productId}`, que
  // no es la ruta de nada. Location apunta al agregado devuelto.
  assert.ok(
    product.includes(
      'ServletUriComponentsBuilder.fromCurrentContextPath()\n                    .path("/api/v1/products/{productId}").buildAndExpand(productId).toUri()'
    ),
    product
  );
  assert.ok(!product.includes('/images/{id}'));

  // removeProductImage sigue con `output: void`: sin id que referenciar no hay URI
  // que construir, así que se queda con @ResponseStatus y sin Location.
  assert.ok(!image.includes('ResponseEntity.created('));
  // Nunca se envuelve un retorno vacío solo por el status.
  assert.ok(!product.includes('ResponseEntity<Void>'));
});

test('paginación: PagedResponse<Dto> sin lista anidada', () => {
  const { read } = scaffoldExtended();
  const query = read(`${JAVA}/application/queries/ListProductsQuery.java`);
  const handler = read(`${JAVA}/application/usecases/ListProductsQueryHandler.java`);
  const controller = read(controllerPath('product'));

  assert.ok(query.includes('Query<PagedResponse<ListProductsResponseDto>>'));
  assert.ok(handler.includes('PagedResponse<ListProductsResponseDto> handle('));
  assert.ok(controller.includes('PagedResponse<ListProductsResponseDto> listProducts('));
  for (const content of [query, handler, controller]) assert.ok(!content.includes('PagedResponse<List<'));
});

test('eventos: el payload declarado se proyecta en el evento y en su gemelo de wire', () => {
  const { read } = scaffoldExtended();
  const domainEvent = read(`${JAVA}/domain/events/ProductCreatedEvent.java`);
  const integration = read(`${JAVA}/infrastructure/messaging/events/ProductCreatedIntegrationEvent.java`);

  assert.ok(domainEvent.includes('UUID productId, String sku, Instant occurredAt'));
  assert.ok(integration.includes('UUID productId, String sku, Instant occurredAt'));
});

test('DTOs: las relaciones entran — referencia por id y entidad hija como DTO propio', () => {
  const { read } = scaffoldExtended();
  const dto = read(`${JAVA}/application/dtos/CreateProductResponseDto.java`);
  const childDto = read(`${JAVA}/application/dtos/ProductImageDto.java`);
  const mapper = read(`${JAVA}/application/mappers/ProductApplicationMapper.java`);

  assert.ok(dto.includes('UUID categoryId'));
  assert.ok(dto.includes('List<ProductImageDto> images'));
  assert.ok(childDto.includes('public record ProductImageDto('));
  // El DTO de la hija lleva el id de su raíz. Sin él, un <Hija>Dto devuelto SUELTO
  // —`output: { entity: <Hija> }`— no dice a qué padre pertenece, y el consumidor no
  // tiene forma de recomponerlo (informe de notifications-spring § 2).
  assert.ok(childDto.includes('UUID productId'));
  // La hija se mapea con su propio DTO, no con un null pendiente. Y el id del padre entra
  // por PARÁMETRO —el dominio es puro y la hija no guarda puntero a su raíz—, así que el
  // compilador no deja olvidarlo: de ahí la lambda en vez de la referencia a método.
  assert.ok(mapper.includes('entity.getImages().stream().map(child -> toProductImageDto(child, entity.getId())).toList()'));
  assert.ok(mapper.includes('public ProductImageDto toProductImageDto(ProductImage entity, UUID productId)'));
  assert.ok(!mapper.includes('productId no es getter directo'));
});

test('campos file: endpoint multipart con MultipartFile y FileUpload en el mensaje', () => {
  const { read } = scaffoldExtended();
  // addProductImage devuelve Product, así que su endpoint vive en el controlador
  // del agregado que devuelve, no en el de la entidad hija.
  const controller = read(controllerPath('product'));
  const command = read(`${JAVA}/application/commands/AddProductImageCommand.java`);

  assert.ok(controller.includes('consumes = MediaType.MULTIPART_FORM_DATA_VALUE'));
  assert.ok(controller.includes('@RequestPart(value = "image") MultipartFile image'));
  assert.ok(controller.includes('toFileUpload(image)'));
  assert.ok(command.includes('FileUpload image'));
  assert.ok(!command.includes('String image'));
});

test('relación bidireccional: mappedBy en la raíz y mapeo sin ciclo', () => {
  const { read } = scaffoldExtended();
  const parentJpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);
  const childJpa = read(`${JAVA}/infrastructure/persistence/entities/ProductImageJpa.java`);
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`);
  const childDomain = read(`${JAVA}/domain/entity/ProductImage.java`);

  // Un solo dueño de la FK: la hija.
  assert.ok(parentJpa.includes('@OneToMany(mappedBy = "product"'));
  assert.ok(childJpa.includes('@ManyToOne(optional = false)'));
  // El mapper de la hija no vuelve al padre; el vínculo lo estampa el padre.
  const childToJpa = adapter.slice(adapter.indexOf('private void applyToJpa(ProductImage domain'));
  assert.ok(!childToJpa.includes('applyToJpa(domain.getProduct()'));
  assert.ok(adapter.includes('childJpa.setProduct(jpa);'));
  // Y el dominio de la hija no arrastra la referencia al padre.
  assert.ok(!childDomain.includes('Product product'));
});

test('errores: un code con http distinto por operación recibe el status por constructor', () => {
  const { read, result } = scaffoldExtended();
  const shared = read(`${JAVA}/domain/errors/CategoryNotFoundError.java`);
  const single = read(`${JAVA}/domain/errors/ProductNotFoundError.java`);

  assert.ok(shared.includes('extends DomainException'));
  assert.ok(shared.includes('CategoryNotFoundError(String message, int httpStatus)'));
  assert.ok(result.warnings.some((w) => w.includes("Nota: 'CATEGORY_NOT_FOUND'") && w.includes('status distintos')));
  // El caso normal (un solo http) no cambia.
  assert.ok(single.includes('extends NotFoundException'));
  assert.ok(single.includes('"PRODUCT_NOT_FOUND", 404'));
});

test('caché: CacheConfig con JavaTimeModule, TTL del diseño y constante por caché', () => {
  const { read } = scaffoldExtended();
  const config = read(`${JAVA}/infrastructure/configurations/cache/CacheConfig.java`);

  assert.ok(config.includes('registerModule(new JavaTimeModule())'));
  assert.ok(config.includes('SerializationFeature.WRITE_DATES_AS_TIMESTAMPS'));
  assert.ok(config.includes('GET_PRODUCT_BY_SLUG_CACHE = "catalog:get-product-by-slug"'));
  assert.ok(config.includes('Duration.ofSeconds(300)'));
  assert.ok(config.includes('disableCachingNullValues()'));
  assert.ok(config.includes('CacheErrorHandler'));
});

test('infra: reset-db.sh borra también las claves de la caché del servicio', () => {
  const { read } = scaffoldExtended();
  const reset = read('infra/reset-db.sh');
  // El comando va entre comillas simples de bash: sq() reescribe las internas.
  assert.ok(reset.includes('redis-cli -h redis --scan --pattern '));
  assert.ok(reset.includes('catalog:*'));
  assert.ok(reset.includes('flyway_schema_history'));
});

// ─── Tercer informe: el arnés de pruebas (§1.1 y §1.2) ───────────────────────

test('§1.1: el sondeo del broker va por argv, nunca por una cadena con comillas para sh -c', () => {
  const { workspace } = scaffoldExtended();
  const harness = (broker) => {
    const { manifest, layers } = loadService(fixtureDir);
    const out = tmpDir(`keel-probe-${broker}-`);
    scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker } });
    return fs.readFileSync(
      path.join(out, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
      'utf8'
    );
  };
  assert.ok(workspace); // el scaffolding por defecto sigue generándose

  const rabbit = harness('rabbitmq');
  // El cuerpo JSON viaja por archivo copiado al contenedor: pasarlo en la línea de
  // comandos es lo que docker.exe/podman.exe corrompen en Windows (400 not_json).
  assert.ok(rabbit.includes('private static void copyToDevtools(String content, String target)'));
  assert.ok(rabbit.includes('"-d", "@" + PROBE_BODY'));
  assert.ok(!rabbit.includes('String.format('));
  // Un curl fallido ya no se traga: exit code != 0 lanza con la evidencia.
  assert.ok(rabbit.includes('Falló el sondeo de infraestructura (código'));
  assert.ok(rabbit.includes('FailureCapture.recordProbe(command, exit, output)'));
  // El runtime se detecta como en los scripts: nada de caer a "docker" a secas.
  assert.ok(rabbit.includes('List.of("docker", "podman")'));

  const sqs = harness('snssqs');
  assert.ok(sqs.includes('"sqs", "purge-queue", "--queue-url"'));

  // La rama Kafka aprendió la misma lección: el humo publica un JSON crudo y el
  // cuerpo viaja por archivo, no embebido en la cadena de `sh -c`. Con el payload
  // en la línea de comandos, Windows se come las comillas dobles y lo que llega al
  // topic es `{metadata:{eventType:X}}`: el filtro por canal no lo reconoce y el
  // test agota el timeout sin decir por qué.
  const kafka = harness('kafka');
  assert.ok(kafka.includes('private static void copyToDevtools(String content, String target)'));
  // El copiado vive ahora en deliverMessage, del que publishRaw es un caso particular
  // (el topic propio, sin cabeceras): una sola vía de entrega, una sola lección aprendida.
  // Y con Kafka el cuerpo se colapsa a UNA línea antes de copiarlo, porque `kcat -l`
  // manda un mensaje POR LÍNEA: un payload escrito como text block llegaba troceado en
  // varios mensajes indeserializables (informe de notifications-spring § 1.5).
  assert.ok(kafka.includes(`copyToDevtools(${collapseToSingleLineJava('body')}, DELIVER_BODY);`));
  assert.ok(!kafka.includes('copyToDevtools(body, DELIVER_BODY);'));
  assert.ok(kafka.includes('deliverMessage(EVENT_TOPIC, key, payload, Map.of());'));
  assert.ok(!kafka.includes("printf '%s'"));
  assert.ok(!kafka.includes('shellQuote(payload)'));
  // Y el cuerpo tampoco se cuela por la cadena de sh -c en la vía nueva.
  assert.ok(!kafka.includes('shellQuote(body)'));
});

test('§1.1: la marca de offset tolera que el topic aún no exista (broker recién levantado)', () => {
  const { read } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // Contra un broker sin publicaciones previas —el caso normal: la infra de prueba
  // parte limpia— `kcat -o beginning` sale con "Unknown topic or partition" (código
  // 1) y runProcess lo convierte en excepción. La guarda tiene que estar en las dos
  // vías: el reset (markChannels) y la purga previa a un Then de "no se publica
  // nada", que puede ser la primerísima operación contra el broker (SMOKE-4).
  assert.ok(harness.includes('private static long safeNextOffset()'));
  assert.ok(harness.includes('MARKS.put(channel, safeNextOffset())'));
  assert.ok(harness.includes('long offset = safeNextOffset();'));
  assert.ok(!harness.includes('MARKS.put(channel, nextOffset())'));
});

test('§1.2: el reset purga los destinos de mensajería declarados', () => {
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
  );
  const out = tmpDir('keel-purge-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'rabbitmq' } });
  const reset = fs.readFileSync(path.join(out, 'services/metering-digest-spring/infra/reset-db.sh'), 'utf8');

  // El canal propio, que es su propio destino.
  assert.ok(reset.includes('/api/queues/%2F/digests/contents'));
  // Y la cola de la suscripción, que NO es el canal que el diseño nombra: el diseño declara
  // `channel: meterTelemetry` y se consume de `metering-gateway.events`. Este test afirmaba antes
  // el nombre lógico, o sea una cola inexistente — congelando el defecto: la purga es tolerante a
  // fallo, así que "purgar" algo que no existe se veía como un AVISO y la cola de entrada
  // arrastraba mensajes entre flujos. Ver reset-purges.test.js.
  assert.ok(reset.includes('/api/queues/%2F/metering-gateway.events/contents'));
  assert.ok(!reset.includes('/api/queues/%2F/meterTelemetry/contents'), 'el canal lógico no es un destino');
  // Que la cola aún no exista no es estado sucio: el reset avisa y sigue.
  assert.ok(reset.includes('AVISO: no se pudo purgar'));
});

test('§1.2: con Kafka no hay purga posible, el aislamiento es la marca de offset', () => {
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
  );
  const out = tmpDir('keel-mark-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'kafka' } });
  const root = path.join(out, 'services/metering-digest-spring');
  const reset = fs.readFileSync(path.join(root, 'infra/reset-db.sh'), 'utf8');
  const harness = fs.readFileSync(
    path.join(root, 'src/integrationTest/java/com/utilities/meteringdigest/flows/AbstractFlowIT.java'),
    'utf8'
  );

  assert.ok(!reset.includes('Canal purgado'));
  // La marca la refresca el reset del propio arnés, no el script.
  assert.ok(harness.includes('markChannels();'));
  assert.ok(harness.includes('CHANNELS = List.of("meterTelemetry", "digests")'));
  assert.ok(harness.includes('String offset = mark != null ? String.valueOf(mark) : "-" + count;'));
});

// El aislamiento entre flujos cubría BD, caché y canales, pero NO los destinos de
// descarte, y ese hueco no se ve como ruido: la aserción típica sobre un DLT es
// negativa —«el duplicado se absorbió sin acabar en el descarte»—, así que un mensaje
// muerto que sobrevive al reset aparece como el flujo siguiente fallando por algo que
// no hizo. Los dos brokers lo cierran por vías distintas porque Kafka no tiene purga.
function scaffoldStockReservation(broker) {
  const { manifest, layers, errors } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stock-reservation')
  );
  assert.deepEqual(errors, []);
  const out = tmpDir('keel-dlq-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker } });
  const root = path.join(out, 'services/stock-reservation-spring');
  return {
    reset: () => fs.readFileSync(path.join(root, 'infra/reset-db.sh'), 'utf8'),
    harness: () =>
      fs.readFileSync(
        path.join(root, 'src/integrationTest/java/com/fulfillment/stockreservation/flows/AbstractFlowIT.java'),
        'utf8'
      )
  };
}

test('el reset aísla también el destino de descarte: con Kafka, marcando su offset', () => {
  const harness = scaffoldStockReservation('kafka').harness();

  // El sondeo de offsets va parametrizado: sin la sobrecarga, marcar un DLT sería
  // marcar el topic del servicio y la marca no aislaría nada.
  assert.ok(harness.includes('private static long nextOffset(String topic)'));
  assert.ok(harness.includes('private static long safeNextOffset(String topic)'));
  // markChannels() marca los DLT declarados, deduplicados: las tres suscripciones de
  // la fixture multiplexan sobre el mismo `inventory.events.DLT`.
  assert.ok(harness.includes('for (String deadLetterTopic : Set.copyOf(DEAD_LETTER_OF.values()))'));
  assert.ok(harness.includes('MARKS.put(deadLetterTopic, safeNextOffset(deadLetterTopic))'));
  // Y la lectura arranca en esa marca, no en «los últimos count» del topic entero.
  assert.ok(harness.includes('Long mark = MARKS.get(deadLetterTopic);'));
  assert.ok(!harness.includes('"-t", deadLetterTopic, "-o", "-" + count'));
});

test('el reset aísla también el destino de descarte: con RabbitMQ, purgando su cola', () => {
  const { reset, harness } = scaffoldStockReservation('rabbitmq');

  // Kafka no llega aquí (sin `cliPurgeCmd`), pero RabbitMQ y SQS sí: su DLQ persiste
  // entre clases de flujo igual que cualquier otra cola.
  assert.ok(reset().includes('/api/queues/%2F/inventory.events-dlq/contents'));
  assert.ok(reset().includes('/api/queues/%2F/stockEvents/contents'));
  // La marca de offset es exclusiva de Kafka: aquí el aislamiento ya lo dio el script.
  assert.ok(!harness().includes('Set.copyOf(DEAD_LETTER_OF.values())'));
});

test('sin suscripciones con descarte no se marca ni se purga ningún DLT', () => {
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inspection-reports')
  );
  const out = tmpDir('keel-nodlq-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'kafka' } });
  const harness = fs.readFileSync(
    path.join(out, 'services/inspection-reports-spring/src/integrationTest/java/com/operations/inspectionreports/flows/AbstractFlowIT.java'),
    'utf8'
  );

  // `DEAD_LETTER_OF` solo existe si alguna suscripción lo declara: citarlo sin más
  // dejaría el arnés sin compilar en todo diseño que no use descarte.
  assert.ok(!harness.includes('DEAD_LETTER_OF'));
  // Lo que se afirma es que no se marca ni se purga un DLT, no que falte un import
  // concreto: `java.util.Set` tiene desde el arreglo del drenaje del outbox una segunda
  // razón legítima para estar (OUTBOX_CHANNELS), y atar el test a él lo convertió en un
  // proxy que se rompe por cambios que no tienen nada que ver con el descarte.
  assert.ok(!harness.includes('deadLetterTopic'));
  assert.ok(!harness.includes('DEAD_LETTER'));
  assert.ok(harness.includes('markChannels();'));
});

test('humo del arnés: con Kafka publica tráfico real; con RabbitMQ, los canales declarados', () => {
  const { read } = scaffoldExtended();
  // Con Kafka el destino por convención (`<servicio>.events`) ES el topic, así que
  // el humo sí puede sondearlo — pero no basta con leer sin excepción: Kafka
  // autocrea el topic vacío al primer sondeo, de modo que un topic equivocado pasa
  // igual que un canal sano. Por eso publica un mensaje sintético y lo espera de
  // vuelta: es lo que distingue las dos situaciones.
  const smoke = read('src/integrationTest/java/com/commerce/catalog/flows/HarnessSmokeIT.java');
  assert.ok(smoke.includes('probeChannel("catalog.events"'));
  assert.ok(smoke.includes('publishRaw(eventType,'));
  assert.ok(smoke.includes('await(Duration.ofSeconds(15)'));
  assert.ok(smoke.includes('resetClearsCache'));

  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
  );
  const out = tmpDir('keel-smoke-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'rabbitmq' } });
  const declared = fs.readFileSync(
    path.join(out, 'services/metering-digest-spring/src/integrationTest/java/com/utilities/meteringdigest/flows/HarnessSmokeIT.java'),
    'utf8'
  );
  assert.ok(declared.includes('for (String channel : List.of("digests"))'));
});

test('clearCache() vacía exactamente lo mismo que el reset, con su misma orden', () => {
  const { read, result } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // El Then que mide un miss tras una invalidación no puede resetear el estado
  // entero: se llevaría por delante lo que dejaron los escenarios anteriores del
  // mismo flujo. Y el conjunto de claves que borra tiene que ser EL MISMO que el
  // del reset — de ahí que la orden salga de devtools.js y no de un literal aquí.
  const expected = cacheFlushCmd(CACHES[result.stack.cache], { artifactId: 'catalog' });
  assert.ok(harness.includes('protected static void clearCache()'));
  assert.ok(harness.includes(`devtoolsShell("${expected}")`));

  // Y el humo lo ejercita en vivo, no solo el reset completo.
  const smoke = read('src/integrationTest/java/com/commerce/catalog/flows/HarnessSmokeIT.java');
  assert.ok(smoke.includes('clearCache();'));
  assert.ok(smoke.includes('clearCache() no borra las claves'));
});

// ─── Fricciones de la generación de catalog-spring (informe de fricciones) ────

test('el arnés permite fijar la Idempotency-Key también en una subida multipart', () => {
  const { read } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // Sin esta variante, el punto "repetir la subida con la misma clave no duplica"
  // de un escenario de imágenes es inexpresable: la firma corta genera una clave
  // nueva por llamada, así que la segunda subida nunca es un reintento.
  assert.ok(harness.includes('protected Response multipartWithKey('));
  assert.ok(harness.includes('String idempotencyKey) {'));
  // La firma corta sigue existiendo y delega: los escenarios que no ejercitan
  // deduplicación no cambian.
  assert.ok(harness.includes('Map<String, String> fields) {\n        return multipartTo('));
  // El header ya no se estampa incondicionalmente: sale de la clave recibida.
  assert.ok(!harness.includes('headers.set("Idempotency-Key", idempotencyKey());'));
  assert.ok(harness.includes('headers.set("Idempotency-Key", idempotencyKey);'));
});

test('sin idempotencia declarada, el arnés no estampa Idempotency-Key en multipart', () => {
  const { manifest, layers } = loadService(fixtureDir);
  const sinIdempotencia = structuredClone(layers);
  for (const operation of Object.values(sinIdempotencia['use-cases'].operations)) {
    delete operation.idempotency;
  }
  const workspace = tmpDir('keel-regression-');
  scaffoldService({ manifest, layers: sinIdempotencia, workspace, force: true });
  const harness = fs.readFileSync(
    path.join(workspace, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
    'utf8'
  );

  // Enviar el header donde el diseño no declara idempotencia prueba un contrato
  // que el servicio no tiene: `exchange` ya lo evitaba, `multipart` no.
  assert.ok(!harness.includes('multipartWithKey'));
  assert.ok(!harness.includes('exchangeWithKey'));
  // No hay clave que estampar: ambas rutas delegan con null y la guarda del
  // header nunca se cumple. `idempotencyKey()` no llega a invocarse en ninguna.
  assert.ok(!harness.includes('idempotencyKey()'));
  assert.ok(harness.includes('if (idempotencyKey != null) {'));
});

test('el arnés sondea el topic físico del servicio, no el canal lógico', () => {
  const { read } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // El código publica todos los eventos en `messaging.publishing.destination`
  // con una routing key por evento (mapping.md § messaging). Un arnés que asuma
  // un topic por canal lee un topic que nadie escribe: Kafka lo autocrea vacío y
  // el timeout resultante es indistinguible de "el código no publica".
  assert.ok(harness.includes('EVENT_TOPIC ='));
  assert.ok(harness.includes('System.getenv().getOrDefault("MESSAGING_DESTINATION", "catalog.events")'));
  assert.ok(harness.includes('"-t", EVENT_TOPIC'));
  assert.ok(!harness.includes('"-t", destination'));
  // La discriminación por canal es por eventType del envelope, no por la key del
  // mensaje: la key difiere entre la ruta outbox y la best-effort.
  assert.ok(harness.includes('CHANNEL_EVENT_TYPES'));
  assert.ok(harness.includes('"\\"eventType\\":\\"" + type + "\\""'));
});

test('kcat se invoca siempre en modo consumidor (-C)', () => {
  const { read } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // Sin `-C` y sin TTY en stdin, kcat elige modo productor: recibe EOF y sale
  // con éxito y salida vacía, un falso negativo silencioso.
  const invocations = harness.match(/devtools\("kcat"[^)]*\)/g) ?? [];
  assert.ok(invocations.length >= 2);
  for (const invocation of invocations) {
    assert.ok(invocation.includes('"-C"'), `kcat sin -C: ${invocation}`);
  }
});

test('el producer de Kafka serializa String: un único punto de serialización', () => {
  const { read } = scaffoldExtended();
  const kafka = read('src/main/resources/parameters/local/kafka.yaml');

  // Con JsonSerializer, el String que ya produjo el ObjectMapper de la app se
  // serializaba otra vez (JSON escapado dos veces) y, cuando el valor era un
  // POJO, lo hacía un ObjectMapper por defecto sin los módulos de la app.
  assert.ok(kafka.includes('value-serializer: org.apache.kafka.common.serialization.StringSerializer'));
  assert.ok(!kafka.includes('value-serializer: org.springframework.kafka.support.serializer.JsonSerializer'));
});

test('la concurrencia del listener de Kafka se parametriza y nunca es obligatoria', () => {
  const { read } = scaffoldExtended();

  // Es configuración de la INSTANCIA (hilos consumidores de este proceso), no del
  // cluster: tiene que existir como propiedad o el agente acaba escribiéndola como
  // literal en el @KafkaListener, que es lo que prohíbe constitution.md.
  assert.ok(read('src/main/resources/parameters/local/kafka.yaml').includes('concurrency: 1'));

  // Con default en todos los ambientes (envWithDefault, igual que KAFKA_GROUP_ID):
  // nadie debe quedarse sin arrancar por no haber dicho cuántos hilos quiere.
  for (const profile of ['develop', 'production']) {
    const yaml = read(`src/main/resources/parameters/${profile}/kafka.yaml`);
    assert.ok(
      yaml.includes('concurrency: ${KAFKA_LISTENER_CONCURRENCY:1}'),
      `${profile}: la concurrencia debe ser parametrizable y traer default`
    );
  }
});

test('el ObjectMapper de la caché sabe reconstruir agregados sin setters', () => {
  const { read } = scaffoldExtended();
  const cache = read(`${JAVA}/infrastructure/configurations/cache/CacheConfig.java`);

  // Las tres piezas son necesarias y ninguna se deduce de la anterior. Sin
  // ellas la caché no falla: el CacheErrorHandler degrada a miss silencioso y
  // nunca retiene nada.
  assert.ok(cache.includes('mapper.setVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)'));
  assert.ok(cache.includes('mapper.setVisibility(PropertyAccessor.CREATOR, JsonAutoDetect.Visibility.ANY)'));
  assert.ok(cache.includes('new ParameterNamesModule(JsonCreator.Mode.PROPERTIES)'));
  assert.ok(cache.includes('import com.fasterxml.jackson.module.paramnames.ParameterNamesModule;'));
});

test('la violación de unicidad usa el error declarado del diseño cuando lo hay', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);

  // El diseño declara SKU_ALREADY_EXISTS: el code sintetizado por convención
  // (PRODUCT_SKU_ALREADY_EXISTS) viajaría en un 409 público sin ser contrato.
  assert.ok(handler.includes('new SkuAlreadyExistsError('));
  assert.ok(!handler.includes('PRODUCT_SKU_ALREADY_EXISTS'));
  assert.ok(handler.includes('import com.commerce.catalog.domain.errors.SkuAlreadyExistsError;'));
  // Sin error declarado (unicidad de Category.slug) sigue el fallback con TODO.
  assert.ok(handler.includes('"CATEGORY_SLUG_ALREADY_EXISTS"'));
  assert.ok(handler.includes('TODO (agente)'));
});

test('storage: la política declarada llega a la aplicación por un puerto, no por @Value', () => {
  // maxSizeMb y allowedContentTypes viajaban solo al YAML, y la capa application
  // no puede leer @Value sin romper la frontera hexagonal: acababan como
  // literales en el command handler, un espejo del diseño que nadie sincroniza.
  const { read } = scaffoldExtended();
  const policy = read(`${JAVA}/domain/storage/BucketPolicy.java`);
  const port = read(`${JAVA}/domain/storage/StoragePolicies.java`);
  const properties = read(`${JAVA}/infrastructure/storage/StorageProperties.java`);
  const config = read(`${JAVA}/infrastructure/storage/StoragePolicyConfig.java`);

  assert.ok(policy.includes('public boolean allowsContentType(String contentType)'), policy);
  assert.ok(policy.includes('public boolean allowsSize(long sizeBytes)'), policy);
  // El nombre del bucket es una constante: renombrarlo en el diseño rompe la
  // compilación, no una subida en producción.
  assert.ok(port.includes('String PRODUCT_IMAGES = "productImages";'), port);
  assert.ok(properties.includes('@ConfigurationProperties("storage")'), properties);
  assert.ok(properties.includes('implements StoragePolicies'), properties);
  assert.ok(config.includes('@EnableConfigurationProperties(StorageProperties.class)'), config);

  // El puerto es de dominio: nada de Spring en él.
  assert.ok(!port.includes('org.springframework'), port);
  assert.ok(!policy.includes('org.springframework'), policy);
});

test('storage: no se emite una clave `bucket` global que ningún minio-init crea', () => {
  const { read } = scaffoldExtended();
  const local = read('src/main/resources/parameters/local/storage.yaml');

  // La skill de S3 instruía leerla con @Value, y apuntaba a un bucket inexistente.
  assert.ok(!/^ {2}bucket:/m.test(local), local);
  assert.ok(local.includes('    productImages:'), local);
});

test('§1.6: la tabla de parámetros de production sale de los YAML generados, no de una lista a mano', () => {
  const { read } = scaffoldExtended();
  const readme = read('README.md');
  const production = read('src/main/resources/parameters/production/storage.yaml');

  // Un bucket declarado emite su propia variable: era justo lo que la tabla
  // escrita a mano no listaba (y nadie cruzaba contra el YAML).
  assert.ok(production.includes('${STORAGE_BUCKET_PRODUCT_IMAGES}'));
  assert.ok(readme.includes('| `STORAGE_BUCKET_PRODUCT_IMAGES` |'));

  // Toda variable sin default de un fragmento de production está en la tabla.
  const required = [
    ...new Set(
      ['db', 'storage', 'kafka', 'redis']
        .map((name) => {
          try {
            return read(`src/main/resources/parameters/production/${name}.yaml`);
          } catch {
            return '';
          }
        })
        .join('\n')
        .matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)
    )
  ].map(([, name]) => name);
  assert.ok(required.length > 0);
  for (const name of required) {
    assert.ok(readme.includes(`| \`${name}\` |`), `falta ${name} en la tabla del README`);
  }
});

test('infra: export-schema.sh verifica los nombres de constraint del diseño', () => {
  const { read } = scaffoldExtended();
  const script = read('infra/export-schema.sh');
  assert.ok(script.includes('uk_products_natural'));
  assert.ok(script.includes('AVISO: el DDL exportado no nombra estas constraints'));
});

// ─── Segundo informe de inconsistencias (R1–R6, R9, C3, C4, C6) ──────────────

test('R2: los parámetros de ruta no llevan Bean Validation en el Command', () => {
  const { read } = scaffoldExtended();
  const command = read(`${JAVA}/application/commands/UpdateProductCommand.java`);
  const controller = read(controllerPath('product'));

  // El id va en la ruta y nunca en el cuerpo: un @NotNull sobre él rechaza con
  // 422 toda petición correcta, hiciera lo que hiciera el cliente.
  assert.ok(command.includes('UUID id,'));
  assert.ok(!command.includes('@NotNull UUID id'));
  assert.ok(controller.includes('updateProduct(@PathVariable UUID id'));
});

test('C6: cuerpo enteramente opcional → @RequestBody(required = false) y fusión null-safe', () => {
  const { read } = scaffoldExtended();
  const controller = read(controllerPath('product'));

  assert.ok(controller.includes('@Valid @RequestBody(required = false) UpdateProductCommand command'));
  assert.ok(controller.includes('command == null ? JsonNullable.<String>undefined() : command.name()'));
  // El testigo de tipo nombra el tipo: el controller tiene que importarlo aunque
  // no aparezca en ninguna firma (si no, no compila).
  assert.ok(controller.includes("import org.openapitools.jackson.nullable.JsonNullable;"));
  assert.ok(controller.includes("import java.util.UUID;"));
});

test('C3: PATCH parcial con tri-estado JsonNullable (ausente ≠ null explícito)', () => {
  const { read } = scaffoldExtended();
  const command = read(`${JAVA}/application/commands/UpdateProductCommand.java`);
  const buildGradle = read('build.gradle');
  const webConfig = read(`${JAVA}/infrastructure/configurations/WebConfig.java`);

  // La constraint va DENTRO del genérico. Fuera —`@Size(...) JsonNullable<String>`—
  // queda sobre el CONTENEDOR: Hibernate Validator resuelve el validador por el tipo
  // declarado, antes de mirar el valor, y lanza UnexpectedTypeException (HV000030) en
  // TODA petición que traiga el campo, válida o no. El endpoint entero responde 500.
  //
  // Esta aserción fijaba la forma defectuosa y la suite salía verde: el `includes(...)`
  // encuentra la anotación y encuentra el tipo, y no hay comparación de cadenas que
  // distinga dónde está puesta. Lo destapó una corrida real (FL-PRD-002-D/E), y por eso
  // ahora también se prohíbe explícitamente la forma vieja.
  assert.ok(command.includes('JsonNullable<@Size(max = 200) String> name'), command);
  assert.ok(!/@Size\([^)]*\)\s+JsonNullable</.test(command), command);
  assert.ok(command.includes('JsonNullable<UUID> categoryId'));
  assert.ok(buildGradle.includes('org.openapitools:jackson-databind-nullable'));
  assert.ok(webConfig.includes('public JsonNullableModule jsonNullableModule()'));
  // Y el value extractor, que es lo que permite a Bean Validation desenvolver el
  // contenedor para aplicar la constraint de dentro.
  const extractor = read('src/main/resources/META-INF/services/jakarta.validation.valueextraction.ValueExtractor');
  assert.ok(extractor.includes('JsonNullableValueExtractor'));
});

test('R1: un nombre de columna que es palabra reservada SQL va entrecomillado', () => {
  const { read } = scaffoldExtended();
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductImageJpa.java`);
  const dbYaml = read('src/main/resources/parameters/local/db.yaml');

  assert.ok(jpa.includes('@Column(name = "`primary`")'));
  assert.ok(jpa.includes('@Column(name = "`position`", nullable = false)'));
  // Red de seguridad dialecto a dialecto para lo que la lista no cubra.
  assert.ok(dbYaml.includes('auto_quote_keyword: true'));
});

test('índices: columnList usa la columna real de la relación, no su nombre lógico', () => {
  const { read } = scaffoldExtended();
  const product = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);
  const image = read(`${JAVA}/infrastructure/persistence/entities/ProductImageJpa.java`);

  assert.ok(product.includes('columnList = "category_id, status"'));
  assert.ok(!product.includes('columnList = "category, status"'));
  assert.ok(image.includes('columnList = "product_id, `position`, `primary`"'));
});

test('version: el contador declarado por el diseño es de dominio y no es el @Version de JPA', () => {
  const { read, result } = scaffoldExtended();
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);
  const domain = read(`${JAVA}/domain/aggregate/Product.java`);

  // Dos campos distintos: el contador del diseño (columna version, sin @Version) y
  // el de bloqueo optimista que pone build (lock_version, con @Version).
  assert.ok(jpa.includes('private Long version;'));
  assert.ok(jpa.includes('@Version\n    @Column(name = "lock_version")\n    private Long lockVersion;'));
  assert.equal(jpa.split('@Version').length - 1, 1);
  assert.ok(domain.includes('public Long getVersion() {'));
  assert.ok(domain.includes('public Long getLockVersion() {'));
  assert.ok(!result.warnings.some((w) => w.includes('lockVersion')));
});

// La política de concurrencia es del diseño, no del generador: un servicio que
// declara "último escritor gana" y un escenario que espera dos 200 no puede
// recibir un 409 de Hibernate por un @Version que nadie pidió.
function scaffoldWithLocking(policy) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.persistence.consistency = { ...(patched.persistence.consistency ?? {}), optimisticLocking: policy };
  const workspace = tmpDir('keel-locking-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  return { result, read };
}

test('concurrencia: optimisticLocking none no genera @Version ni el 409 de conflicto', () => {
  const { read } = scaffoldWithLocking('none');
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);
  const domain = read(`${JAVA}/domain/aggregate/Product.java`);
  const advice = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);

  assert.ok(!jpa.includes('@Version'));
  assert.ok(!jpa.includes('lock_version'));
  assert.ok(!domain.includes('getLockVersion()'));
  // El contador de dominio que sí declara el diseño no se ve afectado.
  assert.ok(jpa.includes('private Long version;'));
  // Sin @Version no hay ObjectOptimisticLockingFailureException que traducir.
  assert.ok(!advice.includes('CONCURRENT_MODIFICATION'));
  assert.ok(!advice.includes('ObjectOptimisticLockingFailureException'));
});

test('concurrencia: optimisticLocking all (default) sigue protegiendo toda raíz', () => {
  const { read } = scaffoldWithLocking('all');
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);

  assert.ok(jpa.includes('@Version\n    @Column(name = "lock_version")'));
  // El code CANÓNICO del catálogo (keel-core, docs/framework-errors.md), no una invención
  // del scaffolding: nombra el hecho —algo cambió mientras escribías— y no la técnica con
  // la que se detecta. `OPTIMISTIC_LOCK_CONFLICT`, que era el canónico anterior, sigue en
  // la familia: un proyecto que quiera conservarlo solo tiene que declararlo en sus errors.
  assert.ok(read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`).includes('CONCURRENT_MODIFICATION'));
});

test('concurrencia: el code del conflicto sale del diseño cuando lo declara', () => {
  // El 409 por @Version llega con el code del scaffolding solo si el diseño no
  // tiene el suyo. Declarado, es contrato público: gana al genérico.
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched['use-cases'].operations.updateProduct.errors.push({
    code: 'CONCURRENT_MODIFICATION',
    when: 'El producto fue modificado por otra petición desde que se leyó.',
    http: 409
  });
  const workspace = tmpDir('keel-concurrency-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const advice = fs.readFileSync(
    path.join(workspace, 'services', 'catalog-spring', JAVA, 'infrastructure/rest/ApiExceptionHandler.java'),
    'utf8'
  );

  assert.ok(advice.includes('onDomainException(new ConcurrentModificationError('), advice);
  assert.ok(!advice.includes('OPTIMISTIC_LOCK_CONFLICT'), advice);
});

test('concurrencia: optimisticLocking declared solo protege las raíces con lockVersion', () => {
  // El fixture no declara el campo reservado en ninguna raíz: la política es
  // entonces indistinguible de none, y así debe generarse.
  const { read } = scaffoldWithLocking('declared');
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);

  assert.ok(!jpa.includes('@Version'));
  assert.ok(!read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`).includes('OPTIMISTIC_LOCK_CONFLICT'));
});

test('R3: los enums del contrato se bindean también como query param', () => {
  const { read } = scaffoldExtended();
  const factory = read(`${JAVA}/infrastructure/web/JsonValueEnumConverterFactory.java`);
  const webConfig = read(`${JAVA}/infrastructure/configurations/WebConfig.java`);

  assert.ok(factory.includes('implements ConverterFactory<String, Enum>'));
  assert.ok(factory.includes('JsonValue.class'));
  assert.ok(webConfig.includes('registry.addConverterFactory(new JsonValueEnumConverterFactory())'));
});

test('R4: el sobre de paginación es el canónico y el maxSize del diseño se aplica', () => {
  const { read } = scaffoldExtended();
  const paged = read(`${JAVA}/application/dtos/PagedResponse.java`);
  const appYaml = read('src/main/resources/application.yaml');

  assert.ok(paged.includes('List<T> items, int page, int size, long totalElements, int totalPages'));
  assert.ok(!paged.includes('List<T> content'));
  assert.ok(appYaml.includes('max-page-size: 100'));
  assert.ok(appYaml.includes('default-page-size: 20'));
});

test('R5: build no prejuzga "ausencia vs. nulo": es convención del diseño', () => {
  const { read } = scaffoldExtended();
  const appYaml = read('src/main/resources/application.yaml');

  // Un default global arrastra al MessageConverter del broker (comparte el
  // ObjectMapper autoconfigurado) y decide el contrato observable de todo
  // servicio generado. La convención la implementa el agente con @JsonInclude
  // por clase, según lo que declare specs/validation-scenarios.md.
  assert.ok(!appYaml.includes('default-property-inclusion'));
  assert.ok(appYaml.includes('write-dates-as-timestamps: false'));
  assert.ok(!read(`${JAVA}/infrastructure/rest/ErrorResponse.java`).includes('@JsonInclude'));
});

test('R5b: los instantes salen con precisión de milisegundos, no de plataforma', () => {
  const { read } = scaffoldExtended();
  const module = read(`${JAVA}/infrastructure/serialization/TimestampModule.java`);

  assert.ok(module.includes('appendInstant(3)'));
  assert.ok(module.includes('addSerializer(Instant.class'));
  assert.ok(
    read(`${JAVA}/infrastructure/serialization/JacksonConfig.java`).includes(
      'modulesToInstall(TimestampModule.class)'
    )
  );
  // La caché sirve el mismo byte que serviría la base de datos.
  assert.ok(
    read(`${JAVA}/infrastructure/configurations/cache/CacheConfig.java`).includes(
      'registerModule(new TimestampModule())'
    )
  );
});

test('storage: los buckets del diseño los prepara infra/, no el arranque de la app', () => {
  const { read } = scaffoldExtended();
  const compose = read('infra/docker-compose.yaml');
  const script = read('infra/validate-infra.sh');
  const storageYaml = read('src/main/resources/parameters/local/storage.yaml');

  // El sidecar crea el bucket y le aplica la policy: sin esto el hueco solo
  // aparecía como blocker a mitad de la validación funcional.
  assert.ok(compose.includes('minio-init'));
  assert.ok(compose.includes('mc mb --ignore-existing local/catalog-product-images'));
  assert.ok(compose.includes('mc anonymous set download local/catalog-product-images'));

  // Sin política de reinicio: `restart: "no"` es válido en docker-compose pero
  // podman-compose lo lee como el booleano false de YAML y aborta el sidecar
  // («"False" is not a valid restart policy»), dejando el bucket sin crear.
  assert.ok(!compose.includes('restart:'), compose);

  // Y la infraestructura se declara mal desde el sondeo, antes de arrancar nada.
  // El sondeo mide el EFECTO (un GET anónimo que responde 200), no el nombre del
  // preset: en cuanto el adaptador aplica su propia bucket policy al arrancar,
  // `mc anonymous get` la etiqueta `custom` y comparar contra `download` daba un
  // FALLO que había que ir a desmentir a mano con un curl.
  assert.ok(script.includes('curl -sf -o /dev/null http://minio:9000/catalog-product-images/.keel-anon-probe'));
  assert.ok(script.includes('mc rm --force local/catalog-product-images/.keel-anon-probe'));
  assert.ok(!script.includes('mc anonymous get'));

  // Nombre físico en la config: el adaptador lo lee, no lo inventa.
  assert.ok(storageYaml.includes('bucket: catalog-product-images'));
  assert.ok(storageYaml.includes('visibility: public'));
});

test('R6: los errores de forma son 400; el 422 queda para las reglas de negocio', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  const validation = handler.slice(handler.indexOf('onMethodArgumentNotValid') - 200, handler.indexOf('onConstraintViolation'));

  assert.ok(validation.includes('@ResponseStatus(HttpStatus.BAD_REQUEST)'));
  assert.ok(!validation.includes('@ResponseStatus(HttpStatus.UNPROCESSABLE_ENTITY)'));
  assert.ok(handler.includes('@ExceptionHandler(BusinessException.class)'));
});

test('C4: el límite multipart del servlet deja holgura sobre el límite de negocio', () => {
  const { read } = scaffoldExtended();
  // maxSizeMb del diseño = 5: si el servlet cortase ahí, Tomcat emitiría el 413
  // antes del caso de uso y ninguna guarda anterior podría precederlo.
  assert.ok(read('src/main/resources/application.yaml').includes('max-file-size: 10MB'));
});

test('C2/embed: una referencia a otro agregado se proyecta como objeto, no como id', () => {
  const { read } = scaffoldExtended();
  const dto = read(`${JAVA}/application/dtos/UpdateProductResponseDto.java`);
  const ref = read(`${JAVA}/application/dtos/CategoryRefDto.java`);
  const productMapper = read(`${JAVA}/application/mappers/ProductApplicationMapper.java`);
  const categoryMapper = read(`${JAVA}/application/mappers/CategoryApplicationMapper.java`);

  assert.ok(dto.includes('CategoryRefDto category'));
  assert.ok(!dto.includes('UUID categoryId'));
  // La proyección se corta a profundidad 1: el ref no arrastra las relaciones
  // del agregado referenciado (aquí, el parent de Category).
  assert.ok(!ref.includes('parent'));
  // El objeto lo resuelve el handler: entra como parámetro, no como null pendiente.
  assert.ok(productMapper.includes('toUpdateProductResponseDto(Product entity, CategoryRefDto category)'));
  assert.ok(categoryMapper.includes('public CategoryRefDto toCategoryRefDto(Category entity)'));

  // Y el handler tiene con qué resolverlo: el parámetro del mapper sin su
  // resolver dejaba el proyecto sin compilar. Detalle en read-composition.test.js.
  const handler = read(`${JAVA}/application/usecases/UpdateProductCommandHandler.java`);
  assert.ok(handler.includes('private final CategoryRefResolver categoryRefResolver;'));
});

// ─── Cuarto informe: infraestructura de mensajería (§1.1 y §1.2) ─────────────

// Helper: scaffolding de la fixture con un broker concreto, devolviendo un lector
// de archivos del proyecto generado.
function scaffoldWithBroker(broker) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const out = tmpDir(`keel-broker-${broker}-`);
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker } });
  return (relative) =>
    fs.readFileSync(path.join(out, 'services', 'catalog-spring', relative), 'utf8');
}

test('§1.1: el contenedor devtools trae credenciales AWS dummy', () => {
  // Sin ellas la AWS CLI aborta con "Unable to locate credentials" dentro de
  // devtools, y el check de LocalStack sale en rojo aunque SNS/SQS respondan.
  const read = scaffoldWithBroker('snssqs');
  const compose = read('infra/docker-compose.yaml');
  const devtools = compose.slice(compose.indexOf('devtools:'));
  assert.ok(devtools.includes('AWS_ACCESS_KEY_ID'), 'devtools sin AWS_ACCESS_KEY_ID');
  assert.ok(devtools.includes('AWS_SECRET_ACCESS_KEY'), 'devtools sin AWS_SECRET_ACCESS_KEY');
});

test('§1.2: con snssqs el nombre físico del destino no lleva puntos', () => {
  // SNS y SQS solo admiten [A-Za-z0-9_-] en topics y colas: `catalog.events`
  // es un nombre inválido y la topología no llega a crearse.
  const read = scaffoldWithBroker('snssqs');
  const messagingYaml = read('src/main/resources/parameters/local/messaging.yaml');
  const destination = messagingYaml.match(/destination:\s*(\S+)/)?.[1];
  assert.ok(destination, 'no hay destination en parameters/local/messaging.yaml');
  assert.ok(!destination.includes('.'), `destino inválido para SNS/SQS: ${destination}`);
  assert.ok(destination.includes('catalog-events'), destination);
});

test('§1.2: con kafka se conserva el punto, que ahí es idiomático', () => {
  const read = scaffoldWithBroker('kafka');
  const destination = read('src/main/resources/parameters/local/messaging.yaml').match(/destination:\s*(\S+)/)?.[1];
  assert.ok(destination.includes('catalog.events'), destination);
});

test('§1.2: con snssqs se genera la topología (topics, colas, DLQ, raw delivery)', () => {
  // Sin este script nadie crea topics ni colas: la app arranca contra un topic
  // inexistente y el humo del arnés muere con NonExistentQueue.
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
  );
  const out = tmpDir('keel-topology-');
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'snssqs' } });
  const root = path.join(out, 'services', 'metering-digest-spring');

  const script = fs.readFileSync(path.join(root, 'infra/init-messaging.sh'), 'utf8');
  assert.ok(script.includes("create_topic 'metering-digest-events'"), 'falta el topic de publicación');
  assert.ok(script.includes("create_topic 'metering-gateway-events'"), 'falta el topic de la fuente');
  // La cola es del consumidor, y su DLQ lleva el maxReceiveCount del diseño.
  assert.ok(script.includes("create_queue_with_dlq 'metering-digest-meter-reading-captured'"), script);
  assert.ok(/create_queue_with_dlq '[^']+' \d+/.test(script), 'maxReceiveCount no es numérico');
  assert.ok(script.includes('RawMessageDelivery'), 'sin raw delivery el listener recibe el sobre SNS');
  assert.ok(script.includes('FilterPolicy'), 'sin filtro por eventType el fan-out entrega de más');

  // Cola de ARNÉS por canal de publicación, con el nombre del canal: es lo que
  // AbstractFlowIT#publishedMessages busca al componer la URL. Sin ella el humo del
  // arnés muere con NonExistentQueue y la suite entera se queda sin correr — y este
  // servicio no tiene subscriptions de negocio que la creasen de rebote.
  // SIN DLQ, y eso importa: la cola de arnés no la consume la aplicación, la lee el
  // arnés — y `publishedMessages` lee sin borrar, así que cada lectura incrementa el
  // contador de recepciones de SQS. Con redrive, un escenario que sondee el canal más
  // veces que `maxReceiveCount` vería el mensaje MOVIDO a la DLQ a mitad de la
  // aserción y lo leería como «el canal está vacío». Antes la tenían todas por un
  // default del script; ahora la DLQ es solo de quien la declara en el diseño.
  assert.ok(script.includes("create_queue 'digests'"), script);
  assert.ok(!script.includes("create_queue_with_dlq 'digests'"), script);
  assert.ok(script.includes("subscribe 'metering-digest-events' 'digests' 'DailyDigestClosed'"), script);

  // Ningun JSON viaja inline en el argv: podman.exe en Windows corrompe las
  // comillas anidadas al reenviar la linea de comandos al contenedor.
  assert.ok(!/--attributes\s+\w+='?\{/.test(script), 'JSON de politica inline en el argv');
  assert.ok(script.includes('put_json'), script);

  // El check tiene que medir que los recursos EXISTEN: `sns list-topics` da verde
  // con la lista vacía, que es exactamente el estado roto.
  const validate = fs.readFileSync(path.join(root, 'infra/validate-infra.sh'), 'utf8');
  assert.ok(validate.includes('sns get-topic-attributes'), validate);
  assert.ok(validate.includes('sqs get-queue-url --queue-name metering-digest-meter-reading-captured'), validate);
  // Y la de arnés también: mientras no se comprobaba, validate-infra.sh daba verde
  // sobre el estado que después tumbaba la suite.
  assert.ok(validate.includes('sqs get-queue-url --queue-name digests'), validate);
});

test('§1.2: los brokers que autocrean topología no generan el script', () => {
  for (const broker of ['kafka', 'rabbitmq']) {
    const { manifest, layers } = loadService(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
    );
    const out = tmpDir(`keel-topology-${broker}-`);
    scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker } });
    assert.ok(
      !fs.existsSync(path.join(out, 'services/metering-digest-spring/infra/init-messaging.sh')),
      `${broker} no necesita sembrar topología`
    );
  }
});

test('colección hija con orden explícito: @OrderBy en la entidad JPA', () => {
  const { read } = scaffoldExtended();
  const parentJpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);

  // `ProductImage.position` hace del orden un contrato observable (la galería se
  // devuelve ordenada). Sin @OrderBy, la colección llega en el orden que decida la
  // base de datos, y tras un reorder la lista en memoria no refleja lo recién
  // guardado salvo que cada adaptador se acuerde de reordenarla al mapear.
  assert.ok(parentJpa.includes('@OrderBy("position ASC")'), parentJpa);
  assert.ok(parentJpa.includes('import jakarta.persistence.OrderBy;'));
});

test('normalización antes que formato: el patrón del value type no llega al DTO de entrada', () => {
  const { read } = scaffoldExtended();
  const command = read(`${JAVA}/application/commands/CreateProductCommand.java`);

  // `sku` es de tipo SKU, cuyo formato describe el valor YA normalizado. Bean
  // Validation corre sobre el DTO antes de que el handler normalice nada: con
  // @Pattern, un sku en minúsculas moría con 422 VALIDATION_ERROR sin llegar a la
  // regla de negocio que debía responder 409 SKU_ALREADY_EXISTS — el escenario
  // fallaba por el error equivocado (conventions/mapping.md).
  // La anotación, no la palabra: lo que no puede estar es el @Pattern APLICADO al
  // componente. La nota de abajo lo nombra a propósito, y un `includes('@Pattern')`
  // a secas no distingue una cosa de la otra.
  assert.ok(!/^\s*@[A-Za-z]*\s*@?Pattern\(|@Pattern\(regexp[^\n]*\)\s+String sku/m.test(command), command);
  assert.ok(!command.includes('@NotBlank @Pattern'), command);
  // Presencia sí se queda: no compite con ninguna normalización.
  assert.ok(command.includes('@NotBlank String sku'), command);
  // Y no se quita en silencio: quitarlo sin decirlo deja la entrada sin validar
  // cuando el diseño NO normaliza ese campo (el sku de esta fixture se guarda tal
  // cual llega), y el borde acepta un formato que el diseño prohíbe — un 201 donde
  // el escenario espera un 400. Apareció en dos corridas seguidas y las dos veces lo
  // arregló el agente a mano, que es la señal de que el generador no lo estaba
  // planteando. La nota no decide por el diseño: deja la decisión escrita donde se ve.
  assert.ok(command.includes('El @Pattern del value type SKU'), command);
  assert.ok(command.includes('el formato tiene que volver aquí'), command);
});

// El mismo defecto lo encontró y corrigió a mano el agente de código en DOS corridas
// independientes sobre este diseño: reproducible y determinista, así que le toca al
// generador y no a cada generación.
test('el campo del lifecycle no entra en la entrada derivada', () => {
  const { read } = scaffoldExtended();
  const command = read(`${JAVA}/application/commands/CreateProductCommand.java`);

  // `Product.status` declara `required: true` con `default: draft` y es el campo del
  // `lifecycle`. Quien lo mueve es la máquina de estados del dominio —el default al
  // crear, las `transitions` después—, nunca el cliente, así que no es un campo opcional
  // de la entrada: no es de la entrada. Primero se le quitó el `@NotNull` (con él, el
  // camino feliz de createProduct devolvía 400 antes de llegar al handler) y dos
  // generaciones más tarde el agente seguía teniendo que razonar por qué el DTO le
  // ofrecía un estado que debía ignorar.
  assert.ok(!/ProductStatus status/.test(command), command);

  // Y no es que se haya caído la entrada entera: `sku` sigue estando y sigue validado.
  // Sin esta mitad, el test pasaría igual con el DTO vacío.
  assert.ok(command.includes('@NotBlank String sku'), command);
});

test('un campo con default que no es el del lifecycle sí entra, y sin exigir presencia', () => {
  const { read } = scaffoldExtended();
  const command = read(`${JAVA}/application/commands/AddProductImageCommand.java`);
  const dto = read(`${JAVA}/application/dtos/ProductImageDto.java`);

  // `ProductImage.primary` declara `default: false` y NO gobierna ningún lifecycle: es
  // una preferencia que el cliente puede fijar, así que sigue en el contrato. La
  // distinción importa —quitar todo lo que tenga `default` habría borrado también esto—
  // y build no la adivina: la lee del `lifecycle` que el dominio declara.
  assert.ok(dto.includes('Boolean primary') || dto.includes('boolean primary'), dto);
  // Lo que sí se relaja es la presencia: un default es precisamente el valor de quien
  // no lo manda.
  assert.ok(!/@NotNull\s+Boolean primary/.test(command), command);
});

test('la obligatoriedad de un campo con default sí llega a la entidad persistida', () => {
  const { read } = scaffoldExtended();
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);

  // La otra mitad de la regla anterior, y la que impide que el fix se lea como
  // "los campos con default pasan a ser opcionales": lo que se relaja es lo que el
  // cliente tiene que mandar, no lo que la fila puede guardar.
  assert.ok(/@Column\(name = "status"[^)]*nullable = false/.test(jpa), jpa);
});

// `required` en `response.fields` era lo único del DSL que se declaraba y no hacía
// cumplir nadie: el record salía pelado y un proveedor que devolviera `{}` pasaba por
// bueno. Con `awaits: outcome` el desenlace lo decide el cuerpo, así que el campo que
// falta es el que sostiene la decisión. Lo destapó FL-CMP-003.
test('la respuesta de un proveedor comprueba los campos que el contrato declara obligatorios', () => {
  const { read } = scaffoldExtended();
  const response = read(`${JAVA}/infrastructure/http/RecordWithdrawalResponse.java`);

  assert.ok(response.includes('public RecordWithdrawalResponse {'), response);
  assert.ok(response.includes('if (recordId == null)'), response);

  // El tipo importa tanto como la comprobación: NO puede ser una excepción con
  // sobrecarga de fallback. Si entrara al fallback se aplicaría el `onFailure` del
  // diseño —«proveedor no disponible», 502— por un proveedor que respondió
  // perfectamente, y además contaría para su circuito. Sin sobrecarga, resilience4j
  // la relanza y sale como 500, que es lo que el escenario exige.
  assert.ok(response.includes('throw new IllegalStateException'), response);
  for (const { simple } of providerFailures({ circuitBreaker: true, oauth2: true })) {
    assert.ok(!response.includes(simple), `${simple} tiene sobrecarga de fallback: la guarda no puede lanzarla`);
  }
});

test('un campo opcional de la respuesta no se comprueba, y una respuesta sin obligatorios no lleva guarda', () => {
  const { read } = scaffoldExtended();

  // `cancelled` es required → guarda. Si algún día deja de serlo, este test lo dice.
  assert.ok(read(`${JAVA}/infrastructure/http/CancelWithdrawalResponse.java`).includes('if (cancelled == null)'));

  // La mitad que impide que la guarda se vuelva ruido: solo la llevan los campos que
  // el diseño marcó, no todos.
  const price = read(`${JAVA}/infrastructure/http/GetPriceResponse.java`);
  assert.ok(price.includes('if (amount == null)'), price);
  assert.ok(price.includes('if (currency == null)'), price);
});

// La tercera frontera de datos ajenos, y la que quedaba sin comprobar.
// `@JsonIgnoreProperties(ignoreUnknown = true)` cubre los campos de MÁS; los que faltan
// entraban como null en silencio — incluido `occurredAt`, que es el que ordena las
// reentregas para que un hecho viejo no pise a uno nuevo.
test('el payload de un evento entrante comprueba sus campos obligatorios', () => {
  const { read } = scaffoldExtended();
  const message = read(`${JAVA}/infrastructure/messaging/subscriptions/SupplierPriceChangedMessage.java`);

  assert.ok(message.includes('public void requireContract()'), message);
  for (const field of ['sku', 'amount', 'currency', 'occurredAt']) {
    assert.ok(message.includes(`if (${field} == null)`), `falta la comprobación de ${field}`);
  }
});

// La diferencia con la guarda gemela de los clientes HTTP, y no es simetría mal hecha:
// en un listener lanzar manda el mensaje al DESCARTE, y un canal compartido trae
// mensajes ajenos que hay que descartar sin lanzar. En el constructor saltaría al
// deserializar —antes del filtro por eventType— y mandaría a la DLQ un mensaje válido.
test('la guarda del evento entrante NO va en el constructor: eso mandaría al descarte un mensaje ajeno', () => {
  const { read } = scaffoldExtended();
  const message = read(`${JAVA}/infrastructure/messaging/subscriptions/SupplierPriceChangedMessage.java`);

  assert.ok(!message.includes('public SupplierPriceChangedMessage {'), message);
  // Y el método dice cuándo llamarlo, que es la mitad que hace segura a la otra.
  assert.ok(message.includes('DESPUÉS de filtrar por {@code metadata.eventType}'), message);
});

// La cuarta frontera. Aquí el dato es NUESTRO: un required nulo es un bug propio, y
// saltar antes de mandarlo evita estrenarlo contra un tercero — encima en una escritura
// con reintentos, donde el intento malo se repite tal cual.
test('la petición saliente comprueba lo que el contrato del proveedor exige', () => {
  const { read } = scaffoldExtended();
  const request = read(`${JAVA}/infrastructure/http/RecordWithdrawalRequest.java`);

  assert.ok(request.includes('public RecordWithdrawalRequest {'), request);
  assert.ok(request.includes("la petición no lleva 'productId'"), request);
});

test('config de storage: el mapa storage.buckets.* está en los CUATRO perfiles, test incluido', () => {
  const { read } = scaffoldExtended();

  // El perfil test tenía su propio YAML escrito a mano, y se desincronizó: emitía
  // la clave plana `bucket: test-bucket` que el refactor a `storage.buckets.*`
  // eliminó del contrato, así que StorageProperties.forBucket lanzaba
  // IllegalStateException en cuanto el adaptador preguntaba por la política.
  // Ahora los cuatro salen de storageYaml(); esta prueba lo fija.
  for (const profile of ['local', 'develop', 'production', 'test']) {
    const yaml = read(`src/main/resources/parameters/${profile}/storage.yaml`);
    assert.ok(yaml.includes('  buckets:'), `${profile}: falta el mapa de buckets`);
    assert.ok(yaml.includes('    productImages:'), `${profile}: falta el bucket del diseño`);
    assert.ok(yaml.includes('      visibility: public'), `${profile}: falta la visibilidad declarada`);
    assert.ok(yaml.includes('      max-size-mb: 5'), `${profile}: falta el límite del diseño`);
    // La clave plana ya no existe: si reaparece, el adaptador vuelve a poder
    // leerla con @Value y a subir a un bucket que nadie preparó.
    assert.ok(!/^ {2}bucket:/m.test(yaml), `${profile}: clave 'bucket' plana, eliminada del contrato`);
    // La guarda de aprovisionamiento va en todos: sin ella el adaptador la lee
    // con el default `false` y en local no se asegura nada.
    assert.ok(yaml.includes('ensure-buckets-on-startup:'), `${profile}: falta la guarda de aprovisionamiento`);
  }

  // El perfil test es cerrado: sin red, sin aprovisionar y sin salir a AWS.
  const testYaml = read('src/main/resources/parameters/test/storage.yaml');
  assert.ok(testYaml.includes('ensure-buckets-on-startup: false'), testYaml);
  assert.ok(testYaml.includes('endpoint: http://localhost:9000'), testYaml);
});

test('config del perfil test: los fragmentos con placeholders del código están todos', () => {
  const { read } = scaffoldExtended();

  // testProfileFiles() escribe su propia tabla de fragmentos, y por eso se
  // desincronizó de la del bucle de perfiles: faltaba `messaging`, y el publisher
  // que escribe el agente lee el destino con un @Value sin default, así que
  // @SpringBootTest moría con PlaceholderResolutionException antes de ejecutar
  // ninguna prueba. Cada fragmento del perfil test tiene que arrancar sin que
  // nadie exporte nada: ningún ${VAR} sin default.
  const importados = read('src/main/resources/application-test.yaml');
  for (const name of ['db', 'messaging', 'idempotency', 'storage']) {
    assert.ok(importados.includes(`classpath:parameters/test/${name}.yaml`), `${name}: no se importa en el perfil test`);
    const yaml = read(`src/main/resources/parameters/test/${name}.yaml`);
    assert.ok(!/\$\{[^:}]+\}/.test(yaml), `${name}: placeholder sin default en el perfil test`);
  }
});

test('crones parametrizados: las comillas van fuera del placeholder, no dentro', () => {
  const { read } = scaffoldExtended();

  // `${VAR:"0 0 4 * * *"}` resuelve al literal CON las comillas, y Spring rechaza
  // el @Scheduled al arrancar ("invalid cron expression") en todo perfil que no
  // sea local. Salió a la luz al añadir messaging al perfil test, pero el defecto
  // estaba en develop y production desde siempre.
  for (const profile of ['local', 'develop', 'production', 'test']) {
    for (const name of ['messaging', 'idempotency']) {
      const yaml = read(`src/main/resources/parameters/${profile}/${name}.yaml`);
      for (const linea of yaml.split('\n').filter((l) => l.trim().startsWith('cron:'))) {
        assert.ok(!/:\s*\$\{[^}]*"/.test(linea), `${profile}/${name}: comillas dentro del placeholder → ${linea}`);
        assert.match(linea, /cron: "[^"]+"$/, `${profile}/${name}: el cron va entrecomillado entero → ${linea}`);
      }
    }
  }
});

// El orden del reclamo apareció mal en TRES generaciones distintas, y la causa no era
// el agente: la nota del stub le decía literalmente «si no hay registro, ejecuta y
// llama a save(...)». Con el save al final, la perdedora de una carrera choca antes
// contra la unicidad de negocio (`sku`) y el cliente recibe SKU_ALREADY_EXISTS en vez
// del code de la clave en curso — el servidor sigue ejecutando una sola vez, así que
// solo lo delata un escenario de concurrencia que afirme el code exacto.
test('idempotencia de comando: el stub manda reclamar ANTES de ejecutar el negocio', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/application/usecases/CreateProductCommandHandler.java`);

  assert.ok(handler.includes('RECLAMA PRIMERO'), handler);
  assert.ok(handler.includes('SOLO DESPUÉS ejecuta el negocio'), handler);
  // Y el porqué, no solo la instrucción: sin él, «reclamar primero» es una preferencia
  // de estilo que el siguiente refactor deshace.
  assert.ok(handler.includes('EXIGE el orden de arriba'), handler);
  // La instrucción vieja no puede sobrevivir en ninguna parte de la nota.
  assert.ok(!handler.includes('ejecuta y llama a save'), handler);
});

test('idempotencia de comando: la cabecera llega por contexto, no por el controller', () => {
  const { read } = scaffoldExtended();

  // El binding del controller es generado entero (conventions/mapping.md): si la
  // cabecera se colara ahí, el agente tendría que editar un archivo que la
  // convención le prohíbe tocar. Y en el Command tampoco: Jackson lo deserializa
  // entero desde el cuerpo, así que un componente más sería settable desde el body.
  const controller = read(`${JAVA}/infrastructure/rest/controllers/product/v1/ProductV1Controller.java`);
  assert.ok(!controller.includes('Idempotency-Key'), controller);
  assert.ok(!read(`${JAVA}/application/commands/CreateProductCommand.java`).includes('idempotencyKey'));
  assert.ok(read(`${JAVA}/infrastructure/web/IdempotencyKeyFilter.java`).includes('IdempotencyContext.set(request.getHeader(HEADER));'));
});

// El realm de prueba se describe en DOS formatos: bash contra kcadm
// (infra/init-keycloak.sh, para la generación) y JSON de import
// (deploy/keycloak/realm-export.json, para las pruebas manuales). Los dos salen de
// realmSpec(), pero eso es una puerta que alguien puede saltarse: esta prueba
// compara los artefactos YA RENDERIZADOS, que es lo que de verdad se ejecuta.
test('identidad: el script de kcadm y el realm importado declaran exactamente lo mismo', () => {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'oauth2', audience: 'catalog-api', validateAudience: true }
    },
    access: {
      default: { level: 'required' },
      rules: { createProduct: { roles: ['admin', 'editor'], scopes: ['catalog:write'] } }
    },
    serviceClients: { billing: { scopes: ['catalog:write'] } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  const workspace = tmpDir('keel-realm-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');

  const script = read('infra/init-keycloak.sh');
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));
  const collect = (pattern) => [...script.matchAll(pattern)].map((match) => match[1]).sort();

  // Roles.
  assert.deepEqual(
    collect(/create roles -r \$REALM -s name=(\S+?)"/g),
    realm.roles.realm.map((role) => role.name).sort()
  );

  // Usuarios: el script los recorre en un bucle `for USER in ...`.
  const users = script.match(/for USER in (.+); do/)[1].split(' ').sort();
  assert.deepEqual(users, realm.users.map((user) => user.username).sort());

  // Clientes y, sobre todo, sus secretos: un desajuste aquí no da un error de
  // arranque, da un 401 que parece un bug del servicio.
  const scriptClients = [...script.matchAll(/clientId=(\S+) .*?-s secret=(\S+?)"/g)]
    .map(([, id, secret]) => `${id}=${secret}`)
    .sort();
  const exportClients = realm.clients
    .filter((client) => client.secret)
    .map((client) => `${client.clientId}=${client.secret}`)
    .sort();
  assert.deepEqual(scriptClients, exportClients);

  // El cliente público de tokens de usuario, que no lleva secreto.
  const userClient = script.match(/USER_CLIENT=(\S+)/)[1];
  assert.ok(realm.clients.some((client) => client.clientId === userClient && client.publicClient));

  // Client scopes: los de permiso más los de audiencia (aud-<audiencia>, y
  // aud-wrong solo si el diseño valida audiencia).
  const scriptScopes = collect(/create client-scopes -r \$REALM -s name=(\S+?) /g)
    .map((name) => name.replace('aud-$SVC', `aud-${script.match(/^SVC=(\S+)/m)[1]}`))
    .sort();
  assert.deepEqual(scriptScopes, realm.clientScopes.map((scope) => scope.name).sort());

  // Y la asignación: cada `assign_scope <cliente> "$SCOPE_n"` del script tiene que
  // corresponderse con un defaultClientScopes del export.
  // Solo los de permiso (los que llevan `attributes`), en orden de declaración:
  // es el orden del que salen los índices de $SCOPE_n.
  const scopeNames = [...script.matchAll(/-s name=(\S+) -s protocol=openid-connect -s 'attributes/g)].map((m) => m[1]);
  const assignedByClient = {};
  for (const [, client, ref] of script.matchAll(/assign_scope (\S+) "\$(\S+?)"/g)) {
    const name = ref === 'AUD_OK' ? `aud-${script.match(/^SVC=(\S+)/m)[1]}` : ref === 'AUD_BAD' ? 'aud-wrong' : scopeNames[Number(ref.replace('SCOPE_', ''))];
    (assignedByClient[client] ??= []).push(name);
  }
  for (const client of realm.clients.filter((c) => c.secret)) {
    assert.deepEqual(
      (client.defaultClientScopes ?? []).slice().sort(),
      (assignedByClient[client.clientId] ?? []).sort(),
      `client scopes desalineados para ${client.clientId}`
    );
  }
});

// --- Informe de generación de notifications-spring --------------------------
// Cinco defectos del scaffolding que costaron rondas de arbitraje en una corrida
// real. Ninguno tenía red: los cinco pasaban todos los `includes(...)` de esta
// suite y solo aparecían dentro del proyecto generado, contra infraestructura.

test('§1.1 informe: el realm habilita los atributos de usuario no gestionados, en los dos formatos', () => {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc' },
    roles: { admin: { description: 'x' } },
    access: { default: { level: 'required' }, rules: { createProduct: { roles: ['admin'] } } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  const workspace = tmpDir('keel-userprofile-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');

  // Keycloak 24+ descarta EN SILENCIO cualquier atributo de usuario fuera del schema del
  // User Profile: ni error HTTP ni salida de kcadm. Un claim acotado por atributo no
  // persiste, y el síntoma es un 403 sin explicación en un test, minutos después.
  const script = read('infra/init-keycloak.sh');
  assert.ok(script.includes('run "update users/profile -r $REALM -s unmanagedAttributePolicy=ENABLED"'));
  // Y va ANTES de crear los usuarios: fijarlo después no rescata lo ya descartado.
  assert.ok(script.indexOf('users/profile') < script.indexOf('for USER in'));

  // Paridad con el realm que se importa en deploy/: si solo lo hiciera el script, la
  // prueba manual del diseñador contradiría a la suite por una diferencia no escrita.
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));
  const component = realm.components['org.keycloak.userprofile.UserProfileProvider'][0];
  assert.equal(component.providerId, 'declarative-user-profile');
  const upConfig = JSON.parse(component.config['kc.user.profile.config'][0]);
  assert.equal(upConfig.unmanagedAttributePolicy, 'ENABLED');
  // Los cuatro atributos base van explícitos: este componente SUSTITUYE al perfil por
  // defecto, y sin ellos el realm se queda sin username gestionado y no admite usuarios.
  assert.deepEqual(upConfig.attributes.map((a) => a.name), ['username', 'email', 'firstName', 'lastName']);
});

test('§1.2 informe: run() propaga el fallo de kcadm y solo tolera el conflicto', () => {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc' },
    roles: { admin: { description: 'x' } },
    access: { default: { level: 'required' }, rules: { createProduct: { roles: ['admin'] } } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const workspace = tmpDir('keel-kcrun-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true });
  const script = fs.readFileSync(
    path.join(workspace, 'services', 'catalog-spring', 'infra', 'init-keycloak.sh'), 'utf8');

  // El `|| true` incondicional de antes hacía que un aprovisionamiento a medias saliera 0.
  assert.ok(!/run\(\) \{ eval .*\|\| true; \}/.test(script));
  assert.ok(script.includes('ERROR: kcadm falló'));
  // Pero el 409 sigue siendo tolerado: el script es idempotente por diseño.
  assert.ok(script.includes('grep -qi "409\\|already exists'));
});

test('§1.4 informe: el arnés resuelve la URL sin re-codificarla', () => {
  const harness = harnessFor('kafka');
  // `rest.exchange(String, ...)` elige la sobrecarga de PLANTILLA de URI y re-codifica el
  // `%` de un segmento ya codificado: el `%40` de un email llega como `%2540` y la
  // petición contesta 401 sin haber llegado a autenticar.
  assert.ok(harness.includes('protected static URI uriOf(String path)'));
  assert.ok(harness.includes('UriComponentsBuilder.fromUriString(path).build(true).toUri()'));
  assert.ok(!/rest\.exchange\((path|url),/.test(harness), 'queda una llamada por plantilla de URI');
  assert.ok(harness.includes('rest.exchange(uriOf(path), method,'));
});

test('§2 informe: los 400 de la cadena de Spring llevan code, y sale del catálogo', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  const validation = fixedFrameworkErrors().find((entry) => entry.code === 'VALIDATION_ERROR');
  assert.ok(validation, 'VALIDATION_ERROR debe estar en el catálogo de framework-errors');

  // Un cuerpo malformado y un parámetro ausente son la petición no superando validación
  // de forma: dejarlos con `code: null` rompía el contrato que el resto del scaffolding
  // se esfuerza en mantener estable.
  const malformed = handler.slice(handler.indexOf('onMalformedRequest'));
  assert.ok(malformed.slice(0, 300).includes(`"${validation.code}"`));
  const missingParam = handler.slice(handler.indexOf('onMissingRequestParameter'));
  assert.ok(missingParam.slice(0, 400).includes(`"${validation.code}"`));

  // Un 405 NO es un error de validación: darle ese code mentiría.
  const notAllowed = handler.slice(handler.indexOf('onMethodNotAllowed'));
  assert.ok(!notAllowed.slice(0, 300).includes(`"${validation.code}"`));
});

test('§2 informe: la unicidad se resuelve con el error de SU entidad, no con el de otra', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);

  // La fixture tiene DOS entidades con clave natural `sku`: Product y SupplierPrice. La
  // familia de un canónico derivado sale de los CAMPOS, así que las dos casaban con el
  // único SKU_ALREADY_EXISTS del diseño —declarado por createProduct— y el conflicto de
  // una copia de precio duplicada salía por el cable con el código de un producto
  // duplicado. Silencioso y con toda la pinta de estar bien.
  const entryFor = (constraint) => {
    const at = handler.indexOf(`Map.entry("${constraint}"`);
    assert.ok(at > 0, `no hay entrada para ${constraint}`);
    return handler.slice(at, at + 220);
  };

  // Product SÍ declara el suyo, y lo declara la operación que escribe Product.
  assert.ok(entryFor('uk_products_natural').includes('SkuAlreadyExistsError'));
  // SupplierPrice no declara ninguno: TODO, no el error de otra entidad.
  const supplier = entryFor('uk_supplier_prices_natural');
  assert.ok(!supplier.includes('SkuAlreadyExistsError'), supplier);
  assert.ok(handler.includes('para la unicidad de SupplierPrice.sku'));
});

test('§2 informe: el error handler de Kafka no reintenta un error de negocio', () => {
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended'));
  const workspace = tmpDir('keel-dlq-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'kafka' } });
  const config = fs.readFileSync(
    path.join(workspace, 'services', 'catalog-spring',
      'src/main/java/com/commerce/catalog/infrastructure/messaging/DeadLetterConfig.java'), 'utf8');

  // Sin esto, una violación de regla de negocio se reintenta hasta agotar la política y
  // acaba en la DLT — un mensaje perfectamente válido, leído en operación como incidente.
  assert.ok(config.includes('handler.addNotRetryableExceptions(DomainException.class);'));
  assert.ok(config.includes('import com.commerce.catalog.domain.errors.DomainException;'));
});

// --- Entrega de eventos entrantes -------------------------------------------
// `publishedMessages` lee lo que el servicio publica; `deliverXxx` inyecta lo que
// consume. Sin esta mitad, una suscripción no se puede ejercitar y su REENTREGA
// —el escenario que distingue deduplicar de aplicar dos veces— no era escribible:
// la obligación existía en el diseño y el gate de generación no podía verla.

// El paquete y el nombre del servicio salen del manifiesto de cada fixture, así que
// la clase se busca en vez de componer su ruta: así el helper vale para cualquier
// fixture nueva sin tener que recordar su basePackage.
const harnessFor = (broker, fixture = 'catalog-extended') => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', fixture);
  const { manifest, layers } = loadService(dir);
  const out = tmpDir(`keel-deliver-${broker}-`);
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker } });
  const find = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const hit = find(full);
        if (hit) return hit;
      } else if (entry.name === 'AbstractFlowIT.java') {
        return full;
      }
    }
    return null;
  };
  const file = find(path.join(out, 'services'));
  const content = file ? fs.readFileSync(file, 'utf8') : '';
  fs.rmSync(out, { recursive: true, force: true });
  return content;
};

test('cada suscripción tiene su deliver, en los tres brokers', () => {
  for (const broker of ['kafka', 'rabbitmq', 'snssqs']) {
    const harness = harnessFor(broker);
    assert.ok(
      harness.includes('protected static void deliverWithdrawalRejected(String messageId, String payloadJson)'),
      `${broker}: falta el deliver de la compensación`
    );
    assert.ok(
      harness.includes('protected static void deliverSupplierPriceChanged(String messageId, String payloadJson)'),
      `${broker}: falta el deliver de la suscripción de proyección`
    );
    assert.ok(
      harness.includes('protected static void deliverMessage(String destination, String key, String body, Map<String, String> headers)'),
      `${broker}: falta la primitiva de entrega`
    );
    // El cuerpo viaja por archivo con los tres: es JSON del escenario, justo lo que
    // el cliente de contenedores corrompe en Windows si va por la línea de comandos.
    // Con RabbitMQ lo que se copia es el sobre de la API de gestión, con el cuerpo
    // dentro en base64 — misma garantía, un envoltorio más.
    assert.ok(
      /copyToDevtools\((body|body\.replaceAll\([^)]*\)|request), DELIVER_BODY\)/.test(harness),
      `${broker}: el cuerpo entregado no viaja por archivo`
    );
  }
});

test('el deliver apunta al topic real de la suscripción, saneado por broker', () => {
  // El canal es del proveedor (compliance), no el topic propio del servicio: publicar
  // en EVENT_TOPIC dejaría el escenario en timeout mudo.
  assert.ok(harnessFor('kafka').includes('"MESSAGING_SUBSCRIPTIONS_WITHDRAWAL_REJECTED_TOPIC", "compliance.events"'));
  // SQS no admite puntos en el nombre de la cola: mismo saneado que el resto de destinos.
  assert.ok(harnessFor('snssqs').includes('"MESSAGING_SUBSCRIPTIONS_WITHDRAWAL_REJECTED_TOPIC", "compliance-events"'));
});

test('la envoltura del deliver sale del contrato del diseño, no del test', () => {
  // Envoltura Keel (sin contract declarado, canal propio): metadata + data, y el
  // eventId ES el messageId — por eso repetirlo es la reentrega.
  const keel = harnessFor('kafka');
  assert.ok(keel.includes('\\"metadata\\":{\\"eventId\\":\\"" + messageId + "\\",\\"eventType\\":\\"WithdrawalRejected\\"},\\"data\\":" + payloadJson'));

  // Envoltura wrapped con payloadPath y ambos datos en cabecera: el cuerpo cuelga de
  // `data` y el discriminador y la clave viajan como cabeceras del broker.
  const wrapped = harnessFor('kafka', 'metering-digest');
  assert.ok(wrapped.includes('"{" + "\\"data\\":" + payloadJson + "}"'), wrapped.slice(0, 0) || 'falta el sobre wrapped');
  assert.ok(wrapped.includes('Map.of("eventType", "MeterReadingCaptured", "messageId", messageId)'));
});

test('el javadoc del deliver enseña que repetir el messageId es la reentrega', () => {
  const harness = harnessFor('kafka');
  assert.ok(harness.includes('es la <b>reentrega</b> que el consumidor'));
  assert.ok(harness.includes('Con valores distintos son dos hechos distintos, no una reentrega.'));
});

test('publishRaw pasa a ser un caso particular de deliverMessage', () => {
  // Una sola vía de entrega: el humo del arnés y los escenarios comparten mecánica,
  // así que un fallo de escapado se ve en SMOKE-4 antes que en ningún flujo.
  const harness = harnessFor('kafka');
  assert.ok(harness.includes('deliverMessage(EVENT_TOPIC, key, payload, Map.of());'));
  assert.ok(!harness.includes('PUBLISH_BODY'));
});

test('sin suscripciones no se genera ningún deliver de evento', () => {
  // product-catalog no consume nada: la primitiva genérica puede seguir estando
  // (la usa el humo), pero no debe aparecer ningún deliver por evento.
  const harness = harnessFor('kafka', 'product-catalog');
  assert.ok(!/deliver[A-Z]\w+\(String messageId/.test(harness), 'no debería haber deliver por evento');
});

// --- Orden de los efectos en el stub del handler -----------------------------
// Una llamada saliente no participa de la transacción: si sale antes de la guarda de
// estado y la guarda rechaza, el rollback deshace la fila y deja el encargo hecho en
// el otro servidor. El camino de menor resistencia del agente es el contrario —llamar
// primero y mutar «cuando ya se sabe que salió bien»—, así que build lo dice.

test('§1.1: el handler con transición y activación saliente lleva la nota de orden', () => {
  const { read } = scaffoldExtended();
  const handler = read(`${JAVA}/application/usecases/RetireProductCommandHandler.java`);

  assert.ok(handler.includes('ORDEN de los efectos'), handler);
  // La nota cita la transición concreta del diseño y la llamada concreta, no una regla
  // genérica: sin los dos nombres el agente no sabe a qué se aplica.
  assert.ok(handler.includes('Product: draft|active → retired'));
  assert.ok(handler.includes('compliance.recordWithdrawal'));
  assert.ok(handler.includes('La llamada saliente no es transaccional'));
});

test('§1.1: la nota de orden se emite solo cuando hay las dos cosas', () => {
  const { read } = scaffoldExtended();

  // Compensación CON activación de vuelta: transición y llamada saliente, así que hay
  // orden que fijar — y el orden importa. La llamada no es transaccional: si sale
  // antes y la guarda del agregado rechaza el cambio, el rollback revierte la fila
  // pero el trabajo ya está deshecho en el otro servidor y nadie lo rehace.
  const compensation = read(`${JAVA}/application/usecases/ReactivateWithdrawnProductCommandHandler.java`);
  assert.ok(compensation.includes('ORDEN de los efectos'), compensation);
  assert.match(compensation, /aplica PRIMERO la transición de estado[\s\S]*?y solo después llama a compliance\.cancelWithdrawal/);
  // Y el cliente se inyecta: sin él, el camino de menor resistencia es no llamarlo, y
  // la compensación se queda a medias sin que nada en nuestra base lo delate.
  assert.ok(compensation.includes('ComplianceClient complianceClient'), compensation);

  // Alta: activación no, transición tampoco (la creación no es una arista del lifecycle).
  const create = read(`${JAVA}/application/usecases/CreateProductCommandHandler.java`);
  assert.ok(!create.includes('ORDEN de los efectos'));
});

// Los índices de purga de los tres registros de mecanismo (outbox, procesados y
// claves de idempotencia) existían solo en la rama documental. En la relacional las
// dos purgas hacían un recorrido completo de la tabla — y con varias réplicas, todas
// a la misma hora. La paridad se congela por NOMBRE de índice porque es lo que
// aparece en el baseline exportado y lo que un diff entre ramas puede comparar.
test('los índices de purga tienen el mismo nombre en las dos ramas de persistencia', () => {
  const { read } = scaffoldExtended();

  const processed = read(`${JAVA}/infrastructure/messaging/idempotency/ProcessedEventJpa.java`);
  assert.ok(processed.includes('@Index(name = "ix_processed_event_processed_at", columnList = "processed_at")'));

  const record = read(`${JAVA}/infrastructure/persistence/idempotency/IdempotencyRecordJpa.java`);
  assert.ok(record.includes('@Index(name = "ix_idempotency_record_expires_at", columnList = "expires_at")'));

  // El outbox ya lo tenía; va en la misma aserción para que los tres se lean juntos.
  const outbox = read(`${JAVA}/infrastructure/messaging/outbox/OutboxEventJpa.java`);
  assert.ok(outbox.includes('ix_outbox_event_pending'));
});

// ─── Cosecha de la corrida documental de asset-vault ──────────────────────────
//
// Lo que solo apareció al orquestar el pipeline entero sobre Mongo. Ninguno de los
// dos lo veía la suite de cadenas: uno dejó un escenario sin ejercitar por una firma
// que no existía, y el otro daba por muerto un Keycloak sano.

test('el arnés sabe dirigir una subida multipart a la segunda réplica', () => {
  const { read } = scaffoldExtended();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  // Sin esto, el escenario de clúster de un diseño cuya mutación con clave es una
  // SUBIDA es inexpresable: `onReplica` solo manda JSON. En la corrida documental
  // FL-CLU-003 se quedó NO_EJERCITADO exactamente por aquí — y es el escenario que
  // separa «lo arbitra la base» de «lo arbitra un candado en memoria».
  assert.ok(harness.includes('protected Response onReplicaMultipart('));
  // Reutiliza el cuerpo de la subida contra una URL absoluta, en vez de duplicarlo:
  // dos constructores del mismo formulario se separan al primer cambio.
  assert.match(harness, /onReplicaMultipart\([\s\S]*?return multipartTo\("http:\/\/localhost:" \+ REPLICA_PORT \+ path/);
  // Y comparte la guarda de `onReplica`: llamar sin réplica arrancada es un error del
  // escenario, no un fallo del servicio.
  assert.match(harness, /onReplicaMultipart\([\s\S]*?La réplica no está arrancada/);
});

test('init-keycloak.sh resuelve el frontend de compose igual que up.sh', () => {
  // Con asset-vault y no con catalog-extended: el script solo se genera cuando el
  // diseño declara identidad por token, y es la fixture de la corrida que lo destapó.
  const vaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asset-vault');
  const { manifest, layers, errors } = loadService(vaultDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-regression-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const script = fs.readFileSync(
    path.join(workspace, 'services', 'asset-vault-spring', 'infra', 'init-keycloak.sh'),
    'utf8'
  );

  // El defecto: `podman compose` hardcodeado. En Windows delega en el
  // docker-compose.exe del PATH, que busca el named pipe de Docker Desktop y no el de
  // la máquina de podman — el `exec` falla y el script acusa a Keycloak de no arrancar
  // («no aceptó una sesión admin tras N intentos») con Keycloak sirviendo desde hacía
  // rato. Un falso negativo que señala al sitio equivocado.
  assert.ok(!/COMPOSE=\(podman compose/.test(script), script);
  assert.ok(!/COMPOSE=\(docker compose/.test(script), script);
  // La misma resolución que up.sh: sondeo con `compose ls` (que sí toca el motor) y
  // caída a podman-compose.
  assert.ok(script.includes('! podman compose ls >/dev/null 2>&1'), script);
  assert.ok(script.includes('COMPOSE=(podman-compose -f infra/docker-compose.yaml)'), script);
  // Y el runtime se detecta, no se asume docker: en una máquina con solo podman el
  // default anterior elegía un binario que no existe.
  assert.ok(script.includes('command -v docker >/dev/null 2>&1'), script);
  // El mensaje de diagnóstico cita el frontend que de verdad se usó.
  assert.ok(script.includes('${COMPOSE[*]} logs keycloak'), script);
});

// ─── Cosecha de la corrida con RabbitMQ ───────────────────────────────────────

test('deadLetterMessages traduce «cola viva y vacía» a cadena vacía en cada broker', () => {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);

  // El defecto: delegaba en `publishedMessages` sin traducir, y «vacío» no es cadena
  // vacía en ningún broker salvo Kafka — la API de RabbitMQ devuelve el literal "[]" y
  // la CLI de SQS un JSON sin la clave "Messages". El javadoc promete cadena vacía y la
  // aserción que importa es la NEGATIVA (`.isBlank()`), así que el caso en el que el
  // servicio se comporta BIEN era justo el que fallaba: tres escenarios de dos clases
  // distintas cayeron con `Expecting blank but was: "[]"`.
  const expected = {
    rabbitmq: 'messages.trim().equals("[]")',
    snssqs: '!messages.contains("\\"Messages\\"")'
  };
  for (const [broker, predicate] of Object.entries(expected)) {
    const workspace = tmpDir('keel-regression-');
    scaffoldService({ manifest, layers, workspace, force: true, stack: { broker } });
    const harness = fs.readFileSync(
      path.join(workspace, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
      'utf8'
    );
    assert.ok(harness.includes(`return ${predicate} ? "" : messages;`), `${broker}: ${harness.slice(0, 0)}falta la traducción de cola vacía`);
    // El predicado sale del módulo compartido, no de una comparación escrita a mano:
    // así el que se olvida no es un broker, es ninguno.
    assert.ok(harness.includes(emptyReadJava(broker, 'messages')), broker);
  }

  // Y `publishedMessages` NO se toca: sigue devolviendo el crudo del broker, que es de
  // lo que depende el humo del arnés para distinguir «no hay nada» de «no leí nada».
  const workspace = tmpDir('keel-regression-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'rabbitmq' } });
  const harness = fs.readFileSync(
    path.join(workspace, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
    'utf8'
  );
  const published = harness.slice(harness.indexOf('protected static String publishedMessages'));
  assert.ok(!published.slice(0, 800).includes('? "" : messages'), published.slice(0, 800));
});

// ─── Cosecha de la corrida con SNS/SQS ────────────────────────────────────────

test('la entrega de un evento entrante lleva el eventType como atributo nativo', () => {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);

  // En SNS esto no es decoración: `init-messaging.sh` suscribe cada cola con una
  // FilterPolicy sobre el atributo `eventType`, así que sin él el broker descarta el
  // mensaje EN SILENCIO — seis escenarios de la corrida esperaban un efecto que nunca
  // se disparaba, y el fallo señalaba al handler, que ni se enteró.
  for (const broker of ['snssqs', 'rabbitmq', 'kafka']) {
    const workspace = tmpDir('keel-regression-');
    scaffoldService({ manifest, layers, workspace, force: true, stack: { broker } });
    const harness = fs.readFileSync(
      path.join(workspace, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
      'utf8'
    );
    const deliver = harness.slice(harness.indexOf('protected static void deliverWithdrawalRejected('));
    assert.match(deliver.slice(0, 400), /Map\.of\([^)]*"eventType", "WithdrawalRejected"/, broker);

    // Y ninguna entrega de suscripción se queda con el mapa vacío, que era el estado
    // anterior. `publishRaw` queda fuera a propósito: publica en el canal PROPIO y solo
    // lo usa el humo del arnés, que mide la fontanería del canal y no el enrutado.
    const methods = [
      ...harness.matchAll(/protected static void deliver[A-Z]\w+\(String messageId, String payloadJson\) \{\s*deliverMessage\(([^;]*)\);/g)
    ];
    assert.ok(methods.length > 0, `${broker}: no hay entregas de suscripción`);
    for (const [, args] of methods) {
      assert.ok(args.includes('"eventType"'), `${broker}: una entrega va sin eventType — ${args}`);
    }
  }
});

test('la lectura de SQS pide por lotes: el límite de 10 es del broker, no del escenario', () => {
  const { manifest, layers } = loadService(fixtureDir);
  const workspace = tmpDir('keel-regression-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'snssqs' } });
  const harness = fs.readFileSync(
    path.join(workspace, 'services/catalog-spring/src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'),
    'utf8'
  );

  // `--max-number-of-messages` acepta 1..10 y contesta InvalidParameterValue por encima:
  // pedir de una vez los mensajes de un escenario de clúster reventaba la lectura.
  assert.ok(harness.includes('int size = Math.min(remaining, 10);'), harness.slice(harness.indexOf('publishedMessages'), harness.indexOf('publishedMessages') + 900));
  assert.ok(harness.includes('String.valueOf(size)'));
  // Y se corta en cuanto un lote vuelve incompleto: con --visibility-timeout 0 el
  // mensaje sigue visible, así que seguir pidiendo lo devolvería otra vez y un conteo
  // sobre el texto acumulado lo contaría dos veces.
  assert.ok(harness.includes('if (receivedCount(batch) < size) {'));
  // El contador no se inventa nada: cuenta cuerpos de la respuesta de receive-message.
  assert.match(harness, /private static int receivedCount\(String response\)/);
});

// ─── Errores del framework: el catálogo manda, el diseño sustituye ────────────
//
// Tres corridas completas improvisaron tres codes distintos para el mismo conflicto,
// porque el generador delegaba en un diseño que no tenía dónde declararlo. Ahora salen
// del catálogo de keel-core y el diseño los sustituye con la sintaxis que ya existía.

test('la reutilización de la clave de idempotencia tiene su excepción, con el code canónico', () => {
  // `stock-reservation` declara idempotency y NO nombra sus conflictos: es el camino que
  // recorrieron las tres corridas del pipeline, y el que antes dejaba al agente inventando.
  const service = loadService(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stock-reservation'));
  const workspace = tmpDir('keel-framework-errors-');
  const result = scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true });
  const root = path.join(workspace, result.outDir, 'src/main/java/com/fulfillment/stockreservation');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

  const reuse = read('domain/idempotency/IdempotencyReuseException.java');
  assert.ok(reuse.includes('"IDEMPOTENCY_KEY_REUSED"'), reuse);
  assert.ok(reuse.includes('extends ConflictException'), reuse);
  // Y no se confunde con la carrera, que es el otro desenlace y tiene su propia clase.
  assert.ok(read('domain/idempotency/IdempotencyConflictException.java').includes('"IDEMPOTENCY_KEY_IN_PROGRESS"'));

  // La nota del handler la nombra: sin eso, el agente vuelve a inventarse un code —que es
  // exactamente lo que hizo en las tres corridas.
  const handler = read('application/usecases/CreateReservationCommandHandler.java');
  assert.ok(handler.includes('IdempotencyReuseException'), handler);
  assert.ok(handler.includes('IDEMPOTENCY_KEY_REUSED'), handler);
});

test('un code del dominio en la familia sustituye al canónico, en los DOS desenlaces', () => {
  // catalog-extended sí los nombra (PRODUCT_KEY_IN_PROGRESS / PRODUCT_KEY_REUSED): el
  // diseño manda sobre el contrato público.
  //
  // Los dos, y no solo la reutilización: la CARRERA emitía el canónico como literal
  // aunque el diseño declarase el suyo. El efecto era una clase de error generada en
  // domain/errors que no lanzaba nadie y un contrato público que decía una cosa
  // mientras el servidor devolvía otra — y sin que nada lo delatara, porque el aviso
  // de `keel validate` calla con razón cuando el diseño SÍ nombra el desenlace.
  // Cuarta corrida consecutiva reportándolo (INFORME-CORRIDA-HTTP-AUTH.md).
  const { read } = scaffoldExtended();

  const reuse = read(`${JAVA}/domain/idempotency/IdempotencyReuseException.java`);
  assert.ok(reuse.includes('"PRODUCT_KEY_REUSED"'), reuse);
  assert.ok(!reuse.includes('IDEMPOTENCY_KEY_REUSED'), reuse);

  const race = read(`${JAVA}/domain/idempotency/IdempotencyConflictException.java`);
  assert.ok(race.includes('"PRODUCT_KEY_IN_PROGRESS"'), race);
  assert.ok(!race.includes('IDEMPOTENCY_KEY_IN_PROGRESS'), race);

  // Y las notas del handler citan los codes que de verdad van a salir por el cable: si
  // dijeran otra cosa, el agente escribiría el escenario contra un contrato inexistente.
  const handler = read(`${JAVA}/application/usecases/CreateProductCommandHandler.java`);
  assert.ok(handler.includes('PRODUCT_KEY_REUSED'), handler);
  assert.ok(handler.includes('PRODUCT_KEY_IN_PROGRESS'), handler);
  assert.ok(!handler.includes('IDEMPOTENCY_KEY_IN_PROGRESS'), handler);
});

test('el 413 del límite de subida usa el error que el diseño declara', () => {
  // Antes este handler emitía el canónico pasara lo que pasara, así que un diseño que
  // declaraba FILE_TOO_LARGE recibía DOS nombres para el mismo 413 según por dónde
  // llegara el rechazo: la política del bucket dentro del handler, o el límite de Spring
  // antes de entrar. La fixture ya lo declara con un prefijo propio.
  const { manifest, layers } = loadService(fixtureDir);
  const patched = structuredClone(layers);
  patched['use-cases'].operations.addProductImage.errors = [
    ...(patched['use-cases'].operations.addProductImage.errors ?? []),
    { code: 'PRODUCT_IMAGE_FILE_TOO_LARGE', when: 'La imagen supera el tamaño del bucket.', http: 413 }
  ];
  const workspace = tmpDir('keel-framework-errors-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const advice = fs.readFileSync(
    path.join(workspace, 'services', 'catalog-spring', JAVA, 'infrastructure/rest/ApiExceptionHandler.java'),
    'utf8'
  );
  assert.ok(advice.includes('"PRODUCT_IMAGE_FILE_TOO_LARGE"'), advice);
});

test('ningún code que salga por el cable se inventa fuera del catálogo', () => {
  // La comprobación que cierra el asunto: todo `code` literal del ApiExceptionHandler y de
  // las excepciones de mecanismo está o en el catálogo del framework, o declarado por el
  // diseño, o derivado de una clave natural. Si aparece uno nuevo, el generador volvió a
  // inventar — que es justo lo que este trabajo cierra.
  const { manifest, layers } = loadService(fixtureDir);
  const workspace = tmpDir('keel-framework-errors-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, 'services', 'catalog-spring', JAVA);

  const canonical = new Set(fixedFrameworkErrors().map((entry) => entry.code));
  const declared = new Set(
    Object.values(layers['use-cases'].operations).flatMap((op) => (op.errors ?? []).map((error) => error.code))
  );

  const sospechosos = [];
  for (const relative of ['infrastructure/rest/ApiExceptionHandler.java', 'domain/idempotency/IdempotencyReuseException.java', 'domain/idempotency/IdempotencyConflictException.java']) {
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const [, code] of content.matchAll(/"([A-Z][A-Z0-9_]{4,})"/g)) {
      if (canonical.has(code) || declared.has(code)) continue;
      // Los derivados de una clave natural llevan el sufijo de su familia.
      if (code.endsWith('_ALREADY_EXISTS')) continue;
      sospechosos.push(`${relative}: ${code}`);
    }
  }
  assert.deepEqual(sospechosos, [], `codes fuera del catálogo:\n${sospechosos.join('\n')}`);
});

// La etiqueta del sobre contra el filtro que la lee. Son dos piezas que build genera
// por caminos distintos —el bridge escribe el `eventType` de la fila del outbox, y
// `init-messaging.sh` siembra la FilterPolicy de la cola de arnés— y nada las comparaba:
// con el nombre de la clase Java en el sobre, SNS descarta el mensaje EN SILENCIO (sin
// error, sin log) y el escenario falla como si el handler no hubiera publicado.
test('el eventType que publica el outbox es el que espera la FilterPolicy del broker', () => {
  const { manifest, layers } = loadService(fixtureDir);
  const workspace = tmpDir('keel-eventtype-');
  scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'snssqs' } });
  const root = path.join(workspace, 'services', 'catalog-spring');
  const bridge = fs.readFileSync(path.join(root, JAVA, 'infrastructure/messaging/CatalogDomainEventBridge.java'), 'utf8');
  const provisioning = fs.readFileSync(path.join(root, 'infra/init-messaging.sh'), 'utf8');

  // Lo que el bridge mete en la fila (tercer argumento de append) …
  const emitted = [...bridge.matchAll(/append\([A-Za-z]+RoutingKey, "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(emitted.length > 0, bridge);
  // … tiene que estar entre los valores con los que se suscribe la cola de arnés.
  for (const eventType of emitted) {
    assert.ok(
      new RegExp(`^subscribe .*'${eventType}'`, 'm').test(provisioning),
      `'${eventType}' no aparece en ninguna FilterPolicy de init-messaging.sh:\n${provisioning}`
    );
  }
  // Y ser el MISMO literal que viaja en el cuerpo: el sobre y la carta no pueden
  // decir cosas distintas.
  const domainEvent = fs.readFileSync(path.join(root, JAVA, 'domain/events/ProductCreatedEvent.java'), 'utf8');
  assert.ok(domainEvent.includes('EventMetadata.now("ProductCreated")'), domainEvent);
  assert.ok(emitted.includes('ProductCreated'), emitted.join(', '));
});

// --- Corrida de autenticación saliente (INFORME-CORRIDA-HTTP-AUTH.md) ---

// El fallo que ocurre ANTES de que salga la petición. El interceptor de OAuth2 pide
// el token al autorizar, así que un proveedor de identidad caído lanza desde dentro
// del interceptor y ninguna de las sobrecargas del fallback —todas de transporte o de
// respuesta— llega a verlo: el 500 sale sin traducir aunque el resto del fallback esté
// bien. Lo destapó FL-AUT-004, que era el único escenario que miraba ese camino.
test('el fallback de un cliente OAuth2 atiende el fallo de obtención del token', () => {
  const { read } = scaffoldExtended();
  const oauth = read(`${JAVA}/infrastructure/http/PartnerCatalogHttpAdapter.java`);

  assert.ok(oauth.includes('import org.springframework.security.oauth2.core.OAuth2AuthorizationException;'), oauth);
  assert.ok(/notifyCatalogChangeFallback\([^)]*OAuth2AuthorizationException throwable\)/.test(oauth), oauth);

  // Y solo ahí: un cliente sin esa auth no puede recibir esa excepción, y declararla
  // arrastraría el tipo (y su starter) a un proyecto que no lo tiene en el classpath.
  const bearer = read(`${JAVA}/infrastructure/http/ComplianceHttpAdapter.java`);
  assert.ok(!bearer.includes('OAuth2AuthorizationException'), bearer);
});

// La ventana del circuito describe la salud del PROVEEDOR DE NEGOCIO. Que no nos den
// un token es cosa del emisor de identidad: contarlo abriría el circuito del socio por
// una caída ajena y dejaría las llamadas cortadas toda la ventana después de que la
// identidad ya hubiera vuelto. Mismo criterio que el 4xx, que tampoco cuenta.
test('el fallo de token entra al fallback pero no cuenta para el circuito', () => {
  const { read } = scaffoldExtended();
  // `record-exceptions` es el único sitio del fragmento donde aparecen FQN de
  // excepciones, así que basta con que el tipo no esté en el archivo entero.
  const local = read('src/main/resources/parameters/local/http-clients.yaml');
  assert.ok(local.includes('record-exceptions:'), local);
  assert.ok(!local.includes('OAuth2AuthorizationException'), local);
});

// El diseño de catalog NO trae capa `security`: su API es abierta. Pero el cliente
// `partner-catalog` declara auth oauth2 saliente, y su starter arrastra Spring
// Security: sin una cadena propia, la autoconfiguración de Boot pone TODA la API
// —incluido /actuator/health, que empieza a contestar 302— detrás de un login que
// nadie pidió. El servicio nace roto por una dependencia que se pidió para salir.
test('un cliente OAuth2 saliente no cierra la puerta de entrada de un servicio sin capa security', () => {
  const { read, result } = scaffoldExtended();
  const chain = read(`${JAVA}/infrastructure/configurations/security/OpenApiSecurityConfig.java`);

  assert.ok(chain.includes('anyRequest().permitAll()'), chain);
  assert.ok(chain.includes('formLogin(AbstractHttpConfigurer::disable)'), chain);
  // Y no se inventa autenticación: no hay resource server ni filtro de api-key.
  assert.ok(!chain.includes('oauth2ResourceServer'), chain);
  assert.ok(!result.warnings.some((w) => /security/i.test(w)), result.warnings.join('\n'));

  // Y solo cuando hace falta: sin cliente oauth2 no hay Spring Security en el
  // classpath, así que una cadena declarada no compilaría.
  const other = path.join(path.dirname(fixtureDir), 'stock-reservation');
  const { manifest, layers } = loadService(other);
  const workspace = tmpDir('keel-openchain-');
  scaffoldService({ manifest, layers, workspace, force: true });
  // Por nombre de archivo sobre el árbol entero, no contra una ruta escrita a mano:
  // una ruta equivocada haría pasar esta aserción sin mirar nada.
  const generated = fs.readdirSync(workspace, { recursive: true }).map(String);
  assert.ok(generated.some((file) => file.endsWith('.java')), 'el scaffolding no generó Java');
  assert.ok(!generated.some((file) => file.includes('OpenApiSecurityConfig')), 'se generó la cadena abierta sin cliente oauth2');
});

// --- exposedAs: el dato ajeno que llega a la respuesta ---
//
// Antes de este campo, un `need` se pedía al proveedor, atravesaba el anticorrupción y
// se DESCARTABA: la forma `{entity: X}` de un payload no admite campos extra, así que
// no había dónde ponerlo ni forma de declararlo. Tres diseños llegaron así, y el
// `SupplierPriceReader` quedaba generado sin un solo llamador.
test('un need con exposedAs llega al DTO y entra al mapper por parámetro', () => {
  const { read } = scaffoldExtended();

  // On-demand: la forma sale de response.fields de la llamada, no se declara otra vez.
  const priceDto = read(`${JAVA}/application/dtos/CurrentPriceDto.java`);
  assert.ok(priceDto.includes('public record CurrentPriceDto('), priceDto);
  assert.ok(priceDto.includes('BigDecimal amount'), priceDto);

  // Replicado: la forma sale de la entidad réplica.
  assert.ok(read(`${JAVA}/application/dtos/SupplierPriceDto.java`).includes('public record SupplierPriceDto('));

  // El campo está en la respuesta de CADA operación de usedBy.
  const response = read(`${JAVA}/application/dtos/GetProductBySlugResponseDto.java`);
  assert.ok(response.includes('CurrentPriceDto currentPrice'), response);
  assert.ok(response.includes('ProductCostDto productCost'), response);

  // Y entra al mapper por PARÁMETRO, no derivado de la entidad: es lo único que impide
  // el camino de menor resistencia, que es pedir el dato y no ponerlo en ningún sitio.
  // Un campo derivado se rellenaría con un TODO y compilaría igual.
  const mapper = read(`${JAVA}/application/mappers/ProductApplicationMapper.java`);
  assert.match(
    mapper,
    /toGetProductBySlugResponseDto\(Product entity, CurrentPriceDto currentPrice, ProductCostDto productCost\)/,
    mapper
  );
  assert.match(mapper, /toListProductsResponseDto\(Product entity, SupplierPriceDto supplierPrice\)/, mapper);

  // Y el stub dice dónde termina el dato, no solo cómo traerlo.
  const handler = read(`${JAVA}/application/usecases/GetProductBySlugQueryHandler.java`);
  assert.ok(handler.includes("campo 'currentPrice'"), handler);
});

test('un need SIN exposedAs no toca la respuesta', () => {
  // La mitad que hace que el test anterior mida algo: sin el campo, el comportamiento
  // es el de siempre —el dato sirve para decidir y no sale del servicio—.
  const { manifest, layers } = loadService(fixtureDir);
  const patched = structuredClone(layers);
  for (const dep of Object.values(patched.dependencies.dependencies)) {
    for (const need of Object.values(dep.needs ?? {})) delete need.exposedAs;
  }
  const workspace = tmpDir('keel-exposed-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, 'services', 'catalog-spring', JAVA);

  assert.ok(!fs.existsSync(path.join(root, 'application/dtos/CurrentPriceDto.java')));
  const response = fs.readFileSync(path.join(root, 'application/dtos/GetProductBySlugResponseDto.java'), 'utf8');
  assert.ok(!response.includes('currentPrice'), response);
});

// ─── La cola de cada suscripción, y el Body escapado de SQS ───────────────────
//
// Los dos salieron de la corrida SNS/SQS del 14/08/2026 y los dos son del generador,
// no del proyecto: cualquier servicio con este broker los hereda.

test('§1.2: con snssqs cada suscripción declara su COLA, no solo su topic', () => {
  // Del topic se PUBLICA; se CONSUME de una cola, y su nombre lo fija este servicio
  // (dos consumidores del mismo topic necesitan colas distintas). `init-messaging.sh`
  // ya la creaba con ese nombre, pero ningún parámetro la declaraba: el listener no
  // tenía de dónde leerla y el agente la añadía a mano en los cuatro perfiles — o se
  // la inventaba, y entonces todo escenario de suscripción moría en un timeout mudo.
  const read = scaffoldWithBroker('snssqs');

  for (const profile of ['local', 'develop', 'production', 'test']) {
    const yaml = read(`src/main/resources/parameters/${profile}/messaging.yaml`);
    assert.ok(yaml.includes('queue:'), `${profile}: la suscripción no declara cola`);
    assert.ok(
      yaml.includes('catalog-supplier-price-changed'),
      `${profile}: el nombre de cola no coincide con el que siembra init-messaging.sh`
    );
  }
  // Y en los perfiles no locales sale por entorno, igual que el topic.
  assert.ok(
    read('src/main/resources/parameters/production/messaging.yaml')
      .includes('${MESSAGING_SUBSCRIPTIONS_SUPPLIER_PRICE_CHANGED_QUEUE:'),
    'la cola no es redirigible por entorno'
  );

  // La MISMA fuente que la siembra: si las dos mitades se desincronizan, el listener
  // consume de una cola que nadie crea.
  const script = read('infra/init-messaging.sh');
  assert.ok(script.includes("'catalog-supplier-price-changed'"), script);
});

test('§1.2: los otros brokers no ganan una clave `queue` que no significa nada', () => {
  for (const broker of ['kafka', 'rabbitmq']) {
    const yaml = scaffoldWithBroker(broker)('src/main/resources/parameters/local/messaging.yaml');
    assert.ok(!yaml.includes('queue:'), `${broker}: cola declarada donde no hay colas por suscripción`);
  }
});

test('§1.2: con snssqs el arnés desescapa el campo Body de SQS', () => {
  // La CLI de AWS devuelve el Body como cadena JSON ESCAPADA dentro del JSON de la
  // respuesta, así que `.contains("\"status\":\"draft\"")` no casaba nunca aunque el
  // mensaje fuera correcto: un falso negativo mudo. En la corrida apareció a la vez en
  // tres clases de flujo sin relación entre sí, que es la firma de un defecto de arnés.
  const harness = scaffoldWithBroker('snssqs')(
    'src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'
  );

  assert.ok(harness.includes('return decodeBodies(batches.toString());'), 'publishedMessages devuelve la salida cruda');
  assert.ok(harness.includes('private static String decodeBodies(String raw)'), harness);
  assert.ok(harness.includes('import java.util.regex.Matcher;'), 'falta el import de Matcher');
  // El grupo repetido es POSESIVO: con la forma perezosa, un Body sin raw delivery
  // (envuelto en el sobre de notificación de SNS, con backslashes muy anidados) hace
  // backtracking catastrófico y agota el stack en vez de devolver un resultado.
  const patternLine = harness.split('\n').find((line) => line.includes('BODY_FIELD = Pattern.compile('));
  assert.ok(patternLine, 'no se declara el patrón del campo Body');
  assert.ok(patternLine.includes('*+'), `el grupo repetido no es posesivo: ${patternLine}`);

  // Y no se toca la envoltura: hay comprobaciones que dependen de ella.
  assert.ok(harness.includes('deadLetterMessages'), harness);
});

test('§1.2: los otros brokers no arrastran el desescapado de SQS', () => {
  for (const broker of ['kafka', 'rabbitmq']) {
    const harness = scaffoldWithBroker(broker)(
      'src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'
    );
    assert.ok(!harness.includes('decodeBodies'), `${broker}: desescapado de SQS donde no hay SQS`);
  }
  // Kafka además no desescapa NADA: kcat escupe el registro tal cual, así que ni
  // decodePayloads ni el import de Matcher tienen a qué servir.
  const kafka = scaffoldWithBroker('kafka')(
    'src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'
  );
  assert.ok(!kafka.includes('decodePayloads'), 'kafka: desescapado donde el registro viaja crudo');
  assert.ok(!kafka.includes('import java.util.regex.Matcher;'), 'kafka: import sin uso');
});

test('§1.4: con rabbitmq el arnés desescapa el campo payload de la Management API', () => {
  // Mismo defecto que el de SQS y con la misma firma: el sobre de aplicación viaja como
  // cadena JSON ESCAPADA dentro del JSON de la respuesta, así que una aserción tan normal
  // como `.contains("\\"status\\":\\"active\\"")` no casa NUNCA aunque el evento publicado sea
  // correcto. En la corrida del 18/08/2026 cayeron cuatro clases de flujo escritas por
  // separado — cuando el mismo error aparece en clases sin relación, el defecto es del arnés.
  const harness = scaffoldWithBroker('rabbitmq')(
    'src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'
  );

  assert.ok(harness.includes('return decodePayloads(devtools('), 'publishedMessages devuelve la salida cruda');
  assert.ok(harness.includes('private static String decodePayloads(String raw)'), harness);
  assert.ok(harness.includes('import java.util.regex.Matcher;'), 'falta el import de Matcher');
  // Posesivo, por lo mismo que el de SQS: la forma perezosa hace backtracking
  // catastrófico con una racha de backslashes y agota el stack.
  const patternLine = harness.split('\n').find((line) => line.includes('PAYLOAD_FIELD = Pattern.compile('));
  assert.ok(patternLine, 'no se declara el patrón del campo payload');
  assert.ok(patternLine.includes('*+'), `el grupo repetido no es posesivo: ${patternLine}`);

  // Se emite EMBEBIDO cuando es JSON (el resultado sigue siendo JSON navegable con
  // JsonPath), y tal cual vino cuando no lo es.
  assert.ok(harness.includes('JSON.readTree(decoded);'), harness);
  assert.ok(harness.includes('private static String embeddedPayload(String escaped)'), harness);

  // Y el predicado de canal vacío sigue en pie: sin mensajes no hay campo `payload` que
  // tocar, así que la purga se sigue leyendo como `[]`. Si esto se rompiera, toda
  // aserción negativa de mensajería pasaría a fallar por el desescapado.
  assert.ok(harness.includes('.trim().equals("[]")'), harness);
});

// La skill del broker y lo que build genera tienen que decir lo mismo: si el ejemplo del
// @SqsListener apunta al topic y build declara la cola, el agente escribe un listener
// contra un destino que no existe y todo escenario de suscripción muere en un timeout mudo.
// Fue exactamente el camino del hallazgo D.1 de la corrida del 14/08/2026.
test('§1.2: la skill de snssqs y los parámetros generados nombran la misma clave', () => {
  const skillDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'assets', 'generators', 'spring', 'skills', 'keel-spring-snssqs'
  );
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const implementation = fs.readFileSync(path.join(skillDir, 'references', 'implementation.md'), 'utf8');

  for (const [name, text] of [['SKILL.md', skill], ['implementation.md', implementation]]) {
    const listeners = text.match(/@SqsListener\("\$\{[^"]+"\)/g) ?? [];
    assert.ok(listeners.length > 0, `${name}: sin ejemplo de @SqsListener`);
    for (const listener of listeners) {
      assert.ok(listener.includes('.queue:'), `${name}: el listener consume de un topic — ${listener}`);
    }
  }

  // Y la clave existe de verdad en lo que build emite.
  const yaml = scaffoldWithBroker('snssqs')('src/main/resources/parameters/local/messaging.yaml');
  assert.ok(/^\s+queue: /m.test(yaml), yaml);
});

// El reset abre CADA clase de flujo, así que restoreBroker() corre decenas de veces por
// suite. Levantar un contenedor ya arrancado es barato; lo que cuelga de startBroker() no
// —resiembra de topología y sonda de entrega end-to-end, con espera de hasta 90 s—. En la
// corrida SNS/SQS del 14/08/2026 eso mató 14 clases enteras (55 escenarios NO_EJERCITADOS)
// por agotar la espera bajo la carga de la suite completa, sin que ninguna tuviera nada
// que ver con el outbox. El flag BROKER_STOPPED ya existía y no se consultaba.
test('§1.2: el reset solo restaura el broker si un escenario lo tiró', () => {
  const harness = scaffoldWithBroker('snssqs')(
    'src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java'
  );

  const restore = harness.slice(
    harness.indexOf('private static void restoreBroker()'),
    harness.indexOf('private static void awaitBrokerReady()')
  );
  assert.ok(restore.includes('BROKER_STOPPED.get()'), `restoreBroker no consulta el flag: ${restore}`);
  assert.ok(restore.includes('startBroker();'), restore);
});


test('§4: los números del barrido salen de parameters/, y solo el umbral viene del diseño', () => {
  // El designGap de la corrida: `schedule` solo admitía `cron`, así que el umbral de
  // espera, la caducidad del reclamo y el tamaño de lote los elegía el agente — y en el
  // diseño acabaron como PROSA dentro de `rules`, que no lee ninguna herramienta.
  //
  // La 2.8 no metió los tres en el DSL, y la asimetría es el punto: cuánto se espera a un
  // proveedor antes de insistir es negocio (`unansweredAfterSeconds`); cuánto dura un
  // reclamo y cuánto cabe en un lote son mecánica y capacidad, de la familia que
  // `dsl-reference.md § Modificación del DSL equivocada` deja fuera a propósito.
  const { read } = scaffoldExtended();

  const local = read('src/main/resources/parameters/local/reconciliation.yaml');
  assert.ok(local.includes('  record-withdrawal:'), local);
  assert.ok(local.includes('unanswered-after-seconds: 3600'), local);
  assert.ok(local.includes('claim-timeout-ms: 60000'), local);
  assert.ok(local.includes('batch-size: 50'), local);

  // Fuera de local, el gradiente habitual: el diseño fija el valor y el entorno puede
  // moverlo sin recompilar, que es lo que hace compatible «lo declara el diseño» con «es
  // configuración».
  const production = read('src/main/resources/parameters/production/reconciliation.yaml');
  assert.ok(
    production.includes('unanswered-after-seconds: ${RECONCILIATION_RECORD_WITHDRAWAL_UNANSWERED_AFTER_SECONDS:3600}'),
    production
  );

  // Y el perfil lo importa: un fragmento que nadie carga son parámetros que nadie lee.
  assert.ok(read('src/main/resources/application-local.yaml').includes('parameters/local/reconciliation.yaml'));

  // Y quién LEE cada número: el adaptador, no el handler. El handler vive en
  // `application`, que por constitución no importa Spring, así que no puede leer
  // configuración — por eso el reclamo generado no recibe `batchSize` por parámetro y los
  // tres `@Value` están donde sí pueden estar.
  const adapter = read(`${JAVA}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`);
  assert.ok(adapter.includes('reconciliation.record-withdrawal.unanswered-after-seconds:3600'), adapter);
  assert.ok(adapter.includes('reconciliation.record-withdrawal.claim-timeout-ms:60000'), adapter);
  assert.ok(adapter.includes('reconciliation.record-withdrawal.batch-size:50'), adapter);

  // Y la nota del stub manda usar el reclamo generado —que es quien los aplica— en vez de
  // elegir números o escribir otro reclamo.
  const handler = read(`${JAVA}/application/usecases/ReconcileWithdrawalsCommandHandler.java`);
  assert.ok(handler.includes('claimForReconcileWithdrawalsRecordWithdrawal()'), handler);
  assert.ok(handler.includes('parameters/<perfil>/reconciliation.yaml'), handler);
});
