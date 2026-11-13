// El HISTORIAL DE CAMBIOS consultable (DSL 2.29: `persistence.audit.history` y la query de `output: { history }`) en
// keel-dotnet: incremento 3 de PLAN-DSL-229-HISTORIAL.md, con el reparto de keel-spring y keel-nest. Lo que decide QUÉ
// (qué raíces, qué rutas registra cada una, cuáles son personales, el diff, el orden, los filtros, las tablas y sus
// sentencias, la nota) es de keel-core (gen/history.js, gen/history-store.js); aquí solo se escribe en C#:
//
//   · `Domain/History`: la entrada y el cambio del cable y el filtro, lo único que el puerto de la raíz nombra. Los
//     valores de un cambio son `JsonElement`: ya están en la forma del cable, y el dominio no sabe escribirla.
//   · `Infrastructure/Persistence/History`: el diff (D2) sobre el TEXTO del cable, la reescritura de lo personal (D8), las
//     rutas personales de cada raíz y el almacén (D6, D11): `ChangeHistory` con las sentencias de keel-core TAL CUAL por la
//     conexión y la transacción del DbContext (como TimerStore), y las dos tablas mapeadas solo para el esquema; o un
//     documento por entrada en MongoDB. En infraestructura, como en keel-nest: el valor del cable lo escribe `WireJson`
//     (Application/Support), que el dominio no ve.
//   · El ADAPTADOR de la raíz escribe la entrada en su `Save`/`DeleteById`/`Restore` (D1), dentro de su transacción. T1: EF
//     tiene la fila RASTREADA que el Save ya carga, así que la instantánea «antes» sale de ella antes de volcar el agregado
//     (como keel-spring), sin otra lectura; en documental se lee el documento antes de escribirlo (como keel-nest). La
//     lectura es `HistoryOf`, que carga la raíz con la misma lectura que su ficha (D7).
//   · La retención se lleva el historial (`then: delete`) o lo anonimiza (`then: anonymize`), en data-lifecycle.js.

import { usesHistory, historyPersonalPatterns, historyNote } from '@keel-system/keel-core/gen/history';
import {
  CHANGE_HISTORY,
  CHANGE_HISTORY_FIELD,
  CHANGE_HISTORY_COLLECTION,
  HISTORY_ENGINES,
  HISTORY_FILTER_ORDER,
  historyStatements
} from '@keel-system/keel-core/gen/history-store';
import { scopedLoadOf } from '@keel-system/keel-core/gen/read-scope';
import { csFile, csLocal, csMember, csString, csVerbatim, located, namespaceOf, solution } from './render.js';

export { usesHistory };

export const HISTORY_ENTRY = 'HistoryEntry';
export const CHANGE_HISTORY_CLASS = 'ChangeHistory';
export const CHANGE_HISTORY_ROW = 'ChangeHistoryRow';
export const CHANGE_HISTORY_FIELD_ROW = 'ChangeHistoryFieldRow';

const isDocument = (model) => model.persistenceKind === 'document';
const isMySql = (model) => model.stack?.database === 'mysql';

/** ¿Lleva historial esta raíz? */
export const recordsHistory = (entity) => Boolean(entity?.history && entity.historyShape);

/** El namespace de la entrada, el cambio y el filtro (Domain/History). */
export const historyNamespace = (model) => namespaceOf(model, 'history');

/** El namespace del almacén, el diff y las raíces (Infrastructure/Persistence/History). */
export const historyInfraNamespace = (model) => namespaceOf(model, 'historyInfra');

/** La raíz en `HistoryRoots`: su tipo y sus rutas personales. */
export const rootMember = (entity) => `HistoryRoots.${entity.name}`;

/**
 * Lo que el historial no puede generar con este stack, o []: las sentencias son de PostgreSQL y MySQL (las mide
 * timer-sql-check) y el documental es MongoDB. Una réplica no es un agregado de este servicio. El mismo criterio que
 * keel-spring y keel-nest.
 */
export function historyStackErrors(model) {
  if (!usesHistory(model)) return [];
  const errors = [];
  if (!isDocument(model) && !HISTORY_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `persistence: audit.history (DSL 2.29): el almacén del historial tiene sentencias medidas para ${HISTORY_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores.`
    );
  }
  for (const entity of model.entities.filter((candidate) => candidate.history)) {
    if (entity.replicaOf) errors.push(`persistence: audit.history: ${entity.name} es la copia local de otro servicio, no un agregado de este.`);
  }
  return errors;
}

// ─── Lo que nombra el dominio ────────────────────────────────────────────────────────────────────────────────────

function entryFile(model) {
  const { namespace, path } = located(model, 'history', HISTORY_ENTRY);
  const body = `/// <summary>
/// Un campo que cambió en una escritura (wire-contract.md § Historial): su ruta del contrato y sus valores antes y después,
/// ya en la forma del cable (null cuando no había o ya no hay). Se escriben aunque sean null: un historial que calla el
/// <c>before</c> no dice desde qué valor cambió.
/// </summary>
public sealed record FieldChange(
    [property: JsonPropertyName("field")] string Field,
    [property: JsonPropertyName("before")] JsonElement Before,
    [property: JsonPropertyName("after")] JsonElement After);

/// <summary>Lo que pasó en una escritura (D2): el <c>change</c> del cable.</summary>
public static class HistoryChanges
{
    public const string Created = "created";

    public const string Updated = "updated";

    public const string Deleted = "deleted";

    public const string Restored = "restored";

    public const string Anonymized = "anonymized";
}

/// <summary>
/// Una entrada del historial: una escritura confirmada sobre el agregado (D2). <c>Author</c> es el actor de la autoría, o el
/// centinela <c>system</c> fuera de una petición. Las propiedades van en el orden del cable.
/// </summary>
public sealed record HistoryEntry(
    [property: JsonPropertyName("at")] DateTimeOffset At,
    [property: JsonPropertyName("author")] string Author,
    [property: JsonPropertyName("change")] string Change,
    [property: JsonPropertyName("changes")] IReadOnlyList<FieldChange> Changes);

/// <summary>
/// Los filtros de una lectura del historial (D10), los tres opcionales y combinados con AND: <c>Field</c> casa la ruta
/// entera o el campo de la raíz que la contiene (<c>price</c> casa <c>price.amount</c>); <c>From</c> y <c>To</c> incluyen su extremo.
/// </summary>
public sealed record HistoryFilter(string? Field, DateTimeOffset? From, DateTimeOffset? To)
{
    /// <summary>Sin filtros: el historial entero.</summary>
    public static HistoryFilter None { get; } = new(null, null, null);
}`;
  return { path, content: csFile({ namespace, usings: ['System.Text.Json', 'System.Text.Json.Serialization'], body }) };
}

