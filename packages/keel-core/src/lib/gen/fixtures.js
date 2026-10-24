// `infra/fixtures.sql`: el estado de partida de los escenarios (`specs/<servicio>/fixtures.yaml`), como INSERT del motor
// elegido sobre el esquema que emiten los TRES generadores. Neutral: las tablas, las columnas y cómo se guarda un enum
// salen de lo mismo que ya comparten (`relational.js` y el modelo), así que el archivo es el mismo para keel-spring,
// keel-nest y keel-dotnet. Lo carga `infra/reset-db.sh` después de vaciar, y la paridad de keel-recover, que lo lee del
// proyecto generado en vez de traducir los registros por su cuenta: una sola traducción, dos lectores.
//
// Además de los campos del diseño, cada fila lleva lo que build pone sin que el dominio lo nombre: la versión del
// bloqueo optimista a 0 (con null, Spring Data tomaría la fila por NUEVA y el primer guardado sería un INSERT
// duplicado) y la auditoría de la política `all` (autor `system`, como el actor de una escritura sin llamante, y la
// hora de la carga).
//
// Lo que todavía no carga, con su motivo: colecciones de valores (`list`) e hijas internas de un agregado (sus filas
// viven en otras tablas con la FK al padre), y el modelo documental. Se rechazan en vez de cargarse a medias.

import { persistedMembers, quoteIdentifierFor, tableOf, AUDIT_COLUMNS, LOCK_VERSION } from './relational.js';
import { snakeCase } from './naming.js';

/** Por qué no se pueden cargar estas fixtures en este proyecto, o null. */
export function fixturesUnsupported(model, doc) {
  if (!doc) return null;
  if (model.persistenceKind === 'document') return 'fixtures.yaml todavía no se carga en un diseño documental (MongoDB): sin un legacy documental que lo necesite, no hay forma medida que generar';
  for (const [name, block] of Object.entries(doc.entities ?? {})) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === name);
    if (!entity) return `fixtures.yaml: ${name} no es una entidad del modelo`;
    if (entity.internalOf) return `fixtures.yaml: ${name} es una entidad interna del agregado ${entity.rootEntity ?? entity.internalOf}; sus filas todavía no se cargan`;
    const lists = entity.fields.filter((field) => field.list).map((field) => field.name);
    const used = lists.find((list) => (block.records ?? []).some((record) => list in record));
    if (used) return `fixtures.yaml: ${name}.${used} es una colección de valores (list); todavía no se carga`;
  }
  return null;
}

const isToMany = (relation) => relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';

/** La fecha como literal sin zona, en UTC: la entienden PostgreSQL (timestamp y timestamptz) y MySQL (datetime). */
function timestampLiteral(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`fixtures.yaml: ${JSON.stringify(value)} no es una fecha`);
  return `'${date.toISOString().replace('T', ' ').replace('Z', '')}'`;
}

