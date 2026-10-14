// RabbitMQ en keel-dotnet (incremento 9): lo que en el servidor de keel-spring ponen Spring Boot y build sin que el
// agente escriba nada, y que en .NET no pone nadie. El gemelo de `rabbitmq.js` de keel-nest:
//
//   · la TOPOLOGÍA de consumo y de publicación (`RabbitTopology.cs`), como DATOS de keel-core
//     (gen/messaging-plan.js): por cola, el exchange topic del canal de origen, la cola propia de este servicio enlazada
//     con `#` y su DLQ por argumentos `x-dead-letter-*`; por canal publicado, una cola durable enlazada con la routing
//     key de cada evento. Es la de `RabbitTopologyConfig` de keel-spring, con los mismos nombres. Y la política de
//     REINTENTO del listener (`rabbitListenerRetry`, neutral), con lo que no se reintenta: el rechazo de negocio
//     (DomainException) y el contrato incumplido;
//   · la CONEXIÓN (`RabbitConnection.cs`, RabbitMQ.Client 7): las mismas variables que keel-spring (RABBITMQ_HOST, _PORT,
//     _USERNAME, _PASSWORD, RABBITMQ_LISTENER_RECOVERY_INTERVAL_MS), el servicio arranca SIN broker y conecta en
//     segundo plano, recuperación automática de la conexión, publicación con confirmación del broker y `mandatory` (lo
//     que en Spring son `publisher-confirm-type: correlated` y `template.mandatory`), y un consumo que hace lo que el
//     contenedor de Spring: confirmar al terminar bien, reintentar en memoria con la curva del diseño y, agotado o no
//     reintentable, rechazar SIN reencolar (`default-requeue-rejected: false`), que es lo que lleva el mensaje a su DLQ.
//
// Lo que escribe el agente (skill keel-dotnet-rabbitmq) es lo mismo que en keel-spring: el dispatcher del outbox o los
// publishers best-effort sobre `RabbitConnection.Publish`, y los listeners sobre `RabbitConnection.Consume`. No declara
// topología.

