// La telemetría del servicio generado (`telemetry: otel`, incremento 14c de PLAN-KEEL-DOTNET.md).
//
// El patrón de keel-spring y keel-nest: el servidor solo conoce el endpoint de UN colector (`OTEL_EXPORTER_OTLP_ENDPOINT`)
// y le manda trazas (y, con `LOG_EXPORT_OTLP`, logs) por OTLP/HTTP; las métricas no salen, las viene a buscar el colector
// a `/actuator/prometheus`, que es lo que conserva los EXEMPLARS. Cambiar de backend es cambiar el colector.
//
// La regla de equivalencia manda en los NOMBRES: observaciones, atributos, desenlaces y series salen de
// `keel-core/gen/telemetry-vocabulary.js`, así que el mismo panel y las mismas alertas tienen datos con los tres servidores.
//
//   · Trazas: el SDK de OpenTelemetry sobre un `ActivitySource` propio (`keel`), con los spans abiertos por el código
//     generado donde ya es dueño del punto de paso (la entrada HTTP, el mediator, el relay, el consumo, los clientes
//     salientes, los puertos de storage y correo), como keel-nest. Sin la instrumentación de ASP.NET Core: su span de
//     cada petición existe aunque nadie lo exporte (lo crea el host mientras haya logs), y un span nuestro que colgara de
//     él quedaría con un padre que el backend no tiene. Los nuestros toman su padre de forma EXPLÍCITA: el de quien
//     llama, el de la fila del outbox, el de la envoltura, o ninguno.
//   · Métricas: prometheus-net (MIT) en un registro propio, con los nombres de `promMetric` y exemplars `trace_id`/
//     `span_id` en OpenMetrics, y no el exportador Prometheus de OpenTelemetry, que sigue en beta.
//   · Los spans de los drivers (SQL, Mongo, Redis) son otro tramo: `telemetry-store-spans` de la matriz.

import { collectorHostEndpoint } from 'keel-core/gen/infra-catalog';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, OUTBOX_DEAD_LETTERED, instrumentationFor, promGauge, usesTelemetry } from 'keel-core/gen/telemetry-vocabulary';
import { telemetryYaml as neutralTelemetryYaml } from 'keel-core/gen/telemetry-config';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesCorrelation } from './rest-support.js';

export { usesTelemetry };

const PROFILES = ['local', 'develop', 'production', 'test'];

/**
 * Los cubos de los histogramas de duración, en segundos: de 1 ms a 30 s, los de keel-nest. No tienen que coincidir con
 * los de keel-spring: `histogram_quantile` interpola dentro de cada uno.
 */
export const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Las etiquetas de la métrica HTTP de entrada y de la de salida: las de keel-spring (y keel-nest). */
export const HTTP_SERVER_LABELS = ['method', 'uri', 'status', 'outcome', 'exception'];
export const HTTP_CLIENT_LABELS = ['method', 'uri', 'status', 'client_name', 'outcome'];

export function telemetryNamespace(model) {
  return namespaceOf(model, 'telemetry');
}

