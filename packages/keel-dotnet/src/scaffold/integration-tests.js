// El arnés de integración del proyecto generado: el proyecto `tests/<Raíz>.IntegrationTests`, la base de la que
// cuelgan las pruebas de flujo (`<Flujo>Flow.cs`) que escribe el agente de pruebas a partir de
// specs/validation-scenarios.md, el humo que comprueba la fontanería y `infra/score-scenarios.sh`, que puntúa el
// XML JUnit.
//
// Es el equivalente de AbstractFlowIT + FailureCapture + HarnessSmokeIT de keel-spring y de `useFlow()` de
// keel-nest, con las mismas promesas: el servidor REAL escuchando en un puerto libre contra la infraestructura de
// `infra/`, peticiones HTTP de verdad, el reset de estado por flujo con `infra/reset-db.sh`, y la evidencia de cada
// fallo volcada a `build/keel-failures/<FL-id>.json` con el último intercambio y el último sondeo, que es lo que
// lee el árbitro.
//
// **Caja negra por construcción**, como en keel-spring (allí src/main/java está fuera del classpath del source set):
// el proyecto de flujos NO referencia ningún proyecto del servicio —solo ordena la compilación del Api, sin ver sus
// tipos (`ReferenceOutputAssembly="false"`)— y arranca el servidor como un PROCESO aparte, el mismo ejecutable que
// se despliega. Un flujo que nombre un tipo del servicio no compila.
//
// La matriz se lee con los MISMOS programas awk que la de keel-spring y keel-nest (keel-core/gen/junit-scoring):
// xUnit v3 escribe JUnit con el `DisplayName` del caso en `name` y la clase en `classname`. Un escenario no puede
// puntuar distinto según el generador.
//
// Aquí NO se genera ninguna prueba de flujo: eso es derivado del diseño y lo escribe el agente.

import { DATABASES, selectedInfra } from 'keel-core/gen/infra-catalog';
import { JUNIT_MATRIX_AWK, JUNIT_NON_SCENARIO_AWK, SCENARIO_DOCUMENT_SCORING, FOREIGN_ROWS_PRINT, specsSealCheck } from 'keel-core/gen/junit-scoring';
import { resetDbScript } from 'keel-core/gen/infra-scripts';
import { TARGET_FRAMEWORK } from '../lib/assets.js';
import { DOTNET_INFRA } from './infra.js';
import { usesApi } from './rest-support.js';
import { usesRelational } from './persistence.js';
import { csFile, csString, solution } from './render.js';
import { messagingHarnessCs, messagingSmokeCase, usesMessagingHarness } from './messaging-harness.js';
import { closingCredentialExpression, credentialsCs, flowTestCredentialMembers, smokeCredentialsCase } from './identity-harness.js';

export const INTEGRATION_RESULTS = 'build/test-results/integration';
export const SCORE_SCENARIOS_SH = 'infra/score-scenarios.sh';
export const CHECK_FLOWS_SH = 'infra/check-flows.sh';
/** La clase del humo: el script la ejecuta sola, antes que la suite. */
export const HARNESS_SMOKE_CLASS = 'HarnessSmoke';

export function supportNamespace(model) {
  return `${solution(model).integrationTests.name}.Support`;
}

export function generate(model) {
  const project = solution(model).integrationTests;
  return [
    { path: project.csproj, content: integrationTestsCsproj(model) },
    { path: `${project.dir}/AssemblyInfo.cs`, content: assemblyInfoCs(model) },
    { path: `${project.dir}/Support/FlowTest.cs`, content: flowTestCs(model) },
    { path: `${project.dir}/Support/FlowResponse.cs`, content: flowResponseCs(model) },
    { path: `${project.dir}/Support/FlowServer.cs`, content: flowServerCs(model) },
    { path: `${project.dir}/Support/FailureCapture.cs`, content: failureCaptureCs(model) },
    { path: `${project.dir}/Support/Harness.cs`, content: harnessCs(model) },
    { path: `${project.dir}/Support/JsonShape.cs`, content: jsonShapeCs(model) },
    { path: `${project.dir}/Support/ScenarioOrder.cs`, content: scenarioOrderCs(model) },
    // Con capa security, las credenciales del proveedor de prueba (identity-harness.js).
    ...[credentialsCs(model, supportNamespace(model))].filter(Boolean).map((content) => ({ path: `${project.dir}/Support/Credentials.cs`, content })),
    // Con mensajería, los helpers del broker y del outbox (messaging-harness.js).
    ...[messagingHarnessCs(model, supportNamespace(model))].filter(Boolean).map((content) => ({ path: `${project.dir}/Support/Messaging.cs`, content })),
    { path: `${project.dir}/${HARNESS_SMOKE_CLASS}.cs`, content: harnessSmokeCs(model) },
    { path: SCORE_SCENARIOS_SH, content: scoreScenariosScript(model) },
    { path: CHECK_FLOWS_SH, content: checkFlowsScript(model) }
  ];
}

/** ¿Hay `infra/reset-db.sh`? Las mismas condiciones con las que lo escribe infra-scripts.js. */
export function hasResetScript(model) {
  return resetDbScript(selectedInfra(model), model.service, model, DOTNET_INFRA) !== null;
}

/** La base de prueba como contenedor al que se le pueden mandar sentencias (relacional con CLI). */
function dbProbe(model) {
  if (!usesRelational(model)) return null;
  const entry = DATABASES[model.stack?.database ?? 'postgresql'];
  if (!entry?.cliQueryArgv || !entry.composeService) return null;
  const dbName = model.service.name.replaceAll('-', '_');
  return {
    container: `${model.service.name}-db`,
    argv: entry.cliQueryArgv({ user: entry.user ? entry.user(dbName) : '', pass: entry.password ?? '', db: dbName }),
    label: entry.label
  };
}

/** Lo que el proyecto de flujos tiene que saber del Api para arrancarlo: su nombre y dónde deja el ejecutable. */
function apiLaunch(model) {
  const api = solution(model).api;
  return { project: api.name, dir: api.dir };
}

// ─── Support/FlowTest.cs ─────────────────────────────────────────────────────────────────────────

