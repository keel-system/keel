// Kafka en keel-dotnet (incremento 9f): lo que en el servidor de keel-spring ponen Spring Boot y build sin que el agente
// escriba nada, y que en .NET no pone nadie. El gemelo de `kafka.js` de keel-nest:
//
//   · el CONSUMO como datos (`KafkaConsumption.cs`), de keel-core (gen/messaging-plan.js, `kafkaConsumption`): por
//     suscripción, su topic y su consumer group (`<servicio>-<evento>`), si descarta en `<topic>.DLT`, y el REINTENTO
//     del consumidor (`kafkaListenerRetry`, neutral): la curva del `DeadLetterConfig` de keel-spring, con lo que no se
//     reintenta —el rechazo de negocio y el contrato incumplido—;
//   · la CONEXIÓN (`KafkaConnection.cs`) sobre Confluent.Kafka (librdkafka): las mismas variables que keel-spring
//     (KAFKA_BOOTSTRAP_SERVERS y los plazos del productor de keel-core/gen/infra-catalog.js), un productor que espera el
//     ack de todas las réplicas con idempotencia (lo que kafka-clients 3 trae por defecto en Spring), un consumidor por
//     suscripción que hace lo que el `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` de keel-spring —reintentar
//     en memoria y, agotado o no reintentable, publicar en `<topic>.DLT` solo los topics que lo declaran, con los
//     headers de Spring Kafka—, y el arranque SIN broker: librdkafka conecta en segundo plano y reintenta solo.
//
// Lo que escribe el agente (skill keel-dotnet-kafka) es lo mismo que en keel-spring: el dispatcher del outbox o los
// publishers best-effort sobre `KafkaConnection.Publish`, y un listener por SUSCRIPCIÓN sobre `KafkaConnection.Consume`.
// No crea topics: los autocrea el broker de infra/ con el primer mensaje y en producción los gobierna la plataforma.

