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
  databaseHealthProbe,
  UI_SERVICES,
  HTTP_STUB,
  MAIL_SINK,
  TELEMETRY_INFRA,
  collectorEndpoint,
  GRAFANA_PROVISIONING,
  OBSERVABILITY_DIR,
  ALERTING,
  alertSinkEndpoint
} from '../lib/stack-catalog.js';
import { METRICS_TRANSPORT } from '../lib/telemetry-probes.js';
import { dashboardUid } from './observability-assets.js';
import { usesTelemetry } from './telemetry.js';
import { cognitoMockConfig, realmSpec, tokenUrl } from './auth-provisioning.js';
import { kebabCase } from '../lib/naming.js';
import { AUTH_PROVIDERS } from './security.js';
import { RUNTIME_RESOLUTION, composeResolution, HOSTPATH_HELPER } from './devtools.js';
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
  'cognito-mock:8080': 'COGNITO_PORT',
  'redis:6379': 'REDIS_PORT',
  'valkey:6379': 'VALKEY_PORT',
  'minio:9000': 'MINIO_PORT',
  'minio:9001': 'MINIO_CONSOLE_PORT',
  'mailpit:1025': 'MAILPIT_SMTP_PORT',
  'mailpit:8025': 'MAILPIT_UI_PORT',
  [`${TELEMETRY_INFRA.collector.serviceKey}:${TELEMETRY_INFRA.collector.grpcPort}`]: 'OTEL_GRPC_PORT',
  [`${TELEMETRY_INFRA.collector.serviceKey}:${TELEMETRY_INFRA.collector.httpPort}`]: 'OTEL_HTTP_PORT',
  [`${TELEMETRY_INFRA.backend.serviceKey}:${TELEMETRY_INFRA.backend.grafanaPort}`]: 'GRAFANA_PORT'
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
  files.push({ path: postmanEnvironmentPath(model), content: postmanEnvironment(model) });

  // El emulador de Cognito lee su config del mismo archivo que en infra/, pero
  // relativo a deploy/: son dos composes distintos y cada uno monta el suyo.
  if (model.stack.auth === 'cognito') {
    const config = cognitoMockConfig(model);
    if (config) files.push({ path: 'deploy/cognito/mock-oauth2-config.json', content: config.content });
  }
  const realm = model.stack.auth === 'keycloak' ? realmSpec(model) : null;
  if (realm) {
    files.push({ path: 'deploy/keycloak/realm-export.json', content: realmExport(realm) });
  }
  if (usesTelemetry(model)) {
    files.push({ path: 'deploy/otel/collector.yaml', content: collectorConfig(model) });
    files.push({ path: 'deploy/otel/collector-agent.example.yaml', content: collectorAgentConfig(model) });
    files.push({ path: 'deploy/otel/collector-gateway.example.yaml', content: collectorGatewayConfig(model) });
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
# /readyz y no /actuator/health/readiness: es la misma sonda, pero servida en el puerto
# PRINCIPAL en todos los perfiles, y en production el actuator vive en otro puerto.
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=18 \\
  CMD wget -q -O - http://localhost:8080/readyz | grep -q '"status":"UP"' || exit 1

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
      // La regla —el healthcheck del propio servicio manda; si no lo trae, el genérico— vive
      // en `databaseHealthProbe` y no aquí: `scripts/claim-check.js` necesita la MISMA para
      // saber a qué preguntarle al motor antes de correr su JUnit, y mientras estuvo escrita
      // solo en este archivo el runner acabó con `pg_isready` cableado.
      const probe = databaseHealthProbe(stack.database, dbName);
      if (probe && !services.db.healthcheck) services.db.healthcheck = probe.healthcheck;
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

  // Destino del correo, también en las pruebas manuales: sin él la app arranca
  // apuntando a un SMTP que no existe y el primer envío revienta. Y su interfaz
  // web es justo lo que el diseñador quiere mirar aquí —cómo se ve el correo, con
  // sus dos partes y sus cabeceras—, que es lo que la API no le enseña. No entra
  // en UI_SERVICES porque no añade contenedor: la interfaz viene en la imagen.
  if (layersPresent.mail) {
    Object.assign(services, withHealthcheck(MAIL_SINK.composeServices(), MAIL_SINK.id));
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

  // Telemetría: el colector, y detrás el backend de prueba donde mirar las tres señales. La app
  // solo conoce al colector (OTEL_EXPORTER_OTLP_ENDPOINT); el backend es un detalle de
  // deploy/otel/collector.yaml. Ninguno lleva healthcheck, así que la app no espera por ellos
  // (dependsOn solo encadena los que lo tienen), y es lo correcto: los exportadores reintentan
  // y encolan, y un colector caído no puede impedir arrancar el servicio. La imagen del
  // colector es distroless, sin shell con el que sondearlo.
  if (usesTelemetry(model)) {
    const { collector, backend } = TELEMETRY_INFRA;
    // El sumidero de alertas: el destino por defecto del contacto que se provisiona con ellas.
    // Sin un destino, lo único comprobable es que el archivo de alertas existe; con él, lo que
    // Grafana envía queda REGISTRADO y se puede leer (`/__admin/requests`). Es la misma imagen
    // que el proveedor de prueba de las integraciones salientes: no entra ninguna nueva.
    services[ALERTING.sink.serviceKey] = {
      image: ALERTING.sink.image,
      command: ['--verbose'],
      ports: [`\${${ALERTING.sink.portVar}:-${ALERTING.sink.publishedPort}}:${ALERTING.sink.port}`]
    };
    env.push({
      name: ALERTING.sink.portVar,
      value: String(ALERTING.sink.publishedPort),
      comment: 'Sumidero de alertas: aquí se lee lo que Grafana envía (/__admin/requests).'
    });
    env.push({
      name: ALERTING.webhookVar,
      value: alertSinkEndpoint(),
      comment:
        'A dónde van las alertas. Por defecto, al sumidero de arriba; apunta a tu canal ' +
        '(o al puente que hable con él) para recibirlas de verdad.'
    });
    services[backend.serviceKey] = {
      image: backend.image,
      ports: [`${backend.grafanaPublishedPort}:${backend.grafanaPort}`],
      // La variable la lee el PROCESO de Grafana, no el compose: `$__env{…}` del archivo de
      // provisioning se resuelve dentro del contenedor. Sin pasarla aquí, el contacto se
      // provisiona con una URL vacía y la alerta no sale — sin error visible en ningún sitio.
      environment: {
        [ALERTING.webhookVar]: `\${${ALERTING.webhookVar}:-${alertSinkEndpoint()}}`,
        // Sin esto, el Prometheus de la imagen ACEPTA los exemplars y los tira: no hay error, no
        // hay log, y el panel sale con los puntos de latencia pero sin el salto a la traza. Es el
        // último eslabón del camino del exemplar, y el único que falla en silencio.
        PROMETHEUS_EXTRA_ARGS: '--enable-feature=exemplar-storage'
      },
      volumes: [
        `./${OBSERVABILITY_DIR}/dashboards:${GRAFANA_PROVISIONING.dashboardsDir}:ro`,
        `./${OBSERVABILITY_DIR}/dashboards-provisioning.yaml:${GRAFANA_PROVISIONING.provider}:ro`,
        `./${OBSERVABILITY_DIR}/alerting/keel-alerts.yaml:${GRAFANA_PROVISIONING.alerting}:ro`
      ]
    };
    services[collector.serviceKey] = {
      image: collector.image,
      command: ['--config=/etc/otelcol-contrib/config.yaml'],
      volumes: ['./otel/collector.yaml:/etc/otelcol-contrib/config.yaml:ro', './otel/out:/var/otel-out'],
      // Publicados también en el host: así una app arrancada con bootRun (perfil local con
      // TELEMETRY_EXPORT_ENABLED=true) exporta al mismo colector.
      ports: [`${collector.grpcPort}:${collector.grpcPort}`, `${collector.httpPort}:${collector.httpPort}`],
      depends_on: [backend.serviceKey]
    };
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
    // La imagen, no un bloque `build:`, y la construye up.sh con el runtime directamente.
    //
    // El bloque `build` exige la clave `dockerfile` —el contexto es la RAÍZ del proyecto (hacen
    // falta src/ y el wrapper) y el archivo vive en deploy/—, y **podman-compose no la honra**:
    // busca un Dockerfile en el contexto y aborta con «no Containerfile or Dockerfile specified
    // or found». Es el mismo motivo por el que el toolbox de infra/ tiene su Dockerfile en un
    // subdirectorio propio, pero aquí esa salida no existe. Medido: con podman en Windows,
    // `deploy/up.sh` no podía construir la imagen de la app.
    image: appImage(service),
    // Sin container_name: el proyecto ya prefija los nombres, y fijarlo sería la
    // única forma de colisionar con el stack de infra/.
    //
    // El puerto publicado lo decide up.sh en `APP_PORTS`, y no es un rodeo.
    //
    // Replicar es lo único que ejercita lo que el servidor asume siempre (los barridos reclaman
    // su lote porque corren en todas las instancias), y con un puerto de host FIJO `--scale app=2`
    // colisiona. La solución de docker es publicar un RANGO (`8080-8089:8080`: cada réplica toma
    // el siguiente libre), pero **podman no admite rangos contra un puerto único** y aborta con
    // «host and container port ranges have different lengths: 10 vs 1» — o sea que con podman no
    // arrancaba ni UNA instancia. Medido en una corrida.
    //
    // Así que el valor sale de una variable: up.sh pone el rango con docker y un puerto único con
    // podman, y quien invoque compose a mano sin pasar nada obtiene el puerto único, que es lo que
    // funciona en los dos.
    ports: ['${APP_PORTS:-8080}:8080'],
    environment,
    ...dependsOn(services)
  };
  env.unshift(
    { name: 'APP_PORT', value: '8080', comment: 'Puerto de la app en tu maquina' },
    {
      name: 'APP_PORT_MAX',
      value: '8089',
      comment:
        'Ultimo puerto del rango que up.sh publica al replicar. SOLO con docker: podman no admite rangos de puertos, asi que con el se publica APP_PORT y una sola instancia'
    },
    // Cuántas instancias levanta up.sh. Por defecto una —probar a mano no necesita
    // más— pero subirlo a 2 es la única forma de ejercitar lo que el servidor asume
    // siempre: que hay otra réplica haciendo lo mismo al mismo tiempo.
    { name: 'APP_REPLICAS', value: '1' }
  );

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

  // Parámetros de DESPLIEGUE del servicio: aquí es donde se ven. El perfil `develop` los lee
  // con default, así que deploy/ levanta igual sin tocar nada; pero el `.env` los enumera con
  // su valor de prueba para que el diseñador sepa QUÉ hay que darle al servicio al desplegarlo
  // de verdad — que es justo el contrato operativo que, mientras esto lo decidió un agente,
  // no quedaba escrito en ninguna parte.
  for (const parameter of service.parameters ?? []) {
    environment[parameter.envVar] = `\${${parameter.envVar}}`;
    extraEnv.push({
      name: parameter.envVar,
      value: String(parameter.testValue ?? parameter.default ?? ''),
      comment: `${parameter.description}${parameter.requiredInProduction ? ' (en producción es obligatorio)' : ''}`
    });
  }

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
  // Dentro de la red el colector es su nombre de servicio; la ruta de cada señal la compone
  // parameters/develop/telemetry.yaml.
  if (usesTelemetry(model)) {
    environment[TELEMETRY_INFRA.endpointVar] = collectorEndpoint();
    // Aquí sí se exportan los logs por OTLP, y es la excepción a la regla: en deploy/ no hay
    // nada que recoja el stdout de los contenedores, así que sin esto Loki se quedaría vacío.
    // En un despliegue real la consola es el canal y esto se deja apagado (ver
    // collector-production.example.yaml, que la recoge con filelog).
    environment.LOG_EXPORT_OTLP = 'true';
  }
  if (layersPresent.storage && stack.storage === 'minio') {
    environment.STORAGE_ENDPOINT = 'http://minio:9000';
  }
  // La base de las URLs públicas: `develop` la declara sin default a propósito (una base vacía
  // compone URLs rotas en vez de fallar), así que sin ella la app NO ARRANCA en este compose. No
  // es el `STORAGE_ENDPOINT` de arriba: `minio:9000` es un nombre de la red de contenedores que
  // el consumidor —Postman, un navegador— no resuelve. Va por .env porque es contrato operativo:
  // en un despliegue real es el borde o la CDN.
  if (layersPresent.storage && model.storage?.hasPublicBucket) {
    environment.STORAGE_PUBLIC_BASE_URL = '${STORAGE_PUBLIC_BASE_URL}';
    extraEnv.push({
      name: 'STORAGE_PUBLIC_BASE_URL',
      value: 'http://localhost:9000',
      comment:
        'URL con la que el CONSUMIDOR lee los objetos públicos (en producción, el borde o la CDN). ' +
        'No es el endpoint interno del almacén; si cambias MINIO_PORT, cámbiala con él'
    });
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

  // Correo: la app del compose habla con el Mailpit de al lado, por el nombre de
  // servicio de la red (no por localhost, que dentro del contenedor es él mismo).
  // Son los MISMOS cuatro parámetros que en producción apuntan al proveedor
  // contratado: cambiar de Brevo a SES es cambiar estas variables y reiniciar.
  if (model.layersPresent.mail) {
    for (const [name, value, comment] of [
      ['MAIL_HOST', 'mailpit', 'Servidor SMTP (en producción, el del proveedor contratado)'],
      ['MAIL_PORT', '1025', 'Puerto SMTP (587 con STARTTLS en la mayoría de proveedores)'],
      ['MAIL_USERNAME', '', 'Usuario SMTP (Mailpit acepta cualquiera; en producción es obligatorio)'],
      ['MAIL_PASSWORD', '', 'Contraseña SMTP (en producción, de un gestor de secretos)']
    ]) {
      environment[name] = `\${${name}}`;
      extraEnv.push({ name, value, comment });
    }
  }

  return { environment, extraEnv };
}

function jwkSetUri(model) {
  const realmPath = `realms/${model.service.name}/protocol/openid-connect/certs`;
  if (model.stack.auth === 'keycloak') return `http://keycloak:8080/${realmPath}`;
  // El issuerId del emulador es el nombre del servicio, así que la ruta es
  // determinista (con un emulador de la API de Cognito habría sido un id de pool
  // generado, imposible de escribir aquí).
  if (model.stack.auth === 'cognito') return `http://cognito-mock:8080/${model.service.name}/jwks`;
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

// ─── deploy/postman/<servicio>-local.postman_environment.json ────────────────

/** Ruta del environment de Postman: la lee también el README. */
export function postmanEnvironmentPath(model) {
  return `deploy/postman/${model.service.name}-local.postman_environment.json`;
}

/**
 * El environment de Postman con el que las colecciones de `docs/postman/` funcionan contra
 * este stack sin rellenar nada a mano.
 *
 * Lo escribe build y no `/keel-docs` por la misma razón que el realm: las colecciones son
 * del DISEÑO, que es agnóstico del proveedor, así que dejan vacías la URL del token, los
 * clientes y las credenciales; quien sabe esos valores es el generador, que acaba de elegir
 * el proveedor y de sembrar el realm. Salen de `realmSpec()` —la misma fuente que el realm
 * importado y que `infra/test-credentials.env`—, así que un rol nuevo en el diseño aparece
 * a la vez en los tres. Los nombres de variable son los de la guía de `/keel-docs`
 * (`postman-collection-guide.md`); en Postman el environment tiene prioridad sobre las
 * variables de colección, así que basta con importarlo y seleccionarlo.
 *
 * Los puertos son los de fábrica de `.env`: si cambias `APP_PORT` o el del proveedor de
 * identidad, cambia también `baseUrl`/`tokenUrl` aquí.
 */
function postmanEnvironment(model) {
  const { security } = model;
  const values = [];
  const add = (key, value, secret = false) =>
    values.push({ key, value: String(value), type: secret ? 'secret' : 'default', enabled: true });

  add('baseUrl', 'http://localhost:8080');
  if (model.layersPresent.security && security?.cors) add('webOrigin', LOCAL_CORS_ORIGINS.split(',')[0]);

  const spec = model.layersPresent.security && ['keycloak', 'cognito'].includes(model.stack.auth) ? realmSpec(model) : null;
  if (spec) {
    add('tokenUrl', tokenUrl(model));
    // Cliente público con direct access grants: sin secreto, pero la colección lo manda.
    add('clientId', spec.userClient);
    add('clientSecret', '');
    for (const user of spec.users) {
      add(`username_${kebabCase(user.username)}`, user.username);
      add(`password_${kebabCase(user.username)}`, spec.password, true);
    }
    for (const client of spec.serviceClients) {
      add(`clientId_${kebabCase(client.name)}`, client.name);
      add(`clientSecret_${kebabCase(client.name)}`, client.secret, true);
      add(`scope_${kebabCase(client.name)}`, client.scopes.join(' '));
    }
    // El caso de rechazo por audiencia: la colección no puede nombrar un cliente de la matriz
    // de prueba (es del generador, no del diseño), así que la guía fija `other-audience` y
    // aquí se le da el que tiene la audiencia equivocada.
    const otherAudience = spec.m2mClients.find((client) => client.audience === 'wrong');
    if (otherAudience) {
      add('clientId_other-audience', otherAudience.name);
      add('clientSecret_other-audience', otherAudience.secret, true);
      add('scope_other-audience', otherAudience.scopes.join(' '));
    }
  }
  if (model.layersPresent.security && security?.protocol === 'api-key') add('apiKey', LOCAL_API_KEY, true);
  if (model.layersPresent.security && security?.serviceAuth?.protocol === 'api-key') {
    for (const client of security.serviceClients ?? []) {
      add(`apiKey_${kebabCase(client.name)}`, localClientApiKey(client.name), true);
    }
  }

  const environment = {
    name: `${model.service.name} — local (deploy)`,
    values,
    _postman_variable_scope: 'environment'
  };
  return `${JSON.stringify(environment, null, 2)}\n`;
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

${HOSTPATH_HELPER}

${composeResolution(['-f', '"$(hostpath "$COMPOSE_FILE")"', '--env-file', '"$(hostpath "$ENV_FILE")"'])}`;

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

# La imagen de la app se construye AQUI y no con 'compose up --build': el contexto es la raiz
# del proyecto y el Dockerfile vive en deploy/, y esa combinacion necesita la clave 'dockerfile',
# que podman-compose ignora (aborta con "no Containerfile or Dockerfile specified or found").
echo "== Construyendo la imagen de la app (\$RUNTIME) =="
"\$RUNTIME" build -f "\$(hostpath "\$HERE/Dockerfile")" -t "${appImage(model.service)}" "\$(hostpath "\$HERE/..")"

# Cuantos puertos publica la app, y por que depende del runtime: replicar exige un RANGO de
# puertos de host (cada replica toma el siguiente libre) y podman no los admite contra un puerto
# unico del contenedor. Con docker se usa el rango; con podman, un puerto y una sola instancia.
REPLICAS="\${APP_REPLICAS:-1}"
if [ "\$RUNTIME" = "docker" ]; then
  export APP_PORTS="\${APP_PORT:-8080}-\${APP_PORT_MAX:-8089}"
else
  export APP_PORTS="\${APP_PORT:-8080}"
  if [ "\$REPLICAS" -gt 1 ]; then
    echo "podman no publica rangos de puertos, asi que no puede levantar \$REPLICAS replicas con el" >&2
    echo "puerto publicado. Opciones: usar docker (CONTAINER_RUNTIME=docker), o levantar una sola" >&2
    echo "instancia aqui y arrancar las demas sin publicar puerto:" >&2
    echo "  podman run -d --network <red-del-proyecto> --env-file deploy/.env ${appImage(model.service)}" >&2
    exit 2
  fi
fi

echo "== Levantando (\${COMPOSE[0]}, \$REPLICAS instancia(s) de la app) =="
"\${COMPOSE[@]}" up -d --scale app="\$REPLICAS"

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
echo "Postman: importa deploy/postman/${model.service.name}-local.postman_environment.json y las colecciones de docs/postman/,"
echo "selecciona el environment y ejecuta primero la coleccion de auth."
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
  if (usesTelemetry(model)) {
    const port = TELEMETRY_INFRA.backend.grafanaPublishedPort;
    const grafana = `http://localhost:\${GRAFANA_PORT:-${port}}`;
    urls.push({ label: 'Grafana (telemetría)', url: grafana });
    // El panel y las alertas se provisionan solos: el enlace directo ahorra buscarlos, y es la
    // forma más rápida de ver si el provisioning funcionó —si el enlace da 404, no entraron—.
    urls.push({ label: 'Panel del servicio', url: `${grafana}/d/${dashboardUid(model)}` });
    urls.push({ label: 'Alertas', url: `${grafana}/alerting/list` });
    // Lo que el contacto RECIBE. Es la diferencia entre «la alerta está configurada» y «la
    // alerta salió»: aquí queda registrada cada entrega, con su cuerpo.
    urls.push({
      label: 'Alertas recibidas (sumidero)',
      url: `http://localhost:\${${ALERTING.sink.portVar}:-${ALERTING.sink.publishedPort}}/__admin/requests`
    });
  }
  return urls;
}

// ─── deploy/keycloak/realm-export.json ───────────────────────────────────────

/**
 * El realm en el formato de import de Keycloak. Misma estructura que levanta
 * `infra/init-keycloak.sh` —las dos salen de realmSpec()—, pero declarativa: la
 * importa Keycloak al arrancar y no hace falta que nadie ejecute nada después.
 *
 * Con `clientScopes` declarados, el import NO crea los scopes integrados de Keycloak
 * (`basic`, `roles`, `profile`…): solo los crea cuando el JSON no trae ninguno. Y son
 * los que ponen en el token `realm_access.roles`, `preferred_username` y `sub`, o sea
 * de donde el `JwtAuthConverter` generado saca los roles. El realm de `infra/` los
 * tiene porque kcadm crea el realm vacío y Keycloak siembra los suyos; este no, y la
 * prueba manual veía 403 con un token válido mientras la suite estaba en verde. Por
 * eso, en cuanto hay scopes propios, se declaran también los integrados.
 */
function realmExport(spec) {
  const clientScopes = [];
  const builtins = spec.scopes.length > 0 ? builtinScopes() : [];
  if (spec.scopes.length > 0) {
    clientScopes.push(...builtins);
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
      standardFlowEnabled: true,
      ...(builtins.length > 0 ? { defaultClientScopes: builtins.map((scope) => scope.name) } : {}),
      // El mapper del claim de alcance por recurso, en paridad con el que
      // `infra/init-keycloak.sh` crea sobre este mismo cliente. Sin él, el realm importado
      // tiene los atributos de usuario pero ningún token los lleva, y la prueba manual del
      // diseñador ve un 403 que la suite de integración no ve.
      ...(spec.scoping ? { protocolMappers: [scopingMapper(spec.scoping.claim)] } : {})
    },
    ...[...spec.serviceClients, ...spec.m2mClients].map((client) => ({
      clientId: client.name,
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      secret: client.secret,
      defaultClientScopes: [...builtins.map((scope) => scope.name), ...defaultScopesOf(client, spec)]
    }))
  ];

  const realm = {
    realm: spec.realm,
    enabled: true,
    // Sesiones largas: una prueba manual no debería interrumpirse por un token
    // caducado a los cinco minutos.
    accessTokenLifespan: 1800,
    // El equivalente declarativo del `update users/profile -s unmanagedAttributePolicy`
    // que emite `infra/init-keycloak.sh`. Va aquí por PARIDAD: sin él, el realm que se
    // importa en `deploy/` descarta en silencio cualquier atributo de usuario que sí
    // persiste en el realm de `infra/`, y la prueba manual del diseñador contradice a la
    // suite de integración por una diferencia que no está escrita en ninguna parte.
    components: { 'org.keycloak.userprofile.UserProfileProvider': [userProfileComponent()] },
    roles: { realm: spec.roles.map((name) => ({ name })) },
    users: spec.users.map((user) => ({
      username: user.username,
      enabled: true,
      email: `${user.username}@example.com`,
      emailVerified: true,
      firstName: 'Test',
      lastName: 'User',
      credentials: [{ type: 'password', value: spec.password, temporary: false }],
      realmRoles: user.roles,
      // Los usuarios exentos del alcance NO llevan atributos, y eso es lo que hace la
      // exención observable: si todos lo llevaran, el escenario que prueba que un rol
      // transversal alcanza cualquier recurso no probaría nada.
      ...(Object.keys(user.attributes ?? {}).length > 0 ? { attributes: user.attributes } : {})
    })),
    ...(clientScopes.length > 0 ? { clientScopes } : {}),
    // Lo que hereda un cliente que alguien cree a mano desde la consola: los mismos
    // integrados que tendría en el realm de `infra/`.
    ...(builtins.length > 0 ? { defaultDefaultClientScopes: builtins.map((scope) => scope.name) } : {}),
    clients
  };

  return `${JSON.stringify(realm, null, 2)}\n`;
}

/**
 * El User Profile del realm, en el único sitio donde el formato de import lo admite:
 * un componente `declarative-user-profile` cuya configuración es un STRING con el JSON
 * del `UPConfig` dentro. No hay campo `unmanagedAttributePolicy` en la raíz del realm.
 *
 * Los cuatro atributos base van explícitos porque este componente SUSTITUYE al perfil
 * por defecto: declararlo con solo la política dejaría el realm sin `username` ni
 * `email` gestionados, y ahí ya no se puede crear un usuario.
 *
 * `ENABLED` (y no `ADMIN_EDIT`) porque el token de un usuario tiene que poder llevar el
 * claim que sale del atributo: con las políticas de solo-admin el atributo existe pero
 * no está disponible fuera de la interfaz de gestión.
 */
function userProfileComponent() {
  const attribute = (name) => ({
    name,
    permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
    multivalued: false
  });
  return {
    providerId: 'declarative-user-profile',
    subComponents: {},
    config: {
      'kc.user.profile.config': [
        JSON.stringify({
          attributes: ['username', 'email', 'firstName', 'lastName'].map(attribute),
          unmanagedAttributePolicy: 'ENABLED'
        })
      ]
    }
  };
}

/**
 * Los tres scopes integrados de Keycloak de los que depende el servidor generado, con
 * sus nombres y mappers de fábrica. Los nombres de claim no se escriben aquí: salen de
 * `AUTH_PROVIDERS.keycloak`, que es lo que lee el `JwtAuthConverter`; si uno cambia,
 * el otro lo sigue.
 *
 * `basic` y `roles` no entran en el claim `scope`; `profile` sí, como en Keycloak (da un
 * `SCOPE_profile` que ninguna regla pide). La matriz de prueba varía los scopes del
 * diseño y la audiencia, y estos no tocan ninguno de los dos.
 */
export function builtinScopes() {
  const { rolesParent, rolesField, principalClaim } = AUTH_PROVIDERS.keycloak;
  const claims = { 'access.token.claim': 'true', 'id.token.claim': 'true', 'introspection.token.claim': 'true' };
  return [
    {
      name: 'basic',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'false' },
      protocolMappers: [
        { name: 'sub', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper', config: { ...claims } }
      ]
    },
    {
      name: 'roles',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'false' },
      protocolMappers: [
        {
          name: 'realm roles',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-realm-role-mapper',
          config: {
            ...claims,
            'id.token.claim': 'false',
            'claim.name': `${rolesParent}.${rolesField}`,
            'jsonType.label': 'String',
            multivalued: 'true'
          }
        }
      ]
    },
    {
      name: 'profile',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true' },
      protocolMappers: [
        {
          name: 'username',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-attribute-mapper',
          config: { ...claims, 'user.attribute': 'username', 'claim.name': principalClaim, 'jsonType.label': 'String' }
        }
      ]
    }
  ];
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

/**
 * El mapper que proyecta el atributo de usuario del alcance por recurso al claim del token.
 * Es el gemelo declarativo del `create protocol-mappers/models` que emite
 * `infra/init-keycloak.sh`: mismo nombre, mismo tipo y misma configuración, porque los dos
 * describen el mismo realm y un test de paridad los compara.
 */
function scopingMapper(claim) {
  return {
    name: `${claim}-mapper`,
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: {
      'user.attribute': claim,
      'claim.name': claim,
      'jsonType.label': 'String',
      multivalued: 'true',
      'access.token.claim': 'true',
      'id.token.claim': 'true'
    }
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

// ─── deploy/otel/collector.yaml ──────────────────────────────────────────────

/**
 * La configuración del colector OpenTelemetry: el ÚNICO sitio donde se decide a qué backend van
 * las trazas, las métricas y los logs. El servicio no lo sabe ni lo necesita.
 *
 * Robusta en el sentido que recomienda el propio proyecto del colector, y cada pieza por algo:
 *   · memory_limiter PRIMERO en cada pipeline: si el backend se atasca, el colector rechaza en
 *     vez de morir por falta de memoria —y el SDK de la app reintenta—.
 *   · attributes/redact antes de exportar: ninguna cabecera de credenciales sale de aquí aunque
 *     una instrumentación la capture.
 *   · batch al final: agrupa y comprime; exportar span a span es lo que satura un backend.
 *   · retry_on_failure + sending_queue en el exportador: un backend caído unos minutos no
 *     pierde datos, los encola.
 */
function collectorConfig(model) {
  const { collector, backend } = TELEMETRY_INFRA;
  const backendEndpoint = `http://${backend.serviceKey}:${backend.otlpHttpPort}`;
  return `# Colector OpenTelemetry de ${model.service.name} (pruebas manuales en deploy/).
# Generado por keel-spring build.
#
# El servicio exporta TODO aquí por OTLP y no sabe a qué backend va a parar: esa decisión vive
# SOLO en este archivo. Cambiar de backend es cambiar el bloque \`exporters\` (y la lista de cada
# pipeline) y reiniciar el colector; la aplicación no se toca. Ejemplos al final.

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${collector.grpcPort}
      http:
        endpoint: 0.0.0.0:${collector.httpPort}
  # Las MÉTRICAS no llegan: se van a buscar. El motivo es único y son los EXEMPLARS —el enlace de
  # un punto de una métrica a una traza de ejemplo—, que viajan pegados a los cubos del histograma
  # en el formato de exposición de Prometheus y que el registro OTLP de Micrometer no sabe emitir
  # con la versión que gestiona Boot 3.5. Quien no pueda scrapear vuelve al push con
  # METRICS_EXPORT_OTLP=true en la aplicación y quita este receptor del pipeline.
  prometheus:
    config:
      scrape_configs:
        - job_name: ${model.service.artifactId}
          scrape_interval: 15s
          metrics_path: ${METRICS_TRANSPORT.scrapePath}
          static_configs:
            - targets: ['app:8080']

processors:
  # Un scrape NO trae los atributos de recurso que sí trae OTLP: las series llegarían sin
  # service.name y el panel no podría filtrar por servicio. Va antes de resourcedetection y con
  # upsert para que el valor sea el mismo venga la métrica por donde venga.
  resource/scrape:
    attributes:
      - key: service.name
        value: ${model.service.artifactId}
        action: upsert
      - key: deployment.environment
        value: develop
        action: upsert
  # Primero en cada pipeline: con el backend atascado el colector rechaza en vez de caerse por
  # memoria, y el SDK de la aplicación reintenta.
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  # Completa el recurso con lo que declare el entorno (OTEL_RESOURCE_ATTRIBUTES) sin pisar lo
  # que ya trae la aplicación (service.name, service.version, deployment.environment).
  resourcedetection:
    detectors: [env]
    override: false
  # Defensa en profundidad: ninguna credencial sale del colector aunque una instrumentación la
  # capture como atributo.
  attributes/redact:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: http.request.header.cookie
        action: delete
      - key: http.response.header.set-cookie
        action: delete
      - key: http.request.header.x-api-key
        action: delete
  batch:
    send_batch_size: 1024
    timeout: 5s

exporters:
  # Backend de PRUEBA: Grafana LGTM (Tempo + Loki + Mimir), en el contenedor '${backend.serviceKey}'.
  otlphttp/backend:
    endpoint: ${backendEndpoint}
    compression: gzip
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 4
      queue_size: 5000
  # Un resumen por lote en los logs del colector: lo primero que se mira cuando «no llega nada».
  debug:
    verbosity: basic
  # Lo que SALIÓ del colector, en crudo y en disco (deploy/otel/out/). Es el segundo paso del
  # diagnóstico de «no llega nada»: si aquí hay datos, el problema está entre el colector y el
  # backend; si no los hay, está antes. Rota solo, y se borra con el resto de deploy/.
  file/traces:
    path: /var/otel-out/traces.json
  file/metrics:
    path: /var/otel-out/metrics.json
  file/logs:
    path: /var/otel-out/logs.json

extensions:
  health_check:
    endpoint: 0.0.0.0:${collector.healthPort}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, attributes/redact, batch]
      exporters: [otlphttp/backend, debug, file/traces]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, resource/scrape, resourcedetection, attributes/redact, batch]
      exporters: [otlphttp/backend, debug, file/metrics]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, attributes/redact, batch]
      exporters: [otlphttp/backend, debug, file/logs]

# ── Otros backends ──────────────────────────────────────────────────────────────────────────
# Se cambia el exportador y su referencia en los pipelines; nada más. Por ejemplo:
#
#   Jaeger o Tempo (trazas por OTLP):
#     otlp/jaeger:
#       endpoint: jaeger:4317
#       tls: { insecure: true }
#
#   Prometheus (métricas por remote-write):
#     prometheusremotewrite:
#       endpoint: http://prometheus:9090/api/v1/write
#
#   Un proveedor SaaS por OTLP (la clave, desde el entorno del colector, nunca en este archivo):
#     otlphttp/vendor:
#       endpoint: https://otlp.example.com
#       headers: { api-key: \${env:VENDOR_API_KEY} }
`;
}

// ─── deploy/otel/collector-{agent,gateway}.example.yaml ──────────────────────
//
// La referencia de PRODUCCIÓN, que la plataforma adapta y despliega; build no la levanta. Son
// dos piezas y no una, y no es gusto: el muestreo por COLA (quedarse con todas las trazas con
// error y con las lentas) solo funciona si todos los spans de una traza llegan al MISMO colector,
// y recoger el stdout de los contenedores exige un colector en CADA nodo. Un solo despliegue no
// puede ser las dos cosas: el agente de nodo reparte las trazas por traceID entre los gateways
// (exportador `loadbalancing`) y el gateway decide qué se queda.

function collectorAgentConfig(model) {
  const { collector } = TELEMETRY_INFRA;
  return `# Colector AGENTE (uno por nodo: DaemonSet) — referencia de producción para ${model.service.name}.
# Generado por keel-spring build. NO lo despliega build: es la plantilla que adapta la plataforma.
#
# Qué hace:
#   · Recoge los LOGS del stdout de los contenedores (filelog). La consola JSON (ECS) es el canal
#     primario de los logs del servicio; por eso LOG_EXPORT_OTLP va apagado en la app.
#   · Recibe trazas y métricas por OTLP de los pods de su nodo (la app exporta a
#     OTEL_EXPORTER_OTLP_ENDPOINT=http://<ip-del-nodo>:${collector.httpPort}).
#   · Añade los metadatos de Kubernetes (pod, deployment, namespace, nodo).
#   · Reparte las trazas por traceID entre los gateways, para que el muestreo por cola vea cada
#     traza entera en un solo sitio (collector-gateway.example.yaml).
#
# Muestreo: con el gateway haciendo muestreo por cola, sube TRACING_SAMPLING_PROBABILITY a 1.0 en
# la app — si no, se muestrea dos veces y el gateway decide sobre una décima parte.

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${collector.grpcPort}
      http:
        endpoint: 0.0.0.0:${collector.httpPort}
  filelog:
    include: [/var/log/pods/*/*/*.log]
    # Los logs del propio colector fuera: si no, cada línea que escribe al procesar un log vuelve
    # a entrar como log.
    exclude: [/var/log/pods/*/otel-*/*.log]
    start_at: end
    include_file_path: true
    operators:
      # Quita la envoltura del runtime (containerd/CRI-O/docker) y deja la línea de la app.
      - type: container
        id: container-parser
      # La línea es ECS: se parsea a atributos, con su instante y su nivel.
      - type: json_parser
        id: ecs-parser
        if: 'body matches "^\\\\{"'
        parse_from: body
        parse_to: attributes
        timestamp:
          parse_from: attributes["@timestamp"]
          layout_type: gotime
          layout: '2006-01-02T15:04:05.999999999Z07:00'
        severity:
          parse_from: attributes["log.level"]
      # trace.id / span.id (los renombra la app desde el MDC) pasan a ser el CONTEXTO del
      # registro: es lo que permite saltar del log a su traza en el backend.
      - type: trace_parser
        if: 'attributes["trace.id"] != nil'
        trace_id:
          parse_from: attributes["trace.id"]
        span_id:
          parse_from: attributes["span.id"]
      - type: move
        if: 'attributes["message"] != nil'
        from: attributes["message"]
        to: body

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    extract:
      metadata: [k8s.namespace.name, k8s.deployment.name, k8s.pod.name, k8s.node.name]
    pod_association:
      - sources:
          - from: resource_attribute
            name: k8s.pod.ip
      - sources:
          - from: connection
  resourcedetection:
    detectors: [env, system]
    override: false
  batch:
    send_batch_size: 1024
    timeout: 5s

exporters:
  # Trazas: por traceID a los gateways (servicio headless), para el muestreo por cola.
  loadbalancing:
    routing_key: traceID
    protocol:
      otlp:
        compression: gzip
        tls:
          insecure: true
    resolver:
      dns:
        hostname: otel-gateway-headless.observability.svc.cluster.local
  # Métricas y logs no necesitan afinidad: van al gateway tal cual.
  otlp/gateway:
    endpoint: otel-gateway.observability.svc.cluster.local:${collector.grpcPort}
    compression: gzip
    tls:
      insecure: true
    retry_on_failure:
      enabled: true
    sending_queue:
      enabled: true
      queue_size: 5000

extensions:
  health_check:
    endpoint: 0.0.0.0:${collector.healthPort}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [loadbalancing]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [otlp/gateway]
    logs:
      receivers: [filelog]
      processors: [memory_limiter, k8sattributes, resourcedetection, batch]
      exporters: [otlp/gateway]
`;
}

function collectorGatewayConfig(model) {
  const { collector } = TELEMETRY_INFRA;
  return `# Colector GATEWAY (Deployment con servicio headless) — referencia de producción para ${model.service.name}.
# Generado por keel-spring build. NO lo despliega build: es la plantilla que adapta la plataforma.
#
# Es el ÚNICO sitio que conoce el backend: cambiarlo es cambiar el bloque \`exporters\` de este
# archivo. Aquí se decide también qué trazas se quedan (muestreo por cola), porque el agente de
# nodo le manda cada traza entera por traceID.

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${collector.grpcPort}
      http:
        endpoint: 0.0.0.0:${collector.httpPort}

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  # Defensa en profundidad: ninguna credencial sale hacia el backend.
  attributes/redact:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: http.request.header.cookie
        action: delete
      - key: http.response.header.set-cookie
        action: delete
      - key: http.request.header.x-api-key
        action: delete
  # Muestreo por COLA: se decide con la traza entera delante. Se queda con TODAS las que tienen
  # un error y con todas las lentas, y con una parte del resto. Ajusta el umbral al SLO del
  # servicio y el porcentaje al volumen que el backend puede pagar.
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    policies:
      - name: errores
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: lentas
        type: latency
        latency:
          threshold_ms: 1000
      - name: resto
        type: probabilistic
        probabilistic:
          sampling_percentage: 10
  batch:
    send_batch_size: 2048
    timeout: 5s

exporters:
  # El backend. Placeholder: un proveedor por OTLP con su credencial DESDE EL ENTORNO del
  # colector, nunca en este archivo ni en la aplicación.
  otlphttp/backend:
    endpoint: \${env:OTEL_BACKEND_ENDPOINT}
    headers:
      authorization: \${env:OTEL_BACKEND_AUTH}
    compression: gzip
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 8
      queue_size: 10000

extensions:
  health_check:
    endpoint: 0.0.0.0:${collector.healthPort}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, tail_sampling, batch]
      exporters: [otlphttp/backend]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [otlphttp/backend]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [otlphttp/backend]
`;
}

/**
 * La imagen de la app en deploy/. Se nombra aquí una vez porque la citan tres sitios —el servicio
 * del compose, el `build` de up.sh y el mensaje que explica cómo levantar una réplica sin puerto—
 * y un nombre distinto en cualquiera de ellos deja a compose buscando una imagen que nadie
 * construyó, con un error que habla de registries y no del nombre.
 */
function appImage(service) {
  return `${service.projectName}-deploy:latest`;
}
