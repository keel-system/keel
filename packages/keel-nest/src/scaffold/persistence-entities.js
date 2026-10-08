// Las entidades de persistencia (TypeORM), separadas del dominio: `<Entidad>Orm` en
// infrastructure/persistence/entities, una por entidad persistida, más la tabla de elementos de cada
// lista. Es el `<Entidad>Jpa` de keel-spring sobre los MISMOS datos: tablas, columnas, cotas,
// constraints únicas, índices y FK salen de keel-core/gen/relational.js, así que el esquema de los
// dos servidores del mismo diseño tiene los mismos nombres —que es lo que leen el traductor de
// errores, el baseline y los scripts del arnés—.
//
// Lo único de aquí es el TIPO FÍSICO de cada motor (`physicalColumn`). Hibernate lo decide por su
// dialecto y TypeORM no: se escribe a mano, con el que Hibernate elige para el mismo tipo Java, y
// donde no se iguala se dice (la matriz de paridad de keel-nest).
//
// Tres decisiones de TypeORM que no son obvias:
//   · los value objects se APLANAN a columnas con prefijo, como en keel-spring, en vez de usar las
//     columnas embebidas de TypeORM: la nulabilidad de cada columna depende de si el value object
//     ENTERO es obligatorio en esa entidad, y una clase embebida no la puede saber;
//   · una relación a-uno se declara con `Relation<T>`: con ESM y emitDecoratorMetadata, el tipo de la
//     propiedad se evalúa al decorar la clase, y dos entidades que se nombran entre sí revientan con
//     «Cannot access before initialization»;
//   · el bloqueo optimista NO es un @VersionColumn: TypeORM incrementa la versión pero no comprueba
//     la esperada al guardar. Es una columna corriente que el adaptador sube con un UPDATE
//     condicionado (repositories.js), que es lo que hace Hibernate.

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
  usesAuditableEntity,
  LOCK_VERSION,
  AUDIT_COLUMNS,
  DECIMAL_PRECISION,
  snakeCase,
  camelCase,
  partialIndexSpecs,
  discriminatorColumn
} from 'keel-core/gen';
import { DIRS, classPath, capitalize, decapitalize, isNullable, tsModule, tsString } from './render.js';

export const ORM_DIR = 'infrastructure/persistence/entities';
export const TRANSFORMERS_TS = 'src/infrastructure/persistence/column-transformers.ts';
export const AUDITABLE_TS = classPath(ORM_DIR, 'AuditableOrm');
export const TEXT_FOLD_TS = 'src/infrastructure/persistence/text-fold.ts';

/** ¿El diseño persiste en un motor relacional? Es lo que genera todo este módulo. */
export function usesRelational(model) {
  return Boolean(model.layersPresent?.persistence) && model.persistenceKind !== 'document';
}

/** ¿El diseño persiste en documentos (MongoDB, incremento 12)? Lo genera document-persistence.js. */
export function usesDocument(model) {
  return Boolean(model.layersPresent?.persistence) && model.persistenceKind === 'document';
}

/**
 * ¿Hay persistencia, del modelo que sea? Es lo que deciden el mediator (abre la transacción), el filtro
 * de errores (traduce los del almacén) y el módulo raíz: las dos ramas emiten los MISMOS archivos de
 * transacción, errores y módulo, con la misma forma, y lo de encima no distingue cuál tiene debajo.
 */
export function usesPersistence(model) {
  return usesRelational(model) || usesDocument(model);
}

/** ¿Algún campo persistido se compara plegado (`compare`)? Entonces hace falta TextFold, en las dos ramas. */
export function usesTextFold(model) {
  return model.entities.some((entity) => entity.persisted && entity.fields.some((field) => field.fold));
}

/** El motor del stack, con PostgreSQL por defecto (la frontera solo admite postgresql y mysql). */
export function engineOf(model) {
  return model.stack?.database === 'mysql' ? 'mysql' : 'postgresql';
}

export const ormClass = (entityName) => `${entityName}Orm`;
export const ormPath = (entityName) => classPath(ORM_DIR, ormClass(entityName));
/** La clase de la tabla de elementos de una lista: vive en el archivo de su entidad. */
export const elementClass = (entity, member) => `${entity.name}${capitalize(member.name)}Element`;

export function generate(model) {
  if (!usesRelational(model)) return [];
  const files = [{ path: TRANSFORMERS_TS, content: transformersFile(model) }];
  if (usesTextFold(model)) {
    files.push({ path: TEXT_FOLD_TS, content: textFoldFile() });
  }
  if (usesAuditableEntity(model)) files.push({ path: AUDITABLE_TS, content: auditableFile(model) });
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    files.push(renderEntity(model, entity));
  }
  return files;
}

