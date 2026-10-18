// Los logs del servicio generado (incremento 14b de PLAN-KEEL-DOTNET.md): lo que keel-spring y keel-nest generan CON
// y SIN telemetría, porque la consola es el canal primario de los logs en cualquier plataforma.
//
//   · `local` (y `test`) escriben TEXTO, porque lo lee una persona; `develop` y `production`, JSON ECS (`LOG_FORMAT`,
//     default `ecs`) con la forma ANIDADA del formato de Spring Boot 3.5 —la de keel-nest—, para que un mismo
//     pipeline de logs lea los tres servidores del mismo diseño. El `logging.yaml` de cada perfil es el neutral de
//     keel-core (`gen/logging-config.js`), el mismo de keel-nest byte a byte salvo la cabecera.
//   · Cada línea lleva el `correlationId` en curso (CorrelationContext), leído al escribirla: no depende de que quien
//     escribe haya abierto un ámbito de log.
//   · Los niveles salen de las MISMAS variables: `LOG_LEVEL_ROOT` es el mínimo de todas las categorías (lo que escribe
//     ASP.NET Core, EF Core o un driver) y `LOG_LEVEL_APP` el de las del servicio, que en .NET son las que empiezan
//     por su namespace raíz. Es la regla de filtro por prefijo de categoría de Microsoft.Extensions.Logging, la misma
//     forma que el `logging.level.<paquete>` de logback.
//   · Un formateador de consola propio y no el JSON de serie de .NET: el de serie escribe su propia forma
//     (`Timestamp`, `EventId`, `State`), no la de ECS.

import { solution, csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesCorrelation } from './rest-support.js';
import { ECS_VERSION, loggingYaml as neutralLoggingYaml } from 'keel-core/gen/logging-config';

const PROFILES = ['local', 'develop', 'production', 'test'];

export function loggingNamespace(model) {
  return namespaceOf(model, 'logging');
}

/** El `logging.yaml` de un perfil: el neutral de keel-core con la cabecera de keel-dotnet. */
export function loggingYaml(model, profile) {
  return neutralLoggingYaml(model, profile, { header: `Generado por keel-dotnet build. Los logs del servicio en el perfil ${profile}.` });
}

