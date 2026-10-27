// Contenedorización del servicio para PRUEBAS MANUALES del diseñador (`deploy/`).
//
// Desde el incremento 14d de PLAN-KEEL-NEST.md el `deploy/` es NEUTRAL (`@keel-system/keel-core/gen/deploy.js`): la misma
// infraestructura, el mismo colector, el mismo realm y los mismos scripts que genera keel-nest para el mismo diseño.
// Aquí queda lo único que es de esta plataforma: la imagen de la app (el jar explotado en las capas de Spring Boot),
// la URL JDBC de la base vista desde la red del compose, la variable con la que Spring lee el JWKS directo, la sonda
// de readiness y las URLs del actuator y de Swagger que imprime up.sh.

import { deployFiles, publishedUrls as neutralPublishedUrls, postmanEnvironmentPath, builtinScopes } from '@keel-system/keel-core/gen/deploy';
import { JAVA_VERSION } from '../lib/assets.js';
import { JAVA_DATABASES } from '../lib/java-stack.js';
import { LOCAL_API_KEY, LOCAL_CORS_ORIGINS, localClientApiKey } from './config.js';

export { postmanEnvironmentPath, builtinScopes };

/** La plataforma de keel-spring para el `deploy/` neutral. */
export const SPRING_DEPLOY = {
  generator: 'keel-spring',
  dockerfile: (model) => dockerfile(model),
  // Dentro de la red de compose el host es `db`. Los motores relacionales solo cambian el host de su URL; Mongo
  // además cambia el modo de conexión (replica set completo en vez de conexión directa), así que declara su URL interna.
  internalDatabaseUrl: (db, dbName) => {
    const connection = JAVA_DATABASES[db.id];
    return connection.internalUrl ? connection.internalUrl(dbName) : connection.url(dbName).replace('localhost', 'db');
  },
  // Boot prioriza jwk-set-uri sobre issuer-uri: el decoder resuelve las claves por la ruta interna sin discovery.
  jwkSetUriVariable: 'SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_JWK_SET_URI',
  readyPath: '/actuator/health/readiness',
  appUrls: [
    { label: 'Swagger UI', url: 'http://localhost:${APP_PORT:-8080}/swagger-ui/index.html' },
    { label: 'Health', url: 'http://localhost:${APP_PORT:-8080}/actuator/health' }
  ],
  localApiKey: LOCAL_API_KEY,
  localClientApiKey,
  localCorsOrigins: LOCAL_CORS_ORIGINS
};

export function generate(model) {
  return deployFiles(model, SPRING_DEPLOY);
}

/** URLs que el stack publica, para imprimirlas al terminar y para el README. */
export function publishedUrls(model) {
  return neutralPublishedUrls(model, SPRING_DEPLOY);
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