// ─── El diff, la anonimización y las raíces ──────────────────────────────────────────────────────────────────────

function supportFile(model) {
  const { namespace, path } = located(model, 'historyInfra', 'HistorySupport');
  const roots = model.entities.filter(recordsHistory).map((entity) => {
    const personal = historyPersonalPatterns(entity.historyShape).map(
      (entry) => `new PersonalPath(new Regex(${csVerbatim(entry.pattern)}, RegexOptions.CultureInvariant), ${entry.required})`
    );
    return `    /// <summary>El historial de ${entity.name}: el tipo con que se guardan sus entradas y sus rutas personales.</summary>
    public static readonly HistoryRoot ${entity.name} = new(${csString(entity.name)}, ${personal.length > 0 ? `[${personal.join(', ')}]` : '[]'});`;
  });
  const body = `/// <summary>
/// Una ruta personal del historial de una raíz (DSL 2.28): el patrón de keel-core (<c>historyPersonalPatterns</c>, anclado) y
/// si el campo es obligatorio, que decide qué vale al anonimizar: el sustituto <c>anon-&lt;id&gt;</c> o null.
/// </summary>
public sealed record PersonalPath(Regex Pattern, bool Required);

/// <summary>Una raíz con historial: el nombre del diseño (contrato con los otros generadores) y sus rutas personales.</summary>
public sealed record HistoryRoot(string Type, IReadOnlyList<PersonalPath> Personal);

/// <summary>Las raíces del servicio que llevan historial (persistence.audit.history).</summary>
public static class HistoryRoots
{
${roots.join('\n\n')}
}

/// <summary>
/// Lo que el adaptador y el almacén comparten: la instantánea del agregado como texto del cable, el diff (D2, D3), las
/// filas del filtro por campo y la reescritura de lo personal (D8). Las referencias ejecutables son las de keel-core
/// (<c>historyDiff</c>, <c>anonymizeHistoryChanges</c>, <c>anonymizedEntryChanges</c>).
/// </summary>
public static class HistorySupport
{
    private static readonly Lock IdLock = new();

    private static Guid lastId;

    /// <summary>
    /// El id de una entrada: un UUID versión 7 que además CRECE dentro del proceso. Es el desempate de dos entradas con la misma
    /// hora (D10), y <c>Guid.CreateVersion7()</c> no lo promete dentro de un mismo milisegundo, que es la precisión de la hora en
    /// MongoDB: dos escrituras seguidas podían leerse al revés.
    /// </summary>
    public static Guid NextId()
    {
        var id = Guid.CreateVersion7();
        lock (IdLock)
        {
            if (string.CompareOrdinal(id.ToString("D"), lastId.ToString("D")) <= 0)
            {
                var bytes = lastId.ToByteArray(bigEndian: true);
                for (var index = bytes.Length - 1; index >= 0 && ++bytes[index] == 0; index--)
                {
                }
                id = new Guid(bytes, bigEndian: true);
            }
            lastId = id;
            return id;
        }
    }

    /// <summary>El texto del cable de un valor del dominio: el mismo serializador que escribe las respuestas.</summary>
    public static string WireText(object? value) => JsonSerializer.Serialize(value, WireJson.Options);

    /// <summary>El id de una raíz o de una hija como texto: el de la columna <c>root_id</c> y el de la ruta de una hija.</summary>
    public static string Key<T>(T id)
        where T : notnull => id is IFormattable formattable ? formattable.ToString(null, CultureInfo.InvariantCulture) : id.ToString() ?? string.Empty;

    /// <summary>
    /// Lo que cambió entre dos instantáneas (ruta del contrato → texto del cable). <c>before</c> null es un alta. Solo lo que
    /// cambió, ordenado por ruta, con los valores leídos del cable (un número conserva su texto).
    /// </summary>
    public static IReadOnlyList<FieldChange> Diff(IReadOnlyDictionary<string, string>? before, IReadOnlyDictionary<string, string> after)
    {
        ArgumentNullException.ThrowIfNull(after);
        var paths = new SortedSet<string>(after.Keys, StringComparer.Ordinal);
        if (before is not null)
        {
            paths.UnionWith(before.Keys);
        }
        var changes = new List<FieldChange>();
        foreach (var path in paths)
        {
            var was = before is not null && before.TryGetValue(path, out var previous) ? previous : "null";
            var now = after.TryGetValue(path, out var current) ? current : "null";
            if (!string.Equals(was, now, StringComparison.Ordinal))
            {
                changes.Add(new FieldChange(path, Element(was), Element(now)));
            }
        }
        return changes;
    }

    /// <summary>Las filas del filtro por campo de una entrada: su ruta y el campo de la raíz que la contiene, sin repetir ruta.</summary>
    public static IReadOnlyList<(string Path, string Top)> FieldRows(IReadOnlyList<FieldChange> changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rows = new List<(string Path, string Top)>();
        foreach (var change in changes)
        {
            if (seen.Add(change.Field))
            {
                rows.Add((change.Field, change.Field.Split('.', '[')[0]));
            }
        }
        return rows;
    }

    /// <summary>
    /// Los cambios de una entrada con lo personal reescrito (D8), y si alguno cambió: <c>before</c> y <c>after</c> pasan al
    /// sustituto o a null.
    /// </summary>
    public static (IReadOnlyList<FieldChange> Changes, bool Touched) Anonymize(IReadOnlyList<FieldChange> changes, IReadOnlyList<PersonalPath> personal, string rootId)
    {
        ArgumentNullException.ThrowIfNull(changes);
        ArgumentNullException.ThrowIfNull(personal);
        var touched = false;
        var rewritten = new List<FieldChange>();
        foreach (var change in changes)
        {
            var match = PersonalMatch(personal, change.Field);
            if (match is null)
            {
                rewritten.Add(change);
                continue;
            }
            var value = Anonymized(match, rootId);
            if (!string.Equals(change.Before.GetRawText(), value.GetRawText(), StringComparison.Ordinal) || !string.Equals(change.After.GetRawText(), value.GetRawText(), StringComparison.Ordinal))
            {
                touched = true;
            }
            rewritten.Add(new FieldChange(change.Field, value, value));
        }
        return (rewritten, touched);
    }

    /// <summary>Los cambios de la entrada <c>anonymized</c> (D8): una por ruta personal que aparece en el historial, por ruta.</summary>
    public static IReadOnlyList<FieldChange> AnonymizedEntryChanges(IEnumerable<IReadOnlyList<FieldChange>> entries, IReadOnlyList<PersonalPath> personal, string rootId)
    {
        ArgumentNullException.ThrowIfNull(entries);
        ArgumentNullException.ThrowIfNull(personal);
        var seen = new SortedDictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var changes in entries)
        {
            foreach (var change in changes)
            {
                if (!seen.ContainsKey(change.Field) && PersonalMatch(personal, change.Field) is { } match)
                {
                    seen[change.Field] = Anonymized(match, rootId);
                }
            }
        }
        return [.. seen.Select(entry => new FieldChange(entry.Key, entry.Value, entry.Value))];
    }

    /// <summary>Los cambios de una entrada como se guardan: con las reglas del cable.</summary>
    public static string WriteChanges(IReadOnlyList<FieldChange> changes) => JsonSerializer.Serialize(changes, WireJson.Options);

    /// <summary>
    /// Los cambios guardados de una entrada. Se leen a mano y no con el conversor del cable: el de <c>JsonElement</c> toma una
    /// cadena por un documento ya serializado, y un <c>before</c> de texto no lo es.
    /// </summary>
    public static IReadOnlyList<FieldChange> ReadChanges(string text)
    {
        using var document = JsonDocument.Parse(text);
        return [.. document.RootElement.EnumerateArray().Select(item => new FieldChange(item.GetProperty("field").GetString()!, item.GetProperty("before").Clone(), item.GetProperty("after").Clone()))];
    }

    private static JsonElement Element(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private static PersonalPath? PersonalMatch(IReadOnlyList<PersonalPath> personal, string field) =>
        personal.FirstOrDefault(path => path.Pattern.IsMatch(field));

    /// <summary>Lo que vale un cambio personal anonimizado: el sustituto <c>anon-&lt;id&gt;</c> si es obligatorio, null si no.</summary>
    private static JsonElement Anonymized(PersonalPath path, string rootId) => Element(path.Required ? JsonSerializer.Serialize("anon-" + rootId) : "null");
}`;
  return {
    path,
    content: csFile({
      namespace,
      usings: ['System.Globalization', 'System.Text.Json', 'System.Text.RegularExpressions', historyNamespace(model), `${solution(model).application.name}.Support`],
      body
    })
  };
}

