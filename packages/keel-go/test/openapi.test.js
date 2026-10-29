// El `openapi.yaml` DERIVADO del modelo neutral (keel-core/gen/openapi.js): el mismo documento que escriben keel-spring,
// keel-nest y keel-dotnet, byte a byte, porque los cuatro servidores sirven ese contrato. Y lo que dice de cada ruta es
// lo que keel-go REGISTRA (la tabla `routes`): un documento idéntico que describiera otra API no valdría.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { planService as planSpring } from '../../keel-spring/src/scaffold/index.js';
import { planService as planNest } from '../../keel-nest/src/scaffold/index.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR } from './helpers/workspace.js';
import { goRoutes, goView } from './helpers/contract.js';

const DOC = 'docs/openapi.yaml';
const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

for (const name of fixtures) {
  test(`${name}: el openapi derivado es el de keel-spring y keel-nest, y describe las rutas que registra keel-go`, () => {
    const design = goView(name);
    const fromSpring = planSpring({ ...design, workspace: FIXTURES_DIR }).files.find((f) => f.path === DOC)?.content;
    const fromNest = planNest({ ...design, workspace: FIXTURES_DIR }).files.find((f) => f.path === DOC)?.content;
    const go = planService({ ...design, workspace: FIXTURES_DIR });
    const fromGo = go.files.find((f) => f.path === DOC)?.content;
    assert.equal(fromGo, fromSpring);
    assert.equal(fromGo, fromNest);
    if (!fromGo) return;
    const document = YAML.parse(fromGo);
    for (const [operation, row] of goRoutes(go.files)) {
      const described = document.paths?.[row.path]?.[row.method.toLowerCase()];
      assert.ok(described, `${operation}: ${row.method} ${row.path} está en el documento`);
      assert.equal(described.operationId, operation);
      assert.ok(described.responses?.[String(row.status)], `${operation}: el documento declara su ${row.status}`);
    }
  });
}
