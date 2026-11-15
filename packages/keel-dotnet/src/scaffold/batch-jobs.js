// Los LOTES ASÍNCRONOS (DSL 2.30: `use-cases.<op>.batch` con `execution: async`) en keel-dotnet: incremento 8 de
// PLAN-DSL-230-LOTES.md, el gemelo de batch-jobs.js de keel-spring y de keel-nest. Lo que decide QUÉ (las tablas y sus
// sentencias por motor, los estados, el temporizador de cada trabajo, la firma de la petición, la forma del trabajo en el
// cable, los casos BJ-*) es de keel-core (gen/batch.js y gen/batch-store.js); aquí solo se escribe en C#:
//
//   · el almacén (`IBatchJobStore`, en Infrastructure/Persistence/Batch): SQL a pelo con las sentencias de keel-core TAL
//     CUAL por la conexión y la transacción del DbContext, como TimerStore y ChangeHistory, más las dos tablas mapeadas solo
//     para el esquema; o MongoDB con la forma documental de keel-core y sus índices en DocumentIndexes. La purga de lo
//     terminado (D10) es un recurrente más del cronómetro (`BatchJobPurgeTimer`, en timer.js);
//   · `BatchJobs` (Api/Rest): el alta (D8, D13) y las dos rutas del trabajo, que solo lee quien lo creó (D11). El alta lee
//     los BYTES del cuerpo: los firma, los lee con el MISMO lector de la operación que usa el borde —un sobre mal formado es
//     un 400 sin crear ningún trabajo (BJ-9)—, resuelve la clave del lote y crea el trabajo y su temporizador de una vez en
//     UNA transacción: 202 + Location;
//   · `BatchJobRunner` (Api/Rest): un disparo del temporizador (D9). Procesa un chunk desde el cursor; cada elemento en su
//     ÁMBITO, con su efecto, el avance del cursor (la valla, PRIMERO) y su resultado en UNA transacción. Corre fuera de la
//     transacción del sondeador (`ITimerHandler.InTransaction` a false), y como el dueño del trabajo: es el actor de autoría
//     de cada elemento;
//   · `<Op>BatchJob` (Api/Rest): el `ITimerHandler` de cada operación asíncrona, que sabe leer el sobre guardado con el
//     lector público del endpoint y despachar UN elemento por el mediator. Vive en la API porque el lector y la traducción
//     del fallo (ApiErrorMiddleware) son de ella; lo registra `AddBatchJobs`, desde Program.cs.
//
// Lo que no cambia respecto al lote síncrono: el handler procesa UN elemento, cada elemento se lee con el MISMO
// `ValueReaders.Read<Elemento>` del borde y su fallo se traduce con ApiErrorMiddleware (Batch.cs: `BatchRunner.ReadItem` y
// `BatchRunner.FailureOf`), así que «falla solo su elemento» y «detiene el lote» significan lo mismo.

import { asyncBatchOperations, batchJobPaths, BATCH_JOB_PARAM, BATCH_ACCEPTED_STATUS } from '@keel-system/keel-core/gen/batch';
import {
  BATCH_JOB,
  BATCH_ITEM_RESULT,
  BATCH_JOB_COLLECTIONS,
  BATCH_JOB_STATUSES,
  BATCH_PARAMETERS,
  BATCH_STORE_ENGINES,
  batchKind,
  batchStatements
} from '@keel-system/keel-core/gen/batch-store';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { idempotencyOutcomeCode } from '@keel-system/keel-core/gen/declared-errors';
import { IDEMPOTENCY_HEADER } from '@keel-system/keel-core/gen/request-idempotency';
import { cronWithDefault, envWithDefault } from '@keel-system/keel-core/gen/profile-values';
import { PAGEABLE_DEFAULT_SIZE, PAGEABLE_MAX_SIZE } from '@keel-system/keel-core/gen/pagination';
import { pascalCase } from '@keel-system/keel-core/gen';
import { csFile, csMember, csString, located, namespaceOf, typeUsings } from './render.js';

export const BATCH_JOB_STORE_PORT = 'IBatchJobStore';
export const BATCH_JOB_STORE = 'BatchJobStore';
export const BATCH_SETTINGS = 'BatchSettings';
export const BATCH_JOB_ROW = 'BatchJobRow';
export const BATCH_ITEM_RESULT_ROW = 'BatchItemResultRow';

const PROFILES = ['local', 'develop', 'production', 'test'];
const isDocument = (model) => model.persistenceKind === 'document';
const isMySql = (model) => model.stack?.database === 'mysql';

/** El namespace del almacén y de la configuración de los lotes asíncronos. */
export const batchInfraNamespace = (model) => namespaceOf(model, 'batchInfra');

/** Las operaciones asíncronas del modelo, enteras (no solo su nombre). */
export const asyncOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch?.execution === 'async');

/** ¿Tiene el servicio algún lote asíncrono? Sin persistencia no hay dónde guardar el trabajo (lo rechaza la frontera). */
export const usesBatchJobs = (model) => Boolean(model.layersPresent?.persistence) && asyncBatchOperations(model).length > 0;

/** ¿Es la operación un lote asíncrono que se genera? */
export const isAsyncBatch = (model, operation) => operation.batch?.execution === 'async' && usesBatchJobs(model);

/** La constante del `kind` del temporizador de los trabajos de una operación, en TimerKinds. */
export const batchKindConstant = (operationName) => `Batch${pascalCase(operationName)}`;

/** Las constantes de TimerKinds de los lotes asíncronos (las llama timer.js). */
export function batchKindLines(model) {
  if (!usesBatchJobs(model)) return [];
  return asyncBatchOperations(model).map(
    ({ operation }) => `    /// <summary>Los trabajos del lote asíncrono ${operation} (DSL 2.30): un temporizador de UNA vez por trabajo.</summary>
    public const string ${batchKindConstant(operation)} = ${csString(batchKind(operation))};`
  );
}

/** El handler del temporizador de los trabajos de una operación. */
export const batchJobClass = (operation) => `${csMember(operation.name)}BatchJob`;

/** Los nombres de los dos endpoints del trabajo de una operación (filas de ApiRoutes). */
export const jobEndpoint = (operation) => `${csMember(operation.name)}Job`;
export const jobResultsEndpoint = (operation) => `${csMember(operation.name)}JobResults`;

/**
 * Lo que un diseño con lotes asíncronos no puede generar con este stack, o []: las sentencias son las del cronómetro
 * (PostgreSQL y MySQL, medidas con timer-sql-check) y el documental es MongoDB; el sobre guardado es el CUERPO, así que lo
 * que el mensaje lea de la ruta o estampe de la petición no viajaría al trabajo. El mismo criterio que keel-spring y
 * keel-nest. `stamped(operation)` dice si el mensaje lleva algo que estampa la petición (identidad, versiones, alcance).
 */
export function batchJobStackErrors(model, stamped) {
  if (asyncBatchOperations(model).length === 0) return [];
  const errors = [];
  if (!model.layersPresent?.persistence) {
    errors.push('use-cases: batch (execution: async, DSL 2.30): el trabajo vive en la base del servicio, y este diseño no tiene capa persistence.');
  } else if (!isDocument(model) && !BATCH_STORE_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `use-cases: batch (execution: async, DSL 2.30): el almacén de los trabajos tiene sentencias medidas para ${BATCH_STORE_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores o declara execution: sync.`
    );
  }
  for (const operation of asyncOperations(model)) {
    if ((operation.pathParams ?? []).length > 0) {
      errors.push(
        `use-cases: ${operation.name}.batch (execution: async, DSL 2.30): el trabajo guarda el CUERPO de la petición, y su ruta ` +
          `(${operation.route.path}) lleva parámetros que no viajarían al procesarlo. Quita los parámetros de la ruta o declara execution: sync.`
      );
    }
    for (const name of stamped(operation)) {
      errors.push(
        `use-cases: ${operation.name}.batch (execution: async, DSL 2.30): el mensaje lleva '${name}', que estampa la ` +
          'petición, y el trabajo se procesa fuera de ella. Declara execution: sync.'
      );
    }
  }
  return errors;
}

