// El patrón mediator de los otros tres generadores, dicho en Go y sin reflexión (PLAN-KEEL-GO.md § 3.4).
//
// En Spring, Nest y .NET un mediator resuelve el handler de un mensaje en tiempo de ejecución por su tipo. En Go
// eso sería reflexión en el camino de la petición; lo idiomático es lo contrario: el registro es un struct
// generado, `UseCases`, con UN CAMPO TIPADO POR OPERACIÓN (`Handler[CreateProductCommand, CreateProductResponseDto]`),
// y el compilador hace el trabajo del registro: un mensaje no puede llegar a otro handler, y una operación sin
// cablear no compila en `NewUseCases`. Lo que el mediator añadía por encima —el log de frontera de cada caso de
// uso y, con la persistencia, la transacción— es un decorador genérico (`observe`), como un middleware de
// net/http: `NewUseCases` envuelve cada handler al cablearlo.
//
//   · usecase.go — `Handler[M, R]`, `CommandHandler[M]`, sus adaptadores de función, `MessageKind`,
//     `ErrNotImplemented` y los decoradores con el log de frontera.
//   · use_cases.go — `UseCases` y `NewUseCases`, el ÚNICO sitio que cablea un handler por operación.
//   · use_cases_test.go — que cada operación queda cableada y que el decorador deja pasar el resultado y el
//     error tal cual, con el nivel de log que toca.

import { alignRows, goString } from '../lib/go-source.js';
import { frameworkSentinels, sentinelOf } from './errors.js';
import { applicationPath, layout, packageFile } from './render.js';
import { contractOf, handlerType, messageType, operations, useCaseField } from './services.js';

export function generate(model) {
  const ops = operations(model);
  if (ops.length === 0) return [];
  const { application } = layout(model);
  // La prueba es INTERNA al paquete (no `application_test`): mide los decoradores, que no se exportan.
  const file = (name, body, imports = [], { test = false } = {}) => ({
    path: test ? applicationPath(model, name).replace(/\.go$/, '_test.go') : applicationPath(model, name),
    content: packageFile(model, application, { imports, body })
  });
  return [
    file('usecase', USECASE_BODY, ['context', 'errors', 'fmt', 'log/slog', 'time', 'internal/domain']),
    file('use_cases', useCasesBody(model, ops), ['log/slog']),
    file('use_cases', useCasesTest(model, ops), ['bytes', 'context', 'errors', 'log/slog', 'strings', 'testing', 'internal/domain'], { test: true })
  ];
}

