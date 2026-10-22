import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_DIR, LEGACY_DIR, listLegacyFixtures, renderFixture } from './helpers/golden.js';
import { tmpDir } from './helpers/tmp.js';
import { renderDoc } from '../src/lib/emit.js';
import { fingerprint } from '../src/lib/fingerprint.js';
import { envDeps } from '../src/lib/env-deps.js';

// La puerta del incremento 2: fingerprint y env-deps son deterministas byte a byte sobre las
// fixtures de legacy mínimas. Si un cambio de la herramienta mueve un byte, este test falla y
// `npm run golden` reescribe lo esperado para revisarlo en el diff.

test('hay una fixture por adaptador: Java/Maven, Java/Gradle y Node', () => {
  assert.deepEqual(listLegacyFixtures(), ['java8-gradle', 'java8-maven', 'node14']);
});

for (const name of listLegacyFixtures()) {
  test(`${name}: runtime.yaml y environment.yaml salen byte a byte como los esperados`, () => {
    for (const [file, text] of Object.entries(renderFixture(name))) {
      const expected = fs.readFileSync(path.join(EXPECTED_DIR, name, file), 'utf8');
      assert.equal(text, expected, `${name}/${file} cambió: si es a propósito, npm run golden y revisa el diff`);
    }
  });

  test(`${name}: dos ejecuciones dan los mismos bytes`, () => {
    assert.deepEqual(renderFixture(name), renderFixture(name));
  });
}

test('la copia de una fixture en otro directorio da los mismos bytes: nada depende de la ruta absoluta', () => {
  const copy = path.join(tmpDir('recover-copy-'), 'legacy');
  fs.cpSync(path.join(LEGACY_DIR, 'java8-maven'), copy, { recursive: true });
  for (const produce of [fingerprint, envDeps]) {
    assert.equal(renderDoc(produce(copy)).text, renderDoc(produce(path.join(LEGACY_DIR, 'java8-maven'))).text);
  }
});

test('lo que un build dejó en el árbol (node_modules, target) no cambia la huella', () => {
  const copy = path.join(tmpDir('recover-built-'), 'legacy');
  fs.cpSync(path.join(LEGACY_DIR, 'node14'), copy, { recursive: true });
  fs.mkdirSync(path.join(copy, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules', 'express', 'index.js'), "const u = 'mongodb://otra-base:27017/x';\nprocess.env.FANTASMA;\n");
  fs.mkdirSync(path.join(copy, 'target'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'target', 'Dockerfile'), 'FROM node:20\n');
  const expected = renderFixture('node14');
  assert.equal(renderDoc(fingerprint(copy)).text, expected['runtime.yaml']);
  assert.equal(renderDoc(envDeps(copy)).text, expected['environment.yaml']);
});
