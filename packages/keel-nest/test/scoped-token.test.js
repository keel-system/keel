// `tokenWithScope(rol, ...valores)`: un titular cuyo claim del alcance enumera OTRO recurso, varios o ninguno.
//
// El realm siembra a cada usuario no exento con UN valor (`scopedResource()`), y las tres corridas de asset-vault
// (dos de keel-spring y una de keel-nest) dejaron como hueco del arnés el «custodio con vaults = ["OTRO"]»
// (`test-realm-claim-values`). Aquí se EJECUTA la sección de identidad emitida de keel-nest contra un Keycloak falso
// de `node:http` —qué usuario da de alta, con qué rol y atributo, con qué nombre—, y se compara con lo que emite
// keel-spring. Contra un Keycloak real lo mide `npm run security-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { identitySection } from '../src/scaffold/identity-harness.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const STACK = { database: 'mongodb', broker: 'rabbitmq', auth: 'keycloak' };

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.firma`;
}

/** Un Keycloak mínimo: token de admin, usuarios, roles y el password grant del realm. */
function fakeKeycloak({ dropAttributes = false } = {}) {
  const users = new Map();
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://x');
      calls.push(`${request.method} ${url.pathname}`);
      const reply = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (url.pathname === '/realms/master/protocol/openid-connect/token') return reply(200, { access_token: 'admin' });
      if (url.pathname === '/realms/asset-vault/protocol/openid-connect/token') {
        const form = new URLSearchParams(body);
        const user = [...users.values()].find((u) => u.username === form.get('username'));
        if (!user) return reply(401, { error: 'invalid_grant' });
        const claims = { preferred_username: user.username, exp: Math.floor(Date.now() / 1000) + 300, roles: user.roles };
        if (user.attributes?.vaults) claims.vaults = user.attributes.vaults;
        return reply(200, { access_token: jwt(claims) });
      }
      const admin = url.pathname.replace('/admin/realms/asset-vault', '');
      if (request.headers.authorization !== 'Bearer admin') return reply(401);
      if (request.method === 'GET' && admin === '/users') {
        return reply(200, [...users.values()].filter((u) => u.username === url.searchParams.get('username')));
      }
      if (request.method === 'POST' && admin === '/users') {
        const user = JSON.parse(body);
        const id = `id-${users.size + 1}`;
        users.set(id, { id, username: user.username, attributes: dropAttributes ? {} : user.attributes, roles: [], user });
        return reply(201);
      }
      if (request.method === 'GET' && admin.startsWith('/roles/')) return reply(200, { id: 'r1', name: decodeURIComponent(admin.slice(7)) });
      const mapping = admin.match(/^\/users\/([^/]+)\/role-mappings\/realm$/);
      if (request.method === 'POST' && mapping) {
        users.get(mapping[1]).roles.push(...JSON.parse(body).map((role) => role.name));
        return reply(204);
      }
      const one = admin.match(/^\/users\/([^/]+)$/);
      if (request.method === 'GET' && one) return reply(200, users.get(one[1]));
      return reply(404, { error: `no simulado: ${request.method} ${admin}` });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, users, calls, port: server.address().port }))
  );
}

async function loadIdentity() {
  const { files, model } = planFixture('asset-vault', { stack: STACK });
  const flow = files.find((f) => f.path === 'test/integration/support/flow.ts').content;
  assert.ok(flow.includes('export async function tokenWithScope(role: string, ...values: readonly string[]): Promise<string>'));
  // La sección de identidad sola, con lo que toma de la cabecera de flow.ts.
  const source = `import fs from 'node:fs';\nimport path from 'node:path';\ntype Headers = Record<string, string>;\n${identitySection(model)}`;
  const { load } = transpileTree([{ path: 'src/identity.ts', content: source }]);
  return load('src/identity.ts');
}

test('asset-vault: tokenWithScope da de alta al usuario del rol con ESOS valores del claim y pide su token', async (t) => {
  const keycloak = await fakeKeycloak();
  t.after(() => keycloak.server.close());
  process.env.AUTH_TOKEN_URL = `http://127.0.0.1:${keycloak.port}/realms/asset-vault/protocol/openid-connect/token`;
  t.after(() => delete process.env.AUTH_TOKEN_URL);
  const { tokenWithScope } = await loadIdentity();

  const token = await tokenWithScope('vault-reader', 'OTRO');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  // El nombre es el de keel-spring: Integer.toHexString("OTRO".hashCode()) = 252ee2.
  assert.equal(claims.preferred_username, 'scoped-vault-reader-252ee2');
  assert.deepEqual(claims.vaults, ['OTRO']);
  assert.deepEqual(claims.roles, ['vault-reader']);

  // Otra vez lo mismo: de la caché, sin tocar la administración.
  const before = keycloak.calls.length;
  assert.equal(await tokenWithScope('vault-reader', 'OTRO'), token);
  assert.equal(keycloak.calls.length, before);

  // El orden y los repetidos no cambian el usuario; sin valores, el usuario del rol SIN el claim.
  await tokenWithScope('vault-reader', 'B', 'A', 'B');
  const none = JSON.parse(Buffer.from((await tokenWithScope('vault-reader')).split('.')[1], 'base64url').toString('utf8'));
  assert.equal(none.vaults, undefined);
  assert.equal(keycloak.users.size, 3);
  const both = [...keycloak.users.values()].find((u) => u.attributes?.vaults?.length === 2);
  assert.deepEqual(both.attributes.vaults, ['A', 'B']);
});

