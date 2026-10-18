// Caché de lectura (`use-cases.<op>.cache`, incremento 13f). Se genera siempre que alguna operación del diseño la
// declare, sobre Redis o Valkey (el mismo protocolo, el mismo cliente: solo cambia la imagen del compose).
//
// QUÉ se cachea es la RESPUESTA de la operación, no el agregado, como en keel-spring y keel-nest. Se guarda con el
// contrato del cable (las opciones de WireJson, las mismas que escriben la respuesta HTTP) y se lee con ellas: lo que sale
// de la caché es, campo a campo, lo que habría servido el origen —decimales con su escala, instantes con sus tres
// decimales—. A diferencia de keel-nest, no hace falta un lector por DTO: System.Text.Json reconstruye los records.
//
// DÓNDE se consulta lo decide el agente: en el handler, DESPUÉS de lo que dependa de quién llama (la clave es la entrada de
// la operación, no el llamante). Por eso el puerto vive en Application y la consulta es `GetOrLoad`.
//
// La INVALIDACIÓN la pone build: es un hecho del diseño (`invalidatedBy` + `emits` + las suscripciones), y el mediator vacía
// la caché ENTERA tras el commit de cada operación que emite o consume uno de sus eventos (keel-core/gen/cache-plan.js).
// Invalida de más, nunca de menos.
//
// Las claves en el store son las de RedisCacheManager de keel-spring (`<servicio>:<operación>::<clave>`): el mismo
// `infra/reset-db.sh` y el mismo `ClearCache()` del arnés las borran en los tres servidores.

