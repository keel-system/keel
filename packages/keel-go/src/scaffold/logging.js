// Los logs del servicio generado (`internal/platform/logging`, incremento 14b): lo que los otros tres generan CON y SIN
// telemetría, porque la consola es el canal primario de los logs en cualquier plataforma.
//
//   · `local` y `test` escriben TEXTO, porque lo lee una persona; `develop` y `production`, JSON ECS (`LOG_FORMAT`, default
//     `ecs`) con la forma ANIDADA del formato de Spring Boot 3.5, para que un mismo pipeline lea los cuatro servidores. El
//     `logging.yaml` de cada perfil es el neutral de keel-core (`gen/logging-config.js`).
//   · Cada línea lleva el `correlationId` del contexto con el que se escribe y, con telemetría, los ids de su traza.
//   · Los niveles salen de las MISMAS variables: `LOG_LEVEL_APP` para lo que escribe el servicio y `LOG_LEVEL_ROOT` para lo
//     demás. slog no tiene categorías: la de una línea es el PAQUETE que la escribe, leído del contador de programa que
//     slog ya captura, y es también el `log.logger` de ECS.
//   · Un Handler propio y no el JSON de slog: el de serie escribe su forma plana (`time`, `level`, `msg`), y con ReplaceAttr
//     no se llega a la anidada, porque el nivel se reemplaza antes de saber qué paquete escribe.
//   · Sin `process.thread.name`: una goroutine no tiene identidad que se pueda escribir.

import { ECS_VERSION, loggingYaml as neutralLoggingYaml } from '@keel-system/keel-core/gen/logging-config';
import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { goString } from '../lib/go-source.js';
import { usesCorrelation } from './correlation.js';
import { layout, packageFile } from './render.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El `logging.yaml` de un perfil: el neutral de keel-core con la cabecera de keel-go. */
export function loggingYaml(model, profile) {
  return neutralLoggingYaml(model, profile, { header: `Generado por keel-go build. Los logs del servicio en el perfil ${profile}.` });
}

export function generate(model) {
  const { logging } = layout(model);
  return [
    { path: `${logging.dir}/logging.go`, content: loggingGo(model) },
    { path: `${logging.dir}/logging_test.go`, content: loggingTestGo(model) },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/logging.yaml`, content: loggingYaml(model, profile) }))
  ];
}

/** El cableado de `run`: la configuración del perfil y el logger, antes que nada que escriba. */
export function loggerWiring(model) {
  const extra = usesTelemetry(model) ? ', observability.LogHandlers()...' : '';
  return `	logSettings, err := logging.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de los logs: %w", err)
	}
	logger := logging.New(logSettings, stdout${extra})
	// Lo que escribe una biblioteca con slog o con log sale con el mismo formato y los mismos niveles.
	previous := slog.Default()
	slog.SetDefault(logger)
	defer slog.SetDefault(previous)
`;
}

function loggingGo(model) {
  const { logging } = layout(model);
  const telemetry = usesTelemetry(model);
  const correlated = usesCorrelation(model);
  return packageFile(model, logging, {
    doc: 'Package logging escribe la consola del servicio: texto en local, para una persona, y JSON ECS fuera de él, con la\nmisma forma que los otros servidores del mismo diseño.',
    imports: [
      'context',
      'fmt',
      'io',
      'log/slog',
      'math',
      'os',
      'runtime',
      'strconv',
      'strings',
      'sync',
      'time',
      'encoding/json/jsontext',
      'encoding/json/v2',
      ...(telemetry ? ['go.opentelemetry.io/otel/trace'] : []),
      'internal/platform/config',
      ...(correlated ? ['internal/platform/correlation'] : [])
    ],
    body: `
// serviceModule es lo que empieza por el paquete de una línea que escribe el servicio. El resto es de una biblioteca.
const serviceModule = ${goString(`${model.service.goModule}/`)}

// ecsVersion es la versión del esquema que declara cada línea: la del formato de Spring Boot 3.5.
const ecsVersion = ${goString(ECS_VERSION)}

// Format es el formato de la consola.
type Format int

const (
	// FormatText es para una persona.
	FormatText Format = iota
	// FormatECS es JSON ECS, para quien la recoge.
	FormatECS
)

// Los niveles que slog no nombra: los de logback, los que escriben LOG_LEVEL_ROOT y LOG_LEVEL_APP.
const (
	// LevelTrace está por debajo de Debug.
	LevelTrace = slog.Level(-8)
	// LevelFatal está por encima de Error.
	LevelFatal = slog.Level(12)
	// LevelOff no deja pasar ninguna línea.
	LevelOff = slog.Level(math.MaxInt32)
)

// Settings son los logs del perfil activo (logging.yaml).
type Settings struct {
	// Format es el formato de la consola.
	Format Format
	// RootLevel es el mínimo de lo que escribe una biblioteca (LOG_LEVEL_ROOT).
	RootLevel slog.Level
	// AppLevel es el mínimo de lo que escribe el servicio (LOG_LEVEL_APP).
	AppLevel slog.Level
	// ServiceName es el service.name de cada línea ECS.
	ServiceName string
	// Version es el service.version de cada línea ECS.
	Version string
	// Environment es el service.environment de cada línea ECS.
	Environment string
	// NodeName es la réplica que escribe (service.node.name).
	NodeName string
}

// SettingsFrom lee los logs de la configuración del perfil. Un nivel que no existe no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
	root, err := ParseLevel(text("logging.level.root", "INFO"))
	if err != nil {
		return Settings{}, fmt.Errorf("logging.level.root: %w", err)
	}
	app, err := ParseLevel(text("logging.level.app", "INFO"))
	if err != nil {
		return Settings{}, fmt.Errorf("logging.level.app: %w", err)
	}
	settings := Settings{
		RootLevel:   root,
		AppLevel:    app,
		ServiceName: cfg.ApplicationName,
		Version:     text("logging.structured.ecs.service.version", ""),
		Environment: text("logging.structured.ecs.service.environment", ""),
		NodeName:    text("logging.structured.ecs.service.node-name", ""),
	}
	if strings.EqualFold(text("logging.structured.format.console", ""), "ecs") {
		settings.Format = FormatECS
	}
	return settings, nil
}

