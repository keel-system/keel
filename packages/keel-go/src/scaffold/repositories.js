// La persistencia hexagonal de cada raíz de agregado, el mismo reparto que los otros tres generadores:
//   · el PUERTO `<Raíz>Repository` en el dominio (`internal/domain/<raíz>_repository.go`), que solo nombra el dominio,
//     la página y el contexto;
//   · el ADAPTADOR en `internal/infrastructure/<motor>` (`postgres` o `mysql`), con el SQL escrito por build y el mapeo fila ↔ dominio campo a
//     campo (`Rehydrate<E>` para leer, los accesores para escribir): sin ORM y sin reflexión, como pide el § 3.4.
//
// Tres decisiones que no son obvias:
//   · un finder devuelve `(*E, bool, error)`: «no está» no es un error del adaptador sino una respuesta, y el caso de uso
//     decide qué `code` del diseño significa (`domain.Errorf(domain.ErrProductNotFound, …)`), como el Optional de Spring
//     Data. Nunca `nil, nil`;
//   · guardar es FUSIONAR, como el merge de Hibernate: la raíz con su versión (`UPDATE … WHERE lock_version = $leída`, y
//     cero filas es otra escritura que ganó: 409), las hijas que ya no están se borran y las que están se insertan o
//     actualizan por su id, y una lista de valores se reescribe entera (la @ElementCollection de JPA hace lo mismo). Lo
//     guardado se RELEE en la misma transacción: la versión, la auditoría y lo que el motor completó salen de la base;
//   · las hijas y las listas se cargan con UNA consulta por tabla para todas las raíces leídas (`= ANY($1)`), nunca una
//     por raíz: una página de veinte productos son tantas consultas como tablas tenga el agregado, no veinte veces más.
//     Y siempre después de cerrar la consulta anterior: en una transacción la conexión es una sola.

