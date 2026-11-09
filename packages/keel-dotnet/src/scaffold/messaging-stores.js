// Los almacenes de la mensajería sobre EF Core (incremento 9): el OUTBOX con su relay y el registro de mensajes
// PROCESADOS con su guarda. Las tablas son DATOS de keel-core (`gen/messaging-stores.js`: OUTBOX_EVENT y
// PROCESSED_EVENT), las mismas que crean los servidores de keel-spring y keel-nest del diseño, y los parámetros del relay
// son los de OUTBOX_RELAY, con la misma clave, la misma variable y el mismo default.
//
// El relay va en tres pasos y la publicación NO está dentro de ninguna transacción, como en los otros dos:
//   1. el reclamo, en una transacción corta: SKIP LOCKED más un LEASE sobre next_attempt_at;
//   2. la publicación al broker por el puerto IOutboxDispatcher (lo escribe el agente);
//   3. el desenlace, en otra transacción corta: publicada, o un intento más con su backoff y, agotados, la rendición.
//
// Cada transacción corta usa un DbContext propio (un ámbito de DI nuevo): en EF Core una transacción es de UNA conexión,
// y la del caso de uso no puede ser la del relay ni la de la guarda, que tiene que sobrevivir al fallo del handler.

import { OUTBOX_EVENT, PROCESSED_EVENT, OUTBOX_LAST_ERROR_LENGTH, storeColumns } from '@keel-system/keel-core/gen/messaging-stores';
import { csFile, csString, located, namespaceOf } from './render.js';
import { dbContextClass, persistenceNamespace, rowsNamespace, usesDocument } from './persistence.js';
import { documentGuardBody, documentRelayStoreBody } from './document-stores.js';
import { usesDotnetOutbox, usesProcessedEvents } from './messaging.js';
import { telemetryNamespace, usesTelemetry } from './telemetry.js';

export const OUTBOX_ROW = 'OutboxEventRow';
export const PROCESSED_ROW = 'ProcessedEventRow';

/** Las filas de los almacenes que el diseño usa: las lee el DbContext. */
export function storeRows(model) {
  const rows = [];
  if (usesDotnetOutbox(model)) rows.push(OUTBOX_ROW);
  if (usesProcessedEvents(model)) rows.push(PROCESSED_ROW);
  return rows;
}

/** Los nombres que estas tablas ponen en el esquema: los busca la prueba emitida del modelo. */
export function storeSchemaNames(model) {
  const names = [];
  const add = (table) => {
    names.push(table.table, `${table.table}_pkey`, ...table.indexes.map((index) => index.name));
  };
  if (usesDotnetOutbox(model)) add(OUTBOX_EVENT);
  if (usesProcessedEvents(model)) add(PROCESSED_EVENT);
  return names;
}

export function generate(model) {
  const files = [];
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  // Sobre documentos (incremento 12c), los mismos archivos y la misma API, sin filas: document-stores.js.
  const document = usesDocument(model);
  if (usesDotnetOutbox(model)) {
    if (!document) files.push(rowFile(model, OUTBOX_ROW, OUTBOX_EVENT, OUTBOX_DOC));
    files.push(
      file('outbox', 'IOutboxDispatcher', [], dispatcherPortBody()),
      file('outbox', 'OutboxDispatcherFallback', ['Microsoft.Extensions.Logging'], dispatcherFallbackBody()),
      file('outbox', 'OutboxBackoff', [], backoffBody()),
      file('outbox', 'OutboxWakeup', [], wakeupBody()),
      document
        ? file('outbox', 'OutboxRelayStore', ['MongoDB.Bson', 'MongoDB.Driver', persistenceNamespace(model)], documentRelayStoreBody())
        : file(
            'outbox',
            'OutboxRelayStore',
            ['System.Data', 'Microsoft.EntityFrameworkCore', 'Microsoft.Extensions.DependencyInjection', persistenceNamespace(model), rowsNamespace(model)],
            relayStoreBody(model)
          ),
      file(
        'outbox',
        'OutboxRelay',
        ['Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging', persistenceNamespace(model), namespaceOf(model, 'messaging'), ...(usesTelemetry(model) ? ['System.Text.Json', telemetryNamespace(model)] : [])],
        relayBody(model)
      )
    );
  }
  if (usesProcessedEvents(model)) {
    if (document) {
      files.push(file('messageIdempotency', 'IdempotencyGuard', ['MongoDB.Bson', 'MongoDB.Driver', 'Microsoft.Extensions.Logging', persistenceNamespace(model)], documentGuardBody()));
    } else {
      files.push(
        rowFile(model, PROCESSED_ROW, PROCESSED_EVENT, PROCESSED_DOC),
        file(
          'messageIdempotency',
          'IdempotencyGuard',
          ['Microsoft.EntityFrameworkCore', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Logging', persistenceNamespace(model), rowsNamespace(model)],
          guardBody(model)
        )
      );
    }
  }
  return files;
}

// ─── Las filas ───────────────────────────────────────────────────────────────────────────────────

const OUTBOX_DOC = `Fila del outbox: un evento pendiente de entregar al broker. Se escribe en la misma transacción que el cambio que
/// lo provocó, y la MISMA tabla que los servidores de keel-spring y keel-nest del diseño (keel-core/gen/messaging-stores.js):
/// payload es la EventEnvelope ya serializada; published_at null es lo que distingue una fila por entregar; next_attempt_at
/// es a la vez el backoff de una fila que falló y el LEASE de una reclamada cuyo despacho está en vuelo.`;

const PROCESSED_DOC = `Mensaje ya procesado por un consumidor: el par (handler_id, event_id). La MISMA tabla que los servidores de
/// keel-spring y keel-nest del diseño: la clave primaria arbitra la carrera entre dos entregas simultáneas del mismo
/// mensaje, y el índice sobre processed_at es el de la purga.`;

const CS_TYPES = { uuid: 'Guid', string: 'string', text: 'string', timestamp: 'DateTimeOffset', int: 'int' };

/** `routing_key` → `RoutingKey`. */
const propertyOf = (column) => column.name.replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase());

