import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDoc } from '../../src/lib/emit.js';
import { fingerprint } from '../../src/lib/fingerprint.js';
import { envDeps } from '../../src/lib/env-deps.js';

// Las fixtures de legacy mínimas y lo que la herramienta tiene que escribir de cada una, byte a
// byte: la puerta del incremento 2. Lo usan el test y `npm run golden`.

const testDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
export const LEGACY_DIR = path.join(testDir, 'legacy');
export const EXPECTED_DIR = path.join(testDir, 'expected');

export const DOCS = [
  ['runtime.yaml', fingerprint],
  ['environment.yaml', envDeps],
];

export function listLegacyFixtures() {
  return fs
    .readdirSync(LEGACY_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Lo que la herramienta escribe hoy de una fixture: `{ 'runtime.yaml': texto, … }`. */
export function renderFixture(name) {
  const root = path.join(LEGACY_DIR, name);
  const out = {};
  for (const [file, produce] of DOCS) {
    const { errors, text } = renderDoc(produce(root));
    if (errors.length) throw new Error(`${name}/${file} no cumple su schema:\n  ${errors.join('\n  ')}`);
    out[file] = text;
  }
  return out;
}
