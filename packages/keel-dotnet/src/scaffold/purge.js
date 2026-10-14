// La purga POR LOTES de las tablas del generador en la rama relacional: `outbox_event`, `processed_event` e
// `idempotency_record` (incremento 10b).
//
// Las mismas que purgan los servidores de keel-spring y keel-nest del mismo diseño, con la misma forma
// (keel-core/gen/scheduling.js, `BATCHED_PURGE`): un único DELETE sobre todo lo caducado es una transacción del tamaño
// del atraso —tras una caída del broker, millones de filas que retienen sus bloqueos, llenan el WAL y, con el tope de
// transacción del servicio, no terminan nunca—. El lote se acota por INSTANTE: se lee el de la fila que ocupa la
// posición N entre las que hay que purgar y se borra hasta él, cada lote en su propia transacción.
//
// Dos archivos: el bucle (`BatchedPurge.cs`, sin EF, para poder ejecutarlo en la prueba emitida contra los casos de la
// referencia de keel-core) y las purgas con su configuración (`TablePurges.cs`), con las mismas claves, variables y
// defaults que keel-spring. El SQL de cada purga va LITERAL: la tabla y la columna son del generador, y lo único que
// viaja como parámetro son los instantes.

import { BATCHED_PURGE, batchedPurgeParameters } from 'keel-core/gen';
import { OUTBOX_EVENT, OUTBOX_PURGE, PROCESSED_EVENT, PROCESSED_EVENT_PURGE } from 'keel-core/gen/messaging-stores';
import { IDEMPOTENCY_RECORD, IDEMPOTENCY_RECORD_PURGE } from 'keel-core/gen/request-idempotency';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { dbContextClass, persistenceNamespace, usesRelational } from './persistence.js';
import { usesDotnetOutbox, usesProcessedEvents } from './messaging.js';
import { usesRequestIdempotency } from './request-idempotency.js';
import { reconciliationPurge } from './reconciliation-claim.js';
import { RECONCILIATION_CLAIM } from 'keel-core/gen/reconciliation-stores';

export function purgeNamespace(model) {
  return namespaceOf(model, 'purge');
}

/**
 * Las purgas de ESTE diseño, como datos: qué tabla, por qué columna se corta, qué condición propia lleva (lo pendiente
 * del outbox no se toca nunca), con qué retención y bajo qué prefijo de configuración. Las mismas que keel-nest.
 */
export function tablePurges(model) {
  if (!usesRelational(model)) return [];
  const purges = [];
  if (usesDotnetOutbox(model)) {
    purges.push({
      key: 'Outbox',
      what: 'outbox_event',
      method: 'PurgeOutbox',
      table: OUTBOX_EVENT.table,
      column: 'published_at',
      predicate: 'published_at IS NOT NULL',
      prefix: 'outbox.purge',
      cron: OUTBOX_PURGE.cron,
      retentionDays: OUTBOX_PURGE.retentionDays,
      log: 'Outbox: purgadas {Deleted} filas publicadas antes de {Cutoff}'
    });
  }
  if (usesProcessedEvents(model)) {
    purges.push({
      key: 'ProcessedEvent',
      what: 'processed_event',
      method: 'PurgeProcessedEvents',
      table: PROCESSED_EVENT.table,
      column: 'processed_at',
      predicate: null,
      prefix: 'processed-event.purge',
      cron: PROCESSED_EVENT_PURGE.cron,
      retentionDays: PROCESSED_EVENT_PURGE.retentionDays,
      log: 'Idempotencia: purgados {Deleted} mensajes procesados antes de {Cutoff}'
    });
  }
  if (usesRequestIdempotency(model)) {
    purges.push({
      key: 'IdempotencyRecord',
      what: 'idempotency_record',
      method: 'PurgeIdempotencyRecords',
      table: IDEMPOTENCY_RECORD.table,
      column: 'expires_at',
      predicate: null,
      prefix: 'idempotency-record.purge',
      cron: IDEMPOTENCY_RECORD_PURGE.cron,
      // Sin retención: cada fila lleva su caducidad (expires_at), calculada con el ttlSeconds del diseño.
      retentionDays: null,
      log: 'Idempotencia HTTP: purgadas {Deleted} claves caducadas antes de {Cutoff}'
    });
  }
  // Las marcas del reclamo de reconciliación (incremento 11c): la misma purga que keel-nest.
  const reconciliation = reconciliationPurge(model);
  if (reconciliation) purges.push(reconciliation);
  // Las columnas que se nombran tienen que existir en los datos de la tabla: si keel-core renombrara una, la purga
  // borraría por una columna que no está y fallaría cada noche sin que nada lo dijera antes.
  for (const purge of purges) {
    const table = [OUTBOX_EVENT, PROCESSED_EVENT, IDEMPOTENCY_RECORD, RECONCILIATION_CLAIM].find((candidate) => candidate.table === purge.table);
    if (!table.columns.some((column) => column.name === purge.column)) {
      throw new Error(`La purga de ${purge.table} corta por ${purge.column}, que no es columna de la tabla en keel-core`);
    }
  }
  return purges;
}

