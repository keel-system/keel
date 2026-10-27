// La seguridad de keel-dotnet (incremento 8) sobre el texto emitido: qué se emite y dónde, el cableado de la entrada
// HTTP, la identidad del llamante que no viaja en la petición, el alcance por recurso y la configuración, que tiene que
// ser la MISMA que la de keel-nest (mismas claves, variables y gradiente). Lo que ejecuta el C# —el 401 antes de
// enrutar, el token caducado o firmado con otra clave, el 403 de una regla— lo mide la prueba emitida ApiTests en
// `npm run cs-check`; las reglas, `security-parity.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';
import { FIXTURES_DIR, planFixture } from './helpers/workspace.js';

const plan = (name, auth = 'keycloak') => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } });
};
const content = (files, suffix) => files.find((file) => file.path.endsWith(suffix))?.content;

test('profile-directory: el principal, las reglas, el autenticador JWT, la identidad del llamante y el middleware', () => {
  const { files } = plan('profile-directory');
  for (const name of ['SecurityContext', 'AccessRules', 'JwtAuthenticator', 'CallerIdentity', 'SecurityRegistration']) {
    assert.ok(content(files, `/ProfileDirectory.Infrastructure/Security/${name}.cs`), name);
  }
  assert.ok(content(files, '/ProfileDirectory.Api/Rest/HttpSecurityMiddleware.cs'));
  // Sin clave de API, sin CORS y sin alcance en el diseño: no se emiten.
  for (const name of ['ApiKeyAuthenticator', 'CorsPolicy', 'JwtCallerScope']) assert.equal(content(files, `/${name}.cs`), undefined, name);
  assert.match(content(files, 'Directory.Packages.props'), /Microsoft\.IdentityModel\.JsonWebTokens" Version="8\.23\.0"/);
});

test('el middleware va detrás de la correlación y de los errores, y delante de las rutas', () => {
  const program = content(plan('profile-directory').files, '/Program.cs');
  const order = ['UseMiddleware<CorrelationMiddleware>', 'UseMiddleware<ApiErrorMiddleware>', 'UseMiddleware<HttpSecurityMiddleware>', 'MapApiRoutes'].map((marker) =>
    program.indexOf(marker)
  );
  assert.ok(order.every((index) => index >= 0), order.join(','));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(program, /builder\.Services\.AddHttpSecurity\(configuration\);/);
});

test('el middleware decide con la plantilla de la ruta que casó y deja el principal abierto para la petición', () => {
  const middleware = content(plan('profile-directory').files, '/HttpSecurityMiddleware.cs');
  assert.match(middleware, /\(context\.GetEndpoint\(\) as RouteEndpoint\)\?\.RoutePattern\.RawText/);
  assert.match(middleware, /using \(SecurityContext\.Open\(principal\)\)/);
  assert.match(middleware, /catch \(InvalidCredentialException\)/);
  assert.match(middleware, /"UNAUTHENTICATED", "Credenciales ausentes o no válidas"/);
  assert.match(middleware, /"ACCESS_DENIED", "La credencial no autoriza esta operación"/);
});

test('la identidad del llamante la estampa el lector desde la credencial: no se lee de la petición ni viaja en la query', () => {
  const { files } = plan('profile-directory');
  const endpoints = content(files, '/ContactCardV1Endpoints.cs');
  assert.equal((endpoints.match(/CallerSubject = CallerIdentity\.Resolve\(\),/g) ?? []).length, 2);
  assert.doesNotMatch(endpoints, /"callerSubject"/);
  const routes = content(files, '/ApiRoutes.cs');
  assert.doesNotMatch(routes, /callerSubject/);
  assert.match(content(files, '/CallerIdentity.cs'), /ClaimValues\.Text\(principal\.Claims, "sub"\)/);
  assert.match(content(files, '/GetMyCardQuery.cs'), /lo estampa el lector del endpoint con CallerIdentity\.Resolve\(\)/);
});

test('el alcance por recurso: el puerto en Application, el adaptador en Infrastructure y el handler que declara su error lo recibe', async () => {
  const { model, files } = await planFixture('asset-vault', { mutate: () => {} });
  const scoping = model.security.scoping;
  assert.match(content(files, '/AssetVault.Application/Support/ICallerScope.cs'), /bool Covers\(string\? value\) => IsExempt\(\)/);
  assert.match(content(files, '/AssetVault.Infrastructure/Security/JwtCallerScope.cs'), new RegExp(`ScopingClaim = "${scoping.claim}"`));
  const scoped = model.services.flatMap((service) => service.operations).filter((op) => (op.errors ?? []).includes(scoping.error));
  assert.ok(scoped.length > 0);
  for (const operation of scoped) {
    const handler = content(files, `/${operation.handlerClass}.cs`);
    assert.match(handler, /private readonly ICallerScope callerScope = callerScope;/, operation.name);
    assert.match(handler, /callerScope\.Covers\(/, operation.name);
  }
  // La prueba del cableado registra el alcance con el registro real, sin la entrada HTTP.
  assert.match(content(files, '/UseCasesTests.cs'), /services\.AddCallerScope\(\);/);
});

test('sin capa security no se emite nada de seguridad', () => {
  const { files } = plan('product-catalog');
  assert.equal(files.filter((file) => /\/Security\/|HttpSecurityMiddleware|TestCredential|security\.yaml/.test(file.path)).length, 0);
  assert.doesNotMatch(content(files, '/Program.cs'), /Security/);
  assert.doesNotMatch(content(files, 'Directory.Packages.props'), /IdentityModel/);
});

test('las pruebas emitidas firman con su propia clave: el perfil test publica su JWKS y no hay ninguna clave en el repo', () => {
  const { files } = plan('profile-directory');
  assert.match(content(files, '/InMemoryServer.cs'), /SetEnvironmentVariable\("SECURITY_TEST_JWKS", TestCredential\.Jwks\)/);
  const credential = content(files, '/TestCredential.cs');
  assert.match(credential, /RSA\.Create\(2048\)/);
  assert.doesNotMatch(credential, /BEGIN|PRIVATE KEY/);
  assert.match(content(files, 'config/parameters/test/security.yaml'), /jwks: \$\{SECURITY_TEST_JWKS:\}/);
  const api = content(files, '/ApiTests.cs');
  for (const name of ['SinCredencialUnCaminoProtegidoEs401ExistaONo', 'UnTokenQueNoValidaEs401TambienEnUnaRutaAbierta', 'UnTokenCaducadoEs401', 'UnTokenFirmadoConOtraClaveEs401', 'UnaCredencialValidaSinLoQueExigeLaReglaEs403']) {
    assert.match(api, new RegExp(`public async Task ${name}\\(`), name);
  }
});

// La configuración: las dos imágenes del mismo diseño se despliegan con las mismas variables.
const secured = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'security.keel.yaml')));
for (const name of secured) {
  for (const auth of ['keycloak', 'cognito']) {
    test(`${name} (${auth}): los security.yaml de cada perfil son los de keel-nest`, () => {
      const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
      const pick = (files) => Object.fromEntries(files.filter((file) => /^config\/parameters\/\w+\/security\.yaml$/.test(file.path)).map((file) => [file.path, file.content]));
      const nest = pick(planNest({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      const dotnet = pick(planService({ manifest, layers, workspace: FIXTURES_DIR, stack: { auth } }).files);
      assert.deepEqual(dotnet, nest);
    });
  }
}

test('la frontera: la capa entra, también con resolvedBy (12e); un campo de identidad que no es texto se rechaza con su motivo', () => {
  const manifest = { layers: { domain: 'd', 'use-cases': 'u', security: 's' } };
  const layersWith = (callerIdentity, type = 'string') => ({
    security: { authentication: { callerIdentity } },
    'use-cases': { operations: { getMine: { input: { fields: { caller: { type } } } } } }
  });
  assert.deepEqual(checkSupportedFeatures(manifest, layersWith({ field: 'caller', from: { source: 'claim' } })).errors, []);
  assert.deepEqual(checkSupportedFeatures(manifest, layersWith({ field: 'caller', from: { source: 'serviceClient', resolvedBy: 'Application.keys' } })).errors, []);
  const typed = checkSupportedFeatures(manifest, layersWith({ field: 'caller', from: { source: 'claim' } }, 'uuid')).errors;
  assert.equal(typed.length, 1);
  assert.match(typed[0], /use-cases\.getMine\.input\.caller: uuid .*string/);
});

// ─── El arnés de identidad (8b) ───────────────────────────────────────────────

const flowTest = (files) => content(files, '/Support/FlowTest.cs');

test('el arnés: credenciales del proveedor de prueba, solo lo que el diseño hace posible', () => {
  const vault = plan('asset-vault').files;
  assert.match(content(vault, '/Support/Credentials.cs'), /Path\.Combine\(Harness\.Root, "infra", "test-credentials\.env"\)/);
  for (const member of ['Bearer', 'TokenFor', 'ServiceCredential', 'ScopedResource', 'TokenWithScope']) {
    assert.match(flowTest(vault), new RegExp(`protected static [^\\n]* ${member}\\(`), member);
  }
  // asset-vault no identifica al llamante por `sub`: sin personas.
  assert.doesNotMatch(flowTest(vault), / TokenAs\(/);
  const cards = plan('profile-directory').files;
  assert.match(flowTest(cards), /protected static Task<string> TokenAs\(string sub/);
  assert.doesNotMatch(flowTest(cards), / ScopedResource\(/);
  // Con Cognito no hay personas ni usuarios del alcance: el emulador fija los claims en su configuración.
  assert.doesNotMatch(flowTest(plan('asset-vault', 'cognito').files), / TokenWithScope\(| TokenAs\(/);
  // Sin capa security, nada.
  const catalog = plan('product-catalog').files;
  assert.equal(content(catalog, '/Support/Credentials.cs'), undefined);
  assert.doesNotMatch(flowTest(catalog), /Bearer|TokenFor/);
});

test('el humo llama con la credencial que satisface el cierre (keel-core) y comprueba que el proveedor emite', () => {
  const smoke = content(plan('asset-vault').files, '/HarnessSmoke.cs');
  assert.match(smoke, /Dictionary<string, string> headers = Bearer\(await TokenFor\("vault-admin"\)\);/);
  assert.match(smoke, /\[Scenario\("SMOKE-5: el proveedor de identidad emite credenciales"\)\]/);
  assert.match(smoke, /await ServiceCredential\("rendering-service"\)/);
});

test('infra/ siembra el proveedor de identidad: el realm con Keycloak y el emulador con Cognito', () => {
  const keycloak = plan('profile-directory').files;
  assert.ok(content(keycloak, 'infra/init-keycloak.sh'));
  assert.match(content(keycloak, 'infra/test-credentials.env'), /AUTH_TEST_CLIENT=profile-directory-dotnet-test/);
  assert.match(content(keycloak, 'infra/test-credentials.env'), /Support\/Credentials\.cs/);
  const cognito = plan('profile-directory', 'cognito').files;
  assert.ok(content(cognito, 'infra/cognito/mock-oauth2-config.json'));
  assert.equal(content(cognito, 'infra/init-keycloak.sh'), undefined);
});

test('la skill del proveedor se instala con su stack, en cada harness', () => {
  const skills = (files) => [...new Set(files.map((file) => /\/skills\/(keel-dotnet-[\w-]+)\//.exec(file.path)?.[1]).filter(Boolean))].sort();
  assert.deepEqual(skills(plan('profile-directory').files), ['keel-dotnet-database', 'keel-dotnet-keycloak']);
  assert.deepEqual(skills(plan('profile-directory', 'cognito').files), ['keel-dotnet-cognito', 'keel-dotnet-database']);
  assert.deepEqual(skills(plan('product-catalog').files), ['keel-dotnet-database']);
});
