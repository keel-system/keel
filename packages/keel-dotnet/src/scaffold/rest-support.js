// La infraestructura REST que no depende de ninguna operación: la correlación, el cuerpo de error, la lectura y
// la validación de una petición y el middleware que traduce cualquier fallo a ErrorResponse. Los endpoints de
// cada operación los emite endpoints.js sobre esto.
//
// El contrato es el del servidor de keel-spring del mismo diseño, el mismo que cumple keel-nest:
//   · la forma y el orden de ErrorResponse los fija keel-core (WIRE_SHAPES.errorResponse); un campo sin valor
//     viaja como null, nunca se omite;
//   · el `error` y el `message` de cada fallo salen de keel-core/gen/api-errors.js, y el `code` de un fallo de
//     forma es VALIDATION_ERROR (FRAMEWORK_ERRORS.validation);
//   · `details` de una validación es «campo mensaje», con los mensajes por defecto de Hibernate Validator en
//     inglés, que es lo que imprime Bean Validation;
//   · una petición que no se puede LEER (JSON roto, un tipo que no encaja, un value object que su constructor
//     rechaza) es 400 «Petición malformada» sin details: en Spring eso es HttpMessageNotReadableException, que
//     no distingue la causa.
//
// Sin FluentValidation ni el enlace de parámetros de las APIs mínimas: cada operación tiene un lector GENERADO
// que convierte y valida en el orden del binding de Spring, con las reglas neutrales de keel-core/gen.

import { WIRE_SHAPES } from 'keel-core/gen/wire';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { FRAMEWORK_RESPONSES as FW, domainErrorResponses } from 'keel-core/gen/api-errors';
import { csFile, csString, located, namespaceOf } from './render.js';
import { wireNamespace } from './wire.js';

/** ¿Expone el servicio una API? Sin capa api, o sin ninguna operación con ruta, no hay nada de esto. */
export function usesApi(model) {
  return Boolean(model.layersPresent?.api) && (model.services ?? []).some((service) => (service.operations ?? []).some((op) => op.route));
}

export function restNamespace(model) {
  return namespaceOf(model, 'rest');
}