export function usesTablePurges(model) {
  return tablePurges(model).length > 0;
}

/**
 * Los casos con los que la prueba emitida ejecuta el bucle: instantes en ms (con repetidos en la frontera y con tope), el
 * corte en 1000, y lo que sale según la REFERENCIA de keel-core (`batchedPurgeReference`). `test/scheduling.test.js`
 * vuelve a calcular cada resultado con la referencia: si alguien toca un número aquí, cae allí.
 */
export const PURGE_CASES = Object.freeze([
  { instants: [], batchSize: 3, maxBatches: 5, deleted: 0, deletes: 1, exhausted: false, remaining: [] },
  { instants: [10, 20], batchSize: 3, maxBatches: 5, deleted: 2, deletes: 1, exhausted: false, remaining: [] },
  { instants: [10, 20, 20, 20, 30, 40, 50, 60, 1500, 2000], batchSize: 3, maxBatches: 5, deleted: 8, deletes: 3, exhausted: false, remaining: [1500, 2000] },
  {
    instants: Array.from({ length: 20 }, (_, i) => i * 10),
    batchSize: 2,
    maxBatches: 3,
    deleted: 6,
    deletes: 3,
    exhausted: true,
    remaining: Array.from({ length: 14 }, (_, i) => 60 + i * 10)
  }
]);
export const PURGE_CASES_CUTOFF = 1000;

export function generate(model) {
  const purges = tablePurges(model);
  if (purges.length === 0) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'purge', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    file('BatchedPurge', [], batchedPurgeBody()),
    file('PurgeSettings', ['System.Globalization', configNamespace(model)], settingsBody(purges)),
    file(
      'TablePurges',
      ['Microsoft.EntityFrameworkCore', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Logging', persistenceNamespace(model), namespaceOf(model, 'scheduling')],
      tablePurgesBody(model, purges)
    )
  ];
  // La cadencia de la purga del registro de idempotencia, en su propio fragmento como en keel-spring y keel-nest (las del
  // outbox y de processed_event van en messaging.yaml). El perfil test no lo lleva: allí no corre el reloj.
  if (purges.some((purge) => purge.key === 'IdempotencyRecord')) {
    for (const profile of ['local', 'develop', 'production']) {
      files.push({ path: `config/parameters/${profile}/idempotency.yaml`, content: idempotencyYaml(profile) });
    }
  }
  return files;
}

/** El MISMO texto que el idempotency.yaml de keel-nest. */
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

