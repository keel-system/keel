// PostgreSQL desde dentro de su contenedor, con psql, pg_dump y pg_restore. Lo que hace cada pieza
// sale de la corrida a mano de shop-api (docs/recover-bench/shop-api.answers.yaml, SA-ENV-10):
//
//   - El snapshot es `pg_dump -Fc` y la restauración `pg_restore --clean`: funcionan con la app
//     conectada y devuelven también las secuencias, así que la misma sonda vuelve a dar los mismos
//     ids. `CREATE DATABASE … TEMPLATE` no sirve: el pool de la app tiene sesiones abiertas.
//   - La huella es la del CONTENIDO (cada tabla ordenada por su clave primaria, más el valor de cada
//     secuencia), no los contadores de pg_stat_user_tables: en un 9.4 llegan segundos tarde, y un
//     juez que los lea al instante da en rojo un legacy sano.
//   - Las secuencias son una tabla más (`_sequences`) en la exportación y en el diff: consumir un
//     id es un efecto, también cuando la escritura falla (SA-EFFECT-04).
//
// Todo va por psql con `-f -` (el SQL por stdin): en Windows el cliente de contenedores se come las
// comillas de la línea de comandos. Sirve desde 9.4 (json_agg ordenado, json_build_object).

import crypto from 'node:crypto';

export const SNAPSHOT_FILE = '/tmp/recover-snapshot.pgdump';

/** Las tablas de historial de migraciones de los generadores de keel y de las herramientas habituales: la paridad no las vacía. */
export const HISTORY_TABLES = ['flyway_schema_history', 'typeorm_migrations', 'ef_migrations_history', 'databasechangelog', 'databasechangeloglock', 'SequelizeMeta', 'knex_migrations', 'knex_migrations_lock', 'schema_migrations'];

// Las columnas de estado se reconocen por su forma, igual que en MongoDB: pocos valores distintos en
// más de una fila. Aquí también los enteros, porque un legacy relacional guarda así su estado
// (shop-api: order_status 0/1/2, sin CHECK ni ENUM).
export const ENUM_MAX_VALUES = 12;
const STATE_TYPES = new Set(['text', 'character varying', 'character', 'integer', 'smallint']);

