// Lo que comparten los adaptadores relacionales (postgresql.js, mysql.js): la forma de la exportación, el
// diff por clave primaria, la huella del contenido y el historial de migraciones que la paridad no vacía.
//
// La exportación es `{ tabla: [filas], <contador>: [{ name, … }], $keys: { tabla: [pk…] } }`. El contador
// es lo que el motor consume al dar un id, también cuando la escritura falla: las secuencias de PostgreSQL
// (`_sequences`, SA-EFFECT-04) y el AUTO_INCREMENT de MySQL (`_auto_increment`, ST-ENV-11). Es un efecto,
// pero técnico: va al diff y a la huella, y no es una tabla del legacy.
//
// `$onUpdate` (MySQL) nombra, por tabla, las columnas que el motor reescribe en cada UPDATE (`ON UPDATE
// CURRENT_TIMESTAMP`, M-09): en el diff no deciden si una fila cambió, y su valor se graba como ON_UPDATE_MARK,
// porque no lo escribió el flujo. La huella no las aparta: lo que hay en la base es lo que hay.

import crypto from 'node:crypto';

/** Las tablas de historial de migraciones de los generadores de keel y de las herramientas habituales: la paridad no las vacía. */
export const HISTORY_TABLES = ['flyway_schema_history', 'typeorm_migrations', 'ef_migrations_history', 'databasechangelog', 'databasechangeloglock', 'SequelizeMeta', 'knex_migrations', 'knex_migrations_lock', 'schema_migrations'];

/** Las «tablas» de la exportación que son el contador de ids de cada motor, casadas por nombre. */
export const COUNTER_TABLES = ['_sequences', '_auto_increment'];

/** Lo que se graba en el diff en lugar del valor de una columna que mantiene el motor. */
export const ON_UPDATE_MARK = '<on-update>';

/** Una clave de la exportación que no es una tabla del legacy: el contador, las claves primarias o las columnas del motor. */
export const isTechnicalKey = (key) => key.startsWith('$') || COUNTER_TABLES.includes(key);

export function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

export const lines = (out) => String(out).split(/\r?\n/).filter((l) => l !== '');
export const rows = (out) => lines(out).map((l) => l.split('\t'));

/** Lo que cambió entre dos exportaciones, por clave primaria (una tabla sin ella, por la fila entera; un contador, por su nombre). */
export function dbDiff(before, after) {
  const keys = { ...(before?.$keys ?? {}), ...(after?.$keys ?? {}) };
  const onUpdate = { ...(before?.$onUpdate ?? {}), ...(after?.$onUpdate ?? {}) };
  const keyOf = (t, row) => JSON.stringify(COUNTER_TABLES.includes(t) ? row.name : keys[t]?.length ? keys[t].map((k) => row[k]) : row);
  const mark = (t, row) => (onUpdate[t]?.length ? { ...row, ...Object.fromEntries(onUpdate[t].filter((c) => c in row).map((c) => [c, ON_UPDATE_MARK])) } : row);
  const diff = {};
  for (const t of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !k.startsWith('$')).sort()) {
    const b = new Map((before?.[t] ?? []).map((r) => [keyOf(t, r), mark(t, r)]));
    const a = new Map((after?.[t] ?? []).map((r) => [keyOf(t, r), mark(t, r)]));
    const added = [...a].filter(([k]) => !b.has(k)).map(([, r]) => r);
    const removed = [...b].filter(([k]) => !a.has(k)).map(([, r]) => r);
    const changed = [...a].filter(([k, r]) => b.has(k) && JSON.stringify(b.get(k)) !== JSON.stringify(r)).map(([k, r]) => ({ before: b.get(k), after: r }));
    if (added.length || removed.length || changed.length) diff[t] = { added, removed, changed };
  }
  return diff;
}

/** La huella de una exportación: el contenido, contador incluido, sin lo que describe la base (las claves `$`). */
export function contentHash(exported) {
  const content = Object.fromEntries(Object.entries(exported).filter(([k]) => !k.startsWith('$')));
  return crypto.createHash('md5').update(JSON.stringify(content)).digest('hex');
}