export function rowFile(model, className, table, doc) {
  const { namespace, path } = located(model, 'rows', className);
  const columns = storeColumns(table, 'relational');
  const primary = columns.filter((column) => column.primary);
  const properties = columns.map((column) => {
    const type = CS_TYPES[column.base];
    if (!type) throw new Error(`${table.table}.${column.name}: keel-dotnet no sabe mapear el tipo ${column.base}`);
    const initializer = type === 'string' && !column.nullable ? ' = null!;' : '';
    return `    public ${type}${column.nullable ? '?' : ''} ${propertyOf(column)} { get; set; }${initializer}`;
  });
  const chains = columns.map((column) => {
    const parts = [`row.Property(r => r.${propertyOf(column)})`, `.HasColumnName(${csString(column.name)})`];
    if (column.length != null) parts.push(`.HasMaxLength(${column.length})`);
    if (column.base === 'text') parts.push('.HasColumnType("text")');
    parts.push(column.nullable ? '.IsRequired(false)' : '.IsRequired()');
    // El id lo pone quien escribe la fila: EF no tiene que generarlo.
    if (column.primary && column.base === 'uuid') parts.push('.ValueGeneratedNever()');
    return `        ${parts.join('')};`;
  });
  const key = primary.length === 1 ? `r => r.${propertyOf(primary[0])}` : `r => new { ${primary.map((column) => `r.${propertyOf(column)}`).join(', ')} }`;
  const indexes = table.indexes.map((index) => {
    const cols = index.columns.map((name) => `r.${propertyOf({ name })}`);
    const selector = cols.length === 1 ? `r => ${cols[0]}` : `r => new { ${cols.join(', ')} }`;
    return `        row.HasIndex(${selector}, ${csString(index.name)}).HasDatabaseName(${csString(index.name)});`;
  });
  const body = `/// <summary>
/// ${doc}
/// </summary>
public sealed class ${className}
{
${properties.join('\n\n')}
}

/// <summary>El mapeo de ${className} a la tabla ${table.table}.</summary>
public sealed class ${className}Configuration : IEntityTypeConfiguration<${className}>
{
    public void Configure(EntityTypeBuilder<${className}> row)
    {
        row.ToTable(${csString(table.table)});
        row.HasKey(${key}).HasName(${csString(`${table.table}_pkey`)});
${chains.join('\n')}
${indexes.join('\n')}
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders'], body }) };
}

// ─── El dispatcher ───────────────────────────────────────────────────────────────────────────────

function dispatcherPortBody() {
  return `/// <summary>
/// Puerto de salida del outbox: entrega al broker una fila ya serializada. Es lo ÚNICO acoplado al broker en todo el
/// patrón; la implementación la escribe el agente (skill keel-dotnet-&lt;broker&gt;) y la registra en BrokerBindings.cs.
/// </summary>
public interface IOutboxDispatcher
{
    /// <summary>
    /// Envía el payload (la EventEnvelope ya serializada) al destino y la routing key indicados, con
    /// <paramref name="eventType"/> como tipo nativo del mensaje. Tiene que FALLAR si el broker no confirma la entrega: el
    /// relay cuenta el intento y reintenta en la pasada siguiente.
    /// </summary>
    Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default);
}`;
}

function dispatcherFallbackBody() {
  return `/// <summary>