import { rabbitListenerRetry } from 'keel-core/gen';
import { RABBIT_CONFIRM_TIMEOUT_MS, RABBIT_PREFETCH, RABBIT_RECOVERY_INTERVAL_MS, publishedChannels, rabbitTopology, rabbitYaml } from 'keel-core/gen/messaging-plan';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesRabbitMq, messagingNamespace } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export function generate(model) {
  if (!usesRabbitMq(model)) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'rabbitmq', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/rabbitmq.yaml`, content: rabbitYaml(profile) })),
    file('RabbitTopology', ['RabbitMQ.Client', namespaceOf(model, 'errors'), messagingNamespace(model)], topologyBody(model)),
    file('RabbitMqSettings', ['System.Globalization', configNamespace(model)], settingsBody()),
    file(
      'RabbitConnection',
      ['System.Text', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging', 'RabbitMQ.Client', 'RabbitMQ.Client.Events', 'RabbitMQ.Client.Exceptions', messagingNamespace(model)],
      connectionBody()
    )
  ];
}

// ─── La topología y el reintento ─────────────────────────────────────────────────────────────────

const list = (items) => (items.length === 0 ? '[]' : `[${items.map(csString).join(', ')}]`);

function topologyBody(model) {
  const topology = rabbitTopology(model);
  const retry = rabbitListenerRetry(model);
  const published = publishedChannels(model);
  const queues = topology.map(
    (entry) =>
      `        new(${csString(entry.source)}, ${csString(entry.queue)}, ${entry.deadLetter ? csString(entry.deadLetter) : 'null'}, ${entry.retriesNotFound ? 'true' : 'false'}, ${list(entry.subscriptions)})`
  );
  const channels = published.map((entry) => `        new(${csString(entry.channel)}, ${list(entry.events)})`);
  const retryLiteral = retry
    ? `new(${retry.attempts}, ${retry.initialMs}, ${Number.isInteger(retry.multiplier) ? `${retry.multiplier}.0` : retry.multiplier}, ${retry.maxDelayMs ?? 'null'})`
    : 'null';
  return `/// <summary>La topología de consumo de una cola de este servicio.</summary>
/// <param name="Source">El exchange (topic) del canal de origen, el del emisor.</param>
/// <param name="Queue">La cola PROPIA de este servicio, enlazada al exchange con '#'.</param>
/// <param name="DeadLetter">Su descarte, enlazado por argumentos x-dead-letter-*; null si ninguna suscripción lo declara.</param>
/// <param name="RetriesNotFound">¿Se reintenta aquí el «no existe» del caso de uso? Es el RETRIES_NOT_FOUND de keel-spring.</param>
/// <param name="Subscriptions">Las suscripciones del diseño que consumen de ella.</param>
public sealed record QueueTopology(string Source, string Queue, string? DeadLetter, bool RetriesNotFound, IReadOnlyList<string> Subscriptions);

/// <summary>Un canal del diseño en el que este servicio publica, con los eventos que viajan por él.</summary>
public sealed record PublishedChannel(string Channel, IReadOnlyList<string> Events);

/// <summary>El reintento del listener, de onFailure.retry (keel-core, rabbitListenerRetry).</summary>
public sealed record ListenerRetry(int Attempts, long InitialMs, double Multiplier, long? MaxDelayMs);

/// <summary>
/// La topología RabbitMQ del servicio: la MISMA que declara RabbitTopologyConfig en el servidor de keel-spring del diseño.
/// </summary>
/// <remarks>
/// <para>
/// El canal que nombra el diseño es el exchange del emisor, y de un exchange no se consume: cuelga de él una cola propia de
/// este servicio (dos servicios en el mismo canal necesitan colas distintas, o el broker les repartiría los mensajes). El
/// binding es '#' porque el canal transporta todo lo que publica su emisor: el filtro por tipo va en el listener.
/// </para>
/// <para>
/// Lo que este servicio PUBLICA: por canal, sus eventos. De ahí sale la topología de publicación —el exchange del
/// servicio (messaging.publishing.destination) y una cola durable por canal, nombrada como el canal y enlazada con la
/// routing key de cada uno de sus eventos—. Sin una cola enlazada, un exchange topic descarta en silencio lo publicado, y
/// con <c>mandatory</c> la publicación falla y el outbox reintenta hasta rendirse. Es también la cola de la que el arnés lee
/// lo publicado.
/// </para>
/// <para>
/// Es de BUILD: no la redeclares en un listener. Dos declaraciones de la misma cola con argumentos distintos hacen que
/// RabbitMQ rechace la segunda con PRECONDITION_FAILED.
/// </para>
/// </remarks>
public static class RabbitTopology
{
    public static IReadOnlyList<QueueTopology> Queues { get; } =
    [
${queues.join(',\n')}
    ];

    public static IReadOnlyList<PublishedChannel> Published { get; } =
    [
${channels.join(',\n')}
    ];

    /// <summary>
    /// El reintento ${retry ? `que declaran ${retry.subscriptions.join(', ')}` : 'de las suscripciones: ninguna lo declara, así que un fallo va al descarte al primer intento'}. Uno para todo el
    /// contenedor, como en keel-spring: con varias políticas gana la más paciente.
    /// </summary>
    public static ListenerRetry? Retry { get; } = ${retryLiteral};

    /// <summary>Los intentos de una entrega, el primero incluido.</summary>
    public static int ListenerAttempts(ListenerRetry? retry) => retry?.Attempts ?? 1;

    /// <summary>La espera antes del intento <c>attempt + 1</c>: initial·multiplier^(attempt-1), con su techo.</summary>
    public static long ListenerBackoffMs(int attempt, ListenerRetry? retry)
    {
        if (retry is null)
        {
            return 0;
        }
        var delay = retry.InitialMs * Math.Pow(retry.Multiplier, Math.Max(attempt - 1, 0));
        return retry.MaxDelayMs is { } max ? (long)Math.Min(delay, max) : (long)delay;
    }

    /// <summary>
    /// ¿Se reintenta este fallo? No el rechazo de negocio (DomainException): no se resuelve mejor dentro de un segundo, y
    /// peor, el reintento en memoria repite la MISMA entrega, así que un guard que reclama antes (TryRecord) encontraría el
    /// evento ya marcado y lo confirmaría sin que llegara nunca al descarte. Ni el contrato incumplido
    /// (MessageContractViolation): un mensaje mal formado no se vuelve válido.
    /// </summary>
    public static bool IsRetryable(Exception error, bool retriesNotFound)
    {
        // Salvo el «no existe» donde la cola lo admite: suele ser la carrera de orden de un consumo asíncrono (llegó antes
        // que el hecho del que depende) y el reintento la resuelve. Solo con guarda de dominio, que con TryRecord el
        // reintento encontraría el evento ya marcado.
        if (retriesNotFound && error is NotFoundException)
        {
            return true;
        }
        return error is not DomainException and not MessageContractViolation;
    }

    /// <summary>¿Reintenta <paramref name="queue"/> el «no existe»? Por el nombre con el que se consume, como la política de keel-spring.</summary>
    public static bool RetriesNotFoundOn(string queue) => Queues.Any(entry => entry.Queue == queue && entry.RetriesNotFound);

    /// <summary>
    /// Declara la topología: la de consumo y, con <paramref name="publishing"/>, la de publicación. Idempotente: se repite
    /// en cada conexión.
    /// </summary>
    public static async Task Declare(IChannel channel, MessagingSettings? publishing, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(channel);
        if (publishing is not null && Published.Count > 0)
        {
            await channel.ExchangeDeclareAsync(publishing.Destination, ExchangeType.Topic, durable: true, autoDelete: false, cancellationToken: cancellationToken);
            foreach (var entry in Published)
            {
                await channel.QueueDeclareAsync(entry.Channel, durable: true, exclusive: false, autoDelete: false, cancellationToken: cancellationToken);
                foreach (var eventName in entry.Events)
                {
                    var routingKey = publishing.RoutingKeys.TryGetValue(eventName, out var key)
                        ? key
                        : throw new InvalidOperationException($"Sin routing key para el evento {eventName} en la configuración de mensajería");
                    await channel.QueueBindAsync(entry.Channel, publishing.Destination, routingKey, cancellationToken: cancellationToken);
                }
            }
        }
        foreach (var entry in Queues)
        {
            await channel.ExchangeDeclareAsync(entry.Source, ExchangeType.Topic, durable: true, autoDelete: false, cancellationToken: cancellationToken);
            if (entry.DeadLetter is not null)
            {
                await channel.QueueDeclareAsync(entry.DeadLetter, durable: true, exclusive: false, autoDelete: false, cancellationToken: cancellationToken);
            }
            var arguments = entry.DeadLetter is null
                ? null
                : new Dictionary<string, object?> { ["x-dead-letter-exchange"] = string.Empty, ["x-dead-letter-routing-key"] = entry.DeadLetter };
            await channel.QueueDeclareAsync(entry.Queue, durable: true, exclusive: false, autoDelete: false, arguments: arguments, cancellationToken: cancellationToken);
            await channel.QueueBindAsync(entry.Queue, entry.Source, "#", cancellationToken: cancellationToken);
        }
    }
}`;
}

// ─── La conexión ─────────────────────────────────────────────────────────────────────────────────

function settingsBody() {
  return `/// <summary>La conexión con RabbitMQ del perfil activo, con las mismas variables que keel-spring.</summary>
/// <param name="Enabled">false en el perfil test: las pruebas de build arrancan sin broker.</param>
/// <param name="RecoveryInterval">El techo de la espera entre reconexiones (la recuperación del listener de keel-spring).</param>
/// <param name="ConfirmTimeout">Cuánto espera una publicación la confirmación del broker.</param>
public sealed record RabbitMqSettings(bool Enabled, string Host, int Port, string Username, string Password, TimeSpan RecoveryInterval, TimeSpan ConfirmTimeout)
{
    public static RabbitMqSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        string Text(string key, string fallback) => configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value : fallback;
        return new RabbitMqSettings(
            !string.Equals(configuration.Get("rabbitmq:enabled"), "false", StringComparison.OrdinalIgnoreCase),
            Text("rabbitmq:host", "localhost"),
            Positive(configuration.Get("rabbitmq:port"), 5672),
            Text("rabbitmq:username", "guest"),
            Text("rabbitmq:password", "guest"),
            TimeSpan.FromMilliseconds(Positive(configuration.Get("rabbitmq:listener:recovery-interval-ms"), ${RABBIT_RECOVERY_INTERVAL_MS})),
            TimeSpan.FromMilliseconds(Positive(configuration.Get("rabbitmq:publisher:confirm-timeout-ms"), ${RABBIT_CONFIRM_TIMEOUT_MS})));
    }

    private static int Positive(string? value, int fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"RabbitMQ: '{value}' no es un entero positivo");
    }
}`;
}

function connectionBody() {
  return `/// <summary>Un mensaje recibido de una cola, ya copiado: el cuerpo de la entrega solo vale mientras dura el callback.</summary>