// ─── El almacén relacional ───────────────────────────────────────────────────────────────────────────────────────

/** Las sentencias de keel-core, con el nombre de su constante C#. */
export function relationalHistoryStatements(model) {
  const S = historyStatements(isMySql(model) ? 'mysql' : 'postgresql');
  return [
    ['InsertEntrySql', S.insertEntry],
    ['InsertFieldSql', S.insertField],
    ['PageHeadSql', S.pageHead],
    ['CountHeadSql', S.countHead],
    ...HISTORY_FILTER_ORDER.map((name) => [`Filter${csMember(name)}Sql`, S.filters[name]]),
    ['PageTailSql', S.pageTail],
    ['EntriesOfRootSql', S.entriesOfRoot],
    ['UpdateChangesSql', S.updateChanges],
    ['DeleteFieldsSql', S.deleteFields],
    ['DeleteEntriesSql', S.deleteEntries]
  ];
}

function sqlStoreFile(model) {
  const { namespace, path } = located(model, 'historyInfra', CHANGE_HISTORY_CLASS);
  const mysql = isMySql(model);
  const context = `${model.service.rootNamespace}DbContext`;
  const constants = relationalHistoryStatements(model).map(([name, sql]) => `    private const string ${name} = ${csString(sql)};`).join('\n\n');
  const body = `/// <summary>
/// El historial de cambios sobre ${mysql ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core (<c>history-store.js</c>) TAL CUAL: son contrato
/// con los otros generadores, que comparten las tablas, y las mide <c>timer-sql-check</c> contra el motor. No las reescribas aquí.
/// </summary>
/// <remarks>
/// Va por la conexión y la transacción en curso del DbContext del ámbito, como TimerStore: la entrada entra en la de la
/// escritura que la origina, y si esa escritura revierte, la entrada también (D1). La hora es la del motor; a igual hora
/// desempata el id, un UUID versión 7. Los marcadores nombrados (<c>:id</c>) se traducen a los del driver
/// (${mysql ? '<c>?</c> de MySqlConnector' : '<c>$1</c> de Npgsql'}) con la regla de <c>bindNamed</c> de keel-core.
/// </remarks>
public sealed partial class ${CHANGE_HISTORY_CLASS}(${context} db, PersistenceTransactions transactions)
{
${constants}

    /// <summary>Escribe una entrada con el autor de la escritura en curso, en su transacción.</summary>
    public async Task Record(string rootType, string rootId, string change, IReadOnlyList<FieldChange> changes, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(changes);
        await transactions.InTransaction(
            async () =>
            {
                var id = HistorySupport.NextId();
                await Execute(InsertEntrySql, new() { ["id"] = id, ["rootType"] = rootType, ["rootId"] = rootId, ["author"] = AuditActor.Current(), ["change"] = change, ["changes"] = HistorySupport.WriteChanges(changes) }, cancellationToken);
                foreach (var (fieldPath, top) in HistorySupport.FieldRows(changes))
                {
                    await Execute(InsertFieldSql, new() { ["entryId"] = id, ["path"] = fieldPath, ["top"] = top }, cancellationToken);
                }
                return true;
            },
            readOnly: false,
            cancellationToken);
    }

    /// <summary>Una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor.</summary>
    public async Task<Page<HistoryEntry>> PageOf(string rootType, string rootId, HistoryFilter filter, Pageable pageable, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(filter);
        ArgumentNullException.ThrowIfNull(pageable);
        // Los filtros presentes, en el orden de keel-core (historyPageSql): uno que no llega no se escribe.
        var filters = (filter.Field is not null ? FilterFieldSql : string.Empty) + (filter.From is not null ? FilterFromSql : string.Empty) + (filter.To is not null ? FilterToSql : string.Empty);
        var values = new Dictionary<string, object?>(StringComparer.Ordinal) { ["rootType"] = rootType, ["rootId"] = rootId };
        if (filter.Field is not null)
        {
            values["field"] = filter.Field;
        }
        if (filter.From is not null)
        {
            values["from"] = filter.From.Value;
        }
        if (filter.To is not null)
        {
            values["to"] = filter.To.Value;
        }
        return await transactions.InTransaction(
            () => OnConnection(
                async () =>
                {
                    var entries = new List<HistoryEntry>();
                    var offset = (long)pageable.Page * pageable.Size;
                    await using (var command = Command(PageHeadSql + filters + PageTailSql, new(values, StringComparer.Ordinal) { ["limit"] = pageable.Size, ["offset"] = offset }))
                    await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
                    {
                        while (await reader.ReadAsync(cancellationToken))
                        {
                            entries.Add(new HistoryEntry(ReadTime(reader.GetValue(1)), reader.GetString(2), reader.GetString(3), HistorySupport.ReadChanges(reader.GetString(4))));
                        }
                    }
                    await using var counting = Command(CountHeadSql + filters, values);
                    var total = Convert.ToInt64(await counting.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
                    return Page<HistoryEntry>.Of(entries, pageable, total);
                },
                cancellationToken),
            readOnly: true,
            cancellationToken);
    }

    /// <summary>Reescribe los valores personales de todas las entradas de la raíz y deja la entrada <c>anonymized</c> (D8).</summary>
    public async Task Anonymize(string rootType, string rootId, IReadOnlyList<PersonalPath> personal, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(personal);
        await transactions.InTransaction(
            async () =>
            {
                // Primero se leen todas: la conexión no admite otra sentencia con un lector abierto.
                var stored = await OnConnection(
                    async () =>
                    {
                        var rows = new List<(object Id, string Changes)>();
                        await using var command = Command(EntriesOfRootSql, new() { ["rootType"] = rootType, ["rootId"] = rootId });
                        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                        while (await reader.ReadAsync(cancellationToken))
                        {
                            rows.Add((reader.GetValue(0), reader.GetString(1)));
                        }
                        return rows;
                    },
                    cancellationToken);
                var all = new List<IReadOnlyList<FieldChange>>();
                foreach (var (id, text) in stored)
                {
                    var (changes, touched) = HistorySupport.Anonymize(HistorySupport.ReadChanges(text), personal, rootId);
                    all.Add(changes);
                    if (touched)
                    {
                        await Execute(UpdateChangesSql, new() { ["changes"] = HistorySupport.WriteChanges(changes), ["id"] = id }, cancellationToken);
                    }
                }
                await Record(rootType, rootId, HistoryChanges.Anonymized, HistorySupport.AnonymizedEntryChanges(all, personal, rootId), cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }

    /// <summary>Borra el historial de la raíz: su retención con <c>then: delete</c> o la purga de lo borrado (D8).</summary>
    public async Task Purge(string rootType, string rootId, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                await Execute(DeleteFieldsSql, new() { ["rootType"] = rootType, ["rootId"] = rootId }, cancellationToken);
                await Execute(DeleteEntriesSql, new() { ["rootType"] = rootType, ["rootId"] = rootId }, cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }

    // ─── La conexión y los marcadores ───────────────────────────────────────────────────────────

    /// <summary>Abre la conexión del contexto (si la transacción en curso ya la tiene abierta, EF cuenta una apertura más) y la suelta al terminar.</summary>
    private async Task<T> OnConnection<T>(Func<Task<T>> work, CancellationToken cancellationToken)
    {
        await db.Database.OpenConnectionAsync(cancellationToken);
        try
        {
            return await work();
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    private Task<int> Execute(string sql, Dictionary<string, object?> values, CancellationToken cancellationToken) =>
        OnConnection(
            async () =>
            {
                await using var command = Command(sql, values);
                return await command.ExecuteNonQueryAsync(cancellationToken);
            },
            cancellationToken);

    /// <summary>La sentencia con sus marcadores nombrados pasados a los del driver, en la transacción en curso del contexto. Un marcador repetido es otro parámetro con el mismo valor.</summary>
    private DbCommand Command(string named, Dictionary<string, object?> values)
    {
        var command = db.Database.GetDbConnection().CreateCommand();
        command.Transaction = db.Database.CurrentTransaction?.GetDbTransaction();
        command.CommandText = Marker().Replace(named, match =>
        {
            if (!values.TryGetValue(match.Groups[1].Value, out var value))
            {
                throw new InvalidOperationException($"Falta el valor de :{match.Groups[1].Value} en una sentencia del historial");
            }
            var parameter = command.CreateParameter();
            parameter.Value = Wire(value);
            command.Parameters.Add(parameter);
            return ${mysql ? '"?"' : '"$" + command.Parameters.Count.ToString(CultureInfo.InvariantCulture)'};
        });
        return command;
    }

    /// <summary>El valor como viaja: la hora en UTC y null como DBNull.${mysql ? ' El uuid va en binary(16) con los bytes del texto (GuidFormat=Binary16).' : ''}</summary>
    private static object Wire(object? value) => value switch
    {
        null => DBNull.Value,
        DateTimeOffset instant => instant.UtcDateTime,
        _ => value
    };

    private static DateTimeOffset ReadTime(object? value) => value switch
    {
        DateTime time => new DateTimeOffset(DateTime.SpecifyKind(time, DateTimeKind.Utc)),
        DateTimeOffset instant => instant.ToUniversalTime(),
        _ => throw new InvalidOperationException($"La base no devolvió una hora: '{value}'")
    };

    /// <summary>El marcador nombrado de keel-core (<c>bindNamed</c>): dos puntos que no siguen a otros ni a una letra.</summary>
    [GeneratedRegex(@"(?<![:\\w]):([a-zA-Z][a-zA-Z0-9]*)")]
    private static partial Regex Marker();
}`;
  return {
    path,
    content: csFile({
      namespace,
      usings: [
        'System.Data.Common',
        'System.Globalization',
        'System.Text.RegularExpressions',
        'Microsoft.EntityFrameworkCore',
        'Microsoft.EntityFrameworkCore.Storage',
        namespaceOf(model, 'persistence'),
        namespaceOf(model, 'repositories'),
        historyNamespace(model)
      ],
      body
    })
  };
}

