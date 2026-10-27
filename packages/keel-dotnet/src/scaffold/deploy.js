// Contenedorización del servicio para PRUEBAS MANUALES del diseñador (`deploy/`, incremento 14d de PLAN-KEEL-DOTNET.md).
//
// Es el `deploy/` NEUTRAL de `@keel-system/keel-core/gen/deploy.js`, el mismo que generan keel-spring y keel-nest para el mismo
// diseño: la infraestructura, el colector y el backend de telemetría, el realm de Keycloak, el environment de Postman y
// los scripts up.sh/down.sh. Lo de esta plataforma:
//
//   · la imagen de la app: la solución publicada con el SDK de .NET y corrida sobre el runtime de ASP.NET, con su
//     usuario sin privilegios y `config/` junto al ejecutable;
//   · la URL de la base vista desde la red del compose (`db`), en el MISMO formato que keel-spring y keel-nest: el
//     `DB_URL` de los tres servidores es intercambiable;
//   · `OAUTH2_JWK_SET_URI`, con la que el servidor valida el token por el JWKS interno del proveedor (el emisor que ve
//     quien pide el token es localhost:8180; el que alcanza la app, keycloak:8080);
//   · `/readyz` como sonda de up.sh, y las sondas como URLs propias (no hay actuator ni Swagger).

import { deployFiles, publishedUrls as neutralPublishedUrls, postmanEnvironmentPath } from '@keel-system/keel-core/gen/deploy';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { runtimeDefault } from '@keel-system/keel-core/gen/runtime-env';
import { TARGET_FRAMEWORK } from '../lib/assets.js';
import { solution } from './render.js';
import { LOCAL_API_KEY, localClientApiKey } from './security.js';

export { postmanEnvironmentPath };

/** La variable con la que el servidor lee el JWKS directo (security.oauth2.jwk-set-uri). */
export const JWK_SET_URI_VARIABLE = 'OAUTH2_JWK_SET_URI';

/** La versión de las imágenes de .NET: la del framework al que apunta la solución. */
export const DOTNET_IMAGE_TAG = TARGET_FRAMEWORK.replace(/^net/, '');

/** La plataforma de keel-dotnet para el `deploy/` neutral. */
export const DOTNET_DEPLOY = {
  generator: 'keel-dotnet',
  dockerfile: (model) => dockerfile(model),
  internalDatabaseUrl: (db, dbName) => internalDatabaseUrl(db, dbName),
  jwkSetUriVariable: JWK_SET_URI_VARIABLE,
  readyPath: '/readyz',
  appUrls: [
    { label: 'Sonda de vida', url: 'http://localhost:${APP_PORT:-8080}/livez' },
    { label: 'Sonda de disponibilidad', url: 'http://localhost:${APP_PORT:-8080}/readyz' }
  ],
  localApiKey: LOCAL_API_KEY,
  localClientApiKey,
  localCorsOrigins: runtimeDefault('SECURITY_CORS_ALLOWED_ORIGINS')
};

export function generate(model) {
  return deployFiles(model, DOTNET_DEPLOY);
}

/** URLs que el stack publica, para imprimirlas al terminar y para el README. */
export function publishedUrls(model) {
  return neutralPublishedUrls(model, DOTNET_DEPLOY);
}

/**
 * La base vista desde la red del compose, con el formato de `DB_URL` que leen los tres servidores. MongoDB, con el
 * replica set completo: dentro de la red `db` se resuelve y el driver puede reconectar tras un failover.
 */
export function internalDatabaseUrl(db, dbName) {
  if (db.kind === 'document') {
    return `mongodb://${db.user(dbName)}:${db.password}@db:${db.port}/${dbName}?authSource=admin&replicaSet=rs0&uuidRepresentation=standard`;
  }
  return `jdbc:${db.id}://db:${DATABASES[db.id].port}/${dbName}`;
}

/** Lo que no entra en la imagen: el contexto de build es la RAÍZ del proyecto. */
export const DOCKERIGNORE = `.git/
**/bin/
**/obj/
tests/
build/
infra/
deploy/
docs/
specs/
.idea/
.vs/
.vscode/
*.md
`;

function dockerfile(model) {
  const sln = solution(model);
  const api = sln.api;
  return `# Imagen del servicio, en dos etapas.
#
# La primera publica el proyecto Api con el SDK de .NET; la imagen final lleva solo el runtime de ASP.NET, lo publicado
# y config/ (que la publicación copia junto al ejecutable). La restauración va en su propia capa, que solo se invalida
# si cambian los .csproj, los props o los lockfiles: iterar sobre el código no vuelve a descargar los paquetes.
#
# El contexto de build es la RAIZ del proyecto, no deploy/: se necesitan src/, config/ y los props. Por eso el
# .dockerignore vive en la raiz.

# ── 1. Publicacion ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_IMAGE_TAG} AS build
WORKDIR /workspace
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
COPY global.json Directory.Build.props Directory.Packages.props ./
# Los proyectos de src/ con sus lockfiles (si ya se commitearon), y la restauracion del Api, que arrastra al resto.
COPY src/ src/
RUN dotnet restore ${api.csproj}
COPY config/ config/
RUN dotnet publish ${api.csproj} -c Release -o /application --no-restore

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_IMAGE_TAG}
WORKDIR /application
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# El usuario sin privilegios que traen las imagenes de .NET (app, UID 1654). La app no escribe en ningun volumen, asi
# que esto no choca con el mapeo de UIDs de podman rootless.
USER $APP_UID

COPY --from=build --chown=$APP_UID /application/ ./

EXPOSE 8080

# La imagen no trae curl ni wget: la sonda habla HTTP con el /dev/tcp de bash. Es lo que consume el
# \`depends_on: service_healthy\` de quien dependa de la app y el bucle de up.sh. /readyz responde en el puerto PRINCIPAL
# en todos los perfiles.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=18 \\
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /readyz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n" >&3 && grep -q "\\"status\\":\\"UP\\"" <&3' || exit 1

# Forma exec: dotnet es el PID 1 y recibe el SIGTERM que dispara el apagado ordenado (/readyz a 503 y el drenaje).
ENTRYPOINT ["dotnet", "${api.name}.dll"]
`;
}