function batchedPurgeBody() {
  return `/// <summary>
/// La purga POR LOTES, cada lote en su propia transacción: la de los servidores de keel-spring y keel-nest del diseño
/// (keel-core/gen/scheduling.js, BATCHED_PURGE).
/// </summary>
/// <remarks>
/// <para>
/// Las filas que comparten instante con la frontera caen en el mismo lote, así que un lote puede pasar de batchSize: la
/// cota es aproximada a propósito. Alcanzado maxBatches, avisa y deja el resto a la siguiente pasada: sin tope, un atraso
/// enorme haría de la pasada nocturna un proceso de horas compitiendo con el tráfico de la mañana.
/// </para>
/// <para>
/// Corre en todas las réplicas a la vez y no se coordina: borrar es idempotente, y dos réplicas que se solapan solo
/// borran menos cada una.
/// </para>
/// </remarks>
public static class BatchedPurge
{
    /// <summary>Filas por lote y lotes por pasada: los de keel-spring y keel-nest.</summary>
    public const int DefaultBatchSize = ${BATCHED_PURGE.batchSize};

    public const int DefaultMaxBatches = ${BATCHED_PURGE.maxBatches};

    /// <summary>Purga lo anterior a <paramref name="cutoff"/>. Devuelve las filas borradas en total.</summary>
    /// <param name="what">El nombre de la tabla, para el aviso.</param>
    /// <param name="boundary">El instante de la fila en esa POSICIÓN entre las que hay que purgar, o null si quedan menos.</param>
    /// <param name="deleteUpTo">Borra lo anterior al corte hasta ese instante incluido, en SU PROPIA transacción; devuelve cuántas.</param>
    /// <param name="warn">Dónde se avisa de que la pasada llegó a su tope con filas pendientes.</param>
    public static async Task<long> Run(
        string what,
        int batchSize,
        int maxBatches,
        DateTimeOffset cutoff,
        Func<int, Task<DateTimeOffset?>> boundary,
        Func<DateTimeOffset, Task<int>> deleteUpTo,
        Action<string> warn)
    {
        ArgumentNullException.ThrowIfNull(boundary);
        ArgumentNullException.ThrowIfNull(deleteUpTo);
        ArgumentNullException.ThrowIfNull(warn);
        if (batchSize < 1 || maxBatches < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(batchSize), $"{what}: batch-size y max-batches tienen que ser enteros positivos");
        }
        long total = 0;
        for (var batch = 0; batch < maxBatches; batch++)
        {
            var edge = await boundary(batchSize - 1);
            if (edge is null)
            {
                // Queda menos de un lote: el último, entero.
                return total + await deleteUpTo(cutoff);
            }
            total += await deleteUpTo(edge.Value);
        }
        warn($"{what}: la purga llegó a su tope de {maxBatches} lotes de {batchSize} filas y quedan filas por purgar; la siguiente pasada sigue");
        return total;
    }
}`;
}

const configKey = (key) => key.replaceAll('.', ':');

function settingsBody(purges) {
  const read = (purge) => {
    const batch = batchedPurgeParameters(purge.prefix);
    const retention = purge.retentionDays ? `Positive(configuration, ${csString(configKey(purge.retentionDays.key))}, ${purge.retentionDays.default})` : 'null';
    return `            ${purge.key}: new PurgeSchedule(
                Text(configuration, ${csString(configKey(purge.cron.key))}, ${csString(purge.cron.default)}),
                ${retention},
                Positive(configuration, ${csString(configKey(batch.batchSize.key))}, ${batch.batchSize.default}),
                Positive(configuration, ${csString(configKey(batch.maxBatches.key))}, ${batch.maxBatches.default}))`;
  };
  return `/// <summary>Una purga: su cron (seis campos, con segundos), la retención en días donde la hay, y el lote y su tope.</summary>
public sealed record PurgeSchedule(string Cron, int? RetentionDays, int BatchSize, int MaxBatches);

/// <summary>
/// Las purgas del perfil activo, con las claves y los defaults de los servidores de keel-spring y keel-nest. Un valor que
/// no es un entero positivo no deja arrancar.
/// </summary>
public sealed record PurgeSettings(${purges.map((purge) => `PurgeSchedule ${purge.key}`).join(', ')})
{
    public static PurgeSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new PurgeSettings(
${purges.map(read).join(',\n')});
    }

    private static string Text(ServiceConfiguration configuration, string key, string fallback) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : fallback;

    private static int Positive(ServiceConfiguration configuration, string key, int fallback)
    {
        var value = configuration.Get(key);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un entero positivo: '{value}'");
    }
}`;
}

