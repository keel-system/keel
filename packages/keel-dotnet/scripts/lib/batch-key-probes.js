// Los lotes SÍNCRONOS con clave (DSL 2.30, D15, incremento 10b) contra lo emitido, para db-check y doc-check: BK-1 a BK-6
// de keel-core/gen/batch.js, con los ids que ejecutan keel-spring (batch-check) y keel-nest (scripts/lib/batch-key-probes.js)
// sobre los MISMOS diseños (BATCH_KEY_DESIGNS de keel-core/test/helpers/batch-designs.js). El handler de la sonda es el de
// batch-probes.js (batchProbePatch).
//
// Un [Fact] por caso (`BatchKey_BK4_…`), dentro de la clase de sondas de cada sujeto: comparte la base con el resto, así que
// NO vacía nada; cada caso usa sus propias claves y sus propios sku (`ZK<letra>-000n`), y cuenta trabajos y resultados como
// DIFERENCIA. El endpoint emitido se llama como lo llama ASP.NET Core (un HttpContext con el cuerpo y la cabecera de la clave,
// los servicios de un ámbito y el ApiErrorMiddleware emitido delante).
//
// La petición que muere a mitad de lote (BK-3, BK-4) es el almacén que lanza al escribir el resultado del SEGUNDO elemento
// (CrashingBatchJobStore de batch-job-probes.js, registrado en el lugar del emitido): en C# se captura todo, así que la muerte
// no puede ser un error del handler (sería el fallo de su elemento); la del almacén vuelve a caer al escribir el resultado de
// fallo y escapa del lote sin mover el cursor, como el Error del gancho de keel-spring. Que lleve muerta más que
// `batch.sync-stale-ms` se simula envejeciendo su `updated_at`.

import { BATCH_KEY_CASES, BATCH_KEY_RACE_ROUNDS, BATCH_KEY_SABOTAGES } from '@keel-system/keel-core/gen/batch';
import { BATCH_JOB, BATCH_ITEM_RESULT, BATCH_PARAMETERS, BATCH_SYNC_STALE } from '@keel-system/keel-core/gen/batch-store';
import { csMember, csString, namespaceOf } from '../../src/scaffold/render.js';
import { endpointsClass } from '../../src/scaffold/endpoints.js';
import { portClass } from '../../src/scaffold/repositories.js';
import { usesMySql } from '../../src/scaffold/relational-engine.js';
import { batchInfraNamespace } from '../../src/scaffold/batch-jobs.js';
import { batchOperations } from './batch-probes.js';

const js = (value) => JSON.stringify(value);

/** Los sujetos por almacén: los de BATCH_KEY_DESIGNS. */
export const BATCH_KEY_SUBJECTS = { relational: ['catalog-batch-keyed', 'catalog-batch-atomic-keyed'], document: ['catalog-batch-keyed-mongo'] };

/** Las operaciones síncronas con clave del modelo. */
export const keyedOperations = (model) => batchOperations(model).filter((operation) => operation.batch.idempotency);

/** Los casos de un lote síncrono con clave que ejecuta este diseño: BK-1 a BK-4 y BK-6 con un per-item, BK-5 con un todo o nada. */
export function batchKeyCases(model) {
  const atomicities = new Set(keyedOperations(model).map((operation) => operation.batch.atomicity));
  const ids = [];
  if (atomicities.has('per-item')) ids.push('BK-1', 'BK-2', 'BK-3', 'BK-4', 'BK-6');
  if (atomicities.has('all-or-nothing')) ids.push('BK-5');
  return BATCH_KEY_CASES.map((entry) => entry.id).filter((id) => ids.includes(id));
}

// ─── Los sabotajes ───────────────────────────────────────────────────────────────────────────────────────────────

const KEYED = 'Rest/KeyedBatches.cs';
const SAME = (spec) => ({ relational: spec, document: spec });

// El alta que el motor mata por interbloqueo no se repite (solo cae en MySQL: en PostgreSQL la carrera llega por la unicidad).
// En keel-dotnet la repetición NO es del alta sino de PersistenceTransactions, la de todo caso de uso: el sabotaje la apaga
// ahí, y el veredicto solo mira los casos de los lotes.
const NO_RACE_RETRY = SAME([
  'Persistence/PersistenceTransactions.cs',
  'catch (Exception error) when (!readOnly && attempt < WriteConflictAttempts && PersistenceErrors.IsTransientWriteConflict(error))',
  'catch (Exception error) when (!readOnly && attempt < 1 && PersistenceErrors.IsTransientWriteConflict(error))'
]);