export function generate(model) {
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'logging', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const correlation = usesCorrelation(model) ? [namespaceOf(model, 'correlation')] : [];
  return [
    file('LoggingSettings', ['System.Globalization', 'Microsoft.Extensions.Logging', configNamespace(model)], settingsBody(model)),
    file(
      'KeelConsoleFormatter',
      [
        'System.Buffers',
        'System.Globalization',
        'System.Text',
        'System.Text.Encodings.Web',
        'System.Text.Json',
        'Microsoft.Extensions.Logging',
        'Microsoft.Extensions.Logging.Abstractions',
        'Microsoft.Extensions.Logging.Console',
        'Microsoft.Extensions.Options',
        ...correlation
      ],
      formatterBody(model)
    ),
    file('LoggingRegistration', ['Microsoft.Extensions.Logging'], registrationBody()),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/logging.yaml`, content: loggingYaml(model, profile) })),
    testsFile(model)
  ];
}

// ─── LoggingSettings ─────────────────────────────────────────────────────────────────────────────

function settingsBody(model) {
  return `/// <summary>El formato de la consola: texto para una persona, JSON ECS para quien la recoge.</summary>
public enum LogFormat
{
    Text,
    Ecs
}

/// <summary>
/// Los logs del perfil activo (<c>logging.yaml</c>): el formato de la consola, el nivel del framework
/// (<c>LOG_LEVEL_ROOT</c>), el del servicio (<c>LOG_LEVEL_APP</c>) y los campos <c>service.*</c> de cada línea ECS.
/// </summary>
public sealed record LoggingSettings(
    LogFormat Format,
    LogLevel RootLevel,
    LogLevel AppLevel,
    string ServiceName,
    string? Version,
    string? Environment,
    string? NodeName)
{
    /// <summary>
    /// Las categorías del servicio: las que empiezan por su namespace raíz (<c>ILogger&lt;T&gt;</c> toma el nombre
    /// completo del tipo). Todas las demás son del framework o de una librería.
    /// </summary>
    public const string AppCategory = ${csString(model.service.rootNamespace)};

    /// <summary>Los logs que dice la configuración del perfil. Un nivel que no existe no deja arrancar.</summary>
    public static LoggingSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new LoggingSettings(
            string.Equals(Text(configuration, "logging:structured:format:console"), "ecs", StringComparison.OrdinalIgnoreCase) ? LogFormat.Ecs : LogFormat.Text,
            ToLevel(Text(configuration, "logging:level:root") ?? "INFO"),
            ToLevel(Text(configuration, "logging:level:app") ?? "INFO"),
            configuration.ApplicationName,
            Text(configuration, "logging:structured:ecs:service:version"),
            Text(configuration, "logging:structured:ecs:service:environment"),
            Text(configuration, "logging:structured:ecs:service:node-name"));
    }

    /// <summary>Los nombres de nivel de keel-spring (los de logback) sobre los de .NET.</summary>
    public static LogLevel ToLevel(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        return name.Trim().ToUpperInvariant() switch
        {
            "TRACE" => LogLevel.Trace,
            "DEBUG" => LogLevel.Debug,
            "INFO" => LogLevel.Information,
            "WARN" => LogLevel.Warning,
            "ERROR" => LogLevel.Error,
            "FATAL" => LogLevel.Critical,
            "OFF" => LogLevel.None,
            _ => throw new InvalidOperationException(
                string.Create(CultureInfo.InvariantCulture, $"Nivel de log desconocido: '{name}' (usa TRACE, DEBUG, INFO, WARN, ERROR u OFF)"))
        };
    }

    /// <summary>El nombre con que la línea dice su nivel: el de keel-spring y keel-nest.</summary>
    public static string NameOf(LogLevel level) => level switch
    {
        LogLevel.Trace => "TRACE",
        LogLevel.Debug => "DEBUG",
        LogLevel.Information => "INFO",
        LogLevel.Warning => "WARN",
        LogLevel.Error => "ERROR",
        LogLevel.Critical => "FATAL",
        _ => "OFF"
    };

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;
}`;
}

// ─── KeelConsoleFormatter ────────────────────────────────────────────────────────────────────────

function formatterBody(model) {
  const correlationOf = usesCorrelation(model) ? 'CorrelationContext.Get()' : 'null';
  return `/// <summary>Las opciones del formateador: los logs del perfil, ya leídos.</summary>
public sealed class KeelConsoleFormatterOptions : ConsoleFormatterOptions
{
    public LoggingSettings? Settings { get; set; }
}

/// <summary>
/// La consola del servicio: texto en local (<c>&lt;instante&gt; &lt;NIVEL&gt; &lt;pid&gt; --- [correlationId] [categoría]
/// mensaje</c>, la pila debajo) y JSON ECS fuera de él, con la forma anidada del formato de Spring Boot 3.5: la misma
/// línea que escriben los servidores de keel-spring y keel-nest del mismo diseño.
/// </summary>
/// <remarks>
/// Cada línea lleva el correlationId en curso. Una sola pila por fallo: la escribe quien registra el error con la
/// excepción (el middleware de la API); quien solo lo cuenta (el mediator) no la pasa.
/// </remarks>
public sealed class KeelConsoleFormatter : ConsoleFormatter
{
    public const string FormatterName = "keel";

    private static readonly JsonWriterOptions JsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly LoggingSettings settings;

    public KeelConsoleFormatter(IOptions<KeelConsoleFormatterOptions> options)
        : base(FormatterName)
    {
        ArgumentNullException.ThrowIfNull(options);
        settings = options.Value.Settings ?? throw new InvalidOperationException("KeelConsoleFormatter sin LoggingSettings: regístralo con AddServiceLogging");
    }

    public override void Write<TState>(in LogEntry<TState> logEntry, IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
        ArgumentNullException.ThrowIfNull(textWriter);
        var message = logEntry.Formatter(logEntry.State, logEntry.Exception);
        if (string.IsNullOrEmpty(message) && logEntry.Exception is null)
        {
            return;
        }
        var line = new LogLine(DateTimeOffset.UtcNow, logEntry.LogLevel, logEntry.Category, message ?? string.Empty, logEntry.Exception, ${correlationOf});
        textWriter.Write(settings.Format == LogFormat.Ecs ? Ecs(settings, line) : Text(line));
    }

    private sealed record LogLine(DateTimeOffset Timestamp, LogLevel Level, string Category, string Message, Exception? Error, string? CorrelationId);

    private static string Instant(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static string Text(LogLine line)
    {
        var text = new StringBuilder()
            .Append(Instant(line.Timestamp)).Append(' ')
            .Append(LoggingSettings.NameOf(line.Level).PadLeft(5)).Append(' ')
            .Append(Environment.ProcessId.ToString(CultureInfo.InvariantCulture)).Append(" --- ");
        if (line.CorrelationId is { } correlationId)
        {
            text.Append('[').Append(correlationId).Append("] ");
        }
        text.Append('[').Append(line.Category).Append("] ").Append(line.Message).Append('\\n');
        if (line.Error is { } error)
        {
            text.Append(error).Append('\\n');
        }
        return text.ToString();
    }

    private static string Ecs(LoggingSettings settings, LogLine line)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var json = new Utf8JsonWriter(buffer, JsonOptions))
        {
            json.WriteStartObject();
            json.WriteString("@timestamp", Instant(line.Timestamp));
            json.WriteStartObject("log");
            json.WriteString("level", LoggingSettings.NameOf(line.Level));
            json.WriteString("logger", line.Category);
            json.WriteEndObject();
            json.WriteStartObject("process");
            json.WriteNumber("pid", Environment.ProcessId);
            json.WriteStartObject("thread");
            json.WriteString("name", Thread.CurrentThread.Name ?? Environment.CurrentManagedThreadId.ToString(CultureInfo.InvariantCulture));
            json.WriteEndObject();
            json.WriteEndObject();
            json.WriteStartObject("service");
            json.WriteString("name", settings.ServiceName);
            if (settings.Version is { } version)
            {
                json.WriteString("version", version);
            }
            if (settings.Environment is { } environment)
            {
                json.WriteString("environment", environment);
            }
            if (settings.NodeName is { } nodeName)
            {
                json.WriteStartObject("node");
                json.WriteString("name", nodeName);
                json.WriteEndObject();
            }
            json.WriteEndObject();
            json.WriteString("message", line.Message);
            if (line.CorrelationId is { } correlationId)
            {
                json.WriteString("correlationId", correlationId);
            }
            if (line.Error is { } error)
            {
                json.WriteStartObject("error");
                json.WriteString("type", error.GetType().FullName);
                json.WriteString("message", error.Message);
                json.WriteString("stack_trace", error.ToString());
                json.WriteEndObject();
            }
            json.WriteStartObject("ecs");
            json.WriteString("version", ${csString(ECS_VERSION)});
            json.WriteEndObject();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan) + "\\n";
    }
}`;
}

// ─── LoggingRegistration ─────────────────────────────────────────────────────────────────────────

function registrationBody() {
  return `/// <summary>Los logs del servicio: la consola con su formateador y los dos niveles del perfil.</summary>
