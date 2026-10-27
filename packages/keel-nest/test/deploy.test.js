// El `deploy/` de keel-nest (incremento 14d): el neutral de keel-core con la plataforma de Node.
//
// Lo que se afirma es lo que hace que `bash deploy/up.sh` levante el servicio y lo que hace que sea el MISMO stack que
// el de keel-spring:
//   · toda variable que el perfil develop exige SIN default llega al contenedor de la app (si no, no arranca);
//   · toda variable que el compose le da a la app la lee su configuración (una que nadie lee es una palanca muerta);
//   · los servicios de infraestructura, el colector y el realm son los de keel-spring byte a byte;
//   · la imagen: multietapa, sin root, con su HEALTHCHECK sobre /readyz y Node como PID 1.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const SUBJECTS = [
  ['product-catalog', { database: 'postgresql' }],
  ['notification-mailer', { database: 'mysql', broker: 'rabbitmq', telemetry: 'otel' }],
  ['catalog-extended', { database: 'postgresql', broker: 'kafka', telemetry: 'otel', cache: 'redis', storage: 'minio', auth: 'keycloak' }],
  ['asset-vault', { broker: 'snssqs', telemetry: 'otel', cache: 'valkey', storage: 'minio', auth: 'cognito' }],
  ['stock-reservation', { database: 'postgresql', broker: 'rabbitmq' }],
  ['payment-checkout', { database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak', paymentGateway: 'stripe' }]
];

/** Las variables de los YAML de un perfil: obligatorias (sin default) y todas. */
function variablesOf(files, profile) {
  // Sin comentarios: application.yaml explica la sintaxis con un `${VAR}` de ejemplo.
  const texts = files
    .filter((file) => file.path === 'config/application.yaml' || file.path.startsWith(`config/parameters/${profile}/`))
    .map((file) => file.content.replace(/(^|\s)#.*$/gm, '$1'));
  const all = new Set();
  const required = new Set();
  for (const text of texts) {
    for (const [, name, fallback] of text.matchAll(/\$\{([A-Z0-9_]+)(:)?/g)) {
      all.add(name);
      if (!fallback) required.add(name);
    }
  }
  return { all, required };
}

for (const [name, stack] of SUBJECTS) {
  const nest = planFixture(name, { stack });
  const byPath = Object.fromEntries(nest.files.map((file) => [file.path, file.content]));
  const compose = parseYaml(byPath['deploy/docker-compose.yaml']);
  const appEnv = compose.services.app.environment;

  test(`${name}: toda variable que develop exige sin default llega a la app, y toda la que llega la lee el servidor`, () => {
    const { all, required } = variablesOf(nest.files, 'develop');
    const missing = [...required].filter((variable) => !(variable in appEnv));
    assert.deepEqual(missing, [], `develop las exige y el compose no se las da: la app no arrancaría`);
    const unread = Object.keys(appEnv).filter((variable) => variable !== 'PROFILE' && !all.has(variable));
    assert.deepEqual(unread, [], 'el compose las da y la configuración de develop no las lee');
    // Y el .env enumera las que el compose deja a quien despliega.
    const env = byPath['deploy/.env'];
    for (const [variable, value] of Object.entries(appEnv)) {
      const reference = /^\$\{([A-Z0-9_]+)\}$/.exec(String(value));
      if (reference) assert.match(env, new RegExp(`^${reference[1]}=`, 'm'), `${variable} sin valor en deploy/.env`);
    }
  });

  test(`${name}: la infraestructura, el colector y el realm de deploy/ son los de keel-spring`, () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = Object.fromEntries(planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack }).files.map((file) => [file.path, file.content]));
    const springCompose = parseYaml(spring['deploy/docker-compose.yaml']);
    assert.deepEqual(Object.keys(compose.services).sort(), Object.keys(springCompose.services).sort());
    for (const service of Object.keys(compose.services).filter((key) => key !== 'app')) {
      assert.deepEqual(compose.services[service], springCompose.services[service], service);
    }
    assert.deepEqual(compose.volumes, springCompose.volumes);
    // La app: la misma base (el DB_URL de los dos servidores es intercambiable) y las mismas dependencias.
    assert.equal(appEnv.DB_URL, springCompose.services.app.environment.DB_URL);
    assert.deepEqual(compose.services.app.depends_on, springCompose.services.app.depends_on);
    for (const file of ['deploy/otel/collector.yaml', 'deploy/keycloak/realm-export.json', 'deploy/down.sh'].filter((candidate) => candidate in spring)) {
      const neutral = (text) => text.replaceAll('keel-spring', 'keel-nest').replaceAll(`${manifest.service.name}-spring`, `${manifest.service.name}-nest`);
      assert.equal(byPath[file], neutral(spring[file]), file);
    }
    assert.equal(byPath[nest.files.find((file) => file.path.endsWith('.postman_environment.json')).path] != null, true);
  });
}

test('la imagen: multietapa sobre Node, dependencias de producción, sin root, HEALTHCHECK sobre /readyz y Node como PID 1', () => {
  const nest = planFixture('product-catalog');
  const byPath = Object.fromEntries(nest.files.map((file) => [file.path, file.content]));
  const dockerfile = byPath['deploy/Dockerfile'];
  assert.equal((dockerfile.match(/^FROM /gm) ?? []).length, 3);
  assert.equal((dockerfile.match(/^FROM node:\d+-alpine/gm) ?? []).length, 2, 'dependencias y runtime; la compilación hereda de la primera');
  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\/\nRUN npm ci/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /COPY --chown=node:node config\/ \.\/config\//);
  assert.match(dockerfile, /HEALTHCHECK [^\n]*\n\s+CMD wget -q -O - http:\/\/localhost:8080\/readyz/);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "dist\/main\.js"\]$/m);
  // Lo que el Dockerfile copia existe en el proyecto generado.
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json']) assert.ok(file in byPath, file);
  assert.match(byPath['.dockerignore'], /^node_modules\/$/m);
  assert.match(byPath['deploy/up.sh'], /READY_URL="http:\/\/localhost:\$\{APP_PORT:-8080\}\/readyz"/);
  assert.ok(nest.files.find((file) => file.path === 'deploy/up.sh').executable);
});