// ─── Tipos físicos ───────────────────────────────────────────────────────────

/**
 * El tipo físico de una columna en el motor, como opciones de @Column (sin el nombre ni la
 * nulabilidad) y el transformador que lleva el valor entre el dominio y el driver. El tipo es el
 * que Hibernate da al mismo tipo Java en ese dialecto, salvo donde se dice.
 */
export function physicalColumn(spec, engine, { enumName = null } = {}) {
  const pg = engine === 'postgresql';
  if (spec.enum) {
    // Por el NOMBRE de la constante (`ACTIVE`), como @Enumerated(EnumType.STRING): el valor del enum
    // de TypeScript es el literal del cable (`active`), así que lo traduce el transformador.
    return { options: { type: 'varchar', length: 255 }, transformer: `enumColumn(${enumName})`, imports: ['enumColumn'] };
  }
  switch (spec.base) {
    case 'uuid':
      // MySQL: binary(16), como Hibernate. Es lo que asume el `uuidLiteral` del catálogo
      // (UUID_TO_BIN) con el que el arnés escribe SQL a mano: un varchar(36) no casaría con él.
      return pg
        ? { options: { type: 'uuid' } }
        : { options: { type: 'binary', length: 16 }, transformer: 'UUID_BINARY', imports: ['UUID_BINARY'] };
    case 'int':
      return { options: { type: pg ? 'integer' : 'int' } };
    case 'long':
      // El driver devuelve un bigint como TEXTO (no cabe en un number): lo convierte el transformador.
      return { options: { type: 'bigint' }, transformer: 'LONG', imports: ['LONG'] };
    case 'decimal':
      // Con escala declarada, la precisión del contrato; sin ella, la columna por defecto de Hibernate
      // (38,2): las dos columnas del mismo diseño tienen que ser iguales.
      return {
        options: { type: pg ? 'numeric' : 'decimal', precision: spec.scale != null ? DECIMAL_PRECISION : 38, scale: spec.scale ?? 2 },
        transformer: 'DECIMAL',
        imports: ['DECIMAL']
      };
    case 'boolean':
      // MySQL: tinyint(1) (Hibernate pone bit). Divergencia declarada en la matriz de paridad.
      return { options: { type: 'boolean' } };
    case 'date':
      return { options: { type: 'date' }, transformer: 'LOCAL_DATE', imports: ['LOCAL_DATE'] };
    case 'timestamp':
      return { options: { type: pg ? 'timestamptz' : 'datetime', precision: 6 } };
    case 'text':
      return withCollation({ options: { type: 'text' } }, spec);
    case 'json':
      return withCollation({ options: { type: 'text' }, transformer: 'RAW_JSON', imports: ['RAW_JSON'] }, spec);
    default:
      // Texto acotado (string, file, value types textuales): varchar con la cota del diseño, o 255.
      return withCollation({ options: { type: 'varchar', length: spec.length ?? 255 } }, spec);
  }
}

function withCollation(column, spec) {
  return spec.collation ? { ...column, options: { ...column.options, collation: spec.collation } } : column;
}

/** Las opciones de @Column como literal TypeScript, en un orden fijo. */
export function optionsLiteral(options) {
  const order = ['name', 'type', 'length', 'precision', 'scale', 'collation', 'nullable', 'update', 'transformer'];
  const entries = order
    .filter((key) => options[key] !== undefined)
    .map((key) => {
      const value = options[key];
      if (key === 'transformer') return `transformer: ${value}`;
      return `${key}: ${typeof value === 'string' ? tsString(value) : String(value)}`;
    });
  return `{ ${entries.join(', ')} }`;
}

/** Una propiedad de columna completa: decorador y declaración. */
function columnProperty({ decorator = 'Column', name, spec, engine, enumName, tsType, nullable, tsNullable = nullable, update, comment, transformer = null }) {
  const found = physicalColumn(spec, engine, { enumName });
  const physical = transformer ? { ...found, transformer, imports: [transformer] } : found;
  const options = { name, ...physical.options, nullable };
  if (update === false) options.update = false;
  if (physical.transformer) options.transformer = physical.transformer;
  if (decorator === 'PrimaryColumn') delete options.nullable;
  const doc = comment ? `  // ${comment}\n` : '';
  return {
    text: `${doc}  @${decorator}(${optionsLiteral(options)})\n  ${spec.propertyName}: ${tsNullable ? `${tsType} | null` : tsType};`,
    imports: physical.imports ?? []
  };
}

// ─── La entidad ──────────────────────────────────────────────────────────────

/**
 * El mapa columna → propiedad de la entidad ORM. Lo necesitan @Unique e @Index, que en TypeORM
 * nombran PROPIEDADES, mientras keel-core/gen nombra columnas.
 */