import { inverseFindersOf } from '@keel-system/keel-core/gen/inverse-collections';
import { idBatchReason } from '@keel-system/keel-core/gen/ref-targets';
import {
  AUDIT_COLUMNS,
  LOCK_VERSION,
  backReferenceTo,
  elementTable,
  joinColumnOf,
  keyShadow,
  naturalKeyBatchReason,
  parentColumnOf,
  partialUniqueIndexes,
  persistedMembers,
  uniqueFields
} from '@keel-system/keel-core/gen';
import { SYSTEM_ACTOR } from '@keel-system/keel-core/gen/relational';
import { isPaginated, repositoryRoots, usesRelational } from '@keel-system/keel-core/gen/features';
import { enumConstant, goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { sqlDialect, storeDir } from '../lib/relational-engine.js';
import { isDeclaredLockVersion } from './entities.js';
import { physicalType } from './persistence.js';
import { adapterFinderMethods, entityFinders, filtersBlocks, filtersUses, portFinderMethods, filterStructs } from './finders.js';
import { docComment, domainPath, goFileName, layout, localName, packageFile } from './render.js';
import { emitsEvents, usesGoOutbox } from './messaging.js';

// Un identificador en el SQL del adaptador, citado como en el baseline si es una palabra reservada (`"primary"` en
// PostgreSQL, `` `primary` `` en MySQL).
const sq = (model, name) => sqlDialect(model).quote(name);

// El parámetro n (1-based) del SQL del motor: `$n` en PostgreSQL, `?` en MySQL.
const ph = (model, n) => sqlDialect(model).param(n);

export function generate(model) {
  if (!usesRelational(model)) return [];
  const roots = repositoryRoots(model);
  if (roots.length === 0) return [];
  const { domain, store } = layout(model);
  const files = [];
  const uses = new Set();
  for (const entity of roots) {
    files.push({ path: domainPath(model, portName(entity)), content: packageFile(model, domain, { imports: PORT_IMPORTS, body: portBody(model, entity) }) });
    files.push({
      path: `${store.dir}/${goFileName(entity.name)}_repository.go`,
      content: packageFile(model, store, { imports: ADAPTER_IMPORTS, body: adapterBody(model, entity, uses) })
    });
  }
  // Los enums que viajan a una columna: su traducción va en values.go.
  for (const file of files) {
    for (const match of file.content.matchAll(/\bparse(\w+)Column\(|\b(\w+)Column\(/g)) uses.add(`enum:${goExported(match[1] ?? match[2])}`);
  }
  files.push({ path: `${store.dir}/values.go`, content: packageFile(model, store, { imports: [...ADAPTER_IMPORTS, 'internal/platform/correlation', 'strconv'], body: valuesBody(model, uses, roots) }) });
  return files;
}

const PORT_IMPORTS = ['context', 'encoding/json/jsontext', 'time', 'github.com/google/uuid', 'internal/platform/wire'];
const ADAPTER_IMPORTS = [
  'context',
  'database/sql',
  'encoding/json/jsontext',
  'errors',
  'fmt',
  'slices',
  'strings',
  'time',
  'github.com/google/uuid',
  'internal/domain',
  'internal/platform/textfold',
  'internal/platform/wire',
  'internal/infrastructure/messaging'
];

/**
 * Los argumentos del constructor del adaptador de una raíz: las transacciones y, si la raíz emite eventos, el puente de
 * la mensajería (messaging.js). Lo usan el arranque y las sondas de db-check, que pasan `nil` (rehidratan, no emiten).
 */
export function repositoryArgs(model, entity, tx, bridge) {
  return emitsEvents(model, entity) ? `${tx}, ${bridge}` : tx;
}

/** El nombre del puerto de una raíz: `ProductRepository`. */
export function portName(entity) {
  return `${entity.name}Repository`;
}

/** El campo de `application.Dependencies` y el parámetro del handler con el repositorio de una raíz. */
export function repositoryParam(entity) {
  return localName(`${entity.name[0].toLowerCase()}${entity.name.slice(1)}Repository`);
}

// ─── Los finders ─────────────────────────────────────────────────────────────────────────────────

/**
 * Un finder por unas claves del diseño, resuelto contra los MIEMBROS persistidos: una clave que es la referencia a otro
 * agregado se busca por su columna `<relación>_id`, un value object por sus columnas aplanadas y un texto con
 * `compare: ignore-case` por su SOMBRA plegada, que es lo que la unicidad indexa. Null si una clave no tiene columna.
 */
function keyFinder(model, entity, keys) {
  if (keys.length === 0) return null;
  const members = persistedMembers(model, entity);
  const params = [];
  for (const key of keys) {
    const member = members.find((m) => m.name === key || m.relation?.name === key);
    if (!member) return null;
    if (member.kind === 'externalRef') {
      const target = model.entities.find((candidate) => candidate.name === member.relation.entity);
      const type = target?.idField?.goType ?? 'uuid.UUID';
      params.push({ name: member.name, type, where: [{ column: sq(model, member.column), arg: localName(member.name) }] });
    } else if (member.kind === 'vo') {
      const local = localName(member.name);
      params.push({
        name: member.name,
        type: `domain.${member.field.goType}`,
        where: member.subs.map((sub) => ({ column: sq(model, sub.column), arg: writeValue(sub.sub, `${local}.${goExported(sub.voAccessor)}()`, false) }))
      });
    } else if (member.kind === 'scalar') {
      const { field } = member;
      const local = localName(field.name);
      const type = field.kind === 'enum' ? `domain.${field.goType}` : field.goType;
      const shadow = keyShadow(field);
      const arg = shadow ? `${shadow.accents ? 'textfold.CaseAndAccents' : 'textfold.Case'}(${local})` : writeValue(field, local, false);
      params.push({ name: field.name, type, fold: Boolean(shadow), where: [{ column: sq(model, shadow ? shadow.column : field.columns.name), arg }] });
    } else return null;
  }
  return { name: `FindBy${params.map((p) => goExported(p.name)).join('And')}`, params };
}

/** Los finders por clave de una raíz: la clave natural, la fila que ocupa un índice condicionado y cada campo único. */
export function keyFinders(model, entity) {
  const finders = [];
  const seen = new Set();
  const add = (finder, doc) => {
    if (!finder || seen.has(finder.name)) return;
    seen.add(finder.name);
    finders.push({ ...finder, doc });
  };
  add(keyFinder(model, entity, entity.naturalKey ?? []), `el ${entity.name} por su clave natural (${(entity.naturalKey ?? []).join(', ')}).`);
  for (const index of partialUniqueIndexes(entity)) {
    if (!index.when?.field || index.when.field.includes('.')) continue;
    add(
      keyFinder(model, entity, [...index.fields, index.when.field]),
      `la fila que OCUPA el índice único condicionado sobre '${index.when.equals}': como mucho una por clave. La operación que releva la busca aquí para retirarla antes de activar la nueva.`
    );
  }
  for (const field of uniqueFields(entity)) {
    if (field.list) continue;
    add(
      keyFinder(model, entity, [field.name]),
      `el ${entity.name} que ya tiene este ${field.name}, que es único: para comprobarlo antes de un efecto que la transacción no deshace. La carrera la sigue arbitrando la constraint.`
    );
  }
  return finders;
}

// Las bases que se buscan por lote con `= ANY($1)` sobre el valor tal cual (las mismas que keel-dotnet).
const BATCHABLE = { string: 'text[]', text: 'text[]', int: 'integer[]', long: 'bigint[]' };

/** El finder por LOTE de la clave natural (`FindAllBySkuIn`), cuando keel-core dice que hace falta, o null. */
export function naturalKeyBatchFinder(model, entity) {
  if (!naturalKeyBatchReason(model, entity)) return null;
  const finder = keyFinder(model, entity, entity.naturalKey ?? []);
  if (!finder || finder.params.length !== 1) return null;
  const [param] = finder.params;
  const field = entity.fields.find((candidate) => candidate.name === param.name);
  if (!field || param.fold || field.kind === 'enum' || field.kind === 'composite' || !BATCHABLE[field.base]) return null;
  return { name: `FindAllBy${goExported(param.name)}In`, param, column: param.where[0].column, cast: BATCHABLE[field.base], plural: `${localName(param.name)}s` };
}

// ─── El puerto ───────────────────────────────────────────────────────────────────────────────────

function idOf(entity) {
  return { type: entity.idField?.goType ?? 'uuid.UUID', name: localName(entity.idField?.name ?? 'id') };
}

function portBody(model, entity) {
  const name = entity.name;
  const id = idOf(entity);
  const methods = [];
  const method = (doc, signature) => methods.push(`${docComment(signature.split('(')[0], doc, null, '\t')}\t${signature}`);
  method(`el ${name} con ese id; found es false si no existe.`, `FindByID(ctx context.Context, ${id.name} ${id.type}) (*${name}, bool, error)`);
  if (idBatchReason(model, entity)) {
    method('los agregados de varios id en UNA consulta; los que no existen no están. El orden no está garantizado.', `FindAllByID(ctx context.Context, ids []${id.type}) ([]*${name}, error)`);
  }
  for (const inverse of inverseFindersOf(model, name)) {
    const owner = model.entities.find((candidate) => candidate.name === inverse.owner);
    method(
      `los ${name} cuya relación ${inverse.relation} apunta a ese ${inverse.owner}: la colección que su respuesta lleva y que el agregado ${inverse.owner} no guarda. Una consulta, sea cual sea el número de filas.`,
      `${goExported(inverse.finder)}(ctx context.Context, ${localName(`${inverse.relation}Id`)} ${owner?.idField?.goType ?? 'uuid.UUID'}) ([]*${name}, error)`
    );
  }
  for (const finder of keyFinders(model, entity)) {
    method(`${finder.doc} found es false si no existe.`, `${finder.name}(ctx context.Context, ${finder.params.map((p) => `${localName(p.name)} ${p.type.replace(/^domain\./, '')}`).join(', ')}) (*${name}, bool, error)`);
  }
  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    method(
      `los agregados de varias ${batch.param.name} en UNA consulta; los que no existen no están. Es la lectura por lote que pide un listado: un finder por elemento serían N consultas por página.`,
      `${batch.name}(ctx context.Context, ${batch.plural} []${batch.param.type}) ([]*${name}, error)`
    );
  }
  for (const [doc, signature] of portFinderMethods(model, entity)) method(doc, signature);
  if (isPaginated(model, entity)) {
    method('una página de agregados, en el orden pedido y con el id como desempate. Una propiedad de orden que no existe es un error.', `List(ctx context.Context, pageable Pageable) (Page[*${name}], error)`);
  }
  method(
    'guarda el agregado entero (sus entidades internas y sus listas) y devuelve lo guardado, releído. Con bloqueo optimista, una versión obsoleta es el error de concurrencia del contrato.',
    `Save(ctx context.Context, ${localName(name[0].toLowerCase() + name.slice(1))} *${name}) (*${name}, error)`
  );
  method('borra el agregado entero; no hace nada si no existe.', `DeleteByID(ctx context.Context, ${id.name} ${id.type}) error`);
  const filters = filterStructs(model, entity).map((struct) => `${struct}

`).join('');
  return `
${filters}${docComment(portName(entity), `el puerto de persistencia del agregado ${name}. El dominio solo ve esto; el adaptador vive en ${storeDir(model)} y se une a la transacción que abrió el caso de uso.`)}type ${portName(entity)} interface {
${methods.join('\n\n')}
}
`;
}

// ─── Los valores: dominio ↔ columna ──────────────────────────────────────────────────────────────

/**
 * Cómo viaja un valor del dominio a una columna y de vuelta. `direct`: database/sql lo lee y lo escribe tal cual (también
 * su puntero, para lo opcional); si no, con qué tipo se lee (`scan` y su versión nula) y cómo se convierte.
 */
function codec(field) {
  // Un enum se guarda por el NOMBRE de su constante (el @Enumerated(STRING) de keel-spring), que no tiene por qué ser su
  // valor en el cable: lo traducen las funciones de values.go.
  if (field.kind === 'enum') return { scan: 'string', nullScan: 'sql.NullString', nullValue: '.String', parse: (v) => `parse${field.goType}Column(${v})`, write: (v) => `${lower(field.goType)}Column(${v})` };
  switch (field.goType) {
    case 'string':
    case 'int32':
    case 'int64':
    case 'bool':
    case 'time.Time':
    case 'uuid.UUID':
      return { direct: true };
    case 'wire.Decimal':
      return { scan: 'string', nullScan: 'sql.NullString', nullValue: '.String', parse: (v) => `wire.ParseDecimal(${v})`, write: (v) => `${v}.String()` };
    case 'wire.Date':
      return { scan: 'time.Time', nullScan: 'sql.NullTime', nullValue: '.Time', convert: (v) => `wire.DateOf(${v})`, write: (v) => `${v}.Time()` };
    case 'jsontext.Value':
      return { scan: 'string', nullScan: 'sql.NullString', nullValue: '.String', convert: (v) => `jsontext.Value(${v})`, write: (v) => `string(${v})` };
    default:
      throw new Error(`keel-go no sabe persistir el tipo ${field.goType} del campo ${field.name}`);
  }
}

/** El argumento de SQL de un valor del dominio (`expr`, de tipo T, o *T si `optional`). */
export function writeValue(field, expr, optional) {
  const c = codec(field);
  if (c.direct) return expr;
  if (!optional) return c.write(expr);
  return `nullable(${expr}, func(v ${field.kind === 'enum' ? `domain.${field.goType}` : field.goType}) any { return ${c.write('v')} })`;
}

/**
 * Leer una columna sobre `target` (una expresión asignable del tipo del dominio, T o *T): las declaraciones, el destino
 * del Scan y lo que convierte después. `column` nombra la columna en el error.
 */
function readValue(field, target, optional, column, counter) {
  const c = codec(field);
  if (c.direct) return { decls: [], dest: `&${target}`, after: [] };
  const tmp = `col${counter.next++}`;
  const value = (v) => (c.parse ? null : c.convert(v));
  if (!optional) {
    if (c.parse) {
      return {
        decls: [[tmp, c.scan]],
        dest: `&${tmp}`,
        after: [`if ${target}, err = ${c.parse(tmp)}; err != nil {\n\treturn fmt.Errorf("${column}: %w", err)\n}`]
      };
    }
    return { decls: [[tmp, c.scan]], dest: `&${tmp}`, after: [`${target} = ${value(tmp)}`] };
  }
  const inner = `${tmp}${c.nullValue}`;
  if (c.parse) {
    return {
      decls: [[tmp, c.nullScan]],
      dest: `&${tmp}`,
      after: [`if ${tmp}.Valid {\n\tv, err := ${c.parse(inner)}\n\tif err != nil {\n\t\treturn fmt.Errorf("${column}: %w", err)\n\t}\n\t${target} = &v\n}`]
    };
  }
  return { decls: [[tmp, c.nullScan]], dest: `&${tmp}`, after: [`if ${tmp}.Valid {\n\tv := ${value(inner)}\n\t${target} = &v\n}`] };
}

/** El tipo de array de PostgreSQL con el que viajan unos ids, y cómo se convierten (`= ANY($1::uuid[])`). */
function idArray(entity) {
  const field = entity.idField;
  const type = physicalType(field?.columns ?? { base: 'uuid' });
  if (field?.goType === 'uuid.UUID' || !field) return { cast: 'uuid[]', helper: 'uuidTexts' };
  if (field.goType === 'int64') return { cast: 'bigint[]', helper: null };
  if (field.goType === 'int32') return { cast: 'integer[]', helper: null };
  if (field.goType === 'string') return { cast: 'text[]', helper: null };
  throw new Error(`keel-go no sabe buscar por lote un id ${field.goType} (${type})`);
}

/**
 * Una consulta sobre un LOTE de valores: `<head>= ANY($1::tipo[])<tail>` en PostgreSQL y `<head>IN (?, …)<tail>` en
 * MySQL, que no tiene arrays (un parámetro por valor, compuesto por `inList`: nunca el valor dentro del texto). `array`
 * es el tipo de array de PostgreSQL (`idArray`). Devuelve lo que va antes de la llamada (`setup`), la expresión Go del
 * SQL y la de sus argumentos.
 */
function batchQuery(model, head, tail, values, array, uses) {
  if (sqlDialect(model).mysql) {
    uses.add('inList');
    return { setup: `in, args := inList(${values})`, sql: `${goString(`${head}IN (`)}+in+${goString(`)${tail}`)}`, args: 'args...' };
  }
  if (array.helper) uses.add(array.helper);
  return { setup: null, sql: goString(`${head}= ANY($1::${array.cast})${tail}`), args: array.helper ? `${array.helper}(${values})` : values };
}

/** El cuerpo de un finder por lote: carga las raíces cuya `column` está en `values`. */
function batchLoad(model, column, entity, values, uses, cast = null) {
  const query = batchQuery(model, `WHERE ${column} `, '', values, entity ? idArray(entity) : { cast, helper: null }, uses);
  return `${query.setup ? `\t${query.setup}\n` : ''}\treturn r.load(ctx, ${query.sql}, ${query.args})`;
}

// ─── El modelo de tabla de cada entidad ──────────────────────────────────────────────────────────

/**
 * Las columnas de la tabla de una entidad, con cómo se leen sobre su estado y cómo se escriben desde el agregado (`e`).
 * `parent` es la entidad que la contiene (null para la raíz): su id viaja en la columna FK de la hija.
 */
function tableModel(model, entity, parent) {
  const members = persistedMembers(model, entity);
  const counter = { next: 1 };
  const columns = [];
  const children = [];
  const lists = [];
  const idColumn = sq(model, entity.idField?.columns?.name ?? 'id');
  let version = null;
  for (const member of members) {
    if (member.kind === 'scalar') {
      const { field } = member;
      const method = goExported(field.name);
      const optional = !(field.required || field.isId || field.generated);
      if (isDeclaredLockVersion(entity, field)) {
        version = { column: sq(model, field.columns.name), method };
        continue;
      }
      const read = readValue(field, `state.${method}`, optional, field.columns.name, counter);
      columns.push({ column: sq(model, field.columns.name), read, write: writeValue(field, `e.${method}()`, optional), id: field.isId });
      if (member.folded) {
        const fold = member.folded.accents ? 'textfold.CaseAndAccents' : 'textfold.Case';
        columns.push({ column: sq(model, member.folded.column), write: optional ? `nullable(e.${method}(), func(v string) any { return ${fold}(v) })` : `${fold}(e.${method}())` });
      }
      if (member.ranked) {
        const enumName = member.ranked.enum ?? field.goType;
        columns.push({ column: sq(model, member.ranked.column), write: optional ? `nullable(e.${method}(), func(v domain.${enumName}) any { return ${rankFunc(enumName)}(v) })` : `${rankFunc(enumName)}(e.${method}())`, rank: enumName });
      }
    } else if (member.kind === 'vo') {
      columns.push(...voColumns(model, member, counter));
    } else if (member.kind === 'externalRef') {
      const target = model.entities.find((candidate) => candidate.name === member.relation.entity);
      const method = goExported(member.name);
      const fake = { name: member.name, goType: target?.idField?.goType ?? 'uuid.UUID', kind: 'scalar' };
      const optional = !member.relation.required;
      columns.push({ column: sq(model, member.column), read: readValue(fake, `state.${method}`, optional, member.column, counter), write: writeValue(fake, `e.${method}()`, optional) });
    } else if (member.kind === 'relationOne') {
      // La referencia de vuelta de una hija: su columna lleva el id del padre, que el dominio no modela.
      if (!member.relation.backReference) throw new Error(`${entity.name}.${member.name}: keel-go no persiste una relación interna a-uno (lo rechaza la frontera)`);
      columns.push({ column: sq(model, joinColumnOf(member.relation)), parentKey: true });
    } else if (member.kind === 'relationMany') {
      if (member.relation.cardinality === 'many-to-many') throw new Error(`${entity.name}.${member.name}: keel-go no persiste una many-to-many interna (lo rechaza la frontera)`);
      const child = model.entities.find((candidate) => candidate.name === member.relation.entity);
      children.push({ member, entity: child, method: goExported(member.name) });
    } else if (member.kind === 'elementCollection') {
      lists.push(listModel(model, entity, member));
    }
  }
  // La FK de un one-to-many UNIDIRECCIONAL la pone el padre en la tabla de la hija: el dominio no la nombra.
  if (parent && !backReferenceTo(model, entity.name, parent.name)) columns.push({ column: sq(model, parentColumnOf(parent.name)), parentKey: true });
  if (entity.usesOptimisticLocking && !entity.declaresLockVersion) version = { column: sq(model, LOCK_VERSION.column), method: 'LockVersion' };
  // La versión se LEE con el resto (el agregado la porta para el siguiente guardado) y se escribe aparte.
  if (version) columns.push({ column: version.column, read: { decls: [], dest: `&state.${version.method}`, after: [] } });
  const audit = [
    ...(entity.auditTimestamps === 'all' ? AUDIT_COLUMNS.timestamps.map((column) => ({ ...column, column: sq(model, column.column), kind: 'time' })) : []),
    ...(entity.auditAuthorship === 'all' ? AUDIT_COLUMNS.authorship.map((column) => ({ ...column, column: sq(model, column.column), kind: 'actor' })) : [])
  ];
  return { entity, table: sq(model, entity.tableName), idColumn, columns, children, lists, version, audit, decls: counter };
}

/** El nombre de la función que da el rango de un valor de enum (su posición en la declaración). */
function rankFunc(enumName) {
  return `${enumName[0].toLowerCase()}${enumName.slice(1)}Rank`;
}

/** Las columnas aplanadas de un value object: se leen por separado y se construyen con su constructor. */
function voColumns(model, member, counter) {
  const vo = member.vo;
  const optional = !member.field.required;
  const method = goExported(member.name);
  const subs = member.subs.map((sub) => {
    if (sub.subKind === 'composite' || !sub.sub.columns) throw new Error(`${vo.name}.${sub.voAccessor}: keel-go no persiste un value object anidado (lo rechaza la frontera)`);
    if (!sub.sub.required) throw new Error(`${vo.name}.${sub.voAccessor}: keel-go no persiste un campo opcional dentro de un value object`);
    return sub;
  });
  const temps = subs.map((sub) => ({ sub, tmp: `col${counter.next++}`, codec: codec(sub.sub) }));
  const decls = temps.map(({ sub, tmp, codec: c }) => [tmp, optional ? nullScanOf(sub.sub, c) : c.direct ? sub.sub.goType : c.scan]);
  // Lo que se pasa al constructor, ya convertido desde lo leído.
  const prep = [];
  const args = temps.map(({ sub, tmp, codec: c }) => {
    const raw = optional ? `${tmp}${c.direct ? directNullValue(sub.sub) : c.nullValue}` : tmp;
    if (c.direct) return raw;
    if (c.convert) return c.convert(raw);
    const local = `${tmp}Value`;
    prep.push(`${local}, err := ${c.parse(raw)}\nif err != nil {\n\treturn fmt.Errorf("${sub.column}: %w", err)\n}`);
    return local;
  });
  const build = `v, err := domain.New${vo.name}(${args.join(', ')})\nif err != nil {\n\treturn fmt.Errorf("${member.subs.map((s) => s.column).join(', ')}: %w", err)\n}`;
  const after = optional
    ? [`if ${temps.map(({ tmp }) => `${tmp}.Valid`).join(' || ')} {\n${indent([...prep, build, `state.${method} = &v`].join('\n'))}\n}`]
    : [...prep, build, `state.${method} = v`];
  const columns = temps.map(({ sub, tmp }, index) => ({
    column: sq(model, sub.column),
    read: { decls: [decls[index]], dest: `&${tmp}`, after: index === temps.length - 1 ? after : [] },
    write: optional
      ? `nullable(e.${method}(), func(v domain.${vo.name}) any { return ${writeValue(sub.sub, `v.${goExported(sub.voAccessor)}()`, false)} })`
      : writeValue(sub.sub, `e.${method}().${goExported(sub.voAccessor)}()`, false)
  }));
  return columns;
}

const DIRECT_NULL = {
  string: ['sql.NullString', '.String'],
  int32: ['sql.NullInt32', '.Int32'],
  int64: ['sql.NullInt64', '.Int64'],
  bool: ['sql.NullBool', '.Bool'],
  'time.Time': ['sql.NullTime', '.Time'],
  'uuid.UUID': ['uuid.NullUUID', '.UUID']
};

function nullScanOf(field, c) {
  return c.direct ? DIRECT_NULL[field.goType][0] : c.nullScan;
}

function directNullValue(field) {
  return DIRECT_NULL[field.goType][1];
}

/** La tabla de elementos de una lista: dueño, posición y el valor (o las columnas de su value object). */
function listModel(model, entity, member) {
  const raw = elementTable(entity, member);
  const table = { ...raw, table: sq(model, raw.table), joinColumn: sq(model, raw.joinColumn), orderColumn: sq(model, raw.orderColumn), valueColumn: raw.valueColumn && sq(model, raw.valueColumn) };
  const method = goExported(member.name);
  const counter = { next: 1 };
  if (member.element.kind === 'vo') {
    const vo = model.valueObjects.find((candidate) => candidate.name === member.field.namedType);
    const fakeMember = {
      field: { ...member.field, required: true, goType: vo.name },
      vo,
      name: member.name,
      subs: vo.fields.map((sub) => ({ voAccessor: sub.name, sub, subKind: sub.kind, column: sub.columns?.name }))
    };
    const columns = voColumns(model, fakeMember, counter).map((column) => ({
      ...column,
      read: { ...column.read, after: column.read.after.map((line) => line.replace(`state.${method} = v`, 'value = v')) },
      write: column.write.replace(`e.${method}()`, 'item')
    }));
    return { ...table, method, columns, element: `domain.${vo.name}` };
  }
  const elementField = { ...member.field, goType: member.field.goType.replace(/^\[\]/, ''), list: false };
  const element = elementField.kind === 'enum' ? `domain.${elementField.goType}` : elementField.goType;
  return {
    ...table,
    method,
    element,
    columns: [{ column: table.valueColumn, read: readValue(elementField, 'value', false, table.valueColumn, counter), write: writeValue(elementField, 'item', false) }]
  };
}

function indent(text, prefix = '\t') {
  return text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n');
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

function adapterBody(model, entity, uses) {
  const name = entity.name;
  const type = `${name}Repository`;
  const id = idOf(entity);
  const root = tableModel(model, entity, null);
  const tables = collectTables(model, root);
  const parts = [];

  const events = emitsEvents(model, entity);
  const eventsDoc = events
    ? ` Al guardar, entrega al puente de la mensajería los eventos que drena del agregado: ${usesGoOutbox(model) ? 'sus filas del outbox van en la MISMA transacción del cambio' : 'se publican DESPUÉS del commit'}.`
    : '';
  parts.push(`${docComment(type, `el adaptador de domain.${portName(entity)} sobre ${sqlDialect(model).label}: el SQL lo escribe build y el mapeo fila ↔ dominio va campo a campo, sin reflexión. Se une a la transacción que abrió el caso de uso; sin ella, cada lectura va sola y cada escritura abre la suya.${eventsDoc}`)}type ${type} struct {
${events ? '\ttx     *Transactions\n\tevents *messaging.Bridge' : '\ttx *Transactions'}
}

// New${type} construye el adaptador sobre las transacciones del servicio${events ? ' y el puente de la mensajería' : ''}.
func New${type}(${events ? 'tx *Transactions, events *messaging.Bridge' : 'tx *Transactions'}) *${type} {
	return &${type}{${events ? 'tx: tx, events: events' : 'tx: tx'}}
}

var _ domain.${portName(entity)} = (*${type})(nil)`);

  // ─── Lecturas
  const one = (method, signature, where, args) =>
    parts.push(`// ${method} implementa domain.${portName(entity)}.
func (r *${type}) ${signature} (*domain.${name}, bool, error) {
	found, err := r.load(ctx, ${goString(where)}, ${args})
	if err != nil || len(found) == 0 {
		return nil, false, err
	}
	return found[0], true, nil
}`);
  one('FindByID', `FindByID(ctx context.Context, ${id.name} ${id.type})`, `WHERE ${root.idColumn} = ${ph(model, 1)}`, id.name);
  if (idBatchReason(model, entity)) {
    parts.push(`// FindAllByID implementa domain.${portName(entity)}.
func (r *${type}) FindAllByID(ctx context.Context, ids []${id.type}) ([]*domain.${name}, error) {
	if len(ids) == 0 {
		return nil, nil
	}
${batchLoad(model, root.idColumn, entity, 'ids', uses)}
}`);
  }
  for (const inverse of inverseFindersOf(model, name)) {
    const owner = model.entities.find((candidate) => candidate.name === inverse.owner);
    const param = localName(`${inverse.relation}Id`);
    const column = persistedMembers(model, entity).find((m) => m.kind === 'externalRef' && m.relation.name === inverse.relation)?.column ?? `${inverse.relation}_id`;
    const quoted = sq(model, column);
    parts.push(`// ${goExported(inverse.finder)} implementa domain.${portName(entity)}.
func (r *${type}) ${goExported(inverse.finder)}(ctx context.Context, ${param} ${owner?.idField?.goType ?? 'uuid.UUID'}) ([]*domain.${name}, error) {
	return r.load(ctx, ${goString(`WHERE ${quoted} = ${ph(model, 1)}`)}, ${param})
}`);
  }
  for (const finder of keyFinders(model, entity)) {
    const conditions = [];
    const args = [];
    for (const param of finder.params) {
      for (const where of param.where) {
        args.push(where.arg);
        conditions.push(`${where.column} = ${ph(model, args.length)}`);
      }
    }
    one(finder.name, `${finder.name}(ctx context.Context, ${finder.params.map((p) => `${localName(p.name)} ${p.type}`).join(', ')})`, `WHERE ${conditions.join(' AND ')}`, args.join(', '));
  }
  const batch = naturalKeyBatchFinder(model, entity);
  if (batch) {
    parts.push(`// ${batch.name} implementa domain.${portName(entity)}.
func (r *${type}) ${batch.name}(ctx context.Context, ${batch.plural} []${batch.param.type}) ([]*domain.${name}, error) {
	if len(${batch.plural}) == 0 {
		return nil, nil
	}
${batchLoad(model, batch.column, null, batch.plural, uses, batch.cast)}
}`);
  }
  // El mapa de orden lo usan el listado y los finders; el List, solo una raíz paginada.
  if (isPaginated(model, entity) || entityFinders(model, entity).length > 0) parts.push(sortableMap(model, entity));
  if (isPaginated(model, entity)) parts.push(listMethod(model, entity, root, type));
  parts.push(...adapterFinderMethods(model, entity, { type, root, sortable: `${lower(name)}Sortable`, writeValue }));

  // ─── Escrituras
  parts.push(saveMethods(model, entity, root, tables, type, uses));
  parts.push(`// DeleteByID implementa domain.${portName(entity)}. Las filas de las hijas y de las listas caen con la raíz (ON DELETE CASCADE).
func (r *${type}) DeleteByID(ctx context.Context, ${id.name} ${id.type}) error {
	return r.tx.write(ctx, func(q DBTX) error {
		_, err := q.ExecContext(ctx, ${goString(`DELETE FROM ${root.table} WHERE ${root.idColumn} = ${ph(model, 1)}`)}, ${id.name})
		return err
	})
}`);

  // ─── La carga del agregado
  parts.push(loadMethod(model, root, type));
  for (const table of tables) parts.push(...tableFunctions(model, table, type, uses));
  return `\n${parts.join('\n\n')}\n`;
}

/** La raíz y sus hijas (transitivo), cada una con el modelo de su tabla y quién la contiene. */
function collectTables(model, root) {
  const tables = [root];
  const visit = (table) => {
    for (const child of table.children) {
      const childTable = tableModel(model, child.entity, table.entity);
      child.table = childTable;
      tables.push(childTable);
      visit(childTable);
    }
  };
  visit(root);
  return tables;
}

const lower = (name) => `${name[0].toLowerCase()}${name.slice(1)}`;

/** Las columnas que se leen de una tabla, en orden: las del dominio (sin la FK al padre, que va aparte). */
function readColumns(table) {
  return table.columns.filter((column) => column.read);
}

function loadMethod(model, root, type) {
  const name = root.entity.name;
  return `// load lee las raíces que casan con where y su agregado entero, y las rehidrata.
func (r *${type}) load(ctx context.Context, where string, args ...any) ([]*domain.${name}, error) {
	q, err := r.tx.conn(ctx)
	if err != nil {
		return nil, err
	}
	states, err := query${name}(ctx, q, where, args...)
	if err != nil {
		return nil, err
	}
	found := make([]*domain.${name}, 0, len(states))
	for _, state := range states {
		found = append(found, domain.Rehydrate${name}(state))
	}
	return found, nil
}`;
}

/** Leer, rellenar las hijas y las listas, y escribir: las funciones de una tabla del agregado. */
function tableFunctions(model, table, type, uses) {
  const name = table.entity.name;
  const out = [];
  const cols = readColumns(table);
  const parentKey = table.columns.find((column) => column.parentKey);
  const selected = [...(parentKey ? [parentKey.column] : []), ...cols.map((c) => c.column)];
  const decls = [];
  const dests = [];
  const after = [];
  if (parentKey) {
    decls.push(['parent', table.parentIdType]);
    dests.push('&parent');
  }
  for (const column of cols) {
    decls.push(...column.read.decls);
    dests.push(column.read.dest);
    after.push(...column.read.after);
  }
  const declBlock = decls.length > 0 ? `\tvar (\n${alignRows(decls.map(([n, t]) => ({ indent: '\t\t', cells: [n, t] }))).join('\n')}\n\t)\n` : '';
  const needsErr = after.some((line) => /, err = /.test(line));
  const returns = parentKey ? `(${table.parentIdType}, domain.${name}State, error)` : `(domain.${name}State, error)`;
  const fail = parentKey ? 'return parent, state, ' : 'return state, ';
  const scanBody = [
    `\tvar state domain.${name}State`,
    declBlock.trimEnd(),
    `\tif err := rows.Scan(${dests.join(', ')}); err != nil {\n\t\t${fail}err\n\t}`,
    after.length > 0
      ? `\terr := func() error {\n${needsErr ? '\t\tvar err error\n' : ''}${indent(after.join('\n'), '\t\t')}\n\t\treturn nil\n\t}()\n\t${fail}err`
      : `\t${fail}nil`
  ]
    .filter(Boolean)
    .join('\n');
  out.push(`// scan${name} lee una fila de ${table.table}${parentKey ? ' con el id de su padre' : ''}.
func scan${name}(rows *sql.Rows) ${returns} {
${scanBody}
}`);

  // query<E>: las filas, cerradas antes de cargar las hijas.
  const childLoads = [];
  for (const child of table.children) {
    childLoads.push(`\tbyParent${child.method}, err := query${child.entity.name}ByParent(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range states {
		states[i].${child.method} = byParent${child.method}[states[i].${goExported(table.entity.idField?.name ?? 'id')}]
	}`);
  }
  for (const list of table.lists) {
    childLoads.push(`\t${lower(list.method)}, err := load${name}${list.method}(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range states {
		states[i].${list.method} = ${lower(list.method)}[states[i].${goExported(table.entity.idField?.name ?? 'id')}]
	}`);
  }
  const idField = goExported(table.entity.idField?.name ?? 'id');
  const idType = table.entity.idField?.goType ?? 'uuid.UUID';
  const collectIds = childLoads.length > 0 ? `\tids := make([]${idType}, len(states))\n\tfor i, state := range states {\n\t\tids[i] = state.${idField}\n\t}\n${childLoads.join('\n')}\n` : '';
  if (!parentKey) {
    out.push(`// query${name} lee las filas de ${table.table} que casan con where${table.children.length + table.lists.length > 0 ? ', y después sus hijas y sus listas' : ''}.
func query${name}(ctx context.Context, q DBTX, where string, args ...any) ([]domain.${name}State, error) {
	rows, err := q.QueryContext(ctx, ${goString(`SELECT ${selected.join(', ')} FROM ${table.table} `)}+where, args...)
	if err != nil {
		return nil, translate(err)
	}
	var states []domain.${name}State
	for rows.Next() {
		state, err := scan${name}(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		states = append(states, state)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
${collectIds}	return states, nil
}`);
  } else {
    const order = sq(model, table.entity.idField?.columns?.name ?? 'id');
    const query = batchQuery(model, `SELECT ${selected.join(', ')} FROM ${table.table} WHERE ${parentKey.column} `, ` ORDER BY ${order}`, 'parents', table.parentArray, uses);
    out.push(`// query${name}ByParent lee las ${name} de varios padres en UNA consulta, agrupadas por su padre y en el orden de su id.
func query${name}ByParent(ctx context.Context, q DBTX, parents []${table.parentIdType}) (map[${table.parentIdType}][]*domain.${name}, error) {
	if len(parents) == 0 {
		return nil, nil
	}
${query.setup ? `\t${query.setup}\n` : ''}	rows, err := q.QueryContext(ctx, ${query.sql}, ${query.args})
	if err != nil {
		return nil, translate(err)
	}
	var (
		owners []${table.parentIdType}
		states []domain.${name}State
	)
	for rows.Next() {
		parent, state, err := scan${name}(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		owners = append(owners, parent)
		states = append(states, state)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
${collectIds}	byParent := make(map[${table.parentIdType}][]*domain.${name}, len(parents))
	for i, state := range states {
		byParent[owners[i]] = append(byParent[owners[i]], domain.Rehydrate${name}(state))
	}
	return byParent, nil
}`);
  }

  // Las listas de valores de esta tabla.
  for (const list of table.lists) out.push(...listFunctions(model, table, list, uses));
  // Escribir la fila.
  out.push(writeFunction(model, table, uses));
  return out;
}

function listFunctions(model, table, list, uses) {
  const name = table.entity.name;
  const idType = table.entity.idField?.goType ?? 'uuid.UUID';
  const decls = list.columns.flatMap((column) => column.read.decls);
  const declBlock = alignRows([['owner', idType], ['value', list.element], ...decls].map(([n, t]) => ({ indent: '\t\t\t\t', cells: [n, t] })));
  const after = list.columns.flatMap((column) => column.read.after);
  const needsErr = after.some((line) => /, err = /.test(line));
  const convert = after.length > 0 ? `${needsErr ? '\t\tvar err error\n' : ''}${indent(after.join('\n'), '\t\t')}\n` : '';
  const columns = list.columns.map((column) => column.column);
  const query = batchQuery(model, `SELECT ${[list.joinColumn, ...columns].join(', ')} FROM ${list.table} WHERE ${list.joinColumn} `, ` ORDER BY ${list.joinColumn}, ${list.orderColumn}`, 'owners', idArray(table.entity), uses);
  const read = `// load${name}${list.method} lee la lista ${list.method} de varios ${name} en UNA consulta, en su orden.
func load${name}${list.method}(ctx context.Context, q DBTX, owners []${idType}) (map[${idType}][]${list.element}, error) {
	if len(owners) == 0 {
		return nil, nil
	}
${query.setup ? `\t${query.setup}\n` : ''}	rows, err := q.QueryContext(ctx, ${query.sql}, ${query.args})
	if err != nil {
		return nil, translate(err)
	}
	byOwner := make(map[${idType}][]${list.element}, len(owners))
	err = func() error {
		for rows.Next() {
			var (
${declBlock.join('\n')}
			)
			if err := rows.Scan(&owner, ${list.columns.map((column) => column.read.dest).join(', ')}); err != nil {
				return err
			}
${convert ? indent(convert.replace(/\n$/, ''), '\t') + '\n' : ''}			byOwner[owner] = append(byOwner[owner], value)
		}
		return nil
	}()
	if closeErr := closeRows(rows); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	return byOwner, nil
}`;
  const placeholders = [list.joinColumn, list.orderColumn, ...columns].map((_, index) => ph(model, index + 1)).join(', ');
  const write = `// write${name}${list.method} reescribe la lista ${list.method} de un ${name} entera, en su orden.
func write${name}${list.method}(ctx context.Context, q DBTX, owner ${idType}, items []${list.element}) error {
	if _, err := q.ExecContext(ctx, ${goString(`DELETE FROM ${list.table} WHERE ${list.joinColumn} = ${ph(model, 1)}`)}, owner); err != nil {
		return err
	}
	for position, item := range items {
		if _, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${list.table} (${[list.joinColumn, list.orderColumn, ...columns].join(', ')}) VALUES (${placeholders})`)}, owner, position, ${list.columns.map((column) => column.write).join(', ')}); err != nil {
			return err
		}
	}
	return nil
}`;
  return [read, write];
}

/** La función que escribe la fila de una entidad (y después sus hijas y sus listas). */
function writeFunction(model, table, uses) {
  const name = table.entity.name;
  const parentKey = table.columns.find((column) => column.parentKey);
  const writable = table.columns.filter((column) => column.write || column.parentKey);
  const insertColumns = [...writable.map((c) => c.column)];
  const args = writable.map((c) => (c.parentKey ? 'parent' : c.write));
  for (const audit of table.audit) {
    insertColumns.push(audit.column);
    args.push(audit.kind === 'time' ? 'now' : 'actor');
  }
  if (table.audit.some((audit) => audit.kind === 'actor')) uses.add('auditActor');
  const versioned = Boolean(table.version) && !parentKey;
  const updatable = insertColumns.filter((column) => column !== table.idColumn && !['created_at', 'created_by'].includes(column));
  const placeholders = (count, from = 1) => Array.from({ length: count }, (_, i) => ph(model, i + from)).join(', ');
  const signature = `func write${name}(ctx context.Context, q DBTX, e *domain.${name}${parentKey ? `, parent ${table.parentIdType}` : ''}) error`;
  const prelude = [];
  if (table.audit.some((a) => a.kind === 'time')) prelude.push('\tnow := time.Now().UTC()');
  if (table.audit.some((a) => a.kind === 'actor')) prelude.push('\tactor := auditActor(ctx)');
  const updateArgs = insertColumns.map((column, index) => ({ column, arg: args[index] })).filter(({ column }) => updatable.includes(column));
  const idArg = args[insertColumns.indexOf(table.idColumn)];
  let statement;
  if (versioned) {
    const insertAll = [...insertColumns, table.version.column];
    const setColumns = updatable.map((column, index) => `${column} = ${ph(model, index + 1)}`);
    statement = `	version := e.${table.version.method}()
	if version == nil {
		if _, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table.table} (${insertAll.join(', ')}) VALUES (${placeholders(insertAll.length)})`)}, ${[...args, '0'].join(', ')}); err != nil {
			return err
		}
	} else {
		result, err := q.ExecContext(ctx, ${goString(`UPDATE ${table.table} SET ${[...setColumns, `${table.version.column} = ${table.version.column} + 1`].join(', ')} WHERE ${table.idColumn} = ${ph(model, updatable.length + 1)} AND ${table.version.column} = ${ph(model, updatable.length + 2)}`)}, ${[...updateArgs.map((u) => u.arg), idArg, '*version'].join(', ')})
		if err != nil {
			return err
		}
		// Cero filas: otra escritura subió la versión (o borró la fila) desde que este agregado se leyó.
		if changed, err := result.RowsAffected(); err != nil || changed == 0 {
			return errors.Join(errStaleVersion, err)
		}
	}`;
    uses.add('errStaleVersion');
  } else if (sqlDialect(model).mysql) {
    // MySQL: ON DUPLICATE KEY salta con CUALQUIER índice único, y una clave natural repetida actualizaría la fila de
    // otro agregado en vez de fallar. Se actualiza por el id y, si no ENCONTRÓ la fila (ClientFoundRows), se inserta.
    const allColumns = [...insertColumns, ...(table.version ? [table.version.column] : [])];
    const allArgs = [...args, ...(table.version ? [`nullable(e.${table.version.method}(), func(v int64) any { return v })`] : [])];
    const setColumns = updatable.length > 0 ? updatable.map((column) => `${column} = ?`) : [`${table.idColumn} = ${table.idColumn}`];
    statement = `	result, err := q.ExecContext(ctx, ${goString(`UPDATE ${table.table} SET ${setColumns.join(', ')} WHERE ${table.idColumn} = ?`)}, ${[...updateArgs.map((u) => u.arg), idArg].join(', ')})
	if err != nil {
		return err
	}
	found, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if found == 0 {
		if _, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table.table} (${allColumns.join(', ')}) VALUES (${placeholders(allColumns.length)})`)}, ${allArgs.join(', ')}); err != nil {
			return err
		}
	}`;
  } else {
    const conflict = updatable.length > 0 ? `DO UPDATE SET ${updatable.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}` : 'DO NOTHING';
    const lockColumns = table.version ? [table.version.column] : [];
    const allColumns = [...insertColumns, ...lockColumns];
    const allArgs = [...args, ...(table.version ? [`nullable(e.${table.version.method}(), func(v int64) any { return v })`] : [])];
    statement = `	if _, err := q.ExecContext(ctx, ${goString(`INSERT INTO ${table.table} (${allColumns.join(', ')}) VALUES (${placeholders(allColumns.length)}) ON CONFLICT (${table.idColumn}) ${conflict}`)}, ${allArgs.join(', ')}); err != nil {
		return err
	}`;
  }
  const idExpr = `e.${goExported(table.entity.idField?.name ?? 'id')}()`;
  const after = [];
  for (const child of table.children) {
    const childTable = child.table;
    const array = childTable.selfArray;
    const childParent = childTable.columns.find((column) => column.parentKey).column;
    const kept = `kept${child.method}`;
    let prune;
    if (sqlDialect(model).mysql) {
      // Sin arrays: `NOT IN (?, …)` con un parámetro por id, y sin ninguno (`NOT IN ()` no es SQL) se borran todas.
      uses.add('inList');
      const del = `delete${child.method}`;
      prune = `	${del} := ${goString(`DELETE FROM ${childTable.table} WHERE ${childParent} = ?`)}
	${del}Args := []any{${idExpr}}
	if len(${kept}) > 0 {
		in, args := inList(${kept})
		${del} += ${goString(` AND ${childTable.idColumn} NOT IN (`)} + in + ")"
		${del}Args = append(${del}Args, args...)
	}
	if _, err := q.ExecContext(ctx, ${del}, ${del}Args...); err != nil {
		return err
	}`;
    } else {
      if (array.helper) uses.add(array.helper);
      prune = `	if _, err := q.ExecContext(ctx, ${goString(`DELETE FROM ${childTable.table} WHERE ${childParent} = $1 AND NOT (${childTable.idColumn} = ANY($2::${array.cast}))`)}, ${idExpr}, ${array.helper ? `${array.helper}(${kept})` : kept}); err != nil {
		return err
	}`;
    }
    after.push(`	// Las ${child.entity.name} que ya no están se borran (con lo que cuelga de ellas); las demás se insertan o se actualizan.
	${lower(child.method)} := e.${child.method}()
	${kept} := make([]${child.entity.idField?.goType ?? 'uuid.UUID'}, 0, len(${lower(child.method)}))
	for _, child := range ${lower(child.method)} {
		${kept} = append(${kept}, child.${goExported(child.entity.idField?.name ?? 'id')}())
	}