// ParseLevel lee un nivel con los nombres de keel-spring (los de logback).
func ParseLevel(name string) (slog.Level, error) {
	switch strings.ToUpper(strings.TrimSpace(name)) {
	case "TRACE":
		return LevelTrace, nil
	case "DEBUG":
		return slog.LevelDebug, nil
	case "INFO":
		return slog.LevelInfo, nil
	case "WARN":
		return slog.LevelWarn, nil
	case "ERROR":
		return slog.LevelError, nil
	case "FATAL":
		return LevelFatal, nil
	case "OFF":
		return LevelOff, nil
	}
	return 0, fmt.Errorf("nivel de log desconocido: %q (usa TRACE, DEBUG, INFO, WARN, ERROR u OFF)", name)
}

// levelName es el nombre con que la línea dice su nivel: el de los otros servidores.
func levelName(level slog.Level) string {
	switch {
	case level < slog.LevelDebug:
		return "TRACE"
	case level < slog.LevelInfo:
		return "DEBUG"
	case level < slog.LevelWarn:
		return "INFO"
	case level < slog.LevelError:
		return "WARN"
	case level < LevelFatal:
		return "ERROR"
	}
	return "FATAL"
}

// New es el logger del servicio sobre out. others son handlers adicionales, que reciben las mismas líneas.
func New(settings Settings, out io.Writer, others ...slog.Handler) *slog.Logger {
	var handler slog.Handler = NewHandler(settings, out)
	if len(others) > 0 {
		handler = slog.NewMultiHandler(append([]slog.Handler{handler}, others...)...)
	}
	return slog.New(handler)
}

// Handler escribe cada línea en el formato del perfil. El paquete que la escribe decide su nivel y es su log.logger.
type Handler struct {
	sink   *sink
	prefix string
	attrs  []slog.Attr
}

// sink es lo que comparten un Handler y los que salen de él: una línea se escribe entera, sin mezclarse con otra.
type sink struct {
	settings Settings
	pid      int
	mu       sync.Mutex
	out      io.Writer
}

// NewHandler devuelve el Handler del perfil sobre out.
func NewHandler(settings Settings, out io.Writer) *Handler {
	return &Handler{sink: &sink{settings: settings, pid: os.Getpid(), out: out}}
}

// Enabled deja pasar lo que supere alguno de los dos niveles: el paquete aún no se sabe, lo dice Handle.
func (h *Handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= min(h.sink.settings.RootLevel, h.sink.settings.AppLevel)
}

