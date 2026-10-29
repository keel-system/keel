// El COSTE de una petición, para los `Then` que lo afirman («el trabajo no crece con el tamaño de la página»): el
// `queryCount()` de keel-spring (hibernate.statements del actuator) y de keel-nest (un suscriptor del DataSource). Aquí
// el arnés es caja negra —el servidor es otro proceso—, así que la cuenta la lleva el SERVIDOR y la lee el arnés por
// HTTP:
//   · un `DbCommandInterceptor` de EF Core cuenta cada comando que llega al motor dentro de una petición HTTP (un
//     AsyncLocal que marca el middleware): el relay del outbox, las purgas y los barridos corren fuera y no cuentan;
//   · el middleware, delante de la correlación y de la seguridad, sirve la cuenta en `GET /__keel/statements`;
//   · las dos piezas solo se registran si el proceso arranca con KEEL_FLOW_STATEMENTS=on, que solo pone el arnés de
//     flujos (FlowServer.Launch): ni deploy/ ni producción tienen la ruta.
// Solo con API y persistencia relacional, como en los otros dos generadores.

import { csFile, located, namespaceOf } from './render.js';
import { usesApi } from './rest-support.js';
import { usesRelational } from './persistence.js';
import { usesStatementCount } from '@keel-system/keel-core/gen/features';
export { usesStatementCount };

export const STATEMENT_COUNT_VARIABLE = 'KEEL_FLOW_STATEMENTS';
export const STATEMENT_COUNT_PATH = '/__keel/statements';

export function generate(model) {
  if (!usesStatementCount(model)) return [];
  const counter = located(model, 'persistence', 'StatementCount');
  const middleware = located(model, 'rest', 'StatementCountMiddleware');
  return [
    {
      path: counter.path,
      content: csFile({
        namespace: counter.namespace,
        usings: ['System.Data.Common', 'System.Text.RegularExpressions', 'Microsoft.EntityFrameworkCore.Diagnostics'],
        body: counterBody()
      })
    },
    {
      path: middleware.path,
      content: csFile({
        namespace: middleware.namespace,
        usings: ['System.Globalization', 'Microsoft.AspNetCore.Http', namespaceOf(model, 'persistence')],
        body: middlewareBody()
      })
    }
  ];
}

function counterBody() {
  return String.raw`
/// <summary>
/// Las sentencias SQL que han emitido las peticiones HTTP desde que arrancó el proceso: lo que leen las pruebas de flujo
/// para afirmar un Then de COSTE, como el queryCount() de keel-spring y el de keel-nest. Cuenta lo que pasa por EF Core,
/// un comando por viaje al motor (un SaveChanges agrupado es uno), sin el control de la transacción (START, COMMIT, SET…),
/// que lo paga igual una página de 2 que una de 100.
/// </summary>
/// <remarks>
/// Solo se activa con <c>${STATEMENT_COUNT_VARIABLE}=on</c>, que pone el arnés de flujos al arrancar el servidor: en
/// cualquier otro arranque ni el interceptor ni la ruta existen. Lo generó keel-dotnet build: no se edita.
/// </remarks>
public static partial class StatementCount
{
    public const string Variable = "${STATEMENT_COUNT_VARIABLE}";

    private static readonly AsyncLocal<bool> InRequest = new();
    private static long statements;
    private static long reads;

    public static bool Enabled { get; } = Environment.GetEnvironmentVariable(Variable) == "on";

    /// <summary>Lecturas y escrituras de las peticiones HTTP.</summary>
    public static long Statements => Interlocked.Read(ref statements);

    /// <summary>Solo las lecturas (SELECT/WITH): para cuando el When escribe, y los INSERT crecen con lo que se guarda.</summary>
    public static long Reads => Interlocked.Read(ref reads);

    /// <summary>Marca el flujo asíncrono en curso como una petición HTTP: lo que emita desde aquí cuenta.</summary>
    public static void EnterRequest() => InRequest.Value = true;

    internal static void Count(DbCommand command)
    {
        if (!InRequest.Value || TransactionControl().IsMatch(command.CommandText))
        {
            return;
        }
        Interlocked.Increment(ref statements);
        if (ReadStatement().IsMatch(command.CommandText))
        {
            Interlocked.Increment(ref reads);
        }
    }

    [GeneratedRegex(@"^\s*(START|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TransactionControl();

    [GeneratedRegex(@"^\s*(SELECT|WITH)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReadStatement();
}

/// <summary>El interceptor que alimenta <see cref="StatementCount"/>: un comando por viaje al motor.</summary>
public sealed class StatementCountInterceptor : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        StatementCount.Count(command);
        return result;
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        StatementCount.Count(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        StatementCount.Count(command);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StatementCount.Count(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        StatementCount.Count(command);
        return result;
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<object> result,
        CancellationToken cancellationToken = default)
    {
        StatementCount.Count(command);
        return ValueTask.FromResult(result);
    }
}`;
}

