// La persistencia relacional con EF Core: las FILAS (`<Entidad>Row`, en Infrastructure/Persistence/Rows), una por
// entidad persistida más la tabla de elementos de cada lista, con su mapeo a la tabla, y el DbContext del servicio.
// Es el `<Entidad>Jpa` de keel-spring y el `<Entidad>Orm` de keel-nest sobre los MISMOS datos: tablas, columnas,
// cotas, constraints únicas, índices y FK salen de keel-core/gen/relational.js, así que el esquema de los tres
// servidores del mismo diseño tiene los mismos nombres —que es lo que leen el traductor de errores, el baseline y
// los scripts del arnés—. `test/schema-parity.test.js` lo compara con lo que EMITE keel-spring.
//
// Lo único de aquí es cómo se dice en EF Core. Cuatro decisiones que no son obvias:
//   · el mapeo es FLUENTE (`IEntityTypeConfiguration`) y explícito, sin atributos ni convenciones que decidan un
//     nombre: un índice o una FK que EF nombrara por su cuenta no casaría con el traductor de errores;
//   · la unicidad es un ÍNDICE único con nombre, no una clave alternativa: EF no deja modificar una clave
//     alternativa, y un `sku` único sigue pudiendo cambiar. Y todo índice es NOMBRADO en EF (`HasIndex(…, "nombre")`):
//     EF identifica un índice sin nombre por sus columnas, y dos sobre las mismas (la clave natural y un índice
//     declarado, en metering-digest) se fundían en uno — la unicidad desaparecía del esquema sin que nada fallara;
//   · los value objects se APLANAN a columnas con prefijo (como en keel-spring), en vez de tipos propios de EF: la
//     nulabilidad de cada columna depende de si el value object ENTERO es obligatorio en esa entidad;
//   · el bloqueo optimista es un token de concurrencia (`IsConcurrencyToken`) que sube el adaptador: EF sí comprueba
//     la versión esperada (`WHERE lock_version = @original`), a diferencia de TypeORM.
//
// Solo PostgreSQL (Npgsql). MySQL espera a que `db-check` lo mida (PLAN-KEEL-DOTNET.md § 5).

import {
  persistedMembers,
  backReferenceTo,
  uniqueFields,
  indexName,
  foreignKeyName,
  foreignKeyIndexName,
  foreignKeyIndexColumns,
  columnsFor,
  collectionIndexesOf,
  elementTable,
  joinColumnOf,
  parentColumnOf,
  crossAggregateForeignKeys,
  partialIndexSpecs,
  uniqueConstraints,
  keyShadow,
  LOCK_VERSION,
  AUDIT_COLUMNS,
  DECIMAL_PRECISION
} from 'keel-core/gen';
import { IDEMPOTENCY_RECORD } from 'keel-core/gen/request-idempotency';
import { enumMember } from '../lib/cs-projection.js';
import { IDEMPOTENCY_ROW, usesRequestIdempotency } from './request-idempotency.js';
import { storeRows, storeSchemaNames } from './messaging-stores.js';
import { csFile, csMember, csString, located, namespaceOf, solution, typeUsings, xmlDoc } from './render.js';

/** ¿El diseño persiste en un motor relacional? Es lo que genera todo este módulo. */
export function usesRelational(model) {
  return Boolean(model.layersPresent?.persistence) && model.persistenceKind !== 'document';
}

export const rowClass = (entityName) => `${entityName}Row`;
export const rowConfigurationClass = (className) => `${className}Configuration`;
/** La fila de un elemento de una lista: vive en el archivo de su entidad. */
export const elementClass = (entity, member) => `${entity.name}${csMember(member.name)}Element`;
export const dbContextClass = (model) => `${model.service.rootNamespace}DbContext`;

/** La propiedad C# de la FK que una hija pone hacia el padre de un one-to-many UNIDIRECCIONAL. */
export const ownerProperty = (parentName) => `${parentName}OwnerId`;

export function rowsNamespace(model) {
  return namespaceOf(model, 'rows');
}

export function persistenceNamespace(model) {
  return namespaceOf(model, 'persistence');
}

export function persistedEntities(model) {
  return model.entities.filter((entity) => entity.persisted);
}

export function generate(model) {
  if (!usesRelational(model)) return [];
  const files = persistedEntities(model).map((entity) => renderRowFile(model, entity));
  files.push(enumColumnsFile(model), rowValuesFile(model), rowSyncFile(model), dbContextFile(model), schemaTestFile(model));
  if (usesTextFold(model)) files.push(textFoldFile(model));
  return files;
}

/** ¿Algún campo persistido se compara plegado (`compare`)? Entonces hace falta TextFold. */
export function usesTextFold(model) {
  return persistedEntities(model).some((entity) => entity.fields.some((field) => field.fold || field.filterFold));
}

// ─── Tipos y columnas ────────────────────────────────────────────────────────────────────────────

/** ¿Es un tipo de valor de C# (admite `?` como Nullable<T>)? Todo lo que no es texto. */
export function isValueType(csType) {
  return csType !== 'string';
}

