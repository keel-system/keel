// Un barrido puede tener DOS disparadores: el reloj y una llamada manual.
//
// `resolveRoute` descartaba la ruta de toda operación con `schedule`, incluso cuando
// `api.endpoints` la declaraba explícitamente. El diseño de una corrida real declaraba las dos
// cosas —`schedule: { cron: … }` para la purga diaria y `POST /messages/purge` con su permiso
// `retention:purge` para dispararla a mano— y build se quedaba el scheduler y tiraba el endpoint
// SIN AVISAR. La petición caía entonces en el patrón hermano (`GET /messages/{id}`) y respondía
// 405, tumbando cuatro escenarios; y como nada lo explicaba, el agente de código acabó escribiendo
// el `@PostMapping` a mano — código que el siguiente `build --force` se lleva por delante.
//
// Los dos casos son inseparables y por eso se prueban juntos: con endpoint declarado hay ruta, y
// sin él sigue sin haberla. Lo segundo no es un detalle: la doctrina de que un barrido no se
// alcanza desde fuera sostiene el aviso de `crossrefs.js` y § Lo que no tiene escenario de
// validation-scenarios.md.

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
const SWEEP = 'reconcileWithdrawals';
const ROUTE = '/withdrawals/reconcile';

/** Las capas de la fixture con el barrido expuesto (o no) por un endpoint declarado. */
function layersWith({ endpoint }) {
  const { manifest, layers, errors } = loadService(fixtureDir);
  assert.deepEqual(errors, []);
  const patched = structuredClone(layers);
  // El barrido de la fixture es `internal: true`; lo que se prueba aquí es el efecto de
  // `schedule`, así que se quita la otra causa de exclusión para no medir dos cosas a la vez.
  delete patched['use-cases'].operations[SWEEP].internal;
  assert.ok(patched['use-cases'].operations[SWEEP].schedule, 'la fixture debe seguir declarando schedule');
  if (endpoint) {
    patched.api.endpoints[SWEEP] = { method: 'POST', path: ROUTE, successStatus: 204 };
  }
  return { manifest, layers: patched };
}

const modelFor = (options) => {
  const { manifest, layers } = layersWith(options);
  return buildModel({ manifest, layers, stack: resolveStack({}, layers, manifest) });
};

test('un barrido con endpoint declarado SÍ recibe su ruta', () => {
  const model = modelFor({ endpoint: true });
  const sweep = model.services.flatMap((group) => group.operations).find((operation) => operation.name === SWEEP);
  assert.ok(sweep, `la operación ${SWEEP} no está en el modelo`);
  assert.ok(sweep.route, 'el endpoint declarado manda sobre el schedule');
  assert.equal(sweep.route.method, 'POST');
  assert.equal(sweep.route.path, ROUTE);
  assert.equal(sweep.route.status, 204);
});

test('un barrido SIN endpoint declarado sigue sin ruta', () => {
  // La regresión que hay que no cometer al arreglar lo anterior: inferirle una ruta por convención
  // CRUD o por el fallback POST publicaría al mundo una operación que el diseño no expuso.
  const model = modelFor({ endpoint: false });
  const sweep = model.services.flatMap((group) => group.operations).find((operation) => operation.name === SWEEP);
  assert.ok(sweep, `la operación ${SWEEP} no está en el modelo`);
  assert.equal(sweep.route, null);
});

test('el controller generado trae el mapping del barrido expuesto', () => {
  // El modelo teniendo ruta no basta: `controllers.js` filtra por `operation.route` y es ahí donde
  // el método aparece o no. Se comprueba sobre el árbol generado, que es lo que de verdad compila.
  const { manifest, layers } = layersWith({ endpoint: true });
  const workspace = tmpDir('keel-sweep-route-');
  scaffoldService({ manifest, layers, workspace, force: true });

  const controllersDir = path.join(workspace, 'services', 'catalog-spring', 'src/main/java/com/commerce/catalog/infrastructure/rest/controllers');
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) sources.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(controllersDir);

  const withMapping = sources.filter((source) => source.includes(`@PostMapping("${ROUTE}")`));
  assert.equal(withMapping.length, 1, `esperaba exactamente un controller con ${ROUTE}`);
  assert.match(withMapping[0], new RegExp(`public\\s+\\w+\\s+${SWEEP}\\(`));
});
