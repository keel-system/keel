// Lo que comparten los adaptadores relacionales (postgresql.js, mysql.js): la forma de la exportación, el
// diff por clave primaria, la huella del contenido y el historial de migraciones que la paridad no vacía.
//
// La exportación es `{ tabla: [filas], <contador>: [{ name, … }], $keys: { tabla: [pk…] } }`. El contador
// es lo que el motor consume al dar un id, también cuando la escritura falla: las secuencias de PostgreSQL
// (`_sequences`, SA-EFFECT-04) y el AUTO_INCREMENT de MySQL (`_auto_increment`, ST-ENV-11). Es un efecto,
// pero técnico: va al diff y a la huella, y no es una tabla del legacy.

import crypto from 'node:crypto';

/** Las tablas de historial de migraciones de los generadores de keel y de las herramientas habituales: la paridad no las vacía. */
export const HISTORY_TABLES = ['flyway_schema_history', 'typeorm_migrations', 'ef_migrations_history', 'databasechangelog', 'databasechangeloglock', 'SequelizeMeta', 'knex_migrations', 'knex_migrations_lock', 'schema_migrations'];

/** Las «tablas» de la exportación que son el contador de ids de cada motor, casadas por nombre. */
export const COUNTER_TABLES = ['_sequences', '_auto_increment'];

/** Una clave de la exportación que no es una tabla del legacy: el contador o las claves primarias. */
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
  const keyOf = (t, row) => JSON.stringify(COUNTER_TABLES.includes(t) ? row.name : keys[t]?.length ? keys[t].map((k) => row[k]) : row);
  const diff = {};
  for (const t of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => k !== '$keys').sort()) {
    const b = new Map((before?.[t] ?? []).map((r) => [keyOf(t, r), r]));
    const a = new Map((after?.[t] ?? []).map((r) => [keyOf(t, r), r]));
    const added = [...a].filter(([k]) => !b.has(k)).map(([, r]) => r);
    const removed = [...b].filter(([k]) => !a.has(k)).map(([, r]) => r);
    const changed = [...a].filter(([k, r]) => b.has(k) && JSON.stringify(b.get(k)) !== JSON.stringify(r)).map(([k, r]) => ({ before: b.get(k), after: r }));
    if (added.length || removed.length || changed.length) diff[t] = { added, removed, changed };
  }
  return diff;
}

/** La huella de una exportación: el contenido, contador incluido, sin las claves primarias. */
export function contentHash(exported) {
  const { $keys, ...content } = exported;
  return crypto.createHash('md5').update(JSON.stringify(content)).digest('hex');
}
