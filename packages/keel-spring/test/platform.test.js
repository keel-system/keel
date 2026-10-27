import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BOOT4_SINCE, platformMismatch, springBootLineOf } from '../src/lib/platform.js';
import { SPRING_BOOT_VERSION, SPRING_BOOT_LINE } from '../src/lib/assets.js';

const own = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('la línea de Boot de la constante y la de la versión de Boot dicen lo mismo', () => {
  assert.equal(SPRING_BOOT_VERSION.split('.')[0], SPRING_BOOT_LINE);
});

test('esta versión de keel-spring es de la línea que genera', () => {
  assert.equal(springBootLineOf(`keel-spring@${own}`), SPRING_BOOT_LINE);
  assert.equal(springBootLineOf(`keel-spring@${BOOT4_SINCE}`), SPRING_BOOT_LINE);
});

test('las firmas anteriores a la frontera son de Boot 3 y se rechazan con el motivo', () => {
  for (const generator of ['keel-spring@0.1.7', 'keel-spring@0.1.0', 'keel-spring@0.0.9']) {
    assert.equal(springBootLineOf(generator), '3');
    const message = platformMismatch(generator);
    assert.match(message, /Spring Boot 3/);
    assert.match(message, new RegExp(SPRING_BOOT_VERSION.replace(/\./g, '\.')));
    assert.match(message, /Regenera en un directorio limpio/);
  }
});

test('sin firma legible no se juzga: un proyecto nuevo o anterior al manifiesto no se bloquea', () => {
  for (const generator of [null, undefined, '', 'keel-nest@0.1.0', 'keel-spring@dev']) {
    assert.equal(platformMismatch(generator), null, String(generator));
  }
});
