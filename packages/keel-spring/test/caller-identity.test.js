// `security.authentication.callerIdentity` (DSL 2.13): quién pide el trabajo, por la puerta HTTP.
//
// El DSL sabía declararlo para la vía de eventos —`subscriptions.identity`— y daba por resuelto el
// lado HTTP («la pone el proveedor de identidad en un claim del token»). Cuando no lo está —la
// identidad sale del cliente máquina de la credencial—, la resolución acababa en la prosa de una
// `rule`, el campo llegaba del CUERPO (que lo elige quien llama, o sea justo quien no debería) y el
// agente terminaba añadiendo un segundo campo sintético al record del comando… que es un archivo de
// build, así que el siguiente `build --force` se lo llevaba.
//
// Lo que se comprueba aquí es que build cierre las tres puntas: que el campo no se acepte del
// cuerpo, que exista un único punto de resolución, y que el controller lo estampe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { buildModel } from '../src/lib/model.js';
import { scaffoldService, resolveStack } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const fixtureDir = path.join(FIXTURES_DIR, 'catalog-extended');
const OP = 'createProduct';
const FIELD = 'sku';

function layersWith({ callerIdentity = true, source = 'serviceClient' } = {}) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  patched.security = {
    authentication: {
      protocol: 'oidc',
      serviceAuth: { protocol: 'oauth2', audience: 'catalog-api' },
      ...(callerIdentity
        ? {
            callerIdentity: {
              field: FIELD,
              from: source === 'claim' ? { source: 'claim', name: 'tenant' } : { source: 'serviceClient' }
            }
          }
        : {})
    },
    access: { default: { level: 'required' }, rules: { [OP]: { level: 'service', scopes: ['catalog:write'] } } },
    serviceClients: { billing: { scopes: ['catalog:write'] } }
  };
  const patchedManifest = structuredClone(manifest);
  patchedManifest.layers.security = 'security.keel.yaml';
  return { manifest: patchedManifest, layers: patched };
}

