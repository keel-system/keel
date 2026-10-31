// Los sabotajes de los clientes salientes, sin Go: cada uno se sigue aplicando al texto que emite hoy build para
// stock-reservation y nombra una prueba que la prueba emitida declara. Los ejecuta `npm run go-check`: un sabotaje que ya
// no encuentra lo que buscaba no falsa nada, y saldría en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { CLIENTS_SABOTAGES, CLIENTS_SUBJECT, applySabotage } from './helpers/clients-sabotages.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const { manifest, layers } = loadService(path.join(FIXTURES_DIR, CLIENTS_SUBJECT));
const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR });
const emittedTest = files.find((file) => file.path === 'internal/infrastructure/clients/clients_test.go')?.content ?? '';

for (const sabotage of CLIENTS_SABOTAGES) {
  test(`el sabotaje de los clientes ${sabotage.id} se sigue aplicando a lo emitido y nombra una prueba emitida`, () => {
    const file = files.find((f) => f.path === sabotage.file);
    assert.ok(file, `no se emite ${sabotage.file}`);
    assert.ok(applySabotage(sabotage, file.content), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
    for (const name of [sabotage.fails, ...(sabotage.alsoFails ?? [])]) {
      assert.match(emittedTest, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, 'm'), name);
    }
  });
}
