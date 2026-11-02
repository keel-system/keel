// La telemetría del servicio generado (`telemetry: otel`, incremento 14c): `internal/platform/telemetry`.
//
// El patrón de los otros tres: el servidor solo conoce el endpoint de UN colector (`OTEL_EXPORTER_OTLP_ENDPOINT`) y le manda
// trazas (y, con `LOG_EXPORT_OTLP`, logs) por OTLP/HTTP; las métricas no salen, las viene a buscar el colector a
// `/actuator/prometheus`, que es lo que conserva los EXEMPLARS. Cambiar de backend es cambiar el colector.
//
// La regla de equivalencia manda en los NOMBRES: observaciones, atributos, desenlaces y series salen de
// `keel-core/gen/telemetry-vocabulary.js`, así que el mismo panel y las mismas alertas tienen datos con los cuatro servidores.
//
//   · Trazas: el SDK de OpenTelemetry, con los spans abiertos por el código generado donde ya es dueño del punto de paso. Sin
//     el proveedor global ni el propagador global (§ 3.4: sin estado global mutable): `run` construye un *Telemetry y se lo
//     da a quien observa. El span viaja en el context.Context, así que un span cuelga del que tiene delante y de ningún
//     otro: aquí no existe la trampa del Activity de ASP.NET Core.
//   · Métricas: client_golang en un registro propio, con los nombres de `promMetric` y exemplars `trace_id`/`span_id` en
//     OpenMetrics. promhttp solo escribe OpenMetrics si lo piden en Accept, y los otros tres lo sirven siempre: el scrape
//     lo pide por quien llega.
//   · La métrica no puede romper la operación: GetMetricWith y no With, que entra en pánico con otras etiquetas.
//   · La aplicación no ve la plataforma: se observa por su puerto (`application.Observer`), que este tipo cumple.
//   · Los spans de los drivers (SQL, Mongo, Redis) son otro tramo: `telemetry-store-spans` de la matriz.

