// Retirar lo que el generador ya no emite, pero solo lo que se puede demostrar suyo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { digestOf, pruneOrphans } from '../src/lib/write.js';

function project(files) {
  const dir = tmpDir('keel-prune-');
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  return dir;
}

test('borra lo intacto, conserva lo tocado y olvida lo que ya no está', () => {
  const dir = project({
    'src/a/Intacto.java': 'de build',
    'src/b/Tocado.java': 'de build\n// y del agente',
    'src/b/Vecino.java': 'sigue emitiéndose'
  });
  const manifest = {
    files: {
      'src/a/Intacto.java': digestOf({ content: 'de build' }),
      'src/b/Tocado.java': digestOf({ content: 'de build' }),
      'src/c/Ausente.java': digestOf({ content: 'lo que hubo' })
    }
  };

  const result = pruneOrphans(['src/c/Ausente.java', 'src/b/Tocado.java', 'src/a/Intacto.java'], dir, manifest);

  assert.deepEqual(result, {
    borrados: ['src/a/Intacto.java'],
    ausentes: ['src/c/Ausente.java'],
    modificados: ['src/b/Tocado.java']
  });
  assert.equal(fs.existsSync(path.join(dir, 'src/a/Intacto.java')), false);
  assert.ok(fs.existsSync(path.join(dir, 'src/b/Tocado.java')), 'borró trabajo ajeno');
  // El directorio que se queda vacío se va; el que aún tiene algo, no; la raíz, nunca.
  assert.equal(fs.existsSync(path.join(dir, 'src/a')), false);
  assert.ok(fs.existsSync(path.join(dir, 'src/b')));
  assert.ok(fs.existsSync(dir));
});

test('sin registro de quién lo escribió, no se borra', () => {
  const dir = project({ 'src/Suelto.java': 'nadie sabe de quién' });
  const result = pruneOrphans(['src/Suelto.java'], dir, { files: {} });
  assert.deepEqual(result.modificados, ['src/Suelto.java']);
  assert.ok(fs.existsSync(path.join(dir, 'src/Suelto.java')));
});