import { KAFKA_PRODUCER_TIMEOUTS } from 'keel-core/gen/infra-catalog';
import { kafkaListenerRetry } from 'keel-core/gen';
import { KAFKA_DEFAULT_METADATA_REFRESH_MS, KAFKA_RECONNECT_INTERVAL_MS, kafkaConsumption, kafkaYaml } from 'keel-core/gen/messaging-plan';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesKafka, messagingNamespace } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export function generate(model) {
  if (!usesKafka(model)) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'kafka', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/kafka.yaml`, content: kafkaYaml(profile) })),
    file('KafkaConsumption', [namespaceOf(model, 'errors'), messagingNamespace(model)], consumptionBody(model)),
    file('KafkaSettings', ['System.Globalization', configNamespace(model)], settingsBody()),
    file('KafkaConnection', ['System.Buffers.Binary', 'System.Text', 'Confluent.Kafka', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging', messagingNamespace(model)], connectionBody())
  ];
}

// ─── El consumo y el reintento ───────────────────────────────────────────────────────────────────

const literal = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

function consumptionBody(model) {
  const consumption = kafkaConsumption(model);
  const retry = kafkaListenerRetry(model);
  const declared = retry.deadLetteredTopics.length > 0;
  const entries = consumption.map(
    (entry) => `        new(${csString(entry.subscription)}, ${csString(entry.topic)}, ${csString(entry.groupId)}, ${entry.deadLetter}, ${entry.retriesNotFound})`
  );
  return `/// <summary>Cómo consume una suscripción: los defaults del diseño (el perfil puede renombrar topic y grupo).</summary>
/// <param name="Topic">El topic de la fuente, del que se consume directamente (en Kafka no hay cola intermedia).</param>
/// <param name="GroupId">Su consumer group: uno por suscripción, para que cada una reciba el topic entero.</param>
/// <param name="DeadLetter">¿Publica en <c>&lt;topic&gt;.DLT</c> lo que agota sus reintentos? Por topic: basta con que una suscripción lo declare.</param>
/// <param name="RetriesNotFound">¿Se reintenta aquí el «no existe» del caso de uso? Es el RETRIES_NOT_FOUND de keel-spring.</param>
public sealed record SubscriptionConsumption(string Subscription, string Topic, string GroupId, bool DeadLetter, bool RetriesNotFound);

/// <summary>El reintento del consumidor (keel-core, kafkaListenerRetry).</summary>
public sealed record ListenerRetry(int Attempts, long InitialMs, double Multiplier, long? MaxDelayMs);

/// <summary>
/// El consumo de este servicio: el MISMO que el del servidor de keel-spring del diseño (los grupos de
/// <c>messaging.subscriptions.&lt;clave&gt;.group-id</c> y el DEAD_LETTERED de su DeadLetterConfig). Los topics no los crea
/// la aplicación: en infra/ los autocrea el broker con el primer mensaje, y en producción los aprovisiona la plataforma.
/// </summary>
public static class KafkaConsumption
{
    public static IReadOnlyList<SubscriptionConsumption> Subscriptions { get; } =
    [
${entries.join(',\n')}
    ];

    /// <summary>
    /// ${
      declared
        ? `El reintento de las suscripciones con descarte (${model.subscriptions.filter((sub) => sub.deadLetter).map((sub) => sub.name).join(', ')}), aplicado a todas: uno para todo el\n    /// servicio, como el DefaultErrorHandler de keel-spring, y con varias políticas gana la más paciente.`
        : 'Ninguna suscripción declara descarte: rige el DefaultErrorHandler por defecto de Spring Kafka, diez intentos\n    /// seguidos sin espera, y después se registra y se confirma.'
    }
    /// </summary>
    public static ListenerRetry Retry { get; } = new(${retry.attempts}, ${retry.initialMs}, ${literal(retry.multiplier)}, ${retry.maxDelayMs ?? 'null'});

    /// <summary>El destino de descarte de un topic: la convención de Spring Kafka.</summary>
    public static string DeadLetterTopic(string topic) => topic + ".DLT";

    /// <summary>La espera antes del intento <c>attempt + 1</c>: initial·multiplier^(attempt-1), con su techo.</summary>
    public static long ListenerBackoffMs(int attempt, ListenerRetry retry)
    {
        ArgumentNullException.ThrowIfNull(retry);
        var delay = retry.InitialMs * Math.Pow(retry.Multiplier, Math.Max(attempt - 1, 0));
        return retry.MaxDelayMs is { } max ? (long)Math.Min(delay, max) : (long)delay;
    }

    /// <summary>
    /// ¿Se reintenta este fallo? No el rechazo de negocio (DomainException) ni el contrato incumplido
    /// (MessageContractViolation): son el <c>addNotRetryableExceptions(DomainException.class, IllegalArgumentException.class)</c>
    /// de keel-spring. No mejoran dentro de un segundo, y el reintento en memoria repite la MISMA entrega: un guard que
    /// reclama antes (TryRecord) la encontraría ya marcada y la confirmaría sin que llegara nunca al descarte.
    /// </summary>
    public static bool IsRetryable(Exception error, bool retriesNotFound)
    {
        // Salvo el «no existe» donde la suscripción lo admite: suele ser la carrera de orden de un consumo asíncrono.
        if (retriesNotFound && error is NotFoundException)
        {
            return true;
        }
        return error is not DomainException and not MessageContractViolation;
    }
}`;
}

// ─── La conexión ─────────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `/// <summary>La conexión con Kafka del perfil activo, con las mismas variables que keel-spring.</summary>
/// <param name="Enabled">false en el perfil test: las pruebas de build arrancan sin broker.</param>
/// <param name="DeliveryTimeoutMs">Cuánto puede retener el productor un envío sin confirmar (delivery.timeout.ms).</param>
/// <param name="MetadataRefreshIntervalMs">Cada cuánto refresca el consumidor los metadatos de sus topics (ver kafka.yaml).</param>
/// <param name="ReconnectIntervalMs">La espera entre intentos de publicar en el descarte mientras el broker no está.</param>
public sealed record KafkaSettings(bool Enabled, string BootstrapServers, int DeliveryTimeoutMs, int RequestTimeoutMs, int MetadataRefreshIntervalMs, int ReconnectIntervalMs)
{
    public static KafkaSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var servers = configuration.Get("kafka:bootstrap-servers");
        return new KafkaSettings(
            !string.Equals(configuration.Get("kafka:enabled"), "false", StringComparison.OrdinalIgnoreCase),
            string.IsNullOrWhiteSpace(servers) ? "localhost:9092" : servers.Trim(),
            Positive(configuration.Get("kafka:producer:delivery-timeout-ms"), ${KAFKA_PRODUCER_TIMEOUTS.delivery.default}),
            Positive(configuration.Get("kafka:producer:request-timeout-ms"), ${KAFKA_PRODUCER_TIMEOUTS.request.default}),
            Positive(configuration.Get("kafka:consumer:metadata-refresh-interval-ms"), ${KAFKA_DEFAULT_METADATA_REFRESH_MS}),
            Positive(configuration.Get("kafka:reconnect-interval-ms"), ${KAFKA_RECONNECT_INTERVAL_MS}));
    }

    private static int Positive(string? value, int fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"Kafka: '{value}' no es un entero positivo");
    }
}`;
}

function connectionBody() {
  return `/// <summary>Un mensaje recibido, ya leído: la clave y el valor como texto y los headers como cadenas.</summary>