function tail(text, n = 300) {
  const t = String(text).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

const userOf = (database) => database.auth?.user ?? database.user ?? 'postgres';

/** Un identificador entre comillas dobles, como lo escribe quote_ident. */
export const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
/** Un literal de texto SQL. */
export const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** psql dentro del contenedor: `{ ok, out }` o `{ ok: false, error }`. */
export function psql(rt, c, database, sql) {
  const password = database.auth?.password ?? database.password ?? null;
  const args = [...(password ? ['env', `PGPASSWORD=${password}`] : []), 'psql', '-X', '-q', '-U', userOf(database), '-d', database.name, '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
  const r = rt.exec(c, args, { input: sql });
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, error: tail(r.stderr || r.stdout) || `psql salió con ${r.status}` };
}

const lines = (out) => String(out).split(/\r?\n/).filter((l) => l !== '');
const rows = (out) => lines(out).map((l) => l.split('\t'));

// ── catálogo ────────────────────────────────────────────────────────────────────────────────

export const TABLES_SQL = `select t.table_name, coalesce(string_agg(k.column_name, ',' order by k.ordinal_position), '')
  from information_schema.tables t
  left join information_schema.table_constraints c on c.table_schema = t.table_schema and c.table_name = t.table_name and c.constraint_type = 'PRIMARY KEY'
  left join information_schema.key_column_usage k on k.constraint_schema = c.constraint_schema and k.constraint_name = c.constraint_name
  where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
  group by t.table_name order by t.table_name;`;

export const SEQUENCES_SQL = `select sequence_name from information_schema.sequences where sequence_schema = 'public' order by 1;`;

/** `{ tables: { nombre: [pk…] }, sequences: [nombre…] }` del esquema public. */
export function catalog(rt, c, database) {
  const t = psql(rt, c, database, TABLES_SQL);
  if (!t.ok) return t;
  const s = psql(rt, c, database, SEQUENCES_SQL);
  if (!s.ok) return s;
  return { ok: true, value: { tables: Object.fromEntries(rows(t.out).map(([name, pk]) => [name, pk ? pk.split(',') : []])), sequences: lines(s.out) } };
}

// ── exportación, diff y huella ───────────────────────────────────────────────────────────────

/**
 * El SELECT que vuelca el contenido: una línea por tabla («nombre<TAB>json») y una por secuencia.
 * Cada tabla, ordenada por su clave primaria (sin ella, por la fila entera); json_agg separa los
 * elementos con saltos de línea, que se quitan (dentro de una cadena JSON un salto va escapado).
 */
export function exportSql({ tables, sequences }) {
  const parts = Object.entries(tables).map(([t, pk]) => {
    const order = pk.length ? pk.map((k) => `x.${ident(k)}`).join(', ') : 'x::text';
    return `select ${literal(t)}, replace(coalesce((select json_agg(x order by ${order}) from ${ident(t)} x)::text, '[]'), chr(10), ' ')`;
  });
  for (const s of sequences) parts.push(`select ${literal(`_sequences.${s}`)}, (select json_build_object('name', ${literal(s)}, 'last_value', last_value, 'is_called', is_called) from ${ident(s)})::text`);
  return parts.length ? `${parts.join('\nunion all\n')};` : `select 'nada', '[]' where false;`;
}

/** Lee la salida de `exportSql`: `{ tabla: [filas], _sequences: [{ name, last_value, is_called }] }`. */
export function parseExport(out) {
  const doc = {};
  for (const l of lines(out)) {
    const i = l.indexOf('\t');
    const [key, json] = [l.slice(0, i), l.slice(i + 1)];
    if (key.startsWith('_sequences.')) (doc._sequences ??= []).push(JSON.parse(json));
    else doc[key] = JSON.parse(json);
  }
  return doc;
}

/**
 * El contenido entero como JSON plano. Las claves primarias viajan en `$keys` (no es una tabla: el
 * diff las usa para casar filas y no se compara).
 */
export function exportDb(rt, c, database) {
  const cat = catalog(rt, c, database);
  if (!cat.ok) return cat;
  const r = psql(rt, c, database, exportSql(cat.value));
  if (!r.ok) return r;
  try {
    return { ok: true, value: { ...parseExport(r.out), $keys: cat.value.tables } };
  } catch (err) {
    return { ok: false, error: `la salida de psql no se pudo leer: ${err.message}` };
  }
}

/** Huella del contenido: cambia con cualquier escritura, secuencias incluidas, y no depende de las estadísticas. */
export function fingerprint(rt, c, database) {
  const e = exportDb(rt, c, database);
  if (!e.ok) return e;
  const { $keys, ...content } = e.value;
  return { ok: true, value: crypto.createHash('md5').update(JSON.stringify(content)).digest('hex') };
}

/** Lo que cambió entre dos exportaciones, por clave primaria (una tabla sin ella, por la fila entera; una secuencia, por su nombre). */
export function dbDiff(before, after) {
  const keys = { ...(before?.$keys ?? {}), ...(after?.$keys ?? {}) };
  const keyOf = (t, row) => JSON.stringify(t === '_sequences' ? row.name : keys[t]?.length ? keys[t].map((k) => row[k]) : row);
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

// ── snapshot ─────────────────────────────────────────────────────────────────────────────────

/** El estado de partida de las sondas: el volcado y su huella, para comprobar cada restauración. */
export function takeSnapshot(rt, c, database) {
  const hash = fingerprint(rt, c, database);
  if (!hash.ok) return { ok: false, error: hash.error };
  const r = rt.exec(c, ['pg_dump', '-U', userOf(database), '-Fc', '-f', SNAPSHOT_FILE, database.name]);
  return r.status === 0 ? { ok: true, where: `${c}:${SNAPSHOT_FILE}`, hash: hash.value } : { ok: false, error: tail(r.stderr || r.stdout) };
}

export function hasSnapshot(rt, c) {
  return rt.exec(c, ['test', '-s', SNAPSHOT_FILE]).status === 0;
}

export const NO_SNAPSHOT = (c, sandboxRel) =>
  `no hay snapshot en ${c}:${SNAPSHOT_FILE} (se pierde al recrear el sandbox): vuelve a pasar keel-recover verify ${sandboxRel} --no-up`;

/**
 * Vuelve la base al snapshot: cada objeto del volcado se borra y se recrea, con sus filas y el valor
 * de sus secuencias. Una tabla que la sonda creara fuera del volcado sobreviviría, pero la huella de
 * después (comprobada contra la del snapshot) la delata.
 */
export function restoreSnapshot(rt, c, database) {
  const r = rt.exec(c, ['pg_restore', '-U', userOf(database), '--clean', '--if-exists', '-d', database.name, SNAPSHOT_FILE]);
  const err = tail(r.stderr || r.stdout);
  return r.status === 0 ? { ok: true } : { ok: false, error: `pg_restore salió con ${r.status} sobre ${SNAPSHOT_FILE}${err ? `: ${err}` : ''}` };
}

// ── introspección ────────────────────────────────────────────────────────────────────────────

export const COLUMNS_SQL = `select table_name, column_name, data_type, coalesce(character_maximum_length::text, ''), coalesce(numeric_precision::text, ''), coalesce(numeric_scale::text, ''), is_nullable, coalesce(column_default, '')
  from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position;`;

// pg_constraint y no information_schema: los CHECK de information_schema no traen su tabla en 9.4,
// y la acción de borrado de una FK está en confdeltype.
export const CONSTRAINTS_SQL = `select cl.relname, co.conname, co.contype,
    coalesce((select string_agg(a.attname, ',' order by k.n) from unnest(co.conkey) with ordinality k(attnum, n) join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.attnum), ''),
    coalesce(fr.relname, ''),
    coalesce((select string_agg(a.attname, ',' order by k.n) from unnest(co.confkey) with ordinality k(attnum, n) join pg_attribute a on a.attrelid = co.confrelid and a.attnum = k.attnum), ''),
    co.confdeltype, pg_get_constraintdef(co.oid)
  from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
  left join pg_class fr on fr.oid = co.confrelid
  where ns.nspname = 'public' order by cl.relname, co.contype, co.conname;`;

// Los índices que no son de una restricción (los de PK y UNIQUE ya salen con ella).
export const INDEXES_SQL = `select i.tablename, i.indexname, i.indexdef from pg_indexes i
  where i.schemaname = 'public' and not exists (select 1 from pg_constraint co where co.conname = i.indexname)
  order by 1, 2;`;

export const TYPES_SQL = `select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid = t.oid
  join pg_namespace ns on ns.oid = t.typnamespace where ns.nspname = 'public' group by t.typname order by 1;`;

const ON_DELETE = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

/** Las filas del catálogo, a la forma de surface.yaml (puro: lo prueba test/db.test.js con salidas grabadas). */
export function shapeTables({ tables, columns, constraints, indexes }) {
  return tables.map(([name, count]) => {
    const t = { name, rows: Number(count), columns: [] };
    for (const [table, col, type, length, precision, scale, nullable, def] of columns) {
      if (table !== name) continue;
      const c = { name: col, type, nullable: nullable === 'YES' };
      if (length) c.length = Number(length);
      if (precision && /numeric|decimal/.test(type)) Object.assign(c, { precision: Number(precision), scale: Number(scale) });
      if (def) c.default = def;
      t.columns.push(c);
    }
    for (const [table, conname, type, cols, ref, refCols, del, def] of constraints) {
      if (table !== name) continue;
      const list = cols ? cols.split(',') : [];
      if (type === 'p') t.primaryKey = list;
      else if (type === 'u') (t.unique ??= []).push(list);
      else if (type === 'f') (t.foreignKeys ??= []).push({ name: conname, columns: list, references: { table: ref, columns: refCols.split(',') }, onDelete: ON_DELETE[del] ?? del });
      else if (type === 'c') (t.checks ??= []).push(def);
    }
    for (const [table, idx, def] of indexes) if (table === name) (t.indexes ??= []).push({ name: idx, definition: def });
    return t;
  });
}

/** Qué columnas parecen de estado: pocos valores distintos, en más de una fila y no todas distintas. */
export function shapeStates(samples) {
  return samples
    .filter(([, , total, distinct]) => Number(total) > 1 && Number(distinct) > 0 && Number(distinct) <= ENUM_MAX_VALUES && Number(distinct) < Number(total))
    .map(([table, column, , , values]) => ({ table, column, values: JSON.parse(values) }));
}

/** Paso 1a, datos: tablas con columnas, claves, restricciones, índices y columnas de estado; secuencias y tipos ENUM. */
export function introspectDb(rt, c, database) {
  const q = (sql) => psql(rt, c, database, sql);
  const cat = catalog(rt, c, database);
  if (!cat.ok) return cat;
  const names = Object.keys(cat.value.tables);
  const counts = names.length ? q(`${names.map((t) => `select ${literal(t)}, count(*) from ${ident(t)}`).join('\nunion all\n')};`) : { ok: true, out: '' };
  const columns = q(COLUMNS_SQL);
  const constraints = q(CONSTRAINTS_SQL);
  const indexes = q(INDEXES_SQL);
  const types = q(TYPES_SQL);
  const failed = [counts, columns, constraints, indexes, types].find((r) => !r.ok);
  if (failed) return failed;
  const tables = shapeTables({ tables: rows(counts.out), columns: rows(columns.out), constraints: rows(constraints.out), indexes: rows(indexes.out) });
  // las candidatas a estado: texto o entero, sin ser clave primaria, ajena ni única (esas no son un estado)
  const candidates = tables.flatMap((t) => {
    const keyed = new Set([...(t.primaryKey ?? []), ...(t.foreignKeys ?? []).flatMap((f) => f.columns), ...(t.unique ?? []).filter((u) => u.length === 1).flat()]);
    return t.columns.filter((col) => STATE_TYPES.has(col.type) && !keyed.has(col.name)).map((col) => [t.name, col.name]);
  });
  let states = [];
  if (candidates.length) {
    const s = q(
      `${candidates
        .map(([t, col]) => `select ${literal(t)}, ${literal(col)}, (select count(*) from (select 1 from ${ident(t)} limit 5000) n), (select count(distinct v) from (select ${ident(col)} v from ${ident(t)} limit 5000) d), (select coalesce(json_agg(v order by v), '[]')::text from (select distinct ${ident(col)} v from (select ${ident(col)} from ${ident(t)} limit 5000) l where ${ident(col)} is not null limit ${ENUM_MAX_VALUES + 1}) s)`)
        .join('\nunion all\n')};`
    );
    if (!s.ok) return s;
    states = shapeStates(rows(s.out));
  }
  for (const st of states) {
    const t = tables.find((x) => x.name === st.table);
    (t.states ??= []).push({ column: st.column, values: st.values });
  }
  const value = { tables, sequences: cat.value.sequences.map((name) => ({ name })) };
  const enums = rows(types.out).map(([name, labels]) => ({ name, values: labels.split(',') }));
  if (enums.length) value.types = enums;
  return { ok: true, value };
}

// ── paridad ──────────────────────────────────────────────────────────────────────────────────

/**
 * Vacía las tablas del regenerado (menos el historial de migraciones) y reinicia sus secuencias, y
 * cuenta las filas que quedan: cada flujo de la paridad parte de la base vacía. `{ ok, remaining }`.
 */
export function emptyDatabase(rt, c, database) {
  const cat = catalog(rt, c, database);
  if (!cat.ok) return cat;
  const tables = Object.keys(cat.value.tables).filter((t) => !HISTORY_TABLES.includes(t));
  if (!tables.length) return { ok: true, remaining: '0' };
  const list = tables.map(ident).join(', ');
  const r = psql(rt, c, database, `truncate table ${list} restart identity cascade;\nselect ${tables.map((t) => `(select count(*) from ${ident(t)})`).join(' + ')};`);
  return r.ok ? { ok: true, remaining: lines(r.out).at(-1)?.trim() ?? '?' } : r;
}
