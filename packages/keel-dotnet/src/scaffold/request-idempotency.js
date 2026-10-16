// La idempotencia de PETICIÓN (`use-cases.<op>.idempotency`): la que evita que reintentar una petición ejecute el caso
// de uso dos veces. Es el mismo mecanismo que el de keel-spring y keel-nest, con su misma tabla
// (`keel-core/gen/request-idempotency.js`, `IDEMPOTENCY_RECORD`):
//
//   · build genera TODO lo transversal: el puerto `IIdempotencyStore` (Domain/Idempotency), su adaptador EF Core con la
//     tabla `idempotency_record`, la firma canónica del comando (`CommandSignature`), el contexto que lleva la cabecera
//     `Idempotency-Key` hasta el handler (y el middleware que lo abre) y los dos errores de conflicto (la carrera y la
//     clave reutilizada), con el `code` del catálogo de Keel o el que el diseño declare;
//   · el agente escribe el USO en el handler, guiado por la nota que le deja el stub (services.js).
//
// Por qué un registro en la base y no una clave en una caché: el contrato no es «rechazar el duplicado» sino
// «reproducir la respuesta», y el registro tiene que confirmarse en la MISMA transacción que el efecto del comando.
//
// Se adelantó del incremento 10 por lo mismo que en keel-nest: su primera corrida enseñó que un aviso de frontera no
// frena al agente cuando un escenario exige el mecanismo, y que el suyo sale con otra tabla y otro algoritmo.

import { FRAMEWORK_ERRORS } from 'keel-core';
import { idempotencyOutcomeCodes } from 'keel-core/gen';
import { IDEMPOTENCY_RECORD, IDEMPOTENCY_HEADER, registryOperations, usesRequestIdempotency as usesRegistryInDesign } from 'keel-core/gen/request-idempotency';
import { csFile, csString, located, namespaceOf, solution } from './render.js';
import { usesPersistence, usesDocument, rowsNamespace, persistenceNamespace } from './persistence.js';
import { documentIdempotencyStoreBody } from './document-stores.js';
import { usesApi } from './rest-support.js';
import { usesOutboundIdempotency } from './http-clients.js';

/** La fila del registro y su configuración: las lee el DbContext y la paridad del esquema. */
export const IDEMPOTENCY_ROW = 'IdempotencyRecordRow';
export const IDEMPOTENCY_PORT = 'IIdempotencyStore';
const ADAPTER = 'IdempotencyStore';

/**
 * ¿Se genera el registro? Con persistencia —relacional o, desde el incremento 12c, documental— y alguna operación que lo
 * use (no la guarda por clave natural).
 */
export function usesRequestIdempotency(model) {
  return usesPersistence(model) && usesRegistryInDesign(model);
}

/** ¿Viaja la clave por la cabecera Idempotency-Key? Solo con `client-key`, y con API. */
export function usesIdempotencyHeader(model) {
  return usesRequestIdempotency(model) && usesApi(model) && registryOperations(model, 'client-key').length > 0;
}

/** ¿Deduplica ESTA operación con el registro? */
export function usesRegistry(model, operation) {
  return usesRequestIdempotency(model) && Boolean(operation.idempotency && operation.idempotency.guard !== 'natural-key');
}

export function idempotencyNamespace(model) {
  return namespaceOf(model, 'idempotency');
}

export function generate(model) {
  // La firma canónica la usa también la clave de idempotencia SALIENTE (http-clients): sin registro, solo ella.
  if (!usesRequestIdempotency(model)) return usesOutboundIdempotency(model) ? [commandSignature(model)] : [];
  const files = [storePort(model), conflictException(model), reuseException(model), commandSignature(model)];
  // El adaptador, por modelo: sobre documentos no hay fila, y el `_id` subdocumento arbitra la carrera (incremento 12c).
  if (usesDocument(model)) files.push(documentStoreAdapter(model));
  else files.push(recordRow(model), storeAdapter(model));
  // El contexto es el camino de la CABECERA: solo con `client-key`. Con `payload-hash` o `payload-field` la clave sale
  // del propio comando y no hay nada que transportar.
  if (usesIdempotencyHeader(model)) files.push(idempotencyContext(model), headerMiddleware(model));
  files.push(emittedTests(model));
  return files;
}

