import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { wrapperDir, GRADLE_VERSION } from '../src/lib/assets.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');

function loadFixture() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  return { manifest, layers };
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keel-scaffold-'));
}

function read(workspace, relative) {
  return fs.readFileSync(path.join(workspace, 'services', 'product-catalog-spring', relative), 'utf8');
}

function exists(workspace, relative) {
  return fs.existsSync(path.join(workspace, 'services', 'product-catalog-spring', relative));
}

test('scaffoldService genera el proyecto completo con contenido clave', () => {
  const workspace = makeWorkspace();
  const { outDir, copied, skipped, warnings } = scaffoldService({ ...loadFixture(), workspace });

  assert.equal(outDir, 'services/product-catalog-spring');
  assert.deepEqual(skipped, []);
  assert.deepEqual(warnings, []);
  assert.ok(copied.length > 15);

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('spring-boot-starter-data-jpa'));
  assert.ok(buildGradle.includes("runtimeOnly 'org.postgresql:postgresql'"));
  assert.ok(buildGradle.includes('JavaLanguageVersion.of(21)'));
  assert.ok(buildGradle.includes('springdoc-openapi-starter-webmvc-ui'));
  assert.ok(!buildGradle.includes('spring-kafka')); // sin capa messaging

  // Dominio puro (sin JPA) en domain/aggregate; la Jpa vive aparte.
  const product = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/aggregate/Product.java');
  assert.ok(!product.includes('@Entity'));
  assert.ok(!product.includes('@Column'));
  assert.ok(product.includes('public void transitionTo(ProductStatus target)'));
  assert.ok(product.includes('// TODO invariante'));
  assert.ok(product.includes('// Constructor completo: reconstrucción desde persistencia.'));

  const productJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/ProductJpa.java');
  assert.ok(productJpa.includes('@Entity'));
  assert.ok(productJpa.includes('@Table(name = "products"'));
  assert.ok(productJpa.includes('public class ProductJpa extends AuditableEntity'));

  // Auditoría automática (portada del shared del prototipo).
  const auditable = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/AuditableEntity.java');
  assert.ok(auditable.includes('@MappedSuperclass'));
  assert.ok(auditable.includes('@CreatedDate'));
  const application = read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java');
  assert.ok(application.includes('@EnableJpaAuditing'));

  // @LogExceptions implementada con su aspecto (AOP).
  assert.ok(buildGradle.includes('spring-boot-starter-aop'));
  const aspect = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/logging/LogExceptionsAspect.java');
  assert.ok(aspect.includes('@Around("@annotation(logExceptions)")'));
  assert.ok(fs.existsSync(path.join(workspace, 'services', 'product-catalog-spring', 'src/main/java/com/commerce/productcatalog/application/annotations/LogExceptions.java')));

  // Desacople de application: anotaciones propias registradas por UseCaseConfig.
  const applicationComponent = read(workspace, 'src/main/java/com/commerce/productcatalog/application/annotations/ApplicationComponent.java');
  assert.ok(applicationComponent.includes('public @interface ApplicationComponent'));
  assert.ok(fs.existsSync(path.join(workspace, 'services', 'product-catalog-spring', 'src/main/java/com/commerce/productcatalog/domain/annotations/DomainComponent.java')));
  const useCaseConfig = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/usecase/UseCaseConfig.java');
  assert.ok(useCaseConfig.includes('FilterType.ANNOTATION'));

  // Controller versionado que despacha vía mediator; commands con body = @RequestBody del Command.
  const controller = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/controllers/product/v1/ProductV1Controller.java');
  assert.ok(controller.includes('@RequestMapping("/api/v1")'));
  assert.ok(controller.includes('@Tag(name = "Product"'));
  assert.ok(controller.includes('@GetMapping("/products/{id}")'));
  assert.ok(controller.includes('@PostMapping("/products/{id}/retire")'));
  assert.ok(controller.includes('@ResponseStatus(HttpStatus.NO_CONTENT)'));
  assert.ok(controller.includes('private final UseCaseMediator mediator;'));
  assert.ok(controller.includes('return mediator.dispatch(new GetProductQuery(id));'));
  assert.ok(controller.includes('mediator.dispatch(new RetireProductCommand(id));'));
  assert.ok(controller.includes('@Valid @RequestBody CreateProductCommand command'));
  assert.ok(controller.includes('return mediator.dispatch(command);'));

  // Manejo centralizado de errores: jerarquía DomainException + validación + catch-all.
  const advice = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(advice.includes('@ExceptionHandler(MethodArgumentNotValidException.class)'));
  assert.ok(advice.includes('@ExceptionHandler(DomainException.class)'));
  assert.ok(advice.includes('@ExceptionHandler(Exception.class)'));
  assert.ok(advice.includes('"VALIDATION_ERROR"'));

  const baseNotFound = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/errors/NotFoundException.java');
  assert.ok(baseNotFound.includes('extends DomainException'));
  const notFound = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/errors/ProductNotFoundError.java');
  assert.ok(notFound.includes('extends NotFoundException'));
  assert.ok(notFound.includes('super(message, "PRODUCT_NOT_FOUND", 404, null);'));
  const skuExists = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/errors/SkuAlreadyExistsError.java');
  assert.ok(skuExists.includes('extends ConflictException'));
  const invalidTransition = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/errors/InvalidStateTransitionException.java');
  assert.ok(invalidTransition.includes('extends ConflictException'));
  assert.ok(invalidTransition.includes('"INVALID_STATE_TRANSITION"'));
  const errorResponse = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ErrorResponse.java');
  assert.ok(errorResponse.includes('public record ErrorResponse(Instant timestamp, int status, String error, String code, String message, List<String> details)'));

  // Infraestructura del mediator (sin paquete shared) con la frontera transaccional.
  const mediatorFile = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/usecase/UseCaseMediator.java');
  assert.ok(mediatorFile.includes('public <R, Q extends Query<R>> R dispatch(Q query)'));
  assert.ok(mediatorFile.includes('TransactionTemplate'));
  assert.ok(mediatorFile.includes('readTransaction.setReadOnly(true);'));
  assert.ok(fs.existsSync(path.join(workspace, 'services', 'product-catalog-spring', 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/usecase/UseCaseAutoRegister.java')));
  assert.ok(fs.existsSync(path.join(workspace, 'services', 'product-catalog-spring', 'src/main/java/com/commerce/productcatalog/application/interfaces/ReturningCommandHandler.java')));

  // Un record mensaje (con Bean Validation) + un handler por operación.
  const createCommand = read(workspace, 'src/main/java/com/commerce/productcatalog/application/commands/CreateProductCommand.java');
  assert.ok(createCommand.includes('implements ReturningCommand<CreateProductResponseDto>'));
  assert.ok(createCommand.includes('jakarta.validation.constraints')); // el Command es el body HTTP
  const createHandler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java');
  assert.ok(createHandler.includes('implements ReturningCommandHandler<CreateProductCommand, CreateProductResponseDto>'));
  assert.ok(createHandler.includes('throw new UnsupportedOperationException("TODO: createProduct")'));
  assert.ok(createHandler.includes('import com.commerce.productcatalog.domain.repository.ProductRepository;')); // puerto, no JPA
  const getHandler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/GetProductQueryHandler.java');
  // Desacople real: el handler no importa NADA de Spring (la transacción la abre el mediator).
  assert.ok(getHandler.includes('@ApplicationComponent'));
  assert.ok(!getHandler.includes('org.springframework'));
  assert.ok(!getHandler.includes('@Transactional'));
  assert.ok(getHandler.includes('@LogExceptions'));
  assert.ok(getHandler.includes('ProductApplicationMapper'));
  const retireCommand = read(workspace, 'src/main/java/com/commerce/productcatalog/application/commands/RetireProductCommand.java');
  assert.ok(retireCommand.includes('implements Command'));

  // Persistencia hexagonal: puerto + Spring Data + adaptador con mapeo inline.
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/repository/ProductRepository.java');
  assert.ok(port.includes('public interface ProductRepository'));
  assert.ok(port.includes('Optional<Product> findBySku(String sku);'));
  assert.ok(!port.includes('JpaRepository'));
  const jpaRepository = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/ProductJpaRepository.java');
  assert.ok(jpaRepository.includes('extends JpaRepository<ProductJpa, UUID>'));
  const adapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/ProductRepositoryImpl.java');
  assert.ok(adapter.includes('implements ProductRepository'));
  assert.ok(adapter.includes('private Product toDomain(ProductJpa jpa)'));
  assert.ok(adapter.includes('private ProductJpa toJpa(Product domain)'));

  // Mapper de aplicación dominio → ResponseDto (también sin Spring).
  const mapper = read(workspace, 'src/main/java/com/commerce/productcatalog/application/mappers/ProductApplicationMapper.java');
  assert.ok(mapper.includes('public CreateProductResponseDto toCreateProductResponseDto(Product entity)'));
  assert.ok(mapper.includes('@ApplicationComponent'));
  assert.ok(!mapper.includes('org.springframework'));

  // Multi-ambiente: base + perfiles + fragmentos con gradiente de env vars.
  const appYaml = read(workspace, 'src/main/resources/application.yaml');
  assert.ok(!appYaml.includes('context-path')); // la ruta base va en @RequestMapping (<basePath>/v1)
  assert.ok(appYaml.includes('active: ${PROFILE:local}'));
  const localProfile = read(workspace, 'src/main/resources/application-local.yaml');
  assert.ok(localProfile.includes('classpath:parameters/local/db.yaml'));
  const localDb = read(workspace, 'src/main/resources/parameters/local/db.yaml');
  assert.ok(localDb.includes('jdbc:postgresql://localhost:5432/product_catalog'));
  assert.ok(localDb.includes('username: product_catalog')); // literal en local
  assert.ok(localDb.includes('ddl-auto: update'));
  const developDb = read(workspace, 'src/main/resources/parameters/develop/db.yaml');
  assert.ok(developDb.includes('username: ${DB_USERNAME:product_catalog}')); // env var con default
  const productionDb = read(workspace, 'src/main/resources/parameters/production/db.yaml');
  assert.ok(productionDb.includes('username: ${DB_USERNAME}')); // sin default: obligatoria
  assert.ok(productionDb.includes('ddl-auto: validate'));
  const productionLogging = read(workspace, 'src/main/resources/parameters/production/logging.yaml');
  assert.ok(productionLogging.includes('root: WARN'));
  const testProfile = read(workspace, 'src/main/resources/application-test.yaml');
  assert.ok(testProfile.includes('classpath:parameters/test/db.yaml'));
  assert.ok(read(workspace, 'src/main/resources/parameters/test/db.yaml').includes('jdbc:h2:mem:testdb'));
  assert.ok(read(workspace, 'src/test/resources/application.yaml').includes('active: test'));

  // Estilo Spring Initializr: wrapper incluido, .gitattributes y test de contexto.
  const projectDir = path.join(workspace, 'services', 'product-catalog-spring');
  assert.ok(fs.existsSync(path.join(projectDir, 'gradlew')));
  assert.ok(fs.existsSync(path.join(projectDir, 'gradlew.bat')));
  const vendorJar = fs.readFileSync(path.join(wrapperDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'));
  const copiedJar = fs.readFileSync(path.join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar'));
  assert.ok(vendorJar.equals(copiedJar)); // copia binaria intacta
  assert.ok(read(workspace, 'gradle/wrapper/gradle-wrapper.properties').includes(`gradle-${GRADLE_VERSION}-bin.zip`));
  assert.ok(read(workspace, '.gitattributes').includes('/gradlew        text eol=lf'));
  const appTests = read(workspace, 'src/test/java/com/commerce/productcatalog/ProductCatalogApplicationTests.java');
  assert.ok(appTests.includes('@SpringBootTest'));
  assert.ok(appTests.includes('void contextLoads()'));

  // Infraestructura de prueba: compose con la BD por defecto.
  const compose = read(workspace, 'docker-compose.yaml');
  assert.ok(compose.includes('postgres:16-alpine'));
  assert.ok(!compose.includes('kafka')); // sin capa messaging
});

test('stack elegido (mysql + rabbitmq) parametriza gradle, yaml y compose', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  // Capa messaging mínima para activar la categoría broker.
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';

  const { stack } = scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'mysql', broker: 'rabbitmq', auth: null, cache: null }
  });
  assert.equal(stack.database, 'mysql');
  assert.equal(stack.broker, 'rabbitmq');

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('com.mysql:mysql-connector-j'));
  assert.ok(buildGradle.includes('spring-boot-starter-amqp'));
  assert.ok(!buildGradle.includes('org.postgresql'));
  assert.ok(!buildGradle.includes('spring-kafka'));

  const localDb = read(workspace, 'src/main/resources/parameters/local/db.yaml');
  assert.ok(localDb.includes('jdbc:mysql://localhost:3306/product_catalog'));
  const localBroker = read(workspace, 'src/main/resources/parameters/local/rabbitmq.yaml');
  assert.ok(localBroker.includes('username: guest'));
  const productionBroker = read(workspace, 'src/main/resources/parameters/production/rabbitmq.yaml');
  assert.ok(productionBroker.includes('username: ${RABBITMQ_USERNAME}'));

  // Con capa messaging: evento de dominio + puerto publisher transversal + stub
  // sin broker. La implementación real (Rabbit) la escribe el agente.
  const event = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedEvent.java');
  assert.ok(event.includes('public record ProductCreatedEvent('));
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java');
  assert.ok(port.includes('public interface ProductCreatedPublisher'));
  assert.ok(!port.includes('RabbitTemplate'));
  const stub = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java');
  assert.ok(stub.includes('implements ProductCreatedPublisher'));
  assert.ok(stub.includes('TODO (agente)'));
  assert.ok(!stub.includes('RabbitTemplate'));
  const envelope = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/EventMetadata.java');
  assert.ok(envelope.includes('"product-catalog"')); // source = nombre del servicio
  // La config del broker ya no es determinista: la escribe el agente.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/broker/RabbitMqConfig.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisher.java'));

  const compose = read(workspace, 'docker-compose.yaml');
  assert.ok(compose.includes('mysql:8.0'));
  assert.ok(compose.includes('rabbitmq:4-management'));
});