/** El `telemetry.yaml` de un perfil: el neutral de keel-core, el mismo de keel-nest. */
export function telemetryYaml(model, profile) {
  return neutralTelemetryYaml(model, profile, { generator: 'keel-dotnet' });
}

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'telemetry', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    file('TelemetrySettings', ['System.Globalization', configNamespace(model)], settingsBody(model)),
    file('TelemetryNames', [], namesBody()),
    file(
      'KeelTelemetry',
      [
        'System.Collections.Concurrent',
        'System.Diagnostics',
        'System.Globalization',
        'System.Net.Http.Headers',
        'OpenTelemetry',
        'OpenTelemetry.Context.Propagation',
        'OpenTelemetry.Exporter',
        'OpenTelemetry.Resources',
        'OpenTelemetry.Trace',
        'Prometheus'
      ],
      telemetryBody()
    ),
    file('W3cOutB3InPropagator', ['OpenTelemetry.Context.Propagation'], propagatorBody()),
    file(
      'HttpTelemetryMiddleware',
      ['System.Diagnostics', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing', ...(usesCorrelation(model) ? [namespaceOf(model, 'correlation')] : [])],
      middlewareBody(model)
    ),
    file(
      'TelemetryRegistration',
      ['Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing', 'Microsoft.Extensions.Logging', 'OpenTelemetry.Exporter', 'OpenTelemetry.Logs', 'Prometheus'],
      registrationBody()
    ),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/telemetry.yaml`, content: telemetryYaml(model, profile) }))
  ];
}

// ─── TelemetrySettings ───────────────────────────────────────────────────────────────────────────

function settingsBody(model) {
  const switches = instrumentationFor(model);
  const keys = switches.map((entry) => `        [${csString(entry.id)}] = ${csString(entry.property.replaceAll('.', ':'))}`).join(',\n');
  return `/// <summary>
/// La telemetría del perfil activo (<c>telemetry.yaml</c>): el muestreo, el colector, el scrape, el recurso de cada señal
/// y los interruptores de la instrumentación opcional. Las mismas claves y variables que keel-spring y keel-nest.
/// </summary>
public sealed record TelemetrySettings(
    string ServiceName,
    string ServiceVersion,
    string Environment,
    string? InstanceId,
    double SamplingProbability,
    bool ExportEnabled,
    string Endpoint,
    bool LogsExportEnabled,
    bool PrometheusEnabled,
    int? ManagementPort,
    IReadOnlyDictionary<string, bool> Instrumentation)
{
    /// <summary>La clave de configuración de cada interruptor de este diseño (<c>TELEMETRY_INSTRUMENT_*</c>).</summary>
    private static readonly IReadOnlyDictionary<string, string> InstrumentationKeys = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${keys}
    };

    /// <summary>¿Está encendida la instrumentación opcional de <paramref name="id"/> (cache, storage, mail)?</summary>
    public bool Instrumented(string id) => Instrumentation.TryGetValue(id, out var enabled) && enabled;

    /// <summary>La telemetría que dice la configuración del perfil. Una proporción fuera de [0, 1] no deja arrancar.</summary>
    public static TelemetrySettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var sampling = Text(configuration, "telemetry:tracing:sampling-probability") ?? "1.0";
        if (!double.TryParse(sampling, NumberStyles.Float, CultureInfo.InvariantCulture, out var probability) || probability is < 0 or > 1)
        {
            throw new InvalidOperationException($"telemetry.tracing.sampling-probability inválido: '{sampling}' (entre 0 y 1)");
        }
        var port = Text(configuration, "management:server:port");
        return new TelemetrySettings(
            configuration.ApplicationName,
            Text(configuration, "telemetry:resource:service-version") ?? "unknown",
            Text(configuration, "telemetry:resource:deployment-environment") ?? string.Join(',', configuration.Profiles),
            Text(configuration, "telemetry:resource:service-instance-id"),
            probability,
            Flag(configuration, "telemetry:export:enabled", false),
            (Text(configuration, "telemetry:export:endpoint") ?? ${csString(collectorHostEndpoint())}).TrimEnd('/'),
            Flag(configuration, "telemetry:logs:export-enabled", false),
            Flag(configuration, "telemetry:metrics:prometheus-enabled", true),
            port is null ? null : ServiceConfiguration.ToPort(port),
            InstrumentationKeys.ToDictionary(entry => entry.Key, entry => Flag(configuration, entry.Value, true), StringComparer.Ordinal));
    }

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    private static bool Flag(ServiceConfiguration configuration, string key, bool fallback) =>
        Text(configuration, key) is { } value ? string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) : fallback;
}`;
}

// ─── TelemetryNames ──────────────────────────────────────────────────────────────────────────────

function namesBody() {
  const constants = (entries) => Object.entries(entries).map(([key, value]) => `    public const string ${key[0].toUpperCase()}${key.slice(1)} = ${csString(value)};`).join('\n');
  return `/// <summary>Las observaciones propias: el vocabulario neutral (keel-core/gen/telemetry-vocabulary.js), el de keel-spring y keel-nest.</summary>
public static class Observations
{
${constants(OBSERVATIONS)}

    /// <summary>El gauge de los eventos del outbox que agotaron sus reintentos: no se publicarán nunca.</summary>
    public const string OutboxDeadLettered = ${csString(OUTBOX_DEAD_LETTERED)};
}

/// <summary>Los atributos que estampa el código generado; <c>CorrelationId</c> va solo al span, nunca a una etiqueta de métrica.</summary>
public static class TelemetryAttributes
{
${constants(ATTRIBUTES)}
}`;
}

// ─── KeelTelemetry ───────────────────────────────────────────────────────────────────────────────

function telemetryBody() {
  const list = (values) => values.map(csString).join(', ');
  return `/// <summary>Cómo se observa una acción: el span, sus atributos y qué fallo es un desenlace esperado.</summary>
public sealed class ObserveOptions
{
    private static readonly IReadOnlyDictionary<string, string> NoLabels = new Dictionary<string, string>();
    private static readonly IReadOnlyDictionary<string, string?> NoAttributes = new Dictionary<string, string?>();

    /// <summary>El nombre del span (la operación concreta); la métrica lleva el de la observación.</summary>
    public string? Name { get; init; }

    public ActivityKind Kind { get; init; } = ActivityKind.Internal;

    /// <summary>Atributos de BAJA cardinalidad: van al span y, manglados, a la métrica.</summary>
    public IReadOnlyDictionary<string, string> Labels { get; init; } = NoLabels;

    /// <summary>Atributos de ALTA cardinalidad: solo al span.</summary>
    public IReadOnlyDictionary<string, string?> SpanAttributes { get; init; } = NoAttributes;

    /// <summary>
    /// El contexto padre explícito (un traceparent recibido); el contexto vacío pide una traza NUEVA. Sin él (null), el span en
    /// curso si es nuestro, o ninguno.
    /// </summary>
    public ActivityContext? Parent { get; init; }

