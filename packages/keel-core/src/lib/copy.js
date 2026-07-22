import fs from 'node:fs';
import path from 'node:path';

/**
 * Copia recursiva de srcDir dentro de destDir. Sin force, los archivos que ya
 * existen en destino se dejan intactos y se reportan como omitidos.
 * `renames` mapea nombres de archivo en la raíz de srcDir a su nombre en
 * destino (p. ej. `gitignore` → `.gitignore`, que npm excluye del tarball).
 * Devuelve rutas relativas a destDir, con separador POSIX para mostrar.
 */
export function copyTree(srcDir, destDir, { force = false, renames = {} } = {}) {
  const copied = [];
  const skipped = [];

  const walk = (src, dest) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const destName = src === srcDir && !entry.isDirectory() && renames[entry.name]
        ? renames[entry.name]
        : entry.name;
      const to = path.join(dest, destName);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, to);
      } else {
        const relative = path.relative(destDir, to).split(path.sep).join('/');
        if (fs.existsSync(to) && !force) {
          skipped.push(relative);
        } else {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          copied.push(relative);
        }
      }
    }
  };

  walk(srcDir, destDir);
  return { copied, skipped };
}