test('devtools: compose trae el toolbox + Dockerfile + validate-infra.sh con las CLIs del stack', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';

  // Stack por defecto: postgres + kafka → ambas CLIs viven en devtools.
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const compose = read(workspace, 'docker-compose.yaml');
  assert.ok(compose.includes('product-catalog-devtools')); // container_name determinista
  assert.ok(compose.includes('Dockerfile.devtools'));
  assert.ok(compose.includes('kafka:29092')); // listener interno para clientes en red

  const dockerfile = read(workspace, 'docker/Dockerfile.devtools');
  assert.ok(dockerfile.includes('FROM alpine:3.20'));
  assert.ok(dockerfile.includes('postgresql-client')); // BD por defecto
  assert.ok(dockerfile.includes('kcat')); // broker kafka
  assert.ok(!dockerfile.includes('mysql-client')); // solo las CLIs del stack elegido

  const script = read(workspace, 'validate-infra.sh');
  assert.ok(script.startsWith('#!/usr/bin/env bash'));
  assert.ok(script.includes('psql -h db')); // check de la BD
  assert.ok(script.includes('kcat -b kafka:29092')); // check del broker
  assert.ok(script.includes('product-catalog-devtools')); // ejecuta vía docker exec en devtools
});

test('h2 como BD elegida: sin contenedor de BD ni devtools, pero con dependencia Gradle', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  const { copied } = scaffoldService({
    manifest,
    layers,
    workspace,
    stack: { database: 'h2', broker: null, auth: null, cache: null, storage: null }
  });

  // H2 es en memoria: el fixture no tiene más infra → no hay compose ni toolbox.
  assert.ok(!copied.includes('docker-compose.yaml'));
  assert.ok(!copied.some((f) => f.includes('Dockerfile.devtools')));
  assert.ok(!copied.includes('validate-infra.sh'));

  assert.ok(read(workspace, 'build.gradle').includes("runtimeOnly 'com.h2database:h2'"));
});

