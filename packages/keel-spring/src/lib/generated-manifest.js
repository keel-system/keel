// El registro de lo que build escribió, que es lo que hace propagable un arreglo del
// generador a un proyecto que ya existe.
//
// Sin él solo hay dos modos y ninguno sirve: sin `--force` build omite todo lo que
// existe —así que un arreglo nunca llega—, y con `--force` lo sobrescribe todo, incluido
// el código que escribió el agente. La tercera vía necesita saber qué escribió build la
// última vez, y eso no se deduce de comparar contenidos (ver classifyGenerated).
//
// Va junto a `keel-stack.json`, en la raíz del proyecto generado, y **se versiona con
// él**: quien clone el repo y quiera refrescarlo necesita la línea base.

import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'keel-generated.json';

/**
 * Dónde cae la versión nueva de un archivo en conflicto.
 *
 * En `build/` y NO junto al archivo: un `Foo.java.keel-new` dentro de `src/main/java`
 * envenenaría a quien lee ese árbol —`check-idempotency.sh` y `check-domain-guards.sh`
 * hacen `grep -rl` sobre él— y acabaría juzgando código que no compila nadie. En `build/`
 * está fuera del classpath, git ya lo ignora y Gradle lo limpia.
 */
export const REFRESH_DIR = 'build/keel-refresh';

/** El manifiesto del proyecto, o null si es anterior al mecanismo. */
export function readManifest(projectDir) {
  const file = path.join(projectDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { generator: parsed.generator ?? null, files: parsed.files ?? {}, adopted: parsed.adopted ?? [] };
  } catch {
    // Un manifiesto ilegible no puede tumbar un build: lo que se pierde es la capacidad
    // de refrescar, y eso ya lo dice el reporte al no encontrar registro de nada.
    return null;
  }
}

export function writeManifest(projectDir, manifest) {
  const ordenado = {
    generator: manifest.generator,
    // Ordenadas para que dos builds seguidos den el mismo archivo: un manifiesto que
    // cambia de orden ensucia cada diff del proyecto generado sin decir nada.
    files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))),
    adopted: [...manifest.adopted].sort((a, b) => a.localeCompare(b))
  };
  fs.writeFileSync(path.join(projectDir, MANIFEST_FILE), JSON.stringify(ordenado, null, 2) + '\n');
}

/**
 * El manifiesto tras una pasada de build.
 *
 * Lo que build acaba de escribir pasa a `files` con su huella. Lo que ya estaba y build
 * no escribió se **adopta**: no se sabe quién lo puso —el agente, o un build anterior al
 * mecanismo—, así que se registra para poder REPORTAR que se ha quedado atrás, y nunca
 * para refrescarlo. Una ruta sale de `adopted` solo cuando un `--force` la reescribe, que
 * es el único momento en que build puede afirmar que el archivo es suyo.
 */
export function nextManifest({ previous, generator, escritas, presentes }) {
  const files = { ...(previous?.files ?? {}) };
  const adopted = new Set(previous?.adopted ?? []);

  for (const [relative, digest] of escritas) {
    files[relative] = digest;
    adopted.delete(relative);
  }
  for (const relative of presentes) {
    if (files[relative] === undefined && !adopted.has(relative)) adopted.add(relative);
  }

  return { generator, files, adopted: [...adopted] };
}
