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
import { repositoryOf, repositoryRoots, usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { portName, repositoryParam } from './repositories.js';

/** ¿Reciben los casos de uso adaptadores (Dependencies)? Con la persistencia relacional. */
export function usesDependencies(model) {
  return usesRelational(model) && repositoryRoots(model).length > 0;
}

/** Lo que recibe el constructor del handler de una operación: el repositorio de su agregado y, si despacha, UseCases. */
export function handlerArgs(model, operation, repository) {
  const args = [];
  const root = usesDependencies(model) ? repositoryOf(model, operation) : null;
  if (root) args.push(repository(root));
  if ((operation.dispatches ?? []).length > 0) args.push('uc');
  return args;
}

/** La llamada a NewUseCases con un logger y, si hacen falta, unas Dependencies (`deps`, o vacías en las pruebas). */
export function newUseCasesCall(model, logger, deps = 'application.Dependencies{}', prefix = 'application.') {
  return `${prefix}NewUseCases(${logger}${usesDependencies(model) ? `, ${deps}` : ''})`;
}

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
    file('use_cases', useCasesBody(model, ops), ['log/slog', 'internal/domain']),
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

// Transactor abre la transacción de un caso de uso: de solo lectura para una consulta y de escritura para un comando.
// Lo implementa el adaptador de persistencia, y los repositorios se unen a la transacción que viaja en el contexto sin
// verla. Si fn devuelve un error, la transacción revierte.
type Transactor interface {
	Within(ctx context.Context, kind MessageKind, fn func(ctx context.Context) error) error
}

// noTransaction es el Transactor de un servicio sin persistencia: ejecuta el caso de uso tal cual.
type noTransaction struct{}

// Within llama a fn.
func (noTransaction) Within(ctx context.Context, _ MessageKind, fn func(ctx context.Context) error) error {
	return fn(ctx)
}

// withoutTransactionKey marca un contexto despachado sin transacción abarcadora.
type withoutTransactionKey struct{}

// WithoutTransaction devuelve ctx marcado para que el caso de uso que se despache con él NO se una a la transacción
// abierta ni abra una propia: cada escritura de sus repositorios confirma la suya. Es para despachar un caso de uso que
// hace E/S externa (un correo, una llamada a un proveedor) sin retener la transacción ni la conexión mientras espera.
func WithoutTransaction(ctx context.Context) context.Context {
	return context.WithValue(ctx, withoutTransactionKey{}, true)
}

// TransactionDetached dice si ctx viene de WithoutTransaction. Lo consulta el adaptador de persistencia.
func TransactionDetached(ctx context.Context) bool {
	detached, _ := ctx.Value(withoutTransactionKey{}).(bool)
	return detached
}

// observe envuelve un caso de uso con su TRANSACCIÓN y su LOG DE FRONTERA. Todas las operaciones pasan por aquí —las
// peticiones HTTP, los barridos programados y los mensajes consumidos—, así que es el único sitio que los pone:
// operación, resultado y duración. Solo nombres y códigos, nunca los valores del mensaje, que lleva datos de quien
// llama. El log va FUERA de la transacción: cuenta lo que vio el cliente, confirmación incluida.
func observe[M, R any](logger *slog.Logger, tx Transactor, operation string, kind MessageKind, next Handler[M, R]) Handler[M, R] {
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		started := time.Now()
		var result R
		err := tx.Within(ctx, kind, func(ctx context.Context) error {
			var err error
			result, err = next.Handle(ctx, msg)
			return err
		})
		logOutcome(ctx, logger, operation, kind, started, err)
		if err != nil {
			// Lo que el caso de uso devolvió antes de que la transacción fallara no se confirmó: no sale.
			var zero R
			return zero, err
		}
		return result, nil
	})
}

// observeCommand es observe para un comando sin resultado.
func observeCommand[M any](logger *slog.Logger, tx Transactor, operation string, next CommandHandler[M]) CommandHandler[M] {
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		started := time.Now()
		err := tx.Within(ctx, KindCommand, func(ctx context.Context) error {
			return next.Handle(ctx, cmd)
		})
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
  const roots = repositoryRoots(model);
  const persistent = usesDependencies(model);
  const wiring = ops.map((operation) => {
    const contract = contractOf(operation);
    const handler = `New${handlerType(operation)}(${handlerArgs(model, operation, (root) => `deps.${goExported(repositoryParam(root))}`).join(', ')})`;
    const name = goString(messageType(operation));
    return contract.kind === 'KindCommand'
      ? `\tuc.${useCaseField(operation)} = observeCommand(logger, tx, ${name}, ${handler})`
      : `\tuc.${useCaseField(operation)} = observe(logger, tx, ${name}, ${contract.kind}, ${handler})`;
  });
  const dependencies = persistent
    ? `
// Dependencies son los adaptadores que reciben los casos de uso: la transacción y el repositorio de cada agregado.
// Los construye el arranque (cmd/server) y solo él.
type Dependencies struct {
${alignRows([
  { text: '\t// Transactor abre la transacción de cada caso de uso; nil, ninguna (las pruebas sin base).' },
  { indent: '\t', cells: ['Transactor', 'Transactor'] },
  ...roots.flatMap((root) => [
    { text: `\t// ${goExported(repositoryParam(root))} es el repositorio del agregado ${root.name}.` },
    { indent: '\t', cells: [goExported(repositoryParam(root)), `domain.${portName(root)}`] }
  ])
]).join('\n')}
}
`
    : '';
  const prelude = persistent
    ? `	var tx Transactor = noTransaction{}
	if deps.Transactor != nil {
		tx = deps.Transactor
	}
`
    : '	tx := noTransaction{}\n';
  return `${dependencies}
// UseCases son los casos de uso del servicio, uno por operación del diseño, ya envueltos con su transacción y su log
// de frontera. Es la ÚNICA puerta de despacho: la API, los consumidores y el reloj llaman a un campo de aquí, nunca a
// un handler. Cada campo está tipado con su mensaje y su resultado, así que un mensaje no puede llegar a otro caso de
// uso: lo impide el compilador, no una tabla en tiempo de ejecución.
type UseCases struct {
${alignRows(fieldRows).join('\n')}
}

// NewUseCases cablea cada operación con su handler. Es el registro explícito de los casos de uso y lo genera
// build: lo que no está aquí no se despacha. Un handler que despacha otra operación (use-cases.dispatches)
// recibe el propio UseCases, ya completo cuando se le llama.
func NewUseCases(${persistent ? 'logger *slog.Logger, deps Dependencies' : 'logger *slog.Logger'}) *UseCases {
${prelude}	uc := &UseCases{}
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
	handler := observeCommand(logger, noTransaction{}, "Refuse", CommandHandlerFunc[string](func(context.Context, string) error {
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
	uc := ${newUseCasesCall(model, 'slog.New(slog.DiscardHandler)', 'Dependencies{}', '')}
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
	ping := observe(logger, noTransaction{}, "Ping", KindQuery, HandlerFunc[string, string](func(_ context.Context, text string) (string, error) {
		return text + "-pong", nil
	}))
	got, err := ping.Handle(t.Context(), "x")
	if err != nil || got != "x-pong" {
		t.Fatalf("Ping = %q, %v; quería x-pong", got, err)
	}
	broken := errors.New("roto")
	fail := observeCommand(logger, noTransaction{}, "Fail", CommandHandlerFunc[int](func(context.Context, int) error {
		return broken
	}))
	if err := fail.Handle(t.Context(), 1); !errors.Is(err, broken) {
		t.Fatalf("el decorador cambió el error: %v", err)
	}
}${rejected}
`;
}
