import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { HARNESSES, loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { hasScheduledOperations } from '../src/scaffold/services.js';
import { generate as applicationFiles } from '../src/scaffold/application.js';
import { assetsDir, wrapperDir, GRADLE_VERSION } from '../src/lib/assets.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');

function loadFixture() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  return { manifest, layers };
}

function makeWorkspace() {
  return tmpDir('keel-scaffold-');
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
  assert.ok(buildGradle.includes('spring-boot-starter-actuator'));
  assert.ok(!buildGradle.includes('spring-kafka')); // sin capa messaging

  // Actuator: fragmento management con probes de liveness/readiness (Kubernetes).
  const management = read(workspace, 'src/main/resources/parameters/local/management.yaml');
  assert.ok(management.includes('include: health,info,metrics'));
  assert.ok(management.includes('probes:'));
  assert.ok(management.includes('enabled: true'));
  assert.ok(read(workspace, 'src/main/resources/application-local.yaml').includes('parameters/local/management.yaml'));

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
  // El TODO de una transición que el diseño atribuye a una operación (use-cases.transitions)
  // la nombra: sin destinatario, el camino corto es mutar el estado fuera del agregado.
  assert.ok(product.includes('método semántico ACTIVE → RETIRED (lo ejecuta retireProduct)'), product);
  // Y la que ninguna operación declara se queda sin atribución, en vez de inventarla.
  assert.ok(product.includes('método semántico DRAFT → ACTIVE que valide'), product);
  // Concurrencia optimista (Opción A): la raíz porta lockVersion, que viaja por el
  // constructor de rehidratación (último parámetro) y expone getter.
  assert.ok(product.includes('private Long lockVersion;'));
  assert.ok(product.includes(', Long lockVersion) {'));
  assert.ok(product.includes('this.lockVersion = lockVersion;'));
  assert.ok(product.includes('public Long getLockVersion() {'));

  const productJpa = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities/ProductJpa.java');
  assert.ok(productJpa.includes('@Entity'));
  assert.ok(productJpa.includes('@Table(name = "products"'));
  assert.ok(productJpa.includes('public class ProductJpa extends AuditableEntity'));
  // Bloqueo optimista a nivel de raíz de agregado.
  assert.ok(productJpa.includes('@Version'));
  assert.ok(productJpa.includes('@Column(name = "lock_version")'));
  assert.ok(productJpa.includes('private Long lockVersion;'));

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
  // Creación con id en la salida: 201 + Location, derivados del diseño.
  assert.ok(controller.includes('CreateProductResponseDto response = mediator.dispatch(command);'));
  assert.ok(controller.includes('ResponseEntity.created('));

  // Manejo centralizado de errores: jerarquía DomainException + validación + catch-all.
  const advice = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(advice.includes('@ExceptionHandler(MethodArgumentNotValidException.class)'));
  assert.ok(advice.includes('@ExceptionHandler(DomainException.class)'));
  assert.ok(advice.includes('@ExceptionHandler(Exception.class)'));
  assert.ok(advice.includes('"VALIDATION_ERROR"'));
  // Parámetro de query obligatorio ausente: Spring lo rechaza ANTES de Bean
  // Validation, así que sin su handler cae en el catch-all y sale 500 por un 400.
  assert.ok(advice.includes('@ExceptionHandler(MissingServletRequestParameterException.class)'));
  assert.ok(advice.includes('org.springframework.web.bind.MissingServletRequestParameterException'));
  // Conflicto de concurrencia optimista → 409 (no cae en el catch-all 500).
  assert.ok(advice.includes('@ExceptionHandler(ObjectOptimisticLockingFailureException.class)'));
  // Con el code canónico del catálogo de keel-core, no con uno propio del scaffolding.
  assert.ok(advice.includes('"CONCURRENT_MODIFICATION"'));

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
  // El cuarto camino: sin transacción, para el barrido de una reconciliación. Las DOS
  // sobrecargas, porque un barrido con `output` es un ReturningCommand y sin la segunda
  // el `main` no compilaría — un fallo que ningún includes() de este archivo vería.
  assert.ok(mediatorFile.includes('public <C extends Command> void dispatchWithoutTransaction(C command)'));
  assert.ok(
    mediatorFile.includes('public <R, C extends ReturningCommand<R>> R dispatchWithoutTransaction(C command)')
  );
  // Y no abren transacción: si tocaran writeTransaction serían dispatch con otro nombre.
  // Se corta desde la PRIMERA declaración (no desde la primera mención, que está en el
  // javadoc de clase, antes de que se declaren los TransactionTemplate).
  const withoutTx = mediatorFile.slice(
    mediatorFile.indexOf('public <C extends Command> void dispatchWithoutTransaction')
  );
  assert.ok(!withoutTx.includes('writeTransaction'), withoutTx);
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
  // El adaptador se basta solo. Bajo el mediator es un no-op (REQUIRED se une a la
  // transacción existente e ignora el readOnly); importa en el único camino que no trae
  // transacción, el barrido de una reconciliación, donde sin esto una consulta que
  // devuelva un agregado con colecciones LAZY revienta con LazyInitializationException.
  assert.ok(adapter.includes('@Transactional(readOnly = true)\npublic class ProductRepositoryImpl'), adapter);
  assert.ok(adapter.includes('import org.springframework.transaction.annotation.Transactional;'));
  // Y por eso mismo TODA escritura lleva su @Transactional de método: sin él heredaría
  // el readOnly de la clase. Antes solo lo llevaba save() y solo cuando drenaba eventos.
  assert.ok(adapter.includes('@Transactional\n    public Product save(Product entity)'), adapter);
  assert.ok(adapter.includes('@Transactional\n    public void deleteById(UUID id)'), adapter);
  // El volcado dominio → JPA se aplica sobre la instancia que save() cargó, que
  // puede estar gestionada; construir una nueva convertiría el save en un merge
  // sobre detached (y con @Version, en un 409 sin concurrencia).
  assert.ok(adapter.includes('private void applyToJpa(Product domain, ProductJpa jpa)'));
  assert.ok(adapter.includes('.findById(entity.getId()).orElseGet(ProductJpa::new)'));
  // La versión de concurrencia viaja en ambos sentidos del mapeo.
  assert.ok(adapter.includes('jpa.getLockVersion()'));
  assert.ok(adapter.includes('jpa.setLockVersion(domain.getLockVersion());'));

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
  // Tuning del pool Hikari expuesto por ambiente (punto 7): literal en local, env var con default fuera.
  assert.ok(localDb.includes('maximum-pool-size: 10'));
  assert.ok(localDb.includes('connection-timeout: 30000'));
  assert.ok(developDb.includes('maximum-pool-size: ${DB_POOL_MAX_SIZE:10}'));
  assert.ok(productionDb.includes('connection-timeout: ${DB_POOL_CONNECTION_TIMEOUT_MS:30000}'));
  // Migraciones: Hibernate solo gobierna el esquema en local; fuera manda Flyway.
  assert.ok(localDb.includes('flyway:') && localDb.includes('enabled: false'));
  assert.ok(developDb.includes('ddl-auto: validate'));
  assert.ok(developDb.includes('enabled: ${FLYWAY_ENABLED:true}'));
  assert.ok(productionDb.includes('enabled: ${FLYWAY_ENABLED:true}'));
  assert.ok(productionDb.includes('clean-disabled: true'));
  assert.ok(appYaml.includes('port: ${SERVER_PORT:8080}')); // puerto parametrizable, 8080 por defecto
  // Apagado ordenado: drena peticiones en vuelo al recibir SIGTERM (timeout parametrizable).
  assert.ok(appYaml.includes('shutdown: graceful'));
  assert.ok(appYaml.includes('timeout-per-shutdown-phase: ${SHUTDOWN_TIMEOUT:30s}'));
  // Niveles de log: literales en local, env var con default fuera (nunca impiden arrancar).
  assert.ok(read(workspace, 'src/main/resources/parameters/local/logging.yaml').includes('root: INFO'));
  const productionLogging = read(workspace, 'src/main/resources/parameters/production/logging.yaml');
  assert.ok(productionLogging.includes('root: ${LOG_LEVEL_ROOT:WARN}'));
  const testProfile = read(workspace, 'src/main/resources/application-test.yaml');
  assert.ok(testProfile.includes('classpath:parameters/test/db.yaml'));
  const testDb = read(workspace, 'src/main/resources/parameters/test/db.yaml');
  assert.ok(testDb.includes('jdbc:h2:mem:testdb'));
  // El DDL de las migraciones es del dialecto real: no aplica al H2 del perfil test.
  assert.ok(testDb.includes('flyway:') && testDb.includes('enabled: false'));
  // El perfil test lo activa @ActiveProfiles, NO un application.yaml en
  // src/test/resources: ese archivo ocultaría al de main en el classpath del
  // source set `test` y con él `spring.application.name`, que es lo que las
  // skills prescriben como groupId de un listener.
  assert.ok(!exists(workspace, 'src/test/resources/application.yaml'));
  assert.ok(
    read(workspace, 'src/test/java/com/commerce/productcatalog/ProductCatalogApplicationTests.java')
      .includes('@ActiveProfiles("test")')
  );

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

test('README.md: guía de despliegue productivo con pasos y parámetros obligatorios', () => {
  // Fixture base (persistence postgresql, sin broker/security/storage/http-clients).
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const readme = read(workspace, 'README.md');
  assert.ok(readme.includes('## Despliegue en producción'));
  assert.ok(readme.includes('PROFILE=production java -jar build/libs/*.jar')); // paso de arranque
  assert.ok(readme.includes('### Parámetros obligatorios'));
  // DB deriva del perfil production (envValue → ${VAR} sin default).
  assert.ok(readme.includes('| `DB_URL` |'));
  assert.ok(readme.includes('| `DB_USERNAME` |'));
  assert.ok(readme.includes('| `DB_PASSWORD` |'));
  // Sin broker/security/storage/http-clients: no aparecen sus parámetros.
  assert.ok(!readme.includes('KAFKA_BOOTSTRAP_SERVERS'));
  assert.ok(!readme.includes('STORAGE_BUCKET'));
  assert.ok(!readme.includes('OAUTH2_ISSUER_URI'));
  // Operativos con default: mencionados aparte, no como obligatorios.
  assert.ok(readme.includes('`SERVER_PORT`'));
  // El flujo de agentes completa la sección antes del commit.
  assert.ok(readme.includes('parameters/production/*.yaml'));

  // Con broker kafka + storage minio + security oidc: sus parámetros obligatorios aparecen.
  const rich = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  patchedManifest.layers.storage = 'storage.keel.yaml';
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  patched.storage = { buckets: { productImages: { allowedContentTypes: ['image/png'] } } };
  patched.security = {
    authentication: { protocol: 'oidc' },
    access: { default: { level: 'required' }, rules: { listProducts: { level: 'public' } } }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace: rich, stack: { broker: 'kafka', auth: 'keycloak', storage: 'minio' } });
  const richReadme = read(rich, 'README.md');
  assert.ok(richReadme.includes('| `KAFKA_BOOTSTRAP_SERVERS` |'));
  // Un bucket por el que declara el diseño; no hay bucket "por defecto".
  assert.ok(richReadme.includes('| `STORAGE_BUCKET_PRODUCT_IMAGES` |'));
  assert.ok(!richReadme.includes('| `STORAGE_BUCKET` |'));
  assert.ok(richReadme.includes('| `STORAGE_ENDPOINT` |')); // solo con minio
  assert.ok(richReadme.includes('| `OAUTH2_ISSUER_URI` |'));
  // KAFKA_GROUP_ID tiene default: operativo, no obligatorio.
  assert.ok(!richReadme.includes('| `KAFKA_GROUP_ID` |'));
  // Y por lo mismo la concurrencia del listener: se ajusta por entorno, pero su
  // ausencia no impide arrancar, así que no es una variable que haya que aportar.
  assert.ok(!richReadme.includes('| `KAFKA_LISTENER_CONCURRENCY` |'));
});

test('CLAUDE.md contextual: specs, solo capas declaradas y skill local con conventions', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const claude = read(workspace, 'CLAUDE.md');
  assert.ok(claude.includes('specs/service.keel.yaml')); // snapshot local del diseño
  assert.ok(claude.includes('../../specs/product-catalog/')); // canónico del workspace
  assert.ok(claude.includes('persistence.keel.yaml'));
  assert.ok(!claude.includes('messaging.keel.yaml')); // capa no declarada en el fixture
  assert.ok(claude.includes('validation-scenarios.md'));
  assert.ok(claude.includes('grep -rn "TODO" src'));
  assert.ok(claude.includes('keel-stack.json'));
  assert.ok(claude.includes('infra/up.sh')); // la infraestructura de prueba vive en infra/, con su lanzador
  assert.ok(claude.includes('keel-spring-code')); // la skill orquesta los subagentes
  assert.ok(claude.includes('docs/keel/architecture.md'));
  assert.ok(claude.includes('docs/keel/constitution.md'));
  // Sin pruebas unitarias en el flujo: el gate es compilar + los escenarios end-to-end.
  assert.ok(claude.includes('./gradlew build -x test'));
  assert.ok(claude.includes('Sin pruebas unitarias'));
  assert.ok(!claude.includes('**Tests**')); // ya no hay paso de escribir tests

  // El CLAUDE.md lo cargan dos audiencias —quien orquesta y cada agente hoja— y
  // describe el pipeline entero. Sin decir quién es quién, un agente lo lee como su
  // propia lista de tareas y acaba lanzando a los agentes que el documento nombra
  // (incluido él mismo), fuera del conteo de ciclos y del gating.
  assert.ok(claude.includes('**Quién eres.**'));
  assert.ok(claude.includes('**tú no lanzas agentes**'));
  assert.ok(claude.includes('manda **tu propio archivo de agente**'));
  // La verificación es el criterio de salida del pipeline, no el de cada agente:
  // como "obligatoria antes de dar por terminado" contradecía al agente de código,
  // que solo debe compilar.
  assert.ok(claude.includes('## Verificación — criterio de salida del pipeline'));
  assert.ok(!claude.includes('## Verificación (obligatoria antes de dar por terminado)'));
  // El reparto se describe ("lo reparte la skill"), no se prescribe al lector.
  assert.ok(claude.includes('## Quién ejecuta esto'));
  assert.ok(claude.includes('**único orquestador**'));

  // architecture.md y constitution.md: documentos de primer nivel en docs/keel/.
  const architecture = read(workspace, 'docs/keel/architecture.md');
  assert.ok(architecture.includes('hexagonal'));
  assert.ok(architecture.includes('domain'));
  assert.ok(architecture.includes('application'));
  const constitution = read(workspace, 'docs/keel/constitution.md');
  assert.ok(constitution.includes('UseCaseMediator'));
  assert.ok(constitution.includes('XxxRepositoryImpl'));

  // Skill propia del proyecto: es quien orquesta los agentes de .claude/agents/.
  const skill = read(workspace, '.claude/skills/keel-generate-spring/SKILL.md');
  assert.ok(skill.includes('name: keel-generate-spring'));
  assert.ok(skill.includes('CLAUDE.md'));
  // El prompt de arranque no delega el proceso en el CLAUDE.md: es lo que hacía que
  // el agente leyera el pipeline de ese documento como suyo.
  assert.ok(!skill.includes('Sigue su `CLAUDE.md`'));
  assert.ok(skill.includes('son los de tu archivo de agente'));
  assert.ok(skill.includes('autosuficiente'));
  assert.ok(skill.includes('keel-spring-code'));
  assert.ok(skill.includes('keel-spring-infra'));
  assert.ok(skill.includes('keel-spring-tests'));
  assert.ok(skill.includes('keel-spring-validate'));
  assert.ok(skill.includes('keel-spring-quality'));
  // Flujo normalizado: se invoca sin argumentos, con el cwd en la raíz del proyecto.
  assert.ok(skill.includes('sin argumentos'));
  assert.ok(!skill.includes('argument-hint'));
  // Consolidado desde el asset estático que se eliminó: precondiciones,
  // ciclos de fase 2 escalados por número de flujos y guía de despliegue.
  assert.ok(skill.includes('validation-scenarios.md'));
  assert.ok(skill.includes('keel-stack.json'));
  assert.ok(skill.includes('blocking: systemic'));
  assert.ok(skill.includes('Despliegue en producción'));
  assert.ok(skill.includes('parameters/production'));
  // El detalle del gating no se duplica: remite a orchestration.md.
  assert.ok(skill.includes('docs/keel/orchestration.md'));
  // Exclusividad: con un agente vivo el orquestador no toca el proyecto. Sin esta
  // regla, el default del harness (subagente en segundo plano) le deja el turno
  // abierto y lo más natural es que siga haciendo el trabajo que acaba de delegar
  // — y una pasada suya de score-scenarios.sh borra los volcados del árbitro.
  assert.ok(skill.includes('no ejecutes ninguna herramienta sobre el proyecto'));
  assert.ok(skill.includes('Un solo actor sobre el proyecto'));

  // orchestration.md: el pipeline canónico, instalado junto a architecture/constitution.
  const orchestration = read(workspace, 'docs/keel/orchestration.md');
  assert.ok(orchestration.includes('Ciclos de fix'));
  assert.ok(orchestration.includes('Un solo actor sobre el proyecto'));
  assert.ok(!orchestration.includes('del workspace y del proyecto'));

  // Conventions siempre, junto al resto de docs de apoyo en docs/keel/ (las lee
  // cualquiera de los 4 subagentes, no solo la skill orquestadora); el fixture
  // no elige broker/auth/cache/storage → sin skills de esas categorías, pero
  // declara persistence → keel-spring-database (default postgresql) acompaña
  // a la orquestadora en .claude/skills/.
  // Derivado del disco, no de una lista aquí: una convention nueva que nadie añada a
  // CONVENTIONS (generator-docs.js) rompe este test en vez de quedarse sin instalar.
  const conventionsDir = path.join(assetsDir, 'generators', 'spring', 'conventions');
  const conventions = fs.readdirSync(conventionsDir).filter((f) => f.endsWith('.md'));
  assert.ok(conventions.length >= 9);
  for (const convention of conventions) {
    assert.ok(exists(workspace, `docs/keel/conventions/${convention}`), `falta docs/keel/conventions/${convention}`);
  }
  // La derivación del contrato de cable: lo único que permite escribir las pruebas
  // en caja negra sin adivinar la forma de la respuesta.
  assert.ok(read(workspace, 'docs/keel/conventions/integration-tests.md').includes('Del DSL al cable'));
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
  const claude = read(workspace, 'CLAUDE.md');
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

test('los dos harnesses reciben el mismo conocimiento, cada uno en su convención', () => {
  // La propiedad que hace que el proyecto sirva para cualquiera de los dos sin
  // elegir nada al generarlo: ninguna proyección puede quedarse corta. Se compara
  // el inventario, no los bytes — el frontmatter sí difiere, es lo que traduce.
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });
  const projectDir = path.join(workspace, 'services', 'product-catalog-spring');

  const inventory = (harness) => {
    const root = path.join(projectDir, harness.tokens.skills.split('/')[0]);
    const walk = (dir, prefix = '') => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
        else out.push(rel);
      }
      return out;
    };
    // Se normaliza el nombre del directorio contenedor (skills/ vs agent/): lo que
    // se compara es qué skills y qué agentes hay, no cómo los llama cada harness.
    const skillsDirName = path.basename(harness.tokens.skills);
    const agentsDirName = path.basename(harness.tokens.agents);
    return walk(root)
      .map((rel) => rel.replace(new RegExp(`^${skillsDirName}/`), 'SKILL:').replace(new RegExp(`^${agentsDirName}/`), 'AGENT:'))
      // Los comandos son un artefacto propio de los harnesses que los separan de
      // las skills: no tienen contraparte y quedan fuera de la comparación.
      .filter((rel) => rel.startsWith('SKILL:') || rel.startsWith('AGENT:'))
      .sort();
  };

  const [first, ...rest] = HARNESSES;
  const expected = inventory(first);
  assert.ok(expected.length > 0);
  for (const harness of rest) {
    assert.deepEqual(inventory(harness), expected, `${harness.id} no recibe el mismo conocimiento que ${first.id}`);
  }

  // Y el contexto del repo existe con el nombre que busca cada uno.
  for (const harness of HARNESSES) {
    assert.ok(fs.existsSync(path.join(projectDir, harness.contextFile)), `falta ${harness.contextFile}`);
  }
});

