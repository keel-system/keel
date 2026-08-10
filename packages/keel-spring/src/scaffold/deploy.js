// Contenedorización del servicio para PRUEBAS MANUALES del diseñador, agrupada
// bajo `deploy/`. Es el segundo destino de infraestructura del proyecto generado y
// no se confunde con el primero:
//
//   infra/   — infraestructura DE LA GENERACIÓN. La levanta y sondea un agente;
//              trae el toolbox devtools con las CLIs, validate-infra.sh y
//              reset-db.sh. La app corre fuera, desde el IDE o desde Gradle.
//   deploy/  — el SERVICIO EN CONTENEDOR, para que una persona lo pruebe con
//              Postman o con un front: imagen de la app, su infraestructura, las
//              UIs para mirar por dentro, y el realm de Keycloak ya poblado.
//              Sin devtools: aquí no hay nada que sondear por CLI.
//
// Todo es determinista y sale del diseño. Ninguna fase de la generación lo
// enciende: es prueba manual del diseñador, que lo levanta cuando quiera. Los
// agentes tampoco escriben nada de esto.
//
// Portabilidad docker/podman: un único compose y un único Dockerfile, sin claves
// específicas de Docker (nada de host-gateway ni network_mode), con los puertos
// publicados por encima de 1024 (podman rootless) y la elección de runtime
// resuelta en up.sh/down.sh, igual que ya hacen los scripts de infra/.

import YAML from 'yaml';
import { JAVA_VERSION } from '../lib/assets.js';
import {
  DATABASES,
  BROKERS,
  AUTH,
  CACHES,
  STORAGE,
  HEALTHCHECKS,
  UI_SERVICES,
  HTTP_STUB
} from '../lib/stack-catalog.js';
import { realmSpec } from './auth-provisioning.js';
import { RUNTIME_RESOLUTION, composeResolution } from './devtools.js';
import { LOCAL_API_KEY, LOCAL_CORS_ORIGINS, localClientApiKey } from './config.js';

// Nombre de la variable de .env que publica cada puerto en el host. Explícito y no
// derivado, porque el nombre que espera una persona («¿en qué puerto está la
// consola de MinIO?») no se deduce del par serviceKey:puerto.
const PORT_VARS = {
  'db:5432': 'DB_PORT',
  'db:3306': 'DB_PORT',
  'db:1433': 'DB_PORT',
  'db:1521': 'DB_PORT',
  'db:27017': 'DB_PORT',
  'kafka:9092': 'KAFKA_PORT',
  'rabbitmq:5672': 'RABBITMQ_PORT',
  'rabbitmq:15672': 'RABBITMQ_UI_PORT',
  'localstack:4566': 'LOCALSTACK_PORT',
  'keycloak:8080': 'KEYCLOAK_PORT',
  'redis:6379': 'REDIS_PORT',
  'valkey:6379': 'VALKEY_PORT',
  'minio:9000': 'MINIO_PORT',
  'minio:9001': 'MINIO_CONSOLE_PORT'
};

export function generate(model) {
  const { service } = model;
  const files = [];

  const { services, volumes, env } = composeServices(model);
  const network = `keel-${service.name}-deploy`;
  for (const definition of Object.values(services)) {
    definition.networks = [network];
  }

  const compose = {
    // Proyecto distinto del de infra/: los dos stacks pueden coexistir sin que
    // compose crea que uno es una versión del otro (los nombres de contenedor
    // salen prefijados por el proyecto, así que tampoco colisionan).
    name: `${service.projectName}-deploy`,
    services,
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
    networks: { [network]: { driver: 'bridge' } }
  };

  files.push({ path: 'deploy/Dockerfile', content: dockerfile(model) });
  files.push({
    path: 'deploy/docker-compose.yaml',
    content:
      '# El servicio en contenedor para pruebas manuales (app + infraestructura + UIs).\n' +
      '# Generado por keel-spring build; se levanta con `bash deploy/up.sh`.\n' +
      '# NO es infra/docker-compose.yaml, que es la infraestructura de la generación.\n' +
      // lineWidth 0 = sin plegado de líneas. El healthcheck de Keycloak es un
      // comando largo con \r\n dentro: plegado sigue siendo YAML válido, pero
      // ilegible para quien lo tenga que depurar.
      YAML.stringify(compose, { nullStr: '', lineWidth: 0 })
  });
  files.push({ path: 'deploy/.env', content: envFile(model, env) });
  files.push({ path: 'deploy/up.sh', content: upScript(model), executable: true });
  files.push({ path: 'deploy/down.sh', content: downScript(), executable: true });

  const realm = model.stack.auth === 'keycloak' ? realmSpec(model) : null;
  if (realm) {
    files.push({ path: 'deploy/keycloak/realm-export.json', content: realmExport(realm) });
  }

  return files;
}

