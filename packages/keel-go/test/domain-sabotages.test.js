// Los sabotajes del dominio, sin Go: cada uno se sigue aplicando al texto que emite hoy build para el diseño de
// go-check, nombra una prueba que la sonda declara, y la sonda es Go de la forma que go-check espera. Los
// ejecuta `npm run go-check`: un sabotaje que ya no encuentra lo que buscaba no falsa nada, y saldría en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { DOMAIN_SABOTAGES, applySabotage } from './helpers/domain-sabotages.js';
import { GO_READY_DESIGN, makeWorkspace, mountDesign } from './helpers/workspace.js';
import { checkGoTree } from './helpers/go-tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = makeWorkspace();
const { manifest, layers } = loadService(mountDesign(workspace, GO_READY_DESIGN.name, GO_READY_DESIGN));
const { model, files } = planService({ manifest, layers, workspace });
const probe = fs.readFileSync(path.join(here, '..', 'scripts', 'probes', 'domain_probe_test.go'), 'utf8');

for (const sabotage of DOMAIN_SABOTAGES) {
  test(`el sabotaje del dominio ${sabotage.id} se sigue aplicando a lo emitido`, () => {
    const file = files.find((f) => f.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
  });
}

test('cada sabotaje del dominio nombra una prueba que la sonda declara', () => {
  for (const sabotage of DOMAIN_SABOTAGES) {
    for (const name of [sabotage.fails, ...(sabotage.alsoFails ?? [])]) {
      assert.match(probe, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'm'), sabotage.id);
    }
  }
});

test('la sonda es Go válido dentro del paquete domain emitido, y sus imports se usan', async () => {
  const tree = [...files, { path: 'internal/domain/domain_probe_test.go', content: probe }];
  assert.deepEqual(await checkGoTree(tree, model.service.goModule), []);
});