test('source set integrationTest: compila sin src/main/java (paralelismo real)', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes('integrationTest {'));
  assert.ok(buildGradle.includes('runtimeClasspath += sourceSets.main.output'));
  // La aserción que protege el paralelismo de la fase 1: con main en el
  // compileClasspath, compileIntegrationTestJava arrastraría la compilación de
  // src/main/java y el agente de pruebas quedaría preso del de código.
  assert.ok(!buildGradle.includes('compileClasspath += sourceSets.main.output'));
  assert.ok(buildGradle.includes('integrationTestImplementation.extendsFrom testImplementation'));
  assert.ok(buildGradle.includes("tasks.register('integrationTest', Test)"));
  // Fuera de `check`: ./gradlew build -x test debe seguir corriendo sin infra.
  assert.ok(!buildGradle.includes('check.dependsOn'));
});

test('scaffolding de integración: AbstractFlowIT y FailureCapture, sin clases de flujo', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const base = 'src/integrationTest/java/com/commerce/productcatalog/flows';
  const abstractFlow = read(workspace, `${base}/AbstractFlowIT.java`);
  assert.ok(abstractFlow.includes('public abstract class AbstractFlowIT'));
  assert.ok(abstractFlow.includes('@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)'));
  assert.ok(abstractFlow.includes('@ActiveProfiles("local")'));
  assert.ok(abstractFlow.includes('@ExtendWith(FailureCapture.class)'));
  // Sin atributo `classes`: la clase de la aplicación vive en src/main/java, que
  // no está en el compileClasspath. Spring la resuelve subiendo por el paquete
  // en ejecución.
  assert.ok(!abstractFlow.includes('ProductCatalogApplication'));
  assert.ok(!abstractFlow.includes('classes ='));
  // Caja negra: nada del código generado se importa.
  assert.ok(!abstractFlow.includes('import com.commerce.productcatalog.domain'));
  assert.ok(!abstractFlow.includes('import com.commerce.productcatalog.infrastructure'));
  // Transversales que las clases de flujo consumen.
  assert.ok(abstractFlow.includes('protected static void resetState()'));
  assert.ok(abstractFlow.includes('infra/reset-db.sh'));
  // El ejecutable de bash se resuelve por ruta: dejar que "bash" resuelva por PATH
  // en Windows lanza el bash de WSL, un entorno aislado donde los scripts fallan.
  assert.ok(!abstractFlow.includes('new ProcessBuilder("bash"'));
  assert.ok(abstractFlow.includes('BASH_EXECUTABLE'));
  assert.ok(abstractFlow.includes('JSONCompareMode.STRICT'));
  // toJson: un nodo objeto/array de JsonPath se re-serializa con Jackson, nunca con
  // toString() (daría sintaxis de Map de Java). No depende del stack: el import va
  // una sola vez y el helper existe siempre.
  assert.ok(abstractFlow.includes('protected String toJson(Object value)'));
  assert.ok(abstractFlow.includes('JSON.writeValueAsString(value)'));
  assert.equal(
    abstractFlow.split('\n').filter((line) => line === 'import com.fasterxml.jackson.databind.ObjectMapper;').length,
    1
  );
  assert.ok(abstractFlow.includes('protected void await(Duration timeout, BooleanSupplier condition)'));
  assert.ok(abstractFlow.includes('JdkClientHttpRequestFactory')); // PATCH sin dependencias nuevas
  assert.ok(abstractFlow.includes('ROUTE_BASE = "/api/v1"'));
  // El fixture no declara security: ni tokens ni api keys.
  assert.ok(!abstractFlow.includes('tokenFor'));
  assert.ok(!abstractFlow.includes('local-dev-api-key'));

  const capture = read(workspace, `${base}/FailureCapture.java`);
  // Las DOS interfaces, y la segunda no es un adorno: `TestWatcher` a secas no recibe nada cuando
  // revienta un `@BeforeAll` —JUnit aborta el contenedor de la clase sin ejecutar ningún método—,
  // que es precisamente el fallo que menos evidencia dejaba y más caro salía de diagnosticar.
  // Este test afirmaba solo `implements TestWatcher` y por tanto congelaba el mecanismo a medias.
  assert.ok(capture.includes('implements TestWatcher, LifecycleMethodExecutionExceptionHandler'));
  assert.ok(capture.includes('handleBeforeAllMethodExecutionException'));
  assert.ok(capture.includes('throw throwable;'), 'capturar no es tragar: el fallo se relanza');
  assert.ok(capture.includes('build'));
  assert.ok(capture.includes('keel-failures'));

  // Las clases de flujo son derivadas del diseño: las escribe el agente. Lo único
  // que build añade encima de la base es el humo del propio arnés.
  const flows = fs.readdirSync(path.join(workspace, 'services', 'product-catalog-spring', base));
  assert.deepEqual(flows.sort(), ['AbstractFlowIT.java', 'FailureCapture.java', 'HarnessSmokeIT.java']);
});

test('humo del arnés: build genera HarnessSmokeIT y ejercita solo la fontanería', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const smoke = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/HarnessSmokeIT.java');
  assert.ok(smoke.includes('class HarnessSmokeIT extends AbstractFlowIT'));
  // El reset y el servidor vivo son la base común a cualquier silueta.
  assert.ok(smoke.includes('AbstractFlowIT::resetState'));
  assert.ok(smoke.includes('get("/actuator/health")'));
  // Nada de negocio: el humo no toca ninguna ruta del diseño.
  assert.ok(!smoke.includes('/products'));
});

test('puntuación de escenarios: script mecánico, no agente, y con salida compacta', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const script = read(workspace, 'infra/score-scenarios.sh');

  // El humo del arnés va primero y corta: correr la suite sobre una fontanería
  // rota produce fallos que parecen de negocio y cuesta una pasada descubrirlo.
  assert.ok(script.includes("--tests '*HarnessSmokeIT'"));
  assert.ok(script.includes('exit 2'));

  // La matriz sale del XML de JUnit: es parseo, no criterio.
  assert.ok(script.includes('build/test-results/integrationTest'));
  assert.ok(script.includes('classname='));

  // El requisito que hace que el cambio no salga net-negativo: lo invoca el
  // orquestador, así que el volcado de Gradle va al log y por stdout solo la
  // matriz. Si esto se pierde, la sesión más larga del pipeline se compacta.
  assert.ok(script.includes('LOG_DIR="build/keel-scenarios"'));
  assert.ok(script.includes('LOG="$LOG_DIR/run.log"'));
  assert.ok(script.includes('>"$LOG" 2>&1'));

  // Arbitrar no es suyo: el veredicto lo sigue dando keel-spring-validate.
  assert.ok(!script.includes('culprit'));
});

// La matriz solo conoce los `FL-*`. Una prueba en rojo con otro nombre —un caso
// borde que el agente añadió por su cuenta— no pasa por ninguna fila, así que sin
// consultar a Gradle el script cantaría "100%" sobre una suite roja, y el pipeline
// avanzaría de fase creyendo verde el servicio. Pasó de verdad: la corrida de
// RabbitMQ terminó con 7 pruebas en rojo y la matriz solo contó 6.
test('puntuación de escenarios: el veredicto de Gradle no se ignora', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const script = read(workspace, 'infra/score-scenarios.sh');

  // Se guarda el código de salida en vez de descartarlo…
  assert.ok(script.includes('|| suite_failed=1'), script);
  // …se inicializa, porque `set -u` está activo y --score no ejecuta la suite…
  assert.ok(/^suite_failed=0$/m.test(script), script);
  // …y se consulta ANTES de cantar el 100%.
  const okLine = script.indexOf('RESULTADO: OK');
  const guard = script.indexOf('if [ "$suite_failed" -ne 0 ]');
  assert.ok(guard > 0 && guard < okLine, 'la comprobación va después del 100%');

  // Y no basta con salir en rojo: hay que decir CUÁL prueba, o el diagnóstico
  // obliga a abrir el log de Gradle entero.
  assert.ok(script.includes('NO son escenarios'), script);
});

// Un lock de una corrida anterior mata el humo del arnés exactamente donde lo mataría un
// arnés roto, y leído como `exit 2` manda a revisar un andamiaje que está bien y a relanzar
// a un agente que no tiene nada que arreglar. En la corrida del 13/08/2026 costó una corrida
// completa de puntuación más un diagnóstico manual de PIDs.
test('puntuación de escenarios: el entorno bloqueado no se disfraza de arnés roto', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const script = read(workspace, 'infra/score-scenarios.sh');

  // Código propio: el orquestador tiene que poder decidir SIN leer la prosa.
  assert.ok(script.includes('exit 3'), script);
  assert.ok(script.includes('ENTORNO:'), script);

  // El primer paso es también el primer detector: si el directorio sigue ahí tras el
  // `rm`, es un lock. Y se comprueba ANTES de acusar al arnés.
  assert.ok(/rm -rf "\$RESULTS" 2>\/dev\/null/.test(script), script);
  const detect = script.indexOf('if [ -d "$RESULTS" ]');
  const harnessKo = script.indexOf('HARNESS: KO — la suite NO se ejecutó');
  assert.ok(detect > 0 && detect < harnessKo, 'el lock se descarta después de acusar al arnés');

  // Y el resto de pasos que Gradle puede perder por el mismo motivo miran el log antes
  // de dar el veredicto: el código de salida de Gradle es 1 para esto igual que para
  // una compilación rota, así que el discriminante está en el texto.
  assert.ok(script.includes('blocked_by_lock'), script);
  assert.ok(script.includes('Timeout waiting to lock'), script);
  assert.ok(script.includes('being used by another process'), script);
  for (const paso of ['el humo del arnés', 'la suite']) {
    assert.ok(script.includes(`report_locked "${paso}"`), `sin descarte de lock en: ${paso}`);
  }

  // Una salida que no dice qué hacer obliga al mismo diagnóstico manual que costó el
  // ciclo: el remedio va en el propio mensaje.
  assert.ok(script.includes('./gradlew --stop'), script);
  assert.ok(script.includes('jps -l'), script);
});

test('constraints del diseño en una query: Bean Validation en el @RequestParam y en el record', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  // Una query con filtros acotados: el caso que devolvía 200 donde el contrato
  // exige 400 porque las constraints no llegaban ni al parámetro ni al record.
  patched['use-cases'].operations.listProducts.input = {
    fields: {
      priceMin: { type: 'decimal', constraints: { min: 0 } },
      tags: { type: 'string', list: true, required: true, constraints: { minItems: 1, maxItems: 10 } }
    }
  };

  scaffoldService({ manifest, layers: patched, workspace });

  const controller = read(
    workspace,
    'src/main/java/com/commerce/productcatalog/infrastructure/rest/controllers/product/v1/ProductV1Controller.java'
  );
  // Sin @Validated en la clase, Spring no evalúa constraints sobre parámetros sueltos.
  assert.ok(controller.includes('@Validated'));
  assert.ok(controller.includes('org.springframework.validation.annotation.Validated'));
  assert.ok(controller.includes('@DecimalMin("0") BigDecimal priceMin'));
  assert.ok(controller.includes('@Size(min = 1, max = 10) List<String> tags'));

  // El record de la query también las lleva: una query puede viajar en el cuerpo
  // (consulta en lote por POST), y ahí es la única validación que actúa.
  const query = read(workspace, 'src/main/java/com/commerce/productcatalog/application/queries/ListProductsQuery.java');
  assert.ok(query.includes('@NotEmpty @Size(min = 1, max = 10) List<String> tags'));
  assert.ok(query.includes('jakarta.validation.constraints.Size'));
});

test('AbstractFlowIT con capa security: credenciales por rol contra el proveedor del stack', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc', serviceAuth: { protocol: 'oauth2' } },
    access: { default: { level: 'required' }, rules: { listProducts: { level: 'public' } } },
    serviceClients: { billing: { scopes: ['catalog:read'] } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const abstractFlow = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(abstractFlow.includes('protected String tokenFor(String role)'));
  assert.ok(abstractFlow.includes('protected String serviceCredential(String client)'));
  // Convención documentada en conventions/infra-validation.md, aquí ejecutable.
  assert.ok(abstractFlow.includes('http://localhost:8180/realms/product-catalog/protocol/openid-connect/token'));
  // El cliente de prueba es <artifactId del proyecto Gradle>-test, que es el nombre
  // que la convention documenta y el que el aprovisionamiento crea: derivarlo del
  // nombre del servicio dejaba a las pruebas pidiendo un cliente inexistente.
  assert.ok(abstractFlow.includes('product-catalog-spring-test'));
  assert.ok(abstractFlow.includes('AUTH_TOKEN_URL'));
  // Ningún secreto inventado: sale de infra/test-credentials.env o de la convención.
  assert.ok(!abstractFlow.includes('env("AUTH_CLIENT_SECRET", "secret")'));
  assert.ok(abstractFlow.includes('infra", "test-credentials.env'));
  // Sobrecargas con token para los escenarios autenticados.
  assert.ok(abstractFlow.includes('protected Response get(String path, String token)'));

  // El contrato de credenciales tiene un único productor: build. El agente de
  // infraestructura lo ejecuta y lo verifica; las pruebas lo leen. Que cada lado
  // adivinase por su cuenta el cliente y el secreto bloqueaba la suite entera.
  const credentials = read(workspace, 'infra/test-credentials.env');
  assert.ok(credentials.includes('AUTH_TEST_CLIENT=product-catalog-spring-test'));
  assert.ok(credentials.includes('AUTH_TOKEN_URL=http://localhost:8180/realms/product-catalog/'));
  assert.ok(credentials.includes('AUTH_CLIENT_SECRET_BILLING=billing-secret'));

  const initKeycloak = read(workspace, 'infra/init-keycloak.sh');
  assert.ok(initKeycloak.startsWith('#!/usr/bin/env bash'));
  assert.ok(initKeycloak.includes('REALM=product-catalog'));
  assert.ok(initKeycloak.includes('USER_CLIENT=product-catalog-spring-test'));
  assert.ok(initKeycloak.includes('clientId=billing'));
  // Matriz scope × audiencia de references/test-clients.md: el agente de pruebas
  // puede escribir los escenarios negativos de M2M contando con que existirán.
  assert.ok(initKeycloak.includes('clientId=test-m2m-no-scope'));
  assert.ok(initKeycloak.includes('catalog:read'));

  // La sesión admin espera a que Keycloak esté listo y aborta si no lo consigue.
  // 'start-dev' tarda decenas de segundos en la primera pasada y el compose no le
  // pone healthcheck: sin la espera, kcadm falla, run() se traga el error —tolera
  // el 409 de idempotencia— y el script sale con 0 sin haber creado el realm.
  assert.ok(initKeycloak.includes('KEEL_KC_WAIT_ATTEMPTS'));
  assert.ok(initKeycloak.includes('KEEL_KC_WAIT_DELAY'));
  // El login NO pasa por run(): es prerrequisito, no una creación idempotente.
  assert.ok(!initKeycloak.includes('run "config credentials'));
  assert.ok(initKeycloak.includes('no acepto una sesion admin tras'));
  assert.ok(initKeycloak.includes('exit 1'));
});