import { collectorHostEndpoint } from '@keel-system/keel-core/gen/infra-catalog';
import { telemetryYaml as neutralTelemetryYaml } from '@keel-system/keel-core/gen/telemetry-config';
import { ATTRIBUTES, METRICS_TRANSPORT, OBSERVATIONS, OUTBOX_DEAD_LETTERED, instrumentationFor, usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { usesCorrelation } from './correlation.js';
import { layout, packageFile } from './render.js';

export { usesTelemetry };

const PROFILES = ['local', 'develop', 'production', 'test'];

/**
 * Las series del RUNTIME de Go, que consultan la fila de runtime del panel y su alerta de heap, con nombres propios como
 * keel-nest y keel-dotnet:
 *
 *   · el heap en uso contra su LÍMITE (GOMEMLIMIT, o el del contenedor por cgroup v2; sin ninguno, el MaxInt64 con que Go dice
 *     «sin límite», y la alerta del 90 % no dispara), no contra lo que el runtime pidió al sistema, que crece a demanda;
 *   · el tiempo total en pausas de GC, como contador (el panel mira su ritmo);
 *   · las goroutines: el síntoma propio de Go, el de una que no termina;
 *   · el pool de database/sql (`sql.DBStats`). DBStats no da las peticiones esperando AHORA sino las acumuladas: la serie de
 *     saturación es cuántas esperaron desde el scrape anterior, que en reposo es 0 igual, y solo se mueve bajo presión.
 */
export const GO_RUNTIME = {
  heapUsed: 'keel_runtime_heap_used_bytes',
  heapLimit: 'keel_runtime_heap_limit_bytes',
  gcSeconds: 'keel_runtime_gc_pause_seconds_total',
  goroutines: 'keel_runtime_goroutines',
  pool: {
    active: 'keel_db_pool_active',
    idle: 'keel_db_pool_idle',
    max: 'keel_db_pool_max',
    saturation: 'keel_db_pool_pending'
  }
};

/** Los cubos de los histogramas de duración, en segundos: de 1 ms a 30 s, los de keel-nest y keel-dotnet. */
export const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** El `telemetry.yaml` de un perfil: el neutral de keel-core. */
export function telemetryYaml(model, profile) {
  return neutralTelemetryYaml(model, profile, { generator: 'keel-go' });
}

/** El nombre Go de una entrada del vocabulario: `outboxPublish` → `OutboxPublish`, `correlationId` → `CorrelationID`. */
const exported = (key) => key[0].toUpperCase() + key.slice(1).replace(/Id$/, 'ID');

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  const { telemetry } = layout(model);
  const file = (name, imports, body, doc = null) => ({ path: `${telemetry.dir}/${name}.go`, content: packageFile(model, telemetry, { doc, imports, body }) });
  const correlation = usesCorrelation(model) ? ['internal/platform/correlation'] : [];
  return [
    file(
      'telemetry',
      [
        'cmp',
        'context',
        'errors',
        'fmt',
        'log/slog',
        'maps',
        'regexp',
        'slices',
        'sync',
        'time',
        'github.com/prometheus/client_golang/prometheus',
        'go.opentelemetry.io/contrib/bridges/otelslog',
        'go.opentelemetry.io/contrib/propagators/b3',
        'go.opentelemetry.io/otel/attribute',
        'go.opentelemetry.io/otel/codes',
        'go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp',
        'go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp',
        'go.opentelemetry.io/otel/propagation',
        { path: 'go.opentelemetry.io/otel/sdk/log', name: 'sdklog' },
        'go.opentelemetry.io/otel/sdk/resource',
        { path: 'go.opentelemetry.io/otel/sdk/trace', name: 'sdktrace' },
        'go.opentelemetry.io/otel/trace',
        ...correlation
      ],
      telemetryBody(model),
      'Package telemetry es la telemetría del servicio: las trazas y los logs por OTLP a un colector, las métricas por scrape\ny las observaciones con que el código generado abre sus spans y mide sus series. Los nombres son los de los otros\nservidores del mismo diseño: el mismo panel y las mismas alertas tienen datos con cualquiera de ellos.'
    ),
    file('settings', ['fmt', 'strconv', 'strings', 'internal/platform/config'], settingsBody(model)),
    file(
      'http',
      ['context', 'net/http', 'strconv', 'time', 'github.com/prometheus/client_golang/prometheus', 'github.com/prometheus/client_golang/prometheus/promhttp', 'go.opentelemetry.io/otel/attribute', 'go.opentelemetry.io/otel/codes', 'go.opentelemetry.io/otel/propagation', 'go.opentelemetry.io/otel/trace', ...correlation],
      httpBody(model)
    ),
    file(
      'runtime',
      ['math', 'os', 'runtime', 'runtime/debug', 'strconv', 'strings', ...(usesRelational(model) ? ['database/sql', 'sync'] : []), 'github.com/prometheus/client_golang/prometheus'],
      runtimeBody(model)
    ),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/telemetry.yaml`, content: telemetryYaml(model, profile) }))
  ];
}

// ─── El arranque ─────────────────────────────────────────────────────────────────────────────────

/** Antes del logger: la exportación de los logs le da sus handlers. */
export const TELEMETRY_START = `	telemetrySettings, err := telemetry.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la telemetría: %w", err)
	}
	observability, err := telemetry.New(ctx, telemetrySettings)
	if err != nil {
		return err
	}
`;

/** Después del logger, que cuenta si el vaciado falla. Lo último en ejecutarse: las últimas trazas salen al final. */
export const TELEMETRY_FLUSH = `	defer func() {
		// El plazo del vaciado no hereda la cancelación que lo disparó.
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := observability.Shutdown(flushCtx); err != nil {
			logger.WarnContext(flushCtx, "vaciar la telemetría", "error", err)
		}
	}()
`;

/** En production, el puerto de gestión: se escucha antes de crear el errgroup, y un puerto ocupado no deja arrancar. */
export const MANAGEMENT_LISTEN = `
	var management *http.Server
	var managementListener net.Listener
	if observability.ServesManagementPort() {
		management = httpapi.NewServer(config.Server{Port: telemetrySettings.ManagementPort, Address: cfg.Server.Address}, observability.ScrapeHandler())
		if managementListener, err = (&net.ListenConfig{}).Listen(ctx, "tcp", management.Addr); err != nil {
			return fmt.Errorf("escuchar en %s: %w", management.Addr, err)
		}
		logger.InfoContext(ctx, "puerto de gestión escuchando", "address", managementListener.Addr().String())
	}
`;

export const MANAGEMENT_SERVER = `
	if management != nil {
		group.Go(func() error {
			if err := management.Serve(managementListener); !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("servir el puerto de gestión: %w", err)
			}
			return nil
		})
	}`;

export const MANAGEMENT_SHUTDOWN = `
		if management != nil {
			if err := management.Shutdown(shutdownCtx); err != nil {
				return fmt.Errorf("apagar el puerto de gestión: %w", err)
			}
		}`;

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

function settingsBody(model) {
  const switches = instrumentationFor(model);
  const list = switches.map((entry) => goString(entry.id)).join(', ');
  return `
