// Las sondas de CLASE que la superficie del legacy pide y que la exploración no ha grabado.
//
// La skill del explorador ya lo decía en prosa —un índice único pide una carrera, una columna de estado su ciclo de vida—
// y en la corrida de control de shop-api (2026-10-23) la exploración se cerró sin ellas: el explorador propuso una ronda
// corta que no se hizo, y el diseño acabó afirmando por lectura de código que editar un producto lo devuelve a UP sin que
// ninguna sonda hubiera movido nunca `product_info.product_status`. Aquí se deriva de lo que hay en disco:
//   · `concurrency:<tabla>`: la tabla tiene un índice único y alguna sonda inserta en ella; falta una sonda de clase
//     `concurrency` que inserte en ella (la carrera sobre la unicidad). Una tabla que ninguna sonda escribe (la que solo
//     se siembra) no pide nada: no hay carrera que buscar;
//   · `lifecycle:<tabla>.<columna>`: la columna se llama como un estado (status, state) y alguna sonda escribe la tabla;
//     falta una sonda de clase `lifecycle` que CAMBIE esa columna.
// El efecto de cada sonda sale de su grabación (`effects.db.<tabla>`: added, changed con before/after), que es lo que la
// une a la tabla: una sonda es una petición HTTP y la superficie habla de tablas.
//
// Lo pendiente se graba o se descarta con su motivo en exploration.yaml (`waived`); status no da la exploración por
// cerrada mientras quede algo sin una cosa ni la otra.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const STATE_COLUMN = /status|state/i;

/** Las grabaciones de las rondas de sondas (solo los directorios con round.json: characterization/ y parity/ no son exploración). */
function probeRecordings(legacyDir) {
  const root = path.join(legacyDir, 'recordings');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'round.json'))) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'round.json') continue;
      try {
        const recording = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (recording?.id) out.push(recording);
      } catch {
        // una grabación ilegible la dice su propia ronda
      }
    }
  }
  return out;
}

const tableEffects = (recording, table) => recording.effects?.db?.[table] ?? null;
const inserts = (recording, table) => (tableEffects(recording, table)?.added ?? []).length > 0;
const writes = (recording, table) => {
  const effects = tableEffects(recording, table);
  return Boolean(effects && ((effects.added ?? []).length || (effects.changed ?? []).length || (effects.removed ?? []).length));
};
const changesColumn = (recording, table, column) =>
  (tableEffects(recording, table)?.changed ?? []).some((change) => JSON.stringify(change.before?.[column]) !== JSON.stringify(change.after?.[column]));

/**
 * Las sondas de clase que pide la superficie de `legacyDir` y que no tienen grabación: `[{ key, class, table, column?, why }]`,
 * sin las descartadas en exploration.yaml. Vacío sin surface.yaml o sin tablas (un legacy documental sin colecciones con
 * esquema no tiene de dónde derivarlas).
 */
export function pendingClassProbes(legacyDir) {
  const file = path.join(legacyDir, 'surface.yaml');
  if (!fs.existsSync(file)) return [];
  const tables = YAML.parse(fs.readFileSync(file, 'utf8'))?.data?.tables ?? [];
  const recordings = probeRecordings(legacyDir);
  const waived = new Set((YAML.parse(fs.existsSync(path.join(legacyDir, 'exploration.yaml')) ? fs.readFileSync(path.join(legacyDir, 'exploration.yaml'), 'utf8') : '{}')?.waived ?? []).map((entry) => entry.key));
  const out = [];
  for (const table of tables) {
    const name = table.name;
    if ((table.unique ?? []).length && recordings.some((r) => inserts(r, name))) {
      if (!recordings.some((r) => r.class === 'concurrency' && inserts(r, name))) {
        out.push({ key: `concurrency:${name}`, class: 'concurrency', table: name, why: `índice único (${table.unique.map((cols) => cols.join(', ')).join('; ')}) en una tabla que las sondas escriben: dos altas a la vez con la misma clave` });
      }
    }
    if (!recordings.some((r) => writes(r, name))) continue;
    for (const column of (table.columns ?? []).filter((c) => STATE_COLUMN.test(c.name))) {
      if (!recordings.some((r) => r.class === 'lifecycle' && changesColumn(r, name, column.name))) {
        const moved = recordings.filter((r) => changesColumn(r, name, column.name)).map((r) => r.id);
        out.push({
          key: `lifecycle:${name}.${column.name}`,
          class: 'lifecycle',
          table: name,
          column: column.name,
          why: moved.length ? `la cambian ${moved.join(', ')}, pero ninguna sonda de ciclo de vida recorre sus transiciones` : 'ninguna sonda la ha cambiado nunca: sus transiciones están sin grabar'
        });
      }
    }
  }
  return out.filter((probe) => !waived.has(probe.key));
}