function flowTestCs(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const helpers = [];
  if (reset) {
    helpers.push(String.raw`    /// <summary>
    /// Deja el estado como recién arrancado: exactamente lo que enumera <c>infra/reset-db.sh</c>. La base ya lo
    /// llama al empezar cada flujo; llamarlo a mano solo tiene sentido para un escenario que tenga que empezar de cero.
    /// </summary>
    protected static void ResetState() => Harness.ResetState();`);
  }
  // Las credenciales del proveedor de prueba, con capa security: atajos sobre Support/Credentials.cs.
  helpers.push(...flowTestCredentialMembers(model));
  if (probe) {
    helpers.push(String.raw`    /// <summary>
    /// Ejecuta una sentencia contra la base de prueba (${probe.label}) y devuelve su salida en crudo. Es para lo que
    /// no se ve por HTTP: que una escritura llegó de verdad al almacén, o la precondición de un escenario que ninguna
    /// operación del diseño puede fabricar. Si el servicio lo expone por su API, se comprueba por ahí.
    /// </summary>
    protected static string Db(string sql) => Harness.Db(sql);`);
  }
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Collections.Concurrent', 'Xunit'],
    body: String.raw`
/// <summary>
/// Base de las pruebas de flujo (<c>&lt;Flujo&gt;Flow.cs</c>) que ejecutan los escenarios FL-* de
/// specs/validation-scenarios.md contra el servidor REAL —un proceso aparte, escuchando en un puerto libre bajo el
/// perfil <c>local</c>— y la infraestructura de infra/docker-compose.yaml.
/// </summary>
/// <remarks>
/// Uso, una clase por flujo:
/// <code>
/// public sealed class ProductCreationFlow : FlowTest
/// {
///     [Scenario("FL-PRD-001-A: crea el producto")]
///     public async Task CreaElProducto()
///     {
///         var response = await Post($"{RouteBase}/products", new { sku = "A-1" });
///         Assert.Equal(201, response.Status);
///     }
/// }
/// </code>
/// <para><b>Caja negra.</b> El proyecto no ve ningún tipo del servicio: los escenarios se expresan con HTTP y JSON,
/// que es lo que exige la equivalencia con los servidores de keel-spring y keel-nest del mismo diseño.</para>
/// <para><b>El título de cada caso empieza por su id</b> y dos puntos (<c>FL-PRD-001-A: …</c>): de ahí sale la
/// matriz de infra/score-scenarios.sh, y el nombre del volcado de su evidencia. Los casos de un flujo se ejecutan
/// en el ORDEN en que están escritos (<see cref="ScenarioAttribute"/>): dentro de un flujo, un escenario usa lo que
/// dejó el anterior.</para>
/// <para>Al empezar cada flujo se arranca el servidor (una vez por suite)${reset ? ', se resetea el estado' : ''} y se
/// ejecuta <see cref="GivenAsync"/>. Si eso falla, los casos del flujo salen OMITIDOS y se vuelca
/// <c>build/keel-failures/&lt;Flujo&gt;-init.json</c>: infra/score-scenarios.sh lo lee para decir que el arnés —no el
/// servidor— está roto.</para>
/// <para>Lo generó keel-dotnet build: no se edita. Lo que un flujo necesite y no esté aquí se escribe en la propia
/// clase del flujo.</para>
/// </remarks>
public abstract partial class FlowTest : IAsyncLifetime
{
${api ? `    /// <summary>Prefijo de todas las rutas del servicio (basePath del diseño + versión).</summary>
    public const string RouteBase = ${csString(model.api.routeBase)};

` : ''}    // El arranque de cada flujo: una vez por clase (xUnit crea una instancia por caso). Los flujos corren en serie.
    private static readonly ConcurrentDictionary<Type, string?> Prepared = new();

    /// <summary>
    /// El Given común a todo el flujo, después del reset: lo que el flujo necesita antes de su primer escenario y
    /// ninguna operación del diseño fabrica. Se ejecuta una vez por flujo.
    /// </summary>
    protected virtual Task GivenAsync() => Task.CompletedTask;

    public async ValueTask InitializeAsync()
    {
        FailureCapture.Clear();
        var flow = GetType();
        if (Prepared.TryGetValue(flow, out var failure))
        {
            if (failure is not null) Assert.Skip($"El flujo no llegó a arrancar: {failure}");
            return;
        }
        try
        {
            await FlowServer.EnsureStartedAsync(TestContext.Current.CancellationToken);${reset ? `
            Harness.ResetState();` : ''}${usesMessagingHarness(model) ? `
            // El broker arriba (un flujo anterior pudo dejarlo parado) y el servidor conectado a él.
            await BrokerHarness.PrepareAsync();` : ''}
            await GivenAsync();
            Prepared[flow] = null;
        }
        catch (Exception error)
        {
            Prepared[flow] = error.Message;
            FailureCapture.DumpInit(flow.Name, error);
            Assert.Skip($"El flujo no llegó a arrancar: {error.Message}");
        }
        finally
        {
            FailureCapture.Clear();
        }
    }

    public ValueTask DisposeAsync()
    {
        var state = TestContext.Current.TestState;
        if (state?.Result == TestResult.Failed) FailureCapture.DumpFailure(TestContext.Current.Test?.TestDisplayName ?? "", GetType().Name, state);
        FailureCapture.Clear();
        GC.SuppressFinalize(this);
        return ValueTask.CompletedTask;
    }

    /// <summary>URL base del servidor arrancado (http://127.0.0.1:&lt;puerto&gt;).</summary>
    protected static string BaseUrl => FlowServer.BaseUrl;

    protected static Task<FlowResponse> Get(string path, Dictionary<string, string>? headers = null) => Exchange("GET", path, null, headers);

    /// <summary><paramref name="body"/> es un objeto (se serializa) o el JSON ya escrito, tal cual viaja.</summary>
    protected static Task<FlowResponse> Post(string path, object? body = null, Dictionary<string, string>? headers = null) => Exchange("POST", path, body, headers);

    protected static Task<FlowResponse> Put(string path, object? body = null, Dictionary<string, string>? headers = null) => Exchange("PUT", path, body, headers);

    protected static Task<FlowResponse> Patch(string path, object? body = null, Dictionary<string, string>? headers = null) => Exchange("PATCH", path, body, headers);

    protected static Task<FlowResponse> Delete(string path, Dictionary<string, string>? headers = null) => Exchange("DELETE", path, null, headers);

    /// <summary>Una petición HTTP de verdad. Nunca lanza por un 4xx/5xx: el status es una aserción del escenario.</summary>
    protected static Task<FlowResponse> Exchange(string method, string path, object? body = null, Dictionary<string, string>? headers = null) =>
        Harness.SendAsync(method, path, body, headers, TestContext.Current.CancellationToken);

${helpers.length > 0 ? `${helpers.join('\n\n')}\n\n` : ''}    /// <summary>
    /// Ejecuta un comando y devuelve su salida; lanza nombrando sus últimas líneas si sale mal. Los argumentos van
    /// siempre como lista, nunca armados para un shell.
    /// </summary>
    protected static string Run(string command, IEnumerable<string> arguments, string hint = "") => Harness.Run(command, arguments, hint);

    /// <summary>Espera hasta que <paramref name="condition"/> se cumpla o se agote el plazo; falla con <paramref name="message"/> si no llega.</summary>
    protected static Task Eventually(Func<Task<bool>> condition, TimeSpan? timeout = null, string message = "la condición no se cumplió a tiempo") =>
        Harness.EventuallyAsync(condition, timeout ?? TimeSpan.FromSeconds(10), message, TestContext.Current.CancellationToken);

    /// <summary>
    /// Compara el cuerpo con el JSON esperado, ESTRICTO: las mismas claves, los números por su texto exacto
    /// (<c>2.50</c> no es <c>2.5</c>: la escala es contrato) y las listas en orden. Un valor <c>"&lt;uuid&gt;"</c>,
    /// <c>"&lt;instant&gt;"</c> o <c>"&lt;any&gt;"</c> afirma solo la forma de lo que genera el servidor.
    /// </summary>
    protected static void AssertJson(string expected, FlowResponse response) => JsonShape.AssertMatches(expected, response.Json());
}
`
  });
}

