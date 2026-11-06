// El contrato del cable son DATOS que ejecutan los dos generadores: aquí se comprueba que son
// coherentes entre sí y con su documento, no el comportamiento de ningún serializador (eso lo
// prueba cada generador con estos mismos casos).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIRE_RULES, WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS, WIRE_SHAPES, WIRE_ETAG_CASES, WIRE_IF_MATCH_CASES } from '../src/lib/gen/wire.js';
import { etagOf, expectedVersionsFrom, ifMatchAbsent, versionMatches } from '../src/lib/gen/conditional-writes.js';
import { BASE_TYPES } from '../src/lib/gen/types.js';

const doc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'core', 'docs', 'wire-contract.md'),
  'utf8'
);
const allCases = [...WIRE_OUTPUT_CASES, ...WIRE_INPUT_CASES, ...WIRE_REJECTED_INPUTS];
const knownTypes = new Set([...BASE_TYPES, 'enum']);

test('cada caso cita una regla que existe, de un tipo que existe, y los ids no se repiten por familia', () => {
  for (const cases of [WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS]) {
    const ids = cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
  }
  for (const entry of allCases) {
    assert.ok(WIRE_RULES[entry.rule], `${entry.id}: regla '${entry.rule}' desconocida`);
    assert.ok(knownTypes.has(entry.type), `${entry.id}: tipo '${entry.type}' desconocido`);
  }
});

test('toda regla tiene al menos un caso, salvo las que son de forma y no de valor', () => {
  const structural = new Set(['nulls-include', 'nulls-omit', 'unknown-ignored', 'list-never-null']);
  const cited = new Set([...allCases, ...WIRE_ETAG_CASES, ...WIRE_IF_MATCH_CASES].map((entry) => entry.rule));
  for (const rule of Object.keys(WIRE_RULES)) {
    if (!structural.has(rule)) assert.ok(cited.has(rule), `la regla ${rule} no tiene ningún caso que la ejecute`);
  }
});

test('lo esperado es JSON válido y un decimal nunca sale en exponencial', () => {
  for (const entry of [...WIRE_OUTPUT_CASES, ...WIRE_INPUT_CASES]) {
    const expected = entry.json && !entry.roundTrip ? entry.json : entry.roundTrip;
    assert.doesNotThrow(() => JSON.parse(expected), entry.id);
    if (entry.type === 'decimal') assert.doesNotMatch(expected, /e/i, `${entry.id}: ${expected}`);
  }
});

test('el documento cuenta las mismas formas, en el mismo orden', () => {
  const flat = doc.replace(/\s+/g, ' ');
  const listed = (keys) => keys.map((key) => `\`${key}\``).join(', ');
  for (const shape of ['errorResponse', 'pagedResponse', 'eventMetadata']) {
    assert.ok(flat.includes(listed(WIRE_SHAPES[shape])), `el documento no lista ${shape} en su orden`);
  }
  const errorExample = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(Object.keys(errorExample), WIRE_SHAPES.errorResponse);
});

test('escritura condicional: el ETag es la versión entre comillas y cada If-Match da lo que dice su caso', () => {
  for (const cases of [WIRE_ETAG_CASES, WIRE_IF_MATCH_CASES]) {
    const ids = cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const entry of cases) assert.ok(WIRE_RULES[entry.rule], `${entry.id}: regla '${entry.rule}' desconocida`);
  }
  for (const entry of WIRE_ETAG_CASES) assert.equal(etagOf(entry.version), entry.etag, entry.id);
  for (const entry of WIRE_IF_MATCH_CASES) {
    const expected = expectedVersionsFrom(entry.header);
    assert.deepEqual(expected, entry.expected, `${entry.id}: lo que se estampa`);
    const outcome = ifMatchAbsent(entry.header) ? 'absent' : versionMatches(expected, entry.current) ? 'match' : 'no-match';
    assert.equal(outcome, entry.outcome, entry.id);
  }
  // Las cuatro familias de D2 tienen su caso: *, lista, débil e ilegible.
  for (const id of ['if-match-star', 'if-match-list-hit', 'if-match-weak', 'if-match-unreadable']) {
    assert.ok(WIRE_IF_MATCH_CASES.some((entry) => entry.id === id), id);
  }
});

test('el documento cuenta la escritura condicional', () => {
  assert.match(doc, /## Escritura condicional/);
  for (const text of ['`"7"`', '`W/"7"`', '`412`', '`428`']) assert.ok(doc.includes(text), text);
});
