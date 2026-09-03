// Configuración multi-ambiente del servicio generado (patrón del proyecto de
// referencia): application.yaml base + application-<perfil>.yaml que solo
// importa fragmentos parameters/<perfil>/*.yaml, con gradiente de env vars
// (local literal → develop ${VAR:default} → production ${VAR} obligatoria).
// El perfil activo se elige con la variable de entorno PROFILE (default local).

import { AUTH, DATABASES, HTTP_STUB } from '../lib/stack-catalog.js';
import { usesPartialIndexes } from './migrations.js';
import { EMBEDDED_MONGO_VERSION } from '../lib/assets.js';
import { physicalBucketName } from '../lib/buckets.js';
import { kebabCase, screamingSnake } from '../lib/naming.js';
import { subscriptionDestination } from '../lib/dead-letter.js';
import { recordedFailures } from '../lib/outbound-failures.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { usesCorrelation } from './correlation.js';
import { SWEEP_BATCH_DEFAULT } from './claim.js';

const PROFILES = ['local', 'develop', 'production'];

// Credenciales de juguete del perfil local (mismo criterio que minioadmin en el
// compose de prueba): existen para que los escenarios de validación autentiquen
// sin editar YAML a mano, y nunca salen de local.
// Se exportan porque el compose de pruebas manuales (scaffold/deploy.js) tiene que
// pasar EXACTAMENTE estos valores por entorno: el perfil `develop` con el que corre
// el contenedor declara estas claves como obligatorias y sin default, así que un
// literal reinventado allí no daría un 401 raro — impediría arrancar la app.
export const LOCAL_API_KEY = 'local-dev-api-key';
export const localClientApiKey = (clientName) => `local-${clientName}-key`;

// El proveedor de prueba del perfil local: el WireMock que levanta infra/ cuando
// el diseño trae capa http-clients. Constante y no literal repetido porque son
// DOS los sitios que tienen que apuntar al mismo sitio —la base-url de cada
// cliente y el endpoint de token de los oauth2—, y basta con que uno se quede
// atrás para que en local se hable con dos proveedores distintos.
export const LOCAL_STUB_BASE_URL = `http://localhost:${HTTP_STUB.publishedPort}`;

// Orígenes CORS del perfil local: los puertos de dev habituales de una SPA
// (Create React App / Next.js y Vite), para probar un front sin editar YAML.
export const LOCAL_CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173';

// Gradiente de externalización: literal en local, env var con default en
// develop y env var obligatoria (sin default) en production. `test` es literal
// como local: es un perfil cerrado (H2, sin infra externa) que debe arrancar sin
// que nadie exporte nada.
function envValue(profile, varName, localValue) {
  if (profile === 'local' || profile === 'test') return String(localValue);
  if (profile === 'develop') return `\${${varName}:${localValue}}`;
  return `\${${varName}}`;
}

// Variante para valores operativos que no son secretos ni endpoints (niveles de
// log, group-id): parametrizados en todos los ambientes, pero siempre con
// default, porque su ausencia no debe impedir el arranque.
function envWithDefault(profile, varName, localValue) {
  if (profile === 'local') return String(localValue);
  return `\${${varName}:${localValue}}`;
}

// Variante para expresiones cron. No basta con envWithDefault: la expresión hay
// que entrecomillarla en YAML (empieza por dígito y lleva '*'), y si las comillas
// van DENTRO del default del placeholder pasan a formar parte del valor —
// `${VAR:"0 0 4 * * *"}` resuelve a `"0 0 4 * * *"` con las comillas incluidas y
// Spring rechaza el @Scheduled al arrancar ("invalid cron expression"). Así que
// se entrecomilla el escalar entero y el default va desnudo.
function cronWithDefault(profile, varName, cron) {
  return profile === 'local' ? `"${cron}"` : `"\${${varName}:${cron}}"`;
}

// Variante para valores que NO tienen un default razonable fuera de local (el
// diseño no los declara): literal en local y env var obligatoria en el resto,
// para fallar al arrancar en vez de apuntar en silencio a un destino erróneo.
function envRequired(profile, varName, localValue) {
  if (profile === 'local') return String(localValue);
  return `\${${varName}}`;
}

export function generate(model) {
  const { service, layersPresent, stack } = model;
  const dbName = service.name.replace(/-/g, '_');
  const files = [];

  files.push({ path: 'src/main/resources/application.yaml', content: baseYaml(model) });

  for (const profile of PROFILES) {
    const fragments = [];

    fragments.push(fragment(profile, 'logging', loggingYaml(model, profile)));
    // Actuator: transversal al stack, siempre presente. Health con probes de
    // liveness/readiness para Kubernetes; el detalle del health solo se muestra
    // fuera de production.
    fragments.push(fragment(profile, 'management', managementYaml(profile)));
    if (layersPresent.persistence) {
      fragments.push(fragment(profile, 'db', dbYaml(model, profile, dbName)));
    }
    if (layersPresent.messaging && stack.broker) {
      fragments.push(fragment(profile, stack.broker, brokerYaml(model, profile)));
    }
    // Enrutado de publicación (destino + clave por evento) y, si el diseño
    // declara reliability: outbox, cadencia del relay y retención de la purga.
    // También la purga del registro de idempotencia del lado consumidor.
    if (messagingApplies(model)) {
      fragments.push(fragment(profile, 'messaging', messagingYaml(model, profile)));
    }
    // Purga del registro de idempotencia de comando (cabecera Idempotency-Key).
    // Va aparte del fragmento messaging porque no depende de la capa messaging:
    // un diseño puede declarar idempotencia sin publicar ni consumir nada.
    if (usesHttpIdempotency(model)) {
      fragments.push(fragment(profile, 'idempotency', idempotencyYaml(profile)));
    }
    if (stack.cache === 'redis' || stack.cache === 'valkey') {
      // Valkey habla protocolo Redis: misma configuración spring.data.redis.
      fragments.push(fragment(profile, 'redis', redisYaml(profile)));
    }
    // El fragmento oauth2 (issuer-uri del resource server) solo aplica a
    // protocolos basados en token; api-key/none no lo usan.
    if (layersPresent.security && (model.security?.protocol === 'oidc' || model.security?.protocol === 'jwt')) {
      fragments.push(fragment(profile, 'oauth2', oauth2Yaml(model, profile)));
    }
    // Fragmento security propio (clave 'security'): clave api-key del servicio,
    // audiencia a validar y/o claves api-key por serviceClient.
    if (layersPresent.security && securityApplies(model)) {
      fragments.push(fragment(profile, 'security', securityYaml(model, profile)));
    }
    if (layersPresent.storage && stack.storage) {
      fragments.push(fragment(profile, 'storage', storageYaml(model, profile)));
    }
    if (layersPresent.mail) {
      fragments.push(fragment(profile, 'mail', mailYaml(model, profile)));
    }
    if (layersPresent.httpClients && model.httpClients) {
      fragments.push(fragment(profile, 'http-clients', httpClientsYaml(model, profile)));
    }
    // Los números del barrido de reconciliación. Solo si hay barrido: sin `reconciledBy`
    // el fragmento sería un archivo con parámetros que nadie lee.
    if (reconciledActivations(model).length > 0) {
      fragments.push(fragment(profile, 'reconciliation', reconciliationYaml(model, profile)));
    }
    // La cota de cada barrido y el plazo de cada rescate. Basta con que haya UN reclamo: un
    // barrido sin rescate no tiene plazo que fijar, pero su lote se acota igual.
    if (sweepBatchKeys(model).length > 0 || stalledClaims(model).length > 0) {
      fragments.push(fragment(profile, 'sweep', sweepYaml(model, profile)));
    }

    files.push({
      path: `src/main/resources/application-${profile}.yaml`,
      content: profileYaml(profile, fragments)
    });
    files.push(...fragments.map(({ path, content }) => ({ path, content })));
  }

  files.push(...testProfileFiles(model));
  return files;
}

function fragment(profile, name, content) {
  return { name, path: `src/main/resources/parameters/${profile}/${name}.yaml`, content };
}

