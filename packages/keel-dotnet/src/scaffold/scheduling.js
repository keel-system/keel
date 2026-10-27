// Lo que corre por RELOJ (incremento 10b): las operaciones con `schedule` del diseño y las purgas de las tablas del
// generador.
//
// Es el `@Scheduled` de keel-spring y el `Scheduling` de keel-nest sobre un BackgroundService con **Cronos** (MIT) para
// el cron de seis campos:
//
//   · `Scheduling` corre cada tarea en su propio bucle: calcula la siguiente ocurrencia AL TERMINAR la pasada, así que un
//     tick que llega con la anterior en curso se salta (lo que hacen el @Scheduled de Spring y el `waitForCompletion` de
//     keel-nest). Cada pasada abre su propio ámbito de DI. Al apagar no se corta la pasada en vuelo: el host la espera
//     antes de soltar la base. La conmuta `scheduling.enabled`, apagada en el perfil `test`, que no tiene base de datos.
//   · Un `<Grupo>Scheduler` por grupo de operaciones con `schedule`, en infraestructura (un adaptador de entrada, como un
//     endpoint): el segundo de arranque y si se despacha con la transacción del caso de uso o sin ella son decisiones
//     NEUTRALES (keel-core/gen/scheduling.js), las mismas que toman keel-spring y keel-nest para el mismo diseño.
//   · Las purgas (`purge.js`) se registran en el mismo `Scheduling`.

import { scheduledOperations, scheduleCron, scheduleDispatch } from '@keel-system/keel-core/gen';
import { csFile, csString, located, namespaceOf, xmlDoc } from './render.js';
import { usesMediator } from './mediator.js';
import { entryGateAssignment, messageComponents, messageNamespace } from './services.js';
import { usesCorrelation } from './rest-support.js';
import { configNamespace } from './config.js';
import { persistenceNamespace } from './persistence.js';
import { purgeNamespace, usesTablePurges } from './purge.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

/** ¿Hay algo que corra por reloj? Operaciones con `schedule` (con casos de uso que despachar) o purgas. */
export function usesScheduling(model) {
  return scheduledServices(model).length > 0 || usesTablePurges(model);
}

export function schedulingNamespace(model) {
  return namespaceOf(model, 'scheduling');
}

/** El scheduler de un grupo de operaciones: `PayoutRunService` → `PayoutRunScheduler`. */
export const schedulerClass = (service) => service.className.replace(/Service$/, 'Scheduler');
export const schedulerPath = (model, service) => located(model, 'scheduling', schedulerClass(service)).path;

/** Los grupos con alguna operación por reloj, con esas operaciones. */
export function scheduledServices(model) {
  if (!usesMediator(model) || scheduledOperations(model).length === 0) return [];
  return (model.services ?? [])
    .map((service) => ({ service, operations: (service.operations ?? []).filter((operation) => operation.schedule) }))
    .filter(({ operations }) => operations.length > 0);
}