/// <param name="Body">El cuerpo en UTF-8 (JSON con el contrato del cable).</param>
/// <param name="Type">El tipo nativo del mensaje (la propiedad type de AMQP), o null.</param>
/// <param name="Headers">Las cabeceras, con los valores de texto ya decodificados.</param>
public sealed record RabbitMessage(string Queue, string Body, string RoutingKey, string? Type, string? MessageId, IReadOnlyDictionary<string, string?> Headers)
{
    /// <summary>Una cabecera de texto, o null si no viene.</summary>
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
/// La conexión con RabbitMQ: una por proceso, con recuperación automática. Al conectar declara la topología de build
/// (RabbitTopology) y arranca los consumidores registrados. El servicio arranca SIN broker —como el de keel-spring—: la
/// conexión se intenta en segundo plano y se reintenta sin fin.
/// </summary>
/// <remarks>
/// Lo que escribe el agente usa dos métodos:
///   · Publish: con confirmación del broker y <c>mandatory</c>. Termina cuando el broker CONFIRMA; falla si no hay
///     conexión, si lo rechaza, si el mensaje no tenía cola a la que ir o si vence el plazo. Es lo que necesita el
///     dispatcher del outbox: marcar como publicado lo que el broker descartó es lo que el outbox existe para impedir;
///   · Consume: registra un consumidor de una cola de la topología. Confirma al terminar bien, reintenta en memoria con
///     la curva del diseño lo que es transitorio y rechaza sin reencolar el resto (va a la DLQ si la cola la tiene).
/// </remarks>
public sealed partial class RabbitConnection(RabbitMqSettings settings, MessagingSettings messaging, ILogger<RabbitConnection> logger) : IHostedService, IAsyncDisposable
{
    /// <summary>Cuánto espera el apagado a que la conexión se cierre.</summary>
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(5);