// application.yaml base: lo común a todos los perfiles.
function baseYaml(model) {
  const { service, layersPresent } = model;
  const lines = [
    'server:',
    '  # Puerto por variable de entorno; 8080 es el que asumen los escenarios de validación.',
    '  port: ${SERVER_PORT:8080}',
    '  # Apagado ordenado: al recibir SIGTERM deja de aceptar conexiones nuevas y espera',
    '  # (hasta spring.lifecycle.timeout-per-shutdown-phase) a que terminen las peticiones en vuelo.',
    '  # Con los probes de Actuator activos, el readiness pasa a OUT_OF_SERVICE mientras drena.',
    '  shutdown: graceful',
    'spring:',
    '  application:',
    `    name: ${service.name}`,
    '  lifecycle:',
    '    # Margen máximo para que terminen las peticiones en curso antes de matar el proceso.',
    '    timeout-per-shutdown-phase: ${SHUTDOWN_TIMEOUT:30s}',
    '  threads:',
    '    virtual:',
    '      enabled: true',
    '  profiles:',
    '    # Perfil activo por variable de entorno; local para desarrollo en la máquina.',
    '    active: ${PROFILE:local}'
  ];
  // Serialización de fechas: ISO-8601, nunca epoch numérico.
  //
  // Deliberadamente NO se fija default-property-inclusion. "Ausencia vs. nulo"
  // es una convención de determinación del DISEÑO (la declara
  // specs/validation-scenarios.md, distinta en cada servicio), no un default de
  // plantilla: fijarla aquí decide el contrato observable —respuestas REST y
  // payloads de evento, que comparten este ObjectMapper— por el diseñador, y en
  // sentido único. El default de Jackson (los nulos viajan) es el que no
  // prejuzga; el servicio que deba omitirlos lo hace con @JsonInclude por clase,
  // que es la regla de conventions/mapping.md.
  lines.push('  jackson:', '    serialization:', '      write-dates-as-timestamps: false');
  // open-in-view es de JPA: cierra la sesión al salir del servicio para que una
  // relación LAZY no se cargue durante la serialización. En el modelo documental no
  // hay sesión ni carga perezosa que cerrar — el documento viene entero.
  if (layersPresent.persistence && model.persistenceKind !== 'document') {
    lines.push('  jpa:', '    open-in-view: false');
  }
  // Tope de página del diseño (api.pagination): sin max-page-size Spring admite
  // hasta 2000 elementos por página y el maxSize declarado no se aplica nunca.
  if (model.pagination) {
    const pageable = ['  data:', '    web:', '      pageable:'];
    if (model.pagination.defaultSize != null) pageable.push(`        default-page-size: ${model.pagination.defaultSize}`);
    if (model.pagination.maxSize != null) pageable.push(`        max-page-size: ${model.pagination.maxSize}`);
    if (pageable.length > 3) lines.push(...pageable);
  }
  // Límite de subida del servlet a partir del mayor maxSizeMb declarado en el
  // diseño: sin esto Spring corta en 1MB y el 413 del diseño nunca se alcanza.
  // Va con holgura DELIBERADA sobre el límite de negocio: si el servlet cortase
  // justo en maxSizeMb, el 413 lo emitiría Tomcat antes de ejecutar el caso de
  // uso y ninguna guarda declarada antes que la del tamaño (p. ej. "demasiadas
  // imágenes") podría precederla. El límite de negocio se comprueba en el orden
  // que fija el diseño; esto es solo la red de seguridad para subidas absurdas.
  const maxSizeMb = model.storage?.maxSizeMb;
  if (maxSizeMb != null) {
    const servletLimit = maxSizeMb * 2;
    lines.push(
      '  servlet:',
      '    multipart:',
      `      max-file-size: ${servletLimit}MB`,
      `      max-request-size: ${servletLimit}MB`
    );
  }
  return lines.join('\n') + '\n';
}

// application-<perfil>.yaml: solo declara qué fragmentos importa.
// En production, además, se apaga swagger-ui (springdoc).
function profileYaml(profile, fragments) {
  const lines = [
    `# Perfil ${profile}: importa sus fragmentos de parameters/${profile}/.`,
    'spring:',
    '  config:',
    '    import:',
    ...fragments.map(({ name }) => `      - "classpath:parameters/${profile}/${name}.yaml"`)
  ];
  if (profile === 'production') {
    lines.push('', 'springdoc:', '  swagger-ui:', '    enabled: false');
  }
  return lines.join('\n') + '\n';
}

function loggingYaml(model, profile) {
  const root = profile === 'production' ? 'WARN' : 'INFO';
  const app = profile === 'production' ? 'INFO' : 'DEBUG';
  const lines = [
    'logging:',
    '  level:',
    `    root: ${envWithDefault(profile, 'LOG_LEVEL_ROOT', root)}`,
    `    ${model.service.basePackage}: ${envWithDefault(profile, 'LOG_LEVEL_APP', app)}`
  ];
  // Y el contrapeso de `generate_statistics: true`, que dbYaml enciende en estos dos
  // perfiles para que el arnés pueda leer `hibernate.statements`. Ese flag activa además
  // StatisticalLoggingSessionEventListener, que escribe un bloque de ~15 líneas a INFO por
  // CADA sesión de Hibernate: cada tick del relay del outbox (uno por segundo), cada
  // petición HTTP y cada mensaje consumido, durante toda la suite. Son miles de bloques que
  // no alimentan ninguna aserción —el contador lo publica Micrometer, no este logger— y que
  // compiten por CPU e IO con el proceso bajo prueba, en una suite cuyos `await` se miden en
  // segundos. Van juntos a propósito: quien quite el flag tiene que quitar esto.
  if (statisticsEnabled(model, profile)) {
    lines.push(
      '    # Silencia el volcado por sesión que activa generate_statistics (ver el fragmento',
      '    # db de este mismo perfil). El contador que lee el arnés lo publica Micrometer.',
      '    org.hibernate.engine.internal.StatisticalLoggingSessionEventListener: WARN'
    );
  }
  // Saca el correlationId que CorrelationContext deja en el MDC a cada línea de
  // log: es lo que permite reconstruir una petición completa (y los eventos que
  // provocó) a partir del identificador que el cliente recibió en la respuesta.
  if (usesCorrelation(model)) {
    lines.push('  pattern:', '    correlation: "[%X{correlationId:-}] "');
  }
  return lines.join('\n') + '\n';
}

/**
 * ¿Lleva este perfil el contador de sentencias de Hibernate? Es la MISMA condición con la
 * que dbYaml emite `generate_statistics`, en un solo sitio para que las dos no se puedan
 * separar: el logger que se silencia solo existe cuando el flag está puesto.
 */
function statisticsEnabled(model, profile) {
  return (
    Boolean(model.layersPresent?.persistence) &&
    model.persistenceKind !== 'document' &&
    (profile === 'local' || profile === 'test')
  );
}

// Actuator: expone health/info/metrics y activa los grupos de probes
// (liveness/readiness) que consume Kubernetes. El health detalla componentes
// (BD, broker, disco…) salvo en production, donde solo publica el status.
function managementYaml(profile) {
  const showDetails = profile === 'production' ? 'never' : 'always';
  const lines = [
    'management:',
    '  endpoints:',
    '    web:',
    '      exposure:',
    `        include: ${envWithDefault(profile, 'MANAGEMENT_ENDPOINTS', 'health,info,metrics')}`,
    '  endpoint:',
    '    health:',
    '      probes:',
    '        # Habilita /actuator/health/liveness y /actuator/health/readiness.',
    '        enabled: true',
    `      show-details: ${envWithDefault(profile, 'MANAGEMENT_HEALTH_SHOW_DETAILS', showDetails)}`
  ];
  return lines.join('\n') + '\n';
}

function dbYaml(model, profile, dbName) {
  const db = DATABASES[model.stack.database] ?? DATABASES.postgresql;
  if (db.kind === 'document') return documentDbYaml(db, profile, dbName);
  const lines = [
    'spring:',
    '  datasource:',
    `    url: ${envValue(profile, 'DB_URL', db.url(dbName))}`,
    `    username: ${envValue(profile, 'DB_USERNAME', db.user(dbName))}`,
    `    password: ${envValue(profile, 'DB_PASSWORD', db.password)}`,
    '    hikari:',
    '      # Tuning del pool expuesto por ambiente (defaults de Hikari; ajustar en production).',
    `      maximum-pool-size: ${envWithDefault(profile, 'DB_POOL_MAX_SIZE', 10)}`,
    `      connection-timeout: ${envWithDefault(profile, 'DB_POOL_CONNECTION_TIMEOUT_MS', 30000)}`,
    '  jpa:',
    '    hibernate:'
  ];
  if (profile === 'local') {
    // Único perfil donde Hibernate gobierna el esquema: el ciclo de generación
    // itera sobre las entidades y no puede pararse a escribir una migración por
    // cambio. El baseline de db/migration/ se prueba aquí con PROFILE=local,migrations.
    lines.push('      # Solo para iterar: en local Hibernate crea/altera el esquema.', '      ddl-auto: update');
  } else {
    lines.push('      # El esquema lo gobiernan las migraciones de db/migration/, nunca Hibernate.', '      ddl-auto: validate');
  }
  lines.push(`    show-sql: ${profile === 'local'}`);
  // Red de seguridad sobre el quoting explícito de las entidades: Hibernate
  // entrecomilla cualquier identificador que sea palabra clave del dialecto
  // elegido. Sin esto, un campo del diseño llamado como una palabra reservada
  // (primary, order, user…) genera un DDL que no compila y su tabla no se crea.
  lines.push('    properties:', '      hibernate:', '        auto_quote_keyword: true');
  // Red de seguridad del N+1 de colecciones, en TODOS los perfiles porque es una
  // propiedad de producción, no de prueba. Cada colección generada lleva además su
  // @BatchSize —la decisión por colección se lee junto al modelo—, pero esta cubre lo
  // que se añada después sin acordarse de anotarlo, y las cargas perezosas que no son
  // colecciones declaradas.
  lines.push(
    '        # Agrupa las cargas LAZY pendientes en un WHERE ... IN (...) en vez de una',
    '        # consulta por elemento. Sin esto, recorrer una colección de una página de N',
    '        # elementos son N consultas que ninguna aserción funcional distingue.',
    '        default_batch_fetch_size: 50'
  );
  // Contador de sentencias, que es lo que hace OBSERVABLE un N+1: sin él, «esta página
  // cuesta una consulta o veintiuna» es una opinión sobre el código, no un hecho que un
  // escenario pueda afirmar. Micrometer lo publica como `hibernate.statements` y el arnés
  // lo lee del actuator (ver AbstractFlowIT#queryCount).
  //
  // Solo en local y test: llevar la cuenta tiene coste, y en producción se paga en cada
  // petición a cambio de un dato que allí nadie consulta.
  if (statisticsEnabled(model, profile)) {
    lines.push(
      '        # Cuenta las sentencias preparadas. Lo lee el arnés para acotar el coste de',
      '        # una lectura y cazar un N+1: es medición de prueba, no de producción.',
      '        generate_statistics: true'
    );
  }
  lines.push(...sqlInitLines(model, profile));
  lines.push(...flywayLines(profile));
  return lines.join('\n') + '\n';
}

