// El CONTRATO DEL CABLE en el proyecto .NET (keel-core/gen/wire.js): la configuración de System.Text.Json
// que lo cumple y la prueba que la ejecuta contra los casos compartidos.
//
// Lo que .NET ya hace bien y aquí solo se fija por escrito:
//   · `decimal` es decimal de verdad y conserva la escala (2.50m se escribe 2.50), nunca en exponencial;
//   · `long` se escribe con todos sus dígitos; `Guid` en minúsculas; una propiedad desconocida se ignora.
// Lo que no hace a pelo y aquí se resuelve con un conversor explícito:
//   · `DateTimeOffset` sale con su desplazamiento (`+00:00`) y siete decimales: el contrato pide UTC, `Z` y
//     exactamente tres, truncando;
//   · `JsonElement` no se lee de una cadena con el documento ya serializado;
//   · el codificador por defecto escapa lo que no es ASCII (`Ñ` → `Ñ`) y la comilla como `"`;
//   · un enum sale por su nombre C# o por su número: el contrato pide el valor del diseño, y solo ese;
//   · omitir nulos es por propiedad: `conventions.nulls: omit` es por tipo, con la marca `[OmitNulls]`.
//
// Dónde vive: en el proyecto Application (`Support/`), porque System.Text.Json es de la biblioteca base y
// no arrastra ASP.NET Core; los DTO y la infraestructura lo comparten. Program.cs lo instala en las
// opciones JSON de las APIs mínimas: un solo punto de lectura y escritura, como Fastify en keel-nest.

import { WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS } from 'keel-core/gen/wire';
import { pascalCase } from 'keel-core/gen';
import { solution, csFile, csString } from './render.js';
import { testsNamespace } from './tests.js';

export function wireNamespace(model) {
  return `${solution(model).application.name}.Support`;
}

export function generate(model) {
  const dir = `${solution(model).application.dir}/Support`;
  return [
    { path: `${dir}/WireJson.cs`, content: wireJsonCs(model) },
    { path: `${dir}/WireConverters.cs`, content: wireConvertersCs(model) },
    { path: `${dir}/OmitNullsAttribute.cs`, content: omitNullsCs(model) },
    { path: `${solution(model).unitTests.dir}/WireContractTests.cs`, content: wireContractTestsCs(model) }
  ];
}

function wireJsonCs(model) {
  return csFile({
    namespace: wireNamespace(model),
    usings: ['System.Reflection', 'System.Text.Encodings.Web', 'System.Text.Json', 'System.Text.Json.Serialization', 'System.Text.Json.Serialization.Metadata'],
    body: `
/// <summary>
/// El contrato del cable (docs/keel/wire-contract.md del método): cómo viaja en JSON cada tipo del diseño.
/// Es contrato observable, el mismo que cumplen los servidores de keel-spring y keel-nest del mismo diseño;
/// <c>WireContractTests</c> lo ejecuta contra sus casos.
/// </summary>
public static class WireJson
{
    /// <summary>Unas opciones ya configuradas y de solo lectura, para quien serializa fuera de la API.</summary>
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions();
        Configure(options);
        options.MakeReadOnly();
        return options;
    }

    /// <summary>Aplica el contrato a unas opciones existentes (las de la API las crea ASP.NET Core).</summary>
    public static void Configure(JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        // Los DTO nombran cada propiedad con el nombre del diseño; esto es solo la red para lo que no lo hace.
        options.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        // El nombre de una propiedad se compara exacto, como en los otros dos servidores.
        options.PropertyNameCaseInsensitive = false;
        // unknown-ignored: una propiedad desconocida en la entrada se ignora.
        options.UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip;
        // nulls-include: por defecto un campo sin valor viaja como null. Omitirlo es decisión del diseño, por tipo.
        options.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
        // decimal-input y long-exact: un número se lee también desde una cadena numérica ("2.50").
        options.NumberHandling = JsonNumberHandling.AllowReadingFromString;
        // string-utf8: sin escapar lo que no es ASCII. El codificador por defecto escapa además lo que es
        // peligroso DENTRO DE HTML (<, >, &, '); una respuesta JSON no se incrusta en HTML, y Jackson tampoco lo escapa.
        options.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
        options.Converters.Add(new DecimalWireConverter());
        options.Converters.Add(new TimestampWireConverter());
        options.Converters.Add(new DateWireConverter());
        options.Converters.Add(new JsonWireConverter());
        // enum-value: el valor que declara el diseño ([JsonStringEnumMemberName]), nunca el número.
        options.Converters.Add(new JsonStringEnumConverter(namingPolicy: null, allowIntegerValues: false));
        options.TypeInfoResolver = (options.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver()).WithAddedModifier(OmitNulls);
    }

    /// <summary>nulls-omit: un tipo marcado con <see cref="OmitNullsAttribute"/> no escribe sus propiedades sin valor.</summary>
    private static void OmitNulls(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object || typeInfo.Type.GetCustomAttribute<OmitNullsAttribute>() is null)
        {
            return;
        }
        foreach (var property in typeInfo.Properties)
        {
            property.ShouldSerialize = static (_, value) => value is not null;
        }
    }
}
`
  });
}

