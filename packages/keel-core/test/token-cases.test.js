// Los casos del token se DERIVAN del descriptor del proveedor y del diseño: cada prueba afirma la forma del token y lo
// que se espera de él, con los dos proveedores donde difieren. Que un servidor los cumpla es de la fase 2.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { TOKEN_RULES, credentialClientId, tokenCases } from '../src/lib/gen/token-cases.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function modelOf(fixture, auth) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model), auth };
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    // El stack lo cuelga del modelo cada generador al planificar; aquí lo hace la prueba.
    return { ...buildModel({ manifest, layers, stack, projection: PROBE }), stack };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const BASE_SECURITY = {
  roles: ['custodian', 'auditor'],
  roleGrants: [{ role: 'custodian', permissions: ['vault:read'] }],
  scopes: ['vault:write'],
  serviceClients: [{ name: 'batch', description: null, scopes: ['vault:write'] }],
  serviceAuth: { protocol: 'oauth2', validateAudience: true, audience: 'vault-api' },
  usesAuthorities: true,
  callerIdentity: null,
  scoping: null
};

function casesFor(auth, security = {}) {
  const model = modelOf('asset-vault', auth);
  return tokenCases({ ...model, security: { ...model.security, ...BASE_SECURITY, ...security } });
}

const find = (cases, id) => {
  const found = cases.find((entry) => entry.id === id);
  assert.ok(found, `falta el caso ${id}: ${cases.map((entry) => entry.id).join(', ')}`);
  return found;
};
const absent = (cases, id) => assert.equal(cases.find((entry) => entry.id === id), undefined, `${id} no aplica`);

const SCOPING = { claim: 'vaults', over: 'Vault', error: 'X', exemptRoles: ['auditor'], exemptClients: ['batch'], testResource: 'batch' };

test('IDT-ROLE: los roles viajan donde los pone cada proveedor y dan su authority y sus permisos', () => {
  const keycloak = find(casesFor('keycloak'), 'IDT-ROLE');
  assert.deepEqual(keycloak.token.realm_access, { roles: ['custodian'] });
  assert.equal(keycloak.expect.principal, 'idt-user');
  assert.deepEqual(keycloak.expect.authorities.includes, ['ROLE_custodian', 'vault:read']);
  const cognito = find(casesFor('cognito'), 'IDT-ROLE');
  assert.deepEqual(cognito.token['cognito:groups'], ['custodian']);
  assert.equal(cognito.token.username, 'idt-user');
  assert.equal(cognito.token.token_use, 'access');
});

test('IDT-ROLE: sin authorities en ninguna regla, el principal es el sub', () => {
  const found = find(casesFor('cognito', { usesAuthorities: false }), 'IDT-ROLE');
  assert.equal(found.expect.principal, 'idt-sub');
});

test('IDT-NO-ROLE: autenticado, sin ninguna authority de rol', () => {
  const found = find(casesFor('cognito'), 'IDT-NO-ROLE');
  assert.deepEqual(found.token['cognito:groups'], []);
  assert.deepEqual(found.expect, { authenticated: true, authorities: { excludes: ['ROLE_custodian', 'ROLE_auditor'] } });
});

test('IDT-PERMISSION: el permiso que una regla pide se lee del claim de permisos', () => {
  const found = casesFor('keycloak').find((entry) => entry.id === 'IDT-PERMISSION');
  if (!found) return assert.fail('asset-vault tendría que pedir algún permiso');
  assert.deepEqual(found.token.permissions, found.expect.authorities.includes);
});

test('IDT-NOT-ACCESS-TOKEN (D1): solo con un proveedor que marca el tipo de token', () => {
  const found = find(casesFor('cognito'), 'IDT-NOT-ACCESS-TOKEN');
  assert.equal(found.defect, 'D1');
  assert.equal(found.token.token_use, 'id');
  assert.deepEqual(found.token['cognito:groups'], ['custodian'], 'el ID token trae los grupos: por eso concede de más');
  assert.deepEqual(found.expect, { authenticated: false, status: 401 });
  absent(casesFor('keycloak'), 'IDT-NOT-ACCESS-TOKEN');
});

