// El contrato del cable en el proyecto Go, sin Go: que la prueba emitida trae TODOS los casos de
// keel-core/gen/wire.js, que los modos de redondeo son los de la tabla de Java, que el dominio puede importar el
// paquete y que cada sabotaje de go-check se sigue aplicando al texto de hoy. Que lo emitido CUMPLA el contrato
// lo dice go-check, que ejecuta la prueba y la falsa con esos sabotajes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS } from '@keel-system/keel-core/gen/wire';
import path from 'node:path';
import { loadService } from '@keel-system/keel-core';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR, GO_READY_DESIGN, makeWorkspace } from './helpers/workspace.js';
import { WIRE_SABOTAGES, applySabotage } from './helpers/wire-sabotages.js';
import { ROUNDING_TABLE } from '../src/scaffold/wire.js';
import { boundaries } from '../src/scaffold/render.js';
import { goString, stripCommentsAndStrings } from '../src/lib/go-source.js';

const WIRE = 'internal/platform/wire';
const { manifest, layers } = loadService(path.join(FIXTURES_DIR, GO_READY_DESIGN.name));
const { files } = planService({ manifest, layers, workspace: makeWorkspace() });
const emitted = (name) => {
  const file = files.find((entry) => entry.path === `${WIRE}/${name}`);
  assert.ok(file, `no se emite ${WIRE}/${name}`);
  return file.content;
};

test('la prueba emitida trae todos los casos del contrato, con su JSON exacto', () => {
  const content = emitted('wire_test.go');
  for (const entry of WIRE_OUTPUT_CASES) assert.ok(content.includes(`{id: ${goString(entry.id)}, typ: ${goString(entry.type)}, value: ${goString(entry.value)}, want: ${goString(entry.json)}}`), entry.id);
  for (const entry of WIRE_INPUT_CASES) assert.ok(content.includes(`{id: ${goString(entry.id)}, typ: ${goString(entry.type)}, input: ${goString(entry.json)}, want: ${goString(entry.roundTrip)}}`), entry.id);
  for (const entry of WIRE_REJECTED_INPUTS) assert.ok(content.includes(`{id: ${goString(entry.id)}, typ: ${goString(entry.type)}, input: ${goString(entry.json)}}`), entry.id);
});

test('los modos de redondeo son los siete de java.math.RoundingMode, con su tabla entera', () => {
  const decimal = emitted('decimal.go');
  const tests = emitted('decimal_test.go');
  for (const [mode, results] of Object.entries(ROUNDING_TABLE.modes)) {
    assert.match(decimal, new RegExp(`^\\t${mode}\\b`, 'm'), mode);
    ROUNDING_TABLE.inputs.forEach((input, index) => assert.ok(tests.includes(`{input: "${input}", mode: wire.${mode}, want: "${results[index]}"}`), `${mode} ${input}`));
  }
});

test('el decimal es propio: nada de float64 ni de una librería de decimales', () => {
  const decimal = emitted('decimal.go');
  assert.doesNotMatch(stripCommentsAndStrings(decimal), /float64/);
  assert.doesNotMatch(decimal, /shopspring|cockroachdb/);
  assert.match(decimal, /"math\/big"/);
});

test('todo cuerpo pasa por encoding/json/v2 con las opciones del contrato', () => {
  const wire = emitted('wire.go');
  assert.match(wire, /json "encoding\/json\/v2"|"encoding\/json\/v2"/);
  for (const fn of ['Marshal', 'MarshalWrite', 'Unmarshal', 'UnmarshalRead']) assert.match(wire, new RegExp(`func ${fn}\\(.*\\n\\treturn json\\.${fn}\\(.*, options\\)`), fn);
});

test('el dominio y la aplicación pueden importar el cable, y nada más de la plataforma', () => {
  const byLayer = Object.fromEntries(boundaries().map((rule) => [rule.layer, rule.allows]));
  assert.deepEqual(byLayer.domain, [WIRE]);
  assert.deepEqual(byLayer.application, ['internal/domain', WIRE]);
});

test('el go.mod declara uuid, que la prueba del cable importa', () => {
  assert.match(files.find((file) => file.path === 'go.mod').content, /^\tgithub\.com\/google\/uuid v\d/m);
});

for (const sabotage of WIRE_SABOTAGES) {
  test(`el sabotaje ${sabotage.id} se sigue aplicando a lo emitido`, () => {
    const name = sabotage.file.slice(WIRE.length + 1);
    assert.ok(applySabotage(sabotage, emitted(name)), `${sabotage.file} ya no contiene lo que busca el sabotaje`);
  });
}

test('cada sabotaje nombra una prueba que la prueba emitida declara', () => {
  const tests = ['wire_test.go', 'decimal_test.go', 'fuzz_test.go'].map(emitted).join('\n');
  for (const sabotage of WIRE_SABOTAGES) {
    const [fn, sub] = sabotage.fails.split('/');
    assert.match(tests, new RegExp(`^func ${fn}\\(t \\*testing\\.T\\)`, 'm'), sabotage.id);
    if (sub) assert.ok(tests.includes(`{id: ${goString(sub)},`), `${sabotage.id}: no hay caso ${sub}`);
  }
});
