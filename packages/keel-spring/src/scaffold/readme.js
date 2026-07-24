// README.md del servicio generado: procedencia, cómo ejecutarlo, infraestructura
// de prueba y qué queda pendiente para el agente (/keel-generate-spring).

import { JAVA_VERSION, packageVersion } from '../lib/assets.js';
import { selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools } from './devtools.js';
import { usesOutbox } from './outbox.js';
import { usesIdempotency } from './idempotency.js';

export function generate(model) {
  const { service, layersPresent, stack } = model;
  const selected = selectedInfra(model);
  const infra = infraRows(selected);
  const hasDevtools = needsDevtools(selected);

  const lines = [
    `# ${service.projectName}`,
    '',
    service.description,
    '',
    `Generado desde \`specs/${service.name}\` v${service.version} por keel-spring ${packageVersion()} (scaffolding transversal al stack).`,
    '',
    '## Ejecutar',
    '',
    '```bash'
  ];
  if (infra.length > 0) lines.push('docker compose -f infra/docker-compose.yaml up -d   # infraestructura de prueba');
  lines.push('./gradlew bootRun', './gradlew build -x test', '```', '', `Requiere Java ${JAVA_VERSION} (el wrapper de Gradle va incluido; en Windows usa \`gradlew.bat\`).`, '');

  if (infra.length > 0) {
    lines.push(
      '## Infraestructura de prueba',
      '',
      'Elegida en el cuestionario de `keel-spring build` y persistida en `keel-stack.json`',
      '(bórralo y re-ejecuta el build con `--force` para cambiarla).',
      '',
      '| Servicio | Imagen | Puerto |',
      '|---|---|---|',
      ...infra.map(({ name, image, port }) => `| ${name} | ${image} | ${port} |`)
    );
    if (hasDevtools) {
      lines.push(`| devtools (validación) | alpine:3.20 (build local) | — (interno) |`);
    }
    lines.push('');
  }
  if (layersPresent.persistence) {
    lines.push('El perfil `test` usa H2 en memoria (no necesita contenedores): queda listo para la suite de pruebas unitarias, que es un proceso posterior a la validación funcional.', '');
  }

  if (infra.length > 0) {
    lines.push(
      '## Validación de infraestructura',
      '',
      'Todo lo relativo a la infraestructura de prueba vive en `infra/`. Antes de ejercitar',
      'los escenarios funcionales, levántala y sondéala (con podman, exporta `CONTAINER_RUNTIME=podman`):',
      '',
      '```bash',
      'docker compose -f infra/docker-compose.yaml up -d',
      'bash infra/validate-infra.sh   # un check por tecnología; sale != 0 si algo falla',
      '```',
      '',
      'Si la BD del stack lo permite, `infra/reset-db.sh` vacía los datos (esquema intacto):',
      'se ejecuta antes de cada flujo `FL-*` de la validación funcional, cuyos Given asumen BD limpia.',
      ''
    );
    if (hasDevtools) {
      lines.push(
        `El contenedor \`${service.name}-devtools\` trae solo las CLIs del stack elegido; sondéalas a mano con`,
        `\`docker exec ${service.name}-devtools <cli> ...\` (p. ej. \`psql\`, \`redis-cli\`, \`kcat\`, \`mc\`, \`aws\`).`,
        ''
      );
    }
  }

  lines.push(
    '## Perfiles y ambientes',
    '',
    'El perfil activo se elige con la env var `PROFILE` (default `local`): `local`, `develop`, `production` y `test`.',
    'Cada `application-<perfil>.yaml` importa sus fragmentos de `src/main/resources/parameters/<perfil>/`,',
    'con gradiente de externalización: local usa valores literales (los del docker-compose), develop env vars',
    'con default (`${VAR:default}`) y production env vars obligatorias sin default (`${VAR}`).',
    '',
    '```bash',
    'PROFILE=production DB_URL=... DB_USERNAME=... DB_PASSWORD=... java -jar build/libs/*.jar',
    '```',
    '',
    ...productionSection(model),
    '## Qué genera el scaffolding y qué completa el agente',
    '',
    'El scaffolding (transversal al stack, re-ejecutable con `keel-spring build`) produce la arquitectura hexagonal + CQRS',
    'del prototipo de referencia, en un único microservicio (sin paquete shared ni Spring Modulith): dominio puro',
    '(`domain/aggregate|entity|valueobject|enums|errors|events` + puertos en `domain/repository`), capa application',
    '(commands/queries con Bean Validation, handlers stub en `usecases/`, ResponseDtos y mappers), e infraestructura',
    '(entidades `Jpa` con auditoría automática, adaptadores `RepositoryImpl` con mapeo explícito, `UseCaseMediator`',
    'con la frontera transaccional (la capa application no importa Spring: `@ApplicationComponent` propia),',
    '`@LogExceptions` con su aspecto, contratos `EventEnvelope`/`EventMetadata` con puertos `<Evento>Publisher` y stub,',
    'controllers `V1` con springdoc y `ApiExceptionHandler`), más configuración por perfiles y la infraestructura de prueba en `infra/`.',
    'El código que depende de la infraestructura elegida (publishers/listeners del broker, adaptador de storage)',
    'lo escribe el agente siguiendo las skills por tecnología `.claude/skills/keel-spring-<tech>/` (instaladas solo las del stack de `keel-stack.json`).',
    'El punto de entrada para el agente es `.claude/CLAUDE.md` (junto con `.claude/architecture.md` y',
    '`.claude/constitution.md`); el repo es autosuficiente: incluye el diseño (snapshot en `specs/`), la skill y las',
    'guías del stack en `.claude/`.',
    '',
    'Swagger UI (local/develop): http://localhost:8080/swagger-ui.html — deshabilitado en production.',
    '',
    'Pendiente para el agente (`/keel-generate-spring`):',
    '',
    '- Implementar los `handle(...)` con `// TODO (agente)` en `application/usecases/` (reglas, precondiciones, errores).',
    '- Proteger los invariantes marcados con `// TODO invariante` en `domain/aggregate/`.',
    '- Validación funcional: ejecutar los escenarios `FL-*` de `specs/validation-scenarios.md` contra el servidor real hasta el 100% en OK (las pruebas unitarias son un proceso posterior, fuera de la generación).'
  );

  const pendingLayers = [];
  if (layersPresent.security && stack.auth === 'keycloak') {
    pendingLayers.push('- `security`: el `SecurityFilterChain` ya está generado; crea el realm en el Keycloak de prueba (http://localhost:8180, admin/admin).');
  }
  if (layersPresent.messaging) {
    pendingLayers.push('- `messaging`: haz `raise(...)` de cada evento en el método de negocio del agregado (la traducción a evento de integración y la entrega ya están generadas) e implementa el envío al broker — `OutboxDispatcher` o `<Evento>Publisher` según la `reliability` — y los `<Evento>Listener` de las suscripciones, según la skill `.claude/skills/keel-spring-<broker>/`.');
  }
  if (layersPresent.storage) {
    pendingLayers.push('- `storage`: implementa el adaptador de `FileStorage` (bean del cliente + upload/download/delete/signedUrl) según la skill `.claude/skills/keel-spring-s3/`.');
  }
  if (layersPresent.httpClients) {
    pendingLayers.push('- `http-clients`: puerto + adaptador RestClient + mapper ACL ya generados; completa los `*Fallback` (y el tipado records/mapper solo en llamadas declaradas en prosa).');
  }
  if (stack.cache) pendingLayers.push('- `cache`: configurar Spring Cache según las políticas `cache` de use-cases.');
  if (pendingLayers.length > 0) lines.push(...pendingLayers);

  if (model.warnings.length > 0) {
    lines.push('', '## Avisos del scaffolding', '');
    for (const warning of model.warnings) lines.push(`- ${warning}`);
  }

  lines.push('');
  return [{ path: 'README.md', content: lines.join('\n') }];
}