test('sin capa security no hay aprovisionamiento de identidad que generar', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  assert.ok(!exists(workspace, 'infra/init-keycloak.sh'));
  assert.ok(!exists(workspace, 'infra/test-credentials.env'));
});

test('agentes de la orquestación: proyectados al directorio de agentes de cada harness', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  for (const [name, markers] of [
    // El ciclo de fix de la fase 2 es parte del contrato del agente de código: verifica su
    // corrección ejecutando la clase señalada, y lee la evidencia cruda del arbitraje.
    ['keel-spring-code', ['build -x test', "integrationTest --tests '<ClaseAfectada>'", 'build/keel-failures/']],
    ['keel-spring-infra', ['infra/docker-compose.yaml']],
    // El agente de pruebas trabaja sin ver src/main/java: las fuentes con las que
    // deriva la forma del cable son parte de su contrato, no un detalle de redacción.
    ['keel-spring-tests', ['compileIntegrationTestJava', 'mapping.md', 'docs/openapi.yaml', 'infra-validation.md']],
    // El árbitro ya no ejecuta la suite ni compone la matriz (eso es del script):
    // recibe los fallos puntuados y solo emite veredicto.
    ['keel-spring-validate', ['culprit: code', 'evidence:', 'score-scenarios.sh']],
    // El pase de calidad es el único que ejecuta ./gradlew test: en ese punto la
    // suite unitaria es solo contextLoads(), y es lo único que comprueba que los
    // beans arrancan bajo el perfil test (los escenarios corren con perfil local
    // contra infraestructura real y no lo ven).
    ['keel-spring-quality', ['no-conductual', './gradlew test', 'contextTest']]
  ]) {
    const agent = read(workspace, `.claude/agents/${name}.md`);
    assert.ok(agent.includes(`name: ${name}`));
    for (const marker of markers) {
      assert.ok(agent.includes(marker), `${name}.md debería mencionar ${marker}`);
    }
  }

  // deploy/ es prueba manual del diseñador: ninguna fase lo enciende. Lo genera
  // build igual, pero un gate sobre él añadía un modo de fallo (el runtime de
  // contenedores del host) sobre algo que el pipeline no necesita.
  const quality = read(workspace, '.claude/agents/keel-spring-quality.md');
  assert.ok(!quality.includes('deploySmoke'));
  assert.ok(!quality.includes('deploy/up.sh'));

  // El arbitraje es lo único irreducible del nodo: si el agente vuelve a ejecutar
  // la suite, sobrescribe los volcados que vino a leer y el camino verde vuelve a
  // costar una sesión.
  const validate = read(workspace, '.claude/agents/keel-spring-validate.md');
  assert.ok(!validate.includes('./gradlew integrationTest'));
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

  const claude = read(workspace, 'CLAUDE.md');
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

  // El recovery-interval del contenedor de listeners, con clave PROPIA: la de Boot
  // (`spring.rabbitmq.listener.simple.recovery-interval`) no existe, así que el valor
  // real sería un default invisible. Y tiene que ser visible porque no es solo del
  // listener: el deadline de publicación del dispatcher del outbox se deriva de él, y
  // por debajo de este número cada timeout reinicia el reloj de recuperación — el
  // patrón que hace que la entrega nunca converja tras levantar el broker.
  assert.ok(localBroker.includes('recovery-interval-ms: 5000'), localBroker);
  assert.ok(!localBroker.includes('spring.rabbitmq.listener.simple.recovery-interval'), localBroker);
  assert.ok(
    productionBroker.includes('recovery-interval-ms: ${RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS:5000}'),
    productionBroker
  );

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
  assert.ok(compose.includes('context: ./docker'));
  // La imagen va etiquetada por el CONTENIDO del Dockerfile: sin eso, compose
  // reutiliza el toolbox viejo y el síntoma es un 'aws: not found' que se lee
  // como infraestructura rota.
  assert.match(compose, /image: product-catalog-devtools:[0-9a-f]{12}/);
  assert.ok(compose.includes('kafka:29092')); // listener interno para clientes en red

  const dockerfile = read(workspace, 'infra/docker/Dockerfile');
  assert.ok(dockerfile.includes('FROM alpine:3.20'));
  assert.ok(dockerfile.includes('postgresql-client')); // BD por defecto
  assert.ok(dockerfile.includes('kcat')); // broker kafka
  assert.ok(!dockerfile.includes('mysql-client')); // solo las CLIs del stack elegido

  const script = read(workspace, 'infra/validate-infra.sh');
  assert.ok(script.startsWith('#!/usr/bin/env bash'));
  assert.ok(script.includes('psql -h db')); // check de la BD
  assert.ok(script.includes('kcat -b kafka:29092')); // check del broker
  assert.ok(script.includes('product-catalog-devtools')); // ejecuta vía docker exec en devtools
  // 'Up' no es 'listo' (Keycloak, Kafka, LocalStack): sin reintentos, el sondeo
  // inmediato tras 'up -d' da un FALLO que a la segunda pasada es verde.
  assert.ok(script.includes('KEEL_CHECK_RETRIES:-5'));
  assert.ok(script.includes('while [ "$attempt" -le "$RETRIES" ]'));

  // Reset de datos entre flujos: vacía las tablas preservando el esquema.
  const reset = read(workspace, 'infra/reset-db.sh');
  assert.ok(reset.startsWith('#!/usr/bin/env bash'));
  assert.ok(reset.includes('TRUNCATE TABLE')); // reset de PostgreSQL (default)
  assert.ok(reset.includes('CONTAINER_RUNTIME')); // respeta docker/podman
  assert.ok(reset.includes('product-catalog-devtools')); // psql vive en devtools
  // --schema: recrea el esquema. Hace falta porque `ddl-auto: update` nunca elimina
  // una columna obsoleta, y una huérfana NOT NULL rompe todo INSERT con un 409 opaco.
  assert.ok(reset.includes('--schema'));
  assert.ok(reset.includes('DROP SCHEMA public CASCADE'));
});

test('deploy: el servicio empaquetado para pruebas manuales, distinto de la infra de generación', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.messaging = { publishing: { reliability: 'best-effort', events: { ProductCreated: { payload: { entity: 'Product' } } } } };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  // Imagen: multietapa con el jar explotado en las capas de Boot (un cambio de
  // código reescribe kilobytes, no el jar entero) y usuario sin privilegios.
  const dockerfile = read(workspace, 'deploy/Dockerfile');
  assert.ok(dockerfile.includes('AS deps'));
  assert.ok(dockerfile.includes('-jdk-alpine'));
  assert.ok(dockerfile.includes('-jre-alpine')); // el runtime no arrastra el JDK
  assert.ok(dockerfile.includes('-Djarmode=tools -jar application.jar extract --layers'));
  assert.ok(dockerfile.includes('/workspace/extracted/dependencies/'));
  assert.ok(dockerfile.includes('USER app'));
  // wget de BusyBox: la base alpine no trae curl, y el healthcheck lo honran los
  // dos runtimes. Es lo que consume el bucle de espera de up.sh.
  assert.ok(dockerfile.includes('HEALTHCHECK'));
  assert.ok(dockerfile.includes('wget -q -O - http://localhost:8080/actuator/health/readiness'));

  // El contexto de build es la raíz (necesita src/ y el wrapper), así que el
  // .dockerignore va allí y no en deploy/.
  const dockerignore = read(workspace, '.dockerignore');
  assert.ok(dockerignore.includes('build/'));
  assert.ok(dockerignore.includes('infra/'));

  const compose = read(workspace, 'deploy/docker-compose.yaml');
  // La app corre DENTRO, con el único perfil redirigible por entorno: `local` fija
  // literales con localhost y quedaría clavado fuera de la red de contenedores.
  assert.ok(compose.includes('dockerfile: deploy/Dockerfile'));
  assert.ok(compose.includes('PROFILE: develop'));
  assert.ok(compose.includes('DB_URL: jdbc:postgresql://db:5432/product_catalog'));
  assert.ok(compose.includes('KAFKA_BOOTSTRAP_SERVERS: kafka:29092'));
  assert.ok(!compose.includes('DB_URL: jdbc:postgresql://localhost'));
  // Aquí no hay agente que reintente un sondeo: la app espera a que sus
  // dependencias estén sanas o arranca contra una BD que no acepta conexiones.
  assert.ok(compose.includes('condition: service_healthy'));
  assert.ok(compose.includes('pg_isready -U product_catalog'));
  // Sin toolbox: en deploy/ no hay nada que sondear por CLI.
  assert.ok(!compose.includes('devtools'));
  // UIs de inspección: lo que la API no enseña.
  assert.ok(compose.includes('provectuslabs/kafka-ui'));

  const env = read(workspace, 'deploy/.env');
  assert.ok(env.includes('APP_PORT=8080'));
  assert.ok(env.includes('DB_PORT=5432'));
  // Podman rootless no puede publicar por debajo de 1024.
  for (const [, port] of env.matchAll(/^[A-Z_]+_PORT=(\d+)$/gm)) {
    assert.ok(Number(port) > 1024, `puerto publicado por debajo de 1024: ${port}`);
  }
});

test('deploy: los scripts sirven igual con docker que con podman', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  for (const name of ['deploy/up.sh', 'deploy/down.sh']) {
    const script = read(workspace, name);
    assert.ok(script.startsWith('#!/usr/bin/env bash'));
    // Misma detección que validate-infra.sh / reset-db.sh / init-keycloak.sh: quien
    // exporta CONTAINER_RUNTIME=podman para generar no aprende nada nuevo aquí.
    assert.ok(script.includes('CONTAINER_RUNTIME'));
    assert.ok(script.includes('podman-compose')); // fallback sin el frontend delegado
  }

  const up = read(workspace, 'deploy/up.sh');
  // El sondeo va por HTTP contra el puerto publicado, no por `compose ps --format`:
  // ni el formato de esa salida ni el nombre que cada frontend da al contenedor son
  // los mismos en docker y en podman-compose.
  assert.ok(up.includes('/actuator/health/readiness'));
  assert.ok(!up.includes('ps --format'));
  // Lee el .env para sondear e imprimir el puerto REAL si alguien lo cambió.
  assert.ok(up.includes('. "$ENV_FILE"'));

  // El compose no puede usar extensiones que solo entiende Docker.
  const compose = read(workspace, 'deploy/docker-compose.yaml');
  assert.ok(!compose.includes('host-gateway'));
  assert.ok(!compose.includes('network_mode'));
});

// La infraestructura de PRUEBA también necesita lanzador, y por el mismo motivo que
// deploy: `podman compose` no implementa compose, delega. Sin script, todo el repo
// mandaba un `compose up -d` a pelo que en podman sobre Windows muere con un error de
// named pipe — y es el PRIMER comando de la fase de infraestructura del pipeline.
test('infra: tiene lanzador propio y resuelve el frontend de compose por si delega', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  for (const name of ['infra/up.sh', 'infra/down.sh']) {
    const script = read(workspace, name);
    assert.ok(script.startsWith('#!/usr/bin/env bash'), name);
    assert.ok(script.includes('CONTAINER_RUNTIME'), name);
    assert.ok(script.includes('podman-compose'), name);
    // El sondeo es `compose ls` y NO `compose version`: version lo contesta el
    // binario delegado sin tocar el motor, así que sale 0 justo en el caso que el
    // fallback existe para cubrir. Es el bug que este par arregla, y si alguien
    // vuelve a `version` el fallback deja de dispararse en silencio.
    assert.ok(script.includes('podman compose ls'), name);
    assert.ok(!script.includes('podman compose version'), name);
  }

  // up.sh levanta y se aparta: quien decide si está LISTO es validate-infra.sh, que
  // reintenta. Levantar no es estar listo y son dos pasos a propósito.
  const up = read(workspace, 'infra/up.sh');
  assert.ok(up.includes('up -d'));
  assert.ok(up.includes('validate-infra.sh'));

  // down.sh conserva los volúmenes salvo que se los pidan: entre flujos se limpia
  // con reset-db.sh, que no tira el historial de migraciones ni la topología.
  const down = read(workspace, 'infra/down.sh');
  assert.ok(down.includes('--volumes'));

  // Y los scripts que fallan por infra caída mandan al lanzador, no al compose a pelo.
  const validate = read(workspace, 'infra/validate-infra.sh');
  assert.ok(validate.includes('bash infra/up.sh'), validate);
  assert.ok(!validate.includes('compose -f infra/docker-compose.yaml up -d'), validate);
});

// deploy/ e infra/ resuelven runtime y frontend con el MISMO código. Dos criterios
// escritos aparte divergen, y entonces el diseñador y el pipeline eligen distinto en
// la misma máquina — que es exactamente el fallo difícil de creer.
test('infra y deploy resuelven el runtime con el mismo criterio', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const infraUp = read(workspace, 'infra/up.sh');
  const deployUp = read(workspace, 'deploy/up.sh');

  // El bloque de detección del runtime, literal y el mismo en los dos. (Entre él y
  // la resolución de compose, deploy/ mete su .env; por eso se compara el bloque y
  // no el tramo entero.)
  const runtimeBlock = (script) => {
    const from = script.indexOf('RUNTIME="${CONTAINER_RUNTIME');
    return script.slice(from, script.indexOf('\nfi', from) + 3);
  };
  assert.ok(runtimeBlock(infraUp).includes('command -v podman'));
  assert.equal(runtimeBlock(infraUp), runtimeBlock(deployUp));

  // Y el sondeo del frontend, también el mismo.
  for (const script of [infraUp, deployUp]) {
    assert.ok(script.includes('! podman compose ls >/dev/null 2>&1'), script);
  }
});

test('deploy: con Keycloak el realm se importa al arrancar, sin ejecutar nada', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.security = {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'oauth2', audience: 'catalog-api', validateAudience: true }
    },
    access: { default: { level: 'required' }, rules: { createProduct: { roles: ['admin'], scopes: ['catalog:write'] } } },
    serviceClients: { billing: { scopes: ['catalog:write'] } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const compose = read(workspace, 'deploy/docker-compose.yaml');
  assert.ok(compose.includes('--import-realm'));
  assert.ok(compose.includes('/opt/keycloak/data/import/realm-export.json:ro'));
  // El issuer partido: la app alcanza keycloak:8080, pero el token se pide contra
  // localhost:8180 y el `iss` no casaría. jwk-set-uri (que Boot prioriza sobre
  // issuer-uri) resuelve las claves por la ruta interna sin hacer discovery.
  assert.ok(compose.includes('SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_JWK_SET_URI: http://keycloak:8080/realms/product-catalog/'));
  assert.ok(compose.includes('KC_HOSTNAME: http://localhost:${KEYCLOAK_PORT:-8180}'));

  const realm = JSON.parse(read(workspace, 'deploy/keycloak/realm-export.json'));
  assert.equal(realm.realm, 'product-catalog');
  assert.deepEqual(realm.roles.realm.map((r) => r.name), ['admin']);
  // Un usuario por rol (username = rol) + uno sin ninguno: el 403 por rol
  // insuficiente necesita un sujeto autenticado.
  assert.deepEqual(realm.users.map((u) => u.username), ['admin', 'no-role']);
  assert.equal(realm.users[0].credentials[0].value, 'password');

  const byId = Object.fromEntries(realm.clients.map((c) => [c.clientId, c]));
  assert.ok(byId['product-catalog-spring-test'].directAccessGrantsEnabled);
  assert.equal(byId.billing.secret, 'billing-secret');
  // Audiencia y permisos en client scopes separados: si viajaran juntos, el cliente
  // «sin scope» perdería también la audiencia y dejaría de probar nada del scope.
  assert.deepEqual(byId['test-m2m-no-scope'].defaultClientScopes, ['aud-catalog-api']);
  assert.deepEqual(byId['test-m2m-bad-aud'].defaultClientScopes, ['aud-wrong', 'catalog:write']);
  assert.deepEqual(byId['test-m2m-none'].defaultClientScopes, []);
});

test('deploy: sin capa security no hay realm que importar', () => {
  const workspace = makeWorkspace();
  const { copied } = scaffoldService({ ...loadFixture(), workspace });

  assert.ok(!copied.some((f) => f.includes('realm-export.json')));
  assert.ok(!read(workspace, 'deploy/docker-compose.yaml').includes('keycloak'));
});

