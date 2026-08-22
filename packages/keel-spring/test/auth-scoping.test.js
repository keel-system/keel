// Alcance por recurso (`security.authentication.scoping`): el claim que acota QUÉ recursos
// alcanza el titular de un token.
//
// Por qué existe este archivo. Roles, permissions y scopes son globales, así que un servicio
// multi-inquilino necesita además acotar al recurso concreto — y hasta el DSL 2.11 no había
// dónde declararlo. `build` emitía `unmanagedAttributePolicy=ENABLED` «por si acaso» y no
// generaba ni el atributo ni el mapper, de modo que el claim acababa escrito a mano en el
// script de Keycloak de cada proyecto: no sobrevivía a reejecutar el aprovisionamiento ni a
// reimportar el realm, y su ausencia no rompía nada visible. Se manifestaba como un 403 sin
// explicación dentro de un test de integración.
//
// Las dos piezas son inseparables y por eso se comprueban juntas: el ATRIBUTO en cada usuario
// no exento y el MAPPER que lo proyecta al token. Con una sola, el claim no llega.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');

const CLAIM = 'tenants';
const SCOPED_VALUE = 'keel-scoped-resource';

function security({ scoping = true } = {}) {
  return {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'oauth2', audience: 'catalog-api', validateAudience: true },
      ...(scoping
        ? {
            scoping: {
              claim: CLAIM,
              over: 'Product.sku',
              error: 'TENANT_FORBIDDEN',
              // `admin` es transversal: su token NO lleva el claim, y eso es lo que hace la
              // exención observable desde fuera.
              exemptRoles: ['admin']
            }
          }
        : {})
    },
    access: {
      default: { level: 'required' },
      rules: { createProduct: { roles: ['admin', 'editor'], scopes: ['catalog:write'] } }
    },
    serviceClients: { billing: { scopes: ['catalog:write'] } }
  };
}

function build(options) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = security(options);
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';

  const workspace = tmpDir('keel-scoping-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace, force: true });
  const read = (relative) =>
    fs.readFileSync(path.join(workspace, 'services', 'catalog-spring', relative), 'utf8');
  return { read };
}

test('el script crea el protocol mapper que proyecta el claim', () => {
  const { read } = build();
  const script = read('infra/init-keycloak.sh');

  assert.match(script, /protocolMapper=oidc-usermodel-attribute-mapper/);
  assert.match(script, new RegExp(`name=${CLAIM}-mapper`));
  // El mapper va sobre el cliente PÚBLICO de usuario: es el que emite los tokens que el
  // arnés pide con password grant. En otro cliente el claim no llegaría a esos tokens.
  assert.match(script, /clients\/\$USER_CID\/protocol-mappers\/models/);
  // Multivaluado: el claim es una LISTA de recursos, y sin esto Keycloak lo emite como
  // cadena — el servidor leería un solo recurso donde el diseño promete varios.
  assert.match(script, /multivalued\\"=true/);
});

test('solo los usuarios NO exentos reciben el atributo', () => {
  const { read } = build();
  const script = read('infra/init-keycloak.sh');

  const loop = script.match(/for SCOPED_USER in ([^;]+); do/);
  assert.ok(loop, `no se generó el bucle de usuarios acotados:\n${script}`);
  const scoped = loop[1].trim().split(/\s+/);

  assert.ok(scoped.includes('editor'), 'editor se acota y debería recibir el atributo');
  assert.ok(!scoped.includes('admin'), 'admin está exento: su token no lleva el claim');
  // El usuario sin roles tampoco: no pasa ninguna regla de acceso, así que acotarlo no
  // distinguiría nada y solo enturbiaría el escenario del 403 por rol insuficiente.
  assert.ok(!scoped.includes('no-role'), 'no-role no tiene rol que acotar');
  assert.match(script, new RegExp(`attributes\\.${CLAIM}=`));
});

test('el realm importado declara exactamente lo mismo que el script', () => {
  // Paridad: son dos formatos del mismo realm. Un atributo que solo esté en uno hace que la
  // prueba manual del diseñador y la suite de integración vean cosas distintas.
  const { read } = build();
  const script = read('infra/init-keycloak.sh');
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));

  const scopedInScript = script.match(/for SCOPED_USER in ([^;]+); do/)[1].trim().split(/\s+/).sort();
  const scopedInRealm = realm.users
    .filter((user) => Object.keys(user.attributes ?? {}).length > 0)
    .map((user) => user.username)
    .sort();
  assert.deepEqual(scopedInRealm, scopedInScript);

  for (const user of realm.users.filter((u) => scopedInRealm.includes(u.username))) {
    assert.deepEqual(user.attributes[CLAIM], [SCOPED_VALUE], `${user.username}: valor del claim`);
  }

  const userClient = realm.clients.find((client) => client.publicClient);
  const mapper = (userClient.protocolMappers ?? []).find((m) => m.name === `${CLAIM}-mapper`);
  assert.ok(mapper, 'el realm importado no trae el mapper que el script sí crea');
  assert.equal(mapper.protocolMapper, 'oidc-usermodel-attribute-mapper');
  assert.equal(mapper.config['claim.name'], CLAIM);
  assert.equal(mapper.config.multivalued, 'true');
});

