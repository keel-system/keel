// Tercera silueta documental, y la que cierra el hueco real del motor Mongo: lo que
// rodea al documento.
//
// document-persistence.test.js prueba la FORMA del documento (inspection-reports:
// anidamiento de dos niveles, value objects, dot-paths) y document-shape-coverage.test.js
// la forma opuesta (metering-digest sin api ni agregados). Ninguna de las dos declara
// security, cache, storage ni clientes salientes, así que todo lo transversal al stack
// —autoría auditada, reseteo del estado, registro de idempotencia de petición, índices
// sobre array y sobre referencia— solo se había generado nunca en la rama relacional.
//
// asset-vault las declara todas. Las aserciones de aquí son, casi todas, sobre código
// que hasta ahora no ejecutaba ningún test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asset-vault');
const PROJECT = path.join('services', 'asset-vault-spring');
const JAVA = 'src/main/java/com/content/assetvault';
const DOCS = `${JAVA}/infrastructure/persistence/documents`;

function scaffoldVault(stack = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-doc-transversal-');
  const result = scaffoldService({ manifest, layers, workspace, force: true, stack: { broker: 'kafka', ...stack } });
  const root = path.join(workspace, PROJECT);
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const exists = (relative) => fs.existsSync(path.join(root, relative));
  const allFiles = (relative) => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    return walk(path.join(root, relative)).map((file) => ({
      name: path.basename(file),
      content: fs.readFileSync(file, 'utf8')
    }));
  };
  return { result, read, exists, allFiles };
}

test('el motor documental sale del diseño, sin elegir base a mano', () => {
  // Sin `database` en el stack: lo decide `persistence.default.model` del diseño.
  const { read, exists } = scaffoldVault({ broker: undefined });
  assert.ok(read('build.gradle').includes('spring-boot-starter-data-mongodb'));
  assert.ok(exists(`${JAVA}/infrastructure/persistence/config/MongoIndexConfig.java`));
});

test('los índices cubren las tres formas de ruta del documento', () => {
  const { read } = scaffoldVault();
  const config = read(`${JAVA}/infrastructure/persistence/config/MongoIndexConfig.java`);

  // Clave natural COMPUESTA que atraviesa una referencia a otro agregado: la ruta es
  // la del id ajeno, no una asociación navegable.
  assert.match(config, /\.on\("owner_id", Sort\.Direction\.ASC\)\s+\.on\("slug", Sort\.Direction\.ASC\)\s+\.unique\(\)\s+\.named\("uk_assets_natural"\)/);
  // Campo `unique` suelto, que la clave natural no cubre.
  assert.match(config, /\.on\("checksum", Sort\.Direction\.ASC\)\s+\.unique\(\)\s+\.named\("uk_assets_checksum"\)/);
  // Array: en Mongo se indexa multikey, con la ruta del propio campo — sin tabla de
  // elementos, que es lo que haría la rama relacional.
  assert.match(config, /\.on\("labels", Sort\.Direction\.ASC\)\s+\.named\("idx_assets_labels"\)/);
  // Índice declarado sobre la relación: el diseño dice `owner`, el documento `owner_id`.
  assert.match(config, /\.on\("owner_id", Sort\.Direction\.ASC\)\s+\.named\("idx_assets_owner"\)/);
});

test('las tres colecciones de infraestructura llevan su índice', () => {
  const { read } = scaffoldVault();
  const config = read(`${JAVA}/infrastructure/persistence/config/MongoIndexConfig.java`);

  assert.ok(config.includes('mongoTemplate.indexOps("outbox_event")'));
  assert.ok(config.includes('"ix_outbox_event_pending"'));
  assert.ok(config.includes('mongoTemplate.indexOps("processed_event")'));
  assert.ok(config.includes('"ix_processed_event_processed_at"'));
  // El de la idempotencia de PETICIÓN: ninguna otra fixture documental declara
  // `use-cases.<op>.idempotency`, así que esta rama no se generaba en ningún test.
  assert.ok(config.includes('mongoTemplate.indexOps("idempotency_record")'));
  assert.ok(config.includes('"ix_idempotency_record_expires_at"'));
});