/**
 * La prueba EMITIDA del mecanismo, sin base: la firma canónica (lo que hace que el reintento y la clave reutilizada se
 * distingan), el contexto de la cabecera y el code de cada conflicto por operación. Lo que solo juzga el motor (guardar,
 * la carrera, la caducidad, el rollback) lo mide db-check.
 */
function emittedTests(model) {
  const sln = solution(model);
  const cases = [];
  for (const operation of registryOperations(model)) {
    const race = idempotencyOutcomeCodes(model, FRAMEWORK_ERRORS.idempotencyRace).find((row) => row.operation === operation.name)?.code;
    const reuse = idempotencyOutcomeCodes(model, FRAMEWORK_ERRORS.idempotencyReuse).find((row) => row.operation === operation.name)?.code;
    cases.push(`    [InlineData(${csString(operation.name)}, ${csString(race)}, ${csString(reuse)})]`);
  }
  const header = usesIdempotencyHeader(model)
    ? `

    [Fact]
    public async Task LaCabeceraLlegaAlContextoRecortadaYEnBlancoNoAbreNada()
    {
        Assert.Null(IdempotencyContext.Get());
        string? seen = "sin ejecutar";
        await IdempotencyContext.RunWith("  clave-1 ", () => { seen = IdempotencyContext.Get(); return Task.CompletedTask; });
        Assert.Equal("clave-1", seen);
        await IdempotencyContext.RunWith("   ", () => { seen = IdempotencyContext.Get(); return Task.CompletedTask; });
        Assert.Null(seen);
        Assert.Null(IdempotencyContext.Get());
    }`
    : '';
  const body = String.raw`public sealed class IdempotencyTests
{
    /// <summary>Un comando de muestra: el método del ámbito no es contenido y no entra en la firma.</summary>
    private sealed class SampleCommand
    {
        public required string Sku { get; init; }

        public string IdempotencyScope() => "sample";
    }

    private static string Sig(object value) => CommandSignature.Of(value);

    [Fact]
    public void LaFirmaNoDependeDelOrdenDeLasPropiedadesNiDeLosMetodos()
    {
        Assert.Equal(Sig(new { A = 1, B = "x" }), Sig(new { B = "x", A = 1 }));
        Assert.Equal(Sig(new SampleCommand { Sku = "ACM-0001" }), Sig(new { Sku = "ACM-0001" }));
        Assert.Matches("^[0-9a-f]{64}\\z", Sig(new { }));
    }

    [Fact]
    public void ElOrdenDeUnaListaEsContenidoYLaEscalaNo()
    {
        Assert.NotEqual(Sig(new { Items = new[] { 1, 2 } }), Sig(new { Items = new[] { 2, 1 } }));
        Assert.Equal(Sig(new { Amount = 1.50m }), Sig(new { Amount = 1.5m }));
        Assert.NotEqual(Sig(new { Amount = 1.50m }), Sig(new { Amount = 1.51m }));
    }

    [Fact]
    public void NingunContenidoImitaUnSeparadorNiANull()
    {
        Assert.NotEqual(Sig(new { Notes = (string?)null }), Sig(new { Notes = "~" }));
        Assert.NotEqual(Sig(new { A = "b,c" }), Sig(new { A = "b", C = "" }));
    }

    [Fact]
    public void UnBinarioEntraPorSuDigest()
    {
        var digest = Convert.ToHexStringLower(SHA256.HashData("a"u8.ToArray()));
        Assert.Equal("{7:Content64:" + digest + "}", CommandSignature.Canonical(new { Content = "a"u8.ToArray() }));
    }
${model.hasFileUploads ? FILE_UPLOAD_SIGNATURE_TEST : ''}
    [Theory]
${cases.join('\n')}
    public void CadaConflictoSaleConElCodeDeSuOperacion(string operation, string race, string reuse)
    {
        Assert.Equal(race, new IdempotencyConflictException(operation, "k").Code);
        Assert.Equal(reuse, new IdempotencyReuseException(operation, "k").Code);
        Assert.Equal(409, new IdempotencyConflictException(operation + ":particion", "k").HttpStatus);
    }${header}
}`;
  return {
    path: `${sln.unitTests.dir}/IdempotencyTests.cs`,
    content: csFile({ namespace: sln.unitTests.name, usings: ['System.Security.Cryptography', 'Xunit', idempotencyNamespace(model), namespaceOf(model, 'appSupport'), ...(model.hasFileUploads ? [namespaceOf(model, 'dtos')] : [])], body })
  };
}