test('si el realm descarta el atributo, tokenWithScope muere nombrando al usuario, no con un 403 lejano', async (t) => {
  const keycloak = await fakeKeycloak({ dropAttributes: true });
  t.after(() => keycloak.server.close());
  process.env.AUTH_TOKEN_URL = `http://127.0.0.1:${keycloak.port}/realms/asset-vault/protocol/openid-connect/token`;
  t.after(() => delete process.env.AUTH_TOKEN_URL);
  const { tokenWithScope } = await loadIdentity();
  await assert.rejects(tokenWithScope('vault-reader', 'OTRO'), /scoped-vault-reader-252ee2 tiene vaults=\[\] y el escenario pidió \["OTRO"\]/);
});

test('keel-spring emite el mismo tokenWithScope, con el mismo nombre de usuario y las credenciales de administración', () => {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, 'asset-vault'));
  const files = planSpring({ manifest, layers, workspace: FIXTURES_DIR, stack: STACK }).files;
  const flow = files.find((f) => f.path.endsWith('/AbstractFlowIT.java')).content;
  assert.ok(flow.includes('protected String tokenWithScope(String role, String... values) {'));
  assert.ok(flow.includes('"scoped-" + role + "-" + Integer.toHexString(String.join("\\n", wanted).hashCode())'));
  assert.ok(flow.includes('user.put("attributes", Map.of("vaults", values));'));
  const credentials = files.find((f) => f.path === 'infra/test-credentials.env').content;
  assert.match(credentials, /tokenWithScope\(rol, valores\)/);
  assert.match(credentials, /^AUTH_ADMIN_USER=/m);
});

test('sin alcance, con Cognito o con todos los roles exentos no hay tokenWithScope', () => {
  const cases = [
    { stack: STACK, mutate: (layers) => delete layers.security.authentication.scoping },
    { stack: { ...STACK, auth: 'cognito' } },
    { stack: STACK, mutate: (layers) => (layers.security.authentication.scoping.exemptRoles = Object.keys(layers.security.roles ?? {})) }
  ];
  for (const { stack, mutate } of cases) {
    const flow = planFixture('asset-vault', { stack, mutate }).files.find((f) => f.path === 'test/integration/support/flow.ts').content;
    assert.ok(!flow.includes('tokenWithScope'), JSON.stringify(stack));
  }
});
