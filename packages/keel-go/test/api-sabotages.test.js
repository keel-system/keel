// Los sabotajes de la API, sin Go: cada uno se sigue aplicando al texto que emite hoy build para el diseño de go-check y
// nombra una prueba que declaran las pruebas emitidas de internal/httpapi. Los ejecuta `npm run go-check`: un sabotaje
// que ya no encuentra lo que buscaba no falsa nada, y saldría en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { API_SABOTAGES, applySabotage } from './helpers/api-sabotages.js';
import { GO_READY_DESIGN, makeWorkspace, mountDesign } from './helpers/workspace.js';

const workspace = makeWorkspace();
const { manifest, layers } = loadService(mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN));
const { files } = planService({ manifest, layers, workspace });
const emittedTests = files.filter((file) => /^internal\/httpapi\/\w+_test\.go$/.test(file.path)).map((file) => file.content).join('\n');

for (const sabotage of API_SABOTAGES) {
  test(`el sabotaje de la API ${sabotage.id} se sigue aplicando a lo emitido y nombra una prueba emitida`, () => {
    const file = files.find((f) => f.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
    for (const name of [sabotage.fails, ...(sabotage.alsoFails ?? [])]) {
      assert.match(emittedTests, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'm'), name);
    }
  });
}