// Settings es la telemetría del perfil activo (telemetry.yaml): las mismas claves y variables que los otros servidores.
type Settings struct {
	// ServiceName es el service.name de cada señal.
	ServiceName string
	// ServiceVersion es el service.version de cada señal.
	ServiceVersion string
	// Environment es el deployment.environment de cada señal.
	Environment string
	// InstanceID es la réplica que emite la señal; vacío, una sola.
	InstanceID string
	// SamplingProbability es la proporción de raíces que se muestrean: se respeta lo que decide quien llama.
	SamplingProbability float64
	// ExportEnabled dice si las trazas salen al colector. Apagado, siguen existiendo: dan sus ids a los logs y a los exemplars.
	ExportEnabled bool
	// Endpoint es la dirección del colector, sin barra final.
	Endpoint string
	// LogsExportEnabled dice si los logs salen también por OTLP: su canal primario es la consola.
	LogsExportEnabled bool
	// PrometheusEnabled dice si se sirve el scrape.
	PrometheusEnabled bool
	// ManagementPort es el puerto del scrape; 0, el principal.
	ManagementPort int
	// Instrumentation son los interruptores de la instrumentación opcional, por subsistema.
	Instrumentation map[string]bool
}

// Instrumented dice si está encendida la instrumentación opcional de id (cache, storage, mail).
func (s Settings) Instrumented(id string) bool {
	return s.Instrumentation[id]
}

// instrumented son los subsistemas de este diseño con interruptor.
var instrumented = []string{${list}}

// SettingsFrom lee la telemetría de la configuración del perfil. Una proporción fuera de [0, 1] no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
	flag := func(key string, fallback bool) bool {
		value := text(key, "")
		if value == "" {
			return fallback
		}
		return strings.EqualFold(value, "true")
	}
	sampling := text("telemetry.tracing.sampling-probability", "1.0")
	probability, err := strconv.ParseFloat(sampling, 64)
	if err != nil || probability < 0 || probability > 1 {
		return Settings{}, fmt.Errorf("telemetry.tracing.sampling-probability inválido: %q (entre 0 y 1)", sampling)
	}
	settings := Settings{
		ServiceName:         cfg.ApplicationName,
		ServiceVersion:      text("telemetry.resource.service-version", "unknown"),
		Environment:         text("telemetry.resource.deployment-environment", strings.Join(cfg.Profiles, ",")),
		InstanceID:          text("telemetry.resource.service-instance-id", ""),
		SamplingProbability: probability,
		ExportEnabled:       flag("telemetry.export.enabled", false),
		Endpoint:            strings.TrimRight(text("telemetry.export.endpoint", ${goString(collectorHostEndpoint())}), "/"),
		LogsExportEnabled:   flag("telemetry.logs.export-enabled", false),
		PrometheusEnabled:   flag("telemetry.metrics.prometheus-enabled", true),
		Instrumentation:     make(map[string]bool, len(instrumented)),
	}
	if port := text("management.server.port", ""); port != "" {
		if settings.ManagementPort, err = config.ToPort(port); err != nil {
			return Settings{}, fmt.Errorf("management.server.port: %w", err)
		}
	}
	for _, id := range instrumented {
		settings.Instrumentation[id] = flag("keel.telemetry.instrumentation."+id+".enabled", true)
	}
	return settings, nil
}
`;
}

// ─── telemetry.go ────────────────────────────────────────────────────────────────────────────────

function telemetryBody(model) {
  const constants = (entries) =>
    Object.entries(entries)
      .flatMap(([key, value]) => [`	// ${exported(key)} es ${value}.`, `	${exported(key)} = ${goString(value)}`])
      .join('\n');
  const correlated = usesCorrelation(model);
  const buckets = DURATION_BUCKETS.join(', ');
  return `
// Las observaciones propias: el vocabulario neutral de keel-core. Son también el nombre de sus series.
const (
${constants(OBSERVATIONS)}
	// OutboxDeadLettered es el gauge de los eventos del outbox que agotaron sus reintentos: no se publicarán nunca.
	OutboxDeadLettered = ${goString(OUTBOX_DEAD_LETTERED)}
)

// Los atributos que estampa el código generado. Attr${exported('correlationId')} va solo al span, nunca a una etiqueta de métrica.
const (
${Object.entries(ATTRIBUTES)
  .flatMap(([key, value]) => [`	// Attr${exported(key)} es ${value}.`, `	Attr${exported(key)} = ${goString(value)}`])
  .join('\n')}
)

// Los desenlaces de ${ATTRIBUTES.outcome}.
const (
	outcomeOK       = "ok"
	outcomeRejected = "rejected"
	outcomeError    = "error"
)

// ScrapePath es la ruta del scrape: la misma que en los otros servidores, para que el colector no dependa de quién la sirve.
const ScrapePath = ${goString(METRICS_TRANSPORT.scrapePath)}

// tracerName es el origen de todos los spans del servicio.
const tracerName = "keel"

// durationBuckets son los cubos de los histogramas de duración, en segundos.
var durationBuckets = []float64{${buckets}}

