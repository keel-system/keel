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

import { repositoryRoots, usesApi, usesDocument } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';
import { statementCountHandler, statementCountOnTransactions, statementCountWiring } from './statement-count.js';
import { repositoryArgs, repositoryParam } from './repositories.js';
import { MESSAGING_IMPORT, usesGoMessaging, usesGoOutbox } from './messaging.js';
import { brokerConnection, brokerFiles, consumes, publishes } from './broker.js';
import { RABBITMQ_IMPORT } from './rabbitmq.js';
import { KAFKA_IMPORT } from './kafka.js';
import { SNSSQS_IMPORT } from './snssqs.js';
import { SERVICE_PARAMETERS, handlersReadParameters, newUseCasesCall, usesDependencies } from './use-cases.js';
import { IDEMPOTENCY_STORE, usesRequestIdempotency } from './request-idempotency.js';
import { usesCallerScope } from '@keel-system/keel-core/gen/features';
import { CALLER_SCOPE } from './caller-scope.js';
import { CALLER_ROLES, SECURITY_IMPORT, settingsFromConfig, usesRoleCheck } from './security.js';
import { securityCases } from '@keel-system/keel-core/gen/api-cases';
import { securityPlan } from '@keel-system/keel-core/gen/features';
import { SCHEDULER_IMPORT, scheduledServices, tasksFunc, usesScheduling } from './scheduling.js';
import { tablePurges } from './purge.js';
import { PARAMETERS_IMPORT, PARAMETERS_VAR, usesServiceParameters } from './service-parameters.js';
import { PAYMENT_IMPORT, PAYMENT_SERVER_WIRING, paymentServerRows, usesGoPayments } from './payments.js';
import { claimDependencies, usesSweepClaims } from './claim.js';
import { usesReconciliationClaims } from './reconciliation-claim.js';
import { CLIENTS_IMPORT, adapterType, clientField, clientParam, clientRemembers, usesGoHttpClients, usesLastKnown } from './http-clients.js';
import { MAIL_SENDER, TEMPLATE_RENDERER, usesGoMail, usesTemplating } from './mail.js';
import { cacheServerRows, cacheServerWiring } from './cache.js';
import { STORAGE_IMPORT, storageServerRows, storageServerWiring } from './storage.js';
import { loggerWiring } from './logging.js';
import { usesTelemetry } from '@keel-system/keel-core/gen/telemetry-vocabulary';
import { MANAGEMENT_LISTEN, MANAGEMENT_SERVER, MANAGEMENT_SHUTDOWN, TELEMETRY_FLUSH, TELEMETRY_START } from './telemetry.js';
import { usesRelational } from '@keel-system/keel-core/gen/features';

// El gauge de las filas del outbox que se rindieron, leído en cada scrape (sin base, el perfil test, no hay relay que
// mirar). NaN si no se puede leer: un cero diría que no hay ninguna.
const DEAD_LETTERED_GAUGE = `
	if database.Enabled {
		observability.RegisterGauge(telemetry.OutboxDeadLettered, "Eventos del outbox que agotaron sus reintentos", func() float64 {
			count, err := relay.CountDeadLettered(ctx)
			if err != nil {
				return math.NaN()
			}
			return float64(count)
		})
	}`;

// La telemetría de cada perfil: el muestreo, el puerto del scrape y el colector.
const TELEMETRY_PROFILE_TESTS = `
func TestLaTelemetriaDeCadaPerfil(t *testing.T) {
	files := only(t, "telemetry.yaml")
	load := func(env map[string]string) telemetry.Settings {
		t.Helper()
		cfg, err := config.Load(files, func(name string) string { return env[name] })
		if err != nil {
			t.Fatal(err)
		}
		settings, err := telemetry.SettingsFrom(cfg)
		if err != nil {
			t.Fatal(err)
		}
		return settings
	}
	production := load(map[string]string{"PROFILE": "production", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://colector:4318/"})
	if production.SamplingProbability != 0.1 || production.ManagementPort != 8081 || !production.ExportEnabled || production.Endpoint != "http://colector:4318" {
		t.Errorf("production = %+v", production)
	}
	test := load(map[string]string{"PROFILE": "test"})
	if test.ExportEnabled || test.ManagementPort != 0 || !test.PrometheusEnabled {
		t.Errorf("test = %+v", test)
	}
}

func TestUnaProporcionFueraDeRangoNoDejaArrancar(t *testing.T) {
	cfg, err := config.Load(only(t, "telemetry.yaml"), func(name string) string {
		return map[string]string{"PROFILE": "develop", "TRACING_SAMPLING_PROBABILITY": "1.5"}[name]
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := telemetry.SettingsFrom(cfg); err == nil {
		t.Error("SettingsFrom aceptó una proporción de 1.5")
	}
}
`;

