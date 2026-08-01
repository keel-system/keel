// Escritura y comparación de archivos **generados** (contenido en memoria), la
// contraparte de copy.js —que trabaja sobre un árbol de assets en disco—. Los
// artefactos de harness no son copias: se proyectan desde una fuente neutral, así
// que ni copyTree ni diffTree pueden verlos.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Escribe `[{ path, content }]` dentro de destDir con el mismo contrato que
 * copyTree(): sin force, lo que ya existe se deja intacto y se reporta como
 * omitido; `preserve` son rutas que no se pisan **ni con force**.
 *
 * Devuelve rutas relativas a destDir con separador POSIX, para mostrar.
 */
export function writeFiles(files, destDir, { force = false, preserve = [] } = {}) {
  const untouchable = new Set(preserve);
  const copied = [];
  const skipped = [];
  const preserved = [];

  for (const { path: relative, content } of files) {
    const target = path.join(destDir, relative);
    const exists = fs.existsSync(target);
    if (exists && untouchable.has(relative)) {
      preserved.push(relative);
      continue;
    }
    if (exists && !force) {
      skipped.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    copied.push(relative);
  }

  return { copied, skipped, preserved };
}

/**
 * Compara `[{ path, content }]` con lo que hay en destDir, sin escribir nada.
 * Mismo resultado que diffTree(): `stale` existe pero difiere, `missing` no existe.
 * `ignore` son rutas que el destino tiene derecho a reescribir.
 */
export function diffGenerated(files, destDir, { ignore = [] } = {}) {
  const ignored = new Set(ignore);
  const stale = [];
  const missing = [];

  for (const { path: relative, content } of files) {
    if (ignored.has(relative)) continue;
    const target = path.join(destDir, relative);
    if (!fs.existsSync(target)) missing.push(relative);
    else if (fs.readFileSync(target, 'utf8') !== content) stale.push(relative);
  }

  return { stale, missing };
}