test('capa storage: gradle con SDK S3, compose con MinIO y fragmento de config por perfil', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.storage = { buckets: { productImages: { visibility: 'public', allowedContentTypes: ['image/png'], maxSizeMb: 5 } } };
  patched.domain.entities.Product.fields.photo = { type: 'file', bucket: 'productImages' };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.storage = 'storage.keel.yaml';

  const { stack } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace });
  assert.equal(stack.storage, 'minio'); // default

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('software.amazon.awssdk:s3'));

  const compose = read(workspace, 'docker-compose.yaml');
  assert.ok(compose.includes('minio/minio'));
  assert.ok(compose.includes('minio-data')); // volumen persistente registrado

  const localStorage = read(workspace, 'src/main/resources/parameters/local/storage.yaml');
  assert.ok(localStorage.includes('provider: minio'));
  assert.ok(localStorage.includes('endpoint: http://localhost:9000')); // coincide con el compose
  assert.ok(localStorage.includes('access-key: minioadmin'));
  const productionStorage = read(workspace, 'src/main/resources/parameters/production/storage.yaml');
  assert.ok(productionStorage.includes('access-key: ${STORAGE_ACCESS_KEY}')); // env var obligatoria

  const localProfile = read(workspace, 'src/main/resources/application-local.yaml');
  assert.ok(localProfile.includes('classpath:parameters/local/storage.yaml'));

  // El campo file de la entidad persiste la key como String, no un binario.
  const productJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/ProductJpa.java');
  assert.ok(productJpa.includes('String photo'));

  // Storage transversal: solo el puerto de dominio. El adaptador y el bean del
  // cliente (S3/MinIO) los escribe el agente según el stack.
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/storage/FileStorage.java');
  assert.ok(port.includes('public interface FileStorage'));
  assert.ok(port.includes('void upload(String key, byte[] content, String contentType);'));
  assert.ok(port.includes('String signedUrl(String key);'));
  assert.ok(!port.includes('org.springframework')); // puerto puro de dominio

  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/storage/S3Config.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/storage/S3FileStorage.java'));

  // Perfil test: fragmento storage dummy para el adaptador que escriba el agente.
  const testStorage = read(workspace, 'src/main/resources/parameters/test/storage.yaml');
  assert.ok(testStorage.includes('bucket: test-bucket'));
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('classpath:parameters/test/storage.yaml'));
});

