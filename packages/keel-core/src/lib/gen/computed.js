// Los derivados estructurados de la entidad (DSL 2.31, `computed: { sum, times }` y `computed: { count }`), como
// decisiones neutrales.
//
// Un derivado se calcula en la entidad desde sus hijas del mismo agregado y se PERSISTE (D4 de
// PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md): build lo emite como un getter que calcula, y el `save` generado guarda su
// valor en la columna o el campo, que es lo que deja filtrarlo y ordenarlo. La lectura no recalcula. La aritmética es
// la de D5 y es la misma en los cuatro: si cada lenguaje redondeara a su manera, los servidores divergirían en el
// céntimo. `evaluateComputed` es la REFERENCIA EJECUTABLE: las pruebas de cada generador comparan contra ella.

import { DECIMAL_PRECISION } from './constraints.js';
import { INVARIANT_VIOLATED, isStructuredComputed } from './entity-checks.js';

/** Los límites de un entero exacto: el `int` de 32 bits y el `long` de 64, los de los cuatro lenguajes. */
export const INTEGER_LIMITS = Object.freeze({
  int: Object.freeze({ min: -(2n ** 31n), max: 2n ** 31n - 1n }),
  long: Object.freeze({ min: -(2n ** 63n), max: 2n ** 63n - 1n })
});

/**
 * El derivado de un campo de `entityName`, resuelto, o null si su `computed` es prosa (o no tiene):
 * `{ kind: 'sum'|'count', relation, child, field, times, base, scale }`. `field` y `times` son campos de la hija `child`;
 * `base` es el tipo del resultado (`int`, `long` o `decimal`) y `scale` su escala, null fuera de un decimal.
 * crossrefs (CHK-DOMAIN-COMPUTED-PATH) ya garantizó que la ruta existe y es numérica.
 */
export function computedSpec(domain, entityName, fieldName) {
  const entity = domain?.entities?.[entityName];
  const field = entity?.fields?.[fieldName];
  if (!field || !isStructuredComputed(field.computed)) return null;
  const spec = field.computed;
  const [relation, childField] = spec.sum !== undefined ? spec.sum.split('.') : [spec.count, null];
  const child = entity.relations?.[relation]?.entity ?? null;
  const named = domain.types?.[field.type];
  const base = named?.base ?? field.type;
  const scale = base === 'decimal' ? ({ ...(named?.constraints ?? {}), ...(field.constraints ?? {}) }.scale ?? null) : null;
  return Object.freeze({
    kind: spec.sum !== undefined ? 'sum' : 'count',
    relation,
    child,
    field: childField,
    times: spec.times ?? null,
    base,
    scale
  });
}

/** Los derivados estructurados de una entidad, por campo: `[{ fieldName, spec }]`, en el orden del diseño. */
export function computedFieldsOf(domain, entityName) {
  return Object.keys(domain?.entities?.[entityName]?.fields ?? {})
    .map((fieldName) => ({ fieldName, spec: computedSpec(domain, entityName, fieldName) }))
    .filter(({ spec }) => spec !== null);
}

// ─── La aritmética de D5 ─────────────────────────────────────────────────────
//
// Exacta hasta el final y un solo redondeo, HALF_UP, a la escala del campo. Redondear línea a línea daría otro céntimo
// (0.0050 + 0.0050 es 0.01, no 0.02), y HALF_EVEN otro más (2.465 es 2.47, no 2.46). Un decimal desborda cuando su
// parte entera no cabe en la columna (DECIMAL_PRECISION − scale dígitos), un entero cuando sale de su tipo: los dos son
// INVARIANT_VIOLATED, como una cota rota por el servidor.

/** Un decimal exacto: `{ units, scale }`, con `units` un BigInt (`1.25` es `{ units: 125n, scale: 2 }`). */
export function parseDecimal(value) {
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`computed: '${value}' no es un número decimal`);
  const fraction = match[3] ?? '';
  const units = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  return { units, scale: fraction.length };
}

/** `{ units, scale }` llevado a `scale` sin perder nada (solo hacia arriba). */
function widen(decimal, scale) {
  return decimal.units * 10n ** BigInt(scale - decimal.scale);
}

/** Redondea `{ units, scale }` a `target` decimales con HALF_UP (la mitad se aleja del cero), o la de `rounding`. */
export function roundDecimal({ units, scale }, target, rounding = 'HALF_UP') {
  if (scale <= target) return { units: units * 10n ** BigInt(target - scale), scale: target };
  const divisor = 10n ** BigInt(scale - target);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  let quotient = magnitude / divisor;
  const twice = (magnitude % divisor) * 2n;
  if (twice > divisor || (twice === divisor && (rounding === 'HALF_UP' || quotient % 2n === 1n))) quotient += 1n;
  return { units: negative ? -quotient : quotient, scale: target };
}