// ─── deploy/Dockerfile ───────────────────────────────────────────────────────

function dockerfile(model) {
  const jar = `${model.service.projectName}-${model.service.version}.jar`;
  return `# Imagen del servicio, en tres etapas.
#
# El corte no es cosmético: las dependencias se resuelven en una etapa propia que
# solo se invalida si cambia build.gradle, de modo que iterar sobre src/ no vuelve
# a descargar medio Maven Central. Y el jar se explota en las capas de Spring Boot
# (dependencies / spring-boot-loader / snapshot-dependencies / application), que es
# lo que hace que un cambio de codigo reescriba unos kilobytes de capa y no los
# cincuenta megas del jar entero.
#
# El contexto de build es la RAIZ del proyecto, no deploy/: se necesita src/ y el
# wrapper de Gradle vendorizado. Por eso el .dockerignore vive en la raiz.

# ── 1. Dependencias (capa cacheada) ──────────────────────────────────────────
FROM eclipse-temurin:${JAVA_VERSION}-jdk-alpine AS deps
WORKDIR /workspace
COPY gradlew ./
COPY gradle/ gradle/
COPY build.gradle settings.gradle ./
# Calentar la cache de Gradle. Best effort: si la resolucion falla aqui (una
# dependencia que solo existe en un repo privado, por ejemplo) no se rompe la
# imagen, simplemente se descargara en la etapa siguiente.
RUN chmod +x gradlew && ./gradlew --no-daemon -q dependencies > /dev/null 2>&1 || true

# ── 2. Compilacion y explotado en capas ──────────────────────────────────────
FROM deps AS build
WORKDIR /workspace
COPY src/ src/
RUN ./gradlew --no-daemon bootJar -x test
RUN cp build/libs/${jar} application.jar \\
 && java -Djarmode=tools -jar application.jar extract --layers --destination extracted

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM eclipse-temurin:${JAVA_VERSION}-jre-alpine
WORKDIR /application

# Usuario sin privilegios. La app no escribe en ningun volumen, asi que esto no
# choca con el mapeo de UIDs de podman rootless.
RUN addgroup -S app && adduser -S -G app app
USER app

# El orden importa: de lo que menos cambia a lo que mas.
COPY --from=build --chown=app:app /workspace/extracted/dependencies/ ./
COPY --from=build --chown=app:app /workspace/extracted/spring-boot-loader/ ./
COPY --from=build --chown=app:app /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build --chown=app:app /workspace/extracted/application/ ./

EXPOSE 8080

# wget de BusyBox (viene en la base alpine): la imagen no trae curl, y este
# healthcheck lo honran igual docker y podman. Es lo que consume el
# \`depends_on: service_healthy\` de quien dependa de la app y el bucle de up.sh.
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=18 \\
  CMD wget -q -O - http://localhost:8080/actuator/health/readiness | grep -q '"status":"UP"' || exit 1

# Forma shell para que \$JAVA_OPTS se expanda; exec para que la JVM sea el PID 1 y
# reciba el SIGTERM que dispara el apagado ordenado (server.shutdown: graceful).
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar application.jar"]
`;
}

// ─── deploy/docker-compose.yaml ──────────────────────────────────────────────