// Telemetry es la telemetría del proceso: el proveedor de trazas, el registro de métricas y las observaciones. La construye
// run y se la da a quien observa; no hay estado global. Es segura para usarse a la vez. Sus métodos de observación aceptan
// un *Telemetry nil, que no observa nada: las pruebas de lo que observa no tienen que construirla.
type Telemetry struct {
	settings Settings
	tracer   trace.Tracer
	traces   *sdktrace.TracerProvider
	logs     *sdklog.LoggerProvider
	registry *prometheus.Registry
	w3c      propagation.TextMapPropagator
	b3       propagation.TextMapPropagator

	cacheGets *prometheus.CounterVec

	mu sync.Mutex
	// histograms son los de cada observación, con las etiquetas con que nacieron: las de una serie no cambian después.
	histograms map[string]*histogram
}

// histogram es un histograma con sus etiquetas.
type histogram struct {
	vec    *prometheus.HistogramVec
	labels []string
}

// Option configura New.
type Option func(*[]sdktrace.TracerProviderOption)

// WithSpanProcessor añade un procesador de spans (un grabador, en una prueba).
func WithSpanProcessor(processor sdktrace.SpanProcessor) Option {
	return func(options *[]sdktrace.TracerProviderOption) {
		*options = append(*options, sdktrace.WithSpanProcessor(processor))
	}
}

// New arranca la telemetría. Los exportadores no conectan al crearse: un colector caído no impide arrancar.
func New(ctx context.Context, settings Settings, options ...Option) (*Telemetry, error) {
	attributes := []attribute.KeyValue{
		attribute.String("service.name", settings.ServiceName),
		attribute.String("service.version", settings.ServiceVersion),
		attribute.String("deployment.environment", settings.Environment),
	}
	if settings.InstanceID != "" {
		attributes = append(attributes, attribute.String("service.instance.id", settings.InstanceID))
	}
	serviceResource := resource.NewSchemaless(attributes...)
	// Parent-based: se respeta la decisión de quien llama; la proporción solo decide en las raíces.
	providerOptions := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(serviceResource),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(settings.SamplingProbability))),
	}
	for _, option := range options {
		option(&providerOptions)
	}
	if settings.ExportEnabled {
		exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(settings.Endpoint+"/v1/traces"))
		if err != nil {
			return nil, fmt.Errorf("exportador de trazas: %w", err)
		}
		providerOptions = append(providerOptions, sdktrace.WithBatcher(exporter))
	}
	traces := sdktrace.NewTracerProvider(providerOptions...)
	t := &Telemetry{
		settings:   settings,
		tracer:     traces.Tracer(tracerName),
		traces:     traces,
		registry:   prometheus.NewRegistry(),
		w3c:        propagation.TraceContext{},
		b3:         b3.New(),
		histograms: map[string]*histogram{},
	}
	// Apagado por defecto: el canal primario de los logs es la consola, y encenderlo además de recogerla duplica cada línea.
	if settings.ExportEnabled && settings.LogsExportEnabled {
		exporter, err := otlploghttp.New(ctx, otlploghttp.WithEndpointURL(settings.Endpoint+"/v1/logs"))
		if err != nil {
			return nil, fmt.Errorf("exportador de logs: %w", err)
		}
		t.logs = sdklog.NewLoggerProvider(sdklog.WithResource(serviceResource), sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
	}
	t.cacheGets = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "cache_gets_total", Help: "Lecturas de las cachés de lectura"}, []string{"cache", "result"})
	t.register(t.cacheGets)
	t.registerRuntime()
	return t, nil
}

// register añade una serie al registro. La misma serie dos veces no es un fallo del servicio: sigue la primera.
func (t *Telemetry) register(collector prometheus.Collector) {
	if err := t.registry.Register(collector); err != nil {
		var already prometheus.AlreadyRegisteredError
		if !errors.As(err, &already) {
			slog.Default().Warn("registrar una serie", "error", err)
		}
	}
}

// LogHandlers son los handlers con que el logger exporta por OTLP: ninguno, salvo con LOG_EXPORT_OTLP.
func (t *Telemetry) LogHandlers() []slog.Handler {
	if t.logs == nil {
		return nil
	}
	return []slog.Handler{otelslog.NewHandler(tracerName, otelslog.WithLoggerProvider(t.logs))}
}

// Settings es la telemetría del perfil.
func (t *Telemetry) Settings() Settings {
	return t.settings
}

// Instrumented dice si está encendida la instrumentación opcional de id; nil, ninguna.
func (t *Telemetry) Instrumented(id string) bool {
	return t != nil && t.settings.Instrumented(id)
}

// Shutdown exporta lo que queda en cola y para los exportadores.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	err := t.traces.Shutdown(ctx)
	if t.logs != nil {
		err = errors.Join(err, t.logs.Shutdown(ctx))
	}
	return err
}