test('el valor del claim viaja a test-credentials.env, no al código de las pruebas', () => {
  // Mismo criterio que los secretos M2M: un solo productor y un solo consumidor. Si el arnés
  // tuviera que hardcodearlo, cambiar el valor rompería las pruebas sin tocar nada visible.
  const { read } = build();
  const env = read('infra/test-credentials.env');
  assert.match(env, new RegExp(`^AUTH_SCOPED_RESOURCE=${SCOPED_VALUE}$`, 'm'));
  assert.match(env, /Exentos \(su token no lleva el claim\): admin/);
});

test('el recurso acotado tiene credencial propia para poder originar tráfico', () => {
  // Sembrar el claim y no dar credencial al recurso deja el alcance probable solo por vías
  // indirectas: en la primera corrida con `scoping`, el escenario tuvo que ir por el canal de
  // eventos porque nadie podía pedir nada por HTTP en nombre del recurso acotado — y el alcance
  // se acaba probando por una puerta que no es la que importa.
  const { read } = build();
  const script = read('infra/init-keycloak.sh');
  const env = read('infra/test-credentials.env');
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));

  assert.match(script, new RegExp(`clientId=${SCOPED_VALUE}\\b`), 'el script no crea su cliente máquina');
  // Comparte el secreto de la matriz de prueba (`AUTH_CLIENT_SECRET`), como el resto de clientes
  // que no salen del diseño: no necesita clave propia, pero sí que la clave exista.
  assert.match(env, /^AUTH_CLIENT_SECRET=/m, 'sin secreto compartido el cliente no es usable');
  assert.match(env, /^AUTH_SCOPED_RESOURCE=/m);

  const client = realm.clients.find((entry) => entry.clientId === SCOPED_VALUE);
  assert.ok(client, 'el realm importado no trae el cliente del recurso acotado');
  assert.equal(client.serviceAccountsEnabled, true);
  // Con la audiencia buena: un cliente que no pasa la validación de `aud` no sirve para
  // ejercitar el alcance, sino para ejercitar la audiencia — que es otro escenario.
  assert.ok((client.defaultClientScopes ?? []).some((scope) => scope.startsWith('aud-')));
});

test('sin scoping declarado no se genera nada de esto', () => {
  // La ausencia es el caso mayoritario: un servicio de un solo inquilino no tiene por qué
  // cargar con un mapper ni con un atributo que nadie lee.
  const { read } = build({ scoping: false });
  const script = read('infra/init-keycloak.sh');
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));

  assert.doesNotMatch(script, /oidc-usermodel-attribute-mapper/);
  assert.doesNotMatch(script, /for SCOPED_USER in/);
  assert.doesNotMatch(read('infra/test-credentials.env'), /AUTH_SCOPED_RESOURCE/);
  for (const user of realm.users) {
    assert.equal(user.attributes, undefined, `${user.username} no debería llevar atributos`);
  }
  assert.equal(realm.clients.find((client) => client.publicClient).protocolMappers, undefined);
});