/**
 * Servicios del compose de pruebas manuales. Reusa las mismas definiciones del
 * catálogo que infra/ (imágenes, credenciales, variables de arranque) y solo añade
 * lo que aquí es distinto: healthchecks —para que `app` no arranque contra una BD
 * que aún no acepta conexiones—, puertos publicados por variable y las UIs.
 *
 * Devuelve también `env`: los pares de .env que hacen falta, recogidos mientras se
 * construyen los servicios para no recorrer el stack dos veces.
 */
function composeServices(model) {
  const { service, layersPresent, stack } = model;
  const services = {};
  const volumes = {};
  const env = [];
  const dbName = service.name.replace(/-/g, '_');

  if (layersPresent.persistence && stack.database) {
    const db = DATABASES[stack.database];
    if (db?.composeService) {
      services.db = { ...db.composeService(dbName) };
      const health = HEALTHCHECKS[stack.database];
      // sqlserver y mongodb ya traen el suyo en composeService.
      if (health && !services.db.healthcheck) services.db.healthcheck = health(dbName);
      volumes['db-data'] = null;
    }
  }
  if (layersPresent.messaging && stack.broker) {
    Object.assign(services, withHealthcheck(BROKERS[stack.broker].composeServices(), stack.broker));
  }
  if (stack.auth && stack.auth !== 'none') {
    Object.assign(services, withHealthcheck(AUTH[stack.auth].composeServices(), stack.auth));
  }
  if (stack.cache) {
    Object.assign(services, withHealthcheck(CACHES[stack.cache].composeServices(), stack.cache));
  }
  if (layersPresent.storage && stack.storage) {
    const storageServices = STORAGE[stack.storage].composeServices(model);
    Object.assign(services, withHealthcheck(storageServices, stack.storage));
    if ('minio' in storageServices) volumes['minio-data'] = null;
  }

  // Keycloak: importa el realm al arrancar y abre el puerto de management que
  // consume su healthcheck. `--import-realm` solo actúa si el realm no existe,
  // así que reiniciar no pisa lo que el diseñador haya tocado a mano.
  const realm = services.keycloak && model.stack.auth === 'keycloak' ? realmSpec(model) : null;
  if (realm) {
    services.keycloak.command = ['start-dev', '--import-realm'];
    services.keycloak.environment = {
      ...services.keycloak.environment,
      KC_HEALTH_ENABLED: 'true',
      // El issuer que Keycloak emite y publica: el que ve quien pide el token
      // desde fuera (Postman, un front). Ver la nota de jwkSetUri más abajo.
      KC_HOSTNAME: 'http://localhost:${KEYCLOAK_PORT:-8180}'
    };
    services.keycloak.volumes = [
      ...(services.keycloak.volumes ?? []),
      './keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro'
    ];
  }

  // Puertos publicados por variable: el diseñador casi siempre tiene ya algo
  // escuchando en 5432 o en 8080.
  for (const [key, definition] of Object.entries(services)) {
    if (!definition.ports) continue;
    definition.ports = definition.ports.map((mapping) => {
      const [host, container] = String(mapping).split(':');
      const name = PORT_VARS[`${key}:${container}`];
      if (!name) return mapping;
      env.push({ name, value: host });
      return `\${${name}:-${host}}:${container}`;
    });
  }

  // UIs de inspección: lo que la API no enseña (qué mensajes salieron, qué claves
  // quedaron en caché). Las consolas de RabbitMQ, MinIO y Keycloak ya vienen en
  // sus imágenes y no añaden contenedor.
  for (const id of [stack.broker, stack.cache, stack.database]) {
    const ui = id ? UI_SERVICES[id] : null;
    if (!ui) continue;
    // Una UI de mensajería sin capa messaging no tiene nada que enseñar; lo mismo
    // vale para una consola de base de datos sin capa persistence.
    if (id === stack.broker && !layersPresent.messaging) continue;
    if (id === stack.database && !layersPresent.persistence) continue;
    Object.assign(services, ui(dbName));
  }
  if (services['kafka-ui']) env.push({ name: 'KAFKA_UI_PORT', value: '8081' });
  if (services.redisinsight) env.push({ name: 'REDISINSIGHT_PORT', value: '5540' });
  if (services['mongo-express']) env.push({ name: 'MONGO_EXPRESS_PORT', value: '8082' });

  const { environment, extraEnv } = appEnvironment(model);
  env.push(...extraEnv);
  services.app = {
    build: { context: '..', dockerfile: 'deploy/Dockerfile' },
    // Sin container_name: el proyecto ya prefija los nombres, y fijarlo sería la
    // única forma de colisionar con el stack de infra/.
    ports: ['${APP_PORT:-8080}:8080'],
    environment,
    ...dependsOn(services)
  };
  env.unshift({ name: 'APP_PORT', value: '8080' });

  return { services, volumes, env };
}

