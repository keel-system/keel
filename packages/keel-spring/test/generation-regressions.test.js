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
  // addProductImage declara `output: void`: sin id que referenciar no hay URI que
  // construir, así que se queda con @ResponseStatus(CREATED) y sin Location.
  assert.ok(image.includes('@ResponseStatus(HttpStatus.CREATED)'));
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
  const controller = read(controllerPath('productimage'));
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
  const childToJpa = adapter.slice(adapter.indexOf('private ProductImageJpa toJpa('));
  assert.ok(!childToJpa.includes('toJpa(domain.getProduct())'));
  assert.ok(adapter.includes('.forEach(child -> child.setProduct(jpa))'));
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

test('humo del arnés: solo exige los canales que el diseño declara', () => {
  const { read } = scaffoldExtended();
  // catalog-extended no declara `channels`: el destino por convención es el
  // exchange del servicio, que en RabbitMQ no es un destino legible. Sin nombre
  // fijado por el diseño, el humo no inventa una aserción de mensajería.
  const smoke = read('src/integrationTest/java/com/commerce/catalog/flows/HarnessSmokeIT.java');
  assert.ok(!smoke.includes('eventChannelsAreReadableAndPurgeable'));
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

  // Y la infraestructura se declara mal desde el sondeo, antes de arrancar nada.
  assert.ok(script.includes('mc anonymous get local/catalog-product-images'));

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
});