function wireConvertersCs(model) {
  return csFile({
    namespace: wireNamespace(model),
    usings: ['System.Buffers', 'System.Globalization', 'System.Text', 'System.Text.Json', 'System.Text.Json.Serialization', 'System.Text.RegularExpressions'],
    body: `
/// <summary>
/// decimal-scale, decimal-plain y decimal-input: un <c>decimal</c> sale con la escala que lleva y en notación
/// plana (lo que hace <c>decimal.ToString</c>), y se lee EXACTO del texto del número, también desde una cadena
/// numérica o en exponencial (<c>1E-7</c> se lee 0.0000001, con su escala).
/// <para>
/// El <c>decimal</c> de .NET tiene 28-29 dígitos significativos. Por encima del máximo, <c>decimal.Parse</c>
/// lanza; pero con más de 28 decimales REDONDEA en silencio (<c>1E-40</c> se lee 0). Leer exacto exige
/// rechazarlo: un 400 que se ve, en vez de un valor distinto del que mandó el cliente.
/// </para>
/// </summary>
public sealed class DecimalWireConverter : JsonConverter<decimal>
{
    public override decimal Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var text = reader.TokenType switch
        {
            JsonTokenType.Number => Encoding.UTF8.GetString(reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan),
            JsonTokenType.String => reader.GetString()!,
            _ => throw new JsonException("se esperaba un decimal")
        };
        return Parse(text);
    }

    /// <summary>El decimal EXACTO de un texto (también de la ruta o de la query); lanza JsonException si no lo es.</summary>
    public static decimal Parse(string text)
    {
        decimal value;
        int scale;
        try
        {
            value = decimal.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
            scale = WrittenScale(text.Trim());
        }
        catch (Exception error) when (error is FormatException or OverflowException)
        {
            throw new JsonException("se esperaba un decimal", error);
        }
        if (value.Scale != scale)
        {
            throw new JsonException("el decimal no cabe exacto (más de 28 decimales)");
        }
        return value;
    }

    /// <summary>La escala que pide el literal: decimales de la mantisa menos el exponente, nunca negativa.</summary>
    private static int WrittenScale(string text)
    {
        var exponentAt = text.IndexOfAny(['e', 'E']);
        var mantissa = exponentAt < 0 ? text : text[..exponentAt];
        var exponent = exponentAt < 0 ? 0 : int.Parse(text[(exponentAt + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var dot = mantissa.IndexOf('.', StringComparison.Ordinal);
        return (int)Math.Max(0L, (dot < 0 ? 0L : mantissa.Length - dot - 1) - (long)exponent);
    }

    public override void Write(Utf8JsonWriter writer, decimal value, JsonSerializerOptions options) =>
        writer.WriteRawValue(value.ToString(CultureInfo.InvariantCulture), skipInputValidation: true);
}

/// <summary>
/// timestamp-utc-millis y timestamp-input: un instante sale en UTC con exactamente tres decimales y <c>Z</c>,
/// truncando; se lee de ISO-8601 CON zona (<c>Z</c> o <c>±hh:mm</c>), se normaliza a UTC y se descarta lo que
/// hay por debajo del milisegundo.
/// </summary>
public sealed partial class TimestampWireConverter : JsonConverter<DateTimeOffset>
{
    private const string WireFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    [GeneratedRegex(@"^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})$", RegexOptions.CultureInvariant)]
    private static partial Regex Iso8601WithZone();

    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException("se esperaba un instante ISO-8601 con zona");
        }
        return Parse(reader.GetString()!);
    }

    /// <summary>El instante de un texto ISO-8601 con zona (también de la ruta o de la query); lanza JsonException si no lo es.</summary>
    public static DateTimeOffset Parse(string text)
    {
        var match = Iso8601WithZone().Match(text);
        if (!match.Success)
        {
            throw new JsonException("se esperaba un instante ISO-8601 con zona");
        }
        var seconds = match.Groups[3].Success ? match.Groups[3].Value : "00";
        var millis = (match.Groups[4].Value + "000")[..3];
        var normalized = $"{match.Groups[1].Value}T{match.Groups[2].Value}:{seconds}.{millis}{match.Groups[5].Value}";
        if (!DateTimeOffset.TryParseExact(normalized, "yyyy-MM-dd'T'HH:mm:ss.fffK", CultureInfo.InvariantCulture, DateTimeStyles.None, out var value))
        {
            throw new JsonException("el instante no existe");
        }
        return value.ToUniversalTime();
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.UtcDateTime.ToString(WireFormat, CultureInfo.InvariantCulture));
}

/// <summary>date-iso: una fecha viaja como <c>YYYY-MM-DD</c>, y una que no existe (<c>2026-02-30</c>) se rechaza.</summary>
public sealed class DateWireConverter : JsonConverter<DateOnly>
{
    private const string WireFormat = "yyyy-MM-dd";

    public override DateOnly Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException("se esperaba una fecha YYYY-MM-DD que exista");
        }
        return Parse(reader.GetString()!);
    }

    /// <summary>La fecha de un texto <c>YYYY-MM-DD</c> (también de la ruta o de la query); lanza JsonException si no lo es.</summary>
    public static DateOnly Parse(string text) =>
        DateOnly.TryParseExact(text, WireFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var value)
            ? value
            : throw new JsonException("se esperaba una fecha YYYY-MM-DD que exista");

    public override void Write(Utf8JsonWriter writer, DateOnly value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToString(WireFormat, CultureInfo.InvariantCulture));
}

/// <summary>
/// json-embedded: un campo <c>json</c> viaja EMBEBIDO como valor JSON, con sus números tal como llegaron; al
/// leer se acepta también una cadena con el documento ya serializado.
/// </summary>
public sealed class JsonWireConverter : JsonConverter<JsonElement>
{
    public override JsonElement Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            return JsonElement.ParseValue(ref reader);
        }
        try
        {
            using var document = JsonDocument.Parse(reader.GetString()!);
            return document.RootElement.Clone();
        }
        catch (JsonException error)
        {
            throw new JsonException("la cadena no contiene un documento JSON", error);
        }
    }

    public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options)
    {
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            writer.WriteNullValue();
            return;
        }
        value.WriteTo(writer);
    }
}
`
  });
}