/** Añade a cada servicio el healthcheck de su tecnología, si el catálogo lo declara. */
function withHealthcheck(services, id) {
  const health = HEALTHCHECKS[id];
  if (!health) return services;
  for (const [key, definition] of Object.entries(services)) {
    // El sidecar de buckets (minio-init) no es un servicio con vida propia: corre
    // una vez y termina, así que un healthcheck sobre él nunca pasaría a healthy.
    if (key !== id && !(id === 'snssqs' && key === 'localstack')) continue;
    if (!definition.healthcheck) definition.healthcheck = health();
  }
  return services;
}

/**
 * `depends_on` de la app: espera a que cada dependencia esté sana. Es lo que
 * distingue a este compose del de infra/, donde la espera la resuelve el bucle de
 * reintentos de validate-infra.sh porque hay un agente mirando.
 */
function dependsOn(services) {
  const conditions = {};
  for (const [key, definition] of Object.entries(services)) {
    if (!definition.healthcheck) continue;
    conditions[key] = { condition: 'service_healthy' };
  }
  return Object.keys(conditions).length > 0 ? { depends_on: conditions } : {};
}

/**
 * Entorno del contenedor de la app. Corre con el perfil `develop`, que es el único
 * redirigible: `local` fija valores literales (localhost) y quedaría clavado fuera
 * de la red de contenedores. De ahí que aquí solo haya que sobrescribir dos cosas:
 * lo que apunta a localhost y lo que `develop` declara obligatorio sin default
 * (sin eso la app no arranca, en vez de arrancar mal).
 */
