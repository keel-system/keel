// Amazon Cognito: qué genera build cuando `keel-stack.json` declara `auth: cognito`.
//
// La decisión de fondo que estas pruebas fijan: en local NO se levanta Cognito ni un
// emulador de su API, sino un servidor OAuth2 que emite tokens con la FORMA de los de
// Cognito. El servicio generado es un resource server puro —solo consume JWKS y
// claims—, así que emular el token cubre el diseño entero, mientras que emular la API
// de AWS (cognito-local, moto) deja fuera `client_credentials` y con él toda la
// superficie M2M.
//
// Lo que se prueba aquí es justamente lo que hace que local prediga producción: que el
// emulador emita las DOS rarezas de Cognito (scopes prefijados por el resource server y
// tokens de máquina sin `aud`) y que el código generado las absorba.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { AUTH } from '../src/lib/stack-catalog.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product-catalog');
const PROJECT = 'services/product-catalog-spring';
const JAVA = 'src/main/java/com/commerce/productcatalog';

/** El diseño de la fixture + una capa `security` con roles, scopes y superficie M2M. */
function securedFixture({ validateAudience = true } = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const patched = structuredClone(layers);
  patched.security = {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'client-credentials', validateAudience, description: 'Consumo máquina a máquina.' }
    },
    roles: {
      'catalog-admin': { description: 'Gestiona el catálogo.' },
      'catalog-reader': { description: 'Consulta el catálogo.' }
    },
    permissions: { 'product:write': { description: 'Escribir.' }, 'product:read': { description: 'Leer.' } },
    roleGrants: { 'catalog-admin': ['product:write', 'product:read'], 'catalog-reader': ['product:read'] },
    scopes: { 'product:read': { description: 'Lectura para clientes máquina.' } },
    serviceClients: { 'pricing-service': { description: 'Consulta fichas.', scopes: ['product:read'] } },
    access: {
      default: { level: 'required' },
      rules: {
        listProducts: { level: 'service', scopes: ['product:read'] },
        createProduct: { level: 'required', permissions: ['product:write'] }
      }
    }
  };
  return { manifest: patchedManifest, layers: patched };
}

function scaffoldCognito(options) {
  const workspace = tmpDir('keel-cognito-');
  scaffoldService({
    ...securedFixture(options),
    workspace,
    force: true,
    stack: { database: 'postgresql', broker: 'kafka', auth: 'cognito', cache: null, storage: null }
  });
  return {
    read: (relative) => fs.readFileSync(path.join(workspace, PROJECT, relative), 'utf8'),
    exists: (relative) => fs.existsSync(path.join(workspace, PROJECT, relative))
  };
}

test('cognito: el emulador emite tokens con la forma de Cognito, derivados del diseño', () => {
  const { read } = scaffoldCognito();
  const config = JSON.parse(read('infra/cognito/mock-oauth2-config.json'));

  // El issuerId es el nombre del servicio: por eso el issuer es DETERMINISTA y se puede
  // escribir en parameters/ al generar. Con un emulador de la API de Cognito sería un
  // id de user pool generado al crearlo, que nadie puede saber en tiempo de build.
  const [callback] = config.tokenCallbacks;
  assert.equal(callback.issuerId, 'product-catalog');

  const byMatch = Object.fromEntries(callback.requestMappings.map((m) => [m.match, m]));

  // Un usuario por rol, emparejado por `username` (el grant es ROPC, igual que con
  // Keycloak: por eso el arnés no necesita ninguna rama propia).
  assert.deepEqual(byMatch['catalog-admin'].claims['cognito:groups'], ['catalog-admin']);
  assert.equal(byMatch['catalog-admin'].requestParam, 'username');
  // Y uno SIN roles: «autenticado pero sin permiso» necesita un sujeto, o el 403 por
  // rol insuficiente no se puede escribir.
  assert.deepEqual(byMatch['no-role'].claims['cognito:groups'], []);

  // Clientes máquina: scopes PREFIJADOS por el resource server, que es como los emite
  // Cognito de verdad, y SIN `aud`, que es lo que sus tokens de client_credentials no
  // llevan. Un emulador más cómodo dejaría verde un servicio que en producción
  // devuelve 403 a todas las máquinas.
  const machine = byMatch['pricing-service'];
  assert.equal(machine.requestParam, 'client_id');
  assert.equal(machine.claims.scope, 'product-catalog/product:read');
  assert.equal(machine.claims.client_id, 'pricing-service');
  assert.ok(!('aud' in machine.claims), JSON.stringify(machine.claims));
});

