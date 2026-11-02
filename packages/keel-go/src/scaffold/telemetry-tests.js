// Las pruebas emitidas de la telemetría (incremento 14c): la telemetría EJECUTADA sin red. El *Telemetry con un grabador de
// spans y el scrape servido de verdad. Lo que dice un colector y un backend DE VERDAD lo mide la red del generador
// (telemetry-check y deploy-check, incremento 14f).

import { usesApi, usesHttpSecurity, usesRelational } from '@keel-system/keel-core/gen/features';
import { goString } from '../lib/go-source.js';
import { consultedSeries } from './observability-assets.js';
import { usesGoMessaging } from './messaging.js';
import { GO_RUNTIME, usesTelemetry } from './telemetry.js';
import { testHandler } from './httpapi.js';
import { layout, packageFile } from './render.js';
import { trafficPath } from '@keel-system/keel-core/gen/deploy-probes';

export function generate(model) {
  if (!usesTelemetry(model)) return [];
  const { telemetry, httpapi, messaging } = layout(model);
  return [
    {
      path: `${telemetry.dir}/telemetry_test.go`,
      content: packageFile(model, telemetry, {
        test: true,
        imports: ['context', 'errors', 'database/sql', 'io', 'math', 'net/http', 'net/http/httptest', 'slices', 'strconv', 'strings', 'testing', 'go.opentelemetry.io/otel/codes', { path: 'go.opentelemetry.io/otel/sdk/trace', name: 'sdktrace' }, 'go.opentelemetry.io/otel/sdk/trace/tracetest', 'go.opentelemetry.io/otel/trace', 'internal/platform/telemetry'],
        body: testBody(model)
      })
    },
    ...(usesApi(model)
      ? [
          {
            path: `${httpapi.dir}/telemetry_test.go`,
            content: packageFile(model, httpapi, {
              test: true,
              imports: ['io', 'log/slog', 'net/http', 'net/http/httptest', 'strings', 'testing', 'go.opentelemetry.io/otel/trace', { path: 'go.opentelemetry.io/otel/sdk/trace', name: 'sdktrace' }, 'go.opentelemetry.io/otel/sdk/trace/tracetest', 'internal/application', 'internal/httpapi', 'internal/platform/health', 'internal/platform/security', 'internal/platform/telemetry'],
              body: httpTestBody(model)
            })
          }
        ]
      : []),
    ...(usesGoMessaging(model)
      ? [
          {
            path: `${messaging.dir}/telemetry_test.go`,
            content: packageFile(model, messaging, {
              test: true,
              imports: ['context', 'strings', 'testing', 'time', 'go.opentelemetry.io/otel/sdk/trace/tracetest', 'go.opentelemetry.io/otel/trace', 'internal/domain', 'internal/infrastructure/messaging', 'internal/platform/telemetry'],
              body: MESSAGING_TEST
            })
          }
        ]
      : [])
  ];
}

// La telemetría del servicio en una prueba, con un grabador de los spans que terminan.
const STARTED = `
// started es una telemetría sin exportar, con un grabador de spans.
func started(t *testing.T) (*telemetry.Telemetry, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	observability, err := telemetry.New(t.Context(), telemetry.Settings{ServiceName: "servicio", SamplingProbability: 1, PrometheusEnabled: true}, telemetry.WithSpanProcessor(recorder))
	if err != nil {
		t.Fatal(err)
	}
	return observability, recorder
}
`;

function scrapeHelper() {
  return `
// scrape es lo que sirve el scrape: OpenMetrics, el único formato que lleva los exemplars.
func scrape(t *testing.T, observability *telemetry.Telemetry) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	observability.ScrapeHandler().ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, telemetry.ScrapePath, nil))
	response := recorder.Result()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/openmetrics-text") {
		t.Fatalf("scrape: %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(body), "# EOF\\n") {
		t.Fatalf("el scrape no termina en # EOF: %s", body)
	}
	return string(body)
}
`;
}

