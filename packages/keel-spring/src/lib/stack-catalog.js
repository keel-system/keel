// Catálogo de tecnologías del generador (patrón del stack-catalog de referencia):
// cada opción concentra sus dependencias Gradle, su configuración de datasource,
// su servicio de docker-compose y su receta de validación por CLI (cliTool /
// cliVia / cliValidateCmd) que ejecuta el agente desde el contenedor devtools.
// El cuestionario de build elige entre estas opciones (Object.values); los
// defaults son los de conventions/project-layout.md.
//
// Campos de validación (comunes a todas las categorías):
//   serviceKey       clave del servicio en el docker-compose (hostname en-red);
//                    ausente ⇒ la opción no levanta contenedor (h2, s3…).
//   cliTool          nombre legible de la CLI usada para sondear el servicio.
//   cliVia           'devtools' (la CLI vive en el toolbox), 'dbcontainer' (se
//                    ejecuta dentro del propio contenedor) o null (sin sondeo).
//   cliValidateCmd   comando de sondeo con placeholders {user} {pass} {db}
//                    {service}; los hostnames apuntan al serviceKey (red interna).
//   cliQueryArgv     (solo BD) la MISMA invocación, pero como lista de argumentos y
//                    sin la consulta: lo que el arnés de integración pasa a
//                    `db(String... argv)` para ejecutar una sentencia arbitraria. No
//                    es un duplicado de cliValidateCmd por comodidad — son dos formas
//                    con dos destinos: cliValidateCmd va a un script `sh` (donde el
//                    prefijo de entorno y los pipes son del shell) y cliQueryArgv va a
//                    ProcessBuilder, donde NO hay shell que interprete nada. Es la
//                    diferencia que ha costado un ciclo completo de generación en dos
//                    corridas seguidas: una sentencia con comillas armada como cadena
//                    para `sh -c` la reescribe `podman.exe`/`docker.exe` en Windows
//                    antes de que llegue al contenedor, y del SQL solo sobrevive un
//                    fragmento. El prefijo de entorno se resuelve con `env VAR=valor`,
//                    que es un ejecutable y no una construcción del shell.
//
// composeServices(model) recibe el modelo para las opciones cuyo contenedor
// depende del diseño y no solo del stack (hoy, el sidecar de buckets de MinIO);
// el resto lo ignora.

import { declaredBuckets } from './buckets.js';

// Credenciales de la infraestructura de prueba local (LocalStack y MinIO las
// ignoran; el SDK y la AWS CLI exigen que EXISTAN). Van al contenedor devtools
// —de donde salen `aws sns …` / `aws sqs …` en validate-infra.sh, reset-db.sh,
// init-messaging.sh y el arnés de integración—, no solo a la config de la app:
// sin ellas la CLI aborta con "Unable to locate credentials" aunque el servicio
// responda perfectamente, y el check sale en rojo por un motivo que no es el suyo.
export const LOCAL_AWS_ENV = {
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_DEFAULT_REGION: 'us-east-1'
};
//   cliResetCmd      (solo BD) comando que VACÍA LOS DATOS preservando el esquema
//                    (los Given de los flujos FL-* asumen BD limpia); mismos
//                    placeholders y mismo cliVia que cliValidateCmd. Ausente ⇒
//                    sin reset-db.sh (h2: reiniciar la app recrea el esquema).
//                    SIEMPRE excluye flyway_schema_history: es el historial de
//                    migraciones, no datos del servicio; truncarlo haría que el
//                    siguiente arranque reaplicase el baseline sobre tablas ya
//                    existentes y fallara.
//   flywayDependencies  (solo BD relacional) módulo Flyway del motor (Flyway 10+
//                    saca cada dialecto de flyway-core a su propio artefacto). Sin
//                    versión: la gestiona el dependency management de Spring Boot.
//                    Ausente en las BD documentales, que no tienen esquema que migrar.
//   alpinePackages   paquetes apk a instalar en devtools para esa CLI ([] si se
//                    instala por curl —sqlcmd, mc— o si basta la base).
//   kind             (solo BD) 'relational' | 'document'. Discrimina qué modelo de
//                    persistencia genera el scaffolding, y lo elige el DISEÑO
//                    (persistence.default.model), no el cuestionario: con
//                    `document` solo se ofrecen las entradas documentales y con
//                    `relational` solo las relacionales. Todo lo que recorre
//                    DATABASES para levantar y sondear infraestructura
//                    (selectedInfra, docker.js, devtools.js, deploy.js) lee campos
//                    comunes y no necesita mirar este campo: por eso hay una sola
//                    tabla y no dos.

// Motor de migraciones (común a los seis dialectos relacionales) + su módulo por motor.
const FLYWAY_CORE = "implementation 'org.flywaydb:flyway-core'";

const MONGO_IMAGE = 'mongo:7';

