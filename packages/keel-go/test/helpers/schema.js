// El ESQUEMA que emite keel-go, leído de su migración baseline (internal/infrastructure/postgres/migrations): por tabla,
// las columnas (nulabilidad, cota de texto y escala), los nombres de constraint única, índice y FK, y el predicado de cada
// índice único condicionado. Es la misma forma que el lector de keel-spring (keel-spring/test/helpers/schema-table.js),
// así que la paridad compara las dos sin traducir nada. Se lee el SQL, no los datos de los que sale: lo que se compara
// es lo que el motor ejecutará.

import { schemaTable } from '../../../keel-spring/test/helpers/schema-table.js';

const unquote = (name) => String(name).replace(/"/g, '');

/** El SQL de la migración baseline entre los archivos emitidos, o null. */
export function baselineOf(files) {
  return files.find((f) => /^internal\/infrastructure\/postgres\/migrations\/00001_baseline\.sql$/.test(f.path))?.content ?? null;
}

/** El esquema que declara la parte Up de la migración baseline. */
export function goSchema(files) {
  const tables = new Map();
  const sql = baselineOf(files);
  if (!sql) return tables;
  const up = sql.slice(sql.indexOf('-- +goose Up'), sql.indexOf('-- +goose Down'));
  for (const [, table, body] of up.matchAll(/^CREATE TABLE ("?\w+"?) \(\n([\s\S]*?)\n\);$/gm)) {
    const t = schemaTable(tables, unquote(table));
    for (const raw of body.split(',\n').map((line) => line.trim())) {
      const constraint = /^CONSTRAINT (\w+) (PRIMARY KEY|UNIQUE)/.exec(raw);
      if (constraint) {
        // La clave primaria no la nombra ninguna anotación de keel-spring: la del motor (`<tabla>_pkey`).
        if (constraint[2] === 'UNIQUE') t.names.add(constraint[1]);
        continue;
      }
      const column = /^("?\w+"?)\s+(.+?)(\s+NOT NULL)?$/.exec(raw);
      if (!column) throw new Error(`línea de columna ilegible en ${table}: ${raw}`);
      const type = column[2];
      t.columns.set(unquote(column[1]), {
        nullable: !column[3],
        length: /^varchar\((\d+)\)/.exec(type) ? Number(/^varchar\((\d+)\)/.exec(type)[1]) : null,
        scale: /^numeric\(\d+,(\d+)\)/.exec(type) ? Number(/^numeric\(\d+,(\d+)\)/.exec(type)[1]) : null,
        type
      });
    }
  }
  for (const [, name, table, rest] of up.matchAll(/^CREATE (?:UNIQUE )?INDEX (\w+) ON ("?\w+"?) \(.*?\)(.*);$/gm)) {
    const t = schemaTable(tables, unquote(table));
    t.names.add(name);
    const predicate = /^ WHERE (.*)$/.exec(rest)?.[1];
    if (predicate) t.predicates.set(name, predicate);
  }
  for (const [, table, name] of up.matchAll(/^ALTER TABLE ("?\w+"?) ADD CONSTRAINT (\w+)\n\s+FOREIGN KEY/gm)) {
    schemaTable(tables, unquote(table)).names.add(name);
  }
  return tables;
}
