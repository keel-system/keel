// Los sabotajes de la aplicación, sin Go: cada uno se sigue aplicando al texto que emite hoy build para el diseño de
// go-check y nombra una prueba que la prueba emitida del cableado declara. Los ejecuta `npm run go-check`: un
// sabotaje que ya no encuentra lo que buscaba no falsa nada, y saldría en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { APPLICATION_SABOTAGES, applySabotage } from './helpers/application-sabotages.js';
import { GO_READY_DESIGN, makeWorkspace, mountDesign } from './helpers/workspace.js';

const workspace = makeWorkspace();
const { manifest, layers } = loadService(mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN));
const { files } = planService({ manifest, layers, workspace });
// Las pruebas emitidas de la aplicación: el cableado (use_cases_test.go) y, con registro, la firma (idempotency_test.go).
const emittedTest = files
  .filter((file) => file.path.startsWith('internal/application/') && file.path.endsWith('_test.go'))
  .map((file) => file.content)
  .join('\n');

for (const sabotage of APPLICATION_SABOTAGES) {
  test(`el sabotaje de la aplicación ${sabotage.id} se sigue aplicando a lo emitido y nombra una prueba emitida`, () => {
    const file = files.find((f) => f.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
    for (const name of [sabotage.fails, ...(sabotage.alsoFails ?? [])]) {
      assert.match(emittedTest, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'm'), name);
    }
  });
}