public static class LoggingRegistration
{
    /// <summary>
    /// Sustituye los proveedores de serie (consola de .NET, depuración, EventLog) por la consola del servicio, con
    /// <c>LOG_LEVEL_ROOT</c> como mínimo de todas las categorías y <c>LOG_LEVEL_APP</c> para las del servicio.
    /// </summary>
    public static ILoggingBuilder AddServiceLogging(this ILoggingBuilder logging, LoggingSettings settings)
    {
        ArgumentNullException.ThrowIfNull(logging);
        ArgumentNullException.ThrowIfNull(settings);
        logging.ClearProviders();
        logging.SetMinimumLevel(settings.RootLevel);
        logging.AddFilter(LoggingSettings.AppCategory, settings.AppLevel);
        logging.AddConsole(options => options.FormatterName = KeelConsoleFormatter.FormatterName);
        logging.AddConsoleFormatter<KeelConsoleFormatter, KeelConsoleFormatterOptions>(options => options.Settings = settings);
        return logging;
    }
}`;
}

// ─── La prueba emitida ───────────────────────────────────────────────────────────────────────────

function testsFile(model) {
  const sln = solution(model);
  const correlation = usesCorrelation(model);
  const open = correlation ? 'using (CorrelationContext.Open("pedido-42"))\n            ' : '';
  const ecsCorrelation = correlation
    ? '        Assert.Equal("pedido-42", line.GetProperty("correlationId").GetString());'
    : '        Assert.False(line.TryGetProperty("correlationId", out _));';
  const textCorrelation = correlation ? String.raw`\[pedido-42\] ` : '';
  const app = `${model.service.rootNamespace}.Application.UseCases.UseCaseMediator`;
  const body = String.raw`/// <summary>
