// README.md del servicio generado: procedencia, cómo ejecutarlo, infraestructura
// de prueba y qué queda pendiente para el agente (/keel-generate-spring).

import { JAVA_VERSION, packageVersion } from '../lib/assets.js';
import { selectedInfra } from '../lib/stack-catalog.js';
import { needsDevtools } from './devtools.js';
import { publishedUrls } from './deploy.js';
import { realmSpec } from './auth-provisioning.js';
import { generate as generateConfig } from './config.js';

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
  lines.push(
    './gradlew bootRun',
    './gradlew build -x test        # compilación y empaquetado (no ejecuta pruebas)',
    './gradlew integrationTest      # escenarios FL-* contra la infraestructura de arriba',
    './gradlew test                 # contextLoads(): el contexto arranca con perfil test (H2, sin infra)',
    '```',
    '',
    `Requiere Java ${JAVA_VERSION} (el wrapper de Gradle va incluido; en Windows usa \`gradlew.bat\`).`,
    ''
  );

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

  lines.push(...manualTestingSection(model));

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
    ...(layersPresent.persistence
      ? [
          'Hay además dos perfiles auxiliares, finos y aditivos, que se activan **sobre** otro',
          '(`PROFILE=local,<perfil>`) y sirven para trabajar el esquema: `schema-export` (Hibernate',
          'escribe el DDL de las entidades a `build/schema/baseline.sql` sin tocar la BD; lo usa',
          '`infra/export-schema.sh`) y `migrations` (Flyway aplica `db/migration/` y Hibernate solo',
          'valida, como en los ambientes desplegados).',
          ''
        ]
      : []),
    ...productionSection(model),
    ...docsSection(model),
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
    'lo escribe el agente siguiendo las skills por tecnología `keel-spring-<tech>` (instaladas solo las del stack de `keel-stack.json`).',
    'El punto de entrada para el agente es el archivo de contexto del repo (`AGENTS.md`, que `CLAUDE.md` importa),',
    'junto con `docs/keel/architecture.md` y `docs/keel/constitution.md`; el repo es autosuficiente: incluye el diseño',
    '(snapshot en `specs/`), los contratos formales (snapshot en `docs/`), las conventions en `docs/keel/` y —sembrados',
    'para Claude Code y para opencode— la skill del generador, sus agentes y las guías del stack elegido.',
    '',
    'Swagger UI (local/develop): http://localhost:8080/swagger-ui.html — deshabilitado en production.',
    '',
    'Pendiente para el agente (`/keel-generate-spring`):',
    '',
    '- Implementar los `handle(...)` con `// TODO (agente)` en `application/usecases/` (reglas, precondiciones, errores).',
    '- Proteger los invariantes marcados con `// TODO invariante` en `domain/aggregate/`.',
    '- Traducir los escenarios `FL-*` de `specs/validation-scenarios.md` a pruebas de integración en `src/integrationTest/` (la base `AbstractFlowIT` ya está generada) y dejar `./gradlew integrationTest` al 100% en OK. Las pruebas unitarias son un proceso posterior, fuera de la generación.'
  );

  const pendingLayers = [];
  if (layersPresent.persistence) {
    pendingLayers.push(
      '- `persistence`: producir el baseline de migraciones (`bash infra/export-schema.sh` con las entidades ya finales), ' +
        'revisarlo, verificarlo con el doble check estático y commitearlo como ' +
        '`src/main/resources/db/migration/V1__baseline_schema.sql` (sin él, `production` no arranca: Hibernate solo valida). ' +
        'Probarlo en vivo sobre una BD sin esquema queda para ti, a mano: ver «Despliegue en producción».'
    );
  }
  if (layersPresent.security && stack.auth === 'keycloak') {
    pendingLayers.push('- `security`: el `SecurityFilterChain` ya está generado; crea el realm en el Keycloak de prueba (http://localhost:8180, admin/admin).');
  }
  if (layersPresent.messaging) {
    pendingLayers.push('- `messaging`: haz `raise(...)` de cada evento en el método de negocio del agregado (la traducción a evento de integración y la entrega ya están generadas) e implementa el envío al broker — `OutboxDispatcher` o `<Evento>Publisher` según la `reliability` — y los `<Evento>Listener` de las suscripciones, según la skill `keel-spring-<broker>`.');
  }
  if (layersPresent.storage) {
    pendingLayers.push('- `storage`: implementa el adaptador de `FileStorage` (bean del cliente + los métodos que el puerto declare: los de lectura dependen de la visibilidad de los buckets) según la skill `keel-spring-s3`.');
  }
  if (layersPresent.httpClients) {
    pendingLayers.push('- `http-clients`: puerto + adaptador RestClient + mapper ACL ya generados; completa los `*Fallback` (y el tipado records/mapper solo en llamadas declaradas en prosa).');
  }
  if (layersPresent.dependencies) {
    pendingLayers.push(
      '- `dependencies`: `<Entidad>Projector` y `<Entidad>Reader` ya generados por cada réplica; completa la hidratación del Reader (`onMiss: fetch`) o el resultado degradado (`onMiss: degrade`). Nunca llames al Projector desde el listener: el camino es listener → guard → mediator → handler → Projector.'
    );
  }
  if (stack.cache) {
    pendingLayers.push(
      '- `cache`: anotar los adaptadores con `@Cacheable`/`@CacheEvict` usando las constantes de `CacheConfig` (el `CacheManager`, los TTL y el serializador ya están generados).'
    );
  }
  if (pendingLayers.length > 0) lines.push(...pendingLayers);

  if (model.warnings.length > 0) {
    lines.push('', '## Avisos del scaffolding', '');
    for (const warning of model.warnings) lines.push(`- ${warning}`);
  }

  lines.push('');
  return [{ path: 'README.md', content: lines.join('\n') }];
}

