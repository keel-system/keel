// `keel-recover target`: el `target.yaml` de la paridad, derivado del `deploy/` que emite build en el proyecto generado.
//
// Hasta el inc. 9 se escribía a mano (el del laboratorio es `realworld-node/target-conduit-dotnet.yaml`), y con él un
// script aparte que sembraba las personas en el Keycloak del deploy. Todo sale de dos archivos que build escribe
// siempre igual en los tres generadores —`deploy/docker-compose.yaml` y `deploy/keycloak/realm-export.json`— más los
// nombres REALES de los contenedores, que dependen del frontend de compose y se preguntan al runtime por sus etiquetas.
// No importa ningún generador: lee los archivos, como lo leería cualquiera.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { TEST_USER_PASSWORD } from 'keel-core/gen/identity-realm';
import { validateDoc } from './schema.js';

const env = (service) => {
  const raw = service?.environment ?? {};
  if (!Array.isArray(raw)) return raw;
  return Object.fromEntries(raw.map((entry) => String(entry).split(/=(.*)/s).slice(0, 2)));
};
/** El puerto del contenedor de la primera publicación (`${APP_PORTS:-8080}:8080` → 8080). */
const containerPort = (service) => {
  const first = (service?.ports ?? [])[0];
  const port = String(first ?? '').split(':').at(-1);
  return /^\d+$/.test(port) ? Number(port) : null;
};
const byImage = (services, pattern) => Object.entries(services).find(([, service]) => pattern.test(String(service?.image ?? '')));

/**
 * El documento target.yaml, sin tocar el runtime. `containerOf(servicio)` da el nombre real del contenedor de un
 * servicio de compose, y `networkOf(contenedor)` sus redes.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function planTarget({ compose, realm, name, projectRel, containerOf, networkOf }) {
  const errors = [];
  const services = compose?.services ?? {};
  const project = compose?.name;
  if (!project) errors.push('deploy/docker-compose.yaml no declara `name`: sin el proyecto de compose no se encuentran los contenedores');

  const app = services.app;
  const appPort = containerPort(app);
  if (!app || !appPort) errors.push('deploy/docker-compose.yaml no tiene el servicio `app` con su puerto publicado');

  const [dbService, db] = byImage(services, /(^|\/)mongo:/) ?? [];
  if (!db) {
    const engines = Object.values(services).map((s) => String(s?.image ?? '')).filter((image) => /postgres|mysql|mariadb|mssql|oracle/.test(image));
    errors.push(
      engines.length
        ? `la base del regenerado es ${engines.join(', ')}: la paridad solo sabe vaciar MongoDB (keel-recover no ha medido otro motor)`
        : 'deploy/docker-compose.yaml no tiene la base de MongoDB'
    );
  }

  const [kcService, keycloak] = byImage(services, /keycloak/) ?? [];
  const userClient = (realm?.clients ?? []).find((client) => client.publicClient && client.directAccessGrantsEnabled);
  if (keycloak && !userClient) {
    errors.push('el realm del deploy no trae un cliente público con password grant: el diseño no identifica al llamante por su sub y la paridad no tiene cómo pedir el token de una persona');
  }
  if (errors.length) return { doc: null, errors };

  const dbContainer = containerOf(dbService);
  const appContainer = containerOf('app');
  const kcContainer = keycloak ? containerOf(kcService) : null;
  for (const [service, container] of [['app', appContainer], [dbService, dbContainer], ...(keycloak ? [[kcService, kcContainer]] : [])]) {
    if (!container) errors.push(`no hay contenedor del servicio '${service}' del proyecto '${project}': levanta el deploy (bash deploy/up.sh)`);
  }
  if (errors.length) return { doc: null, errors };
  const [network] = networkOf(appContainer);
  if (!network) return { doc: null, errors: [`el contenedor ${appContainer} no está en ninguna red`] };

  const dbEnv = env(db);
  const kcEnv = env(keycloak);
  const kcPort = containerPort(keycloak) ?? 8080;
  const doc = {
    kind: 'target',
    schema: 1,
    name,
    project: projectRel,
    base: `http://app:${appPort}`,
    // El curl de la paridad sale de un contenedor propio en la red del deploy, que parity crea y borra.
    tool: { container: `keel-recover-tool-${name}`, network },
    database: {
      container: dbContainer,
      tech: 'mongodb',
      name: dbEnv.MONGO_INITDB_DATABASE ?? realm?.realm ?? name,
      ...(dbEnv.MONGO_INITDB_ROOT_USERNAME
        ? { auth: { user: dbEnv.MONGO_INITDB_ROOT_USERNAME, password: dbEnv.MONGO_INITDB_ROOT_PASSWORD ?? '', authDb: 'admin' } }
        : {})
    },
    ...(keycloak
      ? {
          idp: {
            tokenUrl: `http://${kcService}:${kcPort}/realms/${realm.realm}/protocol/openid-connect/token`,
            clientId: userClient.clientId,
            // La contraseña de las personas de prueba: la misma convención que el realm del arnés (identity-realm.js).
            password: TEST_USER_PASSWORD,
            // Las personas de los flujos las da de alta parity antes de empezar, con la administración del realm.
            seed: {
              container: kcContainer,
              realm: realm.realm,
              admin: { user: kcEnv.KC_BOOTSTRAP_ADMIN_USERNAME ?? 'admin', password: kcEnv.KC_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin' }
            }
          }
        }
      : {})
  };
  const schemaErrors = validateDoc(doc).map((e) => `target.yaml: ${e}`);
  return schemaErrors.length ? { doc: null, errors: schemaErrors } : { doc, errors: [] };
}

/** El target de un proyecto generado, con los contenedores resueltos por el runtime. */
export function deriveTarget(projectDir, { rt, workspace = process.cwd() } = {}) {
  const dir = path.resolve(projectDir);
  const composeFile = path.join(dir, 'deploy', 'docker-compose.yaml');
  if (!fs.existsSync(composeFile)) return { doc: null, errors: [`no hay ${path.relative(workspace, composeFile)}: ¿es un proyecto generado por keel?`] };
  const compose = YAML.parse(fs.readFileSync(composeFile, 'utf8'));
  const realmFile = path.join(dir, 'deploy', 'keycloak', 'realm-export.json');
  const realm = fs.existsSync(realmFile) ? JSON.parse(fs.readFileSync(realmFile, 'utf8')) : null;
  return planTarget({
    compose,
    realm,
    name: path.basename(dir),
    projectRel: path.relative(workspace, dir).replace(/\\/g, '/'),
    containerOf: (service) => rt.composeContainer(compose.name, service),
    networkOf: (container) => rt.networks(container)
  });
}
