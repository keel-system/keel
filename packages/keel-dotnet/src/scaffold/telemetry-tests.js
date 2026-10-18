// La prueba emitida de la telemetría (incremento 14c): la telemetría EJECUTADA sin red. El servidor en memoria del
// perfil test (su telemetría arranca con él), un escuchador de los spans del origen `keel` y el scrape. Lo que dice un
// colector y un backend DE VERDAD lo mide la red del generador (telemetry-check y deploy-check, incremento 14f).

import { csFile, namespaceOf, solution } from './render.js';
import { configNamespace } from './config.js';
import { loggingNamespace } from './logging.js';
import { messagingNamespace, usesMessaging } from './messaging.js';
import { telemetryNamespace, usesTelemetry } from './telemetry.js';

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  const sln = solution(model);
  const messaging = usesMessaging(model);
  const usings = [
    'System.Collections.Concurrent',
    'System.Diagnostics',
    'System.Globalization',
    'System.Net',
    'System.Text',
    'System.Text.Json',
    'Microsoft.Extensions.Logging',
    'Microsoft.Extensions.Logging.Abstractions',
    'Microsoft.Extensions.Options',
    'Prometheus',
    'Xunit',
    configNamespace(model),
    namespaceOf(model, 'errors'),
    loggingNamespace(model),
    telemetryNamespace(model),
    ...(messaging ? [messagingNamespace(model), namespaceOf(model, 'events')] : [])
  ];
  return [{ path: `${sln.unitTests.dir}/TelemetryTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body: body(messaging) }) }];
}

function body(messaging) {
  return String.raw`/// <summary>
/// La telemetría EJECUTADA sin red: el servidor en memoria del perfil test, los spans del origen keel y el scrape. Lo que
/// se afirma es lo que hacen keel-spring y keel-nest: la entrada HTTP continúa la traza de quien llama y mide
/// http_server_requests_seconds con la plantilla y el exemplar; el caso de uso separa ok, rejected y error; la llamada
/// saliente escribe su traza; un span del servicio nunca cuelga del que abre ASP.NET Core; y la línea de log lleva los
/// ids de su traza. Lo que dice un colector de verdad lo mide telemetry-check.
/// </summary>
public sealed class TelemetryTests : IDisposable
{
    private readonly ConcurrentDictionary<ActivitySpanId, Activity> finished = new();

    private readonly ActivityListener listener;

    public TelemetryTests()
    {
        // Escucha sin decidir el muestreo (None): manda el del proveedor del servicio.
        listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == KeelTelemetry.SourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.None,
            ActivityStopped = activity => finished[activity.SpanId] = activity
        };
        ActivitySource.AddActivityListener(listener);
    }

    public void Dispose() => listener.Dispose();

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    /// <summary>
    /// La observación de las pruebas que no miden un caso de uso: las etiquetas de una serie las fija su primer punto, y
    /// keel.use-case sin keel.operation dejaría la serie sin ella para la prueba que sí la mide.
    /// </summary>
    private const string Probe = "keel.prueba";

    /// <summary>La telemetría del perfil test: la misma que arranca el servidor en memoria (una por proceso).</summary>
    private static KeelTelemetry Started() =>
        KeelTelemetry.Start(TelemetrySettings.From(ServiceConfiguration.Load(name => name == "PROFILE" ? "test" : null)));

    private Activity Finished(ActivitySpanId spanId) =>
        finished.TryGetValue(spanId, out var span) ? span : throw new Xunit.Sdk.XunitException($"el span {spanId} no terminó");

    private static async Task<string> Exposition(KeelTelemetry telemetry)
    {
        using var stream = new MemoryStream();
        await telemetry.Registry.CollectAndExportAsTextAsync(stream, ExpositionFormat.OpenMetricsText, Token);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static async Task<string> Scrape(InMemoryServer server)
    {
        using var client = server.CreateClient();
        using var response = await client.GetAsync(KeelTelemetry.ScrapePath, Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.StartsWith("application/openmetrics-text", response.Content.Headers.ContentType?.ToString(), StringComparison.Ordinal);
        var text = await response.Content.ReadAsStringAsync(Token);
        Assert.EndsWith("# EOF\n", text, StringComparison.Ordinal);
        return text;
    }

    private static IEnumerable<string>? FromDictionary(Dictionary<string, string> carrier, string name) =>
        carrier.TryGetValue(name, out var value) ? [value] : null;

    [Fact]
    public async Task LaEntradaHttpContinuaLaTrazaDeQuienLlamaYLaMideConElExemplar()
    {
        await using var server = new InMemoryServer();
        var trace = ActivityTraceId.CreateRandom();
        var caller = ActivitySpanId.CreateRandom();
        using var client = server.CreateClient();
        // Un método propio: ninguna otra prueba escribe en esta serie, y su exemplar es el de esta petición.
        using var request = new HttpRequestMessage(new HttpMethod("KEELPROBE"), "/keel-telemetria-ruta-inexistente");
        request.Headers.TryAddWithoutValidation("traceparent", $"00-{trace.ToHexString()}-{caller.ToHexString()}-01");
        using var response = await client.SendAsync(request, Token);
        var status = (int)response.StatusCode;
        // Sin ruta que case: NOT_FOUND con un 404, UNKNOWN si la seguridad respondió antes de enrutar.
        var uri = status == 404 ? "NOT_FOUND" : "UNKNOWN";

        var span = Assert.Single(finished.Values, activity => activity.TraceId == trace && activity.Kind == ActivityKind.Server);
        Assert.Equal(caller, span.ParentSpanId);
        Assert.Equal("KEELPROBE " + uri, span.DisplayName);
        Assert.Equal(uri, span.GetTagItem("http.route"));

        var bucket = (await Scrape(server)).Split('\n').FirstOrDefault(line =>
            line.StartsWith("http_server_requests_seconds_bucket{", StringComparison.Ordinal)
            && line.Contains("method=\"KEELPROBE\"", StringComparison.Ordinal)
            && line.Contains($"uri=\"{uri}\"", StringComparison.Ordinal)
            && line.Contains($"status=\"{status}\"", StringComparison.Ordinal)
            && line.Contains($"trace_id=\"{trace.ToHexString()}\"", StringComparison.Ordinal));
        Assert.NotNull(bucket);
        Assert.Contains($"span_id=\"{span.SpanId.ToHexString()}\"", bucket, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LasSondasNoAbrenTrazaPeroCuentanEnLaMetrica()
    {
        await using var server = new InMemoryServer();
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/livez", Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain(finished.Values, activity => activity.Kind == ActivityKind.Server && activity.GetTagItem("url.path") as string == "/livez");
        Assert.Contains("http_server_requests_seconds_count{method=\"GET\",uri=\"/livez\"", await Scrape(server), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ElCasoDeUsoSeparaOkRechazadoYErrorYSoloElErrorMarcaElSpan()
    {
        var telemetry = Started();
        var operation = "PruebaDesenlace" + Guid.NewGuid().ToString("N");
        // Cada span con su nombre: el desenlace tiene que ser el de la excepción que lo produjo, no solo uno de cada.
        ObserveOptions Options(string span) => new()
        {
            Name = operation + span,
            Labels = new Dictionary<string, string> { [TelemetryAttributes.Operation] = operation },
            IsRejection = error => error is DomainException
        };
        await telemetry.Observe(Observations.UseCase, Options("-bien"), () => Task.CompletedTask);
        await Assert.ThrowsAnyAsync<DomainException>(() => telemetry.Observe(Observations.UseCase, Options("-rechazo"), () => throw new PruebaRechazo()));
        await Assert.ThrowsAsync<InvalidOperationException>(() => telemetry.Observe(Observations.UseCase, Options("-roto"), () => throw new InvalidOperationException("roto")));

        Activity Span(string suffix) => Assert.Single(finished.Values, activity => activity.DisplayName == operation + suffix);
        Assert.Equal("ok", Span("-bien").GetTagItem(TelemetryAttributes.Outcome));
        Assert.Equal("rejected", Span("-rechazo").GetTagItem(TelemetryAttributes.Outcome));
        Assert.Equal("error", Span("-roto").GetTagItem(TelemetryAttributes.Outcome));
        // Un rechazo del dominio es un desenlace esperado (un 4xx): solo el fallo marca el span como error.
        Assert.NotEqual(ActivityStatusCode.Error, Span("-rechazo").Status);
        Assert.Equal(ActivityStatusCode.Error, Span("-roto").Status);

        var exposition = await Exposition(telemetry);
        foreach (var outcome in new[] { "ok", "rejected", "error" })
        {
            Assert.Contains($"keel_use_case_seconds_count{{keel_operation=\"{operation}\",keel_outcome=\"{outcome}\"}} 1", exposition, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task UnSpanDelServicioNoCuelgaDelQueAbreAspNetCore()
    {
        var telemetry = Started();
        using var host = new Activity("Microsoft.AspNetCore.Hosting.HttpRequestIn").Start();
        ActivityContext? inside = null;
        await telemetry.Observe(Probe, new ObserveOptions { Name = "PruebaRaiz" }, () =>
        {
            inside = Activity.Current?.Context;
            return Task.CompletedTask;
        });
        Assert.NotEqual(host.TraceId, inside?.TraceId);
        Assert.Equal(default, Finished(inside!.Value.SpanId).ParentSpanId);
        Assert.Same(host, Activity.Current);
    }

    [Fact]
    public async Task LaLlamadaSalienteEscribeLaTrazaDeSuSpanYMideConLaPlantilla()
    {
        var telemetry = Started();
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://proveedor.invalid/items/42");
        request.Headers.TryAddWithoutValidation("traceparent", "00-00000000000000000000000000000001-0000000000000001-01");
        var client = "prueba-" + Guid.NewGuid().ToString("N");
        var span = telemetry.StartClient(client, "GET", "/items/{id}", request.Headers);
        Assert.NotNull(span);
        Assert.Equal(new[] { span.Id }, request.Headers.GetValues("traceparent"));
        telemetry.FinishClient(span, Stopwatch.GetTimestamp(), client, "GET", "/items/{id}", null);
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Contains(
            $"http_client_requests_seconds_count{{method=\"GET\",uri=\"/items/{{id}}\",status=\"IO_ERROR\",client_name=\"{client}\",outcome=\"UNKNOWN\"}} 1",
            await Exposition(telemetry),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ElPropagadorLeeW3cYTambienB3()
    {
        Started();
        var w3c = KeelTelemetry.Extract(new Dictionary<string, string> { ["traceparent"] = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, FromDictionary);
        Assert.Equal("0af7651916cd43dd8448eb211c80319c", w3c.TraceId.ToHexString());
        var single = KeelTelemetry.Extract(new Dictionary<string, string> { ["b3"] = "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1" }, FromDictionary);
        Assert.Equal("80f198ee56343ba864fe8b2a57d3eff7", single.TraceId.ToHexString());
        var multi = KeelTelemetry.Extract(
            new Dictionary<string, string> { ["X-B3-TraceId"] = "463ac35c9f6413ad48485a3953bb6124", ["X-B3-SpanId"] = "a2fb4a1d1a96d312", ["X-B3-Sampled"] = "1" },
            FromDictionary);
        Assert.Equal("463ac35c9f6413ad48485a3953bb6124", multi.TraceId.ToHexString());
    }

    [Fact]
    public async Task LaLineaDeLogLlevaLosIdsDeSuTraza()
    {
        var telemetry = Started();
        var settings = new LoggingSettings(LogFormat.Ecs, LogLevel.Information, LogLevel.Information, "servicio", null, null, null);
        var formatter = new KeelConsoleFormatter(Options.Create(new KeelConsoleFormatterOptions { Settings = settings }));
        string? line = null;
        (string Trace, string Span)? ids = null;
        await telemetry.Observe(Probe, new ObserveOptions { Name = "PruebaLog" }, () =>
        {
            using var writer = new StringWriter(CultureInfo.InvariantCulture);
            formatter.Write(new LogEntry<string>(LogLevel.Information, "Prueba", new EventId(0), "dentro", null, (state, _) => state), null, writer);
            line = writer.ToString();
            ids = (Activity.Current!.TraceId.ToHexString(), Activity.Current.SpanId.ToHexString());
            return Task.CompletedTask;
        });
        using var document = JsonDocument.Parse(line!);
        Assert.Equal(ids!.Value.Trace, document.RootElement.GetProperty("trace").GetProperty("id").GetString());
        Assert.Equal(ids.Value.Span, document.RootElement.GetProperty("span").GetProperty("id").GetString());
    }

    [Fact]
    public async Task UnGaugeSeLeeEnCadaScrape()
    {
        var telemetry = Started();
        var value = 0;
        var name = "keel.prueba.gauge." + Guid.NewGuid().ToString("N");
        telemetry.RegisterGauge(name, "prueba", _ => Task.FromResult((double)Interlocked.Increment(ref value)));
        Assert.Contains(KeelTelemetry.Mangle(name) + " 1", await Exposition(telemetry), StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionMuestreaUnDecimoYSirveElScrapeEnElPuertoDeGestion()
    {
        var root = OnlyTelemetry();
        try
        {
            var production = TelemetrySettings.From(ServiceConfiguration.Load(name => name switch
            {
                "PROFILE" => "production",
                "OTEL_EXPORTER_OTLP_ENDPOINT" => "http://colector:4318",
                _ => null
            }, root));
            Assert.Equal(0.1, production.SamplingProbability);
            Assert.Equal(8081, production.ManagementPort);
            Assert.True(production.ExportEnabled);
            Assert.Equal("http://colector:4318", production.Endpoint);
            var test = TelemetrySettings.From(ServiceConfiguration.Load(name => name == "PROFILE" ? "test" : null, root));
            Assert.False(test.ExportEnabled);
            Assert.Null(test.ManagementPort);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>Solo application.yaml y el telemetry.yaml de cada perfil: production exige las variables de las demás capas.</summary>
    private static string OnlyTelemetry()
    {
        var root = Directory.CreateTempSubdirectory("keel-telemetry-").FullName;
        var source = Path.Combine(AppContext.BaseDirectory, "config");
        var files = new[] { "local", "develop", "production", "test" }.Select(profile => Path.Combine("parameters", profile, "telemetry.yaml")).Prepend("application.yaml");
        foreach (var relative in files)
        {
            var target = Path.Combine(root, "config", relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(Path.Combine(source, relative), target);
        }
        return root;
    }

    private sealed class PruebaRechazo() : DomainException("rechazo de prueba");${messaging ? ENVELOPE_TESTS : ''}
}`;
}

const ENVELOPE_TESTS = String.raw`

    [Fact]
    public async Task LaEnvolturaDeUnEventoLlevaElTraceparentDelSpanEnCursoYElConsumoLoContinua()
    {
        var telemetry = Started();
        string? stamped = null;
        string? spanId = null;
        await telemetry.Observe(Probe, new ObserveOptions { Name = "PruebaEnvoltura" }, () =>
        {
            stamped = EventEnvelope.Of(EventMetadata.Now("PruebaEvento"), 1, null).Metadata.Traceparent;
            spanId = Activity.Current?.SpanId.ToHexString();
            return Task.CompletedTask;
        });
        Assert.NotNull(stamped);
        Assert.Contains(spanId!, stamped, StringComparison.Ordinal);
        ActivityContext? consumed = null;
        var metadata = EventMetadata.Now("PruebaEvento").WithContext(null, stamped);
        await InboundContext.Run(metadata, () =>
        {
            consumed = Activity.Current?.Context;
            return Task.CompletedTask;
        });
        Assert.Equal(ActivityContext.Parse(stamped, null).TraceId, consumed?.TraceId);
        var span = Finished(consumed!.Value.SpanId);
        Assert.Equal(ActivityKind.Consumer, span.Kind);
        Assert.Equal("PruebaEvento consume", span.DisplayName);
    }

    [Fact]
    public void FueraDeUnSpanDelServicioLaEnvolturaNoInventaTraza()
    {
        Started();
        using var foreign = new Activity("ajena").Start();
        Assert.Null(EventEnvelope.Of(EventMetadata.Now("PruebaEvento"), 1, null).Metadata.Traceparent);
    }`;
