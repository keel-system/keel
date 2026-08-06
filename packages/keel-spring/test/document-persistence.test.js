// La rama documental del scaffolding (persistence.default.model: document).
//
// Es un renderizador nuevo y completo —espejos, repositorios, adaptadores, índices,
// transacciones—, no una variante de la rama relacional, así que necesita su propia
// cobertura. La fixture inspection-reports está construida para estresar justo lo
// que el modelo documental cambia: dos niveles de anidamiento interno, value object
// dentro de value object, índice sobre un dot-path anidado y outbox + suscripciones
// (que son lo que obliga al replica set).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inspection-reports');
const PROJECT = path.join('services', 'inspection-reports-spring');
const JAVA = 'src/main/java/com/example/inspectionreports';
const DOCS = `${JAVA}/infrastructure/persistence/documents`;
const REPOS = `${JAVA}/infrastructure/persistence/repositories`;
const CONFIG = `${JAVA}/infrastructure/persistence/config`;

function scaffoldReports() {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-document-'));
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack: { group: 'com.example' } });
  const root = path.join(workspace, PROJECT);
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const exists = (relative) => fs.existsSync(path.join(root, relative));
  const javaFiles = () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    return walk(path.join(root, 'src/main/java')).map((file) => ({
      name: path.basename(file),
      content: fs.readFileSync(file, 'utf8')
    }));
  };
  return { result, root, read, exists, javaFiles };
}

test('el modelo del diseño elige la rama: sin stack explícito, document no cae en JPA', () => {
  // resolveStack() deriva el motor por defecto del modelo declarado. Sin eso, un
  // diseño documental sin keel-stack.json generaría JPA en silencio contra una base
  // que no lo entiende — el fallo más caro de todo el cambio, porque no da error.
  const { result, read } = scaffoldReports();
  assert.equal(result.stack.database, 'mongodb');
  // Y la elección llega hasta el código: el espejo es un documento, no una entidad.
  assert.ok(read(`${DOCS}/InspectionReportDocument.java`).includes('@Document('));
});

test('ningún archivo generado toca JPA', () => {
  // El assert más barato y más valioso de este archivo: si algún generador se olvidó
  // de gatearse por persistenceKind, aparece aquí antes que en el compilador.
  const { javaFiles } = scaffoldReports();
  const offenders = javaFiles()
    .filter((f) => /jakarta\.persistence|org\.hibernate/.test(f.content))
    .map((f) => f.name);
  assert.deepEqual(offenders, []);
});

test('la raíz es una colección y sus entidades internas van anidadas dentro', () => {
  const { read, exists } = scaffoldReports();
  const report = read(`${DOCS}/InspectionReportDocument.java`);

  assert.ok(report.includes('@Document(collection = "inspection_reports")'));
  assert.ok(report.includes('@Id'));
  // Colección hija: una lista dentro del documento, no una asociación.
  assert.ok(report.includes('private List<ReportSectionDocument> sections'));
  assert.ok(!report.includes('@OneToMany'));
  assert.ok(!report.includes('mappedBy'));
  assert.ok(!report.includes('orphanRemoval'));
  // Frontera del agregado: del inspector solo se guarda su id, nunca un @DBRef.
  assert.ok(report.includes('@Field(name = "inspector_id")'));
  assert.ok(report.includes('private UUID inspectorId'));
  assert.ok(!report.includes('@DBRef'));
  // `list: true` es un array del propio documento: sin tabla de elementos.
  assert.ok(report.includes('private List<String> tags'));

  // La hija existe como clase pero NO es una colección propia, y el segundo nivel
  // de anidamiento tampoco: obliga a que el render sea transitivo de verdad.
  const section = read(`${DOCS}/ReportSectionDocument.java`);
  assert.ok(!section.includes('@Document('));
  assert.ok(section.includes('private List<SectionItemDocument> items'));
  assert.ok(exists(`${DOCS}/SectionItemDocument.java`));
  // La back-reference era un artefacto de la clave ajena: dentro del padre no apunta
  // a nada, así que no se genera campo.
  assert.ok(!/private\s+InspectionReportDocument\s+report/.test(section));
});

