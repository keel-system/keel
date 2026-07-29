import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CUSTOMIZABLE_PAYLOAD, coreDir, schemaPathFor, supportedDsl } from '../src/lib/assets.js';
import path from 'node:path';

test('supportedDsl() es exactamente el enum del schema del manifiesto', () => {
  // Este test es la razón por la que no hay una constante duplicada: si alguien
  // añade una versión al enum, supportedDsl() la conoce sin tocar nada más.
  const schema = JSON.parse(fs.readFileSync(schemaPathFor('service'), 'utf8'));

  assert.deepEqual(supportedDsl(), schema.properties.keel.enum);
});

test('supportedDsl() devuelve una lista no vacía y congelada', () => {
  const versions = supportedDsl();

  assert.ok(versions.length > 0);
  assert.ok(Object.isFrozen(versions), 'no debe poder mutarse desde fuera');
  assert.throws(() => versions.push('9.9'));
});

test('supportedDsl() memoiza: dos llamadas devuelven la misma instancia', () => {
  assert.equal(supportedDsl(), supportedDsl());
});

test('todas las versiones soportadas son de la familia 2.x', () => {
  // loader.js rechaza explícitamente los specs 1.x (formato monolítico).
  for (const version of supportedDsl()) {
    assert.match(version, /^2\.\d+$/, version);
  }
});

test('los archivos personalizables del payload existen de verdad en los assets', () => {
  // Una entrada mal escrita dejaría de ignorarse en silencio y `keel init --check`
  // reportaría deriva sobre un archivo que el usuario tiene derecho a editar.
  const renames = { '.gitignore': 'gitignore', '.gitattributes': 'gitattributes' };
  for (const file of CUSTOMIZABLE_PAYLOAD) {
    const source = renames[file] ?? file;
    assert.ok(fs.existsSync(path.join(coreDir, source)), `${source} debería existir en assets/core/`);
  }
});
