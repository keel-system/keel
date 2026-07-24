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
  assert.ok(product.includes('private void transitionTo(ProductStatus target)')); // guard interno, no API
  assert.ok(product.includes('// TODO invariante'));
  assert.ok(product.includes('// Rehidratación desde persistencia'));
  // Modelo encapsulado (conventions/domain-modeling.md): ni setters ni constructor vacío.
  assert.ok(!product.includes('public void set'));
  assert.ok(!product.includes('public Product() {'));
  assert.ok(product.includes('// TODO (agente): factory de creación create(...)'));
  assert.ok(product.includes('// TODO (agente): método semántico'));

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
  // Con capa api el body de error lleva la correlación: es lo que hace
  // rastreable en logs el error que un usuario reporta.
  assert.ok(errorResponse.includes('public record ErrorResponse(Instant timestamp, int status, String error, String code, String message, List<String> details, String correlationId)'));
  assert.ok(errorResponse.includes('CorrelationContext.get()'));

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
  assert.ok(appYaml.includes('port: ${SERVER_PORT:8080}')); // puerto parametrizable, 8080 por defecto
  // Niveles de log: literales en local, env var con default fuera (nunca impiden arrancar).
  assert.ok(read(workspace, 'src/main/resources/parameters/local/logging.yaml').includes('root: INFO'));
  const productionLogging = read(workspace, 'src/main/resources/parameters/production/logging.yaml');
  assert.ok(productionLogging.includes('root: ${LOG_LEVEL_ROOT:WARN}'));
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
  const compose = read(workspace, 'infra/docker-compose.yaml');
  assert.ok(compose.includes('postgres:16-alpine'));
  assert.ok(!compose.includes('kafka')); // sin capa messaging
});

test('CLAUDE.md contextual: specs, solo capas declaradas y skill local con conventions', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const claude = read(workspace, '.claude/CLAUDE.md');
  assert.ok(claude.includes('specs/service.keel.yaml')); // snapshot local del diseño
  assert.ok(claude.includes('../../specs/product-catalog/')); // canónico del workspace
  assert.ok(claude.includes('persistence.keel.yaml'));
  assert.ok(!claude.includes('messaging.keel.yaml')); // capa no declarada en el fixture
  assert.ok(claude.includes('validation-scenarios.md'));
  assert.ok(claude.includes('grep -rn "TODO" src'));
  assert.ok(claude.includes('keel-stack.json'));
  assert.ok(claude.includes('infra/docker-compose.yaml')); // la infraestructura de prueba vive en infra/
  assert.ok(claude.includes('keel-spring-code')); // la skill orquesta los subagentes
  assert.ok(claude.includes('.claude/architecture.md'));
  assert.ok(claude.includes('.claude/constitution.md'));
  // Sin pruebas unitarias en el flujo: el gate es compilar + los escenarios end-to-end.
  assert.ok(claude.includes('./gradlew build -x test'));
  assert.ok(claude.includes('Sin pruebas unitarias'));
  assert.ok(!claude.includes('**Tests**')); // ya no hay paso de escribir tests

  // architecture.md y constitution.md: documentos de primer nivel en .claude/.
  const architecture = read(workspace, '.claude/architecture.md');
  assert.ok(architecture.includes('hexagonal'));
  assert.ok(architecture.includes('domain'));
  assert.ok(architecture.includes('application'));
  const constitution = read(workspace, '.claude/constitution.md');
  assert.ok(constitution.includes('UseCaseMediator'));
  assert.ok(constitution.includes('XxxRepositoryImpl'));

  // Skill propia del proyecto que apunta al CLAUDE.md como proceso y orquesta
  // los subagentes de .claude/agents/.
  const skill = read(workspace, '.claude/skills/keel-generate-spring/SKILL.md');
  assert.ok(skill.includes('name: keel-generate-spring'));
  assert.ok(skill.includes('CLAUDE.md'));
  assert.ok(skill.includes('autosuficiente'));
  assert.ok(skill.includes('keel-spring-code'));
  assert.ok(skill.includes('keel-spring-infra'));
  assert.ok(skill.includes('keel-spring-validate'));
  assert.ok(skill.includes('keel-spring-quality'));

  // Conventions siempre, hermanas de agents/ y skills/ en .claude/ (las lee
  // cualquiera de los 4 subagentes, no solo la skill orquestadora); el fixture
  // no elige broker/auth/cache/storage → sin skills de esas categorías, pero
  // declara persistence → keel-spring-database (default postgresql) acompaña
  // a la orquestadora en .claude/skills/.
  assert.ok(exists(workspace, '.claude/conventions/mapping.md'));
  assert.ok(exists(workspace, '.claude/conventions/project-layout.md'));
  assert.ok(exists(workspace, '.claude/conventions/infra-validation.md'));
  assert.ok(exists(workspace, '.claude/conventions/flow-fidelity.md'));
  assert.ok(exists(workspace, '.claude/conventions/domain-modeling.md'));
  assert.ok(exists(workspace, '.claude/conventions/domain-services.md'));
  assert.ok(exists(workspace, '.claude/conventions/virtual-threads.md'));
  assert.ok(!exists(workspace, '.claude/skills/keel-generate-spring/conventions'));
  assert.ok(!exists(workspace, '.claude/skills/keel-generate-spring/references'));
  const skillDirs = fs.readdirSync(path.join(workspace, 'services', 'product-catalog-spring', '.claude', 'skills')).sort();
  assert.deepEqual(skillDirs, ['keel-generate-spring', 'keel-spring-database']);
});

