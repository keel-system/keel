// La seguridad de keel-go (incremento 8) sobre el texto emitido: qué se emite y dónde, el cableado de la entrada HTTP,
// la identidad del llamante que no viaja en la petición, los roles exentos de una regla de propiedad y la
// configuración, que tiene que ser la MISMA que la de keel-nest y keel-dotnet (mismas claves, variables y gradiente).
// Lo que ejecuta el Go —el 401 antes de enrutar, el token caducado o firmado con otra clave, el 403 de una regla, el
// token sin la identidad— lo miden las pruebas emitidas de internal/httpapi en `npm run go-check`; las reglas,
// `security-parity.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const plan = (name, auth = 'keycloak') => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
};
const content = (files, file) => files.find((candidate) => candidate.path === file)?.content;

test('profile-directory: el principal, el JWT, el emisor de las pruebas y el middleware; sin CORS ni roles', () => {
  const { files } = plan('profile-directory');
  for (const file of [
    'internal/platform/security/principal.go',
    'internal/platform/security/jwt.go',
    'internal/platform/security/securitytest/securitytest.go',
    'internal/httpapi/security.go'
  ]) {
    assert.ok(content(files, file), file);
  }
  assert.equal(content(files, 'internal/platform/security/cors.go'), undefined);
  assert.equal(content(files, 'internal/application/caller_roles.go'), undefined);
  assert.match(content(files, 'go.mod'), /\tgithub\.com\/golang-jwt\/jwt\/v5 v5\.3\.1\n/);
  // Keycloak: los roles en realm_access.roles y el nombre en preferred_username; los permisos que otorga cada rol.
  const jwt = content(files, 'internal/platform/security/jwt.go');
  assert.match(jwt, /claims\["realm_access"\]/);
  assert.match(jwt, /"card-holder": \{"card:self"\}/);
  // Cognito: grupos planos y el prefijo del resource server fuera del scope.
  const cognito = content(plan('profile-directory', 'cognito').files, 'internal/platform/security/jwt.go');
  assert.match(cognito, /ClaimList\(claims, "cognito:groups"\)/);
  assert.match(cognito, /strings\.Cut\(value, "\/"\)/);
});

test('la seguridad va detrás del borde y delante del enrutador, y decide con el patrón que casaría', () => {
  const { files } = plan('profile-directory');
  assert.match(content(files, 'internal/httpapi/server.go'), /return a\.edge\(a\.secure\(mux\)\)/);
  const security = content(files, 'internal/httpapi/security.go');
  assert.match(security, /_, pattern := next\.Handler\(r\)/);
  assert.match(security, /security\.WithPrincipal\(r\.Context\(\), principal\)/);
  assert.match(security, /errors\.Is\(err, security\.ErrInvalidCredential\)/);
  assert.match(security, /"Unauthorized", new\(unauthenticatedCode\), "Credenciales ausentes o no válidas"/);
  assert.match(security, /"Forbidden", new\(accessDeniedCode\), "La credencial no autoriza esta operación"/);
  // El arranque lee la configuración de la seguridad y la pasa a la entrada HTTP.
  assert.match(content(files, 'cmd/server/main.go'), /httpapi\.NewHandler\(probes, useCases, logger, security\.SettingsFrom\(cfg\)\)/);
});

