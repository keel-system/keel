// Los dos puntos donde se hace cumplir lo que declara un value type (el mismo reparto que keel-spring y
// keel-nest).
//
// COMPUESTO: clase inmutable en Domain/ValueObject, sin nada de persistencia, con TODO lo que su tipo
// declara hecho cumplir en el constructor: presencia, formato, longitud, cotas y —la única que no rechaza
// sino que NORMALIZA— la escala de un decimal. Sin normalizarla, el mismo importe leído de la base y
// construido desde una petición son valores distintos en la igualdad y en cualquier clave natural que los
// use, y el fallo aparece lejos de aquí.
//
// ESCALAR: no tiene clase —se aplana a su primitivo—, así que se le da una: `<Tipo>Format`, con la
// expresión regular del diseño escrita una sola vez y un `Validate` que llama quien normaliza.
//
// Las cotas salen de keel-core/gen/constraints.js vía la proyección: QUÉ se guarda es la misma decisión
// que en los otros dos generadores; aquí solo cambia cómo se escribe.
//
// Dos diferencias de .NET que deciden la forma:
//   · `decimal.Round` no SUBE la escala (2.5 redondeado a 2 decimales sigue siendo 2.5): `Decimals.SetScale`
//     la sube sumando un cero con la escala pedida, que es lo que hace `setScale` de BigDecimal;
//   · `$` casa también antes de un salto de línea final: la expresión se ancla con `\z`, que es el valor
//     ENTERO, como el `matches()` de Java.

import { csFile, csLocal, csMember, csString, csVerbatim, declType, fieldUsings, located, namespaceOf, xmlDoc } from './render.js';
import { messagesRoundScale } from './services.js';

const VALUE_TYPES = new Set(['int', 'long', 'decimal', 'bool', 'Guid', 'DateOnly', 'DateTimeOffset', 'JsonElement']);

/** ¿Es un tipo por valor de C#? Uno así nunca es null si no se declara con `?`. */
export function isValueType(field) {
  if (field.list) return false;
  return field.kind === 'enum' || VALUE_TYPES.has(field.csType);
}

export function generate(model) {
  const files = (model.formatTypes ?? []).map((type) => formatClass(model, type));
  if ((model.valueObjects ?? []).length > 0) files.push(supportFile(model, 'ValueEquality', valueEqualityBody(), ['System.Collections', 'System.Text.Json']));
  // La escala la normaliza un value object y también un mensaje que redondea su decimal al entrar: un diseño
  // sin value objects puede necesitarla igual (lo destapó la variante payment-checkout-round de cs-check).
  if ((model.valueObjects ?? []).length > 0 || messagesRoundScale(model)) files.push(supportFile(model, 'Decimals', decimalsBody()));
  for (const vo of model.valueObjects ?? []) files.push(valueObject(model, vo));
  return files;
}

function supportFile(model, name, body, usings = []) {
  const { namespace, path } = located(model, 'domainSupport', name);
  return { path, content: csFile({ namespace, usings, body }) };
}

/** El patrón del diseño anclado al valor ENTERO (sus propios `^`/`$` siguen valiendo dentro del grupo). */
function anchored(pattern) {
  return csVerbatim(`^(?:${pattern})\\z`);
}

/** Un literal numérico C# del tipo del campo: `0.01m`, `10L`, `3`. */
function numberLiteral(field, value) {
  if (field.numeric?.decimal || field.csType === 'decimal') return `${value}m`;
  if (field.csType === 'long') return `${value}L`;
  return String(value);
}

