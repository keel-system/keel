// La ESCRITURA CONDICIONAL (DSL 2.25, `api.concurrency`) en keel-dotnet: incremento 1 de
// PLAN-DSL-225-ESCRITURA-CONDICIONAL.md. Lo que decide QUÉ (las escrituras listadas, las lecturas que dan el ETag, la
// cabecera, los errores, la nota y el gate) es de keel-core/gen/conditional-writes.js; aquí solo se escribe en C#:
//
//   · `Versioned<T>` (Application/Abstractions): lo que devuelve el handler de una lectura derivada y de una escritura
//     que devuelve su raíz (D6). El compilador obliga al agente a dar la versión.
//   · `PreconditionFailedException` (412) y `PreconditionRequiredException` (428), en Domain/Errors: DomainException con
//     el code efectivo y el texto de keel-core/gen/api-errors.js. El manejador de errores ya traduce su status.
//   · `ConditionalRequests` (Api/Rest): lee If-Match a la lista de versiones que se estampa en el mensaje (D2, D5), da el
//     428 en el borde y escribe el ETag (D1).
//   · `LoadExpecting` en el puerto de cada raíz escrita y en sus dos adaptadores (D4): la comparación es del adaptador
//     generado, no del handler, para medirla con db-check y doc-check.
//   · `infra/check-conditional-writes.sh` (CW-12), el gate neutral.

import {
  CHECK_CONDITIONAL_WRITES_SH,
  EXPECTED_VERSIONS_FIELD,
  VERSION_FIELD,
  conditionalWriteErrors,
  conditionalWriteNote,
  conditionalWritePolicy,
  conditionalWrite,
  conditionalWritesGateScript,
  conditionalWritesOf,
  returnsVersioned,
  usesConditionalWrites
} from '@keel-system/keel-core/gen/conditional-writes';
import { idParamNames } from '@keel-system/keel-core/gen/api-contract';
import { conditionalWriteCases } from '@keel-system/keel-core/gen/api-cases';
import { WIRE_ETAG_CASES } from '@keel-system/keel-core/gen/wire';
import { csFile, csLocal, csMember, csString, located, namespaceOf, solution } from './render.js';

export const VERSIONED = 'Versioned';
export const LOAD_EXPECTING_METHOD = 'LoadExpecting';
export const EXPECTED_VERSIONS = csMember(EXPECTED_VERSIONS_FIELD);

export { usesConditionalWrites, returnsVersioned };

/** El tipo de retorno de un handler que devuelve la versión: `Versioned<ProductResponseDto>`. */
export function versionedType(result) {
  return `${VERSIONED}<${result}>`;
}

/** ¿Lleva el mensaje de esta operación la versión esperada? Solo las escrituras condicionales. */
export function carriesExpectedVersions(model, operation) {
  return Boolean(conditionalWrite(model, operation));
}

/** Las raíces que una escritura condicional carga: su puerto y sus adaptadores ganan `LoadExpecting`. */
export function loadsExpecting(model, entity) {
  return (conditionalWritesOf(model)?.writes ?? []).some((write) => write.root === entity.name);
}

/** La propiedad del mensaje: la estampa el endpoint desde If-Match; desde otra puerta llega nula y no se compara. */
export function expectedVersionsProperty() {
  return `    /// <summary>
    /// Las versiones que valen, del If-Match de la petición (api.concurrency). Las estampa el endpoint generado; null
    /// —sin cabecera, '*' u otra puerta— no compara. Pásala tal cual a ${LOAD_EXPECTING_METHOD}.
    /// </summary>
    public IReadOnlyList<long>? ${EXPECTED_VERSIONS} { get; init; }`;
}

/** El método del puerto. */
export function loadExpectingPort(entity, idType, idName) {
  return `    /// <summary>
    /// Carga el agregado comparando su versión con la que el cliente leyó (If-Match, api.concurrency): si no es ninguna de
    /// <paramref name="expectedVersions"/> lanza PreconditionFailedException (412) sin tocar nada; con null no compara.
    /// Null si no existe: el NOT_FOUND del diseño va antes que el 412.
    /// </summary>
    Task<${entity.name}?> ${LOAD_EXPECTING_METHOD}(${idType} ${idName}, IReadOnlyList<long>? expectedVersions, CancellationToken cancellationToken = default);`;
}

