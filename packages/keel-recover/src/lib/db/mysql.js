// MySQL desde dentro de su contenedor, con mysql y mysqldump. Lo que hace cada pieza sale de la corrida a
// mano de show-ticketing (docs/recover-bench/show-ticketing.answers.yaml, ST-ENV-11 y ST-ENV-12; MySQL 8.0.26):
//
//   - El snapshot es `mysqldump --single-transaction --no-tablespaces` y la restauración `source` de ese
//     archivo: funcionan con la app conectada (sesiones ociosas del pool) y devuelven AUTO_INCREMENT, el
//     consumido por una escritura fallida incluido. Sin `--no-tablespaces`, el usuario de la app (sin el
//     privilegio PROCESS) no puede volcar. Con una transacción abierta sobre una tabla, el DROP TABLE del
//     volcado espera su metadata lock (M-01, medido con fixtures/sandbox/node-mysql): la restauración lleva un
//     tope y sale en rojo con quién la retiene.
//   - La huella es la del CONTENIDO más el AUTO_INCREMENT de cada tabla, y el contador se lee con
//     `information_schema_stats_expiry = 0`: por defecto information_schema lo cachea un día y la huella no
//     vería la inserción (el mismo problema que pg_stat en PostgreSQL 9.4).
//   - El AUTO_INCREMENT es una tabla más (`_auto_increment`) en la exportación y en el diff: una escritura
//     que falla lo consume, así que es un efecto, como las secuencias.
//   - Una fila es una línea de JSON_OBJECT en orden de la clave primaria, con `-r`: `-B` solo reescapa las
//     barras del JSON y lo deja inválido. DECIMAL va a texto (como número JSON pierde la escala), el
//     binario a hex (JSON_OBJECT lo da como "base64:type15:…") y DATETIME/TIMESTAMP a la forma ISO que da
//     PostgreSQL, con la sesión en UTC. Las fechas cero salen como texto literal ("0000-00-00",
//     "0000-00-00T00:00:00") y una TIMESTAMP en UTC aunque el servidor corra en otra zona (medido con
//     fixtures/sandbox/node-mysql: el servidor en -05:00 y con el sql_mode de 5.6).
//
// El SQL va por stdin y la contraseña por entorno (`MYSQL_PWD`): el cliente de contenedores se come las
// comillas de la línea de comandos. Sin credenciales en la sección `database` (sandbox.yaml), se entra con
// las de la imagen oficial, leídas del entorno del propio contenedor: `MYSQL_USER`/`MYSQL_PASSWORD` si se
// nombra el usuario, y si no root con `MYSQL_ROOT_PASSWORD`. Desde 8.0: el contador en caché no existe
// antes y show-ticketing no carga en 5.7.

import { HISTORY_TABLES, contentHash, dbDiff, lines, rows, tail } from './relational.js';

export { dbDiff };

export const SNAPSHOT_FILE = '/tmp/recover-snapshot.sql';

export const ENUM_MAX_VALUES = 12;
const STATE_TYPES = new Set(['varchar', 'char', 'enum', 'int', 'tinyint', 'smallint', 'mediumint']);

/** Un identificador entre comillas invertidas. */
export const ident = (name) => `\`${String(name).replace(/`/g, '``')}\``;
/** Un literal de texto SQL (con la barra como escape, el modo por defecto de MySQL). */
export const literal = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

// Cada consulta fija el contador fresco y la zona: una TIMESTAMP sale en UTC, como en el volcado.
export const SESSION = `set session information_schema_stats_expiry = 0;\nset session time_zone = '+00:00';\n`;

/** El cliente (mysql o mysqldump) con las credenciales: las de `database`, o las de la imagen leídas del contenedor. */
export function clientArgs(database, tool, args) {
  const user = database.auth?.user ?? database.user ?? null;
  const password = database.auth?.password ?? database.password ?? null;
  if (password !== null) return ['env', `MYSQL_PWD=${password}`, tool, '-u', user ?? 'root', ...args];
  // $0 es la herramienta y "$@" el resto: la contraseña no pasa por la línea de comandos.
  const env = user ? 'MYSQL_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
  return ['sh', '-c', `MYSQL_PWD=$${env} exec "$0" "$@"`, tool, '-u', user ?? 'root', ...args];
}