// Options es cómo se observa una acción.
type Options struct {
	// Name es el nombre del span (la operación concreta); vacío, el de la observación.
	Name string
	// Kind es la clase del span; por defecto, interno.
	Kind trace.SpanKind
	// Labels son atributos de BAJA cardinalidad: van al span y, manglados, a la métrica.
	Labels map[string]string
	// Attributes son atributos de ALTA cardinalidad: solo al span.
	Attributes map[string]string
	// Rejected dice qué error es un desenlace esperado: rejected, sin marcar el span como error.
	Rejected func(error) bool
	// NewRoot pide una traza nueva si el contexto no trae padre remoto: el relay y el consumo no corren dentro de ninguna petición.
	NewRoot bool
}

// Observe ejecuta action dentro de un span de la observación y registra su duración en su histograma, con el desenlace y,
// si la traza se muestrea, el exemplar que enlaza el punto con ella. Un pánico cuenta como error y sigue su camino.
func (t *Telemetry) Observe(ctx context.Context, observation string, options Options, action func(ctx context.Context) error) error {
	if t == nil {
		return action(ctx)
	}
	started := time.Now()
	start := []trace.SpanStartOption{trace.WithSpanKind(options.Kind)}
	if options.NewRoot && !trace.SpanContextFromContext(ctx).IsRemote() {
		start = append(start, trace.WithNewRoot())
	}
	ctx, span := t.tracer.Start(ctx, cmp.Or(options.Name, observation), start...)
	for key, value := range options.Labels {
		span.SetAttributes(attribute.String(key, value))
	}
	for key, value := range options.Attributes {
		span.SetAttributes(attribute.String(key, value))
	}
	outcome := outcomeError
	defer func() {
		span.SetAttributes(attribute.String(AttrOutcome, outcome))
		span.End()
		values := make(prometheus.Labels, len(options.Labels)+1)
		for key, value := range options.Labels {
			values[Mangle(key)] = value
		}
		values[Mangle(AttrOutcome)] = outcome
		t.observe(observation, values, time.Since(started).Seconds(), span.SpanContext())
	}()
	err := action(ctx)
	switch {
	case err == nil:
		outcome = outcomeOK
	case options.Rejected != nil && options.Rejected(err):
		// Un rechazo del dominio NO es un error del span: es un desenlace esperado (un 4xx).
		outcome = outcomeRejected
	default:
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	return err
}

// ObserveUseCase es application.Observer: el caso de uso en un span de ${OBSERVATIONS.useCase}, con la operación y el desenlace.
func (t *Telemetry) ObserveUseCase(ctx context.Context, operation string, rejected func(error) bool, run func(ctx context.Context) error) error {
	options := Options{Name: operation, Labels: map[string]string{AttrOperation: operation}, Rejected: rejected}
${correlated ? `	if id, ok := correlation.ID(ctx); ok {
		options.Attributes = map[string]string{AttrCorrelationID: id}
	}
` : ''}	return t.Observe(ctx, UseCase, options, run)
}

// Publishing es la publicación de un evento desde el outbox: un span PRODUCER que continúa la traza que lo originó (la que
// quedó en la envoltura de la fila, porque el relay publica en otro instante y sin el contexto de la petición).
func (t *Telemetry) Publishing(ctx context.Context, eventType string, traceparent *string, action func(ctx context.Context) error) error {
	if t == nil {
		return action(ctx)
	}
	return t.Observe(t.continuing(ctx, traceparent), OutboxPublish, eventOptions(eventType+" publish", trace.SpanKindProducer, eventType), action)
}

// Consuming es el consumo de un evento: un span CONSUMER que continúa la traza del emisor (metadata.traceparent).
func (t *Telemetry) Consuming(ctx context.Context, eventType string, traceparent *string, action func(ctx context.Context) error) error {
	if t == nil {
		return action(ctx)
	}
	return t.Observe(t.continuing(ctx, traceparent), MessageConsume, eventOptions(eventType+" consume", trace.SpanKindConsumer, eventType), action)
}

func eventOptions(name string, kind trace.SpanKind, eventType string) Options {
	return Options{Name: name, Kind: kind, Labels: map[string]string{AttrEventType: eventType}, NewRoot: true}
}

// continuing es ctx con el padre remoto de un traceparent recibido, si trae uno válido.
func (t *Telemetry) continuing(ctx context.Context, traceparent *string) context.Context {
	if traceparent == nil {
		return ctx
	}
	return t.w3c.Extract(ctx, propagation.MapCarrier{"traceparent": *traceparent})
}

// Traceparent es el traceparent W3C del span de ctx, para estamparlo en la envoltura de un evento; nil si no hay span.
func Traceparent(ctx context.Context) *string {
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	value, ok := carrier["traceparent"]
	if !ok {
		return nil
	}
	return &value
}

// CacheGet cuenta una lectura de una caché: cache_gets_total{cache,result}, la serie del ratio de acierto del panel.
func (t *Telemetry) CacheGet(cache string, hit bool) {
	result := "miss"
	if hit {
		result = "hit"
	}
	t.cacheGets.WithLabelValues(cache, result).Inc()
}

// observe añade un punto al histograma de la observación. Los valores se ALINEAN con las etiquetas con que nació la serie
// (lo que falte va como none, lo que sobre no entra): la métrica no puede romper la operación que mide.
func (t *Telemetry) observe(observation string, values prometheus.Labels, seconds float64, span trace.SpanContext) {
	series := t.histogramOf(observation, slices.Sorted(maps.Keys(values)))
	aligned := make(prometheus.Labels, len(series.labels))
	for _, name := range series.labels {
		aligned[name] = cmp.Or(values[name], "none")
	}
	metric, err := series.vec.GetMetricWith(aligned)
	if err != nil {
		slog.Default().Warn("medir una observación", "observation", observation, "error", err)
		return
	}
	// Un id de una traza que no se exportó no lleva a nada: sin muestrear, sin exemplar.
	if exemplars, ok := metric.(prometheus.ExemplarObserver); ok && span.IsSampled() {
		exemplars.ObserveWithExemplar(seconds, prometheus.Labels{"trace_id": span.TraceID().String(), "span_id": span.SpanID().String()})
		return
	}
	metric.Observe(seconds)
}

// histogramOf es el histograma de una observación, con el nombre de serie de los otros servidores (<observación>_seconds).
func (t *Telemetry) histogramOf(observation string, labels []string) *histogram {
	t.mu.Lock()
	defer t.mu.Unlock()
	if series, ok := t.histograms[observation]; ok {
		return series
	}
	vec := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: Mangle(observation) + "_seconds", Help: observation, Buckets: durationBuckets}, labels)
	t.register(vec)
	series := &histogram{vec: vec, labels: labels}
	t.histograms[observation] = series
	return series
}

