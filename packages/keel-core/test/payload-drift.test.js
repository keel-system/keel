import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supportedDsl } from '../src/lib/assets.js';

// Versión vigente del DSL: derivada, no escrita. Solo se soporta una, y un literal
// aquí volvería a romper estos tests en el siguiente cambio de versión.
const DSL = supportedDsl()[0];
import { copyTree, diffTree } from '../src/lib/copy.js';
import { CUSTOMIZABLE_PAYLOAD, coreDir } from '../src/lib/assets.js';

const RENAMES = { gitignore: '.gitignore', gitattributes: '.gitattributes' };

/** Un workspace recién sembrado desde los assets reales de la CLI. */
function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-drift-'));
  copyTree(coreDir, dir, { renames: RENAMES });
  return dir;
}

const diff = (dir) => diffTree(coreDir, dir, { renames: RENAMES, ignore: CUSTOMIZABLE_PAYLOAD });

test('un workspace recién sembrado no tiene deriva', () => {
  const result = diff(seeded());

  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.missing, []);
});

test('un schema modificado a mano se reporta como desfasado', () => {
  const dir = seeded();
  const schema = path.join(dir, 'schema', 'domain.schema.json');
  fs.writeFileSync(schema, `${fs.readFileSync(schema, 'utf8')}\n`);

  const result = diff(dir);
  assert.deepEqual(result.stale, ['schema/domain.schema.json']);
  assert.deepEqual(result.missing, []);
});

test('un archivo del payload borrado se reporta como ausente', () => {
  const dir = seeded();
  fs.rmSync(path.join(dir, 'schema', 'storage.schema.json'));

  const result = diff(dir);
  assert.deepEqual(result.missing, ['schema/storage.schema.json']);
  assert.deepEqual(result.stale, []);
});

test('un directorio entero del payload borrado se reporta una sola vez', () => {
  const dir = seeded();
  fs.rmSync(path.join(dir, 'templates'), { recursive: true, force: true });

  const result = diff(dir);
  assert.deepEqual(result.missing, ['templates/']);
});

test('los archivos personalizables no cuentan como deriva, por muy reescritos que estén', () => {
  // El caso real: la portada de un registry y el CLAUDE.md de un equipo.
  const dir = seeded();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Keel Registry\n\nPortada propia.\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Reglas del equipo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'services/*\nnode_modules/\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto\n');
  fs.writeFileSync(path.join(dir, 'contracts', 'README.md'), 'Nuestros proveedores.\n');

  const result = diff(dir);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.missing, []);
});

test('poner al día el payload con --force conserva lo personalizable y actualiza el resto', () => {
  // La propiedad que necesita un registry publicado: `keel init --check` le dice que
  // su payload quedó atrás y le manda ejecutar `keel init --force`; ese --force no
  // puede costarle la portada entre marcadores ni su CLAUDE.md.
  const dir = seeded();
  const portada = '# Keel Registry\n\n<!-- keel:servicios:start -->\ntabla\n<!-- keel:servicios:end -->\n';
  fs.writeFileSync(path.join(dir, 'README.md'), portada);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Reglas del equipo\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  // y un trozo del payload que sí debe volver a su versión original
  const schema = path.join(dir, 'schema', 'domain.schema.json');
  const original = fs.readFileSync(schema, 'utf8');
  fs.writeFileSync(schema, '{"desfasado": true}\n');

  const { preserved } = copyTree(coreDir, dir, {
    force: true,
    renames: RENAMES,
    preserve: CUSTOMIZABLE_PAYLOAD
  });

  assert.deepEqual(preserved.sort(), [...CUSTOMIZABLE_PAYLOAD].sort());
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), portada);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Reglas del equipo\n');
  assert.equal(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  assert.equal(fs.readFileSync(schema, 'utf8'), original);

  // Y el resultado es exactamente lo que `keel init --check` considera al día.
  const result = diff(dir);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.missing, []);
});

test('lo que el workspace añade por su cuenta no es deriva', () => {
  const dir = seeded();
  fs.mkdirSync(path.join(dir, 'specs', 'catalog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'catalog', 'service.keel.yaml'), `keel: "${DSL}"\n`);
  fs.writeFileSync(path.join(dir, 'index.json'), '{}\n');

  const result = diff(dir);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.missing, []);
});

test('diffTree no escribe nada: un workspace vacío sigue vacío tras comprobarlo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-drift-vacio-'));
  const result = diffTree(coreDir, dir, { renames: RENAMES, ignore: CUSTOMIZABLE_PAYLOAD });

  assert.ok(result.missing.length > 0, 'todo el payload falta');
  assert.deepEqual(fs.readdirSync(dir), [], 'no debe haber creado nada');
});

test('el renombrado de gitignore se tiene en cuenta al comparar', () => {
  const dir = seeded();

  // Sembrado como `.gitignore`; sin aplicar renames, se buscaría `gitignore`.
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  const sinRenames = diffTree(coreDir, dir, { ignore: CUSTOMIZABLE_PAYLOAD });
  assert.ok(sinRenames.missing.includes('gitignore'), 'sin renames debería echarlo de menos');
  assert.deepEqual(diff(dir).missing, [], 'con renames no falta nada');
});