// Qué contiene cada archivo que produce /keel-docs. La clave del mapa es la
// ruta relativa dentro de docs/; la colección de flujos Postman lleva el nombre
// del servicio, así que se resuelve por sufijo (ver docFile).
const DOC_DESCRIPTIONS = {
  'overview.html': 'Panel visual del servicio: capas del diseño, operaciones, eventos y enlaces a los demás documentos. Punto de entrada para revisarlo de un vistazo.',
  'openapi.yaml': 'Contrato HTTP en OpenAPI 3.1: endpoints, parámetros, cuerpos, respuestas y errores. Es la fuente para generar clientes.',
  'openapi.html': 'Visor del contrato HTTP (Redoc) con el spec embebido: se abre con doble clic, sin servidor.',
  'asyncapi.yaml': 'Contrato de eventos en AsyncAPI 3.0: canales, mensajes publicados y suscripciones, con la envoltura `EventEnvelope`.',
  'asyncapi.html': 'Visor del contrato de eventos con el spec embebido: se abre con doble clic, sin servidor.',
  'postman/auth-collection.json': 'Colección Postman para obtener token: un request por rol y por cliente máquina (`client_credentials`). Impórtala primero.',
  'postman/*-collection.json': 'Colección Postman del servicio: una carpeta por flujo `FL-*` de la validación funcional, más una carpeta con todas las operaciones.'
};

// Descripción de un archivo copiado; la colección de flujos se identifica por
// sufijo porque su nombre incluye el del servicio.
function docFile(relative) {
  if (DOC_DESCRIPTIONS[relative]) return DOC_DESCRIPTIONS[relative];
  if (relative.startsWith('postman/') && relative.endsWith('-collection.json')) {
    return DOC_DESCRIPTIONS['postman/*-collection.json'];
  }
  return 'Documento derivado del diseño por `/keel-docs`.';
}