export const DATABASES = {
  postgresql: {
    id: 'postgresql',
    label: 'PostgreSQL',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'org.postgresql:postgresql'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-database-postgresql'"],
    image: 'postgres:16-alpine',
    port: 5432,
    user: (db) => db,
    password: 'changeme',
    url: (db) => `jdbc:postgresql://localhost:5432/${db}`,
    serviceKey: 'db',
    cliTool: 'psql',
    cliVia: 'devtools',
    cliValidateCmd: "PGPASSWORD='{pass}' psql -h db -U {user} -d {db} -c 'SELECT 1' -q -t",
    cliQueryArgv: ({ user, pass, db }) => [
      'env', `PGPASSWORD=${pass}`, 'psql', '-h', 'db', '-U', user, '-d', db,
      '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c'
    ],
    cliResetCmd:
      "PGPASSWORD='{pass}' psql -h db -U {user} -d {db} -v ON_ERROR_STOP=1 -q -c \"DO \\$\\$ DECLARE stmt text; BEGIN SELECT 'TRUNCATE TABLE ' || string_agg(quote_ident(tablename), ', ') || ' RESTART IDENTITY CASCADE' INTO stmt FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'flyway_schema_history'; IF stmt IS NOT NULL THEN EXECUTE stmt; END IF; END \\$\\$;\"",
    cliDropSchemaCmd:
      "PGPASSWORD='{pass}' psql -h db -U {user} -d {db} -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'",
    alpinePackages: ['postgresql-client'],
    composeService: (db) => ({
      image: 'postgres:16-alpine',
      environment: { POSTGRES_DB: db, POSTGRES_USER: db, POSTGRES_PASSWORD: 'changeme' },
      ports: ['5432:5432'],
      volumes: ['db-data:/var/lib/postgresql/data']
    })
  },
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'com.mysql:mysql-connector-j'"],
    // MySQL y MariaDB comparten módulo Flyway (flyway-mysql).
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-mysql'"],
    image: 'mysql:8.0',
    port: 3306,
    user: (db) => db,
    password: 'changeme',
    url: (db) => `jdbc:mysql://localhost:3306/${db}`,
    serviceKey: 'db',
    cliTool: 'mysql',
    cliVia: 'devtools',
    cliValidateCmd: "mysql -h db -u {user} -p'{pass}' -e 'SELECT 1' {db}",
    // `-p` va PEGADO a la contraseña: separado, mysql lo lee como «pídemela por
    // terminal» y el proceso se queda esperando una entrada que nunca llega.
    cliQueryArgv: ({ user, pass, db }) => ['mysql', '-h', 'db', '-u', user, `-p${pass}`, '-N', '-B', db, '-e'],
    cliResetCmd:
      "mysql -h db -u {user} -p'{pass}' -N -B -e 'SELECT CONCAT(\"TRUNCATE TABLE \", table_name, \";\") FROM information_schema.tables WHERE table_schema = \"{db}\" AND table_name <> \"flyway_schema_history\"' | mysql -h db -u {user} -p'{pass}' --init-command='SET FOREIGN_KEY_CHECKS=0' {db}",
    cliDropSchemaCmd:
      "mysql -h db -u {user} -p'{pass}' -N -B -e 'SELECT CONCAT(\"DROP TABLE IF EXISTS \", table_name, \";\") FROM information_schema.tables WHERE table_schema = \"{db}\"' | mysql -h db -u {user} -p'{pass}' --init-command='SET FOREIGN_KEY_CHECKS=0' {db}",
    alpinePackages: ['mysql-client'],
    composeService: (db) => ({
      image: 'mysql:8.0',
      environment: {
        MYSQL_DATABASE: db,
        MYSQL_USER: db,
        MYSQL_PASSWORD: 'changeme',
        MYSQL_ROOT_PASSWORD: 'changeme'
      },
      ports: ['3306:3306'],
      volumes: ['db-data:/var/lib/mysql']
    })
  },
  mariadb: {
    id: 'mariadb',
    label: 'MariaDB',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'org.mariadb.jdbc:mariadb-java-client'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-mysql'"],
    image: 'mariadb:11',
    port: 3306,
    user: (db) => db,
    password: 'changeme',
    url: (db) => `jdbc:mariadb://localhost:3306/${db}`,
    serviceKey: 'db',
    cliTool: 'mariadb',
    cliVia: 'devtools',
    cliValidateCmd: "mariadb -h db -u {user} -p'{pass}' -e 'SELECT 1' {db}",
    cliQueryArgv: ({ user, pass, db }) => ['mariadb', '-h', 'db', '-u', user, `-p${pass}`, '-N', '-B', db, '-e'],
    cliResetCmd:
      "mariadb -h db -u {user} -p'{pass}' -N -B -e 'SELECT CONCAT(\"TRUNCATE TABLE \", table_name, \";\") FROM information_schema.tables WHERE table_schema = \"{db}\" AND table_name <> \"flyway_schema_history\"' | mariadb -h db -u {user} -p'{pass}' --init-command='SET FOREIGN_KEY_CHECKS=0' {db}",
    cliDropSchemaCmd:
      "mariadb -h db -u {user} -p'{pass}' -N -B -e 'SELECT CONCAT(\"DROP TABLE IF EXISTS \", table_name, \";\") FROM information_schema.tables WHERE table_schema = \"{db}\"' | mariadb -h db -u {user} -p'{pass}' --init-command='SET FOREIGN_KEY_CHECKS=0' {db}",
    alpinePackages: ['mariadb-client'],
    composeService: (db) => ({
      image: 'mariadb:11',
      environment: {
        MARIADB_DATABASE: db,
        MARIADB_USER: db,
        MARIADB_PASSWORD: 'changeme',
        MARIADB_ROOT_PASSWORD: 'changeme'
      },
      ports: ['3306:3306'],
      volumes: ['db-data:/var/lib/mysql']
    })
  },
  sqlserver: {
    id: 'sqlserver',
    label: 'SQL Server',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'com.microsoft.sqlserver:mssql-jdbc'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-sqlserver'"],
    image: 'mcr.microsoft.com/mssql/server:2022-latest',
    port: 1433,
    user: () => 'sa',
    password: 'Str0ng_Passw0rd1',
    url: (db) => `jdbc:sqlserver://localhost:1433;databaseName=${db};encrypt=false`,
    serviceKey: 'db',
    cliTool: 'sqlcmd',
    // sqlcmd (go-sqlcmd) se instala por curl en devtools; no hay paquete apk.
    cliVia: 'devtools',
    cliValidateCmd: "sqlcmd -S db -U {user} -P '{pass}' -C -Q 'SELECT 1'",
    cliQueryArgv: ({ user, pass, db }) => ['sqlcmd', '-S', 'db', '-U', user, '-P', pass, '-C', '-d', db, '-h', '-1', '-W', '-Q'],
    cliResetCmd:
      "sqlcmd -S db -U {user} -P '{pass}' -C -d {db} -Q \"EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL'; EXEC sp_MSforeachtable @command1 = 'DELETE FROM ?', @whereand = 'AND o.name <> ''flyway_schema_history'''; EXEC sp_MSforeachtable 'ALTER TABLE ? WITH CHECK CHECK CONSTRAINT ALL'\"",
    cliDropSchemaCmd:
      "sqlcmd -S db -U {user} -P '{pass}' -C -d {db} -Q \"EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL'; EXEC sp_MSforeachtable 'DROP TABLE ?'\"",
    alpinePackages: [],
    composeService: () => ({
      image: 'mcr.microsoft.com/mssql/server:2022-latest',
      environment: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: 'Str0ng_Passw0rd1', MSSQL_PID: 'Developer' },
      ports: ['1433:1433'],
      volumes: ['db-data:/var/opt/mssql'],
      healthcheck: {
        test: [
          'CMD-SHELL',
          '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$$MSSQL_SA_PASSWORD" -C -Q \'SELECT 1\' || exit 1'
        ],
        interval: '10s',
        timeout: '5s',
        retries: 10
      }
    })
  },
  oracle: {
    id: 'oracle',
    label: 'Oracle Database Free',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'com.oracle.database.jdbc:ojdbc11'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-database-oracle'"],
    image: 'gvenzl/oracle-free:23-slim',
    port: 1521,
    user: (db) => db,
    password: 'changeme',
    service: 'FREEPDB1',
    url: () => 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
    serviceKey: 'db',
    cliTool: 'sqlplus',
    // Oracle Instant Client es demasiado pesado para devtools: sqlplus ya viene
    // dentro del propio contenedor de Oracle, así que se valida ejecutando ahí.
    cliVia: 'dbcontainer',
    cliValidateCmd: "echo 'SELECT 1 FROM dual;' | sqlplus -s {user}/{pass}@//localhost:1521/{service}",
    cliResetCmd:
      // UPPER(): en Oracle el historial puede quedar como identificador citado en
      // minúsculas ("flyway_schema_history") o en mayúsculas según la versión.
      'printf "BEGIN FOR t IN (SELECT table_name FROM user_tables WHERE UPPER(table_name) <> \'FLYWAY_SCHEMA_HISTORY\') LOOP EXECUTE IMMEDIATE \'TRUNCATE TABLE \' || t.table_name || \' CASCADE\'; END LOOP; END;\\n/\\n" | sqlplus -s {user}/{pass}@//localhost:1521/{service}',
    cliDropSchemaCmd:
      'printf "BEGIN FOR t IN (SELECT table_name FROM user_tables) LOOP EXECUTE IMMEDIATE \'DROP TABLE \' || t.table_name || \' CASCADE CONSTRAINTS\'; END LOOP; FOR s IN (SELECT sequence_name FROM user_sequences) LOOP EXECUTE IMMEDIATE \'DROP SEQUENCE \' || s.sequence_name; END LOOP; END;\\n/\\n" | sqlplus -s {user}/{pass}@//localhost:1521/{service}',
    alpinePackages: [],
    composeService: (db) => ({
      image: 'gvenzl/oracle-free:23-slim',
      environment: { ORACLE_PASSWORD: 'changeme', APP_USER: db, APP_USER_PASSWORD: 'changeme' },
      ports: ['1521:1521'],
      volumes: ['db-data:/opt/oracle/oradata']
    })
  },
  h2: {
    id: 'h2',
    label: 'H2 (en memoria, sin contenedor)',
    kind: 'relational',
    gradleDependencies: ["runtimeOnly 'com.h2database:h2'"],
    // H2 sigue soportado dentro de flyway-core: no tiene módulo propio.
    flywayDependencies: [FLYWAY_CORE],
    image: null,
    port: null,
    user: () => 'sa',
    password: '',
    url: (db) => `jdbc:h2:mem:${db};MODE=LEGACY;DB_CLOSE_DELAY=-1`,
    // Sin serviceKey ⇒ no levanta contenedor ni entra en la validación de infra.
    cliVia: null,
    composeService: null
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    kind: 'document',
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-mongodb'"],
    // Sin flywayDependencies a propósito (ausente, no []): en el modelo documental
    // no hay esquema que migrar. Los índices los crea MongoIndexConfig, que build
    // deriva entero de persistence.keel.yaml.
    image: MONGO_IMAGE,
    port: 27017,
    user: (db) => db,
    password: 'changeme',
    // La app corre en el HOST y el miembro del replica set se anuncia como
    // `db:27017` (nombre de la red de compose), que el host no resuelve:
    // directConnection=true corta el descubrimiento de topología y habla con el
    // miembro al que ya está conectada. Las transacciones funcionan igual —lo que
    // exigen es que el servidor SEA miembro de un replica set, no que el driver
    // descubra el conjunto—. uuidRepresentation va en la URI para que también lo
    // honre cualquier cliente que se construya a mano.
    url: (db) =>
      `mongodb://${db}:changeme@localhost:27017/${db}?authSource=admin&directConnection=true&uuidRepresentation=standard`,
    // Desde DENTRO de la red de compose (deploy/) sí se resuelve `db`, así que ahí
    // se usa el replica set completo y el driver puede reconectar tras un failover.
    internalUrl: (db) =>
      `mongodb://${db}:changeme@db:27017/${db}?authSource=admin&replicaSet=rs0&uuidRepresentation=standard`,
    serviceKey: 'db',
    cliTool: 'mongosh',
    // mongosh no tiene paquete apk y el tarball oficial pesa más que la imagen de
    // devtools entera; ya viene dentro de la imagen de Mongo, así que se valida
    // ahí — mismo motivo y mismo mecanismo que Oracle con sqlplus.
    cliVia: 'dbcontainer',
    // Se sondea rs.status() y no un ping, a propósito: una base que responde al ping
    // pero cuyo replica set no ha arrancado pasaría el check y fallaría en la primera
    // transacción —justo el falso positivo que la validación de infra existe para
    // cazar—. rs.status() lanza mientras el conjunto no exista, así que el fallo sale
    // aquí y no tres fases más tarde.
    cliValidateCmd:
      "mongosh 'mongodb://{user}:{pass}@localhost:27017/{db}?authSource=admin&directConnection=true' --quiet --eval 'rs.status().ok'",
    cliQueryArgv: ({ user, pass, db }) => [
      'mongosh',
      `mongodb://${user}:${pass}@localhost:27017/${db}?authSource=admin&directConnection=true`,
      '--quiet', '--eval'
    ],
    // Vacía los documentos preservando colecciones e ÍNDICES: los índices son el
    // equivalente del esquema aquí, y recrearlos en cada flujo sería el error
    // simétrico a truncar flyway_schema_history en la rama relacional. No hay
    // historial de migraciones que excluir porque no hay migraciones.
    cliResetCmd:
      "mongosh 'mongodb://{user}:{pass}@localhost:27017/{db}?authSource=admin&directConnection=true' --quiet --eval 'db.getCollectionNames().forEach(function (c) { db.getCollection(c).deleteMany({}); })'",
    // El equivalente de --schema: borra la base entera, índices incluidos.
    // MongoIndexConfig los recrea en el siguiente arranque.
    cliDropSchemaCmd:
      "mongosh 'mongodb://{user}:{pass}@localhost:27017/{db}?authSource=admin&directConnection=true' --quiet --eval 'db.dropDatabase()'",
    alpinePackages: [],
    composeService: (db) => ({
      image: MONGO_IMAGE,
      // Las transacciones multi-documento (agregado + outbox_event en el mismo
      // commit) SOLO existen sobre un replica set, así que hasta la infraestructura
      // de prueba arranca como uno de un solo miembro.
      //
      // Y un replica set CON autenticación exige autenticación entre miembros, que
      // mongod solo acepta por keyFile: sin él no arranca siquiera —«security.keyFile
      // is required when authorization is enabled with replica sets»— y el contenedor
      // muere con exit 2 antes del primer sondeo. El secreto se genera en el arranque
      // y no se persiste a propósito: con un solo miembro solo se usa para hablar
      // consigo mismo, así que regenerarlo en cada arranque no rompe nada y evita
      // meter un secreto en el repo. El `exec docker-entrypoint.sh` conserva el
      // arranque de la imagen oficial —es quien crea el usuario root a partir de las
      // MONGO_INITDB_*— y el chown es necesario porque mongod exige que el keyFile
      // sea suyo y solo suyo (0400).
      command: [
        'bash',
        '-c',
        [
          'openssl rand -base64 756 > /data/keyfile',
          'chmod 400 /data/keyfile',
          'chown mongodb:mongodb /data/keyfile',
          'exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /data/keyfile --bind_ip_all'
        ].join(' && ')
      ],
      environment: {
        MONGO_INITDB_ROOT_USERNAME: db,
        MONGO_INITDB_ROOT_PASSWORD: 'changeme',
        MONGO_INITDB_DATABASE: db
      },
      ports: ['27017:27017'],
      volumes: ['db-data:/data/db'],
      healthcheck: mongoHealthcheck(db)
    })
  }
};