// Con una subida en el diseño, la firma del comando EJECUTADA sobre el FileUpload de verdad (su contenido es un
// ReadOnlyMemory, no un byte[]): sin este caso, todo POST de subida con idempotencia daba 500 en la corrida asset-vault y
// la prueba seguía en verde porque solo firmaba un byte[].
const FILE_UPLOAD_SIGNATURE_TEST = `
    [Fact]
    public void UnaSubidaEnTransitoSeFirmaPorElDigestDeSuContenido()
    {
        var upload = new FileUpload("a"u8.ToArray(), "a.pdf", "application/pdf", 1);
        var digest = Convert.ToHexStringLower(SHA256.HashData("a"u8.ToArray()));
        Assert.Contains("7:Content64:" + digest, CommandSignature.Canonical(upload));
        Assert.Equal(Sig(new { Binary = upload }), Sig(new { Binary = new FileUpload("a"u8.ToArray(), "a.pdf", "application/pdf", 1) }));
        Assert.NotEqual(Sig(new { Binary = upload }), Sig(new { Binary = upload with { Content = "b"u8.ToArray() } }));
    }
`;

function storePort(model) {
  const { namespace, path } = located(model, 'idempotency', IDEMPOTENCY_PORT);
  const body = `/// <summary>Lo guardado de la primera ejecución de una petición.</summary>
/// <param name="Signature">La firma del contenido (CommandSignature) con la que se usó la clave.</param>
/// <param name="ResourceId">El id del recurso resultante, para reconstruir la respuesta; null si la operación no crea nada.</param>
public sealed record StoredRequest(string Signature, string? ResourceId);

/// <summary>
/// Registro de peticiones ya atendidas, por clave de idempotencia.
/// </summary>
/// <remarks>
/// El contrato del diseño no es rechazar la repetición, sino REPRODUCIRLA: la segunda llamada con la misma clave y el
/// mismo contenido devuelve la respuesta de la primera, sin volver a ejecutar nada. Por eso se guarda el id del recurso
/// resultante y una firma del contenido (para detectar la reutilización de la clave con otro cuerpo, que tiene su propio
/// error: <see cref="IdempotencyReuseException"/>).
/// </remarks>
public interface ${IDEMPOTENCY_PORT}
{
    /// <summary>El registro previo, si esa clave ya se usó y no ha caducado.</summary>
    /// <param name="scope">command.IdempotencyScope(), que build compone desde el diseño (la operación y su partitionBy): no se compone a mano.</param>
    /// <param name="idempotencyKey">La cabecera Idempotency-Key (client-key), CommandSignature.Of(command) (payload-hash) o el campo de la clave (payload-field).</param>
    /// <param name="cancellationToken">El del handler.</param>
    Task<StoredRequest?> Find(string scope, string idempotencyKey, CancellationToken cancellationToken = default);

    /// <summary>
    /// Registra la primera ejecución, DENTRO de la transacción del caso de uso: si el comando revierte, el registro
    /// revierte con él. Dos peticiones con la misma clave a la vez chocan en la clave primaria del registro, y la que
    /// pierde sale como <see cref="IdempotencyConflictException"/>: no la captures.
    /// </summary>
    /// <param name="scope">El ámbito, como en <see cref="Find"/>.</param>
    /// <param name="idempotencyKey">La clave, como en <see cref="Find"/>.</param>
    /// <param name="signature">CommandSignature.Of(command).</param>
    /// <param name="resourceId">El id del recurso que esta ejecución va a crear, o null.</param>
    /// <param name="ttlSeconds">La ventana de deduplicación del diseño (idempotency.ttlSeconds).</param>
    /// <param name="cancellationToken">El del handler.</param>
    Task Save(string scope, string idempotencyKey, string signature, string? resourceId, int ttlSeconds, CancellationToken cancellationToken = default);
}`;
  return { path, content: csFile({ namespace, body }) };
}

/**
 * Un error de conflicto del registro. El code es de la OPERACIÓN que lo declara, no del servicio
 * (keel-core/gen, idempotencyOutcomeCodes): la excepción lo resuelve por la operación que encabeza el scope.
 */