/**
 * El método de los dos adaptadores: carga con su FindById y compara. Una carga sin transacción abierta no la necesita: la
 * escritura que siga guarda con la versión LEÍDA como valor original, así que otra escritura entre la carga y el commit
 * sigue siendo el 409 de concurrencia y no el 412 (CW-5).
 */
export function loadExpectingAdapter(entity, idType, idName) {
  const version = csMember(VERSION_FIELD);
  return `    public async Task<${entity.name}?> ${LOAD_EXPECTING_METHOD}(${idType} ${idName}, IReadOnlyList<long>? expectedVersions, CancellationToken cancellationToken = default)
    {
        var found = await FindById(${idName}, cancellationToken);
        if (found is null || expectedVersions is null)
        {
            return found;
        }
        return found.${version} is { } version && expectedVersions.Contains(version)
            ? found
            : throw new PreconditionFailedException();
    }`;
}

/** La nota del handler, la de keel-core, con los nombres de C#. */
export function conditionalHandlerNote(model, operation, param) {
  const write = conditionalWrite(model, operation);
  const root = write?.root ?? operation.responseDto?.entity ?? 'Raiz';
  const repository = `${csLocal(root)}Repository`;
  // El id de la raíz es el parámetro de ruta que la nombra ({id} o {productId}): CHK-API-CONCURRENCY-CREATE lo garantiza.
  const owns = idParamNames(root);
  const id = (operation.pathParams ?? []).find((pathParam) => owns.has(pathParam.name))?.name ?? 'id';
  return conditionalWriteNote(model, operation, {
    read: `${param}.${EXPECTED_VERSIONS}`,
    load: `${repository}.${LOAD_EXPECTING_METHOD}(${param}.${csMember(id)}, ${param}.${EXPECTED_VERSIONS}, cancellationToken)`,
    versioned: versionedType(operation.responseDto?.name ?? 'T')
  });
}

/** La línea del lector del endpoint que lee If-Match: la primera, porque el 428 va antes que todo 400 (D3). */
export function readerLine(model, operation) {
  if (!carriesExpectedVersions(model, operation)) return null;
  return `        var expectedVersions = ConditionalRequests.ExpectedVersions(httpRequest, required: ${conditionalWritePolicy(model) === 'required'});`;
}

export function generate(model) {
  if (!usesConditionalWrites(model)) return [];
  const files = [versionedFile(model), ...exceptionFiles(model), requestsFile(model)];
  const gate = conditionalWritesGateScript(model, {
    handlerPath: (row) => located(model, 'useCases', row.handlerClass).path,
    call: LOAD_EXPECTING_METHOD
  });
  if (gate) files.push({ path: CHECK_CONDITIONAL_WRITES_SH, content: gate, executable: true });
  const tests = conditionalTestsFile(model);
  if (tests) files.push(tests);
  return files;
}

function versionedFile(model) {
  const { namespace, path } = located(model, 'abstractions', VERSIONED);
  const body = `/// <summary>
/// Una respuesta con la versión de su raíz (api.concurrency): el endpoint la escribe en la cabecera ETag. La versión es
/// la PERSISTIDA —la que devuelve Save, o la del agregado leído—, nunca la que el handler tenía antes del commit: con
/// esa, el ETag va un número por detrás y la siguiente edición encadenada da 412 sin conflicto.
/// </summary>
public sealed record ${VERSIONED}<T>(long Version, T Value);`;
  return { path, content: csFile({ namespace, body }) };
}

function exceptionFiles(model) {
  const { failed, required } = conditionalWriteErrors(model);
  return [
    exceptionFile(model, 'PreconditionFailedException', failed, 'If-Match no coincide con la versión vigente: otro escribió entre la lectura y la escritura del cliente. No se escribe nada.'),
    exceptionFile(model, 'PreconditionRequiredException', required, 'La escritura exige If-Match (api.concurrency.conditionalWrites: required) y la petición no lo trae. Se responde en el borde, sin cargar nada.')
  ];
}