/**
 * Healthcheck que además INICIA el replica set, y es idempotente: `rs.status()`
 * lanza mientras el conjunto no existe, y el catch lo inicia; en las pasadas
 * siguientes devuelve ok y no toca nada.
 *
 * Va aquí y no en un contenedor `mongo-init` aparte porque un sidecar one-shot
 * nunca llega a `healthy`, y deploy.js construye su `depends_on: service_healthy`
 * recorriendo los servicios con healthcheck: la app arrancaría contra una base sin
 * replica set iniciado y moriría en la primera transacción. Con esto, arranque y
 * espera son la misma pieza, igual en infra/ que en deploy/.
 */
function mongoHealthcheck(db) {
  const init = `rs.initiate({_id:'rs0',members:[{_id:0,host:'db:27017'}]}).ok`;
  return {
    test: [
      'CMD-SHELL',
      `mongosh -u ${db} -p changeme --authenticationDatabase admin --quiet --eval "try { rs.status().ok } catch (e) { ${init} }" | grep -q 1`
    ],
    interval: '5s',
    timeout: '5s',
    retries: 30
  };
}

// Aislamiento de la mensajería entre flujos de validación. `cliPurgeCmd` es la
// primitiva que vacía un destino ({destination}) desde el contenedor devtools:
// la ejecuta infra/reset-db.sh por cada canal declarado, igual que ya hace con la
// BD y la caché. Sin ella, publishedMessages(...) devuelve mensajes de corridas
// anteriores (RabbitMQ sirve desde la CABEZA de la cola, así que basta con unas
// pocas sesiones acumuladas para que nada de lo que se lee sea del escenario en
// curso). Kafka no tiene purga con kcat: su aislamiento es una marca de offset
// que vive en el proceso de test (ver AbstractFlowIT), no en el script.
/**
 * Nombre del contenedor del broker en infra/docker-compose.yaml. Fuente única de
 * docker.js (que lo estampa como `container_name`) y del arnés de integración (que
 * lo detiene y lo levanta en los escenarios de outbox): si cada uno lo compusiera
 * por su cuenta, el día que cambie el patrón el arnés detendría un contenedor que
 * no existe y el fallo saldría como un timeout, muy lejos de su causa.
 */