/// Los logs EJECUTADOS: la configuración EMITIDA de cada perfil (logging.yaml, la que la compilación copia junto a las
/// pruebas) leída con el cargador del servicio, y escrita con su formateador. Lo que se afirma es lo que keel-spring y
/// keel-nest hacen con y sin telemetría: texto en local, JSON ECS anidado fuera de él, el correlationId en cada línea,
/// los niveles de LOG_LEVEL_ROOT y LOG_LEVEL_APP y una pila solo donde se pasa.
/// </summary>
public sealed class ServiceLoggingTests : IDisposable
{
    private const string AppCategory = ${csString(app)};
    private const string FrameworkCategory = "Microsoft.AspNetCore.Hosting.Diagnostics";

    private readonly DirectoryInfo root = Directory.CreateTempSubdirectory("keel-logging-");

    public ServiceLoggingTests()
    {
        // Solo lo que lee el logger: application.yaml y el logging.yaml de cada perfil, tal como se emitieron.
        var source = Path.Combine(AppContext.BaseDirectory, "config");
        Copy(source, "application.yaml");
        foreach (var profile in new[] { "local", "develop", "production", "test" })
        {
            Copy(source, Path.Combine("parameters", profile, "logging.yaml"));
        }
    }

    public void Dispose() => root.Delete(recursive: true);