    /// <summary>Un fallo que es un desenlace esperado (un rechazo del dominio): <c>rejected</c>, sin marcar el span como error.</summary>
    public Func<Exception, bool>? IsRejection { get; init; }
}

/// <summary>
/// La telemetría del proceso: el proveedor de trazas, el registro de métricas (OpenMetrics, para los exemplars) y las
/// piezas con que observa el código generado. Una por proceso; la arranca Program.cs ANTES de crear la aplicación, y sin
/// arrancar (las pruebas que no la piden) todo lo que la consulta sigue sin ella (<see cref="Current"/> es null).
/// </summary>
public sealed class KeelTelemetry
{
    /// <summary>El origen de todos los spans del servicio: el único que el proveedor escucha.</summary>
    public const string SourceName = "keel";

    /// <summary>La ruta del scrape: la misma que en keel-spring y keel-nest, para que el colector no dependa de quién la sirve.</summary>
    public const string ScrapePath = ${csString(METRICS_TRANSPORT.scrapePath)};

    /// <summary>El formato del scrape: OpenMetrics, el único que lleva los exemplars.</summary>
    public const string ScrapeContentType = "application/openmetrics-text; version=1.0.0; charset=utf-8";

    private static readonly ActivitySource Source = new(SourceName);

    private static readonly double[] DurationBuckets = [${DURATION_BUCKETS.join(', ')}];

    private static readonly string[] HttpServerLabels = [${list(HTTP_SERVER_LABELS)}];

    private static readonly string[] HttpClientLabels = [${list(HTTP_CLIENT_LABELS)}];

    /// <summary>Rutas técnicas: no abren traza (las sondas se piden cada pocos segundos), pero sí cuentan en la métrica HTTP.</summary>
    private static readonly HashSet<string> TechnicalPaths = new(StringComparer.Ordinal) { "/livez", "/readyz", ScrapePath };

    private static readonly Lock Gate = new();

    private static KeelTelemetry? current;

    private readonly TracerProvider tracing;

    private readonly IMetricFactory metrics;

    /// <summary>Cada histograma con las etiquetas con que nació: las de una serie no pueden cambiar después.</summary>
    private readonly ConcurrentDictionary<string, (Histogram Metric, string[] Labels)> histograms = new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, Gauge> gauges = new(StringComparer.Ordinal);

    private readonly Lazy<Counter> cacheGets;