export function columnProperties(model, entity, members = persistedMembers(model, entity)) {
  const map = new Map();
  for (const member of members) {
    if (member.kind === 'scalar') {
      map.set(snakeCase(member.name), member.name);
      if (member.folded) map.set(member.folded.column, member.folded.name);
    } else if (member.kind === 'vo') {
      for (const sub of member.subs) map.set(sub.column, sub.name);
    } else if (member.kind === 'externalRef') {
      map.set(member.column, member.name);
    } else if (member.kind === 'relationOne') {
      map.set(joinColumnOf(member.relation), fkProperty(member.name));
    }
  }
  for (const parent of unidirectionalParents(model, entity)) map.set(parent.column, fkProperty(parent.property));
  return map;
}

/**
 * La propiedad que DECLARA la columna FK de una relación a-uno, junto a la relación. Existe porque
 * TypeORM no aplica el transformador de la columna referenciada al escribir la FK de una relación: en
 * MySQL el uuid de la raíz llegaba como texto a una columna binary(16) («Data too long», medido con
 * db-check). Declarada con el mismo nombre, TypeORM la reutiliza como la columna de la relación, con su
 * tipo y su transformador; la rellena el adaptador al mapear.
 */
export function fkProperty(relationProperty) {
  return `${relationProperty}Id`;
}

/** La columna FK declarada: el tipo y el transformador del id de la entidad referenciada. */
function fkColumn(model, targetName, name, propertyName, nullable) {
  const target = model.entities.find((candidate) => candidate.name === targetName);
  const idSpec = target?.idField?.columns ?? { base: 'uuid' };
  return {
    name,
    spec: { ...idSpec, name, propertyName },
    tsType: target?.idField?.tsType ?? 'string',
    nullable,
    comment: `La FK de ${propertyName.replace(/Id$/, '')}, declarada con el tipo del id que referencia (ver fkProperty).`
  };
}

/**
 * Los padres que apuntan a esta entidad con un one-to-many UNIDIRECCIONAL. En JPA la FK la pone el
 * @JoinColumn del padre; TypeORM no tiene one-to-many sin su many-to-one inverso, así que la hija
 * lleva una propiedad sintética hacia el padre, con la MISMA columna y la misma FK.
 */
export function unidirectionalParents(model, entity) {
  const parents = [];
  for (const parent of model.entities.filter((candidate) => candidate.persisted)) {
    for (const relation of parent.relations ?? []) {
      if (!relation.internal || relation.cardinality !== 'one-to-many' || relation.entity !== entity.name) continue;
      if (backReferenceTo(model, entity.name, parent.name)) continue;
      parents.push({
        parent,
        relation,
        property: `${decapitalize(parent.name)}Owner`,
        column: parentColumnOf(parent.name),
        foreignKey: foreignKeyName(entity.tableName, parent.name)
      });
    }
  }
  return parents;
}

/** El nombre del one-to-many del padre que una back-reference invierte, o null si no lo hay. */
function inverseCollectionOf(model, entity, relation) {
  const parent = model.entities.find((candidate) => candidate.name === relation.entity);
  const collection = (parent?.relations ?? []).find(
    (candidate) => candidate.internal && candidate.entity === entity.name && candidate.cardinality === 'one-to-many'
  );
  return collection?.name ?? null;
}

