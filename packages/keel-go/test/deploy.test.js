// El `deploy/` de keel-go (incremento 14d): el neutral de keel-core con la plataforma de Go.
//
// Lo que se afirma es lo que hace que `bash deploy/up.sh` levante el servicio y lo que hace que sea el MISMO stack que el de
// keel-spring:
//   · toda variable que el perfil develop exige SIN default llega al contenedor de la app (si no, no arranca);
//   · toda variable que el compose le da a la app la lee su configuración (una que nadie lee es una palanca muerta);
//   · los servicios de infraestructura, el colector y el realm son los de keel-spring byte a byte;
//   · la imagen: dos etapas, sin cgo, sobre distroless nonroot, con el subcomando healthcheck, y lo que copia existe.
// Que la imagen construya y el servicio arranque dentro lo mide deploy-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { GO_TOOLCHAIN } from '../src/lib/assets.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const SUBJECTS = [
  ['product-catalog', { database: 'postgresql' }],
  ['notification-mailer', { database: 'postgresql', broker: 'rabbitmq', telemetry: 'otel' }],
  ['catalog-extended', { database: 'postgresql', broker: 'kafka', telemetry: 'otel', cache: 'redis', storage: 'minio', auth: 'keycloak' }],
  ['asset-vault', { database: 'mongodb', broker: 'snssqs', telemetry: 'otel', cache: 'valkey', storage: 'minio', auth: 'cognito' }],
  ['stock-reservation', { database: 'postgresql', broker: 'rabbitmq' }],
  ['payment-checkout', { database: 'postgresql', broker: 'rabbitmq', auth: 'keycloak', paymentGateway: 'stripe' }]
];

const plan = (name, stack, planner = planService) => planner({ ...loadService(path.join(FIXTURES_DIR, name)), workspace: FIXTURES_DIR, stack });

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
  const go = plan(name, stack);
  const byPath = Object.fromEntries(go.files.map((file) => [file.path, file.content]));
  const compose = parseYaml(byPath['deploy/docker-compose.yaml']);
  const appEnv = compose.services.app.environment;

  test(`${name}: toda variable que develop exige sin default llega a la app, y toda la que llega la lee el servidor`, () => {
    const { all, required } = variablesOf(go.files, 'develop');
    assert.deepEqual([...required].filter((variable) => !(variable in appEnv)), [], 'develop las exige y el compose no se las da: la app no arrancaría');
    assert.deepEqual(Object.keys(appEnv).filter((variable) => variable !== 'PROFILE' && !all.has(variable)), [], 'el compose las da y la configuración de develop no las lee');
  });

  test(`${name}: la infraestructura, el colector y el realm son los de keel-spring`, () => {
    const springFiles = plan(name, stack, planSpring).files;
    const spring = Object.fromEntries(springFiles.map((file) => [file.path, file.content]));
    const springCompose = parseYaml(spring['deploy/docker-compose.yaml']);
    for (const service of Object.keys(springCompose.services).filter((candidate) => candidate !== 'app')) {
      assert.deepEqual(compose.services[service], springCompose.services[service], service);
    }
    assert.deepEqual(Object.keys(compose.services).sort(), Object.keys(springCompose.services).sort());
    for (const file of Object.keys(spring).filter((candidate) => /^deploy\/(otel|keycloak)\//.test(candidate) && !candidate.endsWith('.gitkeep'))) {
      assert.equal(byPath[file]?.replaceAll('keel-go', 'keel-spring'), spring[file], file);
    }
  });
}

const product = Object.fromEntries(plan('product-catalog', { database: 'postgresql' }).files.map((file) => [file.path, file.content]));
const dockerfile = product['deploy/Dockerfile'];

test('la imagen compila sin cgo con el toolchain que se mide y corre sobre distroless sin root', () => {
  assert.ok(dockerfile.includes(`FROM docker.io/library/golang:${GO_TOOLCHAIN.replace(/^go/, '')} AS build`));
  assert.match(dockerfile, /CGO_ENABLED=0/);
  assert.match(dockerfile, /go build -trimpath -ldflags="-s -w" -o \/server \.\/cmd\/server/);
  assert.match(dockerfile, /^FROM gcr\.io\/distroless\/static:nonroot$/m);
  assert.doesNotMatch(dockerfile, /^RUN .*(?:curl|wget)/m);
});

test('el HEALTHCHECK es el subcomando del binario, en forma exec: la imagen no tiene shell', () => {
  assert.match(dockerfile, /HEALTHCHECK .*CMD \["\/server", "healthcheck"\]/);
  assert.match(dockerfile, /ENTRYPOINT \["\/server"\]/);
  assert.ok(product['cmd/server/main.go'].includes('args[0] == "healthcheck"'));
});

test('lo que copia la imagen existe, y el .dockerignore no lo tapa', () => {
  for (const [, from] of dockerfile.matchAll(/^COPY (?!--from)([^ \n]+(?: [^ \n]+)*) [^ \n]+$/gm)) {
    for (const source of from.split(' ')) {
      if (source === 'go.sum') continue; // lo escribe go mod tidy
      assert.ok(Object.keys(product).some((file) => file === source || file.startsWith(source)), source);
    }
  }
  for (const covered of ['cmd/', 'config/', 'internal/']) assert.ok(!product['.dockerignore'].split('\n').includes(covered), covered);
  for (const ignored of ['tests/', 'infra/', 'deploy/', 'docs/']) assert.ok(product['.dockerignore'].split('\n').includes(ignored), ignored);
});

test('los .sh llegan con LF también desde un checkout de Windows', () => {
  assert.match(product['.gitattributes'], /\*\.sh text eol=lf/);
});

test('el servidor valida el token por el JWKS interno, con la variable que lee', () => {
  const secured = Object.fromEntries(plan('profile-directory', { database: 'postgresql', auth: 'keycloak' }).files.map((file) => [file.path, file.content]));
  assert.match(secured['deploy/docker-compose.yaml'], /OAUTH2_JWK_SET_URI: http:\/\/keycloak:8080/);
  assert.match(secured['config/parameters/develop/security.yaml'], /OAUTH2_JWK_SET_URI/);
});

test('el README enseña deploy/ y dice que go.sum tiene que existir', () => {
  assert.match(product['README.md'], /bash deploy\/up\.sh/);
  assert.match(product['README.md'], /go mod tidy {2,}# la imagen copia go\.sum/);
});