test('con un proveedor de identidad, la app valida por el JWKS interno (el emisor partido de deploy/)', () => {
  const nest = planFixture('asset-vault', { stack: { broker: 'rabbitmq', auth: 'keycloak', cache: 'redis', storage: 'minio' } });
  const byPath = Object.fromEntries(nest.files.map((file) => [file.path, file.content]));
  const compose = parseYaml(byPath['deploy/docker-compose.yaml']);
  assert.equal(compose.services.app.environment.OAUTH2_JWK_SET_URI, `http://keycloak:8080/realms/${nest.model.service.name}/protocol/openid-connect/certs`);
  assert.match(byPath['config/parameters/develop/security.yaml'], /jwk-set-uri: \$\{OAUTH2_JWK_SET_URI:\}/);
  assert.doesNotMatch(byPath['config/parameters/local/security.yaml'], /jwk-set-uri/);
});

test('el README enseña deploy/: los dos scripts, las URLs que imprime up.sh y el environment de Postman', () => {
  const nest = planFixture('catalog-extended', { stack: SUBJECTS[2][1] });
  const byPath = Object.fromEntries(nest.files.map((file) => [file.path, file.content]));
  const readme = byPath['README.md'];
  assert.match(readme, /bash deploy\/up\.sh/);
  assert.match(readme, /bash deploy\/down\.sh/);
  assert.match(readme, /<http:\/\/localhost:8080\/readyz>/);
  assert.match(readme, /<http:\/\/localhost:3001\/d\/keel-catalog>/, 'con telemetría, el panel');
  const postman = nest.files.find((file) => file.path.endsWith('.postman_environment.json')).path;
  assert.ok(readme.includes(postman) && fs.existsSync(FIXTURES_DIR));
});

test('con podman, up.sh construye en formato docker: el OCI descarta el HEALTHCHECK', () => {
  const up = planFixture('product-catalog').files.find((file) => file.path === 'deploy/up.sh').content;
  assert.match(up, /if \[ "\$RUNTIME" = "podman" \]; then BUILD_FORMAT=\(--format docker\); fi/);
  assert.match(up, /build \$\{BUILD_FORMAT\[@\]\+"\$\{BUILD_FORMAT\[@\]\}"\} -f/);
});
