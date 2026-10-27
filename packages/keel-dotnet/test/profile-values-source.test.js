// El gradiente por perfil y las variables de entorno del servidor son contrato de operación y viven en
// keel-core: `gen/profile-values.js` (cómo se escribe una variable en cada perfil) y `gen/runtime-env.js`
// (qué variables hay, con qué gradiente y con qué default). keel-dotnet nació después de extraerlos
// (incremento 1c de PLAN-KEEL-DOTNET.md) y los importa desde el principio, pero nada se lo exigía: este
// test impide que nazca aquí la copia que keel-spring y keel-nest tuvieron.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ENV } from '@keel-system/keel-core/gen/runtime-env';

const scaffoldDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scaffold');
const sources = fs
  .readdirSync(scaffoldDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => [file, fs.readFileSync(path.join(scaffoldDir, file), 'utf8')]);

test('ningún emisor define su propio gradiente por perfil: se importa de keel-core/gen/profile-values', () => {
  const definition = /^(?:function\s+(envValue|envWithDefault|envRequired|cronWithDefault)\s*\(|const\s+(envValue|envWithDefault|envRequired|cronWithDefault)\s*=)/gm;
  const found = sources.flatMap(([file, source]) => [...source.matchAll(definition)].map((match) => `${file}:${match[1] ?? match[2]}`));
  assert.deepEqual(found, []);
});

test('una variable del catálogo neutral se escribe con envFor, nunca a mano con su nombre', () => {
  const call = /\b(envValue|envWithDefault|envRequired)\(\s*\w+\s*,\s*'([A-Z0-9_]+)'/g;
  const found = sources.flatMap(([file, source]) =>
    [...source.matchAll(call)].filter((match) => match[2] in RUNTIME_ENV).map((match) => `${file}: ${match[1]}(…, '${match[2]}')`)
  );
  assert.deepEqual(found, []);
});