function renderEntity(model, entity) {
  const engine = engineOf(model);
  const file = ormPath(entity.name);
  const members = persistedMembers(model, entity);
  const typeorm = new Set(['Entity']);
  const imports = [];
  const transformers = new Set();
  const properties = [];
  const elements = [];
  const props = columnProperties(model, entity, members);

  const addColumn = (args) => {
    const rendered = columnProperty({ engine, ...args });
    properties.push(rendered.text);
    for (const symbol of rendered.imports) transformers.add(symbol);
    if (args.enumName) imports.push({ symbol: args.enumName, from: classPath(DIRS.enums, args.enumName) });
    // El tipo del dominio que declara la propiedad (Decimal, RawJson): solo como tipo.
    for (const imp of args.typeImports ?? []) if (imp.from?.startsWith('src/')) imports.push({ ...imp, type: true });
    typeorm.add(args.decorator ?? 'Column');
  };

  // La auditoría declarada: los campos SON del dominio, y el adaptador los estampa al guardar.
  const declaredAudit = new Set([
    ...(entity.auditTimestamps === 'declared' ? ['createdAt', 'updatedAt'] : []),
    ...(entity.auditAuthorship === 'declared' ? ['createdBy', 'updatedBy'] : [])
  ]);

  for (const member of members) {
    if (member.kind === 'scalar') {
      const { field } = member;
      const spec = { ...field.columns, propertyName: field.name };
      addColumn({
        decorator: field.isId ? 'PrimaryColumn' : 'Column',
        name: field.columns.name,
        spec,
        enumName: field.kind === 'enum' ? field.namedType : null,
        tsType: field.tsType,
        typeImports: field.imports,
        nullable: field.columns.nullable,
        // El tipo de la propiedad es el del dominio: un campo `generated` es nulo en la columna (lo
        // decide el diseño) pero nunca en el agregado, que lo genera al nacer.
        tsNullable: isNullable(field),
        // `createdAt`/`createdBy` no cambian después de nacer, como @CreatedDate/@CreatedBy.
        update: field.columns.updatable && !(declaredAudit.has(field.name) && field.name.startsWith('created')) ? undefined : false,
        comment: declaredAudit.has(field.name) ? `Auditoría declarada (persistence.audit): la estampa el adaptador al guardar.` : null
      });
      if (member.folded) {
        const shadow = member.folded;
        addColumn({
          name: shadow.column,
          spec: { base: 'string', length: shadow.maxLength ?? 255, propertyName: shadow.name },
          tsType: 'string',
          nullable: !shadow.required,
          comment: `${field.name} plegado (compare: ${field.compare}): lo estampa el adaptador con TextFold al guardar.`
        });
      }
    } else if (member.kind === 'vo') {
      if (member.subs.length === 0) {
        properties.push(`  // TODO (agente): mapear el value object ${member.field.namedType} a columnas.`);
        continue;
      }
      for (const sub of member.subs) {
        if (sub.subKind === 'composite') {
          properties.push(
            `  // TODO (agente): ${member.field.namedType}.${sub.voAccessor} es un value object anidado; mapéalo a columnas (ver skill keel-nest-database).`
          );
          continue;
        }
        const subField = sub.sub;
        // La columna aplanada es una columna como cualquier otra: las cotas del sub-campo, con el
        // nombre del aplanado y NOT NULL solo si el value object entero es obligatorio.
        const nullable = !(sub.ownerRequired && subField.columns && !subField.columns.nullable);
        addColumn({
          name: sub.column,
          spec: { ...subField.columns, propertyName: sub.name },
          enumName: subField.kind === 'enum' ? subField.namedType : null,
          tsType: subField.tsType,
          typeImports: subField.imports,
          nullable,
          comment: `${member.field.namedType}.${sub.voAccessor} aplanado.`
        });
      }
    } else if (member.kind === 'externalRef') {
      // Otro agregado: solo su id, sin asociación (una navegable rompería la frontera del agregado).
      // La FK entre agregados va en el baseline (crossAggregateForeignKeys), no aquí.
      addColumn({
        name: member.column,
        spec: { base: 'uuid', propertyName: member.name },
        tsType: 'string',
        nullable: !member.relation.required,
        comment: `Id de la raíz de ${member.relation.entity} (otro agregado).`
      });
    } else if (member.kind === 'elementCollection') {
      const element = renderElement(model, entity, member, engine, imports, transformers, typeorm);
      elements.push(element.text);
      typeorm.add('OneToMany');
      properties.push(
        `  // La lista ${member.name}: su tabla de elementos (${element.table}), en el orden en que se guardó.\n` +
          `  @OneToMany(() => ${element.className}, (element) => element.owner, { cascade: true })\n` +
          `  ${member.name}: ${element.className}[];`
      );
    } else if (member.kind === 'relationMany') {
      const child = member.relation.entity;
      if (member.relation.cardinality === 'many-to-many') {
        properties.push(`  // TODO (agente): ${member.name} es many-to-many dentro del agregado; TypeORM necesita su tabla de unión (ver skill keel-nest-database).`);
        continue;
      }
      if (child !== entity.name) imports.push({ symbol: ormClass(child), from: ormPath(child) });
      typeorm.add('OneToMany');
      const inverse = backReferenceTo(model, child, entity.name) ?? `${decapitalize(entity.name)}Owner`;
      properties.push(
        `  @OneToMany(() => ${ormClass(child)}, (child) => child.${inverse}, { cascade: true })\n  ${member.name}: ${ormClass(child)}[];`
      );
    } else {
      // relationOne: lado dueño de la FK, `<relación>_id` en esta tabla.
      const target = member.relation.entity;
      if (target !== entity.name) imports.push({ symbol: ormClass(target), from: ormPath(target) });
      imports.push({ symbol: 'Relation', from: 'typeorm', type: true });
      typeorm.add('JoinColumn');
      const join = `@JoinColumn({ name: ${tsString(joinColumnOf(member.relation))}, foreignKeyConstraintName: ${tsString(foreignKeyName(entity.tableName, member.relation.name))} })`;
      const nullable = !member.relation.required;
      addColumn(fkColumn(model, target, joinColumnOf(member.relation), fkProperty(member.name), nullable));
      const inverse = member.relation.backReference ? inverseCollectionOf(model, entity, member.relation) : null;
      if (inverse) {
        // La vuelta de una hija a su raíz: el many-to-one del one-to-many del padre. Al quitarla de
        // la colección, la fila se borra (el orphanRemoval de JPA).
        typeorm.add('ManyToOne');
        properties.push(
          `  @ManyToOne(() => ${ormClass(target)}, (parent) => parent.${inverse}, { nullable: ${nullable}, orphanedRowAction: 'delete' })\n  ${join}\n  ${member.name}: Relation<${ormClass(target)}>${nullable ? ' | null' : ''};`
        );
      } else if (member.relation.cardinality === 'many-to-one') {
        typeorm.add('ManyToOne');
        properties.push(`  @ManyToOne(() => ${ormClass(target)}, { nullable: ${nullable} })\n  ${join}\n  ${member.name}: Relation<${ormClass(target)}>${nullable ? ' | null' : ''};`);
      } else {
        typeorm.add('OneToOne');
        properties.push(
          `  @OneToOne(() => ${ormClass(target)}, { cascade: true, nullable: ${nullable} })\n  ${join}\n  ${member.name}: Relation<${ormClass(target)}>${nullable ? ' | null' : ''};`
        );
      }
    }
  }

  // El one-to-many unidireccional de un padre: su many-to-one sintético, con la columna y la FK que
  // pone el @JoinColumn del padre en keel-spring.
  for (const owner of unidirectionalParents(model, entity)) {
    if (owner.parent.name !== entity.name) imports.push({ symbol: ormClass(owner.parent.name), from: ormPath(owner.parent.name) });
    imports.push({ symbol: 'Relation', from: 'typeorm', type: true });
    typeorm.add('ManyToOne').add('JoinColumn');
    // Nula, como la crea Hibernate para un one-to-many unidireccional con @JoinColumn: el esquema de los
    // dos servidores es el mismo (schema-parity). La hija huérfana la borra igual el orphanedRowAction.
    addColumn(fkColumn(model, owner.parent.name, owner.column, fkProperty(owner.property), true));
    properties.push(
      `  // Vuelta sintética del one-to-many ${owner.parent.name}.${owner.relation.name}: el dominio no la nombra.\n` +
        `  @ManyToOne(() => ${ormClass(owner.parent.name)}, (parent) => parent.${owner.relation.name}, { nullable: true, orphanedRowAction: 'delete' })\n` +
        `  @JoinColumn({ name: ${tsString(owner.column)}, foreignKeyConstraintName: ${tsString(owner.foreignKey)} })\n` +
        `  ${owner.property}: Relation<${ormClass(owner.parent.name)}>;`
    );
  }

  // Concurrencia optimista: la raíz porta su versión (persistence.consistency.optimisticLocking).
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) {
    addColumn({
      name: LOCK_VERSION.column,
      spec: { base: 'long', propertyName: LOCK_VERSION.field },
      tsType: 'number',
      nullable: true,
      // La versión viaja en el dominio como number: el transformador de un bigint la daría como bigint.
      transformer: 'LOCK_VERSION',
      comment: 'Versión de concurrencia optimista: la sube el adaptador con un UPDATE condicionado, nunca a mano.'
    });
  }

  const header = [`@Entity({ name: ${tsString(entity.tableName)} })`];
  header.push(...tableConstraints(model, entity, members, props, typeorm));

  // La unicidad CONDICIONADA al estado (`indexes` con `when`): «como mucho uno activo por clave». Sin
  // el predicado sería una unicidad sobre todas las filas, lo contrario del invariante. PostgreSQL lo
  // dice con un índice parcial; MySQL, que no los tiene, con una columna generada DECLARADA que vale 1
  // dentro de la condición y NULL fuera (un índice único no restringe las filas con NULL). Declarada y
  // no como parte funcional anónima: esa es opaca a la introspección del esquema (keel-spring midió
  // que tumbaba el arranque de Hibernate). El predicado compara con la CONSTANTE del enum guardada.
  for (const spec of partialIndexSpecs(model, engine).filter((candidate) => candidate.entity === entity.name)) {
    const columns = spec.fields.flatMap((name) => columnsFor(model, entity, members, name)).map((column) => tsString(props.get(column) ?? column));
    typeorm.add('Index');
    if (engine === 'postgresql') {
      header.push(`@Index(${tsString(spec.name)}, [${columns.join(', ')}], { unique: true, where: ${tsString(spec.predicate)} })`);
    } else {
      const flag = discriminatorColumn(spec);
      const property = camelCase(flag);
      typeorm.add('Column');
      properties.push(
        `  // Discriminador de ${spec.name}: 1 con ${spec.when.field} = ${JSON.stringify(spec.when.equals)}, NULL fuera. Lo calcula el motor.\n` +
          `  @Column({ name: ${tsString(flag)}, type: 'tinyint', nullable: true, generatedType: 'STORED', asExpression: ${tsString(`CASE WHEN ${spec.predicate} THEN 1 END`)}, insert: false, update: false })\n` +
          `  ${property}: number | null;`
      );
      header.push(`@Index(${tsString(spec.name)}, [${[...columns, tsString(property)].join(', ')}], { unique: true })`);
    }
  }

  const inherits = entity.auditTimestamps === 'all' || entity.auditAuthorship === 'all';
  if (inherits) imports.push({ symbol: 'AuditableOrm', from: AUDITABLE_TS });
  for (const symbol of typeorm) imports.push({ symbol, from: 'typeorm' });
  for (const symbol of transformers) imports.push({ symbol, from: TRANSFORMERS_TS });

  const body = `${elements.length > 0 ? `${elements.join('\n\n')}\n\n` : ''}/** Tabla de ${entity.name}${entity.isAggregateRoot ? ' (raíz del agregado)' : ''}. El dominio no la conoce: la mapea su adaptador. */
${header.join('\n')}
export class ${ormClass(entity.name)}${inherits ? ' extends AuditableOrm' : ''} {
${properties.join('\n\n')}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/**
 * Las constraints únicas e índices de la tabla, con los nombres de keel-core/gen. Los condicionados
 * (`when`) NO salen aquí: sin su predicado serían una unicidad sobre todas las filas, lo contrario del
 * invariante («como mucho una activa» pasaría a «como mucho una»).
 */
function tableConstraints(model, entity, members, props, typeorm) {
  const lines = [];
  const propOf = (column) => props.get(column) ?? column;
  const shadowOf = (name) => members.find((m) => m.kind === 'scalar' && m.name === name)?.folded;
  const list = (columns) => `[${columns.map((column) => tsString(propOf(column))).join(', ')}]`;

  if (entity.naturalKey?.length > 0) {
    const columns = entity.naturalKey.flatMap((name) => (shadowOf(name) ? [shadowOf(name).column] : columnsFor(model, entity, members, name, model.warnings)));
    typeorm.add('Unique');
    lines.push(`@Unique(${tsString(`uk_${entity.tableName}_natural`)}, ${list(columns)})`);
  }
  for (const field of uniqueFields(entity)) {
    const target = shadowOf(field.name)?.column ?? snakeCase(field.name);
    typeorm.add('Unique');
    lines.push(`@Unique(${tsString(`uk_${entity.tableName}_${snakeCase(field.name)}`)}, ${list([target])})`);
  }
  const { handled } = collectionIndexesOf(entity, members);
  for (const index of entity.indexes ?? []) {
    if (index.when || handled.has(index)) continue;
    const probe = [];
    const columns = index.fields.flatMap((name) => columnsFor(model, entity, members, name, probe));
    // Un índice sobre lo que no es columna de esta tabla rompe el DDL: lo avisa keel-spring con el
    // mismo texto al anotar, y aquí no se repite el aviso.
    if (probe.length > 0) continue;
    typeorm.add('Index');
    lines.push(`@Index(${tsString(indexName(entity, index))}, ${list(columns)}${index.unique ? ', { unique: true }' : ''})`);
  }
  for (const column of foreignKeyIndexColumns(model, entity, members)) {
    typeorm.add('Index');
    lines.push(`@Index(${tsString(foreignKeyIndexName(entity.tableName, column))}, ${list([column])})`);
  }
  return lines;
}

/** La tabla de elementos de una lista: clave (raíz, orden), la columna del valor y la FK a la raíz. */
function renderElement(model, entity, member, engine, imports, transformers, typeorm) {
  const table = elementTable(entity, member);
  const className = elementClass(entity, member);
  typeorm.add('Entity').add('PrimaryColumn').add('Column').add('ManyToOne').add('JoinColumn').add('Index');
  imports.push({ symbol: 'Relation', from: 'typeorm', type: true });
  const lines = [];
  const pk = (name, property, base, tsType) => {
    const physical = physicalColumn({ base }, engine);
    for (const symbol of physical.imports ?? []) transformers.add(symbol);
    const options = { name, ...physical.options };
    if (physical.transformer) options.transformer = physical.transformer;
    return `  @PrimaryColumn(${optionsLiteral(options)})\n  ${property}: ${tsType};`;
  };
  lines.push(pk(table.joinColumn, 'ownerId', 'uuid', 'string'));
  lines.push(pk(table.orderColumn, 'position', 'int', 'number'));

  const field = member.field;
  if (member.element.kind === 'vo') {
    const vo = model.valueObjects.find((candidate) => candidate.name === field.namedType);
    for (const sub of vo?.fields ?? []) {
      if (sub.kind === 'composite' || !sub.columns) {
        lines.push(`  // TODO (agente): ${vo.name}.${sub.name} es un value object anidado; mapéalo a columnas (ver skill keel-nest-database).`);
        continue;
      }
      const rendered = columnProperty({
        engine,
        name: sub.columns.name,
        spec: { ...sub.columns, propertyName: sub.name },
        enumName: sub.kind === 'enum' ? sub.namedType : null,
        tsType: sub.tsType,
        nullable: sub.columns.nullable
      });
      for (const symbol of rendered.imports) transformers.add(symbol);
      if (sub.kind === 'enum') imports.push({ symbol: sub.namedType, from: classPath(DIRS.enums, sub.namedType) });
      for (const imp of sub.imports ?? []) if (imp.from?.startsWith('src/')) imports.push({ ...imp, type: true });
      lines.push(rendered.text);
    }
  } else {
    const spec = field.elementColumns;
    const rendered = columnProperty({
      engine,
      name: spec.name,
      spec: { ...spec, propertyName: 'value' },
      enumName: field.kind === 'enum' ? field.namedType : null,
      tsType: field.elementTsType,
      nullable: spec.nullable
    });
    for (const symbol of rendered.imports) transformers.add(symbol);
    if (field.kind === 'enum') imports.push({ symbol: field.namedType, from: classPath(DIRS.enums, field.namedType) });
    for (const imp of field.imports ?? []) if (imp.from?.startsWith('src/')) imports.push({ ...imp, type: true });
    lines.push(rendered.text);
  }
  lines.push(
    `  @ManyToOne(() => ${ormClass(entity.name)}, (owner) => owner.${member.name}, { nullable: false, orphanedRowAction: 'delete' })\n` +
      `  @JoinColumn({ name: ${tsString(table.joinColumn)}, foreignKeyConstraintName: ${tsString(table.foreignKey)} })\n` +
      `  owner: Relation<${ormClass(entity.name)}>;`
  );

  // El índice que el diseño declara sobre esta lista (valor primero, FK detrás) y, SIEMPRE, el de la
  // FK a la raíz: cargar la lista de una raíz es un WHERE sobre esa columna.
  const decorators = [`@Entity({ name: ${tsString(table.table)} })`];
  const { byMember } = collectionIndexesOf(entity, persistedMembers(model, entity));
  for (const index of byMember.get(member.name) ?? []) {
    decorators.push(`@Index(${tsString(indexName(entity, index))}, ['value', 'ownerId']${index.unique ? ', { unique: true }' : ''})`);
  }
  decorators.push(`@Index(${tsString(table.foreignKeyIndex)}, ['ownerId'])`);
  return {
    table: table.table,
    className,
    text: `/** Un elemento de ${entity.name}.${member.name}, en su posición: la lista es un valor ordenado. */
${decorators.join('\n')}
export class ${className} {
${lines.join('\n\n')}
}`
  };
}