test('storage con s3 elegido: mismo SDK pero sin contenedor MinIO en el compose', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.storage = { buckets: { productImages: { allowedContentTypes: ['image/png'] } } };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.storage = 'storage.keel.yaml';

  const { stack } = scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: null, broker: null, auth: null, cache: null, storage: 's3' }
  });
  assert.equal(stack.storage, 's3');

  assert.ok(read(workspace, 'build.gradle').includes('software.amazon.awssdk:s3'));
  const compose = read(workspace, 'docker-compose.yaml'); // existe por la BD del fixture
  assert.ok(!compose.includes('minio'));
  const localStorage = read(workspace, 'src/main/resources/parameters/local/storage.yaml');
  assert.ok(localStorage.includes('provider: s3'));
  assert.ok(!localStorage.includes('minio-data'));
});

test('capa security (oidc): SecurityFilterChain con matchers por ruta + JwtAuthConverter del proveedor', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc' },
    roles: { 'catalog-admin': { description: 'Administra el catálogo' } },
    permissions: { 'product:write': { description: 'Modifica productos' } },
    access: {
      default: { level: 'required' },
      rules: {
        listProducts: { level: 'public' },
        getProduct: { level: 'public' },
        createProduct: { level: 'admin', roles: ['catalog-admin'] },
        retireProduct: { level: 'required', permissions: ['product:write'] }
      }
    }
  };

  const { warnings } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { auth: 'keycloak' } });
  assert.deepEqual(warnings, []);

  const securityDir = 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/security';
  const config = read(workspace, `${securityDir}/SecurityConfig.java`);
  assert.ok(config.includes('@EnableWebSecurity'));
  assert.ok(config.includes('SessionCreationPolicy.STATELESS'));
  // Matchers reutilizan las rutas exactas de los controllers (fuente única).
  assert.ok(config.includes('.requestMatchers(HttpMethod.GET, "/api/v1/products").permitAll()'));
  assert.ok(config.includes('.requestMatchers(HttpMethod.POST, "/api/v1/products").hasAnyRole("catalog-admin")'));
  assert.ok(config.includes('.requestMatchers(HttpMethod.POST, "/api/v1/products/{id}/retire").hasAnyAuthority("product:write")'));
  assert.ok(config.includes('.anyRequest().authenticated()'));
  assert.ok(config.includes('.oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthConverter())))'));

  // JwtAuthConverter consciente del proveedor (keycloak → claim anidado).
  const converter = read(workspace, `${securityDir}/JwtAuthConverter.java`);
  assert.ok(converter.includes('jwt.getClaimAsMap("realm_access")'));
  assert.ok(converter.includes('setPrincipalClaimName("preferred_username")'));

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('spring-boot-starter-security'));
  assert.ok(buildGradle.includes('spring-boot-starter-oauth2-resource-server'));
  assert.ok(read(workspace, 'src/main/resources/parameters/local/oauth2.yaml').includes('issuer-uri'));
});