/// <param name="Key">La clave del registro (la routing key, si lo publicó un servicio Keel); null si no trae.</param>
/// <param name="Value">El valor tal cual viajó (el JSON de la envoltura, si lo publicó un servicio Keel).</param>
public sealed record KafkaMessage(string Topic, int Partition, long Offset, string? Key, string Value, IReadOnlyDictionary<string, string> Headers)
{
    /// <summary>Un header de texto (el último, si viene repetido), o null si no viene.</summary>
    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;
}

/// <summary>El broker no está disponible ahora: la publicación no salió y hay que reintentarla.</summary>
public sealed class BrokerUnavailableException : Exception
{
    public BrokerUnavailableException()
    {
    }

    public BrokerUnavailableException(string message)
        : base(message)
    {
    }

    public BrokerUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// La conexión con Kafka: un productor y un consumidor por suscripción, cada uno en su propio hilo. El servicio arranca
/// SIN broker —como el de keel-spring—: librdkafka conecta en segundo plano y se reconecta solo si el broker se va y
/// vuelve.
/// </summary>
/// <remarks>
/// Lo que escribe el agente usa dos métodos:
///   · Publish: termina cuando el broker CONFIRMA (acks de todas las réplicas, productor idempotente); falla con
///     BrokerUnavailableException si no hay broker o si vence delivery.timeout.ms. Es lo que necesita el dispatcher del
///     outbox: marcar como publicado lo que el broker no confirmó es lo que el outbox existe para impedir;
///   · Consume: registra el consumidor de una suscripción (por su NOMBRE en el diseño), con su consumer group. Confirma
///     (el offset avanza) al terminar bien; reintenta en memoria con la curva del diseño lo transitorio; y lo agotado o no
///     reintentable lo publica en <c>&lt;topic&gt;.DLT</c> si el topic lo declara, o lo registra y lo confirma si no.
/// </remarks>
public sealed partial class KafkaConnection(KafkaSettings settings, MessagingSettings messaging, ILogger<KafkaConnection> logger) : IHostedService, IDisposable
{
    /// <summary>Cuánto espera el apagado a que cada consumidor salga de su grupo y el productor vacíe su cola.</summary>
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(5);

    private readonly List<Subscriber> subscribers = [];

    private readonly Lock state = new();