/// El respaldo del puerto IOutboxDispatcher mientras no hay uno real: build lo registra con TryAdd y el que escriba el
/// agente en BrokerBindings.cs ocupa su sitio. No hay que borrar este archivo.
/// </summary>
/// <remarks>
/// Su Dispatch NO lanza —si lanzara, las filas acumularían intentos hasta la rendición—, y eso tiene un precio: el relay
/// marca como publicadas filas que nunca salieron. En local y test es lo que se quiere (arrancar sin broker); en
/// cualquier otro perfil <c>reliability: outbox</c> se convertiría en perder TODOS los eventos sin un error, así que ahí no
/// deja arrancar.
/// </remarks>
public sealed partial class OutboxDispatcherFallback : IOutboxDispatcher
{
    /// <summary>Perfiles en los que arrancar sin broker es legítimo.</summary>
    private static readonly string[] Tolerated = ["local", "test"];

    private readonly ILogger<OutboxDispatcherFallback> logger;

    private OutboxDispatcherFallback(ILogger<OutboxDispatcherFallback> logger)
    {
        this.logger = logger;
    }

    public static OutboxDispatcherFallback Create(IReadOnlyList<string> profiles, ILogger<OutboxDispatcherFallback> logger)
    {
        ArgumentNullException.ThrowIfNull(profiles);
        if (profiles.Count > 0 && !profiles.Any(profile => Tolerated.Contains(profile, StringComparer.Ordinal)))
        {
            throw new InvalidOperationException(
                $"No hay implementación de IOutboxDispatcher y el perfil activo es {string.Join(',', profiles)}: el relay marcaría como publicados " +
                "eventos que nunca salen del proceso. Impleméntalo con la skill keel-dotnet-<broker> del stack de keel-stack.json.");
        }
        var fallback = new OutboxDispatcherFallback(logger);
        fallback.LogUnimplemented(string.Join(',', profiles));
        return fallback;
    }

    public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default)
    {
        // El dispatcher real lo escribe el agente (skill keel-dotnet-<broker>) y lo registra en BrokerBindings.cs, que es
        //   donde está su marca de trabajo: este respaldo se queda y no hay nada que completar aquí.
        LogNotDispatched(eventType, destination, routingKey);
        return Task.CompletedTask;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "IOutboxDispatcher sin implementar: los eventos NO salen del proceso (perfil {Profiles})")]
    private partial void LogUnimplemented(string profiles);

    [LoggerMessage(Level = LogLevel.Warning, Message = "IOutboxDispatcher no implementado: {EventType} no salió a {Destination}/{RoutingKey}")]
    private partial void LogNotDispatched(string eventType, string destination, string routingKey);
}`;
}

// ─── El relay ────────────────────────────────────────────────────────────────────────────────────

function backoffBody() {
  return `/// <summary>El aplazamiento y la rendición de una fila del outbox: la referencia de keel-core (outboxBackoffMs, outboxDeadLettered).</summary>
public static class OutboxBackoff
{
    /// <summary>La cota de last_error: el mensaje de un fallo se trunca a ella antes de guardarse.</summary>
    public const int LastErrorLength = ${OUTBOX_LAST_ERROR_LENGTH};

    /// <summary>
    /// El aplazamiento tras el fallo número <paramref name="attempts"/> (1 = el primero): initial·2^(attempts-1), saturado en
    /// <paramref name="maxMs"/>. La misma fórmula que aplica el relay de keel-spring.
    /// </summary>
    public static long BackoffMs(int attempts, long initialMs, long maxMs)
    {
        var delay = initialMs * Math.Pow(2, Math.Max(attempts - 1, 0));
        return double.IsFinite(delay) && delay <= maxMs ? (long)delay : maxMs;
    }

    /// <summary>¿Se rinde una fila con este número de fallos? Con el contador YA incrementado.</summary>
    public static bool DeadLettered(int attempts, int maxAttempts) => attempts >= maxAttempts;

    /// <summary>El mensaje de un fallo, truncado a la cota de la columna.</summary>
    public static string? TruncateError(Exception? error)
    {
        var message = error?.Message;
        return message is null || message.Length <= LastErrorLength ? message : message[..LastErrorLength];
    }
}`;
}

function relayStoreBody(model) {
  const context = dbContextClass(model);
  return `/// <summary>Lo que el relay necesita de una fila reclamada para publicarla: una copia, no la entidad.</summary>