test('capa security (api-key): filtro propio sin resource server ni fragmento oauth2', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'api-key' },
    access: { default: { level: 'required' }, rules: { listProducts: { level: 'public' } } }
  };

  const { copied } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { auth: null } });

  const securityDir = 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/security';
  const config = read(workspace, `${securityDir}/SecurityConfig.java`);
  assert.ok(config.includes('.addFilterBefore(new ApiKeyAuthFilter(apiKey), UsernamePasswordAuthenticationFilter.class)'));
  assert.ok(config.includes('@Value("${security.api-key:}")'));
  assert.ok(!config.includes('oauth2ResourceServer'));
  assert.ok(read(workspace, `${securityDir}/ApiKeyAuthFilter.java`).includes('extends OncePerRequestFilter'));

  // api-key no usa resource server JWT ni el fragmento oauth2.
  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('spring-boot-starter-security'));
  assert.ok(!buildGradle.includes('oauth2-resource-server'));
  assert.ok(!copied.some((f) => f.includes('oauth2.yaml')));
  assert.ok(!copied.some((f) => f.includes('JwtAuthConverter')));
});

test('capa http-clients: RestClient configurado + resilience4j + fallback stub', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';
  const patched = structuredClone(layers);
  patched['http-clients'] = {
    clients: {
      'pricing-service': {
        purpose: 'Obtener el precio vigente de un producto.',
        calls: {
          getPrice: {
            contract: 'GET /prices/{sku} -> { amount: decimal }',
            timeoutMs: 2000,
            retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200, retryOn: ['timeout', '5xx'] },
            circuitBreaker: { failureRateThreshold: 50, slidingWindowSize: 20, waitDurationMs: 30000 },
            fallback: 'Devolver el último precio conocido en caché.'
          }
        }
      }
    }
  };

  const { warnings } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace });
  assert.deepEqual(warnings, []);

  const httpDir = 'src/main/java/com/commerce/productcatalog/infrastructure/http';
  const config = read(workspace, `${httpDir}/PricingServiceClientConfig.java`);
  assert.ok(config.includes('public RestClient pricingServiceRestClient'));
  assert.ok(config.includes('.withReadTimeout(Duration.ofMillis(2000))'));

  const iface = read(workspace, `${httpDir}/PricingServiceClient.java`);
  assert.ok(iface.includes('GetPriceResponse getPrice(String sku);')); // path var parseada

  const impl = read(workspace, `${httpDir}/PricingServiceClientImpl.java`);
  assert.ok(impl.includes('@Retry(name = "pricing-service-get-price")'));
  assert.ok(impl.includes('@CircuitBreaker(name = "pricing-service-get-price", fallbackMethod = "getPriceFallback")'));
  assert.ok(impl.includes('.uri("/prices/{sku}", sku)')); // llamada funcional armada del contract
  assert.ok(impl.includes('private GetPriceResponse getPriceFallback(String sku, Throwable throwable)'));
  assert.ok(impl.includes('// TODO (agente): Devolver el último precio conocido en caché.')); // fallback = stub de negocio

  // resilience4j en gradle + fragmento de config con instancias derivadas del diseño.
  assert.ok(read(workspace, 'build.gradle').includes('resilience4j-spring-boot3'));
  const hc = read(workspace, 'src/main/resources/parameters/local/http-clients.yaml');
  assert.ok(hc.includes('base-url: http://localhost:8080'));
  assert.ok(hc.includes('max-attempts: 3'));
  assert.ok(hc.includes('- org.springframework.web.client.HttpClientErrorException')); // 4xx nunca se reintenta
  assert.ok(hc.includes('failure-rate-threshold: 50'));
});