${prune}
	for _, child := range ${lower(child.method)} {
		if err := write${child.entity.name}(ctx, q, child, ${idExpr}); err != nil {
			return err
		}
	}`);
  }
  for (const list of table.lists) {
    after.push(`	if err := write${name}${list.method}(ctx, q, ${idExpr}, e.${list.method}()); err != nil {
		return err
	}`);
  }
  return `// write${name} escribe la fila de ${table.table}${table.children.length + table.lists.length > 0 ? ', y después sus hijas y sus listas' : ''}.
${signature} {
${[...prelude, statement, ...after].join('\n')}
	return nil
}`;
}

function saveMethods(model, entity, root, tables, type) {
  const name = entity.name;
  const id = goExported(entity.idField?.name ?? 'id');
  // Los ids de cada tabla como array de PostgreSQL, y el del padre de cada hija.
  for (const table of tables) {
    table.selfArray = idArray(table.entity);
    for (const child of table.children) {
      child.table.parentIdType = table.entity.idField?.goType ?? 'uuid.UUID';
      child.table.parentArray = idArray(table.entity);
    }
  }
  const local = localName(lower(name));
  const events = emitsEvents(model, entity);
  const outbox = events && usesGoOutbox(model);
  return `// Save implementa domain.${portName(entity)}: escribe el agregado entero en una transacción (la abierta, o una