var notAlphanumeric = regexp.MustCompile("[^a-zA-Z0-9]+")

// Mangle es el nombre de una serie o una etiqueta: lo que no es alfanumérico, a _ (promMetric de keel-core).
func Mangle(name string) string {
	return notAlphanumeric.ReplaceAllString(name, "_")
}
`;
}

// ─── http.go ─────────────────────────────────────────────────────────────────────────────────────

function httpBody(model) {
  const correlationOf = usesCorrelation(model)
    ? `			if id := recorder.Header().Get(correlation.Header); id != "" && span != nil {
				span.SetAttributes(attribute.String(AttrCorrelationID, id))
			}
`
    : '';
  return `
// serverRequests y clientRequests son las observaciones HTTP, con los nombres y las etiquetas de keel-spring.
const (
	serverRequests = "http.server.requests"
	clientRequests = "http.client.requests"
)

// scrapeAccept es el formato que se le pide a promhttp: OpenMetrics, el único que lleva los exemplars. promhttp solo lo
// escribe si llega en Accept, y los otros servidores lo sirven siempre.
const scrapeAccept = "application/openmetrics-text; version=1.0.0"

// ScrapeHandler sirve las métricas del servicio.
func (t *Telemetry) ScrapeHandler() http.Handler {
	inner := promhttp.HandlerFor(t.registry, promhttp.HandlerOpts{EnableOpenMetrics: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.Clone(r.Context())
		r.Header.Set("Accept", scrapeAccept)
		inner.ServeHTTP(w, r)
	})
}

// ServesManagementPort dice si el scrape va en su puerto de gestión (production), que no se publica fuera del pod.
func (t *Telemetry) ServesManagementPort() bool {
	return t.settings.PrometheusEnabled && t.settings.ManagementPort != 0
}

// technical dice si una ruta es técnica: no abre traza (las sondas se piden cada pocos segundos), pero cuenta en la métrica.
func technical(path string) bool {
	return path == "/livez" || path == "/readyz" || path == ScrapePath
}

// Instrument observa la entrada HTTP: un span SERVER por petición, que continúa la traza de quien llama, y
// http_server_requests_seconds con la plantilla de la ruta que da route. Va la PRIMERA, antes que la correlación y la
// seguridad: fuera de production sirve también el scrape, que no lleva token. nil, next tal cual.
func (t *Telemetry) Instrument(next http.Handler, route func(*http.Request) string) http.Handler {
	if t == nil {
		return next
	}
	scrape := t.ScrapeHandler()
	servesScrape := t.settings.PrometheusEnabled && t.settings.ManagementPort == 0
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		target, template := next, route(r)
		if servesScrape && r.URL.Path == ScrapePath {
			target, template = scrape, ScrapePath
		}
		var span trace.Span
		if !technical(r.URL.Path) {
			ctx := t.extract(r.Context(), r.Header)
			ctx, span = t.tracer.Start(ctx, r.Method+" "+r.URL.Path, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attribute.String("http.request.method", r.Method), attribute.String("url.path", r.URL.Path)))
			r = r.WithContext(ctx)
		}
		recorder := &statusRecorder{ResponseWriter: w}
		finished := false
		defer func() {
${correlationOf}			t.finishServer(span, started, r.Method, template, recorder.statusCode(finished))
		}()
		target.ServeHTTP(recorder, r)
		finished = true
	})
}