test('capa messaging (subscriptions): payload record transversal, sin listener del broker', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  const patched = structuredClone(layers);
  patched.messaging = {
    subscriptions: {
      StockDepleted: {
        source: 'inventory-service',
        payload: { productId: { type: 'uuid', required: true } },
        triggers: 'retireProduct',
        onFailure: { retry: { maxAttempts: 5, backoff: 'exponential', initialDelayMs: 1000 }, deadLetter: true }
      }
    }
  };

  const { warnings } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace });
  assert.deepEqual(warnings, []);

  const subsDir = 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/subscriptions';
  const message = read(workspace, `${subsDir}/StockDepletedMessage.java`);
  assert.ok(message.includes('public record StockDepletedMessage(UUID productId)'));
  // El record documenta quién lo consumirá y qué operación despacha.
  assert.ok(message.includes('StockDepletedListener'));
  assert.ok(message.includes("'retireProduct'"));

  // El listener depende del broker: lo escribe el agente, no build.
  assert.ok(!exists(workspace, `${subsDir}/StockDepletedListener.java`));
  // Broker por defecto (kafka): spring-kafka en gradle para el código del agente.
  assert.ok(read(workspace, 'build.gradle').includes('spring-kafka'));
});

test('publisher: puerto + stub transversales sin código del broker elegido', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  patched['use-cases'].operations.createProduct.emits = ['ProductCreated'];
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';

  const { stack } = scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: null, broker: 'snssqs', auth: null, cache: null, storage: null }
  });
  assert.equal(stack.broker, 'snssqs');

  // El handler que emite el evento inyecta el PUERTO, nunca el template.
  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java');
  assert.ok(handler.includes('private final ProductCreatedPublisher productCreatedPublisher;'));
  assert.ok(handler.includes('publicar vía el puerto inyectado'));

  // Sea cual sea el broker, build solo genera puerto + stub sin templates.
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java');
  assert.ok(port.includes('public interface ProductCreatedPublisher'));
  assert.ok(port.includes('void publish(ProductCreatedEvent event, String correlationId);'));

  const stub = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java');
  assert.ok(stub.includes('implements ProductCreatedPublisher'));
  assert.ok(stub.includes('throw new UnsupportedOperationException'));
  for (const ajeno of ['SnsTemplate', 'KafkaTemplate', 'RabbitTemplate']) {
    assert.ok(!stub.includes(ajeno));
  }
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisher.java'));
  // Las deps del broker elegido sí van en gradle (las usa el código del agente).
  assert.ok(read(workspace, 'build.gradle').includes('spring-cloud-aws-starter-sns'));
});