// ─── Support/FlowResponse.cs ─────────────────────────────────────────────────────────────────────

function flowResponseCs(model) {
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Text.Json'],
    body: String.raw`
/// <summary>Intercambio HTTP completo: lo que se afirma y lo que se vuelca al fallar.</summary>
public sealed class FlowResponse(int status, IReadOnlyDictionary<string, string> headers, string body)
{
    public int Status { get; } = status;

    /// <summary>Cabeceras de la respuesta (las del contenido incluidas), con el nombre en minúsculas.</summary>
    public IReadOnlyDictionary<string, string> Headers { get; } = headers;

    public string Body { get; } = body;

    /// <summary>Una cabecera por nombre, sin distinguir mayúsculas; null si no vino.</summary>
    public string? Header(string name) => Headers.TryGetValue(name.ToLowerInvariant(), out var value) ? value : null;

    /// <summary>
    /// El cuerpo leído como JSON. Lanza nombrando el cuerpo si no lo es. Un número conserva su texto: para afirmar la
    /// escala de un decimal, <c>GetRawText()</c> (<c>"2.50"</c>), nunca <c>GetDecimal()</c>.
    /// </summary>
    public JsonElement Json()
    {
        try
        {
            using var document = JsonDocument.Parse(Body);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new InvalidOperationException($"La respuesta no es JSON (status {Status}): {(Body.Length > 400 ? Body[..400] : Body)}");
        }
    }

    public override string ToString() => $"{Status} {Body}";
}
`
  });
}

// ─── Support/FlowServer.cs ───────────────────────────────────────────────────────────────────────

function flowServerCs(model) {
  const launch = apiLaunch(model);
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Diagnostics', 'System.Net', 'System.Net.Sockets', 'System.Reflection', 'Xunit'],
    body: String.raw`
/// <summary>
/// El servidor del servicio, arrancado UNA vez por suite como un proceso aparte: el mismo ejecutable que se
/// despliega (<c>${launch.dir}</c>), bajo el perfil <c>local</c> (o el de <c>PROFILE</c>), escuchando en
/// 127.0.0.1 en un puerto libre. Su salida va a <c>build/keel-scenarios/server.log</c>: es la evidencia de un
/// arranque que no llega o de un 500.
/// </summary>
internal static class FlowServer
{
    private const string ApiProject = ${csString(launch.project)};
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(90);
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly HttpClient Probe = new() { Timeout = TimeSpan.FromSeconds(5) };
    private static readonly object LogLock = new();
    private static Process? process;
    private static StreamWriter? log;
    private static string? failure;

    public static string BaseUrl { get; private set; } = "";

    public static string LogPath => Path.Combine(Harness.Root, "build", "keel-scenarios", "server.log");

    public static async Task EnsureStartedAsync(CancellationToken cancellationToken)
    {
        await Gate.WaitAsync(cancellationToken);
        try
        {
            if (failure is not null) throw new InvalidOperationException(failure);
            if (process is { HasExited: false }) return;
            if (process is { HasExited: true })
            {
                failure = $"el servidor terminó a mitad de la suite (código {process.ExitCode}). Log: {LogPath}\n{LogTail()}";
                throw new InvalidOperationException(failure);
            }
            try
            {
                await StartAsync(cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                failure = error.Message;
                Stop();
                throw;
            }
        }
        finally
        {
            Gate.Release();
        }
    }

    private static async Task StartAsync(CancellationToken cancellationToken)
    {
        var dll = ApiAssembly();
        if (!File.Exists(dll))
        {
            throw new InvalidOperationException($"No está compilado el servidor ({dll}): compila la solución antes (dotnet build).");
        }
        var port = FreePort();
        var start = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = Harness.Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(dll);
        start.Environment["PROFILE"] = Environment.GetEnvironmentVariable("PROFILE") ?? "local";
        start.Environment["SERVER_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["SERVER_ADDRESS"] = "127.0.0.1";
        start.Environment["DOTNET_NOLOGO"] = "1";

        Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
        log = new StreamWriter(LogPath, append: false) { AutoFlush = true };
        process = new Process { StartInfo = start };
        process.OutputDataReceived += (_, line) => Write(line.Data);
        process.ErrorDataReceived += (_, line) => Write(line.Data);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Stop();

        BaseUrl = $"http://127.0.0.1:{port}";
        var until = DateTime.UtcNow + StartTimeout;
        while (DateTime.UtcNow < until)
        {
            if (process.HasExited)
            {
                throw new InvalidOperationException($"el servidor no arrancó (salió con código {process.ExitCode}). Log: {LogPath}\n{LogTail()}");
            }
            try
            {
                using var response = await Probe.GetAsync($"{BaseUrl}/livez", cancellationToken);
                if (response.StatusCode == HttpStatusCode.OK) return;
            }
            catch (HttpRequestException)
            {
                // Todavía no escucha.
            }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // La sonda agotó su plazo: se reintenta.
            }
            await Task.Delay(200, cancellationToken);
        }
        throw new InvalidOperationException($"el servidor no respondió /livez en {StartTimeout.TotalSeconds} s. Log: {LogPath}\n{LogTail()}");
    }

    /// <summary>Para el servidor (y lo que haya lanzado). Lo llama el final de la suite y la salida del proceso.</summary>
    public static void Stop()
    {
        try
        {
            if (process is { HasExited: false }) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Ya había terminado.
        }
        lock (LogLock)
        {
            log?.Dispose();
            log = null;
        }
    }

    /// <summary>Las últimas líneas del log del servidor, para el mensaje de un arranque que falla.</summary>
    public static string LogTail(int lines = 20)
    {
        lock (LogLock)
        {
            log?.Flush();
            if (!File.Exists(LogPath)) return "(sin log)";
            using var stream = new FileStream(LogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            var all = reader.ReadToEnd().Split('\n');
            return string.Join('\n', all.TakeLast(lines)).TrimEnd();
        }
    }

    private static void Write(string? line)
    {
        if (line is null) return;
        lock (LogLock) log?.WriteLine(line);
    }

    /// <summary>
    /// El ejecutable del Api, en la configuración con la que se compiló este proyecto (Debug o Release): el
    /// proyecto de flujos ordena su compilación sin ver sus tipos.
    /// </summary>
    private static string ApiAssembly()
    {
        var configuration = typeof(FlowServer).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(attribute => attribute.Key == "Configuration")?.Value ?? "Debug";
        return Path.Combine(Harness.Root, "src", ApiProject, "bin", configuration, ${csString(TARGET_FRAMEWORK)}, $"{ApiProject}.dll");
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}

/// <summary>Para el servidor al terminar la suite (xUnit libera los fixtures de ensamblado al final).</summary>
public sealed class FlowServerShutdown : IAsyncDisposable
{
    public ValueTask DisposeAsync()
    {
        FlowServer.Stop();
        return ValueTask.CompletedTask;
    }
}
`
  });
}