// ─── Auditoría ───────────────────────────────────────────────────────────────

function auditableFile(model) {
  const engine = engineOf(model);
  const columns = [
    ...(model.audit?.timestamps === 'all' ? AUDIT_COLUMNS.timestamps : []),
    ...(model.audit?.authorship === 'all' ? AUDIT_COLUMNS.authorship : [])
  ];
  const properties = columns.map((column) => {
    const base = column.field.endsWith('At') ? 'timestamp' : 'string';
    const physical = physicalColumn({ base, length: 255 }, engine);
    const options = { name: column.column, ...physical.options, nullable: false };
    if (!column.updatable) options.update = false;
    return `  @Column(${optionsLiteral(options)})\n  ${column.field}: ${base === 'timestamp' ? 'Date' : 'string'};`;
  });
  const body = `/**
 * Base de las entidades auditables (persistence.audit: all): las columnas que el diseño delega en la
 * política, sin que el dominio las nombre. Las estampa el adaptador de cada raíz al guardar —en la
 * aplicación, como el listener de auditoría de Spring Data, y no con un DEFAULT del motor—, así que
 * \`created_*\` no cambia después de nacer.
 */
export abstract class AuditableOrm {
${properties.join('\n\n')}
}`;
  return tsModule(AUDITABLE_TS, [{ symbol: 'Column', from: 'typeorm' }], body);
}

