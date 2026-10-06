// El ESQUEMA de la persistencia, sin lenguaje (keel-core/gen).
//
// Qué tablas y columnas tiene un servicio, con qué cotas, qué constraints únicas y qué índices
// llevan qué nombre, qué FK hay entre agregados: todo eso es una lectura del diseño y no de un ORM.
// Y es contrato observable de los dos generadores a la vez —el `code` declarado de una violación
// se resuelve buscando el NOMBRE de la constraint en el mensaje del motor, el baseline se exporta de
// estas tablas y los scripts del arnés escriben SQL contra estas columnas—, así que no puede
// decidirse dos veces: keel-spring lo escribe como anotaciones JPA y keel-nest como decoradores de
// TypeORM, sobre los MISMOS datos.
//
// Lo que este módulo NO decide es el tipo físico de cada motor (eso lo pone el ORM de cada
// generador, o su tabla de tipos) ni cómo se cita un identificador dentro de una anotación: los
// nombres salen crudos, y quien los escribe los cita en su idioma.

import { snakeCase } from './naming.js';
import { isTextual } from './types.js';

// ─── Palabras reservadas ─────────────────────────────────────────────────────
//
// Un nombre de campo del diseño (primary, order, user, value…) se convierte en nombre de columna
// literal, y sin citarlo el DDL no compila: la tabla nunca se crea y toda operación que la toque
// devuelve 500. La lista es la UNIÓN de las reservadas de los motores relacionales del catálogo,
// porque el mismo diseño se genera para cualquiera y el nombre de columna no puede depender del que
// se elija en el cuestionario.
const RESERVED = new Set(
  `absolute action add all allocate alter and any are array as asc assertion at authorization
   avg before begin between bigint binary bit blob boolean both breadth by call cascade cascaded
   case cast catalog char character check class clob close coalesce collate collation column
   commit condition connect connection constraint constraints contains continue convert
   corresponding count create cross cube current current_date current_path current_role
   current_time current_timestamp current_user cursor cycle data date day deallocate dec decimal
   declare default deferrable deferred delete depth deref desc describe descriptor deterministic
   diagnostics disconnect distinct do domain double drop dynamic each else elseif end end_exec
   equals escape except exception exec execute exists exit external extract false fetch filter
   first float for foreign found free from full function general get global go goto grant group
   grouping handler having hold hour identity if immediate in indicator initially inner inout
   input insensitive insert int integer intersect interval into is isolation iterate join key
   language large last lateral leading leave left level like limit local localtime localtimestamp
   locator loop lower map match max member merge method min minute modifies module month
   multiset names national natural nchar nclob new next no none not null nullif numeric object
   of offset old on only open option or order ordinality out outer output over overlaps pad
   parameter partial partition path position precision prepare preserve primary prior privileges
   procedure public range read reads real recursive ref references referencing relative release
   repeat resignal restrict result return returns revoke right role rollback rollup routine row
   rows savepoint schema scope scroll search second section select sensitive session session_user
   set sets signal similar size smallint some space specific specifictype sql sqlexception
   sqlstate sqlwarning start state static submultiset substring sum symmetric system system_user
   table tablesample temporary then time timestamp timezone_hour timezone_minute to trailing
   transaction translate translation treat trigger trim true under undo union unique unknown
   unnest until update upper usage user using value values varchar varying view when whenever
   where while window with within without work write year zone`
    .split(/\s+/)
    .filter(Boolean)
);

export function isReservedSqlWord(name) {
  return RESERVED.has(String(name).toLowerCase());
}

// El carácter de cita REAL de cada motor, para el SQL escrito a mano (el apéndice de índices
// condicionados, los scripts del arnés): ahí no hay ORM que traduzca nada.
const QUOTE_CHARS = {
  postgresql: ['"', '"'],
  oracle: ['"', '"'],
  mysql: ['`', '`'],
  mariadb: ['`', '`'],
  sqlserver: ['[', ']']
};