test('skill de base de datos: directorio completo con el dialecto del stack, solo con persistence', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace }); // persistence declarada, database default postgresql

  assert.ok(exists(workspace, '.claude/skills/keel-spring-database/SKILL.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-database/references/configuration.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-database/references/troubleshooting.md'));
  // Las references de dialecto viajan todas (el directorio se copia completo);
  // el CLAUDE.md remite a la skill desde el paso de persistence.
  assert.ok(exists(workspace, '.claude/skills/keel-spring-database/references/dialects/postgresql.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-database/references/dialects/h2.md'));
  const claude = read(workspace, '.claude/CLAUDE.md');
  assert.ok(claude.includes('.claude/skills/keel-spring-database/SKILL.md'));

  // Sin capa persistence no hay skill de BD.
  const bare = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const stripped = structuredClone(layers);
  delete stripped.persistence;
  const strippedManifest = structuredClone(manifest);
  delete strippedManifest.layers.persistence;
  scaffoldService({ manifest: strippedManifest, layers: stripped, workspace: bare });
  assert.ok(!fs.existsSync(path.join(bare, 'services', 'product-catalog-spring', '.claude', 'skills', 'keel-spring-database')));
});

test('agentes de la orquestación: copiados al .claude/agents/ del proyecto', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  for (const [name, marker] of [
    ['keel-spring-code', 'build -x test'],
    ['keel-spring-infra', 'infra/docker-compose.yaml'],
    ['keel-spring-validate', 'validation-scenarios.md'],
    ['keel-spring-quality', 'no-conductual']
  ]) {
    const agent = read(workspace, `.claude/agents/${name}.md`);
    assert.ok(agent.includes(`name: ${name}`));
    assert.ok(agent.includes(marker));
  }
});

test('skills por tecnología: solo las del stack elegido', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { broker: 'rabbitmq' } });

  assert.ok(exists(workspace, '.claude/skills/keel-spring-rabbitmq/SKILL.md'));
  assert.ok(!exists(workspace, '.claude/skills/keel-spring-kafka'));
  assert.ok(!exists(workspace, '.claude/skills/keel-spring-s3'));
  const rabbitSkill = read(workspace, '.claude/skills/keel-spring-rabbitmq/SKILL.md');
  assert.ok(rabbitSkill.includes('name: keel-spring-rabbitmq'));

  // La skill se instala como directorio completo: SKILL.md + references/.
  assert.ok(exists(workspace, '.claude/skills/keel-spring-rabbitmq/references/configuration.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-rabbitmq/references/implementation.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-rabbitmq/references/troubleshooting.md'));

  // Regeneración segura: un reference editado a mano no se pisa sin force.
  const refPath = path.join(workspace, 'services', 'product-catalog-spring', '.claude', 'skills', 'keel-spring-rabbitmq', 'references', 'configuration.md');
  fs.writeFileSync(refPath, 'editado');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { broker: 'rabbitmq' } });
  assert.equal(fs.readFileSync(refPath, 'utf8'), 'editado');

  const claude = read(workspace, '.claude/CLAUDE.md');
  assert.ok(claude.includes('messaging.keel.yaml'));
  assert.ok(claude.includes('.claude/skills/keel-spring-rabbitmq/SKILL.md'));
});

