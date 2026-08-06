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