/** Identificador citado para SQL literal del motor elegido, solo si choca con una reservada. */
export function quoteIdentifierFor(dialect, name) {
  if (!isReservedSqlWord(name)) return name;
  const [open, close] = QUOTE_CHARS[dialect] ?? ['"', '"'];
  return `${open}${name}${close}`;
}

// ─── Columnas ────────────────────────────────────────────────────────────────

/**
 * La COLUMNA de un campo persistido, como datos: nombre, nulabilidad, tipo lógico y cotas. Es lo
 * único de un campo que llega al DDL, y cada cota que se pierde aquí es una garantía del diseño que
 * la base deja de dar sin que falle nada (una `scale: 4` que sale `numeric(38,2)`, un `maxLength`
 * que sale `varchar(255)`).
 *
 *   · `long: true`   texto largo —`text` y `json`—: un documento real desborda cualquier varchar.
 *   · `length`       la cota del texto acotado. Con collation forzada y sin cota declarada se
 *                    conserva 255, el ancho por defecto de los ORM: la collation no es excusa para
 *                    estrechar una columna que nadie acotó.
 *   · `collation`    solo en una columna de constraint ÚNICA, y solo en el motor que pliega
 *                    mayúsculas por defecto (`caseSensitiveCollationFor`): la unicidad de un texto
 *                    no significa lo mismo en todos los motores y el diseño no puede decir cuál
 *                    quiere, así que se fuerza la sensible.
 *   · `precision/scale` de un decimal con escala declarada (`DECIMAL_PRECISION` es del contrato).
 *   · `enum`         se guarda por el NOMBRE de la constante, nunca por su ordinal.
 *
 * No hay `unique` de columna, a propósito: toda unicidad lleva una constraint NOMBRADA
 * (`uniqueConstraints`), y una segunda sin nombre haría que el motor rechazara por esa y el error
 * declarado del diseño no se encontrara.
 */
export function columnSpec(fieldName, field, resolved, { collation = null } = {}) {
  const constraints = { ...resolved.constraints, ...(field.constraints ?? {}) };
  const textual = isTextual(resolved);
  const long = resolved.base === 'text' || resolved.base === 'json';
  const collated = Boolean(collation) && (textual || resolved.base === 'text');
  let length = null;
  if (!long) {
    if (collated) length = constraints.maxLength ?? 255;
    else if (constraints.maxLength != null && textual) length = constraints.maxLength;
  }
  const decimalScale = resolved.base === 'decimal' && constraints.scale != null ? constraints.scale : null;
  return {
    name: snakeCase(fieldName),
    nullable: !(field.required || field.id),
    updatable: !field.id,
    kind: resolved.kind === 'enum' || field.type === 'enum' ? 'enum' : resolved.kind,
    base: resolved.base ?? null,
    textual,
    long,
    length,
    scale: decimalScale,
    collation: collated ? collation : null,
    enum: resolved.kind === 'enum' || field.type === 'enum'
  };
}

/**
 * La SOMBRA plegada de un campo de texto con `compare: ignore-case | ignore-case-accents` (DSL
 * 2.14): una columna con el valor sin mayúsculas —y sin acentos, si lo pide— que el adaptador
 * estampa al guardar. Es donde vive la unicidad del campo y contra la que se filtra.
 *
 * Una sombra y no una collation insensible porque la collation cambia con el motor y no existe en
 * todos; la sombra es la misma en los dos modelos y en los seis motores. El campo original conserva
 * el valor tal como llegó, que es el que se devuelve.
 */
export function foldedShadow(field) {
  if (!field?.fold) return null;
  const name = field.fold.shadow;
  return {
    name,
    source: field.name,
    column: snakeCase(name),
    accents: field.fold.accents,
    required: Boolean(field.required),
    maxLength: field.fold.maxLength
  };
}

/** La columna del bloqueo optimista que build pone en toda raíz que lo use. */
export const LOCK_VERSION = { field: 'lockVersion', column: 'lock_version' };

