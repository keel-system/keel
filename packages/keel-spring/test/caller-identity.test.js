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
  assert.deepEqual(model.security.callerIdentity, { field: FIELD, source: 'serviceClient', claim: null });
});
