// El CONTRATO DEL CABLE en el proyecto Nest (keel-core/gen/wire.js): los tipos que lo sostienen,
// el lector y el serializador JSON, y la prueba que los ejecuta contra los casos compartidos.
//
// Qué no puede hacer JavaScript a pelo y aquí se resuelve:
//   · `JSON.parse` convierte 2.50 en 2.5 y 9007199254740993 en 9007199254740992. El lector usa el
//     TEXTO FUENTE de cada número (`context.source` del reviver, Node 22+) y lo entrega como
//     `WireNumber`; cada conversor lo lleva a su tipo exacto.
//   · `JSON.stringify` no sabe escribir un decimal con su escala ni un bigint. El serializador usa
//     `JSON.rawJSON` (Node 22+), que emite el texto tal cual.
//   · decimal.js normaliza (2.50 → 2.5), así que `Decimal` lleva su ESCALA aparte, con la semántica
//     de `BigDecimal`: es lo que hace que el mismo diseño responda lo mismo en Spring y en Nest.
//
// Dónde vive cada pieza, respetando la frontera hexagonal:
//   · `Decimal` y `RawJson` en `domain/support`: son valores del dominio, y no importan framework;
//   · el lector, los conversores, el serializador y la marca de omitir nulos en
//     `application/support/wire.ts`: TypeScript puro, los usan los DTO y la infraestructura;
//   · la infraestructura (`http-platform.ts`) solo los conecta a Fastify.

import { WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS } from 'keel-core/gen/wire';

export const DECIMAL_TS = 'src/domain/support/decimal.ts';
export const RAW_JSON_TS = 'src/domain/support/raw-json.ts';
export const WIRE_TS = 'src/application/support/wire.ts';

export function generate() {
  return [
    { path: DECIMAL_TS, content: decimalTs() },
    { path: RAW_JSON_TS, content: rawJsonTs() },
    { path: WIRE_TS, content: wireTs() },
    { path: 'src/types/json-source-text.d.ts', content: jsonTypesTs() },
    { path: 'test/wire-contract.test.ts', content: wireContractTestTs() }
  ];
}

function decimalTs() {
  return `import { Decimal as DecimalJs } from 'decimal.js';

/** Modos de redondeo, con los nombres de RoundingMode de BigDecimal: es el vocabulario del diseño. */
export type RoundingMode = 'UP' | 'DOWN' | 'CEILING' | 'FLOOR' | 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN';

const ROUNDING: Record<RoundingMode, DecimalJs.Rounding> = {
  UP: DecimalJs.ROUND_UP,
  DOWN: DecimalJs.ROUND_DOWN,
  CEILING: DecimalJs.ROUND_CEIL,
  FLOOR: DecimalJs.ROUND_FLOOR,
  HALF_UP: DecimalJs.ROUND_HALF_UP,
  HALF_DOWN: DecimalJs.ROUND_HALF_DOWN,
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN
};

const LITERAL = /^[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?$/;

/**
 * Un decimal EXACTO con su escala, con la semántica de BigDecimal.
 *
 * Todo importe, tasa o cálculo con decimales del diseño es un \`Decimal\`, nunca un \`number\`: un
 * \`number\` es binario y no representa exactamente 0.1. Y la escala es contrato observable —2.50
 * sale 2.50, no 2.5—, así que se conserva: la suma toma la mayor de las dos, el producto la suma de
 * las dos, y la división exige escala y modo de redondeo explícitos.
 */
export class Decimal {
  private constructor(
    private readonly value: DecimalJs,
    /** Dígitos tras el punto con los que se escribe. Nunca negativa: 1E+3 es 1000. */
    readonly scale: number
  ) {}

  /** Lee un literal decimal exacto: \`2.50\`, \`-0.5\`, \`1E-7\`. Lanza si no lo es. */
  static parse(text: string): Decimal {
    const trimmed = text.trim();
    if (!LITERAL.test(trimmed)) throw new RangeError(\`'\${text}' no es un decimal\`);
    const [mantissa, exponent = '0'] = trimmed.toLowerCase().split('e');
    const fraction = mantissa!.includes('.') ? mantissa!.split('.')[1]!.length : 0;
    return new Decimal(new DecimalJs(trimmed), Math.max(0, fraction - Number(exponent)));
  }

  static of(value: string | number | bigint | Decimal): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(new DecimalJs(value.toString()), 0);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(\`'\${value}' no es un decimal\`);
      return Decimal.parse(String(value));
    }
    return Decimal.parse(value);
  }

  /** Notación plana con exactamente \`scale\` decimales: es la forma del cable. */
  toString(): string {
    return this.value.toFixed(this.scale);
  }

  /** La misma cantidad con otra escala; si pierde dígitos, con el redondeo indicado. */
  setScale(scale: number, rounding: RoundingMode = 'HALF_UP'): Decimal {
    return new Decimal(this.value.toDecimalPlaces(scale, ROUNDING[rounding]), scale);
  }

  plus(other: Decimal): Decimal {
    return new Decimal(this.value.plus(other.value), Math.max(this.scale, other.scale));
  }

  minus(other: Decimal): Decimal {
    return new Decimal(this.value.minus(other.value), Math.max(this.scale, other.scale));
  }

  times(other: Decimal): Decimal {
    return new Decimal(this.value.times(other.value), this.scale + other.scale);
  }

  /** División con escala y redondeo EXPLÍCITOS: un cociente no tiene una escala natural. */
  dividedBy(other: Decimal, scale: number, rounding: RoundingMode): Decimal {
    if (other.value.isZero()) throw new RangeError('división por cero');
    return new Decimal(this.value.dividedBy(other.value).toDecimalPlaces(scale, ROUNDING[rounding]), scale);
  }

  negated(): Decimal {
    return new Decimal(this.value.negated(), this.scale);
  }

  /** Compara la CANTIDAD (2.5 y 2.50 son iguales aquí): es la comparación de negocio. */
  compareTo(other: Decimal): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }
}
`;
}

