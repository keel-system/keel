// Configuración multi-ambiente del servicio generado (patrón del proyecto de
// referencia): application.yaml base + application-<perfil>.yaml que solo
// importa fragmentos parameters/<perfil>/*.yaml, con gradiente de env vars
// (local literal → develop ${VAR:default} → production ${VAR} obligatoria).
// El perfil activo se elige con la variable de entorno PROFILE (default local).

import { DATABASES } from '../lib/stack-catalog.js';
import { physicalBucketName } from '../lib/buckets.js';
import { screamingSnake } from '../lib/naming.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';
import { usesHttpIdempotency } from './http-idempotency.js';
import { usesCorrelation } from './correlation.js';

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
    if (layersPresent.httpClients && model.httpClients) {
      fragments.push(fragment(profile, 'http-clients', httpClientsYaml(model, profile)));
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
  if (layersPresent.persistence) {
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
  // Saca el correlationId que CorrelationContext deja en el MDC a cada línea de
  // log: es lo que permite reconstruir una petición completa (y los eventos que
  // provocó) a partir del identificador que el cliente recibió en la respuesta.
  if (usesCorrelation(model)) {
    lines.push('  pattern:', '    correlation: "[%X{correlationId:-}] "');
  }
  return lines.join('\n') + '\n';
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
  const lines = [
    'spring:',
    '  datasource:',
    `    url: ${envValue(profile, 'DB_URL', db.jdbcUrl(dbName))}`,
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
  lines.push(...flywayLines(profile));
  return lines.join('\n') + '\n';
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
      `    password: ${envValue(profile, 'RABBITMQ_PASSWORD', 'guest')}`
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
    '    # TODO (agente): topics y deserialización de consumo según messaging.keel.yaml'
  ].join('\n') + '\n';
}

// Destino y claves de enrutado de los eventos publicados: contrato de
// integración, así que se parametriza (el código solo lee @Value). El nombre
// físico del exchange/topic puede diferir por ambiente.
function messagingYaml(model, profile) {
  const lines = [];
  if (model.events.length > 0) {
    const first = model.events[0];
    lines.push(
      'messaging:',
      '  publishing:',
      `    destination: ${envWithDefault(profile, 'MESSAGING_DESTINATION', first.destinationDefault)}`,
      '    routing-keys:'
    );
    for (const event of model.events) {
      const key = event.routingKeyProperty.split('.').pop();
      lines.push(`      ${key}: ${event.routingKeyDefault}`);
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
      `    max-attempts: ${envWithDefault(profile, 'OUTBOX_RELAY_MAX_ATTEMPTS', 10)}`,
      '    # Backoff exponencial entre reintentos de una misma fila (initial·2^(n-1),',
      '    # con tope max-ms): evita el hot-looping si el broker está caído.',
      '    backoff:',
      `      initial-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_BACKOFF_INITIAL_MS', 1000)}`,
      `      max-ms: ${envWithDefault(profile, 'OUTBOX_RELAY_BACKOFF_MAX_MS', 60000)}`,
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
      lines.push('          # cognito-local de prueba del docker-compose; crea el user pool y ajusta su id en el issuer.');
    }
    lines.push(`          issuer-uri: ${envValue(profile, 'OAUTH2_ISSUER_URI', 'http://localhost:9229/local_userpool')}`);
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
      if (bucket.allowedContentTypes.length > 0) {
        lines.push(`      allowed-content-types: ${bucket.allowedContentTypes.join(',')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
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
      lines.push(`    # TODO (agente): URL del servicio de prueba/mock para ${client.id}.`);
    }
    lines.push(`    base-url: ${envRequired(profile, envVar, 'http://localhost:8081')}`);
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
        `            token-uri: ${envValue(profile, `${client.envPrefix}_TOKEN_URL`, client.auth.tokenUrl)}`
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
    }
  }
  return lines.join('\n') + '\n';
}

// Perfil test: H2 en memoria (sin contenedores); los tests lo activan desde
// src/test/resources/application.yaml.
function testProfileFiles(model) {
  const files = [];
  const fragments = [];

  if (model.layersPresent.persistence) {
    fragments.push(
      fragment('test', 'db', [
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
      ].join('\n') + '\n')
    );
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

  // OAuth2 saliente: registration dummy para que el ClientRegistrationRepository
  // (y con él HttpClientsOAuth2Config) se cree en @SpringBootTest sin proveedor
  // real. Los demás tipos de auth usan @Value con default vacío y no lo necesitan.
  const oauthClients = (model.httpClients ?? []).filter((c) => c.auth?.type === 'oauth2-client-credentials');
  if (model.layersPresent.httpClients && oauthClients.length > 0) {
    const lines = ['spring:', '  security:', '    oauth2:', '      client:', '        registration:'];
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

  files.push({
    path: 'src/test/resources/application.yaml',
    content: ['spring:', '  profiles:', '    active: test', ''].join('\n')
  });

  return files;
}