function valueObject(model, vo) {
  const { namespace, path } = located(model, 'valueObjects', vo.name);
  const usings = [namespaceOf(model, 'domainSupport'), namespaceOf(model, 'errors')];
  const regexes = [];
  const checks = [];
  for (const field of vo.fields) {
    usings.push(...fieldUsings(model, field));
    const local = csLocal(field.name);
    const label = `${vo.name}.${field.name}`;
    const valueType = isValueType(field);
    const text = field.csType === 'string' ? field.text : null;
    const numeric = field.numeric;
    // La PRESENCIA va primero: un Money sin importe no es un Money. Un tipo por valor no nullable ya la
    // garantiza el compilador; un tipo por referencia, no (el null llega igual en ejecución).
    if (field.required && !valueType) {
      checks.push(`        if (${local} is null)
        {
            throw new InvalidValueException(${csString(`${label} es obligatorio`)});
        }`);
    }
    const optional = !field.required && !field.list;
    const present = optional || (!valueType && !field.required) ? `${local} is not null && ` : '';
    // Un tipo por valor opcional (`decimal?`) se lee con `.Value` tras comprobar que está.
    const value = optional && valueType ? `${local}.Value` : local;
    if (text?.pattern != null) {
      const method = `${csMember(field.name)}Format`;
      regexes.push(`    [GeneratedRegex(${anchored(text.pattern)}, RegexOptions.CultureInvariant)]
    private static partial Regex ${method}();`);
      checks.push(`        if (${present}!${method}().IsMatch(${value}))
        {
            throw new InvalidValueException(${csString(`${label} no cumple el formato declarado por su tipo`)});
        }`);
    }
    for (const [bound, operator, words] of [
      ['minLength', '<', 'más corto que el mínimo'],
      ['maxLength', '>', 'más largo que el máximo']
    ]) {
      if (text?.[bound] == null) continue;
      checks.push(`        if (${present}${value}.Length ${operator} ${text[bound]})
        {
            throw new InvalidValueException(${csString(`${label} es ${words} declarado por su tipo (${text[bound]})`)});
        }`);
    }
    if (!numeric) continue;
    for (const [bound, operator, words] of [
      ['min', '<', 'menor que el mínimo'],
      ['max', '>', 'mayor que el máximo']
    ]) {
      if (numeric[bound] == null) continue;
      checks.push(`        if (${present}${value} ${operator} ${numberLiteral(field, numeric[bound])})
        {
            throw new InvalidValueException(${csString(`${label} es ${words} declarado por su tipo (${numeric[bound]})`)});
        }`);
    }
    // `scalePolicy: reject` (DSL 2.14): los decimales DE MÁS se rechazan antes de normalizar. Se comparan
    // cantidades, no escalas: 19.90 pasa con escala 1 y 19.999 no.
    if (numeric.scale != null && numeric.scalePolicy === 'reject') {
      checks.push(`        if (${present}Decimals.SetScale(${value}, ${numeric.scale}, MidpointRounding.ToZero) != ${value})
        {
            throw new InvalidValueException(${csString(`${label} admite como mucho ${numeric.scale} decimales (scalePolicy: reject)`)});
        }`);
    }
  }

  const params = vo.fields.map((field) => `${declType(field)} ${csLocal(field.name)}`).join(', ');
  const assigns = vo.fields.map((field) => {
    const member = csMember(field.name);
    const local = csLocal(field.name);
    if (field.list) return `        ${member} = [.. ${local}];`;
    if (field.numeric?.decimal && field.numeric.scale != null) {
      // La normalización: lo único de aquí que MODIFICA en vez de rechazar (HALF_UP, como keel-spring).
      return isNullableValue(field)
        ? `        ${member} = ${local} is null ? null : Decimals.SetScale(${local}.Value, ${field.numeric.scale});`
        : `        ${member} = Decimals.SetScale(${local}, ${field.numeric.scale});`;
    }
    return `        ${member} = ${local};`;
  });
  const properties = vo.fields.map((field) => `${xmlDoc(field.description, '    ')}    public ${declType(field)} ${csMember(field.name)} { get; }`);
  const members = vo.fields.map((field) => csMember(field.name));
  const equality = members.length > 0 ? members.map((member) => `ValueEquality.Same(${member}, other.${member})`).join('\n            && ') : 'true';
  if (regexes.length > 0) usings.push('System.Text.RegularExpressions');

  const body = `${xmlDoc(vo.description)}public sealed${regexes.length > 0 ? ' partial' : ''} class ${vo.name} : IEquatable<${vo.name}>
{
${regexes.length > 0 ? `${regexes.join('\n\n')}\n\n` : ''}    public ${vo.name}(${params})
    {
${checks.length > 0 ? `${checks.join('\n')}\n` : ''}${assigns.join('\n')}
    }

${properties.join('\n\n')}

    /// <summary>
    /// Igualdad de VALOR, campo a campo. Un decimal compara también su escala, como el equals de
    /// BigDecimal: por eso el constructor la normaliza.
    /// </summary>
    public bool Equals(${vo.name}? other) =>
        other is not null
            && ${equality};

    public override bool Equals(object? obj) => Equals(obj as ${vo.name});

    public override int GetHashCode() => ValueEquality.Hash(${members.join(', ')});
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function isNullableValue(field) {
  return !field.required && !field.list && isValueType(field);
}

/**
 * La clase de formato de un value type ESCALAR. Tolerante a null y vacío a propósito: si el valor es
 * obligatorio lo dice la regla de negocio, y una guarda que además exigiera presencia rechazaría el vaciado
 * legítimo de un campo opcional.
 */
function formatClass(model, type) {
  const { namespace, path } = located(model, 'valueObjects', type.className);
  const body = `${xmlDoc(`Formato declarado por el value type ${type.name}${type.description ? `: ${type.description}` : '.'}`)}public static partial class ${type.className}
{
    // La expresión del diseño, en un único sitio: quien la vuelva a escribir a mano crea una segunda
    // definición que nadie sincroniza.
    [GeneratedRegex(${anchored(type.pattern)}, RegexOptions.CultureInvariant)]
    private static partial Regex Format();

    /// <summary>
    /// Hace cumplir el formato sobre un valor YA NORMALIZADO. Se llama donde se normaliza (el factory o el
    /// método de negocio de la entidad, o el handler que normaliza antes de entregarlo), nunca sobre lo que
    /// llega del cable: el patrón describe el valor normalizado, y comprobarlo antes rechaza peticiones
    /// válidas. No aplica a null ni a vacío: la presencia la decide la regla de negocio.
    /// </summary>
    public static void Validate(string? value)
    {
        if (!Matches(value))
        {
            throw new ValueFormatException(${csString(`El valor no cumple el formato declarado por ${type.name}`)});
        }
    }

    /// <summary>El mismo juicio sin lanzar, para quien tenga que decidir en vez de rechazar.</summary>
    public static bool Matches(string? value) => string.IsNullOrWhiteSpace(value) || Format().IsMatch(value);
}`;
  return { path, content: csFile({ namespace, usings: ['System.Text.RegularExpressions', namespaceOf(model, 'errors')], body }) };
}

function valueEqualityBody() {
  return `/// <summary>
/// Igualdad de VALOR para los campos de un value object: lo que en Java da el equals de un record.
/// </summary>
/// <remarks>
/// Un decimal compara cantidad Y escala, como BigDecimal.equals: 12.5 y 12.50 son valores distintos, y por
/// eso el constructor del value object normaliza la escala antes de guardar. Un <c>json</c> se compara por
/// contenido; una lista, elemento a elemento; un value object anidado, con su propio Equals.
/// </remarks>
public static class ValueEquality
{
    public static bool Same(object? a, object? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }
        if (a is null || b is null)
        {
            return false;
        }
        return (a, b) switch
        {
            (decimal x, decimal y) => x == y && x.Scale == y.Scale,
            (JsonElement x, JsonElement y) => JsonElement.DeepEquals(x, y),
            (string x, string y) => string.Equals(x, y, StringComparison.Ordinal),
            (IEnumerable x, IEnumerable y) => SameItems(x, y),
            _ => a.Equals(b)
        };
    }

    /// <summary>Un hash coherente con <see cref="Same"/>: dos valores iguales dan el mismo.</summary>
    public static int Hash(params object?[] values)
    {
        var hash = new HashCode();
        foreach (var value in values)
        {
            hash.Add(HashOf(value));
        }
        return hash.ToHashCode();
    }

    private static int HashOf(object? value) => value switch
    {
        null => 0,
        JsonElement element => element.ValueKind.GetHashCode(),
        string text => text.GetHashCode(StringComparison.Ordinal),
        IEnumerable items => items.Cast<object?>().Aggregate(17, (hash, item) => unchecked((hash * 31) + HashOf(item))),
        _ => value.GetHashCode()
    };

    private static bool SameItems(IEnumerable a, IEnumerable b)
    {
        var left = a.GetEnumerator();
        var right = b.GetEnumerator();
        while (true)
        {
            var hasLeft = left.MoveNext();
            if (hasLeft != right.MoveNext())
            {
                return false;
            }
            if (!hasLeft)
            {
                return true;
            }
            if (!Same(left.Current, right.Current))
            {
                return false;
            }
        }
    }
}`;
}

function decimalsBody() {
  return `/// <summary>La escala de un decimal con la semántica de BigDecimal.setScale.</summary>
public static class Decimals
{
    /// <summary>
    /// La misma cantidad con exactamente <paramref name="scale"/> decimales. Si sobran, se redondea con
    /// <paramref name="rounding"/> (por defecto, la mitad hacia arriba en magnitud: el HALF_UP de Java); si
    /// faltan, se completan con ceros. <c>decimal.Round</c> solo hace lo primero: 2.5 redondeado a dos
    /// decimales sigue siendo 2.5, y la escala es contrato del cable.
    /// </summary>
    public static decimal SetScale(decimal value, int scale, MidpointRounding rounding = MidpointRounding.AwayFromZero)
    {
        var rounded = decimal.Round(value, scale, rounding);
        // Sumar un cero con la escala pedida sube la escala del resultado sin cambiar la cantidad.
        return rounded + new decimal(0, 0, 0, false, (byte)scale);
    }
}`;
}
