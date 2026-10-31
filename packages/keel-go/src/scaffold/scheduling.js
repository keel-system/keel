// Lo que corre por RELOJ (tramo 10b): las operaciones con `schedule` del diseño y las purgas de las tablas del generador.
//
// Es el `@Scheduled` de keel-spring, el `Scheduling` de keel-nest y el BackgroundService de keel-dotnet, dicho en Go: un
// paquete `scheduler` en la infraestructura (un adaptador de ENTRADA, como httpapi: despacha por los casos de uso) con
// el PARSER de robfig/cron para el cron de seis campos y un bucle propio:
//
//   · `Scheduler.Run` corre cada tarea en su goroutine y va en el errgroup del arranque. La siguiente ocurrencia se
//     calcula AL TERMINAR la pasada, así que un tick que llega con la anterior en curso se salta (lo que hacen el
//     @Scheduled de Spring y el `waitForCompletion` de keel-nest). Al apagar no se corta la pasada en vuelo: corre sin
//     la cancelación y `Run` la espera antes de devolver, así que la base se cierra después. Lo conmuta
//     `scheduling.enabled`, apagado en el perfil `test`, que no tiene base de datos.
//   · `<Grupo>Tasks` por grupo de operaciones con `schedule`: el segundo de arranque y si se despacha con la transacción
//     del caso de uso o sin ella son decisiones NEUTRALES (keel-core/gen/scheduling.js), las mismas que toman keel-spring,
//     keel-nest y keel-dotnet para el mismo diseño.
//   · Las purgas (`purge.js`): el bucle por lotes y su configuración aquí, el SQL en el paquete del motor.
//
// La prueba emitida (`scheduler_test.go`) ejecuta el bucle con `testing/synctest` —el reloj falso de la biblioteca
// estándar: sin esperas reales ni time.Sleep (§ 3.7)— y el bucle de la purga contra los casos de la referencia.

import { BATCHED_PURGE, batchedPurgeParameters, scheduleCron, scheduleDispatch, scheduledOperations } from '@keel-system/keel-core/gen';
import { IDEMPOTENCY_RECORD_PURGE } from '@keel-system/keel-core/gen/request-idempotency';
import { alignRows, commentLines, goString } from '../lib/go-source.js';
import { goFileName, layout, packageFile } from './render.js';
import { contractOf, messageComponents, messageType, useCaseField } from './services.js';
import { usesCorrelation } from './correlation.js';
import { usesDependencies } from './use-cases.js';
import { PURGE_CASES, PURGE_CASES_CUTOFF, tablePurges, usesTablePurges } from './purge.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** Los grupos con alguna operación por reloj, con esas operaciones. Solo con casos de uso cableados (persistencia). */
export function scheduledServices(model) {
  if (!usesDependencies(model) || scheduledOperations(model).length === 0) return [];
  return (model.services ?? [])
    .map((service) => ({ service, operations: (service.operations ?? []).filter((operation) => operation.schedule) }))
    .filter(({ operations }) => operations.length > 0);
}

/**
 * ¿Hay algo que corra por reloj? Operaciones con `schedule` o purgas, con los casos de uso cableados sobre la persistencia.
 * Lo cablea el arranque, con la capa api o sin ella (metering-digest).
 */
export function usesScheduling(model) {
  return usesDependencies(model) && (scheduledServices(model).length > 0 || usesTablePurges(model));
}

/** El nombre de un grupo: `PayoutService` → `Payout`. */
const groupName = (service) => service.className.replace(/Service$/, '');

/** La función que da las tareas de un grupo: `PayoutTasks`. */
export const tasksFunc = (service) => `${groupName(service)}Tasks`;

/** El archivo de las tareas de un grupo. */
export function tasksPath(model, service) {
  return `${layout(model).scheduler.dir}/${goFileName(tasksFunc(service))}.go`;
}

/** La función que despacha una operación desde su tarea: `sendPayouts` → `dispatchSendPayouts`. */
const dispatchFunc = (operation) => `dispatch${useCaseField(operation)}`;

export const SCHEDULER_IMPORT = 'internal/infrastructure/scheduler';