/**
 * El tipo C# de la propiedad de una columna: el del dominio, salvo el `json` embebido, que se guarda como su
 * TEXTO tal cual llegó (la columna es `text`, como en keel-spring y keel-nest). Nulo si la columna lo es.
 */
export function rowType(csType, spec) {
  const base = spec.base === 'json' ? 'string' : csType;
  return spec.nullable ? `${base}?` : base;
}

/**
 * La configuración de una columna: nombre, tipo físico, cota, escala y nulabilidad. El tipo físico es el que
 * Hibernate da al mismo tipo Java en PostgreSQL: un texto sin cota es `varchar(255)`, un decimal sin escala
 * declarada `numeric(38,2)`, un enum su CONSTANTE en `varchar(255)`.
 */
export function columnChain(property, spec, { enumName = null, key = false, concurrency = false } = {}) {
  const parts = [`row.Property(r => r.${property})`, `.HasColumnName(${csString(spec.name)})`];
  if (enumName) {
    parts.push(`.HasConversion(EnumColumns.${enumName}Column)`, '.HasMaxLength(255)');
  } else if (spec.long) {
    parts.push('.HasColumnType("text")');
  } else if (spec.base === 'decimal') {
    parts.push(`.HasPrecision(${spec.scale != null ? DECIMAL_PRECISION : 38}, ${spec.scale ?? 2})`);
  } else if (spec.textual) {
    parts.push(`.HasMaxLength(${spec.length ?? 255})`);
  }
  if (spec.collation) parts.push(`.UseCollation(${csString(spec.collation)})`);
  parts.push(spec.nullable ? '.IsRequired(false)' : '.IsRequired()');
  // El id lo pone siempre el dominio (UUIDv7): EF no tiene que generar nada, tampoco para un entero de la clave.
  if (key) parts.push('.ValueGeneratedNever()');
  if (concurrency) parts.push('.IsConcurrencyToken()');
  return `        ${parts.join('')};`;
}

/** Una propiedad pública de la fila. */
function rowProperty(name, type, doc = null) {
  const initializer = type === 'string' ? ' = null!;' : type.startsWith('List<') ? ' = [];' : '';
  return `${doc ? xmlDoc(doc, '    ') : ''}    public ${type} ${name} { get; set; }${initializer}`;
}

/** El nombre del enum de una columna, o null. */
function enumOf(field) {
  return field?.kind === 'enum' || field?.columns?.enum ? field.namedType ?? field.csType : null;
}

// ─── Las filas de una entidad ────────────────────────────────────────────────────────────────────

/**
 * El mapa columna → propiedad C# de la fila de una entidad. Lo necesita todo lo que en EF nombra PROPIEDADES
 * (índices, FK), mientras keel-core/gen nombra columnas.
 */
export function columnProperties(model, entity, members = persistedMembers(model, entity)) {
  const map = new Map();
  for (const member of members) {
    if (member.kind === 'scalar') {
      map.set(member.field.columns?.name ?? member.name, csMember(member.name));
      if (member.folded) map.set(member.folded.column, csMember(member.folded.name));
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) map.set(sub.column, csMember(sub.name));
    } else if (member.kind === 'externalRef') {
      map.set(member.column, csMember(member.name));
    } else if (member.kind === 'relationOne') {
      map.set(joinColumnOf(member.relation), `${csMember(member.name)}Id`);
    }
  }
  for (const parent of unidirectionalParents(model, entity)) map.set(parent.column, parent.property);
  return map;
}

/**
 * Los padres que apuntan a esta entidad con un one-to-many UNIDIRECCIONAL: la FK `<padre>_id` vive en la tabla de
 * la hija, nula —como la crea Hibernate para un one-to-many con @JoinColumn—, aunque el dominio no la nombre.
 */
export function unidirectionalParents(model, entity) {
  const parents = [];
  for (const parent of persistedEntities(model)) {
    for (const relation of parent.relations ?? []) {
      if (!relation.internal || relation.cardinality !== 'one-to-many' || relation.entity !== entity.name) continue;
      if (backReferenceTo(model, entity.name, parent.name)) continue;
      parents.push({
        parent,
        relation,
        property: ownerProperty(parent.name),
        column: parentColumnOf(parent.name),
        foreignKey: foreignKeyName(entity.tableName, parent.name)
      });
    }
  }
  return parents;
}

/** El tipo C# del id de una entidad (Guid si no lo declara). */
export function idTypeOf(model, entityName) {
  return model.entities.find((candidate) => candidate.name === entityName)?.idField?.csType ?? 'Guid';
}