// Sección «Contratos y documentación»: snapshot de lo que /keel-docs derivó del
// diseño en docs/<servicio>/ del workspace y build copió a docs/. Se omite
// entera si el servicio aún no tiene contratos generados.
function docsSection(model) {
  const files = model.docs?.files ?? [];
  if (files.length === 0) return [];

  const { service } = model;
  return [
    '## Contratos y documentación',
    '',
    'En `docs/` va el snapshot de los contratos formales que la skill `/keel-docs` deriva del diseño.',
    `El canónico es \`docs/${service.name}/\` del workspace Keel y este snapshot **se refresca en cada`,
    '`keel-spring build`**: no los edites a mano aquí; si el diseño cambia, regenera con `/keel-docs` y',
    'vuelve a lanzar el build.',
    '',
    '| Archivo | Qué encontrarás |',
    '|---|---|',
    ...files.map(({ path: relative }) => `| [\`docs/${relative}\`](docs/${relative}) | ${docFile(relative)} |`),
    '',
    'Los `.html` son autocontenidos (llevan el spec embebido): se abren con doble clic, sin servidor ni red.',
    'Los enlaces del panel `overview.html` a `DESIGN.md` e `INTEGRATION.md` solo resuelven en el workspace:',
    'esos dos documentos los producen `/keel-handoff` y `/keel-integrate`, no `/keel-docs`, y no viajan en el snapshot.',
    ''
  ];
}

// Sección «Pruebas manuales en contenedor»: cómo levantar el servicio entero en
// deploy/ para probarlo con Postman o con un front. Es el otro destino de
// infraestructura del proyecto y la sección existe, sobre todo, para que nadie lo
// confunda con infra/, que es la de la generación.
function manualTestingSection(model) {
  const { service, layersPresent, stack } = model;
  const realm = stack.auth === 'keycloak' ? realmSpec(model) : null;

  const lines = [
    '## Pruebas manuales en contenedor',
    '',
    'Cuando el flujo de generación termina en verde, `deploy/` levanta el servicio **y** su',
    'infraestructura en contenedores, para probarlo a mano con Postman, con curl o con un front.',
    'Funciona igual con Docker que con Podman: el runtime se detecta solo, y se fuerza con',
    '`CONTAINER_RUNTIME=podman` si tienes los dos.',
    '',
    '```bash',
    'bash deploy/up.sh      # construye la imagen, levanta todo y espera a que responda',
    'bash deploy/down.sh    # apaga (con -v borra además los datos)',
    '```',
    '',
    '| URL | Qué es |',
    '|---|---|',
    ...publishedUrls(model).map(({ label, url }) => `| ${plainUrl(url)} | ${label} |`),
    '',
    'Los puertos publicados salen de `deploy/.env`: si ya tienes algo ocupando el 8080 o el 5432,',
    'cámbialo ahí y vuelve a ejecutar `up.sh`.',
    ''
  ];

  if (realm) {
    lines.push(
      `El realm \`${realm.realm}\` se importa al arrancar Keycloak, ya poblado con lo que declara el diseño:`,
      `un usuario por rol (username = rol: ${realm.users.map((user) => user.username).join(', ')}), todos con contraseña`,
      `\`${realm.password}\`, y los clientes máquina con sus secretos. No hay que ejecutar nada para provisionarlo.`,
      '',
      '```bash',
      `curl -s -d 'grant_type=password&client_id=${realm.userClient}&username=${realm.users[0].username}&password=${realm.password}' \\`,
      `  http://localhost:8180/realms/${realm.realm}/protocol/openid-connect/token | jq -r .access_token`,
      '```',
      '',
      'Aviso sobre el token: dentro de la red de contenedores la app alcanza a Keycloak como',
      '`keycloak:8080`, pero tú pides el token contra `localhost:8180`, así que el `iss` no coincidiría.',
      'Por eso el contenedor valida con `jwk-set-uri` en vez de `issuer-uri`: **aquí no se comprueba el claim',
      '`iss`** (sí la firma, la caducidad, la audiencia y los roles). La validación completa sigue viva en el',
      'perfil `local` y en `./gradlew integrationTest`, que hablan con Keycloak por la misma URL que la app.',
      ''
    );
  }

  if (layersPresent.persistence) {
    lines.push(
      'El contenedor corre con el perfil `develop`, que aplica las migraciones de `db/migration/` y deja a',
      'Hibernate solo validando el esquema. Por eso **necesita el baseline**: hasta que exista',
      '`src/main/resources/db/migration/V1__baseline_schema.sql` —lo produce el pase de calidad del flujo de',
      'generación— la app arrancará y morirá diciendo que el esquema no valida. Es lo correcto: preferimos',
      'eso a que un despliegue arranque contra un esquema que nadie ha declarado.',
      ''
    );
  }

  lines.push(
    `\`deploy/\` y \`infra/\` no son lo mismo y no conviene tenerlos arriba a la vez (publican los mismos`,
    `puertos): \`infra/\` es la infraestructura **de la generación**, con el toolbox \`${service.name}-devtools\` y`,
    'sus scripts de sondeo y reset, y ahí la app corre fuera del contenedor. `deploy/` es el servicio ya',
    'empaquetado, para una persona.',
    ''
  );
  return lines;
}