/**
 * Inicialización del appendix de SQL en los perfiles donde el esquema lo pone
 * Hibernate (local y test). Contiene los índices únicos condicionados, que JPA no
 * expresa y Hibernate por tanto no crea: sin esto, en local el invariante que
 * declaró el diseño («como máximo una activa») no lo sostiene nada, y el escenario
 * que lo prueba pasaría en verde con dos peticiones simultáneas dejando dos filas.
 *
 * `defer-datasource-initialization` es lo que ordena las dos mitades: sin él, Boot
 * ejecuta el script ANTES de que Hibernate cree las tablas y falla por tabla
 * inexistente. En develop/production no aplica: allí el esquema lo pone Flyway y el
 * appendix ya viaja dentro del baseline.
 */
function sqlInitLines(model, profile) {
  // Solo `local`. El perfil `test` corre sobre H2, que no tiene índices parciales:
  // ejecutar ahí el appendix —escrito para el dialecto elegido— rompería el arranque
  // del contexto de @SpringBootTest por sintaxis, y un servicio con motor sin soporte
  // ni siquiera tendría archivo que ejecutar. Ahí la unicidad condicionada no se
  // comprueba, y no pasa nada: quien la ejercita es el escenario de integración, que
  // corre contra el motor de verdad.
  if (profile !== 'local') return [];
  if (!usesPartialIndexes(model)) return [];
  return [
    '    # El appendix de SQL corre DESPUÉS de que Hibernate cree las tablas.',
    '    defer-datasource-initialization: true',
    '  sql:',
    '    init:',
    '      # Índices condicionados que Hibernate no infiere (ver db/partial-indexes.sql).',
    '      mode: always',
    '      data-locations: "classpath:db/partial-indexes.sql"',
    '      continue-on-error: false'
  ];
}

/**
 * Fragmento db del modelo documental. Mucho más corto que el relacional, y no por
 * omisión: no hay pool JDBC, no hay dialecto, no hay `ddl-auto` y no hay
 * migraciones. La configuración toda cabe en la URI, que ya trae credenciales,
 * modo de conexión y representación de UUID (ver el catálogo).
 */
function documentDbYaml(db, profile, dbName) {
  return (
    [
      'spring:',
      '  data:',
      '    mongodb:',
      `      uri: ${envValue(profile, 'DB_URL', db.url(dbName))}`,
      '      # Los índices los crea MongoIndexConfig, que build deriva entero de',
      '      # persistence.keel.yaml: dejar que Spring los infiera de las anotaciones',
      '      # los crearía con nombres suyos, y el ApiExceptionHandler traduce la',
      '      # violación de unicidad buscando el nombre del índice en el mensaje.',
      '      auto-index-creation: false'
    ].join('\n') + '\n'
  );
}

// Bloque spring.flyway del fragmento db. Las migraciones viven en
// src/main/resources/db/migration (el default de Flyway: no hace falta declarar
// locations) y se aplican al arrancar. Gradiente: apagadas en local (ahí manda
// ddl-auto: update mientras se itera) y encendidas en los ambientes desplegados.
function flywayLines(profile) {
  if (profile === 'local') {
    return [
      '  flyway:',
      '    # Apagadas mientras se itera; para probar el baseline: PROFILE=local,migrations.',
      '    enabled: false'
    ];
  }
  const lines = [
    '  flyway:',
    '    # Aplica db/migration/ al arrancar y lo registra en flyway_schema_history.',
    '    # FLYWAY_ENABLED=false para delegar la migración a un paso previo al despliegue.',
    `    enabled: ${envWithDefault(profile, 'FLYWAY_ENABLED', true)}`
  ];
  if (profile === 'production') {
    lines.push('    # El borrado del esquema nunca es una opción en producción.', '    clean-disabled: true');
  }
  return lines;
}

function brokerYaml(model, profile) {
  const { service, stack } = model;
  if (stack.broker === 'snssqs') {
    const lines = [
      'spring:',
      '  cloud:',
      '    aws:',
      '      region:',
      `        static: ${envValue(profile, 'AWS_REGION', 'us-east-1')}`,
      '      credentials:',
      `        access-key: ${envValue(profile, 'AWS_ACCESS_KEY_ID', 'test')}`,
      `        secret-key: ${envValue(profile, 'AWS_SECRET_ACCESS_KEY', 'test')}`
    ];
    // En local/develop se apunta a LocalStack; en production el SDK resuelve el
    // endpoint real de AWS (no se fija endpoint).
    if (profile !== 'production') {
      lines.push(
        '      sns:',
        `        endpoint: ${envValue(profile, 'AWS_SNS_ENDPOINT', 'http://localhost:4566')}`,
        '      sqs:',
        `        endpoint: ${envValue(profile, 'AWS_SQS_ENDPOINT', 'http://localhost:4566')}`
      );
    }
    return lines.join('\n') + '\n';
  }
  if (stack.broker === 'rabbitmq') {
    return [
      'spring:',
      '  rabbitmq:',
      `    host: ${envValue(profile, 'RABBITMQ_HOST', 'localhost')}`,
      `    port: ${envValue(profile, 'RABBITMQ_PORT', 5672)}`,
      `    username: ${envValue(profile, 'RABBITMQ_USERNAME', 'guest')}`,
      `    password: ${envValue(profile, 'RABBITMQ_PASSWORD', 'guest')}`,
      // Clave PROPIA, no `spring.*`: `spring.rabbitmq.listener.simple.recovery-interval`
      // NO existe —RabbitProperties no la expone—, así que declararla ahí no tendría
      // ningún efecto y el contenedor se quedaría con el default INVISIBLE de
      // AbstractMessageListenerContainer. Se saca a la luz porque no es solo del
      // listener: el deadline de publicación del dispatcher del outbox tiene que quedar
      // POR ENCIMA de este número (comparten ConnectionFactory, y un deadline más corto
      // reinicia este reloj en cada timeout — el patrón que nunca converge). Un valor
      // invisible no se puede respetar.
      'rabbitmq:',
      '  listener:',
      `    recovery-interval-ms: ${envWithDefault(profile, 'RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS', 5000)}`
    ].join('\n') + '\n';
  }
  return [
    'spring:',
    '  kafka:',
    `    bootstrap-servers: ${envValue(profile, 'KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')}`,
    '    producer:',
    '      key-serializer: org.apache.kafka.common.serialization.StringSerializer',
    '      # El JSON del EventEnvelope lo produce el ObjectMapper de la aplicación',
    '      # (JacksonConfig, con TimestampModule) y viaja ya como String: un',
    '      # JsonSerializer aquí lo volvería a serializar —escapado dos veces— y',
    '      # además usaría un ObjectMapper por defecto, instanciado por reflexión de',
    '      # kafka-clients y sin los módulos de la app (los Instant saldrían como',
    '      # epoch crudo, violando docs/asyncapi.yaml).',
    '      value-serializer: org.apache.kafka.common.serialization.StringSerializer',
    '    consumer:',
    `      group-id: ${envWithDefault(profile, 'KAFKA_GROUP_ID', `${service.artifactId}-group`)}`,
    '      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer',
    '      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer',
    '    listener:',
    '      # Hilos consumidores por instancia. Es configuración de ESTE proceso, no del',
    '      # cluster: el techo son las particiones del topic (que gobierna la plataforma)',
    '      # y se multiplica por réplica — el paralelismo real del grupo es',
    '      # min(particiones, réplicas × concurrency), y todo consumidor por encima de las',
    '      # particiones queda asignado a cero y en reposo. En local y develop hay una sola',
    '      # partición por decisión, así que subirlo ahí no da throughput y sí rebalanceos.',
    `      concurrency: ${envWithDefault(profile, 'KAFKA_LISTENER_CONCURRENCY', 1)}`,
    '    # TODO (agente): topics y deserialización de consumo según messaging.keel.yaml'
  ].join('\n') + '\n';
}