public sealed record ClaimedOutboxEvent(Guid Id, string Destination, string RoutingKey, string EventType, string Payload);

/// <summary>El desenlace de un fallo: cuántos intentos lleva la fila y si se rindió.</summary>
/// <remarks>
/// NextAttemptAtMs: cuándo vuelve a ser elegible la fila (milisegundos de la época; null si se rindió). El relay lo recuerda
/// para no esperar al sondeo de respaldo (DSL 2.26).
/// </remarks>
public sealed record MarkFailedOutcome(int Attempts, bool DeadLettered, long? NextAttemptAtMs = null);

/// <summary>
/// Las transacciones CORTAS del relay, separadas de la publicación al broker (E/S de red):
///   1. ClaimBatch: reclamo con SKIP LOCKED más un LEASE sobre next_attempt_at, que retira la fila de las siguientes
///      pasadas mientras dura el despacho. Confirma y suelta el lock en cuanto reclama;
///   2. MarkPublished / MarkFailed: el desenlace, cada uno en su transacción.
/// </summary>
/// <remarks>
/// El lease sustituye a la garantía que el SKIP LOCKED daba solo mientras la transacción seguía abierta: sin él, otra
/// réplica —o esta misma en la pasada siguiente— volvería a ver elegible una fila cuyo despacho sigue en vuelo. Si la
/// réplica muere, el lease caduca y otra la recoge. Cada método abre su propio ámbito: un DbContext y una transacción
/// que no son los de ningún caso de uso.
/// </remarks>
public sealed class OutboxRelayStore(IServiceScopeFactory scopes)
{
    public Task<IReadOnlyList<ClaimedOutboxEvent>> ClaimBatch(int maxAttempts, int batchSize, int claimTimeoutMs, CancellationToken cancellationToken = default) =>
        InNewTransaction<IReadOnlyList<ClaimedOutboxEvent>>(
            async db =>
            {
                var now = DateTimeOffset.UtcNow;
                // Pendientes, en orden de llegada, que no agotaron sus reintentos y cuyo backoff (o lease) venció. SKIP
                // LOCKED: con varias réplicas cada una se lleva un lote disjunto en vez de esperar a la otra.
                var rows = await db.Set<${OUTBOX_ROW}>()
                    .FromSql($"SELECT * FROM outbox_event WHERE published_at IS NULL AND attempts < {maxAttempts} AND (next_attempt_at IS NULL OR next_attempt_at <= {now}) ORDER BY created_at LIMIT {batchSize} FOR UPDATE SKIP LOCKED")
                    .AsNoTracking()
                    .ToListAsync(cancellationToken);
                if (rows.Count == 0)
                {
                    return [];
                }
                // El lease: si el despacho sale bien, MarkPublished la saca del todo; si falla, MarkFailed lo pisa con el
                // backoff de verdad.
                var leaseUntil = now.AddMilliseconds(claimTimeoutMs);
                var ids = rows.Select(row => row.Id).ToList();
                await db.Set<${OUTBOX_ROW}>()
                    .Where(row => ids.Contains(row.Id))
                    .ExecuteUpdateAsync(set => set.SetProperty(row => row.NextAttemptAt, leaseUntil), cancellationToken);
                return [.. rows.Select(row => new ClaimedOutboxEvent(row.Id, row.Destination, row.RoutingKey, row.EventType, row.Payload))];
            },
            readOnly: false,
            cancellationToken,
            // El aislamiento de un reclamo con SKIP LOCKED (READ COMMITTED en MySQL: sin él toma los huecos entre claves).
            PersistenceTransactions.ClaimIsolation);

    public Task MarkPublished(Guid id, CancellationToken cancellationToken = default) =>
        InNewTransaction(
            async db =>
            {
                var now = DateTimeOffset.UtcNow;
                return await db.Set<${OUTBOX_ROW}>()
                    .Where(row => row.Id == id)
                    .ExecuteUpdateAsync(set => set.SetProperty(row => row.PublishedAt, now), cancellationToken);
            },
            readOnly: false,
            cancellationToken);