function tablePurgesBody(model, purges) {
  const context = dbContextClass(model);
  const tasks = purges.map(
    (purge) =>
      `            new(${csString(`purge:${purge.what}`)}, settings.${purge.key}.Cron, (services, cancellationToken) => services.GetRequiredService<TablePurges>().${purge.method}(null, cancellationToken))`
  );
  const methods = purges.map((purge) => {
    // La frontera y el borrado llevan la MISMA condición: la frontera tiene que contar las filas que el borrado se lleva,
    // o el lote deja de medir lo que dice.
    const where = [purge.predicate, `${purge.column} < {cutoff}`].filter(Boolean).join(' AND ');
    const cutoff = purge.retentionDays ? `instant - TimeSpan.FromDays(settings.${purge.key}.RetentionDays!.Value)` : 'instant';
    return `    /// <summary>La purga de ${purge.what}${purge.predicate ? ` (solo ${purge.predicate})` : ''}. Devuelve las filas borradas.</summary>
    public async Task<long> ${purge.method}(DateTimeOffset? now = null, CancellationToken cancellationToken = default)
    {
        if (!database.Enabled)
        {
            return 0;
        }
        var instant = (now ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var cutoff = ${cutoff};
        var schedule = settings.${purge.key};
        var deleted = await BatchedPurge.Run(
            ${csString(purge.what)},
            schedule.BatchSize,
            schedule.MaxBatches,
            cutoff,
            position => Read(db => db.Database
                .SqlQuery<DateTimeOffset>($"SELECT ${purge.column} AS \\"Value\\" FROM ${purge.table} WHERE ${where} ORDER BY ${purge.column} OFFSET {position} LIMIT 1")
                .ToListAsync(cancellationToken), cancellationToken),
            upTo => Delete(db => db.Database
                .ExecuteSqlAsync($"DELETE FROM ${purge.table} WHERE ${where} AND ${purge.column} <= {upTo.ToUniversalTime()}", cancellationToken), cancellationToken),
            LogExhausted);
        if (deleted > 0)
        {
            Log${purge.key}Purged(deleted, cutoff);
        }
        return deleted;
    }`;
  });
  const logs = purges.map(
    (purge) => `    [LoggerMessage(Level = LogLevel.Information, Message = ${csString(purge.log)})]
    private partial void Log${purge.key}Purged(long deleted, DateTimeOffset cutoff);`
  );
  return `/// <summary>
/// Las purgas de las tablas del generador, cada una con su reloj. Por lotes y SIN transacción abarcadora: cada lote
/// confirma en la suya (BatchedPurge). Una sola transacción alrededor de todo volvería a ser el DELETE único que esto
/// sustituye. Sin base de datos (el perfil test) no hacen nada.
/// </summary>
public sealed partial class TablePurges(IServiceScopeFactory scopes, PurgeSettings settings, DatabaseSettings database, ILogger<TablePurges> logger)
{
    /// <summary>Las tareas por reloj de las purgas, con el cron del perfil.</summary>
    public static IReadOnlyList<ScheduledTask> Tasks(PurgeSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return
        [
${tasks.join(',\n')}
        ];
    }

${methods.join('\n\n')}

    /// <summary>La frontera del lote: una lectura, en su propio ámbito.</summary>
    private async Task<DateTimeOffset?> Read(Func<${context}, Task<List<DateTimeOffset>>> query, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await using var scope = scopes.CreateAsyncScope();
        var rows = await query(scope.ServiceProvider.GetRequiredService<${context}>());
        return rows.Count == 0 ? null : rows[0];
    }

    /// <summary>
    /// Un lote en una transacción NUEVA, con el tope de transacción del servicio: confirma y suelta sus bloqueos antes
    /// del siguiente.
    /// </summary>
    private async Task<int> Delete(Func<${context}, Task<int>> statement, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<${context}>();
        var transactions = scope.ServiceProvider.GetRequiredService<PersistenceTransactions>();
        return await transactions.InTransaction(() => statement(db), readOnly: false, cancellationToken);
    }

${logs.join('\n\n')}

    [LoggerMessage(Level = LogLevel.Warning, Message = "{Message}")]
    private partial void LogExhausted(string message);
}`;
}