// suya) y lo relee en ella.${outbox ? ' Las filas del outbox de sus eventos van en esa misma transacción.' : events ? ' Sus eventos se publican cuando esa transacción confirma.' : ''}
func (r *${type}) Save(ctx context.Context, ${local} *domain.${name}) (*domain.${name}, error) {${events ? `
	events := ${local}.PullEvents()` : ''}
	var saved *domain.${name}
	err := r.tx.write(ctx, func(q DBTX) error {
		if err := write${name}(ctx, q, ${local}); err != nil {
			return err
		}${outbox ? `
		records, err := r.events.Route(ctx, events)
		if err != nil {
			return err
		}
		if err := appendOutbox(ctx, q, records); err != nil {
			return err
		}` : ''}
		states, err := query${name}(ctx, q, ${goString(`WHERE ${root.idColumn} = ${ph(model, 1)}`)}, ${local}.${id}())
		if err != nil {
			return err
		}
		if len(states) == 0 {
			return fmt.Errorf("${root.table}: la fila guardada no se pudo releer")
		}
		saved = domain.Rehydrate${name}(states[0])
		return nil
	})
	if err != nil {
		return nil, err
	}${events && !outbox ? `
	if len(events) > 0 {
		r.tx.afterCommit(ctx, func(ctx context.Context) {
			r.events.Deliver(ctx, events)
		})
	}` : ''}
	return saved, nil
}`;
}

/** Las propiedades por las que se puede ordenar, con el nombre del contrato, y su columna. */
function sortable(model, entity) {
  const props = [];
  for (const member of persistedMembers(model, entity)) {
    if (member.kind === 'scalar') {
      if (!member.field.columns) continue;
      props.push([member.name, member.field.columns.name]);
      if (member.folded) props.push([member.folded.name, member.folded.column]);
      if (member.ranked) props.push([member.ranked.name, member.ranked.column]);
    } else if (member.kind === 'externalRef') props.push([member.name, member.column]);
    else if (member.kind === 'vo') for (const sub of member.subs) if (sub.sub.columns) props.push([sub.name, sub.column]);
  }
  if (entity.auditTimestamps === 'all') for (const column of AUDIT_COLUMNS.timestamps) props.push([column.field, column.column]);
  if (entity.auditAuthorship === 'all') for (const column of AUDIT_COLUMNS.authorship) props.push([column.field, column.column]);
  return props;
}

/** El mapa de orden de una raíz: lo usan su List y sus finders. */
function sortableMap(model, entity) {
  const columns = alignRows(sortable(model, entity).map(([property, column]) => ({ indent: '\t', cells: [`${goString(property)}:`, `${goString(sq(model, column))},`] })));
  return `// ${lower(entity.name)}Sortable son las propiedades por las que se puede ordenar, con el nombre del contrato, y su columna.