test('BD con CLI en su propio contenedor y sin toolbox: el arnés conserva el motor de ejecución', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  // Oracle (como Mongo) trae su CLI dentro del contenedor de la base, así que un
  // proyecto sin nada más en el stack no genera contenedor devtools. `runProcess` y
  // la detección de runtime vivían dentro de esa sección: aquí `db(...)` se quedaba
  // sin motor y el arnés no compilaba.
  scaffoldService({
    manifest,
    layers,
    workspace,
    stack: { database: 'oracle', broker: null, auth: null, cache: null, storage: null }
  });

  const harness = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(!harness.includes('DEVTOOLS_CONTAINER'));
  assert.ok(harness.includes('private static final String DB_CONTAINER = "product-catalog-db";'));
  assert.ok(harness.includes('private static String runProcess(List<String> command)'));
  assert.ok(harness.includes('private static synchronized String containerRuntime()'));
  // Y sus imports, que colgaban de la condición de devtools.
  assert.ok(harness.includes('import java.util.ArrayList;'));
  assert.ok(harness.includes('import java.nio.charset.StandardCharsets;'));
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
  assert.ok(!copied.some((f) => f.includes('infra/docker/Dockerfile')));
  assert.ok(!copied.includes('infra/validate-infra.sh'));
  assert.ok(!copied.includes('infra/reset-db.sh')); // h2: reiniciar la app basta

  // deploy/ SÍ se genera: la asimetría es deliberada. infra/ no existe porque no
  // hay nada que sondear, pero el servicio se contenedoriza igual — es lo que se
  // le entrega al diseñador para probarlo.
  assert.ok(copied.includes('deploy/Dockerfile'));
  assert.ok(copied.includes('deploy/docker-compose.yaml'));
  const compose = read(workspace, 'deploy/docker-compose.yaml');
  assert.ok(compose.includes('dockerfile: deploy/Dockerfile'));
  assert.ok(!compose.includes('image: postgres')); // h2 va en memoria, dentro de la app

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
  // upload devuelve StoredObject: sin él el agregado no tiene qué persistir. El
  // bucket lógico viaja en la firma: con dos buckets declarados, la key sola no
  // le dice al adaptador a cuál sube ni cómo resuelve una lectura.
  assert.ok(port.includes('StoredObject upload(String bucket, String key, byte[] content, String contentType);'));
  assert.ok(!port.includes('org.springframework')); // puerto puro de dominio
  // Bucket público: el binario se lee del borde y ningún caso de uso pide los
  // bytes al servicio. Declarar download igual obligaba al agente a implementar
  // un camino inalcanzable y a reportar como hueco del diseño el error que le
  // faltaba (el FILE_NOT_FOUND de una descarga que nadie hace).
  assert.ok(!port.includes('download'));
  // Mismo criterio para la URL, y es el que cierra el hueco que llevó al agente a
  // inventarse un publicUrl propio: con `signedUrl` incondicional, resolver la key
  // de un bucket público pasaba por que ese método compusiera la URL pública —
  // semántica que la firma no dice por ninguna parte. Aquí publicUrl existe y
  // signedUrl no, porque no hay nada privado que firmar.
  assert.ok(port.includes('String publicUrl(String bucket, String key);'));
  assert.ok(!port.includes('signedUrl'));

  // Y el mapper lo usa: el ResponseDto de un bucket público expone la URL
  // absoluta, no la key. La constante sale de StoragePolicies para que el nombre
  // del bucket no viaje como literal.
  const mapper = read(workspace, 'src/main/java/com/commerce/productcatalog/application/mappers/ProductApplicationMapper.java');
  assert.ok(mapper.includes('public ProductApplicationMapper(FileStorage fileStorage)'));
  assert.ok(mapper.includes('fileStorage.publicUrl(StoragePolicies.PRODUCT_IMAGES, entity.getPhoto())'));

  // La base pública es la que ve el CONSUMIDOR, no el endpoint interno con el que
  // el servicio habla con MinIO: una URL con `minio:9000` no resuelve fuera del compose.
  assert.ok(localStorage.includes('public-base-url: http://localhost:9000'));
  assert.ok(productionStorage.includes('public-base-url: ${STORAGE_PUBLIC_BASE_URL}'));

  const storedObject = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/storage/StoredObject.java');
  assert.ok(storedObject.includes('public record StoredObject(String storageKey, URI url, String contentType, Long sizeBytes)'));

  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/storage/S3Config.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/storage/S3FileStorage.java'));

  // Perfil test: mismo generador que el resto de perfiles, no una copia aparte.
  const testStorage = read(workspace, 'src/main/resources/parameters/test/storage.yaml');
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('classpath:parameters/test/storage.yaml'));
  // El mapa de buckets, no la clave plana `bucket:` que StorageProperties ya no
  // bindea (forBucket lanzaría en cuanto el adaptador preguntase).
  assert.ok(testStorage.includes('  buckets:'));
  assert.ok(testStorage.includes('    productImages:'));
  assert.ok(!/^ {2}bucket:/m.test(testStorage));
  // Endpoint local SIEMPRE: sin él el S3Client apunta al S3 real de AWS y
  // cualquier llamada al arrancar el contexto sale a Internet.
  assert.ok(testStorage.includes('endpoint: http://localhost:9000'));
  assert.ok(testStorage.includes('access-key: test'));
  // Y nada de aprovisionar buckets: en test no hay a qué llamar.
  assert.ok(testStorage.includes('ensure-buckets-on-startup: false'));
  // La guarda existe en todos los perfiles, con production en opt-in.
  assert.ok(localStorage.includes('ensure-buckets-on-startup: true'));
  assert.ok(productionStorage.includes('ensure-buckets-on-startup: ${STORAGE_ENSURE_BUCKETS:false}'));
});

test('capa storage: con un bucket private el puerto declara download y signedUrl, y el DTO lleva la key', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  // Mismo diseño que el caso de arriba salvo la visibilidad: es lo único que
  // decide si el servicio tiene que servir el binario él mismo.
  patched.storage = { buckets: { productImages: { visibility: 'private', allowedContentTypes: ['image/png'], maxSizeMb: 5 } } };
  patched.domain.entities.Product.fields.photo = { type: 'file', bucket: 'productImages' };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.storage = 'storage.keel.yaml';
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/storage/FileStorage.java');
  assert.ok(port.includes('byte[] download(String bucket, String key);'));
  assert.ok(port.includes('String signedUrl(String bucket, String key);'));
  // Nada público que resolver: el método no está y el agente no puede exponer por
  // error una URL directa de un objeto que no lo es.
  assert.ok(!port.includes('publicUrl'));
  // El resto del puerto no depende de la visibilidad.
  assert.ok(port.includes('StoredObject upload(String bucket, String key, byte[] content, String contentType);'));
  assert.ok(port.includes('void delete(String bucket, String key);'));

  // El ResponseDto sigue llevando la key: una URL firmada incrustada en una
  // respuesta caduca, y la lectura la sirve la operación que el diseño declare.
  const mapper = read(workspace, 'src/main/java/com/commerce/productcatalog/application/mappers/ProductApplicationMapper.java');
  assert.ok(mapper.includes('entity.getPhoto()'));
  assert.ok(!mapper.includes('FileStorage')); // el mapper no arrastra lo que no usa

  // Sin bucket público no hay base pública que configurar.
  assert.ok(!read(workspace, 'src/main/resources/parameters/local/storage.yaml').includes('public-base-url'));
});

test('capa storage: con visibilidad mixta el puerto declara ambas URLs y el mapper resuelve solo la pública', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.storage = {
    buckets: {
      productImages: { visibility: 'public', allowedContentTypes: ['image/png'], maxSizeMb: 5 },
      productManuals: { visibility: 'private', allowedContentTypes: ['application/pdf'], maxSizeMb: 10 }
    }
  };
  patched.domain.entities.Product.fields.photo = { type: 'file', bucket: 'productImages' };
  patched.domain.entities.Product.fields.manual = { type: 'file', bucket: 'productManuals' };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.storage = 'storage.keel.yaml';
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/storage/FileStorage.java');
  assert.ok(port.includes('String publicUrl(String bucket, String key);'));
  assert.ok(port.includes('String signedUrl(String bucket, String key);'));

  // Es el caso que justifica el parámetro `bucket`: con la key sola, el adaptador
  // no puede decidir si una lectura se firma o se compone.
  const mapper = read(workspace, 'src/main/java/com/commerce/productcatalog/application/mappers/ProductApplicationMapper.java');
  assert.ok(mapper.includes('fileStorage.publicUrl(StoragePolicies.PRODUCT_IMAGES, entity.getPhoto())'));
  assert.ok(!mapper.includes('entity.getManual() != null ? fileStorage'));
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

  // Perfil test: build NO genera ningún JwtDecoder (el decoder lo autoconfigura
  // Boot), así que sin fragmento oauth2 el perfil test se queda sin decoder y
  // @SpringBootTest muere con NoSuchBeanDefinitionException al construir la
  // cadena. Se siembra jwk-set-uri y no issuer-uri: el JWK set se resuelve de
  // forma perezosa en la primera validación, así que el contexto carga sin red.
  assert.ok(!config.includes('JwtDecoder'));
  const testOauth2 = read(workspace, 'src/main/resources/parameters/test/oauth2.yaml');
  assert.ok(testOauth2.includes('jwk-set-uri:'));
  assert.ok(!testOauth2.includes('issuer-uri'));
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('classpath:parameters/test/oauth2.yaml'));

  assert.ok(exists(workspace, '.claude/skills/keel-spring-keycloak/SKILL.md')); // skill del auth elegido
  // La skill se instala como directorio completo: sus references viajan con ella.
  assert.ok(exists(workspace, '.claude/skills/keel-spring-keycloak/references/test-clients.md'));

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

  // Sin bloque cors en el diseño no hay política CORS: ni bean ni llamada.
  assert.ok(!config.includes('.cors('));
  assert.ok(!exists(workspace, `${securityDir}/CorsConfig.java`));
  assert.ok(!read(workspace, 'src/main/resources/parameters/local/security.yaml').includes('allowed-origins'));

  // Y el arnés tampoco trae con qué probarla: los dos únicos helpers que mandan
  // cabeceras de petición propias se gatean por el bloque `cors` declarado, igual que
  // `exchangeWithKey` se gatea por `idempotency`. Sin esta aserción el gate no lo ata
  // nada y el arnés acabaría ofreciendo un preflight contra una política inexistente.
  const harness = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(!harness.includes('protected Response preflight('));
  assert.ok(!harness.includes('protected Response exchangeWithHeaders('));
  // Ni el interruptor de la JVM que hace viajar `Origin`: sin política CORS no hay
  // cabecera restringida que levantar, y dejarlo puesto haría creer que el arnés
  // prueba algo que aquí no existe.
  assert.ok(!buildGradle.includes('allowRestrictedHeaders'));
});

test('capa security con cors: CorsConfig derivado del diseño + orígenes por ambiente', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = {
    authentication: { protocol: 'oidc' },
    cors: {
      description: 'Consumido desde el navegador por la SPA de back-office.',
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['X-Correlation-Id'],
      maxAgeSeconds: 600
    },
    access: { default: { level: 'required' }, rules: { listProducts: { level: 'public' } } }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { auth: 'keycloak' } });

  const securityDir = 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/security';
  // La cadena activa CORS: sin esto el preflight muere antes del controller.
  assert.ok(read(workspace, `${securityDir}/SecurityConfig.java`).includes('.cors(Customizer.withDefaults())'));

  const cors = read(workspace, `${securityDir}/CorsConfig.java`);
  assert.ok(cors.includes('@Value("${security.cors.allowed-origins:}")'));
  assert.ok(cors.includes('setAllowedOriginPatterns')); // exigido si se permiten credenciales
  assert.ok(cors.includes('ALLOWED_HEADERS = List.of("Authorization", "Content-Type")'));
  assert.ok(cors.includes('EXPOSED_HEADERS = List.of("X-Correlation-Id")'));
  assert.ok(cors.includes('Duration.ofSeconds(600)'));
  assert.ok(cors.includes('setAllowCredentials(false)'));
  // Métodos derivados de los endpoints reales del diseño, más el preflight.
  assert.ok(cors.includes('ALLOWED_METHODS = List.of("GET", "OPTIONS", "POST")'));

  // Orígenes: literal en local, variable obligatoria en production.
  assert.ok(
    read(workspace, 'src/main/resources/parameters/local/security.yaml').includes(
      'allowed-origins: http://localhost:3000,http://localhost:5173'
    )
  );
  assert.ok(
    read(workspace, 'src/main/resources/parameters/production/security.yaml').includes(
      'allowed-origins: ${SECURITY_CORS_ALLOWED_ORIGINS}'
    )
  );

  // El arnés puede PROBARLA. Una política CORS que el generador emite pero que ninguna
  // prueba puede observar es la mitad del trabajo: el preflight muere dentro de la
  // cadena de seguridad, así que ninguna llamada normal del arnés lo alcanza. El
  // preflight va sin token —es previo a la credencial— y el primitivo de cabeceras es
  // lo que además permite el caso que NO es preflight: una petición normal con `Origin`.
  const harness = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(harness.includes('protected Response preflight(String path, String origin, String requestMethod, String requestHeaders)'));
  assert.ok(harness.includes('return exchange(HttpMethod.OPTIONS, path, null, null, null, headers);'));
  assert.ok(harness.includes('HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, requestMethod'));
  assert.ok(harness.includes('protected Response exchangeWithHeaders(HttpMethod method, String path, String jsonBody, String token,'));
  // Las cabeceras del escenario se aplican DESPUÉS de las del arnés: se añade sobre lo
  // que ya hay, no se pisa la semántica del token ni la de la clave de idempotencia.
  assert.ok(harness.includes('extraHeaders.forEach(headers::set);'));

  // Y la cabecera llega DE VERDAD al servidor. `Origin` está en la lista de cabeceras
  // restringidas del HttpClient del JDK (el que fija `JdkClientHttpRequestFactory`), que
  // la descarta sin avisar: sin este interruptor el servidor contesta lo mismo que a una
  // petición sin origen y un preflight RECHAZADO se lee como 2xx sin cabeceras
  // `Access-Control-*`. El escenario saldría verde sin haber probado la política.
  assert.ok(
    read(workspace, 'build.gradle').includes(
      "jvmArgs '-Djdk.httpclient.allowRestrictedHeaders=origin'"
    )
  );
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

// Proveedor de prueba de las integraciones salientes: sin él, un flujo FL-* que
// llama a otro servidor no se puede puntuar — falla por conexión rechazada, que
// no dice nada del código. Se gatea por diseño, no por stack.
test('capa http-clients: la infraestructura de prueba levanta un proveedor stub', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';
  const patched = structuredClone(layers);
  patched['http-clients'] = {
    clients: {
      pricing: {
        purpose: 'Obtener el precio vigente de un producto.',
        calls: { getPrice: { contract: 'GET /prices/{sku} -> { amount: decimal }' } }
      }
    }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const compose = read(workspace, 'infra/docker-compose.yaml');
  assert.ok(compose.includes('wiremock/wiremock:'));
  assert.ok(compose.includes('8090:8080'));
  assert.ok(compose.includes('./http-stubs:/home/wiremock'));
  // El montaje necesita el directorio: si no existe, el runtime lo crea como root.
  assert.ok(exists(workspace, 'infra/http-stubs/mappings/.gitkeep'));

  // El reset lo deja como recién arrancado: los mappings del flujo anterior son
  // estado sucio igual que una fila.
  const reset = read(workspace, 'infra/reset-db.sh');
  assert.ok(reset.includes('__admin/reset'));

  // Arnés: programar, contar y resetear desde el propio escenario.
  const abstractIt = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(abstractIt.includes('protected static void stubFor(String method, String pathPattern, int status, String jsonBody)'));
  assert.ok(abstractIt.includes('protected static void stubFailure('));
  assert.ok(abstractIt.includes('protected static int stubCallCount('));
  assert.ok(abstractIt.includes('http://localhost:8090/__admin'));

  // Y afirmar QUÉ se envió, no solo cuántas veces: sin el log de peticiones, una
  // cláusula sobre el cuerpo saliente o sobre la cabecera de idempotencia se queda
  // sin asertar (y la garantía que sostiene, sin probar).
  assert.ok(abstractIt.includes('protected static List<String> stubRequests(String method, String pathPattern)'));
  assert.ok(abstractIt.includes('protected static String stubRequestBody(String requestJson)'));
  assert.ok(abstractIt.includes('protected static String stubRequestHeader(String requestJson, String name)'));
  assert.ok(abstractIt.includes('"/requests/find"'));
  // Conteo y log seleccionan las MISMAS peticiones: un solo criterio, no dos literales.
  assert.ok(abstractIt.includes('private static String stubCriterion(String method, String pathPattern)'));
  // La cabecera se busca sin distinguir caso: quien elige el caso es el cliente HTTP.
  assert.ok(abstractIt.includes('equalsIgnoreCase(name)'));
  // Y el cuerpo saliente se compara con la misma semántica que el entrante.
  assert.ok(abstractIt.includes('protected void assertJson(String actualJson, String expectedJson)'));

  // Y el humo del arnés lo cubre: en rojo, el fallo es de fontanería, no de negocio.
  const smoke = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/HarnessSmokeIT.java');
  assert.ok(smoke.includes('SMOKE-6'));
  assert.ok(smoke.includes('httpStubIsProgrammable'));
  // El humo ejercita también el log: un helper que nadie prueba en vivo no está probado.
  assert.ok(smoke.includes('stubRequests("GET", "/__keel-smoke")'));
  assert.ok(smoke.includes('stubRequestHeader(requests.get(0), "x-keel-smoke")'));
});