function rawJsonTs() {
  return `/**
 * El valor de un campo \`json\` del diseño: un documento JSON guardado como su texto, que viaja
 * EMBEBIDO en el cable (contrato del cable, regla json-embedded) y no como cadena escapada.
 */
export class RawJson {
  private constructor(readonly text: string) {}

  /** Lanza si el texto no es JSON. */
  static of(text: string): RawJson {
    JSON.parse(text);
    return new RawJson(text);
  }
}
`;
}

function wireTs() {
  return `// El contrato del cable en TypeScript puro (sin framework): el lector exacto, los conversores por
// tipo del DSL, el serializador y la marca de omitir nulos. Lo usan los DTO para leer la entrada y la
// infraestructura HTTP para leer y escribir cuerpos. Los casos que lo prueban son los MISMOS que
// cumple el servidor de keel-spring del mismo diseño (test/wire-contract.test.ts).

import { Decimal } from '../../domain/support/decimal.js';
import { RawJson } from '../../domain/support/raw-json.js';

/** Un número tal como llegó por el cable: su texto exacto. Cada conversor lo lleva a su tipo. */
export class WireNumber {
  constructor(readonly source: string) {}
}

/** Un valor que no es del tipo que el contrato espera: es un 400 de la petición, no un 500. */
export class WireTypeError extends Error {
  constructor(
    readonly type: string,
    message: string
  ) {
    super(message);
    this.name = 'WireTypeError';
  }
}

/** Marca de clase: sus instancias no escriben los campos sin valor (\`conventions.nulls: omit\`). */
export const OMIT_NULLS = Symbol.for('keel.wire.omitNulls');

export function OmitNulls(): ClassDecorator {
  return (target) => {
    Object.defineProperty(target.prototype, OMIT_NULLS, { value: true });
  };
}

// ── Lectura ────────────────────────────────────────────────────────────────────

/**
 * Lee un cuerpo JSON sin perder precisión: cada número llega como \`WireNumber\` con su texto. Rechaza
 * \`__proto__\` y \`constructor.prototype\`: un cuerpo que los trae no tiene uso legítimo y sí uno
 * malicioso en cuanto alguien mezcla el objeto en otro.
 */
export function parseWireJson(text: string): unknown {
  return JSON.parse(text, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if (key === '__proto__' || (key === 'constructor' && isObject(value) && 'prototype' in value)) {
      throw new SyntaxError('El cuerpo contiene una clave no admitida');
    }
    if (typeof value === 'number') return new WireNumber(context?.source ?? String(value));
    return value;
  });
}

const INTEGER = /^-?\\d+$/;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

/** El texto numérico de un valor leído: de un número, o de una cadena (coerción del contrato). */
function numericText(type: string, value: unknown): string {
  if (value instanceof WireNumber) return value.source;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new WireTypeError(type, \`se esperaba un \${type}\`);
}

export function toDecimal(value: unknown): Decimal {
  try {
    return Decimal.parse(numericText('decimal', value));
  } catch (error) {
    if (error instanceof WireTypeError) throw error;
    throw new WireTypeError('decimal', 'se esperaba un decimal');
  }
}

export function toLong(value: unknown): bigint {
  const text = numericText('long', value);
  if (!INTEGER.test(text)) throw new WireTypeError('long', 'se esperaba un entero');
  const result = BigInt(text);
  if (result < LONG_MIN || result > LONG_MAX) throw new WireTypeError('long', 'el entero no cabe en 64 bits');
  return result;
}

export function toInt(value: unknown): number {
  const text = numericText('int', value);
  if (!INTEGER.test(text)) throw new WireTypeError('int', 'se esperaba un entero');
  const result = Number(text);
  if (result < INT_MIN || result > INT_MAX) throw new WireTypeError('int', 'el entero no cabe en 32 bits');
  return result;
}

const TIMESTAMP = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})$/;

/** ISO-8601 con zona, normalizado a UTC; la precisión por debajo del milisegundo se descarta. */
export function toTimestamp(value: unknown): Date {
  const match = typeof value === 'string' ? TIMESTAMP.exec(value) : null;
  if (!match) throw new WireTypeError('timestamp', 'se esperaba un instante ISO-8601 con zona');
  const [, y, mo, d, h, mi, s = '00', fraction = '', zone] = match;
  if (!isCalendarDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new WireTypeError('timestamp', 'el instante no existe');
  }
  const millis = (fraction + '000').slice(0, 3);
  const date = new Date(\`\${y}-\${mo}-\${d}T\${h}:\${mi}:\${s}.\${millis}\${zone}\`);
  if (Number.isNaN(date.getTime())) throw new WireTypeError('timestamp', 'el instante no existe');
  return date;
}

/** Fecha sin hora, \`YYYY-MM-DD\`, que exista en el calendario. */
export function toDate(value: unknown): string {
  const match = typeof value === 'string' ? /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(value) : null;
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new WireTypeError('date', 'se esperaba una fecha YYYY-MM-DD que exista');
  }
  return value as string;
}

/** Un \`json\`: embebido, o como cadena con el documento ya serializado. */
export function toJson(value: unknown): RawJson {
  if (typeof value === 'string') {
    try {
      return RawJson.of(value);
    } catch {
      throw new WireTypeError('json', 'la cadena no contiene un documento JSON');
    }
  }
  if (value === undefined) throw new WireTypeError('json', 'se esperaba un documento JSON');
  return RawJson.of(toWireJson(value));
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ── Escritura ──────────────────────────────────────────────────────────────────

/**
 * Serializa con el contrato del cable: \`Decimal\` con su escala y en notación plana, \`bigint\` con
 * todos sus dígitos, \`Date\` en UTC con tres decimales (lo que hace \`toISOString\`), \`RawJson\`
 * embebido, y sin los nulos de una instancia marcada con \`@OmitNulls()\`.
 */
export function toWireJson(value: unknown): string {
  return JSON.stringify(value, wireReplacer);
}

function wireReplacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Decimal) return JSON.rawJSON(value.toString());
  if (typeof value === 'bigint') return JSON.rawJSON(value.toString());
  if (value instanceof WireNumber) return JSON.rawJSON(value.source);
  // JSON.rawJSON solo admite primitivos: un documento embebido se vuelve a leer, conservando sus números.
  if (value instanceof RawJson) return parseWireJson(value.text);
  if (isObject(value) && (value as Record<PropertyKey, unknown>)[OMIT_NULLS] === true) {
    return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined));
  }
  return value;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
`;
}