export function generate(model) {
  if (!usesBatchJobs(model)) return [];
  const document = isDocument(model);
  const infra = (name, usings, body) => {
    const { namespace, path } = located(model, 'batchInfra', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const rest = (name, usings, body) => {
    const { namespace, path } = located(model, 'rest', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    infra(BATCH_JOB_STORE_PORT, [], portBody()),
    document
      ? infra(BATCH_JOB_STORE, ['MongoDB.Bson', 'MongoDB.Driver', namespaceOf(model, 'persistence')], mongoStoreBody())
      : infra(
          BATCH_JOB_STORE,
          ['System.Data.Common', 'System.Globalization', 'System.Text.RegularExpressions', 'Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Storage', namespaceOf(model, 'persistence')],
          sqlStoreBody(model)
        ),
    ...(document ? [] : [rowsFile(model)]),
    infra(BATCH_SETTINGS, ['System.Globalization', namespaceOf(model, 'config')], settingsBody()),
    rest('BatchJobs', jobsUsings(model), jobsBody(model)),
    ...asyncOperations(model).map((operation) => rest(batchJobClass(operation), handlerUsings(model, operation), handlerBody(model, operation))),
    rest('BatchJobRegistration', ['Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'timer')], registrationBody(model)),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/batch.yaml`, content: batchYaml(profile) }))
  ];
}

// ─── Lo que enlazan los demás módulos ────────────────────────────────────────────────────────────

/** Las clases de fila de las dos tablas, para el DbContext (relacional). */
export function batchJobRows(model) {
  if (!usesBatchJobs(model) || isDocument(model)) return [];
  return [BATCH_JOB_ROW, BATCH_ITEM_RESULT_ROW];
}

/** Los nombres que las dos tablas ponen en el esquema: los busca la prueba emitida del modelo. */
export function batchJobSchemaNames(model) {
  if (batchJobRows(model).length === 0) return [];
  const fk = BATCH_ITEM_RESULT.columns.find((column) => column.references).references;
  return [
    BATCH_JOB.table,
    `${BATCH_JOB.table}_pkey`,
    ...BATCH_JOB.uniques.map((unique) => unique.name),
    ...BATCH_JOB.indexes.map((index) => index.name),
    BATCH_ITEM_RESULT.table,
    `${BATCH_ITEM_RESULT.table}_pkey`,
    fk.name
  ];
}

/** El registro del almacén en AddPersistence: una línea y su namespace, o null. */
export function batchJobRegistration(model) {
  if (!usesBatchJobs(model)) return null;
  return { line: `        services.AddScoped<${BATCH_JOB_STORE_PORT}, ${BATCH_JOB_STORE}>();`, usings: [batchInfraNamespace(model)] };
}

/** Las colecciones y sus índices, para DocumentIndexes (documental): la clave única y PARCIAL, y la purga. */
export function batchJobDocumentIndexEntries(model) {
  if (!usesBatchJobs(model) || !isDocument(model)) return [];
  return Object.values(BATCH_JOB_COLLECTIONS).map(({ collection, indexes }) => {
    const lines = indexes.map((spec) => {
      const keys = spec.keys.map(([key, direction]) => `{ ${csString(key)}, ${direction} }`).join(', ');
      const options = [`Name = ${csString(spec.name)}`];
      if (spec.unique) options.push('Unique = true');
      if (spec.partialFilter) {
        const [field, condition] = Object.entries(spec.partialFilter)[0];
        options.push(`PartialFilterExpression = new BsonDocument(${csString(field)}, new BsonDocument("$type", ${csString(condition.$type)}))`);
      }
      return `                new(new BsonDocument { ${keys} }, new CreateIndexOptions<BsonDocument> { ${options.join(', ')} })`;
    });
    return `            [${csString(collection)}] =\n            [\n${lines.join(',\n')}\n            ]`;
  });
}

/**
 * Lo que Program.cs añade con lotes asíncronos, tras el cronómetro: su configuración (la lee la purga, que es
 * Infrastructure) y los handlers de los trabajos, que son de la API.
 */
export function programBatchJobs(model) {
  if (!usesBatchJobs(model)) return { usings: [], registration: '' };
  return {
    usings: [batchInfraNamespace(model), namespaceOf(model, 'rest')],
    registration: `
// Los lotes asíncronos (DSL 2.30): el chunk y la retención (batch.yaml), y un handler del cronómetro por operación.
builder.Services.AddSingleton(BatchSettings.From(configuration));
builder.Services.AddBatchJobs();`
  };
}

/** La purga de `batch_job` como recurrente del cronómetro (la emite timer.js con su nombre de clase y su kind). */
export function batchPurgeTimerBody(className, kindConstant) {
  return `/// <summary>
/// La purga de los trabajos terminados de los lotes asíncronos (DSL 2.30, D10): los que acabaron hace más de
/// <c>${BATCH_PARAMETERS.retentionDays.key}</c> días, con sus resultados. Un trabajo en marcha no se purga nunca. Es un recurrente del
/// cronómetro en modo clúster (<c>${BATCH_PARAMETERS.purgeCron.key}</c>): cada tick lo ejecuta UNA réplica.
/// </summary>
public sealed class ${className}(${BATCH_JOB_STORE_PORT} store, ${BATCH_SETTINGS} settings) : IRecurringTimerHandler
{
    public string Kind => TimerKinds.${kindConstant};

    public string Spec => settings.PurgeCron;

    public async Task Tick(CancellationToken cancellationToken) => await store.Purge(settings.RetentionDays, cancellationToken);
}`;
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

/**
 * config/parameters/<perfil>/batch.yaml: la mecánica de los lotes asíncronos (keel-core/gen/batch-store.js, la misma clave
 * y variable en los cuatro generadores). Es, línea a línea, el `batch.yaml` de keel-spring y keel-nest.
 */
export function batchYaml(profile) {
  const lines = [
    '# Los lotes asíncronos (DSL 2.30): cuántos elementos procesa cada disparo y cuánto vive un trabajo terminado.',
    '# El chunk tiene que caber en el arriendo del cronómetro (timer.lease-ms): uno más lento lo tomaría otra réplica.',
    'batch:'
  ];
  let parent = null;
  for (const parameter of Object.values(BATCH_PARAMETERS)) {
    const segments = parameter.key.split('.');
    if (segments.length === 3 && parent !== segments[1]) {
      parent = segments[1];
      lines.push(`  ${parent}:`);
    }
    const rendered = parameter.cron ? cronWithDefault(profile, parameter.env, parameter.default) : envWithDefault(profile, parameter.env, parameter.default);
    lines.push(`${'  '.repeat(segments.length - 1)}${segments.at(-1)}: ${rendered}`);
  }
  return `${lines.join('\n')}\n`;
}

const configKey = (key) => key.replaceAll('.', ':');

function settingsBody() {
  const P = BATCH_PARAMETERS;
  return `/// <summary>
/// La mecánica de los lotes asíncronos (DSL 2.30) del perfil activo: la de keel-core (<c>BATCH_PARAMETERS</c>), con las mismas
/// claves y defaults en los cuatro generadores. Un valor que no es un entero positivo no deja arrancar.
/// </summary>
/// <param name="ChunkSize">Cuántos elementos procesa cada disparo del temporizador de un trabajo (D9). Por debajo del arriendo del cronómetro.</param>
/// <param name="RetentionDays">Cuántos días vive un trabajo TERMINADO con sus resultados (D10).</param>
/// <param name="PurgeCron">El cron (seis campos, en UTC) de su purga.</param>
public sealed record ${BATCH_SETTINGS}(int ChunkSize, int RetentionDays, string PurgeCron)
{
    /// <summary>Los defaults de keel-core, para quien no lee la configuración (las pruebas).</summary>
    public static ${BATCH_SETTINGS} Defaults { get; } = new(${P.chunkSize.default}, ${P.retentionDays.default}, ${csString(P.purgeCron.default)});

    public static ${BATCH_SETTINGS} From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new ${BATCH_SETTINGS}(
            Positive(configuration, ${csString(configKey(P.chunkSize.key))}, ${P.chunkSize.default}),
            Positive(configuration, ${csString(configKey(P.retentionDays.key))}, ${P.retentionDays.default}),
            Text(configuration, ${csString(configKey(P.purgeCron.key))}, ${csString(P.purgeCron.default)}));
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

// ─── El almacén ──────────────────────────────────────────────────────────────────────────────────

function portBody() {
  return `/// <summary>Un trabajo, como está en la tabla. <c>NextIndex</c> es el cursor: todo elemento por debajo tiene su resultado.</summary>
public sealed record BatchJob(
    Guid Id,
    string Operation,
    string Owner,
    string Status,
    string Input,
    int Total,
    int NextIndex,
    int Succeeded,
    int Failed,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FinishedAt);

/// <summary>El resultado de un elemento intentado, con <c>Result</c> serializado con las reglas del cable.</summary>
public sealed record BatchJobResult(int Index, string Status, string? ErrorCode, string? Message, string? Result);

/// <summary>El trabajo vivo de una clave de idempotencia (D13).</summary>
public sealed record BatchJobKeyHit(Guid Id, string? Signature);

/// <summary>
/// Los trabajos de los lotes asíncronos (DSL 2.30) y sus resultados (<c>${BATCH_JOB.table}</c> y <c>${BATCH_ITEM_RESULT.table}</c>),
/// detrás de un puerto: las sentencias son las de keel-core, iguales en los cuatro generadores, y toda hora es la de la base.
/// </summary>
/// <remarks>
/// Se une a la transacción en curso de su ámbito: el alta va con el temporizador del trabajo, y el resultado y el avance de
/// cada elemento con su efecto (D9).
/// </remarks>
public interface ${BATCH_JOB_STORE_PORT}
{
    /// <summary>El trabajo vivo de esa clave: el que la tiene y cuya ventana no pasó.</summary>
    Task<BatchJobKeyHit?> ByKey(string operation, string owner, string key, CancellationToken cancellationToken = default);

    /// <summary>Libera la clave si su ventana pasó: el alta siguiente la puede tomar, y el trabajo viejo sigue legible por su id.</summary>
    Task ReleaseKey(string operation, string owner, string key, CancellationToken cancellationToken = default);

    /// <summary>Da de alta un trabajo en <c>${BATCH_JOB_STATUSES.queued}</c>, con el cursor en 0. <paramref name="ttlMs"/> null: la clave no caduca.</summary>
    Task Insert(Guid id, string operation, string owner, string? key, string? signature, long? ttlMs, string input, int total, CancellationToken cancellationToken = default);

    /// <summary>Lo que lee el procesador.</summary>
    Task<BatchJob?> Job(Guid id, CancellationToken cancellationToken = default);

    /// <summary>Lo que leen las dos rutas (D11): de otro dueño u otra operación es como si no existiera.</summary>
    Task<BatchJob?> Owned(Guid id, string operation, string owner, CancellationToken cancellationToken = default);

    /// <summary>Avanza el cursor desde <paramref name="index"/>, con los contadores. false: el cursor ya no estaba ahí (la valla, D9).</summary>
    Task<bool> Advance(Guid id, int index, int succeeded, int failed, CancellationToken cancellationToken = default);

    /// <summary>El resultado de un elemento.</summary>
    Task InsertResult(Guid jobId, int index, string status, string? errorCode, string? message, string? result, CancellationToken cancellationToken = default);

    /// <summary>Cierra el trabajo (${BATCH_JOB_STATUSES.completed} o ${BATCH_JOB_STATUSES.aborted}), una sola vez.</summary>
    Task<bool> Finish(Guid id, string status, CancellationToken cancellationToken = default);

    /// <summary>Los resultados, en orden de índice.</summary>
    Task<IReadOnlyList<BatchJobResult>> Results(Guid jobId, int limit, long offset, CancellationToken cancellationToken = default);

    Task<long> ResultsCount(Guid jobId, CancellationToken cancellationToken = default);

    /// <summary>La purga (D10): los trabajos terminados hace más de <paramref name="retentionDays"/>, con sus resultados. Nunca uno en marcha.</summary>
    Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default);
}`;
}

const SQL_NAMES = ['insertJob', 'byKey', 'releaseKey', 'job', 'ownedJob', 'insertResult', 'advance', 'finish', 'resultsPage', 'resultsCount', 'purgeResults', 'purgeJobs'];

/** Las sentencias de keel-core para el motor del modelo, con su constante C#. */
export function relationalBatchStatements(model) {
  const S = batchStatements(isMySql(model) ? 'mysql' : 'postgresql');
  return SQL_NAMES.map((name) => ({ name, constant: `${csMember(name)}Sql`, sql: S[name] }));
}

function sqlStoreBody(model) {
  const mysql = isMySql(model);
  const context = `${model.service.rootNamespace}DbContext`;
  const constants = relationalBatchStatements(model)
    .map(({ name, constant, sql }) => `    /// <summary><c>${name}</c> de keel-core.</summary>\n    private const string ${constant} = ${csString(sql)};`)
    .join('\n\n');
  return `/// <summary>
/// Los trabajos de los lotes asíncronos sobre ${mysql ? 'MySQL' : 'PostgreSQL'}, con las sentencias de keel-core (<c>batch-store.js</c>) TAL CUAL:
/// son contrato con los otros generadores, que comparten las tablas, y las mide <c>timer-sql-check</c> contra el motor. No las
/// reescribas aquí.
/// </summary>
/// <remarks>
/// Va por la conexión y la transacción en curso del DbContext del ámbito, como TimerStore y ChangeHistory: el alta entra en la
/// del temporizador del trabajo, y el avance y el resultado de cada elemento en la de su efecto. Los marcadores nombrados
/// (<c>:id</c>) se traducen a los del driver (${mysql ? '<c>?</c> de MySqlConnector' : '<c>$1</c> de Npgsql'}) con la regla de <c>bindNamed</c> de keel-core.
/// </remarks>
public sealed partial class ${BATCH_JOB_STORE}(${context} db, PersistenceTransactions transactions) : ${BATCH_JOB_STORE_PORT}
{
${constants}

    public Task<BatchJobKeyHit?> ByKey(string operation, string owner, string key, CancellationToken cancellationToken = default) =>
        Read(
            ByKeySql,
            new() { ["operation"] = operation, ["owner"] = owner, ["key"] = key },
            reader => new BatchJobKeyHit(reader.GetGuid(0), reader.IsDBNull(1) ? null : reader.GetString(1)),
            cancellationToken);

    public async Task ReleaseKey(string operation, string owner, string key, CancellationToken cancellationToken = default) =>
        await Write(ReleaseKeySql, new() { ["operation"] = operation, ["owner"] = owner, ["key"] = key }, cancellationToken);

    public async Task Insert(Guid id, string operation, string owner, string? key, string? signature, long? ttlMs, string input, int total, CancellationToken cancellationToken = default) =>
        await Write(
            InsertJobSql,
            new() { ["id"] = id, ["operation"] = operation, ["owner"] = owner, ["key"] = key, ["signature"] = signature, ["ttlMs"] = ttlMs, ["input"] = input, ["total"] = total },
            cancellationToken);

    public Task<BatchJob?> Job(Guid id, CancellationToken cancellationToken = default) =>
        Read(JobSql, new() { ["id"] = id }, ReadJob, cancellationToken);

    public Task<BatchJob?> Owned(Guid id, string operation, string owner, CancellationToken cancellationToken = default) =>
        Read(OwnedJobSql, new() { ["id"] = id, ["operation"] = operation, ["owner"] = owner }, ReadJob, cancellationToken);

    public async Task<bool> Advance(Guid id, int index, int succeeded, int failed, CancellationToken cancellationToken = default) =>
        await Write(AdvanceSql, new() { ["succeeded"] = succeeded, ["failed"] = failed, ["id"] = id, ["index"] = index }, cancellationToken) == 1;

    public async Task InsertResult(Guid jobId, int index, string status, string? errorCode, string? message, string? result, CancellationToken cancellationToken = default) =>
        await Write(
            InsertResultSql,
            new() { ["jobId"] = jobId, ["index"] = index, ["status"] = status, ["errorCode"] = errorCode, ["message"] = message, ["result"] = result },
            cancellationToken);

    public async Task<bool> Finish(Guid id, string status, CancellationToken cancellationToken = default) =>
        await Write(FinishSql, new() { ["status"] = status, ["id"] = id }, cancellationToken) == 1;

    public async Task<IReadOnlyList<BatchJobResult>> Results(Guid jobId, int limit, long offset, CancellationToken cancellationToken = default) =>
        await transactions.InTransaction(
            () => OnConnection<IReadOnlyList<BatchJobResult>>(
                async () =>
                {
                    var rows = new List<BatchJobResult>();
                    await using var command = Command(ResultsPageSql, new() { ["jobId"] = jobId, ["limit"] = limit, ["offset"] = offset });
                    await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                    while (await reader.ReadAsync(cancellationToken))
                    {
                        rows.Add(new BatchJobResult(
                            Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture),
                            reader.GetString(1),
                            reader.IsDBNull(2) ? null : reader.GetString(2),
                            reader.IsDBNull(3) ? null : reader.GetString(3),
                            reader.IsDBNull(4) ? null : reader.GetString(4)));
                    }
                    return rows;
                },
                cancellationToken),
            readOnly: true,
            cancellationToken);

    public async Task<long> ResultsCount(Guid jobId, CancellationToken cancellationToken = default) =>
        await transactions.InTransaction(
            () => OnConnection(
                async () =>
                {
                    await using var command = Command(ResultsCountSql, new() { ["jobId"] = jobId });
                    return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
                },
                cancellationToken),
            readOnly: true,
            cancellationToken);

    public async Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default) =>
        await transactions.InTransaction(
            async () =>
            {
                // Primero los resultados: la FK ya borra en cascada, pero no se depende de ella, como en el historial.
                await Execute(PurgeResultsSql, new() { ["retentionDays"] = retentionDays }, cancellationToken);
                return await Execute(PurgeJobsSql, new() { ["retentionDays"] = retentionDays }, cancellationToken);
            },
            readOnly: false,
            cancellationToken);

    private static BatchJob ReadJob(DbDataReader reader) =>
        new(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(7),
            Convert.ToInt32(reader.GetValue(8), CultureInfo.InvariantCulture),
            Convert.ToInt32(reader.GetValue(9), CultureInfo.InvariantCulture),
            Convert.ToInt32(reader.GetValue(10), CultureInfo.InvariantCulture),
            Convert.ToInt32(reader.GetValue(11), CultureInfo.InvariantCulture),
            ReadTime(reader.GetValue(12)),
            reader.IsDBNull(14) ? null : ReadTime(reader.GetValue(14)));

    // ─── La conexión y los marcadores ───────────────────────────────────────────────────────────

    /// <summary>Una fila (o null), en la transacción en curso o en una de solo lectura.</summary>
    private Task<T?> Read<T>(string sql, Dictionary<string, object?> values, Func<DbDataReader, T> map, CancellationToken cancellationToken)
        where T : class =>
        transactions.InTransaction(
            () => OnConnection(
                async () =>
                {
                    await using var command = Command(sql, values);
                    await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                    return await reader.ReadAsync(cancellationToken) ? map(reader) : null;
                },
                cancellationToken),
            readOnly: true,
            cancellationToken);

    /// <summary>Una escritura, en la transacción en curso o en una propia: cuántas filas tocó.</summary>
    private Task<int> Write(string sql, Dictionary<string, object?> values, CancellationToken cancellationToken) =>
        transactions.InTransaction(() => Execute(sql, values, cancellationToken), readOnly: false, cancellationToken);

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
                throw new InvalidOperationException($"Falta el valor de :{match.Groups[1].Value} en una sentencia de los lotes");
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
}

/** Las dos tablas, mapeadas SOLO para el esquema (como keel_timer y el historial): las crea EF en `local` y entran en el baseline. */
function rowsFile(model) {
  const { namespace, path } = located(model, 'rows', BATCH_JOB_ROW);
  const TYPES = { uuid: 'Guid', string: 'string', timestamp: 'DateTimeOffset', text: 'string', int: 'int' };
  const property = (name) => name.replace(/(^|_)([a-z])/g, (_m, _s, c) => c.toUpperCase());
  const properties = (table) =>
    table.columns.map((column) => {
      const type = TYPES[column.base];
      const nullable = column.nullable ? '?' : '';
      const init = type === 'string' && !column.nullable ? ' = null!;' : '';
      return `    public ${type}${nullable} ${property(column.name)} { get; set; }${init}`;
    });
  const chains = (table) =>
    table.columns.map((column) => {
      const parts = [`row.Property(r => r.${property(column.name)})`, `.HasColumnName(${csString(column.name)})`];
      if (column.length != null) parts.push(`.HasMaxLength(${column.length})`);
      // text y no el longtext que MySQL daría a una cadena sin tope: el tipo de los otros tres servidores.
      if (column.base === 'text') parts.push('.HasColumnType("text")');
      parts.push(column.nullable ? '.IsRequired(false)' : '.IsRequired()');
      if (column.primary) parts.push('.ValueGeneratedNever()');
      return `        ${parts.join('')};`;
    });
  const unique = BATCH_JOB.uniques[0];
  const index = BATCH_JOB.indexes[0];
  const fk = BATCH_ITEM_RESULT.columns.find((column) => column.references).references;
  const resultKeys = BATCH_ITEM_RESULT.columns.filter((column) => column.primary).map((column) => `r.${property(column.name)}`);
  const columnsOf = (columns) => columns.map((name) => `r.${property(name)}`).join(', ');
  const body = `/// <summary>
/// Un trabajo de un lote asíncrono (DSL 2.30), mapeado SOLO para el esquema: así lo crea EF en <c>local</c>, lo lleva el
/// baseline de <c>dotnet ef</c> (o el paso de esquema de build, si la base ya está desplegada) y lo nombra el snapshot del modelo.
/// Nadie lo lee por EF: lo usa BatchJobStore, con las sentencias de keel-core. Columnas, unicidad, índice y FK son los de keel-core
/// (<c>BATCH_JOB</c>), los de los cuatro servidores.
/// </summary>
public sealed class ${BATCH_JOB_ROW}
{
${properties(BATCH_JOB).join('\n\n')}
}

/// <summary>Un resultado por elemento intentado; se va con su trabajo (ON DELETE CASCADE). Mapeado solo para el esquema.</summary>
public sealed class ${BATCH_ITEM_RESULT_ROW}
{
${properties(BATCH_ITEM_RESULT).join('\n\n')}
}

/// <summary>El mapeo de ${BATCH_JOB_ROW} a la tabla ${BATCH_JOB.table}.</summary>
public sealed class ${BATCH_JOB_ROW}Configuration : IEntityTypeConfiguration<${BATCH_JOB_ROW}>
{
    public void Configure(EntityTypeBuilder<${BATCH_JOB_ROW}> row)
    {
        row.ToTable(${csString(BATCH_JOB.table)});
        row.HasKey(r => r.Id).HasName(${csString(`${BATCH_JOB.table}_pkey`)});
${chains(BATCH_JOB).join('\n')}
        // Dos claves NULL no chocan en una unicidad (PostgreSQL y MySQL): un trabajo sin clave no ocupa ninguna.
        row.HasIndex(r => new { ${columnsOf(unique.columns)} }, ${csString(unique.name)}).IsUnique().HasDatabaseName(${csString(unique.name)});
        row.HasIndex(r => new { ${columnsOf(index.columns)} }, ${csString(index.name)}).HasDatabaseName(${csString(index.name)});
    }
}

/// <summary>El mapeo de ${BATCH_ITEM_RESULT_ROW} a la tabla ${BATCH_ITEM_RESULT.table}: se va con su trabajo (ON DELETE CASCADE).</summary>
public sealed class ${BATCH_ITEM_RESULT_ROW}Configuration : IEntityTypeConfiguration<${BATCH_ITEM_RESULT_ROW}>
{
    public void Configure(EntityTypeBuilder<${BATCH_ITEM_RESULT_ROW}> row)
    {
        row.ToTable(${csString(BATCH_ITEM_RESULT.table)});
        row.HasKey(r => new { ${resultKeys.join(', ')} }).HasName(${csString(`${BATCH_ITEM_RESULT.table}_pkey`)});
${chains(BATCH_ITEM_RESULT).join('\n')}
        row.HasOne<${BATCH_JOB_ROW}>().WithMany().HasForeignKey(r => r.JobId).HasConstraintName(${csString(fk.name)}).OnDelete(DeleteBehavior.Cascade);
    }
}`;
  return { path, content: csFile({ namespace, usings: ['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Metadata.Builders'], body }) };
}

function mongoStoreBody() {
  const { job, result } = BATCH_JOB_COLLECTIONS;
  return `/// <summary>
/// Los trabajos de los lotes asíncronos sobre MongoDB, con la forma documental de keel-core (<c>BATCH_JOB_COLLECTIONS</c>): los
/// nombres de campo son los de las columnas, el trabajo lleva su id (texto) en <c>_id</c> y cada resultado la clave aplanada
/// <c>&lt;job&gt;|&lt;índice&gt;</c>, que hace que el motor rechace un segundo resultado del mismo elemento. La unicidad de la clave
/// de idempotencia es PARCIAL (DocumentIndexes): en MongoDB dos ausentes sí chocan.
/// </summary>
/// <remarks>
/// Por la sesión de la transacción en curso (PersistenceTransactions). La hora es la del servidor (<c>$$NOW</c>), como la del
/// cronómetro, y se pide sin la sesión: un comando así no se admite dentro de una transacción.
/// </remarks>
public sealed class ${BATCH_JOB_STORE}(DocumentDatabase database, PersistenceTransactions transactions) : ${BATCH_JOB_STORE_PORT}
{
    private const string Jobs = ${csString(job.collection)};

    private const string ItemResults = ${csString(result.collection)};

    private IMongoCollection<BsonDocument> JobCollection => transactions.Collection(Jobs);

    private IMongoCollection<BsonDocument> ResultCollection => transactions.Collection(ItemResults);

    public async Task<BatchJobKeyHit?> ByKey(string operation, string owner, string key, CancellationToken cancellationToken = default)
    {
        var now = await DbNow(cancellationToken);
        var filter = new BsonDocument
        {
            { "operation", operation },
            { "owner", owner },
            { "idempotency_key", key },
            { "$or", new BsonArray { new BsonDocument("key_expires_at", BsonNull.Value), new BsonDocument("key_expires_at", new BsonDocument("$gt", new BsonDateTime(now.UtcDateTime))) } }
        };
        var found = await First(JobCollection, filter, cancellationToken);
        return found is null ? null : new BatchJobKeyHit(Guid.Parse(found["_id"].AsString), found.GetValue("signature", BsonNull.Value) is BsonString signature ? signature.Value : null);
    }

    public async Task ReleaseKey(string operation, string owner, string key, CancellationToken cancellationToken = default)
    {
        var now = await DbNow(cancellationToken);
        var filter = new BsonDocument
        {
            { "operation", operation },
            { "owner", owner },
            { "idempotency_key", key },
            { "key_expires_at", new BsonDocument("$lte", new BsonDateTime(now.UtcDateTime)) }
        };
        var update = new BsonDocument("$unset", new BsonDocument("idempotency_key", ""));
        if (transactions.Session is { } session)
        {
            await JobCollection.UpdateManyAsync(session, filter, update, cancellationToken: cancellationToken);
        }
        else
        {
            await JobCollection.UpdateManyAsync(filter, update, cancellationToken: cancellationToken);
        }
    }

    public async Task Insert(Guid id, string operation, string owner, string? key, string? signature, long? ttlMs, string input, int total, CancellationToken cancellationToken = default)
    {
        var now = await DbNow(cancellationToken);
        var document = new BsonDocument
        {
            { "_id", id.ToString("D") },
            { "operation", operation },
            { "owner", owner },
            { "status", ${csString(BATCH_JOB_STATUSES.queued)} }
        };
        // Sin clave el campo no existe: el índice parcial solo mira los trabajos que tienen una.
        if (key is not null)
        {
            document["idempotency_key"] = key;
        }
        document["signature"] = signature is null ? BsonNull.Value : new BsonString(signature);
        document["key_expires_at"] = ttlMs is null ? BsonNull.Value : new BsonDateTime(now.UtcDateTime.AddMilliseconds(ttlMs.Value));
        document["input"] = input;
        document["total"] = total;
        document["next_index"] = 0;
        document["succeeded"] = 0;
        document["failed"] = 0;
        document["created_at"] = new BsonDateTime(now.UtcDateTime);
        document["updated_at"] = new BsonDateTime(now.UtcDateTime);
        document["finished_at"] = BsonNull.Value;
        if (transactions.Session is { } session)
        {
            await JobCollection.InsertOneAsync(session, document, cancellationToken: cancellationToken);
        }
        else
        {
            await JobCollection.InsertOneAsync(document, cancellationToken: cancellationToken);
        }
    }

    public async Task<BatchJob?> Job(Guid id, CancellationToken cancellationToken = default)
    {
        var found = await First(JobCollection, new BsonDocument("_id", id.ToString("D")), cancellationToken);
        return found is null ? null : ReadJob(found);
    }

    public async Task<BatchJob?> Owned(Guid id, string operation, string owner, CancellationToken cancellationToken = default)
    {
        var found = await First(JobCollection, new BsonDocument { { "_id", id.ToString("D") }, { "operation", operation }, { "owner", owner } }, cancellationToken);
        return found is null ? null : ReadJob(found);
    }

    public async Task<bool> Advance(Guid id, int index, int succeeded, int failed, CancellationToken cancellationToken = default)
    {
        var now = await DbNow(cancellationToken);
        var filter = new BsonDocument { { "_id", id.ToString("D") }, { "next_index", index } };
        var update = new BsonDocument
        {
            { "$inc", new BsonDocument { { "next_index", 1 }, { "succeeded", succeeded }, { "failed", failed } } },
            { "$set", new BsonDocument { { "status", ${csString(BATCH_JOB_STATUSES.running)} }, { "updated_at", new BsonDateTime(now.UtcDateTime) } } }
        };
        var updated = transactions.Session is { } session
            ? await JobCollection.UpdateOneAsync(session, filter, update, cancellationToken: cancellationToken)
            : await JobCollection.UpdateOneAsync(filter, update, cancellationToken: cancellationToken);
        return updated.ModifiedCount == 1;
    }

    public async Task InsertResult(Guid jobId, int index, string status, string? errorCode, string? message, string? result, CancellationToken cancellationToken = default)
    {
        var job = jobId.ToString("D");
        var document = new BsonDocument
        {
            { "_id", job + "|" + index.ToString(System.Globalization.CultureInfo.InvariantCulture) },
            { "job_id", job },
            { "item_index", index },
            { "status", status },
            { "error_code", errorCode is null ? BsonNull.Value : new BsonString(errorCode) },
            { "message", message is null ? BsonNull.Value : new BsonString(message) },
            { "result", result is null ? BsonNull.Value : new BsonString(result) }
        };
        if (transactions.Session is { } session)
        {
            await ResultCollection.InsertOneAsync(session, document, cancellationToken: cancellationToken);
        }
        else
        {
            await ResultCollection.InsertOneAsync(document, cancellationToken: cancellationToken);
        }
    }

    public async Task<bool> Finish(Guid id, string status, CancellationToken cancellationToken = default)
    {
        var now = new BsonDateTime((await DbNow(cancellationToken)).UtcDateTime);
        var filter = new BsonDocument { { "_id", id.ToString("D") }, { "finished_at", BsonNull.Value } };
        var update = new BsonDocument("$set", new BsonDocument { { "status", status }, { "finished_at", now }, { "updated_at", now } });
        var updated = transactions.Session is { } session
            ? await JobCollection.UpdateOneAsync(session, filter, update, cancellationToken: cancellationToken)
            : await JobCollection.UpdateOneAsync(filter, update, cancellationToken: cancellationToken);
        return updated.ModifiedCount == 1;
    }

    public async Task<IReadOnlyList<BatchJobResult>> Results(Guid jobId, int limit, long offset, CancellationToken cancellationToken = default)
    {
        // Un límite 0 en MongoDB es «sin límite»: una página de tamaño 0 no lee nada.
        if (limit == 0)
        {
            return [];
        }
        var filter = new BsonDocument("job_id", jobId.ToString("D"));
        var find = transactions.Session is { } session ? ResultCollection.Find(session, filter) : ResultCollection.Find(filter);
        var documents = await find.Sort(new BsonDocument("item_index", 1)).Skip((int)Math.Min(offset, int.MaxValue)).Limit(limit).ToListAsync(cancellationToken);
        return
        [
            .. documents.Select(document => new BatchJobResult(
                document["item_index"].ToInt32(),
                document["status"].AsString,
                Text(document, "error_code"),
                Text(document, "message"),
                Text(document, "result")))
        ];
    }

    public async Task<long> ResultsCount(Guid jobId, CancellationToken cancellationToken = default)
    {
        var filter = new BsonDocument("job_id", jobId.ToString("D"));
        return transactions.Session is { } session
            ? await ResultCollection.CountDocumentsAsync(session, filter, cancellationToken: cancellationToken)
            : await ResultCollection.CountDocumentsAsync(filter, cancellationToken: cancellationToken);
    }

    public async Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default)
    {
        var before = new BsonDateTime((await DbNow(cancellationToken)).UtcDateTime.AddDays(-retentionDays));
        return await transactions.InTransaction(
            async () =>
            {
                var session = transactions.Session!;
                var finished = new BsonDocument("finished_at", new BsonDocument { { "$ne", BsonNull.Value }, { "$lt", before } });
                var ids = (await JobCollection.Find(session, finished).Project(new BsonDocument("_id", 1)).ToListAsync(cancellationToken)).Select(document => document["_id"]).ToList();
                if (ids.Count == 0)
                {
                    return 0;
                }
                await ResultCollection.DeleteManyAsync(session, new BsonDocument("job_id", new BsonDocument("$in", new BsonArray(ids))), cancellationToken: cancellationToken);
                var deleted = await JobCollection.DeleteManyAsync(session, new BsonDocument("_id", new BsonDocument("$in", new BsonArray(ids))), cancellationToken: cancellationToken);
                return (int)deleted.DeletedCount;
            },
            readOnly: false,
            cancellationToken);
    }

    /// <summary>La hora del servidor, sin la sesión de la transacción en curso (como TimerStore.DbNow).</summary>
    private async Task<DateTimeOffset> DbNow(CancellationToken cancellationToken)
    {
        var pipeline = new BsonDocumentStagePipelineDefinition<NoPipelineInput, BsonDocument>([new BsonDocument("$documents", new BsonArray { new BsonDocument("now", "$$NOW") })]);
        using var cursor = await database.Database.AggregateAsync(pipeline, cancellationToken: cancellationToken);
        var row = await cursor.FirstAsync(cancellationToken);
        return new DateTimeOffset(row["now"].ToUniversalTime(), TimeSpan.Zero);
    }

    private async Task<BsonDocument?> First(IMongoCollection<BsonDocument> collection, BsonDocument filter, CancellationToken cancellationToken)
    {
        var find = transactions.Session is { } session ? collection.Find(session, filter) : collection.Find(filter);
        return await find.FirstOrDefaultAsync(cancellationToken);
    }

    private static string? Text(BsonDocument document, string field) => document.GetValue(field, BsonNull.Value) is BsonString text ? text.Value : null;

    private static DateTimeOffset? Instant(BsonDocument document, string field) =>
        document.GetValue(field, BsonNull.Value) is BsonDateTime date ? new DateTimeOffset(date.ToUniversalTime(), TimeSpan.Zero) : null;

    private static BatchJob ReadJob(BsonDocument document) =>
        new(
            Guid.Parse(document["_id"].AsString),
            document["operation"].AsString,
            document["owner"].AsString,
            document["status"].AsString,
            document["input"].AsString,
            document["total"].ToInt32(),
            document["next_index"].ToInt32(),
            document["succeeded"].ToInt32(),
            document["failed"].ToInt32(),
            Instant(document, "created_at") ?? throw new InvalidOperationException("Un trabajo sin created_at"),
            Instant(document, "finished_at"));
}`;
}

// ─── El alta, las dos rutas y el procesador ──────────────────────────────────────────────────────

function jobsUsings(model) {
  const usings = [
    'System.Security.Cryptography',
    'System.Text',
    'System.Text.Json',
    'System.Text.Json.Serialization',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.DependencyInjection',
    namespaceOf(model, 'errors'),
    namespaceOf(model, 'persistence'),
    namespaceOf(model, 'repositories'),
    namespaceOf(model, 'useCaseInfra'),
    namespaceOf(model, 'timer'),
    // WireJson: el texto del result de cada elemento, con las reglas del cable.
    namespaceOf(model, 'appSupport'),
    batchInfraNamespace(model),
    ...typeUsings(model, ['PagedResponse'])
  ];
  if (model.layersPresent?.security) usings.push(namespaceOf(model, 'security'));
  return usings;
}

function jobsBody(model) {
  const notFound = FRAMEWORK_ERRORS.batchJobNotFound;
  const canonical = FRAMEWORK_ERRORS.idempotencyReuse;
  const { completed, aborted } = BATCH_JOB_STATUSES;
  const succeeded = 'succeeded';
  const security = Boolean(model.layersPresent?.security);
  const codes = asyncOperations(model).map((operation) => `        [${csString(operation.name)}] = ${csString(idempotencyOutcomeCode(model, operation.name, canonical))},`);
  return `// Los lotes asíncronos (DSL 2.30, fase B; wire-contract.md § Lotes asíncronos): el trabajo en el cable, el alta, las dos
// rutas que lo leen y el procesador que lo recorre por partes sobre el cronómetro.
//
// No lo edites: lo regenera build.

/// <summary>
/// El trabajo de un lote asíncrono en el cable: su estado y su resumen. <c>notAttempted</c> solo cuenta en un trabajo
/// <c>${aborted}</c>: lo que queda por procesar de uno en marcha no se ha intentado todavía, pero tampoco se ha descartado
/// (<c>batchJobView</c> de keel-core). Sus claves salen siempre: no lleva la marca [OmitNulls].
/// </summary>
public sealed record BatchJobView(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("summary")] BatchSummary Summary,
    [property: JsonPropertyName("createdAt")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("finishedAt")] DateTimeOffset? FinishedAt)
{
    public static BatchJobView Of(BatchJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        var notAttempted = job.Status == ${csString(aborted)} ? job.Total - job.NextIndex : 0;
        return new BatchJobView(job.Id, job.Status, new BatchSummary(job.Total, job.Succeeded, job.Failed, notAttempted), job.CreatedAt, job.FinishedAt);
    }
}

/// <summary>
/// El trabajo de un lote asíncrono que no existe, que ya se purgó o que creó OTRO llamante (D11): los tres casos responden
/// igual, para no decirle a nadie que un trabajo ajeno existe. Su code es del framework (docs/framework-errors.md).
/// </summary>
public sealed class BatchJobNotFoundException(Guid jobId)
    : NotFoundException($"No hay ningún trabajo {jobId}", code: ${csString(notFound.code)}, httpStatus: ${notFound.http}, args: [jobId]);

/// <summary>
/// La misma clave de idempotencia de un lote asíncrono con un contenido DISTINTO (D13): no es un reintento, y devolver el
/// trabajo de la primera petición contestaría a una pregunta que el cliente no hizo.
/// </summary>
public sealed class BatchJobKeyReusedException(string operation, string key)
    : ConflictException($"La clave de idempotencia {operation}/{key} ya se usó con un contenido distinto", code: BatchJobRequests.KeyReusedCode(operation), httpStatus: ${canonical.http}, args: [operation, key]);

/// <summary>Lo que el alta lee de la petición: los bytes del cuerpo, su firma y la cabecera de la clave.</summary>
public static class BatchJobRequests
{
    private static readonly Dictionary<string, string> KeyReusedCodes = new(StringComparer.Ordinal)
    {
${codes.join('\n')}
    };

    /// <summary>El code de la clave reutilizada de cada operación: el que declara el diseño para ese desenlace, o el canónico.</summary>
    public static string KeyReusedCode(string operation) => KeyReusedCodes.TryGetValue(operation, out var code) ? code : ${csString(canonical.code)};

    /// <summary>Los BYTES del cuerpo tal como llegaron: su firma es la de la petición (D13) y el trabajo los guarda.</summary>
    public static async Task<byte[]> Body(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer, request.HttpContext.RequestAborted);
        return buffer.ToArray();
    }

    /// <summary>La firma de la petición (D13): el sha256 en hexadecimal de los bytes del cuerpo, como batchRequestSignature de keel-core.</summary>
    public static string Signature(byte[] body) => Convert.ToHexStringLower(SHA256.HashData(body));

    /// <summary>La cabecera ${IDEMPOTENCY_HEADER} de la petición, o null si no llega o va en blanco.</summary>
    public static string? IdempotencyKey(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var value = request.Headers[${csString(IDEMPOTENCY_HEADER)}].FirstOrDefault();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    /// <summary>El id del trabajo de la ruta: un uuid que no se lee es una petición malformada.</summary>
    public static Guid JobId(HttpRequest request) =>
        TextValues.Uuid(TextValues.Route(request, ${csString(BATCH_JOB_PARAM)})) ?? throw new MalformedRequestException();
}

/// <summary>
/// Los lotes asíncronos (DSL 2.30, fase B) vistos desde la API: el alta del trabajo y las dos rutas que lo leen.
/// </summary>
/// <remarks>
/// <para>
/// El alta (D8) no procesa nada: lee el sobre con el lector de la operación (un sobre mal formado es un 400 sin trabajo,
/// BJ-9), resuelve la clave del lote (D13) y crea el trabajo y su temporizador de una vez en UNA transacción. Responde
/// ${BATCH_ACCEPTED_STATUS} con el trabajo; el endpoint pone su URL en Location.
/// </para>
/// <para>
/// Solo lee un trabajo quien lo creó (D11): el dueño es el actor de autoría de la petición, y lo ajeno, lo purgado y lo
/// inexistente responden igual, ${notFound.code}.
/// </para>
/// </remarks>
public sealed class BatchJobs(${BATCH_JOB_STORE_PORT} store, ITimerStore timers, IUseCaseTransactions transactions)
{
    /// <summary>
    /// El alta de un trabajo. <paramref name="body"/> son los bytes del cuerpo tal como llegaron; <paramref name="clientKey"/>,
    /// la cabecera ${IDEMPOTENCY_HEADER} (null si no llega o si la clave es el contenido); <paramref name="ttlSeconds"/>, la ventana de la clave.
    /// </summary>
    public async Task<BatchJobView> Submit<TItem, TMessage>(
        string operation,
        string kind,
        byte[] body,
        Func<ReadOnlyMemory<byte>, BatchEnvelope<TItem, TMessage>> readEnvelope,
        string? keySource,
        string? clientKey,
        int? ttlSeconds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(readEnvelope);
        var total = readEnvelope(body).Items.Count;
        var owner = AuditActor.Current();
        var signature = BatchJobRequests.Signature(body);
        var key = keySource == "payload-hash" ? signature : keySource is null ? null : clientKey;
        long? ttlMs = key is null || ttlSeconds is null ? null : ttlSeconds.Value * 1000L;
        var input = Encoding.UTF8.GetString(body);
        Guid id;
        try
        {
            id = await transactions.Run(() => Accept(operation, kind, owner, key, signature, ttlMs, input, total, cancellationToken), readOnly: false, cancellationToken);
        }
        catch (Exception error) when (key is not null && error is not BatchJobKeyReusedException && error is not OperationCanceledException)
        {
            // Dos altas con la misma clave a la vez: la que pierde choca con la unicidad del motor y responde el trabajo de la
            // ganadora, sin el 409 «en curso» (D13).
            var winner = await transactions.Run(() => Repeat(operation, owner, key, signature, cancellationToken), readOnly: false, cancellationToken);
            if (winner is null)
            {
                throw;
            }
            id = winner.Value;
        }
        var job = await store.Job(id, cancellationToken) ?? throw new BatchJobNotFoundException(id);
        return BatchJobView.Of(job);
    }

    private async Task<Guid> Accept(string operation, string kind, string owner, string? key, string signature, long? ttlMs, string input, int total, CancellationToken cancellationToken)
    {
        if (key is not null)
        {
            await store.ReleaseKey(operation, owner, key, cancellationToken);
            if (await Repeat(operation, owner, key, signature, cancellationToken) is { } same)
            {
                return same;
            }
        }
        var id = Guid.CreateVersion7();
        await store.Insert(id, operation, owner, key, signature, ttlMs, input, total, cancellationToken);
        // El temporizador de UNA vez del trabajo, para ya: lo reclama el cronómetro con su arriendo y su valla.
        await timers.Arm(kind, id, await timers.DbNow(cancellationToken), cancellationToken);
        return id;
    }

    /// <summary>El trabajo vivo de la clave (D13): el mismo si la firma casa, la clave reutilizada si no.</summary>
    private async Task<Guid?> Repeat(string operation, string owner, string key, string signature, CancellationToken cancellationToken)
    {
        var hit = await store.ByKey(operation, owner, key, cancellationToken);
        if (hit is null)
        {
            return null;
        }
        return hit.Signature == signature ? hit.Id : throw new BatchJobKeyReusedException(operation, key);
    }

    /// <summary>El trabajo, si es de quien llama.</summary>
    public async Task<BatchJobView> Status(string operation, Guid jobId, CancellationToken cancellationToken) =>
        BatchJobView.Of(await Owned(operation, jobId, cancellationToken));

    /// <summary>Los resultados de los elementos intentados, en orden de índice, con el sobre de página del cable.</summary>
    public async Task<PagedResponse<BatchItem>> Results(string operation, Guid jobId, Pageable pageable, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pageable);
        var job = await Owned(operation, jobId, cancellationToken);
        var rows = await store.Results(job.Id, pageable.Size, (long)pageable.Page * pageable.Size, cancellationToken);
        var items = rows
            .Select(row => row.Status == ${csString(succeeded)}
                ? BatchItem.Succeeded(row.Index, row.Result is null ? null : JsonDocument.Parse(row.Result).RootElement.Clone())
                : BatchItem.Failed(row.Index, row.ErrorCode ?? "", row.Message))
            .ToList();
        var page = Page<BatchItem>.Of(items, pageable, await store.ResultsCount(job.Id, cancellationToken));
        return new PagedResponse<BatchItem> { Items = page.Items, Page = page.Number, Size = page.Size, TotalElements = page.TotalElements, TotalPages = page.TotalPages };
    }

    private async Task<BatchJob> Owned(string operation, Guid jobId, CancellationToken cancellationToken) =>
        await store.Owned(jobId, operation, AuditActor.Current(), cancellationToken) ?? throw new BatchJobNotFoundException(jobId);
}

/// <summary>El cursor ya no estaba donde lo dejó este disparo: otra réplica se llevó el trabajo. Revierte el elemento entero.</summary>
public sealed class FenceLostException() : Exception("El trabajo lo procesa otra réplica");

/// <summary>
/// Un disparo del temporizador de un trabajo (DSL 2.30, D9): procesa un CHUNK desde el cursor y dice si queda trabajo
/// (rearmar para ya) o si terminó (borrar el temporizador). Es el <i>commit interval</i> y el <i>restart</i> de Spring Batch
/// sobre el cronómetro, sin la librería.
/// </summary>
/// <remarks>
/// <para>
/// Cada elemento va en su ÁMBITO (su contexto, su transacción) y en UNA transacción con tres cosas: su efecto (el despacho por
/// el mediator, que se une a ella), el avance del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue
/// donde lo dejó este disparo, y si no —otra réplica le quitó el trabajo al vencer su arriendo— el elemento revierte entero,
/// efecto incluido. Si la réplica cae a mitad de chunk, lo confirmado queda y el siguiente disparo sigue desde el cursor:
/// ningún elemento se aplica dos veces ni se queda sin resultado.
/// </para>
/// <para>
/// Fallan solo su elemento los codes de <c>itemErrors</c> y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo detiene el trabajo
/// (<c>${aborted}</c>, D4) con su code o ${FRAMEWORK_ERRORS.batchAborted.code}. Corre sin token: el actor de autoría de cada elemento es el
/// dueño del trabajo.
/// </para>
/// </remarks>
public sealed class BatchJobRunner(IServiceScopeFactory scopes, ${BATCH_JOB_STORE_PORT} store, ITimerStore timers, ${BATCH_SETTINGS} settings)
{
    /// <summary>
    /// Un disparo. <paramref name="readEnvelope"/> vuelve a leer el sobre guardado con el lector de la operación;
    /// <paramref name="process"/> despacha el mensaje de UN elemento en los servicios de su ámbito y devuelve su result (null si
    /// la operación no declara batch.output).
    /// </summary>
    public async Task<TimerOutcome> RunChunk<TItem, TMessage>(
        ClaimedTimer timer,
        Func<ReadOnlyMemory<byte>, BatchEnvelope<TItem, TMessage>> readEnvelope,
        Func<JsonElement?, TItem?> readItem,
        IReadOnlyCollection<string> itemErrors,
        Func<IServiceProvider, TMessage, CancellationToken, Task<object?>> process,
        CancellationToken cancellationToken)
        where TItem : class
    {
        ArgumentNullException.ThrowIfNull(timer);
        ArgumentNullException.ThrowIfNull(readEnvelope);
        var job = await store.Job(timer.EntityId, cancellationToken);
        if (job is null || job.FinishedAt is not null)
        {
            return TimerOutcome.Finished();
        }
        var envelope = readEnvelope(Encoding.UTF8.GetBytes(job.Input));
        using var owner = AsOwner(job.Owner);
        var index = job.NextIndex;
        var end = Math.Min(job.Total, index + settings.ChunkSize);
        for (; index < end; index++)
        {
            if (!await ProcessItem(job.Id, index, envelope, readItem, itemErrors, process, cancellationToken))
            {
                return TimerOutcome.Finished();
            }
        }
        if (index >= job.Total)
        {
            await store.Finish(job.Id, ${csString(completed)}, cancellationToken);
            return TimerOutcome.Finished();
        }
        return TimerOutcome.RescheduleAt(await timers.DbNow(cancellationToken));
    }

    /// <summary>Un elemento: true para seguir, false para parar el disparo (detiene el lote, o el trabajo es de otra réplica).</summary>
    private async Task<bool> ProcessItem<TItem, TMessage>(
        Guid jobId,
        int index,
        BatchEnvelope<TItem, TMessage> envelope,
        Func<JsonElement?, TItem?> readItem,
        IReadOnlyCollection<string> itemErrors,
        Func<IServiceProvider, TMessage, CancellationToken, Task<object?>> process,
        CancellationToken cancellationToken)
        where TItem : class
    {
        TItem item;
        try
        {
            item = BatchRunner.ReadItem(envelope.Items[index], readItem) ?? throw BatchRunner.Invalid;
        }
        catch (BatchRunner.InvalidItemException invalid)
        {
            return await Failed(jobId, BatchItem.Failed(index, BatchRunner.ValidationError, invalid.Message), stops: false, cancellationToken);
        }
        BatchItem failure;
        bool stops;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var services = scope.ServiceProvider;
            try
            {
                await services.GetRequiredService<IUseCaseTransactions>().Run(
                    async () =>
                    {
                        var result = await process(services, envelope.Message(item), cancellationToken);
                        await Keep(services.GetRequiredService<${BATCH_JOB_STORE_PORT}>(), jobId, BatchItem.Succeeded(index, result), cancellationToken);
                        return true;
                    },
                    readOnly: false,
                    cancellationToken);
                return true;
            }
            catch (FenceLostException)
            {
                return false;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                (failure, stops) = BatchRunner.FailureOf(index, ApiErrorMiddleware.Translate(services, error), itemErrors);
            }
        }
        return await Failed(jobId, failure, stops, cancellationToken);
    }

    /// <summary>Un elemento que falla: su resultado y el avance, en su transacción; si detiene el lote, también el final (D4).</summary>
    private async Task<bool> Failed(Guid jobId, BatchItem item, bool stops, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var own = services.GetRequiredService<${BATCH_JOB_STORE_PORT}>();
        try
        {
            await services.GetRequiredService<IUseCaseTransactions>().Run(
                async () =>
                {
                    await Keep(own, jobId, item, cancellationToken);
                    if (stops)
                    {
                        await own.Finish(jobId, ${csString(aborted)}, cancellationToken);
                    }
                    return true;
                },
                readOnly: false,
                cancellationToken);
        }
        catch (FenceLostException)
        {
            return false;
        }
        return !stops;
    }

    /// <summary>
    /// La valla y el resultado de un elemento, en la transacción en curso: primero el avance del cursor, que toma la fila del
    /// trabajo, y después el resultado. Si el cursor ya no estaba en su índice, lanza y la transacción revierte entera.
    /// </summary>
    private static async Task Keep(${BATCH_JOB_STORE_PORT} own, Guid jobId, BatchItem item, CancellationToken cancellationToken)
    {
        var ok = item.Status == ${csString(succeeded)};
        if (!await own.Advance(jobId, item.Index, ok ? 1 : 0, ok ? 0 : 1, cancellationToken))
        {
            throw new FenceLostException();
        }
        var result = item.Result is null ? null : JsonSerializer.Serialize(item.Result, WireJson.Options);
        await own.InsertResult(jobId, item.Index, item.Status, item.Error, item.Message, result, cancellationToken);
    }

    /// <summary>El disparo corre como el dueño del trabajo: el actor de autoría de cada elemento (el trabajo no tiene token).</summary>
    private static IDisposable AsOwner(string owner) =>
${
  security
    ? `        SecurityContext.Open(new Principal(PrincipalKind.Token, owner, new HashSet<string>(), new Dictionary<string, JsonElement> { ["sub"] = JsonSerializer.SerializeToElement(owner) }));`
    : `        new NoOwner();

    private sealed class NoOwner : IDisposable
    {
        public void Dispose()
        {
        }
    }`
}
}`;
}

// ─── El temporizador de cada operación ───────────────────────────────────────────────────────────

function endpointsOf(model, operation) {
  const service = model.services.find((candidate) => candidate.operations.includes(operation));
  // El nombre de endpointsClass (endpoints.js), sin importarlo: endpoints.js importa este módulo.
  return service.controllerClass.replace(/Controller$/, 'Endpoints');
}

function handlerUsings(model, operation) {
  return [
    'Microsoft.Extensions.DependencyInjection',
    namespaceOf(model, 'timer'),
    namespaceOf(model, 'endpoints'),
    namespaceOf(model, 'abstractions'),
    namespaceOf(model, 'appSupport'),
    namespaceOf(model, operation.kind === 'query' ? 'queries' : 'commands'),
    ...typeUsings(model, [operation.batch.itemType])
  ];
}

function handlerBody(model, operation) {
  const batch = operation.batch;
  const className = batchJobClass(operation);
  const dispatch = 'services.GetRequiredService<IUseCaseMediator>().Dispatch(message, cancellationToken)';
  const process =
    batch.resultFields.length > 0
      ? `    private static async Task<object?> Process(IServiceProvider services, ${operation.messageClass} message, CancellationToken cancellationToken) =>
        await ${dispatch};`
      : `    private static async Task<object?> Process(IServiceProvider services, ${operation.messageClass} message, CancellationToken cancellationToken)
    {
        await ${dispatch};
        return null;
    }`;
  return `/// <summary>
/// Los trabajos del lote asíncrono ${operation.name} (DSL 2.30): un temporizador de UNA vez por trabajo
/// (<c>${batchKind(operation.name)}</c>), y cada disparo procesa un chunk (BatchJobRunner).
/// </summary>
/// <remarks>
/// Corre FUERA de la transacción del sondeador (<see cref="InTransaction"/>): cada elemento abre la suya. El sobre guardado se
/// vuelve a leer con el MISMO lector de la operación que usa el borde. No lo edites: lo regenera build.
/// </remarks>
public sealed class ${className}(BatchJobRunner runner) : ITimerHandler
{
    private static readonly string[] ItemErrors = [${batch.itemErrors.map(csString).join(', ')}];

    public string Kind => TimerKinds.${batchKindConstant(operation.name)};

    public bool InTransaction => false;

    public Task<TimerOutcome> Handle(ClaimedTimer timer, DateTimeOffset dbNow, CancellationToken cancellationToken) =>
        runner.RunChunk<${batch.itemType}, ${operation.messageClass}>(timer, ${endpointsOf(model, operation)}.Read${csMember(operation.name)}, ValueReaders.Read${batch.itemType}, ItemErrors, Process, cancellationToken);

${process}
}`;
}

function registrationBody(model) {
  const handlers = asyncOperations(model).map((operation) => `        services.AddScoped<ITimerHandler, ${batchJobClass(operation)}>();`);
  return `/// <summary>
/// Los lotes asíncronos (DSL 2.30) en el contenedor: el alta y las rutas del trabajo, el procesador y un handler del cronómetro
/// por operación. Los handlers son de la API (leen el sobre con el lector del endpoint y traducen el fallo con el middleware de
/// errores), así que no los registra AddTimer sino esto, desde Program.cs. BatchSettings lo registra Program.cs con el perfil.
/// </summary>
public static class BatchJobRegistration
{
    public static IServiceCollection AddBatchJobs(this IServiceCollection services)
    {
        services.AddScoped<BatchJobs>();
        services.AddScoped<BatchJobRunner>();
${handlers.join('\n')}
        return services;
    }
}`;
}

// ─── El endpoint ─────────────────────────────────────────────────────────────────────────────────

/**
 * Los tres endpoints de una operación asíncrona: el alta (los bytes del cuerpo, la cabecera de la clave) y las dos rutas
 * del trabajo. `usings` es la lista del archivo de endpoints; `doc`, la documentación del alta.
 */
export function batchJobEndpoints(model, operation, { doc, usings }) {
  const batch = operation.batch;
  const paths = batchJobPaths(operation.route.path);
  const idempotency = batch.idempotency;
  usings.push('Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'timer'), namespaceOf(model, 'repositories'));
  const keySource = idempotency ? csString(idempotency.keySource) : 'null';
  const clientKey = idempotency?.keySource === 'client-key' ? 'BatchJobRequests.IdempotencyKey(http.Request)' : 'null';
  const ttl = idempotency?.ttlSeconds ?? 'null';
  const op = csString(operation.name);
  const pagination = model.pagination ?? {};
  const member = csMember(operation.name);
  return `${doc}    public static async Task ${member}(HttpContext http)
    {
        // Lote asíncrono (DSL 2.30): ${BATCH_ACCEPTED_STATUS} con el trabajo; lo procesa el cronómetro por partes.
        var body = await BatchJobRequests.Body(http.Request);
        var job = await http.RequestServices.GetRequiredService<BatchJobs>().Submit<${batch.itemType}, ${operation.messageClass}>(
            ${op},
            TimerKinds.${batchKindConstant(operation.name)},
            body,
            Read${member},
            ${keySource},
            ${clientKey},
            ${ttl},
            http.RequestAborted);
        http.Response.Headers.Location = HttpReply.Location(http.Request, ${csString(`${model.api.routeBase}${paths.status}`)}, job.Id);
        await HttpReply.Json(http, ${BATCH_ACCEPTED_STATUS}, job);
    }

    /// <summary>GET ${paths.status} (${operation.name}): el trabajo, su estado y su resumen. Solo lo lee quien lo creó.</summary>
    public static async Task ${jobEndpoint(operation)}(HttpContext http)
    {
        var job = await http.RequestServices.GetRequiredService<BatchJobs>().Status(${op}, BatchJobRequests.JobId(http.Request), http.RequestAborted);
        await HttpReply.Json(http, 200, job);
    }

    /// <summary>GET ${paths.results} (${operation.name}): los resultados de los elementos intentados, en orden de índice.</summary>
    public static async Task ${jobResultsEndpoint(operation)}(HttpContext http)
    {
        var jobId = BatchJobRequests.JobId(http.Request);
        var pageable = PageableReading.Read(http.Request.Query, defaultSize: ${pagination.defaultSize ?? PAGEABLE_DEFAULT_SIZE}, maxSize: ${pagination.maxSize ?? PAGEABLE_MAX_SIZE}, defaultSort: []);
        var page = await http.RequestServices.GetRequiredService<BatchJobs>().Results(${op}, jobId, pageable, http.RequestAborted);
        await HttpReply.Json(http, 200, page);
    }`;
}

/** Las dos filas de ApiRoutes del trabajo de una operación asíncrona, como las de routeRow. */
export function batchJobRouteRows(model, operation) {
  const paths = batchJobPaths(operation.route.path);
  return [
    { operation: `${operation.name}Job`, method: 'GET', path: `${model.api.routeBase}${paths.status}`, status: 200, location: false, query: [], body: null, member: jobEndpoint(operation) },
    { operation: `${operation.name}JobResults`, method: 'GET', path: `${model.api.routeBase}${paths.results}`, status: 200, location: false, query: ['page', 'size'], body: null, member: jobResultsEndpoint(operation) }
  ];
}