// El README lo lee una persona: las URLs van con su puerto por defecto, no con la
// sintaxis de interpolación del compose.
function plainUrl(url) {
  return `<${url.replace(/\$\{[A-Z_]+:-(\d+)\}/g, '$1')}>`;
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
  const { required: params, optional } = productionParameters(model);

  const lines = [
    '## Despliegue en producción',
    '',
    'Pasos para levantar el servicio con el perfil `production` (esquema gobernado por',
    'las migraciones Flyway de `src/main/resources/db/migration/` — `ddl-auto: validate`,',
    'Hibernate no crea ni altera tablas —, Swagger UI deshabilitado y logs `root` en `WARN`):',
    ''
  ];

  const steps = ['1. Construye el artefacto: `./gradlew build -x test` (produce `build/libs/*.jar`).'];
  if (layersPresent.persistence) {
    steps.push(
      '2. Comprueba que `src/main/resources/db/migration/` contiene el baseline (`V1__baseline_schema.sql`) ' +
        'y las migraciones posteriores: Flyway las aplica al arrancar y registra cada una en `flyway_schema_history`. ' +
        'Si tu ambiente exige aplicarlas en un paso previo al despliegue, arranca una única instancia con ' +
        '`FLYWAY_ENABLED=true` y el resto con `FLYWAY_ENABLED=false`, o ejecuta Flyway por CLI contra la misma carpeta.',
      '3. **Prueba el baseline sobre una BD sin esquema — este paso es tuyo y el pipeline no lo ejecuta.** ' +
        'El pase de calidad entrega el baseline exportado de las entidades y verificado en estático (`baselineTested: PENDING`), ' +
        'pero solo está *probado* si ha creado el esquema desde cero: contra una BD que Hibernate ya pobló con ' +
        '`ddl-auto: update`, el `validate` pasaría sin ejercitar la migración. Con la infraestructura local:\n\n' +
        '   ```bash\n' +
        '   docker compose -f infra/docker-compose.yaml down -v   # borra el volumen: BD sin esquema\n' +
        '   docker compose -f infra/docker-compose.yaml up -d\n' +
        '   PROFILE=local,migrations ./gradlew bootRun            # Flyway crea, Hibernate valida\n' +
        '   ```\n\n' +
        '   Arranque limpio = baseline correcto. Un fallo de `validate` aquí es exactamente el que tendrías en ' +
        'producción, y dice qué columna o tipo no cuadra: corrige el SQL y repite.'
    );
  }
  const n = layersPresent.persistence ? 4 : 2;
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

// Parámetros de production, derivados del artefacto real: se recorren los
// fragmentos `parameters/production/*.yaml` (y el application.yaml base) que
// acaba de generar config.js y se separan los `${VAR}` sin default —obligatorios,
// el arranque falla sin ellos— de los `${VAR:default}`.
//
// Antes esta tabla era una segunda lista escrita a mano que replicaba el
// gradiente de config.js, y se desincronizaba en cuanto una variable pasaba a
// depender del diseño (un `STORAGE_BUCKET_<NOMBRE>` por bucket declarado no
// aparecía nunca). Derivarla del YAML hace imposible esa divergencia.
function productionParameters(model) {
  const required = new Map();
  const optional = new Map();

  for (const file of generateConfig(model)) {
    const production = file.path.includes('/parameters/production/');
    const base = file.path.endsWith('src/main/resources/application.yaml');
    if (!production && !base) continue;
    const fragment = file.path.replace(/^.*\//, '').replace(/\.yaml$/, '');
    for (const [, name, defaultValue] of file.content.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[^}]*)?\}/g)) {
      const target = defaultValue === undefined ? required : optional;
      if (!required.has(name) && !optional.has(name)) target.set(name, fragment);
    }
  }

  return {
    required: [...required].map(([name, fragment]) => ({ name, purpose: purposeOf(name, fragment, model) })),
    optional: [...optional.keys()]
  };
}