// Destino y claves de enrutado de los eventos publicados: contrato de
// integración, así que se parametriza (el código solo lee @Value). El nombre
// físico del exchange/topic puede diferir por ambiente.
function messagingYaml(model, profile) {
  const lines = [];
  const subscriptions = model.subscriptions ?? [];
  if (model.events.length > 0 || subscriptions.length > 0) lines.push('messaging:');
  if (model.events.length > 0) {
    const first = model.events[0];
    lines.push(
      '  publishing:',
      `    destination: ${envWithDefault(profile, 'MESSAGING_DESTINATION', first.destinationDefault)}`,
      '    routing-keys:'
    );
    for (const event of model.events) {
      const key = event.routingKeyProperty.split('.').pop();
      lines.push(`      ${key}: ${event.routingKeyDefault}`);
    }
  }
  // El destino del que se CONSUME cada suscripción. Lo nombra su dueño, así que es
  // configuración por perfil — y tiene que estar declarado aquí, no solo como TODO
  // en el fragmento del broker: es la propiedad que lee el listener y a la que el
  // arnés entrega. Si el agente inventa otro nombre, todo escenario de suscripción
  // muere en un timeout mudo, que es el fallo más caro de diagnosticar del pipeline.
  if (subscriptions.length > 0) {
    lines.push('  subscriptions:');
    for (const sub of subscriptions) {
      const key = sub.topicProperty.split('.').slice(-2)[0];
      const env = sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
      lines.push(`    ${key}:`, `      topic: ${envWithDefault(profile, env, sub.topicDefault)}`);
      // Con SNS/SQS el topic NO basta: del topic se publica, pero se consume de una
      // COLA, y su nombre lo fija este servicio (dos consumidores del mismo topic
      // necesitan colas distintas). `init-messaging.sh` ya la crea con este nombre; sin
      // declararla aquí, el listener no tenía de dónde leerla y el agente la añadía a
      // mano en los cuatro perfiles — o se la inventaba, y entonces todo escenario de
      // suscripción moría en un timeout mudo. Sale del mismo helper que la siembra, que
      // es lo que impide que las dos mitades se desincronicen.
      // Y con RabbitMQ, por lo MISMO: el canal de origen es un exchange, y de un exchange
      // no se consume — cuelga de él una cola propia de este servicio. Sin declararla aquí
      // no había nadie que la nombrara, y el agente la inventaba siguiendo su skill: la
      // topología quedaba con un nombre que ni la purga ni la entrega del arnés conocían
      // (`corrida-mail-rabbit`). Kafka no entra: ahí se consume del topic directamente.
      if (model.stack?.broker === 'snssqs' || model.stack?.broker === 'rabbitmq') {
        const queueEnv = `${env.replace(/_TOPIC$/, '')}_QUEUE`;
        lines.push(
          `      queue: ${envWithDefault(profile, queueEnv, subscriptionDestination(model.stack.broker, model, sub))}`
        );
      }
    }
  }
  if (usesIdempotency(model)) {
    lines.push(
      'processed-event:',
      '  purge:',
      '    # Borrado del registro de idempotencia; la retención solo tiene que',
      '    # cubrir la ventana en la que el broker puede reentregar un mensaje.',
      `    cron: ${cronWithDefault(profile, 'PROCESSED_EVENT_PURGE_CRON', '0 0 4 * * *')}`,
      `    retention-days: ${envWithDefault(profile, 'PROCESSED_EVENT_PURGE_RETENTION_DAYS', 14)}`
    );
  }
  if (usesOutbox(model)) {
    lines.push(
      'outbox:',
      '  relay:',
      '    # Cada cuánto el relay busca filas pendientes y las entrega al broker.',
      `    fixed-delay-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_DELAY_MS', 1000)}`,
      `    batch-size: ${envWithDefault(profile, 'OUTBOX_RELAY_BATCH_SIZE', 100)}`,
      '    # Tras agotar los reintentos, la fila queda como dead-letter (no se',
      '    # reintenta más ni se borra); se reporta a ERROR para inspección.',
      // Y en `local` son MÁS, no por tolerancia sino por PRESUPUESTO: ahí el broker
      // caído es un PASO del escenario de outbox, y lo que la fila tiene que aguantar es
      // un reinicio de contenedor entero. Con el tope corto de abajo, diez intentos son
      // ~20 s — menos de lo que tarda un broker en volver a servir bajo podman o docker
      // en una máquina cargada, así que la fila moría como dead-letter justo antes de
      // que el broker estuviera listo: el escenario fallaba por el presupuesto, no por
      // lo que prueba. Las dos claves gobiernan cosas distintas — `backoff.max-ms` es la
      // LATENCIA de la reentrega tras la recuperación y el producto de ambas es el
      // presupuesto—, así que igualar los topes entre perfiles «para que no difieran»
      // arregla el presupuesto rompiendo la latencia.
      `    max-attempts: ${envWithDefault(profile, 'OUTBOX_RELAY_MAX_ATTEMPTS', profile === 'local' ? 40 : 10)}`,
      '    # Backoff exponencial entre reintentos de una misma fila (initial·2^(n-1),',
      '    # con tope max-ms): evita el hot-looping si el broker está caído.',
      '    backoff:',
      `      initial-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_BACKOFF_INITIAL_MS', 1000)}`,
      // El tope se acorta en `local` —el perfil con el que corre la suite de
      // integración— porque ahí el broker caído no es una avería sino un PASO del
      // escenario de outbox: el flujo lo detiene, comprueba que la API responde igual
      // y lo vuelve a levantar. Con el tope de producción, la fila acumula intentos
      // mientras está caído y la entrega tras la recuperación llega decenas de
      // segundos después: el escenario tendría que esperar más de lo que ninguna
      // suite tolera, o saldría intermitente. En los demás perfiles el broker caído
      // sí es una avería, y ahí el tope largo es exactamente lo que se quiere.
      `      max-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_BACKOFF_MAX_MS', profile === 'local' ? 2000 : 60000)}`
    );
    // Solo el modelo documental: ahí el reclamo del lote es una marca en la fila
    // (claimed_at), no un lock, así que una réplica que muere la retendría para
    // siempre. Esta ventana es lo que la libera — y por debajo de la latencia peor
    // del broker, dos réplicas entregan la misma fila. En el relacional no existe:
    // el lock lo suelta la conexión al caer.
    if (model.persistenceKind === 'document') {
      lines.push(
        '    # Caducidad del reclamo de una fila: una réplica que muere con el lote en',
        '    # vuelo lo retiene hasta que pasa este tiempo. Debe superar con holgura la',
        '    # latencia peor del broker; por debajo, dos réplicas entregan lo mismo.',
        `    claim-timeout-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_CLAIM_TIMEOUT_MS', 60000)}`
      );
    }
    lines.push(
      '  purge:',
      '    # Borrado diario de lo ya publicado; la tabla no es un histórico.',
      `    cron: ${cronWithDefault(profile, 'OUTBOX_PURGE_CRON', '0 0 3 * * *')}`,
      `    retention-days: ${envWithDefault(profile, 'OUTBOX_PURGE_RETENTION_DAYS', 7)}`
    );
  }
  return lines.join('\n') + '\n';
}

// Cadencia de la purga del registro de idempotencia de comando. La retención no
// se parametriza: cada fila lleva su propia caducidad, calculada con el
// ttlSeconds que el diseño declara para esa operación.
function idempotencyYaml(profile) {
  return [
    'idempotency-record:',
    '  purge:',
    '    # Borrado de las claves ya caducadas; la ventana de deduplicación la fija',
    '    # el ttlSeconds del diseño, no esta cadencia.',
    `    cron: ${cronWithDefault(profile, 'IDEMPOTENCY_PURGE_CRON', '0 30 4 * * *')}`
  ].join('\n') + '\n';
}

function redisYaml(profile) {
  return [
    'spring:',
    '  data:',
    '    redis:',
    `      host: ${envValue(profile, 'REDIS_HOST', 'localhost')}`,
    `      port: ${envValue(profile, 'REDIS_PORT', 6379)}`
  ].join('\n') + '\n';
}