function renderRowFile(model, entity) {
  const { namespace, path } = located(model, 'rows', rowClass(entity.name));
  const usings = ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders', persistenceNamespace(model)];
  const members = persistedMembers(model, entity);
  const properties = [];
  const config = [`        row.ToTable(${csString(entity.tableName)});`];
  const relations = [];
  const elements = [];
  const props = columnProperties(model, entity, members);
  const useEnum = (name) => usings.push(...typeUsings(model, [name]));

  const idName = entity.idField ? csMember(entity.idField.name) : 'Id';
  // La clave con el nombre que le da PostgreSQL por defecto, que es el que deja Hibernate: el mismo esquema.
  config.push(`        row.HasKey(r => r.${idName}).HasName(${csString(`${entity.tableName}_pkey`)});`);

  for (const member of members) {
    if (member.kind === 'scalar') {
      const { field } = member;
      const spec = field.columns;
      const enumName = enumOf(field);
      if (enumName) useEnum(enumName);
      const concurrency = entity.declaresLockVersion && field.name === LOCK_VERSION.field;
      properties.push(rowProperty(csMember(field.name), rowType(field.csType, spec), field.description));
      config.push(columnChain(csMember(field.name), spec, { enumName, key: field.isId, concurrency }));
      if (member.folded) {
        const shadow = member.folded;
        const shadowSpec = { name: shadow.column, base: 'string', textual: true, length: shadow.maxLength ?? 255, nullable: !shadow.required };
        properties.push(rowProperty(csMember(shadow.name), shadow.required ? 'string' : 'string?', `${field.name} plegado (compare: ${field.compare}): lo estampa el adaptador con TextFold al guardar.`));
        config.push(columnChain(csMember(shadow.name), shadowSpec));
      }
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) {
        if (sub.subKind === 'composite' || !sub.sub.columns) {
          properties.push(`    // TODO (agente): ${member.field.namedType}.${sub.voAccessor} es un value object anidado; mapéalo a columnas (skill keel-dotnet-database).`);
          continue;
        }
        // La columna aplanada es una columna como cualquier otra: las cotas del sub-campo, con el nombre del
        // aplanado y NOT NULL solo si el value object entero es obligatorio.
        const spec = { ...sub.sub.columns, name: sub.column, nullable: !(sub.ownerRequired && !sub.sub.columns.nullable) };
        const enumName = enumOf(sub.sub);
        if (enumName) useEnum(enumName);
        properties.push(rowProperty(csMember(sub.name), rowType(sub.sub.csType, spec), `${member.field.namedType}.${sub.voAccessor} aplanado.`));
        config.push(columnChain(csMember(sub.name), spec, { enumName }));
      }
    } else if (member.kind === 'externalRef') {
      // Otro agregado: solo su id, sin navegación (una navegable rompería la frontera del agregado). Su FK sí va
      // en el esquema, con nombre: EF la crea, y su violación se traduce al error que el diseño declare.
      const spec = { name: member.column, base: 'uuid', nullable: !member.relation.required };
      properties.push(rowProperty(csMember(member.name), rowType(idTypeOf(model, member.relation.entity), spec), `Id de la raíz de ${member.relation.entity} (otro agregado).`));
      config.push(columnChain(csMember(member.name), spec));
    } else if (member.kind === 'elementCollection') {
      const element = renderElement(model, entity, member, usings);
      elements.push(element);
      properties.push(rowProperty(csMember(member.name), `List<${element.className}>`, `La lista ${member.name}: su tabla de elementos (${element.table}), en el orden en que se guardó.`));
      relations.push(
        `        row.HasMany(r => r.${csMember(member.name)}).WithOne().HasForeignKey(element => element.OwnerId)` +
          `.HasConstraintName(${csString(element.foreignKey)}).OnDelete(DeleteBehavior.Cascade);`
      );
    } else if (member.kind === 'relationMany') {
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      if (member.relation.cardinality === 'many-to-many' || !child) {
        properties.push(`    // TODO (agente): ${member.name} es many-to-many dentro del agregado; necesita su tabla de unión (skill keel-dotnet-database).`);
        continue;
      }
      properties.push(rowProperty(csMember(member.name), `List<${rowClass(child.name)}>`, `Las ${child.name} del agregado.`));
      const back = backReferenceTo(model, child.name, entity.name);
      const fk = back ? `${csMember(back)}Id` : ownerProperty(entity.name);
      const fkName = back ? foreignKeyName(child.tableName, back) : foreignKeyName(child.tableName, entity.name);
      // Con la vuelta declarada la FK es obligatoria; sin ella, nula (la de Hibernate). Quitar la hija de la
      // colección la BORRA en los dos casos: lo hace el adaptador (RowSync), no EF, que con una FK nula la dejaría
      // huérfana.
      relations.push(
        `        row.HasMany(r => r.${csMember(member.name)}).WithOne().HasForeignKey(child => child.${fk})` +
          `.HasConstraintName(${csString(fkName)}).OnDelete(DeleteBehavior.Cascade);`
      );
    } else if (member.kind === 'relationOne') {
      if (member.relation.backReference) {
        // La vuelta de una hija a su raíz: solo la columna FK. La relación la declara el padre (HasMany).
        const spec = { name: joinColumnOf(member.relation), base: 'uuid', nullable: !member.relation.required };
        properties.push(rowProperty(`${csMember(member.name)}Id`, rowType(idTypeOf(model, member.relation.entity), spec), `La FK de la vuelta a ${member.relation.entity}; la pone EF al añadir la hija a su padre.`));
        config.push(columnChain(`${csMember(member.name)}Id`, spec));
      } else {
        properties.push(`    // TODO (agente): ${member.name} es una relación a-uno dentro del agregado; mapéala con su FK ${joinColumnOf(member.relation)} (skill keel-dotnet-database).`);
      }
    }
  }

  // La FK sintética de un one-to-many unidireccional del padre: la columna y la FK que pone el @JoinColumn del
  // padre en keel-spring. El dominio no la nombra.
  for (const owner of unidirectionalParents(model, entity)) {
    const spec = { name: owner.column, base: 'uuid', nullable: true };
    properties.push(rowProperty(owner.property, rowType(idTypeOf(model, owner.parent.name), spec), `La FK del one-to-many ${owner.parent.name}.${owner.relation.name}: el dominio no la nombra.`));
    config.push(columnChain(owner.property, spec));
  }

  // Concurrencia optimista: la raíz porta su versión (persistence.consistency.optimisticLocking).
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    properties.push(rowProperty(csMember(LOCK_VERSION.field), 'long?', 'Versión de concurrencia optimista: la sube el adaptador al guardar, nunca a mano.'));
    config.push(columnChain(csMember(LOCK_VERSION.field), { name: LOCK_VERSION.column, base: 'long', nullable: true }, { concurrency: true }));
  }

  // La auditoría que la política `all` pone sin que el dominio la nombre.
  for (const column of auditColumns(entity)) {
    const timestamp = column.field.endsWith('At');
    properties.push(rowProperty(csMember(column.field), timestamp ? 'DateTimeOffset' : 'string', `Auditoría (persistence.audit: all): la estampa el adaptador al guardar.`));
    config.push(columnChain(csMember(column.field), { name: column.column, base: timestamp ? 'timestamp' : 'string', textual: !timestamp, length: 255, nullable: false }));
  }

  config.push(...tableIndexes(model, entity, members, props));
  // Las FK hacia OTRO agregado, con su nombre: sin navegación, y sin borrado en cascada (borrar la raíz
  // referenciada es un conflicto que el diseño traduce, no un efecto que se propaga).
  for (const fk of crossAggregateForeignKeys(model).filter((candidate) => candidate.table === entity.tableName)) {
    const property = props.get(fk.column);
    relations.push(
      `        row.HasOne<${rowClass(fk.refEntity)}>().WithMany().HasForeignKey(r => r.${property})` +
        `.HasConstraintName(${csString(fk.name)}).OnDelete(DeleteBehavior.NoAction);`
    );
  }

  const className = rowClass(entity.name);
  const body = `${xmlDoc(`Tabla de ${entity.name}${entity.isAggregateRoot ? ' (raíz del agregado)' : ''}. El dominio no la conoce: la mapea su adaptador.`)}public sealed class ${className}
{
${properties.join('\n\n')}
}

${xmlDoc(`El mapeo de ${className} a la tabla ${entity.tableName}, con los nombres de keel-core/gen/relational.js.`)}public sealed class ${rowConfigurationClass(className)} : IEntityTypeConfiguration<${className}>
{
    public void Configure(EntityTypeBuilder<${className}> row)
    {
${[...config, ...relations].join('\n')}
    }
}${elements.map((element) => `\n\n${element.text}`).join('')}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/** Las columnas de auditoría que esta entidad hereda de la política `all`. */
export function auditColumns(entity) {
  return [
    ...(entity.auditTimestamps === 'all' ? AUDIT_COLUMNS.timestamps : []),
    ...(entity.auditAuthorship === 'all' ? AUDIT_COLUMNS.authorship : [])
  ];
}

/**
 * Las constraints únicas e índices de la tabla, con los nombres de keel-core/gen. La unicidad condicionada
 * (`indexes` con `when`) lleva su PREDICADO, con la constante del enum guardada: sin él sería una unicidad sobre
 * todas las filas, lo contrario del invariante («como mucho una activa» pasaría a «como mucho una»).
 */
function tableIndexes(model, entity, members, props) {
  const lines = [];
  const selector = (columns) => {
    const names = columns.map((column) => `r.${props.get(column) ?? csMember(column)}`);
    return names.length === 1 ? `r => ${names[0]}` : `r => new { ${names.join(', ')} }`;
  };
  // La sombra de un FILTRO (`filterOnly`) no lleva la unicidad del campo: ese se compara exacto.
  const shadowOf = (name) => keyShadow(members.find((m) => m.kind === 'scalar' && m.name === name)?.field);

  if (entity.naturalKey?.length > 0) {
    const columns = entity.naturalKey.flatMap((name) => (shadowOf(name) ? [shadowOf(name).column] : columnsFor(model, entity, members, name)));
    lines.push(`        row.HasIndex(${selector(columns)}, ${csString(`uk_${entity.tableName}_natural`)}).IsUnique().HasDatabaseName(${csString(`uk_${entity.tableName}_natural`)});`);
  }
  for (const field of uniqueFields(entity)) {
    const column = shadowOf(field.name)?.column ?? field.columns?.name;
    const name = `uk_${entity.tableName}_${field.columns?.name}`;
    lines.push(`        row.HasIndex(${selector([column])}, ${csString(name)}).IsUnique().HasDatabaseName(${csString(name)});`);
  }
  const { handled } = collectionIndexesOf(entity, members);
  for (const index of entity.indexes ?? []) {
    if (index.when || handled.has(index)) continue;
    const probe = [];
    const columns = index.fields.flatMap((name) => columnsFor(model, entity, members, name, probe));
    // Un índice sobre lo que no es columna de esta tabla rompería el esquema: lo avisa keel-spring al anotar.
    if (probe.length > 0) continue;
    lines.push(`        row.HasIndex(${selector(columns)}, ${csString(indexName(entity, index))})${index.unique ? '.IsUnique()' : ''}.HasDatabaseName(${csString(indexName(entity, index))});`);
  }
  for (const spec of partialIndexSpecs(model, 'postgresql').filter((candidate) => candidate.entity === entity.name)) {
    const columns = spec.fields.flatMap((name) => columnsFor(model, entity, members, name));
    lines.push(`        row.HasIndex(${selector(columns)}, ${csString(spec.name)}).IsUnique().HasFilter(${csString(spec.predicate)}).HasDatabaseName(${csString(spec.name)});`);
  }
  for (const column of foreignKeyIndexColumns(model, entity, members)) {
    const name = foreignKeyIndexName(entity.tableName, column);
    lines.push(`        row.HasIndex(${selector([column])}, ${csString(name)}).HasDatabaseName(${csString(name)});`);
  }
  return lines;
}

/** La tabla de elementos de una lista: clave (raíz, posición), el valor y la FK a la raíz. */
function renderElement(model, entity, member, usings) {
  const table = elementTable(entity, member);
  const className = elementClass(entity, member);
  const properties = [
    rowProperty('OwnerId', idTypeOf(model, entity.name), `La raíz dueña de la lista (${table.joinColumn}).`),
    rowProperty('Position', 'int', 'La posición del elemento: la lista es un valor ordenado.')
  ];
  const config = [
    `        row.ToTable(${csString(table.table)});`,
    `        row.HasKey(r => new { r.OwnerId, r.Position }).HasName(${csString(`${table.table}_pkey`)});`,
    columnChain('OwnerId', { name: table.joinColumn, base: 'uuid', nullable: false }, { key: true }),
    columnChain('Position', { name: table.orderColumn, base: 'int', nullable: false }, { key: true })
  ];
  const field = member.field;
  if (member.element.kind === 'vo') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    for (const sub of vo?.fields ?? []) {
      if (sub.kind === 'composite' || !sub.columns) {
        properties.push(`    // TODO (agente): ${vo.name}.${sub.name} es un value object anidado; mapéalo a columnas (skill keel-dotnet-database).`);
        continue;
      }
      const enumName = enumOf(sub);
      if (enumName) usings.push(...typeUsings(model, [enumName]));
      properties.push(rowProperty(csMember(sub.name), rowType(sub.csType, sub.columns)));
      config.push(columnChain(csMember(sub.name), sub.columns, { enumName }));
    }
  } else {
    const spec = field.elementColumns;
    const enumName = field.kind === 'enum' ? field.namedType : null;
    if (enumName) usings.push(...typeUsings(model, [enumName]));
    properties.push(rowProperty('Value', rowType(field.elementCsType, spec), `Un ${field.name}.`));
    config.push(columnChain('Value', spec, { enumName }));
  }
  // El índice que el diseño declara sobre esta lista (valor primero, FK detrás) y, SIEMPRE, el de la FK a la raíz:
  // cargar la lista de una raíz es un WHERE sobre esa columna.
  const { byMember } = collectionIndexesOf(entity, persistedMembers(model, entity));
  for (const index of byMember.get(member.name) ?? []) {
    config.push(`        row.HasIndex(r => new { r.Value, r.OwnerId }, ${csString(indexName(entity, index))})${index.unique ? '.IsUnique()' : ''}.HasDatabaseName(${csString(indexName(entity, index))});`);
  }
  config.push(`        row.HasIndex(r => r.OwnerId, ${csString(table.foreignKeyIndex)}).HasDatabaseName(${csString(table.foreignKeyIndex)});`);
  const text = `${xmlDoc(`Un elemento de ${entity.name}.${member.name}, en su posición.`)}public sealed class ${className} : IElementRow
{
${properties.join('\n\n')}
}

${xmlDoc(`El mapeo de ${className} a la tabla ${table.table}.`)}public sealed class ${rowConfigurationClass(className)} : IEntityTypeConfiguration<${className}>
{
    public void Configure(EntityTypeBuilder<${className}> row)
    {
${config.join('\n')}
    }
}`;
  return { className, table: table.table, foreignKey: table.foreignKey, text };
}

