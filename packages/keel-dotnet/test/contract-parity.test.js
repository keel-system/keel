// Paridad del CONTRATO HTTP de keel-dotnet con lo que EMITE keel-spring, sin levantar nada: para cada fixture se
// extrae la tabla de rutas de cada generador —de keel-spring, sus controladores Java (el mismo lector que usa la
// paridad de keel-nest); de keel-dotnet, la tabla ApiRoutes, que es el único mapa de rutas que registra— y se
// exige que digan lo mismo: método, ruta completa, status de éxito, si hay `Location`, los parámetros de query, si
// el cuerpo es obligatorio u opcional y los campos de cada DTO de respuesta, en orden.
//
// Fuera, con su motivo escrito:
//   · las subidas multipart (capa storage, incremento 13) y las operaciones con la identidad del llamante (capa
//     security, incremento 8): keel-dotnet aún no las sirve, y la frontera rechaza los diseños que las declaran;
//   · el `sort` de un listado paginado de un diseño DOCUMENTAL: keel-spring lo lee como Pageable y keel-dotnet no
//     persiste en documentos hasta el incremento 12 (la frontera lo rechaza), así que ahí lee page y size.
//
// La query de un listado paginado se compara entera: con persistencia, los dos leen el Pageable de Spring Data (page,
// size y sort); sin ella, page y size.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from 'keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { springRoutes, springDtoFields } from '../../keel-spring/test/helpers/contract-table.js';
import { planFixture, fixtureNames, FIXTURES_DIR } from './helpers/workspace.js';
import { servedOperation } from '../src/scaffold/endpoints.js';
import { dotnetRoutes } from './helpers/contract.js';

/** Los campos de un DTO de keel-dotnet, en orden: los nombres del cable de sus [JsonPropertyName]. */
function dotnetDtoFields(files, name) {
  const file = files.find((f) => f.path.endsWith(`/Dtos/${name}.cs`));
  if (!file) return null;
  return [...file.content.matchAll(/\[JsonPropertyName\("(\w+)"\)\]/g)].map((m) => m[1]);
}

for (const name of fixtureNames()) {
  test(`${name}: el contrato HTTP de keel-dotnet es el de keel-spring`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const spring = planSpring({ manifest, layers, workspace: FIXTURES_DIR });
    const dotnet = await planFixture(name);
    const springTable = springRoutes(spring.files);
    const routed = dotnet.model.services.flatMap((service) => service.operations).filter((op) => op.route);
    const table = dotnetRoutes(dotnet.files);
    if (routed.length === 0 || !dotnet.model.layersPresent.api) {
      // Sin API (un consumidor puro): la paridad es que ninguno de los dos expone rutas.
      assert.equal(springTable.size, 0);
      assert.equal(table.size, 0);
      assert.deepEqual(dotnet.files.filter((file) => /\/(Rest|Endpoints)\//.test(file.path)).map((file) => file.path), []);
      return;
    }
    const served = routed.filter(servedOperation);
    assert.deepEqual([...table.keys()], served.map((op) => op.name), 'una fila por operación servida, en el orden del diseño');
    // Cada fila apunta a un endpoint que existe, en el archivo de su grupo.
    for (const [operation, row] of table) {
      const file = dotnet.files.find((f) => f.path.endsWith(`/Endpoints/${row.handler.className}.cs`));
      assert.ok(file?.content.includes(`public static async Task ${row.handler.method}(HttpContext http)`), `${operation}: su endpoint existe`);
    }
    let compared = 0;
    for (const operation of served) {
      const fromSpring = springTable.get(operation.name);
      assert.ok(fromSpring, `keel-spring no expone ${operation.name}`);
      const expected = { ...fromSpring };
      delete expected.multipart;
      const { handler, ...actual } = table.get(operation.name);
      if (operation.paginated && dotnet.model.persistenceKind === 'document') expected.query = expected.query.filter((q) => q !== 'sort');
      assert.deepEqual(actual, expected, operation.name);
      if (operation.responseDto) {
        assert.deepEqual(dotnetDtoFields(dotnet.files, operation.responseDto.name), springDtoFields(spring.files, operation.responseDto.name), operation.responseDto.name);
      }
      compared += 1;
    }
    assert.ok(compared > 0 || served.length === 0, 'se comparó al menos una operación');
  });
}