    private KeelTelemetry(TelemetrySettings settings)
    {
        Settings = settings;
        Registry = Metrics.NewCustomRegistry();
        metrics = Metrics.WithCustomRegistry(Registry);
        cacheGets = new(() => metrics.CreateCounter("cache_gets_total", "Lecturas de las cachés de lectura", new CounterConfiguration { LabelNames = ["cache", "result"] }));
        Sdk.SetDefaultTextMapPropagator(new W3cOutB3InPropagator());
        // Parent-based: se respeta la decisión de quien llama; la proporción solo decide en las raíces. Sin exportar (local,
        // por defecto) las trazas existen igual: dan el trace.id a los logs y a los exemplars.
        var builder = Sdk.CreateTracerProviderBuilder()
            .SetResourceBuilder(ResourceOf(settings))
            .SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(settings.SamplingProbability)))
            .AddSource(SourceName);
        if (settings.ExportEnabled)
        {
            builder.AddOtlpExporter(options =>
            {
                options.Protocol = OtlpExportProtocol.HttpProtobuf;
                options.Endpoint = new Uri(settings.Endpoint + "/v1/traces");
            });
        }
        tracing = builder.Build() ?? throw new InvalidOperationException("OpenTelemetry no construyó el proveedor de trazas");
    }

    /// <summary>La telemetría en marcha, o null si este proceso no la arrancó.</summary>
    public static KeelTelemetry? Current => Volatile.Read(ref current);

    public TelemetrySettings Settings { get; }

    /// <summary>El registro de métricas del servicio: lo que sirve el scrape.</summary>
    public CollectorRegistry Registry { get; }

    /// <summary>Arranca la telemetría con la configuración del perfil activo. Idempotente: una por proceso.</summary>
    public static KeelTelemetry Start(TelemetrySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        lock (Gate)
        {
            if (Volatile.Read(ref current) is { } running)
            {
                return running;
            }
            var started = new KeelTelemetry(settings);
            Volatile.Write(ref current, started);
            return started;
        }
    }

    /// <summary>El recurso de cada señal: el servicio, su versión, su entorno y la réplica que la emitió.</summary>
    public static ResourceBuilder ResourceOf(TelemetrySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return ResourceBuilder.CreateEmpty()
            .AddService(settings.ServiceName, serviceVersion: settings.ServiceVersion, autoGenerateServiceInstanceId: false, serviceInstanceId: settings.InstanceId)
            .AddAttributes([new KeyValuePair<string, object>("deployment.environment", settings.Environment)]);
    }

    /// <summary>
    /// Ejecuta <paramref name="action"/> dentro de un span de la observación y registra su duración en el histograma de la
    /// misma, con el desenlace (<c>keel.outcome</c>) y, si la traza se muestrea, el exemplar que enlaza el punto con ella.
    /// </summary>
    public async Task<T> Observe<T>(string observation, ObserveOptions options, Func<Task<T>> action)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(action);
        var started = Stopwatch.GetTimestamp();
        using var span = Begin(options.Name ?? observation, options.Kind, options.Parent);
        foreach (var (key, value) in options.Labels)
        {
            span?.SetTag(key, value);
        }
        foreach (var (key, value) in options.SpanAttributes)
        {
            if (value is not null)
            {
                span?.SetTag(key, value);
            }
        }
        var outcome = "ok";
        try
        {
            return await action();
        }
        catch (Exception error)
        {
            if (options.IsRejection?.Invoke(error) == true)
            {
                // Un rechazo del dominio NO es un error del span: es un desenlace esperado (un 4xx).
                outcome = "rejected";
            }
            else
            {
                outcome = "error";
                span?.AddException(error);
                span?.SetStatus(ActivityStatusCode.Error);
            }
            throw;
        }
        finally
        {
            span?.SetTag(TelemetryAttributes.Outcome, outcome);
            span?.Stop();
            var labels = options.Labels.Append(new KeyValuePair<string, string>(TelemetryAttributes.Outcome, outcome)).ToList();
            Record(observation, labels, Stopwatch.GetElapsedTime(started).TotalSeconds, span);
        }
    }

    /// <summary>Lo mismo sin resultado.</summary>
    public Task Observe(string observation, ObserveOptions options, Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(action);
        return Observe(observation, options, async () =>
        {
            await action();
            return true;
        });
    }

    /// <summary>
    /// La publicación de un evento desde el outbox: un span PRODUCER que continúa la traza que lo originó (la que quedó en la
    /// envoltura de la fila, porque el relay publica en otro instante y sin el contexto de la petición).
    /// </summary>
    public Task Publishing(string eventType, string? traceparent, Func<Task> action) =>
        Observe(Observations.OutboxPublish, EventOptions(eventType + " publish", ActivityKind.Producer, eventType, traceparent), action);

    /// <summary>El consumo de un evento: un span CONSUMER que continúa la traza del emisor (<c>metadata.traceparent</c>).</summary>
    public Task<T> Consuming<T>(string eventType, string? traceparent, Func<Task<T>> action) =>
        Observe(Observations.MessageConsume, EventOptions(eventType + " consume", ActivityKind.Consumer, eventType, traceparent), action);

    /// <summary>
    /// Una llamada saliente: un span CLIENT que escribe la traza en las cabeceras ANTES de llamar. Lo cierra
    /// <see cref="FinishClient"/>, con la métrica <c>http_client_requests_seconds</c> y las etiquetas de keel-spring (la
    /// plantilla de la ruta, nunca la URL con sus valores).
    /// </summary>
    public Activity? StartClient(string clientName, string method, string uriTemplate, HttpRequestHeaders headers)
    {
        ArgumentNullException.ThrowIfNull(headers);
        var span = Begin(method + " " + uriTemplate, ActivityKind.Client, null);
        span?.SetTag("http.request.method", method);
        span?.SetTag("url.template", uriTemplate);
        span?.SetTag("keel.client", clientName);
        headers.Remove("traceparent");
        headers.Remove("tracestate");
        Propagators.DefaultTextMapPropagator.Inject(
            new PropagationContext(span?.Context ?? default, Baggage.Current),
            headers,
            static (carrier, name, value) => carrier.TryAddWithoutValidation(name, value));
        return span;
    }

    /// <summary>
    /// Cierra el span de una llamada saliente y la mide. Sin respuesta, el estado es <c>IO_ERROR</c>; sin respuesta o sin un
    /// 2xx, el span va como error (el adaptador lo trata como un fallo del proveedor).
    /// </summary>
    public void FinishClient(Activity? span, long started, string clientName, string method, string uriTemplate, int? status)
    {
        var text = status?.ToString(CultureInfo.InvariantCulture) ?? "IO_ERROR";
        span?.SetTag("http.response.status_code", text);
        if (status is null or < 200 or > 299)
        {
            span?.SetStatus(ActivityStatusCode.Error);
        }
        span?.Stop();
        HistogramOf("http.client.requests", HttpClientLabels).Metric
            .WithLabels(method, uriTemplate, text, clientName, status is { } code ? OutcomeOf(code) : "UNKNOWN")
            .Observe(Stopwatch.GetElapsedTime(started).TotalSeconds, ExemplarOf(span));
    }

    /// <summary>
    /// La entrada HTTP: abre el span SERVER de una petición continuando la traza de quien llama, salvo en las rutas técnicas
    /// (null). Lo cierra <see cref="FinishServer"/>.
    /// </summary>
    public static Activity? StartServer(string method, string path, ActivityContext parent)
    {
        if (TechnicalPaths.Contains(path))
        {
            return null;
        }
        var span = Begin(method + " " + path, ActivityKind.Server, parent);
        span?.SetTag("http.request.method", method);
        span?.SetTag("url.path", path);
        return span;
    }

    /// <summary>
    /// Cierra el span de la entrada HTTP y mide <c>http_server_requests_seconds</c> con las etiquetas de keel-spring: la
    /// plantilla de la ruta (<c>/products/{id}</c>), <c>NOT_FOUND</c> si ninguna casó con un 404, <c>UNKNOWN</c> si no.
    /// </summary>
    public void FinishServer(Activity? span, long started, string method, string? route, int status, string? correlationId)
    {
        var uri = route ?? (status == 404 ? "NOT_FOUND" : "UNKNOWN");
        if (span is not null)
        {
            span.DisplayName = method + " " + uri;
            span.SetTag("http.route", uri);
            span.SetTag("http.response.status_code", status);
            if (correlationId is not null)
            {
                span.SetTag(TelemetryAttributes.CorrelationId, correlationId);
            }
            if (status >= 500)
            {
                span.SetStatus(ActivityStatusCode.Error);
            }
            span.Stop();
        }
        HistogramOf("http.server.requests", HttpServerLabels).Metric
            .WithLabels(method, uri, status.ToString(CultureInfo.InvariantCulture), OutcomeOf(status), "none")
            .Observe(Stopwatch.GetElapsedTime(started).TotalSeconds, ExemplarOf(span));
    }

    /// <summary>
    /// Un acierto o un fallo de una caché de lectura: <c>cache_gets_total{cache,result}</c>, la serie del ratio de acierto del
    /// panel (la misma que publica keel-spring con las estadísticas del gestor de caché).
    /// </summary>
    public void CacheGet(string cache, bool hit) => cacheGets.Value.WithLabels(cache, hit ? "hit" : "miss").Inc();

    /// <summary>
    /// Un gauge que se lee en cada scrape (<c>keel.outbox.dead_lettered</c>: los eventos que agotaron sus reintentos). Gauge y no
    /// contador: un contador se reinicia con el proceso y no vería lo que se rindió antes de arrancar. Una vez por nombre.
    /// </summary>
    public void RegisterGauge(string name, string help, Func<CancellationToken, Task<double>> read)
    {
        ArgumentNullException.ThrowIfNull(read);
        var metric = Mangle(name);
        var created = false;
        var gauge = gauges.GetOrAdd(metric, key =>
        {
            created = true;
            return metrics.CreateGauge(key, help);
        });
        if (created)
        {
            Registry.AddBeforeCollectCallback(async cancellationToken => gauge.Set(await read(cancellationToken)));
        }
    }

    /// <summary>El contexto que continúa la traza de un <c>traceparent</c> recibido (la envoltura de un evento); sin él, ninguno.</summary>
    public static ActivityContext? ContextFrom(string? traceparent) =>
        traceparent is not null && ActivityContext.TryParse(traceparent, null, isRemote: true, out var context) ? context : null;

    /// <summary>El contexto de traza que llega en las cabeceras de una petición (W3C, o B3 si no hay W3C).</summary>
    public static ActivityContext Extract<TCarrier>(TCarrier carrier, Func<TCarrier, string, IEnumerable<string>?> getter) =>
        Propagators.DefaultTextMapPropagator.Extract(default, carrier, getter).ActivityContext;

    /// <summary>El <c>traceparent</c> W3C del span en curso si es del servicio, para estamparlo en la envoltura de un evento.</summary>
    public static string? CurrentTraceparent() => Activity.Current is { Source.Name: SourceName } span ? span.Id : null;

    /// <summary>Los ids de la traza en curso si el span es del servicio (para el logger), o null.</summary>
    public static (string TraceId, string SpanId)? TraceIds() =>
        Activity.Current is { Source.Name: SourceName } span ? (span.TraceId.ToHexString(), span.SpanId.ToHexString()) : null;

    /// <summary>¿Es una ruta técnica (sondas, scrape)?</summary>
    public static bool IsTechnical(string path) => TechnicalPaths.Contains(path);

    /// <summary>Exporta YA las trazas en cola, sin apagar nada (lo llama el apagado del servicio).</summary>
    public void Flush() => tracing.ForceFlush(5000);

    /// <summary>
    /// Abre un span del servicio. El padre es el explícito si lo hay; si no, el span en curso SOLO si es nuestro: el que abre
    /// ASP.NET Core para cada petición no se exporta, y colgar de él dejaría la traza con un padre que no existe. El cambio de
    /// Activity.Current vale para el flujo asíncrono de quien llama, que siempre es un método asíncrono.
    /// </summary>
    private static Activity? Begin(string name, ActivityKind kind, ActivityContext? parent)
    {
        if (parent is { } remote && remote != default)
        {
            return Source.StartActivity(name, kind, remote);
        }
        // El contexto vacío pide una traza nueva; con StartActivity(name, kind, default) colgaría del span en curso.
        if (parent is not null || Activity.Current is { } running && running.Source != Source)
        {
            Activity.Current = null;
        }
        return Source.StartActivity(name, kind);
    }

    private static ObserveOptions EventOptions(string name, ActivityKind kind, string eventType, string? traceparent) => new()
    {
        Name = name,
        Kind = kind,
        Labels = new Dictionary<string, string>(StringComparer.Ordinal) { [TelemetryAttributes.EventType] = eventType },
        // Sin traceparent, una traza nueva: el relay y el consumo no corren dentro de ninguna petición.
        Parent = ContextFrom(traceparent) ?? default(ActivityContext)
    };

    /// <summary>
    /// Un punto del histograma de la observación. Los valores se ALINEAN con las etiquetas con que nació la serie (lo que
    /// falte va como <c>none</c>, lo que sobre no entra): la métrica no puede lanzar, y lanzaría en el finally de la acción
    /// observada, o sea rompiendo la operación de negocio.
    /// </summary>
    private void Record(string observation, IReadOnlyList<KeyValuePair<string, string>> labels, double seconds, Activity? span)
    {
        var values = labels.ToDictionary(label => Mangle(label.Key), label => label.Value, StringComparer.Ordinal);
        var (metric, names) = HistogramOf(observation, [.. values.Keys]);
        metric.WithLabels([.. names.Select(name => values.TryGetValue(name, out var value) ? value : "none")]).Observe(seconds, ExemplarOf(span));
    }

    /// <summary>El histograma de una observación, con el nombre de serie de keel-spring (<c>&lt;observación&gt;_seconds</c>).</summary>
    private (Histogram Metric, string[] Labels) HistogramOf(string observation, string[] labelNames) =>
        histograms.GetOrAdd(observation, name => (
            metrics.CreateHistogram(
                Mangle(name) + "_seconds",
                name,
                new HistogramConfiguration
                {
                    LabelNames = labelNames,
                    Buckets = DurationBuckets,
                    ExemplarBehavior = new ExemplarBehavior { NewExemplarMinInterval = TimeSpan.Zero }
                }),
            labelNames));

    /// <summary>El exemplar de un punto: solo si la traza se muestrea (un id de una traza que no se exportó no lleva a nada).</summary>
    private static Exemplar ExemplarOf(Activity? span) =>
        span is { Recorded: true }
            ? Exemplar.From(Exemplar.Pair("trace_id", span.TraceId.ToHexString()), Exemplar.Pair("span_id", span.SpanId.ToHexString()))
            : Exemplar.None;

    /// <summary>El desenlace de una respuesta HTTP, con los valores de keel-spring.</summary>
    private static string OutcomeOf(int status) => status switch
    {
        < 200 => "INFORMATIONAL",
        < 300 => "SUCCESS",
        < 400 => "REDIRECTION",
        < 500 => "CLIENT_ERROR",
        < 600 => "SERVER_ERROR",
        _ => "UNKNOWN"
    };

    /// <summary>El nombre de una serie o una etiqueta: lo que no es alfanumérico, a <c>_</c> (promMetric de keel-core).</summary>
    public static string Mangle(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        var text = new System.Text.StringBuilder(name.Length);
        var previousUnderscore = false;
        foreach (var character in name)
        {
            if (char.IsAsciiLetterOrDigit(character))
            {
                text.Append(character);
                previousUnderscore = false;
            }
            else if (!previousUnderscore)
            {
                text.Append('_');
                previousUnderscore = true;
            }
        }
        return text.ToString();
    }
}`;
}

// ─── El propagador ───────────────────────────────────────────────────────────────────────────────

function propagatorBody() {
  return `/// <summary>