test('IDT-SCOPE: el scope con el formato de cada proveedor', () => {
  const cognito = find(casesFor('cognito'), 'IDT-SCOPE');
  assert.equal(cognito.token.scope, 'vault-api/vault:write');
  assert.equal(cognito.token.aud, undefined, 'el access token de máquina de Cognito no lleva aud');
  const keycloak = find(casesFor('keycloak'), 'IDT-SCOPE');
  assert.equal(keycloak.token.scope, 'vault:write');
  assert.equal(keycloak.token.aud, 'vault-api');
  assert.deepEqual(keycloak.expect.authorities.includes, ['SCOPE_vault:write']);
});

test('IDT-SCOPE-FOREIGN (D2): el prefijo de otro resource server no da authority', () => {
  const found = find(casesFor('cognito'), 'IDT-SCOPE-FOREIGN');
  assert.equal(found.defect, 'D2');
  assert.equal(found.token.scope, 'audiencia-ajena/vault:write');
  assert.deepEqual(found.expect.authorities, { excludes: ['SCOPE_vault:write'] });
  absent(casesFor('keycloak'), 'IDT-SCOPE-FOREIGN');
});

test('IDT-AUDIENCE-*: la audiencia, con el mecanismo de cada proveedor, y solo si el diseño la valida', () => {
  assert.equal(find(casesFor('keycloak'), 'IDT-AUDIENCE-OWN').expect.issuedForService, true);
  const keycloak = find(casesFor('keycloak'), 'IDT-AUDIENCE-FOREIGN');
  assert.equal(keycloak.token.aud, 'audiencia-ajena');
  assert.equal(keycloak.expect.status, 403);
  const cognito = find(casesFor('cognito'), 'IDT-AUDIENCE-FOREIGN');
  assert.equal(cognito.token.scope, 'audiencia-ajena/vault:write');
  assert.equal(cognito.expect.issuedForService, false);
  const without = casesFor('keycloak', { serviceAuth: { ...BASE_SECURITY.serviceAuth, validateAudience: false } });
  absent(without, 'IDT-AUDIENCE-OWN');
  absent(without, 'IDT-AUDIENCE-FOREIGN');
});

test('sin tokens de máquina (api-key) no hay casos de scope ni de audiencia', () => {
  const cases = casesFor('keycloak', { serviceAuth: { protocol: 'api-key', validateAudience: false, audience: null } });
  absent(cases, 'IDT-SCOPE');
  absent(cases, 'IDT-AUDIENCE-OWN');
});

test('IDT-IDENTITY-CLAIM: la identidad sale del claim que declara el diseño', () => {
  const found = find(casesFor('cognito', { callerIdentity: { field: 'owner', source: 'claim', claim: 'email', resolvedBy: null } }), 'IDT-IDENTITY-CLAIM');
  assert.equal(found.token.email, 'idt-identity');
  assert.equal(found.expect.identity, 'idt-identity');
});

const SERVICE_CLIENT = { field: 'tenant', source: 'serviceClient', claim: null, resolvedBy: null };

test('IDT-IDENTITY-CLIENT (D4): con 1:1 la identidad es el nombre declarado, y con Cognito hay que traducir', () => {
  const cognito = find(casesFor('cognito', { callerIdentity: SERVICE_CLIENT }), 'IDT-IDENTITY-CLIENT');
  assert.equal(cognito.defect, 'D4');
  assert.equal(cognito.token.client_id, credentialClientId('cognito', 'batch'));
  assert.notEqual(cognito.token.client_id, 'batch');
  assert.equal(cognito.expect.identity, 'batch');
  assert.deepEqual(cognito.clientIds, { batch: cognito.token.client_id });
  const keycloak = find(casesFor('keycloak', { callerIdentity: SERVICE_CLIENT }), 'IDT-IDENTITY-CLIENT');
  assert.equal(keycloak.defect, undefined);
  assert.equal(keycloak.token.azp, 'batch');
  assert.equal(keycloak.clientIds, undefined);
});