// ─── Transformadores y plegado ───────────────────────────────────────────────

function transformersFile(model) {
  const mysql = engineOf(model) === 'mysql';
  const uuid = mysql
    ? `

/**
 * uuid ↔ binary(16) en MySQL, con los bytes en el orden del texto: es lo que hace UUID_TO_BIN sin su
 * segundo argumento, y por tanto lo que leen y escriben los scripts del arnés.
 */
export const UUID_BINARY: ValueTransformer = {
  to: (value: string | null | undefined) => (value == null ? value : Buffer.from(value.replaceAll('-', ''), 'hex')),
  from: (value: Buffer | null) => {
    if (value == null) return null;
    const hex = value.toString('hex');
    return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
  }
};`
    : '';
  const body = `/**
 * Lo que lleva cada valor entre el dominio y el driver sin perder nada por el camino: un decimal con
 * su escala (nunca un number binario), un entero de 64 bits como bigint, un \`json\` embebido como su
 * texto, una fecha sin hora como texto ISO y un enum por el NOMBRE de su constante.
 */

/** decimal ↔ Decimal, con la escala de la columna (el driver lo devuelve como texto). */
export const DECIMAL: ValueTransformer = {
  to: (value: Decimal | null | undefined) => (value == null ? value : value.toString()),
  from: (value: string | null) => (value == null ? null : Decimal.parse(String(value)))
};

/** bigint ↔ bigint de TypeScript (el driver lo devuelve como texto). */
export const LONG: ValueTransformer = {
  to: (value: bigint | null | undefined) => (value == null ? value : value.toString()),
  from: (value: string | number | null) => (value == null ? null : BigInt(value))
};

/** La versión de bloqueo optimista: un bigint de la base que el dominio lleva como number. */
export const LOCK_VERSION: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value == null ? null : Number(value))
};

/** json embebido ↔ RawJson: se guarda el texto tal cual llegó. */
export const RAW_JSON: ValueTransformer = {
  to: (value: RawJson | null | undefined) => (value == null ? value : value.text),
  from: (value: string | null) => (value == null ? null : RawJson.of(value))
};

/** date ↔ 'YYYY-MM-DD': una fecha sin hora no tiene zona, y un Date de JavaScript sí. */
export const LOCAL_DATE: ValueTransformer = {
  to: (value: string | null | undefined) => value,
  from: (value: string | Date | null) => {
    if (value == null) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    return \`\${value.getFullYear()}-\${String(value.getMonth() + 1).padStart(2, '0')}-\${String(value.getDate()).padStart(2, '0')}\`;
  }
};

/**
 * Un enum por el NOMBRE de su constante (\`ACTIVE\`), como @Enumerated(EnumType.STRING): el valor del
 * enum de TypeScript es el literal del cable (\`active\`). Un nombre que el enum no tiene es un
 * dato que no casa con el diseño, y se dice en vez de devolver undefined.
 */
export function enumColumn<E extends Record<string, string>>(type: E): ValueTransformer {
  const byValue = new Map<string, string>(Object.entries(type).map(([name, value]) => [value, name]));
  return {
    to: (value: string | null | undefined) => (value == null ? value : byValue.get(value) ?? value),
    from: (name: string | null) => {
      if (name == null) return null;
      const value = (type as Record<string, string>)[name];
      if (value === undefined) throw new Error(\`Valor de enum desconocido en la base: '\${name}'\`);
      return value;
    }
  };
}${uuid}`;
  return tsModule(
    TRANSFORMERS_TS,
    [
      { symbol: 'ValueTransformer', from: 'typeorm', type: true },
      { symbol: 'Decimal', from: 'src/domain/support/decimal.ts' },
      { symbol: 'RawJson', from: 'src/domain/support/raw-json.ts' }
    ],
    body
  );
}