const USECASE_BODY = `
// Handler es un caso de uso que devuelve un resultado: una consulta, o un comando que devuelve el recurso que
// crea o cambia. Uno por operación del diseño.
type Handler[M, R any] interface {
	Handle(ctx context.Context, msg M) (R, error)
}

// CommandHandler es un caso de uso que cambia estado y no devuelve nada.
type CommandHandler[M any] interface {
	Handle(ctx context.Context, cmd M) error
}

// HandlerFunc adapta una función a Handler, como http.HandlerFunc.
type HandlerFunc[M, R any] func(ctx context.Context, msg M) (R, error)

// Handle llama a f.
func (f HandlerFunc[M, R]) Handle(ctx context.Context, msg M) (R, error) {
	return f(ctx, msg)
}

// CommandHandlerFunc adapta una función a CommandHandler.
type CommandHandlerFunc[M any] func(ctx context.Context, cmd M) error

// Handle llama a f.
func (f CommandHandlerFunc[M]) Handle(ctx context.Context, cmd M) error {
	return f(ctx, cmd)
}

// MessageKind es la clase de mensaje que atiende un caso de uso. Con la persistencia decide la transacción: de
// lectura para una consulta, de escritura para un comando.
type MessageKind string

const (
	// KindCommand es un comando sin resultado.
	KindCommand MessageKind = "command"
	// KindReturningCommand es un comando que devuelve un resultado.
	KindReturningCommand MessageKind = "returningCommand"
	// KindQuery es una consulta: no cambia estado.
	KindQuery MessageKind = "query"
)

// ErrNotImplemented es lo que devuelve lo que build no sabe escribir y el agente tiene que completar: un caso de uso
// recién generado, o un campo que un mapeo no puede derivar. Compila y falla en ejecución nombrando qué falta, en
// vez de dejar pasar un valor inventado; la API lo responde como un 500.
var ErrNotImplemented = errors.New("sin implementar")

// observe envuelve un caso de uso con su LOG DE FRONTERA. Todas las operaciones pasan por aquí —las peticiones
// HTTP, los barridos programados y los mensajes consumidos—, así que es el único sitio que lo escribe: operación,
// resultado y duración. Solo nombres y códigos, nunca los valores del mensaje, que lleva datos de quien llama.
func observe[M, R any](logger *slog.Logger, operation string, kind MessageKind, next Handler[M, R]) Handler[M, R] {
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		started := time.Now()
		result, err := next.Handle(ctx, msg)
		logOutcome(ctx, logger, operation, kind, started, err)
		return result, err
	})
}

// observeCommand es observe para un comando sin resultado.
func observeCommand[M any](logger *slog.Logger, operation string, next CommandHandler[M]) CommandHandler[M] {
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		started := time.Now()
		err := next.Handle(ctx, cmd)
		logOutcome(ctx, logger, operation, KindCommand, started, err)
		return err
	})
}

// logOutcome escribe el resultado de un caso de uso con niveles fijos: Debug si salió bien, Info si el dominio lo
// rechazó —un 4xx es un resultado esperado— y Error si falló. El error en sí lo registra el borde por el que
// entró (§ 3.2: se registra o se devuelve, no las dos cosas); aquí va solo su tipo.
func logOutcome(ctx context.Context, logger *slog.Logger, operation string, kind MessageKind, started time.Time, err error) {
	elapsed := slog.Int64("elapsedMs", time.Since(started).Milliseconds())
	attrs := []any{slog.String("operation", operation), slog.String("kind", string(kind)), elapsed}
	var rejected *domain.Error
	switch {
	case err == nil:
		logger.DebugContext(ctx, "caso de uso: ok", attrs...)
	case errors.As(err, &rejected):
		logger.InfoContext(ctx, "caso de uso: rechazado", append(attrs, slog.String("code", rejected.Code()))...)
	default:
		logger.ErrorContext(ctx, "caso de uso: falló", append(attrs, slog.String("errorType", errorType(err)))...)
	}
}

// errorType nombra el error más interno de la cadena: el envoltorio de fmt.Errorf no dice nada.
func errorType(err error) string {
	for {
		inner := errors.Unwrap(err)
		if inner == nil {
			return typeName(err)
		}
		err = inner
	}
}

func typeName(err error) string {
	if errors.Is(err, ErrNotImplemented) {
		return "ErrNotImplemented"
	}
	return fmt.Sprintf("%T", err)
}
`;