import { cachedOperations, cacheInvalidations, CACHE_ENTRY_SEPARATOR, CACHE_KEY_PART_SEPARATOR } from 'keel-core/gen/cache-plan';
import { cacheYaml } from 'keel-core/gen/cache-config';
import { CACHES, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { cacheFlushCmd } from 'keel-core/gen/infra-scripts';
import { csFile, csMember, csString, located, namespaceOf, solution } from './render.js';
import { configNamespace } from './config.js';
import { messageComponents, messageNamespace, returnTypeOf } from './services.js';
import { telemetryNamespace, usesTelemetry } from './telemetry.js';
import { usesPersistence } from './persistence.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export const OPERATION_CACHE_PORT = 'IOperationCache';

export function usesCache(model) {
  // Sin pasar por cachedOperations, que necesita el servicio: la pregunta solo mira si alguna operación declara caché.
  return (model.services ?? []).some((service) => (service.operations ?? []).some((operation) => operation.cache));
}

export function cacheNamespace(model) {
  return namespaceOf(model, 'cache');
}

/** El miembro de CachedOperations de la caché de una operación (`getAsset` → `GetAsset`). */
export function cacheMember(operationName) {
  return csMember(operationName);
}

/** ¿Lleva esta operación caché? Su handler recibe el puerto. */
export function cachesOperation(model, operation) {
  return cachedOperations(model).some((cache) => cache.operation === operation.name);
}

export function generate(model) {
  if (!usesCache(model)) return [];
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const ports = namespaceOf(model, 'ports');
  const support = namespaceOf(model, 'appSupport');
  const persistence = usesPersistence(model);
  return [
    file('ports', OPERATION_CACHE_PORT, ['System.Globalization'], portBody()),
    cachedOperationsFile(model),
    file('cache', 'CacheSettings', ['System.Globalization', configNamespace(model)], settingsBody()),
    file('cache', 'ICacheStore', [], storeContractBody()),
    file('cache', 'CacheCodec', ['System.Text.Json', 'System.Text.Json.Serialization.Metadata', support], codecBody()),
    file('cache', 'RedisCacheStore', ['Microsoft.Extensions.Logging', 'StackExchange.Redis'], redisStoreBody()),
    file(
      'cache',
      'RedisOperationCache',
      ['System.Collections.Concurrent', 'System.Text.Json', 'Microsoft.Extensions.Logging', ports, support, ...(persistence ? [namespaceOf(model, 'persistence')] : []), ...(usesTelemetry(model) ? [telemetryNamespace(model)] : [])],
      adapterBody(model)
    ),
    cacheInvalidationsFile(model),
    file('cache', 'CacheRegistration', ['Microsoft.Extensions.DependencyInjection', ports], registrationBody()),
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/cache.yaml`, content: cacheYaml(profile) })),
    cacheTestsFile(model, solution(model))
  ];
}

// ─── El puerto (Application/Ports) ───────────────────────────────────────────────────────────────

function portBody() {
  return `/// <summary>Cualquier caché del diseño, para lo que no lee ni compone la clave (desalojar, vaciar).</summary>
public interface ICachedOperation
{
    /// <summary>Su nombre en el store: <c>&lt;servicio&gt;:&lt;operación&gt;</c>, como RedisCacheManager de keel-spring.</summary>
    string Name { get; }

    int TtlSeconds { get; }
}

/// <summary>
/// Una caché de lectura del diseño (<c>use-cases.&lt;operación&gt;.cache</c>): su nombre, su TTL y cómo se compone la clave
/// desde el mensaje de la operación. <typeparamref name="T"/> es lo que guarda —la respuesta de la operación— y
/// <typeparamref name="TMessage"/>, el mensaje del que sale la clave. Las del diseño están en CachedOperations.
/// </summary>
public sealed record CachedOperation<T, TMessage>(string Name, int TtlSeconds, Func<TMessage, string> KeyOf) : ICachedOperation;

/// <summary>Opciones de una carga.</summary>
public sealed record CacheLoadOptions<T>
{
    /// <summary>
    /// Si la respuesta recién cargada se puede guardar. Por defecto, toda la que no es nula. Es para lo que el diseño no
    /// quiere ver servido durante el TTL: una ficha DEGRADADA porque un proveedor no contestó se sirve y no se guarda.
    /// </summary>
    public Func<T, bool>? Cacheable { get; init; }
}

/// <summary>
/// La caché de lectura. Lo que la consulta es el HANDLER de la operación, después de todo lo que dependa de quién llama:
/// la clave es la entrada de la operación y no el llamante, así que una respuesta servida antes de comprobar el alcance
/// se le serviría a cualquiera.
/// </summary>
/// <remarks>Un store caído o una entrada ilegible no son errores: degradan a miss y la respuesta sale del origen.</remarks>
public interface ${OPERATION_CACHE_PORT}
{
    /// <summary>
    /// La respuesta cacheada para el mensaje, o la que da <paramref name="load"/> —que se guarda con el TTL de la caché—.
    /// Con varias peticiones a la vez sobre la misma entrada, carga UNA y las demás esperan a su resultado.
    /// </summary>
    Task<T> GetOrLoad<T, TMessage>(CachedOperation<T, TMessage> cache, TMessage message, Func<CancellationToken, Task<T>> load, CacheLoadOptions<T>? options = null, CancellationToken cancellationToken = default);

    /// <summary>Desaloja una entrada (la clave como la compone KeyOf, o <see cref="CacheKey.Of"/>). Tras el commit, si lo hay.</summary>
    Task Evict(ICachedOperation cache, string key, CancellationToken cancellationToken = default);

    /// <summary>
    /// Vacía la caché entera. Tras el commit, si lo hay. No hace falta llamarlo por los eventos de <c>invalidatedBy</c>: eso
    /// ya lo hace el mediator al confirmar cada operación que los emite o los consume.
    /// </summary>
    Task Clear(ICachedOperation cache, CancellationToken cancellationToken = default);
}

/// <summary>La clave de una entrada, con la forma de keel-spring y keel-nest.</summary>
public static class CacheKey
{
    /// <summary>
    /// Los componentes en su orden, separados por <c>${CACHE_KEY_PART_SEPARATOR}</c>. Un instante va en ISO-8601 con sus milisegundos y en
    /// UTC; un nulo, como <c>null</c>; un booleano, en minúsculas.
    /// </summary>
    public static string Of(params object?[] parts)
    {
        ArgumentNullException.ThrowIfNull(parts);
        return string.Join(${csString(CACHE_KEY_PART_SEPARATOR)}, parts.Select(Part));
    }

    private static string Part(object? part) =>
        part switch
        {
            null => "null",
            bool flag => flag ? "true" : "false",
            DateTimeOffset instant => instant.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => part.ToString() ?? "null"
        };
}`;
}

// ─── Las cachés del diseño (Application/Support) ─────────────────────────────────────────────────

function cachedOperationsFile(model) {
  const { namespace, path } = located(model, 'appSupport', 'CachedOperations');
  const caches = cachedOperations(model);
  const operations = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const usings = [namespaceOf(model, 'ports'), namespaceOf(model, 'dtos')];
  const invalidators = new Map();
  for (const entry of cacheInvalidations(model)) {
    for (const cache of entry.caches) {
      if (!invalidators.has(cache.cacheName)) invalidators.set(cache.cacheName, []);
      invalidators.get(cache.cacheName).push(entry.operation);
    }
  }
  const members = caches.map((cache) => {
    const operation = operations.get(cache.operation);
    usings.push(messageNamespace(model, operation));
    const components = new Map(messageComponents(operation, model).map((component) => [component.name, component]));
    const missing = cache.keyFields.filter((field) => !components.has(field));
    if (missing.length > 0) {
      throw new Error(
        `use-cases.${cache.operation}.cache.keyFields: ${missing.join(', ')} no ${missing.length === 1 ? 'es un campo' : 'son campos'} del mensaje ${operation.messageClass}; la clave de la caché sale de la entrada de la operación.`
      );
    }
    const key = cache.keyFields.length > 0 ? `CacheKey.Of(${cache.keyFields.map((field) => `message.${csMember(field)}`).join(', ')})` : 'CacheKey.Of("all")';
    const by = invalidators.get(cache.cacheName) ?? [];
    const doc = [
      `Caché de ${cache.operation}: TTL ${cache.ttlSeconds} s, clave por ${cache.keyFields.join(', ') || 'ningún campo (una sola entrada)'}.`,
      cache.invalidatedBy.length > 0
        ? `La invalidan ${cache.invalidatedBy.join(', ')}: la vacían ENTERA, al confirmar, ${by.length > 0 ? by.join(', ') : 'ninguna operación de este servicio (solo caduca por su TTL)'} (lo hace el mediator).`
        : 'Ningún evento la invalida: solo caduca por su TTL.'
    ];
    return `    /// <summary>
${doc.map((line) => `    /// ${line}`).join('\n')}
    /// </summary>
    public static readonly CachedOperation<${returnTypeOf(operation)}, ${operation.messageClass}> ${cacheMember(cache.operation)} =
        new(${csString(cache.cacheName)}, ${cache.ttlSeconds}, ${cache.keyFields.length > 0 ? 'message' : '_'} => ${key});`;
  });
  const body = `/// <summary>
/// Las cachés de lectura que declara use-cases.keel.yaml. El nombre y el TTL salen del diseño: cambiarlos aquí a mano los
/// desalinea del contrato —y de los servidores de keel-spring y keel-nest del mismo diseño, que nombran igual sus cachés—.
/// Lo generó keel-dotnet build: no se edita.
/// </summary>
public static class CachedOperations
{
${members.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Configuración ───────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `/// <summary>Lo que la caché lee de config/parameters/&lt;perfil&gt;/cache.yaml (las variables de keel-spring: REDIS_HOST, REDIS_PORT).</summary>
/// <param name="Enabled">Sin caché (perfil test): toda lectura va al origen y no se abre ninguna conexión.</param>
/// <param name="Host">El store.</param>
/// <param name="Port">Su puerto.</param>
/// <param name="ConnectTimeoutMs">Cuánto espera una conexión antes de darla por fallida (y reintentar en segundo plano).</param>
/// <param name="CommandTimeoutMs">Cuánto espera una orden: un store que no contesta degrada a miss en este plazo.</param>
public sealed record CacheSettings(bool Enabled, string Host, int Port, int ConnectTimeoutMs, int CommandTimeoutMs)
{
    /// <summary>Sin caché: la de las pruebas de build que construyen el contenedor.</summary>
    public static CacheSettings Disabled { get; } = new(false, "localhost", 6379, 2000, 2000);

    public static CacheSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new CacheSettings(
            Text(configuration, "cache:enabled") is not { } enabled || string.Equals(enabled, "true", StringComparison.OrdinalIgnoreCase),
            Text(configuration, "cache:redis:host") ?? "localhost",
            Number(configuration, "cache:redis:port", 6379),
            Number(configuration, "cache:redis:connect-timeout-ms", 2000),
            Number(configuration, "cache:redis:command-timeout-ms", 2000));
    }

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    private static int Number(ServiceConfiguration configuration, string key, int fallback)
    {
        var value = Text(configuration, key);
        if (value is null)
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un número no negativo: '{value}'");
    }
}`;
}

// ─── El codec ────────────────────────────────────────────────────────────────────────────────────

function codecBody() {
  return `/// <summary>
/// Cómo se guarda y se vuelve a leer la respuesta de una caché: con el contrato del cable (las opciones de WireJson, lo
/// mismo que sale por HTTP), y una sola diferencia al LEER: ninguna propiedad se exige presente.
/// </summary>
/// <remarks>
/// Una respuesta cuyo tipo omite los nulos (<c>nulls: omit</c> del diseño, OmitNulls) se guarda SIN esas propiedades, y los
/// DTO las declaran <c>required</c>: leídas con las opciones del cable, la entrada no se podría leer nunca y la caché no
/// acertaría jamás, en silencio (lo destapó cache-check con catalog-extended). Lo que se lee aquí lo escribió este mismo
/// servicio con este mismo codec, así que una propiedad ausente es una propiedad nula.
/// </remarks>
public static class CacheCodec
{
    private static readonly JsonSerializerOptions ReadOptions = CreateReadOptions();

    public static string Write<T>(T value) => JsonSerializer.Serialize(value, WireJson.Options);

    /// <exception cref="JsonException">Si el texto no tiene la forma de la respuesta (una entrada de otra versión).</exception>
    public static T? Read<T>(string text) => JsonSerializer.Deserialize<T>(text, ReadOptions);

    private static JsonSerializerOptions CreateReadOptions()
    {
        var options = new JsonSerializerOptions(WireJson.Options);
        options.TypeInfoResolver = (options.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver()).WithAddedModifier(typeInfo =>
        {
            foreach (var property in typeInfo.Properties)
            {
                property.IsRequired = false;
            }
        });
        options.MakeReadOnly();
        return options;
    }
}`;
}

// ─── El store ────────────────────────────────────────────────────────────────────────────────────

function storeContractBody() {
  return `/// <summary>Lo que la caché necesita de un store clave-valor con caducidad.</summary>
public interface ICacheStore
{
    Task<string?> Get(string key);

    Task Set(string key, string value, TimeSpan ttl);

    Task Delete(string key);

    /// <summary>Borra las claves que casan con un patrón <c>*</c> y devuelve cuántas.</summary>
    Task<long> DeleteMatching(string pattern);
}`;
}

function redisStoreBody() {
  return `/// <summary>El store de la caché sobre Redis o Valkey (el mismo protocolo), con StackExchange.Redis.</summary>
/// <remarks>
/// Tres decisiones que no son las del cliente por defecto, y las tres son para que una caché caída no pueda tumbar ni
/// retener al servicio:
/// <list type="bullet">
/// <item>el servicio ARRANCA sin el store (<c>AbortOnConnectFail = false</c>): la conexión se abre en segundo plano y se
/// reintenta sin fin;</item>
/// <item><c>BacklogPolicy.FailFast</c>: sin conexión, una orden falla en el acto —y la lectura va al origen— en vez de
/// quedarse en cola hasta que vuelva el store (el default de la rama 3.x encola);</item>
/// <item>cada orden tiene su plazo (<c>AsyncTimeout</c>): un store que no contesta degrada a miss, no retiene la petición.</item>
/// </list>
/// </remarks>
public sealed partial class RedisCacheStore : ICacheStore, IAsyncDisposable
{
    private readonly Task<ConnectionMultiplexer> connection;

    private readonly ILogger<RedisCacheStore> logger;

    public RedisCacheStore(CacheSettings settings, ILogger<RedisCacheStore> logger)
    {
        ArgumentNullException.ThrowIfNull(settings);
        this.logger = logger;
        var options = new ConfigurationOptions
        {
            EndPoints = { { settings.Host, settings.Port } },
            AbortOnConnectFail = false,
            BacklogPolicy = BacklogPolicy.FailFast,
            ConnectTimeout = settings.ConnectTimeoutMs,
            AsyncTimeout = settings.CommandTimeoutMs,
            SyncTimeout = settings.CommandTimeoutMs,
            ClientName = "keel-cache"
        };
        connection = Connect(options, settings);
    }

    public async Task<string?> Get(string key) => await (await Database()).StringGetAsync(key);

    public async Task Set(string key, string value, TimeSpan ttl) => await (await Database()).StringSetAsync(key, value, ttl);

    public async Task Delete(string key) => await (await Database()).KeyDeleteAsync(key);

    public async Task<long> DeleteMatching(string pattern)
    {
        var multiplexer = await connection;
        var database = multiplexer.GetDatabase();
        long deleted = 0;
        foreach (var endpoint in multiplexer.GetEndPoints())
        {
            var server = multiplexer.GetServer(endpoint);
            if (!server.IsConnected || server.IsReplica)
            {
                continue;
            }
            var batch = new List<RedisKey>();
            // SCAN, por lotes: KEYS bloquearía el servidor con muchas claves.
            await foreach (var key in server.KeysAsync(pattern: pattern, pageSize: 200))
            {
                batch.Add(key);
                if (batch.Count == 200)
                {
                    deleted += await database.KeyDeleteAsync([.. batch]);
                    batch.Clear();
                }
            }
            if (batch.Count > 0)
            {
                deleted += await database.KeyDeleteAsync([.. batch]);
            }
        }
        return deleted;
    }

    public async ValueTask DisposeAsync()
    {
        if (connection.IsCompletedSuccessfully)
        {
            await connection.Result.DisposeAsync();
        }
    }

    private async Task<IDatabase> Database() => (await connection).GetDatabase();

    private async Task<ConnectionMultiplexer> Connect(ConfigurationOptions options, CacheSettings settings)
    {
        var multiplexer = await ConnectionMultiplexer.ConnectAsync(options);
        // Se escribe una vez por caída, no una por reintento.
        multiplexer.ConnectionFailed += (_, failure) => LogUnavailable(settings.Host, settings.Port, failure.FailureType.ToString());
        multiplexer.ConnectionRestored += (_, _) => LogRestored();
        if (!multiplexer.IsConnected)
        {
            LogUnavailable(settings.Host, settings.Port, "sin conexión al arrancar");
        }
        return multiplexer;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Caché no disponible ({Host}:{Port}): las lecturas van al origen hasta que vuelva ({Reason})")]
    private partial void LogUnavailable(string host, int port, string reason);

    [LoggerMessage(Level = LogLevel.Information, Message = "Caché disponible de nuevo")]
    private partial void LogRestored();
}`;
}

// ─── El adaptador ────────────────────────────────────────────────────────────────────────────────

function adapterBody(model) {
  const persistence = usesPersistence(model);
  const transactionsParam = persistence ? ', PersistenceTransactions? transactions = null' : '';
  const afterCommit = persistence
    ? `    /// <summary>Lo que cambia el store va DESPUÉS del commit: si la transacción revierte, no había nada que desalojar.</summary>
    private Task AfterCommit(Func<Task> work) => transactions is null ? work() : transactions.AfterCommitOrNow(work);`
    : `    /// <summary>Sin persistencia no hay commit que esperar.</summary>
    private static Task AfterCommit(Func<Task> work) => work();`;
  return `/// <summary>
/// Lo que la caché comparte entre peticiones: la carga en vuelo de cada entrada y la generación de cada caché. Es de la
/// instancia del servicio (singleton), no de la petición.
/// </summary>
public sealed class CacheState
{
    public ConcurrentDictionary<string, Lazy<Task<object?>>> Loading { get; } = new(StringComparer.Ordinal);

    public ConcurrentDictionary<string, long> Generations { get; } = new(StringComparer.Ordinal);

    public long Generation(ICachedOperation cache) => Generations.GetValueOrDefault(cache.Name);

    public void Bump(ICachedOperation cache) => Generations.AddOrUpdate(cache.Name, 1, (_, current) => current + 1);
}

/// <summary>
/// La caché de lectura sobre Redis/Valkey, con las claves de RedisCacheManager de keel-spring:
/// <c>&lt;caché&gt;${CACHE_ENTRY_SEPARATOR}&lt;clave&gt;</c>. Guarda la respuesta con el contrato del cable (WireJson) y la lee con él.
/// </summary>
/// <remarks>
/// Tres reglas, las de keel-spring: el store caído DEGRADA A MISS (su CacheErrorHandler); lo nulo no se guarda (su
/// <c>disableCachingNullValues()</c>); y una carga por entrada a la vez (su <c>sync = true</c>). Y una que keel-spring no
/// tiene y keel-nest sí: una carga que empezó ANTES de vaciar la caché no guarda lo que leyó, porque pudo leerlo antes del
/// commit que la vació y quedaría servido hasta el TTL. Solo dentro de este proceso: entre réplicas no hay forma de saberlo.
/// </remarks>
public sealed partial class RedisOperationCache(CacheState state, ILogger<RedisOperationCache> logger, ICacheStore? store = null${transactionsParam}) : ${OPERATION_CACHE_PORT}
{
    public async Task<T> GetOrLoad<T, TMessage>(CachedOperation<T, TMessage> cache, TMessage message, Func<CancellationToken, Task<T>> load, CacheLoadOptions<T>? options = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(cache);
        ArgumentNullException.ThrowIfNull(load);
        if (store is null)
        {
            return await load(cancellationToken);
        }
        var entry = EntryKey(cache, cache.KeyOf(message));
        var (hit, cached) = await Read<T>(cache, entry);${usesTelemetry(model) ? `
        // El ratio de acierto del panel: cache_gets_total{cache,result}, la serie que publica keel-spring.
        KeelTelemetry.Current?.CacheGet(cache.Name, hit);` : ''}
        if (hit)
        {
            return cached!;
        }
        var generation = state.Generation(cache);
        var pending = state.Loading.GetOrAdd(entry, _ => new Lazy<Task<object?>>(async () =>
        {
            var value = await load(cancellationToken);
            var keep = value is not null && (options?.Cacheable?.Invoke(value) ?? true);
            if (keep && state.Generation(cache) == generation)
            {
                await Write(cache, entry, value);
            }
            return value;
        }));
        try
        {
            return (T)(await pending.Value)!;
        }
        finally
        {
            state.Loading.TryRemove(new KeyValuePair<string, Lazy<Task<object?>>>(entry, pending));
        }
    }

    public Task Evict(ICachedOperation cache, string key, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(cache);
        return AfterCommit(async () =>
        {
            state.Bump(cache);
            if (store is null)
            {
                return;
            }
            try
            {
                await store.Delete(EntryKey(cache, key));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogUnavailable(cache.Name, "desalojar", "la entrada caducará por su TTL", error.Message);
            }
        });
    }

    public Task Clear(ICachedOperation cache, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(cache);
        return AfterCommit(async () =>
        {
            state.Bump(cache);
            if (store is null)
            {
                return;
            }
            try
            {
                await store.DeleteMatching(cache.Name + ${csString(CACHE_ENTRY_SEPARATOR)} + "*");
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogUnavailable(cache.Name, "vaciar", "sus entradas caducarán por su TTL", error.Message);
            }
        });
    }

    /// <summary>La clave en el store: <c>&lt;caché&gt;${CACHE_ENTRY_SEPARATOR}&lt;clave&gt;</c>, como RedisCacheManager.</summary>
    public static string EntryKey(ICachedOperation cache, string key)
    {
        ArgumentNullException.ThrowIfNull(cache);
        return cache.Name + ${csString(CACHE_ENTRY_SEPARATOR)} + key;
    }

    /// <summary>
    /// Una entrada leída, o un miss. Por aquí pasa también la entrada ilegible, que no es indisponibilidad: si un escenario
    /// de retención falla sin ningún error en la respuesta, este aviso es la única evidencia.
    /// </summary>
    private async Task<(bool Hit, T? Value)> Read<T>(ICachedOperation cache, string entry)
    {
        string? text;
        try
        {
            text = await store!.Get(entry);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogUnavailable(cache.Name, "leer", "se sirve desde el origen", error.Message);
            return (false, default);
        }
        if (text is null)
        {
            return (false, default);
        }
        try
        {
            var value = CacheCodec.Read<T>(text);
            return value is null ? (false, default) : (true, value);
        }
        catch (Exception error) when (error is JsonException or NotSupportedException or InvalidOperationException or ArgumentException)
        {
            LogUnreadable(cache.Name, error.Message);
            return (false, default);
        }
    }

    private async Task Write<T>(ICachedOperation cache, string entry, T value)
    {
        try
        {
            await store!.Set(entry, CacheCodec.Write(value), TimeSpan.FromSeconds(cache.TtlSeconds));
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogUnavailable(cache.Name, "escribir", "se sigue sin caché", error.Message);
        }
    }

${afterCommit}

    [LoggerMessage(Level = LogLevel.Warning, Message = "Caché {Cache} no disponible al {Action}: {Consequence} ({Reason})")]
    private partial void LogUnavailable(string cache, string action, string consequence, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Caché {Cache}: entrada ilegible, se sirve desde el origen ({Reason})")]
    private partial void LogUnreadable(string cache, string reason);
}`;
}

// ─── La invalidación ─────────────────────────────────────────────────────────────────────────────

function cacheInvalidationsFile(model) {
  const { namespace, path } = located(model, 'cache', 'CacheInvalidations');
  const usings = [namespaceOf(model, 'ports'), namespaceOf(model, 'appSupport'), namespaceOf(model, 'abstractions')];
  const operations = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const rows = cacheInvalidations(model).map((entry) => {
    const operation = operations.get(entry.operation);
    usings.push(messageNamespace(model, operation));
    const caches = entry.caches.map((cache) => `CachedOperations.${cacheMember(cachedOperations(model).find((candidate) => candidate.cacheName === cache.cacheName).operation)}`);
    return `        // ${entry.operation}: ${entry.caches.map((cache) => `${cache.cacheName} (por ${cache.events.join(', ')})`).join('; ')}\n        [typeof(${entry.messageClass})] = [${caches.join(', ')}],`;
  });
  const body = `/// <summary>
/// Qué cachés vacía cada operación al confirmar (keel-core/gen/cache-plan.js): la que EMITE uno de sus eventos de
/// <c>invalidatedBy</c> y la que DISPARA la suscripción a uno. Lo aplica el mediator, dentro de la transacción del caso de
/// uso (el vaciado espera al commit: si revierte, no se vacía nada).
/// </summary>
/// <remarks>
/// Se vacía la caché ENTERA: la clave es la entrada de la lectura (un slug, un id) y el evento no tiene por qué llevarla.
/// Invalida de más, nunca de menos —que es el error que no se ve: datos viejos hasta el TTL—.
/// </remarks>
public static class CacheInvalidations
{
    private static readonly Dictionary<Type, ICachedOperation[]> ByMessage = new()
    {
${rows.join('\n')}
    };

    /// <summary>Las cachés que vacía el mensaje al confirmar (ninguna, si no invalida nada).</summary>
    public static IReadOnlyList<ICachedOperation> Of(IMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return ByMessage.TryGetValue(message.GetType(), out var caches) ? caches : [];
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function registrationBody() {
  return `/// <summary>
/// La caché de lectura en el contenedor. Sin caché (perfil test) no hay store y toda lectura va al origen: el adaptador
/// se registra igual, porque los handlers que cachean lo reciben.
/// </summary>
public static class CacheRegistration
{
    public static IServiceCollection AddOperationCache(this IServiceCollection services, CacheSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddSingleton<CacheState>();
        if (settings.Enabled)
        {
            services.AddSingleton<ICacheStore, RedisCacheStore>();
        }
        // Por petición: espera al commit de la transacción del caso de uso, que es de la petición.
        services.AddScoped<${OPERATION_CACHE_PORT}, RedisOperationCache>();
        return services;
    }
}`;
}

// ─── Para quien compone otros archivos ───────────────────────────────────────────────────────────

/** Program.cs: lo que añade la caché al arranque. */
export function cacheProgram(model) {
  if (!usesCache(model)) return { usings: [], registration: '' };
  return {
    usings: [cacheNamespace(model)],
    registration: `
// La caché de lectura del diseño (use-cases.<op>.cache): el adaptador sobre Redis/Valkey y la configuración del perfil.
builder.Services.AddOperationCache(CacheSettings.From(configuration));`
  };
}

/** La consulta que enseña la nota del handler (keel-core/gen/cache-plan.js `cacheNote`). */
export function cacheCall(operation) {
  const param = operation.messageKind === 'query' ? 'query' : 'command';
  return `operationCache.GetOrLoad(CachedOperations.${cacheMember(operation.name)}, ${param}, ct => …, cancellationToken: cancellationToken)`;
}

// ─── La prueba emitida: el adaptador EJECUTADO contra un store en memoria, y la ida y vuelta de cada respuesta ──────

/**
 * `OperationCacheTests`: las reglas del adaptador (acierto, TTL, nulos, error de la carga, store caído, entrada ilegible,
 * una carga por entrada, el vaciado y la carga anterior a él, lo que no se puede guardar) y, por cada caché del diseño,
 * la IDA Y VUELTA de su respuesta con el contrato del cable: un JSON de muestra construido desde el tipo se lee y se vuelve
 * a escribir idéntico. Es lo que en keel-nest hace el lector por DTO; aquí lo hace System.Text.Json, y esta prueba es la
 * que dice que puede.
 */
export function cacheTestsFile(model, sln) {
  if (!usesCache(model)) return null;
  const operations = new Map((model.services ?? []).flatMap((service) => service.operations ?? []).map((operation) => [operation.name, operation]));
  const roundTrips = cachedOperations(model).map((cache) => {
    const operation = operations.get(cache.operation);
    return `    [Fact]
    public void LaRespuestaDe${cacheMember(cache.operation)}VuelveIgualDeLaCache() => AssertRoundTrip<${returnTypeOf(operation)}>();`;
  });
  const usings = [
    'System.Collections',
    'System.Reflection',
    'System.Text.Json',
    'System.Text.Json.Nodes',
    'System.Text.Json.Serialization',
    'Microsoft.Extensions.Logging.Abstractions',
    'Xunit',
    namespaceOf(model, 'ports'),
    namespaceOf(model, 'appSupport'),
    namespaceOf(model, 'dtos'),
    cacheNamespace(model)
  ];
  const body = String.raw`/// <summary>
/// La caché de lectura EJECUTADA sin red: el adaptador contra un store en memoria, y la ida y vuelta de cada respuesta
/// cacheada con el contrato del cable. Lo que dice un Redis o un Valkey DE VERDAD lo mide la red del generador (cache-check).
/// </summary>
public sealed class OperationCacheTests
{
    private sealed record Answer(string Value);

    private static readonly CachedOperation<Answer, string> Probe = new("servicio:prueba", 60, message => CacheKey.Of(message));

    private static CancellationToken Token => TestContext.Current.CancellationToken;

    /// <summary>Un store en memoria que apunta lo que le piden y puede caerse.</summary>
    private sealed class MemoryStore : ICacheStore
    {
        public Dictionary<string, (string Value, TimeSpan Ttl)> Entries { get; } = new(StringComparer.Ordinal);

        public bool Down { get; set; }

        public Task<string?> Get(string key) => Down ? throw new IOException("store caído") : Task.FromResult(Entries.TryGetValue(key, out var entry) ? entry.Value : null);

        public Task Set(string key, string value, TimeSpan ttl)
        {
            if (Down)
            {
                throw new IOException("store caído");
            }
            Entries[key] = (value, ttl);
            return Task.CompletedTask;
        }

        public Task Delete(string key)
        {
            Entries.Remove(key);
            return Task.CompletedTask;
        }

        public Task<long> DeleteMatching(string pattern)
        {
            var prefix = pattern.TrimEnd('*');
            var keys = Entries.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).ToList();
            keys.ForEach(key => Entries.Remove(key));
            return Task.FromResult((long)keys.Count);
        }
    }

    private static RedisOperationCache Cache(ICacheStore? store) => new(new CacheState(), NullLogger<RedisOperationCache>.Instance, store);

    [Fact]
    public async Task UnFalloCargaYGuardaConSuTtlYUnAciertoNoVuelveAlOrigen()
    {
        var store = new MemoryStore();
        var cache = Cache(store);
        var loads = 0;
        var first = await cache.GetOrLoad(Probe, "a", _ => { loads++; return Task.FromResult(new Answer("uno")); }, cancellationToken: Token);
        var second = await cache.GetOrLoad(Probe, "a", _ => { loads++; return Task.FromResult(new Answer("dos")); }, cancellationToken: Token);
        Assert.Equal("uno", first.Value);
        Assert.Equal("uno", second.Value);
        Assert.Equal(1, loads);
        var entry = Assert.Single(store.Entries);
        Assert.Equal("servicio:prueba::a", entry.Key);
        Assert.Equal(TimeSpan.FromSeconds(60), entry.Value.Ttl);
        Assert.Equal("""{"value":"uno"}""", entry.Value.Value);
    }

    [Fact]
    public async Task LoNuloYLoQueNoSePuedeGuardarSeSirvenSinGuardarse()
    {
        var store = new MemoryStore();
        var cache = Cache(store);
        Assert.Null(await cache.GetOrLoad<Answer?, string>(new("servicio:nulos", 60, message => message), "a", _ => Task.FromResult<Answer?>(null), cancellationToken: Token));
        var degraded = await cache.GetOrLoad(Probe, "b", _ => Task.FromResult(new Answer("degradada")), new CacheLoadOptions<Answer> { Cacheable = answer => answer.Value != "degradada" }, Token);
        Assert.Equal("degradada", degraded.Value);
        Assert.Empty(store.Entries);
    }

    [Fact]
    public async Task UnErrorDeLaCargaNoSeGuardaYSePropaga()
    {
        var store = new MemoryStore();
        await Assert.ThrowsAsync<InvalidOperationException>(() => Cache(store).GetOrLoad<Answer, string>(Probe, "a", _ => throw new InvalidOperationException("origen"), cancellationToken: Token));
        Assert.Empty(store.Entries);
    }

    [Fact]
    public async Task ElStoreCaidoDegradaAMissYLaLecturaVaAlOrigen()
    {
        var store = new MemoryStore { Down = true };
        var answer = await Cache(store).GetOrLoad(Probe, "a", _ => Task.FromResult(new Answer("origen")), cancellationToken: Token);
        Assert.Equal("origen", answer.Value);
    }

    [Fact]
    public async Task UnaEntradaIlegibleEsUnMiss()
    {
        var store = new MemoryStore();
        store.Entries["servicio:prueba::a"] = ("no es json", TimeSpan.FromSeconds(60));
        var answer = await Cache(store).GetOrLoad(Probe, "a", _ => Task.FromResult(new Answer("origen")), cancellationToken: Token);
        Assert.Equal("origen", answer.Value);
        Assert.Equal("""{"value":"origen"}""", store.Entries["servicio:prueba::a"].Value);
    }

    [Fact]
    public async Task DiezLecturasALaVezCarganUnaVez()
    {
        var cache = Cache(new MemoryStore());
        var gate = new TaskCompletionSource<Answer>(TaskCreationOptions.RunContinuationsAsynchronously);
        var loads = 0;
        var readers = Enumerable.Range(0, 10).Select(_ => cache.GetOrLoad(Probe, "a", _ => { Interlocked.Increment(ref loads); return gate.Task; }, cancellationToken: Token)).ToList();
        gate.SetResult(new Answer("una"));
        var answers = await Task.WhenAll(readers);
        Assert.Equal(1, loads);
        Assert.All(answers, answer => Assert.Equal("una", answer.Value));
    }

    [Fact]
    public async Task VaciarBorraSoloSuCacheYUnaCargaAnteriorNoGuardaLoQueLeyo()
    {
        var store = new MemoryStore();
        store.Entries["servicio:prueba::x"] = ("""{"value":"vieja"}""", TimeSpan.FromSeconds(60));
        store.Entries["servicio:otra::x"] = ("""{"value":"otra"}""", TimeSpan.FromSeconds(60));
        var cache = Cache(store);
        var gate = new TaskCompletionSource<Answer>(TaskCreationOptions.RunContinuationsAsynchronously);
        var loading = cache.GetOrLoad(Probe, "a", _ => gate.Task, cancellationToken: Token);
        await cache.Clear(Probe, Token);
        gate.SetResult(new Answer("leída antes del vaciado"));
        Assert.Equal("leída antes del vaciado", (await loading).Value);
        Assert.Equal(["servicio:otra::x"], store.Entries.Keys.ToArray());
    }

    [Fact]
    public async Task SinStoreTodaLecturaVaAlOrigen()
    {
        var loads = 0;
        var cache = Cache(null);
        await cache.GetOrLoad(Probe, "a", _ => { loads++; return Task.FromResult(new Answer("uno")); }, cancellationToken: Token);
        await cache.GetOrLoad(Probe, "a", _ => { loads++; return Task.FromResult(new Answer("uno")); }, cancellationToken: Token);
        Assert.Equal(2, loads);
    }

    [Fact]
    public void LaClaveTieneLaFormaDeLosOtrosDosServidores()
    {
        Assert.Equal("a:7:true:null:2026-01-02T03:04:05.006Z", CacheKey.Of("a", 7, true, null, new DateTimeOffset(2026, 1, 2, 3, 4, 5, 6, TimeSpan.Zero)));
        Assert.Equal("servicio:prueba::k", RedisOperationCache.EntryKey(Probe, "k"));
    }

ROUND_TRIPS

    /// <summary>
    /// Un JSON de muestra para el tipo (cada propiedad con un valor de su tipo, las listas con un elemento) se lee con el
    /// contrato del cable y se vuelve a escribir: tiene que salir IDÉNTICO. Si no, una respuesta que sale de la caché no es la
    /// que habría servido el origen.
    /// </summary>
    private static void AssertRoundTrip<T>()
    {
        // Con un valor en cada propiedad: lo escrito se lee y se vuelve a escribir idéntico.
        var full = SampleOf(typeof(T), 0, nulls: false)!.ToJsonString(WireJson.Options);
        Assert.Equal(full, CacheCodec.Write(CacheCodec.Read<T>(full)));
        // Con los nulos puestos: lo que escribe la caché (sin ellos, si el tipo los omite) se vuelve a leer.
        var written = CacheCodec.Write(CacheCodec.Read<T>(SampleOf(typeof(T), 0, nulls: true)!.ToJsonString(WireJson.Options)));
        Assert.Equal(written, CacheCodec.Write(CacheCodec.Read<T>(written)));
    }

    private static readonly NullabilityInfoContext Nullability = new();

    private static JsonNode? SampleOf(Type type, int depth, bool nulls)
    {
        var target = Nullable.GetUnderlyingType(type) ?? type;
        if (target == typeof(string)) return JsonValue.Create("texto-1");
        if (target == typeof(Guid)) return JsonValue.Create("0190f3a2-6c1e-7b3d-9a4f-2b8c1d0e5f61");
        if (target == typeof(int) || target == typeof(long)) return JsonValue.Create(7);
        if (target == typeof(decimal)) return JsonNode.Parse("12.50");
        if (target == typeof(bool)) return JsonValue.Create(true);
        if (target == typeof(DateTimeOffset)) return JsonValue.Create("2026-01-02T03:04:05.006Z");
        if (target == typeof(DateOnly)) return JsonValue.Create("2026-01-02");
        if (target == typeof(JsonElement)) return new JsonObject { ["a"] = 1 };
        if (target.IsEnum)
        {
            var first = target.GetFields(BindingFlags.Public | BindingFlags.Static)[0];
            return JsonValue.Create(first.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name ?? first.Name);
        }
        var element = target.IsGenericType && typeof(IEnumerable).IsAssignableFrom(target) ? target.GetGenericArguments()[0] : null;
        if (element is not null)
        {
            return new JsonArray(SampleOf(element, depth + 1, nulls));
        }
        if (depth > 8)
        {
            throw new InvalidOperationException($"{type.Name}: demasiado anidado para una muestra");
        }
        var json = new JsonObject();
        foreach (var property in target.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(property => property.CanRead && property.GetIndexParameters().Length == 0))
        {
            if (property.GetCustomAttribute<JsonIgnoreAttribute>() is not null)
            {
                continue;
            }
            var name = property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? JsonNamingPolicy.CamelCase.ConvertName(property.Name);
            var nullable = Nullable.GetUnderlyingType(property.PropertyType) is not null || Nullability.Create(property).ReadState == NullabilityState.Nullable;
            json[name] = nulls && nullable ? null : SampleOf(property.PropertyType, depth + 1, nulls);
        }
        return json;
    }
}`.replace('ROUND_TRIPS', roundTrips.join('\n\n'));
  return { path: `${sln.unitTests.dir}/OperationCacheTests.cs`, content: csFile({ namespace: sln.unitTests.name, usings, body }) };
}

// ─── El arnés: ClearCache() en FlowTest ──────────────────────────────────────────────────────────

/**
 * Vaciado de la caché a mitad de escenario. La orden es literalmente la que ejecuta `infra/reset-db.sh` (`cacheFlushCmd`,
 * neutral): un helper que borrase otro conjunto dejaría al escenario midiendo un estado que ningún flujo puede reproducir.
 * El mismo helper que el `clearCache()` de keel-spring y keel-nest.
 */
export function cacheHarnessMembers(model) {
  const entry = usesCache(model) && model.stack?.cache ? CACHES[model.stack.cache] : null;
  if (!entry) return [];
  return [
    `    /// <summary>
    /// Vacía las claves <c>${model.service.artifactId}:*</c> de la caché: las entradas cacheadas de cada operación. Es el subconjunto de
    /// caché del reset de cada flujo, con su misma orden. Vale para el Then que necesita medir un MISS a mitad de flujo —que
    /// un dato se volvió a pedir al origen tras invalidarse— sin llevarse por delante los datos de los escenarios anteriores.
    /// </summary>
    protected static void ClearCache() =>
        Run(Harness.ContainerRuntime(), ["exec", ${csString(devtoolsContainer(model.service.name))}, "sh", "-c", ${csString(cacheFlushCmd(entry, model.service))}], "¿Está la infraestructura arriba (bash infra/up.sh)?");`
  ];
}