/// Produce W3C y acepta además B3 (una y varias cabeceras) de quien llame: una malla de servicio o un sistema de la familia
/// Zipkin no corta la traza al llegar aquí. Emitir B3 no aporta nada a quien ya entiende W3C. El de keel-nest.
/// </summary>
public sealed class W3cOutB3InPropagator : TextMapPropagator
{
    private readonly TraceContextPropagator w3c = new();

    // Los de Extensions.Propagators (el B3Propagator del namespace del núcleo está obsoleto). Cada uno lee UNA forma: la
    // cabecera única b3 o las X-B3-*, según cómo se construye.
    private readonly OpenTelemetry.Extensions.Propagators.B3Propagator b3Single = new(singleHeader: true);

    private readonly OpenTelemetry.Extensions.Propagators.B3Propagator b3Multi = new();

    public override ISet<string>? Fields => w3c.Fields;

    public override void Inject<T>(PropagationContext context, T carrier, Action<T, string, string> setter) => w3c.Inject(context, carrier, setter);

    public override PropagationContext Extract<T>(PropagationContext context, T carrier, Func<T, string, IEnumerable<string>?> getter)
    {
        var fromW3c = w3c.Extract(context, carrier, getter);
        if (fromW3c.ActivityContext.TraceId != default)
        {
            return fromW3c;
        }
        var fromSingle = b3Single.Extract(context, carrier, getter);
        return fromSingle.ActivityContext.TraceId != default ? fromSingle : b3Multi.Extract(context, carrier, getter);
    }
}`;
}

// ─── La entrada HTTP ─────────────────────────────────────────────────────────────────────────────

function middlewareBody(model) {
  const correlation = usesCorrelation(model)
    ? 'context.Response.Headers[CorrelationContext.Header].FirstOrDefault()'
    : 'null';
  return `/// <summary>
