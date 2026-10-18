// El `deploy/` de keel-dotnet (incremento 14d): el neutral de keel-core con la plataforma de .NET.
//
// Lo que se afirma es lo que hace que `bash deploy/up.sh` levante el servicio y lo que hace que sea el MISMO stack que
// el de keel-spring y el de keel-nest:
//   · toda variable que el perfil develop exige SIN default llega al contenedor de la app (si no, no arranca);
//   · toda variable que el compose le da a la app la lee su configuración (una que nadie lee es una palanca muerta);
//   · los servicios de infraestructura, el colector y el realm son los de keel-spring byte a byte;
//   · la imagen: dos etapas, sin root, con su HEALTHCHECK sobre /readyz y dotnet como PID 1, y lo que copia existe.
// Que la imagen construya y el servicio arranque dentro lo mide deploy-check (incremento 14f).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
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
  const dotnet = plan(name, stack);
  const byPath = Object.fromEntries(dotnet.files.map((file) => [file.path, file.content]));
  const compose = parseYaml(byPath['deploy/docker-compose.yaml']);
  const appEnv = compose.services.app.environment;

  test(`${name}: toda variable que develop exige sin default llega a la app, y toda la que llega la lee el servidor`, () => {
    const { all, required } = variablesOf(dotnet.files, 'develop');
    const missing = [...required].filter((variable) => !(variable in appEnv));
    assert.deepEqual(missing, [], 'develop las exige y el compose no se las da: la app no arrancaría');
    const unread = Object.keys(appEnv).filter((variable) => variable !== 'PROFILE' && !all.has(variable));
    assert.deepEqual(unread, [], 'el compose las da y la configuración de develop no las lee');
    const env = byPath['deploy/.env'];
    for (const [variable, value] of Object.entries(appEnv)) {
      const reference = /^\$\{([A-Z0-9_]+)\}$/.exec(String(value));
      if (reference) assert.match(env, new RegExp(`^${reference[1]}=`, 'm'), `${variable} sin valor en deploy/.env`);
    }
  });

  test(`${name}: la infraestructura, el colector y el realm de deploy/ son los de keel-spring`, () => {
    const spring = Object.fromEntries(plan(name, stack, planSpring).files.map((file) => [file.path, file.content]));
    const springCompose = parseYaml(spring['deploy/docker-compose.yaml']);
    assert.deepEqual(Object.keys(compose.services).sort(), Object.keys(springCompose.services).sort());
    for (const service of Object.keys(compose.services).filter((key) => key !== 'app')) {
      assert.deepEqual(compose.services[service], springCompose.services[service], service);
    }
    assert.deepEqual(compose.volumes, springCompose.volumes);
    // La app: la misma base (el DB_URL de los tres servidores es intercambiable) y las mismas dependencias.
    assert.equal(appEnv.DB_URL, springCompose.services.app.environment.DB_URL);
    assert.deepEqual(compose.services.app.depends_on, springCompose.services.app.depends_on);
    const serviceName = dotnet.model.service.name;
    for (const file of ['deploy/otel/collector.yaml', 'deploy/keycloak/realm-export.json', 'deploy/down.sh'].filter((candidate) => candidate in spring)) {
      const neutral = (text) => text.replaceAll('keel-spring', 'keel-dotnet').replaceAll(`${serviceName}-spring`, `${serviceName}-dotnet`);
      assert.equal(byPath[file], neutral(spring[file]), file);
    }
  });
}

test('la imagen: dos etapas sobre las de .NET, sin root, HEALTHCHECK sobre /readyz y dotnet como PID 1', () => {
  const { files, model } = plan('product-catalog', { database: 'postgresql' });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const dockerfile = byPath['deploy/Dockerfile'];
  assert.deepEqual(dockerfile.match(/^FROM .*$/gm), ['FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build', 'FROM mcr.microsoft.com/dotnet/aspnet:10.0']);
  assert.match(dockerfile, /^RUN dotnet restore src\/ProductCatalog\.Api\/ProductCatalog\.Api\.csproj$/m);
  assert.match(dockerfile, /^RUN dotnet publish src\/ProductCatalog\.Api\/ProductCatalog\.Api\.csproj -c Release -o \/application --no-restore$/m);
  assert.match(dockerfile, /^USER \$APP_UID$/m);
  assert.match(dockerfile, /HEALTHCHECK [^\n]*\n\s+CMD bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/8080 && printf "GET \/readyz HTTP\/1\.0/);
  assert.match(dockerfile, /^ENTRYPOINT \["dotnet", "ProductCatalog\.Api\.dll"\]$/m);
  // Lo que el Dockerfile copia existe en el proyecto generado, y config/ viaja con la publicación.
  for (const file of ['global.json', 'Directory.Build.props', 'Directory.Packages.props', 'src/ProductCatalog.Api/ProductCatalog.Api.csproj']) assert.ok(file in byPath, file);
  assert.match(byPath['src/ProductCatalog.Api/ProductCatalog.Api.csproj'], /CopyToPublishDirectory="PreserveNewest"/);
  assert.match(byPath['.dockerignore'], /^\*\*\/bin\/$/m);
  assert.match(byPath['.gitattributes'], /^\*\.sh +text eol=lf$/m);
  assert.match(byPath['deploy/up.sh'], /READY_URL="http:\/\/localhost:\$\{APP_PORT:-8080\}\/readyz"/);
  assert.ok(files.find((file) => file.path === 'deploy/up.sh').executable);
  assert.equal(model.service.rootNamespace, 'ProductCatalog');
});

test('con un proveedor de identidad, la app valida por el JWKS interno (el emisor partido de deploy/)', () => {
  const { files, model } = plan('asset-vault', { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak', cache: 'redis', storage: 'minio' });
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const compose = parseYaml(byPath['deploy/docker-compose.yaml']);
  assert.equal(compose.services.app.environment.OAUTH2_JWK_SET_URI, `http://keycloak:8080/realms/${model.service.name}/protocol/openid-connect/certs`);
  assert.match(byPath['config/parameters/develop/security.yaml'], /jwk-set-uri: \$\{OAUTH2_JWK_SET_URI:\}/);
});

test('el README enseña deploy/: los dos scripts, las URLs que imprime up.sh y el environment de Postman', () => {
  const { files } = plan('catalog-extended', SUBJECTS[2][1]);
  const readme = files.find((file) => file.path === 'README.md').content;
  assert.match(readme, /bash deploy\/up\.sh/);
  assert.match(readme, /bash deploy\/down\.sh/);
  assert.match(readme, /<http:\/\/localhost:8080\/readyz>/);
  assert.match(readme, /<http:\/\/localhost:3001\/d\/keel-catalog>/, 'con telemetría, el panel');
  assert.ok(readme.includes(files.find((file) => file.path.endsWith('.postman_environment.json')).path));
});