test('IDT-IDENTITY-CLIENT-RESOLVED: con resolvedBy la identidad es el valor crudo y no se traduce', () => {
  const callerIdentity = { ...SERVICE_CLIENT, resolvedBy: { entity: 'Tenant', field: 'clientIds' } };
  const cases = casesFor('cognito', { callerIdentity });
  const found = find(cases, 'IDT-IDENTITY-CLIENT-RESOLVED');
  assert.equal(found.expect.identity, found.token.client_id);
  assert.equal(found.clientIds, undefined);
  assert.equal(found.defect, undefined);
  absent(cases, 'IDT-IDENTITY-CLIENT');
});

test('IDT-EXEMPT-CLIENT (D3): un exento se reconoce aunque el proveedor genere su id', () => {
  const cognito = find(casesFor('cognito', { scoping: SCOPING }), 'IDT-EXEMPT-CLIENT');
  assert.equal(cognito.defect, 'D3');
  assert.equal(cognito.expect.exempt, true);
  assert.deepEqual(cognito.clientIds, { batch: cognito.token.client_id });
  assert.equal(find(casesFor('keycloak', { scoping: SCOPING }), 'IDT-EXEMPT-CLIENT').defect, undefined);
});

test('IDT-SCOPED-CLIENT: un cliente fuera de la lista se acota', () => {
  const found = find(casesFor('cognito', { scoping: SCOPING }), 'IDT-SCOPED-CLIENT');
  assert.equal(found.expect.exempt, false);
  assert.notEqual(found.token.client_id, find(casesFor('cognito', { scoping: SCOPING }), 'IDT-EXEMPT-CLIENT').token.client_id);
});

test('IDT-EXEMPT-ROLE e IDT-SCOPED-ROLE: el rol exento no se acota y el otro ve los valores del claim', () => {
  const cases = casesFor('keycloak', { scoping: SCOPING });
  assert.deepEqual(find(cases, 'IDT-EXEMPT-ROLE').token.realm_access, { roles: ['auditor'] });
  assert.equal(find(cases, 'IDT-EXEMPT-ROLE').expect.exempt, true);
  const scoped = find(cases, 'IDT-SCOPED-ROLE');
  assert.deepEqual(scoped.token.vaults, ['idt-resource']);
  assert.deepEqual(scoped.expect.scope, ['idt-resource']);
});

test('sin proveedor conocido o sin identidad por token no hay casos', () => {
  assert.deepEqual(tokenCases(modelOf('asset-vault', 'none')), []);
  const model = modelOf('asset-vault', 'keycloak');
  assert.deepEqual(tokenCases({ ...model, security: { ...model.security, protocol: 'api-key' } }), []);
  assert.deepEqual(tokenCases({ ...model, layersPresent: { ...model.layersPresent, security: false } }), []);
});

test('en las fixtures reales: ids únicos, cada caso cita una regla y toda regla tiene un caso', () => {
  const used = new Set();
  for (const auth of ['keycloak', 'cognito']) {
    for (const security of [
      {},
      { scoping: SCOPING },
      { callerIdentity: SERVICE_CLIENT },
      { callerIdentity: { ...SERVICE_CLIENT, resolvedBy: { entity: 'T', field: 'f' } } },
      { callerIdentity: { field: 'o', source: 'claim', claim: 'sub', resolvedBy: null } }
    ]) {
      const cases = casesFor(auth, security);
      assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
      for (const entry of cases) {
        assert.ok(TOKEN_RULES[entry.rule], `${entry.id}: regla desconocida ${entry.rule}`);
        used.add(entry.rule);
      }
    }
  }
  assert.deepEqual(Object.keys(TOKEN_RULES).filter((rule) => !used.has(rule)), []);
});

test('toda fixture con identidad por token da casos con los dos proveedores', () => {
  for (const fixture of ['asset-vault', 'shop-api', 'conduit', 'notification-mailer']) {
    for (const auth of ['keycloak', 'cognito']) {
      assert.ok(tokenCases(modelOf(fixture, auth)).length > 0, `${fixture} con ${auth}`);
    }
  }
});