// La configuración del correo del perfil: un número que no se entiende no deja arrancar.
const MAIL_WIRING = `	mailSettings, err := smtp.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración del correo: %w", err)
	}
`;

export function generate(model) {
  const { server } = layout(model);
  return [
    { path: `${server.dir}/main.go`, content: mainGo(model) },
    { path: `${server.dir}/main_test.go`, content: mainTestGo(model) },
    { path: `${server.dir}/profiles_test.go`, content: profilesTestGo(model) },
    ...(wiresMessaging(model) ? brokerFiles(model) : [])
  ];
}

/** ¿Cablea el arranque la mensajería? Con los repositorios: el puente sale del adaptador de repositorio. */
export function wiresMessaging(model) {
  return usesGoMessaging(model) && usesDependencies(model);
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
      'math',
      'net',
      'net/http',
      'os',
      'os/signal',
      'syscall',
      'time',
      'golang.org/x/sync/errgroup',
      { path: `${configFiles.importPath}`, name: 'configfiles' },
      'internal/application',
      'internal/httpapi',
      'internal/platform/config',
      'internal/platform/health',
      'internal/platform/logging',
      'internal/platform/statements',
      'internal/platform/telemetry',
      SECURITY_IMPORT,
      'database/sql',
      layout(model).store.dir,
      MESSAGING_IMPORT,
      RABBITMQ_IMPORT,
      KAFKA_IMPORT,
      SNSSQS_IMPORT,
      SCHEDULER_IMPORT,
      PARAMETERS_IMPORT,
      CLIENTS_IMPORT,
      layout(model).mail.dir,
      layout(model).cache.dir,
      STORAGE_IMPORT,
      PAYMENT_IMPORT
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
	if len(args) == 1 && args[0] == "healthcheck" {
		return healthcheck(ctx, getenv)
	}
	if len(args) > 0 {
		return fmt.Errorf("subcomando desconocido %q", args[0])
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(configfiles.Files, getenv)
	if err != nil {
		return fmt.Errorf("cargar la configuración: %w", err)
	}
${usesServiceParameters(model) ? parametersWiring(model) : ''}${wiring(model)}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("escuchar en %s: %w", srv.Addr, err)
	}
	logger.InfoContext(ctx, "servidor HTTP escuchando", "address", listener.Addr().String(), "profiles", cfg.Profiles)
${usesTelemetry(model) ? MANAGEMENT_LISTEN : ''}
	group, groupCtx := errgroup.WithContext(ctx)
	group.Go(func() error {
		if err := srv.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("servir HTTP: %w", err)
		}
		return nil
	})${usesTelemetry(model) ? MANAGEMENT_SERVER : ''}${wiresMessaging(model) ? workers(model) : ''}${usesScheduling(model) ? CLOCK_WORKER : ''}
	group.Go(func() error {
		<-groupCtx.Done()
		probes.StartDraining()
		logger.InfoContext(groupCtx, "apagado ordenado", "timeout", cfg.Server.ShutdownTimeout.String())
		// El plazo del apagado no hereda la cancelación que lo disparó.
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(groupCtx), cfg.Server.ShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("apagar el servidor HTTP: %w", err)
		}${usesTelemetry(model) ? MANAGEMENT_SHUTDOWN : ''}
		return nil
	})
	return group.Wait()
}