test('sin capa http-clients no hay proveedor stub en la infraestructura', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  scaffoldService({ manifest, layers, workspace });

  assert.ok(!read(workspace, 'infra/docker-compose.yaml').includes('wiremock'));
  assert.ok(!exists(workspace, 'infra/http-stubs/mappings/.gitkeep'));
  assert.ok(!read(workspace, 'infra/reset-db.sh').includes('__admin/reset'));

  const abstractIt = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  for (const helper of ['stubFor(', 'stubCallCount(', 'stubRequests(', 'stubRequestHeader(']) {
    assert.ok(!abstractIt.includes(helper), `sin http-clients no debería generarse ${helper}`);
  }
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
            retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 200, maxDelayMs: 4000, retryOn: ['timeout', '5xx'] },
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
  assert.ok(config.includes('requestFactory.setReadTimeout(Duration.ofMillis(2000))'));
  // HTTP/1.1 explícito: con el cliente del JDK negociando h2c contra un servidor
  // en claro, el CUERPO de la petición se pierde y la llamada muere con
  // `Received RST_STREAM`, que el fallback traduce a "el proveedor está caído".
  assert.ok(config.includes('HttpClient.Version.HTTP_1_1'));

  // Puerto hexagonal en domain/clients con retorno en términos del dominio.
  const port = read(workspace, `${portDir}/PricingServiceClient.java`);
  assert.ok(port.includes('public interface PricingServiceClient'));
  assert.ok(port.includes('GetPriceResult getPrice(String sku);')); // path var parseada de la prosa
  const result = read(workspace, `${portDir}/GetPriceResult.java`);
  assert.ok(result.includes('public record GetPriceResult()')); // solo-prosa: vacío + TODO
  assert.ok(result.includes('TODO (agente)'));

  const adapter = read(workspace, `${httpDir}/PricingServiceHttpAdapter.java`);
  assert.ok(adapter.includes('implements PricingServiceClient'));
  // El fallbackMethod va en el aspecto EXTERNO (@Retry). En el circuito dejaba el
  // retry muerto: el CB atrapaba la excepción, ejecutaba el fallback y le devolvía un
  // valor normal al retry, que veía éxito y no reintentaba.
  assert.ok(adapter.includes('@Retry(name = "pricing-service-get-price", fallbackMethod = "getPriceFallback")'));
  assert.ok(adapter.includes('@CircuitBreaker(name = "pricing-service-get-price")'));
  assert.ok(!adapter.includes('@CircuitBreaker(name = "pricing-service-get-price", fallbackMethod'));
  assert.ok(adapter.includes('.uri("/prices/{sku}", sku)')); // llamada funcional armada del contract
  assert.ok(adapter.includes('return mapper.toGetPriceResult(response);'));
  // Sobrecargas tipadas, NUNCA una que declare Throwable: lo que ninguna acepta
  // resilience4j lo relanza, y eso es lo que hace visible un bug del adaptador.
  assert.ok(adapter.includes('private GetPriceResult getPriceFallback(String sku, ResourceAccessException throwable)'));
  assert.ok(!/Fallback\([^)]*\b(?:Throwable|Exception)\s+\w+\)/.test(adapter), adapter);
  assert.ok(adapter.includes('private GetPriceResult getPriceUnavailable(String sku, Throwable throwable)'));
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
  // Literal solo en local, y apuntando al proveedor de prueba del compose: el
  // proveedor real no está en infra/, y sin stub ningún flujo que lo atraviese
  // se puede puntuar.
  assert.ok(hc.includes('base-url: http://localhost:8090'));
  assert.ok(hc.includes('max-attempts: 3'));
  assert.ok(hc.includes('wait-duration: 200ms'));
  // El techo declarado por el diseño acota el backoff exponencial.
  assert.ok(hc.includes('exponential-max-wait-duration: 4000ms'));
  assert.ok(hc.includes('- org.springframework.web.client.HttpClientErrorException')); // 4xx nunca se reintenta
  assert.ok(hc.includes('failure-rate-threshold: 50'));
  // Qué llena la ventana del circuito. Sin la lista, el default cuenta TODA excepción
  // y un bug del adaptador abría el circuito acusando al proveedor.
  assert.ok(hc.includes('record-exceptions:'));
  assert.ok(hc.includes('- org.springframework.web.client.UnknownHttpStatusCodeException'));
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
  // En local, el endpoint de token va al MISMO proveedor de prueba que la base-url,
  // conservando el path que declara el diseño. Con la URL real del diseño, todo
  // escenario que atraviese un cliente oauth2 falla por DNS antes de llegar a la
  // llamada de negocio — y el síntoma no menciona el token por ninguna parte.
  assert.ok(hc.includes('token-uri: http://localhost:8090/token'));
  assert.ok(!hc.includes('auth.example.com'));
  const hcDevelop = read(workspace, 'src/main/resources/parameters/develop/http-clients.yaml');
  assert.ok(hcDevelop.includes('api-key: ${PRICING_SERVICE_API_KEY:changeme}'));
  assert.ok(hcDevelop.includes('client-id: ${PAYMENT_GATEWAY_CLIENT_ID:changeme}'));
  // Fuera de local manda el diseño: develop lo lleva como default de la env var y
  // production la exige. Redirigir al stub es cosa de local y solo de local.
  assert.ok(hcDevelop.includes('token-uri: ${PAYMENT_GATEWAY_TOKEN_URL:https://auth.example.com/token}'));
  // base-url no la declara el diseño: obligatoria fuera de local, sin default que
  // haga que el servicio se llame a sí mismo.
  assert.ok(hcDevelop.includes('base-url: ${PRICING_SERVICE_BASE_URL}'));
  const hcProduction = read(workspace, 'src/main/resources/parameters/production/http-clients.yaml');
  assert.ok(hcProduction.includes('token-uri: ${PAYMENT_GATEWAY_TOKEN_URL}'));

  // Perfil test: registration dummy para levantar el contexto sin proveedor real.
  const hcTest = read(workspace, 'src/main/resources/parameters/test/http-clients.yaml');
  assert.ok(hcTest.includes('client-id: test'));
  assert.ok(hcTest.includes('token-uri: http://localhost/token'));
});

// Los cuatro defectos que solo aparecieron al correr el pipeline entero contra
// infraestructura real (INFORME-GENERACION.md de stock-reservation). Cada uno
// rompía el arranque o la ejecución, y ninguno lo veía la suite de cadenas.

test('un servicio que solo CONSUME genera su EventMetadata', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  const patched = structuredClone(layers);
  // Sin `publishing`: el caso de cualquier consumidor puro.
  patched.messaging = {
    subscriptions: {
      StockDepleted: {
        source: 'inventory',
        payload: { productId: { type: 'uuid', required: true } },
        contract: { envelope: 'keel' },
        triggers: 'retireProduct'
      }
    }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  const base = 'src/main/java/com/commerce/productcatalog';
  // La EventEnvelope la compone por valor: sin EventMetadata el `main` NO compila,
  // y el error señala a la envoltura en vez de a su causa.
  assert.ok(read(workspace, `${base}/infrastructure/messaging/EventEnvelope.java`).includes('EventMetadata'));
  assert.ok(read(workspace, `${base}/domain/events/EventMetadata.java`).includes('record EventMetadata('));
  // Y nada más de domain/events: sin eventos propios no hay nada que marcar.
  assert.ok(!exists(workspace, `${base}/domain/events/DomainEvent.java`));
});

test('el destino de cada suscripción va a parameters/, no a un TODO', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.messaging = 'messaging.keel.yaml';
  const patched = structuredClone(layers);
  patched.messaging = {
    subscriptions: {
      StockDepleted: { source: 'inventory', payload: { productId: { type: 'uuid' } }, triggers: 'retireProduct' }
    }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  // Es la propiedad que lee el listener y a la que entrega el arnés. Si el agente
  // tiene que inventarse el nombre, todo escenario de suscripción muere en un
  // timeout mudo — el fallo más caro de diagnosticar del pipeline.
  const local = read(workspace, 'src/main/resources/parameters/local/messaging.yaml');
  assert.ok(local.includes('subscriptions:'));
  assert.ok(local.includes('stock-depleted:'));
  assert.ok(local.includes('topic: inventory.events'));
  const develop = read(workspace, 'src/main/resources/parameters/develop/messaging.yaml');
  assert.ok(develop.includes('${MESSAGING_SUBSCRIPTIONS_STOCK_DEPLETED_TOPIC:inventory.events}'));
});

test('el perfil test declara la base-url de todo cliente saliente', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers['http-clients'] = 'http-clients.keel.yaml';
  const patched = structuredClone(layers);
  patched['http-clients'] = {
    clients: {
      pricing: { purpose: 'Precio vigente del producto.', calls: { getPrice: { contract: 'GET /prices/{sku}' } } }
    }
  };

  scaffoldService({ manifest: patchedManifest, layers: patched, workspace });

  // El bean del RestClient se construye al levantar el contexto y su @Value no
  // tiene default: sin esto, `contextLoads()` —el gate de "todos los beans
  // arrancan bajo el perfil test"— falla resolviendo el placeholder.
  const hcTest = read(workspace, 'src/main/resources/parameters/test/http-clients.yaml');
  assert.ok(hcTest.includes('pricing:'));
  assert.ok(hcTest.includes('base-url:'));
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('parameters/test/http-clients.yaml'));
});

test('el handler de una operación con idempotency recibe el IdempotencyStore', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  scaffoldService({ manifest, layers, workspace });

  // Mismo criterio que el <C>Client de una activación: el diseño le atribuyó la
  // garantía a esta operación, y sin el puerto delante el camino de menor
  // resistencia es no usarlo — o escribir otro registro.
  const handler = read(
    workspace,
    'src/main/java/com/commerce/productcatalog/application/usecases/CreateProductCommandHandler.java'
  );
  assert.ok(handler.includes('import com.commerce.productcatalog.domain.idempotency.IdempotencyStore;'));
  assert.ok(handler.includes('private final IdempotencyStore idempotencyStore;'));
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

  // El discriminador que nadie declara: con la envoltura Keel, `metadata.eventType`
  // viene siempre y el destino por convención transporta TODOS los eventos de la
  // fuente. Sin esta línea, quien escribe el listener no tiene motivo para filtrar y
  // despacha como suyo lo que no lo es (y con excepción en vez de return, mandaría al
  // descarte un mensaje válido de otro tipo).
  assert.ok(message.includes("Se reconoce por metadata.eventType == 'StockDepleted'"), message);
  assert.ok(message.includes("'inventory-service.events' transporta todos los eventos de inventory-service"), message);
  assert.ok(message.includes('SIN lanzar excepción'), message);

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
  // Y CÓMO deduplicar, que no es intercambiable: retireProduct declara transiciones,
  // así que la repetición la frena el agregado y lo que no puede perderse es el
  // mensaje → registrar después de procesar.
  assert.ok(message.includes('IdempotencyGuard.alreadyProcessed(...) antes de despachar'));
  assert.ok(message.includes('record(...) DESPUÉS'));
  assert.ok(!message.includes('tryRecord'));
  // Y que la deduplicación CADUCA. Se dice aquí —además de en la referencia del DSL y en
  // conventions/dependencies.md— porque este javadoc es lo que lee quien escribe el
  // listener, y la garantía que va a implementar no es la que su nombre sugiere: el
  // registro se purga. Con transiciones detrás es inocuo y el texto lo dice; sin ellas
  // sería el efecto repitiéndose, y por eso el aviso cambia según el diseño.
  assert.ok(message.includes('processed-event.purge.retention-days'), message);
  assert.ok(message.includes('la transición del agregado sigue rechazándola, y esa no caduca'), message);
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
    stack: { database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null }
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
  // En best-effort el bridge no toca el transporte: la envoltura la arma el
  // publisher (es quien lo conoce) y el destino/routing key los lee él de sus
  // propias propiedades. Calcularlos aquí dejaba una variable local por evento y
  // un @Value por evento sin usar.
  assert.ok(!bridge.includes('EventEnvelope'));
  assert.ok(!bridge.includes('@Value'));

  // El evento de integración es el gemelo de wire, no el de dominio. La metadata
  // sigue siendo componente (la usa el bridge) pero no viaja dentro de 'data':
  // la autoritativa es la de la EventEnvelope y duplicarla confundiría al consumidor.
  const integration = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/events/ProductCreatedIntegrationEvent.java');
  assert.ok(integration.includes('public record ProductCreatedIntegrationEvent(@JsonIgnore EventMetadata metadata'));
  assert.ok(integration.includes('import com.fasterxml.jackson.annotation.JsonIgnore;'));

  // El puerto de publicación recibe el evento de INTEGRACIÓN; su stub no rompe el arranque.
  const port = read(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java');
  assert.ok(port.includes('void publish(ProductCreatedIntegrationEvent event, String correlationId);'));
  const stub = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java');
  assert.ok(stub.includes('implements ProductCreatedPublisher'));
  assert.ok(!stub.includes('throw new'));

  // Sin outbox no hay tabla ni relay, y el enrutado sale a parameters/.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/outbox/OutboxRelay.java'));
  assert.ok(read(workspace, 'src/main/resources/parameters/local/messaging.yaml').includes('product-created: product-catalog.product-created'));
  // Y también al perfil `test`: el publisher que escribe el agente lee el destino
  // con un @Value sin default, así que sin este fragmento el contexto de
  // @SpringBootTest muere con PlaceholderResolutionException.
  const testMessaging = read(workspace, 'src/main/resources/parameters/test/messaging.yaml');
  assert.ok(testMessaging.includes('destination: ${MESSAGING_DESTINATION:'));
  assert.ok(testMessaging.includes('product-created: product-catalog.product-created'));
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('classpath:parameters/test/messaging.yaml'));
  // Ningún placeholder sin default: el perfil test arranca sin exportar nada.
  assert.ok(!/\$\{[^:}]+\}/.test(testMessaging));
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
    stack: { database: 'postgresql', broker: 'rabbitmq', auth: null, cache: null, storage: null }
  });

  const outboxDir = 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/outbox';
  // El bridge escribe la fila DENTRO de la transacción (listener síncrono).
  const bridge = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCatalogDomainEventBridge.java');
  assert.ok(bridge.includes('@EventListener'));
  assert.ok(!bridge.includes('@TransactionalEventListener'));
  // El eventType de la fila es la etiqueta del SOBRE (message attribute / props.setType),
  // no el tipo Java: tiene que ser el nombre del evento en el diseño, el mismo que estampa
  // EventMetadata.now(...) en el cuerpo y contra el que filtra la FilterPolicy de SNS.
  assert.ok(bridge.includes('append(productCreatedRoutingKey, "ProductCreated", envelope);'), bridge);
  assert.ok(!bridge.includes('"ProductCreatedIntegrationEvent", envelope'), bridge);
  // Con outbox sí son suyos: la envoltura es lo que serializa en la fila, y el
  // destino/routing key los escribe él (no hay publisher que los lea).
  assert.ok(bridge.includes('EventEnvelope<ProductCreatedIntegrationEvent> envelope = EventEnvelope.of('));
  assert.ok(bridge.includes('@Value'));
  assert.ok(bridge.includes('private String destination;'));

  const entity = read(workspace, `${outboxDir}/OutboxEventJpa.java`);
  assert.ok(entity.includes('@Table(name = "outbox_event"'));
  // Backoff: columna del próximo intento elegible (punto 6).
  assert.ok(entity.includes('name = "next_attempt_at"'));
  assert.ok(entity.includes('scheduleNextAttempt(Instant nextAttemptAt)'));

  // Multi-instancia: el findPending toma lock pesimista con SKIP LOCKED y excluye
  // las filas que agotaron los reintentos o cuyo backoff aún no venció.
  const repository = read(workspace, `${outboxDir}/OutboxEventJpaRepository.java`);
  assert.ok(repository.includes('@Lock(LockModeType.PESSIMISTIC_WRITE)'));
  assert.ok(repository.includes('@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))'));
  assert.ok(repository.includes('o.attempts < :maxAttempts'));
  assert.ok(repository.includes('o.nextAttemptAt is null or o.nextAttemptAt <= :now'));
  assert.ok(repository.includes('findPending(@Param("maxAttempts") int maxAttempts, @Param("now") Instant now, Pageable pageable)'));

  // El relay es determinista; lo acoplado al broker sale por el puerto.
  const relay = read(workspace, `${outboxDir}/OutboxRelay.java`);
  assert.ok(relay.includes('@Scheduled(fixedDelayString = "${outbox.relay.fixed-delay-ms:1000}")'));
  assert.ok(relay.includes('dispatcher.dispatch(row.getDestination()'));
  // Tope de intentos + dead-letter reportado a ERROR.
  assert.ok(relay.includes('@Value("${outbox.relay.max-attempts:10}")'));
  assert.ok(relay.includes('row.getAttempts() >= maxAttempts'));
  assert.ok(relay.includes('log.error('));
  // Backoff exponencial entre reintentos de una misma fila.
  assert.ok(relay.includes('@Value("${outbox.relay.backoff.initial-ms:1000}")'));
  assert.ok(relay.includes('@Value("${outbox.relay.backoff.max-ms:60000}")'));
  assert.ok(relay.includes('row.scheduleNextAttempt('));
  for (const ajeno of ['SnsTemplate', 'KafkaTemplate', 'RabbitTemplate']) {
    assert.ok(!relay.includes(ajeno));
  }
  assert.ok(read(workspace, `${outboxDir}/OutboxDispatcher.java`).includes('void dispatch(String destination'));
  // El fallback del puerto: @Bean condicional, no @Component. El dispatcher real del
  // agente lo aparta sin colisionar, así que no hay que borrar el archivo — y por eso
  // el fail-fast sobrevive a la generación.
  const fallback = read(
    workspace,
    'src/main/java/com/commerce/productcatalog/infrastructure/messaging/OutboxDispatcherFallbackConfig.java'
  );
  assert.ok(fallback.includes('@ConditionalOnMissingBean(OutboxDispatcher.class)'));
  assert.ok(fallback.includes('public OutboxDispatcher outboxDispatcherStub(Environment environment)'));
  assert.ok(!fallback.includes('@Component'));
  // Que `dispatch` no lance tiene un precio: el relay marca como publicado lo que nunca
  // salió. En local eso es lo que se quiere; fuera de local es perderlo todo en silencio.
  assert.ok(fallback.includes('Set.of("local", "test")'));
  assert.ok(fallback.includes('throw new IllegalStateException('));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/OutboxDispatcherStub.java'));

  // Con outbox la entrega NO pasa por publishers: no se generan puerto ni stub.
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/domain/events/ProductCreatedPublisher.java'));
  assert.ok(!exists(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/messaging/ProductCreatedPublisherStub.java'));

  // El relay es @Scheduled: sin @EnableScheduling no saldría nada.
  assert.ok(read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java').includes('@EnableScheduling'));
  const messagingYaml = read(workspace, 'src/main/resources/parameters/local/messaging.yaml');
  assert.ok(messagingYaml.includes('retention-days: 7'));
  // El PRESUPUESTO de reintentos (intentos × tope) se alarga solo en local, y por la
  // razón contraria a la del tope: ahí la fila tiene que sobrevivir al reinicio de
  // contenedor que el propio escenario provoca. Con diez intentos y el tope corto son
  // ~20 s, menos de lo que tarda un broker en volver a servir, así que la fila moría
  // como dead-letter justo antes de que el broker estuviera listo.
  assert.ok(messagingYaml.includes('max-attempts: 40'));
  assert.ok(
    read(workspace, 'src/main/resources/parameters/develop/messaging.yaml').includes(
      'max-attempts: ${OUTBOX_RELAY_MAX_ATTEMPTS:10}'
    )
  );
  assert.ok(messagingYaml.includes('initial-ms: 1000'));
  // El tope del backoff se acorta SOLO en local, que es el perfil con el que corre la
  // suite de integración: ahí el broker caído es un paso del escenario de outbox, no
  // una avería, y con el tope de producción la entrega tras la recuperación llegaría
  // decenas de segundos después. Fuera de local el tope largo es lo correcto.
  assert.ok(messagingYaml.includes('max-ms: 2000'));
  assert.ok(
    read(workspace, 'src/main/resources/parameters/develop/messaging.yaml').includes(
      'max-ms: ${OUTBOX_RELAY_BACKOFF_MAX_MS:60000}'
    )
  );
  // Y NO la caducidad del reclamo: aquí el lote se reclama con un lock de fila, que la
  // conexión suelta al caer la réplica. Emitir el parámetro sería ofrecer una palanca
  // que no está conectada a nada.
  assert.ok(!messagingYaml.includes('claim-timeout-ms'));

  // La palanca que hace observable el outbox en caja negra. Sin ella el único
  // escenario posible —«el evento acaba llegando»— lo pasa igual un servidor que
  // publica en línea, así que la garantía que compra `reliability: outbox` no
  // tendría ningún gate conductual detrás.
  const harness = read(
    workspace,
    'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java'
  );
  assert.ok(harness.includes('protected static void stopBroker()'));
  assert.ok(harness.includes('protected static void startBroker()'));
  // El contenedor se nombra igual que lo bautiza el compose: si cada lado lo
  // compusiera por su cuenta, el arnés pararía un contenedor inexistente y el fallo
  // saldría como un timeout, lejos de su causa.
  assert.ok(harness.includes('BROKER_CONTAINER = "product-catalog-rabbitmq"'));
  assert.ok(read(workspace, 'infra/docker-compose.yaml').includes('container_name: product-catalog-rabbitmq'));
  // Levantar el contenedor no es que el broker sirva: se espera con el mismo sondeo
  // que usa validate-infra.sh.
  assert.ok(harness.includes('awaitBrokerReady()'));
  assert.ok(harness.includes('curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node'));
  // Y la red contra el flujo que muere antes de su finally.
  assert.ok(harness.includes('restoreBroker();'));
  // RabbitMQ conserva su topología al reiniciar: nada que resembrar.
  assert.ok(!harness.includes('reseedTopology'));

  // La palanca no basta: hay que poder AFIRMAR sobre el canal mientras está caído.
  // Con el broker parado la lectura falla por transporte —no por «destino
  // desconocido»—, así que sin esto el Then «el canal sigue vacío» revienta en vez de
  // pasar, y ese Then es la ÚNICA cláusula que separa un outbox de publicar en línea:
  // el resto del escenario lo cumple igual un servicio sin outbox ninguno.
  assert.ok(harness.includes('BROKER_STOPPED'), harness);
  assert.ok(harness.includes('emptyIfBrokerStopped'), harness);
  // La condición es el flag, no el tipo de error: una infraestructura que se cae sola
  // tiene que seguir doliendo donde se cae.
  assert.match(harness, /if \(brokerIntentionallyStopped\(\)\) \{\s*return "";/);
  // Se marca al parar y se limpia DESPUÉS del sondeo de readiness: entre el `start` y
  // el primer listener que responde, el broker sigue sin servir.
  const startBody = harness.slice(harness.indexOf('protected static void startBroker()'));
  assert.ok(startBody.indexOf('awaitBrokerReady()') < startBody.indexOf('BROKER_STOPPED.set(false)'));
});

// Tres garantías de este método no dicen «esto es correcto» sino «esto es correcto
// AUNQUE haya varias instancias»: el reclamo del relay, el del barrido y el arbitraje
// de la clave de idempotencia. Con una sola instancia las tres pasan sus escenarios
// sin ejercitarse — dos hilos de la misma JVM comparten pool, planificador y reloj.
test('el arnés puede levantar una segunda réplica, y es un proceso aparte', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const harness = read(
    workspace,
    'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java'
  );
  assert.ok(harness.includes('protected static int startReplica()'), harness);
  assert.ok(harness.includes('protected static void stopReplica()'), harness);

  // Proceso aparte desde el jar, NO un segundo contexto de Spring: el source set deja
  // src/main/java fuera del compileClasspath —esa es la caja negra—, así que el arnés
  // no puede ni nombrar la clase de aplicación. Y dos contextos en la misma JVM
  // compartirían demasiado para que el resultado signifique lo que dice.
  assert.ok(harness.includes('new ProcessBuilder('), harness);
  assert.ok(harness.includes('"-jar"'), harness);
  assert.ok(!/import com\.commerce\.productcatalog\.(?!.*flows)/.test(harness), harness);

  // La salida va a un archivo: sin nadie leyendo el pipe, un arranque de Spring lo
  // llena y la réplica se queda bloqueada escribiendo — un cuelgue que parece lentitud.
  assert.ok(harness.includes('redirectOutput('), harness);
  // Levantar no es estar listo: se sondea readiness antes de devolver el puerto.
  assert.ok(harness.includes('/actuator/health/readiness'), harness);
  // Y la red por si el finally de un escenario no llegó a correr.
  assert.match(read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java'), /resetState[\s\S]*?stopReplica\(\);/);

  // El jar tiene que existir antes de la suite, y fresco: uno viejo levantaría una
  // réplica con código distinto del que se está puntuando.
  const score = read(workspace, 'infra/score-scenarios.sh');
  assert.ok(score.includes('./gradlew bootJar'), score);
  assert.ok(score.indexOf('bootJar') < score.indexOf("--tests '*HarnessSmokeIT'"), score);
});

test('sin outbox no hay palanca de broker: detenerlo no probaría ninguna garantía', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  // Mismo diseño, misma capa de mensajería, pero entrega best-effort declarada.
  const { patched, patchedManifest } = withEvent(layers, manifest, 'best-effort');

  scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgresql', broker: 'rabbitmq', auth: null, cache: null, storage: null }
  });

  const harness = read(
    workspace,
    'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java'
  );
  assert.ok(!harness.includes('stopBroker'));
  assert.ok(!harness.includes('BROKER_CONTAINER'));
  // El nombre del contenedor sí se estampa siempre: es del compose, no del arnés.
  assert.ok(read(workspace, 'infra/docker-compose.yaml').includes('container_name: product-catalog-rabbitmq'));
});