/// La entrada HTTP observada: un span SERVER por petición (continuando la traza de quien llama) y la métrica
/// <c>http_server_requests_seconds</c>. Va la PRIMERA del pipeline, antes que la correlación, para que todo lo que haga la
/// petición quede dentro del span.
/// </summary>
public sealed class HttpTelemetryMiddleware(RequestDelegate next, KeelTelemetry telemetry)
{
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var started = Stopwatch.GetTimestamp();
        var method = context.Request.Method;
        var parent = KeelTelemetry.Extract(context.Request.Headers, static (headers, name) => headers.TryGetValue(name, out var values) ? values.OfType<string>() : null);
        var span = KeelTelemetry.StartServer(method, context.Request.Path.Value ?? "/", parent);
        var status = StatusCodes.Status500InternalServerError;
        try
        {
            await next(context);
            status = context.Response.StatusCode;
        }
        finally
        {
            var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
            telemetry.FinishServer(span, started, method, route, status, ${correlation});
        }
    }
}`;
}

// ─── El registro ─────────────────────────────────────────────────────────────────────────────────

function registrationBody() {
  return `/// <summary>La telemetría en el arranque: los logs por OTLP, el scrape y el vaciado al apagar.</summary>
public static class TelemetryRegistration
{
    /// <summary>
    /// Los logs por OTLP, solo con <c>LOG_EXPORT_OTLP</c>: el canal primario de los logs es la consola, y encenderlo además de
    /// recogerla duplica cada línea.
    /// </summary>
    public static ILoggingBuilder AddTelemetryLogs(this ILoggingBuilder logging, KeelTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(logging);
        ArgumentNullException.ThrowIfNull(telemetry);
        var settings = telemetry.Settings;
        if (settings.ExportEnabled && settings.LogsExportEnabled)
        {
            logging.AddOpenTelemetry(options =>
            {
                options.SetResourceBuilder(KeelTelemetry.ResourceOf(settings));
                options.IncludeScopes = true;
                options.AddOtlpExporter(exporter =>
                {
                    exporter.Protocol = OtlpExportProtocol.HttpProtobuf;
                    exporter.Endpoint = new Uri(settings.Endpoint + "/v1/logs");
                });
            });
        }
        return logging;
    }

