// Configuración multi-ambiente del servicio generado (patrón del proyecto de
// referencia): application.yaml base + application-<perfil>.yaml que solo
// importa fragmentos parameters/<perfil>/*.yaml, con gradiente de env vars
// (local literal → develop ${VAR:default} → production ${VAR} obligatoria).
// El perfil activo se elige con la variable de entorno PROFILE (default local).

import { DATABASES } from '../lib/stack-catalog.js';

const PROFILES = ['local', 'develop', 'production'];

// Credenciales de juguete del perfil local (mismo criterio que minioadmin en el
// compose de prueba): existen para que los escenarios de validación autentiquen
// sin editar YAML a mano, y nunca salen de local.
const LOCAL_API_KEY = 'local-dev-api-key';
const localClientApiKey = (clientName) => `local-${clientName}-key`;

// Gradiente de externalización: literal en local, env var con default en
// develop y env var obligatoria (sin default) en production.
function envValue(profile, varName, localValue) {
  if (profile === 'local') return String(localValue);
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
    if (layersPresent.persistence) {
      fragments.push(fragment(profile, 'db', dbYaml(model, profile, dbName)));
    }
    if (layersPresent.messaging && stack.broker) {
      fragments.push(fragment(profile, stack.broker, brokerYaml(model, profile)));
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
    'spring:',
    '  application:',
    `    name: ${service.name}`,
    '  threads:',
    '    virtual:',
    '      enabled: true',
    '  profiles:',
    '    # Perfil activo por variable de entorno; local para desarrollo en la máquina.',
    '    active: ${PROFILE:local}'
  ];
  if (layersPresent.persistence) {
    lines.push('  jpa:', '    open-in-view: false');
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
  return [
    'logging:',
    '  level:',
    `    root: ${envWithDefault(profile, 'LOG_LEVEL_ROOT', root)}`,
    `    ${model.service.basePackage}: ${envWithDefault(profile, 'LOG_LEVEL_APP', app)}`
  ].join('\n') + '\n';
}

function dbYaml(model, profile, dbName) {
  const db = DATABASES[model.stack.database] ?? DATABASES.postgresql;
  const lines = [
    'spring:',
    '  datasource:',
    `    url: ${envValue(profile, 'DB_URL', db.jdbcUrl(dbName))}`,
    `    username: ${envValue(profile, 'DB_USERNAME', db.user(dbName))}`,
    `    password: ${envValue(profile, 'DB_PASSWORD', db.password)}`,
    '  jpa:',
    '    hibernate:'
  ];
  if (profile === 'production') {
    lines.push('      # En producción el esquema lo gobiernan las migraciones, nunca Hibernate.', '      ddl-auto: validate');
  } else {
    lines.push('      # El agente decide el esquema definitivo (migraciones); update solo para arrancar.', '      ddl-auto: update');
  }
  lines.push(`    show-sql: ${profile === 'local'}`);
  return lines.join('\n') + '\n';
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
    '      # Publica el EventEnvelope como JSON.',
    '      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer',
    '    consumer:',
    `      group-id: ${envWithDefault(profile, 'KAFKA_GROUP_ID', `${service.artifactId}-group`)}`,
    '      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer',
    '      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer',
    '    # TODO (agente): topics y deserialización de consumo según messaging.keel.yaml'
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
function securityApplies(model) {
  const sec = model.security;
  if (!sec) return false;
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
  return lines.join('\n') + '\n';
}

// Config del object storage (clave propia 'storage', consumida por el adaptador
// S3FileStorage/S3Config que genera el scaffolding). MinIO local coincide con el
// docker-compose; S3 usa los endpoints por defecto del SDK (sin endpoint explícito).
function storageYaml(model, profile) {
  const { stack } = model;
  const isMinio = stack.storage === 'minio';
  const lines = [
    'storage:',
    `  provider: ${stack.storage}`,
    `  bucket: ${envValue(profile, 'STORAGE_BUCKET', `${model.service.name}-files`)}`
  ];
  if (isMinio) {
    lines.push(`  endpoint: ${envValue(profile, 'STORAGE_ENDPOINT', 'http://localhost:9000')}`);
  } else if (profile === 'local') {
    lines.push('  # S3 real: el endpoint lo resuelve el SDK por región; define STORAGE_ENDPOINT solo para un compatible.');
  }
  lines.push(
    `  region: ${envValue(profile, 'STORAGE_REGION', 'us-east-1')}`,
    `  access-key: ${envValue(profile, 'STORAGE_ACCESS_KEY', isMinio ? 'minioadmin' : 'changeme')}`,
    `  secret-key: ${envValue(profile, 'STORAGE_SECRET_KEY', isMinio ? 'minioadmin' : 'changeme')}`,
    isMinio ? '  path-style-access: true' : '  path-style-access: false'
  );
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
        '      ddl-auto: create-drop'
      ].join('\n') + '\n')
    );
  }

  // Storage: valores dummy para que el bean S3Client (S3Config) y el adaptador
  // S3FileStorage se creen en @SpringBootTest sin infra real (no conectan al
  // construirse). Igual que persistence recibe H2 en el perfil test.
  if (model.layersPresent.storage) {
    fragments.push(
      fragment('test', 'storage', [
        'storage:',
        '  provider: s3',
        '  bucket: test-bucket',
        '  region: us-east-1',
        '  access-key: test',
        '  secret-key: test',
        '  path-style-access: true'
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