test('con SNS/SQS el arranque del broker resiembra la topología, que no sobrevive al reinicio', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'outbox');

  scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgresql', broker: 'snssqs', auth: null, cache: null, storage: null }
  });

  const harness = read(
    workspace,
    'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java'
  );
  // LocalStack sirve SNS/SQS desde memoria: al arrancar de nuevo vuelve sin topics ni
  // colas. Lo que se perdería no es el mensaje sino el destino, y el escenario fallaría
  // por «cola inexistente» en vez de por el outbox.
  assert.ok(harness.includes('reseedTopology();'));
  assert.ok(harness.includes('infra/init-messaging.sh'));
  assert.ok(harness.includes('BROKER_CONTAINER = "product-catalog-localstack"'));
  // bashExecutable() se define UNA vez aunque lo usen el reset y la resiembra.
  assert.equal((harness.match(/private static String bashExecutable\(\)/g) ?? []).length, 1);
});

test('frontera hexagonal: application no importa los eventos de Spring', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const { patched, patchedManifest } = withEvent(layers, manifest, 'outbox');

  scaffoldService({
    manifest: patchedManifest,
    layers: patched,
    workspace,
    stack: { database: 'postgresql', broker: 'rabbitmq', auth: null, cache: null, storage: null }
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
  // El perfil test lo activa @ActiveProfiles, NO un application.yaml en
  // src/test/resources: ese archivo ocultaría al de main en el classpath del
  // source set `test` y con él `spring.application.name`, que es lo que las
  // skills prescriben como groupId de un listener.
  assert.ok(!exists(workspace, 'src/test/resources/application.yaml'));
  assert.ok(
    read(workspace, 'src/test/java/com/commerce/productcatalog/ProductCatalogApplicationTests.java')
      .includes('@ActiveProfiles("test")')
  );

  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(!buildGradle.includes('data-jpa'));
  // Sin esquema que migrar no hay mecanismo de migraciones.
  assert.ok(!buildGradle.includes('flyway'));
  assert.ok(!copied.some((file) => file.includes('db/migration')));
  assert.ok(!copied.some((file) => file.includes('export-schema.sh')));
  assert.ok(!copied.some((file) => file.includes('application-migrations.yaml')));

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
  // Y el camino sin transacción existe igual: quién lo usa lo decide el DSL (una operación
  // con schedule que reconcilia), no el stack, así que el scheduler puede llamarlo sin
  // preguntar por la capa. Aquí es simplemente idéntico a dispatch.
  assert.ok(mediatorFile.includes('dispatchWithoutTransaction'));
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
  // Ida: reconciliación por identidad sobre la colección gestionada. Recrear las
  // hijas en cada guardado deja huérfanas y rompe el bloqueo optimista.
  assert.ok(adapter.includes('Map<UUID, OrderLineJpa> linesManaged = new HashMap<>();'), adapter);
  assert.ok(adapter.includes('OrderLineJpa childJpa = child.getId() != null ? linesManaged.get(child.getId()) : null;'));
  assert.ok(adapter.includes('jpa.getLines().clear();'));
  assert.ok(adapter.includes('jpa.getLines().addAll(linesReconciled);'));
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

// --- persistence.audit ---

const JPA_ENTITIES = 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/entities';
const AUDITOR_CONFIG = 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/audit/AuditorAwareConfig.java';

// Diseño con auditoría: la política, los campos que exige 'declared' y la capa
// security sin la que la autoría no se admite.
function withAudit(audit, { declaredFields = {}, security = true } = {}) {
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  const patched = structuredClone(layers);
  patched.persistence.audit = audit;
  patched.domain.entities.Ledger = {
    description: 'Registro contable.',
    fields: { id: { type: 'uuid', id: true, generated: true }, ...declaredFields }
  };
  patched.persistence.entities.Ledger = { persisted: true };
  if (security) {
    patchedManifest.layers.security = 'security.keel.yaml';
    patched.security = {
      authentication: { protocol: 'oidc' },
      access: { default: { level: 'required' } }
    };
  }
  return { manifest: patchedManifest, layers: patched };
}

const auditField = (type) => ({ type, generated: true });

test("audit 'all': las columnas viven en AuditableEntity y el dominio no las nombra", () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...withAudit({ timestamps: 'all', authorship: 'all' }), workspace });

  const auditable = read(workspace, `${JPA_ENTITIES}/AuditableEntity.java`);
  assert.ok(auditable.includes('@Column(name = "created_at", nullable = false, updatable = false)'));
  assert.ok(auditable.includes('@Column(name = "updated_by", nullable = false)'));
  assert.ok(auditable.includes('@CreatedBy'));
  assert.ok(auditable.includes('@LastModifiedBy'));

  const ledgerJpa = read(workspace, `${JPA_ENTITIES}/LedgerJpa.java`);
  assert.ok(ledgerJpa.includes('extends AuditableEntity'));
  // El listener llega por herencia: repetirlo en la subclase sería ruido.
  assert.ok(!ledgerJpa.includes('@EntityListeners'));
  assert.ok(!ledgerJpa.includes('private Instant createdAt;'));
});

test("audit 'declared': los campos son del dominio y se anotan en su propia Jpa", () => {
  const workspace = makeWorkspace();
  scaffoldService({
    ...withAudit(
      { timestamps: 'declared', authorship: 'declared' },
      {
        declaredFields: {
          createdAt: auditField('timestamp'),
          updatedAt: auditField('timestamp'),
          createdBy: auditField('string'),
          updatedBy: auditField('string')
        }
      }
    ),
    workspace
  });

  const ledgerJpa = read(workspace, `${JPA_ENTITIES}/LedgerJpa.java`);
  // No hereda: sus columnas son miembros propios. Pero necesita el listener.
  assert.ok(!ledgerJpa.includes('extends AuditableEntity'));
  assert.ok(ledgerJpa.includes('@EntityListeners(AuditingEntityListener.class)'));
  for (const annotation of ['@CreatedDate', '@LastModifiedDate', '@CreatedBy', '@LastModifiedBy']) {
    assert.ok(ledgerJpa.includes(annotation), annotation);
  }
  // Con ningún eje en 'all' no hay base que heredar.
  assert.ok(!exists(workspace, `${JPA_ENTITIES}/AuditableEntity.java`));
});

test("audit 'none': ni columnas, ni listener, ni @EnableJpaAuditing", () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...withAudit({ timestamps: 'none', authorship: 'none' }), workspace });

  assert.ok(!exists(workspace, `${JPA_ENTITIES}/AuditableEntity.java`));
  assert.ok(!exists(workspace, AUDITOR_CONFIG));
  const ledgerJpa = read(workspace, `${JPA_ENTITIES}/LedgerJpa.java`);
  assert.ok(!ledgerJpa.includes('AuditableEntity'));
  assert.ok(!ledgerJpa.includes('@EntityListeners'));
  const application = read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java');
  assert.ok(!application.includes('@EnableJpaAuditing'));
});

test('autoría: el AuditorAware se genera y nunca devuelve vacío', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...withAudit({ authorship: 'all' }), workspace });

  const config = read(workspace, AUDITOR_CONFIG);
  assert.ok(config.includes('AuditorAware<String> auditorProvider()'));
  // El principal del JWT es getName(): el claim que fijó JwtAuthConverter.
  assert.ok(config.includes('instanceof JwtAuthenticationToken token'));
  assert.ok(config.includes('Optional.of(token.getName())'));
  // Sin petición detrás hay centinela, no Optional.empty(): las columnas de
  // autoría son NOT NULL y el relay del outbox también escribe.
  assert.ok(!config.includes('Optional.empty()'));
  assert.ok(config.includes('CorrelationContext.get()'));
  assert.ok(config.includes('private static final String SYSTEM = "system";'));
  // Spring Data autodetecta el único bean: auditorAwareRef sobraría.
  const application = read(workspace, 'src/main/java/com/commerce/productcatalog/ProductCatalogApplication.java');
  assert.ok(application.includes('@EnableJpaAuditing'));
  assert.ok(!application.includes('auditorAwareRef'));
});

test('timestamps sin autoría no genera AuditorAware (el reloj no necesita bean)', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...withAudit({ timestamps: 'all' }, { security: false }), workspace });
  assert.ok(!exists(workspace, AUDITOR_CONFIG));
  assert.ok(exists(workspace, `${JPA_ENTITIES}/AuditableEntity.java`));
});

test('auditoría proyectada al dominio: el repositorio hace flush al guardar', () => {
  const workspace = makeWorkspace();
  scaffoldService({
    ...withAudit({ timestamps: 'declared' }, { declaredFields: { updatedAt: auditField('timestamp') } }),
    workspace
  });

  // El listener escribe en el flush: con save() a secas la respuesta de un update
  // devolvería el updatedAt anterior.
  const ledgerAdapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/LedgerRepositoryImpl.java');
  assert.ok(ledgerAdapter.includes('.saveAndFlush(jpa)'));
  // Product no proyecta auditoría al dominio: no paga el flush.
  const productAdapter = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/persistence/repositories/ProductRepositoryImpl.java');
  assert.ok(productAdapter.includes('.save(jpa)'));
  assert.ok(!productAdapter.includes('.saveAndFlush(jpa)'));
});