export function generate(model) {
  if (!usesScheduling(model)) return [];
  const { scheduler } = layout(model);
  const file = (name, imports, body, { test = false, doc = null } = {}) => ({
    path: `${scheduler.dir}/${name}${test ? '_test' : ''}.go`,
    content: packageFile(model, scheduler, { imports, body, test, doc })
  });
  const purges = usesTablePurges(model);
  const files = [
    file('doc', [], '', { doc: PACKAGE_DOC }),
    file('settings', ['fmt', 'strconv', 'strings', 'internal/platform/config'], settingsBody(purges)),
    file('scheduler', ['context', 'fmt', 'log/slog', 'sync', 'time', 'github.com/google/uuid', 'github.com/robfig/cron/v3', 'internal/platform/correlation'], schedulerBody(model)),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/scheduling.yaml`, content: schedulingYaml(profile) }))
  ];
  if (purges) {
    files.push(file('purge', ['context', 'errors', 'log/slog', 'time', 'internal/platform/config'], purgeBody(model)));
    // La cadencia de la purga del registro de idempotencia, en su propio fragmento como en los otros tres (las del outbox
    // y de processed_event van en messaging.yaml). El perfil test no lo lleva: allí no corre el reloj.
    if (tablePurges(model).some((purge) => purge.field === 'IdempotencyRecord')) {
      for (const profile of ['local', 'develop', 'production']) files.push({ path: `config/parameters/${profile}/idempotency.yaml`, content: idempotencyYaml(profile) });
    }
  }
  for (const { service, operations } of scheduledServices(model)) {
    files.push({ path: tasksPath(model, service), content: packageFile(model, scheduler, { imports: ['context', 'internal/application'], body: tasksBody(model, service, operations) }) });
  }
  files.push(file('scheduler', testImports(), emittedTest(model), { test: true }));
  return files;
}

const PACKAGE_DOC = `Package scheduler es el reloj del servicio: dispara las operaciones del diseño que declaran schedule y purga por
lotes las tablas del generador. Cada tarea corre en TODAS las réplicas: es «una vez por instancia», no «una vez en el
clúster», así que lo que actúa sobre lo que encuentra tiene que reclamarlo, no solo leerlo.`;

/** El MISMO texto que el scheduling.yaml de keel-nest y keel-dotnet: la clave y la variable son las mismas. */
export function schedulingYaml(profile) {
  if (profile === 'test') {
    return `# El perfil test no tiene base de datos: nada corre por reloj.
scheduling:
  enabled: false
`;
  }
  return `# El reloj del servicio: los barridos del diseño y las purgas de las tablas del generador.
scheduling:
  enabled: \${SCHEDULING_ENABLED:true}
`;
}

/** El MISMO texto que el idempotency.yaml de keel-nest y keel-dotnet. */
function idempotencyYaml(profile) {
  const { cron } = IDEMPOTENCY_RECORD_PURGE;
  const value = profile === 'local' ? cron.default : `\${${cron.env}:${cron.default}}`;
  return (
    [
      'idempotency-record:',
      '  purge:',
      '    # Borrado de las claves ya caducadas; la ventana de deduplicación la fija el ttlSeconds del diseño,',
      '    # no esta cadencia.',
      `    cron: "${value}"`
    ].join('\n') + '\n'
  );
}

// ─── settings.go ─────────────────────────────────────────────────────────────────────────────────

function settingsBody(purges) {
  return `
// Settings es el reloj del perfil activo (config/parameters/<perfil>/scheduling.yaml).
type Settings struct {
	// Enabled dice si corre el reloj: apagado en el perfil test, que no tiene base de datos.
	Enabled bool
}

// SettingsFrom lee scheduling.enabled: sin valor, encendido; un valor que no es true ni false no deja arrancar.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	value, ok := cfg.Value("scheduling.enabled")
	if !ok || strings.TrimSpace(value) == "" {
		return Settings{Enabled: true}, nil
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return Settings{Enabled: true}, nil
	case "false":
		return Settings{Enabled: false}, nil
	}
	return Settings{}, fmt.Errorf("scheduling.enabled tiene que ser true o false: %q", value)
}${purges ? `

// reader lee claves de la configuración y se queda con el primer valor inválido.
type reader struct {
	cfg *config.Config
	err error
}

// text es el valor de key, o fallback si el perfil no lo declara o lo deja vacío.
func (r *reader) text(key, fallback string) string {
	if value, ok := r.cfg.Value(key); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

// positive es el entero positivo de key, o fallback si el perfil no lo declara.
func (r *reader) positive(key string, fallback int) int {
	value, ok := r.cfg.Value(key)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		if r.err == nil {
			r.err = fmt.Errorf("%s tiene que ser un entero positivo: %q", key, value)
		}
		return fallback
	}
	return n
}` : ''}
`;
}

// ─── scheduler.go ────────────────────────────────────────────────────────────────────────────────

function schedulerBody(model) {
  const correlated = usesCorrelation(model);
  return `
// Task es una tarea por reloj: su nombre (único), su cron de SEIS campos (el primero, el segundo) y su pasada.
type Task struct {
	Name string
	Cron string
	Run  func(ctx context.Context) error
}

// parser lee el cron de seis campos de los cuatro servidores del diseño: segundo, minuto, hora, día del mes, mes y día
// de la semana.
var parser = cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

// scheduled es una tarea con su cron ya leído.
type scheduled struct {
	task     Task
	schedule cron.Schedule
}

// Scheduler es el reloj del servicio: corre cada tarea registrada en su propia goroutine desde que arranca.
//
// La siguiente ocurrencia se calcula al TERMINAR la pasada: un tick que llega con la anterior en curso se salta, y la
// tarea no se solapa nunca consigo misma (el @Scheduled de keel-spring y el waitForCompletion de keel-nest). Una pasada
// que falla entera no para el reloj: se registra y lo intenta en la siguiente.
//
// Cada tarea corre en TODAS las réplicas: es «una vez por instancia», no «una vez en el clúster». Lo que actúa sobre lo
// que encuentra tiene que reclamarlo, no solo leerlo.
type Scheduler struct {
	enabled bool
	tasks   []scheduled
	logger  *slog.Logger
}

// New prepara el reloj con sus tareas. Un cron inválido o un nombre repetido no deja arrancar: un barrido que no se
// dispara nunca no da ningún error que alguien vaya a ver.
func New(settings Settings, tasks []Task, logger *slog.Logger) (*Scheduler, error) {
	s := &Scheduler{enabled: settings.Enabled, logger: logger}
	seen := make(map[string]bool, len(tasks))
	for _, task := range tasks {
		if seen[task.Name] {
			return nil, fmt.Errorf("tarea por reloj duplicada: %s", task.Name)
		}
		seen[task.Name] = true
		schedule, err := parser.Parse(task.Cron)
		if err != nil {
			return nil, fmt.Errorf("la tarea por reloj %s tiene un cron inválido %q: %w", task.Name, task.Cron, err)
		}
		s.tasks = append(s.tasks, scheduled{task: task, schedule: schedule})
	}
	return s, nil
}

// Names son los nombres de las tareas registradas, en orden.
func (s *Scheduler) Names() []string {
	names := make([]string, 0, len(s.tasks))
	for _, t := range s.tasks {
		names = append(names, t.task.Name)
	}
	return names
}

// Run corre el reloj hasta que ctx se cancela. Entonces no empieza otra pasada y ESPERA a la que esté en vuelo, que no
// se corta: cortarla a medias dejaría filas reclamadas sin trabajo hecho, que solo recupera un rescate. Va en el errgroup
// del arranque, así que la base se cierra después de que vuelva.
func (s *Scheduler) Run(ctx context.Context) error {
	if !s.enabled {
		if len(s.tasks) > 0 {
			s.logger.InfoContext(ctx, "reloj apagado (scheduling.enabled: false)", "tasks", len(s.tasks))
		}
		return nil
	}
	var wg sync.WaitGroup
	for _, t := range s.tasks {
		wg.Go(func() {
			s.loop(ctx, t)
		})
	}
	wg.Wait()
	return nil
}

// RunOnce ejecuta una pasada de task: es lo que llama el bucle, y lo que puede llamar una prueba. Una pasada que falla
// —o que entra en pánico— no para el reloj: se registra y la siguiente lo intenta otra vez.
func (s *Scheduler) RunOnce(ctx context.Context, task Task) {
${correlated ? `	// Una pasada es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación. Sin esto, todo lo
	// que publique viajaría con correlationId nulo.
	ctx = correlation.WithID(ctx, uuid.NewString())
` : ''}	defer func() {
		if recovered := recover(); recovered != nil {
			s.logger.ErrorContext(ctx, "pasada por reloj: pánico", "task", task.Name, "panic", fmt.Sprint(recovered))
		}
	}()
	if err := task.Run(ctx); err != nil {
		s.logger.ErrorContext(ctx, "pasada por reloj: falló", "task", task.Name, "error", err)
	}
}

// loop es la vida de una tarea: espera a su siguiente ocurrencia, ejecuta la pasada y vuelve a calcular.
func (s *Scheduler) loop(ctx context.Context, t scheduled) {
	// La última ocurrencia atendida: la siguiente se busca a partir de ella mientras el reloj no la haya pasado, así que
	// la misma ocurrencia no se dispara dos veces.
	var last time.Time
	for ctx.Err() == nil {
		from := time.Now()
		if last.After(from) {
			from = last
		}
		next := t.schedule.Next(from)
		if next.IsZero() {
			// El cron no vuelve a casar nunca (un 30 de febrero): no hay nada que esperar.
			return
		}
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		last = next
		// Sin la cancelación del apagado: la pasada que ya empezó termina.
		s.RunOnce(context.WithoutCancel(ctx), t.task)
	}
}
`;
}

// ─── purge.go ────────────────────────────────────────────────────────────────────────────────────

function purgeBody(model) {
  const purges = tablePurges(model);
  const rows = purges.map((purge) => ({ indent: '\t', cells: [purge.field, 'PurgeSchedule'] }));
  const reads = purges.map((purge) => {
    const batch = batchedPurgeParameters(purge.prefix);
    const retention = purge.retentionDays
      ? `time.Duration(read.positive(${goString(purge.retentionDays.key)}, ${purge.retentionDays.default})) * 24 * time.Hour`
      : null;
    const pairs = [
      ['Cron:', `read.text(${goString(purge.cron.key)}, ${goString(purge.cron.default)}),`],
      ...(retention ? [['Retention:', `${retention},`]] : []),
      ['BatchSize:', `read.positive(${goString(batch.batchSize.key)}, ${batch.batchSize.default}),`],
      ['MaxBatches:', `read.positive(${goString(batch.maxBatches.key)}, ${batch.maxBatches.default}),`]
    ];
    return `\t\t${purge.field}: PurgeSchedule{\n${alignRows(pairs.map((cells) => ({ indent: '\t\t\t', cells }))).join('\n')}\n\t\t},`;
  });
  const doc = purges
    .map((purge) => `//   - ${purge.field}: ${purge.what}, bajo ${purge.prefix} (${purge.cron.env}${purge.retentionDays ? `, ${purge.retentionDays.env}` : ''}).`)
    .join('\n');
  return `
// PurgeTable es una tabla del generador que se purga por lotes. La implementa el adaptador del motor (purges.go), con
// el SQL de cada tabla.
type PurgeTable interface {
	// Boundary es el instante de la fila en la posición position entre las anteriores a cutoff, y false si quedan menos.
	Boundary(ctx context.Context, cutoff time.Time, position int) (time.Time, bool, error)
	// DeleteUpTo borra lo anterior a cutoff hasta upTo incluido, en su PROPIA transacción, y devuelve cuántas filas.
	DeleteUpTo(ctx context.Context, cutoff, upTo time.Time) (int64, error)
}

// PurgeSchedule es una purga: su cron (seis campos), la retención (cero donde cada fila lleva su caducidad), y el lote
// y su tope.
type PurgeSchedule struct {
	Cron       string
	Retention  time.Duration
	BatchSize  int
	MaxBatches int
}

// PurgeSettings son las purgas del perfil activo, con las claves, las variables y los defaults de los servidores de
// keel-spring, keel-nest y keel-dotnet:
${doc}
type PurgeSettings struct {
${alignRows(rows).join('\n')}
}

// PurgeSettingsFrom lee las purgas del perfil al ARRANCAR: un valor que no es un entero positivo no deja arrancar.
func PurgeSettingsFrom(cfg *config.Config) (PurgeSettings, error) {
	read := &reader{cfg: cfg}
	settings := PurgeSettings{
${reads.join('\n')}
	}
	if read.err != nil {
		return PurgeSettings{}, read.err
	}
	return settings, nil
}

// El lote y su tope por defecto, los de los cuatro servidores (keel-core/gen/scheduling.js, BATCHED_PURGE).
const (
	// DefaultBatchSize son las filas por lote: lo bastante pocas para que un lote quepa holgado en el tope de transacción.
	DefaultBatchSize = ${BATCHED_PURGE.batchSize}
	// DefaultMaxBatches son los lotes por pasada: alcanzado, se avisa y la siguiente pasada sigue.
	DefaultMaxBatches = ${BATCHED_PURGE.maxBatches}
)

// errBatch es lo que devuelve una purga con un lote o un tope que no son enteros positivos.
var errBatch = errors.New("batch-size y max-batches tienen que ser enteros positivos")

// BatchedPurge purga por lotes lo anterior a cutoff, cada lote en su propia transacción, y devuelve las filas borradas
// y si llegó a su tope con filas pendientes.
//
// Las filas que comparten instante con la frontera caen en el mismo lote, así que un lote puede pasar de batchSize: la
// cota es aproximada a propósito. Alcanzado maxBatches, deja el resto a la siguiente pasada: sin tope, un atraso enorme
// haría de la pasada nocturna un proceso de horas compitiendo con el tráfico de la mañana. Corre en todas las réplicas
// a la vez y no se coordina: borrar es idempotente, y dos réplicas que se solapan solo borran menos cada una.
func BatchedPurge(ctx context.Context, table PurgeTable, cutoff time.Time, batchSize, maxBatches int) (int64, bool, error) {
	if batchSize < 1 || maxBatches < 1 {
		return 0, false, errBatch
	}
	var deleted int64
	for range maxBatches {
		edge, found, err := table.Boundary(ctx, cutoff, batchSize-1)
		if err != nil {
			return deleted, false, err
		}
		if !found {
			// Queda menos de un lote: el último, entero.
			n, err := table.DeleteUpTo(ctx, cutoff, cutoff)
			return deleted + n, false, err
		}
		n, err := table.DeleteUpTo(ctx, cutoff, edge)
		deleted += n
		if err != nil {
			return deleted, false, err
		}
	}
	return deleted, true, nil
}

// PurgeTask es la tarea por reloj de la purga de una tabla: corta en ahora menos la retención.
func PurgeTask(table string, schedule PurgeSchedule, store PurgeTable, logger *slog.Logger) Task {
	return Task{
		Name: "purge:" + table,
		Cron: schedule.Cron,
		Run: func(ctx context.Context) error {
			cutoff := time.Now().Add(-schedule.Retention)
			deleted, exhausted, err := BatchedPurge(ctx, store, cutoff, schedule.BatchSize, schedule.MaxBatches)
			if deleted > 0 {
				logger.InfoContext(ctx, "purga por lotes", "table", table, "deleted", deleted, "cutoff", cutoff.UTC())
			}
			if exhausted {
				logger.WarnContext(ctx, "la purga llegó a su tope y quedan filas por purgar; la siguiente pasada sigue",
					"table", table, "batches", schedule.MaxBatches, "batchSize", schedule.BatchSize)
			}
			return err
		},
	}
}
`;
}