// ─── Support/FailureCapture.cs ───────────────────────────────────────────────────────────────────

function failureCaptureCs(model) {
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Text.Encodings.Web', 'System.Text.Json', 'Xunit'],
    body: String.raw`
/// <summary>Un intercambio HTTP tal como viajó: lo que el árbitro lee sin reproducir el escenario a mano.</summary>
internal sealed record ExchangeRecord(
    string Method, string Path, IReadOnlyDictionary<string, string> RequestHeaders, string? RequestBody,
    int Status, IReadOnlyDictionary<string, string> ResponseHeaders, string ResponseBody);

/// <summary>Un comando que no es HTTP (la base, el reset): lo que se ejecutó, cómo salió y qué escribió.</summary>
internal sealed record ProbeRecord(string Command, int? ExitCode, string Output);

/// <summary>
/// La evidencia de cada fallo, volcada a <c>build/keel-failures/&lt;escenario&gt;.json</c> con el último
/// intercambio y el último sondeo: es lo que lee el árbitro junto al XML para decidir
/// <c>culprit: code | test | design</c>. Mismo formato que el de keel-spring y keel-nest.
/// </summary>
internal static class FailureCapture
{
    // Los flujos corren en serie y cada caso espera a sus peticiones: basta con lo último del proceso.
    private static ExchangeRecord? lastExchange;
    private static ProbeRecord? lastProbe;

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static string Directory => Path.Combine(Harness.Root, "build", "keel-failures");

    public static void RecordExchange(ExchangeRecord exchange) => lastExchange = exchange;

    public static void RecordProbe(ProbeRecord probe) => lastProbe = probe;

    public static void Clear()
    {
        lastExchange = null;
        lastProbe = null;
    }

    /// <summary>El fallo de un caso: el id es lo que va delante de los dos puntos de su título.</summary>
    public static void DumpFailure(string displayName, string testClass, TestResultState state)
    {
        var scenario = displayName.Split(':')[0].Trim();
        var assertion = string.Join("\n", state.ExceptionMessages ?? []);
        Dump(scenario, displayName, testClass, null, assertion);
    }

    /// <summary>Un flujo que no llegó a arrancar: <c>&lt;Flujo&gt;-init.json</c>.</summary>
    public static void DumpInit(string testClass, Exception error) => Dump($"{testClass}-init", testClass, testClass, "init", error.Message);

    private static void Dump(string scenario, string displayName, string testClass, string? phase, string assertion)
    {
        var report = new Dictionary<string, object?> { ["scenario"] = scenario, ["displayName"] = displayName, ["testClass"] = testClass };
        if (phase is not null) report["phase"] = phase;
        report["assertion"] = assertion;
        if (lastExchange is { } exchange)
        {
            report["request"] = new Dictionary<string, object?> { ["method"] = exchange.Method, ["path"] = exchange.Path, ["headers"] = exchange.RequestHeaders, ["body"] = exchange.RequestBody };
            report["response"] = new Dictionary<string, object?> { ["status"] = exchange.Status, ["headers"] = exchange.ResponseHeaders, ["body"] = exchange.ResponseBody };
        }
        if (lastProbe is { } probe)
        {
            report["probe"] = new Dictionary<string, object?> { ["command"] = probe.Command, ["exitCode"] = probe.ExitCode, ["output"] = probe.Output };
        }
        var name = new string(scenario.Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-' ? c : '_').ToArray());
        System.IO.Directory.CreateDirectory(Directory);
        File.WriteAllText(Path.Combine(Directory, $"{(name.Length > 0 ? name : "unnamed")}.json"), JsonSerializer.Serialize(report, Options) + "\n");
        Clear();
    }
}
`
  });
}

// ─── Support/Harness.cs ──────────────────────────────────────────────────────────────────────────

function harnessCs(model) {
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const sections = [];
  if (reset) {
    sections.push(String.raw`    public static void ResetState() => Run(BashExecutable(), ["infra/reset-db.sh"], "¿Está la infraestructura arriba (bash infra/up.sh)?");`);
  }
  if (probe) {
    sections.push(String.raw`    private const string DbContainer = ${csString(probe.container)};
    private static readonly string[] DbQueryArguments = [${probe.argv.map(csString).join(', ')}];

    /// <summary>La sentencia viaja como UN argumento más, nunca armada para un shell.</summary>
    public static string Db(string sql) => Run(ContainerRuntime(), ["exec", DbContainer, .. DbQueryArguments, sql], "¿Está la base arriba (bash infra/up.sh)?");`);
  }
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Diagnostics', 'System.Text', 'System.Text.Json'],
    body: String.raw`
/// <summary>La fontanería del arnés: la raíz del proyecto, el cliente HTTP, los comandos y la base de prueba.</summary>
internal static class Harness
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    /// <summary>La raíz del proyecto (donde está la solución): todo lo de infra/ y build/ cuelga de ahí.</summary>
    public static string Root { get; } = FindRoot();

    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (dir.GetFiles(${csString(solution(model).file)}).Length > 0) return dir.FullName;
        }
        throw new InvalidOperationException("No se encontró la raíz del proyecto (${solution(model).file}) por encima de " + AppContext.BaseDirectory);
    }

    public static async Task<FlowResponse> SendAsync(string method, string path, object? body, IReadOnlyDictionary<string, string>? headers, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(FlowServer.BaseUrl)) throw new InvalidOperationException("El servidor no está arrancado: la prueba de flujo hereda de FlowTest.");
        var payload = body switch
        {
            null => null,
            string json => json,
            _ => JsonSerializer.Serialize(body)
        };
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(new Uri(FlowServer.BaseUrl), path));
        var sent = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Accept"] = "application/json" };
        foreach (var (name, value) in headers ?? new Dictionary<string, string>()) sent[name] = value;
        string? contentType = null;
        foreach (var (name, value) in sent)
        {
            if (name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) contentType = value;
            else request.Headers.TryAddWithoutValidation(name, value);
        }
        if (payload is not null)
        {
            request.Content = new StringContent(payload, Encoding.UTF8);
            request.Content.Headers.Remove("Content-Type");
            request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType ?? "application/json");
            sent["Content-Type"] = contentType ?? "application/json";
        }
        using var response = await Http.SendAsync(request, cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        var received = new Dictionary<string, string>();
        foreach (var header in response.Headers.Concat(response.Content.Headers)) received[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
        FailureCapture.RecordExchange(new ExchangeRecord(method, path, sent, payload, (int)response.StatusCode, received, text));
        return new FlowResponse((int)response.StatusCode, received, text);
    }

    public static string Run(string command, IEnumerable<string> arguments, string hint = "", string? input = null)
    {
        var start = new ProcessStartInfo(command)
        {
            WorkingDirectory = Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = input is not null,
            UseShellExecute = false
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        var line = string.Join(' ', start.ArgumentList.Prepend(command));
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"no se pudo lanzar {command}");
        if (input is not null)
        {
            // Lo que viaja por la entrada estándar (un cuerpo que se copia a un contenedor), sin pasar por el argv.
            process.StandardInput.Write(input);
            process.StandardInput.Close();
        }
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        var output = stdout + stderr.Result;
        FailureCapture.RecordProbe(new ProbeRecord(line, process.ExitCode, output));
        if (process.ExitCode != 0)
        {
            var tail = string.Join('\n', output.Trim().Split('\n').TakeLast(12));
            throw new InvalidOperationException($"{line} falló (código {process.ExitCode}). {hint}\n{(tail.Length > 0 ? tail : "(no escribió nada)")}");
        }
        return stdout;
    }

    public static async Task EventuallyAsync(Func<Task<bool>> condition, TimeSpan timeout, string message, CancellationToken cancellationToken)
    {
        var until = DateTime.UtcNow + timeout;
        while (true)
        {
            if (await condition()) return;
            if (DateTime.UtcNow > until) throw new TimeoutException(message);
            await Task.Delay(200, cancellationToken);
        }
    }

    /// <summary>
    /// El bash con el que se invocan los scripts de infra/. En Windows, <c>bash</c> a secas puede resolver al
    /// lanzador de WSL (System32 va antes que el PATH), un Linux aislado que no ve el PATH ni las variables de
    /// Windows: se busca el de Git for Windows, con override por <c>BASH_EXECUTABLE</c>.
    /// </summary>
    public static string BashExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("BASH_EXECUTABLE");
        if (!string.IsNullOrEmpty(configured)) return configured;
        if (OperatingSystem.IsWindows())
        {
            string?[] candidates =
            [
                Environment.GetEnvironmentVariable("ProgramFiles") is { } programFiles ? Path.Combine(programFiles, "Git", "bin", "bash.exe") : null,
                Environment.GetEnvironmentVariable("ProgramFiles(x86)") is { } programFilesX86 ? Path.Combine(programFilesX86, "Git", "bin", "bash.exe") : null,
                Environment.GetEnvironmentVariable("LOCALAPPDATA") is { } localAppData ? Path.Combine(localAppData, "Programs", "Git", "bin", "bash.exe") : null
            ];
            foreach (var candidate in candidates) if (candidate is not null && File.Exists(candidate)) return candidate;
        }
        return "bash";
    }

    /// <summary>El runtime de contenedores: <c>CONTAINER_RUNTIME</c>, o docker si está, o podman.</summary>
    public static string ContainerRuntime()
    {
        var configured = Environment.GetEnvironmentVariable("CONTAINER_RUNTIME");
        if (!string.IsNullOrEmpty(configured)) return configured;
        try
        {
            using var docker = Process.Start(new ProcessStartInfo("docker", "--version") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false });
            docker?.WaitForExit();
            if (docker?.ExitCode == 0) return "docker";
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // docker no está instalado.
        }
        return "podman";
    }
${sections.length > 0 ? `\n${sections.join('\n\n')}\n` : ''}}
`
  });
}