test('skill http-clients: gateada por presencia de capa, no por stack', () => {
  // Sin capa http-clients (fixture base) → la skill NO se instala.
  const bare = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace: bare });
  assert.ok(!exists(bare, '.claude/skills/keel-spring-httpclient'));

  // Con la capa declarada → build instala la skill completa (SKILL.md + references/).
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched['http-clients'] = {
    clients: {
      'pricing-service': {
        purpose: 'Precios vigentes de un tercero.',
        calls: { getPrice: { contract: 'GET /prices/{sku} → { amount }' } }
      }
    }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  assert.ok(exists(workspace, '.claude/skills/keel-spring-httpclient/SKILL.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-httpclient/references/configuration.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-httpclient/references/implementation.md'));
  assert.ok(exists(workspace, '.claude/skills/keel-spring-httpclient/references/troubleshooting.md'));
  const skill = read(workspace, '.claude/skills/keel-spring-httpclient/SKILL.md');
  assert.ok(skill.includes('name: keel-spring-httpclient'));
  // El SKILL.md del proyecto la lista como skill aplicable al servicio.
  const projectSkill = read(workspace, '.claude/skills/keel-generate-spring/SKILL.md');
  assert.ok(projectSkill.includes('keel-spring-httpclient'));
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
  // La metadata la estampa el agregado al emitir: vive en dominio, no en infra.
  const metadata = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/EventMetadata.java');
  assert.ok(metadata.includes('"product-catalog"')); // source = nombre del servicio
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/EventMetadata.java'));
  // La config del broker ya no es determinista: la escribe el agente.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/broker/RabbitMqConfig.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisher.java'));

  const compose = read(workspace, 'infra/docker-compose.yaml');
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

  const compose = read(workspace, 'infra/docker-compose.yaml');
  assert.ok(compose.includes('product-catalog-devtools')); // container_name determinista
  assert.ok(compose.includes('Dockerfile.devtools'));
  assert.ok(compose.includes('kafka:29092')); // listener interno para clientes en red

  const dockerfile = read(workspace, 'infra/docker/Dockerfile.devtools');
  assert.ok(dockerfile.includes('FROM alpine:3.20'));
  assert.ok(dockerfile.includes('postgresql-client')); // BD por defecto
  assert.ok(dockerfile.includes('kcat')); // broker kafka
  assert.ok(!dockerfile.includes('mysql-client')); // solo las CLIs del stack elegido

  const script = read(workspace, 'infra/validate-infra.sh');
  assert.ok(script.startsWith('#!/usr/bin/env bash'));
  assert.ok(script.includes('psql -h db')); // check de la BD
  assert.ok(script.includes('kcat -b kafka:29092')); // check del broker
  assert.ok(script.includes('product-catalog-devtools')); // ejecuta vía docker exec en devtools

  // Reset de datos entre flujos: vacía las tablas preservando el esquema.
  const reset = read(workspace, 'infra/reset-db.sh');
  assert.ok(reset.startsWith('#!/usr/bin/env bash'));
  assert.ok(reset.includes('TRUNCATE TABLE')); // reset de PostgreSQL (default)
  assert.ok(reset.includes('CONTAINER_RUNTIME')); // respeta docker/podman
  assert.ok(reset.includes('product-catalog-devtools')); // psql vive en devtools
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
  assert.ok(!copied.includes('infra/docker-compose.yaml'));
  assert.ok(!copied.some((f) => f.includes('Dockerfile.devtools')));
  assert.ok(!copied.includes('infra/validate-infra.sh'));
  assert.ok(!copied.includes('infra/reset-db.sh')); // h2: reiniciar la app basta

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

  const compose = read(workspace, 'infra/docker-compose.yaml');
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
  // upload devuelve StoredObject: sin él el agregado no tiene qué persistir.
  assert.ok(port.includes('StoredObject upload(String key, byte[] content, String contentType);'));
  assert.ok(port.includes('String signedUrl(String key);'));
  assert.ok(!port.includes('org.springframework')); // puerto puro de dominio

  const storedObject = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/storage/StoredObject.java');
  assert.ok(storedObject.includes('public record StoredObject(String storageKey, URI url, String contentType, Long sizeBytes)'));

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
  const compose = read(workspace, 'infra/docker-compose.yaml'); // existe por la BD del fixture
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
  assert.ok(exists(workspace, '.claude/skills/keel-spring-keycloak/SKILL.md')); // skill del auth elegido

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

  // La clave sale configurada: en local con valor real (si va vacía, el filtro
  // rechaza todo y los escenarios de validación no pueden pasar).
  assert.ok(read(workspace, 'src/main/resources/parameters/local/security.yaml').includes('api-key: local-dev-api-key'));
  assert.ok(read(workspace, 'src/main/resources/parameters/production/security.yaml').includes('api-key: ${SECURITY_API_KEY}'));
  assert.ok(read(workspace, 'src/main/resources/application-local.yaml').includes('classpath:parameters/local/security.yaml'));

  // api-key no usa resource server JWT ni el fragmento oauth2.
  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('spring-boot-starter-security'));
  assert.ok(!buildGradle.includes('oauth2-resource-server'));
  assert.ok(!copied.some((f) => f.includes('oauth2.yaml')));
  assert.ok(!copied.some((f) => f.includes('JwtAuthConverter')));
});

test('capa security (clientes máquina por api-key): clave local usable y env var obligatoria fuera', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc', serviceAuth: { protocol: 'api-key' } },
    serviceClients: { 'billing-worker': { description: 'Concilia precios', scopes: ['product:read'] } },
    access: { default: { level: 'required' } }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { auth: 'keycloak' } });

  // En local, clave real (vacía = cliente deshabilitado en ServiceApiKeyAuthFilter).
  const localSecurity = read(workspace, 'src/main/resources/parameters/local/security.yaml');
  assert.ok(localSecurity.includes('billing-worker: local-billing-worker-key'));
  const developSecurity = read(workspace, 'src/main/resources/parameters/develop/security.yaml');
  assert.ok(developSecurity.includes('billing-worker: ${API_KEY_BILLING_WORKER}')); // sin default: fail-closed
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
  const portDir = 'src/main/java/com/commerce/productcatalog/domain/clients';
  const config = read(workspace, `${httpDir}/PricingServiceClientConfig.java`);
  assert.ok(config.includes('public RestClient pricingServiceRestClient'));
  assert.ok(config.includes('.withReadTimeout(Duration.ofMillis(2000))'));

  // Puerto hexagonal en domain/clients con retorno en términos del dominio.
  const port = read(workspace, `${portDir}/PricingServiceClient.java`);
  assert.ok(port.includes('public interface PricingServiceClient'));
  assert.ok(port.includes('GetPriceResult getPrice(String sku);')); // path var parseada de la prosa
  const result = read(workspace, `${portDir}/GetPriceResult.java`);
  assert.ok(result.includes('public record GetPriceResult()')); // solo-prosa: vacío + TODO
  assert.ok(result.includes('TODO (agente)'));

  const adapter = read(workspace, `${httpDir}/PricingServiceHttpAdapter.java`);
  assert.ok(adapter.includes('implements PricingServiceClient'));
  assert.ok(adapter.includes('@Retry(name = "pricing-service-get-price")'));
  assert.ok(adapter.includes('@CircuitBreaker(name = "pricing-service-get-price", fallbackMethod = "getPriceFallback")'));
  assert.ok(adapter.includes('.uri("/prices/{sku}", sku)')); // llamada funcional armada del contract
  assert.ok(adapter.includes('return mapper.toGetPriceResult(response);'));
  assert.ok(adapter.includes('private GetPriceResult getPriceFallback(String sku, Throwable throwable)'));
  assert.ok(adapter.includes('// TODO (agente): Devolver el último precio conocido en caché.')); // fallback = stub de negocio

  // ACL: mapper stub (solo-prosa) + wire DTO vacío en infrastructure/http.
  const mapper = read(workspace, `${httpDir}/PricingServiceMapper.java`);
  assert.ok(mapper.includes('public GetPriceResult toGetPriceResult(GetPriceResponse response)'));
  assert.ok(mapper.includes('TODO (agente)'));
  const wire = read(workspace, `${httpDir}/GetPriceResponse.java`);
  assert.ok(wire.includes('public record GetPriceResponse()'));

  // resilience4j en gradle + fragmento de config con instancias derivadas del diseño.
  assert.ok(read(workspace, 'build.gradle').includes('resilience4j-spring-boot3'));
  const hc = read(workspace, 'src/main/resources/parameters/local/http-clients.yaml');
  assert.ok(hc.includes('base-url: http://localhost:8081')); // literal solo en local
  assert.ok(hc.includes('max-attempts: 3'));
  assert.ok(hc.includes('- org.springframework.web.client.HttpClientErrorException')); // 4xx nunca se reintenta
  assert.ok(hc.includes('failure-rate-threshold: 50'));
  // Sin auth declarada: ni credenciales ni starter oauth2-client.
  assert.ok(!hc.includes('auth:'));
  assert.ok(!read(workspace, 'build.gradle').includes('oauth2-client'));
});

