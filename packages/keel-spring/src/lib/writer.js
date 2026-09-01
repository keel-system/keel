import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from 'keel-core';

/**
 * Escribe los archivos generados dentro de destDir con el mismo contrato que
 * copyTree de keel-core: sin force, los archivos que ya existen se dejan
 * intactos y se reportan como omitidos. Cada entrada es { path, content } o
 * { path, sourceFile } (copia binaria, p. ej. el jar del wrapper); con
 * executable: true se marca 0o755 (salvo en Windows). Devuelve rutas
 * relativas a destDir con separador POSIX para mostrar.
 *
 * `only` es la tercera vía, y la razón de que exista: un conjunto EXPLÍCITO de rutas a
 * escribir, decidido fuera por `classifyGenerated` a partir del manifiesto. El booleano
 * `force` solo sabe decir «todo» o «nada» —y «todo» incluye el código del agente—, así
 * que con él un arreglo del generador no puede llegar a un proyecto que ya existe sin
 * destruir trabajo. Con `only`, quien decide es quien sabe de quién es cada archivo.
 *
 * Devuelve también la huella de lo escrito: es lo que alimenta el manifiesto, y
 * calcularla aquí evita volver a leer del disco lo que se acaba de poner.
 */
export function writeFiles(files, destDir, { force = false, only = null } = {}) {
  const copied = [];
  const skipped = [];
  const digests = [];

  for (const entry of files) {
    const { path: relative, content, sourceFile, executable } = entry;
    const target = path.join(destDir, relative);
    const display = relative.split(/[\\/]/).join('/');
    const decided = only ? only.has(display) : force || !fs.existsSync(target);
    if (!decided) {
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
    digests.push([display, digestOf(entry)]);
  }

  return { copied, skipped, digests };
}