// ─── Support/JsonShape.cs ────────────────────────────────────────────────────────────────────────

function jsonShapeCs(model) {
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Text.Json', 'System.Text.RegularExpressions', 'Xunit'],
    body: String.raw`
/// <summary>
/// La comparación estricta de un cuerpo JSON con el esperado, el <c>toStrictEqual</c> de keel-nest: las mismas
/// claves (ni una de más ni de menos), los números por su TEXTO (la escala de un decimal es contrato observable), las
/// listas en orden, y tres comodines de forma para lo que genera el servidor.
/// </summary>
internal static partial class JsonShape
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z")]
    private static partial Regex Uuid();

    // ISO-8601 en UTC con exactamente tres decimales y Z: el instante del contrato del cable.
    [GeneratedRegex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\z")]
    private static partial Regex Instant();

    public static void AssertMatches(string expected, JsonElement actual)
    {
        using var document = JsonDocument.Parse(expected);
        var problems = new List<string>();
        Compare(document.RootElement, actual, "$", problems);
        if (problems.Count > 0) Assert.Fail($"El JSON no casa con el esperado:\n  {string.Join("\n  ", problems)}\nrecibido: {actual.GetRawText()}");
    }

    private static void Compare(JsonElement expected, JsonElement actual, string path, List<string> problems)
    {
        if (expected.ValueKind == JsonValueKind.String && expected.GetString() is "<uuid>" or "<instant>" or "<any>")
        {
            var shape = expected.GetString();
            if (shape == "<any>") return;
            var ok = actual.ValueKind == JsonValueKind.String && (shape == "<uuid>" ? Uuid() : Instant()).IsMatch(actual.GetString()!);
            if (!ok) problems.Add($"{path}: se esperaba la forma {shape} y llegó {actual.GetRawText()}");
            return;
        }
        if (expected.ValueKind != actual.ValueKind)
        {
            problems.Add($"{path}: se esperaba {expected.GetRawText()} y llegó {actual.GetRawText()}");
            return;
        }
        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
                var expectedNames = expected.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
                foreach (var property in actual.EnumerateObject())
                {
                    if (!expectedNames.Contains(property.Name)) problems.Add($"{path}.{property.Name}: sobra (llegó {property.Value.GetRawText()})");
                }
                foreach (var property in expected.EnumerateObject())
                {
                    if (actual.TryGetProperty(property.Name, out var value)) Compare(property.Value, value, $"{path}.{property.Name}", problems);
                    else problems.Add($"{path}.{property.Name}: falta");
                }
                break;
            case JsonValueKind.Array:
                var expectedItems = expected.EnumerateArray().ToList();
                var actualItems = actual.EnumerateArray().ToList();
                if (expectedItems.Count != actualItems.Count) problems.Add($"{path}: se esperaban {expectedItems.Count} elemento(s) y llegaron {actualItems.Count}");
                for (var i = 0; i < Math.Min(expectedItems.Count, actualItems.Count); i++) Compare(expectedItems[i], actualItems[i], $"{path}[{i}]", problems);
                break;
            default:
                // Números por su texto exacto (2.50 no es 2.5); cadenas, booleanos y null, por su valor.
                if (expected.GetRawText() != actual.GetRawText()) problems.Add($"{path}: se esperaba {expected.GetRawText()} y llegó {actual.GetRawText()}");
                break;
        }
    }
}
`
  });
}

// ─── Support/ScenarioOrder.cs ────────────────────────────────────────────────────────────────────