test('el nombre del índice único es el contrato que traduce el 409', () => {
  const { read } = scaffoldVault();
  const handler = read(`${JAVA}/infrastructure/rest/ApiExceptionHandler.java`);
  // Sin esta correspondencia, un E11000 del driver cae en el 409 genérico y el error
  // declarado del diseño no llega nunca al cliente. Y la clave natural de esta fixture
  // es compuesta y atraviesa una referencia, que es donde el nombre del índice y el
  // code del diseño tienen más formas de dejar de encajar.
  assert.ok(handler.includes('Map.entry("uk_assets_natural"'));
  assert.ok(handler.includes('AssetOwnerSlugAlreadyExistsError'));
  // Y el campo `unique` suelto, por el mismo camino declarado.
  assert.ok(handler.includes('Map.entry("uk_assets_checksum"'));
  assert.ok(handler.includes('AssetChecksumAlreadyExistsError'));
  // Son los errores DECLARADOS, no los codes de convención con su TODO.
  assert.ok(!/TODO[^\n]*\n[^\n]*unicidad de Asset\./.test(handler));
  // Y en documental el fallo de bloqueo optimista es el de Spring Data, no el de JPA.
  assert.ok(handler.includes('OptimisticLockingFailureException'));
  assert.ok(!handler.includes('ObjectOptimisticLockingFailureException'));
});

test('la autoría auditada llega al documento y tiene de dónde sacar el actor', () => {
  const { read, exists } = scaffoldVault();

  const auditable = read(`${DOCS}/AuditableDocument.java`);
  assert.ok(auditable.includes('@CreatedBy'));
  assert.ok(auditable.includes('@LastModifiedBy'));
  assert.ok(auditable.includes('org.springframework.data.annotation.CreatedBy'));
  // Solo las raíces heredan: la hija va anidada y Spring Data puebla el objeto que se
  // guarda, no lo anidado.
  assert.ok(read(`${DOCS}/AssetDocument.java`).includes('extends AuditableDocument'));
  assert.ok(!read(`${DOCS}/AssetRevisionDocument.java`).includes('extends AuditableDocument'));

  // Sin @EnableMongoAuditing las anotaciones no las lee nadie y las columnas quedan nulas.
  assert.ok(read(`${JAVA}/AssetVaultApplication.java`).includes('@EnableMongoAuditing'));
  assert.ok(exists(`${JAVA}/infrastructure/configurations/audit/AuditorAwareConfig.java`));
});