test('capa http-clients estructurada: records tipados, mapper ACL completo y auth saliente', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';
  const patched = structuredClone(layers);
  patched['http-clients'] = {
    clients: {
      'pricing-service': {
        purpose: 'Obtener el precio vigente de un producto.',
        auth: { type: 'api-key', headerName: 'X-Api-Key' },
        calls: {
          getPrice: {
            contract: 'Precio vigente de un SKU con su moneda.',
            method: 'GET',
            path: '/prices/{sku}',
            request: {
              pathParams: { sku: { type: 'uuid', required: true } },
              queryParams: { currency: { type: 'string' } }
            },
            response: { fields: { amount: { type: 'decimal', required: true }, currency: { type: 'string' } } },
            timeoutMs: 2000
          }
        }
      },
      'payment-gateway': {
        purpose: 'Cobros con tarjeta.',
        auth: { type: 'oauth2-client-credentials', tokenUrl: 'https://auth.example.com/token', scopes: ['payments:write'] },
        calls: {
          charge: {
            contract: 'Autoriza el cobro de un pedido.',
            method: 'POST',
            path: '/charges',
            request: { body: { orderId: { type: 'uuid', required: true }, amount: { type: 'decimal', required: true } } },
            response: { fields: { status: { type: 'string', required: true } } }
          }
        }
      }
    }
  };

  const { warnings } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace });
  assert.deepEqual(warnings, []);

  const httpDir = 'src/main/java/com/commerce/productcatalog/infrastructure/http';
  const portDir = 'src/main/java/com/commerce/productcatalog/domain/clients';

  // Puerto y result tipados en el dominio.
  const port = read(workspace, `${portDir}/PricingServiceClient.java`);
  assert.ok(port.includes('GetPriceResult getPrice(UUID sku, String currency);'));
  const result = read(workspace, `${portDir}/GetPriceResult.java`);
  assert.ok(result.includes('public record GetPriceResult(BigDecimal amount, String currency)'));
  assert.ok(!result.includes('TODO'));

  // Wire DTOs con el contrato del tercero + mapper ACL completo (sin TODO).
  const wire = read(workspace, `${httpDir}/GetPriceResponse.java`);
  assert.ok(wire.includes('public record GetPriceResponse(BigDecimal amount, String currency)'));
  const mapper = read(workspace, `${httpDir}/PricingServiceMapper.java`);
  assert.ok(mapper.includes('return new GetPriceResult(response.amount(), response.currency());'));
  assert.ok(!mapper.includes('TODO'));

  // Adaptador con uriBuilder (query params tipados) y sin TODO de tipado.
  const adapter = read(workspace, `${httpDir}/PricingServiceHttpAdapter.java`);
  assert.ok(adapter.includes('.uri(uri -> uri.path("/prices/{sku}").queryParam("currency", currency).build(sku))'));
  assert.ok(!adapter.includes('TODO'));

  // Body tipado: wire request + toWire en el mapper + puerto con campos del body.
  const chargePort = read(workspace, `${portDir}/PaymentGatewayClient.java`);
  assert.ok(chargePort.includes('ChargeResult charge(UUID orderId, BigDecimal amount);'));
  const chargeAdapter = read(workspace, `${httpDir}/PaymentGatewayHttpAdapter.java`);
  assert.ok(chargeAdapter.includes('.body(mapper.toChargeRequest(orderId, amount))'));
  assert.ok(read(workspace, `${httpDir}/ChargeRequest.java`).includes('public record ChargeRequest(UUID orderId, BigDecimal amount)'));

  // Auth api-key: header en el bean + credencial por properties (default vacío).
  const config = read(workspace, `${httpDir}/PricingServiceClientConfig.java`);
  assert.ok(config.includes('@Value("${http-clients.pricing-service.auth.api-key:}") String apiKey'));
  assert.ok(config.includes('.defaultHeader("X-Api-Key", apiKey)'));

  // Auth oauth2-client-credentials: interceptor + manager compartido + starter.
  const oauthConfig = read(workspace, `${httpDir}/PaymentGatewayClientConfig.java`);
  assert.ok(oauthConfig.includes('OAuth2ClientHttpRequestInterceptor'));
  assert.ok(oauthConfig.includes('oauth2.setClientRegistrationIdResolver(request -> "payment-gateway");'));
  const shared = read(workspace, `${httpDir}/HttpClientsOAuth2Config.java`);
  assert.ok(shared.includes('AuthorizedClientServiceOAuth2AuthorizedClientManager'));
  assert.ok(shared.includes('.clientCredentials()'));
  assert.ok(read(workspace, 'build.gradle').includes('spring-boot-starter-oauth2-client'));

  // Properties: credenciales por env var + registration oauth2 estándar.
  const hc = read(workspace, 'src/main/resources/parameters/local/http-clients.yaml');
  assert.ok(hc.includes('api-key: changeme'));
  assert.ok(hc.includes('authorization-grant-type: client_credentials'));
  assert.ok(hc.includes('scope: payments:write'));
  assert.ok(hc.includes('token-uri: https://auth.example.com/token'));
  const hcDevelop = read(workspace, 'src/main/resources/parameters/develop/http-clients.yaml');
  assert.ok(hcDevelop.includes('api-key: ${PRICING_SERVICE_API_KEY:changeme}'));
  assert.ok(hcDevelop.includes('client-id: ${PAYMENT_GATEWAY_CLIENT_ID:changeme}'));
  // base-url no la declara el diseño: obligatoria fuera de local, sin default que
  // haga que el servicio se llame a sí mismo.
  assert.ok(hcDevelop.includes('base-url: ${PRICING_SERVICE_BASE_URL}'));

  // Perfil test: registration dummy para levantar el contexto sin proveedor real.
  const hcTest = read(workspace, 'src/main/resources/parameters/test/http-clients.yaml');
  assert.ok(hcTest.includes('client-id: test'));
  assert.ok(hcTest.includes('token-uri: http://localhost/token'));
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
  // El record documenta quién lo consumirá y qué mensaje CQRS despacha.
  assert.ok(message.includes('StockDepletedListener'));
  assert.ok(message.includes('RetireProductCommand'));
  // Sin contract y con canal propio, se asume la envoltura estándar de Keel.
  assert.ok(message.includes('EventEnvelope estándar de Keel'));
  assert.ok(message.includes('@JsonIgnoreProperties(ignoreUnknown = true)'));

  // El listener depende del broker: lo escribe el agente, no build.
  assert.ok(!exists(workspace, `${subsDir}/StockDepletedListener.java`));
  // Broker por defecto (kafka): spring-kafka en gradle para el código del agente.
  assert.ok(read(workspace, 'build.gradle').includes('spring-kafka'));
});