function scenarioOrderCs(model) {
  return csFile({
    namespace: supportNamespace(model),
    usings: ['System.Reflection', 'System.Runtime.CompilerServices', 'Xunit', 'Xunit.Sdk', 'Xunit.v3'],
    body: String.raw`
/// <summary>
/// Un escenario de un flujo: el título (<c>FL-PRD-001-A: …</c>) es el nombre del caso en el XML, y los escenarios
/// de un flujo se ejecutan en el orden en que están ESCRITOS (el de keel-spring con <c>@Order</c> y el de keel-nest
/// por declaración). xUnit, por defecto, los ordena por un hash.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ScenarioAttribute : FactAttribute
{
    public ScenarioAttribute(string title, [CallerFilePath] string? sourceFilePath = null, [CallerLineNumber] int sourceLineNumber = -1)
        : base(sourceFilePath, sourceLineNumber)
    {
        DisplayName = title;
        Line = sourceLineNumber;
    }

    /// <summary>La línea del escenario en su archivo: el orden de ejecución dentro del flujo.</summary>
    public int Line { get; }
}

/// <summary>
/// Ordena los escenarios de un flujo por la línea de su <see cref="ScenarioAttribute"/> (lo demás, al final). En
/// xUnit v3 el orden de los MÉTODOS de una clase es de un <see cref="ITestMethodOrderer"/>, no del de casos.
/// </summary>
public sealed class ScenarioOrderer : ITestMethodOrderer
{
    public IReadOnlyCollection<TTestMethod?> OrderTestMethods<TTestMethod>(IReadOnlyCollection<TTestMethod?> testMethods)
        where TTestMethod : notnull, ITestMethod =>
        testMethods.OrderBy(LineOf).ThenBy(testMethod => testMethod?.MethodName, StringComparer.Ordinal).ToList();

    private static int LineOf<TTestMethod>(TTestMethod? testMethod)
        where TTestMethod : notnull, ITestMethod =>
        testMethod is IXunitTestMethod xunit ? xunit.Method.GetCustomAttribute<ScenarioAttribute>()?.Line ?? int.MaxValue : int.MaxValue;
}
`
  });
}

// ─── HarnessSmoke.cs ─────────────────────────────────────────────────────────────────────────────

function harnessSmokeCs(model) {
  const api = usesApi(model);
  const reset = hasResetScript(model);
  const probe = dbProbe(model);
  const cases = [];
  if (reset) {
    cases.push(String.raw`    [Scenario("SMOKE-1: el reset de estado se ejecuta sin error")]
    public void ElResetSeEjecuta() =>
        // Sin él, ningún flujo arranca con el Given que declara.
        ResetState();`);
  }
  cases.push(String.raw`    [Scenario("SMOKE-2: el servidor responde")]
    public async Task ElServidorResponde()
    {
        var response = await Get("/livez");
        Assert.True(response.Status == 200, response.ToString());
    }`);
  if (probe) {
    cases.push(String.raw`    [Scenario("SMOKE-3: la base de prueba responde a una sentencia")]
    public void LaBaseResponde() =>
        // Es la vía de los Then que miran el almacén: si no responde, fallarían por la fontanería.
        Assert.Equal("1", Db("SELECT 1").Trim());`);
  }
  if (api) {
    // Con seguridad, con la credencial que satisface la regla de cierre: sin ella, un camino que no existe es 401 (se
    // decide antes de enrutar), y el humo mediría la autorización.
    const credential = closingCredentialExpression(model);
    const headers =
      credential && credential !== 'null'
        ? `        Dictionary<string, string> headers = ${credential};
        headers["X-Correlation-Id"] = "keel-smoke";
        var response = await Get($"{RouteBase}/keel-smoke-ruta-inexistente", headers);`
        : '        var response = await Get($"{RouteBase}/keel-smoke-ruta-inexistente", new() { ["X-Correlation-Id"] = "keel-smoke" });';
    cases.push(String.raw`    [Scenario("SMOKE-4: la API responde con ErrorResponse y correlación")]
    public async Task LaApiRespondeConErrorResponse()
    {
${headers}
        Assert.True(response.Status == 404, response.ToString());
        Assert.Equal(404, response.Json().GetProperty("status").GetInt32());
        Assert.Equal("keel-smoke", response.Header("x-correlation-id"));
    }`);
  }
  const identity = smokeCredentialsCase(model);
  if (identity) cases.push(identity);
  const messaging = messagingSmokeCase(model);
  if (messaging) cases.push(messaging);
  const plumbing = [reset ? 'reset' : null, probe ? 'base de prueba' : null, api ? 'API' : null, identity ? 'proveedor de identidad' : null, messaging ? 'broker' : null].filter(Boolean);
  return csFile({
    namespace: solution(model).integrationTests.name,
    header: `// Humo del arnés: la fontanería de la que dependen TODOS los flujos (servidor vivo${plumbing.length > 0 ? `, ${plumbing.join(', ')}` : ''}).
// infra/score-scenarios.sh lo ejecuta ANTES que la suite: correrla sobre una fontanería rota produce decenas de
// fallos que parecen de negocio y no lo son. Lo generó keel-dotnet build: no se edita.`,
    usings: ['Xunit', supportNamespace(model)],
    body: `
public sealed class ${HARNESS_SMOKE_CLASS} : FlowTest
{
${cases.join('\n\n')}
}
`
  });
}

// ─── El proyecto de flujos ───────────────────────────────────────────────────────────────────────

/**
 * El .csproj de las pruebas de flujo. No es un proyecto de pruebas para `dotnet test` (`IsTestProject` false): sus
 * casos necesitan la infraestructura de infra/, y `dotnet test` en la raíz tiene que seguir siendo lo que pasa sin
 * nada más. Lo ejecuta infra/score-scenarios.sh.
 */
export function integrationTestsCsproj(model) {
  const sln = solution(model);
  const api = `${'../'.repeat(sln.integrationTests.dir.split('/').length)}${sln.api.csproj}`.replaceAll('/', '\\');
  return `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <!-- xUnit v3: el proyecto de pruebas es un ejecutable. -->
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
    <!-- No lo ejecuta dotnet test: sus casos necesitan la infraestructura de infra/, y dotnet test en la raíz tiene
         que seguir pasando sin nada más. Lo ejecuta infra/score-scenarios.sh, con el runner propio de xUnit v3
         (Microsoft.Testing.Platform desactivado: es lo que mira dotnet test para elegir proyectos). -->
    <IsTestProject>false</IsTestProject>
    <IsTestingPlatformApplication>false</IsTestingPlatformApplication>
  </PropertyGroup>

  <!-- Caja negra: el Api se COMPILA antes que este proyecto (el arnés lo arranca como proceso), pero ninguno de sus
       tipos es visible aquí. Una prueba de flujo que nombre un tipo del servicio no compila. -->
  <ItemGroup>
    <ProjectReference Include="${api}" ReferenceOutputAssembly="false" />
  </ItemGroup>

  <!-- La configuración de la compilación viaja en el ensamblado: el arnés arranca el Api compilado con la misma. -->
  <ItemGroup>
    <AssemblyAttribute Include="System.Reflection.AssemblyMetadataAttribute">
      <_Parameter1>Configuration</_Parameter1>
      <_Parameter2>$(Configuration)</_Parameter2>
    </AssemblyAttribute>
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="xunit.v3" />
  </ItemGroup>

</Project>
`;
}