test('un value object dentro de otro se resuelve solo: es el TODO que la rama relacional deja abierto', () => {
  const { read, javaFiles } = scaffoldReports();
  const location = read(`${DOCS}/LocationDocument.java`);
  const geo = read(`${DOCS}/GeoPointDocument.java`);

  // Subdocumento anidado, no columnas con prefijo.
  assert.ok(location.includes('private GeoPointDocument coords'));
  // Y su BigDecimal va en el tipo decimal nativo: sin targetType el driver lo
  // serializa como String y todo orden pasa a ser lexicográfico ("10" < "9").
  assert.ok(geo.includes('targetType = FieldType.DECIMAL128'));

  // Ni un solo TODO pendiente en toda la persistencia documental de esta fixture.
  const pending = javaFiles()
    .filter((f) => /TODO \(agente\)/.test(f.content) && /Document\.java$|RepositoryImpl\.java$/.test(f.name))
    .map((f) => f.name);
  assert.deepEqual(pending, []);
});

test('el adaptador mapea sin la maquinaria de entidades gestionadas de JPA', () => {
  const { read } = scaffoldReports();
  const adapter = read(`${REPOS}/InspectionReportRepositoryImpl.java`);

  assert.ok(adapter.includes('private final InspectionReportMongoRepository inspectionReportMongoRepository'));
  assert.ok(adapter.includes('private InspectionReportDocument toDocument(InspectionReport domain)'));
  // Nada de merge sobre detached ni reconciliación de colecciones: el agregado es el
  // documento y se escribe entero de una vez.
  assert.ok(!adapter.includes('applyToJpa'));
  assert.ok(!adapter.includes('Managed'));
  // saveAndFlush no existe en MongoRepository, y no hace falta: la auditoría corre
  // en un callback antes de convertir, así que save() ya devuelve los valores nuevos
  // aunque el diseño proyecte createdAt/updatedAt al dominio (audit: declared).
  assert.ok(!adapter.includes('saveAndFlush'));
  assert.ok(adapter.includes('inspectionReportMongoRepository.save(toDocument(entity))'));

  // El desempate por id se conserva intacto: paginar sin orden total repite y omite
  // documentos entre páginas, y eso no depende del motor.
  assert.ok(adapter.includes('private static final Sort TIE_BREAKER = Sort.by(Sort.Order.asc("id"))'));
  assert.ok(adapter.includes('withStableOrder(pageable)'));

  // El orden de la colección hija lo restablece el MAPEO: donde JPA ponía @OrderBy
  // (lo aplicaba la consulta), un array de Mongo conserva el orden de inserción, que
  // tras un reorder ya no es el del diseño.
  assert.ok(adapter.includes('Comparator.comparing(ReportSectionDocument::getPosition)'));

  const repo = read(`${REPOS}/InspectionReportMongoRepository.java`);
  assert.ok(repo.includes('extends MongoRepository<InspectionReportDocument, UUID>'));
  // Buscador por clave natural derivado del diseño.
  assert.ok(repo.includes('findBySiteCodeAndInspectedOn'));

  // El puerto del dominio es el MISMO que en la rama relacional: lo que ve el
  // dominio no puede depender de dónde se guarda el agregado.
  const port = read(`${JAVA}/domain/repository/InspectionReportRepository.java`);
  assert.ok(!port.includes('Document'));
  assert.ok(!port.includes('Mongo'));
});

test('los índices salen del diseño y su nombre es un contrato con el ApiExceptionHandler', () => {
  const { read } = scaffoldReports();
  const indexes = read(`${CONFIG}/MongoIndexConfig.java`);

  // Clave natural compuesta, única y con el nombre que busca el handler.
  assert.ok(indexes.includes('.named("uk_inspection_reports_natural")'));
  assert.ok(indexes.includes('.on("site_code", Sort.Direction.ASC)'));
  assert.ok(indexes.includes('.on("inspected_on", Sort.Direction.ASC)'));
  assert.ok(indexes.includes('.unique()'));
  // Dot-path a una entidad hija anidada: indexable solo en este modelo, y sin
  // aplanar (en relacional la sección vive en otra tabla y no se alcanza).
  assert.ok(indexes.includes('.on("sections.status", Sort.Direction.ASC)'));
  // Índices de infraestructura: sin el del outbox, cada pasada del relay recorre la
  // colección entera para reclamar un lote.
  assert.ok(indexes.includes('.named("ix_outbox_event_pending")'));
  assert.ok(indexes.includes('.named("ix_processed_event_processed_at")'));

  // El contrato entre módulos: el mismo literal tiene que estar en el mapa que el
  // handler consulta, o la violación de unicidad saldría como 409 genérico.
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  assert.ok(handler.includes('uk_inspection_reports_natural'));
});

