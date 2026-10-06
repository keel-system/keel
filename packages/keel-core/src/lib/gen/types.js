// Los tipos del DSL, resueltos SIN lenguaje (keel-core/gen).
//
// El diseño nombra un tipo base (`string`, `decimal`…), un value type declarado en
// `domain.types` o un nombre de clase generada. Resolverlo es una pregunta del diseño —qué
// clase de tipo es, sobre qué primitivo se apoya y qué constraints arrastra— y la respuesta
// tiene que ser la misma para cualquier generador. Lo que cambia con el lenguaje (el nombre del
// tipo en Java o en TypeScript, sus imports, sus anotaciones) lo añade la PROYECCIÓN de cada
// generador sobre lo que devuelve este módulo.

/** Los tipos base del DSL. El orden no importa; la pertenencia sí. */
export const BASE_TYPES = ['string', 'text', 'int', 'long', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'json', 'file'];

const BASE_SET = new Set(BASE_TYPES);

// Las bases cuyo valor es TEXTO en cualquier lenguaje: el `json` viaja como texto serializado y
// un `file` es la clave del objeto en su bucket.
const TEXTUAL_BASES = new Set(['string', 'text', 'json', 'file']);

/**
 * ¿Este nombre de tipo es un primitivo del DSL, y no un value type declarado?
 *
 * La diferencia importa cuando se quiere ATAR dos sitios que hablan del mismo dato:
 * dos campos `string` no tienen nada que ver entre sí, pero dos campos `EmailAddress`
 * sí — el diseño les puso nombre justamente para decirlo.
 */
export function isBaseType(typeName) {
  return typeof typeName === 'string' && BASE_SET.has(typeName);
}

/**
 * Resuelve una referencia de tipo del diseño. Devuelve `{ kind, base?, name?, constraints }`:
 * - kind 'base'       → tipo base del DSL (`base` es su nombre).
 * - kind 'scalar-vt'  → value type escalar, aplanado a su `base`, con sus constraints.
 * - kind 'enum'       → enum nominal; `name` es la clase que se genera.
 * - kind 'composite'  → value object compuesto; `name` es la clase que se genera.
 *
 * Una referencia no declarada se resuelve como compuesto con su nombre: la validación de
 * referencias cruzadas ya la habría rechazado, y se conserva por robustez.
 */
export function resolveType(typeRef, domainTypes = {}) {
  if (BASE_SET.has(typeRef)) return { kind: 'base', base: typeRef, constraints: {} };
  const declared = domainTypes[typeRef];
  if (declared?.base) {
    return { kind: 'scalar-vt', base: declared.base, constraints: { ...(declared.constraints ?? {}) } };
  }
  if (declared?.values) return { kind: 'enum', name: typeRef, constraints: {} };
  return { kind: 'composite', name: typeRef, constraints: {} };
}

/**
 * ¿El valor de este tipo resuelto es TEXTO? Un tipo base o un value type escalar sobre una base
 * textual; un value type sobre una base que el DSL no conoce se trata como texto, que es el
 * mismo criterio con el que se le da representación.
 */
export function isTextual(resolved) {
  if (resolved.kind !== 'base' && resolved.kind !== 'scalar-vt') return false;
  return TEXTUAL_BASES.has(resolved.base) || !BASE_SET.has(resolved.base);
}