function appEnvironment(model) {
  const { service, layersPresent, stack, security } = model;
  const dbName = service.name.replace(/-/g, '_');
  const environment = { PROFILE: 'develop' };
  const extraEnv = [];

  if (layersPresent.persistence && DATABASES[stack.database]?.serviceKey) {
    const db = DATABASES[stack.database];
    // Dentro de la red de compose el host es `db`. Los motores relacionales solo
    // cambian el host de su URL; Mongo además cambia el modo de conexión (replica
    // set completo en vez de conexión directa), así que declara su URL interna.
    environment.DB_URL = db.internalUrl ? db.internalUrl(dbName) : db.url(dbName).replace('localhost', 'db');
    // La URI de Mongo lleva las credenciales dentro: no hay dos propiedades más
    // que sobrescribir, y declararlas sería configuración que nadie lee.
    if (db.kind !== 'document') {
      environment.DB_USERNAME = db.user(dbName);
      environment.DB_PASSWORD = db.password;
    }
  }

  if (layersPresent.messaging) {
    if (stack.broker === 'kafka') {
      // El listener INTERNAL: el EXTERNAL anuncia localhost:9092, que dentro del
      // contenedor de la app es el propio contenedor.
      environment.KAFKA_BOOTSTRAP_SERVERS = 'kafka:29092';
    } else if (stack.broker === 'rabbitmq') {
      environment.RABBITMQ_HOST = 'rabbitmq';
    } else if (stack.broker === 'snssqs') {
      environment.AWS_SNS_ENDPOINT = 'http://localstack:4566';
      environment.AWS_SQS_ENDPOINT = 'http://localstack:4566';
    }
  }

  if (stack.cache) environment.REDIS_HOST = stack.cache === 'valkey' ? 'valkey' : 'redis';
  if (layersPresent.storage && stack.storage === 'minio') {
    environment.STORAGE_ENDPOINT = 'http://minio:9000';
  }

  if (layersPresent.security && security) {
    const jwt = security.protocol === 'oidc' || security.protocol === 'jwt';
    const jwks = jwt ? jwkSetUri(model) : null;
    if (jwks) {
      // El issuer partido: Keycloak emite tokens con `iss` = localhost:8180 (la URL
      // por la que el diseñador pide el token) pero la app lo alcanza como
      // keycloak:8080. Validar por issuer-uri daría 401 a todo. Con jwk-set-uri
      // —que Boot prioriza sobre issuer-uri— el decoder resuelve las claves por la
      // ruta interna y no hace discovery. Se deja de validar el claim `iss`, y solo
      // aquí: el perfil local y la suite integrationTest siguen usando issuer-uri.
      environment.SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_JWK_SET_URI = jwks;
    }
    if (security.protocol === 'api-key') environment.SECURITY_API_KEY = LOCAL_API_KEY;
    if (security.serviceAuth?.protocol === 'api-key') {
      for (const client of security.serviceClients ?? []) {
        environment[`API_KEY_${client.name.replace(/-/g, '_').toUpperCase()}`] = localClientApiKey(client.name);
      }
    }
    if (security.cors) environment.SECURITY_CORS_ALLOWED_ORIGINS = LOCAL_CORS_ORIGINS;
  }

  // Integraciones salientes: `develop` las declara obligatorias y el diseño no
  // aporta URLs (son infraestructura). Van por .env para que el diseñador las
  // apunte a su mock sin editar el compose.
  //
  // El valor por defecto es el puerto donde `infra/` publica su WireMock, no un
  // puerto cualquiera: es el stub que el diseñador ya tiene a mano. El 8081 que
  // había antes es el de kafka-ui, que responde 200 con HTML a lo que le pidas —
  // una integración apuntada ahí no falla, contesta mal.
  for (const client of model.httpClients ?? []) {
    const name = `${client.envPrefix}_BASE_URL`;
    environment[name] = `\${${name}}`;
    extraEnv.push({
      name,
      value: `http://localhost:${HTTP_STUB.publishedPort}`,
      comment: `URL del servicio de prueba para ${client.id}`
    });
  }

  return { environment, extraEnv };
}

function jwkSetUri(model) {
  const realmPath = `realms/${model.service.name}/protocol/openid-connect/certs`;
  if (model.stack.auth === 'keycloak') return `http://keycloak:8080/${realmPath}`;
  if (model.stack.auth === 'cognito') return 'http://cognito:9229/local_userpool/.well-known/jwks.json';
  return null;
}

// ─── deploy/.env ─────────────────────────────────────────────────────────────

