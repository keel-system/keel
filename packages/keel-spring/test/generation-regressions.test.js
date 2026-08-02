// Regresiones del informe de generación de catalog-spring: cada caso reproduce
// un bug determinista del scaffolding con la fixture catalog-extended (binding
// HTTP, status de éxito, paginación, payload de eventos, DTOs con relaciones,
// multipart, mapeo bidireccional, errores con status por operación, caché e
// infraestructura de validación).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
const JAVA = 'src/main/java/com/commerce/catalog';

function scaffoldExtended() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regression-'));
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
  // La hija se mapea con su propio DTO, no con un null pendiente.
  assert.ok(mapper.includes('entity.getImages().stream().map(this::toProductImageDto).toList()'));
  assert.ok(mapper.includes('public ProductImageDto toProductImageDto(ProductImage entity)'));
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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `keel-probe-${broker}-`));
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
  assert.ok(kafka.includes('copyToDevtools(payload, PUBLISH_BODY);'));
  assert.ok(!kafka.includes("printf '%s'"));
  assert.ok(!kafka.includes('shellQuote(payload)'));
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
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-purge-'));
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'rabbitmq' } });
  const reset = fs.readFileSync(path.join(out, 'services/metering-digest-spring/infra/reset-db.sh'), 'utf8');

  // Los dos canales del diseño (el propio y el externo del que se consume).
  assert.ok(reset.includes('/api/queues/%2F/digests/contents'));
  assert.ok(reset.includes('/api/queues/%2F/meterTelemetry/contents'));
  // Que la cola aún no exista no es estado sucio: el reset avisa y sigue.
  assert.ok(reset.includes('AVISO: no se pudo purgar'));
});

test('§1.2: con Kafka no hay purga posible, el aislamiento es la marca de offset', () => {
  const { manifest, layers } = loadService(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'metering-digest')
  );
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-mark-'));
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
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-smoke-'));
  scaffoldService({ manifest, layers, workspace: out, force: true, stack: { broker: 'rabbitmq' } });
  const declared = fs.readFileSync(
    path.join(out, 'services/metering-digest-spring/src/integrationTest/java/com/utilities/meteringdigest/flows/HarnessSmokeIT.java'),
    'utf8'
  );
  assert.ok(declared.includes('for (String channel : List.of("digests"))'));
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
  assert.ok(harness.includes('Map<String, String> fields) {\n        return multipart('));
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-regression-'));
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

  assert.ok(command.includes('@Size(max = 200) JsonNullable<String> name'));
  assert.ok(command.includes('JsonNullable<UUID> categoryId'));
  assert.ok(buildGradle.includes('org.openapitools:jackson-databind-nullable'));
  assert.ok(webConfig.includes('public JsonNullableModule jsonNullableModule()'));
  // Sin el value extractor, un @Size sobre JsonNullable no se evalúa nunca.
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-locking-'));
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
  assert.ok(!advice.includes('OPTIMISTIC_LOCK_CONFLICT'));
  assert.ok(!advice.includes('ObjectOptimisticLockingFailureException'));
});

test('concurrencia: optimisticLocking all (default) sigue protegiendo toda raíz', () => {
  const { read } = scaffoldWithLocking('all');
  const jpa = read(`${JAVA}/infrastructure/persistence/entities/ProductJpa.java`);

  assert.ok(jpa.includes('@Version\n    @Column(name = "lock_version")'));
  assert.ok(read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`).includes('OPTIMISTIC_LOCK_CONFLICT'));
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-concurrency-'));
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
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `keel-broker-${broker}-`));
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
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-topology-'));
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
  assert.ok(script.includes("create_queue_with_dlq 'digests' 5"), script);
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
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `keel-topology-${broker}-`));
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
  assert.ok(!command.includes('@Pattern'), command);
  // Presencia sí se queda: no compite con ninguna normalización.
  assert.ok(command.includes('@NotBlank String sku'), command);
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
