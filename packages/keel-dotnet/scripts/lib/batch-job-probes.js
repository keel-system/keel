// Los LOTES ASÍNCRONOS (DSL 2.30, fase B) contra lo emitido, para db-check y doc-check: BJ-1 a BJ-10 de
// keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check) y keel-nest (scripts/lib/batch-job-probes.js)
// sobre los MISMOS diseños (BATCH_JOB_DESIGNS de keel-core/test/helpers/batch-designs.js). El handler de la sonda es el de
// batch-probes.js (batchProbePatch), con su gancho `AfterEffect`.
//
// Un [Fact] por caso (`BatchJob_BJ4_…`), dentro de la clase de sondas de cada sujeto: comparte la base con el resto, así que
// NO vacía nada; cada caso usa sus propios sku (`J<letra><letra>-000n`) y sus propios trabajos. Los endpoints emitidos se
// llaman como los llama ASP.NET Core (un HttpContext con el cuerpo, la ruta y la query, los servicios de un ámbito y el
// ApiErrorMiddleware emitido delante), con el dueño puesto a mano en el SecurityContext (es lo que lee el actor de
// autoría); el temporizador de cada trabajo se dispara llamando a su handler, así que la sonda decide cuándo corre cada
// chunk. La caída de una réplica a mitad de chunk (BJ-4) es un almacén que lanza al escribir un resultado (registrado en el
// contenedor en el lugar del emitido, porque cada elemento resuelve el suyo en su ámbito); la réplica que le quita el
// trabajo (BJ-5) es el gancho del handler, que mueve el cursor FUERA de la transacción del elemento, tras el efecto.

import { BATCH_JOB_CASES, BATCH_JOB_SABOTAGES, BATCH_KEY_RACE_ROUNDS } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT, BATCH_SYNC_STALE, batchKind } from '@keel-system/keel-core/gen/batch-store';
import { KEEL_TIMER } from '@keel-system/keel-core/gen/timer-store';
import { csMember, csString, namespaceOf } from '../../src/scaffold/render.js';
import { endpointsClass } from '../../src/scaffold/endpoints.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { usesMySql } from '../../src/scaffold/relational-engine.js';
import { BATCH_JOB_STORE, BATCH_JOB_STORE_PORT, batchInfraNamespace, batchJobClass, jobEndpoint, jobResultsEndpoint, usesBatchJobs, usesKeyedBatches } from '../../src/scaffold/batch-jobs.js';
import { UNDECLARED_FAILURE_NAME, allBatchOperations } from './batch-probes.js';

const js = (value) => JSON.stringify(value);

/** El tamaño del chunk con el que corre la sonda: pequeño, para que un trabajo de cinco elementos dé tres disparos. */
export const PROBE_CHUNK_SIZE = 2;

/** Los sujetos por almacén: los de BATCH_JOB_DESIGNS. */
export const BATCH_JOB_SUBJECTS = { relational: ['catalog-batch-async'], document: ['catalog-batch-async-mongo'] };

/** La operación asíncrona del modelo, o undefined. */
export const asyncOperation = (model) => allBatchOperations(model).find((operation) => operation.batch.execution === 'async');

