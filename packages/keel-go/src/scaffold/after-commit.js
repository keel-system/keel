// «Después de confirmar»: el asentamiento de cada caso de uso, y `afterCommit`, la vía del handler para programar un efecto
// que SALE del proceso (borrar un binario, avisar a un proveedor) para cuando su transacción haya confirmado.
//
// Es el gemelo del `IAfterCommit` de keel-dotnet y del `AfterCommit` de keel-spring y keel-nest. keel-go solo tenía el
// asentamiento con caché, sin nombrar en ninguna doc, y su corrida de catalog (2026-11-02) no pudo cumplir la regla «el
// binario se borra tras confirmar» de `removeProductImage`. Sin esta vía queda hacerlo dentro de la transacción, y si la
// escritura revierte la imagen sigue en la fila y ya sin binario.
//
// En Go no hace falta un puerto: el handler y `settle` viven en el mismo paquete, y lo que `afterCommit` llama no cruza
// ninguna capa. El efecto no devuelve su fallo al llamante: la transacción ya no existe y no hay nada que deshacer, así
// que se registra. Y corre con el contexto sin cancelar: que el cliente cuelgue tras el commit no le quita lo confirmado.

import { applicationPath, layout, packageFile } from './render.js';
import { usesCache } from './cache.js';
import { usesDependencies } from './use-cases.js';

/** ¿Hay asentamiento? Con persistencia (hay transacción que esperar) o con caché (hay vaciados que esperar). */
export function usesAfterCommit(model) {
  return usesDependencies(model) || usesCache(model);
}

export function generate(model) {
  if (!usesAfterCommit(model)) return [];
  const { application } = layout(model);
  return [
    { path: applicationPath(model, 'after_commit'), content: packageFile(model, application, { imports: ['context', 'log/slog', 'sync'], body: AFTER_COMMIT_BODY }) },
    {
      path: applicationPath(model, 'after_commit').replace(/\.go$/, '_test.go'),
      content: packageFile(model, application, { imports: ['bytes', 'context', 'errors', 'log/slog', 'strings', 'testing'], body: AFTER_COMMIT_TEST })
    }
  ];
}