// extract es el contexto de traza de las cabeceras de una petición: W3C, o B3 (una y varias cabeceras) si no hay W3C. Una
// malla de servicio o un sistema de la familia Zipkin no corta la traza al llegar aquí; la salida es siempre W3C.
func (t *Telemetry) extract(ctx context.Context, header http.Header) context.Context {
	carrier := propagation.HeaderCarrier(header)
	if extracted := t.w3c.Extract(ctx, carrier); trace.SpanContextFromContext(extracted).IsValid() {
		return extracted
	}
	return t.b3.Extract(ctx, carrier)
}

// finishServer cierra el span de la entrada y la mide con las etiquetas de keel-spring: la plantilla de la ruta, NOT_FOUND
// si ninguna casó con un 404, UNKNOWN si no.
func (t *Telemetry) finishServer(span trace.Span, started time.Time, method, template string, status int) {
	uri := template
	if uri == "" {
		uri = "UNKNOWN"
		if status == http.StatusNotFound {
			uri = "NOT_FOUND"
		}
	}
	text := strconv.Itoa(status)
	var traced trace.SpanContext
	if span != nil {
		span.SetName(method + " " + uri)
		span.SetAttributes(attribute.String("http.route", uri), attribute.Int("http.response.status_code", status))
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, text)
		}
		span.End()
		traced = span.SpanContext()
	}
	t.observe(serverRequests, prometheus.Labels{"method": method, "uri": uri, "status": text, "outcome": outcomeOf(status), "exception": "none"}, time.Since(started).Seconds(), traced)
}

// statusRecorder recuerda el status de la respuesta.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

// WriteHeader recuerda el primer status.
func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

// Write empieza la respuesta con un 200, si no había empezado.
func (s *statusRecorder) Write(data []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(data)
}

// Unwrap da el ResponseWriter de debajo a http.ResponseController.
func (s *statusRecorder) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

// statusCode es el status de la respuesta: sin escribir, un 200 si el handler terminó y un 500 si salió con un pánico.
func (s *statusRecorder) statusCode(finished bool) int {
	switch {
	case s.status != 0:
		return s.status
	case finished:
		return http.StatusOK
	}
	return http.StatusInternalServerError
}

// Client abre el span CLIENT de una llamada saliente y escribe su traza en header ANTES de llamar. Lo que devuelve lo cierra
// con el status de la respuesta (0, sin respuesta) y la mide en http_client_requests_seconds con la plantilla de la ruta,
// nunca la URL con sus valores. Sin respuesta o sin un 2xx, el span va como error. nil, no observa.
func (t *Telemetry) Client(ctx context.Context, client, method, template string, header http.Header) (context.Context, func(status int)) {
	if t == nil {
		return ctx, func(int) {}
	}
	started := time.Now()
	ctx, span := t.tracer.Start(ctx, method+" "+template, trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attribute.String("http.request.method", method), attribute.String("url.template", template), attribute.String("keel.client", client)))
	header.Del("traceparent")
	header.Del("tracestate")
	t.w3c.Inject(ctx, propagation.HeaderCarrier(header))
	return ctx, func(status int) {
		text, outcome := "IO_ERROR", "UNKNOWN"
		if status != 0 {
			text, outcome = strconv.Itoa(status), outcomeOf(status)
		}
		span.SetAttributes(attribute.String("http.response.status_code", text))
		if status < http.StatusOK || status >= http.StatusMultipleChoices {
			span.SetStatus(codes.Error, text)
		}
		span.End()
		t.observe(clientRequests, prometheus.Labels{"method": method, "uri": template, "status": text, "client_name": client, "outcome": outcome}, time.Since(started).Seconds(), span.SpanContext())
	}
}

// outcomeOf es el desenlace de una respuesta HTTP, con los valores de keel-spring.
func outcomeOf(status int) string {
	switch {
	case status < 200:
		return "INFORMATIONAL"
	case status < 300:
		return "SUCCESS"
	case status < 400:
		return "REDIRECTION"
	case status < 500:
		return "CLIENT_ERROR"
	case status < 600:
		return "SERVER_ERROR"
	}
	return "UNKNOWN"
}
`;
}

// ─── runtime.go ──────────────────────────────────────────────────────────────────────────────────

function runtimeBody(model) {
  const pool = usesRelational(model)
    ? `