test('suscripción con contract: envoltura de la fuente, alias de campo y contrato en el javadoc', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  const patched = structuredClone(layers);
  patched.messaging = {
    channels: { inventoryEvents: { external: true } },
    subscriptions: {
      StockDepleted: {
        source: 'inventory-service',
        channel: 'inventoryEvents',
        contract: {
          envelope: 'wrapped',
          payloadPath: 'data',
          discriminator: { location: 'header', name: 'eventType', value: 'stock.depleted' },
          messageId: { location: 'field', name: 'messageId' },
          unknownFields: 'fail'
        },
        payload: { productId: { type: 'uuid', required: true, wireName: 'product_id' } },
        triggers: 'retireProduct',
        input: { id: 'productId' }
      }
    }
  };

  const { warnings } = scaffoldService({ manifest: patchedManifest, layers: patched, workspace });
  assert.deepEqual(warnings, []);

  const subsDir = 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/subscriptions';
  const message = read(workspace, `${subsDir}/StockDepletedMessage.java`);
  // El nombre real del cable viaja en @JsonProperty; el del DSL queda en el record.
  assert.ok(message.includes('@JsonProperty("product_id") UUID productId'));
  // unknownFields: fail → no se ignoran campos desconocidos.
  assert.ok(!message.includes('ignoreUnknown'));
  assert.ok(message.includes("payload cuelga de 'data'"));
  assert.ok(message.includes("Se reconoce por header 'eventType' == 'stock.depleted'"));
  assert.ok(message.includes("Deduplica por field 'messageId'"));
  assert.ok(message.includes('RetireProductCommand(id = payload.productId())'));

  // La envoltura es la de la fuente, no la EventEnvelope de Keel.
  const envelope = read(workspace, `${subsDir}/StockDepletedEnvelope.java`);
  assert.ok(envelope.includes('public record StockDepletedEnvelope(StockDepletedMessage data, String messageId)'));
});

// Diseño con un evento emitido por una operación, para los tests del patrón
// de eventos: el agregado lo acumula y el bridge lo traduce a integración.
function withEvent(layers, manifest, reliability) {
  const patched = structuredClone(layers);
  patched.messaging = {
    publishing: { reliability, events: { ProductCreated: { payload: { entity: 'Product' } } } }
  };
  patched['use-cases'].operations.createProduct.emits = ['ProductCreated'];
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  return { patched, patchedManifest };
}