const AFTER_COMMIT_BODY = `
// afterCommit programa un efecto que sale del proceso (borrar un binario, avisar a un proveedor) para DESPUÉS de que
// confirme la transacción del caso de uso. Es la herramienta de una regla del diseño que dice «después de confirmar»:
// dentro de la transacción, la copia que revierte ya habría borrado el binario. Si el caso de uso falla, el efecto no
// ocurre nunca; sin caso de uso en curso, o despachado con WithoutTransaction, ocurre ya, antes de volver. Termina antes
// de que se devuelva la respuesta. Su fallo se registra y no deshace lo confirmado.
func afterCommit(ctx context.Context, effect func(context.Context) error) {
	// Se toma ahora: el efecto corre ya fuera del caso de uso, con el contexto de quien lo envolvió.
	logger := useCaseLogger(ctx)
	afterUseCase(ctx, func(ctx context.Context) {
		// Lo confirmado no depende de que el cliente siga esperando.
		ctx = context.WithoutCancel(ctx)
		if err := effect(ctx); err != nil {
			logger.ErrorContext(ctx, "after-commit effect failed", "error", err)
		}
	})
}

// settlement es lo que espera a que termine bien el caso de uso que abrió la transacción.
type settlement struct {
	logger  *slog.Logger
	mu      sync.Mutex
	pending []func(context.Context)
}

// settlementKey es la clave del asentamiento del caso de uso en curso.
type settlementKey struct{}

// useCaseLogger es el logger del servicio para el caso de uso en curso: el que un handler usa para registrar, con el JSON y la
// correlación que no tiene el slog global. Sin caso de uso en curso, el del proceso.
func useCaseLogger(ctx context.Context) *slog.Logger {
	if s, _ := ctx.Value(settlementKey{}).(*settlement); s != nil {
		return s.logger
	}
	return slog.Default()
}

// openSettlement es el asentamiento del caso de uso en curso, o nil. Uno despachado con WithoutTransaction no tiene: sus
// escrituras confirman solas, y lo que espere a ellas puede ir ya.
func openSettlement(ctx context.Context) *settlement {
	if TransactionDetached(ctx) {
		return nil
	}
	s, _ := ctx.Value(settlementKey{}).(*settlement)
	return s
}

// afterUseCase ejecuta fn cuando termine bien el caso de uso en curso, o ya si no hay ninguno.
func afterUseCase(ctx context.Context, fn func(context.Context)) {
	if s := openSettlement(ctx); s != nil {
		s.mu.Lock()
		s.pending = append(s.pending, fn)
		s.mu.Unlock()
		return
	}
	fn(ctx)
}

// settle envuelve un caso de uso ya observado (con su transacción) para que lo que espera a su commit —los afterCommit de
// su handler, y con caché el vaciado que invalida, onCommit, y sus Evict y Clear— se ejecute cuando termine bien. Si lo
// despachó otro caso de uso dentro de su transacción, pasa a esperar al de fuera, que es quien confirma; si falla, no se
// ejecuta nada.
func settle[M, R any](logger *slog.Logger, next Handler[M, R], onCommit ...func(context.Context)) Handler[M, R] {
	return HandlerFunc[M, R](func(ctx context.Context, msg M) (R, error) {
		own := &settlement{logger: logger}
		result, err := next.Handle(context.WithValue(ctx, settlementKey{}, own), msg)
		if err != nil {
			return result, err
		}
		settled(ctx, own, onCommit)
		return result, nil
	})
}

// settleCommand es settle para un comando sin resultado.
func settleCommand[M any](logger *slog.Logger, next CommandHandler[M], onCommit ...func(context.Context)) CommandHandler[M] {
	return CommandHandlerFunc[M](func(ctx context.Context, cmd M) error {
		own := &settlement{logger: logger}
		if err := next.Handle(context.WithValue(ctx, settlementKey{}, own), cmd); err != nil {
			return err
		}
		settled(ctx, own, onCommit)
		return nil
	})
}

// settled entrega lo pendiente de un caso de uso que terminó bien: al de fuera, si lo hay, o lo ejecuta.
func settled(ctx context.Context, own *settlement, onCommit []func(context.Context)) {
	own.mu.Lock()
	pending := append(own.pending, onCommit...)
	own.mu.Unlock()
	for _, fn := range pending {
		afterUseCase(ctx, fn)
	}
}
`;

