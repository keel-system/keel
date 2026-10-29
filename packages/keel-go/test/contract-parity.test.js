// Paridad del CONTRATO HTTP de keel-go con lo que EMITE keel-spring, sin levantar nada: para cada fixture, tal como
// keel-go la genera hoy (sin las capas que su frontera rechaza, y keel-spring sobre el mismo diseño), se extrae la
// tabla de rutas de cada generador —de keel-spring, sus controladores Java (el lector que usan las paridades de
// keel-nest y keel-dotnet); de keel-go, la tabla `routes`, que es el único mapa que registra el ServeMux— y se exige
// que digan lo mismo: método, ruta completa, status de éxito, si hay `Location`, los parámetros de query, si el cuerpo
// es obligatorio u opcional y los campos de cada DTO de respuesta, en orden.
//
// Una operación con un binario (subida multipart) no se sirve todavía: llega con la capa storage (incremento 13).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springRoutes, springDtoFields } from '../../keel-spring/test/helpers/contract-table.js';
import { planService } from '../src/scaffold/index.js';
import { endpointName, servedOperation } from '../src/scaffold/endpoints.js';
import { goFileName, goTypeName } from '../src/scaffold/render.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { goRoutes, goView } from './helpers/contract.js';

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

/** Los campos de un DTO de keel-go, en orden: los nombres del cable de sus tags. */
function goDtoFields(files, name) {
  const file = files.find((f) => f.path === `internal/application/${goFileName(goTypeName(name))}.go`);
  if (!file) return null;
  const type = goTypeName(name);
  const struct = file.content.slice(file.content.indexOf(`type ${type} struct {`), file.content.indexOf('\n}\n', file.content.indexOf(`type ${type} struct {`)));
  return [...struct.matchAll(/`json:"([^",]+)/g)].map((match) => match[1]);
}

for (const name of fixtures) {
  test(`${name}: el contrato HTTP de keel-go es el de keel-spring`, () => {
    const design = goView(name);
    const spring = planSpring({ ...design, workspace: FIXTURES_DIR });
    const go = planService({ ...design, workspace: FIXTURES_DIR });
    const springTable = springRoutes(spring.files);
    const table = goRoutes(go.files);
    const routed = go.model.services.flatMap((service) => service.operations).filter((op) => op.route);
    if (routed.length === 0 || !go.model.layersPresent.api) {
      // Sin API (un consumidor puro): la paridad es que ninguno de los dos expone rutas.
      assert.equal(springTable.size, 0);
      assert.equal(table.size, 0);
      assert.ok(!go.files.some((file) => file.path === 'internal/httpapi/routes.go'));
      return;
    }
    const served = routed.filter(servedOperation);
    assert.deepEqual([...table.keys()], served.map((op) => op.name), 'una fila por operación servida, en el orden del diseño');
    for (const operation of served) {
      const fromSpring = springTable.get(operation.name);
      assert.ok(fromSpring, `keel-spring no expone ${operation.name}`);
      const expected = { ...fromSpring };
      delete expected.multipart;
      const { handle, ...actual } = table.get(operation.name);
      assert.equal(handle, endpointName(operation), `${operation.name}: la fila apunta a su endpoint`);
      assert.match(go.files.find((f) => /^internal\/httpapi\/\w+_endpoints\.go$/.test(f.path) && f.content.includes(`func (a *api) ${handle}(`))?.path ?? '', /_endpoints\.go$/, `${operation.name}: su endpoint existe`);
      assert.deepEqual(actual, expected, operation.name);
      if (operation.responseDto) {
        assert.deepEqual(goDtoFields(go.files, operation.responseDto.name), springDtoFields(spring.files, operation.responseDto.name), operation.responseDto.name);
      }
    }
  });
}