test('campo de auditoría declarado: fuera del DTO de entrada, dentro del de salida', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = withAudit({ timestamps: 'declared' }, { declaredFields: { createdAt: auditField('timestamp') } });
  // Una operación que crea Ledger y devuelve la entidad completa.
  layers['use-cases'].operations.createLedger = {
    description: 'Abre un registro contable.',
    kind: 'command',
    input: { entity: 'Ledger' },
    output: { entity: 'Ledger' }
  };
  scaffoldService({ manifest, layers, workspace });

  const app = 'src/main/java/com/commerce/productcatalog/application';
  // `generated: true` lo mantiene fuera de la entrada: nadie puede enviar su propia
  // auditoría. Y dentro de la salida, que es para lo que el diseño lo declaró.
  assert.ok(!read(workspace, `${app}/commands/CreateLedgerCommand.java`).includes('createdAt'));
  assert.ok(read(workspace, `${app}/dtos/CreateLedgerResponseDto.java`).includes('Instant createdAt'));
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
  assert.ok(entity.includes('@Table(name = "processed_event", indexes = {'));
  assert.ok(entity.includes('@EmbeddedId'));
  // La purga borra por rango de fecha y la clave primaria no le sirve: sin este índice
  // cada réplica recorre la tabla entera a la misma hora. Mismo nombre que el documental.
  assert.ok(entity.includes('@Index(name = "ix_processed_event_processed_at", columnList = "processed_at")'));
  // El id del mensaje lo elige quien publica y no siempre es un uuid: quedarse corto
  // manda a la DLQ, por no caber, justo el mensaje que la tabla existe para deduplicar.
  assert.ok(entity.includes('@Column(name = "event_id", nullable = false, length = 255)'));

  const guard = read(workspace, `${dir}/IdempotencyGuard.java`);
  // Las dos puertas, porque el orden del registro no es intercambiable: procesar y
  // luego registrar hace reintentable un fallo transitorio; reclamar antes cierra la
  // ventana del duplicado a cambio de perder el mensaje si el handler falla.
  assert.ok(guard.includes('public boolean alreadyProcessed(String handlerId, String eventId)'));
  assert.ok(guard.includes('public boolean record(String handlerId, String eventId)'));
  assert.ok(guard.includes('public boolean tryRecord(String handlerId, String eventId)'));
  // La carrera la arbitra la clave primaria, no el existsById previo. Por eso tryRecord
  // NO consulta antes de insertar: preguntar no cierra ninguna ventana que la clave no
  // cierre ya, y con dos réplicas las dos pasarían igualmente la consulta.
  assert.ok(guard.includes('catch (DataIntegrityViolationException duplicate)'));
  assert.ok(!/tryRecord\([^)]*\)\s*\{\s*if \(alreadyProcessed/.test(guard));
  // La escritura vive en OTRO bean, y las dos razones son el proxy: dentro de la misma
  // clase el REQUIRES_NEW no se aplicaría (auto-invocación), y capturar la violación
  // dentro de la transacción que la provoca la deja rollback-only —el `return false`
  // acabaría en UnexpectedRollbackException al commitear—.
  assert.ok(guard.includes('writer.insert(new ProcessedEventJpa.ProcessedEventId(handlerId, eventId))'));
  assert.ok(!guard.includes('Propagation.REQUIRES_NEW'));
  const writer = read(workspace, `${dir}/ProcessedEventWriter.java`);
  assert.ok(writer.includes('@Transactional(readOnly = true, propagation = Propagation.REQUIRES_NEW)'));
  assert.ok(writer.includes('@Transactional(propagation = Propagation.REQUIRES_NEW)'));
  // saveAndFlush del repositorio, y la entidad implementando Persistable con
  // isNew() == true. Las dos mitades, y ninguna sobra:
  //  - sin Persistable, la clave asignada hace que Spring Data deduzca merge() — un
  //    SELECT + UPDATE que no viola la clave primaria, no lanza y hace que
  //    record()/tryRecord() devuelvan true SIEMPRE: el registro no deduplicaba nada.
  //    La rama alreadyProcessed lo tapaba con su consulta previa y con la guarda de
  //    dominio del agregado; tryRecord no tiene ninguna de las dos.
  //  - y con el EntityManager a pelo dentro de un @Component no hay proxy que
  //    traduzca la excepción de Hibernate, así que el catch del llamante no casa y el
  //    desenlace acaba en 500. La traducción la da el proxy de Spring Data.
  assert.ok(writer.includes('saveAndFlush('), writer);
  assert.ok(!writer.includes('entityManager.'), writer);
  assert.ok(!writer.includes('catch ('));
  const processed = read(workspace, `${dir}/ProcessedEventJpa.java`);
  assert.ok(processed.includes('implements Persistable<ProcessedEventJpa.ProcessedEventId>'), processed);
  // isNew() NO es constante: SimpleJpaRepository.delete() empieza con
  // `if (isNew(entity)) return;`, así que un true fijo convierte el borrado en un
  // no-op silencioso. El flag lo pone @PostLoad: recién construida es nueva (persist,
  // y la clave primaria arbitra), leída de la base no lo es (y se puede borrar).
  assert.match(processed, /public boolean isNew\(\) \{\s*return !persisted;/);
  assert.ok(processed.includes('@PostLoad'), processed);
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

test('idempotencia de comando: store transaccional, contexto y filtro de la cabecera', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  scaffoldService({ manifest, layers, workspace });

  const base = 'src/main/java/com/commerce/productcatalog';
  // El puerto vive en dominio; el adaptador, en persistencia. Y el javadoc lo
  // separa explícitamente del guard de consumo: son dos mecanismos distintos.
  const port = read(workspace, `${base}/domain/idempotency/IdempotencyStore.java`);
  assert.ok(port.includes('Optional<StoredRequest> find(String scope, String idempotencyKey);'));
  assert.ok(port.includes('record StoredRequest(String signature, String resourceId)'));
  assert.ok(port.includes('IdempotencyGuard'));

  const dir = `${base}/infrastructure/persistence/idempotency`;
  const entity = read(workspace, `${dir}/IdempotencyRecordJpa.java`);
  assert.ok(entity.includes('@Table(name = "idempotency_record", indexes = {'));
  assert.ok(entity.includes('@EmbeddedId'));
  // "scope" es palabra del SQL estándar: la columna no puede llamarse así.
  assert.ok(entity.includes('@Column(name = "operation_scope"'));
  assert.ok(entity.includes('@Column(name = "expires_at"'));
  // La purga borra por rango de caducidad y la clave primaria no le sirve: sin índice,
  // cada réplica recorre la tabla entera. Mismo nombre que el equivalente documental.
  assert.ok(entity.includes('@Index(name = "ix_idempotency_record_expires_at", columnList = "expires_at")'));

  // La atomicidad es el motivo de existir de esta implementación: save se une a
  // la transacción del caso de uso (REQUIRED), al revés que IdempotencyGuard.
  const store = read(workspace, `${dir}/JpaIdempotencyStore.java`);
  assert.ok(store.includes('implements IdempotencyStore'));
  assert.ok(store.includes('@Transactional\n    public void save('));
  assert.ok(!store.includes('propagation = Propagation.REQUIRES_NEW'));
  // persist + flush, nunca save/saveAndFlush — misma trampa que en ProcessedEventWriter:
  // con la clave asignada, save hace merge y pisa el registro de la ganadora con el de
  // la perdedora sin lanzar, así que la CARRERA deja de estar arbitrada y las dos
  // peticiones se ejecutan. Aquí lo tapaba el find previo, que resuelve la repetición
  // secuencial antes de llegar al save; el fallo solo aparece con dos simultáneas, que
  // es exactamente el caso que esta clase existe para cerrar. Y el flush hace que la
  // violación salte AQUÍ y no en el commit del mediador, donde ya no se distingue de
  // cualquier otro conflicto y el cliente recibe un 409 sin code.
  assert.ok(store.includes('saveAndFlush('), store);
  // Sin EntityManager a pelo. Se mira el CÓDIGO, no la prosa: el javadoc explica
  // justamente por qué no se usa, y buscar el nombre a secas daría falso positivo —
  // el mismo motivo por el que check-idempotency.sh borra comentarios antes de mirar.
  assert.ok(!/^\s*entityManager\./m.test(store), store);
  assert.ok(store.includes('throw new IdempotencyConflictException(scope, idempotencyKey, concurrent)'));
  // El INSERT lo fuerza la entidad, no el adaptador: sin esto, save hace merge y pisa
  // el registro de la ganadora con el de la perdedora sin lanzar — la carrera deja de
  // estar arbitrada y las dos peticiones se ejecutan. El find previo lo tapa en el
  // reintento secuencial, así que solo se ve con dos peticiones simultáneas.
  const record = read(workspace, `${base}/infrastructure/persistence/idempotency/IdempotencyRecordJpa.java`);
  assert.ok(record.includes('implements Persistable<IdempotencyRecordJpa.IdempotencyRecordId>'), record);
  assert.match(record, /public boolean isNew\(\) \{\s*return !persisted;/);
  assert.ok(record.includes('@PostLoad'), record);

  // Y la fila CADUCADA se retira antes de insertar. `find` ya la ignora, así que sin
  // esto el handler ejecuta y la inserción choca contra una fila que ya no protege
  // nada: 409 IDEMPOTENCY_KEY_IN_PROGRESS durante casi un día (la purga va por lotes,
  // una vez al día), y la ventana real de deduplicación pasa a fijarla la cadencia de
  // la purga en vez del ttlSeconds del diseño. El filtro es el complemento EXACTO del
  // de find: lo que aquel descarta por caducado es lo que este retira.
  assert.ok(store.includes('.filter(stored -> !stored.getExpiresAt().isAfter(now))'), store);
  assert.ok(store.includes('repository.delete(expired)'), store);
  // El DELETE tiene que ir antes del INSERT, no reordenado al commit.
  assert.ok(store.indexOf('repository.flush()') < store.indexOf('repository.saveAndFlush('), store);
  const conflict = read(workspace, `${base}/domain/idempotency/IdempotencyConflictException.java`);
  assert.ok(conflict.includes('extends ConflictException'));
  assert.ok(conflict.includes('"IDEMPOTENCY_KEY_IN_PROGRESS"'));
  assert.ok(store.includes('@Scheduled(cron = "${idempotency-record.purge.cron:'));
  assert.ok(read(workspace, `${dir}/IdempotencyRecordJpaRepository.java`).includes('deleteExpiredBefore'));
  assert.ok(read(workspace, `${base}/ProductCatalogApplication.java`).includes('@EnableScheduling'));

  // La cabecera es transporte: llega por contexto, no como componente del Command
  // (Jackson deserializa el Command entero desde el cuerpo).
  const context = read(workspace, `${base}/application/support/IdempotencyContext.java`);
  assert.ok(context.includes('public static Optional<String> get()'));
  const filter = read(workspace, `${base}/infrastructure/web/IdempotencyKeyFilter.java`);
  assert.ok(filter.includes('public static final String HEADER = "Idempotency-Key";'));
  assert.ok(filter.includes('IdempotencyContext.clear();'));
  const command = read(workspace, `${base}/application/commands/CreateProductCommand.java`);
  assert.ok(!command.includes('idempotencyKey'));

  // La cadencia de la purga sale de parameters/, en todos los perfiles.
  assert.ok(read(workspace, 'src/main/resources/parameters/local/idempotency.yaml').includes('cron: "0 30 4 * * *"'));
  assert.ok(read(workspace, 'src/main/resources/parameters/test/idempotency.yaml').includes('${IDEMPOTENCY_PURGE_CRON:'));
  assert.ok(read(workspace, 'src/main/resources/application-test.yaml').includes('classpath:parameters/test/idempotency.yaml'));

  // Y el stub del handler dice qué usar, para que el agente no reinvente el registro.
  const handler = read(workspace, `${base}/application/usecases/CreateProductCommandHandler.java`);
  assert.ok(handler.includes('IdempotencyContext.get()'));
  assert.ok(handler.includes('scope="createProduct"'));

  // Y dice qué NO hacer con la carrera. El `find` no la ve —las dos peticiones lo
  // fallan— así que quien la arbitra es la clave primaria del registro, vía la
  // excepción que el adaptador ya traduce al 409 del contrato. Sin esta frase, el
  // camino de menor resistencia es un try/catch «defensivo» alrededor de save que se
  // traga justo eso: el servidor pasa el reintento secuencial y ejecuta dos veces en
  // cuanto hay concurrencia, que es el caso normal con más de una réplica.
  assert.ok(handler.includes('IDEMPOTENCY_KEY_IN_PROGRESS'), handler);
  assert.match(handler, /NO captures esa excepción/);
});

// Una operación con `schedule` genera su <Servicio>Scheduler con @Scheduled, pero
// las anotaciones no hacen nada sin @EnableScheduling en la clase de aplicación. Y
// nada lo delataba: check-idempotency.sh da la familia `reconciliation` por buena
// porque el @Scheduled SÍ está en el fuente. Ninguna fixture lo reproduce —todas
// traen suscripciones u outbox, que ya activaban el scheduling por su cuenta—, así
// que la red va sobre un modelo sintético.
test('un diseño con schedule y sin outbox ni suscripciones activa el scheduling igual', () => {
  const scheduledModel = {
    service: { basePackage: 'com.example.svc', applicationClass: 'SvcApplication' },
    layersPresent: {},
    services: [{ operations: [{ schedule: { cron: '0 * * * *' } }] }],
    audit: {},
    events: []
  };

  assert.equal(hasScheduledOperations(scheduledModel), true);
  assert.equal(hasScheduledOperations({ services: [{ operations: [{}] }] }), false);
  assert.equal(hasScheduledOperations({}), false);

  const [application] = applicationFiles(scheduledModel);
  assert.ok(application.content.includes('@EnableScheduling'));
  assert.ok(application.content.includes('import org.springframework.scheduling.annotation.EnableScheduling;'));
});

test('sin idempotencia declarada no se genera el registro de comando', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  delete patched['use-cases'].operations.createProduct.idempotency;

  scaffoldService({ manifest, layers: patched, workspace });

  const base = 'src/main/java/com/commerce/productcatalog';
  assert.ok(!exists(workspace, `${base}/domain/idempotency/IdempotencyStore.java`));
  assert.ok(!exists(workspace, `${base}/infrastructure/web/IdempotencyKeyFilter.java`));
  assert.ok(!exists(workspace, `${base}/application/support/CommandSignature.java`));
  assert.ok(!exists(workspace, 'src/main/resources/parameters/local/idempotency.yaml'));
});

test('la firma del contenido se genera, no se deja escrita en prosa', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();

  scaffoldService({ manifest, layers, workspace });

  const signature = read(
    workspace,
    'src/main/java/com/commerce/productcatalog/application/support/CommandSignature.java'
  );
  assert.ok(signature.includes('public static String of(Object command)'));
  // Canónica: componentes de record ordenados por nombre y escalares con prefijo de
  // longitud. Si dos handlers la calculan distinto, la comparación deja de significar
  // nada y nada lo delata — de ahí que no sea cosa del handler.
  assert.ok(signature.includes('Comparator.comparing(RecordComponent::getName)'));
  assert.ok(signature.includes('raw.length() + ":" + raw'));
  // Un binario entra por su digest. Por identidad de objeto —lo que devuelve
  // String.valueOf de un array— la firma cambiaría en cada arranque y la operación
  // dejaría de deduplicar sin que nada lo delate.
  assert.ok(signature.includes('value instanceof byte[] bytes'));
  assert.ok(signature.includes('value.getClass().isArray()'));
  // Sin Jackson a propósito: el ObjectMapper de la app lo configuran la API y el
  // broker, y un cambio ahí movería firmas ya almacenadas.
  assert.ok(!signature.includes('com.fasterxml.jackson'));
});

test('payload-hash: la clave es la firma, sin cabecera ni contexto que puedan faltar', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched['use-cases'].operations.createProduct.idempotency = { keySource: 'payload-hash', ttlSeconds: 600 };

  scaffoldService({ manifest, layers: patched, workspace });

  const base = 'src/main/java/com/commerce/productcatalog';
  // El mecanismo entero sigue estando…
  assert.ok(exists(workspace, `${base}/domain/idempotency/IdempotencyStore.java`));
  assert.ok(exists(workspace, `${base}/application/support/CommandSignature.java`));
  // …pero el camino de la cabecera no: aquí no hay nada que transportar, y dejarlo
  // llevaba al handler a preguntar por una clave que nunca está y no deduplicar nunca.
  assert.ok(!exists(workspace, `${base}/application/support/IdempotencyContext.java`));
  assert.ok(!exists(workspace, `${base}/infrastructure/web/IdempotencyKeyFilter.java`));

  const handler = read(workspace, `${base}/application/usecases/CreateProductCommandHandler.java`);
  assert.ok(handler.includes('CommandSignature.of(command)'));
  assert.ok(handler.includes('siempre se deduplica'));
  assert.ok(!handler.includes('IdempotencyContext.get()'));
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
  // Y NINGUNA de las dos se repite como `unique = true` de columna: esa es anónima, y la
  // base rechazaría por ella, dejando a ApiExceptionHandler —que mapea por nombre— sin
  // poder traducir el conflicto al `code` del diseño.
  assert.ok(!productJpa.includes('unique = true'), 'la unicidad se declara dos veces');

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(handler.includes('CONSTRAINT_TO_ERROR'));
  assert.ok(handler.includes('Map.entry("uk_products_slug"'));
  assert.ok(handler.includes('"PRODUCT_SLUG_ALREADY_EXISTS"'));
  // El diseño no liga campo → code: la asociación exacta la cierra el agente.
  assert.ok(handler.includes('TODO (agente)'));
});