export function brokerContainer(serviceName, broker) {
  return `${serviceName}-${broker.serviceKey}`;
}

export const BROKERS = {
  kafka: {
    id: 'kafka',
    label: 'Apache Kafka',
    gradleDependencies: [
      "implementation 'org.springframework.kafka:spring-kafka'",
      "testImplementation 'org.springframework.kafka:spring-kafka-test'"
    ],
    image: 'apache/kafka:3.8.0',
    port: '9092 (host) / 29092 (red)',
    serviceKey: 'kafka',
    cliTool: 'kcat',
    cliVia: 'devtools',
    // El listener interno kafka:29092 es el alcanzable desde la red de compose.
    cliValidateCmd: 'kcat -b kafka:29092 -L',
    // Sin purga: kcat no borra registros y devtools no trae las CLIs de Kafka. El
    // aislamiento lo da la marca de offset de AbstractFlowIT.
    cliPurgeCmd: null,
    alpinePackages: ['kcat'],
    // KRaft single-node con doble listener: EXTERNAL (localhost:9092) para la app
    // en el host e INTERNAL (kafka:29092) para clientes dentro de la red (devtools).
    composeServices: () => ({
      kafka: {
        image: 'apache/kafka:3.8.0',
        environment: {
          KAFKA_NODE_ID: 1,
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
          KAFKA_LISTENERS: 'INTERNAL://0.0.0.0:29092,EXTERNAL://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
          KAFKA_ADVERTISED_LISTENERS: 'INTERNAL://kafka:29092,EXTERNAL://localhost:9092',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT',
          KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
        },
        ports: ['9092:9092']
      }
    })
  },
  rabbitmq: {
    id: 'rabbitmq',
    label: 'RabbitMQ',
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-amqp'"],
    image: 'rabbitmq:4-management',
    port: '5672 / 15672 (UI)',
    serviceKey: 'rabbitmq',
    cliTool: 'curl (management API)',
    cliVia: 'devtools',
    cliValidateCmd: 'curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node',
    // Vacía la cola por la management API. Un 404 (la cola aún no existe porque la
    // app no ha arrancado nunca) no es un fallo del reset: el script lo tolera.
    cliPurgeCmd:
      'curl -sf -u guest:guest -XDELETE http://rabbitmq:15672/api/queues/%2F/{destination}/contents',
    alpinePackages: [],
    composeServices: () => ({
      rabbitmq: {
        image: 'rabbitmq:4-management',
        environment: { RABBITMQ_DEFAULT_USER: 'guest', RABBITMQ_DEFAULT_PASS: 'guest' },
        ports: ['5672:5672', '15672:15672']
      }
    })
  },
  snssqs: {
    id: 'snssqs',
    label: 'Amazon SNS/SQS (LocalStack de prueba)',
    // BOM de Spring Cloud AWS + starters SNS y SQS (mismo SDK contra LocalStack y AWS real).
    gradleDependencies: [
      "implementation platform('io.awspring.cloud:spring-cloud-aws-dependencies:3.3.0')",
      "implementation 'io.awspring.cloud:spring-cloud-aws-starter-sns'",
      "implementation 'io.awspring.cloud:spring-cloud-aws-starter-sqs'"
    ],
    image: 'localstack/localstack:3.8',
    port: 4566,
    serviceKey: 'localstack',
    cliTool: 'aws',
    cliVia: 'devtools',
    cliValidateCmd: 'aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics',
    // PurgeQueue de SQS. En AWS real está limitada a una vez cada 60 s por cola;
    // LocalStack no aplica esa cuota, pero el script tolera el fallo por si acaso.
    cliPurgeCmd:
      'aws --endpoint-url http://localstack:4566 --region us-east-1 sqs purge-queue --queue-url http://localstack:4566/000000000000/{destination}',
    alpinePackages: ['aws-cli'],
    composeServices: () => ({
      localstack: {
        image: 'localstack/localstack:3.8',
        environment: { SERVICES: 'sns,sqs', DEBUG: '0', ...LOCAL_AWS_ENV },
        ports: ['4566:4566']
      }
    })
  }
};