function testBody(model) {
  const pool = usesRelational(model);
  const series = [GO_RUNTIME.heapUsed, GO_RUNTIME.heapLimit, GO_RUNTIME.gcSeconds, GO_RUNTIME.goroutines];
  const consulted = consultedSeries(model).map(goString).join(', ');
  return `
// La telemetría EJECUTADA sin red. Lo que se afirma es lo que hacen los otros servidores: la entrada HTTP continúa la traza de
// quien llama y mide http_server_requests_seconds con la plantilla y el exemplar; el caso de uso separa ok, rejected y error; la
// llamada saliente escribe su traza. Lo que dice un colector de verdad lo mide telemetry-check.
${STARTED}${scrapeHelper()}
var errRejected = errors.New("rechazado")

// server es una entrada HTTP observada, con una ruta fija.
func server(observability *telemetry.Telemetry, status int, template string) http.Handler {
	return observability.Instrument(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	}), func(*http.Request) string { return template })
}

func TestLaEntradaHTTPContinuaLaTrazaDeQuienLlamaYLaMideConElExemplar(t *testing.T) {
	observability, recorder := started(t)
	request := httptest.NewRequestWithContext(t.Context(), "KEELPROBE", "/products/42", nil)
	request.Header.Set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
	server(observability, http.StatusOK, "/products/{id}").ServeHTTP(httptest.NewRecorder(), request)

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("spans = %d, quiero 1", len(spans))
	}
	span := spans[0]
	if span.SpanContext().TraceID().String() != "0af7651916cd43dd8448eb211c80319c" || span.Parent().SpanID().String() != "b7ad6b7169203331" {
		t.Errorf("el span no continúa la traza de quien llama: traza %s, padre %s", span.SpanContext().TraceID(), span.Parent().SpanID())
	}
	if span.SpanKind() != trace.SpanKindServer || span.Name() != "KEELPROBE /products/{id}" {
		t.Errorf("span = %s %q", span.SpanKind(), span.Name())
	}
	var bucket string
	for line := range strings.Lines(scrape(t, observability)) {
		if strings.HasPrefix(line, "http_server_requests_seconds_bucket{") && strings.Contains(line, \`method="KEELPROBE"\`) && strings.Contains(line, "trace_id=") {
			bucket = line
		}
	}
	for _, want := range []string{\`uri="/products/{id}"\`, \`status="200"\`, \`outcome="SUCCESS"\`, \`trace_id="0af7651916cd43dd8448eb211c80319c"\`, \`span_id="\` + span.SpanContext().SpanID().String() + \`"\`} {
		if !strings.Contains(bucket, want) {
			t.Errorf("falta %s en el cubo %q", want, bucket)
		}
	}
}

func TestSinRutaLaPlantillaEsNotFoundOUnknown(t *testing.T) {
	observability, _ := started(t)
	server(observability, http.StatusNotFound, "").ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/a/1", nil))
	server(observability, http.StatusUnauthorized, "").ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/a/2", nil))
	exposition := scrape(t, observability)
	for _, want := range []string{\`uri="NOT_FOUND"\`, \`uri="UNKNOWN"\`} {
		if !strings.Contains(exposition, want) {
			t.Errorf("falta %s", want)
		}
	}
	if strings.Contains(exposition, "/a/1") {
		t.Error("la URL con sus valores salió en una etiqueta")
	}
}

func TestLasSondasNoAbrenTrazaPeroCuentanEnLaMetrica(t *testing.T) {
	observability, recorder := started(t)
	server(observability, http.StatusOK, "/livez").ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/livez", nil))
	if len(recorder.Ended()) != 0 {
		t.Errorf("una sonda abrió %d span(s)", len(recorder.Ended()))
	}
	if !strings.Contains(scrape(t, observability), \`uri="/livez"\`) {
		t.Error("la sonda no cuenta en la métrica")
	}
}

func TestElCasoDeUsoSeparaOkRechazadoYErrorYSoloElErrorMarcaElSpan(t *testing.T) {
	observability, recorder := started(t)
	rejected := func(err error) bool { return errors.Is(err, errRejected) }
	broken := errors.New("roto")
	for operation, result := range map[string]error{"Bien": nil, "Rechazo": errRejected, "Roto": broken} {
		got := observability.ObserveUseCase(t.Context(), operation, rejected, func(context.Context) error { return result })
		if !errors.Is(got, result) {
			t.Errorf("%s: el decorador cambió el error: %v", operation, got)
		}
	}
	// Cada span con su nombre: el desenlace tiene que ser el del error que lo produjo, no solo uno de cada.
	for _, want := range []struct {
		name, outcome string
		status        codes.Code
	}{{"Bien", "ok", codes.Unset}, {"Rechazo", "rejected", codes.Unset}, {"Roto", "error", codes.Error}} {
		index := slices.IndexFunc(recorder.Ended(), func(span sdktrace.ReadOnlySpan) bool { return span.Name() == want.name })
		if index < 0 {
			t.Fatalf("no terminó el span %s", want.name)
		}
		span := recorder.Ended()[index]
		if span.Status().Code != want.status {
			t.Errorf("%s: estado %v, quiero %v", want.name, span.Status().Code, want.status)
		}
		outcome := ""
		for _, attribute := range span.Attributes() {
			if string(attribute.Key) == telemetry.AttrOutcome {
				outcome = attribute.Value.AsString()
			}
		}
		if outcome != want.outcome {
			t.Errorf("%s: desenlace %q, quiero %q", want.name, outcome, want.outcome)
		}
	}
	exposition := scrape(t, observability)
	for operation, outcome := range map[string]string{"Bien": "ok", "Rechazo": "rejected", "Roto": "error"} {
		if want := \`keel_use_case_seconds_count{keel_operation="\` + operation + \`",keel_outcome="\` + outcome + \`"} 1\`; !strings.Contains(exposition, want) {
			t.Errorf("falta %s", want)
		}
	}
}

func TestUnPanicoCuentaComoErrorYSigueSuCamino(t *testing.T) {
	observability, _ := started(t)
	defer func() {
		if recover() == nil {
			t.Error("el pánico no siguió su camino")
		}
		if !strings.Contains(scrape(t, observability), \`keel_operation="Panico",keel_outcome="error"\`) {
			t.Error("el pánico no contó como error")
		}
	}()
	_ = observability.ObserveUseCase(t.Context(), "Panico", nil, func(context.Context) error { panic("defecto") })
}

func TestUnaMetricaConOtrasEtiquetasNoRompeLaOperacion(t *testing.T) {
	observability, _ := started(t)
	for _, labels := range []map[string]string{{"a": "1"}, {"a": "1", "b": "2"}, {"c": "3"}} {
		if err := observability.Observe(t.Context(), "keel.prueba", telemetry.Options{Labels: labels}, func(context.Context) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(scrape(t, observability), \`keel_prueba_seconds_count{a="none",keel_outcome="ok"} 1\`) {
		t.Errorf("lo que falta no se alineó como none: %s", scrape(t, observability))
	}
}

func TestLaLlamadaSalienteEscribeLaTrazaDeSuSpanYMideConLaPlantilla(t *testing.T) {
	observability, recorder := started(t)
	header := http.Header{"Traceparent": {"00-00000000000000000000000000000001-0000000000000001-01"}}
	_, finish := observability.Client(t.Context(), "proveedor", http.MethodGet, "/items/{id}", header)
	finish(0)
	span := recorder.Ended()[0]
	if span.SpanKind() != trace.SpanKindClient || span.Status().Code != codes.Error {
		t.Errorf("span = %s, %v", span.SpanKind(), span.Status().Code)
	}
	if want := "00-" + span.SpanContext().TraceID().String() + "-" + span.SpanContext().SpanID().String() + "-01"; header.Get("traceparent") != want {
		t.Errorf("traceparent = %q, quiero %q", header.Get("traceparent"), want)
	}
	if want := \`http_client_requests_seconds_count{client_name="proveedor",method="GET",outcome="UNKNOWN",status="IO_ERROR",uri="/items/{id}"} 1\`; !strings.Contains(scrape(t, observability), want) {
		t.Errorf("falta %s", want)
	}
}

func TestElPropagadorLeeW3CYTambienB3(t *testing.T) {
	for name, header := range map[string]map[string]string{
		"0af7651916cd43dd8448eb211c80319c": {"traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"},
		"80f198ee56343ba864fe8b2a57d3eff7": {"b3": "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1"},
		"463ac35c9f6413ad48485a3953bb6124": {"X-B3-TraceId": "463ac35c9f6413ad48485a3953bb6124", "X-B3-SpanId": "a2fb4a1d1a96d312", "X-B3-Sampled": "1"},
	} {
		observability, recorder := started(t)
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/x", nil)
		for key, value := range header {
			request.Header.Set(key, value)
		}
		server(observability, http.StatusOK, "/x").ServeHTTP(httptest.NewRecorder(), request)
		if got := recorder.Ended()[0].SpanContext().TraceID().String(); got != name {
			t.Errorf("%v: traza %s, quiero %s", header, got, name)
		}
	}
}

func TestSinMuestrearNoHayExemplar(t *testing.T) {
	observability, err := telemetry.New(t.Context(), telemetry.Settings{ServiceName: "servicio", SamplingProbability: 0, PrometheusEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := observability.ObserveUseCase(t.Context(), "SinMuestrear", nil, func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if exposition := scrape(t, observability); strings.Contains(exposition, "trace_id=") {
		t.Errorf("un exemplar de una traza que no se exporta: %s", exposition)
	}
}

func TestUnGaugeSeLeeEnCadaScrape(t *testing.T) {
	observability, _ := started(t)
	reads := 0.0
	observability.RegisterGauge("keel.prueba.gauge", "prueba", func() float64 {
		reads++
		return reads
	})
	if !strings.Contains(scrape(t, observability), "keel_prueba_gauge 1") || !strings.Contains(scrape(t, observability), "keel_prueba_gauge 2") {
		t.Error("el gauge no se lee en cada scrape")
	}
}

// value es el valor de una serie sin etiquetas.
func value(t *testing.T, exposition, series string) float64 {
	t.Helper()
	for line := range strings.Lines(exposition) {
		if rest, ok := strings.CutPrefix(line, series+" "); ok {
			number, err := strconv.ParseFloat(strings.Fields(rest)[0], 64)
			if err != nil {
				t.Fatalf("%s: %v", line, err)
			}
			return number
		}
	}
	t.Fatalf("el scrape no trae %s:\\n%s", series, exposition)
	return math.NaN()
}

func TestLasSeriesDelRuntimeSalenYElHeapSeMideContraSuLimite(t *testing.T) {
	observability, _ := started(t)
	exposition := scrape(t, observability)
	for _, series := range []string{${series.map(goString).join(', ')}} {
		if value(t, exposition, series) < 0 {
			t.Errorf("%s negativa", series)
		}
	}
	used := value(t, exposition, ${goString(GO_RUNTIME.heapUsed)})
	if used <= 0 || used >= value(t, exposition, ${goString(GO_RUNTIME.heapLimit)}) {
		t.Errorf("heap = %v contra su límite %v", used, value(t, exposition, ${goString(GO_RUNTIME.heapLimit)}))
	}
	if value(t, exposition, ${goString(GO_RUNTIME.goroutines)}) < 1 {
		t.Error("sin goroutines")
	}
}
${pool ? `
func TestElPoolSaleDeDBStatsYLaSaturacionEsLoQueEsperoDesdeElScrapeAnterior(t *testing.T) {
	observability, _ := started(t)
	waited := int64(4)
	observability.RegisterPool(func() sql.DBStats {
		return sql.DBStats{MaxOpenConnections: 9, InUse: 2, Idle: 3, WaitCount: waited}
	})
	exposition := scrape(t, observability)
	for series, want := range map[string]float64{${goString(GO_RUNTIME.pool.active)}: 2, ${goString(GO_RUNTIME.pool.idle)}: 3, ${goString(GO_RUNTIME.pool.max)}: 9, ${goString(GO_RUNTIME.pool.saturation)}: 4} {
		if got := value(t, exposition, series); got != want {
			t.Errorf("%s = %v, quiero %v", series, got, want)
		}
	}
	// Nadie más esperó: en reposo, cero, aunque el acumulado de DBStats no baje nunca.
	if got := value(t, scrape(t, observability), ${goString(GO_RUNTIME.pool.saturation)}); got != 0 {
		t.Errorf("saturación en reposo = %v, quiero 0", got)
	}
}
` : ''}
// consulted son las series que consultan el panel y las alertas de deploy/observability, sacadas por build de ellos.
var consulted = []string{${consulted}}

func TestTodaSerieQueConsultanElPanelYLasAlertasLaPublicaElScrape(t *testing.T) {
	observability, _ := started(t)
	nothing := func(context.Context) error { return nil }
	// Cada observación, con las etiquetas con que la emite el código generado.
	_ = observability.ObserveUseCase(t.Context(), "PruebaPanel", nil, nothing)
	_ = observability.Publishing(t.Context(), "PruebaPanel", nil, nothing)
	_ = observability.Consuming(t.Context(), "PruebaPanel", nil, nothing)
	_ = observability.Observe(t.Context(), telemetry.Storage, telemetry.Options{Labels: map[string]string{telemetry.AttrStorageOperation: "upload", telemetry.AttrStorageBucket: "prueba"}}, nothing)
	_ = observability.Observe(t.Context(), telemetry.MailSend, telemetry.Options{}, nothing)
	observability.CacheGet("prueba", true)
	observability.RegisterGauge(telemetry.OutboxDeadLettered, "prueba", func() float64 { return 0 })
${pool ? '	observability.RegisterPool(func() sql.DBStats { return sql.DBStats{} })\n' : ''}	server(observability, http.StatusOK, "/prueba/{id}").ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/prueba/1", nil))
	_, finish := observability.Client(t.Context(), "prueba", http.MethodGet, "/prueba/{id}", http.Header{})
	finish(http.StatusOK)
	published := map[string]bool{}
	for line := range strings.Lines(scrape(t, observability)) {
		if name, _, ok := strings.Cut(strings.TrimSpace(line), "{"); ok && !strings.HasPrefix(line, "#") {
			published[name] = true
		} else if fields := strings.Fields(line); len(fields) > 0 && !strings.HasPrefix(line, "#") {
			published[fields[0]] = true
		}
	}
	// Lo que falte sale en el mensaje: una alerta sobre una serie que nadie publica no falla, no dispara nunca.
	for _, series := range consulted {
		if !published[series] {
			t.Errorf("el panel o una alerta consultan %s y el scrape no la publica", series)
		}
	}
}
`;
}