const AFTER_COMMIT_TEST = `
// probeLogger no escribe: las pruebas que no miran el log.
var probeLogger = slog.New(slog.DiscardHandler)

// probeEffect es un efecto que cuenta sus ejecuciones.
func probeEffect(runs *int, err error) func(context.Context) error {
	return func(context.Context) error {
		*runs++
		return err
	}
}

func TestAfterCommitEsperaAQueElCasoDeUsoTermineBien(t *testing.T) {
	runs, during := 0, 0
	handler := settleCommand(probeLogger, CommandHandlerFunc[string](func(ctx context.Context, _ string) error {
		afterCommit(ctx, probeEffect(&runs, nil))
		during = runs
		return nil
	}))
	if err := handler.Handle(t.Context(), "bien"); err != nil {
		t.Fatal(err)
	}
	if during != 0 || runs != 1 {
		t.Fatalf("durante el caso de uso corrió %d veces y al terminar %d (quería 0 y 1)", during, runs)
	}
}

func TestAfterCommitNoOcurreSiElCasoDeUsoFalla(t *testing.T) {
	runs := 0
	command := settleCommand(probeLogger, CommandHandlerFunc[string](func(ctx context.Context, _ string) error {
		afterCommit(ctx, probeEffect(&runs, nil))
		return errors.New("revierte")
	}))
	if err := command.Handle(t.Context(), "falla"); err == nil {
		t.Fatal("el comando tenía que fallar")
	}
	query := settle(probeLogger, HandlerFunc[string, string](func(ctx context.Context, _ string) (string, error) {
		afterCommit(ctx, probeEffect(&runs, nil))
		return "", errors.New("revierte")
	}))
	if _, err := query.Handle(t.Context(), "falla"); err == nil {
		t.Fatal("la consulta tenía que fallar")
	}
	if runs != 0 {
		t.Fatalf("un caso de uso que revierte ejecutó su efecto %d veces", runs)
	}
}

func TestAfterCommitEsperaAlCasoDeUsoDeFuera(t *testing.T) {
	runs := 0
	inner := settleCommand(probeLogger, CommandHandlerFunc[string](func(ctx context.Context, _ string) error {
		afterCommit(ctx, probeEffect(&runs, nil))
		return nil
	}))
	outer := settleCommand(probeLogger, CommandHandlerFunc[string](func(ctx context.Context, cmd string) error {
		if err := inner.Handle(ctx, cmd); err != nil {
			return err
		}
		if runs != 0 {
			t.Errorf("el efecto del despachado corrió dentro de la transacción de fuera")
		}
		if cmd == "falla" {
			return errors.New("revierte")
		}
		return nil
	}))
	if err := outer.Handle(t.Context(), "falla"); err == nil || runs != 0 {
		t.Fatalf("el de fuera revierte: err %v, %d ejecuciones (quería 0)", err, runs)
	}
	if err := outer.Handle(t.Context(), "bien"); err != nil || runs != 1 {
		t.Fatalf("el de fuera confirma: err %v, %d ejecuciones (quería 1)", err, runs)
	}
}

func TestUseCaseLoggerEsElDelCasoDeUso(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := settleCommand(logger, CommandHandlerFunc[string](func(ctx context.Context, msg string) error {
		useCaseLogger(ctx).WarnContext(ctx, msg)
		// Despachado sin transacción abarcadora sigue siendo el suyo: no hay asentamiento abierto, pero sí logger.
		useCaseLogger(WithoutTransaction(ctx)).WarnContext(ctx, msg+"-sin-transaccion")
		return nil
	}))
	if err := handler.Handle(t.Context(), "aviso"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"\\"aviso\\"", "\\"aviso-sin-transaccion\\""} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("falta %s en el log del caso de uso: %q", want, logs.String())
		}
	}
}

func TestAfterCommitSinTransaccionOcurreYa(t *testing.T) {
	runs := 0
	afterCommit(t.Context(), probeEffect(&runs, nil))
	if runs != 1 {
		t.Fatalf("sin caso de uso en curso corrió %d veces (quería 1)", runs)
	}
	detached := settleCommand(probeLogger, CommandHandlerFunc[string](func(ctx context.Context, _ string) error {
		afterCommit(WithoutTransaction(ctx), probeEffect(&runs, nil))
		if runs != 2 {
			t.Errorf("con WithoutTransaction corrió %d veces (quería 2)", runs)
		}
		return nil
	}))
	if err := detached.Handle(t.Context(), "bien"); err != nil || runs != 2 {
		t.Fatalf("despachado con WithoutTransaction: err %v, %d ejecuciones (quería 2)", err, runs)
	}
}

func TestAfterCommitNoDependeDelClienteNiDeshaceNada(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	var seen error
	var logs bytes.Buffer
	handler := settleCommand(slog.New(slog.NewJSONHandler(&logs, nil)), CommandHandlerFunc[string](func(ctx context.Context, _ string) error {
		afterCommit(ctx, func(ctx context.Context) error {
			seen = ctx.Err()
			return errors.New("el almacén no responde")
		})
		cancel()
		return nil
	}))
	if err := handler.Handle(ctx, "bien"); err != nil {
		t.Fatalf("el fallo del efecto llegó al caso de uso, que ya confirmó: %v", err)
	}
	if seen != nil {
		t.Fatalf("el efecto corrió con el contexto cancelado: %v", seen)
	}
	if !strings.Contains(logs.String(), "el almacén no responde") {
		t.Fatalf("el fallo del efecto no llegó al log del caso de uso: %q", logs.String())
	}
}
`;
