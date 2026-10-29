// Los dos puntos donde se hace cumplir lo que declara un value type (el mismo reparto que keel-spring, keel-nest
// y keel-dotnet).
//
// COMPUESTO: un struct inmutable con los campos sin exportar, que solo se construye con `NewX(...) (X, error)`.
// El constructor hace cumplir TODO lo que su tipo declara —formato, longitud, cotas y, la única que no rechaza
// sino que NORMALIZA, la escala de un decimal—. Sin normalizarla, el mismo importe leído de la base y construido
// desde una petición son valores distintos en la igualdad y en cualquier clave natural que los use, y el fallo
// aparece lejos de aquí. Viaja por el cable con sus campos en el orden del diseño, y al leerlo pasa por el mismo
// constructor: lo que llega cumple su tipo, como el constructor compacto del record de keel-spring.
//
// La PRESENCIA no se comprueba: en Go un campo obligatorio es un valor (no puede ser nil) y uno opcional es un
// puntero. Lo que en los otros tres es un null que llega igual en ejecución aquí no compila.
//
// ESCALAR: no tiene tipo —se aplana a su primitivo—, así que se le da una variable: `<Tipo>Format`, con la
// expresión regular del diseño escrita una sola vez y su `Validate`, que llama quien normaliza.
//
// Las cotas salen de keel-core/gen/constraints.js vía la proyección: QUÉ se guarda es la misma decisión que en
// los otros tres; aquí solo cambia cómo se escribe. La expresión es RE2, donde `$` ya es el final del texto (el
// `\z` que keel-dotnet tiene que escribir).

import { goExported, goUnexported } from '../lib/go-projection.js';
import { alignRows, goString, keyedLiteral } from '../lib/go-source.js';
import { entitiesClonePointers } from './entities.js';
import { declType, docComment, domainPath, fieldImports, formatString, goFileName, isOptional, layout, localName, packageFile } from './render.js';

export function generate(model) {
  const { domain } = layout(model);
  const files = [];
  const formats = model.formatTypes ?? [];
  if (formats.length > 0) files.push({ path: domainPath(model, 'format'), content: packageFile(model, domain, { imports: ['strings', 'regexp'], body: formatBody() }) });
  for (const type of formats) {
    files.push({ path: `${domain.dir}/${goFileName(type.className)}.go`, content: packageFile(model, domain, { imports: ['regexp'], body: formatVar(type) }) });
  }
  const valueObjects = model.valueObjects ?? [];
  const helpers = new Set();
  for (const vo of valueObjects) files.push(valueObject(model, vo, helpers));
  if (entitiesClonePointers(model)) helpers.add('clonePtr');
  if (helpers.size > 0) files.push({ path: domainPath(model, 'equality'), content: packageFile(model, domain, { imports: [], body: helperBody(helpers) }) });
  return files;
}

/** El patrón del diseño anclado al valor ENTERO (sus propios `^`/`$` siguen valiendo dentro del grupo). */
export function anchored(pattern) {
  const text = `^(?:${pattern})$`;
  return text.includes('`') ? goString(text) : `\`${text}\``;
}

function formatBody() {
  return `
// Format es el formato declarado por un value type escalar: la expresión regular del diseño, escrita en un solo
// sitio. Quien la vuelva a escribir a mano crea una segunda definición que nadie sincroniza.
type Format struct {
	name    string
	pattern *regexp.Regexp
}

// Validate hace cumplir el formato sobre un valor YA NORMALIZADO. Se llama donde se normaliza (el constructor o
// el método de negocio de la entidad, o el caso de uso que normaliza antes de entregarlo), nunca sobre lo que
// llega del cable: el patrón describe el valor normalizado, y comprobarlo antes rechaza peticiones válidas. No
// aplica a un valor vacío: la presencia la decide la regla de negocio.
func (f Format) Validate(value string) error {
	if !f.Matches(value) {
		return Errorf(ErrValueFormat, "El valor no cumple el formato declarado por %s", f.name)
	}
	return nil
}

// Matches es el mismo juicio sin error, para quien tenga que decidir en vez de rechazar.
func (f Format) Matches(value string) bool {
	return strings.TrimSpace(value) == "" || f.pattern.MatchString(value)
}
`;
}

function formatVar(type) {
  return `
${docComment(type.className, `formato declarado por el value type ${type.name}${type.description ? `: ${type.description}` : '.'}`)}var ${type.className} = Format{name: ${goString(type.name)}, pattern: regexp.MustCompile(${anchored(type.pattern)})}
`;
}

// Los tipos que se comparan con == en Go (y por eso con slices.Equal en una lista).
const COMPARABLE = new Set(['string', 'int32', 'int64', 'bool', 'uuid.UUID', 'wire.Date']);

function elementType(field) {
  return field.list ? field.goType.slice(2) : field.goType;
}

