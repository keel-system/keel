// `keel-recover fixtures`: el estado de partida de los escenarios (`specs/<servicio>/fixtures.yaml`) DERIVADO del snapshot
// del legacy, nunca escrito a mano.
//
// Los flujos recuperados se caracterizan contra el legacy restaurado a su snapshot: lo que había en la base es su
// estado de partida (en shop-api, el seed de import.sql: productos, categorías que ninguna operación crea, pedidos con
// ids estables). Para que el regenerado parta de lo MISMO —en su arnés y en la paridad—, esos registros tienen que viajar
// en el diseño, con sus nombres. La traducción tabla→entidad la escribe el diseñador en `contract-map.yaml → data`, y
// solo las excepciones: lo demás va por convención (el campo `buyerEmail` es la columna `buyer_email`, la relación
// `cart` es `cart_id`). Una columna que no se mapea ni se descarta a sabiendas es un error: el dato del legacy no se
// pierde en silencio.

import { isTechnicalKey } from './db/relational.js';

const snake = (name) => String(name).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const isToMany = (relation) => relation?.cardinality === 'one-to-many' || relation?.cardinality === 'many-to-many';

/**
 * Los registros del diseño desde la exportación del legacy. `exported` es lo que da `dba.exportDb` (tabla → filas);
 * `data` es `contract-map.yaml → data`; `layers`, las capas del diseño. Puro.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function deriveFixtures({ exported, data, layers, source = {} }) {
  const errors = [];
  const entities = layers?.domain?.entities ?? {};
  const doc = { kind: 'fixtures', schema: 1, ...(Object.keys(source).length ? { source } : {}), entities: {} };
  for (const [name, spec] of Object.entries(data ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const entity = entities[name];
    if (!entity) {
      errors.push(`data.${name}: no es una entidad del dominio`);
      continue;
    }
    const rows = exported?.[spec.table];
    if (!Array.isArray(rows)) {
      errors.push(`data.${name}: el legacy no tiene la tabla ${spec.table} (las que hay: ${Object.keys(exported ?? {}).filter((t) => !isTechnicalKey(t)).sort().join(', ')})`);
      continue;
    }
    // Campo del diseño → columna del legacy: lo que dice `columns`, y si no, la convención.
    const targets = [
      ...Object.keys(entity.fields ?? {}).filter((field) => !entity.fields[field]?.list),
      ...Object.entries(entity.relations ?? {}).filter(([, relation]) => !isToMany(relation)).map(([relation]) => relation),
    ];
    const columnOf = (target) => spec.columns?.[target] ?? (entity.relations?.[target] ? `${snake(target)}_id` : snake(target));
    for (const target of Object.keys(spec.columns ?? {})) {
      if (!targets.includes(target)) errors.push(`data.${name}.columns.${target}: no es un campo ni una relación a-uno de ${name}`);
    }
    const used = new Set();
    const records = [];
    for (const row of rows) {
      const record = {};
      for (const target of targets) {
        const column = columnOf(target);
        if (column in row) {
          used.add(column);
          const raw = row[column];
          const mapped = spec.values?.[target];
          if (mapped && raw !== null) {
            if (!(String(raw) in mapped)) errors.push(`data.${name}.values.${target}: el legacy guarda ${JSON.stringify(raw)} en ${spec.table}.${column} y el mapa no dice qué valor del diseño es`);
            record[target] = mapped[String(raw)];
          } else record[target] = raw;
        } else if (spec.defaults && target in spec.defaults) record[target] = spec.defaults[target];
      }
      records.push(record);
    }
    // Lo que el legacy guarda y nadie ha decidido llevar ni descartar.
    const present = new Set(rows.flatMap((row) => Object.keys(row)));
    const dropped = new Set(spec.drop ?? []);
    const orphan = [...present].filter((column) => !used.has(column) && !dropped.has(column)).sort();
    if (orphan.length) errors.push(`data.${name}: ${spec.table} tiene columnas que ni se mapean a un campo ni se descartan (drop): ${orphan.join(', ')}`);
    // Por id: el orden de la exportación es el de la clave primaria del legacy, que puede no ser la del diseño.
    const idField = Object.entries(entity.fields ?? {}).find(([, field]) => field?.id)?.[0];
    if (idField) records.sort((a, b) => String(a[idField]).localeCompare(String(b[idField]), undefined, { numeric: true }));
    doc.entities[name] = { ...(spec.reference ? { reference: true } : {}), records };
  }
  return { doc: errors.length ? null : doc, errors };
}