function httpTestBody(model) {
  const secured = usesHttpSecurity(model);
  const handler = testHandler(model).replace(/, nil\)$/, ', observability)');
  const traffic = trafficPath(model);
  const template = traffic ? `${model.api.routeBase}${model.services.flatMap((service) => service.operations).find((operation) => operation.route?.method === 'GET').route.path}` : null;
  return `
// La entrada HTTP real, observada: la plantilla sale del enrutador y el scrape no pasa por la seguridad.
${STARTED}
func TestLaEntradaRealMideConLaPlantillaDeLaRuta(t *testing.T) {
	observability, _ := started(t)
	handler := ${handler}
	get := func(path string) (*httptest.ResponseRecorder, string) {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		body, err := io.ReadAll(recorder.Result().Body)
		if err != nil {
			t.Fatal(err)
		}
		return recorder, string(body)
	}
	${traffic ? `get(${goString(traffic)})
	_, exposition := get(telemetry.ScrapePath)
	if want := ${goString(`uri="${template}"`)}; !strings.Contains(exposition, want) {
		t.Errorf("falta %s en el scrape:\\n%s", want, exposition)
	}` : `get("/no-existe")
	_, exposition := get(telemetry.ScrapePath)
	if !strings.Contains(exposition, "http_server_requests_seconds_count") {
		t.Errorf("sin la serie HTTP:\\n%s", exposition)
	}`}
	if strings.Contains(exposition, "11111111-1111") {
		t.Error("la URL con sus valores salió en una etiqueta")
	}
	if scraped, _ := get(telemetry.ScrapePath); scraped.Code != http.StatusOK {
		t.Errorf("el scrape respondió %d: el colector no tiene token", scraped.Code)
	}
}
`;
}