/** Las columnas de la auditoría que la política `all` pone sin que el dominio las nombre. */
export const AUDIT_COLUMNS = {
  timestamps: [
    { field: 'createdAt', column: 'created_at', updatable: false, role: 'createdDate' },
    { field: 'updatedAt', column: 'updated_at', updatable: true, role: 'lastModifiedDate' }
  ],
  authorship: [
    { field: 'createdBy', column: 'created_by', updatable: false, role: 'createdBy' },
    { field: 'updatedBy', column: 'updated_by', updatable: true, role: 'lastModifiedBy' }
  ]
};

/**
 * La base de auditoría solo existe si algún eje de `persistence.audit` vale `all`: es la política
 * que pone columnas que el dominio no nombra. Con `declared` los campos son del diseño y se marcan
 * en su propia entidad; con `none` no hay nada que heredar.
 */
export function usesAuditableEntity(model) {
  return model.audit?.timestamps === 'all' || model.audit?.authorship === 'all';
}

// ─── Miembros persistidos ────────────────────────────────────────────────────

/**
 * Los miembros persistidos de una entidad, la MISMA lectura para los dos modelos de persistencia
 * (relacional y documental) y para los dos generadores:
 *   · scalar             campo directo (incluye enums), con su sombra plegada si la tiene;
 *   · vo                 value object compuesto, aplanado a columnas con prefijo (`subs[]`);
 *   · externalRef        la referencia a OTRO agregado: una columna `<relación>_id` sin asociación;
 *   · relationOne/Many   entidad hija del mismo agregado;
 *   · elementCollection  colección de valores sin identidad (`list` del DSL): tabla de elementos.
 *
 * Los nombres de columna salen CRUDOS: citarlos es del que escribe la anotación o el decorador.
 */
export function persistedMembers(model, entity) {
  const members = [];
  for (const field of entity.fields) {
    if (field.list) {
      members.push({
        kind: 'elementCollection',
        field,
        name: field.name,
        element: { kind: field.kind === 'composite' ? 'vo' : field.kind }
      });
    } else if (field.kind === 'composite') {
      const vo = model.valueObjects.find((v) => v.name === field.namedType);
      members.push({
        kind: 'vo',
        field,
        vo,
        name: field.name,
        subs: (vo?.fields ?? []).map((sub) => ({
          name: `${field.name}${capitalize(sub.name)}`,
          voAccessor: sub.name,
          sub,
          subKind: sub.kind,
          column: `${snakeCase(field.name)}_${snakeCase(sub.name)}`,
          // Un value object que el diseño no exige no puede dejar columnas NOT NULL: la fila sin
          // ese importe dejaría de poder insertarse.
          ownerRequired: Boolean(field.required)
        }))
      });
    } else {
      members.push({ kind: 'scalar', field, name: field.name, folded: foldedShadow(field) });
    }
  }
  for (const relation of entity.relations) {
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, column: `${snakeCase(relation.name)}_id` });
    } else {
      members.push({ kind: toMany ? 'relationMany' : 'relationOne', relation, name: relation.name });
    }
  }
  return members;
}

/** La tabla de elementos de una colección (`list: true`): nombre, FK a la raíz y columna de orden. */
export function elementTable(entity, member) {
  const table = `${snakeCase(entity.name)}_${snakeCase(member.name)}`;
  const joinColumn = `${snakeCase(entity.name)}_id`;
  return {
    table,
    joinColumn,
    // El ORDEN es parte del valor: el dominio la modela como lista, y sin columna de orden el
    // motor la devuelve como una bolsa.
    orderColumn: `${snakeCase(member.name)}_order`,
    valueColumn: snakeCase(member.name),
    foreignKey: foreignKeyName(table, entity.name),
    foreignKeyIndex: foreignKeyIndexName(table, joinColumn)
  };
}

/** La columna FK que una relación interna a-uno pone en la tabla dueña: `<relación>_id`. */
export function joinColumnOf(relation) {
  return `${snakeCase(relation.name)}_id`;
}

/** La columna FK que un one-to-many UNIDIRECCIONAL pone en la tabla de la hija: `<padre>_id`. */
export function parentColumnOf(parentName) {
  return `${snakeCase(parentName)}_id`;
}

// ─── Orden, back-references y agregados ──────────────────────────────────────