    /// <summary>
    /// Incrementa el intento, decide rendición o backoff con el contador YA incrementado y lo aplica, todo en la misma
    /// transacción: el relay nunca vuelve a preguntar cuántos intentos lleva con otra consulta.
    /// </summary>
    public Task<MarkFailedOutcome> MarkFailed(Guid id, string? error, int maxAttempts, int backoffInitialMs, int backoffMaxMs, CancellationToken cancellationToken = default) =>
        InNewTransaction(
            async db =>
            {
                var rows = await db.Set<${OUTBOX_ROW}>().FromSql($"SELECT * FROM outbox_event WHERE id = {id} FOR UPDATE").ToListAsync(cancellationToken);
                // La fila desapareció entre el reclamo y el desenlace: nada que actualizar, y se da por agotada para no
                // reintentar sobre un id que ya no está.
                if (rows.Count == 0)
                {
                    return new MarkFailedOutcome(maxAttempts, true);
                }
                var row = rows[0];
                row.Attempts += 1;
                row.LastError = error;
                var deadLettered = OutboxBackoff.DeadLettered(row.Attempts, maxAttempts);
                long? nextAttemptAtMs = null;
                if (!deadLettered)
                {
                    row.NextAttemptAt = DateTimeOffset.UtcNow.AddMilliseconds(OutboxBackoff.BackoffMs(row.Attempts, backoffInitialMs, backoffMaxMs));
                    // Hacia ARRIBA: la columna guarda microsegundos, y truncado la pasada llegaría antes de que sea elegible.
                    nextAttemptAtMs = row.NextAttemptAt.Value.ToUnixTimeMilliseconds() + 1;
                }
                await db.SaveChangesAsync(cancellationToken);
                return new MarkFailedOutcome(row.Attempts, deadLettered, nextAttemptAtMs);
            },
            readOnly: false,
            cancellationToken);

    /// <summary>
    /// Cuántas filas se rindieron: agotaron los reintentos y siguen sin publicar. Es el dato de la única promesa del outbox
    /// —que ningún evento se pierde— justo cuando deja de cumplirse.
    /// </summary>
    public Task<int> CountDeadLettered(int maxAttempts, CancellationToken cancellationToken = default) =>
        InNewTransaction(
            db => db.Set<${OUTBOX_ROW}>().CountAsync(row => row.PublishedAt == null && row.Attempts >= maxAttempts, cancellationToken),
            readOnly: true,
            cancellationToken);

    private async Task<T> InNewTransaction<T>(Func<${context}, Task<T>> work, bool readOnly, CancellationToken cancellationToken, IsolationLevel? isolation = null)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        var transactions = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>();
        return await transactions.InTransaction(() => work(db), readOnly, cancellationToken, isolation);
    }
}`;
}

/**
 * La señal de una fila nueva en el outbox (DSL 2.26, inc. 9): la da el bridge tras el commit de la transacción que la
 * escribió, y la oye el relay de esta réplica, que sale en el acto en vez de esperar al sondeo de respaldo.
 */
function wakeupBody() {
  return `/// <summary>
/// El aviso de que ESTA réplica confirmó una fila nueva en el outbox: lo da el bridge tras el commit, y el relay lo escucha
/// para salir ya. Si la transacción revierte, el bridge no avisa.
/// </summary>
public sealed class OutboxWakeup
{
    private readonly List<Action> listeners = [];
    private readonly Lock gate = new();

    /// <summary>
    /// Lo llama el relay al arrancar, y se da de baja al parar (Dispose): un relay parado que siguiera suscrito recibiría
    /// el aviso sobre un semáforo ya desechado, y su excepción cortaría el de los demás.
    /// </summary>
    public IDisposable Subscribe(Action listener)
    {
        ArgumentNullException.ThrowIfNull(listener);
        lock (gate)
        {
            listeners.Add(listener);
        }
        return new Subscription(this, listener);
    }

    private void Unsubscribe(Action listener)
    {
        lock (gate)
        {
            listeners.Remove(listener);
        }
    }

    private sealed class Subscription(OutboxWakeup owner, Action listener) : IDisposable
    {
        public void Dispose() => owner.Unsubscribe(listener);
    }

    /// <summary>Lo programa el bridge para después del commit.</summary>
    public Task Notify()
    {
        Action[] current;
        lock (gate)
        {
            current = [.. listeners];
        }
        foreach (var listener in current)
        {
            listener();
        }
        return Task.CompletedTask;
    }
}`;
}

function relayBody(model) {
  const telemetry = usesTelemetry(model);
  return `/// <summary>