/**
 * Lo que se busca y se sustituye en lo emitido, por sabotaje y por almacén: [sufijo del archivo, texto, sustituto]. Rompen lo
 * emitido CONSERVANDO LA FORMA (sigue compilando sin avisos: un parámetro del constructor sin leer sería un aviso).
 */
export const BATCH_KEY_SABOTAGE_SPECS = {
  // La repetición de un lote terminado lo vuelve a procesar en vez de responder lo guardado.
  'bk-replay-reprocess': SAME([
    KEYED,
    `            // La repetición de un lote terminado: lo guardado, sin procesar nada.
            return await steps.Stored(started.Id, cancellationToken);`,
    `            return await BatchRunner.PerItem(envelope.Items, readItem, itemErrors, item => process(services, envelope.Message(item), cancellationToken), error => ApiErrorMiddleware.Translate(services, error), cancellationToken);`
  ]),
  // Un lote en marcha se toma igual que uno muerto.
  'bk-steal-running': SAME([KEYED, 'store.TakeOver(job.Id, settings.SyncStaleMs, cancellationToken)', 'store.TakeOver(job.Id, settings.SyncStaleMs * 0L, cancellationToken)']),
  // La reanudación empieza en el principio y no en el cursor.
  'bk-no-resume': SAME([KEYED, 'for (var index = started.From; index < envelope.Items.Count; index++)', 'for (var index = 0; index < envelope.Items.Count; index++)']),
  // El todo o nada que falla deja su trabajo.
  'bk-keep-failed': SAME([
    KEYED,
    '        await transactions.Run(() => store.Discard(id, CancellationToken.None), readOnly: false, CancellationToken.None);',
    '        _ = id;\n        await Task.CompletedTask;'
  ]),
  'bk-no-race-retry': NO_RACE_RETRY
};

export const isBatchKeySabotage = (id) => Boolean(id && BATCH_KEY_SABOTAGE_SPECS[id]);

/** Lo que tiene que caer con un sabotaje en este diseño: sus casos BK que la sonda ejecuta, y solo esos. */
export function batchKeySabotageVerdict(failures, id, model) {
  const cases = batchKeyCases(model);
  const want = BATCH_KEY_SABOTAGES[id].filter((caseId) => cases.includes(caseId)).sort();
  const failed = [...new Set(failures.flatMap((line) => [...line.matchAll(/BatchKey_BK(\d+)_/g)].map((match) => `BK-${match[1]}`)))].sort();
  return { exact: want.length > 0 && failed.length === want.length && failed.every((name, index) => name === want[index]), failed, want };
}

// ─── El contenedor ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el contenedor de la sonda registra con un lote con clave, DESPUÉS de la persistencia: KeyedBatches (el endpoint lo
 * pide al contenedor, también sin la cabecera de la clave) y su mecánica, con el umbral del lote muerto de keel-core. El
 * almacén que sabe caer lo registra batchJobFixtureRegistration.
 */
export function batchKeyFixtureRegistration(model) {
  if (keyedOperations(model).length === 0) return '';
  const P = BATCH_PARAMETERS;
  return `
        // Los lotes síncronos con clave (DSL 2.30, D15): KeyedBatches y su mecánica.
        services.AddSingleton(new BatchSettings(${P.chunkSize.default}, ${P.retentionDays.default}, ${csString(P.purgeCron.default)}, ${BATCH_SYNC_STALE.default}));
        services.AddScoped<KeyedBatches>();`;
}

/** Los using que añaden las sondas de los lotes con clave. */
export function batchKeyProbeUsings(model) {
  if (keyedOperations(model).length === 0) return [];
  return [
    'System.Text',
    'System.Text.Json.Nodes',
    'Microsoft.AspNetCore.Http',
    'Microsoft.Extensions.Logging',
    'Microsoft.Extensions.DependencyInjection.Extensions',
    ...(model.persistenceKind === 'document' ? ['MongoDB.Bson', 'MongoDB.Driver'] : ['Microsoft.EntityFrameworkCore']),
    namespaceOf(model, 'rest'),
    namespaceOf(model, 'endpoints'),
    namespaceOf(model, 'persistence'),
    batchInfraNamespace(model)
  ];
}

// ─── Lo que la sonda lee y retoca de las tablas ──────────────────────────────────────────────────────────────────