// Filas de la tabla de infraestructura, derivadas del catálogo (misma fuente que
// el docker-compose): cada tecnología elegida que levanta contenedor.
function infraRows(selected) {
  return selected.map(({ entry }) => ({ name: entry.label, image: entry.image, port: entry.port }));
}

// Sección «Despliegue en producción»: pasos ordenados para levantar el servidor
// con el perfil production y la tabla de parámetros obligatorios. El flujo
// /keel-generate-spring la revisa y completa antes del commit con lo que el
// agente cableó al implementar los adaptadores del stack.
function productionSection(model) {
  const { layersPresent } = model;
  const params = productionParameters(model);
  const optional = optionalParameters(model);

  const lines = [
    '## Despliegue en producción',
    '',
    'Pasos para levantar el servicio con el perfil `production` (esquema gobernado por',
    'migraciones — `ddl-auto: validate`, no crea ni altera tablas —, Swagger UI',
    'deshabilitado y logs `root` en `WARN`):',
    ''
  ];

  const steps = ['1. Construye el artefacto: `./gradlew build -x test` (produce `build/libs/*.jar`).'];
  if (layersPresent.persistence) {
    steps.push('2. Aplica las migraciones de esquema contra la base de datos destino (en production Hibernate solo valida el esquema, no lo crea ni lo altera).');
  }
  const n = layersPresent.persistence ? 3 : 2;
  steps.push(
    `${n}. Exporta las variables de entorno obligatorias de la tabla de abajo (secretos y endpoints reales del ambiente; en production ninguna trae valor por defecto).`,
    `${n + 1}. Arranca el servicio: \`PROFILE=production java -jar build/libs/*.jar\`.`,
    `${n + 2}. Verifica el arranque en los logs y contra el endpoint del servicio antes de darle tráfico (Swagger UI está deshabilitado en production).`
  );
  lines.push(...steps, '');

  lines.push('### Parámetros obligatorios', '');
  if (params.length > 0) {
    lines.push('| Variable | Para qué |', '|---|---|', ...params.map(({ name, purpose }) => `| \`${name}\` | ${purpose} |`), '');
  } else {
    lines.push('El diseño no declara ningún parámetro obligatorio en production (sin persistencia, broker, cache, seguridad, storage ni clientes HTTP externos).', '');
  }

  if (optional.length > 0) {
    lines.push(
      `Además hay parámetros operativos con valor por defecto (no obligatorios): ${optional.map((v) => `\`${v}\``).join(', ')}. ` +
        'Solo defínelos si necesitas cambiar su default.',
      ''
    );
  }

  lines.push(
    'El flujo `/keel-generate-spring` revisa y completa esta guía antes del commit: si al',
    'implementar los adaptadores del stack (publishers/listeners del broker, adaptador de',
    'storage, auth saliente de los clientes HTTP) el agente introduce parámetros nuevos,',
    'quedan reflejados aquí. Fuente de verdad: los fragmentos',
    '`src/main/resources/parameters/production/*.yaml` — todo `${VAR}` sin default es obligatorio.',
    ''
  );
  return lines;
}

// Parámetros obligatorios en production: los `${VAR}` sin default que emite
// config.js (envValue/envRequired en el perfil production). Debe seguir el
// gradiente de config.js; si allí cambia qué es obligatorio en production,
// actualízalo aquí. Los envWithDefault (con default) se listan como operativos.
function productionParameters(model) {
  const { layersPresent, stack, security, httpClients } = model;
  const params = [];

  if (layersPresent.persistence) {
    params.push(
      { name: 'DB_URL', purpose: 'URL JDBC de la base de datos.' },
      { name: 'DB_USERNAME', purpose: 'Usuario de la base de datos.' },
      { name: 'DB_PASSWORD', purpose: 'Contraseña de la base de datos.' }
    );
  }

  if (layersPresent.messaging && stack.broker === 'kafka') {
    params.push({ name: 'KAFKA_BOOTSTRAP_SERVERS', purpose: 'Brokers Kafka (host:port, separados por coma).' });
  } else if (layersPresent.messaging && stack.broker === 'rabbitmq') {
    params.push(
      { name: 'RABBITMQ_HOST', purpose: 'Host de RabbitMQ.' },
      { name: 'RABBITMQ_PORT', purpose: 'Puerto de RabbitMQ.' },
      { name: 'RABBITMQ_USERNAME', purpose: 'Usuario de RabbitMQ.' },
      { name: 'RABBITMQ_PASSWORD', purpose: 'Contraseña de RabbitMQ.' }
    );
  } else if (layersPresent.messaging && stack.broker === 'snssqs') {
    params.push(
      { name: 'AWS_REGION', purpose: 'Región AWS de SNS/SQS.' },
      { name: 'AWS_ACCESS_KEY_ID', purpose: 'Access key de las credenciales AWS.' },
      { name: 'AWS_SECRET_ACCESS_KEY', purpose: 'Secret key de las credenciales AWS.' }
    );
  }

  if (stack.cache === 'redis' || stack.cache === 'valkey') {
    params.push(
      { name: 'REDIS_HOST', purpose: `Host de ${stack.cache} (protocolo Redis).` },
      { name: 'REDIS_PORT', purpose: `Puerto de ${stack.cache}.` }
    );
  }

  if (layersPresent.security && (security?.protocol === 'oidc' || security?.protocol === 'jwt')) {
    params.push({ name: 'OAUTH2_ISSUER_URI', purpose: 'Issuer del resource server OAuth2/OIDC que valida los tokens.' });
  }
  if (layersPresent.security && security) {
    const jwt = security.protocol === 'oidc' || security.protocol === 'jwt';
    if (security.protocol === 'api-key') {
      params.push({ name: 'SECURITY_API_KEY', purpose: 'Clave API que deben enviar los clientes del servicio.' });
    }
    if (jwt && security.serviceAuth?.validateAudience === true) {
      params.push({ name: 'SECURITY_AUDIENCE', purpose: 'Audiencia (claim `aud`) exigida a los tokens de clientes máquina.' });
    }
    if (security.serviceAuth?.protocol === 'api-key' && (security.serviceClients?.length ?? 0) > 0) {
      for (const client of security.serviceClients) {
        const varName = `API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`;
        params.push({ name: varName, purpose: `Clave API del cliente máquina \`${client.name}\`.` });
      }
    }
  }

  if (layersPresent.storage && stack.storage) {
    params.push(
      { name: 'STORAGE_BUCKET', purpose: 'Bucket de object storage.' },
      { name: 'STORAGE_REGION', purpose: 'Región del object storage.' },
      { name: 'STORAGE_ACCESS_KEY', purpose: 'Access key del object storage.' },
      { name: 'STORAGE_SECRET_KEY', purpose: 'Secret key del object storage.' }
    );
    if (stack.storage === 'minio') {
      params.push({ name: 'STORAGE_ENDPOINT', purpose: 'Endpoint del object storage compatible S3 (MinIO).' });
    }
  }

  if (layersPresent.httpClients && httpClients) {
    for (const client of httpClients) {
      params.push({ name: `${client.envPrefix}_BASE_URL`, purpose: `URL base del cliente HTTP \`${client.id}\`.` });
      const auth = client.auth?.type;
      if (auth === 'api-key') {
        params.push({ name: `${client.envPrefix}_API_KEY`, purpose: `Clave API saliente para \`${client.id}\`.` });
      } else if (auth === 'bearer-static') {
        params.push({ name: `${client.envPrefix}_TOKEN`, purpose: `Token bearer estático para \`${client.id}\`.` });
      } else if (auth === 'basic') {
        params.push(
          { name: `${client.envPrefix}_USERNAME`, purpose: `Usuario básico para \`${client.id}\`.` },
          { name: `${client.envPrefix}_PASSWORD`, purpose: `Contraseña básica para \`${client.id}\`.` }
        );
      } else if (auth === 'oauth2-client-credentials') {
        params.push(
          { name: `${client.envPrefix}_CLIENT_ID`, purpose: `client-id OAuth2 (client_credentials) para \`${client.id}\`.` },
          { name: `${client.envPrefix}_CLIENT_SECRET`, purpose: `client-secret OAuth2 para \`${client.id}\`.` },
          { name: `${client.envPrefix}_TOKEN_URL`, purpose: `token-uri del proveedor OAuth2 de \`${client.id}\`.` }
        );
      }
    }
  }

  return params;
}

// Parámetros operativos con default (envWithDefault): existen pero no bloquean
// el arranque en production; se listan como mención aparte.
function optionalParameters(model) {
  const { layersPresent, stack, events } = model;
  const vars = ['SERVER_PORT', 'LOG_LEVEL_ROOT', 'LOG_LEVEL_APP'];
  if (layersPresent.messaging && events.length > 0) vars.push('MESSAGING_DESTINATION');
  if (layersPresent.messaging && stack.broker === 'kafka') vars.push('KAFKA_GROUP_ID');
  if (usesOutbox(model)) vars.push('OUTBOX_RELAY_DELAY_MS', 'OUTBOX_RELAY_BATCH_SIZE', 'OUTBOX_PURGE_CRON', 'OUTBOX_PURGE_RETENTION_DAYS');
  if (usesIdempotency(model)) vars.push('PROCESSED_EVENT_PURGE_CRON', 'PROCESSED_EVENT_PURGE_RETENTION_DAYS');
  return vars;
}
