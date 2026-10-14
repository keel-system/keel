// El ESQUEMA que emite keel-spring, leído de sus anotaciones JPA y de sus apéndices SQL: por tabla, las columnas
// (nulabilidad, cota de texto y escala), los NOMBRES de constraint única, índice y FK, y el predicado de cada índice
// único condicionado. Es el oráculo de las paridades de esquema de los otros generadores (keel-nest y keel-dotnet),
// que comparan lo que ellos emiten contra esto.
//
// Lo que se lee es lo DECLARADO: en JPA, lo que Hibernate deja al dialecto (el tipo de un UUID, el 255 de un String
// sin cota) no está escrito, y aquí solo se compara lo que lo está. Las FK entre AGREGADOS no son anotaciones (no
// hay asociación navegable entre raíces): keel-spring las añade al baseline desde `infra/export-schema.sh`, y se
// leen aparte (`springCrossAggregateForeignKeys`).

const unquote = (name) => String(name).replace(/`/g, '');

export function schemaTable(tables, name) {
  if (!tables.has(name)) tables.set(name, { columns: new Map(), names: new Set(), predicates: new Map() });
  return tables.get(name);
}

/** Los atributos que una anotación @Column declara: nulabilidad, cota y escala. */
function springColumn(attrs) {
  const length = /length = (\d+)/.exec(attrs)?.[1] ?? /varchar\((\d+)\)/.exec(attrs)?.[1] ?? null;
  return {
    nullable: !/nullable = false/.test(attrs),
    length: length == null ? null : Number(length),
    scale: /scale = (\d+)/.exec(attrs)?.[1] != null ? Number(/scale = (\d+)/.exec(attrs)[1]) : null
  };
}

/** El esquema declarado por las entidades JPA y el apéndice de índices condicionados de keel-spring. */
export function springSchema(files) {
  const tables = new Map();
  const table = (name) => schemaTable(tables, name);
  // Los índices únicos CONDICIONADOS no están en las anotaciones (JPA no tiene predicado): keel-spring
  // los crea con el apéndice SQL, y es ahí donde se leen, con su predicado.
  const appendix = files.find((f) => f.path.endsWith('db/partial-indexes.sql'))?.content ?? '';
  for (const m of appendix.matchAll(/^CREATE UNIQUE INDEX IF NOT EXISTS (\w+) ON (\w+) \(.*\) WHERE (.*);$/gm)) {
    table(m[2]).names.add(m[1]);
    table(m[2]).predicates.set(m[1], m[3]);
  }
  // Las entidades del diseño y las de los mecanismos de build que tienen tabla (el registro de la
  // idempotencia de petición vive en persistence/idempotency).
  // Y los almacenes de la mensajería: el outbox y el registro de procesados (messaging/outbox e idempotency).
  const jpa = files.filter(
    // Y la marca del reclamo de la reconciliación (persistence/reconciliation, incremento 11c).
    (f) => /\/infrastructure\/(persistence\/(entities|idempotency|reconciliation)|messaging\/(outbox|idempotency))\//.test(f.path) && f.path.endsWith('.java')
  );
  const classes = new Map();
  for (const file of jpa) {
    const name = /public (?:abstract )?class (\w+)/.exec(file.content)?.[1];
    const tableName = /@Table\(name = "([^"]+)"/.exec(file.content)?.[1];
    classes.set(name, { file, table: tableName ? unquote(tableName) : null, embeddable: /@Embeddable/.test(file.content), mapped: /@MappedSuperclass/.test(file.content) });
  }
  const columnsOf = (content) => [...content.matchAll(/@Column\((name = "([^"]+)"[^)]*)\)/g)].map((m) => [unquote(m[2]), springColumn(m[1])]);
  for (const [, info] of classes) {
    if (!info.table) continue;
    const content = info.file.content;
    const t = table(info.table);
    const header = /@Table\(([\s\S]*?)\)\npublic class/.exec(content)?.[1] ?? '';
    for (const m of header.matchAll(/@(?:UniqueConstraint|Index)\(name = "([^"]+)"/g)) t.names.add(m[1]);
    // Lo heredado de la base de auditoría.
    const parent = /extends (\w+)/.exec(content)?.[1];
    if (parent && classes.get(parent)?.mapped) for (const [name, spec] of columnsOf(classes.get(parent).file.content)) t.columns.set(name, spec);
    const body = content.slice(content.indexOf('public class'));
    for (const block of body.split(/\n\s*\n/)) {
      const collection = /@CollectionTable\(name = "([^"]+)", joinColumns = @JoinColumn\(name = "([^"]+)", foreignKey = @ForeignKey\(name = "([^"]+)"\)\)([\s\S]*?)\)\n/.exec(block);
      if (collection) {
        const ct = table(collection[1]);
        ct.columns.set(collection[2], { nullable: false, length: null, scale: null });
        ct.names.add(collection[3]);
        for (const m of collection[4].matchAll(/@Index\(name = "([^"]+)"/g)) ct.names.add(m[1]);
        const order = /@OrderColumn\(name = "([^"]+)"\)/.exec(block)?.[1];
        if (order) ct.columns.set(order, { nullable: false, length: null, scale: null });
        for (const [name, spec] of columnsOf(block.replace(/@CollectionTable\([\s\S]*?\)\n/, ''))) ct.columns.set(name, spec);
        const element = /List<(\w+)>/.exec(block)?.[1];
        if (classes.get(element)?.embeddable) for (const [name, spec] of columnsOf(classes.get(element).file.content)) ct.columns.set(name, spec);
        continue;
      }
      const join = /@JoinColumn\(name = "([^"]+)"([^)]*?), foreignKey = @ForeignKey\(name = "([^"]+)"\)\)/.exec(block);
      if (join && /@OneToMany/.test(block)) {
        // Unidireccional: la FK vive en la tabla de la HIJA.
        const child = classes.get(/List<(\w+)>/.exec(block)?.[1]);
        const ct = table(child.table);
        ct.columns.set(unquote(join[1]), { nullable: true, length: null, scale: null });
        ct.names.add(join[3]);
        continue;
      }
      if (join) {
        t.columns.set(unquote(join[1]), { nullable: !/nullable = false/.test(join[2]), length: null, scale: null });
        t.names.add(join[3]);
        continue;
      }
      // Un @Id sin @Column (el del outbox): la columna se llama como el campo.
      const bareId = /@Id\s+private \w+ (\w+);/.exec(block);
      if (bareId) t.columns.set(bareId[1].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), { nullable: false, length: null, scale: null });
      for (const [name, spec] of columnsOf(block)) t.columns.set(name, spec);
    }
  }
  return tables;
}

/** Las FK entre agregados que el baseline de keel-spring añade (`infra/export-schema.sh`): tabla → nombres. */
export function springCrossAggregateForeignKeys(files) {
  const script = files.find((f) => f.path.endsWith('infra/export-schema.sh'))?.content ?? '';
  const byTable = new Map();
  for (const m of script.matchAll(/ALTER TABLE (\w+) ADD CONSTRAINT (fk_\w+)\s+FOREIGN KEY/g)) {
    byTable.set(m[1], [...(byTable.get(m[1]) ?? []), m[2]]);
  }
  return byTable;
}