/** Los atributos de ensamblado: en serie, con el orden de los escenarios, y el servidor parado al final. */
export function assemblyInfoCs(model) {
  // Sin namespace: un atributo de ensamblado tiene que ir antes que cualquier declaración del archivo.
  return `// Los flujos comparten la base y el servidor: en serie, nunca a la vez. El reset es por flujo (clase), y dos
// flujos simultáneos se borrarían el Given el uno al otro.
using ${supportNamespace(model)};
using Xunit;
using Xunit.Sdk;
using Xunit.v3;

[assembly: Parallelization(Mode = ParallelMode.None)]
[assembly: TestMethodOrderer(typeof(ScenarioOrderer))]
[assembly: AssemblyFixture(typeof(FlowServerShutdown))]
`;
}

// ─── infra/score-scenarios.sh ────────────────────────────────────────────────────────────────────
//
// Puntuación MECÁNICA de la matriz de escenarios: «FL-x → OK | FALLO | NO_EJERCITADO» sale del XML de JUnit, sin
// criterio de por medio. Mismo contrato de salida y de códigos que el de keel-spring y keel-nest, para que el
// orquestador sea el mismo: la causa de un rojo llega por stdout y la salida de dotnet va entera a un log.

function scoreScenariosScript(model) {
  const sln = solution(model);
  const project = sln.integrationTests;
  const smokeClass = `${project.name}.${HARNESS_SMOKE_CLASS}`;
  return `#!/usr/bin/env bash
# score-scenarios.sh — compila la solución, ejecuta las pruebas de flujo de ${model.service.name} y
# puntúa los escenarios FL-* contra specs/validation-scenarios.md.
#
# La matriz sale del XML JUnit que escribe xUnit v3, sin criterio de por medio: el título de
# cada caso ([Scenario("FL-PRD-001-A: …")]) lleva el id delante de los dos puntos. Arbitrar de
# quién es la culpa de un fallo NO es trabajo de este script — para eso está el agente de
# validación, que se invoca solo si aquí sale algo en rojo.
#
# Uso (desde la raíz del proyecto, con la infraestructura arriba):
#   bash infra/score-scenarios.sh           # compila + humo del arnés + suite + matriz
#   bash infra/score-scenarios.sh --score   # solo re-puntúa el XML ya existente
#
# Salida: la matriz por stdout (la de dotnet va al log). Código de salida:
#   0  todos los escenarios en OK
#   1  hay FALLO o NO_EJERCITADO → hay algo que arbitrar
#   2  precondición o arnés roto Y NADA QUE ARBITRAR: la solución no compila, la suite no se
#      ejecutó, o un flujo no llegó a arrancar sin dejar ni un FL-* en FALLO. Si además hay
#      escenarios en FALLO, sale 1: esos se arbitran.
#   (3, entorno bloqueado, es del script de keel-spring: dotnet no deja workers que sostengan
#   el directorio de resultados entre corridas.)
set -u

SOLUTION="${sln.file}"
RESULTS="${INTEGRATION_RESULTS}"
LOG_DIR="build/keel-scenarios"
LOG="$LOG_DIR/run.log"
EVIDENCE="build/keel-failures"
SCENARIOS="specs/validation-scenarios.md"
FLOWS="${project.dir}/bin/Debug/${TARGET_FRAMEWORK}/${project.name}.dll"

if [ ! -f "$SOLUTION" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró $SOLUTION)." >&2
  exit 2
fi
mkdir -p "$LOG_DIR"

# La evidencia de la corrida ANTERIOR se borra antes de empezar: un volcado que sobrevive a
# una corrida verde se lee igual que uno recién escrito, y engaña.
rm -rf "$EVIDENCE"

${specsSealCheck('keel-dotnet')}

score_only=0
[ "\${1:-}" = "--score" ] && score_only=1
suite_failed=0

# Los casos de las pruebas de flujo, con su reporte JUnit. El ejecutable es el propio proyecto
# de pruebas, con el runner de xUnit v3 (no Microsoft.Testing.Platform: el proyecto está fuera
# de dotnet test a propósito).
flows() {
  local report="$1"
  shift
  mkdir -p "$RESULTS"
  dotnet "$FLOWS" -noLogo -noColor -result-junit "$RESULTS/$report" "$@"
}

if [ "$score_only" -eq 0 ]; then
  # Re-puntuar (--score) solo lee XML; compilar y ejecutar sí necesita el SDK.
  if ! command -v dotnet >/dev/null 2>&1; then
    echo "No está el SDK de .NET (dotnet) en el PATH: instálalo (global.json dice qué banda)." >&2
    exit 2
  fi
  rm -rf "$RESULTS"
  echo "Compilando la solución…"
  if ! dotnet build "$SOLUTION" -c Debug --nologo >"$LOG" 2>&1; then
    echo ""
    echo "BUILD: KO — la solución no compila; la suite NO se ejecutó."
    grep -E 'error [A-Z]+[0-9]+' "$LOG" | sed 's/^/  /' | sort -u | head -20
    echo "  log: $LOG"
    exit 2
  fi
  # Humo del arnés primero: son segundos y comprueba la fontanería de la que dependen
  # TODOS los flujos. En rojo no se ejecuta la suite.
  echo "Humo del arnés (${HARNESS_SMOKE_CLASS})…"
  if ! flows smoke.xml -class "${smokeClass}" >>"$LOG" 2>&1 \\
     || grep -qE '<(failure|error|skipped)[ />]' "$RESULTS/smoke.xml" 2>/dev/null; then
    echo ""
    echo "HARNESS: KO — la suite NO se ejecutó."
    echo "  El defecto está en el andamiaje que generó build (${project.dir}/Support/,"
    echo "  ${HARNESS_SMOKE_CLASS}.cs) o falta infraestructura (bash infra/up.sh && bash infra/validate-infra.sh)."
    if ls "$EVIDENCE"/*.json >/dev/null 2>&1; then
      echo "  evidencia: $EVIDENCE/"
    fi
    echo "  log del servidor: build/keel-scenarios/server.log"
    echo "  log: $LOG"
    exit 2
  fi
  echo "Humo del arnés: OK."
  rm -rf "$EVIDENCE" "$RESULTS"
  echo "Ejecutando la suite completa…"
  # El código de salida se GUARDA: la matriz solo mira los FL-*, y una prueba en rojo que no
  # sea un escenario no aparecería en ninguna fila.
  flows junit.xml >>"$LOG" 2>&1 || suite_failed=1
fi

if ! ls "$RESULTS"/*.xml >/dev/null 2>&1; then
  echo ""
  echo "No hay resultados en $RESULTS: la suite no llegó a ejecutarse."
  echo "  log: $LOG"
  exit 2
fi

# Matriz desde el XML de JUnit (los mismos programas que puntúan el de keel-spring y keel-nest).
matrix="$(awk '
${JUNIT_MATRIX_AWK}
' "$RESULTS"/*.xml 2>/dev/null | sort -k2,2)"

# Escenarios que el documento declara y ninguna prueba ejercita (cobertura que falta), y pruebas
# FL-* que el documento no declara (no puntúan): keel-core/gen/junit-scoring, el mismo cruce que en
# keel-spring.
${SCENARIO_DOCUMENT_SCORING}

echo ""
echo "MATRIZ"
printf '%s\\n' "$matrix" | while IFS="$(printf '\\t')" read -r result id cls; do
  [ -n "\${id:-}" ] || continue
  if [ "$result" = "FALLO" ]; then
    printf '  %-8s %-20s %-28s %s\\n' "$result" "$id" "$cls" "$EVIDENCE/$id.json"
  else
    printf '  %-8s %-20s %s\\n' "$result" "$id" "$cls"
  fi
done
for id in $uncovered; do
  printf '  %-8s %s\\n' "NO_EJERC" "$id"
done
${FOREIGN_ROWS_PRINT}

ok=$(printf '%s\\n' "$matrix" | grep -c '^OK')
ko=$(printf '%s\\n' "$matrix" | grep -c '^FALLO')
sk=$(printf '%s\\n' "$matrix" | grep -c '^OMITIDO')
nc=0
for id in $uncovered; do nc=$((nc + 1)); done

# Las pruebas en rojo que NO son escenarios: la matriz solo conoce los FL-*.
non_scenario_failures() {
  awk '
${JUNIT_NON_SCENARIO_AWK}
  ' "$RESULTS"/*.xml 2>/dev/null
}

# Los flujos que no llegaron a arrancar. La base da sus casos por OMITIDOS, no por fallidos —el
# gemelo del initializationError de JUnit—, y deja el volcado <Flujo>-init.json. Sin esto,
# «omitido» diría «alguien lo saltó» cuando lo que hubo fue un rojo del arranque.
init_failures() {
  for file in "$EVIDENCE"/*-init.json; do
    [ -f "$file" ] || continue
    flow="$(basename "$file" -init.json)"
    msg="$(sed -n 's/^  "assertion": "\\(.*\\)",\\{0,1\\}$/\\1/p' "$file" | sed 's/\\\\n/ /g' | cut -c1-400)"
    echo "    $flow  (arranque del flujo)"
    [ -n "$msg" ] && echo "      $msg"
  done
}

broken="$(non_scenario_failures)$(init_failures)"
# Las pruebas en rojo con un id FL-* que el documento no declara tampoco salen en la matriz.
if [ -n "$foreign_failures" ]; then broken="$(printf '%s\\n%s' "$broken" "$foreign_failures")"; fi

echo ""
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$ok" -gt 0 ]; then
  if [ "$suite_failed" -ne 0 ]; then
    echo "RESULTADO: KO — los $ok escenario(s) FL-* están en OK, pero la suite falló."
    echo "  Hay pruebas en rojo que NO son escenarios y por eso no salen en la matriz:"
    printf '%s\\n' "$broken"
    echo "  log completo de dotnet: $LOG"
    echo "  Son del agente de pruebas, no del diseño: o las arregla o las retira."
    echo "  Sale con 2 y NO con 1: no hay ningún FL-* en FALLO, así que no hay ningún Then"
    echo "  que arbitrar."
    exit 2
  fi
  echo "RESULTADO: OK — $ok escenario(s) al 100%."
  exit 0
fi

echo "RESULTADO: KO — $ok OK · $ko FALLO · $sk omitido(s) · $nc no ejercitado(s)."
echo "  evidencia por fallo: $EVIDENCE/<FL-id>.json (request, response y aserción)"
echo "  log del servidor: build/keel-scenarios/server.log"
echo "  log completo de dotnet: $LOG"
if [ -n "$broken" ]; then
  echo ""
  echo "  ARNÉS: hay pruebas en rojo que NO son escenarios, o flujos que no llegaron a arrancar."
  printf '%s\\n' "$broken"
  echo "  Un flujo que no arrancó deja sus FL-* como OMITIDO: no es falta de cobertura ni un"
  echo "  salto. La causa va debajo de cada uno; el volcado, en $EVIDENCE/<Flujo>-init.json."
  if [ "$ko" -eq 0 ]; then
    echo "  No hay ningún escenario en FALLO: no hay nada que arbitrar, así que esto sale"
    echo "  con 2 (arnés roto) y no con 1: se arregla el flujo y se vuelve a puntuar."
    exit 2
  fi
  echo "  PERO hay $ko escenario(s) FL-* en FALLO, y eso SÍ se arbitra: esto sale con 1."
fi

# La matriz VACÍA no es un rojo que arbitrar: la suite corrió y no ejercitó ni un FL-*.
if [ "$ko" -eq 0 ] && [ "$sk" -eq 0 ] && [ "$nc" -eq 0 ]; then
  echo ""
  echo "  ARNÉS: la matriz está VACÍA — la suite no ejercitó ni un escenario FL-*."
  echo "  No hay nada que arbitrar: sale con 2 y vuelve al agente de pruebas."
  exit 2
fi
exit 1
`;
}