/** Las dos tablas, mapeadas SOLO para el esquema (como keel_timer): las crea EF en `local` y entran en el baseline. */
function rowsFile(model) {
  const { namespace, path } = located(model, 'rows', CHANGE_HISTORY_ROW);
  const TYPES = { uuid: 'Guid', string: 'string', timestamp: 'DateTimeOffset', text: 'string' };
  const property = (name) => name.replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase());
  const properties = (table) =>
    table.columns.map((column) => `    public ${TYPES[column.base]} ${property(column.name)} { get; set; }${TYPES[column.base] === 'string' ? ' = null!;' : ''}`);
  const chains = (table) =>
    table.columns.map((column) => {
      const parts = [`row.Property(r => r.${property(column.name)})`, `.HasColumnName(${csString(column.name)})`];
      if (column.length != null) parts.push(`.HasMaxLength(${column.length})`);
      // text y no el longtext que MySQL daría a una cadena sin tope: el tipo de los otros tres servidores.
      if (column.base === 'text') parts.push('.HasColumnType("text")');
      parts.push('.IsRequired()');
      if (column.primary && table === CHANGE_HISTORY) parts.push('.ValueGeneratedNever()');
      return `        ${parts.join('')};`;
    });
  const index = CHANGE_HISTORY.indexes[0];
  const fk = CHANGE_HISTORY_FIELD.columns.find((column) => column.references).references;
  const fieldKeys = CHANGE_HISTORY_FIELD.columns.filter((column) => column.primary).map((column) => `r.${property(column.name)}`);
  const body = `/// <summary>
/// Una entrada del historial, mapeada SOLO para el esquema: así la crea EF en <c>local</c>, la lleva el baseline de <c>dotnet ef</c>
/// (o el paso de esquema de build, si la base ya está desplegada) y la nombra el snapshot del modelo. Nadie la lee por EF: la
/// usa ChangeHistory, con las sentencias de keel-core. Columnas, índice y FK son los de keel-core (<c>CHANGE_HISTORY</c>), los de
/// los cuatro servidores.
/// </summary>
public sealed class ${CHANGE_HISTORY_ROW}
{
${properties(CHANGE_HISTORY).join('\n\n')}
}

/// <summary>Los campos que tocó cada entrada, para el filtro por campo sin operadores JSON del motor (D11): su ruta y el campo de la raíz que la contiene.</summary>
public sealed class ${CHANGE_HISTORY_FIELD_ROW}
{
${properties(CHANGE_HISTORY_FIELD).join('\n\n')}
}

/// <summary>El mapeo de ${CHANGE_HISTORY_ROW} a la tabla ${CHANGE_HISTORY.table}.</summary>
public sealed class ${CHANGE_HISTORY_ROW}Configuration : IEntityTypeConfiguration<${CHANGE_HISTORY_ROW}>
{
    public void Configure(EntityTypeBuilder<${CHANGE_HISTORY_ROW}> row)
    {
        row.ToTable(${csString(CHANGE_HISTORY.table)});
        row.HasKey(r => r.Id).HasName(${csString(`${CHANGE_HISTORY.table}_pkey`)});
${chains(CHANGE_HISTORY).join('\n')}
        row.HasIndex(r => new { ${index.columns.map((name) => `r.${property(name)}`).join(', ')} }, ${csString(index.name)}).HasDatabaseName(${csString(index.name)});
    }
}

/// <summary>El mapeo de ${CHANGE_HISTORY_FIELD_ROW} a la tabla ${CHANGE_HISTORY_FIELD.table}: se va con su entrada (ON DELETE CASCADE).</summary>
public sealed class ${CHANGE_HISTORY_FIELD_ROW}Configuration : IEntityTypeConfiguration<${CHANGE_HISTORY_FIELD_ROW}>
{
    public void Configure(EntityTypeBuilder<${CHANGE_HISTORY_FIELD_ROW}> row)
    {
        row.ToTable(${csString(CHANGE_HISTORY_FIELD.table)});
        row.HasKey(r => new { ${fieldKeys.join(', ')} }).HasName(${csString(`${CHANGE_HISTORY_FIELD.table}_pkey`)});
${chains(CHANGE_HISTORY_FIELD).join('\n')}
        row.HasOne<${CHANGE_HISTORY_ROW}>().WithMany().HasForeignKey(r => r.EntryId).HasConstraintName(${csString(fk.name)}).OnDelete(DeleteBehavior.Cascade);
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders'], body }) };
}

/** Las clases de fila del historial, para el DbContext (relacional). */
export function historyRows(model) {
  if (!usesHistory(model) || isDocument(model)) return [];
  return [CHANGE_HISTORY_ROW, CHANGE_HISTORY_FIELD_ROW];
}

/** Los nombres que las dos tablas ponen en el esquema: los busca la prueba emitida del modelo. */
export function historySchemaNames(model) {
  if (historyRows(model).length === 0) return [];
  const fk = CHANGE_HISTORY_FIELD.columns.find((column) => column.references).references;
  return [
    CHANGE_HISTORY.table,
    `${CHANGE_HISTORY.table}_pkey`,
    ...CHANGE_HISTORY.indexes.map((index) => index.name),
    CHANGE_HISTORY_FIELD.table,
    `${CHANGE_HISTORY_FIELD.table}_pkey`,
    fk.name
  ];
}

// ─── El almacén documental ───────────────────────────────────────────────────────────────────────

function mongoStoreFile(model) {
  const { namespace, path } = located(model, 'historyInfra', CHANGE_HISTORY_CLASS);
  const fields = CHANGE_HISTORY_COLLECTION.fields;
  const body = `/// <summary>