// RegisterPool publica el pool de database/sql: en uso, libres, máximo y, como saturación, cuántas peticiones esperaron una
// conexión desde el scrape anterior (DBStats solo las da acumuladas). Una vez por pool.
func (t *Telemetry) RegisterPool(stats func() sql.DBStats) {
	t.gauge(${goString(GO_RUNTIME.pool.active)}, "Conexiones del pool en uso", func() float64 { return float64(stats().InUse) })
	t.gauge(${goString(GO_RUNTIME.pool.idle)}, "Conexiones del pool libres", func() float64 { return float64(stats().Idle) })
	t.gauge(${goString(GO_RUNTIME.pool.max)}, "Tamaño máximo del pool", func() float64 { return float64(stats().MaxOpenConnections) })
	var mu sync.Mutex
	var seen int64
	t.gauge(${goString(GO_RUNTIME.pool.saturation)}, "Peticiones que esperaron una conexión del pool desde el scrape anterior", func() float64 {
		mu.Lock()
		defer mu.Unlock()
		waited := stats().WaitCount
		pending := waited - seen
		seen = waited
		return float64(pending)
	})
}
`
    : '';
  return `
// registerRuntime publica las series del runtime de Go, leídas en cada scrape.
func (t *Telemetry) registerRuntime() {
	memory := func() runtime.MemStats {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		return stats
	}
	t.gauge(${goString(GO_RUNTIME.heapUsed)}, "Heap en uso", func() float64 { return float64(memory().HeapAlloc) })
	t.gauge(${goString(GO_RUNTIME.heapLimit)}, "Memoria que el proceso puede usar: GOMEMLIMIT o el límite del contenedor", memoryLimit)
	t.register(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: ${goString(GO_RUNTIME.gcSeconds)}, Help: "Tiempo total en pausas de GC"}, func() float64 {
		return float64(memory().PauseTotalNs) / 1e9
	}))
	t.gauge(${goString(GO_RUNTIME.goroutines)}, "Goroutines en marcha", func() float64 { return float64(runtime.NumGoroutine()) })
}

// memoryLimit es el límite de memoria del proceso: el menor de GOMEMLIMIT y el del contenedor (cgroup v2). Sin ninguno, el
// MaxInt64 con que Go dice «sin límite»: contra él la alerta del 90 % no dispara, y contra lo que el runtime pidió al sistema,
// que crece a demanda, dispararía en un servicio sano.
func memoryLimit() float64 {
	limit := debug.SetMemoryLimit(-1)
	if text, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		if value, err := strconv.ParseInt(strings.TrimSpace(string(text)), 10, 64); err == nil {
			limit = min(limit, value)
		}
	}
	return float64(min(limit, math.MaxInt64))
}

func (t *Telemetry) gauge(name, help string, read func() float64) {
	t.register(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help}, read))
}

// RegisterGauge publica un gauge que se lee en cada scrape (${OUTBOX_DEAD_LETTERED}: los eventos que agotaron sus reintentos).
// Gauge y no contador: un contador se reinicia con el proceso y no vería lo que se rindió antes de arrancar.
func (t *Telemetry) RegisterGauge(name, help string, read func() float64) {
	t.gauge(Mangle(name), help, read)
}
${pool}`;
}

// ─── Los puertos observados: storage y correo ────────────────────────────────────────────────────

/**
 * El correo observado (${OBSERVATIONS.mailSend}). Sin más etiqueta que el desenlace: el destinatario y el asunto son dato. Un
 * decorador del PUERTO: con el interruptor apagado, el adaptador tal cual.
 */
export function observedMailFile(model) {
  if (!usesTelemetry(model)) return [];
  const { mail } = layout(model);
  return [
    {
      path: `${mail.dir}/observed.go`,
      content: packageFile(model, mail, {
        imports: ['context', 'internal/domain', 'internal/platform/telemetry'],
        body: `
// Observed es el puerto de correo observado: cada envío en un span de ${OBSERVATIONS.mailSend} con su timer y el desenlace, y nada
// más. El destinatario y el asunto son dato: un correo identificado por su destinatario en el backend de trazas es una lista
// de direcciones que nadie decidió publicar. Con TELEMETRY_INSTRUMENT_MAIL apagado, sender tal cual.
func Observed(sender domain.MailSender, observability *telemetry.Telemetry) domain.MailSender {
	if !observability.Instrumented("mail") {
		return sender
	}
	return &observedSender{inner: sender, telemetry: observability}
}

type observedSender struct {
	inner     domain.MailSender
	telemetry *telemetry.Telemetry
}

// Send envía el correo dentro de su observación.
func (s *observedSender) Send(ctx context.Context, message domain.MailMessage) error {
	return s.telemetry.Observe(ctx, telemetry.MailSend, telemetry.Options{}, func(ctx context.Context) error {
		return s.inner.Send(ctx, message)
	})
}
`
      })
    }
  ];
}

