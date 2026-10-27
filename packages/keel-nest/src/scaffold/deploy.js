// Contenedorización del servicio para PRUEBAS MANUALES del diseñador (`deploy/`, incremento 14d de PLAN-KEEL-NEST.md).
//
// Es el `deploy/` NEUTRAL de `@keel-system/keel-core/gen/deploy.js`, el mismo que genera keel-spring para el mismo diseño: la
// infraestructura, el colector y el backend de telemetría, el realm de Keycloak, el environment de Postman y los
// scripts up.sh/down.sh. Lo de esta plataforma:
//
//   · la imagen de la app: Node con las dependencias de producción, el `dist/` compilado y `config/`;
//   · la URL de la base vista desde la red del compose (`db`), en el MISMO formato que keel-spring —el `DB_URL` de los
//     dos servidores es intercambiable—;
//   · `OAUTH2_JWK_SET_URI`, con la que el servidor valida el token por el JWKS interno del proveedor (el emisor que
//     ve quien pide el token es localhost:8180; el que alcanza la app, keycloak:8080);
//   · `/readyz` como sonda de up.sh, y las sondas como URLs propias (no hay actuator ni Swagger).

import { deployFiles, publishedUrls as neutralPublishedUrls, postmanEnvironmentPath } from '@keel-system/keel-core/gen/deploy';
import { DATABASES } from '@keel-system/keel-core/gen/infra-catalog';
import { NODE_VERSION } from '../lib/assets.js';
import { LOCAL_API_KEY, LOCAL_CORS_ORIGINS, localClientApiKey } from './security.js';

export { postmanEnvironmentPath };

/** La variable con la que el servidor lee el JWKS directo (security.oauth2.jwk-set-uri). */
export const JWK_SET_URI_VARIABLE = 'OAUTH2_JWK_SET_URI';

/** La plataforma de keel-nest para el `deploy/` neutral. */
export const NEST_DEPLOY = {
  generator: 'keel-nest',
  dockerfile: () => dockerfile(),
  internalDatabaseUrl: (db, dbName) => internalDatabaseUrl(db, dbName),
  jwkSetUriVariable: JWK_SET_URI_VARIABLE,
  readyPath: '/readyz',
  appUrls: [
    { label: 'Sonda de vida', url: 'http://localhost:${APP_PORT:-8080}/livez' },
    { label: 'Sonda de disponibilidad', url: 'http://localhost:${APP_PORT:-8080}/readyz' }
  ],
  localApiKey: LOCAL_API_KEY,
  localClientApiKey,
  localCorsOrigins: LOCAL_CORS_ORIGINS
};

export function generate(model) {
  return deployFiles(model, NEST_DEPLOY);
}

/** URLs que el stack publica, para imprimirlas al terminar y para el README. */
export function publishedUrls(model) {
  return neutralPublishedUrls(model, NEST_DEPLOY);
}

/**
 * La base vista desde la red del compose, con el formato de `DB_URL` que leen los dos servidores. MongoDB, con el
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
node_modules/
dist/
build/
coverage/
infra/
deploy/
docs/
specs/
test/
.idea/
.vscode/
*.md
`;

function dockerfile() {
  return `# Imagen del servicio, en tres etapas.
#
# El corte no es cosmetico: las dependencias se instalan en una etapa propia que solo se invalida si cambian
# package.json o package-lock.json, de modo que iterar sobre src/ no vuelve a descargar node_modules. Y la imagen final
# lleva solo las dependencias de PRODUCCION, el dist/ compilado y config/.
#
# El contexto de build es la RAIZ del proyecto, no deploy/: se necesitan src/, config/ y el lockfile. Por eso el
# .dockerignore vive en la raiz. El package-lock.json lo crea el primer \`npm install\` y se versiona con el proyecto:
# sin el, \`npm ci\` se niega a instalar.

# ── 1. Dependencias (capa cacheada) ──────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. Compilacion ───────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /workspace
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine
WORKDIR /application
ENV NODE_ENV=production

# Usuario sin privilegios (el \`node\` de la imagen base). La app no escribe en ningun volumen, asi que esto no choca con
# el mapeo de UIDs de podman rootless.
USER node

# El orden importa: de lo que menos cambia a lo que mas.
COPY --from=build --chown=node:node /workspace/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /workspace/package.json ./
COPY --chown=node:node config/ ./config/
COPY --from=build --chown=node:node /workspace/dist/ ./dist/

EXPOSE 8080

# wget de BusyBox (viene en la base alpine). Es lo que consume el \`depends_on: service_healthy\` de quien dependa de la
# app y el bucle de up.sh. /readyz responde en el puerto PRINCIPAL en todos los perfiles.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=18 \\
  CMD wget -q -O - http://localhost:8080/readyz | grep -q '"status":"UP"' || exit 1

# Forma exec: Node es el PID 1 y recibe el SIGTERM que dispara el apagado ordenado (enableShutdownHooks).
ENTRYPOINT ["node", "dist/main.js"]
`;
}
