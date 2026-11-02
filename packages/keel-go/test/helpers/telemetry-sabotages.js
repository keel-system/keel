// Los sabotajes de la telemetría y de los logs (incremento 14): cada uno rompe lo emitido CONSERVANDO LA FORMA (sigue
// compilando), y la prueba emitida que nombra tiene que salir en rojo, y solo esa. Los aplica go-check sobre la silueta con
// telemetría del sujeto.

export const TELEMETRY_SUBJECT = { from: 'stock-reservation-events', stack: { telemetry: 'otel', broker: 'rabbitmq' } };

const TELEMETRY = './internal/platform/telemetry/';
const LOGGING = './internal/platform/logging/';
const MESSAGING = './internal/infrastructure/messaging/';

export const TELEMETRY_SABOTAGES = [
  {
    id: 'telemetry-exemplar',
    what: 'el histograma se mide sin exemplar',
    file: 'internal/platform/telemetry/telemetry.go',
    from: 'ok && span.IsSampled() {',
    to: 'ok && false {',
    packages: TELEMETRY,
    fails: 'TestLaEntradaHTTPContinuaLaTrazaDeQuienLlamaYLaMideConElExemplar'
  },
  {
    id: 'telemetry-unsampled',
    what: 'un exemplar también sin muestrear',
    file: 'internal/platform/telemetry/telemetry.go',
    from: 'ok && span.IsSampled() {',
    to: 'ok && span.IsValid() {',
    packages: TELEMETRY,
    fails: 'TestSinMuestrearNoHayExemplar'
  },
  {
    id: 'telemetry-parent',
    what: 'la entrada HTTP no continúa la traza de quien llama',
    file: 'internal/platform/telemetry/http.go',
    from: 'ctx := t.extract(r.Context(), r.Header)',
    to: 'ctx := r.Context()',
    packages: TELEMETRY,
    fails: 'TestElPropagadorLeeW3CYTambienB3',
    alsoFails: ['TestLaEntradaHTTPContinuaLaTrazaDeQuienLlamaYLaMideConElExemplar']
  },
  {
    id: 'telemetry-b3',
    what: 'la entrada no lee B3',
    file: 'internal/platform/telemetry/http.go',
    from: 'return t.b3.Extract(ctx, carrier)',
    to: 'return ctx',
    packages: TELEMETRY,
    fails: 'TestElPropagadorLeeW3CYTambienB3'
  },
  {
    id: 'telemetry-rejection',
    what: 'el rechazo del dominio cuenta como fallo',
    file: 'internal/platform/telemetry/telemetry.go',
    from: 'case options.Rejected != nil && options.Rejected(err):',
    to: 'case false:',
    packages: TELEMETRY,
    fails: 'TestElCasoDeUsoSeparaOkRechazadoYErrorYSoloElErrorMarcaElSpan'
  },
  {
    id: 'telemetry-template',
    what: 'la serie HTTP lleva la URL con sus valores',
    file: 'internal/platform/telemetry/http.go',
    from: 'target, template := next, route(r)',
    to: 'target, template := next, r.URL.Path',
    packages: TELEMETRY,
    fails: 'TestLaEntradaHTTPContinuaLaTrazaDeQuienLlamaYLaMideConElExemplar',
    alsoFails: ['TestSinRutaLaPlantillaEsNotFoundOUnknown', 'TestElPropagadorLeeW3CYTambienB3'],
    optional: ['TestElPropagadorLeeW3CYTambienB3']
  },
  {
    id: 'telemetry-probes',
    what: 'las sondas abren traza',
    file: 'internal/platform/telemetry/http.go',
    from: 'return path == "/livez" || path == "/readyz" || path == ScrapePath',
    to: 'return path == ScrapePath',
    packages: TELEMETRY,
    fails: 'TestLasSondasNoAbrenTrazaPeroCuentanEnLaMetrica'
  },
  {
    id: 'telemetry-openmetrics',
    what: 'el scrape no fuerza OpenMetrics: sin exemplars para quien no lo pide',
    file: 'internal/platform/telemetry/http.go',
    from: 'r.Header.Set("Accept", scrapeAccept)',
    to: '_ = scrapeAccept',
    packages: TELEMETRY,
    fails: 'scrape',
    anyFailure: true
  },
  {
    id: 'telemetry-series',
    what: 'una serie del runtime con otro nombre: el panel se queda vacío',
    file: 'internal/platform/telemetry/runtime.go',
    from: 't.gauge("keel_runtime_goroutines"',
    to: 't.gauge("keel_runtime_goroutine"',
    packages: TELEMETRY,
    fails: 'TestLasSeriesDelRuntimeSalenYElHeapSeMideContraSuLimite',
    alsoFails: ['TestTodaSerieQueConsultanElPanelYLasAlertasLaPublicaElScrape']
  },
  {
    id: 'telemetry-pool',
    what: 'la saturación del pool es el acumulado de DBStats, que no baja nunca',
    file: 'internal/platform/telemetry/runtime.go',
    from: 'seen = waited',
    to: 'seen = 0',
    packages: TELEMETRY,
    fails: 'TestElPoolSaleDeDBStatsYLaSaturacionEsLoQueEsperoDesdeElScrapeAnterior'
  },
  {
    id: 'telemetry-labels',
    what: 'la métrica entra en pánico con otras etiquetas',
    file: 'internal/platform/telemetry/telemetry.go',
    from: 'aligned[name] = cmp.Or(values[name], "none")',
    to: 'aligned[name] = values[name]',
    packages: TELEMETRY,
    fails: 'TestUnaMetricaConOtrasEtiquetasNoRompeLaOperacion'
  },
  {
    id: 'telemetry-envelope',
    what: 'la envoltura no lleva el traceparent',
    file: 'internal/infrastructure/messaging/envelope.go',
    from: 'telemetry.Traceparent(ctx)',
    to: 'telemetry.Traceparent(context.Background())',
    packages: MESSAGING,
    fails: 'TestLaEnvolturaLlevaElTraceparentYElConsumoLoContinua',
    panicAllowed: true
  },
  {
    id: 'log-correlation',
    what: 'la línea no lleva la correlación',
    file: 'internal/platform/logging/logging.go',
    from: 'current.correlationID = id',
    to: '_ = id',
    packages: LOGGING,
    fails: 'TestLaLineaEcsTieneLaFormaAnidada',
    alsoFails: ['TestElTextoEsParaUnaPersona']
  },
  {
    id: 'log-trace',
    what: 'la línea no lleva los ids de su traza',
    file: 'internal/platform/logging/logging.go',
    from: 'if span := trace.SpanContextFromContext(ctx); span.IsValid() {',
    to: 'if span := trace.SpanContextFromContext(ctx); false && span.IsValid() {',
    packages: LOGGING,
    fails: 'TestLaLineaLlevaLosIdsDeSuTraza',
    panicAllowed: true
  },
  {
    id: 'log-levels',
    what: 'lo del servicio se filtra con el nivel de la raíz',
    file: 'internal/platform/logging/logging.go',
    from: 'threshold = settings.AppLevel',
    to: 'threshold = settings.RootLevel',
    packages: LOGGING,
    fails: 'TestLoQueEscribeElServicioTieneSuNivelYElRestoElDeLaRaiz',
    // Con la raíz en WARN, el INFO del servicio que estas pruebas leen tampoco sale.
    alsoFails: ['TestLaLineaEcsTieneLaFormaAnidada', 'TestLaLineaLlevaLosIdsDeSuTraza', 'TestUnAtributoConUnNombreDeEcsNoRepiteLaClave', 'TestWithAttrsYWithGroupSeConservan']
  },
  {
    id: 'log-stack',
    what: 'la pila sale dos veces',
    file: 'internal/platform/logging/logging.go',
    from: '			out = quoted(out, l.stack)\n',
    to: '			out = quoted(out, l.stack+l.stack)\n',
    packages: LOGGING,
    fails: 'TestElErrorYLaPilaSonLosCamposDeEcsYSalenUnaVez'
  }
];

/** El archivo saboteado, o null si el texto ya no está. */
export function applyTelemetrySabotage(sabotage, source) {
  return source.includes(sabotage.from) ? source.replace(sabotage.from, () => sabotage.to) : null;
}
