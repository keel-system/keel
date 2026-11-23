// La configuración de los clientes salientes por perfil (`http-clients.yaml`), la que comparten keel-nest y keel-dotnet:
// la URL del proveedor según el perfil (el WireMock de infra/ en local, una que no responde en test, la variable
// OBLIGATORIA fuera) y las credenciales de cada autenticación con el gradiente de keel-core.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { httpClientsYaml, localTokenPath, tokenStubMappings } from '../src/lib/gen/http-clients-config.js';
import { LOCAL_STUB_BASE_URL, UNREACHABLE_BASE_URL } from '../src/lib/gen/infra-catalog.js';

const model = {
  httpClients: [
    { id: 'inventory', envPrefix: 'INVENTORY', auth: null },
    { id: 'pricing', envPrefix: 'PRICING', auth: { type: 'api-key' } },
    { id: 'search-index', envPrefix: 'SEARCH_INDEX', auth: { type: 'bearer-static' } },
    { id: 'erp', envPrefix: 'ERP', auth: { type: 'basic' } },
    { id: 'partner', envPrefix: 'PARTNER', auth: { type: 'oauth2-client-credentials', tokenUrl: 'https://auth.partner.example/oauth2/token' } }
  ]
};
const yaml = (profile) => parseYaml(httpClientsYaml(model, profile))['http-clients'];

test('la URL del proveedor: el stub en local, una que no responde en test, la variable obligatoria fuera', () => {
  assert.equal(yaml('local').inventory['base-url'], LOCAL_STUB_BASE_URL);
  assert.equal(yaml('test').inventory['base-url'], UNREACHABLE_BASE_URL);
  for (const profile of ['develop', 'production']) assert.equal(yaml(profile).inventory['base-url'], '${INVENTORY_BASE_URL}');
  assert.equal(yaml('local').inventory.auth, undefined);
});

test('cada autenticación lee sus credenciales de las variables de keel-spring, con el gradiente por perfil', () => {
  assert.deepEqual(yaml('local').pricing.auth, { 'api-key': 'changeme' });
  assert.deepEqual(yaml('develop').pricing.auth, { 'api-key': '${PRICING_API_KEY:changeme}' });
  assert.deepEqual(yaml('production').pricing.auth, { 'api-key': '${PRICING_API_KEY}' });
  assert.deepEqual(yaml('production')['search-index'].auth, { token: '${SEARCH_INDEX_TOKEN}' });
  assert.deepEqual(yaml('production').erp.auth, { username: '${ERP_USERNAME}', password: '${ERP_PASSWORD}' });
  // OAuth2: el token-uri de local es el PATH del diseño sobre el stub; test no sale a la red.
  assert.equal(yaml('local').partner.auth['token-uri'], `${LOCAL_STUB_BASE_URL}/oauth2/token`);
  assert.equal(yaml('production').partner.auth['client-id'], '${PARTNER_CLIENT_ID}');
  assert.deepEqual(yaml('test').partner.auth, { 'client-id': 'test', 'client-secret': 'test', 'token-uri': 'http://localhost/token' });
});

// Corrida order de prueba-gelsa (G4): el token del cliente M2M no lo contestaba nadie en local, y un `tokenUrl` que no
// era una URL llegaba tal cual. Las dos mitades dicen la misma ruta: el token-uri de local y el mapping de infra/.
test('el token de un cliente oauth2 lo contesta un mapping de infra/, en la misma ruta que su token-uri de local', () => {
  const [mapping, ...rest] = tokenStubMappings(model);
  assert.equal(rest.length, 0, 'solo los clientes oauth2-client-credentials');
  assert.equal(mapping.path, 'infra/http-stubs/mappings/partner-token.json');
  const stub = JSON.parse(mapping.content);
  assert.deepEqual(stub.request, { method: 'POST', urlPath: '/oauth2/token' });
  assert.equal(stub.response.status, 200);
  assert.equal(stub.response.jsonBody.token_type, 'Bearer');
  assert.equal(yaml('local').partner.auth['token-uri'], `${LOCAL_STUB_BASE_URL}${stub.request.urlPath}`);
});

test('un tokenUrl que no es una URL lleva una ruta fija por cliente en local, y su mapping la contesta', () => {
  const placeholder = { httpClients: [{ id: 'payment', envPrefix: 'PAYMENT', auth: { type: 'oauth2-client-credentials', tokenUrl: '${IDP_TOKEN_URL}' } }] };
  assert.equal(localTokenPath(placeholder.httpClients[0]), '/payment/oauth2/token');
  const local = parseYaml(httpClientsYaml(placeholder, 'local'))['http-clients'];
  assert.equal(local.payment.auth['token-uri'], `${LOCAL_STUB_BASE_URL}/payment/oauth2/token`);
  assert.equal(JSON.parse(tokenStubMappings(placeholder)[0].content).request.urlPath, '/payment/oauth2/token');
  // Una URL sin ruta tampoco da una que el stub pueda casar sin pisar a otro cliente.
  assert.equal(localTokenPath({ id: 'idp', auth: { tokenUrl: 'https://idp.example' } }), '/idp/oauth2/token');
});