function oauth2Yaml(model, profile) {
  const { service, stack } = model;
  const lines = ['spring:', '  security:', '    oauth2:', '      resourceserver:', '        jwt:'];
  if (stack.auth === 'keycloak') {
    if (profile === 'local') {
      lines.push('          # Keycloak de prueba del docker-compose; crea el realm y ajusta el nombre.');
    }
    lines.push(`          issuer-uri: ${envValue(profile, 'OAUTH2_ISSUER_URI', `http://localhost:8180/realms/${service.name}`)}`);
  } else if (stack.auth === 'cognito') {
    if (profile === 'local') {
      lines.push(
        '          # Emulador del contrato de token de Cognito en el docker-compose. El issuer es',
        '          # DETERMINISTA porque el issuerId lo elige el diseño (el nombre del servicio):',
        '          # no hay ningún id de user pool que descubrir después de crearlo.',
        '          # Fuera de local, aquí va el pool real: https://cognito-idp.<región>.amazonaws.com/<poolId>.'
      );
    }
    lines.push(
      `          issuer-uri: ${envValue(profile, 'OAUTH2_ISSUER_URI', `http://localhost:${AUTH.cognito.port}/${service.name}`)}`
    );
  } else {
    if (profile === 'local') {
      lines.push('          # TODO (agente): issuer real del resource server según security.keel.yaml.');
    }
    lines.push(`          issuer-uri: ${envValue(profile, 'OAUTH2_ISSUER_URI', 'https://tu-issuer')}`);
  }
  return lines.join('\n') + '\n';
}

// Hay fragmento 'security' si el servicio se protege con api-key (security.api-key),
// si el diseño valida audiencia (security.audience) o si los clientes máquina se
// autentican por api-key (security.api-keys.*).
// Un solo predicado para el fragmento `messaging`, compartido por el bucle de
// perfiles y por el perfil `test`: la tabla de fragmentos está escrita dos veces
// (testProfileFiles no la reutiliza porque sus valores son de juguete), y sin
// esto las dos divergen — que es justo lo que pasó con este fragmento.
function messagingApplies(model) {
  return Boolean(model.layersPresent.messaging && (model.events.length > 0 || usesIdempotency(model)));
}

function securityApplies(model) {
  const sec = model.security;
  if (!sec) return false;
  if (sec.cors) return true;
  if (sec.protocol === 'api-key') return true;
  if (!sec.serviceAuth) return false;
  const jwt = sec.protocol === 'oidc' || sec.protocol === 'jwt';
  const audience = jwt && sec.serviceAuth.validateAudience === true;
  const apiKeys = sec.serviceAuth.protocol === 'api-key' && (sec.serviceClients?.length ?? 0) > 0;
  return audience || apiKeys;
}

function securityYaml(model, profile) {
  const sec = model.security;
  const jwt = sec.protocol === 'oidc' || sec.protocol === 'jwt';
  const lines = ['security:'];
  // Clave única del servicio (protocolo api-key). En local sale con valor real
  // para que los escenarios de validación autentiquen sin editar el YAML:
  // ApiKeyAuthFilter rechaza toda petición si la clave está vacía.
  if (sec.protocol === 'api-key') {
    lines.push(
      profile === 'local'
        ? '  # Clave que deben enviar los clientes; esta es la de los escenarios de validación.'
        : '  # Clave que deben enviar los clientes; obligatoria (sin ella la app no arranca).'
    );
    lines.push(`  api-key: ${envRequired(profile, 'SECURITY_API_KEY', LOCAL_API_KEY)}`);
  }
  if (jwt && sec.serviceAuth?.validateAudience === true) {
    const audience = sec.serviceAuth.audience ?? model.service.artifactId;
    lines.push('  # Audiencia que debe traer el claim aud de los tokens de clientes máquina.');
    lines.push(`  audience: ${envValue(profile, 'SECURITY_AUDIENCE', audience)}`);
  }
  if (sec.serviceAuth?.protocol === 'api-key' && (sec.serviceClients?.length ?? 0) > 0) {
    lines.push(
      profile === 'local'
        ? '  # Clave por cliente máquina del diseño (serviceClients); vacía = cliente deshabilitado.'
        : '  # Clave por cliente máquina del diseño (serviceClients); obligatorias por ambiente.'
    );
    lines.push('  api-keys:');
    for (const client of sec.serviceClients) {
      const varName = `API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`;
      lines.push(`    ${client.name}: ${envRequired(profile, varName, localClientApiKey(client.name))}`);
    }
  }
  // Orígenes permitidos por CORS: el único dato de la política que no viene del
  // diseño. Obligatorio fuera de local para que un despliegue mal configurado
  // falle al arrancar en vez de servir en silencio a orígenes equivocados.
  if (sec.cors) {
    lines.push('  cors:');
    lines.push(
      profile === 'local'
        ? '    # Orígenes del navegador (CSV); estos son los puertos de dev habituales de una SPA.'
        : '    # Orígenes del navegador (CSV); obligatorio (sin él la app no arranca).'
    );
    lines.push(
      `    allowed-origins: ${envRequired(profile, 'SECURITY_CORS_ALLOWED_ORIGINS', LOCAL_CORS_ORIGINS)}`
    );
  }
  return lines.join('\n') + '\n';
}

// Config del object storage (clave propia 'storage', consumida por el adaptador
// S3FileStorage/S3Config que escribe el AGENTE siguiendo la skill del proveedor:
// el scaffolding solo genera el puerto FileStorage, ver storage.js). MinIO local
// coincide con el docker-compose; S3 usa los endpoints por defecto del SDK.
/**
 * Correo saliente. Sigue el mismo gradiente que el resto —literal en local,
 * variable obligatoria en production— y son exactamente cuatro parámetros: cambiar
 * de proveedor en producción es cambiarlos y reiniciar, con el mismo binario y sin
 * recompilar. En producción no se escriben a mano (los inyecta un Secret, Vault o
 * un gestor de secretos), pero el consumo sigue siendo por variable de entorno, así
 * que el patrón no cambia.
 *
 * En local apunta al Mailpit de infra/: acepta la conexión sin autenticación ni
 * TLS y no entrega nada a nadie, así que ningún correo de pruebas puede llegar a
 * una dirección real. Con un proveedor de verdad en desarrollo, eso pasa el primer
 * día.
 *
 * Lo que sale del DISEÑO —el remitente, las partes del cuerpo, si hay adjuntos— va
 * bajo la clave `mail:`, aparte de `spring.mail`: no es configuración del
 * transporte, es lo que el diseño decidió y el adaptador aplica.
 */
function mailYaml(model, profile) {
  const isLocalish = profile === 'local' || profile === 'test';
  const mail = model.mail ?? {};
  const lines = [
    'spring:',
    '  mail:',
    `    host: ${envValue(profile, 'MAIL_HOST', 'localhost')}`,
    `    port: ${envValue(profile, 'MAIL_PORT', 1025)}`,
    `    username: ${envValue(profile, 'MAIL_USERNAME', '')}`,
    `    password: ${envValue(profile, 'MAIL_PASSWORD', '')}`,
    '    properties:',
    '      mail:',
    '        smtp:'
  ];
  if (isLocalish) {
    // Mailpit no exige ni autenticación ni cifrado, y pedirlos aquí haría fallar
    // el envío contra la propia infraestructura de prueba.
    lines.push('          auth: false', '          starttls:', '            enable: false');
  } else {
    lines.push(
      `          auth: ${envWithDefault(profile, 'MAIL_SMTP_AUTH', true)}`,
      '          starttls:',
      `            enable: ${envWithDefault(profile, 'MAIL_SMTP_STARTTLS', true)}`
    );
  }
  // Un envío que se queda esperando a un proveedor caído bloquea el hilo que lo
  // hace. Los defaults de JavaMail son "sin timeout": el hilo espera para siempre.
  lines.push(
    `          connectiontimeout: ${envWithDefault(profile, 'MAIL_CONNECT_TIMEOUT_MS', 5000)}`,
    `          timeout: ${envWithDefault(profile, 'MAIL_READ_TIMEOUT_MS', 5000)}`,
    `          writetimeout: ${envWithDefault(profile, 'MAIL_WRITE_TIMEOUT_MS', 5000)}`
  );

  // Bajo `mail:` va SOLO lo que el servidor lee en tiempo de ejecución, y eso son las
  // direcciones: el adaptador las recibe por constructor con @Value. `multipart` y
  // `attachments` estaban aquí y no los leía ningún Java —las dos decisiones se hornean al
  // generar, en el flag de MimeMessageHelper y en la forma del record MailMessage—, así que
  // lo único que ofrecían era una palanca que no mueve nada: cambiarlas en el fichero de
  // parámetros no cambia el comportamiento, y descubrirlo cuesta una sesión.
  const settings = [];
  if (mail.sender?.source === 'fixed') {
    settings.push(`  sender: ${envValue(profile, 'MAIL_SENDER', mail.sender.address)}`);
  } else if (mail.sender?.fallback) {
    settings.push(
      '  # Remitente de respaldo: se usa cuando el dato del servicio no lo resuelve.',
      `  sender-fallback: ${envValue(profile, 'MAIL_SENDER_FALLBACK', mail.sender.fallback)}`
    );
  }
  if (mail.replyTo?.source === 'fixed') {
    settings.push(`  reply-to: ${envValue(profile, 'MAIL_REPLY_TO', mail.replyTo.address)}`);
  }
  if (settings.length > 0) lines.push('', 'mail:', ...settings);
  return lines.join('\n') + '\n';
}

function storageYaml(model, profile) {
  const { stack } = model;
  const isMinio = stack.storage === 'minio';
  // El perfil test es cerrado: H2, sin contenedores y sin salida a la red. Se
  // genera con esta misma función y no con una copia aparte, porque la copia ya
  // se desincronizó una vez (emitía la clave plana `bucket:`, eliminada del
  // contrato, y StorageProperties.forBucket lanzaba en cuanto alguien la usaba).
  const isTest = profile === 'test';
  // Sin clave `bucket` global: los buckets son los que declara el diseño, bajo
  // `storage.buckets.<nombre>`. Una clave por defecto invitaba a leerla con
  // @Value y a subir a un bucket que el sidecar minio-init nunca crea — el fallo
  // solo aparece al leer el objeto, muy lejos de la subida que lo causó.
  const lines = ['storage:', `  provider: ${stack.storage}`];
  if (isTest) {
    // Endpoint local SIEMPRE, también con `storage: s3`. Sin él, el
    // `@Value("${storage.endpoint:}")` del bean queda vacío, no hay
    // endpointOverride y el S3Client apunta al S3 REAL de AWS: cualquier llamada
    // al arrancar el contexto (un ensureBucket del adaptador) sale a Internet con
    // credenciales de juguete y tumba @SpringBootTest. El puerto 9000 no escucha
    // en test; es deliberado: si algo llama, falla en local y rápido.
    lines.push('  endpoint: http://localhost:9000');
  } else if (isMinio) {
    lines.push(`  endpoint: ${envValue(profile, 'STORAGE_ENDPOINT', 'http://localhost:9000')}`);
  } else if (profile === 'local') {
    lines.push('  # S3 real: el endpoint lo resuelve el SDK por región; define STORAGE_ENDPOINT solo para un compatible.');
  }
  lines.push(
    `  region: ${envValue(profile, 'STORAGE_REGION', 'us-east-1')}`,
    `  access-key: ${envValue(profile, 'STORAGE_ACCESS_KEY', isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    `  secret-key: ${envValue(profile, 'STORAGE_SECRET_KEY', isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    isMinio || isTest ? '  path-style-access: true' : '  path-style-access: false'
  );

  // Base de las URLs públicas, solo con algún bucket `visibility: public`. NO es
  // `endpoint`: ese es con quien habla el servicio (en compose, `http://minio:9000`,
  // un nombre de red que fuera no resuelve), y una URL compuesta con él llega al
  // consumidor rota. Aquí va la que el consumidor alcanza — el borde/CDN en un
  // entorno real, el host en local. Sin bucket público no se emite: el puerto
  // tampoco declara `publicUrl`, así que nadie la leería.
  if (model.storage?.hasPublicBucket) {
    if (isTest) {
      // Perfil cerrado: valor inerte y coherente con el `endpoint` de arriba. No
      // se llama a nadie, pero el binding de StorageProperties no puede quedar a null.
      lines.push('  public-base-url: http://localhost:9000');
    } else if (profile === 'local') {
      lines.push(`  public-base-url: ${envValue(profile, 'STORAGE_PUBLIC_BASE_URL', 'http://localhost:9000')}`);
    } else {
      // Sin default, también en develop: una base vacía no falla, compone URLs
      // rotas que solo se ven al abrir una imagen. Mejor no arrancar.
      lines.push(
        '  # URL base con la que el CONSUMIDOR lee los objetos públicos (CDN o borde),',
        '  # no el endpoint interno del almacén.',
        '  public-base-url: ${STORAGE_PUBLIC_BASE_URL}'
      );
    }
  }

  // Aprovisionamiento de buckets desde la propia app (el ensureBucket /
  // ensurePublicRead idempotente del adaptador, ver la skill keel-spring-s3).
  // Es una decisión de ENTORNO, no de código, y por eso viaja en la config:
  //   - local: lo hace el sidecar minio-init del compose, pero dejarlo activo no
  //     cuesta nada y cubre a quien levante la infra a mano.
  //   - test: false, imprescindible. No hay S3 ni MinIO al que llamar y el
  //     arranque del contexto no puede depender de la red.
  //   - production: opt-in. Crear buckets desde la app exige permisos
  //     s3:CreateBucket/PutBucketPolicy que la plataforma no suele conceder —y
  //     que no conviene pedir—, así que por defecto no, y quien tenga un entorno
  //     real sin nada que provisione lo activa con STORAGE_ENSURE_BUCKETS.
  lines.push(
    `  ensure-buckets-on-startup: ${
      isTest ? 'false' : profile === 'local' ? 'true' : profile === 'develop' ? '${STORAGE_ENSURE_BUCKETS:true}' : '${STORAGE_ENSURE_BUCKETS:false}'
    }`
  );

  // Política declarada por bucket en el diseño: la aplica el adaptador
  // (validación de tipo y tamaño, política de lectura pública). Va en la config
  // y no hardcodeada para que el adaptador no la reinvente.
  //
  // `bucket` es el nombre FÍSICO del bucket declarado, derivado del nombre del
  // diseño. No es cosmético: es el contrato entre el adaptador y el sidecar
  // minio-init de infra/docker-compose.yaml, que crea exactamente estos buckets
  // y les aplica la policy. Si el adaptador inventa otro nombre, sube a un
  // bucket que nadie ha hecho público.
  const buckets = model.storage?.buckets ?? [];
  if (buckets.length > 0) {
    lines.push('  buckets:');
    for (const bucket of buckets) {
      lines.push(
        `    ${bucket.name}:`,
        `      bucket: ${envValue(profile, `STORAGE_BUCKET_${screamingSnake(bucket.name)}`, physicalBucketName(model, bucket))}`,
        `      visibility: ${bucket.visibility}`
      );
      if (bucket.maxSizeMb != null) lines.push(`      max-size-mb: ${bucket.maxSizeMb}`);
      // La caducidad del enlace firmado: la declara el diseño y la aplica el adaptador.
      // Sin emitirla aquí, la ventana volvería a ser una constante elegida al escribir el
      // código, que es justo lo que el diseño acaba de sacar de ahí.
      if (bucket.signedUrlTtlSeconds != null) {
        lines.push(
          `      signed-url-ttl-seconds: ${envWithDefault(
            profile,
            `STORAGE_${screamingSnake(bucket.name)}_SIGNED_URL_TTL_SECONDS`,
            bucket.signedUrlTtlSeconds
          )}`
        );
      }
      if (bucket.allowedContentTypes.length > 0) {
        lines.push(`      allowed-content-types: ${bucket.allowedContentTypes.join(',')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// El endpoint de token de un cliente oauth2 en el perfil local. El `tokenUrl` del
// diseño describe al PROVEEDOR REAL —es contrato del socio, no configuración
// nuestra—, así que en local hay que redirigirlo igual que la `base-url`: el
// proveedor que hay levantado es el WireMock de infra/, no internet. Sin esto,
// todo escenario que atraviese un cliente oauth2 falla por DNS o por conexión
// antes de llegar a la llamada de negocio, y el síntoma no menciona al token.
//
// Se conserva el PATH declarado y solo se cambia el origen: el diseño dice dónde
// pide el token ese proveedor, y un escenario que programe el stub tiene que poder
// leerlo del diseño en vez de adivinar una ruta que nos hayamos inventado aquí.
// Si el `tokenUrl` no es una URL absoluta parseable, se deja tal cual: es dato del
// diseño y `keel validate` es quien tiene que juzgarlo, no el emisor de YAML.
//
// La redirección es de `local` y SOLO de `local`: en develop el valor del diseño es
// el default de la env var y en production es obligatoria sin default. Colar el
// stub como default fuera de local haría que un despliegue mal configurado pidiera
// el token a un puerto de nuestra máquina en vez de fallar al arrancar.
function tokenUri(client, profile) {
  if (profile !== 'local') return client.auth.tokenUrl;
  try {
    return LOCAL_STUB_BASE_URL + new URL(client.auth.tokenUrl).pathname;
  } catch {
    return client.auth.tokenUrl;
  }
}

// Config de las integraciones salientes (capa http-clients): base-url por
// cliente (gradiente de env vars) + instancias resilience4j (retry/circuit
// breaker) derivadas del diseño. Los clientes RestClient las consumen por
// nombre de instancia <cliente>-<llamada>.
function httpClientsYaml(model, profile) {
  const clients = model.httpClients;
  const lines = ['http-clients:'];
  for (const client of clients) {
    // El DSL no declara URLs (son infraestructura), así que fuera de local la env
    // var es obligatoria: sin default, un despliegue sin configurar falla al
    // arrancar en vez de llamarse a sí mismo en silencio.
    const envVar = `${client.envPrefix}_BASE_URL`;
    lines.push(`  ${client.id}:`);
    if (profile === 'local') {
      // El proveedor real no está en infra/: en local se habla con el WireMock
      // que levanta el compose, y cada prueba programa lo que ese cliente debe
      // responder en su escenario (conventions/integration-tests.md § stub).
      lines.push(`    # Proveedor de prueba (WireMock de infra/docker-compose.yaml).`);
      lines.push(`    # Los mappings los programa cada test; nada que configurar aquí.`);
    }
    lines.push(`    base-url: ${envRequired(profile, envVar, LOCAL_STUB_BASE_URL)}`);
    // Credenciales de la auth saliente: nunca vienen del diseño; gradiente de
    // env vars como el resto de secretos (oauth2 va aparte, en el bloque
    // spring.security.oauth2.client de más abajo).
    if (client.auth?.type === 'api-key') {
      lines.push('    auth:', `      api-key: ${envValue(profile, `${client.envPrefix}_API_KEY`, 'changeme')}`);
    } else if (client.auth?.type === 'bearer-static') {
      lines.push('    auth:', `      token: ${envValue(profile, `${client.envPrefix}_TOKEN`, 'changeme')}`);
    } else if (client.auth?.type === 'basic') {
      lines.push(
        '    auth:',
        `      username: ${envValue(profile, `${client.envPrefix}_USERNAME`, 'changeme')}`,
        `      password: ${envValue(profile, `${client.envPrefix}_PASSWORD`, 'changeme')}`
      );
    }
  }

  // Registrations OAuth2 client-credentials de los clientes que las declaran
  // (las consume HttpClientsOAuth2Config vía ClientRegistrationRepository).
  const oauthClients = clients.filter((c) => c.auth?.type === 'oauth2-client-credentials');
  if (oauthClients.length > 0) {
    lines.push('spring:', '  security:', '    oauth2:', '      client:', '        registration:');
    for (const client of oauthClients) {
      lines.push(
        `          ${client.id}:`,
        '            authorization-grant-type: client_credentials',
        `            client-id: ${envValue(profile, `${client.envPrefix}_CLIENT_ID`, 'changeme')}`,
        `            client-secret: ${envValue(profile, `${client.envPrefix}_CLIENT_SECRET`, 'changeme')}`
      );
      if (client.auth.scopes.length > 0) {
        lines.push(`            scope: ${client.auth.scopes.join(', ')}`);
      }
    }
    lines.push('        provider:');
    for (const client of oauthClients) {
      lines.push(
        `          ${client.id}:`,
        `            token-uri: ${envValue(profile, `${client.envPrefix}_TOKEN_URL`, tokenUri(client, profile))}`
      );
    }
  }

  const retryCalls = clients.flatMap((c) => c.calls.filter((call) => call.retry));
  const cbCalls = clients.flatMap((c) => c.calls.filter((call) => call.circuitBreaker));
  if (retryCalls.length === 0 && cbCalls.length === 0) return lines.join('\n') + '\n';

  lines.push('resilience4j:');
  if (retryCalls.length > 0) {
    lines.push('  retry:', '    instances:');
    for (const call of retryCalls) {
      const retry = call.retry;
      lines.push(
        `      ${call.instanceName}:`,
        `        max-attempts: ${retry.maxAttempts}`,
        `        wait-duration: ${retry.initialDelayMs ?? 500}ms`
      );
      if ((retry.backoff ?? 'exponential') === 'exponential') {
        lines.push('        enable-exponential-backoff: true', '        exponential-backoff-multiplier: 2');
        // Techo de la espera declarado por el diseño: sin él el backoff exponencial
        // crece sin cota y el último reintento puede caer muy lejos del timeout.
        if (retry.maxDelayMs != null) {
          lines.push(`        exponential-max-wait-duration: ${retry.maxDelayMs}ms`);
        }
      }
      const retryOn = retry.retryOn ?? ['timeout', '5xx', 'connection'];
      const exceptions = new Set();
      if (retryOn.includes('5xx')) exceptions.add('org.springframework.web.client.HttpServerErrorException');
      if (retryOn.includes('timeout') || retryOn.includes('connection')) {
        exceptions.add('org.springframework.web.client.ResourceAccessException');
      }
      if (exceptions.size > 0) {
        lines.push('        retry-exceptions:');
        for (const ex of exceptions) lines.push(`          - ${ex}`);
      }
      // Nunca reintentar 4xx (regla del DSL http-clients).
      lines.push('        ignore-exceptions:', '          - org.springframework.web.client.HttpClientErrorException');
    }
  }
  if (cbCalls.length > 0) {
    lines.push('  circuitbreaker:', '    instances:');
    for (const call of cbCalls) {
      const cb = call.circuitBreaker;
      lines.push(
        `      ${call.instanceName}:`,
        `        failure-rate-threshold: ${cb.failureRateThreshold ?? 50}`,
        `        sliding-window-size: ${cb.slidingWindowSize ?? 20}`,
        `        wait-duration-in-open-state: ${cb.waitDurationMs ?? 30000}ms`
      );
      // Qué llena la ventana. Sin esta lista el default de resilience4j cuenta TODA
      // excepción, así que un 4xx —que el retry de arriba sí excluye— o un bug del
      // adaptador abrían el circuito y dejaban al proveedor acusado de una caída que
      // no era suya. Misma tabla que las sobrecargas del fallback del adaptador
      // (src/lib/outbound-failures.js): son la misma pregunta y no pueden divergir.
      lines.push('        record-exceptions:');
      for (const fqn of recordedFailures()) lines.push(`          - ${fqn}`);
    }
  }
  return lines.join('\n') + '\n';
}

function testDbYaml(model) {
  if (model.persistenceKind === 'document') {
    // Flapdoodle arranca un mongod embebido, análogo de H2: sin contenedor y con el
    // ciclo de vida del contexto de Spring. Arranca STANDALONE, así que en este
    // perfil no hay transacciones multi-documento — de ahí el gestor no-op que
    // genera document-config.js.
    return (
      [
        'spring:',
        '  data:',
        '    mongodb:',
        '      database: testdb',
        '      auto-index-creation: false',
        'de:',
        '  flapdoodle:',
        '    mongodb:',
        '      embedded:',
        `        version: ${EMBEDDED_MONGO_VERSION}`
      ].join('\n') + '\n'
    );
  }
  return (
    [
      'spring:',
      '  datasource:',
      '    url: jdbc:h2:mem:testdb;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE',
      '    username: sa',
      '    password: ""',
      '  jpa:',
      '    hibernate:',
      '      ddl-auto: create-drop',
      '    properties:',
      '      hibernate:',
      '        auto_quote_keyword: true',
      '  flyway:',
      '    # El esquema del perfil test lo crea Hibernate en H2: las migraciones de',
      '    # db/migration/ están escritas para el dialecto real y no aplican aquí.',
      '    enabled: false'
    ].join('\n') + '\n'
  );
}

// Perfil test: base embebida en memoria (sin contenedores) —H2 en el modelo
// relacional, flapdoodle en el documental—; los tests lo activan desde
// src/test/resources/application.yaml.
function testProfileFiles(model) {
  const files = [];
  const fragments = [];

  if (model.layersPresent.persistence) {
    fragments.push(fragment('test', 'db', testDbYaml(model)));
  }

  // Storage: mismo generador que el resto de perfiles (endpoint local,
  // credenciales de juguete, aprovisionamiento desactivado y el mapa completo de
  // `storage.buckets.*`), para que el bean S3Client, el adaptador S3FileStorage y
  // el binding StorageProperties se creen en @SpringBootTest sin infra real ni
  // salida a la red. Igual que persistence recibe H2 en el perfil test.
  if (model.layersPresent.storage && model.stack.storage) {
    fragments.push(fragment('test', 'storage', storageYaml(model, 'test')));
  }

  // Enrutado de publicación: el bridge que genera build lee `${...:default}`,
  // pero el publisher que escribe el agente siguiendo la skill del broker lee el
  // destino sin default — y sin este fragmento el contexto de @SpringBootTest
  // muere con PlaceholderResolutionException antes de ejecutar ninguna prueba.
  // messagingYaml es reutilizable tal cual: todos sus valores pasan por
  // envWithDefault, que fuera de `local` produce ${VAR:default}.
  if (messagingApplies(model)) {
    fragments.push(fragment('test', 'messaging', messagingYaml(model, 'test')));
  }

  if (usesHttpIdempotency(model)) {
    fragments.push(fragment('test', 'idempotency', idempotencyYaml('test')));
  }

  // Correo: el binding de las propiedades `mail.*` y el JavaMailSender que
  // autoconfigura Boot se crean también en @SpringBootTest, o el contexto muere
  // al construir el adaptador. En test apunta al mismo localhost:1025 que en
  // local y NADA lo llama: el perfil test no ejercita el envío (eso es de los
  // escenarios de integración, que corren contra el Mailpit de infra/).
  if (model.layersPresent.mail) {
    fragments.push(fragment('test', 'mail', mailYaml(model, 'test')));
  }

  // Resource server JWT: sin issuer-uri ni jwk-set-uri, Boot no autoconfigura
  // ningún JwtDecoder y la SecurityFilterChain que genera build no se puede
  // construir — @SpringBootTest muere con NoSuchBeanDefinitionException. Se
  // siembra un jwk-set-uri de juguete porque, a diferencia de issuer-uri (que
  // resuelve el discovery OIDC), el JWK set se pide de forma perezosa en la
  // primera validación: basta para crear el decoder y no toca la red al arrancar.
  // El decoder no valida nada de verdad; solo permite que el contexto cargue.
  if (model.layersPresent.security && (model.security?.protocol === 'oidc' || model.security?.protocol === 'jwt')) {
    fragments.push(
      fragment('test', 'oauth2', [
        'spring:',
        '  security:',
        '    oauth2:',
        '      resourceserver:',
        '        jwt:',
        '          # Perfil test: no hay proveedor de identidad. Puerto 9 (discard) a',
        '          # propósito: si algo intentara resolverlo, falla en local y rápido.',
        '          jwk-set-uri: http://localhost:9/.well-known/jwks.json'
      ].join('\n') + '\n')
    );
  }

  // Clientes salientes. La `base-url` va SIEMPRE, aunque en este perfil no se
  // llame a nadie: el bean del RestClient se construye igual al levantar el
  // contexto y su @Value no tiene default, así que sin ella `contextLoads()`
  // —que es justo el gate de "todos los beans arrancan bajo el perfil test"—
  // falla con un PlaceholderResolutionException. Puerto 9 (discard): si algo
  // intentara salir de verdad, falla en local y rápido.
  //
  // OAuth2 saliente añade además una registration dummy para que el
  // ClientRegistrationRepository se cree sin proveedor real; los otros tipos de
  // auth usan @Value con default vacío y no lo necesitan.
  const oauthClients = (model.httpClients ?? []).filter((c) => c.auth?.type === 'oauth2-client-credentials');
  if (model.layersPresent.httpClients && (model.httpClients ?? []).length > 0) {
    const lines = ['http-clients:'];
    for (const client of model.httpClients) {
      lines.push(`  ${client.id}:`, '    base-url: http://localhost:9');
    }
    if (oauthClients.length > 0) {
      lines.push('spring:', '  security:', '    oauth2:', '      client:', '        registration:');
      for (const client of oauthClients) {
        lines.push(
          `          ${client.id}:`,
          '            authorization-grant-type: client_credentials',
          '            client-id: test',
          '            client-secret: test'
        );
      }
      lines.push('        provider:');
      for (const client of oauthClients) {
        lines.push(`          ${client.id}:`, '            token-uri: http://localhost/token');
      }
    }
    fragments.push(fragment('test', 'http-clients', lines.join('\n') + '\n'));
  }

  const header = ['# Perfil test: H2 en memoria, sin contenedores.'];
  files.push({
    path: 'src/main/resources/application-test.yaml',
    content:
      fragments.length > 0
        ? [...header, 'spring:', '  config:', '    import:', ...fragments.map(({ name }) => `      - "classpath:parameters/test/${name}.yaml"`)].join('\n') + '\n'
        : '# Perfil test: sin configuración específica (el diseño no tiene persistencia).\n'
  });
  files.push(...fragments.map(({ path, content }) => ({ path, content })));

  // El perfil `test` lo activa @ActiveProfiles en la clase de prueba, NO un
  // application.yaml en src/test/resources. Ese archivo tendría el mismo nombre
  // que el de main y va delante en el classpath del source set `test`: lo OCULTA
  // entero, así que bajo ese perfil desaparece todo lo que declara —empezando por
  // `spring.application.name`, que es lo que las skills prescriben como groupId de
  // un listener— y el contexto muere resolviendo una propiedad que en cualquier
  // otro perfil existe. Se ve como un fallo del bean, no como lo que es.

  return files;
}

// Barrido de reconciliación: los tres números con los que decide, y de dónde sale cada
// uno. NO son la misma clase de decisión, y por eso solo uno lo declara el diseño.
//
//   - `unanswered-after-seconds` — CUÁNTO SILENCIO SE TOLERA. Es del diseño
//     (`dependencies.activations.<a>.unansweredAfterSeconds`): depende de cuánto tarda
//     razonablemente ESE proveedor en contestar, que es conocimiento de negocio. Por
//     activación, porque un mismo barrido puede reconciliar varias.
//   - `claim-timeout-ms` — CUÁNTO RETIENE UN CANDIDATO una réplica que murió con el lote
//     en vuelo. Mecánica de multi-réplica, no contrato: el generador ya la resuelve igual
//     en `outbox.relay.claim-timeout-ms` sin preguntarle al diseño.
//   - `batch-size` — CUÁNTO TRABAJO CABE EN UNA PASADA. Capacidad, familia de los
//     backoffs: se ajusta con datos de producción delante, no en la mesa de diseño.
//
// Que los dos últimos NO estén en el diseño no es un olvido: el DSL veta los conceptos
// de solución disfrazados de neutrales, y meterlos ahí habría hecho que el diseño
// declarase mecánica en vez de decisiones.
function reconciliationYaml(model, profile) {
  const lines = ['reconciliation:'];
  for (const { dependency, activation } of reconciledActivations(model)) {
    const key = kebabCase(activation.name);
    lines.push(
      `  ${key}:`,
      `    # Encargos a ${dependency} sin desenlace pasado este tiempo: candidatos del barrido.`,
      '    # Lo declara el DISEÑO; aquí solo se parametriza para poder moverlo por entorno.',
      `    unanswered-after-seconds: ${envWithDefault(
        profile,
        `RECONCILIATION_${screamingSnake(activation.name)}_UNANSWERED_AFTER_SECONDS`,
        activation.unansweredAfterSeconds ?? 3600
      )}`,
      '    # Caducidad del reclamo: una réplica que muere con el lote en vuelo retiene sus',
      '    # candidatos hasta que pasa esto. Del generador, no del diseño.',
      `    claim-timeout-ms: ${envWithDefault(
        profile,
        `RECONCILIATION_${screamingSnake(activation.name)}_CLAIM_TIMEOUT_MS`,
        60000
      )}`,
      '    # Cota del lote por pasada: sin ella, una tanda con 50.000 atascados son 50.000',
      '    # llamadas al proveedor de una vez. Del generador, no del diseño.',
      `    batch-size: ${envWithDefault(
        profile,
        `RECONCILIATION_${screamingSnake(activation.name)}_BATCH_SIZE`,
        50
      )}`
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * El plazo de los rescates: cuánto puede llevar una fila en un estado EN VUELO antes de
 * darla por abandonada.
 *
 * Está aquí y no en el diseño por lo mismo que `claim-timeout-ms`: es la caducidad de un
 * reclamo —«asumimos que la réplica que la tomó murió»—, mecánica de multi-réplica y no
 * una decisión de negocio. Lo que SÍ sale del diseño es el reloj sobre el que se mide (el
 * campo `<estado>Since`/`<estado>At` de la entidad), y sin él build no genera el rescate.
 *
 * Se distingue de `reconciliation.<x>.unanswered-after-seconds`, que sí es del diseño:
 * allí lo que se espera es el desenlace de un TERCERO y cuánto silencio se le tolera es
 * un acuerdo con él.
 */
function sweepYaml(model, profile) {
  const lines = ['sweep:'];
  // La cota del lote va por OPERACIÓN —una pasada es una unidad de trabajo, y sus reclamos se
  // la reparten—, mientras que el plazo de abandono va por RECLAMO atascado, que es donde se
  // mide. Por eso son dos claves distintas y no una anidada: mover `stalled-after-seconds`
  // bajo la operación cambiaría variables de entorno que ya pueden estar desplegadas.
  for (const key of sweepBatchKeys(model)) {
    lines.push(
      `  ${key}:`,
      '    # Cota del lote por pasada: sin ella, una tanda con 50.000 filas atrasadas se procesa',
      '    # entera de una vez. Del generador, no del diseño: es capacidad, y se ajusta con datos',
      '    # de producción delante. Misma familia que outbox.relay.batch-size.',
      `    batch-size: ${envWithDefault(profile, `SWEEP_${screamingSnake(key)}_BATCH_SIZE`, SWEEP_BATCH_DEFAULT)}`
    );
  }
  for (const { operation, claim } of stalledClaims(model)) {
    lines.push(
      `  ${claim.stalled.configKey}:`,
      `    # ${operation.name}: un ${claim.entity} lleva más de esto en ${claim.stalled.state} —medido sobre`,
      `    # ${claim.stalled.stampField}— y se da por abandonado, así que otra réplica lo rescata.`,
      '    # Del generador, no del diseño. Tiene que quedar POR ENCIMA de lo que tarda un ciclo',
      '    # completo: por debajo, el rescate le arranca el trabajo a quien lo está haciendo.',
      `    stalled-after-seconds: ${envWithDefault(
        profile,
        `SWEEP_${screamingSnake(claim.suffix)}_STALLED_AFTER_SECONDS`,
        claim.stalled.defaultSeconds
      )}`
    );
  }
  return lines.join('\n') + '\n';
}

/** Los rescates que build generó, con la operación que los dispara. */
/**
 * Las operaciones de barrido que tienen algún reclamo, en orden y sin repetir.
 *
 * No coincide con `stalledClaims`: un barrido puede tener solo reclamo de COLA, sin rescate
 * —no todo estado de trabajo es un estado en vuelo con reloj—, y ese también acota su lote.
 */
function sweepBatchKeys(model) {
  const keys = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      for (const claim of operation.claim ?? []) {
        if (claim.sweepKey && !keys.includes(claim.sweepKey)) keys.push(claim.sweepKey);
      }
    }
  }
  return keys;
}

function stalledClaims(model) {
  const found = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      for (const claim of operation.claim ?? []) {
        if (claim.stalled) found.push({ operation, claim });
      }
    }
  }
  return found;
}

/** Activaciones con barrido declarado, que son las que tienen parámetros que emitir. */
function reconciledActivations(model) {
  const found = [];
  for (const dependency of model.dependencies ?? []) {
    for (const activation of dependency.activations ?? []) {
      if (activation.reconciledBy) found.push({ dependency: dependency.id, activation });
    }
  }
  return found;
}