test('unique sobre campo computed con bloqueo optimista: es carrera, no "ya existe"', () => {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  // Un campo que el servicio CALCULA: el cliente no lo manda nunca.
  patched.domain.entities.Product.fields.sequence = {
    type: 'int',
    required: true,
    unique: true,
    computed: 'El mayor sequence existente más uno.'
  };

  scaffoldService({ manifest, layers: patched, workspace });

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(handler.includes('Map.entry("uk_products_sequence"'));
  // Nadie PIDIÓ este valor, así que romper la constraint solo puede ser una carrera:
  // mandar al cliente a corregir una entrada que no envió no le dice nada accionable.
  assert.ok(handler.includes('"CONCURRENT_MODIFICATION"'));
  assert.ok(!handler.includes('PRODUCT_SEQUENCE_ALREADY_EXISTS'));
  assert.ok(handler.includes('reintenta'));

  // Y no se contagia: una constraint sobre un campo que sí manda el cliente sigue
  // siendo el error de unicidad de siempre.
  assert.ok(handler.includes('uk_products_natural'));
});

test('unique sobre campo computed SIN bloqueo optimista sigue siendo unicidad', () => {
  // El razonamiento se apoya en las dos patas: si el agregado no lleva control de
  // versión, la colisión no tiene por qué venir de una carrera observable y llamarla
  // conflicto de concurrencia sería inventar una garantía que nada sostiene.
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patched = structuredClone(layers);
  patched.domain.entities.Product.fields.sequence = {
    type: 'int',
    required: true,
    unique: true,
    computed: 'El mayor sequence existente más uno.'
  };
  patched.persistence.consistency = { ...(patched.persistence.consistency ?? {}), optimisticLocking: 'none' };

  scaffoldService({ manifest, layers: patched, workspace });

  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(handler.includes('"PRODUCT_SEQUENCE_ALREADY_EXISTS"'));
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
  // La columna del embeddable sale con lo que declara el value object, no solo con su
  // nombre: `required` es un NOT NULL de la tabla de elementos, y un `maxLength` sería
  // su `length`. Compuesta a mano aquí, esa mitad se perdía.
  assert.ok(discountJpa.includes('@Column(name = "code", nullable = false)'));

  // Adaptador: reconstrucción del VO en ambos sentidos, con import del embeddable.
  const repo = read(workspace, `${base}/infrastructure/persistence/repositories/ProductRepositoryImpl.java`);
  assert.ok(repo.includes('.entities.DiscountJpa;'));
  assert.ok(repo.includes('.map(e -> new Discount(e.getCode(), e.getPercentage())).toList()'));
  assert.ok(repo.includes('new ArrayList<DiscountJpa>('));
});

// ─── Seguridad derivada del diseño (matchers, audiencia, roleGrants) ──────────

const SEC_BASE = 'src/main/java/com/commerce/productcatalog/infrastructure/configurations/security';

// Fixture + capa security (y lo que el test necesite), con stack keycloak.
function scaffoldWithSecurity(securityLayer, apiPatch = {}, extra = {}) {
  const workspace = makeWorkspace();
  const { manifest, layers } = loadFixture();
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = securityLayer;
  patched.api = { ...patched.api, ...apiPatch };
  for (const [name, value] of Object.entries(extra)) {
    patchedManifest.layers[name] = `${name}.keel.yaml`;
    patched[name] = value;
  }
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, stack: { auth: 'keycloak', ...(extra.storage ? { storage: 'minio' } : {}) } });
  return workspace;
}

test('SecurityConfig: matchers sin duplicar la versión del basePath', () => {
  const workspace = scaffoldWithSecurity(
    {
      authentication: { protocol: 'oidc' },
      access: { default: { level: 'required' }, rules: { listProducts: { level: 'public' } } }
    },
    { basePath: '/api/v1' }
  );

  const config = read(workspace, `${SEC_BASE}/SecurityConfig.java`);
  assert.ok(config.includes('.requestMatchers(HttpMethod.GET, "/api/v1/products").permitAll()'));
  assert.ok(!config.includes('/api/v1/v1/'));
  // Y el controller expone exactamente ese mismo prefijo.
  const controller = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/controllers/product/v1/ProductV1Controller.java');
  assert.ok(controller.includes('@RequestMapping("/api/v1")'));
});

test('SecurityConfig: dos filter chains cuando conviven endpoints de usuario y M2M', () => {
  const workspace = scaffoldWithSecurity(
    {
      authentication: {
        protocol: 'oidc',
        serviceAuth: { protocol: 'client-credentials', validateAudience: true, audience: 'catalog-api' }
      },
      access: {
        default: { level: 'required' },
        rules: {
          listProducts: { level: 'public' },
          retireProduct: { level: 'service', scopes: ['product:write'] }
        }
      }
    },
    { endpoints: { retireProduct: { method: 'POST', path: '/products/{id}/retire', successStatus: 204, audience: 'services' } } }
  );

  const config = read(workspace, `${SEC_BASE}/SecurityConfig.java`);
  // Cadena M2M: acotada por securityMatcher y con la audiencia comprobada como
  // AUTORIZACIÓN (403), no dentro del decoder (que daría 401).
  assert.ok(config.includes('@Order(1)'));
  assert.ok(config.includes('.securityMatcher("/api/v1/products/{id}/retire")'));
  assert.ok(config.includes('.addFilterBefore(new AudienceAuthorizationFilter(audience), AuthorizationFilter.class)'));
  assert.ok(!config.includes('serviceJwtDecoder'));
  // Ningún decoder propio: la audiencia dejó de ser asunto de la autenticación,
  // así que basta el que autoconfigura Boot desde el issuer-uri.
  assert.ok(!config.includes('JwtDecoder'));
  assert.ok(config.includes('@Order(2)'));

  // El filtro lanza AccessDeniedException: token legítimo de otro público → 403.
  const filter = read(workspace, `${SEC_BASE}/AudienceAuthorizationFilter.java`);
  assert.ok(filter.includes('extends OncePerRequestFilter'));
  assert.ok(filter.includes('throw new AccessDeniedException('));
  assert.ok(filter.includes('instanceof JwtAuthenticationToken token'));

  // 401/403 con el ErrorResponse del contrato, no con el body de Spring Security.
  assert.ok(config.includes('.exceptionHandling(ex -> ex.authenticationEntryPoint(securityErrorHandlers)'));
  const handlers = read(workspace, `${SEC_BASE}/SecurityErrorHandlers.java`);
  assert.ok(handlers.includes('implements AuthenticationEntryPoint, AccessDeniedHandler'));
  assert.ok(handlers.includes('HttpStatus.UNAUTHORIZED'));
  assert.ok(handlers.includes('HttpStatus.FORBIDDEN'));
});

test('SecurityConfig: con cors, todas las cadenas la activan (también la M2M y la de protocolo none)', () => {
  const cors = { description: 'Consumido desde el navegador por la SPA de back-office.' };

  const split = read(
    scaffoldWithSecurity(
      {
        authentication: {
          protocol: 'oidc',
          serviceAuth: { protocol: 'client-credentials', validateAudience: true, audience: 'catalog-api' }
        },
        cors,
        access: {
          default: { level: 'required' },
          rules: { listProducts: { level: 'public' }, retireProduct: { level: 'service', scopes: ['product:write'] } }
        }
      },
      { endpoints: { retireProduct: { method: 'POST', path: '/products/{id}/retire', successStatus: 204, audience: 'services' } } }
    ),
    `${SEC_BASE}/SecurityConfig.java`
  );
  // Una llamada por cadena: si a la M2M le falta, su preflight muere.
  assert.equal(split.split('.cors(Customizer.withDefaults())').length - 1, 2);

  const none = read(
    scaffoldWithSecurity({ authentication: { protocol: 'none' }, cors, access: { default: { level: 'public' } } }),
    `${SEC_BASE}/SecurityConfig.java`
  );
  assert.ok(none.includes('.cors(Customizer.withDefaults())'));
  assert.ok(none.includes('import org.springframework.security.config.Customizer;'));
});

test('SecurityConfig: sin rutas de usuario, se conserva la cadena única con audiencia', () => {
  const workspace = scaffoldWithSecurity(
    {
      authentication: {
        protocol: 'oidc',
        serviceAuth: { protocol: 'client-credentials', validateAudience: true }
      },
      access: { default: { level: 'service' }, rules: { listProducts: { level: 'service', scopes: ['product:read'] } } }
    },
    { defaultAudience: 'services' }
  );

  const config = read(workspace, `${SEC_BASE}/SecurityConfig.java`);
  assert.ok(!config.includes('@Order(1)'));
  assert.ok(!config.includes('securityMatcher'));
  assert.ok(config.includes('.addFilterBefore(new AudienceAuthorizationFilter(audience), AuthorizationFilter.class)'));
});

test('JwtAuthConverter: roleGrants materializado como mapa estático', () => {
  const workspace = scaffoldWithSecurity({
    authentication: { protocol: 'oidc' },
    roleGrants: { 'catalog-admin': ['product:write', 'category:write'] },
    access: {
      default: { level: 'required' },
      rules: { createProduct: { level: 'required', permissions: ['product:write'] } }
    }
  });

  const converter = read(workspace, `${SEC_BASE}/JwtAuthConverter.java`);
  assert.ok(converter.includes('ROLE_GRANTS'));
  assert.ok(converter.includes('java.util.Map.entry("catalog-admin", java.util.List.of("product:write", "category:write"))'));
  assert.ok(converter.includes('authorities.addAll(extractGrantedPermissions(roles));'));
});

// ─── Storage: política de buckets, multipart y sus handlers ──────────────────

test('storage: política por bucket en la config, límite multipart y handlers de Spring', () => {
  const workspace = scaffoldWithSecurity(
    { authentication: { protocol: 'none' }, access: { default: { level: 'public' } } },
    {},
    {
      storage: {
        buckets: {
          productImages: { visibility: 'public', allowedContentTypes: ['image/png', 'image/jpeg'], maxSizeMb: 5 }
        }
      }
    }
  );

  // La política del diseño viaja a la config: el adaptador la lee, no la reinventa.
  const storageYaml = read(workspace, 'src/main/resources/parameters/local/storage.yaml');
  assert.ok(storageYaml.includes('  buckets:'));
  assert.ok(storageYaml.includes('      visibility: public'));
  assert.ok(storageYaml.includes('      max-size-mb: 5'));
  assert.ok(storageYaml.includes('      allowed-content-types: image/png,image/jpeg'));

  // Sin este límite Spring corta en 1MB y el 413 del diseño nunca se alcanza.
  // Va con holgura sobre el maxSizeMb del diseño: si el servlet cortase justo en
  // el límite de negocio, Tomcat emitiría el 413 antes del caso de uso y ninguna
  // guarda declarada antes que la del tamaño podría precederla.
  const appYaml = read(workspace, 'src/main/resources/application.yaml');
  assert.ok(appYaml.includes('      max-file-size: 10MB'));
  assert.ok(appYaml.includes('      max-request-size: 10MB'));

  // Excepciones que lanza el framework antes del controller: 413/400, no 500.
  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(handler.includes('@ExceptionHandler(MaxUploadSizeExceededException.class)'));
  assert.ok(handler.includes('"FILE_TOO_LARGE"'));
  assert.ok(handler.includes('@ExceptionHandler(MissingServletRequestPartException.class)'));
  assert.ok(handler.includes('@ExceptionHandler(PayloadTooLargeException.class)'));
});

test('sin capa storage: ni límite multipart ni handlers de subida', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  assert.ok(!read(workspace, 'src/main/resources/application.yaml').includes('multipart'));
  const handler = read(workspace, 'src/main/java/com/commerce/productcatalog/infrastructure/rest/ApiExceptionHandler.java');
  assert.ok(!handler.includes('MaxUploadSizeExceededException'));
});

test('migraciones: mecanismo Flyway completo y baseline a cargo del agente', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  // Motor + módulo del dialecto elegido (Flyway 10+ saca cada dialecto de core).
  const buildGradle = read(workspace, 'build.gradle');
  assert.ok(buildGradle.includes("implementation 'org.flywaydb:flyway-core'"));
  assert.ok(buildGradle.includes("runtimeOnly 'org.flywaydb:flyway-database-postgresql'"));

  // El directorio existe (con su README, que Flyway ignora por no ser .sql) pero
  // sin baseline: el SQL lo produce el agente desde las entidades ya finales.
  const migrationsReadme = read(workspace, 'src/main/resources/db/migration/README.md');
  assert.ok(migrationsReadme.includes('V1__baseline_schema.sql'));
  assert.ok(migrationsReadme.includes('infra/export-schema.sh'));
  assert.ok(!exists(workspace, 'src/main/resources/db/migration/V1__baseline_schema.sql'));

  // Perfiles auxiliares aditivos, sin fragmentos parameters/.
  const schemaExport = read(workspace, 'src/main/resources/application-schema-export.yaml');
  assert.ok(schemaExport.includes('jakarta.persistence.schema-generation.scripts.action: create'));
  assert.ok(schemaExport.includes('create-target: build/schema/baseline.sql'));
  assert.ok(schemaExport.includes('ddl-auto: none'));
  const migrationsProfile = read(workspace, 'src/main/resources/application-migrations.yaml');
  assert.ok(migrationsProfile.includes('ddl-auto: validate'));
  assert.ok(migrationsProfile.includes('enabled: true'));

  // Script de exportación: usa el perfil aditivo y deja el archivo esperado.
  const exportScript = read(workspace, 'infra/export-schema.sh');
  assert.ok(exportScript.includes('PROFILE=local,schema-export ./gradlew bootRun'));
  assert.ok(exportScript.includes('build/schema/baseline.sql'));

  // El reset entre flujos preserva el historial: truncarlo haría que el siguiente
  // arranque reaplicase el baseline sobre tablas ya existentes.
  // (el comando va entre comillas simples de bash: sq() reescribe las internas)
  assert.ok(read(workspace, 'infra/reset-db.sh').includes('flyway_schema_history'));
});

// El pipeline entrega el baseline verificado en estático, no probado: arrancar con
// el perfil `migrations` exige una BD sin esquema, y borrar ese volumen se llevaría
// la base sobre la que corren los escenarios. Esa prueba es del diseñador, así que
// los textos que él lee tienen que decirlo y traer los comandos.
test('migraciones: la prueba en vivo del baseline queda atribuida al diseñador', () => {
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace });

  const migrationsReadme = read(workspace, 'src/main/resources/db/migration/README.md');
  assert.ok(migrationsReadme.includes('La prueba en vivo es tuya'));
  assert.ok(migrationsReadme.includes('PROFILE=local,migrations ./gradlew bootRun'));
  // Borrar el volumen: es lo que deja la BD sin esquema, que es la precondición de
  // la prueba. Va por el lanzador, que resuelve el frontend de compose.
  assert.ok(migrationsReadme.includes('infra/down.sh --volumes'));

  // README del proyecto: la sección de despliegue es donde el diseñador busca los
  // pasos, y el paso pendiente lleva sus comandos exactos.
  const readme = read(workspace, 'README.md');
  const production = readme.slice(readme.indexOf('## Despliegue en producción'));
  assert.ok(production.includes('este paso es tuyo y el pipeline no lo ejecuta'));
  assert.ok(production.includes('baselineTested: PENDING'));
  assert.ok(production.includes('PROFILE=local,migrations ./gradlew bootRun'));

  // El script de export cierra remitiendo al doble check, no a la prueba.
  const exportScript = read(workspace, 'infra/export-schema.sh');
  assert.ok(exportScript.includes('doble check estático'));
  assert.ok(exportScript.includes('La prueba en vivo (PROFILE=local,migrations sobre una BD sin esquema) la hace el diseñador'));

  // Contexto del repo: el paso de verificación no le pide al agente arrancar nada.
  const agents = read(workspace, 'AGENTS.md');
  assert.ok(agents.includes('doble check estático'));
  assert.ok(agents.includes('verificación **manual del diseñador**'));
});

test('rendimiento: el arnés puede CONTAR consultas, que es lo que hace observable un N+1', () => {
  // Sin esto, «este listado no hace N+1» es una lectura del código: cierta hoy y sin
  // nada que la sostenga tras la siguiente refactorización. Con el contador, un
  // escenario afirma que el coste NO crece con el tamaño de la página.
  const workspace = makeWorkspace();
  scaffoldService({ ...loadFixture(), workspace, force: true });

  const harness = read(workspace, 'src/integrationTest/java/com/commerce/productcatalog/flows/AbstractFlowIT.java');
  assert.ok(harness.includes('protected long queryCount()'), harness);
  assert.ok(harness.includes('/actuator/metrics/hibernate.statements?tag=status:prepared'), harness);

  // La cuenta la publica Micrometer desde las estadísticas de Hibernate...
  assert.ok(read(workspace, 'build.gradle').includes("org.hibernate.orm:hibernate-micrometer"));
  // ...y se activan SOLO donde se mide: llevar la cuenta cuesta, y en producción se
  // paga en cada petición a cambio de un dato que allí nadie lee.
  assert.ok(read(workspace, 'src/main/resources/parameters/local/db.yaml').includes('generate_statistics: true'));
  assert.ok(!read(workspace, 'src/main/resources/parameters/production/db.yaml').includes('generate_statistics'));
  assert.ok(!read(workspace, 'src/main/resources/parameters/develop/db.yaml').includes('generate_statistics'));
});