    private readonly CancellationTokenSource stopping = new();

    private IProducer<string?, byte[]>? producer;

    private bool started;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!settings.Enabled)
        {
            return Task.CompletedTask;
        }
        producer = new ProducerBuilder<string?, byte[]>(new ProducerConfig
        {
            BootstrapServers = settings.BootstrapServers,
            Acks = Acks.All,
            EnableIdempotence = true,
            MessageTimeoutMs = settings.DeliveryTimeoutMs,
            RequestTimeoutMs = settings.RequestTimeoutMs
        })
            .SetErrorHandler((_, error) => LogClientError(error.Reason))
            .SetLogHandler((_, message) => LogClient(message.Name, message.Message))
            .Build();
        List<Subscriber> registered;
        lock (state)
        {
            started = true;
            registered = [.. subscribers];
        }
        foreach (var subscriber in registered)
        {
            Start(subscriber);
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// Para los consumidores (cada uno sale de su grupo) y vacía el productor. Con un tope: un broker que no contesta no
    /// puede retener el apagado del servicio, que tiene su propio margen (server.shutdown-timeout).
    /// </summary>
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await stopping.CancelAsync();
        List<Subscriber> registered;
        lock (state)
        {
            registered = [.. subscribers];
        }
        foreach (var subscriber in registered)
        {
            subscriber.Thread?.Join(CloseTimeout);
        }
        producer?.Flush(CloseTimeout);
    }

    public void Dispose()
    {
        producer?.Dispose();
        stopping.Dispose();
    }

    /// <summary>Registra el consumidor de la suscripción <paramref name="subscription"/> (su NOMBRE en el diseño): arranca con la conexión.</summary>
    public void Consume(string subscription, Func<KafkaMessage, CancellationToken, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        var consumption = KafkaConsumption.Subscriptions.FirstOrDefault(entry => entry.Subscription == subscription);
        if (consumption is null || !messaging.Subscriptions.TryGetValue(subscription, out var configured))
        {
            throw new ArgumentException($"'{subscription}' no es una suscripción de este servicio. Declaradas: {string.Join(", ", KafkaConsumption.Subscriptions.Select(entry => entry.Subscription))}");
        }
        var subscriber = new Subscriber(subscription, configured.Topic, configured.GroupId ?? consumption.GroupId, consumption.DeadLetter, consumption.RetriesNotFound, handler);
        bool start;
        lock (state)
        {
            subscribers.Add(subscriber);
            start = started;
        }
        if (start)
        {
            Start(subscriber);
        }
    }

    /// <summary>
    /// Publica <paramref name="payload"/> (JSON ya serializado con el contrato del cable) en <paramref name="topic"/> con
    /// <paramref name="key"/> como clave del registro. Termina cuando el broker confirma; lanza BrokerUnavailableException
    /// si no salió.
    /// </summary>
    public Task Publish(string topic, string? key, string payload, IReadOnlyDictionary<string, string>? headers = null, CancellationToken cancellationToken = default)
    {
        var raw = new Headers();
        foreach (var (name, value) in headers ?? new Dictionary<string, string>())
        {
            raw.Add(name, Encoding.UTF8.GetBytes(value));
        }
        return Send(topic, key, Encoding.UTF8.GetBytes(payload), raw, cancellationToken);
    }

    private async Task Send(string topic, string? key, byte[] value, Headers headers, CancellationToken cancellationToken)
    {
        var live = producer;
        if (live is null || stopping.IsCancellationRequested)
        {
            throw new BrokerUnavailableException("Kafka no está conectado");
        }
        try
        {
            await live.ProduceAsync(topic, new Message<string?, byte[]> { Key = key, Value = value, Headers = headers }, cancellationToken);
        }
        catch (ProduceException<string?, byte[]> error)
        {
            throw new BrokerUnavailableException($"Kafka no confirmó la publicación en {topic}: {error.Error.Reason}", error);
        }
        catch (KafkaException error)
        {
            throw new BrokerUnavailableException($"Kafka no aceptó la publicación en {topic}: {error.Error.Reason}", error);
        }
    }