function envFile(model, env) {
  const lines = [
    `# Parámetros del stack de pruebas manuales de ${model.service.name}.`,
    '#',
    '# Son los puertos que se publican en tu máquina y los valores que el compose no',
    '# puede adivinar. Cambia el que te haga falta (otro Postgres ocupando el 5432,',
    '# un mock en otro sitio) y vuelve a ejecutar `bash deploy/up.sh`.',
    '#',
    '# Todos los puertos van por encima de 1024 a propósito: por debajo, podman',
    '# rootless no puede publicarlos.',
    ''
  ];
  const seen = new Set();
  for (const { name, value, comment } of env) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (comment) lines.push(`# ${comment}`);
    lines.push(`${name}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

// ─── deploy/up.sh y deploy/down.sh ───────────────────────────────────────────

// Detección de runtime y de frontend de compose. Ambas son las mismas que usan los
// scripts de `infra/` y viven en devtools.js: un segundo criterio escrito aquí haría
// que el diseñador y el pipeline resolvieran distinto en la misma máquina.
const RUNTIME_PREAMBLE = `${RUNTIME_RESOLUTION}

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$HERE/docker-compose.yaml"
ENV_FILE="$HERE/.env"

# Los mismos valores que lee compose, tambien como variables del script: es lo que
# permite sondear e imprimir el puerto REAL cuando alguien lo ha cambiado en .env.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

${composeResolution(['-f', '"$COMPOSE_FILE"', '--env-file', '"$ENV_FILE"'])}`;

function upScript(model) {
  const urls = publishedUrls(model)
    .map(({ label, url }) => `echo "  ${label.padEnd(22)} ${url}"`)
    .join('\n');
  const realm = model.stack.auth === 'keycloak' ? realmSpec(model) : null;
  const credentials = realm
    ? `echo ""
echo "Usuarios del realm '${realm.realm}' (password: ${realm.password}): ${realm.users
        .map((user) => user.username)
        .join(', ')}"
echo "Cliente publico para pedir el token: ${realm.userClient}"`
    : '';

  return `#!/usr/bin/env bash
# Levanta el servicio en contenedor para probarlo a mano. Sirve igual con docker
# que con podman: el runtime se detecta solo (o se fuerza con CONTAINER_RUNTIME).
#
# No es la infraestructura de la generacion: esa es infra/, y no conviene tener las
# dos arriba a la vez porque publican los mismos puertos.
set -euo pipefail
export MSYS_NO_PATHCONV=1

${RUNTIME_PREAMBLE}

echo "== Levantando (\${COMPOSE[0]}) =="
"\${COMPOSE[@]}" up -d --build

# Espera activa a que la app responda. 'Up' no es 'listo': la JVM tarda, y con
# persistencia ademas hay que aplicar las migraciones antes de aceptar trafico.
#
# Se sondea el endpoint publicado desde el host, no el estado del healthcheck via
# 'compose ps': el formato de esa salida y el nombre que cada frontend le da al
# contenedor no son los mismos en docker que en podman-compose, y el sondeo HTTP
# comprueba ademas lo unico que le importa a quien va a probar el servicio — que
# responde por el puerto que tiene delante.
READY_URL="http://localhost:\${APP_PORT:-8080}/actuator/health/readiness"
RETRIES="\${KEEL_CHECK_RETRIES:-60}"
DELAY="\${KEEL_CHECK_DELAY:-5}"

probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf "$READY_URL" 2>/dev/null
  else
    wget -q -O - "$READY_URL" 2>/dev/null
  fi
}

attempt=1
while :; do
  if probe | grep -q '"status":"UP"'; then
    break
  fi
  if [ "$attempt" -ge "$RETRIES" ]; then
    echo "La app no respondio UP en $READY_URL tras $((RETRIES * DELAY))s." >&2
    echo "Mira que paso con: \${COMPOSE[*]} logs app" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$DELAY"
done

echo ""
echo "Servicio listo."
${urls}
${credentials}
echo ""
echo "Para apagarlo: bash deploy/down.sh   (con -v ademas borra los datos)"
`;
}

function downScript() {
  return `#!/usr/bin/env bash
# Apaga el stack de pruebas manuales. Con -v borra tambien los volumenes, que es
# lo que deja la siguiente sesion con la base de datos vacia.
set -euo pipefail
export MSYS_NO_PATHCONV=1

${RUNTIME_PREAMBLE}