test('grupo introducido parametriza build.gradle y el package de las clases Java', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  const { stack } = scaffoldService({
    manifest,
    layers,
    workspace,
    stack: { group: 'com.acme', database: null, broker: null, auth: null, cache: null }
  });
  assert.equal(stack.group, 'com.acme');

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes("group = 'com.acme'"));

  // Las clases Java viven bajo com/acme/productcatalog con el package correcto.
  const app = read(workspace, 'src/main/java/com/acme/productcatalog/ProductCatalogApplication.java');
  assert.ok(app.includes('package com.acme.productcatalog;'));
});

test('regeneración segura: la segunda pasada omite todo y respeta ediciones', () => {
  const workspace = makeWorkspace();
  const fixture = loadFixture();
  scaffoldService({ ...fixture, workspace });

  const servicePath = path.join(
    workspace,
    'services/product-catalog-spring/src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java'
  );
  fs.writeFileSync(servicePath, '// implementado por el agente');

  const second = scaffoldService({ ...fixture, workspace });
  assert.deepEqual(second.copied, []);
  assert.ok(second.skipped.length > 15);
  assert.equal(fs.readFileSync(servicePath, 'utf8'), '// implementado por el agente');

  const forced = scaffoldService({ ...fixture, workspace, force: true });
  assert.ok(forced.copied.length > 15);
  assert.notEqual(fs.readFileSync(servicePath, 'utf8'), '// implementado por el agente');
});

