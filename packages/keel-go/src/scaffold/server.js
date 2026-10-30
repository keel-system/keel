// El arranque del servicio (`cmd/server`): `main` solo llama a `run` y convierte su error en el código de
// salida; `run` carga la configuración, cablea el servicio a mano y gobierna su ciclo de vida.
//
// Es la forma que hace probable el arranque entero (PLAN-KEEL-GO.md § 2): `run` recibe el contexto, los
// argumentos, las variables de entorno y la salida en vez de leerlos del proceso, así que la prueba emitida lo
// arranca en un puerto libre, le pide las sondas y lo apaga cancelando el contexto. Sin contenedor de
// inyección: el cableado se lee de arriba abajo.
//
// El orden es el de los otros tres servidores: la configuración se carga y se valida ANTES de crear nada, así
// que una variable obligatoria sin valor deja el proceso parado con la lista de las que faltan. Y el apagado
// ordenado tiene orden fijo (§ 3.5): /readyz pasa a 503 → el servidor deja de aceptar conexiones y espera a
// las peticiones en vuelo como máximo `server.shutdown-timeout`. Lo que llegue con las capas siguientes
// (consumidores, reloj, relay del outbox) se para entre esos pasos, cada uno en su goroutine del errgroup.

import { repositoryRoots, usesApi } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { repositoryParam } from './repositories.js';
import { newUseCasesCall, usesDependencies } from './use-cases.js';

export function generate(model) {
  const { server } = layout(model);
  return [
    { path: `${server.dir}/main.go`, content: mainGo(model) },
    { path: `${server.dir}/main_test.go`, content: mainTestGo(model) }
  ];
}

function mainGo(model) {
  const { server, configFiles } = layout(model);
  return packageFile(model, server, {
    doc: `Command server arranca el servicio ${model.service.name}.`,
    imports: [
      'context',
      'errors',
      'fmt',
      'io',
      'log/slog',
      'net',
      'net/http',
      'os',
      'os/signal',
      'syscall',
      'golang.org/x/sync/errgroup',
      { path: `${configFiles.importPath}`, name: 'configfiles' },
      'internal/application',
      'internal/httpapi',
      'internal/platform/config',
      'internal/platform/correlation',
      'internal/platform/health',
      'database/sql',
      layout(model).store.dir
    ],
    body: `
func main() {
	if err := run(context.Background(), os.Args[1:], os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run arranca el servicio y lo mantiene hasta que ctx se cancela o llega SIGINT o SIGTERM; entonces lo apaga
// en orden y devuelve. Todo lo del proceso le llega por parámetro, para poder arrancarlo en una prueba.
func run(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer) error {
	if len(args) > 0 {
		return fmt.Errorf("subcomando desconocido %q", args[0])
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(configfiles.Files, getenv)
	if err != nil {
		return fmt.Errorf("cargar la configuración: %w", err)
	}
${usesApi(model) ? apiWiring(model) : PROBES_WIRING}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("escuchar en %s: %w", srv.Addr, err)
	}
	logger.InfoContext(ctx, "servidor HTTP escuchando", "address", listener.Addr().String(), "profiles", cfg.Profiles)

	group, groupCtx := errgroup.WithContext(ctx)
	group.Go(func() error {
		if err := srv.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("servir HTTP: %w", err)
		}
		return nil
	})
	group.Go(func() error {
		<-groupCtx.Done()
		probes.StartDraining()
		logger.InfoContext(groupCtx, "apagado ordenado", "timeout", cfg.Server.ShutdownTimeout.String())
		// El plazo del apagado no hereda la cancelación que lo disparó.
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(groupCtx), cfg.Server.ShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("apagar el servidor HTTP: %w", err)
		}
		return nil
	})
	return group.Wait()
}
`
  });
}

const PROBES_WIRING = `	logger := slog.New(slog.NewJSONHandler(stdout, nil))

	probes := &health.Probes{}
	srv := httpapi.NewServer(cfg.Server, httpapi.NewHandler(probes))`;