function middlewareBody() {
  return String.raw`
/// <summary>
/// La cuenta de <see cref="StatementCount"/> para el arnés de flujos: sirve <c>GET ${STATEMENT_COUNT_PATH}</c> y marca
/// cualquier otra petición como trabajo que cuenta. Va delante de la correlación y de la seguridad (la lectura de la
/// cuenta no es una petición del diseño), y solo se registra con <c>StatementCount.Enabled</c>.
/// </summary>
public sealed class StatementCountMiddleware(RequestDelegate next)
{
    public const string Path = "${STATEMENT_COUNT_PATH}";

    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (HttpMethods.IsGet(context.Request.Method) && context.Request.Path == Path)
        {
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(
                string.Create(CultureInfo.InvariantCulture, $"{{\"statements\":{StatementCount.Statements},\"reads\":{StatementCount.Reads}}}"),
                context.RequestAborted);
            return;
        }
        StatementCount.EnterRequest();
        await next(context);
    }
}`;
}

/** Lo que el arranque del servidor del arnés añade a su entorno. */
export function statementCountLaunch(model) {
  if (!usesStatementCount(model)) return '';
  return `
        // El coste de las peticiones (StatementCount): solo el arnés lo enciende.
        start.Environment[${JSON.stringify(STATEMENT_COUNT_VARIABLE)}] = "on";`;
}

/** La lectura de la cuenta en Support/Harness.cs. */
export function statementCountHarnessSection(model) {
  if (!usesStatementCount(model)) return null;
  return String.raw`    /// <summary>La cuenta de sentencias del servidor del flujo (<c>${STATEMENT_COUNT_PATH}</c>): <c>statements</c> o <c>reads</c>.</summary>
    public static async Task<long> StatementsAsync(string counter, CancellationToken cancellationToken)
    {
        using var response = await Http.GetAsync(FlowServer.BaseUrl + "${STATEMENT_COUNT_PATH}", cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"No se pudo leer la cuenta de sentencias ({(int)response.StatusCode}): ¿arrancó el servidor sin ${STATEMENT_COUNT_VARIABLE}=on? {text}");
        }
        using var document = JsonDocument.Parse(text);
        return document.RootElement.GetProperty(counter).GetInt64();
    }`;
}

/** Los dos helpers de FlowTest. */
export function statementCountMembers(model) {
  if (!usesStatementCount(model)) return [];
  return [
    String.raw`    /// <summary>
    /// Sentencias SQL (lecturas y escrituras, sin el control de la transacción) que han emitido las peticiones HTTP desde
    /// que arrancó el servidor. Es para los Then de COSTE: se lee antes y después de la petición y se afirma sobre el
    /// SALTO, midiendo dos tamaños muy distintos, nunca contra un número escrito:
    /// <code>
    /// await Get($"{RouteBase}/products?size=2");          // calienta: se mide la SEGUNDA ejecución
    /// var before = await QueryCount();
    /// await Get($"{RouteBase}/products?size=2");
    /// var small = await QueryCount() - before;
    /// before = await QueryCount();
    /// await Get($"{RouteBase}/products?size=100");
    /// Assert.True(await QueryCount() - before &lt;= small, "el coste crece con la página");
    /// </code>
    /// La petición medida es la ÚNICA del intervalo, y el Given deja más elementos que el tamaño pequeño. El relay, las
    /// purgas y los barridos no cuentan: corren fuera de una petición. Leer la cuenta tampoco cuenta.
    /// </summary>
    protected static Task<long> QueryCount() => Harness.StatementsAsync("statements", TestContext.Current.CancellationToken);`,
    String.raw`    /// <summary>
    /// Solo las LECTURAS (SELECT/WITH) de <see cref="QueryCount"/>: para cuando el When ESCRIBE. Allí cuentan también
    /// los INSERT, que crecen con lo guardado, y «no crece con N» saldría rojo aunque la comprobación fuera una sola
    /// consulta por lote.
    /// </summary>
    protected static Task<long> QueryExecutions() => Harness.StatementsAsync("reads", TestContext.Current.CancellationToken);`
  ];
}

/** El humo: que la cuenta se lea. Si no, todo Then de coste fallaría por la fontanería. */
export function statementCountSmokeCase(model) {
  if (!usesStatementCount(model)) return null;
  return String.raw`    [Scenario("SMOKE-7: el servidor cuenta las sentencias de las peticiones")]
    public async Task ElServidorCuentaLasSentencias()
    {
        var before = await QueryCount();
        Assert.True(before >= 0 && await QueryExecutions() <= before, "la cuenta de sentencias no es coherente");
        // Leer la cuenta no es una petición que cuente.
        Assert.Equal(before, await QueryCount());
    }`;
}
