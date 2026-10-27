// El `openapi.yaml` DERIVADO del modelo neutral (keel-core/gen/openapi.js): el mismo documento que escriben
// keel-spring y keel-nest, byte a byte, porque los tres servidores sirven ese contrato. Y lo que dice de cada ruta
// es lo que keel-dotnet REGISTRA (la tabla ApiRoutes): un documento idéntico que describiera otra API no valdría.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import YAML from 'yaml';
import { loadService } from '@keel-system/keel-core';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planFixture, fixtureNames, FIXTURES_DIR } from './helpers/workspace.js';
import { dotnetRoutes } from './helpers/contract.js';

const DOC = 'docs/openapi.yaml';

for (const name of fixtureNames()) {
  test(`${name}: el openapi derivado es el de keel-spring y keel-nest, y describe las rutas que registra keel-dotnet`, async () => {
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, name));
    const fromSpring = planSpring({ manifest, layers, workspace: FIXTURES_DIR }).files.find((f) => f.path === DOC)?.content;
    const fromNest = planNest({ manifest, layers, workspace: FIXTURES_DIR }).files.find((f) => f.path === DOC)?.content;
    const dotnet = await planFixture(name);
    const fromDotnet = dotnet.files.find((f) => f.path === DOC)?.content;
    assert.equal(fromDotnet, fromSpring);
    assert.equal(fromDotnet, fromNest);
    if (!fromDotnet) return;
    const document = YAML.parse(fromDotnet);
    for (const [operation, row] of dotnetRoutes(dotnet.files)) {
      const described = document.paths?.[row.path]?.[row.method.toLowerCase()];
      assert.ok(described, `${operation}: ${row.method} ${row.path} está en el documento`);
      assert.equal(described.operationId, operation);
      assert.ok(described.responses?.[String(row.status)], `${operation}: el documento declara su ${row.status}`);
    }
  });
}
