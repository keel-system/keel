// Lo que el proveedor de identidad tiene que cumplir (fase 3.1 y 3.2 de PLAN-PROVEEDOR-IDENTIDAD.md): una prueba por
// exigencia del diseño, con los dos proveedores donde difieren, un proveedor sin forma de cumplirla, y el documento.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../src/index.js';
import { buildModel } from '../src/lib/gen/model.js';
import { STACK_DEFAULTS, defaultDatabaseFor } from '../src/lib/gen/infra-catalog.js';
import { IDENTITY_PROVIDERS } from '../src/lib/gen/identity-providers.js';
import {
  IDENTITY_CONTRACT_DOC,
  checkIdentitySupport,
  claimSupport,
  identityClaimDemands,
  identityContractFile,
  identityCoverage
} from '../src/lib/gen/identity-support.js';
import { PROBE } from './helpers/probe-projection.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'designs');

function modelOf(fixture, auth) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  const stack = { ...STACK_DEFAULTS, database: defaultDatabaseFor(layers.persistence?.default?.model), auth };
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return { ...buildModel({ manifest, layers, stack, projection: PROBE }), stack };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const layersOf = (fixture) => loadService(path.join(FIXTURES_DIR, fixture)).layers;

/** Una capa security mínima con identidad por token, sobre la que cada prueba añade lo suyo. */
function security(authentication = {}, rest = {}) {
  return { security: { authentication: { protocol: 'oidc', ...authentication }, access: { default: { level: 'required' } }, ...rest } };
}

const ids = (demands) => demands.map((demand) => demand.id);

// ─── Lo que el diseño exige al token ────────────────────────────────────────

test('sin identidad por token no se exige nada', () => {
  assert.deepEqual(identityClaimDemands(security({ protocol: 'api-key' }).security), []);
  assert.deepEqual(identityClaimDemands(undefined), []);
});

test('caller-identity: la identidad desde un claim se exige al token de usuario; desde el cliente, no', () => {
  const claim = identityClaimDemands(security({ callerIdentity: { field: 'callerEmail', from: { source: 'claim', name: 'email' } } }).security);
  assert.deepEqual(claim.map(({ id, claim: name, holder }) => [id, name, holder]), [['caller-identity', 'email', 'user']]);
  assert.deepEqual(identityClaimDemands(security({ callerIdentity: { field: 'owner', from: { source: 'serviceClient' } } }).security), []);
});

test('scoping: se exige al usuario, y a la máquina solo por los clientes no exentos con token', () => {
  const scoping = { claim: 'vaults', over: 'Vault.code', error: 'OUT_OF_SCOPE' };
  const clients = { serviceClients: { renderer: {}, importer: {} } };
  assert.deepEqual(ids(identityClaimDemands(security({ scoping }).security)), ['scoping-user']);
  const machine = identityClaimDemands(security({ scoping: { ...scoping, exemptClients: ['renderer'] } }, clients).security);
  assert.deepEqual(ids(machine), ['scoping-user', 'scoping-machine']);
  assert.deepEqual(machine[1].clients, ['importer']);
  assert.deepEqual(ids(identityClaimDemands(security({ scoping: { ...scoping, exemptClients: ['renderer', 'importer'] } }, clients).security)), ['scoping-user']);
  // Con clave de API los clientes máquina no tienen token que llevarlo.
  assert.deepEqual(ids(identityClaimDemands(security({ scoping, serviceAuth: { protocol: 'api-key' } }, clients).security)), ['scoping-user']);
});

test('permissions: solo los permisos que ningún rol otorga llegan en el token', () => {
  const access = { default: { level: 'required' }, rules: { readVault: { permissions: ['vault:read'] }, purge: { permissions: ['vault:purge'] } } };
  const granted = identityClaimDemands(security({}, { access, roleGrants: { custodian: ['vault:read', 'vault:purge'] } }).security);
  assert.deepEqual(granted, []);
  const [direct] = identityClaimDemands(security({}, { access, roleGrants: { custodian: ['vault:read'] } }).security);
  assert.equal(direct.id, 'permissions');
  assert.equal(direct.claim, null, 'el nombre del claim lo pone el proveedor');
  assert.deepEqual(direct.permissions, ['vault:purge']);
});

// ─── La matriz ──────────────────────────────────────────────────────────────

test('un claim que el proveedor pone siempre está soportado sin nada más', () => {
  const sub = { claim: 'sub', holder: 'user' };
  for (const provider of Object.values(IDENTITY_PROVIDERS)) assert.equal(claimSupport(provider, sub).state, 'supported', provider.id);
});

test('D5: email en el access token es nativo en Keycloak y con disparador en Cognito', () => {
  const layers = layersOf('shop-api');
  assert.deepEqual(checkIdentitySupport(layers, 'keycloak'), { errors: [], warnings: [], cells: checkIdentitySupport(layers, 'keycloak').cells });
  const cognito = checkIdentitySupport(layers, 'cognito');
  assert.deepEqual(cognito.errors, []);
  assert.equal(cognito.warnings.length, 1);
  assert.match(cognito.warnings[0], /^security: caller-identity: Cognito solo pone el claim 'email' en el access token de un usuario con un disparador .* V2 o V3/);
  assert.match(cognito.warnings[0], /plan Essentials o Plus/);
  assert.match(cognito.warnings[0], new RegExp(IDENTITY_CONTRACT_DOC.replaceAll('.', '\\.')));
});