/// El historial de cambios sobre MongoDB, con la forma documental de keel-core: un documento por entrada con los nombres de
/// las columnas, <c>_id</c> el id como texto y, en vez de la segunda tabla, <c>${fields}</c> con la ruta y el campo de la raíz de
/// cada cambio. <c>changes</c> va como TEXTO, igual que en el relacional: un decimal o un número grande del cable no
/// sobreviven a pasar por BSON y volver.
/// </summary>
/// <remarks>
/// Por la sesión de la transacción en curso (PersistenceTransactions): si la escritura revierte, la entrada también (D1). A
/// igual instante desempata el id, un UUID versión 7. Su índice lo crea DocumentIndexes.
/// </remarks>
public sealed class ${CHANGE_HISTORY_CLASS}(PersistenceTransactions transactions)
{
    /// <summary>La colección del historial (keel-core: <c>CHANGE_HISTORY_COLLECTION</c>).</summary>
    public const string CollectionName = ${csString(CHANGE_HISTORY_COLLECTION.collection)};

    private IMongoCollection<BsonDocument> Collection => transactions.Collection(CollectionName);

    /// <summary>Escribe una entrada con el autor de la escritura en curso, en su transacción.</summary>
    public async Task Record(string rootType, string rootId, string change, IReadOnlyList<FieldChange> changes, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var rows = new BsonArray(HistorySupport.FieldRows(changes).Select(row => new BsonDocument { { "path", row.Path }, { "top", row.Top } }));
        await transactions.InTransaction(
            async () =>
            {
                await Collection.InsertOneAsync(
                    transactions.Session!,
                    new BsonDocument
                    {
                        { "_id", HistorySupport.NextId().ToString("D") },
                        { "root_type", rootType },
                        { "root_id", rootId },
                        { "at", BsonValues.Of(DateTimeOffset.UtcNow) },
                        { "author", AuditActor.Current() },
                        { "change_kind", change },
                        { "changes", HistorySupport.WriteChanges(changes) },
                        { ${csString(fields)}, rows }
                    },
                    cancellationToken: cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }

    /// <summary>Una página del historial de una raíz: la más reciente primero y, a igual instante, la de id mayor.</summary>
    public async Task<Page<HistoryEntry>> PageOf(string rootType, string rootId, HistoryFilter filter, Pageable pageable, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(filter);
        ArgumentNullException.ThrowIfNull(pageable);
        var query = new BsonDocument { { "root_type", rootType }, { "root_id", rootId } };
        // La ruta entera o el campo de la raíz que la contiene (historyMatches de keel-core).
        if (filter.Field is not null)
        {
            query["$or"] = new BsonArray { new BsonDocument(${csString(`${fields}.path`)}, filter.Field), new BsonDocument(${csString(`${fields}.top`)}, filter.Field) };
        }
        if (filter.From is not null || filter.To is not null)
        {
            var at = new BsonDocument();
            if (filter.From is not null)
            {
                at["$gte"] = BsonValues.Of(filter.From.Value);
            }
            if (filter.To is not null)
            {
                at["$lte"] = BsonValues.Of(filter.To.Value);
            }
            query["at"] = at;
        }
        // Una tras otra y no en paralelo: dentro de una transacción la sesión no admite operaciones concurrentes.
        var session = transactions.Session;
        var total = session is null
            ? await Collection.CountDocumentsAsync(query, cancellationToken: cancellationToken)
            : await Collection.CountDocumentsAsync(session, query, cancellationToken: cancellationToken);
        var offset = (int)Math.Min((long)pageable.Page * pageable.Size, int.MaxValue);
        var find = session is null ? Collection.Find(query) : Collection.Find(session, query);
        // Un límite 0 en MongoDB es «sin límite»: una página de tamaño 0 no lee nada.
        var documents = pageable.Size == 0
            ? new List<BsonDocument>()
            : await find.Sort(new BsonDocument { { "at", -1 }, { "_id", -1 } }).Skip(offset).Limit(pageable.Size).ToListAsync(cancellationToken);
        var entries = documents
            .Select(document => new HistoryEntry(
                new DateTimeOffset(document["at"].ToUniversalTime(), TimeSpan.Zero),
                document["author"].AsString,
                document["change_kind"].AsString,
                HistorySupport.ReadChanges(document["changes"].AsString)))
            .ToList();
        return Page<HistoryEntry>.Of(entries, pageable, total);
    }

    /// <summary>Reescribe los valores personales de todas las entradas de la raíz y deja la entrada <c>anonymized</c> (D8).</summary>
    public async Task Anonymize(string rootType, string rootId, IReadOnlyList<PersonalPath> personal, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(personal);
        await transactions.InTransaction(
            async () =>
            {
                var session = transactions.Session!;
                var stored = await Collection.Find(session, new BsonDocument { { "root_type", rootType }, { "root_id", rootId } }).ToListAsync(cancellationToken);
                var all = new List<IReadOnlyList<FieldChange>>();
                foreach (var document in stored)
                {
                    var (changes, touched) = HistorySupport.Anonymize(HistorySupport.ReadChanges(document["changes"].AsString), personal, rootId);
                    all.Add(changes);
                    if (touched)
                    {
                        await Collection.UpdateOneAsync(
                            session,
                            new BsonDocument("_id", document["_id"]),
                            new BsonDocument("$set", new BsonDocument("changes", HistorySupport.WriteChanges(changes))),
                            cancellationToken: cancellationToken);
                    }
                }
                await Record(rootType, rootId, HistoryChanges.Anonymized, HistorySupport.AnonymizedEntryChanges(all, personal, rootId), cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }

    /// <summary>Borra el historial de la raíz: su retención con <c>then: delete</c> o la purga de lo borrado (D8).</summary>
    public async Task Purge(string rootType, string rootId, CancellationToken cancellationToken = default)
    {
        await transactions.InTransaction(
            async () =>
            {
                await Collection.DeleteManyAsync(transactions.Session!, new BsonDocument { { "root_type", rootType }, { "root_id", rootId } }, cancellationToken: cancellationToken);
                return true;
            },
            readOnly: false,
            cancellationToken);
    }
}`;
  return {
    path,
    content: csFile({
      namespace,
      usings: ['MongoDB.Bson', 'MongoDB.Driver', namespaceOf(model, 'persistence'), namespaceOf(model, 'repositories'), historyNamespace(model)],
      body
    })
  };
}

/** El índice de la colección, para DocumentIndexes (documental): la lectura de una raíz, la entrada más reciente primero. */
export function historyDocumentIndexEntry(model) {
  if (!isDocument(model) || !usesHistory(model)) return null;
  const index = CHANGE_HISTORY_COLLECTION.indexes[0];
  const keys = index.keys.map(([key, direction]) => `{ ${csString(key)}, ${direction} }`).join(', ');
  return `            [${csString(CHANGE_HISTORY_COLLECTION.collection)}] =\n            [\n                new(new BsonDocument { ${keys} }, new CreateIndexOptions<BsonDocument> { Name = ${csString(index.name)} })\n            ]`;
}

/** El registro del almacén en AddPersistence: una línea y su namespace, o null. */
export function historyRegistration(model) {
  if (!usesHistory(model) || !model.layersPresent?.persistence) return null;
  return { line: `        services.AddScoped<${CHANGE_HISTORY_CLASS}>();`, usings: [historyInfraNamespace(model)] };
}

export function generate(model) {
  if (!model.layersPresent?.persistence || !usesHistory(model)) return [];
  const files = [entryFile(model), supportFile(model)];
  if (isDocument(model)) files.push(mongoStoreFile(model));
  else files.push(sqlStoreFile(model), rowsFile(model));
  return files;
}

// ─── Lo que gana el adaptador de cada raíz ───────────────────────────────────────────────────────────────────────

/** La dependencia del adaptador: el almacén, la última del constructor. */
export function historyDependency(model, entity) {
  if (!recordsHistory(entity)) return [];
  return [{ type: CHANGE_HISTORY_CLASS, name: 'changeHistory', usings: [historyNamespace(model), historyInfraNamespace(model)] }];
}

/** La expresión C# de una ruta del contrato sobre `variable` (`price.amount` → `entity.Price?.Amount`). */
function pathExpression(variable, path) {
  const [head, ...rest] = path.split('.');
  return [`${variable}.${csMember(head)}`, ...rest.map(csMember)].join('?.');
}

/** La línea que escribe una entrada sin cambios (`deleted`, `restored`) para el id `idExpr`. */
export function historyRecordLine(entity, change, idExpr, indent) {
  if (!recordsHistory(entity)) return '';
  const what = change === 'deleted' ? 'la baja' : 'la restauración';
  const constant = change === 'deleted' ? 'Deleted' : 'Restored';
  return `${indent}// El historial (DSL 2.29): ${what} deja su entrada, sin cambios de campos.\n${indent}await changeHistory.Record(${rootMember(entity)}.Type, HistorySupport.Key(${idExpr}), HistoryChanges.${constant}, [], cancellationToken);\n`;
}

/**
 * Los métodos privados del adaptador: la instantánea del agregado (D3: ruta del contrato → texto del cable, la forma de
 * keel-core) y la entrada de un guardado (D2).
 */
export function historyAdapterHelpers(model, entity) {
  if (!recordsHistory(entity)) return [];
  const shape = entity.historyShape;
  const lines = shape.paths.map((path) => `            [${csString(path)}] = HistorySupport.WireText(${pathExpression('entity', path)}),`);
  const children = shape.children.map((child) => {
    const childLines = child.paths.map((path) => `            snapshot[prefix + ${csString(path)}] = HistorySupport.WireText(${pathExpression('child', path)});`).join('\n');
    if (child.list) {
      return `        foreach (var child in entity.${csMember(child.relation)})
        {
            var prefix = $"${child.relation}[{HistorySupport.Key(child.${csMember(child.idField)})}].";
${childLines}
        }`;
    }
    const local = `${csLocal(child.relation).replace(/^@/, '')}Child`;
    const oneLines = child.paths.map((path) => `            snapshot[prefix + ${csString(path)}] = HistorySupport.WireText(${pathExpression(local, path)});`).join('\n');
    return `        if (entity.${csMember(child.relation)} is { } ${local})
        {
            const string prefix = ${csString(`${child.relation}.`)};
${oneLines}
        }`;
  });
  const id = csMember(entity.idField?.name ?? 'id');
  return [
    `    /// <summary>Lo que registra el historial de ${entity.name} (DSL 2.29): ruta del contrato → texto del cable.</summary>
    private static Dictionary<string, string> HistorySnapshot(${entity.name} entity)
    {
        var snapshot = new Dictionary<string, string>(StringComparer.Ordinal)
        {
${lines.join('\n')}
        };${children.length > 0 ? `\n${children.join('\n')}` : ''}
        return snapshot;
    }`,
    `    /// <summary>La entrada de un guardado (D2): created si no había nada; updated solo si algo cambió.</summary>
    private async Task RecordSave(Dictionary<string, string>? before, ${entity.name} saved, CancellationToken cancellationToken)
    {
        var changes = HistorySupport.Diff(before, HistorySnapshot(saved));
        if (before is null)
        {
            await changeHistory.Record(${rootMember(entity)}.Type, HistorySupport.Key(saved.${id}), HistoryChanges.Created, changes, cancellationToken);
        }
        else if (changes.Count > 0)
        {
            await changeHistory.Record(${rootMember(entity)}.Type, HistorySupport.Key(saved.${id}), HistoryChanges.Updated, changes, cancellationToken);
        }
    }`
  ];
}

// ─── La lectura (D7) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las lecturas del historial de una raíz: una por forma de cargarla. `{ method, by, load, scoped, param }`: por id (la
 * carga viva del puerto) o, si la query va acotada, por la carga acotada de la ficha (`LoadScoped`/`LoadScopedBy<Clave>`).
 * La misma derivación que keel-spring y keel-nest.
 */
export function historyReadsOf(model, entity) {
  const reads = new Map();
  for (const operation of model.services.flatMap((group) => group.operations)) {
    if (operation.historyOf !== entity.name) continue;
    const load = operation.readScope ? scopedLoadOf(model, operation) : null;
    const by = load?.by === 'key' ? 'key' : 'id';
    const method = by === 'id' ? 'HistoryOf' : `HistoryOfBy${csMember(load.field)}`;
    if (reads.has(method)) continue;
    const field = by === 'id' ? entity.idField : entity.fields.find((candidate) => candidate.name === load.field);
    reads.set(method, {
      method,
      by,
      load: load ? csMember(load.method) : 'FindById',
      scoped: Boolean(operation.readScope),
      param: { name: csLocal(field?.name ?? 'id'), type: (field?.csType ?? 'Guid').replace(/\?$/, '') }
    });
  }
  return [...reads.values()];
}

const readParams = (read) =>
  [`${read.param.type} ${read.param.name}`, ...(read.scoped ? ['ReadScope scope'] : []), 'HistoryFilter filter', 'Pageable pageable', 'CancellationToken cancellationToken = default'].join(', ');

export function historyPortMethods(model, entity) {
  return historyReadsOf(model, entity).map(
    (read) => `    /// <summary>
    /// El historial de cambios de ${entity.name} (DSL 2.29), la entrada más reciente primero: carga la raíz con la misma lectura
    /// que su ficha —viva${read.scoped ? ' y con el alcance del llamante' : ''}— y null si no la ve. El filtro y la página los aplica el almacén.
    /// </summary>
    Task<Page<HistoryEntry>?> ${read.method}(${readParams(read)});`
  );
}

export function historyReadMethods(model, entity) {
  const id = csMember(entity.idField?.name ?? 'id');
  return historyReadsOf(model, entity).map(
    (read) => `    public async Task<Page<HistoryEntry>?> ${read.method}(${readParams(read)})
    {
        ArgumentNullException.ThrowIfNull(filter);
        ArgumentNullException.ThrowIfNull(pageable);
        // D7: la misma lectura que la ficha; lo que ella no ve, el historial tampoco.
        var root = await ${read.load}(${read.param.name}${read.scoped ? ', scope' : ''}, cancellationToken);
        return root is null ? null : await changeHistory.PageOf(${rootMember(entity)}.Type, HistorySupport.Key(root.${id}), filter, pageable, cancellationToken);
    }`
  );
}

/** Los namespaces que el puerto o el adaptador necesitan si la raíz lleva historial. */
export function historyUsings(model, entity, { adapter = false } = {}) {
  if (!recordsHistory(entity)) return [];
  return adapter ? [historyNamespace(model), historyInfraNamespace(model)] : historyReadsOf(model, entity).length > 0 ? [historyNamespace(model)] : [];
}

// ─── La query ────────────────────────────────────────────────────────────────────────────────────────────────────

/** El tipo que devuelve una query de historial: la página del contrato. */
export const HISTORY_RESPONSE = `PagedResponse<${HISTORY_ENTRY}>`;

/** La nota del handler (la neutral de keel-core), con la llamada en C#. */
export function handlerNote(model, operation) {
  const root = model.entities.find((entity) => entity.name === operation.historyOf);
  if (!root) return null;
  const reads = historyReadsOf(model, root);
  const read = reads.find((candidate) => (operation.readScope ? candidate.scoped : !candidate.scoped)) ?? reads[0];
  if (!read) return null;
  const filter = HISTORY_FILTER_ORDER.map((role) => (operation.historyFilters?.[role] ? `query.${csMember(operation.historyFilters[role])}` : 'null')).join(', ');
  const port = `${root.name[0].toLowerCase()}${root.name.slice(1)}Repository`;
  const call = `await ${port}.${read.method}(<${read.by === 'id' ? 'su id' : `su ${read.param.name}`}>${read.scoped ? ', query.ReadScope' : ''}, new HistoryFilter(${filter}), query.Pageable, cancellationToken)`;
  return historyNote(operation, { historyCall: call });
}