export function textFoldFile() {
  return `/**
 * El plegado de un texto que se compara sin distinguir mayúsculas (y acentos): \`compare\` del diseño
 * (DSL 2.14). Lo estampa el adaptador en la columna SOMBRA al guardar, y quien filtre por ese campo
 * tiene que plegar el valor buscado con la MISMA función, o el filtro deja de casar en silencio.
 *
 * \`toLowerCase\` y no \`toLocaleLowerCase\`: con el locale del proceso, en turco «I» se plegaría a «ı»
 * y dos réplicas plegarían distinto el mismo valor (el Locale.ROOT de keel-spring).
 */
function foldCase(value: string): string;
function foldCase(value: string | null | undefined): string | null;
/** compare: ignore-case — sin mayúsculas. Null queda null. */
function foldCase(value: string | null | undefined): string | null {
  return value == null ? null : value.toLowerCase();
}

function foldCaseAndAccents(value: string): string;
function foldCaseAndAccents(value: string | null | undefined): string | null;
/** compare: ignore-case-accents — sin mayúsculas y sin marcas diacríticas. Null queda null. */
function foldCaseAndAccents(value: string | null | undefined): string | null {
  return value == null ? null : value.normalize('NFD').replace(/\\p{M}+/gu, '').toLowerCase();
}

export const TextFold = { foldCase, foldCaseAndAccents } as const;
`;
}
