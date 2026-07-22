import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree } from '../src/lib/copy.js';

function makeTmpDirs(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-copy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const src = path.join(base, 'src');
  const dest = path.join(base, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  return { src, dest };
}

test('copyTree renombra archivos de la raíz según renames', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'gitignore'), 'services/*\n');

  const { copied, skipped } = copyTree(src, dest, { renames: { gitignore: '.gitignore' } });

  assert.deepEqual(copied, ['.gitignore']);
  assert.deepEqual(skipped, []);
  assert.equal(fs.readFileSync(path.join(dest, '.gitignore'), 'utf8'), 'services/*\n');
  assert.equal(fs.existsSync(path.join(dest, 'gitignore')), false);
});

test('copyTree sin force omite un archivo renombrado que ya existe en destino', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'gitignore'), 'services/*\n');
  fs.writeFileSync(path.join(dest, '.gitignore'), 'mio\n');

  const { copied, skipped } = copyTree(src, dest, { renames: { gitignore: '.gitignore' } });

  assert.deepEqual(copied, []);
  assert.deepEqual(skipped, ['.gitignore']);
  assert.equal(fs.readFileSync(path.join(dest, '.gitignore'), 'utf8'), 'mio\n');
});

test('copyTree no renombra archivos fuera de la raíz', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'gitignore'), 'x\n');

  const { copied } = copyTree(src, dest, { renames: { gitignore: '.gitignore' } });

  assert.deepEqual(copied, ['sub/gitignore']);
  assert.equal(fs.existsSync(path.join(dest, 'sub', 'gitignore')), true);
});