export function generate(model) {
  if (!usesScheduling(model)) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'scheduling', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    file('SchedulingSettings', [configNamespace(model)], settingsBody()),
    file('ScheduledTask', ['Cronos'], taskBody()),
    file('Scheduling', ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'], schedulingBody()),
    file('SchedulingRegistration', registrationUsings(model), registrationBody(model)),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/scheduling.yaml`, content: schedulingYaml(profile) }))
  ];
  for (const { service, operations } of scheduledServices(model)) {
    files.push(file(schedulerClass(service), schedulerUsings(model, operations), schedulerBody(model, service, operations)));
  }
  return files;
}

/** El MISMO texto que el scheduling.yaml de keel-nest: la clave y la variable son las mismas. */
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

function settingsBody() {
  return `/// <summary>El reloj del perfil activo (config/parameters/&lt;perfil&gt;/scheduling.yaml).</summary>
/// <param name="Enabled">¿Corre el reloj? Apagado en el perfil test, que no tiene base de datos.</param>
public sealed record SchedulingSettings(bool Enabled)
{
    /// <summary>Lee <c>scheduling.enabled</c>: sin valor, encendido; un valor que no es true ni false no deja arrancar.</summary>
    public static SchedulingSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var value = configuration.Get("scheduling:enabled");
        if (string.IsNullOrWhiteSpace(value))
        {
            return new SchedulingSettings(true);
        }
        return value.Trim().ToLowerInvariant() switch
        {
            "true" => new SchedulingSettings(true),
            "false" => new SchedulingSettings(false),
            _ => throw new InvalidOperationException($"scheduling.enabled tiene que ser true o false: '{value}'")
        };
    }
}`;
}

function taskBody() {
  return `/// <summary>
/// Una tarea por reloj: su nombre (único), su cron de SEIS campos (el primero, el segundo) y su pasada, que recibe los
/// servicios de un ámbito de DI abierto para ella.
/// </summary>
public sealed class ScheduledTask
{
    public ScheduledTask(string name, string cron, Func<IServiceProvider, CancellationToken, Task> run)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(run);
        Name = name;
        Cron = cron;
        Run = run;
        try
        {
            Expression = CronExpression.Parse(cron, CronFormat.IncludeSeconds);
        }
        catch (Exception error) when (error is CronFormatException or ArgumentNullException)
        {
            // Un cron inválido no deja arrancar: un barrido que no se dispara nunca no da ningún error que alguien vaya a ver.
            throw new InvalidOperationException($"La tarea por reloj {name} tiene un cron inválido: '{cron}'", error);
        }
    }

    public string Name { get; }

    public string Cron { get; }

    public CronExpression Expression { get; }

    public Func<IServiceProvider, CancellationToken, Task> Run { get; }

    /// <summary>La siguiente ocurrencia estrictamente posterior a <paramref name="from"/>, en la zona del servidor (la del @Scheduled de Spring).</summary>
    public DateTimeOffset? NextAfter(DateTimeOffset from, TimeZoneInfo zone) => Expression.GetNextOccurrence(from, zone);
}`;
}

function schedulingBody() {
  return `/// <summary>