/** La función que compara dos valores del tipo del campo, o null si basta `==`. */
function equalFunc(field, type) {
  if (field.kind === 'enum' || COMPARABLE.has(type)) return null;
  if (type === 'wire.Decimal') return 'wire.Decimal.Equal';
  if (type === 'time.Time') return 'time.Time.Equal';
  if (type === 'jsontext.Value') return `func(a, b jsontext.Value) bool { return bytes.Equal(a, b) }`;
  return `${type}.Equal`;
}

/** La expresión que compara el campo de dos value objects (`m` y `other`). */
function equalExpr(field, member, helpers) {
  const type = elementType(field);
  const fn = equalFunc(field, type);
  const [a, b] = [`v.${member}`, `other.${member}`];
  if (field.list) return fn ? `slices.EqualFunc(${a}, ${b}, ${fn})` : `slices.Equal(${a}, ${b})`;
  if (isOptional(field)) {
    if (fn) {
      helpers.add('samePtr');
      return `samePtr(${a}, ${b}, ${fn})`;
    }
    helpers.add('samePtr');
    helpers.add('equal');
    return `samePtr(${a}, ${b}, equal[${type}])`;
  }
  if (!fn) return `${a} == ${b}`;
  if (type === 'jsontext.Value') return `bytes.Equal(${a}, ${b})`;
  return `${a}.Equal(${b})`;
}

/** Un literal numérico del tipo del campo para comparar: `wire.MustDecimal("0.01")` o `10`. */
function bound(field, value) {
  return field.goType === 'wire.Decimal' || field.goType === '[]wire.Decimal' ? `wire.MustDecimal(${goString(String(value))})` : String(value);
}

const RESERVED_METHODS = new Set(['Equal', 'MarshalJSONTo', 'UnmarshalJSONFrom']);

function valueObject(model, vo, helpers) {
  const { domain } = layout(model);
  const imports = ['regexp', 'slices', 'bytes', 'unicode/utf8', 'encoding/json/v2', 'encoding/json/jsontext', 'time', 'internal/platform/wire'];
  const patterns = [];
  const checks = [];
  const normalize = [];
  const prefix = goUnexported(vo.name);
  const fields = vo.fields.map((field) => ({ field, member: localName(field.name), local: localName(field.name), method: goExported(field.name) }));
  for (const { method } of fields) {
    if (RESERVED_METHODS.has(method)) throw new Error(`value object ${vo.name}: el campo ${method} choca con un método del tipo en Go; renómbralo en el diseño`);
  }
  for (const { field, local } of fields) {
    imports.push(...fieldImports(field));
    const label = `${vo.name}.${field.name}`;
    const reject = (condition, message) =>
      checks.push(`\tif ${condition} {\n\t\treturn ${vo.name}{}, Errorf(ErrInvalidValue, ${formatString(`${label} ${message}`)})\n\t}`);
    // Las cotas son de un valor: una lista no las lleva aquí (las de sus elementos las juzga el lector de entrada).
    if (field.list) continue;
    const optional = isOptional(field);
    const value = optional ? `*${local}` : local;
    const when = (condition) => (optional ? `${local} != nil && ${condition}` : condition);
    const text = field.goType === 'string' ? field.text : null;
    if (text?.pattern != null) {
      const variable = `${prefix}${goExported(field.name)}Pattern`;
      patterns.push(`var ${variable} = regexp.MustCompile(${anchored(text.pattern)})`);
      reject(when(`!${variable}.MatchString(${value})`), 'no cumple el formato declarado por su tipo');
    }
    if (text?.minLength != null) reject(when(`utf8.RuneCountInString(${value}) < ${text.minLength}`), `es más corto que el mínimo declarado por su tipo (${text.minLength})`);
    if (text?.maxLength != null) reject(when(`utf8.RuneCountInString(${value}) > ${text.maxLength}`), `es más largo que el máximo declarado por su tipo (${text.maxLength})`);
    const numeric = field.numeric;
    if (!numeric) continue;
    const decimal = field.goType === 'wire.Decimal';
    for (const [key, operator, words] of [
      ['min', '<', 'menor que el mínimo'],
      ['max', '>', 'mayor que el máximo']
    ]) {
      if (numeric[key] == null) continue;
      const condition = decimal ? `${value}.Cmp(${bound(field, numeric[key])}) ${operator} 0` : `${value} ${operator} ${bound(field, numeric[key])}`;
      reject(when(condition), `es ${words} declarado por su tipo (${numeric[key]})`);
    }
    if (!decimal || numeric.scale == null) continue;
    // `scalePolicy: reject` (DSL 2.14): los decimales DE MÁS se rechazan antes de normalizar. Se comparan
    // cantidades, no escalas: 19.90 pasa con escala 1 y 19.999 no.
    if (numeric.scalePolicy === 'reject') {
      reject(when(`${value}.Rescale(${numeric.scale}, wire.RoundDown).Cmp(${value}) != 0`), `admite como mucho ${numeric.scale} decimales (scalePolicy: reject)`);
    }
    // La normalización: lo único de aquí que MODIFICA en vez de rechazar (HALF_UP, como keel-spring).
    normalize.push(
      optional
        ? `\tif ${local} != nil {\n\t\tscaled := ${local}.Rescale(${numeric.scale}, wire.RoundHalfUp)\n\t\t${local} = &scaled\n\t}`
        : `\t${local} = ${local}.Rescale(${numeric.scale}, wire.RoundHalfUp)`
    );
  }

  const receiver = 'v';
  const struct = alignRows(fields.map(({ field, member }) => ({ indent: '\t', cells: [member, declType(field)] })));
  const params = fields.map(({ field, local }) => `${local} ${declType(field)}`).join(', ');
  // Una lista se copia: quien la entregó no puede cambiarla después por la espalda del valor.
  const assigns = keyed(fields.map(({ field, member, local }) => [member, field.list ? `slices.Clone(${local})` : local]));
  const accessors = fields.map(({ field, member, method }) => {
    const doc = docComment(method, field.description, `el campo ${field.name}`);
    const result = field.list ? `slices.Clone(${receiver}.${member})` : isOptional(field) ? `clonePtr(${receiver}.${member})` : `${receiver}.${member}`;
    if (isOptional(field)) helpers.add('clonePtr');
    return `${doc}func (${receiver} ${vo.name}) ${method}() ${declType(field)} {\n\treturn ${result}\n}`;
  });
  const equality = fields.length > 0 ? fields.map(({ field, member }) => equalExpr(field, member, helpers)).join(` &&\n\t\t`) : 'true';

  // La forma del cable: un struct exportado solo para el JSON, con los nombres y el orden del diseño.
  const omit = Boolean(model.service?.omitNulls);
  const shape = `${prefix}JSON`;
  const shapeRows = alignRows(
    fields.map(({ field }) => ({
      indent: '\t',
      cells: [goExported(field.name), declType(field), `\`json:"${field.wireName ?? field.name}${omit && isOptional(field) ? ',omitzero' : ''}"\``]
    }))
  );
  const toShape = keyed(fields.map(({ field, member }) => [goExported(field.name), `${receiver}.${member}`]), '\t\t');
  const fromShape = fields.map(({ field }) => `in.${goExported(field.name)}`).join(', ');

  const body = `
${patterns.length > 0 ? `// Las expresiones del diseño para los campos con formato, ancladas al valor entero.\n${patterns.join('\n')}\n\n` : ''}${docComment(vo.name, vo.description, `value object ${vo.name} del diseño`)}type ${vo.name} struct {
${struct.join('\n')}
}