// healthcheck es el subcomando del HEALTHCHECK de la imagen, que no trae curl ni shell: pregunta a /readyz del servidor
// que corre en este contenedor y sale con 0 si está listo.
func healthcheck(ctx context.Context, getenv func(string) string) error {
	port := getenv("SERVER_PORT")
	if port == "" {
		port = "8080"
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/readyz", nil)
	if err != nil {
		return fmt.Errorf("preparar la sonda: %w", err)
	}
	response, err := (&http.Client{}).Do(request)
	if err != nil {
		return fmt.Errorf("preguntar a /readyz: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("/readyz respondió %d", response.StatusCode)
	}
	return nil
}
`
  });
}

// Los parámetros de despliegue, antes que nada: un valor mal puesto no deja arrancar (el dominio valida sus cotas). Los
// reciben los handlers (en Dependencies) y el rescate que lee su plazo de uno; si nadie los recibe (sin casos de uso
// cableados), se validan igual, sin variable: en Go una sin usar no compila.
function parametersWiring(model) {
  const consumed =
    (handlersReadParameters(model) && dispatchesUseCases(model)) ||
    repositoryRoots(model).some((root) => claimDependencies(model, root).some((dep) => dep.field === 'parameters'));
  if (!consumed) {
    return `	if _, err := parameters.From(cfg); err != nil {
		return fmt.Errorf("parámetros de despliegue: %w", err)
	}
`;
  }
  return `	${PARAMETERS_VAR}, err := parameters.From(cfg)
	if err != nil {
		return fmt.Errorf("parámetros de despliegue: %w", err)
	}
`;
}

/**
 * ¿Despacha alguien por los casos de uso? La entrada HTTP, los listeners o el reloj. Sin ninguno, `useCases` quedaría
 * declarado sin uso, y en Go eso no compila.
 */
function dispatchesUseCases(model) {
  return usesApi(model) || (wiresMessaging(model) && consumes(model)) || usesScheduling(model);
}

// El cableado, de arriba abajo. Cada registro lleva el correlationId de la petición o del mensaje que lo escribe. Con la
// persistencia, antes de servir nada: la conexión (sin base no arranca, salvo el perfil test, que no la tiene), las
// migraciones de goose y un repositorio por agregado sobre las transacciones; y los casos de uso, cableados aquí y solo
// aquí. No depende de la capa api: sin ella (metering-digest) la entrada son los listeners y el reloj, y el servidor HTTP
// solo sirve las sondas.
function wiring(model) {
  const telemetry = usesTelemetry(model);
  const logger = `${telemetry ? TELEMETRY_START : ''}${loggerWiring(model)}${telemetry ? TELEMETRY_FLUSH : ''}`;
  const settings = settingsFromConfig(model);
  const observed = telemetry ? ', observability' : '';
  const handler = usesApi(model) ? `httpapi.NewHandler(probes, useCases, logger${settings ? `, ${settings}` : ''}${observed})` : `httpapi.NewHandler(probes${observed})`;
  const serve = `\tsrv := httpapi.NewServer(cfg.Server, ${statementCountHandler(model, handler)})`;
  if (!usesDependencies(model)) {
    return `${logger}
	probes := &health.Probes{}
${usesApi(model) ? `\tuseCases := ${newUseCasesCall(model, 'logger', undefined, undefined, 'observability')}\n` : ''}${serve}`;
  }
  const { store } = layout(model);
  const repositories = repositoryRoots(model).map((root) => ({
    indent: '\t\t',
    cells: [`${goExported(repositoryParam(root))}:`, `${store.name}.New${root.name}Repository(${repositoryArgs(model, root, 'transactions', 'bridge')}),`]
  }));
  if (usesCallerScope(model)) repositories.push({ indent: '\t\t', cells: [`${CALLER_SCOPE.field}:`, 'security.CallerScope{},'] });
  if (usesRoleCheck(model)) repositories.push({ indent: '\t\t', cells: [`${CALLER_ROLES.field}:`, 'security.CallerRoles{},'] });
  if (usesRequestIdempotency(model)) repositories.push({ indent: '\t\t', cells: [`${IDEMPOTENCY_STORE.field}:`, `${store.name}.NewIdempotencyStore(transactions),`] });
  const clients = usesGoHttpClients(model) && dispatchesUseCases(model);
  if (clients) {
    for (const client of model.httpClients) repositories.push({ indent: '\t\t', cells: [`${clientField(client)}:`, `${clientParam(client)},`] });
  }
  // El correo saliente (capa mail): el adaptador SMTP y, con plantillas, el renderizador.
  const mailing = usesGoMail(model) && dispatchesUseCases(model);
  if (mailing) {
    repositories.push({ indent: '\t\t', cells: [`${MAIL_SENDER.field}:`, telemetry ? 'smtp.Observed(smtp.NewSender(mailSettings, logger), observability),' : 'smtp.NewSender(mailSettings, logger),'] });
    if (usesTemplating(model)) repositories.push({ indent: '\t\t', cells: [`${TEMPLATE_RENDERER.field}:`, 'smtp.NewRenderer(),'] });
  }
  // La pasarela de pago (capa payments): su adaptador, su verificador de avisos y los números del barrido.
  const paying = usesGoPayments(model) && dispatchesUseCases(model);
  if (paying) repositories.push(...paymentServerRows(model));
  // La caché de lectura (use-cases.<op>.cache): el store, si el perfil la habilita.
  const caching = dispatchesUseCases(model) ? cacheServerWiring(model) : '';
  if (caching) repositories.push(...cacheServerRows(model));
  // El almacenamiento de binarios (capa storage): la política de cada bucket y el adaptador S3 que escribe el agente.
  const storing = dispatchesUseCases(model) ? storageServerWiring(model) : '';
  if (storing) repositories.push(...storageServerRows(model));
  if (handlersReadParameters(model) && dispatchesUseCases(model)) {
    repositories.push({ indent: '		', cells: [`${SERVICE_PARAMETERS.field}:`, `${PARAMETERS_VAR},`] });
  }
  const messaging = wiresMessaging(model);
  // La documental (incremento 12) abre un cliente de MongoDB y no tiene tope de transacción.
  const document = usesDocument(model);
  return `${logger}
	database, err := ${store.name}.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la base de datos: %w", err)
	}
	var db ${document ? `*${store.name}.Database` : '*sql.DB'}
	if database.Enabled {
		if db, err = ${store.name}.Open(ctx, database); err != nil {
			return err
		}
		// Lo último en cerrarse: después del apagado del servidor, que ya no la usa.
		defer func() {
			if err := db.Close(${document ? 'ctx' : ''}); err != nil {
				logger.ErrorContext(ctx, "cerrar la base de datos", "error", err)
			}
		}()
		if err := ${store.name}.Migrate(ctx, db, logger); err != nil {
			return err
		}${telemetry && usesRelational(model) ? '\n\t\tobservability.RegisterPool(db.Stats)' : ''}
	}
${statementCountWiring(model)}	transactions := ${store.name}.NewTransactions(db, ${document ? '' : 'database.TransactionTimeout, '}logger)
${statementCountOnTransactions(model)}${usesSweepClaims(model) ? sweepsWiring(store) : ''}${usesReconciliationClaims(model) ? reconciliationWiring(store) : ''}${clients ? clientsWiring(model) : ''}${mailing ? MAIL_WIRING : ''}${caching}${storing}${paying ? PAYMENT_SERVER_WIRING : ''}${messaging ? messagingWiring(model) : ''}
	probes := &health.Probes{}
${dispatchesUseCases(model) ? `\tuseCases := ${newUseCasesCall(model, 'logger', `application.Dependencies{\n${alignRows([{ indent: '\t\t', cells: ['Transactor:', 'transactions,'] }, ...repositories]).join('\n')}\n\t}`, undefined, 'observability')}\n` : ''}${messaging ? listenersWiring(model, store) : ''}${usesScheduling(model) ? schedulingWiring(model, store) : ''}${serve}`;
}

// Los clientes HTTP salientes (incremento 11b): la configuración del perfil (la URL de cada proveedor, obligatoria fuera de
// local, no deja arrancar sin ella), un solo Exchange para todos y un adaptador por puerto, con su circuito.
function clientsWiring(model) {
  const adapters = model.httpClients.map(
    (client) => `	${clientParam(client)}, err := clients.New${adapterType(client)}(clientSettings, exchange, logger${clientRemembers(model, client) ? ', lastKnown' : ''})
	if err != nil {
		return err
	}`
  );
  return `	clientSettings, err := clients.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de los clientes HTTP: %w", err)
	}
	exchange := clients.NewExchange(nil)