    private void Start(Subscriber subscriber)
    {
        subscriber.Thread = new Thread(() => Loop(subscriber)) { IsBackground = true, Name = $"kafka-{subscriber.Subscription}" };
        subscriber.Thread.Start();
    }

    private void Loop(Subscriber subscriber)
    {
        using var consumer = new ConsumerBuilder<string?, byte[]>(new ConsumerConfig
        {
            BootstrapServers = settings.BootstrapServers,
            GroupId = subscriber.GroupId,
            // earliest: un grupo nuevo lee lo publicado antes de unirse. Con latest, lo que llega mientras el grupo se
            // forma se pierde (y un escenario que entrega al abrir el flujo, también).
            AutoOffsetReset = AutoOffsetReset.Earliest,
            EnableAutoCommit = true,
            // El offset se guarda a mano DESPUÉS del desenlace: lo que no lo tuvo se vuelve a entregar.
            EnableAutoOffsetStore = false,
            TopicMetadataRefreshIntervalMs = settings.MetadataRefreshIntervalMs
        })
            .SetErrorHandler((_, error) => LogClientError(error.Reason))
            .SetLogHandler((_, message) => LogClient(message.Name, message.Message))
            .Build();
        consumer.Subscribe(subscriber.Topic);
        LogConsumerStarted(subscriber.Subscription, subscriber.Topic, subscriber.GroupId);
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                ConsumeResult<string?, byte[]> result;
                try
                {
                    result = consumer.Consume(stopping.Token);
                }
                catch (ConsumeException error) when (!error.Error.IsFatal)
                {
                    // El topic que aún no existe (lo crea el primer mensaje) o el broker que se fue: librdkafka sigue.
                    LogConsumeError(subscriber.Subscription, error.Error.Reason);
                    continue;
                }
                if (result?.Message is null)
                {
                    continue;
                }
                if (Deliver(subscriber, result))
                {
                    consumer.StoreOffset(result);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Apagándose.
        }
        finally
        {
            consumer.Close();
        }
    }