// ─── Los enums por su constante ──────────────────────────────────────────────────────────────────

/** Los enums que aparecen en alguna columna persistida (directa, aplanada o de elemento). */
export function persistedEnums(model) {
  const names = new Set();
  for (const entity of persistedEntities(model)) {
    for (const member of persistedMembers(model, entity)) {
      if (member.kind === 'scalar' && enumOf(member.field)) names.add(enumOf(member.field));
      if (member.kind === 'vo') for (const sub of member.subs) if (enumOf(sub.sub)) names.add(enumOf(sub.sub));
      if (member.kind === 'elementCollection') {
        if (member.field.kind === 'enum') names.add(member.field.namedType);
        const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
        for (const sub of vo?.fields ?? []) if (enumOf(sub)) names.add(enumOf(sub));
      }
    }
  }
  return (model.enums ?? []).filter((enumDef) => names.has(enumDef.name));
}

function enumColumnsFile(model) {
  const { namespace, path } = located(model, 'persistence', 'EnumColumns');
  const enums = persistedEnums(model);
  const blocks = enums.map((enumDef) => {
    const name = enumDef.name;
    const toConstant = enumDef.values.map((value) => `            ${name}.${enumMember(value.literal)} => ${csString(value.constant)},`);
    const fromConstant = enumDef.values.map((value) => `            ${csString(value.constant)} => ${name}.${enumMember(value.literal)},`);
    return `    /// <summary>${name} por el NOMBRE de su constante, en las dos direcciones.</summary>
    public static readonly ValueConverter<${name}, string> ${name}Column = new(value => ${name}Constant(value), constant => ${name}Of(constant));

    public static string ${name}Constant(${name} value) =>
        value switch
        {
${toConstant.join('\n')}
            _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Valor de ${name} sin constante")
        };

    public static ${name} ${name}Of(string constant) =>
        constant switch
        {
${fromConstant.join('\n')}
            _ => throw new InvalidOperationException($"Valor de enum desconocido en la base para ${name}: '{constant}'")
        };`;
  });
  const body = `/// <summary>
/// Cada enum persistido se guarda por el NOMBRE de su constante (<c>ACTIVE</c>), como el @Enumerated(STRING) de
/// keel-spring: el miembro de C# (<c>Active</c>) y el valor del cable (<c>active</c>) son otra cosa. Un nombre que el
/// enum no tiene es un dato que no casa con el diseño, y se dice en vez de leer un valor por defecto.
/// </summary>
public static class EnumColumns
{
${blocks.join('\n\n')}
}`;
  const usings = ['Microsoft.EntityFrameworkCore.Storage.ValueConversion', ...typeUsings(model, enums.map((enumDef) => enumDef.name))];
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Utilidades del mapeo ────────────────────────────────────────────────────────────────────────

function rowValuesFile(model) {
  const { namespace, path } = located(model, 'persistence', 'RowValues');
  const body = `/// <summary>
/// Lo que el mapeo fila → dominio necesita y no es una asignación: una columna que el esquema admite nula (un campo
/// <c>generated</c>, lo decide el diseño) en un miembro que el dominio no admite nulo, y el <c>json</c> embebido, que
/// se guarda como su texto. Un null donde el dominio no lo admite es un dato roto: se dice qué columna.
/// </summary>
public static class RowValues
{
    public static T Required<T>(T? value, string column)
        where T : struct =>
        value ?? throw new InvalidOperationException($"La columna {column} es null y el dominio no lo admite");

    public static string Required(string? value, string column) =>
        value ?? throw new InvalidOperationException($"La columna {column} es null y el dominio no lo admite");

    /// <summary>El json embebido desde su texto, tal cual se guardó.</summary>
    public static JsonElement Json(string? text, string column)
    {
        using var document = JsonDocument.Parse(Required(text, column));
        return document.RootElement.Clone();
    }

    public static JsonElement? JsonOrNull(string? text)
    {
        if (text is null)
        {
            return null;
        }
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    /// <summary>Lo que build no sabe mapear (un value object anidado): compila y falla al usarse, nombrándolo.</summary>
    public static T Unmapped<T>(string what) =>
        throw new NotImplementedException($"TODO (agente): mapear {what} (skill keel-dotnet-database)");
}

/// <summary>Una fila de la tabla de elementos de una lista: su posición es parte de la clave.</summary>
public interface IElementRow
{
    int Position { get; }
}`;
  return { path, content: csFile({ namespace, usings: ['System.Text.Json'], body }) };
}

function rowSyncFile(model) {
  const { namespace, path } = located(model, 'persistence', 'RowSync');
  const body = `/// <summary>
/// Lleva una colección del agregado a sus filas YA CARGADAS, en vez de borrarlas y volver a insertarlas: lo que sigue
/// igual no se toca, lo nuevo se añade y lo que ya no está se BORRA (el orphanRemoval de JPA; con una FK nula, EF solo
/// la dejaría huérfana). Es el merge que hace Hibernate con una entidad detached.
/// </summary>
public static class RowSync
{
    /// <summary>Hijas con identidad: se emparejan por su id.</summary>
    public static void Children<TRow, TEntity, TKey>(
        DbContext db,
        List<TRow> rows,
        IReadOnlyList<TEntity> entities,
        Func<TRow, TKey> rowKey,
        Func<TEntity, TKey> entityKey,
        Func<TEntity, TRow> create,
        Action<TRow, TEntity> apply)
        where TRow : class
        where TKey : notnull
    {
        var wanted = entities.Select(entityKey).ToHashSet();
        foreach (var gone in rows.Where(row => !wanted.Contains(rowKey(row))).ToList())
        {
            rows.Remove(gone);
            db.Remove(gone);
        }
        var byKey = rows.ToDictionary(rowKey);
        foreach (var entity in entities)
        {
            if (!byKey.TryGetValue(entityKey(entity), out var row))
            {
                row = create(entity);
                rows.Add(row);
            }
            apply(row, entity);
        }
    }

    /// <summary>
    /// Elementos sin identidad de una lista: se emparejan por POSICIÓN, que es parte de la clave y no se puede
    /// cambiar en una fila ya guardada. Sobran los de más; faltan, se añaden.
    /// </summary>
    public static void Elements<TRow, TValue>(
        DbContext db,
        List<TRow> rows,
        IReadOnlyList<TValue> values,
        Func<int, TRow> create,
        Action<TRow, TValue> apply)
        where TRow : class, IElementRow
    {
        foreach (var gone in rows.Where(row => row.Position < 0 || row.Position >= values.Count).ToList())
        {
            rows.Remove(gone);
            db.Remove(gone);
        }
        var byPosition = rows.ToDictionary(row => row.Position);
        for (var position = 0; position < values.Count; position++)
        {
            if (!byPosition.TryGetValue(position, out var row))
            {
                row = create(position);
                rows.Add(row);
            }
            apply(row, values[position]);
        }
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore'], body }) };
}

function textFoldFile(model) {
  const { namespace, path } = located(model, 'persistence', 'TextFold');
  const body = `/// <summary>
/// El plegado de un texto que se compara sin distinguir mayúsculas (y acentos): <c>compare</c> del diseño (DSL 2.14).
/// Lo estampa el adaptador en la columna SOMBRA al guardar, y quien filtre por ese campo tiene que plegar el valor
/// buscado con la MISMA función, o el filtro deja de casar en silencio.
/// </summary>
/// <remarks>
/// Con la cultura invariante, no con la del proceso: en turco «I» se plegaría a «ı» y dos réplicas plegarían distinto
/// el mismo valor (el Locale.ROOT de keel-spring).
/// </remarks>
public static class TextFold
{
    /// <summary>compare: ignore-case — sin mayúsculas. Null queda null.</summary>
    [return: NotNullIfNotNull(nameof(value))]
    public static string? FoldCase(string? value) => value?.ToLowerInvariant();

    /// <summary>compare: ignore-case-accents — sin mayúsculas y sin marcas diacríticas. Null queda null.</summary>
    [return: NotNullIfNotNull(nameof(value))]
    public static string? FoldCaseAndAccents(string? value)
    {
        if (value is null)
        {
            return null;
        }
        var decomposed = value.Normalize(NormalizationForm.FormD);
        var kept = new StringBuilder(decomposed.Length);
        foreach (var character in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) is not (UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark))
            {
                kept.Append(character);
            }
        }
        return kept.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant();
    }
}`;
  return { path, content: csFile({ namespace, usings: ['System.Diagnostics.CodeAnalysis', 'System.Globalization', 'System.Text'], body }) };
}

// ─── El DbContext ────────────────────────────────────────────────────────────────────────────────

/** Las clases de fila del esquema, con su configuración: las de las entidades y las de sus listas. */
export function rowClasses(model) {
  const classes = [];
  for (const entity of persistedEntities(model)) {
    classes.push(rowClass(entity.name));
    for (const member of persistedMembers(model, entity).filter((m) => m.kind === 'elementCollection')) classes.push(elementClass(entity, member));
  }
  // Las tablas de los mecanismos del generador: el registro de idempotencia de petición.
  if (usesRequestIdempotency(model)) classes.push(IDEMPOTENCY_ROW);
  // Y los de la mensajería: el outbox y el registro de mensajes procesados.
  classes.push(...storeRows(model));
  return classes;
}

function dbContextFile(model) {
  const { namespace, path } = located(model, 'persistence', dbContextClass(model));
  const roots = persistedEntities(model).filter((entity) => entity.isAggregateRoot);
  const sets = roots.map((entity) => `    public DbSet<${rowClass(entity.name)}> ${csMember(entity.tableName.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()))} => Set<${rowClass(entity.name)}>();`);
  const configurations = rowClasses(model).map((name) => `        modelBuilder.ApplyConfiguration(new ${rowConfigurationClass(name)}());`);
  const body = `/// <summary>
