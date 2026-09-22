// Lo que el perfil `develop` exige sin default, lo tiene que dar el compose de `deploy/`.
//
// La app de `deploy/docker-compose.yaml` corre con `PROFILE: develop`, y ese perfil declara a
// propósito algunas variables SIN default (`${X}`, sin `:`): un valor vacío no fallaría, operaría
// mal —una URL pública rota, un CORS abierto a nadie—, así que es mejor no arrancar. La otra mitad
// de esa decisión es que `deploy/` las ponga TODAS, o el contenedor muere al arrancar con un
// «Could not resolve placeholder» que solo ve quien levanta el stack a mano.
//
// Existe porque pasó: `storage.public-base-url: ${STORAGE_PUBLIC_BASE_URL}` llevaba tiempo en
// `develop` y `appEnvironment()` no la ponía. El javadoc de esa función describía exactamente
// este caso y ningún test cruzaba los dos artefactos, así que la validación manual del catalog
// del registry fue la primera en arrancar el contenedor con un bucket público.
//
// Es un cruce genérico a propósito: la lista no se escribe, sale de los fragmentos. La siguiente
// variable obligatoria que alguien añada a `develop` lo pone en rojo sin tocar este archivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { tmpDir } from './helpers/tmp.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = fs.readdirSync(fixturesDir).filter((name) => fs.existsSync(path.join(fixturesDir, name, 'service.keel.yaml')));

// Las variantes de stack que cambian lo que `develop` pide: el proveedor de identidad y el
// almacén (S3 real no tiene endpoint en el compose, MinIO sí).
const STACKS = [null, { auth: 'cognito', storage: 's3' }];

// `${NOMBRE}` sin `:` —sin default—. Las de la forma `${NOMBRE:valor}` las resuelve Spring.
const REQUIRED = /\$\{([A-Z][A-Z0-9_]*)\}/g;

function requiredByDevelop(files) {
  const required = new Map();
  for (const file of files) {
    const developFragment = file.path.startsWith('src/main/resources/parameters/develop/');
    if (!developFragment && file.path !== 'src/main/resources/application-develop.yaml') continue;
    for (const [, name] of String(file.content).matchAll(REQUIRED)) required.set(name, file.path);
  }
  return required;
}

for (const fixture of fixtures) {
  for (const stack of STACKS) {
    test(`deploy: la app recibe todo lo que develop exige sin default (${fixture}${stack ? `, ${JSON.stringify(stack)}` : ''})`, () => {
      const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
      assert.deepEqual(errors, []);
      const { files } = planService({ manifest, layers, workspace: tmpDir('deploy-env-'), stack });

      const compose = YAML.parse(files.find((file) => file.path === 'deploy/docker-compose.yaml').content);
      const environment = compose.services.app.environment ?? {};
      const missing = [...requiredByDevelop(files)].filter(([name]) => !(name in environment));

      assert.deepEqual(
        missing.map(([name, from]) => `${name} (de ${from})`),
        [],
        'develop declara estas variables sin default y deploy/ no se las da a la app: el contenedor no arrancará'
      );

      // Y si el compose la pasa por interpolación, el .env tiene que traerla: `${X}` sin valor
      // en .env llega como cadena vacía, que es justo lo que el «sin default» quería evitar.
      const env = files.find((file) => file.path === 'deploy/.env').content;
      for (const [name, value] of Object.entries(environment)) {
        const interpolated = /^\$\{([A-Z0-9_]+)\}$/.exec(String(value));
        if (!interpolated || !requiredByDevelop(files).has(name)) continue;
        assert.match(env, new RegExp(`^${interpolated[1]}=.+$`, 'm'), `${interpolated[1]} sin valor en deploy/.env`);
      }
    });
  }
}
