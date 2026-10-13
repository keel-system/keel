// Huella de lo que genera un generador, para demostrar que un refactor no cambia nada.
//
// Nació en keel-spring (incremento 0 de PLAN-KEEL-NEST.md): mover a keel-core la interpretación
// neutral del diseño es un refactor que NO debe cambiar ni un byte del proyecto generado, y la suite
// no basta para demostrarlo — compara rasgos, no el árbol, así que un cambio en un archivo que ningún
// test nombra pasaría en verde. Vive aquí desde el incremento 1 de PLAN-KEEL-DOTNET.md: keel-nest
// necesitaba la suya para que la extracción de lo que aún duplica con keel-spring fuera medible, y
// copiarla en cada generador era la tercera copia de algo que no depende del lenguaje.
//
// Lo de cada generador entra por parámetro: su `planService` (la mitad pura de `build`, que renderiza
// en memoria sin escribir nada) y sus combinaciones fixture × stack.
//
// No es un árbol congelado ni un test de `npm test`: un cambio INTENCIONAL del generador la pondría
// roja y acabaría regenerándose a ciegas (building-a-generator.md § Fixtures). Es una línea base que se
// toma ANTES del refactor y se compara DESPUÉS, con `--check`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '../loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_FIXTURES_DIR = path.join(here, '..', '..', '..', '..', '..', 'fixtures', 'designs');
export const GOLDEN_SCHEMA = 1;

// planService solo usa el workspace para listar los contratos de /keel-docs (docs/<servicio>/).
// Una ruta que no existe garantiza que la huella no depende de lo que haya en la máquina.
const NO_WORKSPACE = path.join(here, '__golden-without-workspace__');

export function comboKey({ fixture, stack }) {
  const axes = Object.keys(stack)
    .sort()
    .map((axis) => `${axis}=${stack[axis]}`);
  return axes.length > 0 ? `${fixture} [${axes.join(',')}]` : `${fixture} [default]`;
}

/** Las combinaciones con su clave, sin repetidas y en orden estable. */
export function normalizeCombos(combos) {
  const seen = new Set();
  return combos
    .map((combo) => ({ fixture: combo.fixture, stack: combo.stack ?? {}, key: comboKey({ fixture: combo.fixture, stack: combo.stack ?? {} }) }))
    .filter((combo) => (seen.has(combo.key) ? false : seen.add(combo.key)))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function listFixtures(dir = GOLDEN_FIXTURES_DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'service.keel.yaml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Huella de una combinación: { <ruta>: <sha256> }, ordenada por ruta. El bit de ejecución
 * forma parte de lo generado (un script que pierde el +x deja de lanzarse), así que entra en
 * la huella con el prefijo `x:`.
 */
export function digestCombo({ fixture, stack }, { planService, fixturesDir = GOLDEN_FIXTURES_DIR }) {
  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  if (errors.length > 0) throw new Error(`${fixture}: la fixture no carga:\n  ${errors.join('\n  ')}`);
  const { files } = planService({ manifest, layers, workspace: NO_WORKSPACE, stack });
  const digests = {};
  for (const entry of files) {
    const rel = entry.path.split(path.sep).join('/');
    if (rel in digests) throw new Error(`${comboKey({ fixture, stack })}: ruta emitida dos veces: ${rel}`);
    const raw = entry.sourceFile ? fs.readFileSync(entry.sourceFile) : Buffer.from(entry.content ?? '', 'utf8');
    // El fin de línea NO entra en la huella: los assets se copian tal como están en la copia de trabajo, y
    // una copia en CRLF (Windows) frente a otra en LF ponía roja la línea base sin que build cambiara nada.
    // El repositorio los guarda en LF (.gitattributes); esto mide lo que build emite, no cómo se clonó.
    const bytes = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    // 64 bits bastan para detectar un cambio y dividen el archivo de la línea base por dos.
    const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    digests[rel] = entry.executable ? `x:${digest}` : digest;
  }
  return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)));
}

/** La línea base entera. Silencia la consola: los avisos del modelo no son parte de la huella. */
export function computeGolden(combos, { planService, fixturesDir = GOLDEN_FIXTURES_DIR }) {
  const result = {};
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    for (const combo of normalizeCombos(combos)) result[combo.key] = digestCombo(combo, { planService, fixturesDir });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return { schema: GOLDEN_SCHEMA, combos: result };
}

/**
 * Compara dos líneas base. Devuelve una lista de diferencias legibles, vacía si son idénticas:
 * combinaciones que aparecen o desaparecen, y por combinación los archivos nuevos, retirados
 * y cambiados.
 */
export function compareGolden(expected, actual) {
  const diffs = [];
  if (expected.schema !== actual.schema) {
    diffs.push(`schema: ${expected.schema} → ${actual.schema}`);
    return diffs;
  }
  const keys = new Set([...Object.keys(expected.combos), ...Object.keys(actual.combos)]);
  for (const key of [...keys].sort()) {
    const before = expected.combos[key];
    const after = actual.combos[key];
    if (!before) {
      diffs.push(`${key}: combinación nueva`);
      continue;
    }
    if (!after) {
      diffs.push(`${key}: combinación retirada`);
      continue;
    }
    const files = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const file of [...files].sort()) {
      if (!(file in after)) diffs.push(`${key}: retirado ${file}`);
      else if (!(file in before)) diffs.push(`${key}: nuevo ${file}`);
      else if (before[file] !== after[file]) diffs.push(`${key}: cambiado ${file}`);
    }
  }
  return diffs;
}

export function serializeGolden(golden) {
  return `${JSON.stringify(golden, null, 1)}\n`;
}

/**
 * El cuerpo del script `golden` de cada generador: sin `--check` escribe la línea base en
 * `goldenFile`; con `--check` compara y devuelve 1 si algo cambió (2 si no hay línea base).
 * Devuelve el código de salida en vez de salir, para que el script decida.
 */
export function runGolden({ argv = process.argv, goldenFile, combos, planService, fixturesDir, out = console }) {
  const check = argv.includes('--check');
  const golden = computeGolden(combos, { planService, fixturesDir });
  const comboCount = Object.keys(golden.combos).length;
  const fileCount = Object.values(golden.combos).reduce((n, digests) => n + Object.keys(digests).length, 0);

  if (!check) {
    fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
    fs.writeFileSync(goldenFile, serializeGolden(golden));
    out.log(`Línea base escrita: ${comboCount} combinaciones, ${fileCount} archivos → ${path.relative(process.cwd(), goldenFile)}`);
    return 0;
  }
  if (!fs.existsSync(goldenFile)) {
    out.error(`No hay línea base en ${goldenFile}: ejecútalo sin --check primero.`);
    return 2;
  }
  const diffs = compareGolden(JSON.parse(fs.readFileSync(goldenFile, 'utf8')), golden);
  if (diffs.length === 0) {
    out.log(`Idéntico a la línea base: ${comboCount} combinaciones, ${fileCount} archivos.`);
    return 0;
  }
  out.log(`La salida difiere de la línea base en ${diffs.length} punto(s):`);
  for (const diff of diffs.slice(0, 200)) out.log(`  ${diff}`);
  if (diffs.length > 200) out.log(`  … y ${diffs.length - 200} más`);
  return 1;
}