/// El esquema del servicio en EF Core: una tabla por entidad persistida y por lista, con los nombres de
/// keel-core/gen/relational.js (los mismos que keel-spring y keel-nest). Se registra con un ciclo de vida por
/// ÁMBITO —uno por petición, por mensaje o por pasada del reloj—, y es la unidad de trabajo de la transacción del
/// caso de uso: el mediator la abre y los adaptadores la comparten sin verla.
/// </summary>
public sealed class ${dbContextClass(model)}(DbContextOptions<${dbContextClass(model)}> options) : DbContext(options)
{
${sets.join('\n\n')}

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
${configurations.join('\n')}
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', rowsNamespace(model)], body }) };
}

// ─── La prueba del modelo ────────────────────────────────────────────────────────────────────────

/**
 * Los nombres que el esquema del diseño tiene que llevar, sacados de keel-core/gen/relational.js y no del mapeo de
 * arriba: las tablas, las constraints únicas e índices, los índices de FK y las FK. Es lo que la prueba emitida busca
 * en el DDL que EF genera del modelo.
 */
export function expectedSchemaNames(model) {
  const names = new Set();
  for (const entity of persistedEntities(model)) {
    const members = persistedMembers(model, entity);
    names.add(entity.tableName);
    for (const member of members.filter((m) => m.kind === 'elementCollection')) {
      const table = elementTable(entity, member);
      names.add(table.table).add(table.foreignKey).add(table.foreignKeyIndex);
    }
    const { handled } = collectionIndexesOf(entity, members);
    for (const index of entity.indexes ?? []) {
      if (index.when) continue;
      const probe = [];
      for (const field of index.fields) columnsFor(model, entity, members, field, probe);
      if (probe.length === 0 || handled.has(index)) names.add(indexName(entity, index));
    }
    for (const column of foreignKeyIndexColumns(model, entity, members)) names.add(foreignKeyIndexName(entity.tableName, column));
    for (const owner of unidirectionalParents(model, entity)) names.add(owner.foreignKey);
    for (const member of members.filter((m) => m.kind === 'relationOne' && m.relation.backReference)) names.add(foreignKeyName(entity.tableName, member.relation.name));
  }
  for (const constraint of uniqueConstraints(model)) names.add(constraint.constraint);
  for (const fk of crossAggregateForeignKeys(model)) names.add(fk.name);
  if (usesRequestIdempotency(model)) {
    names.add(IDEMPOTENCY_RECORD.table).add(`${IDEMPOTENCY_RECORD.table}_pkey`);
    for (const index of IDEMPOTENCY_RECORD.indexes) names.add(index.name);
  }
  for (const name of storeSchemaNames(model)) names.add(name);
  return [...names].sort();
}