function conflictBody(model, canonical, className, summary, detail, message) {
  const { namespace, path } = located(model, 'idempotency', className);
  const declared = idempotencyOutcomeCodes(model, canonical).filter((row) => row.declared);
  const origin =
    declared.length > 0
      ? `/// El code sale del error que cada operación declara para este conflicto (${declared.map((row) => row.operation).join(', ')}); las demás\n/// usan el CANÓNICO del framework (docs/framework-errors.md). La operación es la que encabeza el scope.`
      : `/// El code es el CANÓNICO del framework (docs/framework-errors.md): el diseño no declara uno propio, y eso es una\n/// respuesta legítima. Para cambiarlo, declara en los errors de la operación un code de su familia con status ${canonical.http}.`;
  const table =
    declared.length === 0
      ? ''
      : `
    /// <summary>El code que declara cada operación para este desenlace; la que no aparece usa el canónico.</summary>
    private static readonly Dictionary<string, string> DeclaredCodes = new(StringComparer.Ordinal)
    {
${declared.map((row) => `        [${csString(row.operation)}] = ${csString(row.code)},`).join('\n')}
    };

    private static string CodeFor(string scope) => DeclaredCodes.GetValueOrDefault(scope.Split(':')[0], ${csString(canonical.code)});
`;
  const code = declared.length === 0 ? csString(canonical.code) : 'CodeFor(scope)';
  const body = `/// <summary>${summary}</summary>
/// <remarks>
/// ${detail}
/// </remarks>
${origin}
public sealed class ${className}(string scope, string idempotencyKey)
    : ConflictException(${message}, code: ${code}, httpStatus: ${canonical.http})
{${table}}`;
  return { path, content: csFile({ namespace, usings: [namespaceOf(model, 'errors')], body }) };
}

function conflictException(model) {
  return conflictBody(
    model,
    FRAMEWORK_ERRORS.idempotencyRace,
    'IdempotencyConflictException',
    'Dos peticiones con la misma clave de idempotencia, a la vez.',
    'No es el reintento normal —ese encuentra el registro ya confirmado y reproduce la respuesta—: es la ventana en la\n/// que la primera aún no ha confirmado, así que no hay respuesta que reproducir. La transacción de quien pierde revierte\n/// entera: de dos peticiones idénticas se ejecutó exactamente una.',
    '$"Otra petición con la misma clave de idempotencia está en curso: {scope}/{idempotencyKey}"'
  );
}

function reuseException(model) {
  return conflictBody(
    model,
    FRAMEWORK_ERRORS.idempotencyReuse,
    'IdempotencyReuseException',
    'La misma clave de idempotencia con un contenido DISTINTO.',
    'El cliente prometió, al mandar la clave, que dos peticiones con ella son la misma; esta no lo es. Reproducir la\n/// primera respuesta contestaría a otra pregunta, y ejecutarla rompería la promesa de la clave. Se detecta comparando la\n/// firma del contenido con la que se guardó junto a la clave.',
    '$"La clave de idempotencia {scope}/{idempotencyKey} ya se usó con un contenido distinto"'
  );
}