export function generate(model) {
  if (!usesApi(model)) return [];
  const rest = (name, usings, body) => {
    const { namespace, path } = located(model, 'rest', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const { namespace: correlationNs, path: correlationPath } = located(model, 'correlation', 'CorrelationContext');
  return [
    { path: correlationPath, content: csFile({ namespace: correlationNs, usings: ['System.Text.RegularExpressions'], body: correlationContextBody() }) },
    rest('CorrelationMiddleware', ['Microsoft.AspNetCore.Http', 'Microsoft.Extensions.Logging', correlationNs], correlationMiddlewareBody()),
    rest('ErrorResponse', ['System.Text.Json.Serialization', correlationNs], errorResponseBody()),
    rest('RequestErrors', [], requestErrorsBody()),
    rest(
      'RequestReading',
      ['System.Globalization', 'System.Reflection', 'System.Text.Json', 'System.Text.Json.Serialization', 'System.Text.RegularExpressions', 'Microsoft.AspNetCore.Http', 'Microsoft.Extensions.Primitives', wireNamespace(model), namespaceOf(model, 'errors')],
      requestReadingBody()
    ),
    rest('InputValidation', ['System.Collections', 'System.Collections.Concurrent', 'System.Globalization', 'System.Text.RegularExpressions'], inputValidationBody()),
    rest('HttpReply', ['System.Globalization', 'System.Text.RegularExpressions', 'Microsoft.AspNetCore.Http', wireNamespace(model)], httpReplyBody()),
    rest(
      'ApiErrorMiddleware',
      ['Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.WebUtilities', 'Microsoft.Extensions.Logging', wireNamespace(model), namespaceOf(model, 'errors')],
      apiErrorMiddlewareBody()
    )
  ];
}

function correlationContextBody() {
  return `/// <summary>
/// Contexto de correlación de la petición o del mensaje en curso: el hilo que une petición HTTP → caso de uso →
/// evento → mensaje saliente, y el valor que lleva ErrorResponse.
/// </summary>
/// <remarks>
/// Vive en un <see cref="AsyncLocal{T}"/>, que es lo que en .NET sigue a una petición a través de sus await (en
/// keel-spring, el ThreadLocal + MDC de CorrelationContext; en keel-nest, un AsyncLocalStorage). Lo abre el
/// middleware de entrada HTTP con <see cref="Open"/>, que devuelve lo que lo cierra.
/// </remarks>
public static partial class CorrelationContext
{
    public const string Header = "X-Correlation-Id";

    private static readonly AsyncLocal<string?> Current = new();

    /// <summary>
    /// Lo que se acepta como correlationId. El valor llega de FUERA y acaba en logs, cabeceras y eventos: sin
    /// cota, un cliente podría meter saltos de línea o kilobytes en cada registro.
    /// </summary>
    [GeneratedRegex(@"^[A-Za-z0-9._-]{1,64}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Accepted();

    /// <summary>
    /// El correlationId EFECTIVO para un valor recibido: el mismo si cumple el formato; uno nuevo si no llegó o
    /// no lo cumple. No se trunca: produciría ids que se confunden entre sí.
    /// </summary>
    public static string Accept(string? received) => received is not null && Accepted().IsMatch(received) ? received : Guid.NewGuid().ToString();

    /// <summary>La correlación en curso, o null si no hay ninguna abierta.</summary>
    public static string? Get() => Current.Value;

    /// <summary>Abre la correlación indicada hasta que se libera lo que devuelve.</summary>
    public static IDisposable Open(string correlationId)
    {
        var previous = Current.Value;
        Current.Value = Accept(correlationId);
        return new Restore(previous);
    }

    private sealed class Restore(string? previous) : IDisposable
    {
        public void Dispose() => Current.Value = previous;
    }
}`;
}

function correlationMiddlewareBody() {
  return `/// <summary>
/// La correlación de cada petición: la recibida en <c>X-Correlation-Id</c> si cumple el formato, o una nueva. Vuelve
/// en la cabecera de la respuesta, va en el cuerpo de error y en el ámbito de cada log de la petición.
/// </summary>
public sealed class CorrelationMiddleware(RequestDelegate next, ILogger<CorrelationMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = CorrelationContext.Accept(context.Request.Headers[CorrelationContext.Header].FirstOrDefault());
        context.Response.Headers[CorrelationContext.Header] = correlationId;
        using (CorrelationContext.Open(correlationId))
        using (logger.BeginScope(new Dictionary<string, object> { ["correlationId"] = correlationId }))
        {
            await next(context);
        }
    }
}`;
}

function errorResponseBody() {
  const types = {
    timestamp: 'DateTimeOffset',
    status: 'int',
    error: 'string',
    code: 'string?',
    message: 'string',
    details: 'IReadOnlyList<string>?',
    correlationId: 'string?'
  };
  const missing = WIRE_SHAPES.errorResponse.filter((name) => !types[name]);
  if (missing.length > 0) throw new Error(`ErrorResponse: el contrato del cable nombra ${missing.join(', ')} y keel-dotnet no lo emite`);
  const member = (name) => name[0].toUpperCase() + name.slice(1);
  const properties = WIRE_SHAPES.errorResponse.map(
    (name) => `    [JsonPropertyName(${csString(name)})]\n    public required ${types[name]} ${member(name)} { get; init; }`
  );
  return `/// <summary>
/// Contrato de error de la API: el cuerpo uniforme de todo fallo, con la forma y el orden del cable (keel-core,
/// WIRE_SHAPES.errorResponse).
/// </summary>
/// <remarks>
/// Los campos sin valor viajan como null (details fuera de una validación, code en un fallo sin código): no se
/// omiten, porque la forma del cuerpo de error es contrato estable. Por eso este tipo no lleva [OmitNulls].
/// </remarks>
public sealed record ErrorResponse
{
${properties.join('\n\n')}

    public static ErrorResponse Of(int status, string error, string? code, string message, IReadOnlyList<string>? details = null) =>
        new()
        {
            Timestamp = DateTimeOffset.UtcNow,
            Status = status,
            Error = error,
            Code = code,
            Message = message,
            Details = details,
            CorrelationId = CorrelationContext.Get()
        };
}`;
}

function requestErrorsBody() {
  const [before, after] = FW.missingParameter.message.split('{name}');
  return `// Los fallos de LECTURA de una petición, antes de que llegue a ningún caso de uso. Los traduce
// ApiErrorMiddleware; no son errores de dominio.

/// <summary>La petición no se puede leer: JSON roto, un tipo que no encaja, un value object inválido.</summary>
public sealed class MalformedRequestException(Exception? cause = null) : Exception(${csString(FW.malformed.message)}, cause);

/// <summary>Falta un parámetro obligatorio de la query.</summary>
public sealed class MissingParameterException(string parameter) : Exception(${csString(before)} + parameter + ${csString(after)})
{
    public string Parameter { get; } = parameter;
}

/// <summary>De dónde sale lo que no supera la validación: en keel-spring, el cuerpo y los parámetros sueltos responden con mensajes distintos.</summary>
public enum ViolationSource
{
    Body,
    Params
}

/// <summary>La petición se leyó pero incumple lo que el diseño declara.</summary>
public sealed class RequestValidationException(IReadOnlyList<string> details, ViolationSource source) : Exception(${csString(FW.invalidBody.message)})
{
    public IReadOnlyList<string> Details { get; } = details;

    public ViolationSource Origin { get; } = source;
}`;
}

function requestReadingBody() {
  return `// Lectura de una petición: convertir lo que llega por el cable al tipo del diseño. Lo usan los lectores que
// genera build para cada operación (Endpoints/). Un valor ausente es null; lo que no se puede convertir es una
// petición malformada.

/// <summary>
/// Lectores de un cuerpo JSON. Los valores se convierten con el contrato del cable (WireJson): un decimal exacto,
/// un instante con zona, un uuid en su forma canónica de 36 caracteres.
/// </summary>
public static class JsonBodyReader
{
    /// <summary>El cuerpo como objeto JSON. Sin cuerpo (o con <c>null</c>): null si es opcional, malformada si es obligatorio.</summary>
    public static async Task<JsonElement?> ReadObject(HttpRequest request, bool required)
    {
        ArgumentNullException.ThrowIfNull(request);
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer, request.HttpContext.RequestAborted);
        JsonElement root;
        if (buffer.Length == 0)
        {
            root = default;
        }
        else
        {
            try
            {
                using var document = JsonDocument.Parse(buffer.ToArray());
                root = document.RootElement.Clone();
            }
            catch (JsonException error)
            {
                throw new MalformedRequestException(error);
            }
        }
        if (root.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            if (required)
            {
                throw new MalformedRequestException();
            }
            return null;
        }
        return root.ValueKind == JsonValueKind.Object ? root : throw new MalformedRequestException();
    }

    /// <summary>¿Viene la propiedad, aunque sea con null? Es lo que distingue «no tocar» de «vaciar» en un PATCH.</summary>
    public static bool Has(JsonElement? fields, string name) => fields is { } value && value.TryGetProperty(name, out _);

    /// <summary>La propiedad del objeto, o null si falta o vale null.</summary>
    public static JsonElement? Property(JsonElement? fields, string name) =>
        fields is { } value && value.TryGetProperty(name, out var property) && property.ValueKind != JsonValueKind.Null ? property : null;

    /// <summary>Un valor del objeto, convertido con el contrato del cable. Para un tipo de valor, pásalo nullable (<c>decimal?</c>).</summary>
    public static T? Value<T>(JsonElement? fields, string name) => Property(fields, name) is { } property ? Element<T>(property) : default;

    /// <summary>Un valor JSON presente, convertido con el contrato del cable: un null aquí es una petición malformada.</summary>
    public static T Element<T>(JsonElement element)
    {
        T? value;
        try
        {
            value = element.Deserialize<T>(WireJson.Options);
        }
        catch (Exception error) when (error is JsonException or NotSupportedException or InvalidOperationException or FormatException or OverflowException)
        {
            throw new MalformedRequestException(error);
        }
        return value is null ? throw new MalformedRequestException() : value;
    }

    /// <summary>Un enum por el LITERAL del diseño, exacto: es lo que escribe el cable.</summary>
    public static T? EnumValue<T>(JsonElement? fields, string name)
        where T : struct, Enum => Property(fields, name) is { } property ? EnumElement<T>(property) : null;

    public static T EnumElement<T>(JsonElement element)
        where T : struct, Enum =>
        element.ValueKind == JsonValueKind.String && EnumLiterals<T>.ByLiteral.TryGetValue(element.GetString()!, out var value)
            ? value
            : throw new MalformedRequestException();

    /// <summary>Una lista: ausente o null es null; algo que no es un array, malformada.</summary>
    public static IReadOnlyList<T>? List<T>(JsonElement? fields, string name, Func<JsonElement, T> element)
    {
        ArgumentNullException.ThrowIfNull(element);
        if (Property(fields, name) is not { } property)
        {
            return null;
        }
        if (property.ValueKind != JsonValueKind.Array)
        {
            throw new MalformedRequestException();
        }
        return [.. property.EnumerateArray().Select(element)];
    }

    /// <summary>
    /// Un value object: un objeto JSON. Si su constructor lo rechaza, la petición es malformada: en keel-spring eso
    /// pasa dentro de Jackson y sale igual.
    /// </summary>
    public static T? ValueObject<T>(JsonElement? value, Func<JsonElement, T> build)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(build);
        if (value is not { } element)
        {
            return null;
        }
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new MalformedRequestException();
        }
        try
        {
            return build(element);
        }
        catch (DomainException error)
        {
            throw new MalformedRequestException(error);
        }
    }

    /// <summary>Lo que el diseño exige y no llegó: una petición que no se puede leer.</summary>
    public static T Present<T>(T? value)
        where T : class => value ?? throw new MalformedRequestException();

    /// <summary>Lo que el diseño exige y no llegó, para un tipo de valor.</summary>
    public static T PresentValue<T>(T? value)
        where T : struct => value ?? throw new MalformedRequestException();
}

/// <summary>
/// Lectores de un valor de TEXTO (ruta y query), con las conversiones de Spring: un booleano admite true/false,
/// yes/no, on/off y 1/0; un enum, su literal o el nombre de la constante sin distinguir mayúsculas ni guiones; un
/// uuid, lo que admite UUID.fromString de Java. Vacío es «sin valor».
/// </summary>
public static partial class TextValues
{
    [GeneratedRegex(@"^[+-]?[0-9]+\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Integer();

    [GeneratedRegex(@"^[0-9a-fA-F]+\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Hex();

    /// <summary>El valor de un segmento de la ruta.</summary>
    public static StringValues Route(HttpRequest request, string name)
    {
        ArgumentNullException.ThrowIfNull(request);
        return new StringValues(request.RouteValues[name] as string);
    }

    /// <summary>Un parámetro obligatorio de la query tiene que venir; vacío cuenta como presente (lo juzga su regla).</summary>
    public static void Require(HttpRequest request, string name)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.Query.ContainsKey(name))
        {
            throw new MissingParameterException(name);
        }
    }

    /// <summary>Un parámetro repetido donde se espera uno solo: Spring toma el primero.</summary>
    private static string? First(StringValues values) => values.Count == 0 ? null : values[0];

    private static string? NonBlank(StringValues values) => First(values) is { } raw && !string.IsNullOrWhiteSpace(raw) ? raw : null;

    public static string? String(StringValues values) => First(values);

    public static int? Int(StringValues values)
    {
        if (NonBlank(values) is not { } raw)
        {
            return null;
        }
        return Integer().IsMatch(raw) && int.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value)
            ? value
            : throw new MalformedRequestException();
    }

    public static long? Long(StringValues values)
    {
        if (NonBlank(values) is not { } raw)
        {
            return null;
        }
        return Integer().IsMatch(raw) && long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value)
            ? value
            : throw new MalformedRequestException();
    }

    public static decimal? Decimal(StringValues values) => NonBlank(values) is { } raw ? Wire(() => DecimalWireConverter.Parse(raw)) : null;

    public static DateTimeOffset? Timestamp(StringValues values) => NonBlank(values) is { } raw ? Wire(() => TimestampWireConverter.Parse(raw)) : null;

    public static DateOnly? Date(StringValues values) => NonBlank(values) is { } raw ? Wire(() => DateWireConverter.Parse(raw)) : null;

    public static JsonElement? Json(StringValues values) =>
        NonBlank(values) is { } raw
            ? Wire(() =>
            {
                using var document = JsonDocument.Parse(raw);
                return document.RootElement.Clone();
            })
            : null;

    public static bool? Bool(StringValues values) =>
        NonBlank(values)?.ToLowerInvariant() switch
        {
            null => null,
            "true" or "on" or "yes" or "1" => true,
            "false" or "off" or "no" or "0" => false,
            _ => throw new MalformedRequestException()
        };

    /// <summary>UUID.fromString de Java: cinco grupos hexadecimales que caben en 8-4-4-4-12; sale canónico.</summary>
    public static Guid? Uuid(StringValues values)
    {
        if (NonBlank(values) is not { } raw)
        {
            return null;
        }
        var parts = raw.Split('-');
        int[] widths = [8, 4, 4, 4, 12];
        if (raw.Length > 36 || parts.Length != 5)
        {
            throw new MalformedRequestException();
        }
        for (var i = 0; i < parts.Length; i++)
        {
            if (!Hex().IsMatch(parts[i]) || parts[i].Length > widths[i])
            {
                throw new MalformedRequestException();
            }
            parts[i] = parts[i].PadLeft(widths[i], '0');
        }
        return Guid.ParseExact(string.Join('-', parts), "D");
    }

    /// <summary>
    /// Un enum por su literal, o por el nombre de la constante comparado como lo hace Spring Boot (sin distinguir
    /// mayúsculas e ignorando lo que no es letra ni dígito: <c>IN_PROGRESS</c>, <c>in-progress</c>).
    /// </summary>
    public static T? EnumValue<T>(StringValues values)
        where T : struct, Enum
    {
        var raw = NonBlank(values)?.Trim();
        if (raw is null)
        {
            return null;
        }
        if (EnumLiterals<T>.ByLiteral.TryGetValue(raw, out var exact))
        {
            return exact;
        }
        return EnumLiterals<T>.ByCanonicalName.TryGetValue(EnumLiterals<T>.Canonical(raw), out var lenient) ? lenient : throw new MalformedRequestException();
    }

    /// <summary>Un value object no se lee de un texto (ruta o query): si llega, la petición es malformada.</summary>
    public static T? Unreadable<T>(StringValues values)
        where T : class => First(values) is null ? null : throw new MalformedRequestException();

    /// <summary>Una lista en la query: el parámetro repetido o separado por comas.</summary>
    public static IReadOnlyList<T>? List<T>(StringValues values, Func<string, T> element)
    {
        ArgumentNullException.ThrowIfNull(element);
        if (values.Count == 0)
        {
            return null;
        }
        IEnumerable<string> items = values.Count > 1 ? values.Select(value => value ?? "") : (values[0] ?? "").Split(',');
        return [.. items.Select(element)];
    }

    private static T Wire<T>(Func<T> convert)
    {
        try
        {
            return convert();
        }
        catch (Exception error) when (error is JsonException or FormatException or OverflowException)
        {
            throw new MalformedRequestException(error);
        }
    }
}

/// <summary>Los literales del diseño de un enum (los de [JsonStringEnumMemberName]) y sus nombres, una vez por tipo.</summary>
internal static class EnumLiterals<T>
    where T : struct, Enum
{
    public static readonly IReadOnlyDictionary<string, T> ByLiteral = Build(literal: true);

    public static readonly IReadOnlyDictionary<string, T> ByCanonicalName = Build(literal: false);

    public static string Canonical(string name) => new([.. name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant)]);

    private static Dictionary<string, T> Build(bool literal)
    {
        var map = new Dictionary<string, T>(StringComparer.Ordinal);
        foreach (var field in typeof(T).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var value = (T)field.GetValue(null)!;
            var name = field.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name ?? field.Name;
            map[literal ? name : Canonical(field.Name)] = value;
        }
        return map;
    }
}`;
}

function inputValidationBody() {
  return `/// <summary>
/// Una regla de validación del diseño (keel-core/gen/constraints.js, validationRules): las mismas que keel-spring
/// escribe como anotaciones de Bean Validation, con sus mensajes por defecto.
/// </summary>
public sealed class InputRule
{
    private static readonly ConcurrentDictionary<string, Regex> Patterns = new(StringComparer.Ordinal);

    private InputRule(string kind)
    {
        Kind = kind;
    }

    public string Kind { get; }

    private int? MinSize { get; init; }

    private int? MaxSize { get; init; }

    private string? Regexp { get; init; }

    private string? Bound { get; init; }

    private int IntegerDigits { get; init; }

    private int FractionDigits { get; init; }

    public static InputRule NotNull { get; } = new("notNull");

    public static InputRule NotBlank { get; } = new("notBlank");

    public static InputRule NotEmpty { get; } = new("notEmpty");

    public static InputRule Size(int? min, int? max) => new("size") { MinSize = min, MaxSize = max };

    public static InputRule Pattern(string regexp) => new("pattern") { Regexp = regexp };

    public static InputRule Min(string value) => new("min") { Bound = value };

    public static InputRule Max(string value) => new("max") { Bound = value };

    public static InputRule Digits(int integer, int fraction) => new("digits") { IntegerDigits = integer, FractionDigits = fraction };

    /// <summary>El mensaje de Hibernate Validator si el valor la incumple; null si la cumple. Un valor ausente solo incumple las de presencia.</summary>
    public string? Violation(object? value) =>
        Kind switch
        {
            "notNull" => value is null ? "must not be null" : null,
            "notBlank" => value is null || (value is string text && string.IsNullOrWhiteSpace(text)) ? "must not be blank" : null,
            "notEmpty" => value is null || Length(value) == 0 ? "must not be empty" : null,
            "size" => SizeViolation(value),
            "pattern" => value is string text && !Matches(text) ? $"must match \\"{Regexp}\\"" : null,
            "min" => Compare(value) < 0 ? $"must be greater than or equal to {Bound}" : null,
            "max" => Compare(value) > 0 ? $"must be less than or equal to {Bound}" : null,
            "digits" => DigitsViolation(value),
            _ => null
        };

    /// <summary>La longitud de un texto o el número de elementos de una lista; null para lo demás.</summary>
    private static int? Length(object value) =>
        value switch
        {
            string text => text.Length,
            ICollection collection => collection.Count,
            IEnumerable items => items.Cast<object?>().Count(),
            _ => null
        };

    private string? SizeViolation(object? value)
    {
        if (value is null || Length(value) is not { } length)
        {
            return null;
        }
        var min = MinSize ?? 0;
        var max = MaxSize ?? int.MaxValue;
        return length < min || length > max ? $"size must be between {min} and {max}" : null;
    }

    /// <summary>Como el matches() de Java: la expresión entera, sin el salto de línea final que admite el $ de .NET.</summary>
    private bool Matches(string text) =>
        Patterns.GetOrAdd(Regexp!, regexp => new Regex($@"\\A(?:{regexp})\\z", RegexOptions.CultureInvariant)).IsMatch(text);

    private int? Compare(object? value)
    {
        decimal? number = value switch
        {
            decimal amount => amount,
            int integer => integer,
            long integer => integer,
            _ => null
        };
        return number is { } present ? decimal.Compare(present, decimal.Parse(Bound!, NumberStyles.Float, CultureInfo.InvariantCulture)) : null;
    }

    private string? DigitsViolation(object? value)
    {
        if (value is not decimal amount)
        {
            return null;
        }
        var parts = amount.ToString(CultureInfo.InvariantCulture).TrimStart('-').Split('.');
        var integer = parts[0].TrimStart('0');
        var fraction = parts.Length > 1 ? parts[1].TrimEnd('0') : "";
        return integer.Length > IntegerDigits || fraction.Length > FractionDigits
            ? $"numeric value out of bounds (<{IntegerDigits} digits>.<{FractionDigits} digits> expected)"
            : null;
    }
}

/// <summary>
/// Acumula las violaciones de una petición y lanza UNA vez con todas, como Bean Validation. Cada una es «campo
/// mensaje».
/// </summary>
public sealed class InputViolations(ViolationSource source)
{
    private readonly List<string> details = [];

    public void Check(string path, object? value, params InputRule[] rules)
    {
        ArgumentNullException.ThrowIfNull(rules);
        foreach (var rule in rules)
        {
            if (rule.Violation(value) is { } message)
            {
                details.Add($"{path} {message}");
            }
        }
    }

    /// <summary>Las reglas de CADA ELEMENTO de una lista (<c>labels[3] size must be between 0 and 40</c>), como Bean Validation.</summary>
    public void CheckEach<T>(string path, IEnumerable<T>? values, params InputRule[] rules)
    {
        var index = 0;
        foreach (var value in values ?? [])
        {
            Check($"{path}[{index++}]", value, rules);
        }
    }

    public void ThrowIfAny()
    {
        if (details.Count > 0)
        {
            throw new RequestValidationException([.. details], source);
        }
    }
}`;
}

function httpReplyBody() {
  return `/// <summary>Cómo responde un endpoint: el status del diseño y, si lo hay, el cuerpo con el contrato del cable.</summary>
public static partial class HttpReply
{
    [GeneratedRegex(@"\\{[^}]+\\}", RegexOptions.CultureInvariant)]
    private static partial Regex TemplateParameter();

    public static Task Json<T>(HttpContext http, int status, T body)
    {
        ArgumentNullException.ThrowIfNull(http);
        http.Response.StatusCode = status;
        return http.Response.WriteAsJsonAsync(body, WireJson.Options, http.RequestAborted);
    }

    public static void Status(HttpContext http, int status)
    {
        ArgumentNullException.ThrowIfNull(http);
        http.Response.StatusCode = status;
    }

    /// <summary>
    /// URL absoluta de <c>Location</c>: el esquema y el host de la petición, y la plantilla de la ruta de lectura
    /// expandida con el valor (como ServletUriComponentsBuilder.fromCurrentContextPath() en keel-spring).
    /// </summary>
    public static string Location(HttpRequest request, string template, object? value)
    {
        ArgumentNullException.ThrowIfNull(request);
        var segment = Uri.EscapeDataString(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "");
        return $"{request.Scheme}://{request.Host}{TemplateParameter().Replace(template, segment, 1)}";
    }
}`;
}

function apiErrorMiddlewareBody() {
  const validation = FRAMEWORK_ERRORS.validation.code;
  const domainBranches = domainErrorResponses().map(
    ({ name, http, error, fallback }) => `            ${name} => Domain(${http}, ${csString(error)}, exception, ${csString(fallback)}),`
  );
  const response = (key, code = 'null', message = csString(FW[key].message), details = '') =>
    `ErrorResponse.Of(${FW[key].status}, ${csString(FW[key].error)}, ${code}, ${message}${details})`;
  return `/// <summary>
/// Traduce CUALQUIER fallo a ErrorResponse, con el status, el <c>error</c> y el <c>code</c> que da el
/// ApiExceptionHandler de keel-spring para el mismo caso; y pone cuerpo a lo que el enrutado responde vacío: una
/// ruta que no existe (404) y un camino que existe con otro método (405).
/// </summary>
/// <remarks>
/// Orden: los fallos de lectura de la petición, la jerarquía de DomainException (cada clase base con su status
/// fijo; un error con status propio lo lleva en su metadata) y el catch-all 500, que es el único que se escribe
/// en el log con su pila: el mediator ya dejó el resultado de cada caso de uso, sin ella.
/// </remarks>
public sealed partial class ApiErrorMiddleware(RequestDelegate next, ILogger<ApiErrorMiddleware> logger)
{
    private const string ValidationCode = ${csString(validation)};

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // El cliente se fue: no queda a quién responder.
            return;
        }
        catch (Exception exception) when (!context.Response.HasStarted)
        {
            await Write(context, ToResponse(exception));
            return;
        }
        if (!context.Response.HasStarted && context.Response.StatusCode is StatusCodes.Status404NotFound or StatusCodes.Status405MethodNotAllowed)
        {
            await Write(
                context,
                context.Response.StatusCode == StatusCodes.Status405MethodNotAllowed
                    ? ${response('methodNotAllowed')}
                    : ${response('notFound')});
        }
    }

    private static Task Write(HttpContext context, ErrorResponse body)
    {
        context.Response.StatusCode = body.Status;
        return context.Response.WriteAsJsonAsync(body, WireJson.Options, context.RequestAborted);
    }

    private ErrorResponse ToResponse(Exception exception)
    {
        switch (exception)
        {
            // ── Validación: errores de FORMA de la petición, 400. El 422 queda para las reglas de negocio.
            case RequestValidationException invalid:
                return ErrorResponse.Of(
                    ${FW.invalidBody.status},
                    ${csString(FW.invalidBody.error)},
                    ValidationCode,
                    invalid.Origin == ViolationSource.Body ? ${csString(FW.invalidBody.message)} : ${csString(FW.invalidParams.message)},
                    invalid.Details);
            // ── Errores de framework
            case MissingParameterException missing:
                return ${response('missingParameter', 'ValidationCode', 'missing.Message')};
            case MalformedRequestException:
            case BadHttpRequestException { StatusCode: StatusCodes.Status400BadRequest }:
                return ${response('malformed', 'ValidationCode')};
            // ── Errores de dominio (jerarquía DomainException)
            case DomainException domain:
                return FromDomain(domain);
            // ── Catch-all
            default:
                LogUnhandled(exception);
                return ${response('internal')};
        }
    }

    private static ErrorResponse FromDomain(DomainException exception) =>
        exception switch
        {
${domainBranches.join('\n')}
            _ => Extended(exception)
        };

    private static ErrorResponse Domain(int status, string error, DomainException exception, string fallback) =>
        ErrorResponse.Of(status, error, exception.Code, string.IsNullOrEmpty(exception.GivenMessage) ? fallback : exception.GivenMessage, exception.Details);

    /// <summary>Errores con status extendido (402, 429, 503…): extienden DomainException y lo llevan en la metadata.</summary>
    private static ErrorResponse Extended(DomainException exception)
    {
        var status = exception.HttpStatus ?? StatusCodes.Status422UnprocessableEntity;
        var phrase = ReasonPhrases.GetReasonPhrase(status);
        if (phrase.Length == 0)
        {
            phrase = "Error";
        }
        return ErrorResponse.Of(status, phrase, exception.Code, string.IsNullOrEmpty(exception.GivenMessage) ? phrase : exception.GivenMessage, exception.Details);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Excepción no controlada")]
    private partial void LogUnhandled(Exception exception);
}`;
}
