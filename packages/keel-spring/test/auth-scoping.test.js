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
// El recurso acotado NO es un literal del generador: es el primer `serviceClient` del diseño —el
// único que puede originar tráfico— y esta fixture declara `billing`. Cuando era un literal
// inventado, no coincidía con el recurso de los escenarios y tumbaba clases enteras con un 403.
const SCOPED_VALUE = 'billing';

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

test('el recurso acotado tiene credencial porque ES un serviceClient del diseño', () => {
  // Sembrar el claim y no dar credencial al recurso deja el alcance probable solo por vías
  // indirectas: en la primera corrida con `scoping`, el escenario tuvo que ir por el canal de
  // eventos porque nadie podía pedir nada por HTTP en nombre del recurso acotado.
  //
  // La primera respuesta a eso fue añadir un cliente M2M de prueba con el nombre del literal, y
  // era el parche equivocado: creaba una credencial que no correspondía a ningún recurso real y
  // seguía sin coincidir con el que usan los escenarios. Derivando el valor del diseño el
  // problema desaparece — la credencial ya existe porque el recurso ES un `serviceClient`.
  const { read } = build();
  const script = read('infra/init-keycloak.sh');
  const env = read('infra/test-credentials.env');
  const realm = JSON.parse(read('deploy/keycloak/realm-export.json'));

  assert.match(script, new RegExp(`clientId=${SCOPED_VALUE}\\b`), 'el recurso acotado no tiene cliente');
  assert.match(env, new RegExp(`^AUTH_CLIENT_SECRET_${SCOPED_VALUE.toUpperCase()}=`, 'm'), 'sin secreto no es usable');
  assert.match(env, /^AUTH_SCOPED_RESOURCE=/m);
  // Y NO se crea un cliente de prueba extra con ese nombre: sobra en cuanto el valor sale del diseño.
  assert.ok(!script.includes('clientId=keel-scoped-resource'), 'quedó el cliente M2M del literal viejo');

  const client = realm.clients.find((entry) => entry.clientId === SCOPED_VALUE);
  assert.ok(client, 'el realm importado no trae el cliente del recurso acotado');
  assert.equal(client.serviceAccountsEnabled, true);
  // Con la audiencia buena: un cliente que no pasa la validación de `aud` no sirve para
  // ejercitar el alcance, sino para ejercitar la audiencia — que es otro escenario.
  assert.ok((client.defaultClientScopes ?? []).some((scope) => scope.startsWith('aud-')));
});

test('el arnés expone el recurso acotado, para que el escenario no lo escriba a mano', () => {
  // Es la tercera pata del mismo contrato. Antes el valor se publicaba en test-credentials.env y
  // NADIE lo leía —cero coincidencias de AUTH_SCOPED_RESOURCE en src/integrationTest/java—, así
  // que el dato vivía en tres sitios y arreglar uno no arreglaba nada.
  const { read } = build();
  const harness = read('src/integrationTest/java/com/commerce/catalog/flows/AbstractFlowIT.java');

  assert.match(harness, /protected static String scopedResource\(\)/);
  assert.match(harness, /env\("AUTH_SCOPED_RESOURCE"/, 'no lo lee del archivo que lo produce');
  assert.match(harness, new RegExp(`"${SCOPED_VALUE}"`), 'sin valor convencional de respaldo');
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

test('build genera el puerto CallerScope y su adaptador JWT desde el diseño', () => {
  // Los escribía el agente en cada corrida (asset-vault, R8, dos veces seguidas), con el nombre
  // del claim y de la authority sacados de un token real. Los dos salen del diseño.
  const workspace = (() => {
    const { manifest, layers } = loadService(fixtureDir);
    const patched = structuredClone(layers);
    patched.security = security();
    // La nota va en el handler de la operación que declara el error del alcance.
    patched['use-cases'].operations.createProduct.errors.push({
      code: 'TENANT_FORBIDDEN',
      when: 'El sku no está en el alcance del solicitante.',
      http: 403
    });
    const patchedManifest = structuredClone(manifest);
    patchedManifest.layers.security = 'security.keel.yaml';
    const dir = tmpDir('keel-scope-port-');
    scaffoldService({ manifest: patchedManifest, layers: patched, workspace: dir, force: true });
    return path.join(dir, 'services', 'catalog-spring', 'src/main/java');
  })();
  const files = fs.readdirSync(workspace, { recursive: true }).map(String);
  const read = (suffix) => fs.readFileSync(path.join(workspace, files.find((f) => f.endsWith(suffix))), 'utf8');

  const port = read(`${path.sep}CallerScope.java`);
  assert.match(port, /package [\w.]+\.application\.support;/);
  assert.ok(port.includes('default boolean covers(String value)'), port);
  const adapter = read('JwtCallerScope.java');
  assert.ok(adapter.includes(`static final String SCOPING_CLAIM = "${CLAIM}";`), adapter);
  assert.ok(adapter.includes('static final Set<String> EXEMPT_AUTHORITIES = Set.of("ROLE_admin");'), adapter);
  // En el fuente Java son dos barras: la regex es [\s,]+.
  assert.ok(adapter.includes('split("[\\\\s,]+")'), adapter);

  // Y el handler de la operación que declara el error del alcance lo nombra.
  const handler = read('CreateProductCommandHandler.java');
  assert.ok(handler.includes('Alcance (security.authentication.scoping): inyecta CallerScope'), handler);
});

test('sin scoping no se genera ni el puerto ni el adaptador', () => {
  const { manifest, layers } = loadService(fixtureDir);
  const patched = structuredClone(layers);
  patched.security = security({ scoping: false });
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  const dir = tmpDir('keel-scope-none-');
  scaffoldService({ manifest: patchedManifest, layers: patched, workspace: dir, force: true });
  const files = fs.readdirSync(path.join(dir, 'services', 'catalog-spring', 'src/main/java'), { recursive: true }).map(String);
  assert.ok(!files.some((f) => f.endsWith('CallerScope.java')), files.join('\n'));
});