// Campos por los que una colección hija tiene un orden PROPIO del diseño: un número de posición
// explícito. Cuando el dominio expone `position`, el orden es contrato observable, y una colección
// sin orden explícito la entrega en el orden que decida la base de datos.
const ORDERING_FIELDS = ['position', 'order', 'sortOrder', 'sequence'];
const ORDERING_KINDS = new Set(['int', 'integer', 'long', 'short', 'number', 'decimal']);

/** Campo de orden explícito de la entidad hija, o null si no lo declara. */
export function orderingFieldOf(model, entityName) {
  const child = model.entities.find((e) => e.name === entityName);
  if (!child) return null;
  return (
    child.fields.find(
      (field) => !field.list && ORDERING_FIELDS.includes(field.name) && (!field.base || ORDERING_KINDS.has(field.base))
    ) ?? null
  );
}

/**
 * Nombre de la relación con la que `childName` apunta de vuelta a `parentName` (back-reference
 * declarada en el diseño), o null si la relación es unidireccional. Con ella, la hija es dueña de
 * la FK; sin ella, la FK la pone el padre en la tabla de la hija.
 */
export function backReferenceTo(model, childName, parentName) {
  const child = model.entities.find((e) => e.name === childName);
  return child?.relations.find((rel) => rel.backReference && rel.entity === parentName)?.name ?? null;
}

/** La raíz y sus entidades internas (transitivo), en orden de descubrimiento. */
export function collectInternalEntities(model, root) {
  const involved = [];
  const visit = (entity) => {
    if (!entity || involved.includes(entity)) return;
    involved.push(entity);
    for (const relation of entity.relations) {
      if (relation.internal) visit(model.entities.find((e) => e.name === relation.entity));
    }
  };
  visit(root);
  return involved;
}

/**
 * Tamaño del lote de carga de colecciones: 50, o el tope de página del diseño si es mayor. Con un
 * lote por debajo del tope de página el coste vuelve a crecer con el tamaño de la página, que es
 * justo lo que el lote existe para evitar.
 */
export function collectionBatchSize(model) {
  return Math.max(50, Number(model.pagination?.maxSize ?? 0) || 0);
}

/** El nombre REAL de la tabla de una entidad (el pluralizado del modelo, no el snake del nombre). */
export function tableOf(model, entityName) {
  const found = (model.entities ?? []).find((candidate) => candidate.name === entityName);
  return found?.tableName ?? snakeCase(entityName);
}

// ─── Unicidad e índices ──────────────────────────────────────────────────────

/**
 * Campos que llevan constraint única propia: los `unique` del diseño, salvo el id (ya es clave
 * primaria), los value objects compuestos (no son una sola columna) y el que la clave natural ya
 * cubre por sí sola.
 */
export function uniqueFields(entity) {
  const naturalKeyAlone = entity.naturalKey?.length === 1 ? entity.naturalKey[0] : null;
  return entity.fields.filter(
    (field) => field.unique && !field.isId && field.kind !== 'composite' && field.name !== naturalKeyAlone
  );
}

/**
 * Nombre de un índice, y es un CONTRATO: lo comparten la entidad relacional, el índice documental,
 * el apéndice SQL de los índices condicionados y el traductor de errores, que mapea una violación
 * POR NOMBRE al error declarado. El prefijo lo decide la unicidad: `uk_` es el que se busca.
 */
export function indexName(entity, index) {
  const suffix = index.fields.map((field) => snakeCase(field.split('.').join('_'))).join('_');
  return `${index.unique ? 'uk' : 'idx'}_${entity.tableName ?? entity.collectionName}_${suffix}`;
}

/**
 * Nombre de una FOREIGN KEY, contrato por la misma razón que `indexName`. Sin él, el ORM la
 * nombra con un hash de tabla y columnas: ninguna traducción de error casa con él y el nombre
 * cambia al renombrar una columna, así que dos exportaciones del baseline difieren en constraints
 * que nadie tocó.
 */
export function foreignKeyName(table, reference) {
  return `fk_${table}_${snakeCase(String(reference))}`;
}

