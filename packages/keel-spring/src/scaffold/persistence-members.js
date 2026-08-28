// Taxonomía de miembros persistidos de una entidad, compartida por los DOS modelos
// de persistencia que genera keel-spring: el relacional (persistence-entities.js +
// repositories.js) y el documental (document-entities.js + document-repositories.js).
//
// Lo que se comparte es la LECTURA del diseño —qué es campo, qué es value object,
// qué relación cruza la frontera del agregado y cuál no—, que no depende del motor.
// Lo que no se comparte es el render: una asociación @OneToMany con mappedBy y una
// lista anidada dentro de un documento no tienen ninguna línea en común, y por eso
// hay dos renderizadores y no uno parametrizado.

import { snakeCase } from '../lib/naming.js';
import { quoteIdentifier } from '../lib/sql-reserved.js';
import { capitalize } from './entities.js';

// Miembros de la entidad persistida, alineados con domainMembers() del dominio:
// - scalar: campo directo (incluye enums)
// - vo: value object compuesto (columnas con prefijo en relacional, subdocumento en
//   documental; `subs[]` solo lo consume la rama relacional)
// - externalRef: UUID <relación>Id — la frontera del agregado, en los dos modelos
// - relationOne / relationMany: entidad hija del mismo agregado
// - elementCollection: colección de valores sin identidad (`list` del DSL)
export function persistedMembers(model, entity) {
  const members = [];
  for (const field of entity.fields) {
    if (field.list) {
      // Colección de valores sin identidad (DSL 2.1 list): tabla de elementos
      // (@ElementCollection) en relacional, array del propio documento en documental.
      // El elemento es escalar/enum o un value object (su espejo compuesto).
      members.push({
        kind: 'elementCollection',
        field,
        name: field.name,
        element:
          field.kind === 'composite'
            ? { kind: 'vo', javaType: `${field.elementJavaType}Jpa`, typeName: field.elementJavaType }
            : { kind: field.kind, javaType: field.elementJavaType }
      });
    } else if (field.kind === 'composite') {
      const vo = model.valueObjects.find((v) => v.name === field.javaType);
      members.push({
        kind: 'vo',
        field,
        vo,
        name: field.name,
        subs: (vo?.fields ?? []).map((sub) => ({
          name: `${field.name}${capitalize(sub.name)}`,
          voAccessor: sub.name,
          javaType: sub.javaType,
          imports: sub.imports,
          subKind: sub.kind,
          column: quoteIdentifier(`${snakeCase(field.name)}_${snakeCase(sub.name)}`)
        }))
      });
    } else {
      members.push({ kind: 'scalar', field, name: field.name, javaType: field.javaType });
    }
  }
  for (const relation of entity.relations) {
    const toMany = relation.cardinality === 'one-to-many' || relation.cardinality === 'many-to-many';
    if (!relation.internal) {
      members.push({ kind: 'externalRef', relation, name: `${relation.name}Id`, javaType: 'UUID' });
    } else {
      members.push({ kind: toMany ? 'relationMany' : 'relationOne', relation, name: relation.name });
    }
  }
  return members;
}

// Campos por los que una colección hija tiene un orden PROPIO del diseño: un
// número de posición explícito. No es cosmético — cuando el dominio expone
// `position`, el orden es contrato observable (la galería de un producto se
// devuelve en su orden), y una colección `@OneToMany` sin `@OrderBy` la entrega en
// el orden que decida la base de datos. Tras un reorder eso significa que la
// colección en memoria no refleja el orden recién guardado salvo que cada
// adaptador se acuerde de reordenarla al mapear.
//
// En el modelo documental el array conserva el orden de INSERCIÓN, que tampoco es
// el del diseño tras un reorder: allí el equivalente del @OrderBy es un
// Comparator explícito al mapear a dominio.
const ORDERING_FIELDS = ['position', 'order', 'sortOrder', 'sequence'];
const ORDERING_KINDS = new Set(['int', 'integer', 'long', 'short', 'number', 'decimal']);

/** Campo de orden explícito de la entidad hija, o null si no lo declara. */
export function orderingFieldOf(model, entityName) {
  const child = model.entities.find((e) => e.name === entityName);
  if (!child) return null;
  return (
    child.fields.find(
      (field) =>
        !field.list && ORDERING_FIELDS.includes(field.name) && (!field.base || ORDERING_KINDS.has(field.base))
    ) ?? null
  );
}

// Nombre de la relación con la que `childName` apunta de vuelta a `parentName`
// (back-reference declarada en el diseño), o null si la relación es unidireccional.
// Es el mappedBy del @OneToMany del padre y el setter que el mapeo debe rellenar.
export function backReferenceTo(model, childName, parentName) {
  const child = model.entities.find((e) => e.name === childName);
  return child?.relations.find((rel) => rel.backReference && rel.entity === parentName)?.name ?? null;
}

// Campos que llevan constraint única propia: los unique del diseño, salvo el id
// (ya es clave primaria), los value objects compuestos (no son una sola columna)
// y los que la clave natural ya cubre por sí sola.
export function uniqueFields(entity) {
  const naturalKeyAlone = entity.naturalKey?.length === 1 ? entity.naturalKey[0] : null;
  return entity.fields.filter(
    (field) => field.unique && !field.isId && field.kind !== 'composite' && field.name !== naturalKeyAlone
  );
}