function commandSignature(model) {
  const { namespace, path } = located(model, 'appSupport', 'CommandSignature');
  const body = String.raw`/// <summary>
/// Firma determinista del contenido de un comando: la que se guarda junto a la clave (client-key) para distinguir el
/// reintento de la clave reutilizada, o la CLAVE misma (payload-hash).
/// </summary>
/// <remarks>
/// Generada y no escrita en cada handler: se compara contra una firma guardada en OTRO despliegue, y dos formas de
/// calcularla —o un refactor que cambie una— dejarían de deduplicar sin que nada lo delate.
///
/// Canónica: propiedades públicas ordenadas por nombre (los métodos, como IdempotencyScope, no entran), cada escalar
/// precedido de su longitud (ningún contenido puede imitar un separador), el orden de las listas conservado, null y
/// ausente como marca propia, un decimal sin ceros finales (1.50 y 1.5 son el mismo importe) y un binario por su digest.
/// No usa System.Text.Json: las opciones del cable no son contrato de la firma, y cambiarlas movería en silencio firmas
/// ya guardadas.
/// </remarks>
public static class CommandSignature
{
    /// <summary>SHA-256 en hexadecimal de la forma canónica del comando.</summary>
    public static string Of(object command) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(command))));

    /// <summary>La forma canónica: visible para poder verificarla en una prueba.</summary>
    public static string Canonical(object? value)
    {
        switch (value)
        {
            case null:
                return "~";
            case string text:
                return Scalar(text);
            case decimal number:
                return Scalar(WithoutTrailingZeros(number.ToString(CultureInfo.InvariantCulture)));
            case bool flag:
                return Scalar(flag ? "true" : "false");
            case DateTimeOffset instant:
                return Scalar(instant.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            case DateOnly date:
                return Scalar(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
            case Guid id:
                return Scalar(id.ToString("D"));
            case JsonElement json:
                return Scalar(json.GetRawText());
            // Un binario (el contenido de una subida) puede pesar megas: entra por su digest, como en keel-spring.
            case byte[] bytes:
                return Scalar(Convert.ToHexStringLower(SHA256.HashData(bytes)));
            // El contenido de una subida en tránsito (FileUpload.Content) es un ReadOnlyMemory: el mismo digest que su byte[].
            case ReadOnlyMemory<byte> memory:
                return Scalar(Convert.ToHexStringLower(SHA256.HashData(memory.Span)));
            case Memory<byte> writable:
                return Scalar(Convert.ToHexStringLower(SHA256.HashData(writable.Span)));
            case Enum member:
                return Scalar(member.ToString());
            case IFormattable formattable:
                return Scalar(formattable.ToString(null, CultureInfo.InvariantCulture));
            case IEnumerable items:
                return "[" + string.Join(",", items.Cast<object?>().Select(Canonical)) + "]";
        }
        var type = value.GetType();
        // El Optional de un PATCH: ausente y null son la misma marca, como el Optional vacío de keel-spring.
        if (type.IsGenericType && type.Name == "Optional${'`'}1")
        {
            var present = (bool)type.GetProperty("IsPresent")!.GetValue(value)!;
            return present ? Canonical(type.GetProperty("Value")!.GetValue(value)) : "~";
        }
        var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.GetIndexParameters().Length == 0)
            // Un ref struct (un Span) no se puede leer por reflexión: nunca se desciende a él.
            .Where(property => !property.PropertyType.IsByRefLike)
            .OrderBy(property => property.Name, StringComparer.Ordinal);
        return "{" + string.Join(",", properties.Select(property => Scalar(property.Name) + Canonical(ReadProperty(property, value)))) + "}";
    }

    /// <summary>Una propiedad que no se puede leer no se salta en silencio: dice cuál es, para añadir su caso arriba.</summary>
    private static object? ReadProperty(PropertyInfo property, object owner)
    {
        try
        {
            return property.GetValue(owner);
        }
        catch (Exception error) when (error is NotSupportedException or TargetInvocationException)
        {
            throw new InvalidOperationException(
                $"CommandSignature no puede firmar {property.DeclaringType?.Name}.{property.Name} ({property.PropertyType.Name}): añade su caso en Canonical.", error);
        }
    }

    /// <summary>Prefijo de longitud: hace imposible que un contenido imite un separador.</summary>
    private static string Scalar(string raw) => string.Create(CultureInfo.InvariantCulture, $"{raw.Length}:{raw}");

    private static string WithoutTrailingZeros(string text) => text.Contains('.', StringComparison.Ordinal) ? text.TrimEnd('0').TrimEnd('.') : text;
}`;
  return {
    path,
    content: csFile({ namespace, usings: ['System.Collections', 'System.Globalization', 'System.Reflection', 'System.Security.Cryptography', 'System.Text', 'System.Text.Json'], body })
  };
}

function idempotencyContext(model) {
  const { namespace, path } = located(model, 'appSupport', 'IdempotencyContext');
  const body = `/// <summary>
/// La clave de idempotencia de la petición en curso (cabecera ${IDEMPOTENCY_HEADER}, keySource: client-key). Es
/// transporte, así que no viaja dentro del comando: la abre el middleware de entrada HTTP (Api/Rest) y la lee el
/// handler. Vive en un AsyncLocal, que sigue a la petición por sus awaits.
/// </summary>
/// <remarks>
/// La cabecera es OPCIONAL: sin ella Get() devuelve null y la operación se ejecuta sin deduplicar — no se rechaza, salvo
/// que el diseño declare el error que la exige.
/// </remarks>
public static class IdempotencyContext
{
    /// <summary>La cabecera HTTP de la clave.</summary>
    public const string Header = ${csString(IDEMPOTENCY_HEADER)};