// New${vo.name} construye un ${vo.name} y hace cumplir lo que declara su tipo.
func New${vo.name}(${params}) (${vo.name}, error) {
${[...checks, ...normalize].join('\n')}${checks.length + normalize.length > 0 ? '\n' : ''}	return ${vo.name}{
${assigns.join('\n')}
	}, nil
}

${accessors.join('\n\n')}

// Equal es la igualdad de VALOR, campo a campo. Un decimal compara también su escala, como el equals de
// BigDecimal: por eso el constructor la normaliza. go-cmp la usa al comparar.
func (${receiver} ${vo.name}) Equal(other ${vo.name}) bool {
	return ${equality}
}

// ${shape} es la forma del cable de ${vo.name}: sus campos con el nombre y en el orden del diseño.
type ${shape} struct {
${shapeRows.join('\n')}
}

// MarshalJSONTo escribe ${vo.name} con la forma del cable.
func (${receiver} ${vo.name}) MarshalJSONTo(enc *jsontext.Encoder) error {
	return json.MarshalEncode(enc, ${shape}{
${toShape.join('\n')}
	})
}

// UnmarshalJSONFrom lee ${vo.name} y lo construye con New${vo.name}: lo que llega cumple su tipo.
func (${receiver} *${vo.name}) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	var in ${shape}
	if err := json.UnmarshalDecode(dec, &in); err != nil {
		return err
	}
	value, err := New${vo.name}(${fromShape})
	if err != nil {
		return err
	}
	*${receiver} = value
	return nil
}
`;
  return { path: domainPath(model, vo.name), content: packageFile(model, domain, { imports, body }) };
}

/** Los campos de un literal compuesto, alineados como go/printer. */
function keyed(pairs, indent = '\t\t') {
  return keyedLiteral(pairs, indent);
}

function helperBody(helpers) {
  const parts = [];
  if (helpers.has('clonePtr')) {
    parts.push(`// clonePtr devuelve una copia del valor apuntado: quien lo recibe no puede cambiar el original.
func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}`);
  }
  if (helpers.has('samePtr')) {
    parts.push(`// samePtr compara dos opcionales: los dos sin valor, o los dos con valores iguales según eq.
func samePtr[T any](a, b *T, eq func(T, T) bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return eq(*a, *b)
}`);
  }
  if (helpers.has('equal')) {
    parts.push(`// equal es la igualdad de un tipo comparable, como función.
func equal[T comparable](a, b T) bool {
	return a == b
}`);
  }
  return `\n${parts.join('\n\n')}\n`;
}