export const AUTH = {
  keycloak: {
    id: 'keycloak',
    label: 'Keycloak (contenedor de prueba)',
    gradleDependencies: [],
    image: 'quay.io/keycloak/keycloak:26.3.1',
    port: 8180,
    serviceKey: 'keycloak',
    cliTool: 'curl',
    cliVia: 'devtools',
    cliValidateCmd: 'curl -sf http://keycloak:8080/realms/master',
    alpinePackages: [],
    composeServices: () => ({
      keycloak: {
        image: 'quay.io/keycloak/keycloak:26.3.1',
        command: 'start-dev',
        environment: {
          KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
          KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
          KC_HTTP_ENABLED: 'true'
        },
        ports: ['8180:8080']
      }
    })
  },
  // Amazon Cognito. En LOCAL no se levanta Cognito ni un emulador de su API: se
  // levanta un servidor OAuth2 que emite tokens con la FORMA de los de Cognito.
  //
  // El servicio generado es un resource server puro —nunca llama a la API de
  // administración de Cognito—, así que lo único que consume es el token: JWKS,
  // `iss`, `exp` y los claims (`cognito:groups`, `scope`, `client_id`). Emular esa
  // superficie cubre el diseño entero; emular la API de AWS, no: cognito-local (y
  // moto) solo implementan `USER_PASSWORD_AUTH`, así que con ellos la mitad M2M del
  // diseño se queda sin poder ejercitarse, y el pool id lo generan ellos, lo que
  // además deja el issuer sin ser determinista. LocalStack sí lo cubre entero, pero
  // Cognito está en sus planes de pago.
  //
  // Lo que esto NO prueba, y por eso el label lo dice: el mock no valida contraseñas
  // (autenticar no es responsabilidad del servicio generado) ni emula el alta de
  // pools, grupos y usuarios (eso se valida contra Cognito real, ver la skill).
  cognito: {
    id: 'cognito',
    label: 'Amazon Cognito (contrato de token emulado en local con mock-oauth2-server)',
    gradleDependencies: [],
    image: 'ghcr.io/navikt/mock-oauth2-server:6.0.1',
    port: 9229,
    serviceKey: 'cognito-mock',
    cliTool: 'curl',
    cliVia: 'devtools',
    // /isalive, no /health: es el endpoint que usa el propio compose de la imagen. Con /health
    // contesta 405 y el sondeo da un falso negativo sobre un emulador que está sirviendo bien.
    cliValidateCmd: 'curl -sf http://cognito-mock:8080/isalive',
    alpinePackages: [],
    // El issuerId es el primer segmento de la ruta, y de él cuelgan `/token`,
    // `/jwks` y el descubrimiento. El config lo genera build desde el diseño
    // (auth-provisioning.js), igual que el realm de Keycloak.
    composeServices: () => ({
      'cognito-mock': {
        image: 'ghcr.io/navikt/mock-oauth2-server:6.0.1',
        environment: { JSON_CONFIG_PATH: '/cognito/mock-oauth2-config.json' },
        volumes: ['./cognito/mock-oauth2-config.json:/cognito/mock-oauth2-config.json:ro'],
        ports: ['9229:8080']
      }
    })
  },
  none: {
    id: 'none',
    label: 'Ninguno (solo placeholder issuer-uri)',
    gradleDependencies: [],
    cliVia: null,
    composeServices: () => ({})
  }
};