test('transaccionalidad: el gestor se genera, y el perfil test tiene el suyo', () => {
  const { read } = scaffoldReports();
  const config = read(`${CONFIG}/MongoTransactionConfig.java`);

  // Sin este bean el contexto NO arranca: el UseCaseMediator abre cada caso de uso
  // con un TransactionTemplate, y Boot no lo autoconfigura con el starter de Mongo.
  assert.ok(config.includes('new MongoTransactionManager(databaseFactory)'));
  assert.ok(config.includes('@Profile("!test")'));
  // Flapdoodle arranca standalone: un gestor real fallaría en la primera operación.
  assert.ok(config.includes('@Profile("test")'));
});

test('concurrencia y auditoría usan las anotaciones de Spring Data, no las de JPA', () => {
  const { read } = scaffoldReports();
  const report = read(`${DOCS}/InspectionReportDocument.java`);

  assert.ok(report.includes('import org.springframework.data.annotation.Version;'));
  assert.ok(report.includes('@Field(name = "lock_version")'));
  // audit.timestamps: declared → los campos son del dominio y se anotan aquí.
  assert.ok(report.includes('import org.springframework.data.annotation.CreatedDate;'));
  assert.ok(report.includes('@LastModifiedDate'));

  const application = read(`${JAVA}/InspectionReportsApplication.java`);
  assert.ok(application.includes('@EnableMongoAuditing'));
  assert.ok(!application.includes('@EnableJpaAuditing'));

  // Spring Data MongoDB lanza el padre, no ObjectOptimisticLockingFailureException.
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  assert.ok(handler.includes('org.springframework.dao.OptimisticLockingFailureException'));
  assert.ok(!handler.includes('ObjectOptimisticLockingFailureException'));
});

test('el outbox reclama con findAndModify: no hay lock pesimista de fila que sostener', () => {
  const { read } = scaffoldReports();
  const relay = read(`${JAVA}/infrastructure/messaging/outbox/OutboxRelay.java`);

  assert.ok(relay.includes('mongoTemplate.findAndModify('));
  assert.ok(relay.includes('Criteria.where("claimed_at")'));
  // La marca de reclamo CADUCA: un lock de BD se suelta al morir la conexión, una
  // marca en un documento no, y una réplica muerta retendría la fila para siempre.
  assert.ok(relay.includes('claim-timeout-ms'));
  assert.ok(!relay.includes('@Lock('));
  assert.ok(!relay.includes('PESSIMISTIC_WRITE'));

  const document = read(`${JAVA}/infrastructure/messaging/outbox/OutboxEventDocument.java`);
  assert.ok(document.includes('@Document(collection = "outbox_event")'));

  // El bridge escribe la fila en la misma transacción del cambio: solo cambia el
  // nombre del espejo, no su papel.
  const bridge = read(`${JAVA}/infrastructure/messaging/InspectionReportsDomainEventBridge.java`);
  assert.ok(bridge.includes('new OutboxEventDocument('));
});

test('la idempotencia inserta en vez de guardar: un save con _id presente reemplazaría en silencio', () => {
  const { read } = scaffoldReports();
  const guard = read(`${JAVA}/infrastructure/messaging/idempotency/IdempotencyGuard.java`);

  // Con save(), la segunda entrega del mismo mensaje pisaría el registro de la
  // primera y se procesaría otra vez: justo lo que este mecanismo existe para
  // impedir. Con insert(), el _id arbitra igual que la clave primaria.
  assert.ok(guard.includes('.insert(new ProcessedEventDocument(key, Instant.now()))'));
  assert.ok(!guard.includes('.save(new ProcessedEventDocument'));
  // DuplicateKeyException es una DataIntegrityViolationException: el catch vale igual.
  assert.ok(guard.includes('catch (DataIntegrityViolationException duplicate)'));
});

