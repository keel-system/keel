// Los dos puntos donde se hace cumplir lo que declara un value type (el mismo reparto que keel-spring).
//
// COMPUESTO: clase inmutable en domain/valueobject, sin nada de persistencia, con TODO lo que su
// tipo declara hecho cumplir en el constructor: presencia, formato, longitud, cotas y —la única que
// no rechaza sino que NORMALIZA— la escala de un decimal. Sin normalizarla, el mismo importe leído
// de la base (escala de la columna) y construido desde el cuerpo de una petición son valores
// distintos en `equals` y en cualquier clave natural que los use, y el fallo aparece lejos de aquí.
//
// ESCALAR: no tiene clase —se aplana a su primitivo—, así que se le da una: `<Tipo>Format`, con la
// regex del diseño escrita una sola vez y un `validate` que llama quien normaliza. Sin ella la
// instrucción «hazlo cumplir en la entidad» no tiene destinatario, y una instrucción que no se puede
// seguir no se sigue (keel-spring/src/scaffold/value-types.js cuenta la corrida que lo enseñó).
//
// Las cotas salen de keel-core/gen/constraints.js vía la proyección: QUÉ se guarda es la misma
// decisión que en keel-spring; aquí solo cambia cómo se escribe.

import { DIRS, classPath, declType, fieldImports, tsModule, tsdoc, tsString } from './render.js';
import { INVALID_VALUE_TS, VALUE_FORMAT_TS } from './exceptions.js';

export const VALUE_EQUALS_TS = classPath(DIRS.support, 'ValueEquals');

export function generate(model) {
  const files = (model.formatTypes ?? []).map((type) => formatClass(type));
  if ((model.valueObjects ?? []).length > 0) {
    files.push({ path: VALUE_EQUALS_TS, content: tsModule(VALUE_EQUALS_TS, valueEqualsImports(), valueEqualsBody()) });
  }
  for (const vo of model.valueObjects ?? []) files.push(valueObject(model, vo));
  return files;
}

/** Literal de una RegExp construida desde el texto del diseño, anclada al valor ENTERO. */
function regexLiteral(pattern) {
  // `matches()` de Java exige que case el valor entero; `RegExp.test` busca dentro. El grupo no
  // capturante anclado hace lo mismo sin tocar el patrón del diseño (sus `^`/`$` siguen valiendo).
  return `new RegExp(${tsString(`^(?:${pattern})$`)})`;
}

function constantName(fieldName) {
  return `${fieldName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_FORMAT`;
}