function exceptionFile(model, name, error, summary) {
  const { namespace, path } = located(model, 'errors', name);
  const body = `/// <summary>${summary}</summary>
public sealed class ${name}(string? message = null)
    : DomainException(message ?? DefaultMessage, code: ErrorCode, httpStatus: ErrorStatus)
{
    public const string ErrorCode = ${csString(error.code)};

    public const int ErrorStatus = ${error.status};

    public const string DefaultMessage = ${csString(error.message)};
}`;
  return { path, content: csFile({ namespace, body }) };
}

function requestsFile(model) {
  const { namespace, path } = located(model, 'rest', 'ConditionalRequests');
  const usings = ['System.Globalization', 'System.Text.RegularExpressions', 'Microsoft.AspNetCore.Http', namespaceOf(model, 'errors')];
  const body = `/// <summary>
/// La escritura condicional en el borde (api.concurrency; los casos, en keel-core/gen/wire.js). El ETag es la versión
/// entre comillas, fuerte y opaco; If-Match se compara en fuerte: '*' se cumple si el recurso existe (no compara), una
/// lista si coincide cualquiera, y un W/"…", un valor sin comillas o ilegible no coincide con nada (412, no 400).
/// </summary>
public static partial class ConditionalRequests
{
    [GeneratedRegex("^\\"(0|[1-9][0-9]*)\\"$", RegexOptions.CultureInvariant)]
    private static partial Regex StrongVersion();

    /// <summary>
    /// Lo que se estampa en el mensaje: null si no se compara (sin cabecera, vacía o '*') y si no las versiones fuertes
    /// que trae. Sin cabecera y con <paramref name="required"/>, el 428, antes de leer nada más.
    /// </summary>
    public static IReadOnlyList<long>? ExpectedVersions(HttpRequest request, bool required)
    {
        ArgumentNullException.ThrowIfNull(request);
        var header = request.Headers.IfMatch.ToString().Trim();
        if (header.Length == 0)
        {
            return required ? throw new PreconditionRequiredException() : null;
        }
        if (header == "*")
        {
            return null;
        }
        var versions = new List<long>();
        foreach (var element in header.Split(','))
        {
            var match = StrongVersion().Match(element.Trim());
            if (match.Success && long.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var version))
            {
                versions.Add(version);
            }
        }
        return versions;
    }

    /// <summary>El ETag de una versión: entre comillas, fuerte.</summary>
    public static string ETagOf(long version) => string.Create(CultureInfo.InvariantCulture, $"\\"{version}\\"");

    /// <summary>Pone el ETag de la respuesta.</summary>
    public static void WriteETag(HttpContext http, long version)
    {
        ArgumentNullException.ThrowIfNull(http);
        http.Response.Headers.ETag = ETagOf(version);
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Las pruebas emitidas (CW-6 a CW-10) ─────────────────────────────────────────────────────────────────────────

/**
 * CW-6, dentro de ApiTests (el servidor en memoria, sin base): una escritura condicional sin If-Match con `required` da
 * 428 con la forma de error del cable. Que no llegó al caso de uso lo dice el propio 428: sin base, un caso de uso que
 * empieza responde 500.
 */
export function conditionalApiTests(model) {
  const cases = conditionalWriteCases(model);
  if (!cases?.required || !cases.write) return [];
  const { write, errors } = cases;
  return [
    `    [Fact]
    public async Task CW6_UnaEscrituraCondicionalSinIfMatchEs428YNoLlegaAlCasoDeUso()
    {
        using var response = await Send(${csString(write.method)}, ${csString(write.url)});
        await ExpectError(response, ${errors.required.status}, ${csString(errors.required.error)}, ${csString(errors.required.code)}, ${csString(errors.required.message)});
    }`
  ];
}

/**
 * `ConditionalRequestsTests`: CW-7 (los casos de la cabecera de keel-core/gen/wire.js, leídos por el borde), CW-8 (la
 * precondición llega al cliente como 412 con su code y su texto), CW-9 (CORS expone ETag, si el diseño declara CORS) y
 * CW-10 (el formato del ETag).
 */
export function conditionalTestsFile(model) {
  const cases = conditionalWriteCases(model);
  if (!cases) return null;
  const sln = solution(model);
  const literal = (value) => (value == null ? 'null' : csString(value));
  const expected = (list) => (list == null ? 'null' : `new long[] { ${list.join(', ')} }`);
  const headerRows = cases.headerCases.map(
    (entry) => `    [InlineData(${csString(entry.id)}, ${literal(entry.header)}, ${expected(entry.expected)}, ${csString(entry.outcome)}, ${entry.current})]`
  );
  const cors = Boolean(model.security?.cors);
  const usings = [
    'System.Text.Json',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.Logging.Abstractions',
    'Xunit',
    `${sln.api.name}.Rest`,
    namespaceOf(model, 'errors'),
    ...(cors ? [namespaceOf(model, 'security'), namespaceOf(model, 'config')] : [])
  ];
  const { failed } = cases.errors;
  const corsTest = cors
    ? `

    [Fact]
    public void CW9_CorsExponeElETag()
    {
        // El perfil test fija los orígenes de una SPA en desarrollo (config/parameters/test/security.yaml).
        var configuration = ServiceConfiguration.Load(name => name == "PROFILE" ? "test" : null);
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("localhost");
        context.Request.Headers.Origin = "http://localhost:5173";
        new CorsPolicy(configuration).Apply(context);
        var exposed = context.Response.Headers.AccessControlExposeHeaders.ToString().Split(',', StringSplitOptions.TrimEntries);
        Assert.Contains(${csString(cases.exposedHeader)}, exposed);
    }`
    : '';
  const body = `/// <summary>
/// La escritura condicional en el borde (api.concurrency): los casos de la cabecera y del ETag son los de
/// keel-core/gen/wire.js, los mismos que ejecutan los otros generadores. La comparación con la versión la hace el
/// adaptador (LoadExpecting), y la miden db-check y doc-check.
/// </summary>
public sealed class ConditionalRequestsTests
{
    [Theory]
${headerRows.join('\n')}
    public void CW7_IfMatchSeLeeComoDicenLosCasosDelCable(string id, string? header, long[]? expected, string outcome, long current)
    {
        var request = new DefaultHttpContext().Request;
        if (header is not null)
        {
            request.Headers.IfMatch = header;
        }
        var stamped = ConditionalRequests.ExpectedVersions(request, required: false);
        Assert.True(expected is null ? stamped is null : stamped is not null && expected.SequenceEqual(stamped), id);
        // Ausente es el 428 con required, y eso lo afirma CW-6 en el servidor: aquí solo que no se compara.
        if (outcome == "absent")
        {
            return;
        }
        // Lo mismo que compara LoadExpecting: null no compara; si no, la vigente tiene que estar en la lista.
        var matches = stamped is null || stamped.Contains(current);
        Assert.Equal(outcome == "match", matches);
    }

    [Fact]
    public async Task CW8_LaPrecondicionEs412ConSuCodeYSuTexto()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        var middleware = new ApiErrorMiddleware(_ => throw new PreconditionFailedException(), NullLogger<ApiErrorMiddleware>.Instance);
        await middleware.InvokeAsync(context);
        Assert.Equal(${failed.status}, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        using var document = await JsonDocument.ParseAsync(context.Response.Body, cancellationToken: TestContext.Current.CancellationToken);
        var body = document.RootElement;
        Assert.Equal(${failed.status}, body.GetProperty("status").GetInt32());
        Assert.Equal(${csString(failed.error)}, body.GetProperty("error").GetString());
        Assert.Equal(${csString(failed.code)}, body.GetProperty("code").GetString());
        Assert.Equal(${csString(failed.message)}, body.GetProperty("message").GetString());
    }

    [Theory]
${WIRE_ETAG_CASES.map((entry) => `    [InlineData(${entry.version}, ${csString(entry.etag)})]`).join('\n')}
    public void CW10_ElETagEsLaVersionEntreComillas(long version, string etag)
    {
        Assert.Equal(etag, ConditionalRequests.ETagOf(version));
        var context = new DefaultHttpContext();
        ConditionalRequests.WriteETag(context, version);
        Assert.Equal(etag, context.Response.Headers.ETag.ToString());
    }${corsTest}
}`;
  return { path: `${sln.unitTests.dir}/ConditionalRequestsTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}
