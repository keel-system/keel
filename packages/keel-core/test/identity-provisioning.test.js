// El proveedor de identidad de prueba es neutral: lo escribe keel-core/gen/identity-provisioning.js
// para los dos generadores —el servicio de keel-spring y el de keel-nest del mismo diseño se prueban
// contra el MISMO realm—, y lo único que cambia entre ellos son los textos de la PLATAFORMA. Aquí se
// mide con una plataforma que no es la de ninguno: que cada texto llegue a su archivo y que no se
// cuele ninguno de otro generador.

import test from 'node:test';
import assert from 'node:assert/strict';
import { identityProvisioningFiles } from '../src/lib/gen/identity-provisioning.js';

const PROBE = { generator: 'keel-probe', identity: { harness: 'PROBE-HARNESS', skill: 'keel-probe-keycloak' } };

function modelFor(auth, security = {}) {
  return {
    service: { name: 'ticket-desk', projectName: 'ticket-desk-probe', artifactId: 'ticket-desk' },
    layersPresent: { security: true },
    stack: { auth },
    security: {
      protocol: 'oidc',
      roles: ['agent'],
      scopes: ['ticket:read'],
      serviceAuth: { protocol: 'client-credentials', validateAudience: true, audience: null },
      serviceClients: [{ name: 'billing', scopes: ['ticket:read'] }],
      scoping: { claim: 'desks', over: 'Desk.code', error: 'DESK_FORBIDDEN', exemptRoles: [], testResource: 'billing' },
      callerIdentity: { field: 'callerSubject', source: 'claim', claim: 'sub', resolvedBy: null },
      ...security
    }
  };
}

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file.content]));
const FOREIGN = /keel-spring|keel-nest|AbstractFlowIT|flow\.ts|gradlew|vitest/i;