// Prosa de la tabla. Los nombres salen del YAML (fuente de verdad); esto solo
// explica para qué sirve cada uno, con el fragmento que lo declara como respaldo
// para cualquier variable que el diseño introduzca y aquí no esté nombrada.
const PARAMETER_PURPOSES = {
  DB_URL: 'URL JDBC de la base de datos.',
  DB_USERNAME: 'Usuario de la base de datos.',
  DB_PASSWORD: 'Contraseña de la base de datos.',
  KAFKA_BOOTSTRAP_SERVERS: 'Brokers Kafka (host:port, separados por coma).',
  RABBITMQ_HOST: 'Host de RabbitMQ.',
  RABBITMQ_PORT: 'Puerto de RabbitMQ.',
  RABBITMQ_USERNAME: 'Usuario de RabbitMQ.',
  RABBITMQ_PASSWORD: 'Contraseña de RabbitMQ.',
  AWS_REGION: 'Región AWS de SNS/SQS.',
  AWS_ACCESS_KEY_ID: 'Access key de las credenciales AWS.',
  AWS_SECRET_ACCESS_KEY: 'Secret key de las credenciales AWS.',
  REDIS_HOST: 'Host de la caché (protocolo Redis).',
  REDIS_PORT: 'Puerto de la caché.',
  OAUTH2_ISSUER_URI: 'Issuer del resource server OAuth2/OIDC que valida los tokens.',
  SECURITY_API_KEY: 'Clave API que deben enviar los clientes del servicio.',
  SECURITY_AUDIENCE: 'Audiencia (claim `aud`) exigida a los tokens de clientes máquina.',
  SECURITY_CORS_ALLOWED_ORIGINS: 'Orígenes permitidos por CORS (separados por coma).',
  STORAGE_ENDPOINT: 'Endpoint del object storage compatible S3.',
  STORAGE_REGION: 'Región del object storage.',
  STORAGE_ACCESS_KEY: 'Access key del object storage.',
  STORAGE_SECRET_KEY: 'Secret key del object storage.'
};

const PARAMETER_PATTERNS = [
  [/^STORAGE_BUCKET_(.+)$/, (match) => `Nombre físico del bucket \`${match[1].toLowerCase()}\` declarado en el diseño.`],
  [/^API_KEY_(.+)$/, (match) => `Clave API del cliente máquina \`${match[1].toLowerCase().replace(/_/g, '-')}\`.`],
  [/_BASE_URL$/, () => 'URL base de un cliente HTTP declarado en el diseño.'],
  [/_CLIENT_ID$/, () => 'client-id OAuth2 (client_credentials) de un cliente HTTP saliente.'],
  [/_CLIENT_SECRET$/, () => 'client-secret OAuth2 de un cliente HTTP saliente.'],
  [/_TOKEN_URL$/, () => 'token-uri del proveedor OAuth2 de un cliente HTTP saliente.'],
  [/_API_KEY$/, () => 'Clave API saliente de un cliente HTTP declarado en el diseño.'],
  [/_TOKEN$/, () => 'Token bearer estático de un cliente HTTP saliente.'],
  [/_USERNAME$/, () => 'Usuario de autenticación básica de un cliente HTTP saliente.'],
  [/_PASSWORD$/, () => 'Contraseña de autenticación básica de un cliente HTTP saliente.']
];

function purposeOf(name, fragment) {
  if (PARAMETER_PURPOSES[name]) return PARAMETER_PURPOSES[name];
  for (const [pattern, describe] of PARAMETER_PATTERNS) {
    const match = name.match(pattern);
    if (match) return describe(match);
  }
  return `Parámetro declarado en \`parameters/production/${fragment}.yaml\`.`;
}
