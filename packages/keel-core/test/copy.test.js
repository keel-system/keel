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

test('copyTree con force sobrescribe lo que no está en preserve', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'schema.json'), 'nuevo\n');
  fs.writeFileSync(path.join(dest, 'schema.json'), 'viejo\n');

  const { copied, skipped, preserved } = copyTree(src, dest, { force: true });

  assert.deepEqual(copied, ['schema.json']);
  assert.deepEqual(skipped, []);
  assert.deepEqual(preserved, []);
  assert.equal(fs.readFileSync(path.join(dest, 'schema.json'), 'utf8'), 'nuevo\n');
});

test('copyTree con force NO sobrescribe un archivo de preserve', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'README.md'), 'la portada del payload\n');
  fs.writeFileSync(path.join(src, 'schema.json'), 'nuevo\n');
  fs.writeFileSync(path.join(dest, 'README.md'), 'mi portada reescrita\n');
  fs.writeFileSync(path.join(dest, 'schema.json'), 'viejo\n');

  const { copied, skipped, preserved } = copyTree(src, dest, { force: true, preserve: ['README.md'] });

  assert.deepEqual(preserved, ['README.md']);
  assert.deepEqual(copied, ['schema.json']);
  assert.deepEqual(skipped, []);
  assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'mi portada reescrita\n');
  assert.equal(fs.readFileSync(path.join(dest, 'schema.json'), 'utf8'), 'nuevo\n');
});

test('preserve sí copia el archivo cuando falta en destino (es la semilla)', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'plantilla del workspace\n');

  const { copied, preserved } = copyTree(src, dest, { force: true, preserve: ['CLAUDE.md'] });

  assert.deepEqual(copied, ['CLAUDE.md']);
  assert.deepEqual(preserved, []);
  assert.equal(fs.readFileSync(path.join(dest, 'CLAUDE.md'), 'utf8'), 'plantilla del workspace\n');
});

test('preserve usa la ruta ya renombrada, no el nombre del origen', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.writeFileSync(path.join(src, 'gitignore'), 'services/*\n');
  fs.writeFileSync(path.join(dest, '.gitignore'), 'mio\n');

  const { copied, preserved } = copyTree(src, dest, {
    force: true,
    renames: { gitignore: '.gitignore' },
    preserve: ['.gitignore']
  });

  assert.deepEqual(preserved, ['.gitignore']);
  assert.deepEqual(copied, []);
  assert.equal(fs.readFileSync(path.join(dest, '.gitignore'), 'utf8'), 'mio\n');
});

test('preserve también protege una ruta anidada', (t) => {
  const { src, dest } = makeTmpDirs(t);
  fs.mkdirSync(path.join(src, 'contracts'));
  fs.mkdirSync(path.join(dest, 'contracts'));
  fs.writeFileSync(path.join(src, 'contracts', 'README.md'), 'plantilla\n');
  fs.writeFileSync(path.join(dest, 'contracts', 'README.md'), 'mis proveedores\n');

  const { preserved } = copyTree(src, dest, { force: true, preserve: ['contracts/README.md'] });

  assert.deepEqual(preserved, ['contracts/README.md']);
  assert.equal(fs.readFileSync(path.join(dest, 'contracts', 'README.md'), 'utf8'), 'mis proveedores\n');
});