function jsonTypesTs() {
  return `// Tipos de las dos piezas de JSON del estándar que usa el contrato del cable y que la librería de
// TypeScript todavía no declara: el texto fuente de cada valor en el reviver de JSON.parse y
// JSON.rawJSON. Las dos existen en Node 22+ (el mínimo de este servicio).

declare global {
  interface JSON {
    parse(text: string, reviver: (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown): unknown;
    rawJSON(text: string): unknown;
  }
}

export {};
`;
}

function wireContractTestTs() {
  const cases = { output: WIRE_OUTPUT_CASES, input: WIRE_INPUT_CASES, rejected: WIRE_REJECTED_INPUTS };
  return `// El contrato del cable, ejecutado. Los casos los genera keel-nest desde keel-core/gen/wire.js, la
// misma fuente contra la que se mide el servidor de keel-spring: si uno de estos falla, este servidor
// y el de Spring del mismo diseño ya no responden igual.

import { Decimal } from '../src/domain/support/decimal.js';
import { RawJson } from '../src/domain/support/raw-json.js';
import {
  OmitNulls,
  WireTypeError,
  parseWireJson,
  toDate,
  toDecimal,
  toInt,
  toJson,
  toLong,
  toTimestamp,
  toWireJson
} from '../src/application/support/wire.js';

interface OutputCase { id: string; rule: string; type: string; value: string; json: string }
interface InputCase { id: string; rule: string; type: string; json: string; roundTrip: string }
interface RejectedCase { id: string; rule: string; type: string; json: string }

const CASES: { output: OutputCase[]; input: InputCase[]; rejected: RejectedCase[] } = ${JSON.stringify(cases, null, 2)};

/** Lee un valor del cable con el tipo del DSL, como lo hará un DTO. */
function read(type: string, value: unknown): unknown {
  switch (type) {
    case 'decimal': return toDecimal(value);
    case 'long': return toLong(value);
    case 'int': return toInt(value);
    case 'timestamp': return toTimestamp(value);
    case 'date': return toDate(value);
    case 'json': return toJson(value);
    default: return value;
  }
}

/** El valor tipado a partir de su literal del DSL. */
function typed(type: string, literal: string): unknown {
  switch (type) {
    case 'decimal': return Decimal.parse(literal);
    case 'long': return BigInt(literal);
    case 'int': return Number(literal);
    case 'boolean': return literal === 'true';
    case 'timestamp': return toTimestamp(literal);
    case 'json': return RawJson.of(literal);
    default: return literal;
  }
}

describe('contrato del cable: salida', () => {
  for (const entry of CASES.output) {
    it(\`\${entry.id}: \${entry.type} \${entry.value} → \${entry.json}\`, () => {
      expect(toWireJson(typed(entry.type, entry.value))).toBe(entry.json);
    });
  }
});

describe('contrato del cable: entrada (ida y vuelta)', () => {
  for (const entry of CASES.input) {
    it(\`\${entry.id}: \${entry.json} → \${entry.roundTrip}\`, () => {
      expect(toWireJson(read(entry.type, parseWireJson(entry.json)))).toBe(entry.roundTrip);
    });
  }
});

describe('contrato del cable: entrada rechazada', () => {
  for (const entry of CASES.rejected) {
    it(\`\${entry.id}: \${entry.type} \${entry.json} se rechaza\`, () => {
      expect(() => read(entry.type, parseWireJson(entry.json))).toThrow(WireTypeError);
    });
  }
});

describe('contrato del cable: nulos y seguridad del lector', () => {
  it('por defecto un campo sin valor viaja como null', () => {
    expect(toWireJson({ a: 1n, b: null })).toBe('{"a":1,"b":null}');
  });

  it('una instancia marcada con @OmitNulls no los escribe', () => {
    @OmitNulls()
    class Omitting {
      constructor(readonly a: bigint, readonly b: string | null) {}
    }
    expect(toWireJson(new Omitting(1n, null))).toBe('{"a":1}');
  });

  it('un cuerpo con __proto__ se rechaza', () => {
    expect(() => parseWireJson('{"__proto__":{"x":1}}')).toThrow(SyntaxError);
  });
});

describe('Decimal: escala con la semántica de BigDecimal', () => {
  it('la suma toma la mayor escala y el producto la suma de las dos', () => {
    expect(Decimal.parse('1.5').plus(Decimal.parse('2.25')).toString()).toBe('3.75');
    expect(Decimal.parse('1.50').times(Decimal.parse('2.0')).toString()).toBe('3.000');
  });

  it('la división exige escala y redondeo, y redondea como se le pide', () => {
    expect(Decimal.parse('10').dividedBy(Decimal.parse('3'), 2, 'HALF_UP').toString()).toBe('3.33');
    expect(Decimal.parse('2.5').setScale(0, 'HALF_EVEN').toString()).toBe('2');
    expect(Decimal.parse('2.5').setScale(0, 'HALF_UP').toString()).toBe('3');
  });

  it('compara cantidades, no escalas', () => {
    expect(Decimal.parse('2.5').compareTo(Decimal.parse('2.50'))).toBe(0);
  });
});
`;
}