/** El texto canónico de un decimal: con exactamente su escala (`2.40`), que es como lo compara cualquier prueba. */
export function formatDecimal({ units, scale }) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** Compara dos decimales exactos: −1, 0 o 1. */
export function compareDecimals(a, b) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  const x = widen(left, scale);
  const y = widen(right, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

const isAbsent = (value) => value === null || value === undefined;

/**
 * El valor de un derivado sobre `children` (los estados de las hijas, con los nombres del diseño), o el desbordamiento:
 * `{ value }` o `{ error: INVARIANT_VIOLATED }`. `value` es un número para `int`/`long` (BigInt si no cabe en uno de JS)
 * y el texto canónico con su escala para un `decimal`. Una hija con el sumando o el factor ausente aporta cero, como
 * `SUM` en SQL. `sabotage` deja falsar la referencia (COMPUTED_SABOTAGES con `reference: true`).
 */
export function evaluateComputed(spec, children = [], { sabotage = null } = {}) {
  if (spec.kind === 'count') return integerResult(spec.base, BigInt(children.length));
  const lines = children.map((child) => {
    const amount = child?.[spec.field];
    const factor = spec.times === null ? 1 : child?.[spec.times];
    if (isAbsent(amount) || isAbsent(factor)) return { units: 0n, scale: 0 };
    const left = parseDecimal(amount);
    const right = parseDecimal(factor);
    return { units: left.units * right.units, scale: left.scale + right.scale };
  });
  if (spec.base !== 'decimal') {
    // Un sumando entero sobre un entero: exacto, sin escala.
    const total = lines.reduce((sum, line) => sum + line.units / 10n ** BigInt(line.scale), 0n);
    return integerResult(spec.base, total);
  }
  const target = spec.scale ?? 0;
  const rounding = sabotage === 'cp-half-even' ? 'HALF_EVEN' : 'HALF_UP';
  const scaled = sabotage === 'cp-round-each' ? lines.map((line) => roundDecimal(line, target, rounding)) : lines;
  const scale = Math.max(target, ...scaled.map((line) => line.scale));
  const exact = { units: scaled.reduce((sum, line) => sum + widen(line, scale), 0n), scale };
  const total = roundDecimal(exact, target, rounding);
  const integerDigits = (total.units < 0n ? -total.units : total.units).toString().length - target;
  if (sabotage !== 'cp-no-overflow' && integerDigits > DECIMAL_PRECISION - target) return { error: INVARIANT_VIOLATED };
  return { value: formatDecimal(total) };
}

function integerResult(base, total) {
  const limits = INTEGER_LIMITS[base] ?? INTEGER_LIMITS.long;
  if (total < limits.min || total > limits.max) return { error: INVARIANT_VIOLATED };
  return { value: total >= BigInt(Number.MIN_SAFE_INTEGER) && total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total };
}

// ─── Lo que lee el agente ────────────────────────────────────────────────────

/** La nota del handler de una operación que escribe una entidad con derivados, o null. La misma en los cuatro. */
export function computedHandlerNote(domain, entityName) {
  return computedNoteOf(entityName, computedFieldsOf(domain, entityName));
}

/** La misma nota desde los derivados ya resueltos: `[{ fieldName, spec }]`. */
export function computedNoteOf(entityName, fields) {
  if (fields.length === 0) return null;
  const list = fields.map(({ fieldName, spec }) => `${fieldName} (${spec.kind === 'count' ? `count de ${spec.relation}` : `sum de ${spec.relation}.${spec.field}${spec.times ? ` × ${spec.times}` : ''}`})`);
  return (
    `${entityName} tiene derivados que calcula la entidad desde sus hijas: ${list.join(', ')}. No los asignes ni los ` +
    'leas del mensaje: los recalcula el getter que build emite y los persiste el save. Un desbordamiento es INVARIANT_VIOLATED.'
  );
}

// ─── Lo que se mide ──────────────────────────────────────────────────────────

/** Los casos del derivado. Los vectores concretos, sobre el sujeto de entity-check-designs.js, los comparten las redes. */
export const COMPUTED_CASES = Object.freeze([
  { id: 'CP-1', what: 'count cuenta las hijas del agregado: cero sin ninguna' },
  { id: 'CP-2', what: 'sum × times es exacto y redondea UNA vez, HALF_UP, a la escala del campo' },
  { id: 'CP-3', what: 'una hija con el sumando o el factor ausente aporta cero' },
  { id: 'CP-4', what: 'un resultado que no cabe en la columna es INVARIANT_VIOLATED (422) y no se guarda nada' },
  { id: 'CP-5', what: 'el save persiste el valor recalculado: leído de vuelta es el de la referencia, también tras quitar una hija' }
]);

/** Los sabotajes del derivado. `reference: true` los sabe aplicar evaluateComputed, y el test de keel-core los falsa. */
export const COMPUTED_SABOTAGES = Object.freeze({
  'cp-round-each': { breaks: ['CP-2'], reference: true, what: 'redondea cada línea antes de sumar' },
  'cp-half-even': { breaks: ['CP-2'], reference: true, what: 'redondea la mitad al par' },
  'cp-no-overflow': { breaks: ['CP-4'], reference: true, what: 'no comprueba que el resultado quepa' },
  'cp-stale': { breaks: ['CP-5'], reference: false, what: 'el save persiste el valor que la entidad traía, sin recalcular' }
});
