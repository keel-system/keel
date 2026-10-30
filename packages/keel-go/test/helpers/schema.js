// El ESQUEMA que emite keel-go, leído de su migración baseline (internal/infrastructure/<motor>/migrations): por tabla,
// las columnas (nulabilidad, cota de texto y escala), los nombres de constraint única, índice y FK, y el predicado de cada
// índice único condicionado. Es la misma forma que el lector de keel-spring (keel-spring/test/helpers/schema-table.js),
// así que la paridad compara las dos sin traducir nada. Se lee el SQL, no los datos de los que sale: lo que se compara
// es lo que el motor ejecutará.

import { schemaTable } from '../../../keel-spring/test/helpers/schema-table.js';

const unquote = (name) => String(name).replace(/["`]/g, '');

/** El SQL de la migración baseline entre los archivos emitidos, o null. */
export function baselineOf(files) {
  return files.find((f) => /^internal\/infrastructure\/(?:postgres|mysql)\/migrations\/00001_baseline\.sql$/.test(f.path))?.content ?? null;
}

// Un identificador del SQL, citado (`"x"` en PostgreSQL, `` `x` `` en MySQL) o no.
const IDENT = '[`"]?\\w+[`"]?';

/**
 * El esquema que declara la parte Up de la migración baseline. Una columna GENERADA (el discriminador `<índice>_flag`
 * de la unicidad condicionada en MySQL) no va en `columns` —keel-spring tampoco la declara en sus anotaciones—: va en
 * `generated`, con su expresión. `indexColumns` son las columnas de cada índice, en orden.
 */
export function goSchema(files) {
  const tables = new Map();
  const sql = baselineOf(files);
  if (!sql) return tables;
  const up = sql.slice(sql.indexOf('-- +goose Up'), sql.indexOf('-- +goose Down'));
  const table = (name) => {
    const t = schemaTable(tables, unquote(name));
    t.generated ??= new Map();
    t.indexColumns ??= new Map();
    return t;
  };
  for (const [, name, body] of up.matchAll(new RegExp(`^CREATE TABLE (${IDENT}) \\(\\n([\\s\\S]*?)\\n\\);$`, 'gm'))) {
    const t = table(name);
    for (const raw of body.split(',\n').map((line) => line.trim())) {
      const constraint = /^CONSTRAINT (\w+) (PRIMARY KEY|UNIQUE)/.exec(raw);
      if (constraint) {
        // La clave primaria no la nombra ninguna anotación de keel-spring: la del motor (`<tabla>_pkey`).
        if (constraint[2] === 'UNIQUE') t.names.add(constraint[1]);
        continue;
      }
      const generated = new RegExp(`^(${IDENT})\\s+tinyint GENERATED ALWAYS AS \\((.*)\\) STORED$`).exec(raw);
      if (generated) {
        t.generated.set(unquote(generated[1]), generated[2]);
        continue;
      }
      const column = new RegExp(`^(${IDENT})\\s+(.+?)(\\s+NOT NULL)?$`).exec(raw);
      if (!column) throw new Error(`línea de columna ilegible en ${name}: ${raw}`);
      const type = column[2];
      t.columns.set(unquote(column[1]), {
        nullable: !column[3],
        length: /^varchar\((\d+)\)/.exec(type) ? Number(/^varchar\((\d+)\)/.exec(type)[1]) : null,
        scale: /^(?:numeric|decimal)\(\d+,(\d+)\)/.exec(type) ? Number(/^(?:numeric|decimal)\(\d+,(\d+)\)/.exec(type)[1]) : null,
        type
      });
    }
  }
  for (const [, name, tableName, columns, rest] of up.matchAll(new RegExp(`^CREATE (?:UNIQUE )?INDEX (\\w+) ON (${IDENT}) \\((.*?)\\)(.*);$`, 'gm'))) {
    const t = table(tableName);
    t.names.add(name);
    t.indexColumns.set(name, columns.split(',').map((column) => unquote(column.trim())));
    const predicate = /^ WHERE (.*)$/.exec(rest)?.[1];
    if (predicate) t.predicates.set(name, predicate);
  }
  for (const [, table, name] of up.matchAll(new RegExp(`^ALTER TABLE (${IDENT}) ADD CONSTRAINT (\\w+)\\n\\s+FOREIGN KEY`, 'gm'))) {
    schemaTable(tables, unquote(table)).names.add(name);
  }
  return tables;
}