function omitNullsCs(model) {
  return csFile({
    namespace: wireNamespace(model),
    body: `
/// <summary>
/// <c>conventions.nulls: omit</c>: las instancias de un tipo marcado no escriben sus propiedades sin valor.
/// Lo llevan las respuestas y los payloads de evento; el cuerpo de error, nunca (su forma es estable).
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
public sealed class OmitNullsAttribute : Attribute;
`
  });
}

/** Los valores de enum de los casos: la prueba los declara como un enum con el valor del diseño. */
function enumValues() {
  return [...new Set([...WIRE_OUTPUT_CASES, ...WIRE_INPUT_CASES, ...WIRE_REJECTED_INPUTS].filter((entry) => entry.type === 'enum').map((entry) => entry.value))];
}

function inlineData(values) {
  return `    [InlineData(${values.map((value) => csString(value)).join(', ')})]`;
}

function wireContractTestsCs(model) {
  const members = enumValues().map((value) => `    [JsonStringEnumMemberName(${csString(value)})]\n    ${pascalCase(value)},`);
  const enumArms = enumValues().map((value) => `        ${csString(value)} => WireSampleEnum.${pascalCase(value)},`);
  return csFile({
    namespace: testsNamespace(model),
    usings: ['System.Globalization', 'System.Text.Json', 'System.Text.Json.Serialization', 'Xunit', wireNamespace(model)],
    header: `// El contrato del cable, ejecutado. Los casos los genera keel-dotnet desde keel-core/gen/wire.js, la misma
// fuente contra la que se miden los servidores de keel-spring y keel-nest: si uno de estos falla, este
// servidor y los otros dos del mismo diseño ya no responden igual.`,
    body: `
/// <summary>Un enum como los que emite el dominio: el miembro C# y el valor del diseño, que es el que viaja.</summary>
public enum WireSampleEnum
{
${members.join('\n')}
}

public sealed class WireContractTests
{
    private static string Write<T>(T value) => JsonSerializer.Serialize(value, WireJson.Options);

    private static T Read<T>(string json) => JsonSerializer.Deserialize<T>(json, WireJson.Options)!;

    private static string WriteJson(string literal)
    {
        using var document = JsonDocument.Parse(literal);
        return Write(document.RootElement);
    }

    private static WireSampleEnum EnumOf(string value) => value switch
    {
${enumArms.join('\n')}
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "valor de enum sin caso")
    };

    /// <summary>El valor tipado a partir de su literal del diseño, escrito con el contrato.</summary>
    private static string WriteTyped(string type, string literal) => type switch
    {
        "decimal" => Write(decimal.Parse(literal, NumberStyles.Float, CultureInfo.InvariantCulture)),
        "long" => Write(long.Parse(literal, CultureInfo.InvariantCulture)),
        "int" => Write(int.Parse(literal, CultureInfo.InvariantCulture)),
        "boolean" => Write(bool.Parse(literal)),
        "timestamp" => Write(DateTimeOffset.Parse(literal, CultureInfo.InvariantCulture)),
        "date" => Write(DateOnly.ParseExact(literal, "yyyy-MM-dd", CultureInfo.InvariantCulture)),
        "uuid" => Write(Guid.Parse(literal)),
        "json" => WriteJson(literal),
        "enum" => Write(EnumOf(literal)),
        _ => Write(literal)
    };

    /// <summary>Lee un valor del cable con el tipo del diseño, como lo hará un DTO, y lo vuelve a escribir.</summary>
    private static string RoundTrip(string type, string json) => type switch
    {
        "decimal" => Write(Read<decimal>(json)),
        "long" => Write(Read<long>(json)),
        "int" => Write(Read<int>(json)),
        "boolean" => Write(Read<bool>(json)),
        "timestamp" => Write(Read<DateTimeOffset>(json)),
        "date" => Write(Read<DateOnly>(json)),
        "uuid" => Write(Read<Guid>(json)),
        "json" => Write(Read<JsonElement>(json)),
        "enum" => Write(Read<WireSampleEnum>(json)),
        _ => Write(Read<string>(json))
    };

    [Theory]
${WIRE_OUTPUT_CASES.map((entry) => inlineData([entry.id, entry.type, entry.value, entry.json])).join('\n')}
    public void Salida(string id, string type, string value, string json) =>
        Assert.True(json == WriteTyped(type, value), $"{id}: {type} {value} se escribe {WriteTyped(type, value)}, no {json}");

    [Theory]
${WIRE_INPUT_CASES.map((entry) => inlineData([entry.id, entry.type, entry.json, entry.roundTrip])).join('\n')}
    public void EntradaIdaYVuelta(string id, string type, string json, string roundTrip) =>
        Assert.True(roundTrip == RoundTrip(type, json), $"{id}: {json} vuelve como {RoundTrip(type, json)}, no {roundTrip}");

    [Theory]
${WIRE_REJECTED_INPUTS.map((entry) => inlineData([entry.id, entry.type, entry.json])).join('\n')}
    public void EntradaRechazada(string id, string type, string json)
    {
        var error = Record.Exception(() => RoundTrip(type, json));
        Assert.True(error is JsonException, $"{id}: {type} {json} no se rechaza ({error?.GetType().Name ?? "se acepta"})");
    }

    public sealed record Sample(long A, string? B);

    [OmitNulls]
    public sealed record OmittingSample(long A, string? B, int? C);

    [Fact]
    public void PorDefectoUnCampoSinValorViajaComoNull() =>
        Assert.Equal("""{"a":1,"b":null}""", Write(new Sample(1, null)));

    [Fact]
    public void UnTipoMarcadoConOmitNullsNoLosEscribe() =>
        Assert.Equal("""{"a":1}""", Write(new OmittingSample(1, null, null)));

    [Fact]
    public void UnaPropiedadDesconocidaSeIgnora() =>
        Assert.Equal(new Sample(1, "x"), Read<Sample>("""{"a":1,"b":"x","otra":true}"""));

    [Fact]
    public void UnEnumNoSeLeePorSuNumero() =>
        Assert.Throws<JsonException>(() => Read<WireSampleEnum>("0"));

    [Theory]
    [InlineData("1E-40")]
    [InlineData("0.00000000000000000000000000001")]
    [InlineData("123456789012345678901234567890")]
    public void UnDecimalQueNoCabeExactoSeRechazaEnVezDeRedondearse(string json) =>
        Assert.Throws<JsonException>(() => Read<decimal>(json));

    [Theory]
    [InlineData("1.0000000000000000000000000001", "1.0000000000000000000000000001")]
    [InlineData("2.50E1", "25.0")]
    [InlineData("1E+3", "1000")]
    public void UnDecimalQueCabeSeLeeConLaEscalaQueEscribio(string json, string expected) =>
        Assert.Equal(expected, Write(Read<decimal>(json)));

    [Fact]
    public void UnTimestampSinZonaSeRechaza() =>
        Assert.Throws<JsonException>(() => Read<DateTimeOffset>("\\"2026-03-14T09:21:07.482\\""));
}
`
  });
}
