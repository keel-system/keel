// Rasgos de la API que emite keel-dotnet, sin SDK: lo que la compilación no juzga y la prueba emitida solo ve en
// la fixture de referencia. La lectura EJECUTADA está en scripts/probes/RestProbes y las pruebas emitidas
// (ApiTests.cs), que corren en `npm run cs-check`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { ERROR_BASES } from 'keel-core/gen/error-bases';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { apiCases as nestApiCases } from '../../keel-nest/src/scaffold/api-tests.js';
import { apiCases } from '../src/scaffold/api-tests.js';
import { servedOperation } from '../src/scaffold/endpoints.js';
import { planFixture, fixtureNames, FIXTURES_DIR } from './helpers/workspace.js';

const file = (files, suffix) => files.find((f) => f.path.endsWith(suffix))?.content;

test('ErrorResponse lleva las claves del cable, en su orden, y ninguna se omite', async () => {
  const { files } = await planFixture('product-catalog');
  const content = file(files, '/Rest/ErrorResponse.cs');
  assert.deepEqual([...content.matchAll(/\[JsonPropertyName\("(\w+)"\)\]/g)].map((m) => m[1]), WIRE_SHAPES.errorResponse);
  assert.doesNotMatch(content, /^\[OmitNulls\]/m);
});

test('el arranque abre la correlación antes del manejo de errores, y las rutas salen de un solo mapa', async () => {
  const { files } = await planFixture('product-catalog');
  const program = file(files, '/Program.cs');
  const order = ['UseMiddleware<CorrelationMiddleware>', 'UseMiddleware<ApiErrorMiddleware>', 'MapHealthEndpoints', 'MapApiRoutes'].map((call) => program.indexOf(call));
  assert.ok(order.every((at) => at > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal((program.match(/Map(Get|Post|Put|Patch|Delete|Methods)\(/g) ?? []).length, 0, 'ninguna ruta del diseño fuera de ApiRoutes');
});

test('sin API no se emite nada de la entrada HTTP', async () => {
  const { files } = await planFixture('product-catalog', {
    mutate: (manifest, layers) => {
      delete manifest.layers.api;
      delete layers.api;
    }
  });
  assert.deepEqual(files.filter((f) => /\/(Rest|Endpoints)\/|ApiTests\.cs$/.test(f.path)).map((f) => f.path), []);
  assert.doesNotMatch(file(files, '/Program.cs'), /CorrelationMiddleware|MapApiRoutes/);
});

test('el manejador de errores traduce cada clase base de la jerarquía con su status', async () => {
  const { files } = await planFixture('product-catalog');
  const middleware = file(files, '/Rest/ApiErrorMiddleware.cs');
  for (const { name, http } of ERROR_BASES) assert.match(middleware, new RegExp(`${name} => Domain\\(${http}, `), name);
});

test('una operación de una capa que aún no se sirve (subida, identidad del llamante) no tiene ruta', async () => {
  const { model, files } = await planFixture('notification-mailer');
  const routes = file(files, '/Rest/ApiRoutes.cs');
  for (const operation of model.services.flatMap((s) => s.operations).filter((op) => op.route)) {
    assert.equal(routes.includes(`new("${operation.name}"`), servedOperation(operation), operation.name);
  }
});

for (const name of fixtureNames()) {
  test(`${name}: la prueba emitida pide las mismas peticiones que la de keel-nest`, async () => {
    const { model } = await planFixture(name);
    const routed = model.services.flatMap((s) => s.operations).filter((op) => op.route);
    // Donde keel-dotnet todavía no sirve alguna operación, sus casos se eligen sobre las que sí: no son comparables.
    if (routed.length === 0 || !routed.every(servedOperation)) return;
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const nest = planNest({ manifest, layers, workspace: FIXTURES_DIR });
    const fromNest = nestApiCases(nest.model);
    delete fromNest.upload;
    const fromDotnet = apiCases(model);
    // Con persistencia keel-nest lee la página como un Pageable (incremento 6 en keel-dotnet): la operación que
    // llega al handler puede ser otra. Lo demás no depende de ello.
    if (model.layersPresent.persistence) {
      delete fromNest.reachesHandler;
      delete fromDotnet.reachesHandler;
    }
    assert.deepEqual(fromDotnet, fromNest);
  });
}

test('la prueba emitida de la referencia ejercita los cinco caminos del contrato, además del 404 y la correlación', async () => {
  const { model, files } = await planFixture('product-catalog', { mutate: (manifest) => delete manifest.layers.persistence });
  assert.deepEqual(Object.keys(apiCases(model)).sort(), ['invalidBody', 'malformedBody', 'malformedPath', 'reachesHandler', 'wrongMethod']);
  const emitted = file(files, '/ApiTests.cs');
  assert.equal((emitted.match(/^ {4}\[Fact\]/gm) ?? []).length, 7);
});