/// Reenvía al broker las filas pendientes del outbox, ya fuera de la transacción que las creó.
/// </summary>
/// <remarks>
/// <para>
/// Tres pasos, y la publicación no está dentro de ninguna transacción: OutboxRelayStore.ClaimBatch reclama el lote en una
/// transacción corta, el dispatcher publica sin conexión retenida, y el desenlace va en otra transacción corta. Un fallo
/// de entrega no revierte nada: cuenta el intento y la fila se reintenta tras su backoff (entrega at-least-once: el
/// consumidor deduplica por metadata.eventId). La que agota max-attempts se rinde: deja de reclamarse y se reporta a
/// ERROR, sin borrarse.
/// </para>
/// <para>
/// Corre POR RÉPLICA (DSL 2.26): lo despierta el commit que escribe en el outbox (OutboxWakeup), y la pasada siguiente va
/// en el acto con el lote lleno, al reintento más próximo que programó o al sondeo de respaldo (outbox.relay.poll-ms), lo
/// que llegue antes: relayNextRunMs de keel-core/gen/timer-plan.js. Al apagarse no empieza otra publicación: las filas
/// que quedan conservan su lease y otra pasada las recoge. Sin base de datos o con scheduling.enabled apagado (el perfil
/// test) no corre.
/// </para>
/// </remarks>
public sealed partial class OutboxRelay(
    OutboxRelayStore store,
    IOutboxDispatcher dispatcher,
    MessagingSettings messaging,
    DatabaseSettings database,
    OutboxWakeup wakeup,
    ILogger<OutboxRelay> logger) : BackgroundService
{
    private readonly OutboxRelaySettings settings = messaging.OutboxRelay ?? throw new InvalidOperationException("OutboxRelay sin outbox.relay en la configuración de mensajería");

    private readonly SemaphoreSlim pass = new(1, 1);

    /// <summary>El despertar: lo suelta el commit de una fila nueva o Resume(); una pasada lo consume.</summary>
    private readonly SemaphoreSlim woken = new(0, 1);

    private volatile bool paused;

    private volatile bool stopping;

    /// <summary>El reintento más próximo que esta réplica programó y aún no ha llegado (long.MaxValue: ninguno).</summary>
    private long pendingRetryMs = long.MaxValue;

    /// <summary>Cuándo toca la pasada siguiente, según la última.</summary>
    private long nextRunMs;

    private long passCount;

    private static long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!database.Enabled || !settings.Enabled)
        {
            return;
        }
        using var subscription = wakeup.Subscribe(Wake);${telemetry ? `
        // Las filas rendidas, leídas en cada scrape: la señal de que el outbox perdió algo (la alerta del panel).
        KeelTelemetry.Current?.RegisterGauge(Observations.OutboxDeadLettered, "Eventos del outbox que agotaron sus reintentos", async _ => (double)await CountDeadLettered());` : ''}
        using var registration = stoppingToken.Register(() => stopping = true);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!paused)
            {
                // Lo que despertó antes de esta pasada lo cubre ella; lo que despierte DURANTE la encadena.
                woken.Wait(0, CancellationToken.None);
                await pass.WaitAsync(CancellationToken.None);
                try
                {
                    if (!paused)
                    {
                        Interlocked.Increment(ref passCount);
                        await RelayOnce();
                    }
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    // Una pasada que falla entera (la base caída) no para el relay: lo intenta al sondeo de respaldo.
                    nextRunMs = NowMs + settings.PollMs;
                    LogPassFailed(error);
                }
                finally
                {
                    pass.Release();
                }
            }
            try
            {
                var delay = paused ? Timeout.Infinite : (int)Math.Clamp(nextRunMs - NowMs, 0, int.MaxValue);
                await woken.WaitAsync(delay, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Cuándo corre la pasada siguiente (relayNextRunMs de keel-core/gen/timer-plan.js): en el acto con el lote lleno; si
    /// no, al primero del reintento más próximo que esta réplica programó y del sondeo de respaldo. Un reintento ya vencido
    /// al empezar la pasada lo reclamó ella, así que se olvida.
    /// </summary>
    public long NextRun(bool full, long retryAtMs, long passStartMs)
    {
        var remembered = pendingRetryMs > passStartMs ? pendingRetryMs : long.MaxValue;
        pendingRetryMs = Math.Min(remembered, retryAtMs);
        var now = NowMs;
        if (full)
        {
            return now;
        }
        return Math.Min(pendingRetryMs, now + settings.PollMs);
    }

    /// <summary>Una fila nueva confirmada en ESTA réplica: el relay sale ya. Durante una pasada, la siguiente va sin dormir.</summary>
    public void Wake()
    {
        try
        {
            woken.Release();
        }
        catch (SemaphoreFullException)
        {
            // Ya había un despertar pendiente: uno basta.
        }
    }

    /// <summary>Cuántas pasadas lleva el relay de esta réplica: en reposo, una por sondeo de respaldo.</summary>
    public long Passes => Interlocked.Read(ref passCount);

    /// <summary>Una pasada: reclama, publica y registra el desenlace de cada fila. Devuelve cuántas reclamó.</summary>
    public async Task<int> RelayOnce()
    {
        var passStartMs = NowMs;
        var retryAtMs = long.MaxValue;
        var claimed = await store.ClaimBatch(settings.MaxAttempts, settings.BatchSize, settings.ClaimTimeoutMs);
        foreach (var row in claimed)
        {
            // Apagándose, no se empieza otra publicación: las filas que quedan conservan su lease y otra pasada (de esta
            // réplica al volver o de otra) las recoge cuando caduca.
            if (stopping)
            {
                break;
            }
            try
            {
${telemetry ? `                // Dentro de la traza de la fila (la que quedó en su envoltura): el relay publica en otro instante.
                await Publish(row.EventType, row.Payload, () => dispatcher.Dispatch(row.Destination, row.RoutingKey, row.EventType, row.Payload));` : '                await dispatcher.Dispatch(row.Destination, row.RoutingKey, row.EventType, row.Payload);'}
                await store.MarkPublished(row.Id);
                LogPublished(row.EventType, row.Id);
            }
            catch (Exception error)
            {
                var reason = OutboxBackoff.TruncateError(error);
                var outcome = await store.MarkFailed(row.Id, reason, settings.MaxAttempts, settings.BackoffInitialMs, settings.BackoffMaxMs);
                if (outcome.DeadLettered)
                {
                    // La rendición: queda parada para inspección, sin borrarse ni bloquear al resto.
                    LogDeadLettered(row.Id, settings.MaxAttempts, reason);
                }
                else
                {
                    if (outcome.NextAttemptAtMs is { } next)
                    {
                        retryAtMs = Math.Min(retryAtMs, next);
                    }
                    LogDeliveryFailed(row.Id, outcome.Attempts, reason);
                }
            }
        }
        nextRunMs = NextRun(claimed.Count >= settings.BatchSize, retryAtMs, passStartMs);
        return claimed.Count;
    }

    /// <summary>
    /// Suspende las pasadas, esperando a la que esté en vuelo. Es para el arnés de integración, que fabrica así la
    /// precondición de un escenario del outbox (una fila pendiente que nadie entrega todavía).
    /// </summary>
    public async Task Pause()
    {
        paused = true;
        await pass.WaitAsync();
        pass.Release();
    }

    /// <summary>Reanuda las pasadas suspendidas con Pause(), con una en el acto: lo escrito durante la pausa no despertó a nadie.</summary>
    public void Resume()
    {
        paused = false;
        Wake();
    }

    /// <summary>Las filas rendidas ahora mismo: la señal de que el outbox perdió algo (la mide el arnés).</summary>
    public Task<int> CountDeadLettered() => store.CountDeadLettered(settings.MaxAttempts);
${telemetry ? `
    /// <summary>La publicación de una fila en un span PRODUCER que continúa la traza de su envoltura (metadata.traceparent).</summary>
    private static Task Publish(string eventType, string payload, Func<Task> dispatch) =>
        KeelTelemetry.Current is { } telemetry ? telemetry.Publishing(eventType, TraceparentOf(payload), dispatch) : dispatch();

    /// <summary>El traceparent de la envoltura guardada en la fila, o null si no lo trae (o no se puede leer).</summary>
    private static string? TraceparentOf(string payload)
    {
        try
        {
            using var envelope = JsonDocument.Parse(payload);
            return envelope.RootElement.TryGetProperty("metadata", out var metadata)
                && metadata.ValueKind == JsonValueKind.Object
                && metadata.TryGetProperty("traceparent", out var traceparent)
                && traceparent.ValueKind == JsonValueKind.String
                ? traceparent.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
` : ''}
    public override void Dispose()
    {
        pass.Dispose();
        woken.Dispose();
        base.Dispose();
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "Outbox: {EventType} publicado ({Id})")]
    private partial void LogPublished(string eventType, Guid id);

    [LoggerMessage(Level = LogLevel.Error, Message = "Outbox: {Id} agotó {MaxAttempts} reintentos y queda como dead-letter: {Reason}")]
    private partial void LogDeadLettered(Guid id, int maxAttempts, string? reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Outbox: fallo entregando {Id} (intento {Attempt}): {Reason}")]
    private partial void LogDeliveryFailed(Guid id, int attempt, string? reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "Outbox: la pasada del relay falló")]
    private partial void LogPassFailed(Exception error);
}`;
}

// ─── La guarda de los mensajes procesados ────────────────────────────────────────────────────────

function guardBody(model) {
  const context = dbContextClass(model);
  return `/// <summary>
