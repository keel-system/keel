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
//
// El lote SÍNCRONO con clave (D15, incremento 10b) usa el mismo almacén, sin temporizador: `KeyedBatches` (Api/Rest) crea su
// trabajo, procesa cada elemento con los mismos pasos que el procesador (`BatchJobSteps`: cada elemento en su ámbito, con su
// efecto, la valla y su resultado en UNA transacción) y responde lo guardado (`batchStoredBody`), así que la primera
// petición, la repetición y la que reanuda responden lo mismo.

import {
  asyncBatchOperations,
  batchJobStoreOperations,
  keyedSyncBatchOperations,
  batchJobPaths,
  BATCH_JOB_PARAM,
  BATCH_ACCEPTED_STATUS
} from '@keel-system/keel-core/gen/batch';
import {
  BATCH_JOB,
  BATCH_ITEM_RESULT,
  BATCH_JOB_COLLECTIONS,
  BATCH_JOB_STATUSES,
  BATCH_PARAMETERS,
  BATCH_STORE_ENGINES,
  BATCH_SYNC_STALE,
  BATCH_ANONYMOUS_OWNER,
  batchKind,
  batchStatements,
  batchSyncStatements
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

/**
 * ¿Usa el servicio el almacén de trabajos? Con un lote asíncrono o un lote síncrono con clave (D15). Sin persistencia no hay
 * dónde guardar el trabajo (lo rechaza la frontera).
 */
export const usesBatchJobs = (model) => Boolean(model.layersPresent?.persistence) && batchJobStoreOperations(model).length > 0;

/** ¿Tiene el servicio algún lote asíncrono? El alta, el procesador, su temporizador y las dos rutas del trabajo. */
export const usesAsyncBatchJobs = (model) => usesBatchJobs(model) && asyncBatchOperations(model).length > 0;

/** ¿Tiene el servicio algún lote síncrono con clave (D15)? */
export const usesKeyedBatches = (model) => usesBatchJobs(model) && keyedSyncBatchOperations(model).length > 0;

/** ¿Es la operación un lote asíncrono que se genera? */
export const isAsyncBatch = (model, operation) => operation.batch?.execution === 'async' && usesAsyncBatchJobs(model);

/** ¿Es la operación un lote síncrono con clave que se genera (D15)? */
export const isKeyedBatch = (model, operation) =>
  Boolean(operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency) && usesKeyedBatches(model);

/** Las operaciones síncronas con clave del modelo, enteras. */
const keyedOperations = (model) =>
  (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => operation.batch && operation.batch.execution !== 'async' && operation.batch.idempotency);

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
  if (batchJobStoreOperations(model).length === 0) return [];
  const errors = [];
  const what = asyncBatchOperations(model).length > 0 ? 'execution: async' : 'idempotency en un lote síncrono';
  if (!model.layersPresent?.persistence) {
    errors.push(`use-cases: batch (${what}, DSL 2.30): el trabajo vive en la base del servicio, y este diseño no tiene capa persistence.`);
  } else if (!isDocument(model) && !BATCH_STORE_ENGINES.includes(model.stack?.database)) {
    errors.push(
      `use-cases: batch (${what}, DSL 2.30): el almacén de los trabajos tiene sentencias medidas para ${BATCH_STORE_ENGINES.join(', ')}, ` +
        `y no para '${model.stack?.database}'. Elige uno de esos motores, o declara execution: sync sin idempotency.`
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
  const keyed = usesKeyedBatches(model);
  const infra = (name, usings, body) => {
    const { namespace, path } = located(model, 'batchInfra', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const rest = (name, usings, body) => {
    const { namespace, path } = located(model, 'rest', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    infra(BATCH_JOB_STORE_PORT, [], portBody(keyed)),
    document
      ? infra(BATCH_JOB_STORE, ['MongoDB.Bson', 'MongoDB.Driver', namespaceOf(model, 'persistence')], mongoStoreBody(keyed))
      : infra(
          BATCH_JOB_STORE,
          ['System.Data.Common', 'System.Globalization', 'System.Text.RegularExpressions', 'Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Storage', namespaceOf(model, 'persistence')],
          sqlStoreBody(model)
        ),
    ...(document ? [] : [rowsFile(model)]),
    infra(BATCH_SETTINGS, ['System.Globalization', namespaceOf(model, 'config')], settingsBody(keyed)),
    rest('BatchJobSteps', stepsUsings(model), stepsBody(model)),
    ...(usesAsyncBatchJobs(model)
      ? [
          rest('BatchJobs', jobsUsings(model), jobsBody(model)),
          ...asyncOperations(model).map((operation) => rest(batchJobClass(operation), handlerUsings(model, operation), handlerBody(model, operation)))
        ]
      : []),
    ...(keyed ? [rest('KeyedBatches', keyedUsings(model), keyedBody(model))] : []),
    rest('BatchJobRegistration', ['Microsoft.Extensions.DependencyInjection', namespaceOf(model, 'timer')], registrationBody(model)),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/batch.yaml`, content: batchYaml(model, profile) }))
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
 * Lo que Program.cs añade con lotes con trabajo, tras el cronómetro: su configuración (la lee la purga, que es
 * Infrastructure) y lo que es de la API: los handlers de los trabajos asíncronos y los lotes síncronos con clave.
 */
export function programBatchJobs(model) {
  if (!usesBatchJobs(model)) return { usings: [], registration: '' };
  const what = [
    ...(usesAsyncBatchJobs(model) ? ['un handler del cronómetro por operación asíncrona'] : []),
    ...(usesKeyedBatches(model) ? ['los lotes síncronos con clave'] : [])
  ].join(' y ');
  return {
    usings: [batchInfraNamespace(model), namespaceOf(model, 'rest')],
    registration: `
// Los lotes con trabajo (DSL 2.30): su mecánica (batch.yaml), y ${what}.
builder.Services.AddSingleton(BatchSettings.From(configuration));
builder.Services.AddBatchJobs();`
  };
}

/** La purga de `batch_job` como recurrente del cronómetro (la emite timer.js con su nombre de clase y su kind). */
export function batchPurgeTimerBody(className, kindConstant) {
  return `/// <summary>
/// La purga de los trabajos terminados de los lotes (DSL 2.30, D10 y D15: los asíncronos y los síncronos con clave): los que acabaron hace más de
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
 * config/parameters/<perfil>/batch.yaml: la mecánica de los lotes con trabajo (keel-core/gen/batch-store.js, la misma clave
 * y variable en los cuatro generadores). Es, línea a línea, el `batch.yaml` de keel-spring y keel-nest: el chunk solo con
 * lotes asíncronos; el umbral del lote muerto, solo con lotes síncronos con clave (D15).
 */
export function batchYaml(model, profile) {
  const asynchronous = asyncBatchOperations(model).length > 0;
  const keyed = usesKeyedBatches(model);
  const lines = asynchronous
    ? [
        '# Los lotes asíncronos (DSL 2.30): cuántos elementos procesa cada disparo y cuánto vive un trabajo terminado.',
        '# El chunk tiene que caber en el arriendo del cronómetro (timer.lease-ms): uno más lento lo tomaría otra réplica.'
      ]
    : ['# Los lotes con clave (DSL 2.30): cuánto vive un trabajo terminado.'];
  if (keyed) {
    lines.push('# Un lote síncrono con clave sin terminar que nadie escribe desde hace más de sync-stale-ms se da por muerto, y su repetición lo sigue desde el cursor.');
  }
  lines.push('batch:');
  const parameters = [
    ...Object.entries(BATCH_PARAMETERS).filter(([name]) => asynchronous || name !== 'chunkSize').map(([, parameter]) => parameter),
    ...(keyed ? [BATCH_SYNC_STALE] : [])
  ];
  let parent = null;
  for (const parameter of parameters) {
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

function settingsBody(keyed) {
  const P = BATCH_PARAMETERS;
  const S = BATCH_SYNC_STALE;
  return `/// <summary>
/// La mecánica de los lotes con trabajo (DSL 2.30) del perfil activo: la de keel-core (<c>BATCH_PARAMETERS</c>${keyed ? ' y <c>BATCH_SYNC_STALE</c>' : ''}), con las
/// mismas claves y defaults en los cuatro generadores. Un valor que no es un entero positivo no deja arrancar.
/// </summary>
/// <param name="ChunkSize">Cuántos elementos procesa cada disparo del temporizador de un trabajo (D9). Por debajo del arriendo del cronómetro.</param>
/// <param name="RetentionDays">Cuántos días vive un trabajo TERMINADO con sus resultados (D10).</param>
/// <param name="PurgeCron">El cron (seis campos, en UTC) de su purga.</param>${
    keyed
      ? `
/// <param name="SyncStaleMs">Cuántos milisegundos sin escribirse hacen falta para dar por muerto un lote síncrono con clave sin terminar (D15).</param>`
      : ''
  }
public sealed record ${BATCH_SETTINGS}(int ChunkSize, int RetentionDays, string PurgeCron${keyed ? ', int SyncStaleMs' : ''})
{
    /// <summary>Los defaults de keel-core, para quien no lee la configuración (las pruebas).</summary>
    public static ${BATCH_SETTINGS} Defaults { get; } = new(${P.chunkSize.default}, ${P.retentionDays.default}, ${csString(P.purgeCron.default)}${keyed ? `, ${S.default}` : ''});

    public static ${BATCH_SETTINGS} From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new ${BATCH_SETTINGS}(
            Positive(configuration, ${csString(configKey(P.chunkSize.key))}, ${P.chunkSize.default}),
            Positive(configuration, ${csString(configKey(P.retentionDays.key))}, ${P.retentionDays.default}),
            Text(configuration, ${csString(configKey(P.purgeCron.key))}, ${csString(P.purgeCron.default)})${
              keyed ? `,\n            Positive(configuration, ${csString(configKey(S.key))}, ${S.default})` : ''
            });
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

function portBody(keyed) {
  const keyedMethods = keyed
    ? `

    /// <summary>
    /// Toma un lote síncrono con clave sin terminar que nadie escribe desde hace más de <paramref name="staleMs"/> (D15), con la
    /// hora de la base. false: sigue en marcha.
    /// </summary>
    Task<bool> TakeOver(Guid id, long staleMs, CancellationToken cancellationToken = default);

    /// <summary>Borra el trabajo de un todo o nada con clave que no se confirmó (D15): libera la clave. Nunca uno terminado.</summary>
    Task<bool> Discard(Guid id, CancellationToken cancellationToken = default);`
    : '';
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
    Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default);${keyedMethods}
}`;
}

const SQL_NAMES = ['insertJob', 'byKey', 'releaseKey', 'job', 'ownedJob', 'insertResult', 'advance', 'finish', 'resultsPage', 'resultsCount', 'purgeResults', 'purgeJobs'];

/** Las sentencias de keel-core para el motor del modelo, con su constante C#: las del lote síncrono con clave, solo si lo hay. */
export function relationalBatchStatements(model) {
  const engine = isMySql(model) ? 'mysql' : 'postgresql';
  const S = { ...batchStatements(engine), ...(usesKeyedBatches(model) ? batchSyncStatements(engine) : {}) };
  const names = [...SQL_NAMES, ...(usesKeyedBatches(model) ? ['takeOver', 'discardJob'] : [])];
  return names.map((name) => ({ name, constant: `${csMember(name)}Sql`, sql: S[name] }));
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
            cancellationToken);${
              usesKeyedBatches(model)
                ? `

    public async Task<bool> TakeOver(Guid id, long staleMs, CancellationToken cancellationToken = default) =>
        await Write(TakeOverSql, new() { ["id"] = id, ["staleMs"] = staleMs }, cancellationToken) == 1;

    public async Task<bool> Discard(Guid id, CancellationToken cancellationToken = default) =>
        await Write(DiscardJobSql, new() { ["id"] = id }, cancellationToken) == 1;`
                : ''
            }

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

function mongoStoreBody(keyed) {
  const { job, result } = BATCH_JOB_COLLECTIONS;
  const keyedMethods = keyed
    ? `

    public async Task<bool> TakeOver(Guid id, long staleMs, CancellationToken cancellationToken = default)
    {
        var now = (await DbNow(cancellationToken)).UtcDateTime;
        var filter = new BsonDocument
        {
            { "_id", id.ToString("D") },
            { "finished_at", BsonNull.Value },
            { "updated_at", new BsonDocument("$lte", new BsonDateTime(now.AddMilliseconds(-staleMs))) }
        };
        var update = new BsonDocument("$set", new BsonDocument("updated_at", new BsonDateTime(now)));
        var updated = transactions.Session is { } session
            ? await JobCollection.UpdateOneAsync(session, filter, update, cancellationToken: cancellationToken)
            : await JobCollection.UpdateOneAsync(filter, update, cancellationToken: cancellationToken);
        return updated.ModifiedCount == 1;
    }

    public async Task<bool> Discard(Guid id, CancellationToken cancellationToken = default)
    {
        var filter = new BsonDocument { { "_id", id.ToString("D") }, { "finished_at", BsonNull.Value } };
        var deleted = transactions.Session is { } session
            ? await JobCollection.DeleteOneAsync(session, filter, cancellationToken: cancellationToken)
            : await JobCollection.DeleteOneAsync(filter, cancellationToken: cancellationToken);
        return deleted.DeletedCount == 1;
    }`
    : '';
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
    }${keyedMethods}

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

function stepsUsings(model) {
  return [
    'System.Security.Cryptography',
    'System.Text.Json',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.DependencyInjection',
    namespaceOf(model, 'errors'),
    namespaceOf(model, 'useCaseInfra'),
    // WireJson: el texto del result de cada elemento, con las reglas del cable.
    namespaceOf(model, 'appSupport'),
    batchInfraNamespace(model)
  ];
}

/** Las operaciones que guardan su clave en el trabajo: las asíncronas y las síncronas con clave, enteras. */
const storedOperations = (model) => {
  const names = new Set(batchJobStoreOperations(model).map(({ operation }) => operation));
  return (model.services ?? []).flatMap((service) => service.operations ?? []).filter((operation) => names.has(operation.name));
};

function stepsBody(model) {
  const canonical = FRAMEWORK_ERRORS.idempotencyReuse;
  const { completed, aborted } = BATCH_JOB_STATUSES;
  const succeeded = 'succeeded';
  const codes = storedOperations(model).map((operation) => `        [${csString(operation.name)}] = ${csString(idempotencyOutcomeCode(model, operation.name, canonical))},`);
  const jobId = usesAsyncBatchJobs(model)
    ? `

    /// <summary>El id del trabajo de la ruta: un uuid que no se lee es una petición malformada.</summary>
    public static Guid JobId(HttpRequest request) =>
        TextValues.Uuid(TextValues.Route(request, ${csString(BATCH_JOB_PARAM)})) ?? throw new MalformedRequestException();`
    : '';
  return `// Lo que comparten el procesador de los lotes asíncronos y los lotes síncronos con clave (DSL 2.30, D9 y D15): los bytes
// del cuerpo y su firma, la clave reutilizada, el paso de UN elemento y la respuesta rehecha desde lo guardado.
//
// No lo edites: lo regenera build.

/// <summary>
/// La misma clave de idempotencia de un lote con un contenido DISTINTO (D13, D15): no es un reintento, y devolver el trabajo
/// de la primera petición contestaría a una pregunta que el cliente no hizo.
/// </summary>
public sealed class BatchJobKeyReusedException(string operation, string key)
    : ConflictException($"La clave de idempotencia {operation}/{key} ya se usó con un contenido distinto", code: BatchJobRequests.KeyReusedCode(operation), httpStatus: ${canonical.http}, args: [operation, key]);

/// <summary>Lo que se lee de la petición de un lote con trabajo: los bytes del cuerpo, su firma y la cabecera de la clave.</summary>
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
    }${jobId}
}

/// <summary>
/// El cursor ya no estaba donde lo dejó quien procesa: otra réplica, o la repetición de la petición, se llevó el trabajo.
/// Revierte el elemento entero.
/// </summary>
public sealed class FenceLostException() : Exception("El trabajo lo procesa otro");

/// <summary>Lo que deja un elemento: seguir, parar (el lote se detuvo, D4) o perder el trabajo (la valla).</summary>
public enum BatchStep
{
    Next,
    Stop,
    Lost
}

/// <summary>
/// UN elemento de un lote con trabajo y la respuesta rehecha desde lo guardado (DSL 2.30, D9 y D15): lo usan el procesador de
/// los trabajos asíncronos y los lotes síncronos con clave.
/// </summary>
/// <remarks>
/// <para>
/// Cada elemento va en su ÁMBITO (su contexto, su transacción) y en UNA transacción con tres cosas: su efecto (el despacho por
/// el mediator, que se une a ella), el avance del cursor y su resultado. El avance es la VALLA: solo avanza si el cursor sigue
/// donde lo dejó quien procesa, y si no —otra réplica, o la repetición de la petición, se llevó el trabajo— el elemento
/// revierte entero, efecto incluido. Si quien procesa cae a mitad, lo confirmado queda y quien sigue lo hace desde el cursor:
/// ningún elemento se aplica dos veces ni se queda sin resultado.
/// </para>
/// <para>
/// Fallan solo su elemento los codes de <c>itemErrors</c> y ${FRAMEWORK_ERRORS.validation.code}; cualquier otro fallo detiene el trabajo
/// (<c>${aborted}</c>, D4) con su code o ${FRAMEWORK_ERRORS.batchAborted.code}.
/// </para>
/// </remarks>
public sealed class BatchJobSteps(IServiceScopeFactory scopes, ${BATCH_JOB_STORE_PORT} store)
{
    /// <summary>
    /// Un elemento. <paramref name="message"/> construye el mensaje de UN elemento; <paramref name="process"/> lo despacha en
    /// los servicios de su ámbito y devuelve su result (null si la operación no declara batch.output).
    /// </summary>
    public async Task<BatchStep> Process<TItem, TMessage>(
        Guid jobId,
        int index,
        JsonElement element,
        Func<JsonElement?, TItem?> readItem,
        Func<TItem, TMessage> message,
        IReadOnlyCollection<string> itemErrors,
        Func<IServiceProvider, TMessage, CancellationToken, Task<object?>> process,
        CancellationToken cancellationToken)
        where TItem : class
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(process);
        TItem item;
        try
        {
            item = BatchRunner.ReadItem(element, readItem) ?? throw BatchRunner.Invalid;
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
                        var result = await process(services, message(item), cancellationToken);
                        await Keep(services.GetRequiredService<${BATCH_JOB_STORE_PORT}>(), jobId, BatchItem.Succeeded(index, result), cancellationToken);
                        return true;
                    },
                    readOnly: false,
                    cancellationToken);
                return BatchStep.Next;
            }
            catch (FenceLostException)
            {
                return BatchStep.Lost;
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
    private async Task<BatchStep> Failed(Guid jobId, BatchItem item, bool stops, CancellationToken cancellationToken)
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
            return BatchStep.Lost;
        }
        return stops ? BatchStep.Stop : BatchStep.Next;
    }

    /// <summary>
    /// La valla y el resultado de un elemento, en la transacción en curso: primero el avance del cursor, que toma la fila del
    /// trabajo, y después el resultado. Si el cursor ya no estaba en su índice, lanza y la transacción revierte entera.
    /// </summary>
    internal static async Task Keep(${BATCH_JOB_STORE_PORT} own, Guid jobId, BatchItem item, CancellationToken cancellationToken)
    {
        var ok = item.Status == ${csString(succeeded)};
        if (!await own.Advance(jobId, item.Index, ok ? 1 : 0, ok ? 0 : 1, cancellationToken))
        {
            throw new FenceLostException();
        }
        var result = item.Result is null ? null : JsonSerializer.Serialize(item.Result, WireJson.Options);
        await own.InsertResult(jobId, item.Index, item.Status, item.Error, item.Message, result, cancellationToken);
    }

    /// <summary>
    /// La respuesta de un lote con clave rehecha desde lo guardado (D15, batchStoredBody de keel-core): los resultados en orden
    /// de índice y, si se detuvo, un <c>notAttempted</c> por cada elemento desde el cursor.
    /// </summary>
    public async Task<BatchResponse> Stored(Guid jobId, CancellationToken cancellationToken)
    {
        var job = await store.Job(jobId, cancellationToken) ?? throw new InvalidOperationException($"No hay ningún trabajo {jobId}");
        var items = (await store.Results(jobId, job.Total, 0, cancellationToken)).Select(Item).ToList();
        if (job.Status == ${csString(aborted)})
        {
            for (var index = job.NextIndex; index < job.Total; index++)
            {
                items.Add(BatchItem.NotAttempted(index));
            }
        }
        return BatchResponse.Of(items);
    }

    /// <summary>Un resultado guardado, como viaja en el cable.</summary>
    public static BatchItem Item(BatchJobResult row)
    {
        ArgumentNullException.ThrowIfNull(row);
        return row.Status == ${csString(succeeded)}
            ? BatchItem.Succeeded(row.Index, row.Result is null ? null : JsonDocument.Parse(row.Result).RootElement.Clone())
            : BatchItem.Failed(row.Index, row.ErrorCode ?? "", row.Message);
    }
}

/// <summary>El estado de un trabajo que se da por cerrado (lo usan quienes lo procesan).</summary>
internal static class BatchJobStatuses
{
    public const string Completed = ${csString(completed)};

    public const string Aborted = ${csString(aborted)};
}`;
}

function jobsUsings(model) {
  const usings = [
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
    batchInfraNamespace(model),
    ...typeUsings(model, ['PagedResponse'])
  ];
  if (model.layersPresent?.security) usings.push(namespaceOf(model, 'security'));
  return usings;
}

function jobsBody(model) {
  const notFound = FRAMEWORK_ERRORS.batchJobNotFound;
  const { completed, aborted } = BATCH_JOB_STATUSES;
  const security = Boolean(model.layersPresent?.security);
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
        var items = rows.Select(BatchJobSteps.Item).ToList();
        var page = Page<BatchItem>.Of(items, pageable, await store.ResultsCount(job.Id, cancellationToken));
        return new PagedResponse<BatchItem> { Items = page.Items, Page = page.Number, Size = page.Size, TotalElements = page.TotalElements, TotalPages = page.TotalPages };
    }

    private async Task<BatchJob> Owned(string operation, Guid jobId, CancellationToken cancellationToken) =>
        await store.Owned(jobId, operation, AuditActor.Current(), cancellationToken) ?? throw new BatchJobNotFoundException(jobId);
}

/// <summary>
/// Un disparo del temporizador de un trabajo (DSL 2.30, D9): procesa un CHUNK desde el cursor y dice si queda trabajo
/// (rearmar para ya) o si terminó (borrar el temporizador). Es el <i>commit interval</i> y el <i>restart</i> de Spring Batch
/// sobre el cronómetro, sin la librería.
/// </summary>
/// <remarks>
/// Cada elemento lo procesa <see cref="BatchJobSteps"/>: en su ámbito, con su efecto, el avance del cursor (la valla) y su
/// resultado en UNA transacción. Si la réplica cae a mitad de chunk, el siguiente disparo sigue desde el cursor. Corre sin
/// token: el actor de autoría de cada elemento es el dueño del trabajo.
/// </remarks>
public sealed class BatchJobRunner(IServiceScopeFactory scopes, ${BATCH_JOB_STORE_PORT} store, ITimerStore timers, ${BATCH_SETTINGS} settings)
{
    /// <summary>Los pasos de cada elemento, sobre el almacén y los ámbitos de este disparo.</summary>
    private BatchJobSteps Steps => new(scopes, store);

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
        var steps = Steps;
        using var owner = AsOwner(job.Owner);
        var index = job.NextIndex;
        var end = Math.Min(job.Total, index + settings.ChunkSize);
        for (; index < end; index++)
        {
            // Parar (el lote se detuvo) o perder la valla (el trabajo es de otra réplica) acaban el disparo.
            if (await steps.Process(job.Id, index, envelope.Items[index], readItem, envelope.Message, itemErrors, process, cancellationToken) != BatchStep.Next)
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

// ─── El lote síncrono con clave (D15) ────────────────────────────────────────────────────────────

function keyedUsings(model) {
  const usings = [
    'System.Text',
    'System.Text.Json',
    'Microsoft.Extensions.DependencyInjection',
    namespaceOf(model, 'errors'),
    namespaceOf(model, 'useCaseInfra'),
    namespaceOf(model, 'appSupport'),
    batchInfraNamespace(model)
  ];
  if (model.layersPresent?.security) usings.push(namespaceOf(model, 'persistence'));
  return usings;
}

function keyedBody(model) {
  const secured = Boolean(model.layersPresent?.security);
  const canonical = FRAMEWORK_ERRORS.idempotencyRace;
  const operations = keyedOperations(model);
  const codes = operations.map((operation) => `        [${csString(operation.name)}] = ${csString(idempotencyOutcomeCode(model, operation.name, canonical))},`);
  const perItem = operations.some((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.some((operation) => operation.batch.atomicity === 'all-or-nothing');
  const translate = 'error => ApiErrorMiddleware.Translate(services, error)';
  const perItemMethod = `

    /// <summary>
    /// Un lote <c>per-item</c> con clave: como <c>BatchRunner.PerItem</c>, con cada elemento confirmado junto a su
    /// resultado y el avance del cursor, y la respuesta rehecha de lo guardado. Sin clave, el lote de siempre.
    /// </summary>
    public async Task<BatchResponse> PerItem<TItem, TMessage>(
        string operation,
        byte[] body,
        string keySource,
        string? clientKey,
        int? ttlSeconds,
        BatchEnvelope<TItem, TMessage> envelope,
        Func<JsonElement?, TItem?> readItem,
        IReadOnlyCollection<string> itemErrors,
        Func<IServiceProvider, TMessage, CancellationToken, Task<object?>> process,
        CancellationToken cancellationToken)
        where TItem : class
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(process);
        var signature = BatchJobRequests.Signature(body);
        var key = KeyOf(keySource, clientKey, signature);
        if (key is null)
        {
            // Sin la cabecera de la clave: el lote de siempre, sin trabajo.
            return await BatchRunner.PerItem(envelope.Items, readItem, itemErrors, item => process(services, envelope.Message(item), cancellationToken), ${translate}, cancellationToken);
        }
        var started = await Start(operation, key, signature, ttlSeconds, body, envelope.Items.Count, cancellationToken);
        var steps = Steps;
        if (started.Replay)
        {
            // La repetición de un lote terminado: lo guardado, sin procesar nada.
            return await steps.Stored(started.Id, cancellationToken);
        }
        for (var index = started.From; index < envelope.Items.Count; index++)
        {
            var step = await steps.Process(started.Id, index, envelope.Items[index], readItem, envelope.Message, itemErrors, process, cancellationToken);
            if (step == BatchStep.Lost)
            {
                // Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
                throw new BatchKeyInProgressException(operation, key);
            }
            if (step == BatchStep.Stop)
            {
                return await steps.Stored(started.Id, cancellationToken);
            }
        }
        await transactions.Run(() => store.Finish(started.Id, BatchJobStatuses.Completed, cancellationToken), readOnly: false, cancellationToken);
        return await steps.Stored(started.Id, cancellationToken);
    }`;
  const atomicMethod = `

    /// <summary>
    /// Un lote <c>all-or-nothing</c> con clave: como <c>BatchRunner.AllOrNothing</c>, con los resultados, el cursor y el
    /// final del trabajo en la transacción del lote. Si falla no queda nada confirmado, y su trabajo se descarta en otra: la
    /// repetición lo vuelve a procesar en vez de devolver un lote que nunca se confirmó.
    /// </summary>
    public async Task<AtomicOutcome> AllOrNothing<TItem, TMessage>(
        string operation,
        string over,
        byte[] body,
        string keySource,
        string? clientKey,
        int? ttlSeconds,
        BatchEnvelope<TItem, TMessage> envelope,
        Func<JsonElement?, TItem?> readItem,
        Func<TItem, Task<object?>> process,
        CancellationToken cancellationToken)
        where TItem : class
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(envelope);
        var signature = BatchJobRequests.Signature(body);
        var key = KeyOf(keySource, clientKey, signature);
        if (key is null)
        {
            // Sin la cabecera de la clave: el lote de siempre, sin trabajo.
            return await BatchRunner.AllOrNothing(over, envelope.Items, readItem, transactions, process, ${translate}, sink: null, cancellationToken);
        }
        var started = await Start(operation, key, signature, ttlSeconds, body, envelope.Items.Count, cancellationToken);
        if (started.Replay)
        {
            // La repetición de un todo o nada confirmado: la respuesta guardada, sin procesar nada.
            return new AtomicOutcome(await Steps.Stored(started.Id, cancellationToken), null);
        }
        var id = started.Id;
        AtomicOutcome outcome;
        try
        {
            outcome = await BatchRunner.AllOrNothing(over, envelope.Items, readItem, transactions, process, ${translate}, new JobSink(store, id), cancellationToken);
        }
        catch (FenceLostException)
        {
            // Otra petición con la misma clave tomó el trabajo (D15): lo termina ella.
            throw new BatchKeyInProgressException(operation, key);
        }
        catch
        {
            // Un fallo al confirmar no es de ningún elemento, y el lote tampoco quedó confirmado: su trabajo se descarta igual.
            await Discard(id);
            throw;
        }
        if (outcome.Error is not null)
        {
            await Discard(id);
            return outcome;
        }
        return new AtomicOutcome(await Steps.Stored(id, cancellationToken), null);
    }

    /// <summary>El trabajo de un todo o nada que no se confirmó, fuera, en su transacción: libera la clave. Sin cancelación: la petición puede estar cancelada.</summary>
    private async Task Discard(Guid id)
    {
        await transactions.Run(() => store.Discard(id, CancellationToken.None), readOnly: false, CancellationToken.None);
    }

    /// <summary>Lo que guarda el todo o nada con clave DENTRO de la transacción del lote: el resultado y el cursor de cada elemento, y el final.</summary>
    private sealed class JobSink(${BATCH_JOB_STORE_PORT} store, Guid id) : IAtomicSink
    {
        public Task Kept(BatchItem item, CancellationToken cancellationToken) => BatchJobSteps.Keep(store, id, item, cancellationToken);

        public async Task Completed(CancellationToken cancellationToken) => await store.Finish(id, BatchJobStatuses.Completed, cancellationToken);
    }`;
  return `// Los lotes SÍNCRONOS con clave de idempotencia (DSL 2.30, D15; wire-contract.md § Lotes).
//
// No lo edites: lo regenera build.

/// <summary>
/// La repetición de un lote síncrono con clave mientras el primero sigue en marcha (DSL 2.30, D15): todavía no hay respuesta
/// que devolver, y procesarlo a la vez lo repartiría entre dos peticiones. Es la semántica de una operación sola con clave.
/// El code es el que declara cada operación para este desenlace, o el canónico (docs/framework-errors.md).
/// </summary>
public sealed class BatchKeyInProgressException(string operation, string key)
    : ConflictException($"Otra petición con la clave de idempotencia {operation}/{key} está procesando el lote", code: CodeOf(operation), httpStatus: ${canonical.http}, args: [operation, key])
{
    private static readonly Dictionary<string, string> Codes = new(StringComparer.Ordinal)
    {
${codes.join('\n')}
    };

    /// <summary>El code de la clave en curso de cada operación: el que declara el diseño para ese desenlace, o el canónico.</summary>
    public static string CodeOf(string operation) => Codes.TryGetValue(operation, out var code) ? code : ${csString(canonical.code)};
}

/// <summary>
/// Los lotes SÍNCRONOS con clave de idempotencia (DSL 2.30, D15): la clave la guarda el TRABAJO (<c>${BATCH_JOB.table}</c>), como en
/// un lote asíncrono, sin temporizador. La petición crea su trabajo en una transacción propia y procesa cada elemento con
/// <see cref="BatchJobSteps"/>; la respuesta se rehace siempre de lo guardado, así que es la misma para la primera petición,
/// la repetición y la que reanuda.
/// </summary>
/// <remarks>
/// La repetición: con la misma firma y el trabajo terminado, la respuesta guardada sin procesar nada; con otra firma, el error
/// de la clave reutilizada; sin terminar y escrito hace menos de <c>${BATCH_SYNC_STALE.key}</c>, el error de la clave en curso
/// (409); sin terminar y más viejo, quien lo procesaba murió: lo toma y sigue desde el cursor.
/// </remarks>
public sealed class KeyedBatches(
    IServiceProvider services,
    IServiceScopeFactory scopes,
    ${BATCH_JOB_STORE_PORT} store,
    IUseCaseTransactions transactions,
    ${BATCH_SETTINGS} settings)
{${
    secured
      ? ''
      : `
    /// <summary>El dueño de un lote sin capa security: no hay llamante, y la clave la acota solo la operación.</summary>
    private const string Owner = ${csString(BATCH_ANONYMOUS_OWNER)};
`
  }
    /// <summary>Los pasos de cada elemento, sobre el almacén y los ámbitos de la petición.</summary>
    private BatchJobSteps Steps => new(scopes, store);${perItem ? perItemMethod : ''}${atomic ? atomicMethod : ''}

    /// <summary>La clave del lote: la cabecera, o la firma del cuerpo si la clave es el contenido. null: sin clave.</summary>
    private static string? KeyOf(string keySource, string? clientKey, string signature) => keySource == "payload-hash" ? signature : clientKey;

    /// <summary>El trabajo de la petición: el de la clave, si lo hay, o uno nuevo, en una transacción propia.</summary>
    private async Task<Started> Start(string operation, string key, string signature, int? ttlSeconds, byte[] body, int total, CancellationToken cancellationToken)
    {
        var owner = ${secured ? 'AuditActor.Current()' : 'Owner'};
        long? ttlMs = ttlSeconds is null ? null : ttlSeconds.Value * 1000L;
        var input = Encoding.UTF8.GetString(body);
        try
        {
            return await transactions.Run(
                async () =>
                {
                    await store.ReleaseKey(operation, owner, key, cancellationToken);
                    if (await Repeat(operation, owner, key, signature, cancellationToken) is { } found)
                    {
                        return found;
                    }
                    var id = Guid.CreateVersion7();
                    await store.Insert(id, operation, owner, key, signature, ttlMs, input, total, cancellationToken);
                    return new Started(id, 0, false);
                },
                readOnly: false,
                cancellationToken);
        }
        catch (Exception error) when (error is not BatchJobKeyReusedException && error is not BatchKeyInProgressException && error is not OperationCanceledException)
        {
            // Dos peticiones con la misma clave a la vez: la que pierde choca con la unicidad del motor y encuentra el trabajo
            // de la ganadora, en marcha.
            var found = await transactions.Run(() => Repeat(operation, owner, key, signature, cancellationToken), readOnly: false, cancellationToken);
            if (found is null)
            {
                throw;
            }
            return found;
        }
    }

    /// <summary>El trabajo vivo de la clave (D15, batchSyncRepeat de keel-core).</summary>
    private async Task<Started?> Repeat(string operation, string owner, string key, string signature, CancellationToken cancellationToken)
    {
        var hit = await store.ByKey(operation, owner, key, cancellationToken);
        if (hit is null)
        {
            return null;
        }
        if (hit.Signature != signature)
        {
            throw new BatchJobKeyReusedException(operation, key);
        }
        var job = await store.Job(hit.Id, cancellationToken);
        if (job is null)
        {
            return null;
        }
        if (job.FinishedAt is not null)
        {
            return new Started(job.Id, job.Total, Replay: true);
        }
        if (!await store.TakeOver(job.Id, settings.SyncStaleMs, cancellationToken))
        {
            throw new BatchKeyInProgressException(operation, key);
        }
        return new Started(job.Id, job.NextIndex, Replay: false);
    }

    /// <summary>El trabajo de la petición: su id, desde qué elemento sigue y si ya terminó (la repetición responde lo guardado).</summary>
    private sealed record Started(Guid Id, int From, bool Replay);
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
  const lines = [];
  if (usesAsyncBatchJobs(model)) {
    lines.push(
      '        services.AddScoped<BatchJobs>();',
      '        services.AddScoped<BatchJobRunner>();',
      ...asyncOperations(model).map((operation) => `        services.AddScoped<ITimerHandler, ${batchJobClass(operation)}>();`)
    );
  }
  if (usesKeyedBatches(model)) lines.push('        services.AddScoped<KeyedBatches>();');
  return `/// <summary>
/// Los lotes con trabajo (DSL 2.30) en el contenedor: el alta y las rutas del trabajo, el procesador y un handler del cronómetro
/// por operación asíncrona, y los lotes síncronos con clave. Son de la API (leen el sobre con el lector del endpoint y traducen
/// el fallo con el middleware de errores), así que no los registra AddTimer sino esto, desde Program.cs. BatchSettings lo
/// registra Program.cs con el perfil.
/// </summary>
public static class BatchJobRegistration
{
    public static IServiceCollection AddBatchJobs(this IServiceCollection services)
    {
${lines.join('\n')}
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