function useCasesBody(model, ops) {
  const fieldRows = [];
  for (const operation of ops) {
    fieldRows.push({ text: `\t// ${useCaseField(operation)} es ${operation.name}.` });
    fieldRows.push({ indent: '\t', cells: [useCaseField(operation), contractOf(operation).handler] });
  }
  const wiring = ops.map((operation) => {
    const contract = contractOf(operation);
    const handler = `New${handlerType(operation)}(${(operation.dispatches ?? []).length > 0 ? 'uc' : ''})`;
    const name = goString(messageType(operation));
    return contract.kind === 'KindCommand'
      ? `\tuc.${useCaseField(operation)} = observeCommand(logger, ${name}, ${handler})`
      : `\tuc.${useCaseField(operation)} = observe(logger, ${name}, ${contract.kind}, ${handler})`;
  });
  return `
// UseCases son los casos de uso del servicio, uno por operación del diseño, ya envueltos con su log de frontera.
// Es la ÚNICA puerta de despacho: la API, los consumidores y el reloj llaman a un campo de aquí, nunca a un
// handler. Cada campo está tipado con su mensaje y su resultado, así que un mensaje no puede llegar a otro caso
// de uso: lo impide el compilador, no una tabla en tiempo de ejecución.
type UseCases struct {
${alignRows(fieldRows).join('\n')}
}

// NewUseCases cablea cada operación con su handler. Es el registro explícito de los casos de uso y lo genera
// build: lo que no está aquí no se despacha. Un handler que despacha otra operación (use-cases.dispatches)
// recibe el propio UseCases, ya completo cuando se le llama.
func NewUseCases(logger *slog.Logger) *UseCases {
	uc := &UseCases{}
${wiring.join('\n')}
	return uc
}
`;
}

/** Un error de dominio con el que probar el rechazo, o null si el diseño no tiene ninguno. */
function sampleSentinel(model) {
  const framework = frameworkSentinels(model)[0];
  if (framework) return framework.name;
  const declared = (model.errors ?? []).find((error) => !error.dynamicStatus);
  return declared ? sentinelOf(declared.code) : null;
}

function useCasesTest(model, ops) {
  const rows = ops.map((operation) => `\t\t{${goString(operation.name)}, uc.${useCaseField(operation)} != nil},`);
  const sentinel = sampleSentinel(model);
  const rejected = sentinel
    ? `

func TestObserveRegistraElRechazoDelDominioConSuCode(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	refused := domain.Errorf(domain.${sentinel}, "rechazado")
	handler := observeCommand(logger, "Refuse", CommandHandlerFunc[string](func(context.Context, string) error {
		return refused
	}))
	if err := handler.Handle(t.Context(), "dato-sensible"); !errors.Is(err, domain.${sentinel}) {
		t.Fatalf("el decorador cambió el error del dominio: %v", err)
	}
	line := logs.String()
	if !strings.Contains(line, \`"level":"INFO"\`) || !strings.Contains(line, \`"msg":"caso de uso: rechazado"\`) {
		t.Fatalf("un rechazo del dominio se registra en Info: %s", line)
	}
	if strings.Contains(line, "dato-sensible") {
		t.Fatalf("el log de frontera escribió el valor del mensaje: %s", line)
	}
}`
    : '';
  return `
// La prueba del cableado: cada operación del diseño tiene su caso de uso en UseCases, y el decorador del log de
// frontera deja pasar el resultado y el error tal cual. Se escribe para que siga valiendo cuando el agente
// implemente los handlers: no afirma que fallen, sino que existen y que el decorador no se interpone.

func TestNewUseCasesCableaCadaOperacion(t *testing.T) {
	uc := NewUseCases(slog.New(slog.DiscardHandler))
	for _, tc := range []struct {
		operation string
		wired     bool
	}{
${rows.join('\n')}
	} {
		if !tc.wired {
			t.Errorf("%s: sin caso de uso en UseCases", tc.operation)
		}
	}
}

func TestObserveDejaPasarResultadoYError(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	ping := observe(logger, "Ping", KindQuery, HandlerFunc[string, string](func(_ context.Context, text string) (string, error) {
		return text + "-pong", nil
	}))
	got, err := ping.Handle(t.Context(), "x")
	if err != nil || got != "x-pong" {
		t.Fatalf("Ping = %q, %v; quería x-pong", got, err)
	}
	broken := errors.New("roto")
	fail := observeCommand(logger, "Fail", CommandHandlerFunc[int](func(context.Context, int) error {
		return broken
	}))
	if err := fail.Handle(t.Context(), 1); !errors.Is(err, broken) {
		t.Fatalf("el decorador cambió el error: %v", err)
	}
}${rejected}
`;
}