    private static readonly AsyncLocal<string?> Current = new();

    /// <summary>La clave de la petición en curso, o null si el cliente no la envió.</summary>
    public static string? Get() => Current.Value;

    /// <summary>Ejecuta la acción con la clave recibida (sin clave, o en blanco, con ninguna).</summary>
    public static async Task RunWith(string? idempotencyKey, Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(action);
        var previous = Current.Value;
        Current.Value = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey.Trim();
        try
        {
            await action();
        }
        finally
        {
            Current.Value = previous;
        }
    }
}`;
  return { path, content: csFile({ namespace, body }) };
}

function headerMiddleware(model) {
  const { namespace, path } = located(model, 'rest', 'IdempotencyKeyMiddleware');
  const body = `/// <summary>
/// Lleva la cabecera ${IDEMPOTENCY_HEADER} de la petición al <see cref="IdempotencyContext"/>, de donde la lee el handler
/// de una operación idempotente. Va detrás de la correlación: un rechazo posterior sigue llevando su correlationId.
/// </summary>
public sealed class IdempotencyKeyMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var key = context.Request.Headers.TryGetValue(IdempotencyContext.Header, out var values) ? values.FirstOrDefault() : null;
        return IdempotencyContext.RunWith(key, () => next(context));
    }
}`;
  return { path, content: csFile({ namespace, usings: [namespaceOf(model, 'appSupport')], body }) };
}

function propertyOf(column) {
  return column.name.replace(/(^|_)([a-z])/g, (_m, _sep, c) => c.toUpperCase());
}

function recordRow(model) {
  const { namespace, path } = located(model, 'rows', IDEMPOTENCY_ROW);
  const index = IDEMPOTENCY_RECORD.indexes[0];
  const primary = IDEMPOTENCY_RECORD.columns.filter((column) => column.primary);
  const properties = IDEMPOTENCY_RECORD.columns.map((column) => {
    const type = column.base === 'timestamp' ? 'DateTimeOffset' : 'string';
    const initializer = type === 'string' && !column.nullable ? ' = null!;' : '';
    return `    public ${type}${column.nullable ? '?' : ''} ${propertyOf(column)} { get; set; }${initializer}`;
  });
  const chains = IDEMPOTENCY_RECORD.columns.map((column) => {
    const parts = [`row.Property(r => r.${propertyOf(column)})`, `.HasColumnName(${csString(column.name)})`];
    if (column.length != null) parts.push(`.HasMaxLength(${column.length})`);
    parts.push(column.nullable ? '.IsRequired(false)' : '.IsRequired()');
    return `        ${parts.join('')};`;
  });
  const body = `/// <summary>
/// Petición ya atendida: un par (ámbito, clave de idempotencia). La MISMA tabla que los servidores de keel-spring y
/// keel-nest del diseño (keel-core/gen/request-idempotency.js): la clave primaria compuesta arbitra la carrera entre dos
/// peticiones simultáneas, y expires_at se guarda calculada para que cada fila conserve la ventana con la que se
/// registró. El índice sobre expires_at es el de la purga.
/// </summary>
public sealed class ${IDEMPOTENCY_ROW}
{
${properties.join('\n\n')}
}