/** Nombre del índice que build pone a una columna FK. Prefijo `ix_`, el de los índices del framework. */
export function foreignKeyIndexName(table, fkColumn) {
  return `ix_${table}_${fkColumn}`;
}

/** Índices únicos condicionados: los que ninguna constraint de columnas expresa. */
export function partialUniqueIndexes(entity) {
  return (entity.indexes ?? []).filter((index) => index.unique && index.when);
}

/**
 * El valor con el que la CONDICIÓN de un índice se compara en el almacén, que no siempre es el que
 * escribió el diseño: un enum se guarda por la CONSTANTE (`ACTIVE`) mientras el diseño, el JSON y el
 * OpenAPI hablan del literal (`active`). Emitir el literal produce un índice que se crea sin error y
 * no casa con ninguna fila. Lo que no es enum se devuelve intacto.
 */
export function storedWhenValue(model, entity, when) {
  if (!when) return when;
  // Solo un campo directo puede ser enum; un dot-path apunta a un value object o a una hija.
  const field = (entity.fields ?? []).find((candidate) => candidate.name === when.field);
  if (field?.kind !== 'enum') return when.equals;
  if (!field.namedType) return when.equals;
  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === field.namedType);
  const value = enumDef?.values?.find((candidate) => candidate.literal === when.equals);
  // Sin correspondencia se devuelve el literal: el diseño declara un valor que no existe en el
  // enum, y eso lo caza `crossrefs` como error de validación.
  return value?.constant ?? when.equals;
}

/**
 * Las FK entre AGREGADOS. Una referencia a otra raíz es una columna plana SIN asociación —una
 * asociación navegable entre raíces rompe la frontera del agregado—, así que su integridad
 * referencial no la conoce el ORM: la emite build con nombre estable para que el baseline la
 * lleve y la violación se pueda traducir al error declarado.
 */
