// El texto con el que la skill del proyecto generado pide `design-gaps.yaml` (DESIGN_GAPS_FORM) dice lo mismo que su schema:
// el proyecto no lleva el schema, y lo que el texto no nombre no llega al archivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DESIGN_GAPS_FORM } from '../src/lib/gen/design-gaps.js';

const schema = JSON.parse(fs.readFileSync(new URL('../assets/core/schema/design-gaps.schema.json', import.meta.url), 'utf8'));
const entry = schema.properties.gaps.items;
const named = (name) => DESIGN_GAPS_FORM.includes(`\`${name}\``);

test('nombra todos los campos del schema, los del archivo y los de cada hueco', () => {
  for (const name of [...Object.keys(schema.properties), ...Object.keys(entry.properties)]) assert.ok(named(name), name);
});

test('nombra los valores de kind y solo dice obligatorios los que el schema exige', () => {
  for (const value of entry.properties.kind.enum) assert.ok(named(value), value);
  const [required, optional] = DESIGN_GAPS_FORM.split('(obligatorios)');
  for (const name of entry.required) assert.ok(required.includes(`\`${name}\``), name);
  for (const name of Object.keys(entry.properties).filter((property) => !entry.required.includes(property))) {
    assert.ok(optional.includes(`\`${name}\``), name);
  }
});