const MESSAGING_TEST = `
// La envoltura lleva el traceparent del span en curso y el consumo lo continúa; el relay publica dentro de esa traza.

func TestLaEnvolturaLlevaElTraceparentYElConsumoLoContinua(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	observability, err := telemetry.New(t.Context(), telemetry.Settings{ServiceName: "servicio", SamplingProbability: 1, PrometheusEnabled: true}, telemetry.WithSpanProcessor(recorder))
	if err != nil {
		t.Fatal(err)
	}
	metadata := domain.EventMetadata{EventType: "PruebaEvento", OccurredAt: time.Now()}
	var stamped domain.EventMetadata
	var spanID string
	if err := observability.Observe(t.Context(), "keel.prueba", telemetry.Options{Name: "PruebaEnvoltura"}, func(ctx context.Context) error {
		stamped = messaging.NewEnvelope(ctx, metadata, 1).Metadata
		spanID = trace.SpanContextFromContext(ctx).SpanID().String()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if stamped.Traceparent == nil || !strings.Contains(*stamped.Traceparent, spanID) {
		t.Fatalf("traceparent = %v, quiero el del span %s", stamped.Traceparent, spanID)
	}
	var consumed trace.SpanContext
	if err := messaging.Consume(t.Context(), observability, stamped, func(ctx context.Context) error {
		consumed = trace.SpanContextFromContext(ctx)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(*stamped.Traceparent, consumed.TraceID().String()) {
		t.Errorf("el consumo no continúa la traza del emisor: %s contra %s", consumed.TraceID(), *stamped.Traceparent)
	}
	var span trace.SpanKind
	for _, ended := range recorder.Ended() {
		if ended.Name() == "PruebaEvento consume" {
			span = ended.SpanKind()
		}
	}
	if span != trace.SpanKindConsumer {
		t.Errorf("el consumo no abrió su span CONSUMER: %v", span)
	}
}

func TestSinSpanLaEnvolturaNoInventaTraza(t *testing.T) {
	envelope := messaging.NewEnvelope(t.Context(), domain.EventMetadata{EventType: "PruebaEvento"}, 1)
	if envelope.Metadata.Traceparent != nil {
		t.Errorf("traceparent = %q, quiero nil", *envelope.Metadata.Traceparent)
	}
}
`;