${usesTelemetry(model) ? '\texchange.Telemetry = observability\n' : ''}${usesLastKnown(model) ? '	lastKnown := clients.NewLastKnownValues(nil)\n' : ''}${adapters.join('\n')}
`;
}

// Los barridos del perfil (tramo 10c): la cota del lote de cada reclamo y el plazo de cada rescate. Un valor que no es un
// entero positivo no deja arrancar.
function sweepsWiring(store) {
  return `	sweeps, err := ${store.name}.SweepSettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de los barridos: %w", err)
	}
`;
}

// Los barridos de reconciliación del perfil (tramo 11c): el umbral, la caducidad del reclamo y el lote de cada activación.
function reconciliationWiring(store) {
  return `	reconciliation, err := ${store.name}.ReconciliationSettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la reconciliación: %w", err)
	}
`;
}

// El reloj (tramo 10b): las tareas de las operaciones con schedule, que despachan por los casos de uso, y las purgas de
// las tablas del generador, con el SQL del adaptador del motor. Un cron inválido no deja arrancar.
function schedulingWiring(model, store) {
  const lines = [`	schedulingSettings, err := scheduler.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración del reloj: %w", err)
	}
	var tasks []scheduler.Task`];
  for (const { service } of scheduledServices(model)) lines.push(`	tasks = append(tasks, scheduler.${tasksFunc(service)}(useCases)...)`);
  const purges = tablePurges(model);
  if (purges.length > 0) {
    const tasks = purges.map((purge) => `			scheduler.PurgeTask(${JSON.stringify(purge.what)}, purges.${purge.field}, ${store.name}.${purge.constructor}(transactions), logger),`);
    lines.push(`	purges, err := scheduler.PurgeSettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de las purgas: %w", err)
	}
	// Las purgas solo con base: el perfil test no la tiene.
	if database.Enabled {
		tasks = append(tasks,
${tasks.join('\n')}
		)
	}`);
  }
  lines.push(`	clock, err := scheduler.New(schedulingSettings, tasks, logger)
	if err != nil {
		return err
	}`);
  return `${lines.join('\n')}\n`;
}

// El reloj en el errgroup: al cancelarse el contexto no empieza otra pasada y espera a la que está en vuelo, antes de que
// se cierre la base.
const CLOCK_WORKER = `
	group.Go(func() error {
		return clock.Run(groupCtx)
	})`;

// La mensajería en el arranque (incremento 9): la configuración del perfil, los adaptadores del broker que escribe el
// agente (cmd/server/broker.go) y el puente, que necesitan los repositorios. Va antes de los casos de uso.
function messagingWiring(model) {
  const lines = [`
	messagingSettings, err := messaging.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de la mensajería: %w", err)
	}`];
  const connection = brokerConnection(model);
  if (connection) {
    lines.push(`	${connection.name}Settings, err := ${connection.pkg}.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración de ${connection.label}: %w", err)
	}
	// La conexión con el broker: arranca sin él y conecta en segundo plano (su Run va en el errgroup).
	${connection.name} := ${connection.pkg}.New(${connection.name}Settings, messagingSettings, logger)`);
  }
  if (publishes(model)) {
    lines.push(`	adapters, err := brokerAdapters(messagingSettings, ${connection ? `${connection.name}, ` : ''}logger)
	if err != nil {
		return fmt.Errorf("adaptadores del broker: %w", err)
	}`);
    lines.push(usesGoOutbox(model) ? '\tbridge := messaging.NewBridge(messagingSettings)' : '\tbridge := messaging.NewBridge(adapters.Publishers, logger)');
  }
  return `${lines.join('\n')}\n`;
}

// Lo que necesita los casos de uso: el relay del outbox (con el dispatcher del agente o el respaldo) y los listeners.
function listenersWiring(model, store) {
  const lines = [];
  if (usesGoOutbox(model)) {
    lines.push(`	dispatcher := adapters.Dispatcher
	if dispatcher == nil {
		if dispatcher, err = messaging.NewDispatcherFallback(cfg.Profiles, logger); err != nil {
			return err
		}
	}
	relay := messaging.NewRelay(${store.name}.NewOutbox(transactions), dispatcher, *messagingSettings.OutboxRelay, logger)${usesTelemetry(model) ? DEAD_LETTERED_GAUGE : ''}`);
  }
  if (consumes(model)) {
    const connection = brokerConnection(model);
    const fields = alignRows([
      { indent: '\t\t', cells: ['Settings:', 'messagingSettings,'] },
      ...(connection ? [{ indent: '\t\t', cells: [`${connection.field}:`, `${connection.name},`] }] : []),
      { indent: '\t\t', cells: ['UseCases:', 'useCases,'] },
      { indent: '\t\t', cells: ['Guard:', `messaging.NewIdempotencyGuard(${store.name}.NewProcessedEvents(transactions), logger),`] },
      { indent: '\t\t', cells: ['Logger:', 'logger,'] },
      ...(usesTelemetry(model) ? [{ indent: '\t\t', cells: ['Telemetry:', 'observability,'] }] : [])
    ]);
    lines.push(`	listeners, err := messageListeners(inbound{
${fields.join('\n')}
	})
	if err != nil {
		return fmt.Errorf("listeners de las suscripciones: %w", err)
	}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// Las goroutines de la mensajería en el errgroup: la conexión con el broker, el relay (solo con base: el perfil test no