/// Guarda de idempotencia del consumidor. La entrega de cualquier broker es at-least-once y el relay del outbox
/// reintenta: la reentrega no es un caso raro, es lo normal ante cualquier corte.
/// </summary>
/// <remarks>
/// <para>
/// Hay DOS órdenes y no son intercambiables. El registro va en su PROPIA transacción (sobrevive al fallo del handler), y
/// por eso el orden importa:
///   1. procesar y luego registrar (AlreadyProcessed antes, Record después de que el handler termine bien). Es el
///      predeterminado: un fallo transitorio deja el mensaje sin marcar y la reentrega lo reintenta. Si el proceso muere
///      entre el commit del negocio y el registro, la reentrega se procesa dos veces: por eso este orden pide una guarda
///      de dominio detrás;
///   2. registrar y luego procesar (TryRecord, atómico). Cierra la ventana del duplicado, pero convierte un fallo
///      transitorio en un mensaje PERDIDO. Solo si reprocesar es inaceptable y perder tolerable.
/// Cuál toca lo dice el mensaje de cada suscripción.
/// </para>
/// <para>
/// Con varias réplicas, dos entregas del mismo mensaje pueden procesarse a la vez: el árbitro es la clave primaria de
/// processed_event, que es compartida.
/// </para>
/// </remarks>
public sealed partial class IdempotencyGuard(IServiceScopeFactory scopes, ILogger<IdempotencyGuard> logger)
{
    /// <summary>¿Ya se procesó este mensaje? Sin efectos, para descartar la reentrega antes de despachar.</summary>
    /// <param name="handlerId">El consumidor (el nombre de la clase del listener).</param>
    /// <param name="eventId">El id del mensaje (el messageId del diseño o Metadata.EventId).</param>
    public async Task<bool> AlreadyProcessed(string handlerId, string eventId, CancellationToken cancellationToken = default)
    {
        var seen = await InNewTransaction(
            db => db.Set<${PROCESSED_ROW}>().AnyAsync(row => row.HandlerId == handlerId && row.EventId == eventId, cancellationToken),
            readOnly: true,
            cancellationToken);
        if (seen)
        {
            LogDuplicate(handlerId, eventId, "ya procesado");
        }
        return seen;
    }

