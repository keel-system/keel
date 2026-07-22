import fs from 'node:fs';
import path from 'node:path';

/**
 * Escribe los archivos generados dentro de destDir con el mismo contrato que
 * copyTree de keel-core: sin force, los archivos que ya existen se dejan
 * intactos y se reportan como omitidos. Cada entrada es { path, content } o
 * { path, sourceFile } (copia binaria, p. ej. el jar del wrapper); con
 * executable: true se marca 0o755 (salvo en Windows). Devuelve rutas
 * relativas a destDir con separador POSIX para mostrar.
 */
export function writeFiles(files, destDir, { force = false } = {}) {
  const copied = [];
  const skipped = [];

  for (const { path: relative, content, sourceFile, executable } of files) {
    const target = path.join(destDir, relative);
    const display = relative.split(path.sep).join('/');
    if (fs.existsSync(target) && !force) {
      skipped.push(display);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (sourceFile) {
      fs.copyFileSync(sourceFile, target);
    } else {
      fs.writeFileSync(target, content);
    }
    if (executable && process.platform !== 'win32') {
      fs.chmodSync(target, 0o755);
    }
    copied.push(display);
  }

  return { copied, skipped };
}