function literal(value, { kind, base }, enumDef, uuidLiteral) {
  if (value === null || value === undefined) return 'NULL';
  if (kind === 'enum') {
    // Se guarda por su CONSTANTE (como el @Enumerated(STRING) de keel-spring y sus gemelos): el literal del cable es otro.
    const constant = enumDef?.values?.find((candidate) => candidate.literal === value)?.constant ?? value;
    return `'${String(constant).replace(/'/g, "''")}'`;
  }
  if (base === 'timestamp' || base === 'date' || base === 'datetime' || base === 'instant') return timestampLiteral(value);
  if (base === 'uuid') return `${uuidLiteral?.prefix ?? "'"}${value}${uuidLiteral?.suffix ?? "'"}`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function fold(value, accents) {
  if (typeof value !== 'string') return value;
  const lower = value.toLowerCase();
  return accents ? lower.normalize('NFD').replace(/[̀-ͯ]/g, '') : lower;
}

/** Las columnas y valores de un registro, en el orden de los miembros persistidos. */
function rowOf(model, entity, record, dialect, uuidLiteral) {
  const columns = [];
  const values = [];
  const put = (column, value) => {
    columns.push(quoteIdentifierFor(dialect, column));
    values.push(value);
  };
  const enumOf = (field) => (field.kind === 'enum' ? (model.enums ?? []).find((candidate) => candidate.name === field.namedType) : null);
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      if (!(member.name in record)) continue;
      const field = member.field;
      put(snakeCase(member.name), literal(record[member.name], field, enumOf(field), uuidLiteral));
      if (member.folded) put(member.folded.column, literal(fold(record[member.name], member.folded.accents), { kind: 'base', base: 'string' }, null, null));
      // La sombra de rango: la posición del valor en su enum, que es por lo que se ordena (relational.js, `rankShadow`).
      if (member.ranked) {
        const position = (enumOf(field)?.values ?? []).findIndex((value) => value.literal === record[member.name]);
        put(member.ranked.column, record[member.name] == null || position < 0 ? 'NULL' : String(position));
      }
    } else if (member.kind === 'vo') {
      const value = record[member.name];
      if (!value) continue;
      for (const sub of member.subs) {
        if (sub.voAccessor in value) put(sub.column, literal(value[sub.voAccessor], sub.sub, null, uuidLiteral));
      }
    } else if (member.kind === 'externalRef' || member.kind === 'relationOne') {
      if (isToMany(member.relation) || !(member.relation.name in record)) continue;
      const target = (model.entities ?? []).find((candidate) => candidate.name === member.relation.entity);
      put(`${snakeCase(member.relation.name)}_id`, literal(record[member.relation.name], target?.idField ?? {}, null, uuidLiteral));
    }
  }
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) put(LOCK_VERSION.column, '0');
  if (entity.auditTimestamps === 'all') for (const column of AUDIT_COLUMNS.timestamps) put(column.column, 'CURRENT_TIMESTAMP');
  if (entity.auditAuthorship === 'all') for (const column of AUDIT_COLUMNS.authorship) put(column.column, "'system'");
  return { columns, values };
}

/** Las entidades en un orden en que toda FK apunta a una fila ya cargada. */
function loadOrder(model, doc) {
  const names = Object.keys(doc.entities ?? {}).sort();
  const deps = new Map(
    names.map((name) => {
      const entity = model.entities.find((candidate) => candidate.name === name);
      const targets = (entity?.relations ?? []).filter((r) => !isToMany(r) && r.entity !== name && names.includes(r.entity)).map((r) => r.entity);
      return [name, new Set(targets)];
    })
  );
  const order = [];
  const visiting = new Set();
  const visit = (name) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) throw new Error(`fixtures.yaml: las relaciones entre ${[...visiting].join(', ')} forman un ciclo; no hay orden de carga sin desactivar las FK`);
    visiting.add(name);
    for (const dep of [...deps.get(name)].sort()) visit(dep);
    visiting.delete(name);
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

/**
 * El SQL de las fixtures para el motor del stack (`dialect` es la clave de DATABASES), o null si no hay fixtures.
 * Lanza si no se pueden cargar (`fixturesUnsupported`): ningún camino genera una carga a medias.
 */
export function fixturesSql(model, doc, { dialect, uuidLiteral = null, source = 'specs/fixtures.yaml' } = {}) {
  if (!doc || Object.keys(doc.entities ?? {}).length === 0) return null;
  const unsupported = fixturesUnsupported(model, doc);
  if (unsupported) throw new Error(unsupported);
  const lines = [
    `-- fixtures.sql — el estado de partida de los escenarios de ${model.service.name}, desde ${source}.`,
    '-- Lo genera build y lo carga infra/reset-db.sh tras vaciar los datos (y la paridad de keel-recover). No se edita:',
    '-- se cambia fixtures.yaml en el diseño y se vuelve a generar.'
  ];
  for (const name of loadOrder(model, doc)) {
    const entity = model.entities.find((candidate) => candidate.name === name);
    const records = doc.entities[name].records ?? [];
    if (records.length === 0) continue;
    lines.push('', `-- ${name} (${records.length})`);
    for (const record of records) {
      const { columns, values } = rowOf(model, entity, record, dialect, uuidLiteral);
      lines.push(`INSERT INTO ${quoteIdentifierFor(dialect, tableOf(model, name))} (${columns.join(', ')}) VALUES (${values.join(', ')});`);
    }
  }
  return `${lines.join('\n')}\n`;
}