export const CACHES = {
  redis: {
    id: 'redis',
    label: 'Redis',
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-redis'"],
    image: 'redis:7-alpine',
    port: 6379,
    serviceKey: 'redis',
    cliTool: 'redis-cli',
    cliVia: 'devtools',
    cliValidateCmd: 'redis-cli -h redis PING',
    alpinePackages: ['redis'],
    composeServices: () => ({
      redis: {
        image: 'redis:7-alpine',
        ports: ['6379:6379']
      }
    })
  },
  valkey: {
    id: 'valkey',
    label: 'Valkey (compatible Redis)',
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-redis'"],
    image: 'valkey/valkey:8-alpine',
    port: 6379,
    serviceKey: 'valkey',
    cliTool: 'redis-cli',
    cliVia: 'devtools',
    cliValidateCmd: 'redis-cli -h valkey PING',
    alpinePackages: ['redis'],
    composeServices: () => ({
      valkey: {
        image: 'valkey/valkey:8-alpine',
        ports: ['6379:6379']
      }
    })
  }
};

// Sidecar que deja el MinIO de prueba con los buckets del diseño ya creados y
// con su policy aplicada, antes de que arranque el servicio.
//
// Por qué aquí y no en un @PostConstruct del adaptador: crear el bucket del
// ENTORNO DE PRUEBA es infraestructura, y la infraestructura la genera build.
// Dejarlo en el código de aplicación lo convertía en algo que el agente tenía
// que acordarse de escribir, y su ausencia solo se descubría en la validación
// funcional —bloqueando en cascada toda la superficie que sube o lee ficheros—
// después de haber gastado un ciclo entero. El adaptador sigue necesitando su
// propio ensureBucket/ensurePublicRead idempotente para los entornos reales,
// donde no hay compose que valga (ver la skill keel-spring-s3).
//
// Todo el script es idempotente: `mb --ignore-existing` no falla si el bucket
// ya está, y `anonymous set download` reescribe la policy completa.
function minioInitService(buckets) {
  const steps = buckets.flatMap((bucket) => {
    const lines = [`mc mb --ignore-existing local/${bucket.physicalName};`];
    if (bucket.visibility === 'public') {
      // Crear el bucket no lo hace público: MinIO y S3 los crean privados, y sin
      // esto la subida responde 201 y la lectura directa de la URL, 403.
      lines.push(`mc anonymous set download local/${bucket.physicalName};`);
    }
    return lines;
  });
  const script = [
    'until mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null 2>&1; do sleep 1; done;',
    ...steps,
    'mc ls local;'
  ].join('\n');

  // Sin `restart`: corre una vez y termina, que es el default de compose. Declarar
  // `restart: "no"` explícitamente lo rompía en podman-compose, que lee el YAML con
  // su propio parser (el `no` sin comillas es el booleano false de YAML) y aborta
  // con «"False" is not a valid restart policy» — el sidecar no llegaba a crearse y
  // toda la superficie que sube o lee ficheros quedaba bloqueada. `infra/` declara
  // podman como runtime de primera clase (conventions/infra-validation.md), así que
  // el compose generado no puede depender de una extensión de docker-compose.
  return {
    image: 'minio/mc:RELEASE.2024-10-08T09-37-26Z',
    depends_on: ['minio'],
    entrypoint: ['sh', '-c', script + '\n']
  };
}

