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
  // `nest(js)` como palabra, no como prefijo: `nested` es vocabulario del propio modelo.
  [/\bnest(?:js)?\b|@nestjs/i, 'nombra Nest'],
  [/\btypescript\b|\btypeorm\b/i, 'nombra TypeScript/TypeORM'],
  [/['"`]@[A-Z]\w+/, 'emite una anotación'],
  // Un tipo cuenta como cadena suelta —lo que emitiría un mapeador de tipos— o con una llamada a
  // su API. El nombre a secas no: `UUID("…")` es una función de mongosh, y el script que la usa
  // es igual para cualquier generador.
  [/['"`](BigDecimal|UUID|Instant|LocalDate)['"`]|\b(BigDecimal|UUID|Instant)\.[a-z]\w*/, 'nombra un tipo de un lenguaje']
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
  const call = codeOf('const id = `${x}UUID.randomUUID()`;');
  assert.ok(FORBIDDEN.some(([pattern]) => pattern.test(call)), 'una llamada a la API del tipo cuenta');
  const mongosh = codeOf('const s = `db.c.updateOne({ _id: UUID("${id}") })`;');
  assert.ok(!FORBIDDEN.some(([pattern]) => pattern.test(mongosh)), 'la función UUID() de mongosh no cuenta');
});

test('el subpath keel-core/gen expone lo mismo que su índice', async () => {
  const viaPackage = await import('keel-core/gen');
  assert.deepEqual(Object.keys(viaPackage).sort(), Object.keys(gen).sort());
});

test('el catálogo de mecanismos: ids estables, título y eje conocido', async () => {
  const { MECHANISM_CATALOG, MODELS, STATES } = await import('keel-core/gen/mechanisms');
  assert.ok(Object.keys(MECHANISM_CATALOG).length >= 10);
  for (const [id, { title, axis }] of Object.entries(MECHANISM_CATALOG)) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, `${id}: id no estable`);
    assert.ok(title && title.length >= 10, `${id}: sin título`);
    assert.ok(['model', 'engine'].includes(axis), `${id}: eje desconocido '${axis}'`);
  }
  assert.deepEqual(MODELS, ['relational', 'document']);
  assert.ok(STATES.verificado && STATES.razonado && STATES.degradado && STATES['no-aplica']);
});
