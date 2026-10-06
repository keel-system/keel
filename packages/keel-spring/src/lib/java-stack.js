// Lo que cada opción del stack añade al proyecto JAVA: sus dependencias de Gradle, el módulo de
// Flyway del motor y la cadena de conexión que lee Spring.
//
// La infraestructura de cada opción (imagen, puertos, compose, sondeo, healthcheck) es neutral y
// vive en keel-core/gen/infra-catalog.js, que se reexporta como stack-catalog.js. Aquí solo queda
// lo que cambia si el servidor no es Spring: las claves son los mismos `id` del catálogo, y
// `test/stack.test.js` comprueba que no sobra ni falta ninguna.

// Motor de migraciones (común a los seis dialectos relacionales) + su módulo por motor.
const FLYWAY_CORE = "implementation 'org.flywaydb:flyway-core'";

// gradleDependencies     dependencias del starter/driver de la opción.
// flywayDependencies     (solo BD relacional) módulo Flyway del motor (Flyway 10+ saca cada
//                        dialecto de flyway-core a su propio artefacto). Sin versión: la gestiona
//                        el dependency management de Spring Boot. Ausente en las BD documentales,
//                        que no tienen esquema que migrar.
// url / internalUrl      cadena de conexión de Spring, vista desde el HOST y (si difiere en algo
//                        más que el host) desde DENTRO de la red de compose de deploy/.
export const JAVA_DATABASES = {
  postgresql: {
    gradleDependencies: ["runtimeOnly 'org.postgresql:postgresql'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-database-postgresql'"],
    url: (db) => `jdbc:postgresql://localhost:5432/${db}`
  },
  mysql: {
    gradleDependencies: ["runtimeOnly 'com.mysql:mysql-connector-j'"],
    // MySQL y MariaDB comparten módulo Flyway (flyway-mysql).
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-mysql'"],
    url: (db) => `jdbc:mysql://localhost:3306/${db}`
  },
  mariadb: {
    gradleDependencies: ["runtimeOnly 'org.mariadb.jdbc:mariadb-java-client'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-mysql'"],
    url: (db) => `jdbc:mariadb://localhost:3306/${db}`
  },
  sqlserver: {
    gradleDependencies: ["runtimeOnly 'com.microsoft.sqlserver:mssql-jdbc'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-sqlserver'"],
    url: (db) => `jdbc:sqlserver://localhost:1433;databaseName=${db};encrypt=false`
  },
  oracle: {
    gradleDependencies: ["runtimeOnly 'com.oracle.database.jdbc:ojdbc11'"],
    flywayDependencies: [FLYWAY_CORE, "runtimeOnly 'org.flywaydb:flyway-database-oracle'"],
    url: () => 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1'
  },
  mongodb: {
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-mongodb'"],
    // Sin flywayDependencies a propósito (ausente, no []): en el modelo documental
    // no hay esquema que migrar. Los índices los crea MongoIndexConfig, que build
    // deriva entero de persistence.keel.yaml.
    //
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
      `mongodb://${db}:changeme@db:27017/${db}?authSource=admin&replicaSet=rs0&uuidRepresentation=standard`
  }
};

export const JAVA_BROKERS = {
  kafka: {
    gradleDependencies: [
      "implementation 'org.springframework.kafka:spring-kafka'",
      "testImplementation 'org.springframework.kafka:spring-kafka-test'"
    ]
  },
  rabbitmq: {
    gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-amqp'"]
  },
  snssqs: {
    // BOM de Spring Cloud AWS + starters SNS y SQS (mismo SDK contra LocalStack y AWS real).
    gradleDependencies: [
      "implementation platform('io.awspring.cloud:spring-cloud-aws-dependencies:3.3.0')",
      "implementation 'io.awspring.cloud:spring-cloud-aws-starter-sns'",
      "implementation 'io.awspring.cloud:spring-cloud-aws-starter-sqs'"
    ]
  }
};

// Sin tabla para los proveedores de identidad: ninguno añade dependencias propias, porque el
// resource server de Spring Security es el mismo para todos (lo añade gradle.js con la capa
// security).

export const JAVA_CACHES = {
  redis: { gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-redis'"] },
  valkey: { gradleDependencies: ["implementation 'org.springframework.boot:spring-boot-starter-data-redis'"] }
};

export const JAVA_STORAGE = {
  minio: { gradleDependencies: ["implementation 'software.amazon.awssdk:s3:2.31.6'"] },
  s3: { gradleDependencies: ["implementation 'software.amazon.awssdk:s3:2.31.6'"] }
};