"\${COMPOSE[@]}" down "$@"
`;
}

/** URLs que el stack publica, para imprimirlas al terminar y para el README. */
export function publishedUrls(model) {
  const { layersPresent, stack } = model;
  const urls = [
    { label: 'API', url: 'http://localhost:${APP_PORT:-8080}' },
    { label: 'Swagger UI', url: 'http://localhost:${APP_PORT:-8080}/swagger-ui/index.html' },
    { label: 'Health', url: 'http://localhost:${APP_PORT:-8080}/actuator/health' }
  ];
  if (layersPresent.messaging && stack.broker === 'kafka') {
    urls.push({ label: 'Kafka UI', url: 'http://localhost:${KAFKA_UI_PORT:-8081}' });
  }
  if (layersPresent.messaging && stack.broker === 'rabbitmq') {
    urls.push({ label: 'RabbitMQ (guest/guest)', url: 'http://localhost:${RABBITMQ_UI_PORT:-15672}' });
  }
  if (stack.cache) {
    urls.push({ label: 'RedisInsight', url: 'http://localhost:${REDISINSIGHT_PORT:-5540}' });
  }
  if (layersPresent.storage && stack.storage === 'minio') {
    urls.push({ label: 'MinIO (minioadmin)', url: 'http://localhost:${MINIO_CONSOLE_PORT:-9001}' });
  }
  if (stack.auth === 'keycloak') {
    urls.push({ label: 'Keycloak (admin/admin)', url: 'http://localhost:${KEYCLOAK_PORT:-8180}' });
  }
  return urls;
}

// ─── deploy/keycloak/realm-export.json ───────────────────────────────────────

/**
 * El realm en el formato de import de Keycloak. Misma estructura que levanta
 * `infra/init-keycloak.sh` —las dos salen de realmSpec()—, pero declarativa: la
 * importa Keycloak al arrancar y no hace falta que nadie ejecute nada después.
 */
function realmExport(spec) {
  const clientScopes = [];
  if (spec.scopes.length > 0) {
    clientScopes.push(audienceScope(`aud-${spec.audience}`, spec.audience));
    if (spec.validateAudience) clientScopes.push(audienceScope('aud-wrong', 'audiencia-ajena'));
    for (const scope of spec.scopes) {
      clientScopes.push({
        name: scope,
        protocol: 'openid-connect',
        attributes: { 'include.in.token.scope': 'true' }
      });
    }
  }

  const clients = [
    {
      clientId: spec.userClient,
      enabled: true,
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: true
    },
    ...[...spec.serviceClients, ...spec.m2mClients].map((client) => ({
      clientId: client.name,
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      secret: client.secret,
      defaultClientScopes: defaultScopesOf(client, spec)
    }))
  ];

  const realm = {
    realm: spec.realm,
    enabled: true,
    // Sesiones largas: una prueba manual no debería interrumpirse por un token
    // caducado a los cinco minutos.
    accessTokenLifespan: 1800,
    roles: { realm: spec.roles.map((name) => ({ name })) },
    users: spec.users.map((user) => ({
      username: user.username,
      enabled: true,
      email: `${user.username}@example.com`,
      emailVerified: true,
      firstName: 'Test',
      lastName: 'User',
      credentials: [{ type: 'password', value: spec.password, temporary: false }],
      realmRoles: user.roles
    })),
    ...(clientScopes.length > 0 ? { clientScopes } : {}),
    clients
  };

  return `${JSON.stringify(realm, null, 2)}\n`;
}

/**
 * Client scope que solo inyecta audiencia. Va SEPARADO de los de permiso: si
 * viajaran juntos, el cliente «sin scope» perdería también la audiencia y su fallo
 * dejaría de probar nada sobre el scope.
 */
function audienceScope(name, audience) {
  return {
    name,
    protocol: 'openid-connect',
    protocolMappers: [
      {
        name: 'aud-mapper',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': audience, 'access.token.claim': 'true' }
      }
    ]
  };
}

/** Client scopes por defecto de un cliente máquina: su audiencia y sus permisos. */
function defaultScopesOf(client, spec) {
  if (spec.scopes.length === 0) return [];
  // Los clientes del diseño no llevan marca de audiencia en el spec: siempre es la
  // buena. La matriz de prueba sí la varía (ok / wrong / ninguna).
  const audience = 'audience' in client ? client.audience : 'ok';
  const scopes = [];
  if (audience === 'ok') scopes.push(`aud-${spec.audience}`);
  if (audience === 'wrong') scopes.push('aud-wrong');
  return [...scopes, ...client.scopes];
}
