// Taxonomía de miembros persistidos de una entidad, compartida por los DOS modelos
// de persistencia que genera keel-spring: el relacional (persistence-entities.js +
// repositories.js) y el documental (document-entities.js + document-repositories.js).
//
// La LECTURA del diseño —qué es campo, qué es value object, qué relación cruza la
// frontera del agregado, cómo se llama cada tabla, columna, constraint e índice— vive en
// keel-core/gen (relational.js), porque keel-nest la escribe sobre los mismos datos y el
// esquema es contrato observable de los dos. Aquí se le añade lo que es de Java: el tipo de
// cada miembro, sus imports y la anotación @Column ya escrita, con el identificador citado en
// backticks (que Hibernate traduce al dialecto).

import {
  persistedMembers as neutralMembers,
  foldedShadow as neutralShadow,
  orderingFieldOf,
  backReferenceTo,
  uniqueFields,
  indexName,
  foreignKeyName,
  partialUniqueIndexes,
  storedWhenValue,
  crossAggregateForeignKeys,
  uniqueConstraints,
  usesAuditableEntity
} from 'keel-core/gen/relational';
import { quoteIdentifier } from '../lib/sql-reserved.js';

export {
  orderingFieldOf,
  backReferenceTo,
  uniqueFields,
  indexName,
  foreignKeyName,
  partialUniqueIndexes,
  storedWhenValue,
  crossAggregateForeignKeys,
  uniqueConstraints,
  usesAuditableEntity
};

// Miembros de la entidad persistida, alineados con domainMembers() del dominio:
// - scalar: campo directo (incluye enums)
// - vo: value object compuesto (columnas con prefijo en relacional, subdocumento en
//   documental; `subs[]` solo lo consume la rama relacional)
// - externalRef: UUID <relación>Id — la frontera del agregado, en los dos modelos
// - relationOne / relationMany: entidad hija del mismo agregado
// - elementCollection: colección de valores sin identidad (`list` del DSL)
export function persistedMembers(model, entity) {
  return neutralMembers(model, entity).map((member) => {
    if (member.kind === 'elementCollection') {
      // Tabla de elementos (@ElementCollection) en relacional, array del propio documento en
      // documental. El elemento es escalar/enum o un value object (su espejo compuesto).
      const { field } = member;
      return {
        ...member,
        element:
          member.element.kind === 'vo'
            ? { kind: 'vo', javaType: `${field.elementJavaType}Jpa`, typeName: field.elementJavaType }
            : { kind: field.kind, javaType: field.elementJavaType }
      };
    }
    if (member.kind === 'vo') {
      return {
        kind: 'vo',
        field: member.field,
        vo: member.vo,
        name: member.name,
        subs: member.subs.map((sub) => {
          const column = quoteIdentifier(sub.column);
          return {
            name: sub.name,
            voAccessor: sub.voAccessor,
            javaType: sub.sub.javaType,
            imports: sub.sub.imports,
            subKind: sub.subKind,
            column,
            // El @Column COMPLETO, no solo su nombre. Compuesto a mano en el
            // renderizador se quedaba en el nombre y perdía todo lo demás —`nullable`,
            // `length`, `precision/scale`, `columnDefinition`—, que es justo lo único
            // que llega al DDL: un Money con `scale: 2` salía `numeric(38,2)` por el
            // DEFAULT de Hibernate y no por el diseño (con `scale: 4` habría seguido
            // diciendo 2), y su `currency` de tres letras salía `varchar(255)`. Es el
            // mismo defecto que ya se corrigió para la columna de un `list: true`, y
            // `embeddables.js` ya lo hacía bien para el VO de una colección: el camino
            // aplanado era el que quedaba fuera.
            //
            // El `nullable = false` se cae si el VO ENTERO es opcional: un Money que el
            // diseño no exige no puede dejar columnas NOT NULL, o la fila sin importe no
            // se puede insertar.
            columns: flattenedColumns(sub.sub, column, sub.ownerRequired)
          };
        })
      };
    }
    if (member.kind === 'scalar') {
      return { kind: 'scalar', field: member.field, name: member.name, javaType: member.field.javaType, folded: foldedShadow(member.field) };
    }
    if (member.kind === 'externalRef') {
      return { kind: 'externalRef', relation: member.relation, name: member.name, javaType: 'UUID' };
    }
    return member;
  });
}

/**
 * La SOMBRA plegada de un campo con `compare` (DSL 2.14), con la columna citada para Hibernate.
 * Qué es y por qué una sombra y no una collation: keel-core/gen/relational.js (`foldedShadow`).
 */
export function foldedShadow(field) {
  const shadow = neutralShadow(field);
  return shadow ? { ...shadow, column: quoteIdentifier(shadow.column) } : null;
}

/**
 * Las anotaciones de columna de un sub-campo de value object, con el nombre aplanado.
 *
 * Se reescribe el `name` en vez de volver a resolver el campo: `columnAnnotations()` ya
 * corrió sobre el sub-campo (lo hace `collectValueObjects`), así que aquí solo cambia
 * dónde aterriza, no qué se declaró.
 */
function flattenedColumns(sub, column, ownerRequired) {
  return (sub.columns ?? [])
    .filter((annotation) => annotation.startsWith('@Column'))
    .map((annotation) => {
      const renamed = annotation.replace(/name = "[^"]*"/, `name = "${column}"`);
      return ownerRequired ? renamed : renamed.replace(', nullable = false', '');
    });
}