/// El reloj del servicio: corre cada tarea registrada en su propio bucle desde que la aplicación arranca.
/// </summary>
/// <remarks>
/// <para>
/// La siguiente ocurrencia se calcula al TERMINAR la pasada: un tick que llega con la anterior en curso se salta, y la
/// tarea no se solapa nunca consigo misma (el @Scheduled de keel-spring y el waitForCompletion de keel-nest). Una pasada
/// que falla entera no para el reloj: se registra y lo intenta en la siguiente.
/// </para>
/// <para>
/// Al apagar no se empieza otra pasada y la que está en vuelo NO se corta: el host la espera (hasta su ShutdownTimeout)
/// antes de soltar la base. Cortarla a medias dejaría filas reclamadas sin trabajo hecho, que solo recupera un rescate.
/// </para>
/// <para>
/// Cada tarea corre en TODAS las réplicas: es «una vez por instancia», no «una vez en el clúster». Lo que actúa sobre lo
/// que encuentra tiene que reclamarlo, no solo leerlo.
/// </para>
/// </remarks>
public sealed partial class Scheduling(IEnumerable<ScheduledTask> tasks, SchedulingSettings settings, IServiceScopeFactory scopes, ILogger<Scheduling> logger)
    : BackgroundService
{
    /// <summary>El tramo más largo que se espera de una vez: Task.Delay no admite más de ~49 días, y un cron anual los supera.</summary>
    private static readonly TimeSpan LongestWait = TimeSpan.FromHours(1);

    private readonly IReadOnlyList<ScheduledTask> registered = Distinct(tasks);

    /// <summary>Los nombres de las tareas registradas.</summary>
    public IReadOnlyList<string> Names => [.. registered.Select(task => task.Name)];

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!settings.Enabled)
        {
            if (registered.Count > 0)
            {
                LogDisabled(registered.Count);
            }
            return Task.CompletedTask;
        }
        return Task.WhenAll(registered.Select(task => Loop(task, stoppingToken)));
    }

    /// <summary>Una pasada de la tarea en un ámbito de DI propio. Es lo que llama el bucle, y lo que puede llamar una prueba.</summary>
    public async Task RunOnce(ScheduledTask task, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(task);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            await task.Run(scope.ServiceProvider, cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            LogPassFailed(task.Name, error);
        }
    }

    private async Task Loop(ScheduledTask task, CancellationToken stoppingToken)
    {
        // La última ocurrencia atendida: un Task.Delay que despierta unos milisegundos ANTES de su instante no puede hacer
        // que la misma ocurrencia se dispare dos veces.
        DateTimeOffset? last = null;
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.Now;
            var from = last is { } previous && previous > now ? previous : now;
            if (task.NextAfter(from, TimeZoneInfo.Local) is not { } next)
            {
                return;
            }
            try
            {
                for (var wait = next - DateTimeOffset.Now; wait > TimeSpan.Zero; wait = next - DateTimeOffset.Now)
                {
                    await Task.Delay(wait < LongestWait ? wait : LongestWait, stoppingToken);
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            last = next;
            // Sin el token del apagado: la pasada que ya empezó termina.
            await RunOnce(task, CancellationToken.None);
        }
    }

    private static IReadOnlyList<ScheduledTask> Distinct(IEnumerable<ScheduledTask> tasks)
    {
        var list = tasks.ToList();
        var duplicated = list.GroupBy(task => task.Name, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);
        return duplicated is null ? list : throw new InvalidOperationException($"Tarea por reloj duplicada: {duplicated.Key}");
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Reloj apagado (scheduling.enabled: false): {Count} tarea(s) sin arrancar")]
    private partial void LogDisabled(int count);

    [LoggerMessage(Level = LogLevel.Error, Message = "{Task}: la pasada falló")]
    private partial void LogPassFailed(string task, Exception error);
}`;
}

function registrationUsings(model) {
  const usings = ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.DependencyInjection.Extensions', configNamespace(model)];
  if (usesTablePurges(model)) usings.push(purgeNamespace(model), persistenceNamespace(model));
  return usings;
}

function registrationBody(model) {
  const lines = ['        services.AddSingleton(SchedulingSettings.From(configuration));'];
  for (const { service } of scheduledServices(model)) {
    const scheduler = schedulerClass(service);
    lines.push(`        services.AddScoped<${scheduler}>();`, `        foreach (var task in ${scheduler}.Tasks())`, '        {', '            services.AddSingleton(task);', '        }');
  }
  if (usesTablePurges(model)) {
    lines.push(
      '        var purges = PurgeSettings.From(configuration);',
      '        services.AddSingleton(purges);',
      '        services.AddSingleton<TablePurges>();',
      '        foreach (var task in TablePurges.Tasks(purges))',
      '        {',
      '            services.AddSingleton(task);',
      '        }'
    );
  }
  lines.push('        services.TryAddSingleton<Scheduling>();', '        services.AddHostedService(provider => provider.GetRequiredService<Scheduling>());', '        return services;');
  const what = [scheduledServices(model).length > 0 ? 'los schedulers de las operaciones con schedule' : null, usesTablePurges(model) ? 'las purgas de las tablas del generador' : null]
    .filter(Boolean)
    .join(' y ');
  return `/// <summary>
/// El reloj del servicio: el registro de tareas, ${what}. Va después de los casos de uso y de la persistencia:
/// despacha por el IUseCaseMediator y purga con el DbContext.
/// </summary>
public static class SchedulingRegistration
{
    public static IServiceCollection AddScheduling(this IServiceCollection services, ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
${lines.join('\n')}
    }
}`;
}

function schedulerUsings(model, operations) {
  const usings = ['Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'abstractions')];
  if (usesCorrelation(model)) usings.push('Microsoft.Extensions.Logging', namespaceOf(model, 'correlation'));
  for (const operation of operations) {
    if (messageComponents(operation, model).length === 0) usings.push(messageNamespace(model, operation));
  }
  return usings;
}

const csMethod = (name) => name[0].toUpperCase() + name.slice(1);

/** Una nota larga en líneas de comentario de hasta `width` caracteres. */
function wrapLines(text, width = 110) {
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
  return lines;
}

function schedulerBody(model, service, operations) {
  const className = schedulerClass(service);
  const correlated = usesCorrelation(model);
  const tasks = operations.map(
    (operation) =>
      `        new(${csString(operation.name)}, ${csString(scheduleCron(model, operation))}, (services, cancellationToken) => services.GetRequiredService<${className}>().${csMethod(operation.name)}(cancellationToken))`
  );
  const methods = operations.map((operation) => {
    const mode = scheduleDispatch(model, operation);
    const why = {
      provider: 'llama al proveedor',
      irreversible: 'produce un efecto que no se deshace',
      claimed: 'confirma cada reclamo en su propia transacción y actúa sobre las filas una a una'
    }[mode.reason];
    const note = wrapLines(
      mode.withoutTransaction
        ? `Despachado SIN transacción abarcadora a propósito: este barrido ${why} EN MEDIO de su trabajo, así que su ` +
            'garantía es un orden de commits —reclamar y confirmar, actuar fuera de toda transacción, confirmar el ' +
            'desenlace— y no una transacción única. Igualarlo a mediator.Dispatch(...) «por coherencia» deja el reclamo ' +
            'sin confirmar hasta el final del lote: ninguna réplica lo ve y todas actúan sobre los mismos candidatos.'
        : 'Despachado con la transacción del caso de uso: no llama a nadie en medio de su trabajo.'
    );
    const doc = xmlDoc([operation.schedule.description, `Cron del diseño: ${operation.schedule.cron} (build añade el segundo de arranque).`, ...note], '    ');
    const name = csMethod(operation.name);
    if (messageComponents(operation, model).length > 0) {
      return `${doc}    public Task ${name}(CancellationToken cancellationToken)
    {
        // TODO (agente): el mensaje requiere argumentos; construirlos aquí.
        throw new NotImplementedException("TODO: despachar ${operation.messageClass} desde el scheduler");
    }`;
    }
    const dispatch = `await mediator.${mode.withoutTransaction ? 'DispatchWithoutTransaction' : 'Dispatch'}(new ${operation.messageClass}${scheduleGate(model, operation)}, cancellationToken);`;
    const body = correlated
      ? `        // Una pasada del barrido es una TRAZA nueva: no la origina ninguna petición, así que aquí nace su correlación.
        // Sin esto, todo lo que publique viajaría con correlationId nulo.
        var correlationId = Guid.NewGuid().ToString();
        using (CorrelationContext.Open(correlationId))
        using (logger.BeginScope(new Dictionary<string, object> { ["correlationId"] = correlationId }))
        {
            ${dispatch}
        }`
      : `        ${dispatch}`;
    return `${doc}    public async Task ${name}(CancellationToken cancellationToken)
    {
${body}
    }`;
  });
  const ctor = correlated ? `IUseCaseMediator mediator, ILogger<${className}> logger` : 'IUseCaseMediator mediator';
  const group = service.className.replace(/Service$/, '');
  return `/// <summary>
/// Disparadores por reloj de las operaciones de ${group} que declaran <c>schedule</c>.
/// </summary>
/// <remarks>
/// <para>
/// Cada método corre en TODAS las réplicas del servicio. No todos despachan igual, y no es un descuido: lo decide el
/// diseño (keel-core/gen/scheduling.js), igual que en los servidores de keel-spring y keel-nest.
/// </para>
/// <para>
/// El primer campo del cron —el segundo— no es 0 por casualidad: el diseño declara cinco campos y build reparte el
/// arranque dentro del minuto para que dos operaciones con la misma cadencia no salgan a la vez. Igualarlos a 0 «por
/// limpieza» deshace ese reparto.
/// </para>
/// </remarks>
public sealed class ${className}(${ctor})
{
    /// <summary>Las tareas de este grupo, con su cron de seis campos.</summary>
    public static IReadOnlyList<ScheduledTask> Tasks() =>
    [
${tasks.join(',\n')}
    ];

${methods.join('\n\n')}
}`;
}

/** El inicializador del mensaje que despacha el reloj: `()`, o `{ EntryGate = EntryGate.Schedule }` si lleva su puerta. */
function scheduleGate(model, operation) {
  const gate = entryGateAssignment(model, operation.name, 'SCHEDULE');
  return gate ? ` { ${gate} }` : '()';
}
