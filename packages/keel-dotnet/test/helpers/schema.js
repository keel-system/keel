// El ESQUEMA que emite keel-dotnet, leído de su mapeo fluente de EF Core (Persistence/Rows): por tabla, las columnas
// (nulabilidad, cota de texto y escala), los nombres de índice, constraint y FK, y el predicado de cada índice único
// condicionado. Lo leen la paridad con keel-spring (test/schema-parity.test.js) y `db-check`, que lo compara con el
// catálogo del motor.

import { schemaTable } from '../../../keel-spring/test/helpers/schema-table.js';

/** El esquema que declaran las configuraciones de EF Core emitidas. */
export function dotnetSchema(files) {
  const tables = new Map();
  const rows = files.filter((f) => /\/Persistence\/Rows\/\w+\.cs$/.test(f.path)).map((f) => f.content);
  // Las propiedades de colección de cada fila (`List<ProductImageRow> Images`): a qué tabla va la FK de un HasMany.
  const navigations = new Map();
  for (const content of rows) {
    for (const m of content.matchAll(/public sealed class (\w+)(?: : IElementRow)?\n\{([\s\S]*?)\n\}/g)) {
      for (const nav of m[2].matchAll(/public List<(\w+)> (\w+) \{/g)) navigations.set(`${m[1]}.${nav[2]}`, nav[1]);
    }
  }
  const configurations = new Map();
  for (const content of rows) {
    for (const m of content.matchAll(/public sealed class \w+Configuration : IEntityTypeConfiguration<(\w+)>\n\{([\s\S]*?)\n\}/g)) {
      configurations.set(m[1], m[2]);
    }
  }
  const tableOfRow = (rowClass) => /row\.ToTable\("([^"]+)"\)/.exec(configurations.get(rowClass) ?? '')?.[1];
  for (const [rowClass, body] of configurations) {
    const t = schemaTable(tables, tableOfRow(rowClass));
    for (const line of body.split('\n').map((l) => l.trim())) {
      const column = /^row\.Property\(r => r\.\w+\)\.HasColumnName\("([^"]+)"\)(.*);$/.exec(line);
      if (column) {
        const rest = column[2];
        t.columns.set(column[1], {
          nullable: rest.includes('.IsRequired(false)'),
          length: /\.HasMaxLength\((\d+)\)/.exec(rest) ? Number(/\.HasMaxLength\((\d+)\)/.exec(rest)[1]) : null,
          scale: /\.HasPrecision\(\d+, (\d+)\)/.exec(rest) ? Number(/\.HasPrecision\(\d+, (\d+)\)/.exec(rest)[1]) : null
        });
        continue;
      }
      const index = /\.HasDatabaseName\("([^"]+)"\)/.exec(line);
      if (index) {
        t.names.add(index[1]);
        const filter = /\.HasFilter\("((?:[^"\\]|\\.)*)"\)/.exec(line);
        if (filter) t.predicates.set(index[1], filter[1].replace(/\\"/g, '"'));
        continue;
      }
      const constraint = /\.HasConstraintName\("([^"]+)"\)/.exec(line);
      if (constraint) {
        // La FK de un HasMany vive en la tabla de la HIJA; la de un HasOne (otro agregado), en esta.
        const many = /^row\.HasMany\(r => r\.(\w+)\)/.exec(line);
        const owner = many ? tableOfRow(navigations.get(`${rowClass}.${many[1]}`)) : tableOfRow(rowClass);
        schemaTable(tables, owner).names.add(constraint[1]);
      }
    }
  }
  return tables;
}