export const STORAGE = {
  minio: {
    id: 'minio',
    label: 'MinIO (compatible S3, contenedor de prueba)',
    // MinIO habla protocolo S3: el mismo SDK sirve para dev (MinIO) y prod (S3).
    gradleDependencies: ["implementation 'software.amazon.awssdk:s3:2.31.6'"],
    image: 'minio/minio:RELEASE.2024-10-13T13-34-11Z',
    port: '9000 / 9001 (consola)',
    serviceKey: 'minio',
    cliTool: 'mc',
    // mc (MinIO client) se instala por curl en devtools; no hay paquete apk.
    cliVia: 'devtools',
    cliValidateCmd: 'mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null && mc ready local',
    alpinePackages: [],
    composeServices: (model) => {
      const services = {
        minio: {
          image: 'minio/minio:RELEASE.2024-10-13T13-34-11Z',
          command: 'server /data --console-address ":9001"',
          environment: { MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' },
          ports: ['9000:9000', '9001:9001'],
          volumes: ['minio-data:/data']
        }
      };
      const buckets = model ? declaredBuckets(model) : [];
      if (buckets.length > 0) services['minio-init'] = minioInitService(buckets);
      return services;
    }
  },
  s3: {
    id: 's3',
    label: 'Amazon S3 (sin contenedor de prueba)',
    gradleDependencies: ["implementation 'software.amazon.awssdk:s3:2.31.6'"],
    cliVia: null,
    composeServices: () => ({})
  }
};

// ─── Proveedores de prueba de las integraciones salientes ────────────────────
//
// Un servicio que depende de otro por HTTP no tiene con quién hablar en `infra/`:
// el proveedor real no está, y sin él ningún escenario FL-* que atraviese un
// cliente de la capa `http-clients` se puede puntuar — falla por conexión
// rechazada, que no dice nada sobre el código. WireMock lo cierra hablando el
// mismo protocolo por el mismo socket que hablaría el proveedor: la prueba sigue
// siendo de caja negra. No es un doble en el sentido que prohíbe
// conventions/integration-tests.md (@MockBean, @EmbeddedKafka): esos sustituyen
// la fontanería DENTRO de la JVM; esto es un proceso aparte, exactamente igual
// que LocalStack sustituye a SNS/SQS.
//
// No es una elección de stack: no entra en CATALOG ni en STACK_DEFAULTS ni en el
// cuestionario. Se gatea por diseño (capa http-clients), como la skill
// keel-spring-httpclient.
export const HTTP_STUB = {
  id: 'wiremock',
  label: 'WireMock (proveedor de prueba de las integraciones salientes)',
  image: 'wiremock/wiremock:3.13.1',
  port: 8080,
  publishedPort: 8090,
  serviceKey: 'wiremock',
  cliTool: 'curl',
  cliVia: 'devtools',
  // /__admin/mappings responde 200 en cuanto el admin API está en pie, sin
  // depender de qué versión introdujo /__admin/health.
  cliValidateCmd: 'curl -sf -o /dev/null http://wiremock:8080/__admin/mappings',
  // Deja el stub como recién arrancado: borra los mappings programados por el
  // flujo anterior y el log de peticiones que verifican los tests.
  cliResetCmd: 'curl -sf -o /dev/null -XPOST http://wiremock:8080/__admin/reset',
  composeServices: () => ({
    wiremock: {
      image: 'wiremock/wiremock:3.13.1',
      // --verbose deja en el log qué petición no casó con ningún mapping, que es
      // el diagnóstico que hace falta cuando un escenario falla contra el stub.
      command: ['--verbose', '--global-response-templating'],
      ports: ['8090:8080'],
      volumes: ['./http-stubs:/home/wiremock:z']
    }
  })
};

export const STACK_DEFAULTS = {
  database: 'postgresql',
  // Default de la rama documental. No es una segunda pregunta: el diseño elige el
  // modelo (persistence.default.model) y el cuestionario solo ofrece las opciones
  // de ESE modelo, así que un servicio nunca tiene ambos defaults en juego.
  documentDatabase: 'mongodb',
  broker: 'kafka',
  auth: 'keycloak',
  cache: 'redis',
  storage: 'minio'
};

/**
 * Motores que puede elegir un diseño según su `persistence.default.model`.
 * El modelo lo declara el DISEÑO y el stack solo elige dentro de él: ofrecer
 * PostgreSQL a un diseño `document` haría que el campo del DSL no significara nada.
 * Cualquier valor que no sea 'document' se trata como relacional (es el default
 * del schema y el modelo de los seis dialectos históricos).
 */
export function databasesForModel(persistenceModel) {
  const kind = persistenceModel === 'document' ? 'document' : 'relational';
  return Object.values(DATABASES).filter((entry) => entry.kind === kind);
}

/** Motor por defecto para un `persistence.default.model` dado. */
export function defaultDatabaseFor(persistenceModel) {
  return persistenceModel === 'document' ? STACK_DEFAULTS.documentDatabase : STACK_DEFAULTS.database;
}

// Índice de categoría → diccionario, para recorridos genéricos.
const CATALOG = {
  database: DATABASES,
  broker: BROKERS,
  auth: AUTH,
  cache: CACHES,
  storage: STORAGE,
  httpStub: { wiremock: HTTP_STUB }
};

/**
 * Tecnologías elegidas que levantan contenedor (con su metadata de validación),
 * derivadas del modelo. Fuente única para docker.js, devtools.js y readme.js:
 * evita que la lista de infraestructura se desincronice entre generadores.
 * Devuelve `[{ category, id, entry, serviceKey, cliVia }]`; omite las opciones
 * sin contenedor (h2, s3, auth 'none').
 */
export function selectedInfra(model) {
  const { layersPresent, stack } = model;
  const chosen = {
    database: layersPresent.persistence ? stack.database : null,
    broker: layersPresent.messaging ? stack.broker : null,
    auth: stack.auth && stack.auth !== 'none' ? stack.auth : null,
    cache: stack.cache,
    storage: layersPresent.storage ? stack.storage : null,
    // Gateado por diseño, no por stack: si hay integraciones salientes hace
    // falta con quién hablar en la infraestructura de prueba.
    httpStub: layersPresent.httpClients ? HTTP_STUB.id : null
  };

  const infra = [];
  for (const [category, id] of Object.entries(chosen)) {
    if (!id) continue;
    const entry = CATALOG[category][id];
    if (!entry?.serviceKey) continue; // opción sin contenedor
    infra.push({ category, id, entry, serviceKey: entry.serviceKey, cliVia: entry.cliVia ?? null });
  }
  return infra;
}

// ─── Solo para deploy/ (pruebas manuales) ────────────────────────────────────
//
// Las dos tablas de abajo las consume ÚNICAMENTE scaffold/deploy.js. No entran en
// infra/docker-compose.yaml, y es deliberado: ahí la espera a que un servicio esté
// listo ya la resuelve el bucle de reintentos de validate-infra.sh, y el agente de
// infraestructura sabe leer un FALLO transitorio. En deploy/ no hay agente: el
// contenedor de la app arranca solo y necesita `depends_on: service_healthy` para
// no morir contra una BD que todavía no acepta conexiones.

/**
 * Healthcheck por tecnología, para el `depends_on` del servicio `app` en deploy/.
 * El comando se ejecuta DENTRO del contenedor sondeado, así que solo usa
 * herramientas que trae su propia imagen (no las de devtools, que en deploy/ no
 * existe). Honrado igual por docker y por podman.
 *
 * sqlserver y mongodb no aparecen: sus composeService ya declaran el suyo (el de
 * Mongo, además, inicia el replica set, así que tiene que ser el mismo en infra/).
 */
export const HEALTHCHECKS = {
  postgresql: (db) => ({
    test: ['CMD-SHELL', `pg_isready -U ${db} -d ${db}`],
    interval: '5s',
    timeout: '5s',
    retries: 20
  }),
  mysql: () => ({
    test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 --silent'],
    interval: '5s',
    timeout: '5s',
    retries: 30
  }),
  mariadb: () => ({
    test: ['CMD-SHELL', 'healthcheck.sh --connect --innodb_initialized'],
    interval: '5s',
    timeout: '5s',
    retries: 30
  }),
  oracle: () => ({
    // La imagen gvenzl trae su propio healthcheck.sh; Oracle tarda minutos en la
    // primera pasada, de ahí el start_period largo.
    test: ['CMD-SHELL', 'healthcheck.sh'],
    interval: '10s',
    timeout: '10s',
    retries: 30,
    start_period: '60s'
  }),
  kafka: () => ({
    test: ['CMD-SHELL', '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list'],
    interval: '10s',
    timeout: '10s',
    retries: 20
  }),
  rabbitmq: () => ({
    test: ['CMD-SHELL', 'rabbitmq-diagnostics -q ping'],
    interval: '10s',
    timeout: '10s',
    retries: 20
  }),
  snssqs: () => ({
    test: ['CMD-SHELL', 'curl -sf http://localhost:4566/_localstack/health'],
    interval: '5s',
    timeout: '5s',
    retries: 30
  }),
  keycloak: () => ({
    // La imagen de Keycloak 26 no trae curl ni wget (UBI micro): el sondeo va por
    // el /dev/tcp de bash contra el puerto de management, que KC_HEALTH_ENABLED
    // abre en el 9000. Es el patrón que documenta el propio proyecto.
    test: [
      'CMD-SHELL',
      "exec 3<>/dev/tcp/localhost/9000 && echo -e 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && cat <&3 | grep -q '\"status\": \"UP\"'"
    ],
    interval: '5s',
    timeout: '5s',
    retries: 40
  }),
  redis: () => ({
    test: ['CMD-SHELL', 'redis-cli ping'],
    interval: '5s',
    timeout: '5s',
    retries: 20
  }),
  valkey: () => ({
    test: ['CMD-SHELL', 'valkey-cli ping'],
    interval: '5s',
    timeout: '5s',
    retries: 20
  }),
  minio: () => ({
    test: ['CMD-SHELL', 'curl -sf http://localhost:9000/minio/health/live'],
    interval: '5s',
    timeout: '5s',
    retries: 20
  })
};

/**
 * UIs de inspección que se añaden SOLO al compose de pruebas manuales, para que el
 * diseñador pueda mirar por dentro lo que la API no le enseña (qué mensajes
 * salieron, qué claves quedaron en caché). Mismo estilo que composeServices.
 *
 * No hay entrada para rabbitmq, minio ni keycloak: sus consolas ya vienen en la
 * propia imagen (15672, 9001, 8180) y añadir un contenedor sería duplicarlas. Se
 * documentan en el README, que es donde el diseñador las busca.
 *
 * mongodb es la primera BD con entrada aquí, y es coherente con la regla: los
 * motores relacionales se inspeccionan con la CLI que devtools ya trae, pero un
 * documento anidado en una terminal es justo lo que esta tabla existe para evitar.
 */
export const UI_SERVICES = {
  kafka: () => ({
    'kafka-ui': {
      image: 'provectuslabs/kafka-ui:v0.7.2',
      environment: {
        KAFKA_CLUSTERS_0_NAME: 'local',
        // El listener interno: kafka-ui vive dentro de la red, como devtools.
        KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: 'kafka:29092',
        DYNAMIC_CONFIG_ENABLED: 'true'
      },
      ports: ['${KAFKA_UI_PORT:-8081}:8080'],
      depends_on: ['kafka']
    }
  }),
  redis: () => ({ redisinsight: redisInsightService('redis') }),
  valkey: () => ({ redisinsight: redisInsightService('valkey') }),
  mongodb: (db) => ({
    'mongo-express': {
      image: 'mongo-express:1.0.2',
      environment: {
        ME_CONFIG_MONGODB_URL: `mongodb://${db}:changeme@db:27017/?authSource=admin&replicaSet=rs0`,
        ME_CONFIG_BASICAUTH: 'false'
      },
      ports: ['${MONGO_EXPRESS_PORT:-8082}:8081'],
      depends_on: ['db']
    }
  })
};

function redisInsightService(serviceKey) {
  return {
    image: 'redis/redisinsight:2.62',
    ports: ['${REDISINSIGHT_PORT:-5540}:5540'],
    depends_on: [serviceKey]
  };
}