test('sin capa persistence: POJOs sin JPA, sin repositorio ni datasource', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const noPersistenceManifest = structuredClone(manifest);
  delete noPersistenceManifest.layers.persistence;
  const { persistence, ...restLayers } = layers;

  const { copied } = scaffoldService({ manifest: noPersistenceManifest, layers: restLayers, workspace });

  const product = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/aggregate/Product.java');
  assert.ok(!product.includes('@Entity'));
  assert.ok(!product.includes('@Column'));
  assert.ok(product.includes('public void transitionTo(ProductStatus target)')); // el guard se mantiene
  assert.ok(!copied.some((file) => file.includes('ProductJpa'))); // sin persistence no hay lado JPA

  assert.ok(!copied.some((file) => file.includes('ProductRepository')));
  // Sin persistence no hay fragmento H2, pero el perfil test sigue existiendo.
  assert.ok(!copied.some((file) => file.includes('parameters/test/db.yaml')));
  assert.ok(read(workspace, 'src/test/resources/application.yaml').includes('active: test'));

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(!buildGradle.includes('data-jpa'));

  // Sin persistence/messaging/cache no hay contenedores → sin compose.
  assert.ok(!copied.includes('docker-compose.yaml'));

  const money = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/valueobject/Money.java');
  assert.ok(money.includes('public record Money('));

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java');
  assert.ok(!handler.includes('@Transactional'));
  assert.ok(!handler.includes('ProductRepository'));

  // Sin persistence el mediator no abre transacciones.
  const mediatorFile = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/usecase/UseCaseMediator.java');
  assert.ok(!mediatorFile.includes('TransactionTemplate'));
});

test('operación sin patrón CRUD ni endpoint explícito cae a POST con aviso', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched['use-cases'].operations.reconcilePrices = {
    description: 'Reconcilia los precios del catálogo con el proveedor.',
    kind: 'command',
    input: 'void',
    output: 'void'
  };

  const { warnings } = scaffoldService({ manifest, layers: patched, workspace });
  assert.ok(warnings.some((w) => w.includes("reconcilePrices")));

  // Sin entidad asociada, la operación se agrupa en el controller del nombre del propio servicio.
  const controller = read(
    workspace,
    'src/main/java/com/commerce/productcatalog/infrastructure/rest/controllers/productcatalog/v1/ProductCatalogV1Controller.java'
  );
  assert.ok(controller.includes('@PostMapping("/reconcile-prices")'));
  assert.ok(controller.includes('// TODO: revisar ruta'));
});
