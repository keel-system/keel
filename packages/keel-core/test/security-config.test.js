// Los parámetros del proveedor en el fragmento de seguridad (fase 2 de PLAN-PROVEEDOR-IDENTIDAD.md): qué clientes se
// traducen (P1, P2) y cuándo el servidor necesita saber su audiencia (T6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIdLines, needsAudience, securityYaml, translatedClients } from '../src/lib/gen/security-config.js';

const SECURITY = {
  protocol: 'oidc',
  matchers: [],
  defaultRule: { level: 'required' },
  roles: ['custodian'],
  scopes: ['vault:write'],
  serviceClients: [
    { name: 'batch-runner', scopes: ['vault:write'] },
    { name: 'reporter', scopes: [] }
  ],
  serviceAuth: { protocol: 'oauth2', validateAudience: false },
  callerIdentity: null,
  scoping: null
};

function modelWith(auth, security = {}) {
  return {
    service: { artifactId: 'vault-api' },
    layersPresent: { security: true, api: true },
    services: [{ operations: [{ route: { method: 'GET', path: '/x' } }] }],
    stack: { auth },
    security: { ...SECURITY, ...security }
  };
}

const EXEMPT = { scoping: { exemptClients: ['batch-runner'] } };
const ONE_TO_ONE = { callerIdentity: { source: 'serviceClient', resolvedBy: null } };
const RESOLVED = { callerIdentity: { source: 'serviceClient', resolvedBy: { entity: 'T', field: 'f' } } };

test('se traducen solo los exentos y la identidad 1:1, y solo con un proveedor que genera el id', () => {
  assert.deepEqual(translatedClients(modelWith('cognito')), []);
  assert.deepEqual(translatedClients(modelWith('cognito', EXEMPT)), [{ name: 'batch-runner', variable: 'SECURITY_CLIENT_ID_BATCH_RUNNER' }]);
  assert.deepEqual(translatedClients(modelWith('cognito', ONE_TO_ONE)).map((client) => client.name), ['batch-runner', 'reporter']);
  assert.deepEqual(translatedClients(modelWith('keycloak', { ...EXEMPT, ...ONE_TO_ONE })), []);
});

test('con resolvedBy no se traduce: la lista del recurso ya guarda los ids', () => {
  assert.deepEqual(translatedClients(modelWith('cognito', RESOLVED)), []);
});

test('con clave de API por cliente el nombre ya es el declarado: no hay nada que traducir', () => {
  assert.deepEqual(translatedClients(modelWith('cognito', { ...EXEMPT, serviceAuth: { protocol: 'api-key' } })), []);
});

test('un cliente exento y con identidad 1:1 sale una sola vez', () => {
  assert.equal(translatedClients(modelWith('cognito', { ...EXEMPT, ...ONE_TO_ONE })).filter((client) => client.name === 'batch-runner').length, 1);
});

test('P2: la variable es obligatoria en production y tiene valor en los demás perfiles', () => {
  const model = modelWith('cognito', EXEMPT);
  const entry = (profile) => clientIdLines(model, profile).at(-1).trim();
  assert.equal(entry('production'), 'batch-runner: ${SECURITY_CLIENT_ID_BATCH_RUNNER}');
  assert.equal(entry('develop'), 'batch-runner: ${SECURITY_CLIENT_ID_BATCH_RUNNER:batch-runner}');
  assert.equal(entry('local'), 'batch-runner: batch-runner');
  assert.equal(entry('test'), 'batch-runner: opaque-id-of-batch-runner');
});

test('sin nada que traducir no sale la clave', () => {
  assert.deepEqual(clientIdLines(modelWith('keycloak', EXEMPT), 'production'), []);
  assert.doesNotMatch(securityYaml(modelWith('keycloak', EXEMPT), 'production'), /client-ids/);
});

test('T6: con scopes prefijados la audiencia hace falta aunque el diseño no la valide', () => {
  assert.equal(needsAudience(modelWith('cognito')), true);
  assert.match(securityYaml(modelWith('cognito'), 'production'), /audience: \$\{SECURITY_AUDIENCE\}/);
});

test('T6: sin scopes prefijados, solo con validateAudience', () => {
  assert.equal(needsAudience(modelWith('keycloak')), false);
  assert.equal(needsAudience(modelWith('keycloak', { serviceAuth: { protocol: 'oauth2', validateAudience: true } })), true);
});

test('T6: sin scopes que lleguen por el token no hace falta', () => {
  assert.equal(needsAudience(modelWith('cognito', { scopes: [] })), false);
  assert.equal(needsAudience(modelWith('cognito', { serviceAuth: { protocol: 'api-key' } })), false);
});

test('sin token no hay audiencia ni clientes que configurar', () => {
  const model = modelWith('cognito', { ...EXEMPT, protocol: 'api-key' });
  assert.equal(needsAudience(model), false);
  assert.deepEqual(translatedClients(model), []);
});
