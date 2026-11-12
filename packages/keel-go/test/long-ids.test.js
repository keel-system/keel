// El id `long` que genera la aplicación (keel-core/gen/ids.js). Las notas del constructor citaban NextLongID() y build no
// la emitía (corrida de shop-api 2.27, 2026-11-11): toda fixture que la cite tiene que traer su definición, con la forma
// neutral. La forma la ejecuta go-syntax (tree-sitter) y la compila go-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { LONG_ID_EPOCH_MS, LONG_ID_RANDOM_BITS } from '@keel-system/keel-core/gen/ids';
import { planService } from '../src/scaffold/index.js';
import { LONG_ID_FUNC } from '../src/scaffold/long-ids.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

function plan(fixture) {
  const { manifest, layers } = loadService(path.join(FIXTURES_DIR, fixture));
  return planService({ manifest, layers, workspace: FIXTURES_DIR, stack: null }).files;
}

const fixtures = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.existsSync(path.join(FIXTURES_DIR, name, 'service.keel.yaml')));

test('toda fixture que cita NextLongID() trae su definición, y ninguna otra la emite', () => {
  let citing = 0;
  for (const fixture of fixtures) {
    const files = plan(fixture);
    const cites = files.some((file) => file.path.endsWith('.go') && file.content.includes(`${LONG_ID_FUNC}()`));
    const defines = files.some((file) => file.content.includes(`func ${LONG_ID_FUNC}() int64 {`));
    assert.equal(defines, cites, `${fixture}: cita ${cites}, define ${defines}`);
    if (cites) citing += 1;
  }
  assert.ok(citing > 0, 'alguna fixture tiene ids long generados (shop-api)');
});

test('la definición tiene la forma neutral: los milisegundos desde 2020 y los bits aleatorios de keel-core', () => {
  const file = plan('shop-api').find((entry) => entry.path === 'internal/domain/long_ids.go');
  assert.ok(file, 'shop-api emite internal/domain/long_ids.go');
  assert.match(file.content, new RegExp(`longIDEpochMs\\s+= ${LONG_ID_EPOCH_MS}\\n`));
  assert.match(file.content, new RegExp(`longIDRandomBits = ${LONG_ID_RANDOM_BITS}\\n`));
  assert.match(file.content, /"crypto\/rand"/, 'la aleatoriedad, de crypto/rand');
});