    /// <summary>
    /// El scrape (OpenMetrics, con los exemplars). En production va en su puerto de gestión (<c>MANAGEMENT_PORT</c>), que no se
    /// publica fuera del pod; fuera de production, en el principal.
    /// </summary>
    public static IEndpointRouteBuilder MapTelemetryEndpoints(this IEndpointRouteBuilder endpoints, KeelTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(telemetry);
        if (!telemetry.Settings.PrometheusEnabled)
        {
            return endpoints;
        }
        var scrape = endpoints.MapGet(KeelTelemetry.ScrapePath, async (HttpContext context) =>
        {
            context.Response.ContentType = KeelTelemetry.ScrapeContentType;
            await telemetry.Registry.CollectAndExportAsTextAsync(context.Response.Body, ExpositionFormat.OpenMetricsText, context.RequestAborted);
        });
        if (telemetry.Settings.ManagementPort is { } port)
        {
            scrape.RequireHost("*:" + port.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        return endpoints;
    }
}`;
}

// ─── Lo que cambia en Program.cs ─────────────────────────────────────────────────────────────────

/** Lo que cambia en Program.cs con telemetría: arrancarla antes que nada, el middleware, el scrape y el vaciado. */
export function programTelemetry(model) {
  if (!usesTelemetry(model)) return { usings: [], start: '', services: '', logging: '', urls: null, pipeline: '', mapping: '', shutdown: '' };
  return {
    usings: [telemetryNamespace(model)],
    start: `
// La telemetría arranca ANTES que la aplicación: los spans de su arranque ya tienen proveedor (telemetry.yaml).
var telemetry = KeelTelemetry.Start(TelemetrySettings.From(configuration));`,
    services: '\nbuilder.Services.AddSingleton(telemetry);',
    logging: '\nbuilder.Logging.AddTelemetryLogs(telemetry);',
    // En production, el puerto de gestión además del principal.
    urls: 'telemetry.Settings.ManagementPort is { } management\n    ? new[] { $"http://{configuration.Server.Address}:{configuration.Server.Port}", $"http://{configuration.Server.Address}:{management}" }\n    : new[] { $"http://{configuration.Server.Address}:{configuration.Server.Port}" }',
    pipeline: '\napp.UseMiddleware<HttpTelemetryMiddleware>();',
    mapping: '\napp.MapTelemetryEndpoints(telemetry);',
    shutdown: '\n// Al apagar, las últimas trazas salen antes de que el proceso termine.\napp.Lifetime.ApplicationStopped.Register(telemetry.Flush);'
  };
}

export { promGauge };

// ─── Los puertos observados: storage y correo ────────────────────────────────────────────────────

/**
 * El puerto de storage observado (keel.storage, con la operación y el bucket LÓGICO del diseño: un nombre de un conjunto
 * cerrado; la key del objeto no sale nunca, es dato). Un decorador sobre el PUERTO y no dentro del adaptador, porque el
 * adaptador lo escribe el agente: así se instrumenta cualquier implementación, como el aspecto de keel-spring. Los métodos
 * son los del puerto, que dependen de la visibilidad de los buckets; PublicUrl no habla con el almacén y no se observa.
 */
export function observedStorageFile(model, { namespace, path, usings }) {
  if (!usesTelemetry(model)) return null;
  const storage = model.storage ?? {};
  const method = (operation, signature, call) =>
    `    public ${signature} =>\n        telemetry.Observe(Observations.Storage, Options(${csString(operation)}, bucket), () => inner.${call});`;
  const members = [
    method('upload', 'Task<StoredObject> Upload(string bucket, string key, ReadOnlyMemory<byte> content, string contentType, CancellationToken cancellationToken = default)', 'Upload(bucket, key, content, contentType, cancellationToken)'),
    ...(storage.hasPrivateBucket ? [method('download', 'Task<byte[]> Download(string bucket, string key, CancellationToken cancellationToken = default)', 'Download(bucket, key, cancellationToken)')] : []),
    ...(storage.hasPublicBucket ? ['    public string PublicUrl(string bucket, string key) => inner.PublicUrl(bucket, key);'] : []),
    method('delete', 'Task Delete(string bucket, string key, CancellationToken cancellationToken = default)', 'Delete(bucket, key, cancellationToken)'),
    ...(storage.hasPrivateBucket ? [method('signedUrl', 'Task<string> SignedUrl(string bucket, string key, CancellationToken cancellationToken = default)', 'SignedUrl(bucket, key, cancellationToken)')] : [])
  ];
  const body = `/// <summary>
/// El puerto de storage observado: cada operación sobre un bucket en un span de keel.storage con su timer, la operación y
/// el bucket lógico. La key del objeto no sale nunca: los nombres de archivo llevan datos de personas. Lo registra
/// StorageRegistration con TELEMETRY_INSTRUMENT_STORAGE encendido.
/// </summary>
public sealed class ObservedFileStorage(IFileStorage inner, KeelTelemetry telemetry) : IFileStorage
{
${members.join('\n\n')}

    private static ObserveOptions Options(string operation, string bucket) => new()
    {
        Name = Observations.Storage + " " + operation,
        Labels = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [TelemetryAttributes.StorageOperation] = operation,
            [TelemetryAttributes.StorageBucket] = bucket
        }
    };
}`;
  return { path, content: csFile({ namespace, usings: [...usings, telemetryNamespace(model)], body }) };
}

/** El puerto de correo observado (keel.mail.send). Sin más etiqueta que el desenlace: el destinatario es dato. */
export function observedMailFile(model, { namespace, path, usings }) {
  if (!usesTelemetry(model)) return null;
  const body = `/// <summary>
/// El envío de correo observado: un span de keel.mail.send con su timer y el desenlace, y nada más. El destinatario y el
/// asunto son dato: un correo identificado por su destinatario en el backend de trazas es una lista de direcciones que
/// nadie decidió publicar. Lo registra MailRegistration con TELEMETRY_INSTRUMENT_MAIL encendido.
/// </summary>
public sealed class ObservedMailSender(IMailSender inner, KeelTelemetry telemetry) : IMailSender
{
    private static readonly ObserveOptions Sending = new() { Name = Observations.MailSend };

    public Task Send(MailMessage message, CancellationToken cancellationToken = default) =>
        telemetry.Observe(Observations.MailSend, Sending, () => inner.Send(message, cancellationToken));
}`;
  return { path, content: csFile({ namespace, usings: [...usings, telemetryNamespace(model)], body }) };
}

/**
 * El registro de un puerto que la telemetría puede observar: con su interruptor encendido, el decorador alrededor del
 * adaptador; si no, el adaptador tal cual.
 */
export function observedRegistration(model, { port, adapter, decorator, instrumentation }) {
  if (!usesTelemetry(model)) return null;
  return `services.AddSingleton<${port}>(provider => KeelTelemetry.Current is { } telemetry && telemetry.Settings.Instrumented(${csString(instrumentation)})
            ? new ${decorator}(provider.GetRequiredService<${adapter}>(), telemetry)
            : provider.GetRequiredService<${adapter}>());`;
}