    /// <summary>
    /// Registra el mensaje como procesado, en su propia transacción. true si lo registró esta llamada; false si otra
    /// entrega simultánea llegó primero — no es un error, es la carrera resuelta en la clave.
    /// </summary>
    public async Task<bool> Record(string handlerId, string eventId, CancellationToken cancellationToken = default)
    {
        try
        {
            await InNewTransaction(
                async db =>
                {
                    db.Set<${PROCESSED_ROW}>().Add(new ${PROCESSED_ROW} { HandlerId = handlerId, EventId = eventId, ProcessedAt = DateTimeOffset.UtcNow });
                    return await db.SaveChangesAsync(cancellationToken);
                },
                readOnly: false,
                cancellationToken);
            return true;
        }
        catch (Exception error) when (PersistenceErrors.IsUniqueViolation(error))
        {
            LogDuplicate(handlerId, eventId, "carrera resuelta en la clave");
            return false;
        }
    }

    /// <summary>
    /// Reclama el mensaje ANTES de procesarlo, de forma atómica: es la MISMA inserción que Record, llamada antes. true si
    /// es la primera vez y hay que procesar; false si es un duplicado.
    /// </summary>
    public Task<bool> TryRecord(string handlerId, string eventId, CancellationToken cancellationToken = default) =>
        Record(handlerId, eventId, cancellationToken);

    private async Task<T> InNewTransaction<T>(Func<${context}, Task<T>> work, bool readOnly, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        var transactions = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>();
        return await transactions.InTransaction(() => work(db), readOnly, cancellationToken);
    }

    /// <summary>El descarte de una reentrega: lo primero que se busca cuando «el evento llegó y no pasó nada».</summary>
    [LoggerMessage(Level = LogLevel.Information, Message = "Mensaje duplicado descartado por {HandlerId} ({Reason}): {EventId}")]
    private partial void LogDuplicate(string handlerId, string eventId, string reason);
}`;
}
