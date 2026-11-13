// El almacén del historial de cambios (DSL 2.29, D6 y D11 de PLAN-DSL-229-HISTORIAL.md), como DATOS: lo mismo en los
// cuatro generadores, que comparten base y esquema, como OUTBOX_EVENT (messaging-stores.js). Lo que cambia entre
// lenguajes (la entidad, el adaptador que escribe la entrada en la transacción de la escritura, la consulta paginada)
// es de cada uno. Las SENTENCIAS por motor sí son de aquí (`historyStatements`): son contrato de los cuatro, que comparten
// la tabla, y las mide `scripts/timer-sql-check.js` contra PostgreSQL y MySQL.
//
// Dos tablas en el relacional y no una columna JSON: el filtro por campo no puede depender de un operador JSON propio de
// cada motor (T2). `change_history_field` guarda, por cada cambio de una entrada, su ruta entera y el campo de la raíz que
// la contiene, y el filtro es una igualdad sobre cualquiera de las dos (`historyMatches` en history.js).

import { topFieldOf } from './history.js';

/**
 * Una entrada del historial: una escritura confirmada sobre un agregado.
 *
 *   · root_type es el nombre de la raíz en el diseño y root_id el texto de su id: una tabla por servicio, no por raíz;
 *   · changes es la lista `[{ field, before, after }]` serializada con las reglas del cable, y viaja TAL CUAL: `text`;
 *   · author es el actor de `authorship`, o el centinela fuera de una petición (T4);
 *   · change_kind es el `change` del cable;
 *   · el índice (root_type, root_id, at, id) es el de la lectura: una raíz, del más reciente al más antiguo.
 */
export const CHANGE_HISTORY = Object.freeze({
  table: 'change_history',
  columns: Object.freeze([
    { name: 'id', base: 'uuid', nullable: false, primary: true },
    { name: 'root_type', base: 'string', length: 100, nullable: false },
    { name: 'root_id', base: 'string', length: 64, nullable: false },
    { name: 'at', base: 'timestamp', nullable: false },
    { name: 'author', base: 'string', length: 255, nullable: false },
    // change_kind y no change: CHANGE es palabra reservada en MySQL.
    { name: 'change_kind', base: 'string', length: 16, nullable: false },
    { name: 'changes', base: 'text', nullable: false }
  ]),
  indexes: Object.freeze([{ name: 'ix_change_history_root', columns: ['root_type', 'root_id', 'at', 'id'] }])
});

/**
 * Los campos que tocó cada entrada, para el filtro (solo relacional: en el documental la entrada es un documento y
 * `changes` un array con `field` y `top` en cada elemento). Se va con su entrada (`ON DELETE CASCADE`).
 */
export const CHANGE_HISTORY_FIELD = Object.freeze({
  table: 'change_history_field',
  columns: Object.freeze([
    { name: 'entry_id', base: 'uuid', nullable: false, primary: true, references: { table: 'change_history', column: 'id', onDelete: 'cascade', name: 'fk_change_history_field_entry' } },
    { name: 'path', base: 'string', length: 255, nullable: false, primary: true },
    { name: 'top', base: 'string', length: 100, nullable: false }
  ]),
  indexes: Object.freeze([])
});

/**
 * La colección del modelo documental: un documento por entrada, con los mismos nombres que las columnas (`_id` es el id,
 * texto) y, en vez de la segunda tabla, `fields`: un array `[{ path, top }]` con las filas de `historyFieldRows`. `changes`
 * va como TEXTO, igual que en el relacional: un decimal del cable (`"19.90"`) o un número grande no sobreviven a pasar
 * por BSON y volver, y el historial devuelve lo que se guardó.
 */
export const CHANGE_HISTORY_COLLECTION = Object.freeze({
  collection: 'change_history',
  fields: 'fields',
  indexes: Object.freeze([
    { name: 'ix_change_history_root', keys: Object.freeze([['root_type', 1], ['root_id', 1], ['at', -1], ['_id', -1]]) }
  ])
});

/** Las filas de `change_history_field` de una entrada: una por cambio, `{ path, top }`, sin repetir ruta. */
export function historyFieldRows(changes) {
  const seen = new Set();
  return (changes ?? [])
    .filter((change) => !seen.has(change.field) && seen.add(change.field))
    .map((change) => ({ path: change.field, top: topFieldOf(change.field) }));
}