test('la identidad del llamante la estampa el lector desde la credencial: no se lee de la petición ni viaja en la query', () => {
  const { files } = plan('profile-directory');
  const endpoints = files.filter((file) => file.path.endsWith('_endpoints.go')).map((file) => file.content).join('\n');
  assert.equal((endpoints.match(/msg\.CallerSubject, err = callerIdentity\(r\.Context\(\)\)/g) ?? []).length, 2);
  assert.doesNotMatch(endpoints, /member\(fields, "callerSubject"/);
  assert.doesNotMatch(content(files, 'internal/httpapi/routes.go'), /callerSubject/);
  assert.match(content(files, 'internal/httpapi/security.go'), /security\.ClaimText\(principal\.Claims, "sub"\)/);
  // Un token válido sin la identidad es un 401, no un 500.
  assert.match(content(files, 'internal/httpapi/errors.go'), /case errors\.Is\(err, errUnidentifiedCaller\):/);
  assert.match(content(files, 'internal/application/get_my_card_query.go'), /lo estampa el lector del endpoint/);
});

test('shop-api: los roles exentos de una regla de propiedad llegan al handler por un puerto, y la nota dice cómo usarlo', () => {
  const { files } = plan('shop-api');
  assert.match(content(files, 'internal/application/caller_roles.go'), /HasRole\(ctx context\.Context, role string\) bool/);
  assert.match(content(files, 'internal/platform/security/principal.go'), /func \(CallerRoles\) HasRole/);
  assert.match(content(files, 'cmd/server/main.go'), /CallerRoles: +security\.CallerRoles\{\},/);
  const handler = content(files, 'internal/application/get_order_query_handler.go');
  assert.match(handler, /callerRoles CallerRoles/);
  assert.match(handler, /h\.callerRoles\.HasRole\(ctx, "employee"\) \|\| h\.callerRoles\.HasRole\(ctx, "manager"\)/);
  assert.match(handler, /ORDER_NOT_OWNED \(403\)/);
  // Una operación sin exentos no lo recibe.
  assert.doesNotMatch(content(files, 'internal/application/get_profile_query_handler.go'), /callerRoles/);
  // CORS con la semántica del DefaultCorsProcessor, antes de autenticar.
  assert.ok(content(files, 'internal/platform/security/cors.go'));
  assert.match(content(files, 'internal/httpapi/security.go'), /switch a\.cors\.Apply\(w, r\)/);
});

test('protocol: none sin CORS no emite nada de seguridad; sin capa security, tampoco', () => {
  for (const name of ['job-dispatch-cycles', 'product-catalog']) {
    const { files } = plan(name);
    assert.equal(files.filter((file) => /platform\/security|httpapi\/security\.go|security\.yaml/.test(file.path)).length, 0, name);
    assert.doesNotMatch(content(files, 'go.mod'), /golang-jwt/, name);
    assert.doesNotMatch(content(files, 'internal/httpapi/server.go'), /secure|security/, name);
  }
});

test('las pruebas emitidas firman con su propia clave: el perfil test publica su JWKS y no hay ninguna clave en el repo', () => {
  const { files } = plan('profile-directory');
  const issuer = content(files, 'internal/platform/security/securitytest/securitytest.go');
  assert.match(issuer, /rsa\.GenerateKey\(rand\.Reader, 2048\)/);
  assert.doesNotMatch(issuer, /BEGIN|PRIVATE KEY/);
  assert.match(content(files, 'config/parameters/test/security.yaml'), /jwks: \$\{SECURITY_TEST_JWKS:\}/);
  const api = content(files, 'internal/httpapi/api_test.go');
  assert.match(api, /security\.Settings\{JWKS: jwks\(t\)\}/);
  for (const name of [
    'TestSinCredencialUnCaminoProtegidoEs401ExistaONo',
    'TestUnTokenQueNoValidaEs401TambienEnUnaRutaAbierta',
    'TestUnTokenCaducadoEs401',
    'TestUnTokenFirmadoConOtraClaveEs401',
    'TestUnaCredencialValidaSinLoQueExigeLaReglaEs403',
    'TestUnTokenSinLaIdentidadDelLlamanteEs401'
  ]) {
    assert.match(api, new RegExp(`func ${name}\\(t \\*testing\\.T\\)`), name);
  }
  // Un camino que no existe es 401 sin credencial, también en la prueba del arranque.
  assert.match(content(files, 'cmd/server/main_test.go'), /code != http\.StatusUnauthorized/);
});

// La configuración: las imágenes del mismo diseño se despliegan con las mismas variables.
const secured = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'security.keel.yaml')));
for (const name of secured) {
  for (const auth of ['keycloak', 'cognito']) {
    test(`${name} (${auth}): los security.yaml de cada perfil son los de keel-nest`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const pick = (files) => Object.fromEntries(files.filter((file) => /^config\/parameters\/\w+\/security\.yaml$/.test(file.path)).map((file) => [file.path, file.content]));
      const nest = pick(planNest({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      assert.deepEqual(pick(planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files), nest);
    });
  }
}