// Es una lista blanca: el ORDER BY nunca lleva un texto de la petición.
var ${lower(entity.name)}Sortable = map[string]string{
${columns.join('\n')}
}`;
}

function listMethod(model, entity, root, type) {
  const name = entity.name;
  const idName = entity.idField?.name ?? 'id';
  return `// List implementa domain.${portName(entity)}.
func (r *${type}) List(ctx context.Context, pageable domain.Pageable) (domain.Page[*domain.${name}], error) {
	order, err := orderBy(pageable.Sort, ${lower(name)}Sortable, ${goString(idName)}, ${goString(root.idColumn)})
	if err != nil {
		return domain.Page[*domain.${name}]{}, fmt.Errorf("${root.table}: %w", err)
	}
	q, err := r.tx.conn(ctx)
	if err != nil {
		return domain.Page[*domain.${name}]{}, err
	}
	var total int64
	if err := q.QueryRowContext(ctx, ${goString(`SELECT count(*) FROM ${root.table}`)}).Scan(&total); err != nil {
		return domain.Page[*domain.${name}]{}, translate(err)
	}
	found, err := r.load(ctx, "ORDER BY "+order+" LIMIT ${ph(model, 1)} OFFSET ${ph(model, 2)}", pageable.Size, pageable.Offset())
	if err != nil {
		return domain.Page[*domain.${name}]{}, err
	}
	return domain.NewPage(found, pageable, total), nil
}`;
}

// ─── Lo común de los adaptadores ─────────────────────────────────────────────────────────────────

/** values.go: los auxiliares que comparten los adaptadores, solo los que alguno usa (U1000 rechaza el resto). */
function valuesBody(model, uses, roots) {
  const blocks = [
    `// closeRows cierra un cursor y devuelve el error de la iteración o del cierre, ya traducido.