/// <summary>El mapeo de ${IDEMPOTENCY_ROW} a la tabla ${IDEMPOTENCY_RECORD.table}.</summary>
public sealed class ${IDEMPOTENCY_ROW}Configuration : IEntityTypeConfiguration<${IDEMPOTENCY_ROW}>
{
    public void Configure(EntityTypeBuilder<${IDEMPOTENCY_ROW}> row)
    {
        row.ToTable(${csString(IDEMPOTENCY_RECORD.table)});
        row.HasKey(r => new { ${primary.map((column) => `r.${propertyOf(column)}`).join(', ')} }).HasName(${csString(`${IDEMPOTENCY_RECORD.table}_pkey`)});
${chains.join('\n')}
        row.HasIndex(r => r.${propertyOf({ name: index.columns[0] })}, ${csString(index.name)}).HasDatabaseName(${csString(index.name)});
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders'], body }) };
}

function storeAdapter(model) {
  const { namespace, path } = located(model, 'persistence', ADAPTER);
  const context = `${model.service.rootNamespace}DbContext`;
  const body = `/// <summary>
/// Adaptador EF Core del registro de idempotencia. Usa el DbContext del ámbito, el de la transacción del caso de uso: el
/// registro y el efecto del comando se confirman o revierten juntos, porque una clave marcada sin recurso detrás haría
/// que el reintento devolviese una respuesta que nunca existió.
/// </summary>
/// <remarks>
/// Carreras: dos peticiones simultáneas con la misma clave insertan la misma clave primaria y el MOTOR arbitra: la que
/// pierde espera a que la otra confirme y choca. Sale como <see cref="IdempotencyConflictException"/> (su code, no un 409
/// anónimo indistinguible de un conflicto de negocio), sin la causa del motor detrás: el traductor de la transacción no
/// tiene que volver a mirarla.
/// </remarks>
public sealed class ${ADAPTER}(${context} db, PersistenceTransactions transactions) : ${IDEMPOTENCY_PORT}
{
    public async Task<StoredRequest?> Find(string scope, string idempotencyKey, CancellationToken cancellationToken = default)
    {
        var found = await db.Set<${IDEMPOTENCY_ROW}>().AsNoTracking()
            .SingleOrDefaultAsync(r => r.OperationScope == scope && r.IdempotencyKey == idempotencyKey, cancellationToken);
        // Una fila caducada es como si no estuviera: la ventana la fija el diseño, no la purga.
        return found is null || found.ExpiresAt <= DateTimeOffset.UtcNow ? null : new StoredRequest(found.Signature, found.ResourceId);
    }

    public async Task Save(string scope, string idempotencyKey, string signature, string? resourceId, int ttlSeconds, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                var now = DateTimeOffset.UtcNow;
                // Una fila CADUCADA es como si no estuviera —es lo que ya asume Find—, y tiene que serlo aquí: si no, la
                // clave quedaría inutilizable entre su caducidad y la purga, con un 409 de clave en curso todo ese tiempo.
                await db.Set<${IDEMPOTENCY_ROW}>()
                    .Where(r => r.OperationScope == scope && r.IdempotencyKey == idempotencyKey && r.ExpiresAt <= now)
                    .ExecuteDeleteAsync(cancellationToken);
                var row = new ${IDEMPOTENCY_ROW}
                {
                    OperationScope = scope,
                    IdempotencyKey = idempotencyKey,
                    Signature = signature,
                    ResourceId = resourceId,
                    CreatedAt = now,
                    ExpiresAt = now.AddSeconds(ttlSeconds)
                };
                db.Add(row);
                try
                {
                    await db.SaveChangesAsync(cancellationToken);
                }
                catch (DbUpdateException error) when (PersistenceErrors.EngineError(error) is { SqlState: PostgresErrorCodes.UniqueViolation } engine
                    && string.Equals(engine.ConstraintName, ${csString(`${IDEMPOTENCY_RECORD.table}_pkey`)}, StringComparison.OrdinalIgnoreCase))
                {
                    db.Entry(row).State = EntityState.Detached;
                    throw new IdempotencyConflictException(scope, idempotencyKey);
                }
                return true;
            },
            readOnly: false,
            cancellationToken);
    }
}`;
  return {
    path,
    content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Npgsql', idempotencyNamespace(model), rowsNamespace(model)], body })
  };
}

function documentStoreAdapter(model) {
  const { namespace, path } = located(model, 'persistence', ADAPTER);
  return {
    path,
    content: csFile({ namespace, usings: ['MongoDB.Bson', 'MongoDB.Driver', idempotencyNamespace(model)], body: documentIdempotencyStoreBody({ adapter: ADAPTER, port: IDEMPOTENCY_PORT }) })
  };
}

/** La línea del registro en PersistenceRegistration. */
export function idempotencyRegistration(model) {
  return usesRequestIdempotency(model) ? `        services.AddScoped<${IDEMPOTENCY_PORT}, ${ADAPTER}>();` : null;
}

/** El namespace que necesita la línea del registro. */
export function idempotencyRegistrationUsings(model) {
  return usesRequestIdempotency(model) ? [idempotencyNamespace(model), persistenceNamespace(model)] : [];
}