/** mysql dentro del contenedor, el SQL por stdin: `{ ok, out }` o `{ ok: false, error }`. */
export function mysql(rt, c, database, sql) {
  const r = rt.exec(c, clientArgs(database, 'mysql', ['-N', '-B', '-r', '--default-character-set=utf8mb4', database.name]), { input: SESSION + sql });
  if (r.status === 0) return { ok: true, out: r.stdout };
  const err = tail(r.stderr || r.stdout) || `mysql salió con ${r.status}`;
  // 5.7 no tiene la variable: es la versión que keel-recover no ha medido, no un fallo de la consulta
  return { ok: false, error: /information_schema_stats_expiry/.test(err) ? `MySQL anterior a 8.0 (sin medir: keel-recover lee MySQL desde 8.0): ${err}` : err };
}

// ── catálogo ────────────────────────────────────────────────────────────────────────────────

export const COLUMNS_SQL = `select c.table_name, c.column_name, c.data_type from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = database() order by c.table_name, c.ordinal_position;`;

export const PRIMARY_KEYS_SQL = `select table_name, column_name from information_schema.key_column_usage
  where table_schema = database() and constraint_name = 'PRIMARY' order by table_name, ordinal_position;`;

/** `{ tables: { nombre: { columns: [[columna, tipo]…], pk: [columna…] } } }` de la base. */
export function catalog(rt, c, database) {
  const cols = mysql(rt, c, database, COLUMNS_SQL);
  if (!cols.ok) return cols;
  const pks = mysql(rt, c, database, PRIMARY_KEYS_SQL);
  if (!pks.ok) return pks;
  return { ok: true, value: { tables: shapeCatalog(rows(cols.out), rows(pks.out)) } };
}

/** Las filas del catálogo a `{ tabla: { columns, pk } }` (puro). */
export function shapeCatalog(columns, pks) {
  const tables = {};
  for (const [t, col, type] of columns) (tables[t] ??= { columns: [], pk: [] }).columns.push([col, type.toLowerCase()]);
  for (const [t, col] of pks) tables[t]?.pk.push(col);
  return tables;
}

// ── exportación, diff y huella ───────────────────────────────────────────────────────────────

/** Cómo viaja una columna en el JSON de su fila (ST-ENV-12). */
export function valueExpr(column, type) {
  const col = ident(column);
  if (type === 'decimal' || type === 'numeric') return `cast(${col} as char)`;
  if (/binary|blob/.test(type) || type === 'bit') return `hex(${col})`;
  if (type === 'datetime' || type === 'timestamp') return `replace(cast(${col} as char), ' ', 'T')`;
  return col;
}

/**
 * El SELECT que vuelca el contenido: una línea por fila («tabla<TAB>json»), cada tabla en orden de su
 * clave primaria (sin ella, por la fila entera), y una por tabla con AUTO_INCREMENT.
 */
export function exportSql({ tables }) {
  const parts = Object.entries(tables).map(([t, { columns, pk }]) => {
    const row = `json_object(${columns.map(([col, type]) => `${literal(col)}, ${valueExpr(col, type)}`).join(', ')})`;
    const order = pk.length ? pk.map(ident).join(', ') : `cast(${row} as char)`;
    return `select ${literal(t)}, ${row} from ${ident(t)} order by ${order};`;
  });
  parts.push(`select '_auto_increment', json_object('name', table_name, 'next', auto_increment) from information_schema.tables
  where table_schema = database() and table_type = 'BASE TABLE' and auto_increment is not null order by table_name;`);
  return parts.join('\n');
}

/** Lee la salida de `exportSql`: `{ tabla: [filas], _auto_increment: [{ name, next }] }`; una tabla vacía no da líneas. */
export function parseExport(out, tableNames) {
  const doc = Object.fromEntries(tableNames.map((t) => [t, []]));
  doc._auto_increment = [];
  for (const l of lines(out)) {
    const i = l.indexOf('\t');
    const key = l.slice(0, i);
    if (!doc[key]) throw new Error(`fila de una tabla que el catálogo no tiene: ${key}`);
    doc[key].push(JSON.parse(l.slice(i + 1)));
  }
  return doc;
}

/** El contenido entero como JSON plano; las claves primarias viajan en `$keys` (el diff las usa y no se comparan). */
export function exportDb(rt, c, database) {
  const cat = catalog(rt, c, database);
  if (!cat.ok) return cat;
  const r = mysql(rt, c, database, exportSql(cat.value));
  if (!r.ok) return r;
  try {
    const $keys = Object.fromEntries(Object.entries(cat.value.tables).map(([t, { pk }]) => [t, pk]));
    return { ok: true, value: { ...parseExport(r.out, Object.keys(cat.value.tables)), $keys } };
  } catch (err) {
    return { ok: false, error: `la salida de mysql no se pudo leer: ${err.message}` };
  }
}