func closeRows(rows *sql.Rows) error {
	return translate(errors.Join(rows.Err(), rows.Close()))
}`,
    `// nullable escribe un opcional: NULL si no hay valor, o el valor convertido a lo que la columna espera.
func nullable[T any](value *T, convert func(T) any) any {
	if value == nil {
		return nil
	}
	return convert(*value)
}`,
    `// orderBy traduce el orden pedido a columnas desde una lista blanca, con el id como último criterio si no está ya:
// sin desempate, dos páginas consecutivas pueden repetir una fila y omitir otra. Una propiedad que no existe es un
// error, como la PropertyReferenceException de Spring Data.
func orderBy(sort []domain.SortOrder, columns map[string]string, idProperty, idColumn string) (string, error) {
	var terms []string
	var seen []string
	for _, order := range sort {
		column, ok := columns[order.Property]
		if !ok {
			return "", fmt.Errorf("no existe la propiedad %q para ordenar", order.Property)
		}
		if slices.Contains(seen, order.Property) {
			continue
		}
		seen = append(seen, order.Property)
		direction := "ASC"
		if order.Direction == domain.SortDesc {
			direction = "DESC"
		}
		terms = append(terms, column+" "+direction)
	}
	if !slices.Contains(seen, idProperty) {
		terms = append(terms, idColumn+" ASC")
	}
	return strings.Join(terms, ", "), nil
}`
  ];
  if (uses.has('inList')) {
    blocks.push(`// inList es la lista de parámetros de un IN de MySQL, que no tiene arrays: un «?» por valor, y los valores como