    private void Copy(string source, string relativePath)
    {
        var target = Path.Combine(root.FullName, "config", relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(Path.Combine(source, relativePath), target);
    }

    private LoggingSettings SettingsFor(params (string Name, string Value)[] variables)
    {
        var environment = variables.ToDictionary(variable => variable.Name, variable => variable.Value);
        return LoggingSettings.From(ServiceConfiguration.Load(name => environment.GetValueOrDefault(name), root.FullName));
    }

    private static string Render(LoggingSettings settings, LogLevel level, string category, string message, Exception? error = null)
    {
        var formatter = new KeelConsoleFormatter(Options.Create(new KeelConsoleFormatterOptions { Settings = settings }));
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        formatter.Write(new LogEntry<string>(level, category, new EventId(0), message, error, (state, _) => state), null, writer);
        return writer.ToString();
    }

    private static Exception Thrown()
    {
        try
        {
            throw new InvalidOperationException("la base no responde");
        }
        catch (InvalidOperationException error)
        {
            return error;
        }
    }

    [Fact]
    public void FueraDeLocalLaLineaEsJsonEcsAnidadoConElServicioLaReplicaYElCorrelationId()
    {
        var settings = SettingsFor(("PROFILE", "production"), ("HOSTNAME", "pod-7"));
        string text;
        ${open}text = Render(settings, LogLevel.Information, AppCategory, "Caso de uso createProduct: rechazado (3 ms)");
        Assert.EndsWith("\n", text, StringComparison.Ordinal);
        Assert.Single(text.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        using var document = JsonDocument.Parse(text);
        var line = document.RootElement;
        Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\z", line.GetProperty("@timestamp").GetString());
        Assert.Equal("INFO", line.GetProperty("log").GetProperty("level").GetString());
        Assert.Equal(AppCategory, line.GetProperty("log").GetProperty("logger").GetString());
        Assert.Equal(Environment.ProcessId, line.GetProperty("process").GetProperty("pid").GetInt32());
        var service = line.GetProperty("service");
        Assert.Equal(${csString(model.service.name)}, service.GetProperty("name").GetString());
        Assert.Equal(${csString(model.service.version)}, service.GetProperty("version").GetString());
        Assert.Equal("production", service.GetProperty("environment").GetString());
        Assert.Equal("pod-7", service.GetProperty("node").GetProperty("name").GetString());
        Assert.Equal("Caso de uso createProduct: rechazado (3 ms)", line.GetProperty("message").GetString());
${ecsCorrelation}
        Assert.Equal(${csString(ECS_VERSION)}, line.GetProperty("ecs").GetProperty("version").GetString());
        Assert.False(line.TryGetProperty("error", out _));
    }

    [Fact]
    public void LaReplicaSaleDeServiceInstanceIdSiNoDeHostnameYSiNoEsUnknown()
    {
        Assert.Equal("replica-2", SettingsFor(("PROFILE", "develop"), ("SERVICE_INSTANCE_ID", "replica-2"), ("HOSTNAME", "pod-7")).NodeName);
        Assert.Equal("pod-7", SettingsFor(("PROFILE", "develop"), ("HOSTNAME", "pod-7")).NodeName);
        Assert.Equal("unknown", SettingsFor(("PROFILE", "develop")).NodeName);
        // Lo que llega de una variable se usa tal cual: no se vuelve a resolver.
        Assert.Equal("$" + "{HOSTNAME}", SettingsFor(("PROFILE", "develop"), ("SERVICE_INSTANCE_ID", "$" + "{HOSTNAME}")).NodeName);
    }

    [Fact]
    public void ElErrorLlevaSuTipoSuMensajeYSuPilaUnaSolaVez()
    {
        var settings = SettingsFor(("PROFILE", "develop"));
        using var document = JsonDocument.Parse(Render(settings, LogLevel.Error, AppCategory, "Error no controlado", Thrown()));
        var error = document.RootElement.GetProperty("error");
        Assert.Equal("ERROR", document.RootElement.GetProperty("log").GetProperty("level").GetString());
        Assert.Equal("System.InvalidOperationException", error.GetProperty("type").GetString());
        Assert.Equal("la base no responde", error.GetProperty("message").GetString());
        Assert.Contains(" at ", error.GetProperty("stack_trace").GetString(), StringComparison.Ordinal);
        Assert.Equal("Error no controlado", document.RootElement.GetProperty("message").GetString());
    }

    [Fact]
    public void EnLocalLaLineaEsTextoConLaPilaDebajo()
    {
        var settings = SettingsFor(("PROFILE", "local"));
        Assert.Equal(LogFormat.Text, settings.Format);
        string text;
        ${open}text = Render(settings, LogLevel.Warning, AppCategory, "pool casi lleno");
        Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z  WARN \d+ --- ${textCorrelation}\[" + Regex.Escape(AppCategory) + @"\] pool casi lleno\n\z", text);
        var failed = Render(settings, LogLevel.Error, AppCategory, "falló", Thrown()).Split('\n');
        Assert.EndsWith("falló", failed[0], StringComparison.Ordinal);
        Assert.StartsWith("System.InvalidOperationException: la base no responde", failed[1], StringComparison.Ordinal);
        Assert.Single(failed, part => part.StartsWith("System.InvalidOperationException", StringComparison.Ordinal));
    }

    [Fact]
    public void LogFormatTextDevuelveElTextoFueraDeLocalYElPerfilTestEsTexto()
    {
        Assert.Equal(LogFormat.Text, SettingsFor(("PROFILE", "develop"), ("LOG_FORMAT", "text")).Format);
        Assert.Equal(LogFormat.Ecs, SettingsFor(("PROFILE", "develop")).Format);
        Assert.Equal(LogFormat.Text, SettingsFor(("PROFILE", "test")).Format);
    }

    [Fact]
    public void LosNivelesElFrameworkConLogLevelRootYElServicioConLogLevelAppConElGradienteDeKeelSpring()
    {
        var production = SettingsFor(("PROFILE", "production"));
        Assert.Equal(LogLevel.Warning, production.RootLevel);
        Assert.Equal(LogLevel.Information, production.AppLevel);
        var develop = SettingsFor(("PROFILE", "develop"));
        Assert.Equal(LogLevel.Information, develop.RootLevel);
        Assert.Equal(LogLevel.Debug, develop.AppLevel);

        Assert.Equal(new[] { "WARN framework", "INFO servicio" }, Written(production));
        var tuned = SettingsFor(("PROFILE", "production"), ("LOG_LEVEL_ROOT", "INFO"), ("LOG_LEVEL_APP", "DEBUG"));
        Assert.Equal(new[] { "INFO framework", "WARN framework", "INFO servicio", "DEBUG servicio" }, Written(tuned));
    }

    [Fact]
    public void UnNivelQueNoExisteNoDejaArrancar()
    {
        var error = Assert.Throws<InvalidOperationException>(() => SettingsFor(("PROFILE", "develop"), ("LOG_LEVEL_APP", "VERBOSE")));
        Assert.Contains("Nivel de log desconocido: 'VERBOSE'", error.Message, StringComparison.Ordinal);
    }

    /// <summary>Lo que dejan pasar los niveles de AddServiceLogging, leído por un proveedor de la prueba.</summary>
    private static string[] Written(LoggingSettings settings)
    {
        var captured = new Captured();
        using (var services = new ServiceCollection().AddLogging(logging => logging.AddServiceLogging(settings).AddProvider(captured)).BuildServiceProvider())
        {
            var factory = services.GetRequiredService<ILoggerFactory>();
            var framework = factory.CreateLogger(FrameworkCategory);
            var app = factory.CreateLogger(AppCategory);
            framework.LogInformation("framework");
            framework.LogWarning("framework");
            app.LogInformation("servicio");
            app.LogDebug("servicio");
        }
        return [.. captured.Lines];
    }

    private sealed class Captured : ILoggerProvider
    {
        public List<string> Lines { get; } = [];

        public ILogger CreateLogger(string categoryName) => new Writer(Lines);

        public void Dispose()
        {
        }

        private sealed class Writer(List<string> lines) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
                lines.Add(LoggingSettings.NameOf(logLevel) + " " + formatter(state, exception));
        }
    }
}`;
  const usings = [
    'System.Globalization',
    'System.Text.Json',
    'System.Text.RegularExpressions',
    'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Logging',
    'Microsoft.Extensions.Logging.Abstractions',
    'Microsoft.Extensions.Options',
    'Xunit',
    configNamespace(model),
    loggingNamespace(model),
    ...(correlation ? [namespaceOf(model, 'correlation')] : [])
  ];
  return { path: `${sln.unitTests.dir}/ServiceLoggingTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}
