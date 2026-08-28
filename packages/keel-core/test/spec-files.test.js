import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { DECISIONS_FILE, SCENARIOS_FILE, SIDECAR_FILE, SPEC_SIDE_FILES, sideFilesOf } from '../src/lib/spec-files.js';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('sideFilesOf solo devuelve lo que existe y lo que ese transporte mueve', () => {
  const dir = tmpDir('keel-spec-files-');
  fs.writeFileSync(path.join(dir, SIDECAR_FILE), 'family: x\n');
  fs.writeFileSync(path.join(dir, DECISIONS_FILE), 'decisions: []\n');
  fs.writeFileSync(path.join(dir, SCENARIOS_FILE), '# FL-1\n');

  // Publicar mueve el sidecar y las decisiones; los escenarios los aporta el
  // catálogo de derivados, así que no salen por aquí (se duplicarían).
  assert.deepEqual(sideFilesOf(dir, 'publish'), [SIDECAR_FILE, DECISIONS_FILE]);
  // Derivar deja fuera el sidecar: es metadato de publicación del origen.
  assert.deepEqual(sideFilesOf(dir, 'derive'), [DECISIONS_FILE]);

  fs.rmSync(path.join(dir, DECISIONS_FILE));
  assert.deepEqual(sideFilesOf(dir, 'publish'), [SIDECAR_FILE]);
  assert.deepEqual(sideFilesOf(dir, 'derive'), []);
});

// El fallo que este test existe para evitar: cada transporte (publicar, derivar,
// adoptar) enumeraba estos archivos a mano, y así fue como decisions.yaml se quedó
// fuera de dos de ellos de forma independiente. Un literal suelto es el primer paso
// para que vuelva a pasar con el siguiente archivo que se añada al spec.
test('los nombres de los archivos del spec solo se escriben en spec-files.js', () => {
  const nombres = SPEC_SIDE_FILES.map((entry) => entry.file);
  const culpables = [];

  for (const file of jsFiles(srcDir)) {
    if (path.basename(file) === 'spec-files.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const nombre of nombres) {
      // Solo comillas de código: en los comentarios y en los mensajes el nombre se
      // cita con backticks como prosa, y eso debe seguir leyéndose.
      if (text.includes(`'${nombre}'`) || text.includes(`"${nombre}"`)) {
        culpables.push(`${path.relative(srcDir, file)} → ${nombre}`);
      }
    }
  }

  assert.deepEqual(culpables, [], 'importa la constante de spec-files.js en vez de escribir el nombre');
});