    private readonly List<(string Queue, Func<RabbitMessage, CancellationToken, Task> Handler)> consumers = [];

    private readonly Lock state = new();

    private readonly SemaphoreSlim confirmGate = new(1, 1);

    private readonly CancellationTokenSource stopping = new();

    private IConnection? connection;

    private IChannel? confirm;

    private Task? connecting;

    /// <summary>¿Hay conexión ahora mismo?</summary>
    public bool Connected => connection is { IsOpen: true };

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (settings.Enabled)
        {
            connecting = Task.Run(() => ConnectLoop(stopping.Token), CancellationToken.None);
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// Cierra la conexión y para los reintentos. Con un tope: un broker que no contesta al cierre no puede retener el
    /// apagado del servicio, que tiene su propio margen (server.shutdown-timeout).
    /// </summary>
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await stopping.CancelAsync();
        if (connecting is not null)
        {
            await connecting.WaitAsync(CloseTimeout, CancellationToken.None).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
        if (connection is { } open)
        {
            await open.CloseAsync(Constants.ReplySuccess, "apagado del servicio", CloseTimeout, false, CancellationToken.None).WaitAsync(CloseTimeout, CancellationToken.None).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (connection is not null)
        {
            await connection.DisposeAsync();
        }
        confirmGate.Dispose();
        stopping.Dispose();
    }

    /// <summary>Registra el consumidor de <paramref name="queue"/>: arranca con la conexión (y la recuperación lo rearranca).</summary>
    public void Consume(string queue, Func<RabbitMessage, CancellationToken, Task> handler)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        ArgumentNullException.ThrowIfNull(handler);
        IConnection? live;
        lock (state)
        {
            consumers.Add((queue, handler));
            live = connection;
        }
        if (live is not null)
        {
            _ = StartConsumerLogged(live, queue, handler);
        }
    }

    /// <summary>
    /// Publica <paramref name="payload"/> (JSON ya serializado con el contrato del cable) en <paramref name="exchange"/> con
    /// <paramref name="routingKey"/>, con <paramref name="type"/> como tipo nativo del mensaje (sobre él filtran los
    /// consumidores). Termina cuando el broker confirma; lanza BrokerUnavailableException si no salió.
    /// </summary>
    public async Task Publish(string exchange, string routingKey, string payload, string type, IReadOnlyDictionary<string, string>? headers = null, CancellationToken cancellationToken = default)
    {
        var channel = await ConfirmChannel(cancellationToken);
        var properties = new BasicProperties
        {
            Persistent = true,
            ContentType = "application/json",
            Type = type,
            MessageId = Guid.NewGuid().ToString(),
            Headers = headers?.ToDictionary(pair => pair.Key, pair => (object?)pair.Value)
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, stopping.Token);
        timeout.CancelAfter(settings.ConfirmTimeout);
        try
        {
            await channel.BasicPublishAsync(exchange, routingKey, mandatory: true, basicProperties: properties, body: Encoding.UTF8.GetBytes(payload), cancellationToken: timeout.Token);
        }
        catch (PublishException error)
        {
            throw new BrokerUnavailableException(
                error.IsReturn ? $"El mensaje no tenía cola en {exchange} con {routingKey}" : "RabbitMQ rechazó la publicación",
                error);
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new BrokerUnavailableException($"RabbitMQ no confirmó la publicación en {settings.ConfirmTimeout.TotalMilliseconds} ms", error);
        }
        catch (Exception error) when (error is OperationInterruptedException or AlreadyClosedException or BrokerUnreachableException)
        {
            throw new BrokerUnavailableException($"RabbitMQ no aceptó la publicación: {error.Message}", error);
        }
    }

    /// <summary>
    /// El canal de confirmaciones de la conexión viva, abierto bajo demanda. Un canal que el broker cierra (una publicación
    /// a un exchange que no existe lo hace) se reabre en la publicación siguiente.
    /// </summary>
    private async Task<IChannel> ConfirmChannel(CancellationToken cancellationToken)
    {
        var live = connection;
        if (live is not { IsOpen: true } || stopping.IsCancellationRequested)
        {
            throw new BrokerUnavailableException("RabbitMQ no está conectado");
        }
        await confirmGate.WaitAsync(cancellationToken);
        try
        {
            if (confirm is { IsOpen: true } open)
            {
                return open;
            }
            try
            {
                confirm = await live.CreateChannelAsync(
                    new CreateChannelOptions(publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true),
                    cancellationToken);
            }
            catch (Exception error) when (error is OperationInterruptedException or AlreadyClosedException)
            {
                throw new BrokerUnavailableException($"RabbitMQ no abrió el canal de confirmaciones: {error.Message}", error);
            }
            return confirm;
        }
        finally
        {
            confirmGate.Release();
        }
    }

    private async Task ConnectLoop(CancellationToken cancellationToken)
    {
        var factory = new ConnectionFactory
        {
            HostName = settings.Host,
            Port = settings.Port,
            UserName = settings.Username,
            Password = settings.Password,
            ClientProvidedName = messaging.Destination,
            AutomaticRecoveryEnabled = true,
            TopologyRecoveryEnabled = true,
            NetworkRecoveryInterval = settings.RecoveryInterval
        };
        var delay = TimeSpan.FromMilliseconds(200);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var opened = await factory.CreateConnectionAsync(cancellationToken);
                await using (var channel = await opened.CreateChannelAsync(cancellationToken: cancellationToken))
                {
                    await RabbitTopology.Declare(channel, messaging, cancellationToken);
                }
                opened.ConnectionShutdownAsync += (_, args) =>
                {
                    LogShutdown(args.ReplyText);
                    return Task.CompletedTask;
                };
                opened.RecoverySucceededAsync += (_, _) =>
                {
                    LogRecovered();
                    return Task.CompletedTask;
                };
                List<(string Queue, Func<RabbitMessage, CancellationToken, Task> Handler)> registered;
                lock (state)
                {
                    connection = opened;
                    registered = [.. consumers];
                }
                foreach (var (queue, handler) in registered)
                {
                    await StartConsumer(opened, queue, handler);
                }
                LogConnected();
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                LogConnectFailed(delay.TotalMilliseconds, error.Message);
                try
                {
                    await Task.Delay(delay, cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, settings.RecoveryInterval.TotalMilliseconds));
            }
        }
    }