/**
 * La prueba del MODELO, sin base de datos: EF lo construye entero (relaciones, claves, conversores) y genera el DDL,
 * que tiene que llevar cada tabla, constraint, índice y FK del diseño con su nombre. Compilar no basta: una relación
 * mal declarada solo falla al construir el modelo, que es en la primera petición. Lo que el motor hace con el DDL lo
 * juzga db-check.
 */
function schemaTestFile(model) {
  const sln = solution(model);
  const context = dbContextClass(model);
  const rows = expectedSchemaNames(model).map((name) => `    [InlineData(${csString(name)})]`);
  const body = `public sealed class PersistenceModelTests
{
    private static readonly Lazy<string> Ddl = new(() =>
    {
        // Sin conectar: el DDL se genera del modelo, y para construirlo no hace falta ninguna base.
        var options = new DbContextOptionsBuilder<${context}>().UseNpgsql("Host=unused").Options;
        using var db = new ${context}(options);
        return db.Database.GenerateCreateScript();
    });

    [Fact]
    public void ElModeloSeConstruyeYGeneraSuEsquema() => Assert.Contains("CREATE TABLE", Ddl.Value, StringComparison.Ordinal);

    /// <summary>
    /// Ningún nombre puesto por EF por su cuenta: una clave, una FK o un índice de convención no casaría con el
    /// traductor de errores ni con el baseline de los otros dos servidores.
    /// </summary>
    [Fact]
    public void NingunNombreLoPoneEfPorSuCuenta() => Assert.DoesNotMatch(@"\\b(PK|FK|IX|AK)_\\w+", Ddl.Value);

    [Theory]
${rows.join('\n')}
    public void ElEsquemaLlevaCadaNombreDelDiseño(string name) => Assert.Matches($@"\\b{name}\\b", Ddl.Value);
}`;
  return {
    path: `${sln.unitTests.dir}/PersistenceModelTests.cs`,
    content: csFile({ namespace: sln.unitTests.name, usings: ['Microsoft.EntityFrameworkCore', 'Xunit', persistenceNamespace(model)], body })
  };
}
