import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Raíz temporal única del proceso. `node --test` lanza un proceso por archivo de
 * test, así que cada archivo tiene la suya y el barrido de salida se la lleva
 * entera: ningún test necesita acordarse de borrar lo que crea.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-tests-'));
const SAFE_CWD = process.cwd();

/** Directorio temporal desechable. Se borra solo al terminar el proceso. */
export function tmpDir(prefix = 'keel-') {
  return fs.mkdtempSync(path.join(ROOT, prefix));
}

// El propio helper es el único que nombra el temporal del sistema; los fixtures
// no son código de test.
const EXENTOS = new Set(['tmp.js', 'tmp-hygiene.test.js']);

/**
 * Rutas relativas de los .js de `testDir` que llaman a os.tmpdir() a pelo. La
 * usa el test de higiene de cada paquete: quien lo hacía no borraba, y cada
 * `npm test` dejaba cientos de directorios que había que barrer a mano.
 */
export function rawTmpdirUsages(testDir) {
  const encontrados = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures') walk(full);
      } else if (entry.name.endsWith('.js') && !EXENTOS.has(entry.name)) {
        if (/\btmpdir\s*\(/.test(fs.readFileSync(full, 'utf8'))) {
          encontrados.push(path.relative(testDir, full).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(testDir);
  return encontrados.sort();
}

// 'exit' corre también cuando la suite falla o lanza, que es justo cuando un
// rmSync al final de la función no llega a ejecutarse.
process.on('exit', () => {
  // Un test que hizo chdir dentro de ROOT impediría borrarlo en Windows (EBUSY).
  try {
    process.chdir(SAFE_CWD);
  } catch {
    /* el cwd previo ya no existe: seguimos igual */
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* limpiar no puede romper el exit code de la suite */
  }
});