// ─── infra/check-flows.sh ────────────────────────────────────────────────────────────────────────
//
// El gate de compilación del agente de PRUEBAS. Como en keel-spring, las pruebas de flujo compilan SIN el código
// del servicio: el proyecto no ve sus tipos, y aquí se compila sin construir sus referencias, así que un src/ a
// medio escribir (el agente de código trabajando en paralelo) no pone rojo a quien no lo escribe.

function checkFlowsScript(model) {
  const project = solution(model).integrationTests;
  return `#!/usr/bin/env bash
# check-flows.sh — compila las pruebas de flujo (${project.dir}/) sin el código del servicio.
#
# El proyecto de flujos no ve ningún tipo del servicio (caja negra): compila solo, y aquí se
# compila SIN construir el Api, así que un src/ a medio escribir no lo pone en rojo. Además
# comprueba que nadie le añadió una referencia que rompa la caja negra.
#
# Uso (desde la raíz; no necesita infraestructura):
#   bash infra/check-flows.sh
# Sale con 0 si las pruebas de flujo compilan y respetan la caja negra, y con 1 si no.
set -u
cd "$(dirname "$0")/.."
mkdir -p build

PROJECT="${project.csproj}"
fail=0

# La caja negra: la única referencia a un proyecto del servicio es la que ordena la compilación
# del Api sin ver sus tipos.
visible="$(grep -E '<ProjectReference' "$PROJECT" | grep -v 'ReferenceOutputAssembly="false"' || true)"
if [ -n "$visible" ]; then
  echo "Caja negra rota: el proyecto de flujos referencia un proyecto del servicio y ve sus tipos:"
  printf '%s\\n' "$visible" | sed 's/^ */  /'
  fail=1
fi

if ! dotnet build "$PROJECT" -c Debug --nologo -p:BuildProjectReferences=false >build/keel-flows-build.log 2>&1; then
  echo "Las pruebas de flujo no compilan:"
  grep -E '(error|warning) [A-Z]+[0-9]+' build/keel-flows-build.log | sed 's/^/  /' | sort -u | head -30
  fail=1
fi
[ "$fail" -eq 0 ] && echo "Pruebas de flujo: compilan y respetan la caja negra."
exit "$fail"
`;
}
