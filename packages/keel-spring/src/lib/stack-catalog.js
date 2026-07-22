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
//   alpinePackages   paquetes apk a instalar en devtools para esa CLI ([] si se
//                    instala por curl —sqlcmd, mc— o si basta la base).

export const DATABASES = {
  postgresql: {
    id: 'postgresql',
    label: 'PostgreSQL',
    gradleDependencies: ["runtimeOnly 'org.postgresql:postgresql'"],
    image: 'postgres:16-alpine',
    port: 5432,
    user: (db) => db,
    password: 'changeme',
    jdbcUrl: (db) => `jdbc:postgresql://localhost:5432/${db}`,
    serviceKey: 'db',
    cliTool: 'psql',
    cliVia: 'devtools',
    cliValidateCmd: "PGPASSWORD='{pass}' psql -h db -U {user} -d {db} -c 'SELECT 1' -q -t",
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
    gradleDependencies: ["runtimeOnly 'com.mysql:mysql-connector-j'"],
    image: 'mysql:8.0',
    port: 3306,
    user: (db) => db,
    password: 'changeme',
    jdbcUrl: (db) => `jdbc:mysql://localhost:3306/${db}`,
    serviceKey: 'db',
    cliTool: 'mysql',
    cliVia: 'devtools',
    cliValidateCmd: "mysql -h db -u {user} -p'{pass}' -e 'SELECT 1' {db}",
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
    gradleDependencies: ["runtimeOnly 'org.mariadb.jdbc:mariadb-java-client'"],
    image: 'mariadb:11',
    port: 3306,
    user: (db) => db,
    password: 'changeme',
    jdbcUrl: (db) => `jdbc:mariadb://localhost:3306/${db}`,
    serviceKey: 'db',
    cliTool: 'mariadb',
    cliVia: 'devtools',
    cliValidateCmd: "mariadb -h db -u {user} -p'{pass}' -e 'SELECT 1' {db}",
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
    gradleDependencies: ["runtimeOnly 'com.microsoft.sqlserver:mssql-jdbc'"],
    image: 'mcr.microsoft.com/mssql/server:2022-latest',
    port: 1433,
    user: () => 'sa',
    password: 'Str0ng_Passw0rd1',
    jdbcUrl: (db) => `jdbc:sqlserver://localhost:1433;databaseName=${db};encrypt=false`,
    serviceKey: 'db',
    cliTool: 'sqlcmd',
    // sqlcmd (go-sqlcmd) se instala por curl en devtools; no hay paquete apk.
    cliVia: 'devtools',
    cliValidateCmd: "sqlcmd -S db -U {user} -P '{pass}' -C -Q 'SELECT 1'",
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
    gradleDependencies: ["runtimeOnly 'com.oracle.database.jdbc:ojdbc11'"],
    image: 'gvenzl/oracle-free:23-slim',
    port: 1521,
    user: (db) => db,
    password: 'changeme',
    service: 'FREEPDB1',
    jdbcUrl: () => 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1',
    serviceKey: 'db',
    cliTool: 'sqlplus',
    // Oracle Instant Client es demasiado pesado para devtools: sqlplus ya viene
    // dentro del propio contenedor de Oracle, así que se valida ejecutando ahí.
    cliVia: 'dbcontainer',
    cliValidateCmd: "echo 'SELECT 1 FROM dual;' | sqlplus -s {user}/{pass}@//localhost:1521/{service}",
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
    gradleDependencies: ["runtimeOnly 'com.h2database:h2'"],
    image: null,
    port: null,
    user: () => 'sa',
    password: '',
    jdbcUrl: (db) => `jdbc:h2:mem:${db};MODE=LEGACY;DB_CLOSE_DELAY=-1`,
    // Sin serviceKey ⇒ no levanta contenedor ni entra en la validación de infra.
    cliVia: null,
    composeService: null
  }
};

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
    alpinePackages: ['aws-cli'],
    composeServices: () => ({
      localstack: {
        image: 'localstack/localstack:3.8',
        environment: { SERVICES: 'sns,sqs', DEBUG: '0', AWS_DEFAULT_REGION: 'us-east-1' },
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
  cognito: {
    id: 'cognito',
    label: 'Amazon Cognito (cognito-local de prueba)',
    gradleDependencies: [],
    image: 'jagregory/cognito-local:5.3.0',
    port: 9229,
    serviceKey: 'cognito',
    cliTool: 'curl',
    cliVia: 'devtools',
    cliValidateCmd: 'curl -sf http://cognito:9229/health',
    alpinePackages: [],
    composeServices: () => ({
      cognito: {
        image: 'jagregory/cognito-local:5.3.0',
        ports: ['9229:9229']
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
    composeServices: () => ({
      minio: {
        image: 'minio/minio:RELEASE.2024-10-13T13-34-11Z',
        command: 'server /data --console-address ":9001"',
        environment: { MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' },
        ports: ['9000:9000', '9001:9001'],
        volumes: ['minio-data:/data']
      }
    })
  },
  s3: {
    id: 's3',
    label: 'Amazon S3 (sin contenedor de prueba)',
    gradleDependencies: ["implementation 'software.amazon.awssdk:s3:2.31.6'"],
    cliVia: null,
    composeServices: () => ({})
  }
};

export const STACK_DEFAULTS = { database: 'postgresql', broker: 'kafka', auth: 'keycloak', cache: 'redis', storage: 'minio' };

// Índice de categoría → diccionario, para recorridos genéricos.
const CATALOG = { database: DATABASES, broker: BROKERS, auth: AUTH, cache: CACHES, storage: STORAGE };

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
    storage: layersPresent.storage ? stack.storage : null
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