    /// <summary>
    /// Lo que hace el DefaultErrorHandler de keel-spring con cada mensaje. Devuelve si hubo desenlace: sin él (apagándose,
    /// o el descarte no se pudo escribir) el offset no avanza y el mensaje se vuelve a entregar.
    /// </summary>
    private bool Deliver(Subscriber subscriber, ConsumeResult<string?, byte[]> result)
    {
        var message = Copy(result);
        var attempts = KafkaConsumption.Retry.Attempts;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                subscriber.Handler(message, stopping.Token).GetAwaiter().GetResult();
                return true;
            }
            catch (Exception error) when (!stopping.IsCancellationRequested)
            {
                var reason = $"{error.GetType().Name}: {error.Message}";
                if (!KafkaConsumption.IsRetryable(error, subscriber.RetriesNotFound) || attempt >= attempts)
                {
                    return Recover(subscriber, result, error, attempt, reason);
                }
                LogRetrying(result.Topic, attempt, reason);
                if (stopping.Token.WaitHandle.WaitOne(TimeSpan.FromMilliseconds(KafkaConsumption.ListenerBackoffMs(attempt, KafkaConsumption.Retry))))
                {
                    return false;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    /// <summary>El DeadLetterPublishingRecoverer de keel-spring: la clave, el valor y los headers originales, y los suyos.</summary>
    private bool Recover(Subscriber subscriber, ConsumeResult<string?, byte[]> result, Exception error, int attempts, string reason)
    {
        if (!subscriber.DeadLetter)
        {
            LogDiscarded(result.Topic, attempts, reason);
            return true;
        }
        var target = KafkaConsumption.DeadLetterTopic(result.Topic);
        var headers = new Headers();
        foreach (var header in result.Message.Headers ?? [])
        {
            headers.Add(header.Key, header.GetValueBytes());
        }
        // Los headers de Spring Kafka, con su misma codificación (la partición en 4 bytes y el offset en 8, big-endian):
        // quien vigila los descartes de los tres servidores lee lo mismo.
        var partition = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(partition, result.Partition.Value);
        var offset = new byte[8];
        BinaryPrimitives.WriteInt64BigEndian(offset, result.Offset.Value);
        headers.Add("kafka_dlt-original-topic", Encoding.UTF8.GetBytes(result.Topic));
        headers.Add("kafka_dlt-original-partition", partition);
        headers.Add("kafka_dlt-original-offset", offset);
        headers.Add("kafka_dlt-original-consumer-group", Encoding.UTF8.GetBytes(subscriber.GroupId));
        headers.Add("kafka_dlt-exception-fqcn", Encoding.UTF8.GetBytes(error.GetType().FullName ?? error.GetType().Name));
        headers.Add("kafka_dlt-exception-message", Encoding.UTF8.GetBytes(error.Message));
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                Send(target, result.Message.Key, result.Message.Value ?? [], headers, stopping.Token).GetAwaiter().GetResult();
                LogDeadLettered(result.Topic, target, attempts, reason);
                return true;
            }
            catch (BrokerUnavailableException failure)
            {
                // Sin descarte escrito no hay desenlace: se insiste, y al apagar se suelta sin confirmar.
                LogDeadLetterFailed(target, failure.Message);
                if (stopping.Token.WaitHandle.WaitOne(settings.ReconnectIntervalMs))
                {
                    return false;
                }
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }
        return false;
    }

    private static KafkaMessage Copy(ConsumeResult<string?, byte[]> result)
    {
        var headers = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var header in result.Message.Headers ?? [])
        {
            headers[header.Key] = Encoding.UTF8.GetString(header.GetValueBytes() ?? []);
        }
        return new KafkaMessage(
            result.Topic,
            result.Partition.Value,
            result.Offset.Value,
            result.Message.Key,
            Encoding.UTF8.GetString(result.Message.Value ?? []),
            headers);
    }

    private sealed class Subscriber(string subscription, string topic, string groupId, bool deadLetter, bool retriesNotFound, Func<KafkaMessage, CancellationToken, Task> handler)
    {
        public string Subscription { get; } = subscription;

        public string Topic { get; } = topic;

        public string GroupId { get; } = groupId;

        public bool DeadLetter { get; } = deadLetter;

        public bool RetriesNotFound { get; } = retriesNotFound;

        public Func<KafkaMessage, CancellationToken, Task> Handler { get; } = handler;

        public Thread? Thread { get; set; }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Kafka: consumidor de {Subscription} en {Topic} (grupo {GroupId})")]
    private partial void LogConsumerStarted(string subscription, string topic, string groupId);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Kafka: {Name}: {Message}")]
    private partial void LogClient(string name, string message);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Kafka: {Reason}")]
    private partial void LogClientError(string reason);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Kafka: el consumidor de {Subscription} no pudo leer ({Reason}); sigue")]
    private partial void LogConsumeError(string subscription, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Kafka: fallo procesando un mensaje de {Topic} (intento {Attempt}): {Reason}")]
    private partial void LogRetrying(string topic, int attempt, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "Kafka: mensaje de {Topic} descartado tras {Attempts} intento(s); el diseño no declara dead-letter para esta suscripción: {Reason}")]
    private partial void LogDiscarded(string topic, int attempts, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "Kafka: mensaje de {Topic} llevado a {Target} tras {Attempts} intento(s): {Reason}")]
    private partial void LogDeadLettered(string topic, string target, int attempts, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Kafka: no se pudo publicar en {Target} ({Reason}); se reintenta")]
    private partial void LogDeadLetterFailed(string target, string reason);
}`;
}