test('la infraestructura arranca como replica set y cada perfil usa su modo de conexión', () => {
  const { read, root } = scaffoldReports();

  // Las transacciones multi-documento (agregado + outbox en el mismo commit) solo
  // existen sobre un replica set, así que hasta la infra de prueba es uno.
  for (const compose of ['infra/docker-compose.yaml', 'deploy/docker-compose.yaml']) {
    const yaml = read(compose);
    assert.ok(yaml.includes('--replSet'), `${compose}: falta --replSet`);
    // El healthcheck además lo INICIA: un sidecar one-shot nunca llegaría a healthy
    // y deploy.js construye su depends_on recorriendo los servicios con healthcheck.
    assert.ok(yaml.includes('rs.initiate('), `${compose}: el healthcheck no inicia el conjunto`);
  }

  // Split-horizon: el miembro se anuncia como `db:27017`, que el host no resuelve.
  const local = read('src/main/resources/parameters/local/db.yaml');
  assert.ok(local.includes('directConnection=true'));
  assert.ok(local.includes('uuidRepresentation=standard'));
  // Los índices los crea MongoIndexConfig con SUS nombres; que Spring los infiera
  // rompería la traducción del handler.
  assert.ok(local.includes('auto-index-creation: false'));
  // Dentro de la red sí se resuelve `db`, y ahí conviene el conjunto completo.
  assert.ok(read('deploy/docker-compose.yaml').includes('replicaSet=rs0'));

  // Nada de JPA en la configuración tampoco.
  assert.ok(!local.includes('spring.jpa'));
  assert.ok(!local.includes('ddl-auto'));
  assert.ok(!read('src/main/resources/application.yaml').includes('open-in-view'));
});

test('sin Flyway: no hay esquema que migrar, y sí índices que exportar', () => {
  const { exists } = scaffoldReports();

  assert.ok(!exists('src/main/resources/db/migration/README.md'));
  assert.ok(!exists('infra/export-schema.sh'));
  assert.ok(!exists('src/main/resources/application-schema-export.yaml'));
  assert.ok(!exists('src/main/resources/application-migrations.yaml'));
  // Su equivalente, y la razón de que el pase de calidad sí pueda ejecutarlo: solo lee.
  assert.ok(exists('infra/export-indexes.sh'));
});

test('las dependencias y el perfil test siguen al modelo', () => {
  const { read } = scaffoldReports();
  const gradle = read('build.gradle');

  assert.ok(gradle.includes('spring-boot-starter-data-mongodb'));
  assert.ok(!gradle.includes('spring-boot-starter-data-jpa'));
  assert.ok(!gradle.includes('flyway'));
  assert.ok(!gradle.includes('com.h2database:h2'));
  assert.ok(gradle.includes('de.flapdoodle.embed.mongo.spring30x'));

  const testDb = read('src/main/resources/parameters/test/db.yaml');
  assert.ok(testDb.includes('flapdoodle'));
  assert.ok(!testDb.includes('jdbc:h2'));
});

test('se instala la skill del motor documental, no la relacional', () => {
  const { read, exists } = scaffoldReports();
  // El reset entre flujos sigue existiendo (mongodb declara cliResetCmd), así que el
  // arnés lo invoca en vez de recrear el contexto con @DirtiesContext.
  assert.ok(exists('infra/reset-db.sh'));
  const harness = read('src/integrationTest/java/com/example/inspectionreports/flows/AbstractFlowIT.java');
  assert.ok(harness.includes('infra/reset-db.sh'));
  assert.ok(!harness.includes('@DirtiesContext'));

  assert.ok(exists('.claude/skills/keel-spring-mongodb/SKILL.md'));
  assert.ok(!exists('.claude/skills/keel-spring-database/SKILL.md'));
});

test('ningún archivo importa una clase propia que no se generó', () => {
  // Guarda estructural: un import al propio paquete base que apunta a una clase
  // inexistente no compila. Para un renderizador nuevo es la red más rentable —
  // aquí cazaría, por ejemplo, un XxxDocument de value object que nadie emitió.
  const { javaFiles } = scaffoldReports();
  const files = javaFiles();
  const generated = new Set(files.map((f) => f.name.replace(/\.java$/, '')));

  const dangling = [];
  for (const file of files) {
    for (const match of file.content.matchAll(/^import com\.example\.inspectionreports\.[\w.]*?(\w+);$/gm)) {
      if (!generated.has(match[1])) dangling.push(`${file.name} → ${match[1]}`);
    }
  }

  assert.deepEqual(dangling, []);
});
