// Las COTAS de un campo, leídas del diseño sin lenguaje (keel-core/gen).
//
// Un campo hereda las constraints de su value type y puede declarar las suyas, que mandan. Qué
// cotas acaban valiendo —y cuáles se hacen cumplir dónde— es una pregunta del diseño, y la
// respuesta tiene que ser la misma en los dos generadores: si keel-spring normalizara la escala
// de un importe y keel-nest no, el mismo `12.5` saldría `12.50` de un servidor y `12.5` del otro.
// Cómo se escribe cada guarda (un constructor compacto de Java, una clase de TypeScript) es de la
// proyección; QUÉ se guarda sale de aquí.

// Las bases textuales cuyo formato heredado se recoge en una clase `<Tipo>Format`. La misma cota
// que `collectFormatTypes` del modelo, y tiene que serlo: este dato es el que hace que la nota del
// mensaje cite `<Tipo>Format` y que el gate exija una llamada. Si los dos lados no coincidieran,
// la nota mandaría a una clase que no se generó.
export const FORMAT_TEXT_BASES = new Set(['string', 'text', 'json']);

/**
 * Cotas numéricas y ESCALA de un campo, con la mezcla tipo → campo (el campo manda). Es la fuente
 * única de un dato que no viaja como validación de entrada: no hay validador que NORMALICE una
 * escala —solo los que rechazan—, así que sin esto el único sitio donde vive `scale` es la columna,
 * que no existe cuando el value object no se persiste.
 *
 * Devuelve null cuando no hay nada que hacer cumplir, para que quien lo consuma pueda decidir sin
 * mirar dentro.
 */
export function numericConstraints(field, resolved) {
  if (field.list) return null;
  const constraints = { ...resolved.constraints, ...(field.constraints ?? {}) };
  const decimal = resolved.base === 'decimal';
  const scale = decimal && constraints.scale != null ? constraints.scale : null;
  const min = constraints.min ?? null;
  const max = constraints.max ?? null;
  if (scale === null && min === null && max === null) return null;
  // `reject` | `round` | null. Null es «el diseño no lo decidió» (y keel validate lo exigió como
  // obligación, o se aceptó por escrito): se redondea, que es lo que build hacía siempre.
  const scalePolicy = scale === null ? null : constraints.scalePolicy ?? null;
  return { scale, min, max, decimal, scalePolicy };
}

/**
 * El `pattern` que un campo HEREDA de su value type escalar, que es exactamente el que la
 * validación de ENTRADA deja fuera: el formato del tipo describe el valor ya normalizado, y la
 * validación del borde corre antes de que nadie normalice. Null si el campo declara el suyo propio
 * (entonces no se hereda nada y la entrada lo conserva) o si el tipo no declara formato.
 *
 * Para un campo COLECCIÓN el patrón es el del ELEMENTO: `resolved` ya es el tipo del elemento.
 */
export function inheritedTypePattern(field, resolved) {
  if ((field?.constraints ?? {}).pattern != null) return null;
  return resolved?.constraints?.pattern ?? null;
}

/**
 * El formato heredado que sostiene la clase `<Tipo>Format` del dominio y el gate que comprueba que
 * alguien la llama: solo un value type ESCALAR sobre una base textual lo tiene.
 */
export function inheritedFormat(field, resolved) {
  return resolved.kind === 'scalar-vt' && FORMAT_TEXT_BASES.has(resolved.base) ? inheritedTypePattern(field, resolved) : null;
}

/**
 * Las cotas de TEXTO de un campo (formato y longitud), con la misma mezcla tipo → campo. Una lista
 * no tiene: sus cotas son de cardinalidad. `minLength: 0` no rechaza nada y se omite: una guarda
 * que no puede dispararse solo es ruido. Null si no queda ninguna.
 */
export function textConstraints(field, resolved) {
  if (field.list) return null;
  if (resolved.kind === 'enum' || resolved.kind === 'composite') return null;
  const constraints = { ...resolved.constraints, ...(field.constraints ?? {}) };
  const minLength = constraints.minLength != null && constraints.minLength > 0 ? constraints.minLength : null;
  const maxLength = constraints.maxLength ?? null;
  const pattern = constraints.pattern ?? null;
  if (minLength === null && maxLength === null && pattern === null) return null;
  return { pattern, minLength, maxLength };
}