export function crossAggregateForeignKeys(model) {
  const byName = new Map(model.entities.map((entity) => [entity.name, entity]));
  const fks = [];
  for (const entity of model.entities.filter((candidate) => candidate.persisted)) {
    for (const member of persistedMembers(model, entity).filter((m) => m.kind === 'externalRef')) {
      const target = byName.get(member.relation.entity);
      // Sin entidad persistida al otro lado no hay tabla que referenciar (CHK-PERSIST-ROOT-UNMAPPED).
      if (!target?.persisted) continue;
      const table = entity.tableName;
      fks.push({
        name: foreignKeyName(table, member.relation.name),
        table,
        column: `${snakeCase(member.relation.name)}_id`,
        refEntity: target.name,
        refTable: target.tableName,
        refColumn: snakeCase(target.idField?.name ?? 'id')
      });
    }
  }
  return fks.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Nombre de constraint → entidad y campos que la originan, con el error que el diseño declara. Los
 * nombres son los MISMOS en los dos modelos de persistencia: el traductor de errores los encuentra
 * dentro del mensaje del motor o del driver.
 */
export function uniqueConstraints(model) {
  const entries = [];
  for (const entity of model.entities.filter((e) => e.persisted)) {
    if (entity.naturalKey?.length > 0) {
      entries.push({
        constraint: `uk_${entity.tableName}_natural`,
        entity: entity.name,
        fields: entity.naturalKey,
        error: entity.naturalKeyError ?? null
      });
    }
    for (const field of uniqueFields(entity)) {
      entries.push({
        constraint: `uk_${entity.tableName}_${snakeCase(field.name)}`,
        entity: entity.name,
        fields: [field.name]
      });
    }
    // Los índices únicos del diseño, condicionados o no: su violación llega igual que la de una
    // constraint de tabla, y sin esta entrada el error declarado se degradaría a uno genérico.
    for (const index of (entity.indexes ?? []).filter((i) => i.unique)) {
      entries.push({
        constraint: indexName(entity, index),
        entity: entity.name,
        fields: index.fields,
        when: index.when ?? null,
        description: index.description ?? null,
        error: index.error ?? null
      });
    }
  }
  return entries;
}

/**
 * Nombre real de columna de un nombre lógico del diseño (campo, relación o value object). Un índice
 * declarado sobre la relación `parent` tiene que ir a `parent_id`. Una relación se admite por su
 * nombre o con el sufijo del id, indistintamente. Si no lo resuelve, avisa y usa el nombre tal cual.
 */
export function columnsFor(model, entity, members, logicalName, warnings) {
  const [head, ...rest] = String(logicalName).split('.');
  const member = members.find(
    (m) => m.name === head || m.relation?.name === head || (m.relation && `${m.relation.name}Id` === head)
  );

  if (member?.kind === 'scalar') return [snakeCase(member.name)];
  if (member?.kind === 'externalRef' || member?.kind === 'relationOne') {
    return [`${snakeCase(member.relation.name)}_id`];
  }
  if (member?.kind === 'vo') {
    // vo.sub → una columna; el vo entero → todas sus columnas aplanadas.
    if (rest.length > 0) {
      const sub = member.subs.find((s) => s.voAccessor === rest[0]);
      if (sub) return [rawColumn(sub.column)];
    } else if (member.subs.length > 0) {
      return member.subs.map((sub) => rawColumn(sub.column));
    }
  }

  warnings?.push(
    `persistence.entities.${entity.name}: el índice declara "${logicalName}", que no es un campo ni una relación de la entidad; se usa "${snakeCase(head)}" tal cual y el índice puede no crearse.`
  );
  return [snakeCase(head)];
}

// Una columna que un generador ya citó para su ORM (keel-spring envuelve en backticks las
// reservadas) vuelve aquí a su nombre crudo.
function rawColumn(column) {
  return String(column).replace(/`/g, '');
}

/**
 * Índices declarados sobre un campo de COLECCIÓN, agrupados por el miembro al que pertenecen. No
 * caben en la tabla de la entidad —una lista vive en su tabla hija— pero sí en la hija, que la
 * genera build entera. Se quedan fuera el compuesto que mezcla la lista con columnas del padre y el
 * elemento value object, cuyas columnas son varias.
 */
export function collectionIndexesOf(entity, members) {
  const byMember = new Map();
  const handled = new Set();
  for (const index of entity.indexes ?? []) {
    if (index.when || index.fields.length !== 1) continue;
    const member = members.find((m) => m.kind === 'elementCollection' && m.name === index.fields[0]);
    if (!member || member.element.kind === 'vo') continue;
    byMember.set(member.name, [...(byMember.get(member.name) ?? []), index]);
    handled.add(index);
  }
  return { byMember, handled };
}

/**
 * Las columnas FK de la tabla de esta entidad que necesitan un índice propio. PostgreSQL, SQL
 * Server y Oracle NO indexan una FK por su cuenta: sin él, cargar las hijas de una página y borrar
 * el padre recorren la tabla hija entera, y ningún escenario lo ve.
 *
 * Las tres FK de este modelo: `<relación>_id` de un many-to-one, `<padre>_id` que un one-to-many
 * UNIDIRECCIONAL pone en esta tabla y `<relación>_id` de una referencia a otro agregado. Se omite la
 * columna que ya ENCABEZA otro índice o constraint única de la tabla.
 */
export function foreignKeyIndexColumns(model, entity, members = persistedMembers(model, entity)) {
  const candidates = crossAggregateForeignKeys(model)
    .filter((fk) => fk.table === entity.tableName)
    .map((fk) => fk.column);
  for (const member of members) {
    if (member.kind === 'relationOne' && member.relation.cardinality === 'many-to-one') {
      candidates.push(`${snakeCase(member.relation.name)}_id`);
    }
  }
  for (const parent of model.entities ?? []) {
    if (!parent.persisted) continue;
    for (const relation of parent.relations ?? []) {
      if (!relation.internal || relation.cardinality !== 'one-to-many' || relation.entity !== entity.name) continue;
      if (backReferenceTo(model, entity.name, parent.name)) continue;
      candidates.push(`${snakeCase(parent.name)}_id`);
    }
  }

  const leading = new Set();
  const lead = (columns) => columns.length > 0 && leading.add(columns[0]);
  if (entity.naturalKey?.length > 0) {
    lead(entity.naturalKey.flatMap((f) => columnsFor(model, entity, members, f)));
  }
  for (const field of uniqueFields(entity)) lead([snakeCase(field.name)]);
  for (const index of entity.indexes ?? []) {
    // Un índice condicionado solo cubre las filas de su condición: no sirve para la FK.
    if (index.when) continue;
    const probe = [];
    const columns = index.fields.flatMap((f) => columnsFor(model, entity, members, f, probe));
    if (probe.length === 0) lead(columns);
  }

  return [...new Set(candidates)].filter((candidate) => !leading.has(candidate));
}

function capitalize(name) {
  return name[0].toUpperCase() + name.slice(1);
}

// ─── Unicidad condicionada al estado ─────────────────────────────────────────

/** Un valor como literal SQL (texto entre comillas simples, booleano, número). */
export function sqlLiteral(value) {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * La columna generada que discrimina un índice condicionado en el motor que no tiene índices
 * parciales (MySQL): vale 1 dentro de la condición y NULL fuera, y un índice único no restringe las
 * filas con NULL. Cuelga del nombre del índice, que ya es único por tabla.
 */
export const discriminatorColumn = (spec) => `${spec.name}_flag`;

/**
 * Los índices únicos condicionados del diseño (`indexes` con `when`), ya resueltos a tabla, columnas y
 * PREDICADO en el idioma del motor: «como mucho uno activo por clave» no es una unicidad de columnas,
 * y ningún ORM la expresa sin el predicado. El valor comparado es el ALMACENADO (`storedWhenValue`): un
 * enum se guarda por su constante, y un predicado con el literal del diseño crea un índice que no casa
 * con ninguna fila — el invariante se queda sin efecto y no lo delata nada.
 */
export function partialIndexSpecs(model, dialect = model.stack?.database) {
  const specs = [];
  // Este SQL va DIRECTO al motor: el quoting es el del dialecto, no el de ningún ORM.
  const quote = (name) => quoteIdentifierFor(dialect, name);
  for (const entity of model.entities.filter((e) => e.persisted)) {
    const members = persistedMembers(model, entity);
    for (const index of partialUniqueIndexes(entity)) {
      const columnList = index.fields.flatMap((field) => columnsFor(model, entity, members, field, model.warnings)).map(quote);
      const [whenColumn] = columnsFor(model, entity, members, index.when.field, model.warnings);
      const stored = storedWhenValue(model, entity, index.when);
      specs.push({
        entity: entity.name,
        name: indexName(entity, index),
        table: quote(entity.tableName),
        // El nombre CRUDO, además del citado: `information_schema` guarda el identificador.
        tableName: entity.tableName,
        columns: columnList.join(', '),
        columnList,
        whenColumn: quote(whenColumn),
        predicate: `${quote(whenColumn)} = ${sqlLiteral(stored)}`,
        // Junto al literal del diseño, para que la prosa pueda decir los dos cuando difieren.
        stored,
        fields: index.fields,
        when: index.when
      });
    }
  }
  return specs;
}

/**
 * Las operaciones que RELEVAN en un índice único condicionado: en el mismo acto sacan una fila del
 * estado condicionado y meten otra (el diseño declara las dos transiciones juntas). El índice se
 * comprueba por FILA y no se puede diferir, así que la salida tiene que llegar a la base ANTES que la
 * entrada; quien no lo ordena muere con el error de unicidad en el camino feliz. Cómo se ordena es de
 * cada generador; quién lo necesita, del diseño.
 */
export function relievingOperations(model) {
  const entities = model.entities.filter((entity) => entity.persisted && partialUniqueIndexes(entity).length > 0);
  const out = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      for (const entity of entities) {
        const states = new Set(partialUniqueIndexes(entity).map((index) => index.when.equals));
        const own = (operation.transitions ?? []).filter((t) => t.entity === entity.name);
        const occupies = own.filter((t) => states.has(t.to));
        const vacates = own.filter((t) => (t.from ?? []).some((from) => states.has(from)));
        if (occupies.length > 0 && vacates.length > 0) out.push({ operation, entity, state: occupies[0].to });
      }
    }
  }
  return out;
}