/** Los casos de un lote ASÍNCRONO que ejecuta este diseño: todos, si declara uno. */
export function batchJobCases(model) {
  return asyncOperation(model) ? BATCH_JOB_CASES.map((entry) => entry.id) : [];
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const JOBS = 'Rest/BatchJobs.cs';
const STEPS = 'Rest/BatchJobSteps.cs';
const SAME = (spec) => ({ relational: spec, document: spec });

// El alta que el motor mata por interbloqueo no se repite (solo cae en MySQL: en PostgreSQL la carrera llega por la unicidad).
// En keel-dotnet la repetición NO es del alta sino de PersistenceTransactions, la de todo caso de uso: el sabotaje la apaga
// ahí, y el veredicto solo mira los casos de los lotes.
const NO_RACE_RETRY = SAME([
  'Persistence/PersistenceTransactions.cs',
  'catch (Exception error) when (!readOnly && attempt < WriteConflictAttempts && PersistenceErrors.IsTransientWriteConflict(error))',
  'catch (Exception error) when (!readOnly && attempt < 1 && PersistenceErrors.IsTransientWriteConflict(error))'
]);

/** Lo que se busca y se sustituye en lo emitido, por sabotaje y por almacén: [sufijo del archivo, texto, sustituto]. */
export const BATCH_JOB_SABOTAGE_SPECS = {
  // Cada disparo empieza en el principio de su chunk y no en el cursor: tras una caída a mitad de chunk reprocesa lo ya
  // confirmado.
  'bj-no-resume': SAME([JOBS, 'var index = job.NextIndex;', 'var index = job.NextIndex - (job.NextIndex % settings.ChunkSize);']),
  // El efecto en su transacción, y el cursor con el resultado en otra, después (en el paso que comparte con el lote
  // síncrono con clave, BatchJobSteps).
  'bj-cursor-outside-tx': SAME([
    STEPS,
    `                await services.GetRequiredService<IUseCaseTransactions>().Run(
                    async () =>
                    {
                        var result = await process(services, message(item), cancellationToken);
                        await Keep(services.GetRequiredService<${BATCH_JOB_STORE_PORT}>(), jobId, BatchItem.Succeeded(index, result), cancellationToken);
                        return true;
                    },
                    readOnly: false,
                    cancellationToken);`,
    `                var result = await services.GetRequiredService<IUseCaseTransactions>().Run(() => process(services, message(item), cancellationToken), readOnly: false, cancellationToken);
                await services.GetRequiredService<IUseCaseTransactions>().Run(
                    async () =>
                    {
                        await Keep(services.GetRequiredService<${BATCH_JOB_STORE_PORT}>(), jobId, BatchItem.Succeeded(index, result), cancellationToken);
                        return true;
                    },
                    readOnly: false,
                    cancellationToken);`
  ]),
  // Las rutas del trabajo no miran el dueño.
  'bj-foreign-reader': SAME([
    JOBS,
    'await store.Owned(jobId, operation, AuditActor.Current(), cancellationToken) ?? throw',
    '(await store.Job(jobId, cancellationToken) is { } found && found.Operation == operation ? found : null) ?? throw'
  ]),
  'bj-no-race-retry': NO_RACE_RETRY
};

export const isBatchJobSabotage = (id) => Boolean(id && BATCH_JOB_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje en UN sujeto: sus casos BJ, y solo esos. */
export function batchJobSabotageVerdict(failures, id) {
  const want = [...BATCH_JOB_SABOTAGES[id]].sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/BatchJob_BJ(\d+)_/g)].map((match) => `BJ-${match[1]}`)))].sort();
  return { exact: failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El contenedor ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el contenedor de la sonda registra con un almacén de trabajos, DESPUÉS de la persistencia: con un lote asíncrono, el
 * alta (BatchJobs, que el endpoint pide al contenedor); y siempre, el almacén que sabe caer (BJ-4, y BK-3 y BK-4 con un lote
 * síncrono con clave) en el lugar del emitido. No registra el handler del trabajo: lo construye cada caso, y así el sondeador
 * de otras sondas no toca sus temporizadores.
 */
export function batchJobFixtureRegistration(model) {
  if (!usesBatchJobs(model)) return '';
  return `
        // Los lotes con trabajo (DSL 2.30): ${asyncOperation(model) ? 'el alta, y ' : ''}el almacén de los trabajos envuelto en el que cae a voluntad.${asyncOperation(model) ? `
        services.AddScoped<BatchJobs>();` : ''}
        services.Replace(ServiceDescriptor.Scoped<${BATCH_JOB_STORE_PORT}>(provider => new CrashingBatchJobStore(ActivatorUtilities.CreateInstance<${BATCH_JOB_STORE}>(provider))));`;
}

/** Los using que añaden las sondas de los lotes asíncronos. */
export function batchJobProbeUsings(model) {
  if (!asyncOperation(model)) return [];
  return [
    'System.Text',
    'System.Text.Json',
    'System.Text.Json.Nodes',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.DependencyInjection.Extensions',
    'Microsoft.Extensions.Logging',
    ...(usesDocumentModel(model) ? ['MongoDB.Bson', 'MongoDB.Driver'] : ['Microsoft.EntityFrameworkCore']),
    namespaceOf(model, 'rest'),
    namespaceOf(model, 'endpoints'),
    namespaceOf(model, 'useCases'),
    namespaceOf(model, 'timer'),
    namespaceOf(model, 'security'),
    namespaceOf(model, 'persistence'),
    batchInfraNamespace(model)
  ];
}

const usesDocumentModel = (model) => model.persistenceKind === 'document';

/** El almacén que cae al escribir el resultado de un elemento (BJ-4, BK-3, BK-4): delega todo lo demás en el emitido. */
export function batchJobProbeClasses(model) {
  if (!usesBatchJobs(model)) return null;
  const keyed = usesKeyedBatches(model)
    ? `

    public Task<bool> TakeOver(Guid id, long staleMs, CancellationToken cancellationToken = default) => inner.TakeOver(id, staleMs, cancellationToken);

    public Task<bool> Discard(Guid id, CancellationToken cancellationToken = default) => inner.Discard(id, cancellationToken);`
    : '';
  return `/// <summary>El almacén de una réplica, o de una petición, que cae al escribir el resultado del elemento <see cref="CrashAt"/> (BJ-4, BK-3, BK-4).</summary>
public sealed class CrashingBatchJobStore(${BATCH_JOB_STORE_PORT} inner) : ${BATCH_JOB_STORE_PORT}
{
    /// <summary>El índice en el que cae; null: no cae.</summary>
    public static int? CrashAt { get; set; }

    public Task<BatchJobKeyHit?> ByKey(string operation, string owner, string key, CancellationToken cancellationToken = default) => inner.ByKey(operation, owner, key, cancellationToken);

    public Task ReleaseKey(string operation, string owner, string key, CancellationToken cancellationToken = default) => inner.ReleaseKey(operation, owner, key, cancellationToken);

    public Task Insert(Guid id, string operation, string owner, string? key, string? signature, long? ttlMs, string input, int total, CancellationToken cancellationToken = default) =>
        inner.Insert(id, operation, owner, key, signature, ttlMs, input, total, cancellationToken);

    public Task<BatchJob?> Job(Guid id, CancellationToken cancellationToken = default) => inner.Job(id, cancellationToken);

    public Task<BatchJob?> Owned(Guid id, string operation, string owner, CancellationToken cancellationToken = default) => inner.Owned(id, operation, owner, cancellationToken);

    public Task<bool> Advance(Guid id, int index, int succeeded, int failed, CancellationToken cancellationToken = default) => inner.Advance(id, index, succeeded, failed, cancellationToken);

    public Task InsertResult(Guid jobId, int index, string status, string? errorCode, string? message, string? result, CancellationToken cancellationToken = default) =>
        CrashAt == index ? throw new InvalidOperationException("sonda: la réplica cae") : inner.InsertResult(jobId, index, status, errorCode, message, result, cancellationToken);

    public Task<bool> Finish(Guid id, string status, CancellationToken cancellationToken = default) => inner.Finish(id, status, cancellationToken);

    public Task<IReadOnlyList<BatchJobResult>> Results(Guid jobId, int limit, long offset, CancellationToken cancellationToken = default) => inner.Results(jobId, limit, offset, cancellationToken);

    public Task<long> ResultsCount(Guid jobId, CancellationToken cancellationToken = default) => inner.ResultsCount(jobId, cancellationToken);

    public Task<int> Purge(int retentionDays, CancellationToken cancellationToken = default) => inner.Purge(retentionDays, cancellationToken);${keyed}
}`;
}

// ─── Lo que la sonda lee y retoca de las tablas ──────────────────────────────────────────────────────────────────

function storage(model) {
  const kind = csString(batchKind(asyncOperation(model).name));
  if (usesDocumentModel(model)) {
    const jobs = `root.GetRequiredService<DocumentDatabase>().Collection(${csString(BATCH_JOB.table)})`;
    const results = `root.GetRequiredService<DocumentDatabase>().Collection(${csString(BATCH_ITEM_RESULT.table)})`;
    const timers = `root.GetRequiredService<DocumentDatabase>().Collection(${csString(KEEL_TIMER.table)})`;
    const byId = (id) => `new BsonDocument("_id", ${id}.ToString("D"))`;
    return `    private static Task<long> JobCount() => ${jobs}.CountDocumentsAsync(new BsonDocument(), cancellationToken: Cancel);

    private static Task<long> JobCountOf(string key) => ${jobs}.CountDocumentsAsync(new BsonDocument("idempotency_key", key), cancellationToken: Cancel);

    private static Task<long> JobArmed(Guid id) => ${timers}.CountDocumentsAsync(new BsonDocument { { "kind", ${kind} }, { "entity_id", id.ToString("D") } }, cancellationToken: Cancel);

    private static async Task<int> JobCursor(Guid id) => (await ${jobs}.Find(${byId('id')}).FirstAsync(Cancel))["next_index"].ToInt32();

    private static Task<long> JobResultCount(Guid id) => ${results}.CountDocumentsAsync(new BsonDocument("job_id", id.ToString("D")), cancellationToken: Cancel);

    private static async Task<bool> JobExists(Guid id) => await ${jobs}.CountDocumentsAsync(${byId('id')}, cancellationToken: Cancel) == 1;

    /// <summary>Otra réplica se lleva el elemento: mueve el cursor en SU escritura (aquí, sin sesión).</summary>
    private static Task JobBumpCursor(Guid id) => ${jobs}.UpdateOneAsync(${byId('id')}, new BsonDocument("$inc", new BsonDocument("next_index", 1)), cancellationToken: Cancel);

    private static Task JobSetTime(Guid id, string field, DateTime value) =>
        ${jobs}.UpdateOneAsync(${byId('id')}, new BsonDocument("$set", new BsonDocument(field, new BsonDateTime(value))), cancellationToken: Cancel);`;
  }
  const context = `${model.service.rootNamespace}DbContext`;
  // Dentro de una cadena interpolada de C#: las comillas del alias de PostgreSQL van escapadas.
  const alias = usesMySql(model) ? 'AS `Value`' : 'AS \\"Value\\"';
  const db = (lambda) => `InScope(services => ${lambda.replace('$DB', `services.GetRequiredService<${context}>().Database`)})`;
  return `    private static Task<long> JobCount() => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_JOB.table}").SingleAsync(Cancel)`)};

    private static Task<long> JobCountOf(string key) => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_JOB.table} WHERE idempotency_key = {key}").SingleAsync(Cancel)`)};

    private static Task<long> JobArmed(Guid id) => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${KEEL_TIMER.table} WHERE kind = {${kind}} AND entity_id = {id}").SingleAsync(Cancel)`)};

    private static Task<int> JobCursor(Guid id) => ${db(`$DB.SqlQuery<int>($"SELECT next_index ${alias} FROM ${BATCH_JOB.table} WHERE id = {id}").SingleAsync(Cancel)`)};

    private static Task<long> JobResultCount(Guid id) => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_ITEM_RESULT.table} WHERE job_id = {id}").SingleAsync(Cancel)`)};

    private static async Task<bool> JobExists(Guid id) => await ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_JOB.table} WHERE id = {id}").SingleAsync(Cancel)`)} == 1;

    /// <summary>Otra réplica se lleva el elemento: mueve el cursor en SU transacción (aquí, otro ámbito y otra conexión, en autocommit).</summary>
    private static Task JobBumpCursor(Guid id) => ${db(`$DB.ExecuteSqlAsync($"UPDATE ${BATCH_JOB.table} SET next_index = next_index + 1 WHERE id = {id}", Cancel)`)};

    /// <summary>Una hora del trabajo, retrasada a mano: la columna es una de las de la tabla, nunca un valor de fuera.</summary>
    private static Task JobSetTime(Guid id, string column, DateTime value)
    {
        var sql = "UPDATE ${BATCH_JOB.table} SET " + column + " = {0} WHERE id = {1}";
        return ${db(`$DB.ExecuteSqlRawAsync(sql, [value, id], Cancel)`)};
    }`;
}

// ─── Los casos ───────────────────────────────────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => csString(js({ items }));
const skus = (prefix, count) => Array.from({ length: count }, (_, n) => draft(`${prefix}-000${n}`));

/** Los [Fact] de los lotes asíncronos, dentro de la clase de sondas; null si el diseño no tiene ninguno. */
export function batchJobProbeBlock(model) {
  const operation = asyncOperation(model);
  if (!operation) return null;
  const product = model.entities.find((entity) => entity.name === 'Product');
  const service = model.services.find((candidate) => candidate.operations.includes(operation));
  const endpoints = endpointsClass(service);
  const alta = `${endpoints}.${csMember(operation.name)}`;
  const status = `${endpoints}.${jobEndpoint(operation)}`;
  const results = `${endpoints}.${jobResultsEndpoint(operation)}`;
  const location = `${model.api.routeBase}${operation.route.path}/jobs/`;
  const maxItems = operation.batch.maxItems;
  const methods = [];
  const fact = (id, title, code) => {
    methods.push(`    /// <summary>${id}: ${title}.</summary>
    [Fact]
    public async Task BatchJob_${id.replace('-', '')}_${title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('')}()
    {
        using var owner = JobOwner("alice");
${code}
    }`);
  };
  fact('BJ-1', 'el alta responde 202 sin procesar nada', `        var (code, json, where) = await JobPost(${body(...skus('JAA', 2))}, null);
        Assert.True(code == 202, $"el alta responde 202: {code} {json}");
        var id = Guid.Parse(json!["id"]!.GetValue<string>());
        Assert.True(where is not null && where.EndsWith(${csString(location)} + id.ToString("D"), StringComparison.Ordinal), $"Location del trabajo: {where}");
        Assert.Equal("queued", json["status"]!.GetValue<string>());
        AssertJobSummary(json, 2, 0, 0, 0);
        Assert.Null(json["finishedAt"]);
        Assert.True(json.AsObject().ContainsKey("finishedAt"), "finishedAt sale aunque sea null");
        Assert.Equal(1, await JobArmed(id));
        Assert.Null(await JobProduct("JAA-0000"));`);
  fact('BJ-2', 'por chunks hasta completed con los resultados paginados', `        var id = await JobSubmit(${body(...skus('JBB', 5))});
        Assert.False((await JobFire(id)).Done, "el primer chunk deja trabajo");
        Assert.Equal(${PROBE_CHUNK_SIZE}, await JobCursor(id));
        Assert.False((await JobFire(id)).Done, "el segundo también");
        Assert.True((await JobFire(id)).Done, "el tercero termina");
        var (_, job, _) = await JobGet(id);
        Assert.Equal("completed", job!["status"]!.GetValue<string>());
        AssertJobSummary(job, 5, 5, 0, 0);
        Assert.NotNull(job["finishedAt"]);
        var (_, page, _) = await JobResults(id, "?page=1&size=2");
        Assert.Equal(5, page!["totalElements"]!.GetValue<long>());
        Assert.Equal(2, page["items"]![0]!["index"]!.GetValue<int>());
        Assert.Equal(3, page["items"]![1]!["index"]!.GetValue<int>());
        Assert.NotNull(page["items"]![0]!["result"]?["productId"]);
        Assert.NotNull(await JobProduct("JBB-0004"));`);
  fact('BJ-3', 'un itemError falla solo su elemento y uno no declarado detiene el trabajo', `        await JobRun(await JobSubmit(${body(draft('JCC-0009'))}));
        var id = await JobSubmit(${body(draft('JCC-0001'), draft('JCC-0009'), draft('mal'), draft('JCC-0003'), draft('JCC-0004', UNDECLARED_FAILURE_NAME), draft('JCC-0005'))});
        await JobRun(id);
        var (_, job, _) = await JobGet(id);
        Assert.Equal("aborted", job!["status"]!.GetValue<string>());
        AssertJobSummary(job, 6, 2, 3, 1);
        var (_, page, _) = await JobResults(id, "?size=50");
        Assert.Equal(5, page!["totalElements"]!.GetValue<long>());
        AssertJobResult(page, 1, "failed", "SKU_ALREADY_EXISTS");
        AssertJobResult(page, 2, "failed", "VALIDATION_ERROR");
        AssertJobResult(page, 3, "succeeded", null);
        AssertJobResult(page, 4, "failed", "BATCH_ABORTED");
        Assert.Null(await JobProduct("JCC-0005"));`);
  fact('BJ-4', 'reanuda desde el cursor tras caer a mitad de chunk', `        var id = await JobSubmit(${body(...skus('JDD', 5))});
        Assert.False((await JobFire(id)).Done, "el primer chunk");
        // La réplica cae al escribir el resultado del elemento 3, a mitad del segundo chunk: el 2 ya está confirmado.
        var crashed = false;
        CrashingBatchJobStore.CrashAt = 3;
        try
        {
            await JobFire(id);
        }
        catch (InvalidOperationException)
        {
            crashed = true;
        }
        finally
        {
            CrashingBatchJobStore.CrashAt = null;
        }
        Assert.True(crashed, "la sonda simula la caída");
        Assert.Equal(3, await JobCursor(id));
        await JobRun(id);
        var (_, job, _) = await JobGet(id);
        Assert.Equal("completed", job!["status"]!.GetValue<string>());
        AssertJobSummary(job, 5, 5, 0, 0);
        Assert.Equal(5, await JobResultCount(id));
        Assert.NotNull(await JobProduct("JDD-0003"));`);
  fact('BJ-5', 'la valla revierte al que pierde el trabajo', `        var id = await JobSubmit(${body(draft('JEE-0001'))});
        ${operation.handlerClass}.AfterEffect = async () =>
        {
            ${operation.handlerClass}.AfterEffect = null;
            await JobBumpCursor(id);
        };
        try
        {
            await JobFire(id);
        }
        finally
        {
            ${operation.handlerClass}.AfterEffect = null;
        }
        Assert.Null(await JobProduct("JEE-0001"));
        Assert.Equal(0, await JobResultCount(id));
        Assert.Equal(1, await JobCursor(id));`);
  fact('BJ-6', 'solo lo lee quien lo creó', `        var id = await JobSubmit(${body(draft('JFF-0001'))});
        using (JobOwner("bob"))
        {
            var (code, json, _) = await JobGet(id);
            Assert.True(code == 404 && json?["code"]?.GetValue<string>() == "BATCH_JOB_NOT_FOUND", $"un trabajo ajeno es un 404: {code} {json}");
            var (pageCode, page, _) = await JobResults(id, null);
            Assert.True(pageCode == 404 && page?["code"]?.GetValue<string>() == "BATCH_JOB_NOT_FOUND", $"también sus resultados: {pageCode} {page}");
        }
        Assert.Equal(404, (await JobGet(Guid.NewGuid())).Status);
        Assert.Equal(200, (await JobGet(id)).Status);
        Assert.Equal(200, (await JobResults(id, null)).Status);`);
  fact('BJ-7', 'la clave del lote', `        var first = ${body(draft('JGG-0001'))};
        var created = await JobPost(first, "clave-bj7");
        Assert.True(created.Status == 202, $"el alta con clave: {created.Status} {created.Json}");
        var id = Guid.Parse(created.Json!["id"]!.GetValue<string>());
        await JobRun(id);
        var repeated = await JobPost(first, "clave-bj7");
        Assert.Equal(202, repeated.Status);
        Assert.Equal(created.Location, repeated.Location);
        Assert.Equal("completed", repeated.Json!["status"]!.GetValue<string>());
        var reused = await JobPost(${body(draft('JGG-0002'))}, "clave-bj7");
        Assert.True(reused.Status == 409 && reused.Json?["code"]?.GetValue<string>() == "IDEMPOTENCY_KEY_REUSED", $"la misma clave con otro contenido: {reused.Status} {reused.Json}");
        using (JobOwner("bob"))
        {
            Assert.NotEqual(id.ToString("D"), (await JobPost(first, "clave-bj7")).Json!["id"]!.GetValue<string>());
        }
        await JobSetTime(id, "key_expires_at", DateTime.UtcNow.AddMinutes(-1));
        var fresh = await JobPost(${body(draft('JGG-0002'))}, "clave-bj7");
        Assert.True(fresh.Status == 202, $"pasada su ventana, la clave se libera: {fresh.Status} {fresh.Json}");
        Assert.NotEqual(id.ToString("D"), fresh.Json!["id"]!.GetValue<string>());`);
  fact('BJ-8', 'la purga se lleva lo terminado viejo y nunca lo que está en marcha', `        var old = await JobSubmit(${body(draft('JHH-0001'))});
        await JobRun(old);
        var recent = await JobSubmit(${body(draft('JHH-0002'))});
        await JobRun(recent);
        var running = await JobSubmit(${body(draft('JHH-0003'))});
        await JobSetTime(old, "finished_at", DateTime.UtcNow.AddDays(-8));
        await JobSetTime(running, "created_at", DateTime.UtcNow.AddDays(-30));
        await InScope(services => services.GetRequiredService<${BATCH_JOB_STORE_PORT}>().Purge(7, Cancel));
        Assert.False(await JobExists(old), "el terminado hace más de la retención se va");
        Assert.Equal(0, await JobResultCount(old));
        Assert.True(await JobExists(recent), "el terminado reciente se queda");
        Assert.True(await JobExists(running), "uno en marcha no se purga nunca");`);
  fact('BJ-9', 'el sobre es un 400 sin trabajo', `        var before = await JobCount();
        Assert.Equal(400, (await JobPost("{}", null)).Status);
        var many = await JobPost(JsonSerializer.Serialize(new { items = Enumerable.Range(0, ${maxItems + 1}).Select(_ => new { }).ToList() }), null);
        Assert.True(many.Status == 400, $"más elementos que maxItems: {many.Status} {many.Json}");
        Assert.Equal(400, (await JobPost("{\\"items\\":", null)).Status);
        Assert.Equal(before, await JobCount());`);
  const contents = Array.from({ length: BATCH_KEY_RACE_ROUNDS }, (_, round) => body(draft(`JKK-${String(round).padStart(4, '0')}`)));
  fact('BJ-10', 'la carrera de la clave', `        string[] contents = [${contents.join(', ')}];
        var wrong = new List<string>();
        for (var round = 0; round < contents.Length; round++)
        {
            var content = contents[round];
            var key = "carrera-bj10-" + round;
            var both = await JobRace(() => JobPost(content, key));
            foreach (var answer in both)
            {
                if (answer.Status != 202)
                {
                    wrong.Add($"{round}: {answer.Status} {answer.Json}");
                }
            }
            if (both[0].Location != both[1].Location)
            {
                wrong.Add($"{round}: dos Location, {both[0].Location} y {both[1].Location}");
            }
            var jobs = await JobCountOf(key);
            if (jobs != 1)
            {
                wrong.Add($"{round}: {jobs} trabajos con la clave");
            }
        }
        Assert.True(wrong.Count == 0, "las dos responden 202 con el mismo Location (D13), y un solo trabajo por clave: " + string.Join(" | ", wrong));`);

  const helpers = `    private const string JobKind = ${csString(batchKind(operation.name))};

    private static readonly BatchSettings JobSettings = new(${PROBE_CHUNK_SIZE}, 7, "0 0 0 * * *"${usesKeyedBatches(model) ? `, ${BATCH_SYNC_STALE.default}` : ''});

    /// <summary>El llamante: su sujeto es el dueño de lo que crea (el actor de autoría).</summary>
    private static IDisposable JobOwner(string subject) =>
        SecurityContext.Open(new Principal(PrincipalKind.Token, subject, new HashSet<string>(), new Dictionary<string, JsonElement> { ["sub"] = JsonSerializer.SerializeToElement(subject) }));

    /// <summary>Un endpoint emitido, llamado como lo llama ASP.NET Core: el cuerpo, la ruta, la query, los servicios de un ámbito y el middleware de errores delante.</summary>
    private static async Task<(int Status, JsonNode? Json, string? Location)> JobCall(Func<HttpContext, Task> endpoint, string method, string? content, string? key, Guid? jobId, string? query)
    {
        await using var scope = root.CreateAsyncScope();
        var http = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        http.Request.Method = method;
        http.Request.Scheme = "http";
        http.Request.Host = new HostString("localhost");
        if (content is not null)
        {
            http.Request.ContentType = "application/json";
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(content));
        }
        if (key is not null)
        {
            http.Request.Headers["Idempotency-Key"] = key;
        }
        if (jobId is not null)
        {
            http.Request.RouteValues["jobId"] = jobId.Value.ToString("D");
        }
        if (query is not null)
        {
            http.Request.QueryString = new QueryString(query);
        }
        http.Response.Body = new MemoryStream();
        var middleware = new ApiErrorMiddleware(context => endpoint(context), scope.ServiceProvider.GetRequiredService<ILogger<ApiErrorMiddleware>>());
        await middleware.InvokeAsync(http);
        http.Response.Body.Position = 0;
        var text = await new StreamReader(http.Response.Body).ReadToEndAsync(Cancel);
        return (http.Response.StatusCode, text.Length == 0 ? null : JsonNode.Parse(text), http.Response.Headers.Location.FirstOrDefault());
    }

    /// <summary>Dos altas a la vez, cada una en su tarea. La que lanza cuenta como status 0.</summary>
    private static async Task<(int Status, JsonNode? Json, string? Location)[]> JobRace(Func<Task<(int Status, JsonNode? Json, string? Location)>> call)
    {
        async Task<(int Status, JsonNode? Json, string? Location)> Guarded()
        {
            try
            {
                return await call();
            }
            catch (Exception failed)
            {
                return (0, new JsonObject { ["exception"] = failed.ToString() }, null);
            }
        }
        return await Task.WhenAll(Task.Run(Guarded), Task.Run(Guarded));
    }

    private static Task<(int Status, JsonNode? Json, string? Location)> JobPost(string content, string? key) => JobCall(${alta}, "POST", content, key, null, null);

    private static Task<(int Status, JsonNode? Json, string? Location)> JobGet(Guid id) => JobCall(${status}, "GET", null, null, id, null);

    private static Task<(int Status, JsonNode? Json, string? Location)> JobResults(Guid id, string? query) => JobCall(${results}, "GET", null, null, id, query);

    private static async Task<Guid> JobSubmit(string content)
    {
        var (code, json, _) = await JobPost(content, null);
        Assert.True(code == 202, $"el alta: {code} {json}");
        return Guid.Parse(json!["id"]!.GetValue<string>());
    }

    /// <summary>Un disparo del temporizador del trabajo: su handler emitido, con el chunk de la sonda.</summary>
    private static async Task<TimerOutcome> JobFire(Guid id)
    {
        await using var scope = root.CreateAsyncScope();
        var runner = ActivatorUtilities.CreateInstance<BatchJobRunner>(scope.ServiceProvider, JobSettings);
        var handler = new ${batchJobClass(operation)}(runner);
        return await handler.Handle(new ClaimedTimer(Guid.NewGuid().ToString("D"), JobKind, id, DateTimeOffset.UtcNow, 0), DateTimeOffset.UtcNow, Cancel);
    }

    private static async Task JobRun(Guid id)
    {
        for (var shot = 0; shot < 100; shot++)
        {
            if ((await JobFire(id)).Done)
            {
                return;
            }
        }
        throw new Xunit.Sdk.XunitException("el trabajo no termina");
    }

    private static Task<${product.name}?> JobProduct(string sku) => InScope(other => other.GetRequiredService<${portClass(product)}>().FindBySku(sku, Cancel));

    private static void AssertJobSummary(JsonNode json, int total, int succeeded, int failed, int notAttempted)
    {
        var summary = json["summary"] ?? throw new Xunit.Sdk.XunitException($"sin summary: {json}");
        Assert.Equal((total, succeeded, failed, notAttempted), (summary["total"]!.GetValue<int>(), summary["succeeded"]!.GetValue<int>(), summary["failed"]!.GetValue<int>(), summary["notAttempted"]!.GetValue<int>()));
    }

    private static void AssertJobResult(JsonNode page, int index, string status, string? code)
    {
        var element = page["items"]!.AsArray().FirstOrDefault(candidate => candidate!["index"]!.GetValue<int>() == index)
            ?? throw new Xunit.Sdk.XunitException($"sin el resultado {index}: {page}");
        Assert.Equal(status, element["status"]!.GetValue<string>());
        if (code is not null)
        {
            Assert.Equal(code, element["error"]!.GetValue<string>());
        }
    }

${storage(model)}`;
  return { methods: `    // ─── Lotes asíncronos (DSL 2.30, fase B): BJ-1 a BJ-10, con el endpoint, el procesador y los almacenes emitidos ───\n\n${[...methods, helpers].join('\n\n')}` };
}