test('cognito: la matriz M2M conserva su significado sin claim aud', () => {
  // Con Keycloak las variantes negativas se expresan con audiencias distintas. Sin
  // `aud`, lo que dice para qué API vale un permiso es el PREFIJO del scope, así que la
  // variante «audiencia ajena» se emite con otro resource server.
  const { read } = scaffoldCognito();
  const config = JSON.parse(read('infra/cognito/mock-oauth2-config.json'));
  const byMatch = Object.fromEntries(config.tokenCallbacks[0].requestMappings.map((m) => [m.match, m]));

  assert.equal(byMatch['test-m2m-ok'].claims.scope, 'product-catalog/product:read');
  assert.equal(byMatch['test-m2m-bad-aud'].claims.scope, 'audiencia-ajena/product:read');
  // Sin scopes no hay claim: su AUSENCIA es el control, y un claim vacío no
  // significaría lo mismo.
  assert.ok(!('scope' in byMatch['test-m2m-no-scope'].claims));
  assert.ok(!('scope' in byMatch['test-m2m-none'].claims));
});

test('cognito: el código generado absorbe las dos rarezas del proveedor', () => {
  const { read } = scaffoldCognito();

  // 1. El prefijo del resource server se corta antes de componer la authority: si no,
  //    `SCOPE_product-catalog/product:read` no casa con ningún matcher del diseño.
  const converter = read(`${JAVA}/infrastructure/configurations/security/JwtAuthConverter.java`);
  assert.ok(converter.includes(".map(scope -> scope.substring(scope.indexOf('/') + 1))"), converter);

  // 2. La audiencia se comprueba por el prefijo del scope, no por `aud`. Mirar `aud`
  //    daría 403 a TODOS los clientes máquina contra Cognito real.
  const filter = read(`${JAVA}/infrastructure/configurations/security/AudienceAuthorizationFilter.java`);
  assert.ok(filter.includes('private boolean issuedForUs(Jwt jwt)'), filter);
  assert.ok(filter.includes('String prefix = audience + "/";'), filter);
  assert.ok(!filter.includes('getAudience()'), filter);
  assert.ok(filter.includes('import org.springframework.security.oauth2.jwt.Jwt;'), filter);
});

test('cognito: con Keycloak el filtro sigue mirando aud (no se generaliza el cambio)', () => {
  // La otra mitad de la afirmación anterior: la semántica de Cognito es de Cognito. Con
  // Keycloak el token SÍ trae `aud`, y comprobar el prefijo del scope allí rechazaría
  // tokens correctos.
  const workspace = tmpDir('keel-keycloak-');
  scaffoldService({
    ...securedFixture(),
    workspace,
    force: true,
    stack: { database: 'postgresql', broker: 'kafka', auth: 'keycloak', cache: null, storage: null }
  });
  const filter = fs.readFileSync(
    path.join(workspace, PROJECT, `${JAVA}/infrastructure/configurations/security/AudienceAuthorizationFilter.java`),
    'utf8'
  );
  assert.ok(filter.includes('token.getToken().getAudience()'), filter);
  assert.ok(!filter.includes('issuedForUs'), filter);
});

test('cognito: el compose levanta el emulador con su config, y el issuer local apunta a él', () => {
  const { read } = scaffoldCognito();

  const compose = read('infra/docker-compose.yaml');
  assert.ok(compose.includes('cognito-mock:'), compose);
  assert.ok(compose.includes(AUTH.cognito.image), compose);
  assert.ok(compose.includes('JSON_CONFIG_PATH: /cognito/mock-oauth2-config.json'), compose);
  assert.ok(compose.includes('./cognito/mock-oauth2-config.json:/cognito/mock-oauth2-config.json:ro'), compose);

  // El issuer local es escribible en tiempo de build porque el issuerId lo elige el
  // diseño. Y el arnés pide el token por OAuth2 estándar: ninguna rama propia.
  assert.ok(
    read('src/main/resources/parameters/local/oauth2.yaml').includes('issuer-uri: http://localhost:9229/product-catalog')
  );
  const credentials = read('infra/test-credentials.env');
  assert.ok(credentials.includes('AUTH_TOKEN_URL=http://localhost:9229/product-catalog/token'), credentials);
  // Y NO se avisa de que «build no genera el aprovisionamiento»: con cognito sí lo genera.
  assert.ok(!credentials.includes('build no genera el script'), credentials);
});

test('cognito: deploy/ trae su copia del config y valida por jwk-set-uri', () => {
  // El issuer partido, igual que con Keycloak: la app alcanza el emulador por la red de
  // compose y el token dice `localhost`. Boot prioriza jwk-set-uri y ahí no valida `iss`.
  const { read } = scaffoldCognito();
  assert.ok(read('deploy/cognito/mock-oauth2-config.json').includes('"issuerId": "product-catalog"'));
  assert.ok(
    read('deploy/docker-compose.yaml').includes('http://cognito-mock:8080/product-catalog/jwks'),
    read('deploy/docker-compose.yaml')
  );
});