// Con la API: cada registro lleva el correlationId de la petición que lo escribe, y la entrada despacha por los casos
// de uso, cableados aquí y solo aquí. Con la persistencia, antes de servir nada: la conexión (sin base no arranca, salvo
// el perfil test, que no la tiene), las migraciones de goose y un repositorio por agregado sobre las transacciones.
function apiWiring(model) {
  const logger = '\tlogger := slog.New(correlation.NewLogHandler(slog.NewJSONHandler(stdout, nil)))\n';
  const serve = '\tsrv := httpapi.NewServer(cfg.Server, httpapi.NewHandler(probes, useCases, logger))';
  if (!usesDependencies(model)) {
    return `${logger}
	probes := &health.Probes{}
	useCases := ${newUseCasesCall(model, 'logger')}
${serve}`;
  }
  const { store } = layout(model);
  const repositories = repositoryRoots(model).map((root) => ({ indent: '\t\t', cells: [`${goExported(repositoryParam(root))}:`, `${store.name}.New${root.name}Repository(transactions),`] }));
  return `${logger}
	database, err := ${store.name}.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la base de datos: %w", err)
	}
	var db *sql.DB
	if database.Enabled {
		if db, err = ${store.name}.Open(ctx, database); err != nil {
			return err
		}
		// Lo último en cerrarse: después del apagado del servidor, que ya no la usa.
		defer func() {
			if err := db.Close(); err != nil {
				logger.ErrorContext(ctx, "cerrar la base de datos", "error", err)
			}
		}()
		if err := ${store.name}.Migrate(ctx, db, logger); err != nil {
			return err
		}
	}
	transactions := ${store.name}.NewTransactions(db, database.TransactionTimeout, logger)

	probes := &health.Probes{}
	useCases := ${newUseCasesCall(model, 'logger', `application.Dependencies{\n${alignRows([{ indent: '\t\t', cells: ['Transactor:', 'transactions,'] }, ...repositories]).join('\n')}\n\t}`)}
${serve}`;
}

function mainTestGo(model) {
  const { server } = layout(model);
  return packageFile(model, server, {
    imports: ['bufio', 'context', 'encoding/json', 'errors', 'io', 'net/http', 'strings', 'testing', 'time'],
    body: `
// El arranque entero, sin señales: SIGTERM no llega en Windows, y cancelar el contexto recorre el mismo camino.

// started arranca run en un puerto libre y devuelve su dirección, su error final y cómo pararlo.
func started(t *testing.T, env map[string]string) (string, <-chan error, context.CancelFunc) {
	t.Helper()
	env["SERVER_PORT"] = "0"
	env["SERVER_ADDRESS"] = "127.0.0.1"
	ctx, cancel := context.WithCancel(t.Context())
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, nil, func(name string) string { return env[name] }, writer)
		// Cerrar el escritor termina la lectura de los logs.
		_ = writer.Close()
	}()

	lines := bufio.NewScanner(reader)
	address := ""
	for address == "" && lines.Scan() {
		var entry struct {
			Msg     string
			Address string
		}
		if err := json.Unmarshal(lines.Bytes(), &entry); err == nil && entry.Msg == "servidor HTTP escuchando" {
			address = entry.Address
		}
	}
	if address == "" {
		cancel()
		t.Fatalf("el servidor no llegó a escuchar: %v", <-done)
	}
	// El resto de los logs se sigue leyendo, o el servidor se bloquearía al escribirlos.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, reader)
	}()
	t.Cleanup(func() {
		cancel()
		<-drained
	})
	return address, done, cancel
}

func getStatus(t *testing.T, url string) (int, string) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("petición %s: %v", url, err)
	}
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("leer %s: %v", url, err)
	}
	return response.StatusCode, strings.TrimSpace(string(body))
}

func TestRunServesProbesAndStopsInOrder(t *testing.T) {
	address, done, cancel := started(t, map[string]string{${usesDependencies(model) ? '"PROFILE": "test"' : ''}})
	for _, path := range []string{"/livez", "/readyz"} {
		if code, body := getStatus(t, "http://"+address+path); code != http.StatusOK || body != \`{"status":"UP"}\` {
			t.Errorf("GET %s = %d %s, quiero 200 {\\"status\\":\\"UP\\"}", path, code, body)
		}
	}
	if code, _ := getStatus(t, "http://"+address+"/no-existe"); code != http.StatusNotFound {
		t.Errorf("GET /no-existe = %d, quiero 404", code)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("run terminó con %v, quiero un apagado limpio", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run no terminó tras cancelar el contexto")
	}
}

func TestRunRefusesAnInvalidConfiguration(t *testing.T) {
	err := run(t.Context(), nil, func(name string) string {
		return map[string]string{"SERVER_PORT": "no-es-un-puerto"}[name]
	}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "server.port") {
		t.Errorf("run = %v, quiero el error de server.port", err)
	}
}

func TestRunRefusesAnUnknownSubcommand(t *testing.T) {
	err := run(t.Context(), []string{"migrate"}, func(string) string { return "" }, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "migrate") {
		t.Errorf("run = %v, quiero el error del subcomando", err)
	}
}
`
  });
}
