// Paridad del CONTRATO HTTP entre keel-spring y keel-nest, sin levantar nada: para cada fixture se
// extrae la tabla de rutas de lo que emite cada generador —de keel-spring, sus controladores Java;
// de keel-nest, su `routes.ts`, transpilado y ejecutado— y se exige que digan lo mismo: método,
// ruta completa, status de éxito, si hay `Location`, los parámetros de query, si el cuerpo es
// obligatorio u opcional y los campos de cada DTO de respuesta, en orden.
//
// Fuera, con su motivo escrito: las subidas multipart (llegan con la capa storage, inc. 13) y el
// orden de un listado con persistencia (keel-spring lo recibe en un Pageable con `sort`, keel-nest lo
// trae en el inc. 6).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planFixture, transpileTree } from './helpers/emitted.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { springRoutes, springDtoFields } from '../../keel-spring/test/helpers/contract-table.js';

/**
 * Lo que de verdad sirve Nest: el decorador de ruta y el @HttpCode de cada método de los
 * controladores emitidos, con la base de su @Controller. routes.ts es un dato aparte, así que la
 * tabla tiene que coincidir con esto o el test compararía una copia.
 */
function nestDecorated(files) {
  const routes = new Map();
  for (const file of files.filter((f) => f.path.startsWith('src/infrastructure/rest/controllers/'))) {
    const base = /@Controller\('([^']*)'\)/.exec(file.content)?.[1] ?? '';
    for (const m of file.content.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)\n {2}@HttpCode\((\d+)\)\n {2}async (\w+)\(/g)) {
      const path = `/${base}/${m[2]}`.replace(/:(\w+)/g, '{$1}');
      routes.set(m[4], { method: m[1].toUpperCase(), path, status: Number(m[3]) });
    }
  }
  return routes;
}

/** Los campos de una clase de DTO de keel-nest, en orden. */
function nestDtoFields(files, name) {
  const fileName = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const file = files.find((f) => f.path === `src/application/dtos/${fileName}.ts`);
  if (!file) return null;
  const head = file.content.split('  constructor(')[0];
  return [...head.matchAll(/^ {2}readonly (\w+):/gm)].map((m) => m[1]);
}

for (const name of fs.readdirSync(FIXTURES_DIR)) {
  test(`${name}: el contrato HTTP de keel-nest es el de keel-spring`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
    const nest = planFixture(name);
    const operations = nest.model.services.flatMap((service) => service.operations).filter((op) => op.route);
    const springTable = springRoutes(spring.files);
    if (operations.length === 0 || !nest.model.layersPresent.api) {
      // Sin API (un consumidor puro): la paridad es que ninguno de los dos expone rutas.
      assert.equal(springTable.size, 0);
      // Los mensajes de sus suscripciones se leen con el lector del cable y las reglas de la API
      // (request-reading y request-errors), pero no hay controladores ni rutas.
      const shared = new Set(['src/infrastructure/rest/request-reading.ts', 'src/infrastructure/rest/request-errors.ts']);
      assert.deepEqual(nest.files.filter((file) => file.path.startsWith('src/infrastructure/rest/') && !shared.has(file.path)).map((file) => file.path), []);
      return;
    }
    const tree = transpileTree(nest.files);
    const { ROUTES } = await tree.load('src/infrastructure/rest/routes.ts');
    const nestTable = new Map(ROUTES.map((route) => [route.operation, route]));
    assert.equal(nestTable.size, operations.length, 'una fila por operación con ruta');
    const decorated = nestDecorated(nest.files);
    for (const route of ROUTES) {
      assert.deepEqual(decorated.get(route.operation), { method: route.method, path: route.path, status: route.status }, `${route.operation}: el controlador sirve lo que dice routes.ts`);
    }
    let compared = 0;
    for (const operation of operations) {
      const fromSpring = springTable.get(operation.name);
      const fromNest = nestTable.get(operation.name);
      assert.ok(fromSpring, `keel-spring no expone ${operation.name}`);
      if (fromSpring.multipart) continue;
      const expected = { ...fromSpring };
      delete expected.multipart;
      const actual = { method: fromNest.method, path: fromNest.path, status: fromNest.status, location: fromNest.location, query: [...fromNest.query].sort(), body: fromNest.body };
      assert.deepEqual(actual, expected, operation.name);
      if (operation.responseDto) {
        assert.deepEqual(nestDtoFields(nest.files, operation.responseDto.name), springDtoFields(spring.files, operation.responseDto.name), `${operation.responseDto.name}`);
      }
      compared += 1;
    }
    assert.ok(compared > 0 || operations.length === 0, 'se comparó al menos una operación');
  });
}