function valueObject(model, vo) {
  const file = classPath(DIRS.valueObjects, vo.name);
  const imports = [{ symbol: 'valueEquals', from: VALUE_EQUALS_TS }];
  for (const field of vo.fields) imports.push(...fieldImports(model, field));

  const constants = [];
  const checks = [];
  for (const field of vo.fields) {
    const { name } = field;
    const label = `${vo.name}.${name}`;
    // Formato y longitud solo sobre texto: es lo único que tiene `length` y que una regex juzga.
    const text = field.tsType === 'string' ? field.text : null;
    const numeric = field.numeric;
    if (!(field.required || text || numeric)) continue;
    // La PRESENCIA va primero: un Money sin importe no es un Money. Exigirla aquí obliga a que
    // quien rehidrata un value object AUSENTE devuelva null en vez de construirlo con nulls.
    if (field.required) {
      checks.push(`    if (${name} == null) {
      throw new InvalidValueException(${tsString(`${label} es obligatorio`)});
    }`);
    }
    // Con la presencia exigida, el `!= null` de lo que sigue sobra; sin ella, un opcional vacío pasa.
    const present = field.required ? '' : `${name} != null && `;
    if (text?.pattern != null) {
      const constant = constantName(name);
      constants.push(`  private static readonly ${constant} = ${regexLiteral(text.pattern)};`);
      checks.push(`    if (${present}!${vo.name}.${constant}.test(${name})) {
      throw new InvalidValueException(${tsString(`${label} no cumple el formato declarado por su tipo`)});
    }`);
    }
    for (const [bound, operator, texto] of [
      ['minLength', '<', 'más corto que el mínimo'],
      ['maxLength', '>', 'más largo que el máximo']
    ]) {
      if (text?.[bound] == null) continue;
      checks.push(`    if (${present}${name}.length ${operator} ${text[bound]}) {
      throw new InvalidValueException(${tsString(`${label} es ${texto} declarado por su tipo (${text[bound]})`)});
    }`);
    }
    if (!numeric) continue;
    for (const [bound, operator, texto] of [
      ['min', '<', 'menor que el mínimo'],
      ['max', '>', 'mayor que el máximo']
    ]) {
      if (numeric[bound] == null) continue;
      // Un Decimal se compara por cantidad con compareTo; un bigint, con un literal bigint.
      const condition = numeric.decimal
        ? `${name}.compareTo(Decimal.parse(${tsString(numeric[bound])})) ${operator} 0`
        : field.tsType === 'bigint'
          ? `${name} ${operator} ${numeric[bound]}n`
          : `${name} ${operator} ${numeric[bound]}`;
      checks.push(`    if (${present}${condition}) {
      throw new InvalidValueException(${tsString(`${label} es ${texto} declarado por su tipo (${numeric[bound]})`)});
    }`);
    }
    if (numeric.scale == null) continue;
    // `scalePolicy: reject` (DSL 2.14): los decimales DE MÁS se rechazan antes de normalizar. Se
    // comparan cantidades, no escalas: `19.90` pasa con escala 1 y `19.999` no.
    if (numeric.scalePolicy === 'reject') {
      checks.push(`    if (${present}${name}.setScale(${numeric.scale}, 'DOWN').compareTo(${name}) !== 0) {
      throw new InvalidValueException(${tsString(`${label} admite como mucho ${numeric.scale} decimales (scalePolicy: reject)`)});
    }`);
    }
  }

  const params = vo.fields.map((field) => `${field.name}: ${declType(field)}`).join(', ');
  const assigns = vo.fields.map((field) => {
    const { name, numeric } = field;
    if (field.list) return `    this.${name} = Object.freeze([...${name}]);`;
    if (numeric?.decimal && numeric.scale != null) {
      // La normalización: lo único de aquí que MODIFICA en vez de rechazar.
      return field.required
        ? `    this.${name} = ${name}.setScale(${numeric.scale}, 'HALF_UP');`
        : `    this.${name} = ${name} == null ? null : ${name}.setScale(${numeric.scale}, 'HALF_UP');`;
    }
    return `    this.${name} = ${name};`;
  });
  if (vo.fields.some((field) => field.numeric?.decimal && field.numeric.min != null) || vo.fields.some((field) => field.numeric?.decimal && field.numeric.max != null)) {
    imports.push({ symbol: 'Decimal', from: 'src/domain/support/decimal.ts' });
  }
  if (checks.length > 0) imports.push({ symbol: 'InvalidValueException', from: INVALID_VALUE_TS });

  const declarations = vo.fields.map((field) => `${tsdoc(field.description, '  ')}  readonly ${field.name}: ${declType(field)};`);
  const equality = vo.fields.length > 0
    ? vo.fields.map((field) => `valueEquals(this.${field.name}, other.${field.name})`).join(' &&\n      ')
    : 'true';
  const body = `${tsdoc(vo.description)}export class ${vo.name} {
${constants.length > 0 ? `${constants.join('\n')}\n\n` : ''}${declarations.join('\n')}

  constructor(${params}) {
${checks.length > 0 ? `${checks.join('\n')}\n` : ''}${assigns.join('\n')}
  }

  /**
   * Igualdad de VALOR, campo a campo. Un decimal compara también su escala, como el equals de
   * BigDecimal: por eso el constructor la normaliza.
   */
  equals(other: ${vo.name} | null | undefined): boolean {
    if (other == null) return false;
    return (
      ${equality}
    );
  }
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

/**
 * Clase de formato de un value type ESCALAR. Tolerante a null/vacío a propósito: si el valor es
 * obligatorio lo dice la regla de negocio, y un guard que además exigiera presencia rechazaría el
 * vaciado legítimo de un campo opcional.
 */
function formatClass(type) {
  const file = classPath(DIRS.valueObjects, type.className);
  const body = `${tsdoc(`Formato declarado por el value type ${type.name}${type.description ? `: ${type.description}` : '.'}`)}export class ${type.className} {
  // La regex del diseño, en un único sitio: quien la vuelva a escribir a mano crea una segunda
  // definición que nadie sincroniza.
  private static readonly FORMAT = ${regexLiteral(type.pattern)};

  private constructor() {}

  /**
   * Hace cumplir el formato sobre un valor YA NORMALIZADO. Se llama donde se normaliza (el factory o
   * el método de negocio de la entidad, o el handler que normaliza antes de entregarlo), nunca sobre
   * lo que llega del cable: el patrón describe el valor normalizado y comprobarlo antes rechaza
   * peticiones válidas.
   *
   * No aplica a null/vacío: la presencia la decide la regla de negocio.
   */
  static validate(value: string | null | undefined): void {
    if (!${type.className}.matches(value)) {
      throw new ValueFormatException(${tsString(`El valor no cumple el formato declarado por ${type.name}`)});
    }
  }

  /** El mismo juicio sin lanzar, para quien tenga que decidir en vez de rechazar. */
  static matches(value: string | null | undefined): boolean {
    return value == null || value.trim() === '' || ${type.className}.FORMAT.test(value);
  }
}`;
  return { path: file, content: tsModule(file, [{ symbol: 'ValueFormatException', from: VALUE_FORMAT_TS }], body) };
}

function valueEqualsImports() {
  return [
    { symbol: 'Decimal', from: 'src/domain/support/decimal.ts' },
    { symbol: 'RawJson', from: 'src/domain/support/raw-json.ts' }
  ];
}

function valueEqualsBody() {
  return `/**
 * Igualdad de VALOR para los campos de un value object: lo que en Java da el equals de un record.
 *
 * Un Decimal compara su TEXTO (cantidad y escala), como BigDecimal.equals: 12.5 y 12.50 son valores
 * distintos, y por eso el constructor del value object normaliza la escala antes de guardar. Una
 * fecha compara su instante; una lista, elemento a elemento; un value object anidado, con su equals.
 */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Decimal && b instanceof Decimal) return a.toString() === b.toString();
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RawJson && b instanceof RawJson) return a.text === b.text;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valueEquals(item, b[index]));
  }
  const equals = (a as { equals?: unknown }).equals;
  return typeof equals === 'function' ? Boolean(equals.call(a, b)) : false;
}`;
}
