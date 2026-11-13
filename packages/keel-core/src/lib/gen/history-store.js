// El almacén del historial de cambios (DSL 2.29, D6 y D11 de PLAN-DSL-229-HISTORIAL.md), como DATOS: lo mismo en los
// cuatro generadores, que comparten base y esquema, como OUTBOX_EVENT (messaging-stores.js). Lo que cambia entre
// lenguajes (la entidad, el adaptador que escribe la entrada en la transacción de la escritura, la consulta paginada)
// es de cada uno. Las sentencias por motor se diseñan en el incremento 1, junto a su primer consumidor.
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
    { name: 'change', base: 'string', length: 16, nullable: false },
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
    { name: 'entry_id', base: 'uuid', nullable: false, primary: true, references: { table: 'change_history', column: 'id', onDelete: 'cascade' } },
    { name: 'path', base: 'string', length: 255, nullable: false, primary: true },
    { name: 'top', base: 'string', length: 100, nullable: false }
  ]),
  indexes: Object.freeze([])
});

/** La colección del modelo documental: un documento por entrada, con los mismos nombres que las columnas. */
export const CHANGE_HISTORY_COLLECTION = Object.freeze({
  collection: 'change_history',
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