test('best-effort: agregado acumula, adaptador drena y el bridge publica tras commit', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'best-effort');

  const { stack } = scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgres', broker: 'snssqs', auth: null, cache: null, storage: null }
  });
  assert.equal(stack.broker, 'snssqs');

  // El evento nace en el agregado: buffer + raise + pull, sin nada de Spring.
  const aggregate = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/aggregate/Product.java');
  assert.ok(aggregate.includes('private final List<DomainEvent> domainEvents'));
  assert.ok(aggregate.includes('public List<DomainEvent> pullDomainEvents()'));
  assert.ok(aggregate.includes('raise(ProductCreatedEvent.of('));
  assert.ok(!aggregate.includes('org.springframework'));

  // El adaptador drena dentro de la transacción del cambio.
  const adapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/ProductRepositoryImpl.java');
  assert.ok(adapter.includes('private final ApplicationEventPublisher eventPublisher;'));
  assert.ok(adapter.includes('@Transactional\n    public Product save(Product entity)'));
  assert.ok(adapter.includes('entity.pullDomainEvents().forEach(eventPublisher::publishEvent);'));

  // El handler ya NO publica: no inyecta ningún publisher.
  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java');
  assert.ok(!handler.includes('Publisher'));
  assert.ok(handler.includes('raise(ProductCreatedEvent.of(...))'));

  // El bridge traduce a integración y entrega tras confirmar la transacción.
  const bridge = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCatalogDomainEventBridge.java');
  assert.ok(bridge.includes('@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)'));
  assert.ok(bridge.includes('new ProductCreatedIntegrationEvent(event.metadata()'));
  assert.ok(bridge.includes('productCreatedPublisher.publish(integrationEvent, correlationId);'));
  for (const ajeno of ['SnsTemplate', 'KafkaTemplate', 'RabbitTemplate']) {
    assert.ok(!bridge.includes(ajeno));
  }

  // El evento de integración es el gemelo de wire, no el de dominio.
  const integration = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/events/ProductCreatedIntegrationEvent.java');
  assert.ok(integration.includes('public record ProductCreatedIntegrationEvent(EventMetadata metadata'));

  // El puerto de publicación recibe el evento de INTEGRACIÓN; su stub no rompe el arranque.
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java');
  assert.ok(port.includes('void publish(ProductCreatedIntegrationEvent event, String correlationId);'));
  const stub = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java');
  assert.ok(stub.includes('implements ProductCreatedPublisher'));
  assert.ok(!stub.includes('throw new'));

  // Sin outbox no hay tabla ni relay, y el enrutado sale a parameters/.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/outbox/OutboxRelay.java'));
  assert.ok(read(workspace, 'src/main/resources/parameters/local/messaging.yaml').includes('product-created: product-catalog.product-created'));
  // Las deps del broker elegido sí van en gradle (las usa el código del agente).
  assert.ok(read(workspace, 'build.gradle').includes('spring-cloud-aws-starter-sns'));
});

test('outbox: fila en la misma transacción, relay determinista y envío tras el puerto', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'outbox');

  scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgres', broker: 'rabbitmq', auth: null, cache: null, storage: null }
  });

  const outboxDir = 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/outbox';
  // El bridge escribe la fila DENTRO de la transacción (listener síncrono).
  const bridge = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCatalogDomainEventBridge.java');
  assert.ok(bridge.includes('@EventListener'));
  assert.ok(!bridge.includes('@TransactionalEventListener'));
  assert.ok(bridge.includes('append(productCreatedRoutingKey, "ProductCreatedIntegrationEvent", envelope);'));

  const entity = read(workspace, `${outboxDir}/OutboxEventJpa.java`);
  assert.ok(entity.includes('@Table(name = "outbox_event"'));

  // El relay es determinista; lo acoplado al broker sale por el puerto.
  const relay = read(workspace, `${outboxDir}/OutboxRelay.java`);
  assert.ok(relay.includes('@Scheduled(fixedDelayString = "${outbox.relay.fixed-delay-ms:1000}")'));
  assert.ok(relay.includes('dispatcher.dispatch(row.getDestination()'));
  for (const ajeno of ['SnsTemplate', 'KafkaTemplate', 'RabbitTemplate']) {
    assert.ok(!relay.includes(ajeno));
  }
  assert.ok(read(workspace, `${outboxDir}/OutboxDispatcher.java`).includes('void dispatch(String destination'));
  assert.ok(read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/OutboxDispatcherStub.java').includes('implements OutboxDispatcher'));

  // Con outbox la entrega NO pasa por publishers: no se generan puerto ni stub.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java'));

  // El relay es @Scheduled: sin @EnableScheduling no saldría nada.
  assert.ok(read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java').includes('@EnableScheduling'));
  assert.ok(read(workspace, 'src/main/resources/parameters/local/messaging.yaml').includes('retention-days: 7'));
});

test('frontera hexagonal: application no importa los eventos de Spring', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'outbox');

  scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgres', broker: 'rabbitmq', auth: null, cache: null, storage: null }
  });

  const appDir = path.join(workspace, 'services', 'product-catalog-spring', 'src/main/java/com/commerce/productcatalog/application');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(appDir)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('org.springframework.context.event'), file);
  }
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
  assert.ok(product.includes('private void transitionTo(ProductStatus target)')); // el guard se mantiene
  assert.ok(!copied.some((file) => file.includes('ProductJpa'))); // sin persistence no hay lado JPA

  assert.ok(!copied.some((file) => file.includes('ProductRepository')));
  // Sin persistence no hay fragmento H2, pero el perfil test sigue existiendo.
  assert.ok(!copied.some((file) => file.includes('parameters/test/db.yaml')));
  assert.ok(read(workspace, 'src/test/resources/application.yaml').includes('active: test'));

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(!buildGradle.includes('data-jpa'));

  // Sin persistence/messaging/cache no hay contenedores → sin compose.
  assert.ok(!copied.includes('infra/docker-compose.yaml'));

  const money = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/valueobject/Money.java');
  assert.ok(money.includes('public record Money('));

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java');
  assert.ok(!handler.includes('@Transactional'));
  assert.ok(!handler.includes('ProductRepository'));

  // Sin persistence el mediator no abre transacciones.
  const mediatorFile = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/usecase/UseCaseMediator.java');
  assert.ok(!mediatorFile.includes('TransactionTemplate'));
});