// Handle escribe la línea si supera el nivel del paquete que la escribe.
func (h *Handler) Handle(ctx context.Context, record slog.Record) error {
	settings := h.sink.settings
	category := categoryOf(record.PC)
	threshold := settings.RootLevel
	if category == "main" || strings.HasPrefix(category, serviceModule) {
		threshold = settings.AppLevel
	}
	if record.Level < threshold {
		return nil
	}
	current := line{at: record.Time.UTC(), level: record.Level, category: category, message: record.Message}
${correlated ? `	if id, ok := correlation.ID(ctx); ok {
		current.correlationID = id
	}
` : ''}${telemetry ? `	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		current.traceID, current.spanID = span.TraceID().String(), span.SpanID().String()
	}
` : ''}	for _, attr := range h.attrs {
		current.add("", attr)
	}
	record.Attrs(func(attr slog.Attr) bool {
		current.add(h.prefix, attr)
		return true
	})
	var text []byte
	if settings.Format == FormatECS {
		text = current.ecs(settings, h.sink.pid)
	} else {
		text = current.text(h.sink.pid)
	}
	h.sink.mu.Lock()
	defer h.sink.mu.Unlock()
	if _, err := h.sink.out.Write(text); err != nil {
		return fmt.Errorf("escribir la línea de log: %w", err)
	}
	return nil
}

// WithAttrs añade atributos a todas las líneas.
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := &Handler{sink: h.sink, prefix: h.prefix, attrs: append([]slog.Attr{}, h.attrs...)}
	for _, attr := range attrs {
		attr.Key = h.prefix + attr.Key
		next.attrs = append(next.attrs, attr)
	}
	return next
}

// WithGroup pone un prefijo a los atributos que vengan: <grupo>.<clave>.
func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	return &Handler{sink: h.sink, prefix: h.prefix + name + ".", attrs: h.attrs}
}

// categoryOf es el paquete de la función que escribe: de «svc/internal/x.(*T).M», «svc/internal/x». Sin contador de
// programa (lo que llega por el paquete log), «log».
func categoryOf(pc uintptr) string {
	if pc == 0 {
		return "log"
	}
	frame, _ := runtime.CallersFrames([]uintptr{pc}).Next()
	name := frame.Function
	slash := strings.LastIndexByte(name, '/')
	if dot := strings.IndexByte(name[slash+1:], '.'); dot >= 0 {
		return name[:slash+1+dot]
	}
	return name
}

// field es un atributo de la línea.
type field struct {
	key   string
	value slog.Value
}

// line es una línea ya decidida.
type line struct {
	at            time.Time
	level         slog.Level
	category      string
	message       string
	correlationID string
	traceID       string
	spanID        string
	errorType     string
	errorMessage  string
	stack         string
	fields        []field
}

// add reparte un atributo: «error» y «stack» son los campos error.* de ECS, y un grupo se aplana con puntos.
func (l *line) add(prefix string, attr slog.Attr) {
	value := attr.Value.Resolve()
	if attr.Equal(slog.Attr{}) {
		return
	}
	key := prefix + attr.Key
	switch {
	case value.Kind() == slog.KindGroup:
		next := prefix
		if attr.Key != "" {
			next = key + "."
		}
		for _, inner := range value.Group() {
			l.add(next, inner)
		}
	case key == "error":
		l.errorMessage = value.String()
		if err, ok := value.Any().(error); ok {
			l.errorType = fmt.Sprintf("%T", err)
		}
	case key == "stack":
		l.stack = value.String()
	default:
		l.fields = append(l.fields, field{key: key, value: value})
	}
}

// instant es el instante de una línea: UTC con tres decimales, como el cable.
func instant(at time.Time) string {
	return at.Format("2006-01-02T15:04:05.000Z")
}