// ─── <grupo>_tasks.go ────────────────────────────────────────────────────────────────────────────

/** Una nota en líneas de comentario de hasta `width` caracteres. */
function wrapComment(text, indent = '', width = 116) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return commentLines(lines.join('\n'), indent).join('\n');
}

/** La prosa del schedule del diseño, en minúscula detrás de los dos puntos, o un punto si no la hay. */
function scheduleProse(operation) {
  const prose = String(operation.schedule.description ?? operation.description ?? '').trim();
  if (!prose) return '.';
  const lowered = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(prose) ? prose[0].toLowerCase() + prose.slice(1) : prose;
  return `: ${/[.!?]$/.test(lowered) ? lowered : `${lowered}.`}`;
}

function tasksBody(model, service, operations) {
  const group = groupName(service);
  // Una línea por tarea: gofmt no alinea los campos de un literal escrito en una sola línea.
  const rows = operations.map(
    (operation) => `\t\t{Name: ${goString(operation.name)}, Cron: ${goString(scheduleCron(model, operation))}, Run: ${dispatchFunc(operation)}(uc)},`
  );
  const dispatchers = operations.map((operation) => {
    if (messageComponents(operation, model).length > 0) {
      // La frontera (supported-features.js) no deja llegar aquí: un mensaje con campos no tiene de dónde sacarlos.
      throw new Error(`${operation.name}: una operación por reloj cuyo mensaje lleva campos no se puede despachar sin argumentos`);
    }
    const mode = scheduleDispatch(model, operation);
    const why = {
      provider: 'llama al proveedor',
      irreversible: 'produce un efecto que no se deshace',
      claimed: 'confirma cada reclamo en su propia transacción y actúa sobre las filas una a una'
    }[mode.reason];
    const note = mode.withoutTransaction
      ? `Despachado SIN transacción abarcadora a propósito (application.WithoutTransaction): este barrido ${why} EN MEDIO ` +
        'de su trabajo, así que su garantía es un orden de commits —reclamar y confirmar, actuar fuera de toda transacción, ' +
        'confirmar el desenlace— y no una transacción única. Quitarlo «por coherencia» deja el reclamo sin confirmar hasta ' +
        'el final del lote: ninguna réplica lo ve y todas actúan sobre los mismos candidatos.'
      : 'Despachado con la transacción del caso de uso: no llama a nadie en medio de su trabajo.';
    const doc = [
      wrapComment(`${dispatchFunc(operation)} dispara ${operation.name}${scheduleProse(operation)}`),
      '//',
      wrapComment(`Cron del diseño: ${operation.schedule.cron} (build añade el segundo de arranque). ${note}`)
    ].join('\n');
    const ctx = mode.withoutTransaction ? 'application.WithoutTransaction(ctx)' : 'ctx';
    const call = `uc.${useCaseField(operation)}.Handle(${ctx}, application.${messageType(operation)}{})`;
    const body = contractOf(operation).result ? `\t\t_, err := ${call}\n\t\treturn err` : `\t\treturn ${call}`;
    return `${doc}
func ${dispatchFunc(operation)}(uc *application.UseCases) func(context.Context) error {
	return func(ctx context.Context) error {
${body}
	}
}`;
  });
  return `
// ${tasksFunc(service)} son los disparadores por reloj de las operaciones de ${group} que declaran schedule, con su cron de
// seis campos.
//
// Cada uno corre en TODAS las réplicas del servicio. No todos despachan igual, y no es un descuido: lo decide el diseño
// (keel-core/gen/scheduling.js), igual que en los servidores de keel-spring, keel-nest y keel-dotnet.
//
// El primer campo del cron —el segundo— no es 0 por casualidad: el diseño declara cinco campos y build reparte el
// arranque dentro del minuto para que dos operaciones con la misma cadencia no salgan a la vez. Igualarlos a 0 «por
// limpieza» deshace ese reparto.
func ${tasksFunc(service)}(uc *application.UseCases) []Task {
	return []Task{
${rows.join('\n')}
	}
}

${dispatchers.join('\n\n')}
`;
}