test('persistencia: relación interna con @JoinColumn (FK en la hija, sin join table)', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.domain.entities.Order = {
    description: 'Pedido del catálogo.',
    fields: { id: { type: 'uuid', id: true, generated: true } },
    relations: { lines: { entity: 'OrderLine', cardinality: 'one-to-many', required: true } }
  };
  patched.domain.entities.OrderLine = {
    description: 'Línea de un pedido.',
    fields: { id: { type: 'uuid', id: true, generated: true }, quantity: { type: 'int', required: true } }
  };
  patched.domain.aggregates = { Order: { root: 'Order', entities: ['OrderLine'] } };

  const { warnings } = scaffoldService({ manifest, layers: patched, workspace });
  assert.deepEqual(warnings, []);

  const orderJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/OrderJpa.java');
  assert.ok(orderJpa.includes('@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)'));
  assert.ok(orderJpa.includes('@JoinColumn(name = "order_id")')); // FK en la tabla hija
  assert.ok(orderJpa.includes('import jakarta.persistence.JoinColumn;'));
  assert.ok(orderJpa.includes('private List<OrderLineJpa> lines = new ArrayList<>();'));

  // La raíz de dominio expone la colección como vista inmutable, pero la guarda mutable
  // (copia defensiva) para que sus métodos de negocio puedan dar de alta/baja hijas.
  const order = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/aggregate/Order.java');
  assert.ok(order.includes('return List.copyOf(lines);'));
  assert.ok(order.includes('this.lines = new ArrayList<>(lines);'));

  // El adaptador mapea la colección interna en ambos sentidos.
  const adapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/OrderRepositoryImpl.java');
  assert.ok(adapter.includes('jpa.getLines().stream().map(this::toDomain).toList()'));
  assert.ok(adapter.includes('jpa.setLines(new ArrayList<>(domain.getLines().stream().map(this::toJpa).toList()));'));
});

test('persistencia: value object anidado deja TODO en vez de columna/mapa inválidos', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.domain.types.GeoPoint = {
    description: 'Coordenada geográfica.',
    fields: { lat: { type: 'decimal' }, lng: { type: 'decimal' } }
  };
  patched.domain.types.Address = {
    description: 'Dirección postal con geolocalización.',
    fields: { street: { type: 'string' }, geo: { type: 'GeoPoint' } }
  };
  patched.domain.entities.Product.fields.origin = { type: 'Address' };

  scaffoldService({ manifest, layers: patched, workspace });

  const productJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/ProductJpa.java');
  assert.ok(productJpa.includes('@Column(name = "origin_street")')); // sub escalar sí se aplana
  assert.ok(productJpa.includes('// TODO (agente): Address.geo es un value object anidado')); // sub compuesto no

  const adapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/ProductRepositoryImpl.java');
  assert.ok(adapter.includes('null /* TODO (agente): reconstruir Address')); // toDomain no inventa getters
  assert.ok(adapter.includes('// TODO (agente): mapear Address.geo (value object anidado).')); // toJpa
});

test('persistencia: timestamps de auditoría declarados se auto-pueblan (no se pierden)', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.domain.entities.Ledger = {
    description: 'Registro contable con auditoría propia.',
    fields: {
      id: { type: 'uuid', id: true, generated: true },
      createdAt: { type: 'timestamp' },
      updatedAt: { type: 'timestamp' }
    }
  };

  scaffoldService({ manifest, layers: patched, workspace });

  const ledgerJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/LedgerJpa.java');
  assert.ok(!ledgerJpa.includes('extends AuditableEntity')); // no hereda (evita campos duplicados)
  assert.ok(ledgerJpa.includes('@EntityListeners(AuditingEntityListener.class)'));
  assert.ok(ledgerJpa.includes('@CreatedDate'));
  assert.ok(ledgerJpa.includes('@LastModifiedDate'));
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

test('correlación: contexto + filtro HTTP, y el bridge la lee de ahí (no de un MDC vacío)', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'best-effort');

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const contextPath = 'src/main/java/com/commerce/productcatalog/infrastructure/correlation/CorrelationContext.java';
  const context = read(workspace, contextPath);
  assert.ok(context.includes('public static void runWith(String correlationId, Runnable action)'));
  assert.ok(context.includes('MDC.put(MDC_KEY, correlationId);'));

  const filter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/web/CorrelationFilter.java');
  assert.ok(filter.includes('extends OncePerRequestFilter'));
  assert.ok(filter.includes('public static final String HEADER = "X-Correlation-Id";'));
  assert.ok(filter.includes('CorrelationContext.clear();')); // siempre en finally

  // El bridge toma la correlación del contexto: leer el MDC a pelo daba null
  // porque nadie lo poblaba.
  const bridge = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCatalogDomainEventBridge.java');
  assert.ok(bridge.includes('String correlationId = CorrelationContext.get();'));
  assert.ok(!bridge.includes('MDC.get('));

  // Y sale a cada línea de log por el patrón de correlación de Spring Boot.
  assert.ok(read(workspace, 'src/main/resources/parameters/local/logging.yaml').includes('correlation: "[%X{correlationId:-}] "'));
});