test('D6: el claim del alcance va con un mapper en Keycloak y con disparador en Cognito', () => {
  const layers = layersOf('asset-vault');
  const keycloak = checkIdentitySupport(layers, 'keycloak');
  assert.deepEqual([keycloak.errors, keycloak.warnings], [[], []]);
  assert.match(keycloak.cells[0].via, /mapper/);
  const cognito = checkIdentitySupport(layers, 'cognito');
  assert.deepEqual(cognito.cells.map(({ id, state }) => [id, state]), [['scoping-user', 'requires-configuration']]);
});

test('T5: el claim en un cliente máquina no exento exige en Cognito el disparador V3', () => {
  const layers = security({ scoping: { claim: 'vaults', over: 'Vault.code', error: 'OUT_OF_SCOPE' } }, { serviceClients: { importer: {} } });
  const machine = checkIdentitySupport(layers, 'cognito').cells.find((cell) => cell.holder === 'machine');
  assert.equal(machine.state, 'requires-configuration');
  assert.match(machine.via, /V3/);
  assert.doesNotMatch(machine.via, /V2/);
});

test('un proveedor sin forma de poner un claim no sirve al diseño: error, y no se genera', () => {
  const lacking = { ...IDENTITY_PROVIDERS.cognito, id: 'acme-lacking', displayName: 'Acme', token: { ...IDENTITY_PROVIDERS.cognito.token, customClaims: { user: IDENTITY_PROVIDERS.cognito.token.customClaims.user } } };
  IDENTITY_PROVIDERS[lacking.id] = lacking;
  try {
    const layers = security({ scoping: { claim: 'vaults', over: 'Vault.code', error: 'OUT_OF_SCOPE' } }, { serviceClients: { importer: {} } });
    const { errors, warnings } = checkIdentitySupport(layers, lacking.id);
    assert.deepEqual(errors, ["security: scoping-machine: Acme no tiene forma de poner el claim 'vaults' en el access token de un cliente máquina, y lo necesita el alcance por recurso de importer (authentication.scoping, sin exemptClients)"]);
    assert.equal(warnings.length, 1, 'el del usuario sigue siendo con configuración');
    assert.deepEqual(identityCoverage(layers, ['keycloak', lacking.id]).map((entry) => [entry.id, entry.errors.length]), [['keycloak', 0], [lacking.id, 1]]);
  } finally {
    delete IDENTITY_PROVIDERS[lacking.id];
  }
});

test('sin proveedor del catálogo no hay descriptor que consultar', () => {
  assert.deepEqual(checkIdentitySupport(layersOf('shop-api'), 'none'), { errors: [], warnings: [], cells: [] });
  assert.deepEqual(identityCoverage(layersOf('shop-api'), ['none']), []);
});

test('ninguna fixture queda sin proveedor que la sirva', () => {
  for (const fixture of ['asset-vault', 'shop-api', 'conduit', 'profile-directory']) {
    for (const entry of identityCoverage(layersOf(fixture), ['keycloak', 'cognito'])) assert.deepEqual(entry.errors, [], `${fixture}/${entry.id}`);
  }
});

// ─── El documento ───────────────────────────────────────────────────────────

test('el documento se emite con identidad por token, también sin proveedor del catálogo, y no sin ella', () => {
  assert.equal(identityContractFile(modelOf('asset-vault', 'keycloak')).path, IDENTITY_CONTRACT_DOC);
  assert.ok(identityContractFile(modelOf('asset-vault', 'none')));
  assert.equal(identityContractFile(modelOf('stock-reservation', 'keycloak')), null);
  assert.equal(identityContractFile(modelOf('job-dispatch', 'keycloak')), null);
});

test('con Cognito dice qué no está demostrado, qué hay que crear y las variables de los clientes', () => {
  const doc = identityContractFile(modelOf('asset-vault', 'cognito')).content;
  assert.match(doc, /no contra un pool real/);
  assert.match(doc, /## Lo que no está demostrado/);
  assert.match(doc, /`token_use: access`/);
  assert.match(doc, /Grupos del user pool\*\*: `vault-admin`, `vault-reader`/);
  assert.match(doc, /con el prefijo `asset-vault-api\/`/);
  assert.match(doc, /\| `vaults` \| .* \| un usuario \| con configuración \| un disparador/);
  assert.match(doc, /lista de textos \(un array JSON/);
  assert.match(doc, /\| `SECURITY_CLIENT_ID_RENDERING_SERVICE` \|/);
  assert.match(doc, /\| `SECURITY_AUDIENCE` \| El identificador del resource server/);
});

test('con Keycloak no dice que falte demostrar nada, ni pide ids de cliente', () => {
  const doc = identityContractFile(modelOf('asset-vault', 'keycloak')).content;
  assert.match(doc, /medido contra un Keycloak real/);
  assert.doesNotMatch(doc, /Lo que no está demostrado|SECURITY_CLIENT_ID_|token_use/);
  assert.match(doc, /\| `vaults` \| .* \| un usuario \| sí \| un mapper/);
});
