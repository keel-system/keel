// Las COTAS de un campo, leídas del diseño sin lenguaje (keel-core/gen).
//
// Un campo hereda las constraints de su value type y puede declarar las suyas, que mandan. Qué
// cotas acaban valiendo —y cuáles se hacen cumplir dónde— es una pregunta del diseño, y la
// respuesta tiene que ser la misma en los dos generadores: si keel-spring normalizara la escala
// de un importe y keel-nest no, el mismo `12.5` saldría `12.50` de un servidor y `12.5` del otro.
// Cómo se escribe cada guarda (un constructor compacto de Java, una clase de TypeScript) es de la
// proyección; QUÉ se guarda sale de aquí.

import { isTextual } from './types.js';

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

/**
 * Precisión de toda columna decimal con escala. Fuente única: la usan la columna y la parte entera
 * de la validación de dígitos de la entrada, que tienen que decir lo mismo.
 */
export const DECIMAL_PRECISION = 19;

/**
 * Las REGLAS DE VALIDACIÓN de un campo, como datos y en orden: lo que en Java son las anotaciones
 * de Bean Validation y en TypeScript el lector de la petición. Una sola decisión para los dos
 * generadores; cada uno las escribe a su manera.
 *
 * `honourDefault: true` (lo pasa el lado de ENTRADA) deja fuera la PRESENCIA de un campo que
 * declara `default`: por definición el cliente puede omitirlo, y exigirlo rechaza con 400 justo el
 * caso para el que el default existe. `inheritTypeFormat: false` (también la entrada) deja fuera el
 * `pattern` que el campo hereda de su value type: describe el valor YA normalizado, y la entrada se
 * valida antes de normalizar. El `pattern` que el campo declara por su cuenta se conserva.
 *
 * Cada regla es `{ rule, ... }`:
 *   · `notBlank` (texto) | `notNull` | `notEmpty` (lista) — presencia;
 *   · `size` con `min`/`max` (longitud de un texto, o cardinalidad de una lista);
 *   · `pattern` con `regexp` (el valor ENTERO tiene que casar);
 *   · `min` / `max` con `value` y `decimal` (cota inclusiva);
 *   · `digits` con `integer` y `fraction` (`scalePolicy: reject` en la entrada).
 */
export function validationRules(field, resolved, { inheritTypeFormat = true, honourDefault = false } = {}) {
  // `!== undefined` y no un truthy check: `default: 0` y `default: false` son tan legítimos como
  // cualquier otro, y son justo los que un `if (default)` se deja fuera.
  const omitPresence = honourDefault && field.default !== undefined;
  const own = field.constraints ?? {};
  const constraints = inheritTypeFormat
    ? { ...resolved.constraints, ...own }
    : { ...resolved.constraints, ...own, pattern: own.pattern ?? null };

  // Campo colección: las reglas son del contenedor, no del elemento.
  if (field.list) {
    const rules = [];
    if (field.required && !omitPresence) rules.push({ rule: 'notEmpty' });
    if (constraints.minItems != null || constraints.maxItems != null) {
      rules.push({ rule: 'size', min: constraints.minItems ?? null, max: constraints.maxItems ?? null });
    }
    return rules;
  }

  const rules = [];
  if (field.required && !omitPresence) rules.push({ rule: isTextual(resolved) ? 'notBlank' : 'notNull' });
  if (constraints.minLength != null || constraints.maxLength != null) {
    rules.push({ rule: 'size', min: constraints.minLength ?? null, max: constraints.maxLength ?? null });
  }
  if (constraints.pattern != null) rules.push({ rule: 'pattern', regexp: constraints.pattern });
  const decimal = resolved.base === 'decimal';
  if (constraints.min != null) rules.push({ rule: 'min', value: constraints.min, decimal });
  if (constraints.max != null) rules.push({ rule: 'max', value: constraints.max, decimal });
  // `scalePolicy: reject` (DSL 2.14): un decimal de ENTRADA con más decimales que su escala es un
  // 400, no un redondeo. Solo en la entrada: el valor ya formado tiene la escala por construcción.
  // La parte entera sale de la misma precisión que la columna, o el borde aceptaría importes que el
  // INSERT rechaza.
  if (!inheritTypeFormat && decimal && constraints.scale != null && constraints.scalePolicy === 'reject') {
    rules.push({ rule: 'digits', integer: DECIMAL_PRECISION - constraints.scale, fraction: constraints.scale });
  }
  return rules;
}