test('correlación sin capa api: contexto sí, filtro HTTP no', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'best-effort');
  delete patched.api;
  delete patchedManifest.layers.api;

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  assert.ok(exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/correlation/CorrelationContext.java'));
  // Sin entrada HTTP el filtro no tiene qué interceptar.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/web/CorrelationFilter.java'));
});

test('idempotencia de consumo: registro de procesados transversal al broker', () => {
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
        triggers: 'retireProduct'
      }
    }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const dir = 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/idempotency';
  const entity = read(workspace, `${dir}/ProcessedEventJpa.java`);
  assert.ok(entity.includes('@Table(name = "processed_event")'));
  assert.ok(entity.includes('@EmbeddedId'));

  const guard = read(workspace, `${dir}/IdempotencyGuard.java`);
  assert.ok(guard.includes('@Transactional(propagation = Propagation.REQUIRES_NEW)'));
  assert.ok(guard.includes('public boolean tryRecord(String handlerId, String eventId)'));
  // La carrera la arbitra la clave primaria, no el existsById previo.
  assert.ok(guard.includes('catch (DataIntegrityViolationException duplicate)'));
  // Nada del broker concreto: quien llama al guard es el listener del agente.
  for (const ajeno of ['SnsTemplate', 'KafkaTemplate', 'RabbitTemplate']) {
    assert.ok(!guard.includes(ajeno));
  }

  assert.ok(read(workspace, `${dir}/ProcessedEventJpaRepository.java`).includes('deleteProcessedBefore'));
  // La purga es @Scheduled y su retención sale de parameters/, no del código.
  assert.ok(read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java').includes('@EnableScheduling'));
  assert.ok(read(workspace, 'src/main/resources/parameters/local/messaging.yaml').includes('retention-days: 14'));
});

test('sin suscripciones no se genera el registro de idempotencia', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'outbox');

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  assert.ok(
    !exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/idempotency/IdempotencyGuard.java')
  );
});

test('unique: constraint nombrada en la tabla y traducida al error de negocio', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.domain.entities.Product.fields.slug = { type: 'string', required: true, unique: true };

  scaffoldService({ manifest, layers: patched, workspace });

  // La unicidad la garantiza la BD; la comprobación previa del handler solo
  // produce el error bonito en el caso sin carrera.
  const productJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/ProductJpa.java');
  assert.ok(productJpa.includes('@UniqueConstraint(name = "uk_products_slug", columnNames = { "slug" })'));
  // sku es la clave natural: ya tiene su constraint, no se duplica.
  assert.ok(productJpa.includes('uk_products_natural'));
  assert.ok(!productJpa.includes('uk_products_sku'));

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(handler.includes('CONSTRAINT_TO_ERROR'));
  assert.ok(handler.includes('Map.entry("uk_products_slug"'));
  assert.ok(handler.includes('"PRODUCT_SLUG_ALREADY_EXISTS"'));
  // El diseño no liga campo → code: la asociación exacta la cierra el agente.
  assert.ok(handler.includes('TODO (agente)'));
});

test('colecciones del dominio (DSL 2.1 list): @ElementCollection, @Embeddable y mapeo bidireccional', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  // Escalar, enum nominal y value object compuesto, todos como colección.
  patched.domain.types.Discount = {
    fields: { code: { type: 'string', required: true }, percentage: { type: 'decimal' } }
  };
  patched.domain.entities.Product.fields.tags = { type: 'string', list: true, constraints: { maxItems: 20 } };
  patched.domain.entities.Product.fields.channels = { type: 'ProductStatus', list: true };
  patched.domain.entities.Product.fields.discounts = { type: 'Discount', list: true };

  scaffoldService({ manifest, layers: patched, workspace });

  const base = 'src/main/java/com/commerce/productcatalog';

  // Dominio: colección mutable interna, getter inmutable, copia defensiva en la rehidratación.
  const product = read(workspace, `${base}/domain/aggregate/Product.java`);
  assert.ok(product.includes('private List<Discount> discounts = new ArrayList<>();'));
  assert.ok(product.includes('this.discounts = new ArrayList<>(discounts);'));
  assert.ok(product.includes('return List.copyOf(discounts);'));

  // Jpa: @ElementCollection + @CollectionTable por campo; enum con @Enumerated; VO como XxxJpa.
  const productJpa = read(workspace, `${base}/infrastructure/persistence/entities/ProductJpa.java`);
  assert.ok(productJpa.includes('@CollectionTable(name = "product_tags", joinColumns = @JoinColumn(name = "product_id"))'));
  assert.ok(productJpa.includes('@CollectionTable(name = "product_channels"'));
  assert.ok(productJpa.includes('@Enumerated(EnumType.STRING)'));
  assert.ok(productJpa.includes('private List<DiscountJpa> discounts = new ArrayList<>();'));

  // Embeddable del VO en el mismo paquete que las entidades Jpa.
  const discountJpa = read(workspace, `${base}/infrastructure/persistence/entities/DiscountJpa.java`);
  assert.ok(discountJpa.includes('@Embeddable'));
  assert.ok(discountJpa.includes('public class DiscountJpa'));
  assert.ok(discountJpa.includes('@Column(name = "code")'));

  // Adaptador: reconstrucción del VO en ambos sentidos, con import del embeddable.
  const repo = read(workspace, `${base}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`);
  assert.ok(repo.includes('.entities.DiscountJpa;'));
  assert.ok(repo.includes('.map(e -> new Discount(e.getCode(), e.getPercentage())).toList()'));
  assert.ok(repo.includes('new ArrayList<DiscountJpa>('));
});
