// La correlación (`internal/platform/correlation`): el hilo que une petición HTTP → caso de uso → evento → mensaje
// saliente, y el valor que lleva ErrorResponse. Es el CorrelationContext de keel-spring (ThreadLocal + MDC), de
// keel-nest (AsyncLocalStorage) y de keel-dotnet (AsyncLocal), dicho en Go: viaja en el `context.Context` de la
// petición (§ 3.3), y un `slog.Handler` lo añade a cada registro que se escribe con ese contexto.
//
// El formato aceptado es el de los otros tres: el valor llega de FUERA y acaba en logs, cabeceras y eventos, así que
// lo que no lo cumple se sustituye por uno nuevo (nunca se trunca: saldrían ids que se confunden entre sí).

import { usesApi } from '@keel-system/keel-core/gen/features';
import { layout, packageFile } from './render.js';

/** ¿Se emite la correlación? Hoy la abre solo la entrada HTTP; la mensajería (incremento 9) también la abrirá. */
export function usesCorrelation(model) {
  return usesApi(model);
}

export function generate(model) {
  if (!usesCorrelation(model)) return [];
  const { correlation } = layout(model);
  return [
    {
      path: `${correlation.dir}/correlation.go`,
      content: packageFile(model, correlation, {
        doc: 'Package correlation lleva el identificador de correlación de la petición o del mensaje en curso: el\nhilo que une la entrada, el caso de uso y lo que sale de él. Viaja en el contexto.',
        imports: ['context', 'log/slog', 'regexp', 'github.com/google/uuid'],
        body: CORRELATION_BODY
      })
    },
    {
      path: `${correlation.dir}/correlation_test.go`,
      content: packageFile(model, correlation, {
        test: true,
        imports: ['bytes', 'log/slog', 'regexp', 'strings', 'testing', 'internal/platform/correlation'],
        body: CORRELATION_TEST
      })
    }
  ];
}

const CORRELATION_BODY = `
// Header es la cabecera HTTP por la que llega y vuelve la correlación.
const Header = "X-Correlation-Id"

// accepted es lo que se acepta como correlationId recibido: sin cota, un cliente podría meter saltos de línea o
// kilobytes en cada registro.
var accepted = regexp.MustCompile(\`^[A-Za-z0-9._-]{1,64}$\`)

// Accept devuelve el correlationId EFECTIVO para un valor recibido: el mismo si cumple el formato, o uno nuevo si
// no llegó o no lo cumple.
func Accept(received string) string {
	if accepted.MatchString(received) {
		return received
	}
	return uuid.NewString()
}

type contextKey struct{}

// WithID devuelve un contexto que lleva el correlationId id.
func WithID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, contextKey{}, id)
}

// ID es el correlationId del contexto y si lo lleva.
func ID(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(contextKey{}).(string)
	return id, ok
}

// LogHandler añade a cada registro el correlationId del contexto con el que se escribe, si lo lleva.
type LogHandler struct {
	next slog.Handler
}

// NewLogHandler envuelve next.
func NewLogHandler(next slog.Handler) *LogHandler {
	return &LogHandler{next: next}
}

// Enabled pregunta a next.
func (h *LogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

// Handle añade el correlationId y pasa el registro a next.
func (h *LogHandler) Handle(ctx context.Context, record slog.Record) error {
	if id, ok := ID(ctx); ok {
		// El registro puede compartir sus atributos con otras copias: se clona antes de añadir.
		record = record.Clone()
		record.AddAttrs(slog.String("correlationId", id))
	}
	return h.next.Handle(ctx, record)
}

// WithAttrs conserva el envoltorio.
func (h *LogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &LogHandler{next: h.next.WithAttrs(attrs)}
}

// WithGroup conserva el envoltorio.
func (h *LogHandler) WithGroup(name string) slog.Handler {
	return &LogHandler{next: h.next.WithGroup(name)}
}
`;

const CORRELATION_TEST = `
var generated = regexp.MustCompile(\`^[0-9a-f-]{36}$\`)

func TestAcceptConservaLoQueCumpleElFormatoYSustituyeLoDemas(t *testing.T) {
	if got := correlation.Accept("pedido-42"); got != "pedido-42" {
		t.Errorf("Accept(pedido-42) = %q, quiero el mismo", got)
	}
	for _, received := range []string{"", "con espacios", "linea\\nnueva", strings.Repeat("a", 65)} {
		if got := correlation.Accept(received); !generated.MatchString(got) {
			t.Errorf("Accept(%q) = %q, quiero uno nuevo", received, got)
		}
	}
}

func TestElContextoLlevaLaCorrelacion(t *testing.T) {
	if _, ok := correlation.ID(t.Context()); ok {
		t.Fatal("un contexto sin correlación dice llevar una")
	}
	ctx := correlation.WithID(t.Context(), "pedido-42")
	if id, ok := correlation.ID(ctx); !ok || id != "pedido-42" {
		t.Fatalf("ID = %q, %v; quiero pedido-42", id, ok)
	}
}

func TestLogHandlerEscribeLaCorrelacionDelContexto(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(correlation.NewLogHandler(slog.NewJSONHandler(&logs, nil))).With("service", "x")
	logger.InfoContext(correlation.WithID(t.Context(), "pedido-42"), "con")
	logger.InfoContext(t.Context(), "sin")
	lines := strings.Split(strings.TrimSpace(logs.String()), "\\n")
	if len(lines) != 2 || !strings.Contains(lines[0], \`"correlationId":"pedido-42"\`) || strings.Contains(lines[1], "correlationId") {
		t.Fatalf("logs = %s", logs.String())
	}
}
`;
