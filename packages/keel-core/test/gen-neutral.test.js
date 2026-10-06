// El núcleo de `keel-core/gen` lo consumen todos los generadores, así que no puede saber en
// qué lenguaje escribe ninguno. La regla se vigila sobre el CÓDIGO, sin comentarios: la prosa
// puede (y suele) nombrar a keel-spring o a keel-nest para explicar por qué algo vive aquí.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gen from '../src/lib/gen/index.js';

const genDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'gen');

function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// Lo que delata a un lenguaje o a un framework concreto dentro del código de un módulo neutral.
const FORBIDDEN = [
  [/\bjava\w*/i, 'nombra Java'],
  [/\bspring\w*/i, 'nombra Spring'],
  [/\bnest\w*/i, 'nombra Nest'],
  [/\btypescript\b|\btypeorm\b/i, 'nombra TypeScript/TypeORM'],
  [/['"`]@[A-Z]\w+/, 'emite una anotación'],
  [/\bBigDecimal\b|\bUUID\b|\bInstant\b/, 'nombra un tipo de un lenguaje']
];

const files = fs.readdirSync(genDir).filter((name) => name.endsWith('.js'));

test('ningún módulo de keel-core/gen nombra un lenguaje, un framework ni sus tipos', () => {
  const findings = [];
  for (const name of files) {
    const code = codeOf(fs.readFileSync(path.join(genDir, name), 'utf8'));
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(code)) findings.push(`${name}: ${why} (${code.match(pattern)[0]})`);
  }
  assert.deepEqual(findings, []);
});

test('keel-core/gen solo importa de keel-core y de node: (nunca de un generador)', () => {
  const findings = [];
  for (const name of files) {
    const code = codeOf(fs.readFileSync(path.join(genDir, name), 'utf8'));
    for (const [, from] of code.matchAll(/from\s+'([^']+)'/g)) {
      if (!from.startsWith('./') && !from.startsWith('../') && !from.startsWith('node:')) findings.push(`${name}: ${from}`);
    }
  }
  assert.deepEqual(findings, []);
});

test('el detector ve lo que tiene que ver (se autocomprueba)', () => {
  const code = codeOf("// Java en un comentario no cuenta\nconst t = 'BigDecimal';\nconst a = '@Entity';");
  const hits = FORBIDDEN.filter(([pattern]) => pattern.test(code)).map(([, why]) => why);
  assert.deepEqual(hits, ['emite una anotación', 'nombra un tipo de un lenguaje']);
});

test('el subpath keel-core/gen expone lo mismo que su índice', async () => {
  const viaPackage = await import('keel-core/gen');
  assert.deepEqual(Object.keys(viaPackage).sort(), Object.keys(gen).sort());
});
