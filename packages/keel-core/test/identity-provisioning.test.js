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
  // La persona del claim sub: el arnés de la plataforma la da de alta por la API de administración.
  assert.match(files['infra/test-credentials.env'], /tokenAs\(sub, claims\) de PROBE-HARNESS/);
  assert.match(files['infra/test-credentials.env'], /^AUTH_TEST_CLIENT=ticket-desk-probe-test$/m);
  for (const [file, content] of Object.entries(files)) assert.doesNotMatch(content, FOREIGN, file);
});

test('con Cognito: credenciales y emulador, sin script de kcadm', () => {
  const files = byPath(identityProvisioningFiles(modelFor('cognito'), PROBE));
  assert.deepEqual(Object.keys(files).sort(), ['infra/cognito/mock-oauth2-config.json', 'infra/test-credentials.env']);
  const config = JSON.parse(files['infra/cognito/mock-oauth2-config.json']);
  assert.equal(config.tokenCallbacks[0].issuerId, 'ticket-desk');
  for (const [file, content] of Object.entries(files)) assert.doesNotMatch(content, FOREIGN, file);
});

test('sin protocolo de token no hay proveedor que aprovisionar', () => {
  assert.deepEqual(identityProvisioningFiles(modelFor('keycloak', { protocol: 'api-key' }), PROBE), []);
  assert.deepEqual(identityProvisioningFiles({ ...modelFor('keycloak'), layersPresent: {} }, PROBE), []);
});