// text es «<instante> <NIVEL> <pid> --- [correlationId] [categoría] mensaje clave=valor», con la pila debajo.
func (l *line) text(pid int) []byte {
	var out strings.Builder
	fmt.Fprintf(&out, "%s %5s %d --- ", instant(l.at), levelName(l.level), pid)
	if l.correlationID != "" {
		fmt.Fprintf(&out, "[%s] ", l.correlationID)
	}
	if l.traceID != "" {
		fmt.Fprintf(&out, "[%s,%s] ", l.traceID, l.spanID)
	}
	fmt.Fprintf(&out, "[%s] %s", l.category, l.message)
	for _, item := range l.fields {
		text := item.value.String()
		if strings.ContainsAny(text, " \\t\\n\\"=") {
			text = strconv.Quote(text)
		}
		fmt.Fprintf(&out, " %s=%s", item.key, text)
	}
	if l.errorMessage != "" {
		fmt.Fprintf(&out, " error=%s", strconv.Quote(l.errorMessage))
	}
	out.WriteByte('\\n')
	if l.stack != "" {
		out.WriteString(l.stack)
		if !strings.HasSuffix(l.stack, "\\n") {
			out.WriteByte('\\n')
		}
	}
	return []byte(out.String())
}

// reserved son las claves de la forma ECS: un atributo con uno de estos nombres va bajo labels, o la línea repetiría la clave.
var reserved = map[string]bool{"@timestamp": true, "log": true, "process": true, "service": true, "message": true, "correlationId": true, "trace": true, "span": true, "ecs": true}

// ecs es la línea en JSON ECS: la forma anidada de Spring Boot 3.5.
func (l *line) ecs(settings Settings, pid int) []byte {
	out := []byte(\`{"@timestamp":\`)
	out = quoted(out, instant(l.at))
	out = append(out, \`,"log":{"level":\`...)
	out = quoted(out, levelName(l.level))
	out = append(out, \`,"logger":\`...)
	out = quoted(out, l.category)
	out = append(out, \`},"process":{"pid":\`...)
	out = strconv.AppendInt(out, int64(pid), 10)
	out = append(out, \`},"service":{"name":\`...)
	out = quoted(out, settings.ServiceName)
	if settings.Version != "" {
		out = append(out, \`,"version":\`...)
		out = quoted(out, settings.Version)
	}
	if settings.Environment != "" {
		out = append(out, \`,"environment":\`...)
		out = quoted(out, settings.Environment)
	}
	if settings.NodeName != "" {
		out = append(out, \`,"node":{"name":\`...)
		out = quoted(out, settings.NodeName)
		out = append(out, '}')
	}
	out = append(out, \`},"message":\`...)
	out = quoted(out, l.message)
	if l.correlationID != "" {
		out = append(out, \`,"correlationId":\`...)
		out = quoted(out, l.correlationID)
	}
	if l.traceID != "" {
		// Los nombres de ECS: con ellos un backend enlaza la línea con su traza.
		out = append(out, \`,"trace":{"id":\`...)
		out = quoted(out, l.traceID)
		out = append(out, \`},"span":{"id":\`...)
		out = quoted(out, l.spanID)
		out = append(out, '}')
	}
	if l.errorMessage != "" || l.stack != "" {
		out = append(out, \`,"error":{"message":\`...)
		out = quoted(out, l.errorMessage)
		if l.errorType != "" {
			out = append(out, \`,"type":\`...)
			out = quoted(out, l.errorType)
		}
		if l.stack != "" {
			out = append(out, \`,"stack_trace":\`...)
			out = quoted(out, l.stack)
		}
		out = append(out, '}')
	}
	for _, item := range l.fields {
		key := item.key
		if reserved[key] {
			key = "labels." + key
		}
		out = append(out, ',')
		out = quoted(out, key)
		out = append(out, ':')
		out = appendValue(out, item.value)
	}
	out = append(out, \`,"ecs":{"version":\`...)
	out = quoted(out, ecsVersion)
	return append(out, "}}\\n"...)
}

// quoted añade text como cadena JSON. Lo que no es UTF-8 válido se sustituye: una línea no se pierde por un byte.
func quoted(out []byte, text string) []byte {
	// Con UTF-8 válido, AppendQuote no falla.
	encoded, _ := jsontext.AppendQuote(out, strings.ToValidUTF8(text, "\\uFFFD"))
	return encoded
}

// appendValue añade el valor de un atributo con su tipo JSON.
func appendValue(out []byte, value slog.Value) []byte {
	switch value.Kind() {
	case slog.KindInt64:
		return strconv.AppendInt(out, value.Int64(), 10)
	case slog.KindUint64:
		return strconv.AppendUint(out, value.Uint64(), 10)
	case slog.KindBool:
		return strconv.AppendBool(out, value.Bool())
	case slog.KindFloat64:
		if number := value.Float64(); !math.IsNaN(number) && !math.IsInf(number, 0) {
			return strconv.AppendFloat(out, number, 'g', -1, 64)
		}
	case slog.KindAny:
		if _, isError := value.Any().(error); !isError {
			if encoded, err := json.Marshal(value.Any()); err == nil {
				return append(out, encoded...)
			}
		}
	case slog.KindTime:
		return quoted(out, instant(value.Time().UTC()))
	}
	return quoted(out, value.String())
}
`
  });
}