function storage(model) {
  if (model.persistenceKind === 'document') {
    const jobs = `root.GetRequiredService<DocumentDatabase>().Collection(${csString(BATCH_JOB.table)})`;
    const results = `root.GetRequiredService<DocumentDatabase>().Collection(${csString(BATCH_ITEM_RESULT.table)})`;
    return `    private static Task<long> KeyJobCount() => ${jobs}.CountDocumentsAsync(new BsonDocument(), cancellationToken: Cancel);

    private static Task<long> KeyJobCountOf(string key) => ${jobs}.CountDocumentsAsync(new BsonDocument("idempotency_key", key), cancellationToken: Cancel);

    private static Task<long> KeyResultCount() => ${results}.CountDocumentsAsync(new BsonDocument(), cancellationToken: Cancel);

    /// <summary>Una hora del trabajo de esa clave, retrasada a mano.</summary>
    private static Task KeyAge(string key, string field, TimeSpan ago) =>
        ${jobs}.UpdateOneAsync(new BsonDocument("idempotency_key", key), new BsonDocument("$set", new BsonDocument(field, new BsonDateTime(DateTime.UtcNow - ago))), cancellationToken: Cancel);`;
  }
  const context = `${model.service.rootNamespace}DbContext`;
  // Dentro de una cadena interpolada de C#: las comillas del alias de PostgreSQL van escapadas.
  const alias = usesMySql(model) ? 'AS `Value`' : 'AS \\"Value\\"';
  const db = (lambda) => `InScope(services => ${lambda.replace('$DB', `services.GetRequiredService<${context}>().Database`)})`;
  return `    private static Task<long> KeyJobCount() => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_JOB.table}").SingleAsync(Cancel)`)};

    private static Task<long> KeyJobCountOf(string key) => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_JOB.table} WHERE idempotency_key = {key}").SingleAsync(Cancel)`)};

    private static Task<long> KeyResultCount() => ${db(`$DB.SqlQuery<long>($"SELECT count(*) ${alias} FROM ${BATCH_ITEM_RESULT.table}").SingleAsync(Cancel)`)};

    /// <summary>Una hora del trabajo de esa clave, retrasada a mano: la columna es una de las de la tabla, nunca un valor de fuera.</summary>
    private static Task KeyAge(string key, string column, TimeSpan ago)
    {
        var sql = "UPDATE ${BATCH_JOB.table} SET " + column + " = {0} WHERE idempotency_key = {1}";
        return ${db(`$DB.ExecuteSqlRawAsync(sql, [DateTime.UtcNow - ago, key], Cancel)`)};
    }`;
}

// ─── Los casos ───────────────────────────────────────────────────────────────────────────────────────────────────

const draft = (sku, name = 'Producto') => ({ sku, name, price: { amount: '10.00', currency: 'EUR' } });
const body = (...items) => csString(js({ items }));

/** Los [Fact] de los lotes con clave, dentro de la clase de sondas; null si el diseño no tiene ninguno. */
export function batchKeyProbeBlock(model) {
  const operations = keyedOperations(model);
  if (operations.length === 0) return null;
  const cases = new Set(batchKeyCases(model));
  const product = model.entities.find((entity) => entity.name === 'Product');
  const service = model.services.find((candidate) => candidate.operations.includes(operations[0]));
  const endpoints = endpointsClass(service);
  const perItem = operations.find((operation) => operation.batch.atomicity === 'per-item');
  const atomic = operations.find((operation) => operation.batch.atomicity === 'all-or-nothing');
  const staleAgo = `TimeSpan.FromMilliseconds(${BATCH_SYNC_STALE.default * 2})`;
  const methods = [];
  const fact = (id, title, code) => {
    if (!cases.has(id)) return;
    methods.push(`    /// <summary>${id}: ${title}.</summary>
    [Fact]
    public async Task BatchKey_${id.replace('-', '')}_${title.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join('')}()
    {
${code}
    }`);
  };
  if (perItem) {
    const call = `${endpoints}.${csMember(perItem.name)}`;
    fact('BK-1', 'la repeticion devuelve el mismo 207', `        var content = ${body(draft('ZKA-0001'), draft('ZKA-0002'))};
        var jobs = await KeyJobCount();
        var first = await KeyPost(${call}, content, "clave-bk1");
        Assert.True(first.Status == 207 && first.Json?["summary"]?["succeeded"]?.GetValue<int>() == 2, $"el primero responde 207: {first.Status} {first.Json}");
        var results = await KeyResultCount();
        var repeated = await KeyPost(${call}, content, "clave-bk1");
        Assert.True(repeated.Status == 207, $"la repetición responde 207: {repeated.Status} {repeated.Json}");
        Assert.True(JsonNode.DeepEquals(first.Json, repeated.Json), $"el MISMO 207: {first.Json} frente a {repeated.Json}");
        Assert.Equal(results, await KeyResultCount());
        Assert.Equal(jobs + 1, await KeyJobCount());`);
    fact('BK-2', 'otra firma es la clave reutilizada', `        var jobs = await KeyJobCount();
        Assert.Equal(207, (await KeyPost(${call}, ${body(draft('ZKB-0001'))}, "clave-bk2")).Status);
        var reused = await KeyPost(${call}, ${body(draft('ZKB-0002'))}, "clave-bk2");
        Assert.True(reused.Status == 409 && reused.Json?["code"]?.GetValue<string>() == "IDEMPOTENCY_KEY_REUSED", $"la misma clave con otro cuerpo: {reused.Status} {reused.Json}");
        Assert.Null(await KeyProduct("ZKB-0002"));
        await KeyAge("clave-bk2", "key_expires_at", TimeSpan.FromMinutes(1));
        var fresh = await KeyPost(${call}, ${body(draft('ZKB-0002'))}, "clave-bk2");
        Assert.True(fresh.Status == 207, $"pasada su ventana, un lote nuevo: {fresh.Status} {fresh.Json}");
        Assert.NotNull(await KeyProduct("ZKB-0002"));
        Assert.Equal(jobs + 2, await KeyJobCount());`);
    fact('BK-3', 'en marcha es 409', `        var content = ${body(draft('ZKC-0001'), draft('ZKC-0002'), draft('ZKC-0003'))};
        var results = await KeyResultCount();
        await KeyDies(${call}, content, "clave-bk3");
        var running = await KeyPost(${call}, content, "clave-bk3");
        Assert.True(running.Status == 409 && running.Json?["code"]?.GetValue<string>() == "IDEMPOTENCY_KEY_IN_PROGRESS", $"el primero sigue en marcha: {running.Status} {running.Json}");
        Assert.Null(await KeyProduct("ZKC-0002"));
        Assert.Equal(results + 1, await KeyResultCount());`);
    fact('BK-4', 'reanuda desde el cursor', `        var content = ${body(draft('ZKD-0001'), draft('ZKD-0002'), draft('ZKD-0003'))};
        var results = await KeyResultCount();
        await KeyDies(${call}, content, "clave-bk4");
        Assert.NotNull(await KeyProduct("ZKD-0001"));
        await KeyAge("clave-bk4", "updated_at", ${staleAgo});
        var resumed = await KeyPost(${call}, content, "clave-bk4");
        Assert.True(resumed.Status == 207, $"la repetición de un lote muerto lo sigue: {resumed.Status} {resumed.Json}");
        AssertKeySummary(resumed.Json!, 3, 3, 0, 0);
        Assert.Equal(results + 3, await KeyResultCount());
        Assert.NotNull(await KeyProduct("ZKD-0003"));`);
    const contents = Array.from({ length: BATCH_KEY_RACE_ROUNDS }, (_, round) => body(draft(`ZKF-${String(round).padStart(4, '0')}`)));
    fact('BK-6', 'la carrera de la clave', `        string[] contents = [${contents.join(', ')}];
        var wrong = new List<string>();
        for (var round = 0; round < contents.Length; round++)
        {
            var content = contents[round];
            var key = "carrera-bk6-" + round;
            var both = await KeyRace(() => KeyPost(${call}, content, key));
            foreach (var answer in both)
            {
                if (answer.Status != 207 && !(answer.Status == 409 && answer.Json?["code"]?.GetValue<string>() == "IDEMPOTENCY_KEY_IN_PROGRESS"))
                {
                    wrong.Add($"{round}: {answer.Status} {answer.Json}");
                }
            }
            if (!both.Any(answer => answer.Status == 207))
            {
                wrong.Add($"{round}: ninguno es 207");
            }
            var jobs = await KeyJobCountOf(key);
            if (jobs != 1)
            {
                wrong.Add($"{round}: {jobs} trabajos con la clave");
            }
        }
        Assert.True(wrong.Count == 0, "cada respuesta es el 207 o 409 IDEMPOTENCY_KEY_IN_PROGRESS, y un solo trabajo por clave: " + string.Join(" | ", wrong));`);
  }
  if (atomic) {
    const call = `${endpoints}.${csMember(atomic.name)}`;
    fact('BK-5', 'todo o nada con clave', `        var jobs = await KeyJobCount();
        var good = ${body(draft('ZKE-0001'), draft('ZKE-0002'))};
        var first = await KeyPost(${call}, good, "clave-bk5");
        Assert.True(first.Status == ${atomic.route.status}, $"el lote confirmado: {first.Status} {first.Json}");
        var repeated = await KeyPost(${call}, good, "clave-bk5");
        Assert.Equal(${atomic.route.status}, repeated.Status);
        Assert.True(JsonNode.DeepEquals(first.Json, repeated.Json), $"con la misma respuesta: {first.Json} frente a {repeated.Json}");
        Assert.Equal(jobs + 1, await KeyJobCount());
        var bad = ${body(draft('ZKE-0003'), draft('ZKE-0003'))};
        var failed = await KeyPost(${call}, bad, "clave-bk5b");
        Assert.True(failed.Status == 409 && failed.Json?["code"]?.GetValue<string>() == "SKU_ALREADY_EXISTS", $"el que falla: {failed.Status} {failed.Json}");
        Assert.Equal(jobs + 1, await KeyJobCount());
        var again = await KeyPost(${call}, bad, "clave-bk5b");
        Assert.True(again.Json?["code"]?.GetValue<string>() == "SKU_ALREADY_EXISTS", $"repetirlo lo vuelve a procesar: {again.Status} {again.Json}");
        Assert.Null(await KeyProduct("ZKE-0003"));`);
  }

  const helpers = `    /// <summary>El endpoint emitido, llamado como lo llama ASP.NET Core: el cuerpo, la cabecera de la clave, los servicios de un ámbito y el middleware de errores delante.</summary>
    private static async Task<(int Status, JsonNode? Json)> KeyPost(Func<HttpContext, Task> endpoint, string content, string key)
    {
        await using var scope = root.CreateAsyncScope();
        var http = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
        http.Request.Method = "POST";
        http.Request.ContentType = "application/json";
        http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(content));
        http.Request.Headers["Idempotency-Key"] = key;
        http.Response.Body = new MemoryStream();
        var middleware = new ApiErrorMiddleware(context => endpoint(context), scope.ServiceProvider.GetRequiredService<ILogger<ApiErrorMiddleware>>());
        await middleware.InvokeAsync(http);
        http.Response.Body.Position = 0;
        var text = await new StreamReader(http.Response.Body).ReadToEndAsync(Cancel);
        return (http.Response.StatusCode, text.Length == 0 ? null : JsonNode.Parse(text));
    }

    /// <summary>Dos llamadas a la vez, cada una en su tarea. La que lanza cuenta como status 0.</summary>
    private static async Task<(int Status, JsonNode? Json)[]> KeyRace(Func<Task<(int Status, JsonNode? Json)>> call)
    {
        async Task<(int Status, JsonNode? Json)> Guarded()
        {
            try
            {
                return await call();
            }
            catch (Exception failed)
            {
                return (0, new JsonObject { ["exception"] = failed.ToString() });
            }
        }
        return await Task.WhenAll(Task.Run(Guarded), Task.Run(Guarded));
    }

    /// <summary>La petición muere al escribir el resultado del SEGUNDO elemento: el primero queda confirmado y el trabajo, sin terminar.</summary>
    private static async Task KeyDies(Func<HttpContext, Task> endpoint, string content, string key)
    {
        (int Status, JsonNode? Json) answer;
        CrashingBatchJobStore.CrashAt = 1;
        try
        {
            answer = await KeyPost(endpoint, content, key);
        }
        finally
        {
            CrashingBatchJobStore.CrashAt = null;
        }
        Assert.True(answer.Status == 500, $"la sonda tenía que matar la petición: {answer.Status} {answer.Json}");
    }

    private static Task<${product.name}?> KeyProduct(string sku) => InScope(other => other.GetRequiredService<${portClass(product)}>().FindBySku(sku, Cancel));

    private static void AssertKeySummary(JsonNode json, int total, int succeeded, int failed, int notAttempted)
    {
        var summary = json["summary"] ?? throw new Xunit.Sdk.XunitException($"sin summary: {json}");
        Assert.Equal((total, succeeded, failed, notAttempted), (summary["total"]!.GetValue<int>(), summary["succeeded"]!.GetValue<int>(), summary["failed"]!.GetValue<int>(), summary["notAttempted"]!.GetValue<int>()));
    }

${storage(model)}`;
  return { methods: `    // ─── Lotes síncronos con clave (DSL 2.30, D15): BK-1 a BK-6, con el endpoint, KeyedBatches y los almacenes emitidos ───\n\n${[...methods, helpers].join('\n\n')}` };
}