test('con Keycloak: el script y las credenciales llevan los textos de la plataforma, y ningún otro', () => {
  const files = byPath(identityProvisioningFiles(modelFor('keycloak'), PROBE));
  assert.deepEqual(Object.keys(files).sort(), ['infra/init-keycloak.sh', 'infra/test-credentials.env']);
  assert.match(files['infra/init-keycloak.sh'], /por keel-probe build a partir de specs\/security\.keel\.yaml/);
  assert.match(files['infra/init-keycloak.sh'], /entrega a PROBE-HARNESS, y por eso/);
  assert.match(files['infra/init-keycloak.sh'], /references\/test-clients\.md de la skill keel-probe-keycloak/);
  assert.match(files['infra/test-credentials.env'], /# PROBE-HARNESS \(quien las consume\)/);
  // La persona del claim sub y el titular con otro valor del claim del alcance: el arnés de la plataforma los da
  // de alta por la API de administración, con las credenciales del contenedor.
  assert.match(files['infra/test-credentials.env'], /tokenAs\(sub, claims\) y tokenWithScope\(rol, valores\) de PROBE-HARNESS/);
  assert.match(files['infra/test-credentials.env'], /^AUTH_ADMIN_USER=/m);
  assert.match(files['infra/test-credentials.env'], /^AUTH_TEST_CLIENT=ticket-desk-probe-test$/m);
  for (const [file, content] of Object.entries(files)) assert.doesNotMatch(content, FOREIGN, file);
});

// conduit (recuperado de RealWorld): sin roles, con la identidad en el `sub` y dos personas por escenario («solo el
// autor edita su artículo»). Hasta el DSL 2.23 el realm salía sin cliente de usuario —así que sin `tokenAs`— y el
// agente de pruebas del inc. 1 de keel-recover escribió su propio emisor de personas.
test('sin roles y con la identidad en el sub: cliente de usuario y personas, sin usuarios fijos', () => {
  const sinRoles = { roles: [], scopes: [], serviceAuth: undefined, serviceClients: [], scoping: undefined };
  const files = byPath(identityProvisioningFiles(modelFor('keycloak', sinRoles), PROBE));
  const script = files['infra/init-keycloak.sh'];
  assert.match(files['infra/test-credentials.env'], /^AUTH_TEST_CLIENT=ticket-desk-probe-test$/m);
  assert.match(files['infra/test-credentials.env'], /tokenAs\(sub, claims\) de PROBE-HARNESS/);
  assert.match(script, /^USER_CLIENT=ticket-desk-probe-test /m);
  assert.match(script, /create clients -r \$REALM -s clientId=\$USER_CLIENT/);
  assert.doesNotMatch(script, /create users/, 'las personas las da de alta el arnés, no el script');
  // Sin la identidad en el sub no hay personas: el realm sigue sin cliente de usuario.
  const sinPersonas = byPath(identityProvisioningFiles(modelFor('keycloak', { ...sinRoles, callerIdentity: undefined }), PROBE));
  assert.doesNotMatch(sinPersonas['infra/test-credentials.env'], /AUTH_TEST_CLIENT/);
  assert.doesNotMatch(sinPersonas['infra/init-keycloak.sh'], /USER_CLIENT/);
});

// shop-api (recuperado de un legacy que identificaba por email): la identidad es el claim `email` y los escenarios
// nombran a sus actores por ese valor. Con los usuarios del realm (`<rol>@example.com`) no había forma de pedir el token
// de `customer1@email.com`, ni uno sin email: la corrida de control dejó así 12 escenarios sin token.
test('con la identidad en otro claim (email) también hay personas: el escenario pide el valor que nombra', () => {
  const files = byPath(identityProvisioningFiles(modelFor('keycloak', { callerIdentity: { field: 'callerEmail', source: 'claim', claim: 'email', resolvedBy: null } }), PROBE));
  assert.match(files['infra/test-credentials.env'], /tokenAs\(sub, claims\) y tokenWithScope\(rol, valores\) de PROBE-HARNESS/);
  assert.match(files['infra/test-credentials.env'], /^AUTH_ADMIN_USER=/m);
  // Sin identidad por claim (un servicio que solo atiende a clientes máquina) sigue sin personas.
  const machine = byPath(identityProvisioningFiles(modelFor('keycloak', { callerIdentity: { field: 'app', source: 'serviceClient', resolvedBy: null }, scoping: undefined }), PROBE));
  assert.doesNotMatch(machine['infra/test-credentials.env'], /tokenAs/);
});

test('con Cognito: credenciales y emulador, sin script de kcadm', () => {
  const files = byPath(identityProvisioningFiles(modelFor('cognito'), PROBE));
  assert.deepEqual(Object.keys(files).sort(), ['infra/cognito/mock-oauth2-config.json', 'infra/test-credentials.env']);
  const config = JSON.parse(files['infra/cognito/mock-oauth2-config.json']);
  assert.equal(config.tokenCallbacks[0].issuerId, 'ticket-desk');
  for (const [file, content] of Object.entries(files)) assert.doesNotMatch(content, FOREIGN, file);
});

// Con Cognito ningún usuario llevaba el claim del alcance: el emulador emitía sub, grupos y cliente, y un diseño
// con `scoping` no tenía titular acotado que probar. Ahora lleva el mismo valor que el realm de Keycloak, solo en
// los no exentos, y validate-infra lo comprueba contra el emulador igual que contra Keycloak.
test('con Cognito: el emulador pone el claim del alcance en los no exentos, y validate-infra lo comprueba', async () => {
  const exempt = modelFor('cognito', { roles: ['agent', 'supervisor'], scoping: { claim: 'desks', over: 'Desk.code', error: 'DESK_FORBIDDEN', exemptRoles: ['supervisor'], testResource: 'billing' } });
  const config = JSON.parse(byPath(identityProvisioningFiles(exempt, PROBE))['infra/cognito/mock-oauth2-config.json']);
  const claimsOf = (username) => config.tokenCallbacks[0].requestMappings.find((m) => m.requestParam === 'username' && m.match === username)?.claims;
  assert.deepEqual(claimsOf('agent').desks, ['billing']);
  assert.deepEqual(claimsOf('agent-2').desks, ['billing']);
  assert.equal(claimsOf('supervisor').desks, undefined, 'un rol exento no lleva el claim');
  assert.equal(claimsOf('no-role').desks, undefined);

  const { scopingClaimChecks } = await import('../src/lib/gen/identity-realm.js');
  const checks = scopingClaimChecks({ ...exempt, layersPresent: { security: true } });
  assert.deepEqual(checks.map((check) => check.label), [
    "Claim 'desks' en el token de agent (cognito)",
    "Claim 'desks' en el token de agent-2 (cognito)"
  ]);
  assert.match(checks[0].cmd, /http:\/\/cognito-mock:8080\/ticket-desk\/token/);
  // El emulador responde el JSON formateado en varias líneas: la extracción lo aplana y admite espacios
  // (medido contra mock-oauth2-server 6.0.1; con el sed de Keycloak no casaba).
  assert.ok(checks[0].cmd.includes(`tr -d '\\n\\r' | sed 's/.*"access_token" *: *"`), checks[0].cmd);
  assert.ok(checks[0].cmd.includes(`grep -qF '"desks":["billing"]'`), checks[0].cmd);
});

// Incremento 4.1 de PLAN-PROVEEDOR-IDENTIDAD.md: el emulador escondía D3 a D6 porque ponía `client_id` igual al nombre
// del cliente y el nombre del usuario como `sub`. Ahora el id es opaco y el MISMO en el emulador, en las credenciales que
// manda el arnés y en el perfil local del servicio; con el nombre, el servidor no traduciría nada y saldría verde igual.
test('4.1: con Cognito el emulador emite un client_id opaco, el mismo que manda el arnés y que traduce el servicio', async () => {
  const { credentialClientId } = await import('../src/lib/gen/identity-providers.js');
  const model = modelFor('cognito', { scoping: { claim: 'desks', over: 'Desk.code', error: 'DESK_FORBIDDEN', exemptRoles: [], exemptClients: ['billing'], testResource: 'billing' } });
  const files = byPath(identityProvisioningFiles(model, PROBE));
  const mappings = JSON.parse(files['infra/cognito/mock-oauth2-config.json']).tokenCallbacks[0].requestMappings;
  const machines = mappings.filter((mapping) => mapping.requestParam === 'client_id');
  assert.deepEqual(machines.map((mapping) => mapping.match), ['billing', 'test-m2m-ok', 'test-m2m-no-scope', 'test-m2m-bad-aud', 'test-m2m-none'].map((name) => credentialClientId('cognito', name)));
  for (const { match, claims } of machines) {
    assert.match(match, /^[a-z0-9]{26}$/, 'con la forma de un app client de Cognito');
    assert.equal(claims.client_id, match);
    assert.equal(claims.sub, match, 'el sub de un token de máquina es el id del cliente');
  }
  const billing = credentialClientId('cognito', 'billing');
  assert.notEqual(billing, 'billing');
  // El arnés manda el id de test-credentials.env; el perfil local del servicio lo traduce con el mismo
  // credentialClientId (security-config.test.js).
  assert.match(files['infra/test-credentials.env'], new RegExp(`^AUTH_CLIENT_ID_BILLING=${billing}$`, 'm'));
  assert.match(files['infra/test-credentials.env'], new RegExp(`^AUTH_CLIENT_ID_TEST_M2M_OK=${credentialClientId('cognito', 'test-m2m-ok')}$`, 'm'));
  // El token de usuario lleva el id del cliente de usuario, el mismo que el arnés manda.
  const user = mappings.find((mapping) => mapping.requestParam === 'username');
  assert.match(files['infra/test-credentials.env'], new RegExp(`^AUTH_TEST_CLIENT=${user.claims.client_id}$`, 'm'));
  assert.notEqual(user.claims.client_id, 'ticket-desk-probe-test');

  // Con Keycloak nada de esto cambia: el id es el nombre y no hay AUTH_CLIENT_ID_*.
  const keycloak = byPath(identityProvisioningFiles(modelFor('keycloak'), PROBE));
  assert.doesNotMatch(keycloak['infra/test-credentials.env'], /AUTH_CLIENT_ID_/);
});

test('4.1 (T2): el sub de un usuario en el emulador es un uuid determinista, no su nombre', () => {
  const read = () => JSON.parse(byPath(identityProvisioningFiles(modelFor('cognito'), PROBE))['infra/cognito/mock-oauth2-config.json']).tokenCallbacks[0].requestMappings;
  const users = read().filter((mapping) => mapping.requestParam === 'username');
  const subs = users.map((user) => user.claims.sub);
  for (const [i, user] of users.entries()) {
    assert.match(subs[i], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(user.claims.username, user.match, 'el principal sigue siendo el nombre del usuario');
  }
  assert.equal(new Set(subs).size, subs.length, 'dos usuarios no comparten sub');
  assert.deepEqual(read().filter((mapping) => mapping.requestParam === 'username').map((user) => user.claims.sub), subs, 'determinista');
});

// P3: Cognito no pone `email` en el access token. El emulador tampoco, salvo que el diseño lo lea: entonces representa
// un pool con el disparador desplegado (y check/build ya avisan de que hace falta).
test('4.1 (P3): el emulador pone el claim de la identidad solo si el diseño lo lee y el proveedor no lo da de serie', () => {
  const claimsOf = (security) =>
    JSON.parse(byPath(identityProvisioningFiles(modelFor('cognito', security), PROBE))['infra/cognito/mock-oauth2-config.json']).tokenCallbacks[0].requestMappings.find(
      (mapping) => mapping.requestParam === 'username' && mapping.match === 'agent'
    ).claims;
  const byEmail = { claimDemands: [{ id: 'caller-identity', claim: 'email', holder: 'user' }] };
  assert.equal(claimsOf(byEmail).email, 'agent@example.com', 'el correo con el que Keycloak da de alta al usuario');
  assert.equal(claimsOf({}).email, undefined, 'sin exigencia, como el token real');
});

test('sin protocolo de token no hay proveedor que aprovisionar', () => {
  assert.deepEqual(identityProvisioningFiles(modelFor('keycloak', { protocol: 'api-key' }), PROBE), []);
  assert.deepEqual(identityProvisioningFiles({ ...modelFor('keycloak'), layersPresent: {} }, PROBE), []);
});