function loggingTestGo(model) {
  const { logging } = layout(model);
  const telemetry = usesTelemetry(model);
  const correlated = usesCorrelation(model);
  const ctxLine = correlated ? 'correlation.WithID(t.Context(), "pedido-42")' : 't.Context()';
  return packageFile(model, logging, {
    test: true,
    imports: [
      'bytes',
      'encoding/json',
      'errors',
      'log/slog',
      'strings',
      'testing',
      'time',
      ...(telemetry ? ['go.opentelemetry.io/otel/trace'] : []),
      ...(correlated ? ['internal/platform/correlation'] : []),
      'internal/platform/logging'
    ],
    body: `
// Los logs EJECUTADOS: la línea ECS anidada de los otros tres servidores, el texto de local, los dos niveles y la pila
// una sola vez. La configuración emitida de cada perfil la mide la prueba del arranque.

func ecsSettings() logging.Settings {
	return logging.Settings{Format: logging.FormatECS, RootLevel: slog.LevelWarn, AppLevel: slog.LevelInfo, ServiceName: "servicio", Version: "1.2.3", Environment: "develop", NodeName: "pod-1"}
}

func decode(t *testing.T, text string) map[string]any {
	t.Helper()
	var line map[string]any
	if err := json.Unmarshal([]byte(text), &line); err != nil {
		t.Fatalf("la línea no es JSON: %v\\n%s", err, text)
	}
	return line
}

func nested(t *testing.T, line map[string]any, path ...string) any {
	t.Helper()
	var current any = line
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v: no es un objeto en %q: %v", path, key, line)
		}
		current = object[key]
	}
	return current
}

func TestLaLineaEcsTieneLaFormaAnidada(t *testing.T) {
	var out bytes.Buffer
	logging.New(ecsSettings(), &out).InfoContext(${ctxLine}, "pedido creado", "operation", "CreateOrder", "elapsedMs", 12)
	line := decode(t, out.String())
	for path, want := range map[string]any{
		"log.level":           "INFO",
		"service.name":        "servicio",
		"service.version":     "1.2.3",
		"service.environment": "develop",
		"service.node.name":   "pod-1",
		"message":             "pedido creado",
		"ecs.version":         ${goString(ECS_VERSION)},
	} {
		if got := nested(t, line, strings.Split(path, ".")...); got != want {
			t.Errorf("%s = %v, quiero %v", path, got, want)
		}
	}
	if !strings.HasPrefix(nested(t, line, "log", "logger").(string), ${goString(`${model.service.goModule}/`)}) {
		t.Errorf("log.logger = %v: quiero el paquete que escribe", nested(t, line, "log", "logger"))
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", line["@timestamp"].(string)); err != nil {
		t.Errorf("@timestamp: %v", err)
	}
	if line["operation"] != "CreateOrder" || line["elapsedMs"] != float64(12) {
		t.Errorf("los atributos no salen como campos con su tipo: %v", line)
	}
${correlated ? `	if line["correlationId"] != "pedido-42" {
		t.Errorf("correlationId = %v, quiero pedido-42", line["correlationId"])
	}
` : `	if _, ok := line["correlationId"]; ok {
		t.Errorf("sin correlación en el contexto, la línea no lleva correlationId: %v", line)
	}
`}}

func TestElErrorYLaPilaSonLosCamposDeEcsYSalenUnaVez(t *testing.T) {
	var out bytes.Buffer
	logging.New(ecsSettings(), &out).ErrorContext(t.Context(), "pánico en un handler", "error", errors.New("roto"), "stack", "goroutine 1\\nmain.run()")
	line := decode(t, out.String())
	if nested(t, line, "error", "message") != "roto" || nested(t, line, "error", "stack_trace") != "goroutine 1\\nmain.run()" {
		t.Errorf("error = %v", line["error"])
	}
	if nested(t, line, "error", "type") != "*errors.errorString" {
		t.Errorf("error.type = %v", nested(t, line, "error", "type"))
	}
	if strings.Count(out.String(), "goroutine 1") != 1 {
		t.Errorf("la pila sale más de una vez: %s", out.String())
	}
}

func TestUnAtributoConUnNombreDeEcsNoRepiteLaClave(t *testing.T) {
	var out bytes.Buffer
	logging.New(ecsSettings(), &out).InfoContext(t.Context(), "m", "service", "otro")
	line := decode(t, out.String())
	if nested(t, line, "service", "name") != "servicio" || line["labels.service"] != "otro" {
		t.Errorf("línea = %v", line)
	}
}

func TestElTextoEsParaUnaPersona(t *testing.T) {
	var out bytes.Buffer
	settings := logging.Settings{Format: logging.FormatText, RootLevel: slog.LevelInfo, AppLevel: slog.LevelInfo}
	logging.New(settings, &out).WarnContext(${ctxLine}, "algo raro", "address", "127.0.0.1:80", "reason", "con espacios")
	text := out.String()
	for _, want := range []string{" WARN ", " --- ", ${correlated ? '"[pedido-42] ", ' : ''}"algo raro", " address=127.0.0.1:80", \` reason="con espacios"\`} {
		if !strings.Contains(text, want) {
			t.Errorf("falta %q en %q", want, text)
		}
	}
	if strings.HasPrefix(text, "{") {
		t.Errorf("el texto salió en JSON: %s", text)
	}
}

func TestLoQueEscribeElServicioTieneSuNivelYElRestoElDeLaRaiz(t *testing.T) {
	var out bytes.Buffer
	handler := logging.NewHandler(logging.Settings{Format: logging.FormatText, RootLevel: slog.LevelWarn, AppLevel: slog.LevelDebug}, &out)
	// El servicio: esta prueba es un paquete del módulo.
	slog.New(handler).DebugContext(t.Context(), "del servicio")
	// Sin contador de programa: lo que llega por el paquete log, que no es del servicio.
	if err := handler.Handle(t.Context(), slog.NewRecord(time.Now(), slog.LevelInfo, "de una biblioteca", 0)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "del servicio") {
		t.Errorf("LOG_LEVEL_APP no deja pasar lo del servicio: %q", out.String())
	}
	if strings.Contains(out.String(), "de una biblioteca") {
		t.Errorf("LOG_LEVEL_ROOT no filtra lo que no es del servicio: %q", out.String())
	}
}

func TestParseLevel(t *testing.T) {
	for name, want := range map[string]slog.Level{"TRACE": logging.LevelTrace, "debug": slog.LevelDebug, " INFO ": slog.LevelInfo, "WARN": slog.LevelWarn, "ERROR": slog.LevelError, "OFF": logging.LevelOff} {
		if got, err := logging.ParseLevel(name); err != nil || got != want {
			t.Errorf("ParseLevel(%q) = %v, %v; quiero %v", name, got, err, want)
		}
	}
	if _, err := logging.ParseLevel("VERBOSE"); err == nil {
		t.Error("ParseLevel aceptó un nivel que no existe")
	}
}

func TestWithAttrsYWithGroupSeConservan(t *testing.T) {
	var out bytes.Buffer
	logging.New(ecsSettings(), &out).With("tenant", "a").WithGroup("g").InfoContext(t.Context(), "m", "k", "v")
	line := decode(t, out.String())
	if line["tenant"] != "a" || line["g.k"] != "v" {
		t.Errorf("línea = %v", line)
	}
}
${telemetry ? `
func TestLaLineaLlevaLosIdsDeSuTraza(t *testing.T) {
	traceID, _ := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	spanID, _ := trace.SpanIDFromHex("b7ad6b7169203331")
	ctx := trace.ContextWithSpanContext(t.Context(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID}))
	var out bytes.Buffer
	logging.New(ecsSettings(), &out).InfoContext(ctx, "dentro")
	line := decode(t, out.String())
	if nested(t, line, "trace", "id") != traceID.String() || nested(t, line, "span", "id") != spanID.String() {
		t.Errorf("línea = %v", line)
	}
}
` : ''}`
  });
}