/** Huella del contenido: cambia con cualquier escritura, AUTO_INCREMENT incluido, y no depende de la caché de information_schema. */
export function fingerprint(rt, c, database) {
  const e = exportDb(rt, c, database);
  return e.ok ? { ok: true, value: contentHash(e.value) } : e;
}

// ── snapshot ─────────────────────────────────────────────────────────────────────────────────

export const DUMP_ARGS = ['--single-transaction', '--routines', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF', `--result-file=${SNAPSHOT_FILE}`];

/** El estado de partida de las sondas: el volcado y su huella, para comprobar cada restauración. */
export function takeSnapshot(rt, c, database) {
  const hash = fingerprint(rt, c, database);
  if (!hash.ok) return { ok: false, error: hash.error };
  const r = rt.exec(c, clientArgs(database, 'mysqldump', [...DUMP_ARGS, database.name]));
  return r.status === 0 ? { ok: true, where: `${c}:${SNAPSHOT_FILE}`, hash: hash.value } : { ok: false, error: tail(r.stderr || r.stdout) || `mysqldump salió con ${r.status}` };
}

export function hasSnapshot(rt, c) {
  return rt.exec(c, ['test', '-s', SNAPSHOT_FILE]).status === 0;
}

export const NO_SNAPSHOT = (c, sandboxRel) =>
  `no hay snapshot en ${c}:${SNAPSHOT_FILE} (se pierde al recrear el sandbox): vuelve a pasar keel-recover verify ${sandboxRel} --no-up`;

// Cuánto espera cada DROP TABLE del volcado el metadata lock de su tabla. El de MySQL es un año: con una
// transacción abierta sobre la tabla (de la app o de otra sesión), la restauración se quedaría colgada (M-01,
// medido con fixtures/sandbox/node-mysql). Una restauración normal tarda segundos.
export const RESTORE_LOCK_WAIT_SECONDS = 20;

// Las transacciones abiertas, con quién las tiene y desde hace cuánto: el motivo de una restauración que no
// consigue el metadata lock.
export const OPEN_TRANSACTIONS_SQL = `select t.trx_mysql_thread_id, coalesce(p.user, ''), coalesce(p.host, ''), timestampdiff(second, t.trx_started, now())
  from information_schema.innodb_trx t left join information_schema.processlist p on p.id = t.trx_mysql_thread_id order by t.trx_started;`;

/**
 * Vuelve la base al snapshot: el volcado borra y recrea cada tabla con sus filas y su AUTO_INCREMENT. El
 * cliente lo lee dentro del contenedor (`source`) y en modo batch para en el primer error. Una tabla que la
 * sonda creara fuera del volcado sobreviviría, pero la huella de después la delata. Si una transacción abierta
 * retiene una tabla, sale en rojo a los RESTORE_LOCK_WAIT_SECONDS con quién la tiene, en vez de colgarse.
 */
export function restoreSnapshot(rt, c, database) {
  const r = mysql(rt, c, database, `set session lock_wait_timeout = ${RESTORE_LOCK_WAIT_SECONDS};\nsource ${SNAPSHOT_FILE}\n`);
  if (r.ok) return { ok: true };
  if (!/ERROR 1205\b/.test(r.error)) return { ok: false, error: `la restauración de ${SNAPSHOT_FILE} falló: ${r.error}` };
  const open = mysql(rt, c, database, OPEN_TRANSACTIONS_SQL);
  const who = open.ok ? rows(open.out).map(([id, user, host, age]) => `sesión ${id}${user ? ` de ${user}@${host}` : ''}, abierta hace ${age} s`) : [];
  return {
    ok: false,
    error:
      `la restauración de ${SNAPSHOT_FILE} esperó ${RESTORE_LOCK_WAIT_SECONDS} s el metadata lock de una tabla y no lo obtuvo: una transacción abierta la retiene ` +
      `(${who.length ? who.join('; ') : 'sin ninguna en innodb_trx: un LOCK TABLES o una sesión sobre MyISAM'}). La base puede haber quedado a medias: ` +
      `cuando se cierre, vuelve a restaurar (${r.error})`,
  };
}

// ── introspección ────────────────────────────────────────────────────────────────────────────

export const TABLES_SQL = `select table_name, coalesce(engine, '') from information_schema.tables
  where table_schema = database() and table_type = 'BASE TABLE' order by table_name;`;

export const INTROSPECT_COLUMNS_SQL = `select table_name, column_name, data_type, coalesce(character_maximum_length, ''), coalesce(numeric_precision, ''), coalesce(numeric_scale, ''),
    is_nullable, coalesce(column_default, ''), coalesce(collation_name, ''), extra, column_type
  from information_schema.columns where table_schema = database() order by table_name, ordinal_position;`;

// Las restricciones con sus columnas en orden; la acción de borrado de una FK, de referential_constraints.
export const CONSTRAINTS_SQL = `select tc.table_name, tc.constraint_name, tc.constraint_type,
    coalesce((select group_concat(k.column_name order by k.ordinal_position) from information_schema.key_column_usage k
      where k.constraint_schema = tc.constraint_schema and k.table_name = tc.table_name and k.constraint_name = tc.constraint_name), ''),
    coalesce(rc.referenced_table_name, ''),
    coalesce((select group_concat(k.referenced_column_name order by k.ordinal_position) from information_schema.key_column_usage k
      where k.constraint_schema = tc.constraint_schema and k.table_name = tc.table_name and k.constraint_name = tc.constraint_name), ''),
    coalesce(rc.delete_rule, ''),
    coalesce((select cc.check_clause from information_schema.check_constraints cc where cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name), '')
  from information_schema.table_constraints tc
  left join information_schema.referential_constraints rc on rc.constraint_schema = tc.constraint_schema and rc.table_name = tc.table_name and rc.constraint_name = tc.constraint_name
  where tc.table_schema = database() order by tc.table_name, tc.constraint_type, tc.constraint_name;`;

// Los índices que no son de una restricción (PK, UNIQUE): los de una FK sí salen, porque InnoDB los crea solos
// con el nombre de la restricción y son índices de verdad.
export const INDEXES_SQL = `select s.table_name, s.index_name, max(s.non_unique), group_concat(s.column_name order by s.seq_in_index)
  from information_schema.statistics s where s.table_schema = database()
    and not exists (select 1 from information_schema.table_constraints tc where tc.table_schema = s.table_schema and tc.table_name = s.table_name
      and tc.constraint_name = s.index_name and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE'))
  group by s.table_name, s.index_name order by 1, 2;`;

const CONSTRAINT_TYPES = { 'PRIMARY KEY': 'p', UNIQUE: 'u', 'FOREIGN KEY': 'f', CHECK: 'c' };

/** Las filas del catálogo, a la forma de surface.yaml (puro: lo prueba test/db.test.js con salidas grabadas). */
export function shapeTables({ tables, columns, constraints, indexes }) {
  return tables.map(([name, engine, count]) => {
    const t = { name, rows: Number(count), engine, columns: [] };
    for (const [table, col, type, length, precision, scale, nullable, def, collation, extra, columnType] of columns) {
      if (table !== name) continue;
      const c = { name: col, type, nullable: nullable === 'YES' };
      if (length) c.length = Number(length);
      if (precision && /decimal|numeric/.test(type)) Object.assign(c, { precision: Number(precision), scale: Number(scale) });
      if (def) c.default = def;
      if (/auto_increment/i.test(extra)) c.autoIncrement = true;
      if (/unsigned/.test(columnType)) c.unsigned = true;
      if (type === 'enum' || type === 'set') c.values = columnType.slice(type.length + 2, -2).split("','").map((v) => v.replace(/''/g, "'"));
      if (collation) c.collation = collation;
      t.columns.push(c);
    }
    for (const [table, conname, kind, cols, ref, refCols, del, check] of constraints) {
      if (table !== name) continue;
      const list = cols ? cols.split(',') : [];
      const type = CONSTRAINT_TYPES[kind];
      if (type === 'p') t.primaryKey = list;
      else if (type === 'u') (t.unique ??= []).push(list);
      else if (type === 'f') (t.foreignKeys ??= []).push({ name: conname, columns: list, references: { table: ref, columns: refCols.split(',') }, onDelete: del.toLowerCase() });
      else if (type === 'c') (t.checks ??= []).push(check);
    }
    for (const [table, idx, nonUnique, cols] of indexes) {
      if (table === name) (t.indexes ??= []).push({ name: idx, definition: `${nonUnique === '0' ? 'UNIQUE ' : ''}INDEX ${idx} (${cols})` });
    }
    return t;
  });
}

/** Qué columnas parecen de estado: pocos valores distintos, en más de una fila y no todas distintas. */
export function shapeStates(samples) {
  const order = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
  return samples
    .filter(([, , total, distinct]) => Number(total) > 1 && Number(distinct) > 0 && Number(distinct) <= ENUM_MAX_VALUES && Number(distinct) < Number(total))
    .map(([table, column, , , values]) => ({ table, column, values: JSON.parse(values).sort(order) }));
}

/** Paso 1a, datos: tablas con motor, columnas (collation y AUTO_INCREMENT incluidos), claves, restricciones, índices y columnas de estado. */
export function introspectDb(rt, c, database) {
  const q = (sql) => mysql(rt, c, database, sql);
  const list = q(TABLES_SQL);
  if (!list.ok) return list;
  const names = rows(list.out);
  const counts = names.length ? q(`${names.map(([t]) => `select ${literal(t)}, count(*) from ${ident(t)}`).join('\nunion all\n')};`) : { ok: true, out: '' };
  const columns = q(INTROSPECT_COLUMNS_SQL);
  const constraints = q(CONSTRAINTS_SQL);
  const indexes = q(INDEXES_SQL);
  const failed = [counts, columns, constraints, indexes].find((r) => !r.ok);
  if (failed) return failed;
  const countOf = Object.fromEntries(rows(counts.out));
  const tables = shapeTables({ tables: names.map(([t, engine]) => [t, engine, countOf[t] ?? '0']), columns: rows(columns.out), constraints: rows(constraints.out), indexes: rows(indexes.out) });
  // las candidatas a estado: texto o entero, sin ser clave primaria, ajena ni única (esas no son un estado)
  const candidates = tables.flatMap((t) => {
    const keyed = new Set([...(t.primaryKey ?? []), ...(t.foreignKeys ?? []).flatMap((f) => f.columns), ...(t.unique ?? []).filter((u) => u.length === 1).flat()]);
    return t.columns.filter((col) => STATE_TYPES.has(col.type) && !keyed.has(col.name)).map((col) => [t.name, col.name]);
  });
  let states = [];
  if (candidates.length) {
    // JSON_ARRAYAGG no admite ORDER BY: los valores se ordenan en shapeStates
    const s = q(
      `${candidates
        .map(([t, col]) => `select ${literal(t)}, ${literal(col)}, (select count(*) from (select 1 from ${ident(t)} limit 5000) n), (select count(distinct v) from (select ${ident(col)} v from ${ident(t)} limit 5000) d), (select coalesce(json_arrayagg(v), json_array()) from (select distinct ${ident(col)} v from (select ${ident(col)} from ${ident(t)} limit 5000) l where ${ident(col)} is not null limit ${ENUM_MAX_VALUES + 1}) s)`)
        .join('\nunion all\n')};`
    );
    if (!s.ok) return s;
    states = shapeStates(rows(s.out));
  }
  for (const st of states) {
    const t = tables.find((x) => x.name === st.table);
    (t.states ??= []).push({ column: st.column, values: st.values });
  }
  return { ok: true, value: { tables } };
}

// ── paridad ──────────────────────────────────────────────────────────────────────────────────

/**
 * Vacía las tablas del regenerado (menos el historial de migraciones) y cuenta las filas que quedan: cada
 * flujo de la paridad parte de la base vacía. TRUNCATE reinicia el AUTO_INCREMENT; con las FK desactivadas en
 * la sesión, el orden no importa. `{ ok, remaining }`.
 */
export function emptyDatabase(rt, c, database) {
  const cat = catalog(rt, c, database);
  if (!cat.ok) return cat;
  const tables = Object.keys(cat.value.tables).filter((t) => !HISTORY_TABLES.includes(t));
  if (!tables.length) return { ok: true, remaining: '0' };
  const r = mysql(rt, c, database, `set foreign_key_checks = 0;\n${tables.map((t) => `truncate table ${ident(t)};`).join('\n')}\nset foreign_key_checks = 1;\nselect ${tables.map((t) => `(select count(*) from ${ident(t)})`).join(' + ')};`);
  return r.ok ? { ok: true, remaining: lines(r.out).at(-1)?.trim() ?? '?' } : r;
}

/** Carga el infra/fixtures.sql del regenerado, en una transacción. */
export function loadScript(rt, c, database, sql) {
  return mysql(rt, c, database, `start transaction;\n${sql}\ncommit;\n`);
}