function generate(options) {
  const { manifest, layers } = layersWith(options);
  const workspace = tmpDir('keel-calleridentity-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, 'services', 'catalog-spring', 'src/main/java');
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(entry.name, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

test('el campo de identidad no se acepta del cuerpo', () => {
  const files = generate();
  const command = files.get('CreateProductCommand.java');
  assert.ok(command, 'no se generó el comando');

  // Sigue EN el record —el handler necesita la identidad— pero no es bindeable ni sale en el
  // contrato de entrada. Quitarlo del record dejaría al handler sin el dato.
  assert.match(command, new RegExp(`@JsonIgnore\\s+\\S+\\s+${FIELD}`), 'el campo sigue llegando del cuerpo');
  assert.match(command, /La resuelve el servidor desde la credencial/);
});

test('hay un único punto de resolución, y lo usa el controller', () => {
  // La costura de un solo punto es lo que hace barato cambiar de mecanismo: pasar de la credencial
  // a un claim son dos líneas y no toca dominio, casos de uso ni esquema.
  const files = generate();
  assert.ok(files.has('CallerIdentity.java'), 'no se generó el resolutor');

  const controller = [...files.entries()].find(([name]) => name.endsWith('V1Controller.java'))?.[1];
  assert.match(controller, /CallerIdentity\.resolve\(\)/, 'el controller no estampa la identidad');
  assert.match(controller, /import .*configurations\.security\.CallerIdentity;/);
});

// ─── La operación que además tiene parámetros de ruta ────────────────────────
//
// El caso de arriba afirma sobre el PRIMER *V1Controller.java que encuentra, y por ahí se coló el
// defecto: en `catalog-extended` esa operación no tiene ruta, así que la rama que estampa la
// identidad era la que se ejercitaba. Con cuerpo Y parámetros de ruta gana la rama que fusiona la
// ruta, y esa leía el campo del comando — donde SIEMPRE es null, porque lleva @JsonIgnore. El
// servicio se quedaba sin saber quién llama y respondía 403 en el camino feliz.
//
// El sujeto es `notification-mailer` sin parchear: ya declara `callerIdentity`, y su
// `registerTemplate` es PUT /v1/templates/{templateKey}/{locale} — cuerpo y dos parámetros de
// ruta. Su gemelo `requestNotification` (POST, sin ruta) sirve de control: si algún día fallaran
// los dos, el defecto sería otro.

function generateMailer() {
  const dir = path.join(FIXTURES_DIR, 'notification-mailer');
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-calleridentity-ruta-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, result.outDir, 'src/main/java');
  const files = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(entry.name, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

// ─── Una credencial o varias (`resolvedBy`) ─────────────────────────────────
//
// Por defecto la correspondencia credencial↔recurso es 1:1 y el DSL lo dice: la entrada de
// `serviceClients` ES el identificador del recurso. Cuando NO lo es —un sistema con su
// credencial de envío y la de su pipeline, las dos hacia la misma Application—, la relación
// vivía solo en la `description` de un campo, que no es estructura y nadie puede leer.
//
// Lo que producía: el puerto solo ofrecía el finder de la clave natural, el agente buscaba por
// ahí, y toda credencial que no coincidiera con ella no resolvía a ningún recurso. 403 en el
// camino feliz, en la puerta de entrada. Costó nueve escenarios y cinco clases enteras.

test('con resolvedBy, build da el finder por colección y lo dice en el stub', () => {
  const files = generateMailer();

  const port = files.get('ApplicationRepository.java');
  assert.match(port, /Optional<Application> findByCredentialKeysContaining\(/, 
    'el puerto no ofrece cómo resolver una credencial que no es la clave natural');
  assert.match(files.get('ApplicationJpaRepository.java'), /findByCredentialKeysContaining\(/);
  assert.match(files.get('ApplicationRepositoryImpl.java'), /findByCredentialKeysContaining\(/);

  // Y la nota, que es la mitad que cierra el círculo: sin ella el método existe y nadie sabe
  // que hace falta, porque el valor que llega PARECE una clave natural.
  const command = files.get('RequestNotificationCommand.java');
  assert.ok(command.includes('YA resuelta a la clave natural de Application (key)'), 'la nota del comando no dice que llega resuelta');
  assert.match(command, /findByCredentialKeysContaining/);
});

// ─── Resuelta en la PUERTA, igual por las dos ───────────────────────────────
//
// Hasta la corrida notification-mailer R8, con `resolvedBy` build metía el client_id en crudo en
// `applicationKey` —que el diseño define como la clave de Application— mientras la nota del
// listener decía que por eventos llegaba ya resuelto: la misma operación recibía dos cosas según
// la puerta, y el agente reescribió el handler para buscar por las dos. Ahora las dos resuelven.

test('con resolvedBy, CallerIdentity resuelve la credencial a la clave natural', () => {
  const files = generateMailer();
  const identity = files.get('CallerIdentity.java');
  assert.match(identity, /@Component\s+public class CallerIdentity/, 'CallerIdentity no es un bean');
  assert.ok(identity.includes('applicationRepository.findByCredentialKeysContaining(credential())'));
  assert.ok(identity.includes('.map(Application::getKey)'), 'no devuelve la clave natural');
  // El recurso inexistente es precondición de la OPERACIÓN (APPLICATION_INACTIVE, con su
  // precedencia): un 403 genérico aquí taparía el código que el diseño pide.
  assert.ok(identity.includes('.orElse(null)'));
  assert.ok(!identity.includes('AccessDeniedException'));

  const controller = files.get('NotificationV1Controller.java');
  assert.ok(controller.includes('public NotificationV1Controller(UseCaseMediator mediator, CallerIdentity callerIdentity)'));
  assert.ok(!controller.includes('CallerIdentity.resolve()'), 'el controller sigue usando la credencial cruda');

  // Y el listener dice lo mismo: pasa la clave natural, no la credencial.
  const listenerNote = [...files.values()].find((c) => c.includes('resolvedBy: Application.credentialKeys') && c.includes('onUnresolved')) ?? '';
  assert.match(listenerNote, /se le pasa la CLAVE NATURAL del Application/, 'la nota del listener no dice qué pasa al comando');
});

test('sin resolvedBy CallerIdentity sigue siendo estático y el controller no lo inyecta', () => {
  const files = generate();
  const identity = files.get('CallerIdentity.java');
  assert.ok(identity, 'la fixture de control no tiene identidad del llamante');
  assert.match(identity, /public final class CallerIdentity/);
  assert.ok(identity.includes('public static String resolve()'));
  const controllers = [...files.entries()].filter(([name]) => name.endsWith('V1Controller.java')).map(([, c]) => c);
  assert.ok(controllers.every((c) => !c.includes('CallerIdentity callerIdentity')));
});

test('y la rama DOCUMENTAL lo implementa igual: el puerto es el mismo', () => {
  // Lo cazó `compile-check` y no esta suite: el puerto es compartido por los dos modelos, así
  // que declarar el método y no implementarlo en una rama deja ese adaptador SIN COMPILAR. La
  // regla ya estaba escrita en document-repositories.js —«lo que se declare allí hay que
  // implementarlo aquí»— y aun así se me pasó, que es justo el argumento para tener el caso.
  const dir = path.join(FIXTURES_DIR, 'notification-mailer-mongo');
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-calleridentity-doc-');
  const result = scaffoldService({ manifest, layers, workspace, stack: { database: 'mongodb' }, force: true });
  const root = path.join(workspace, result.outDir, 'src/main/java/com/platform/notificationmailermongo');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  assert.match(read('domain/repository/ApplicationRepository.java'), /findByCredentialKeysContaining\(/);
  assert.match(read('infrastructure/persistence/repositories/ApplicationMongoRepository.java'), /findByCredentialKeysContaining\(/);
  assert.match(read('infrastructure/persistence/repositories/ApplicationRepositoryImpl.java'), /findByCredentialKeysContaining\(/);
});

test('y sin resolvedBy no se emite nada de eso', () => {
  // La mitad negativa. Un finder por colección en todos los agregados deja de significar algo, y
  // la nota sobre un diseño 1:1 sería una instrucción falsa.
  const port = generate().get('ProductRepository.java');
  assert.ok(port && !port.includes('Containing('), 'se emitió el finder sin que el diseño lo pidiera');
});

test('con parámetros de ruta la identidad SIGUE saliendo del token', () => {
  const controller = generateMailer().get('TemplateV1Controller.java');
  assert.ok(controller, 'no se generó el controller de la operación con ruta');

  // El registro de plantilla fusiona {templateKey} y {locale} con el cuerpo. La identidad no es
  // ninguno de los dos: la pone el servidor.
  assert.match(controller, /callerIdentity.resolve()/, 'la identidad se lee del cuerpo, donde es null');
  assert.match(controller, /import .*configurations.security.CallerIdentity;/);

  // Y no se lee del comando: es la mitad que distingue el arreglo de un import decorativo.
  assert.ok(
    !controller.includes('command.applicationKey()'),
    'el controller sigue leyendo la identidad del comando, que lleva @JsonIgnore y es null'
  );
});

test('y el control sin ruta sigue igual', () => {
  const controller = generateMailer().get('NotificationV1Controller.java');
  assert.match(controller, /callerIdentity.resolve()/);
});

// ─── Un POST cuyo único campo fuera de la ruta es la identidad ──────────────
//
// `publishTemplate` es POST /v1/templates/{templateId}/publish: su entrada es `templateId` (ruta) y
// `applicationKey` (la identidad). No queda nada que leer del cuerpo, y el controller declaraba igual
// `@Valid @RequestBody`: la petición correcta según el diseño —sin cuerpo— respondía 400 antes de
// llegar al mediator. Tumbó 3 escenarios y dejó 14 sin ejercitar en la corrida de la v2.0.0.

test('sin nada que leer del cuerpo, un POST no declara @RequestBody', () => {
  const controller = generateMailer().get('TemplateV1Controller.java');
  // La firma hasta la llave: los `@Size(max = 64)` de los parámetros cierran paréntesis antes.
  const signature = (name) => new RegExp(`${name}\\([\\s\\S]*?\\)\\s*\\{`).exec(controller)?.[0];
  const method = signature('publishTemplate');
  assert.ok(method, 'no se generó el endpoint de publicación');
  assert.ok(!method.includes('@RequestBody'), `el POST sin cuerpo exige uno (${method})`);

  const dispatch = /new PublishTemplateCommand\([^)]*\)/.exec(controller)?.[0];
  assert.ok(dispatch, 'no se construye el comando desde la ruta');
  assert.ok(dispatch.includes('callerIdentity.resolve()'), `la publicación no recibe la identidad (${dispatch})`);
  assert.ok(dispatch.includes('templateId'), `la publicación no recibe la ruta (${dispatch})`);

  // El control: el registro de plantilla (PUT con cuerpo y ruta) sigue leyendo su cuerpo.
  assert.match(signature('registerTemplate') ?? '', /@RequestBody/);
});

// ─── La operación de LECTURA ────────────────────────────────────────────────
//
// La tercera rama del controller, y la última que no lo miraba: los verbos SIN cuerpo. Ahí los
// campos del input salen como `@RequestParam`, y el de la identidad salía con ellos — o sea, la
// identidad elegida por quien hace la petición. En una lectura eso no es un 403 en el camino
// feliz como en los comandos: es leer los datos de OTRO inquilino poniendo su clave en la URL, y
// el servidor responde 200.
//
// No lo vio ninguna suite porque ninguna fixture tenía una query cuyo input llevara el campo de
// la identidad. Lo destapó la corrida de evolución de `notification-mailer`, donde
// `listTemplateVersions` estrenó esa combinación; el sujeto de aquí es sintético por lo mismo que
// en los demás casos de este archivo: el diseño se parchea en memoria.

function generateWithQuery({ field = FIELD } = {}) {
  const { manifest, layers } = layersWith();
  const patched = structuredClone(layers);
  patched['use-cases'].operations.listTenantProducts = {
    description: 'Lista los productos del inquilino del token.',
    kind: 'query',
    input: { fields: { [field]: { type: 'string', required: true }, category: { type: 'string', required: true } } },
    output: { entity: 'Product', list: true }
  };
  patched.api.endpoints.listTenantProducts = { method: 'GET', path: '/products/by-tenant' };
  patched.security.access.rules.listTenantProducts = { level: 'service', scopes: ['catalog:write'] };

  const workspace = tmpDir('keel-calleridentity-query-');
  const result = scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, result.outDir, 'src/main/java');
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(entry.name, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

test('en una QUERY la identidad tampoco se acepta de la query string', () => {
  const files = generateWithQuery();
  const controller = [...files.entries()].find(([name]) => name.endsWith('V1Controller.java'))?.[1];
  const method = /listTenantProducts\([^)]*\)/.exec(controller)?.[0];
  assert.ok(method, 'no se generó el endpoint de lectura');

  assert.ok(
    !new RegExp(`@RequestParam[^)]*\\b${FIELD}\\b`).test(method),
    `la identidad viaja como @RequestParam: quien llama elegiría de qué inquilino lee (${method})`
  );
  // Y se afirma sobre el DESPACHO de esta operación, no sobre el controller entero: ahí hay otra
  // que ya estampa la identidad, así que un `includes` a secas saldría verde con la lectura rota.
  const dispatch = /new ListTenantProductsQuery\([^)]*\)/.exec(controller)?.[0];
  assert.ok(dispatch, 'no se despacha la query');
  assert.ok(dispatch.includes('CallerIdentity.resolve()'), `la lectura no recibe la identidad del token (${dispatch})`);

  // El control: un filtro normal SÍ sigue siendo un @RequestParam. Sin esta mitad, quitar todos
  // los parámetros de la query pasaría el caso de arriba y rompería el endpoint entero.
  assert.match(method, /@RequestParam\b[^,)]*\bcategory\b/, 'el filtro normal dejó de viajar en la query');
});

test('con source serviceClient la identidad sale del cliente de la credencial', () => {
  const resolver = generate().get('CallerIdentity.java');
  // `azp` es el de Keycloak y `client_id` el de otros proveedores: mirar solo uno deja el resolutor
  // devolviendo null contra la mitad de los emisores, y el síntoma es un 403 sin explicación.
  assert.match(resolver, /getClaimAsString\("azp"\)/);
  assert.match(resolver, /getClaimAsString\("client_id"\)/);
  // Y no se sigue con la identidad vacía: escribir a nombre de nadie es peor que fallar.
  assert.match(resolver, /throw new IllegalStateException/);
});

test('con source claim sale del claim que el diseño nombra', () => {
  const resolver = generate({ source: 'claim' }).get('CallerIdentity.java');
  assert.match(resolver, /getClaimAsString\("tenant"\)/);
  assert.ok(!resolver.includes('"azp"'), 'no debe mirar el cliente cuando el diseño dice el claim');
});

test('sin callerIdentity nada cambia', () => {
  // La ausencia es el caso mayoritario: un servicio cuya identidad no acota nada no necesita ni el
  // resolutor ni que ningún campo deje de viajar en el cuerpo.
  const files = generate({ callerIdentity: false });
  assert.ok(!files.has('CallerIdentity.java'));
  assert.ok(!files.get('CreateProductCommand.java').includes('@JsonIgnore'));
});

test('el modelo expone la política ya resuelta', () => {
  const { manifest, layers } = layersWith();
  const model = buildModel({ manifest, layers, stack: resolveStack({}, layers, manifest) });
  // `resolvedBy` en null es la correspondencia 1:1, que es la de por defecto: una credencial, un
  // recurso. Se afirma explícitamente porque su ausencia y su presencia generan cosas distintas.
  assert.deepEqual(model.security.callerIdentity, {
    field: FIELD,
    source: 'serviceClient',
    claim: null,
    resolvedBy: null
  });
});

// ─── DSL 2.17: los dos ámbitos que eran prosa (hallazgos 1 y 9 de R9) ──────────────
//
// Sobre el par del MVP, que es quien los declara: el emisor por el broker se resuelve contra
// Application.credentialKeys como la credencial por HTTP, y la Idempotency-Key se acota a la
// aplicación del llamante.

function scaffoldMailer() {
  const dir = path.join(FIXTURES_DIR, 'notification-mailer');
  const { manifest, layers, errors } = loadService(dir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-scope-');
  scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, 'services', 'notification-mailer-spring');
  const walk = (current) =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(current, entry.name)) : [path.join(current, entry.name)]
    );
  const files = walk(root);
  const find = (suffix) => fs.readFileSync(files.find((file) => file.endsWith(suffix)), 'utf8');
  return { layers, find };
}

test('DSL 2.17: el listener nombra contra qué se resuelve el emisor, con el finder de la puerta HTTP', () => {
  const { find } = scaffoldMailer();
  const listener = find('NotificationRequestedMessage.java');
  assert.match(listener, /resolvedBy: Application\.credentialKeys/);
  assert.match(listener, /ApplicationRepository\.findByCredentialKeysContaining\(\.\.\.\)/);
  // El finder existe, y uno solo aunque lo pidan las dos puertas.
  const port = find('ApplicationRepository.java');
  assert.equal(port.match(/findByCredentialKeysContaining\(/g).length, 1, port);
});

test('DSL 2.17: sin resolvedBy en el broker, el listener dice que la resolución es 1:1', () => {
  const dir = path.join(FIXTURES_DIR, 'notification-mailer');
  const { manifest, layers } = loadService(dir);
  const patched = structuredClone(layers);
  delete patched.messaging.subscriptions.NotificationRequested.identity.resolvedBy;
  const workspace = tmpDir('keel-scope-');
  scaffoldService({ manifest, layers: patched, workspace, force: true });
  const root = path.join(workspace, 'services', 'notification-mailer-spring');
  const walk = (current) =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(current, entry.name)) : [path.join(current, entry.name)]
    );
  const listener = fs.readFileSync(walk(root).find((file) => file.endsWith('NotificationRequestedMessage.java')), 'utf8');
  assert.match(listener, /Se resuelve 1:1/);
  assert.doesNotMatch(listener, /findByCredentialKeysContaining/);
});

test('DSL 2.17: el comando trae su ámbito de idempotencia ya compuesto con partitionBy', () => {
  const { find } = scaffoldMailer();
  const command = find('RequestNotificationCommand.java');
  assert.ok(command.includes('public String idempotencyScope() {'), command);
  assert.ok(command.includes('return "requestNotification" + ":" + String.valueOf(applicationKey);'), command);
  // Y la nota del handler lo usa en vez de un literal con el nombre de la operación.
  const handler = find('RequestNotificationCommandHandler.java');
  assert.ok(handler.includes('command.idempotencyScope()'), handler);
  assert.ok(!handler.includes('scope="requestNotification"'));
});

// ─── tokenAs: personas con sub y claims propios ──────────────────────────────────
// Con la identidad en el claim `sub`, los escenarios nombran titulares («el perfil de
// sub-ana-001», «su token sin email») y tokenFor(rol) no los puede dar: su sub es el id aleatorio
// del usuario del rol. Hasta la corrida user-profile (2026-10-01) lo escribía el agente de pruebas
// a mano. El sujeto es la fixture profile-directory, que compile-check compila.

const profileDir = path.join(FIXTURES_DIR, 'profile-directory');

function renderProfile({ auth = 'keycloak', patch = (layers) => layers } = {}) {
  const { manifest, layers, errors } = loadService(profileDir);
  assert.deepEqual(errors, []);
  const workspace = tmpDir('keel-persona-');
  scaffoldService({
    manifest,
    layers: patch(structuredClone(layers)),
    workspace,
    force: true,
    stack: { database: 'postgresql', auth }
  });
  const root = path.join(workspace, 'services', 'profile-directory-spring');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  return {
    harness: read('src/integrationTest/java/com/identity/profiledirectory/flows/AbstractFlowIT.java'),
    credentials: read('infra/test-credentials.env')
  };
}

test('con la identidad en el claim sub, el arnés ofrece tokenAs y sus credenciales de administración', () => {
  const { harness, credentials } = renderProfile();
  assert.match(harness, /protected String tokenAs\(String sub, Map<String, String> claims\)/);
  assert.match(harness, /protected String tokenAs\(String sub, String role, Map<String, String> claims\)/);
  // El alta por partialImport es lo que hace que el sub sea el pedido: POST /users lo ignora.
  assert.match(harness, /"\/partialImport"/);
  assert.match(harness, /Keycloak no respetó el id pedido/);
  assert.match(credentials, /^AUTH_ADMIN_USER=admin$/m);
  assert.match(credentials, /^AUTH_ADMIN_PASSWORD=admin$/m);
});

test('sin identidad por claim no se emite: tokenFor sigue siendo lo único', () => {
  const { harness, credentials } = renderProfile({
    patch: (layers) => {
      delete layers.security.authentication.callerIdentity;
      for (const op of Object.values(layers['use-cases'].operations)) delete op.input.fields.callerSubject;
      return layers;
    }
  });
  assert.ok(!/tokenAs/.test(harness), 'emite tokenAs sin identidad por claim');
  assert.match(harness, /protected String tokenFor\(String role\)/);
  assert.ok(!/AUTH_ADMIN_USER/.test(credentials), 'expone credenciales de administración sin necesitarlas');
});

test('con Cognito no se emite: el emulador no fija claims por petición', () => {
  const { harness } = renderProfile({ auth: 'cognito' });
  assert.ok(!/tokenAs/.test(harness), 'emite tokenAs contra un emulador que no puede servirlo');
});