test('el registro de idempotencia de petición usa insert, no save', () => {
  const { read } = scaffoldVault();
  const store = read(`${JAVA}/infrastructure/persistence/idempotency/MongoIdempotencyStore.java`);
  // Un save con el _id ya presente REEMPLAZA en silencio: la segunda petición pisaría
  // el registro de la primera en vez de perder la carrera.
  assert.ok(store.includes('repository.insert('));
  assert.ok(!/repository\.save\(/.test(store));

  // Y retira el documento CADUCADO antes de insertar. `find` ya lo ignora por
  // caducado, así que sin esto el handler ejecuta y el insert choca contra un
  // documento que ya no protege nada: 409 IDEMPOTENCY_KEY_IN_PROGRESS hasta que la
  // purga pase (una vez al día), con la ventana real de deduplicación fijada por la
  // cadencia de la purga en vez de por el ttlSeconds del diseño. En la rama documental
  // este defecto es ORIGINAL —`insert` nunca lo tapó, al revés que el merge de JPA—,
  // así que estaba vivo en cualquier servicio documental con `idempotency`.
  assert.ok(store.includes('.filter(stored -> !stored.getExpiresAt().isAfter(now))'), store);
  assert.ok(store.includes('repository.deleteById(key)'), store);
});

test('reset-db.sh limpia por el contenedor de la base y no promete Hibernate', () => {
  const { read } = scaffoldVault();
  const reset = read('infra/reset-db.sh');

  // mongosh vive en la imagen de Mongo: la rama `dbcontainer` ejecuta en el contenedor
  // de la BD, no en el de devtools.
  assert.ok(reset.includes("exec 'asset-vault-db'"));
  assert.ok(reset.includes('deleteMany({})'));
  assert.ok(reset.includes('db.dropDatabase()'));
  // Y la caché, que en esta silueta también forma parte del estado del flujo.
  assert.ok(reset.includes("exec 'asset-vault-devtools'"));
  assert.ok(reset.includes('asset-vault:*'));
  // El modelo documental no tiene Hibernate ni ddl-auto: quien recrea colecciones e
  // índices al arrancar es MongoIndexConfig, y decir otra cosa manda al diseñador a
  // buscar una configuración que no existe.
  assert.ok(!/Hibernate|ddl-auto/.test(reset));
  assert.ok(reset.includes('MongoIndexConfig'));
});

test('validate-infra.sh sondea el replica set, no un ping', () => {
  const { read } = scaffoldVault();
  // Una base viva pero sin replica set acepta el ping y rechaza toda transacción: el
  // sondeo tiene que ser el que distingue esos dos estados.
  assert.match(read('infra/validate-infra.sh'), /rs\.status\(\)\.ok/);
});

test('export-indexes.sh solo lee, y deja el volcado donde el agente lo busca', () => {
  const { read } = scaffoldVault();
  const script = read('infra/export-indexes.sh');
  assert.ok(script.includes('build/schema/indexes.json'));
  assert.ok(script.includes('getIndexes()'));
  assert.ok(script.includes("exec -i \"asset-vault-db\""));
  // Ni arranca la aplicación ni escribe: por eso el agente de calidad sí puede
  // ejecutarlo contra la misma base sobre la que corre su no-regresión.
  assert.ok(!/dropDatabase|deleteMany|gradlew/.test(script));
});

test('el compose de despliegue trae Mongo con replica set, su UI y sin credenciales sueltas', () => {
  const { read } = scaffoldVault();
  const compose = read('deploy/docker-compose.yaml');
  const env = read('deploy/.env');

  // En documental las credenciales viajan dentro de la URI: emitirlas aparte daría dos
  // fuentes para el mismo dato.
  assert.ok(!compose.includes('DB_USERNAME'));
  assert.ok(!compose.includes('DB_PASSWORD'));
  assert.match(compose, /DB_URL: mongodb:\/\/asset_vault:changeme@db:27017\/asset_vault\?[^\n]*replicaSet=rs0/);
  // El healthcheck es también quien inicia el replica set: un sidecar one-shot nunca
  // llegaría a `healthy`, y `depends_on: service_healthy` se quedaría esperando.
  assert.ok(compose.includes('rs.initiate('));
  // Y el replica set arranca CON keyFile. Sin él mongod ni siquiera levanta
  // («security.keyFile is required when authorization is enabled with replica sets»):
  // el contenedor muere con exit 2 y todo lo demás falla por conexión rechazada, que
  // es un síntoma que no apunta a su causa.
  assert.ok(compose.includes('--keyFile /data/keyfile'));
  assert.ok(compose.includes('exec docker-entrypoint.sh mongod'));
  // Mongo es la primera base con UI de inspección propia.
  assert.ok(compose.includes('mongo-express:1.0.2'));
  assert.ok(env.includes('MONGO_EXPRESS_PORT='));
});

test('la infraestructura de prueba arranca el replica set igual que la de despliegue', () => {
  const { read } = scaffoldVault();
  const compose = read('infra/docker-compose.yaml');
  // Son dos composes distintos con el mismo servicio de base: lo que arregla a uno
  // tiene que arreglar al otro, o el pipeline pasa contra una infra que el diseñador
  // no puede levantar (o al revés).
  assert.ok(compose.includes('--replSet rs0'));
  assert.ok(compose.includes('--keyFile /data/keyfile'));
  assert.ok(compose.includes('chmod 400 /data/keyfile'));
  assert.ok(compose.includes('rs.initiate('));
});

test('el arnés resetea el estado con el script y sabe subir un binario', () => {
  const { read } = scaffoldVault();
  const harness = read('src/integrationTest/java/com/content/assetvault/flows/AbstractFlowIT.java');
  // En documental no hay @DirtiesContext que valga: el estado vive fuera de la JVM.
  assert.ok(harness.includes('infra/reset-db.sh'));
  assert.ok(!harness.includes('@DirtiesContext'));
  // La superficie que esta fixture estrena en documental: multipart y token por rol.
  assert.ok(harness.includes('protected Response multipart('));
  assert.ok(harness.includes('protected String tokenFor(String role)'));
  assert.ok(harness.includes('infra/test-credentials.env'));
});

test('el arnés alcanza la base por su propio contenedor, no por el toolbox', () => {
  const { read } = scaffoldVault();
  const harness = read('src/integrationTest/java/com/content/assetvault/flows/AbstractFlowIT.java');

  // mongosh no está en el toolbox (no hay paquete apk y el tarball pesa más que la
  // imagen entera): vive dentro del contenedor de la propia base, igual que sqlplus
  // con Oracle. Esa regla ya la aplican validate-infra.sh y reset-db.sh, y escribirla
  // a mano en cada clase de prueba es justo lo que dejaba a Mongo inalcanzable.
  assert.ok(harness.includes('private static final String DB_CONTAINER = "asset-vault-db";'));
  assert.ok(harness.includes('protected static String db(String... argv)'));
  assert.ok(harness.includes('protected static String dbShell(String command)'));
  // El javadoc trae la invocación concreta del motor, copiada de la del catálogo:
  // sin ella el agente tiene que deducir credenciales y URI.
  assert.ok(harness.includes('mongodb://asset_vault:changeme@localhost:27017/asset_vault'));
});

test('nada del proyecto documental habla de JPA, Flyway ni H2', () => {
  const { read, exists, allFiles } = scaffoldVault();

  const java = allFiles('src/main/java').concat(allFiles('src/integrationTest/java'));
  assert.deepEqual(
    java.filter((f) => /jakarta\.persistence|org\.hibernate/.test(f.content)).map((f) => f.name),
    []
  );
  assert.ok(!/flyway|hibernate-|com\.h2database/.test(read('build.gradle')));
  assert.ok(read('build.gradle').includes('de.flapdoodle.embed.mongo.spring3x:'));

  // Los artefactos del esquema relacional no existen: aquí el esquema son los índices.
  assert.ok(!exists('infra/export-schema.sh'));
  assert.ok(!exists('src/main/resources/db/migration'));
  assert.ok(!exists('src/main/resources/parameters/migrations'));
  assert.ok(exists('infra/export-indexes.sh'));
});

test('ningún archivo importa una clase propia que no se generó', () => {
  const { allFiles } = scaffoldVault();
  const files = allFiles('src/main/java').concat(allFiles('src/integrationTest/java'));
  const generated = new Set(files.map((f) => f.name.replace(/\.java$/, '')));

  const dangling = [];
  for (const file of files) {
    for (const match of file.content.matchAll(/^import (?:static )?com\.content\.assetvault\.[\w.]*?(\w+);$/gm)) {
      if (!generated.has(match[1])) dangling.push(`${file.name} → ${match[1]}`);
    }
  }
  assert.deepEqual(dangling, []);
});

// ── Corrida del pipeline completo (INFORME-CORRIDA-ASSET-VAULT.md) ────────────
//
// Los cuatro defectos que solo aparecieron al arrancar de verdad el servidor
// documental contra la infraestructura real. Ninguno los veía la suite de
// cadenas, ni `compile-check` (que solo compila el arnés), ni `broker-check`
// (que no levanta la JVM): tres tumbaban el arranque o corrompían datos y el
// cuarto impedía que ninguna prueba de integración llegara a ejecutarse.

test('el finder de una clave natural que atraviesa una referencia usa la propiedad real', () => {
  const { read } = scaffoldVault();

  // El diseño dice `naturalKey: [owner, slug]`, pero ni el dominio ni el documento
  // tienen propiedad `owner`: guardan `ownerId`, un UUID. Spring Data valida los
  // finders derivados al construir el contexto, así que el nombre equivocado no
  // rompe la compilación — tumba el ARRANQUE con PropertyReferenceException.
  const mongoRepo = read(`${JAVA}/infrastructure/persistence/repositories/AssetMongoRepository.java`);
  assert.ok(mongoRepo.includes('findByOwnerIdAndSlug(UUID ownerId, String slug)'));
  assert.ok(!/findByOwnerAndSlug/.test(mongoRepo));

  // Y el puerto del dominio declara la misma firma: es el mismo finder.
  const port = read(`${JAVA}/domain/repository/AssetRepository.java`);
  assert.ok(port.includes('findByOwnerIdAndSlug(UUID ownerId, String slug)'));
  assert.ok(!/findByOwnerAndSlug|String owner\b/.test(port));
});

test('guardar una raíz ya existente arrastra la auditoría de creación', () => {
  const { read } = scaffoldVault();

  // Mongo REEMPLAZA el documento entero, y el callback de auditoría solo estampa
  // @CreatedDate/@CreatedBy cuando es nuevo: sin releer el que había, cada
  // actualización dejaba created_at/created_by a null, contra lo que `audit: all`
  // promete. No tiene equivalente relacional (allí el merge de JPA los conserva).
  const auditable = read(`${DOCS}/AuditableDocument.java`);
  assert.ok(auditable.includes('public void carryCreationAudit(Instant createdAt, String createdBy)'));

  for (const root of ['Asset', 'Owner']) {
    const adapter = read(`${JAVA}/infrastructure/persistence/repositories/${root}RepositoryImpl.java`);
    assert.match(
      adapter,
      /\.findById\(entity\.getId\(\)\)\s+\.ifPresent\(existing -> document\.carryCreationAudit\(existing\.getCreatedAt\(\), existing\.getCreatedBy\(\)\)\);/,
      `${root}RepositoryImpl: falta el arrastre de la auditoría de creación`
    );
  }
});

test('un campo de subida no lleva una restricción de cadena', () => {
  const { read } = scaffoldVault();
  // @NotBlank es de CharSequence: sobre un componente FileUpload no falla al
  // compilar, revienta al validar. Y hay que corregir las DOS listas de
  // anotaciones — el DTO se anota desde `validation` y el command desde
  // `inputValidation`—, que es justo lo que se había quedado a medias.
  const command = read(`${JAVA}/application/commands/UploadAssetCommand.java`);
  assert.ok(command.includes('@NotNull FileUpload binary'));

  // Y en ningún otro sitio: la entrada multipart no genera DTO de petición (el
  // controller enlaza las partes contra el propio command), pero la regla vale
  // para cualquier archivo que llegue a nombrar el tipo.
  const { allFiles } = scaffoldVault();
  assert.deepEqual(
    allFiles('src/main/java')
      .filter((f) => /@NotBlank\s+FileUpload/.test(f.content))
      .map((f) => f.name),
    []
  );
});

test('el mongod embebido no entra en el classpath de las pruebas de integración', () => {
  const { read } = scaffoldVault();
  const gradle = read('build.gradle');

  // El source set integrationTest hereda las dependencias de test, donde vive el
  // mongod embebido (la base del perfil `test`). Con él en el classpath, su
  // autoconfiguración se activa TAMBIÉN bajo el perfil `local` de las IT y
  // sustituye la conexión al Mongo real de infra/: el contexto no arranca y la
  // suite entera queda sin ejecutar (score-scenarios.sh sale con 2).
  assert.ok(gradle.includes("integrationTestImplementation.exclude group: 'de.flapdoodle.embed'"));
  assert.ok(gradle.includes("integrationTestRuntimeOnly.exclude group: 'de.flapdoodle.embed'"));
  // Sigue estando en `test`, que es donde sí es la base del perfil.
  assert.ok(gradle.includes("testImplementation 'de.flapdoodle.embed:de.flapdoodle.embed.mongo.spring3x:"));
});

// La caducidad del reclamo solo existe en la rama documental: ahí el relay marca la
// fila (claimed_at) en vez de bloquearla, así que una réplica que muere la retendría
// para siempre. Vivía únicamente como default del @Value, es decir, como un parámetro
// que nadie sabía que podía tocar — y es justo el que fija la ventana en la que dos
// réplicas pueden entregar la misma fila.
test('la caducidad del reclamo del relay se parametriza por perfil', () => {
  const { read } = scaffoldVault();

  const local = read('src/main/resources/parameters/local/messaging.yaml');
  assert.ok(local.includes('claim-timeout-ms: 60000'), local);
  for (const profile of ['develop', 'production', 'test']) {
    const yaml = read(`src/main/resources/parameters/${profile}/messaging.yaml`);
    assert.ok(yaml.includes('${OUTBOX_RELAY_CLAIM_TIMEOUT_MS:'), `${profile}: sin env para el claim`);
  }

  // Y el nombre coincide con lo que el relay lee: un parámetro emitido con otra clave
  // sería un valor que se puede editar sin que nada lo aplique.
  const relay = read(`${JAVA}/infrastructure/messaging/outbox/OutboxRelay.java`);
  assert.ok(relay.includes('${outbox.relay.claim-timeout-ms:'));
});