/**
 * Nombre del índice, y es un CONTRATO compartido por cuatro sitios: la anotación
 * del espejo relacional, el `MongoIndexConfig` del documental, el appendix de SQL
 * de los índices parciales y el mapa del ApiExceptionHandler, que traduce una
 * violación POR NOMBRE al error declarado del diseño. Compuesto en cada sitio por
 * su cuenta, un cambio de patrón dejaría al handler buscando un nombre que ya no
 * existe y el error del diseño se degradaría a un 409 genérico.
 *
 * El prefijo lo decide la unicidad, no la forma: `uk_` es el que el handler busca.
 */
export function indexName(entity, index) {
  const suffix = index.fields.map((field) => snakeCase(field.split('.').join('_'))).join('_');
  return `${index.unique ? 'uk' : 'idx'}_${entity.tableName ?? entity.collectionName}_${suffix}`;
}

/** Índices únicos condicionados: los que ningún motor expresa con una constraint de columnas. */
export function partialUniqueIndexes(entity) {
  return (entity.indexes ?? []).filter((index) => index.unique && index.when);
}

/**
 * El valor con el que la CONDICIÓN de un índice se compara en el almacén, que no siempre
 * es el que escribió el diseño.
 *
 * Un campo enum se guarda por `name()` —`@Enumerated(EnumType.STRING)` en relacional, la
 * serialización por defecto de Spring Data en documental—, o sea la CONSTANTE (`ACTIVE`),
 * mientras el diseño, el JSON y `openapi.yaml` hablan del literal (`active`). Emitir el
 * literal produce un índice que se crea sin error y no casa con ninguna fila: el invariante
 * que debía sostener queda sin efecto, y no lo delata ni el arranque ni ningún escenario —la
 * ausencia de un rechazo no falla ninguna aserción—.
 *
 * Vive aquí, y no en cada emisor, porque los emisores son DOS y aplican la misma conversión:
 * el predicado SQL de `migrations.js` y el `partialFilterExpression` de `document-indexes.js`.
 * Es la regla de `broker-probes.js`: una fuente, dos proyecciones.
 *
 * Lo que NO es enum se devuelve intacto. Para un booleano o un número el literal del diseño
 * ES el valor almacenado, y convertirlo sería el error simétrico.
 */
export function storedWhenValue(model, entity, when) {
  if (!when) return when;
  // Solo un campo directo puede ser enum; un dot-path apunta a un value object o a una hija
  // anidada, y ahí no hay constante que resolver.
  const field = (entity.fields ?? []).find((candidate) => candidate.name === when.field);
  if (field?.kind !== 'enum' || !field.javaType) return when.equals;

  const enumDef = (model.enums ?? []).find((candidate) => candidate.name === field.javaType);
  const value = enumDef?.values?.find((candidate) => candidate.literal === when.equals);
  // Sin correspondencia se devuelve el literal tal cual: el diseño declara un valor que no
  // existe en el enum, y eso lo caza `crossrefs` como error de validación. Inventar aquí una
  // constante taparía esa incoherencia bajo un índice igual de inútil.
  return value?.constant ?? when.equals;
}

// Nombre de constraint → entidad y campo que la originan. Lo consume el
// ApiExceptionHandler para traducir una violación de integridad al error
// declarado del diseño en vez de a un 409 genérico.
//
// Los nombres son los MISMOS en los dos modelos, y es un contrato, no una
// coincidencia: en relacional los emite el @UniqueConstraint de la Jpa y en
// documental el índice único de MongoIndexConfig, y en ambos casos el handler
// encuentra el nombre dentro del mensaje del driver (`E11000 … index: uk_… `).
export function uniqueConstraints(model) {
  const entries = [];
  for (const entity of model.entities.filter((e) => e.persisted)) {
    if (entity.naturalKey?.length > 0) {
      entries.push({
        constraint: `uk_${entity.tableName}_natural`,
        entity: entity.name,
        fields: entity.naturalKey
      });
    }
    for (const field of uniqueFields(entity)) {
      entries.push({
        constraint: `uk_${entity.tableName}_${snakeCase(field.name)}`,
        entity: entity.name,
        fields: [field.name]
      });
    }
    // Los índices únicos del diseño entran por el mismo sitio, condicionados o no:
    // su violación llega al handler igual que la de una constraint de tabla, y sin
    // esta entrada el error declarado se degradaría a un 409 genérico — que es
    // justo el caso que más importa, porque un índice parcial existe para sostener
    // un invariante que el diseño nombró.
    for (const index of (entity.indexes ?? []).filter((i) => i.unique)) {
      entries.push({
        constraint: indexName(entity, index),
        entity: entity.name,
        fields: index.fields,
        when: index.when ?? null
      });
    }
  }
  return entries;
}

// AuditableEntity/AuditableDocument solo existe si algún eje de persistence.audit
// vale 'all': es la política que pone campos que el dominio no nombra. Con
// 'declared' los campos son del diseño y se anotan en su propio espejo; con 'none'
// no hay nada que heredar.
export function usesAuditableEntity(model) {
  return model.audit?.timestamps === 'all' || model.audit?.authorship === 'all';
}