// ─── scheduler_test.go ───────────────────────────────────────────────────────────────────────────

function testImports() {
  return ['context', 'errors', 'log/slog', 'maps', 'slices', 'sync/atomic', 'testing', 'testing/synctest', 'time', SCHEDULER_IMPORT];
}

function emittedTest(model) {
  const groups = scheduledServices(model);
  const crons = groups.flatMap(({ operations }) => operations.map((operation) => [operation.name, scheduleCron(model, operation)]));
  const purges = tablePurges(model);
  const parts = [`
// quiet es un logger que no escribe nada.
func quiet() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// counting es una tarea que cuenta sus pasadas y tarda took en cada una.
func counting(spec string, took time.Duration, passes *atomic.Int32) scheduler.Task {
	return scheduler.Task{Name: "tick", Cron: spec, Run: func(context.Context) error {
		passes.Add(1)
		if took > 0 {
			<-time.After(took)
		}
		return nil
	}}
}

// running arranca el reloj con task y devuelve cómo pararlo y esperar a que Run vuelva.
func running(t *testing.T, enabled bool, task scheduler.Task) (stop func() error) {
	t.Helper()
	s, err := scheduler.New(scheduler.Settings{Enabled: enabled}, []scheduler.Task{task}, quiet())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- s.Run(ctx)
	}()
	return func() error {
		cancel()
		return <-done
	}
}

func TestSchedulerFiresOnEveryOccurrence(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var passes atomic.Int32
		stop := running(t, true, counting("*/10 * * * * *", 0, &passes))
		<-time.After(35 * time.Second)
		if err := stop(); err != nil {
			t.Fatalf("Run = %v", err)
		}
		if got := passes.Load(); got != 3 {
			t.Errorf("pasadas en 35 s con */10 = %d, quiero 3", got)
		}
	})
}

func TestSchedulerSkipsTheTicksOfAPassInFlight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Una pasada de 25 s cada 10 s: empieza a los 10 s y a los 40 s (la siguiente ocurrencia tras terminar), nunca dos
		// a la vez.
		var passes atomic.Int32
		stop := running(t, true, counting("*/10 * * * * *", 25*time.Second, &passes))
		<-time.After(61 * time.Second)
		if got := passes.Load(); got != 2 {
			t.Errorf("pasadas empezadas en 61 s = %d, quiero 2: un tick con la pasada en vuelo se salta", got)
		}
		_ = stop()
	})
}

func TestSchedulerWaitsForThePassInFlight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		var finished, cancelled atomic.Bool
		stop := running(t, true, scheduler.Task{Name: "slow", Cron: "*/10 * * * * *", Run: func(ctx context.Context) error {
			<-time.After(25 * time.Second)
			cancelled.Store(ctx.Err() != nil)
			finished.Store(true)
			return nil
		}})
		<-time.After(15 * time.Second)
		if err := stop(); err != nil {
			t.Fatalf("Run = %v", err)
		}
		if !finished.Load() || cancelled.Load() {
			t.Errorf("la pasada en vuelo: terminada %v, cancelada %v; quiero terminada y sin cancelar", finished.Load(), cancelled.Load())
		}
		if elapsed := time.Since(started); elapsed != 35*time.Second {
			t.Errorf("Run volvió a los %v, quiero 35s: al final de la pasada que empezó a los 10s", elapsed)
		}
	})
}

func TestSchedulerKeepsGoingAfterAFailedPass(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var passes atomic.Int32
		stop := running(t, true, scheduler.Task{Name: "flaky", Cron: "*/10 * * * * *", Run: func(context.Context) error {
			switch passes.Add(1) {
			case 1:
				return errors.New("falla")
			case 2:
				panic("pánico en la pasada")
			}
			return nil
		}})
		<-time.After(35 * time.Second)
		_ = stop()
		if got := passes.Load(); got != 3 {
			t.Errorf("pasadas = %d, quiero 3: ni un error ni un pánico paran el reloj", got)
		}
	})
}

func TestSchedulerDisabledRunsNothing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var passes atomic.Int32
		stop := running(t, false, counting("* * * * * *", 0, &passes))
		<-time.After(10 * time.Second)
		_ = stop()
		if got := passes.Load(); got != 0 {
			t.Errorf("pasadas con scheduling.enabled: false = %d, quiero 0", got)
		}
	})
}

func TestNewRefusesAnInvalidCronOrARepeatedName(t *testing.T) {
	run := func(context.Context) error { return nil }
	if _, err := scheduler.New(scheduler.Settings{Enabled: true}, []scheduler.Task{{Name: "five", Cron: "* * * * *", Run: run}}, quiet()); err == nil {
		t.Error("New aceptó un cron de cinco campos: el de los cuatro servidores lleva el segundo")
	}
	twice := []scheduler.Task{{Name: "a", Cron: "0 * * * * *", Run: run}, {Name: "a", Cron: "30 * * * * *", Run: run}}
	if _, err := scheduler.New(scheduler.Settings{Enabled: true}, twice, quiet()); err == nil {
		t.Error("New aceptó dos tareas con el mismo nombre")
	}
}
`];
  if (groups.length > 0) {
    const want = alignRows(crons.map(([name, cron]) => ({ indent: '\t\t', cells: [`${goString(name)}:`, `${goString(cron)},`] })));
    parts.push(`
func TestTasksCarryTheCronOfTheDesign(t *testing.T) {
	// El segundo repartido y los cinco campos del diseño: los mismos que el @Scheduled de keel-spring.
	want := map[string]string{
${want.join('\n')}
	}
	var tasks []scheduler.Task
${groups.map(({ service }) => `\ttasks = append(tasks, scheduler.${tasksFunc(service)}(nil)...)`).join('\n')}
	got := map[string]string{}
	for _, task := range tasks {
		got[task.Name] = task.Cron
	}
	if !maps.Equal(got, want) {
		t.Errorf("tareas = %v, quiero %v", got, want)
	}
	if _, err := scheduler.New(scheduler.Settings{Enabled: true}, tasks, quiet()); err != nil {
		t.Errorf("New: %v", err)
	}
}
`);
  }
  if (purges.length > 0) {
    const ms = (list) => `[]int64{${list.join(', ')}}`;
    const cases = PURGE_CASES.map(
      (c) => `\t\t{${ms(c.instants)}, ${c.batchSize}, ${c.maxBatches}, ${c.deleted}, ${c.deletes}, ${c.exhausted}, ${ms(c.remaining)}},`
    );
    parts.push(`
// memoryTable es una tabla en memoria con instantes en milisegundos (con repetidos): Boundary y DeleteUpTo como los haría
// el motor.
type memoryTable struct {
	rows    []int64
	deletes int
}

// Boundary implementa scheduler.PurgeTable.
func (m *memoryTable) Boundary(_ context.Context, cutoff time.Time, position int) (time.Time, bool, error) {
	var eligible []int64
	for _, at := range m.rows {
		if at < cutoff.UnixMilli() {
			eligible = append(eligible, at)
		}
	}
	if position >= len(eligible) {
		return time.Time{}, false, nil
	}
	return time.UnixMilli(eligible[position]), true, nil
}

// DeleteUpTo implementa scheduler.PurgeTable.
func (m *memoryTable) DeleteUpTo(_ context.Context, cutoff, upTo time.Time) (int64, error) {
	m.deletes++
	var kept []int64
	for _, at := range m.rows {
		if at >= cutoff.UnixMilli() || at > upTo.UnixMilli() {
			kept = append(kept, at)
		}
	}
	deleted := int64(len(m.rows) - len(kept))
	m.rows = kept
	return deleted, nil
}

func TestBatchedPurgeFollowsTheReference(t *testing.T) {
	// Los casos de keel-core/gen/scheduling.js (batchedPurgeReference), con el corte en ${PURGE_CASES_CUTOFF} ms.
	cases := []struct {
		instants              []int64
		batchSize, maxBatches int
		deleted               int64
		deletes               int
		exhausted             bool
		remaining             []int64
	}{
${cases.join('\n')}
	}
	for _, c := range cases {
		table := &memoryTable{rows: slices.Clone(c.instants)}
		deleted, exhausted, err := scheduler.BatchedPurge(t.Context(), table, time.UnixMilli(${PURGE_CASES_CUTOFF}), c.batchSize, c.maxBatches)
		if err != nil {
			t.Fatalf("%v: BatchedPurge = %v", c.instants, err)
		}
		if deleted != c.deleted || exhausted != c.exhausted || table.deletes != c.deletes || !slices.Equal(table.rows, c.remaining) {
			t.Errorf("%v (lote %d, tope %d): borradas %d, tope %v, %d borrados, quedan %v; quiero %d, %v, %d, %v",
				c.instants, c.batchSize, c.maxBatches, deleted, exhausted, table.deletes, table.rows, c.deleted, c.exhausted, c.deletes, c.remaining)
		}
	}
}

func TestBatchedPurgeRefusesANonPositiveBatch(t *testing.T) {
	if _, _, err := scheduler.BatchedPurge(t.Context(), &memoryTable{}, time.Now(), 0, 1); err == nil {
		t.Error("BatchedPurge aceptó un lote de 0 filas")
	}
}
`);
  }
  return parts.join('');
}