    private async Task StartConsumerLogged(IConnection live, string queue, Func<RabbitMessage, CancellationToken, Task> handler)
    {
        try
        {
            await StartConsumer(live, queue, handler);
        }
        catch (Exception error)
        {
            LogConsumerFailed(queue, error.Message);
        }
    }

    private async Task StartConsumer(IConnection live, string queue, Func<RabbitMessage, CancellationToken, Task> handler)
    {
        var channel = await live.CreateChannelAsync(cancellationToken: stopping.Token);
        await channel.BasicQosAsync(prefetchSize: 0, prefetchCount: ${RABBIT_PREFETCH}, global: false, cancellationToken: stopping.Token);
        var retriesNotFound = RabbitTopology.RetriesNotFoundOn(queue);
        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += (_, delivery) => Deliver(channel, queue, delivery, handler, retriesNotFound);
        await channel.BasicConsumeAsync(queue, autoAck: false, consumer: consumer, cancellationToken: stopping.Token);
    }

    /// <summary>Lo que hace el contenedor de listeners de Spring con cada entrega.</summary>
    private async Task Deliver(IChannel channel, string queue, BasicDeliverEventArgs delivery, Func<RabbitMessage, CancellationToken, Task> handler, bool retriesNotFound)
    {
        var message = Copy(queue, delivery);
        var attempts = RabbitTopology.ListenerAttempts(RabbitTopology.Retry);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await handler(message, stopping.Token);
                await Settle(channel, delivery.DeliveryTag, accept: true);
                return;
            }
            catch (Exception error)
            {
                var reason = $"{error.GetType().Name}: {error.Message}";
                if (!RabbitTopology.IsRetryable(error, retriesNotFound) || attempt >= attempts || stopping.IsCancellationRequested)
                {
                    // Rechazo SIN reencolar: con DLQ declarada, el broker lo lleva al descarte.
                    LogDiscarded(delivery.RoutingKey, attempt, reason);
                    await Settle(channel, delivery.DeliveryTag, accept: false);
                    return;
                }
                LogRetrying(attempt, reason);
                await Task.Delay(TimeSpan.FromMilliseconds(RabbitTopology.ListenerBackoffMs(attempt, RabbitTopology.Retry)), CancellationToken.None);
            }
        }
    }

    /// <summary>Confirma o rechaza; con el canal ya cerrado (el broker se fue) no hay a quién: el broker lo reentregará.</summary>
    private async Task Settle(IChannel channel, ulong deliveryTag, bool accept)
    {
        try
        {
            if (accept)
            {
                await channel.BasicAckAsync(deliveryTag, multiple: false);
            }
            else
            {
                await channel.BasicNackAsync(deliveryTag, multiple: false, requeue: false);
            }
        }
        catch (Exception error) when (error is AlreadyClosedException or OperationInterruptedException)
        {
            LogSettleFailed(accept ? "confirmar" : "rechazar", error.Message);
        }
    }

    private static RabbitMessage Copy(string queue, BasicDeliverEventArgs delivery)
    {
        var headers = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (name, value) in delivery.BasicProperties.Headers ?? new Dictionary<string, object?>())
        {
            headers[name] = value switch
            {
                byte[] bytes => Encoding.UTF8.GetString(bytes),
                null => null,
                _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)
            };
        }
        return new RabbitMessage(
            queue,
            Encoding.UTF8.GetString(delivery.Body.Span),
            delivery.RoutingKey,
            delivery.BasicProperties.Type,
            delivery.BasicProperties.MessageId,
            headers);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "RabbitMQ: conectado, topología declarada")]
    private partial void LogConnected();

    [LoggerMessage(Level = LogLevel.Warning, Message = "RabbitMQ: no se pudo conectar, reintento en {DelayMs} ms ({Reason})")]
    private partial void LogConnectFailed(double delayMs, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "RabbitMQ: la conexión se cerró ({Reason})")]
    private partial void LogShutdown(string reason);

    [LoggerMessage(Level = LogLevel.Information, Message = "RabbitMQ: conexión recuperada")]
    private partial void LogRecovered();

    [LoggerMessage(Level = LogLevel.Error, Message = "RabbitMQ: no se pudo arrancar el consumidor de {Queue}: {Reason}")]
    private partial void LogConsumerFailed(string queue, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "RabbitMQ: mensaje de {RoutingKey} descartado tras {Attempts} intento(s): {Reason}")]
    private partial void LogDiscarded(string routingKey, int attempts, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "RabbitMQ: fallo procesando un mensaje (intento {Attempt}): {Reason}")]
    private partial void LogRetrying(int attempt, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "RabbitMQ: no se pudo {Action} un mensaje (canal cerrado): {Reason}")]
    private partial void LogSettleFailed(string action, string reason);
}`;
}
