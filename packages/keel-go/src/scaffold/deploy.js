// Contenedorización del servicio para PRUEBAS MANUALES del diseñador (`deploy/`, incremento 14d).
//
// Es el `deploy/` NEUTRAL de `keel-core/gen/deploy.js`, el mismo que generan los otros tres para el mismo diseño: la
// infraestructura, el colector y el backend de telemetría, el realm de Keycloak, el environment de Postman y los scripts
// up.sh/down.sh. Lo de esta plataforma:
//
//   · la imagen de la app: un binario estático sin cgo sobre distroless/static:nonroot (usuario no root, sin shell). La
//     configuración va embebida en el binario, así que no hay nada más que copiar;
//   · sin curl ni shell, el HEALTHCHECK es el subcomando `healthcheck` del propio binario;
//   · la caché de módulos es una capa de la imagen (COPY go.mod go.sum + go mod download) y no `RUN --mount=type=cache`: esa
//     clave exige BuildKit, y este Dockerfile se construye igual con docker y con podman. Por lo mismo exige go.sum: lo escribe
//     `go mod tidy`, y sin él el COPY falla diciendo qué archivo falta;
//   · la URL de la base vista desde la red del compose (`db`), en el MISMO formato que los otros tres: el `DB_URL` de los cuatro
//     servidores es intercambiable.

import { deployFiles, publishedUrls as neutralPublishedUrls, postmanEnvironmentPath } from '@keel-system/keel-core/gen/deploy';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { runtimeDefault } from '@keel-system/keel-core/gen/runtime-env';
import { GO_TOOLCHAIN } from '../lib/assets.js';
import { layout } from './render.js';

export { postmanEnvironmentPath };

/** La variable con la que el servidor lee el JWKS directo (security.oauth2.jwk-set-uri). */
export const JWK_SET_URI_VARIABLE = 'OAUTH2_JWK_SET_URI';

/** La imagen con la que se compila: el toolchain con el que se mide. */
export const GOLANG_IMAGE = `docker.io/library/golang:${GO_TOOLCHAIN.replace(/^go/, '')}`;

/** La imagen final: sin shell, sin libc y sin root. */
export const RUNTIME_IMAGE = 'gcr.io/distroless/static:nonroot';

/** La plataforma de keel-go para el `deploy/` neutral. La clave de API no se genera: la frontera la rechaza. */
export const GO_DEPLOY = {
  generator: 'keel-go',
  dockerfile: (model) => dockerfile(model),
  internalDatabaseUrl: (db, dbName) => internalDatabaseUrl(db, dbName),
  jwkSetUriVariable: JWK_SET_URI_VARIABLE,
  readyPath: '/readyz',
  appUrls: [
    { label: 'Sonda de vida', url: 'http://localhost:${APP_PORT:-8080}/livez' },
    { label: 'Sonda de disponibilidad', url: 'http://localhost:${APP_PORT:-8080}/readyz' }
  ],
  localApiKey: null,
  localClientApiKey: () => null,
  localCorsOrigins: runtimeDefault('SECURITY_CORS_ALLOWED_ORIGINS')
};

export function generate(model) {
  return [...deployFiles(model, GO_DEPLOY), { path: '.dockerignore', content: DOCKERIGNORE }, { path: '.gitattributes', content: GITATTRIBUTES }];
}

/** URLs que el stack publica, para imprimirlas al terminar y para el README. */
export function publishedUrls(model) {
  return neutralPublishedUrls(model, GO_DEPLOY);
}

/**
 * La base vista desde la red del compose, con el formato de `DB_URL` que leen los cuatro servidores. MongoDB, con el replica
 * set completo: dentro de la red `db` se resuelve y el driver puede reconectar tras un failover.
 */
export function internalDatabaseUrl(db, dbName) {
  if (db.kind === 'document') {
    return `mongodb://${db.user(dbName)}:${db.password}@db:${db.port}/${dbName}?authSource=admin&replicaSet=rs0&uuidRepresentation=standard`;
  }
  return `jdbc:${db.id}://db:${DATABASES[db.id].port}/${dbName}`;
}

/** Lo que no entra en la imagen: el contexto de build es la RAÍZ del proyecto. */
export const DOCKERIGNORE = `.git/
bin/
build/
tests/
infra/
deploy/
docs/
specs/
.idea/
.vscode/
*.md
`;

// Un .sh con CRLF no se ejecuta dentro de un contenedor: en un checkout de Windows, git no los toca.
const GITATTRIBUTES = `*.sh text eol=lf
`;

function dockerfile(model) {
  const { server } = layout(model);
  return `# Imagen del servicio, en dos etapas.
#
# La primera compila un binario estático, sin cgo, y lleva dentro la configuración (embed.FS). La imagen final es solo ese
# binario, sin shell y con un usuario sin privilegios. La descarga de módulos va en su propia capa, que solo se invalida si
# cambian go.mod o go.sum: iterar sobre el código no vuelve a descargarlos. go.sum lo escribe \`go mod tidy\`: ejecútalo antes.
#
# El contexto de build es la RAIZ del proyecto, no deploy/: se necesitan cmd/, internal/ y config/. Por eso el .dockerignore
# vive en la raiz.

# ── 1. Compilacion ───────────────────────────────────────────────────────────
FROM ${GOLANG_IMAGE} AS build
WORKDIR /workspace
ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY config/ config/
COPY internal/ internal/
RUN go build -trimpath -ldflags="-s -w" -o /server ./${server.dir}

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM ${RUNTIME_IMAGE}
COPY --from=build /server /server

EXPOSE 8080

# La imagen no trae shell ni curl: la sonda es un subcomando del propio binario, que pregunta a /readyz. Es lo que consume el
# \`depends_on: service_healthy\` de quien dependa de la app y el bucle de up.sh. /readyz responde en el puerto PRINCIPAL en
# todos los perfiles.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=18 CMD ["/server", "healthcheck"]

# Forma exec: el binario es el PID 1 y recibe el SIGTERM que dispara el apagado ordenado (/readyz a 503 y el drenaje).
ENTRYPOINT ["/server"]
`;
}
