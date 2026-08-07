import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawTmpdirUsages } from './helpers/tmp.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

test('ningún test de keel-core crea temporales fuera de tmpDir()', () => {
  assert.deepEqual(
    rawTmpdirUsages(testDir),
    [],
    'usa tmpDir() de test/helpers/tmp.js: lo que cuelga de ahí se borra solo al terminar el proceso'
  );
});