// la tiene) y un listener por consumidor. Todos paran al cancelarse el contexto del grupo.
function workers(model) {
  const parts = [];
  const connection = brokerConnection(model);
  if (connection) {
    parts.push(`
	group.Go(func() error {
		return ${connection.name}.Run(groupCtx)
	})`);
  }
  if (usesGoOutbox(model)) {
    parts.push(`
	if database.Enabled {
		group.Go(func() error {
			return relay.Run(groupCtx)
		})
	}`);
  }
  if (consumes(model)) {
    parts.push(`
	for _, listen := range listeners {
		group.Go(func() error {
			return listen(groupCtx)
		})
	}`);
  }
  return parts.join('');
}

function mainTestGo(model) {
  const { server } = layout(model);
  return packageFile(model, server, {
    imports: ['bufio', 'context', 'errors', 'io', 'net', 'net/http', 'strings', 'testing', 'time'],
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
		// El perfil de la prueba escribe texto: «… servidor HTTP escuchando address=127.0.0.1:1234 profiles=[…]».
		if _, rest, ok := strings.Cut(lines.Text(), "servidor HTTP escuchando address="); ok {
			address, _, _ = strings.Cut(rest, " ")
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
	${unknownPathCheck(model)}

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

func TestHealthcheckPreguntaAReadyz(t *testing.T) {
	address, done, cancel := started(t, map[string]string{${usesDependencies(model) ? '"PROFILE": "test"' : ''}})
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("dirección %q: %v", address, err)
	}
	env := func(name string) string { return map[string]string{"SERVER_PORT": port}[name] }
	if err := run(t.Context(), []string{"healthcheck"}, env, io.Discard); err != nil {
		t.Errorf("healthcheck con el servidor listo = %v", err)
	}
	cancel()
	<-done
	if err := run(t.Context(), []string{"healthcheck"}, env, io.Discard); err == nil {
		t.Error("healthcheck con el servidor parado salió bien")
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

/**
 * La configuración EMITIDA de cada perfil, leída con el cargador del servicio. Solo application.yaml y los fragmentos que
 * se miden: production exige las variables de las demás capas.
 */
function profilesTestGo(model) {
  const { server, configFiles } = layout(model);
  const telemetry = usesTelemetry(model);
  return packageFile(model, server, {
    imports: ['io/fs', 'log/slog', 'testing', 'testing/fstest', { path: `${configFiles.importPath}`, name: 'configfiles' }, 'internal/platform/config', 'internal/platform/logging', ...(telemetry ? ['internal/platform/telemetry'] : [])],
    body: `
// only es la configuración embebida con solo application.yaml y el fragmento name de cada perfil.
func only(t *testing.T, name string) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	for _, file := range []string{"application.yaml", "parameters/local/" + name, "parameters/develop/" + name, "parameters/production/" + name, "parameters/test/" + name} {
		data, err := fs.ReadFile(configfiles.Files, file)
		if err != nil {
			t.Fatalf("leer %s: %v", file, err)
		}
		files[file] = &fstest.MapFile{Data: data}
	}
	return files
}

func TestLosLogsDeCadaPerfil(t *testing.T) {
	files := only(t, "logging.yaml")
	for profile, want := range map[string]logging.Settings{
		"local":      {Format: logging.FormatText, RootLevel: slog.LevelInfo, AppLevel: slog.LevelDebug},
		"test":       {Format: logging.FormatText, RootLevel: slog.LevelInfo, AppLevel: slog.LevelDebug},
		"develop":    {Format: logging.FormatECS, RootLevel: slog.LevelInfo, AppLevel: slog.LevelDebug},
		"production": {Format: logging.FormatECS, RootLevel: slog.LevelWarn, AppLevel: slog.LevelInfo},
	} {
		cfg, err := config.Load(files, func(name string) string { return map[string]string{"PROFILE": profile}[name] })
		if err != nil {
			t.Fatalf("%s: %v", profile, err)
		}
		got, err := logging.SettingsFrom(cfg)
		if err != nil {
			t.Fatalf("%s: %v", profile, err)
		}
		if got.Format != want.Format || got.RootLevel != want.RootLevel || got.AppLevel != want.AppLevel {
			t.Errorf("%s = %+v, quiero %+v", profile, got, want)
		}
		if want.Format == logging.FormatECS && (got.ServiceName == "" || got.Version == "" || got.Environment == "" || got.NodeName == "") {
			t.Errorf("%s: faltan los campos service.* de la línea ECS: %+v", profile, got)
		}
	}
}

func TestLogFormatCambiaElFormato(t *testing.T) {
	cfg, err := config.Load(only(t, "logging.yaml"), func(name string) string {
		return map[string]string{"PROFILE": "develop", "LOG_FORMAT": "text"}[name]
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := logging.SettingsFrom(cfg); err != nil || got.Format != logging.FormatText {
		t.Errorf("LOG_FORMAT=text = %+v, %v", got, err)
	}
}

func TestUnNivelQueNoExisteNoDejaArrancar(t *testing.T) {
	cfg, err := config.Load(only(t, "logging.yaml"), func(name string) string {
		return map[string]string{"PROFILE": "develop", "LOG_LEVEL_APP": "VERBOSE"}[name]
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := logging.SettingsFrom(cfg); err == nil {
		t.Error("SettingsFrom aceptó un nivel que no existe")
	}
}
${telemetry ? TELEMETRY_PROFILE_TESTS : ''}`
  });
}

/**
 * Un camino que no existe: 404, o 401 si la seguridad cierra la API (decide antes de enrutar, como Spring Security). El
 * plan de keel-core dice cuál, con el mismo caso que la prueba emitida de la API.
 */
function unknownPathCheck(model) {
  const closed = Boolean(securityCases(model, securityPlan(model))?.protectedPath);
  const [constant, code] = closed ? ['StatusUnauthorized', 401] : ['StatusNotFound', 404];
  return `if code, _ := getStatus(t, "http://"+address+"/no-existe"); code != http.${constant} {
		t.Errorf("GET /no-existe = %d, quiero ${code}", code)
	}`;
}