// argumentos. Nunca está vacía: quien la pide comprueba antes que hay algún valor.
func inList[T any](values []T) (string, []any) {
	args := make([]any, len(values))
	for i, value := range values {
		args[i] = value
	}
	return strings.Repeat("?, ", len(values)-1) + "?", args
}`);
  }
  if (uses.has('uuidTexts')) {
    blocks.push(`// uuidTexts pasa unos uuid a texto para un array de PostgreSQL (\`= ANY($1::uuid[])\`).
func uuidTexts(ids []uuid.UUID) []string {
	texts := make([]string, len(ids))
	for i, id := range ids {
		texts[i] = id.String()
	}
	return texts
}`);
  }
  if (uses.has('auditActor')) {
    blocks.push(`// auditActor es el autor de una escritura para la auditoría. Sin la capa de seguridad (incremento 8 de PLAN-KEEL-GO.md)
// es el sistema, con la correlación de la petición o del mensaje si la hay (SYSTEM_ACTOR de keel-core/gen/relational.js).
func auditActor(ctx context.Context) string {
	if id, ok := correlation.ID(ctx); ok {
		return ${goString(`${SYSTEM_ACTOR}:`)} + id
	}
	return ${goString(SYSTEM_ACTOR)}
}`);
  }
  for (const name of [...uses].filter((use) => use.startsWith('enum:')).map((use) => use.slice(5)).sort()) {
    const values = (model.enums ?? []).find((candidate) => candidate.name === name)?.values ?? [];
    const rows = alignRows(values.map((value) => ({ indent: '\t', cells: [`domain.${enumConstant(name, value.literal)}:`, `${goString(value.constant)},`] })));
    blocks.push(`// ${lower(name)}Columns es lo que se guarda de cada ${name}: el nombre de su constante, como en los otros tres generadores.
