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

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-extended');
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
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notification-mailer');
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
  assert.match(command, /client_id, NO la clave natural de Application/);
  assert.match(command, /findByCredentialKeysContaining/);
});

test('y la rama DOCUMENTAL lo implementa igual: el puerto es el mismo', () => {
  // Lo cazó `compile-check` y no esta suite: el puerto es compartido por los dos modelos, así
  // que declarar el método y no implementarlo en una rama deja ese adaptador SIN COMPILAR. La
  // regla ya estaba escrita en document-repositories.js —«lo que se declare allí hay que
  // implementarlo aquí»— y aun así se me pasó, que es justo el argumento para tener el caso.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notification-mailer-mongo');
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
  assert.match(controller, /CallerIdentity.resolve()/, 'la identidad se lee del cuerpo, donde es null');
  assert.match(controller, /import .*configurations.security.CallerIdentity;/);

  // Y no se lee del comando: es la mitad que distingue el arreglo de un import decorativo.
  assert.ok(
    !controller.includes('command.applicationKey()'),
    'el controller sigue leyendo la identidad del comando, que lleva @JsonIgnore y es null'
  );
});

test('y el control sin ruta sigue igual', () => {
  const controller = generateMailer().get('NotificationV1Controller.java');
  assert.match(controller, /CallerIdentity.resolve()/);
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