// ─── Las sentencias (relacional) ─────────────────────────────────────────────
//
// Con marcadores nombrados (`:id`), como las del cronómetro: `bindNamed` (timer-store.js) los pasa al estilo de cada
// driver. La hora de una entrada es la del MOTOR, como en el cronómetro: con varias réplicas sus relojes se desvían, y el
// orden de la lectura no puede depender de cuál escribió. A igual hora (dos escrituras en una transacción de PostgreSQL,
// cuyo current_timestamp es el de su inicio) desempata el id, que es un UUID versión 7: crece con el tiempo.
//
// Y truncada al MILISEGUNDO, la precisión del cable (wire.js: el timestamp se trunca a tres decimales): el `at` que lee el
// cliente es el que está guardado, así que sirve tal cual de extremo de `from`/`to`. Con microsegundos, `to=<at de una
// entrada>` la dejaba fuera a ella misma (medido al escribir los escenarios de profile-directory v1.2.0).

const HISTORY_NOW = Object.freeze({ postgresql: "date_trunc('milliseconds', current_timestamp)", mysql: 'utc_timestamp(3)' });

/** Los motores para los que hay sentencias del historial. */
export const HISTORY_ENGINES = Object.freeze(Object.keys(HISTORY_NOW));

/**
 * Las sentencias del historial para un motor relacional. La lectura se compone por piezas (`pageHead` + los filtros
 * presentes, en el orden field, from, to + `pageTail`), con `historyPageSql`: un filtro que no llega no se escribe, en vez
 * de compararlo con NULL (PostgreSQL no sabe el tipo de un parámetro que solo aparece en `:x IS NULL`).
 */
export function historyStatements(engine) {
  const now = HISTORY_NOW[engine];
  if (!now) throw new Error(`el historial no tiene sentencias para '${engine}' (las hay para ${HISTORY_ENGINES.join(', ')})`);
  const h = CHANGE_HISTORY.table;
  const f = CHANGE_HISTORY_FIELD.table;
  const ofRoot = 'root_type = :rootType AND root_id = :rootId';
  return Object.freeze({
    insertEntry: `INSERT INTO ${h} (id, root_type, root_id, at, author, change_kind, changes) VALUES (:id, :rootType, :rootId, ${now}, :author, :change, :changes)`,
    insertField: `INSERT INTO ${f} (entry_id, path, top) VALUES (:entryId, :path, :top)`,
    pageHead: `SELECT h.id, h.at, h.author, h.change_kind, h.changes FROM ${h} h WHERE h.root_type = :rootType AND h.root_id = :rootId`,
    countHead: `SELECT count(*) FROM ${h} h WHERE h.root_type = :rootType AND h.root_id = :rootId`,
    // `field` casa la ruta entera o el campo de la raíz que la contiene (historyMatches); `from` y `to` incluyen su extremo.
    filters: Object.freeze({
      field: ` AND EXISTS (SELECT 1 FROM ${f} f WHERE f.entry_id = h.id AND (f.path = :field OR f.top = :field))`,
      from: ' AND h.at >= :from',
      to: ' AND h.at <= :to'
    }),
    pageTail: ' ORDER BY h.at DESC, h.id DESC LIMIT :limit OFFSET :offset',
    // La anonimización (D8): las entradas de una raíz, para reescribir sus valores personales, y la reescritura.
    entriesOfRoot: `SELECT id, changes FROM ${h} WHERE ${ofRoot}`,
    updateChanges: `UPDATE ${h} SET changes = :changes WHERE id = :id`,
    // El borrado de la raíz por su retención o por la purga de lo borrado (D8): primero los campos y después las
    // entradas. La FK ya borra en cascada, pero no se depende de ella: una base que perdió la cascada no deja huérfanos.
    deleteFields: `DELETE FROM ${f} WHERE entry_id IN (SELECT id FROM ${h} WHERE ${ofRoot})`,
    deleteEntries: `DELETE FROM ${h} WHERE ${ofRoot}`
  });
}

/** Los filtros, en el orden en que se componen. */
export const HISTORY_FILTER_ORDER = Object.freeze(['field', 'from', 'to']);

/** La lectura de una página con los filtros presentes (`{ field, from, to }`, cada uno valor o null). */
export function historyPageSql(statements, filters = {}) {
  return statements.pageHead + HISTORY_FILTER_ORDER.filter((name) => filters[name] != null).map((name) => statements.filters[name]).join('') + statements.pageTail;
}

/** El total de la lectura, con los mismos filtros. */
export function historyCountSql(statements, filters = {}) {
  return statements.countHead + HISTORY_FILTER_ORDER.filter((name) => filters[name] != null).map((name) => statements.filters[name]).join('');
}