var ${lower(name)}Columns = map[domain.${name}]string{
${rows.join('\n')}
}

// ${lower(name)}Column es el valor de columna de un ${name}.
func ${lower(name)}Column(value domain.${name}) string {
	return ${lower(name)}Columns[value]
}

// parse${name}Column lee un ${name} de su columna: solo admite las constantes del diseño.
func parse${name}Column(text string) (domain.${name}, error) {
	for value, column := range ${lower(name)}Columns {
		if column == text {
			return value, nil
		}
	}
	return "", fmt.Errorf("${name} desconocido en la base de datos: %q", text)
}`);
  }
  for (const name of rankedEnums(model)) {
    const values = (model.enums ?? []).find((candidate) => candidate.name === name)?.values ?? [];
    const order = values.map((value) => `domain.${enumConstant(name, value.literal)}`);
    blocks.push(`// ${rankFunc(name)} es la posición de un ${name} en su declaración: la sombra de rango por la que se ordena.
func ${rankFunc(name)}(value domain.${name}) int32 {
	return int32(slices.Index([]domain.${name}{${order.join(', ')}}, value))
}`);
  }
  blocks.push(...filtersBlocks(filtersUses(model, roots), sqlDialect(model)));
  return `\n${blocks.join('\n\n')}\n`;
}

/** Los rangos de los enums por los que se ordena: la posición de cada valor en su declaración. */
export function rankedEnums(model) {
  const names = new Set();
  for (const entity of repositoryRoots(model)) {
    for (const member of persistedMembers(model, entity)) if (member.kind === 'scalar' && member.ranked) names.add(member.ranked.enum ?? member.field.goType);
  }
  return [...names].sort();
}
