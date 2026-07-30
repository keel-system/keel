import fs from 'node:fs';
import path from 'node:path';

/**
 * Copia recursiva de srcDir dentro de destDir. Sin force, los archivos que ya
 * existen en destino se dejan intactos y se reportan como omitidos.
 * `renames` mapea nombres de archivo en la raíz de srcDir a su nombre en
 * destino (p. ej. `gitignore` → `.gitignore`, que npm excluye del tarball).
 *
 * `preserve` son rutas relativas (ya renombradas) que el workspace tiene derecho
 * a editar: se copian si faltan —en un workspace nuevo son la semilla— pero
 * **nunca se sobrescriben, ni con force**, y salen en `preserved`. Es la
 * contraparte del `ignore` de diffTree(): sin esto, el `keel init --force` que
 * recomienda `keel init --check` pisaría justo lo que `--check` respeta.
 *
 * Devuelve rutas relativas a destDir, con separador POSIX para mostrar.
 */
export function copyTree(srcDir, destDir, { force = false, renames = {}, preserve = [] } = {}) {
  const preserved = [];
  const untouchable = new Set(preserve);
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
        const exists = fs.existsSync(to);
        if (exists && untouchable.has(relative)) {
          preserved.push(relative);
        } else if (exists && !force) {
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
  return { copied, skipped, preserved };
}

/**
 * Compara el payload de srcDir con lo que hay en destDir, sin escribir nada.
 * Recorre igual que copyTree() y devuelve las mismas rutas relativas POSIX.
 *
 * `ignore` son rutas relativas (ya renombradas) que el workspace tiene derecho a
 * editar: la portada de un registry está reescrita a propósito y reportarla como
 * desfasada en cada ejecución sería ruido que enseña a ignorar el aviso.
 *
 * Devuelve { stale, missing }: `stale` existe pero difiere del original,
 * `missing` no existe. No hay `extra`: lo que el workspace añada por su cuenta
 * (sus specs, sus docs) no es asunto de esta comparación.
 */
export function diffTree(srcDir, destDir, { renames = {}, ignore = [] } = {}) {
  const ignored = new Set(ignore);
  const stale = [];
  const missing = [];

  const walk = (src, dest) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const destName = src === srcDir && !entry.isDirectory() && renames[entry.name]
        ? renames[entry.name]
        : entry.name;
      const to = path.join(dest, destName);
      if (entry.isDirectory()) {
        if (fs.existsSync(to)) walk(from, to);
        else missing.push(`${path.relative(destDir, to).split(path.sep).join('/')}/`);
        continue;
      }
      const relative = path.relative(destDir, to).split(path.sep).join('/');
      if (ignored.has(relative)) continue;
      if (!fs.existsSync(to)) {
        missing.push(relative);
      } else if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
        stale.push(relative);
      }
    }
  };

  walk(srcDir, destDir);
  return { stale, missing };
}
