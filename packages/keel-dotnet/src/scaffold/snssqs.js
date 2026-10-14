// SNS/SQS en keel-dotnet (incremento 9g): lo que en el servidor de keel-spring ponen Spring Cloud AWS, build y la skill
// keel-spring-snssqs, y que en .NET no pone nadie. El gemelo de `snssqs.js` de keel-nest:
//
//   · el CONSUMO como datos (`SnsSqsConsumption.cs`), de keel-core (gen/messaging-plan.js, `snsSqsConsumption`): por
//     suscripción, su cola propia, su DLQ y su `maxReceiveCount` —los MISMOS que siembra `infra/init-messaging.sh`—, y la
//     curva del reintento, que en SQS no la aplica la cola sino quien alarga la VISIBILIDAD del mensaje;
//   · la CONEXIÓN (`SnsSqsConnection.cs`) sobre el SDK de AWS para .NET (v4): las mismas variables que keel-spring
//     (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SNS_ENDPOINT, AWS_SQS_ENDPOINT); la publicación en SNS
//     con el tipo del evento como message attribute `eventType` y el ARN resuelto LISTANDO y exigiendo un suscriptor
//     confirmado —crear el topic al publicar publica en un topic sin suscriptores, y SNS descarta sin error—; y un
//     consumidor por suscripción que sondea su cola: borra al terminar bien, alarga la visibilidad con la curva del diseño
//     lo transitorio (y al agotar `maxReceiveCount` la RedrivePolicy lo lleva a la DLQ), y lo no reintentable lo lleva él
//     mismo a la DLQ.
//
// En AWS real la topología la crea la plataforma (IaC), no la aplicación. Lo que escribe el agente (skill
// keel-dotnet-snssqs) es lo mismo que en keel-spring: el dispatcher del outbox o los publishers best-effort sobre
// `SnsSqsConnection.Publish`, y un listener por suscripción sobre `SnsSqsConnection.Consume`.

import {
  SNSSQS_RECONNECT_INTERVAL_MS,
  SNS_MAX_ATTEMPTS,
  SNS_REQUEST_TIMEOUT_MS,
  SQS_MAX_MESSAGES,
  SQS_POLL_WAIT_SECONDS,
  snsSqsConsumption,
  snssqsYaml
} from 'keel-core/gen/messaging-plan';
import { csFile, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';
import { usesSnsSqs, messagingNamespace } from './messaging.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export function generate(model) {
  if (!usesSnsSqs(model)) return [];
  const file = (name, usings, body) => {
    const { namespace, path } = located(model, 'snssqs', name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  return [
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/snssqs.yaml`, content: snssqsYaml(profile) })),
    file('SnsSqsConsumption', [namespaceOf(model, 'errors'), messagingNamespace(model)], consumptionBody(model)),
    file('SnsSqsSettings', ['System.Globalization', configNamespace(model)], settingsBody()),
    file(
      'SnsSqsConnection',
      [
        'System.Globalization',
        'Amazon',
        'Amazon.Runtime',
        'Amazon.SimpleNotificationService',
        'Amazon.SimpleNotificationService.Model',
        'Amazon.SQS',
        'Amazon.SQS.Model',
        'Microsoft.Extensions.Hosting',
        'Microsoft.Extensions.Logging',
        messagingNamespace(model)
      ],
      connectionBody()
    )
  ];
}

// ─── El consumo y el reintento ───────────────────────────────────────────────────────────────────

const literal = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

function consumptionBody(model) {
  const entries = snsSqsConsumption(model).map(
    (entry) =>
      `        new(${csString(entry.subscription)}, ${csString(entry.queue)}, ${entry.deadLetterQueue ? csString(entry.deadLetterQueue) : 'null'}, ${entry.retriesNotFound}, ${entry.maxReceive}, ${entry.initialMs}, ${literal(entry.multiplier)}, ${entry.maxDelayMs ?? 'null'})`
  );
  return `/// <summary>Cómo consume una suscripción: su cola, su descarte y su reintento (los defaults del diseño).</summary>
/// <param name="Queue">La cola PROPIA de este servicio, suscrita al topic de la fuente con filtro por eventType.</param>
/// <param name="DeadLetterQueue">Su DLQ (RedrivePolicy de infra/init-messaging.sh); null si la suscripción no declara onFailure.deadLetter.</param>
/// <param name="RetriesNotFound">¿Se reintenta aquí el «no existe» del caso de uso?</param>
/// <param name="MaxReceive">Recepciones antes del descarte: onFailure.retry.maxAttempts (uno sin retry). Lo cuenta SQS.</param>
/// <param name="Multiplier">2 con backoff exponential (la curva de la skill keel-spring-snssqs); 1 con fixed.</param>
public sealed record SubscriptionConsumption(string Subscription, string Queue, string? DeadLetterQueue, bool RetriesNotFound, int MaxReceive, long InitialMs, double Multiplier, long? MaxDelayMs);

/// <summary>
/// El consumo de este servicio: las MISMAS colas, DLQ y recepciones que siembra infra/init-messaging.sh y que consume el
/// servidor de keel-spring del diseño. El perfil puede renombrar la cola (messaging.subscriptions.&lt;e&gt;.queue).
/// </summary>
public static class SnsSqsConsumption
{
    public static IReadOnlyList<SubscriptionConsumption> Subscriptions { get; } =
    [
${entries.join(',\n')}
    ];

    /// <summary>
    /// Cuántos segundos queda oculto un mensaje tras su recepción <paramref name="received"/> fallida:
    /// initial·multiplier^(n-1), con su techo, redondeado hacia arriba al segundo (SQS no admite menos). Es el backoff del
    /// diseño: SQS no tiene otro, y sin alargar la visibilidad el mensaje volvería a los 30 s fijos de la cola.
    /// </summary>
    public static int RetryVisibilitySeconds(SubscriptionConsumption consumption, int received)
    {
        ArgumentNullException.ThrowIfNull(consumption);
        var delay = consumption.InitialMs * Math.Pow(consumption.Multiplier, Math.Max(received - 1, 0));
        var capped = consumption.MaxDelayMs is { } max ? Math.Min(delay, max) : delay;
        return (int)Math.Min(Math.Max(Math.Ceiling(capped / 1000), 0), 43_200);
    }

    /// <summary>
    /// ¿Se reintenta este fallo? No el rechazo de negocio (DomainException) ni el contrato incumplido
    /// (MessageContractViolation): no mejoran con otra recepción, y repetirlos con un guard que reclama antes (TryRecord)
    /// haría que la segunda recepción encontrara el mensaje marcado y lo borrara sin que llegara nunca a la DLQ. SQS no
    /// distingue tipos de excepción: lo lleva a la DLQ la conexión.
    /// </summary>
    public static bool IsRetryable(Exception error, bool retriesNotFound)
    {
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
  return `/// <summary>La conexión con SNS/SQS del perfil activo, con las mismas variables que keel-spring.</summary>
/// <param name="Enabled">false en el perfil test: las pruebas de build arrancan sin broker.</param>
/// <param name="AccessKey">Credenciales estáticas; null para la cadena por defecto del SDK (un rol IAM en producción).</param>
/// <param name="SnsEndpoint">El endpoint de SNS: LocalStack fuera de producción; null para el de AWS de la región.</param>
/// <param name="PollWaitSeconds">El sondeo largo de SQS.</param>
/// <param name="ReconnectIntervalMs">La espera entre intentos mientras el broker o una cola no están.</param>
public sealed record SnsSqsSettings(
    bool Enabled,
    string Region,
    string? AccessKey,
    string? SecretKey,
    string? SnsEndpoint,
    string? SqsEndpoint,
    int PollWaitSeconds,
    int MaxMessagesPerPoll,
    int ReconnectIntervalMs)
{
    public static SnsSqsSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        string? Text(string key) => configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;
        var accessKey = Text("aws:credentials:access-key");
        var secretKey = Text("aws:credentials:secret-key");
        var withKeys = accessKey is not null && secretKey is not null;
        return new SnsSqsSettings(
            !string.Equals(configuration.Get("aws:enabled"), "false", StringComparison.OrdinalIgnoreCase),
            Text("aws:region") ?? "us-east-1",
            withKeys ? accessKey : null,
            withKeys ? secretKey : null,
            Text("aws:sns:endpoint"),
            Text("aws:sqs:endpoint"),
            Bounded(configuration.Get("aws:sqs:listener:poll-timeout-seconds"), ${SQS_POLL_WAIT_SECONDS}, 0, 20),
            Bounded(configuration.Get("aws:sqs:listener:max-messages-per-poll"), ${SQS_MAX_MESSAGES}, 1, 10),
            Bounded(configuration.Get("aws:reconnect-interval-ms"), ${SNSSQS_RECONNECT_INTERVAL_MS}, 1, int.MaxValue));
    }

    private static int Bounded(string? value, int fallback, int min, int max)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed >= min && parsed <= max
            ? parsed
            : throw new InvalidOperationException($"SNS/SQS: '{value}' tiene que ser un entero entre {min} y {max}");
    }
}`;
}

function connectionBody() {
  return `/// <summary>Un mensaje recibido de la cola: su cuerpo, sus message attributes y cuántas veces se ha recibido.</summary>
/// <param name="MessageId">El MessageId de SQS: cambia en cada reenvío a la cola, NO sirve para deduplicar.</param>
/// <param name="Body">El cuerpo tal cual viajó (con raw delivery, el JSON de la envoltura si lo publicó un servicio Keel).</param>
/// <param name="Attributes">Los message attributes (eventType y los que declare el contrato), como cadenas.</param>
/// <param name="ReceiveCount">ApproximateReceiveCount: 1 en la primera entrega.</param>
public sealed record SqsMessage(string MessageId, string Body, IReadOnlyDictionary<string, string> Attributes, int ReceiveCount)
{
    /// <summary>Un message attribute de texto, o null si no viene.</summary>
    public string? Attribute(string name) => Attributes.TryGetValue(name, out var value) ? value : null;
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
/// La conexión con SNS/SQS: un cliente de cada, y un bucle de sondeo por suscripción. El servicio arranca SIN broker
/// —como el de keel-spring—: el sondeo reintenta mientras la cola no existe o LocalStack no responde.
/// </summary>
/// <remarks>
/// Lo que escribe el agente usa dos métodos:
///   · Publish: publica en el topic con sus message attributes y termina cuando SNS lo acepta; lanza
///     BrokerUnavailableException si el topic no existe, no tiene ningún suscriptor confirmado o SNS no responde. Es lo que
///     necesita el dispatcher del outbox: dar por publicado lo que SNS descartó por no tener a quién entregar es lo que el
///     outbox existe para impedir;
///   · Consume: registra el consumidor de una suscripción (su cola). Borra el mensaje al terminar bien; alarga su
///     visibilidad con la curva del diseño si el fallo es transitorio (al agotar maxReceiveCount, la RedrivePolicy lo lleva
///     a la DLQ); y lo no reintentable lo lleva directamente a la DLQ si la hay, o lo registra y lo borra.
/// </remarks>
public sealed partial class SnsSqsConnection : IHostedService, IDisposable
{
    private readonly SnsSqsSettings settings;
    private readonly MessagingSettings messaging;
    private readonly ILogger<SnsSqsConnection> logger;
    private readonly List<Subscriber> subscribers = [];
    private readonly List<Task> polls = [];
    private readonly Lock state = new();
    private readonly CancellationTokenSource stopping = new();
    /// <summary>El ARN de cada topic, solo cuando ya se vio con un suscriptor confirmado.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> topicArns = new(StringComparer.Ordinal);
    private readonly AmazonSimpleNotificationServiceClient sns;
    private readonly AmazonSQSClient sqs;
    private bool started;

    public SnsSqsConnection(SnsSqsSettings settings, MessagingSettings messaging, ILogger<SnsSqsConnection> logger)
    {
        ArgumentNullException.ThrowIfNull(settings);
        this.settings = settings;
        this.messaging = messaging;
        this.logger = logger;
        // Los plazos de una llamada a SNS: los de la skill keel-spring-snssqs (${SNS_REQUEST_TIMEOUT_MS} ms, ${SNS_MAX_ATTEMPTS} intentos). Sin ellos
        // el SDK reintenta puertas adentro con su política, y ese tiempo se suma al backoff del relay.
        var snsConfig = new AmazonSimpleNotificationServiceConfig { Timeout = TimeSpan.FromMilliseconds(${SNS_REQUEST_TIMEOUT_MS}), MaxErrorRetry = ${SNS_MAX_ATTEMPTS - 1} };
        // El plazo de una recepción tiene que pasar del sondeo largo, o cada sondeo vacío sería un error.
        var sqsConfig = new AmazonSQSConfig { Timeout = TimeSpan.FromSeconds(settings.PollWaitSeconds + 10) };
        Endpoint(snsConfig, settings.SnsEndpoint);
        Endpoint(sqsConfig, settings.SqsEndpoint);
        if (settings.AccessKey is not null && settings.SecretKey is not null)
        {
            var credentials = new BasicAWSCredentials(settings.AccessKey, settings.SecretKey);
            sns = new AmazonSimpleNotificationServiceClient(credentials, snsConfig);
            sqs = new AmazonSQSClient(credentials, sqsConfig);
        }
        else
        {
            sns = new AmazonSimpleNotificationServiceClient(snsConfig);
            sqs = new AmazonSQSClient(sqsConfig);
        }
    }

    private void Endpoint(ClientConfig config, string? endpoint)
    {
        if (endpoint is null)
        {
            config.RegionEndpoint = RegionEndpoint.GetBySystemName(settings.Region);
            return;
        }
        // LocalStack: el endpoint explícito, firmado para la región del perfil.
        config.ServiceURL = endpoint;
        config.AuthenticationRegion = settings.Region;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!settings.Enabled)
        {
            return Task.CompletedTask;
        }
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

    /// <summary>Para los sondeos (corta el que esté esperando), con un tope: el apagado tiene su propio margen.</summary>
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await stopping.CancelAsync();
        Task[] running;
        lock (state)
        {
            running = [.. polls];
        }
        await Task.WhenAll(running).WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    public void Dispose()
    {
        sns.Dispose();
        sqs.Dispose();
        stopping.Dispose();
    }

    /// <summary>Registra el consumidor de la suscripción <paramref name="subscription"/> (su NOMBRE en el diseño): arranca con la conexión.</summary>
    public void Consume(string subscription, Func<SqsMessage, CancellationToken, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        var consumption = SnsSqsConsumption.Subscriptions.FirstOrDefault(entry => entry.Subscription == subscription);
        if (consumption is null || !messaging.Subscriptions.TryGetValue(subscription, out var configured))
        {
            throw new ArgumentException($"'{subscription}' no es una suscripción de este servicio. Declaradas: {string.Join(", ", SnsSqsConsumption.Subscriptions.Select(entry => entry.Subscription))}");
        }
        var subscriber = new Subscriber(consumption, configured.Queue ?? consumption.Queue, handler);
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
    /// Publica <paramref name="payload"/> (JSON ya serializado con el contrato del cable) en el topic <paramref name="topic"/>
    /// (su NOMBRE), con <paramref name="attributes"/> como message attributes —<c>eventType</c> es obligatorio: sobre él
    /// filtran las suscripciones—. Termina cuando SNS lo acepta; lanza BrokerUnavailableException si no salió.
    /// </summary>
    public async Task Publish(string topic, string payload, IReadOnlyDictionary<string, string> attributes, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(attributes);
        if (stopping.IsCancellationRequested)
        {
            throw new BrokerUnavailableException("SNS/SQS: la conexión se está cerrando");
        }
        if (!attributes.TryGetValue("eventType", out var eventType) || string.IsNullOrEmpty(eventType))
        {
            throw new ArgumentException("SNS: falta el message attribute eventType, y sin él ninguna suscripción recibe el mensaje", nameof(attributes));
        }
        var arn = await TopicArn(topic, cancellationToken);
        var messageAttributes = attributes.ToDictionary(pair => pair.Key, pair => new Amazon.SimpleNotificationService.Model.MessageAttributeValue { DataType = "String", StringValue = pair.Value });
        try
        {
            await sns.PublishAsync(new PublishRequest { TopicArn = arn, Message = payload, MessageAttributes = messageAttributes }, cancellationToken);
        }
        catch (Exception error) when (error is AmazonServiceException or AmazonClientException or HttpRequestException or TaskCanceledException)
        {
            // Un topic que desapareció (LocalStack reiniciado sin resembrar) obliga a resolverlo de nuevo.
            topicArns.TryRemove(topic, out _);
            throw new BrokerUnavailableException($"SNS no aceptó la publicación en {topic}: {error.Message}", error);
        }
    }

    /// <summary>
    /// El ARN de un topic que EXISTE y tiene al menos un suscriptor confirmado. Nunca se crea: SNS entrega en el momento, y
    /// un topic sin suscriptores descarta lo publicado sin decir nada.
    /// </summary>
    private async Task<string> TopicArn(string topic, CancellationToken cancellationToken)
    {
        if (topicArns.TryGetValue(topic, out var cached))
        {
            return cached;
        }
        try
        {
            string? arn = null;
            string? next = null;
            do
            {
                var page = await sns.ListTopicsAsync(new ListTopicsRequest { NextToken = next }, cancellationToken);
                arn = page.Topics?.FirstOrDefault(candidate => candidate.TopicArn?.EndsWith($":{topic}", StringComparison.Ordinal) == true)?.TopicArn;
                next = page.NextToken;
            }
            while (arn is null && next is not null);
            if (arn is null)
            {
                throw new BrokerUnavailableException($"SNS: el topic {topic} no existe");
            }
            var subscriptions = await sns.ListSubscriptionsByTopicAsync(new ListSubscriptionsByTopicRequest { TopicArn = arn }, cancellationToken);
            var confirmed = (subscriptions.Subscriptions ?? []).Any(subscription => !string.IsNullOrEmpty(subscription.SubscriptionArn) && subscription.SubscriptionArn != "PendingConfirmation");
            if (!confirmed)
            {
                throw new BrokerUnavailableException($"SNS: el topic {topic} todavía no tiene ningún suscriptor confirmado");
            }
            topicArns[topic] = arn;
            return arn;
        }
        catch (Exception error) when (error is AmazonServiceException or AmazonClientException or HttpRequestException or TaskCanceledException)
        {
            throw new BrokerUnavailableException($"SNS no resolvió el topic {topic}: {error.Message}", error);
        }
    }

    private void Start(Subscriber subscriber)
    {
        var poll = Task.Run(() => Poll(subscriber), CancellationToken.None);
        lock (state)
        {
            polls.Add(poll);
        }
    }

    private async Task Poll(Subscriber subscriber)
    {
        string? queueUrl = null;
        string? deadLetterUrl = null;
        var polling = false;
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                queueUrl ??= (await sqs.GetQueueUrlAsync(subscriber.Queue, stopping.Token)).QueueUrl;
                if (subscriber.Consumption.DeadLetterQueue is { } deadLetter)
                {
                    deadLetterUrl ??= (await sqs.GetQueueUrlAsync(deadLetter, stopping.Token)).QueueUrl;
                }
                var received = await sqs.ReceiveMessageAsync(
                    new ReceiveMessageRequest
                    {
                        QueueUrl = queueUrl,
                        MaxNumberOfMessages = settings.MaxMessagesPerPoll,
                        WaitTimeSeconds = settings.PollWaitSeconds,
                        MessageAttributeNames = ["All"],
                        MessageSystemAttributeNames = ["ApproximateReceiveCount"]
                    },
                    stopping.Token);
                if (!polling)
                {
                    polling = true;
                    LogPolling(subscriber.Consumption.Subscription, subscriber.Queue);
                }
                foreach (var message in received.Messages ?? [])
                {
                    if (stopping.IsCancellationRequested)
                    {
                        break;
                    }
                    await Deliver(subscriber, queueUrl, deadLetterUrl, message);
                }
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error) when (error is AmazonServiceException or AmazonClientException or HttpRequestException or TaskCanceledException)
            {
                // La cola o el broker no están (LocalStack reiniciado, la topología sin sembrar): se resuelve otra vez.
                polling = false;
                queueUrl = null;
                deadLetterUrl = null;
                LogPollFailed(subscriber.Queue, error.Message);
                try
                {
                    await Task.Delay(settings.ReconnectIntervalMs, stopping.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    /// <summary>Lo que hacen Spring Cloud AWS (ack ON_SUCCESS) y el ErrorHandler de la skill keel-spring-snssqs con cada mensaje.</summary>
    private async Task Deliver(Subscriber subscriber, string queueUrl, string? deadLetterUrl, Message message)
    {
        var inbound = ToInbound(message);
        var consumption = subscriber.Consumption;
        try
        {
            await subscriber.Handler(inbound, stopping.Token);
            await sqs.DeleteMessageAsync(queueUrl, message.ReceiptHandle, CancellationToken.None);
            return;
        }
        catch (Exception error) when (!stopping.IsCancellationRequested)
        {
            var reason = $"{error.GetType().Name}: {error.Message}";
            if (!SnsSqsConsumption.IsRetryable(error, consumption.RetriesNotFound))
            {
                if (deadLetterUrl is not null)
                {
                    await sqs.SendMessageAsync(new SendMessageRequest { QueueUrl = deadLetterUrl, MessageBody = message.Body ?? "", MessageAttributes = message.MessageAttributes }, CancellationToken.None);
                    LogDeadLetteredNow(subscriber.Queue, consumption.DeadLetterQueue!, reason);
                }
                else
                {
                    LogDiscardedNow(subscriber.Queue, reason);
                }
                await sqs.DeleteMessageAsync(queueUrl, message.ReceiptHandle, CancellationToken.None);
                return;
            }
            if (inbound.ReceiveCount >= consumption.MaxReceive)
            {
                if (deadLetterUrl is null)
                {
                    // Sin RedrivePolicy volvería para siempre: se registra y se borra, como en los demás brokers.
                    LogDiscarded(subscriber.Queue, inbound.ReceiveCount, reason);
                    await sqs.DeleteMessageAsync(queueUrl, message.ReceiptHandle, CancellationToken.None);
                    return;
                }
                // Agotado: visible ya, y la RedrivePolicy lo lleva a la DLQ en la próxima recepción.
                LogExhausted(subscriber.Queue, consumption.MaxReceive, consumption.DeadLetterQueue!, reason);
                await ChangeVisibility(queueUrl, message.ReceiptHandle, 0);
                return;
            }
            LogRetrying(subscriber.Queue, inbound.ReceiveCount, reason);
            await ChangeVisibility(queueUrl, message.ReceiptHandle, SnsSqsConsumption.RetryVisibilitySeconds(consumption, inbound.ReceiveCount));
        }
        catch (Exception)
        {
            // Apagándose: sin desenlace, vuelve a la cola al vencer su visibilidad.
        }
    }

    private async Task ChangeVisibility(string queueUrl, string receipt, int seconds)
    {
        try
        {
            await sqs.ChangeMessageVisibilityAsync(queueUrl, receipt, seconds, CancellationToken.None);
        }
        catch (Exception error) when (error is AmazonServiceException or AmazonClientException or HttpRequestException)
        {
            // Si no se pudo alargar, vuelve al vencer la visibilidad de la cola: más tarde, pero vuelve.
            LogVisibilityFailed(error.Message);
        }
    }

    private static SqsMessage ToInbound(Message message)
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (name, value) in message.MessageAttributes ?? [])
        {
            if (value.StringValue is not null)
            {
                attributes[name] = value.StringValue;
            }
        }
        var count = message.Attributes is not null && message.Attributes.TryGetValue("ApproximateReceiveCount", out var raw)
            && int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : 1;
        return new SqsMessage(message.MessageId ?? "", message.Body ?? "", attributes, count);
    }

    private sealed record Subscriber(SubscriptionConsumption Consumption, string Queue, Func<SqsMessage, CancellationToken, Task> Handler);

    [LoggerMessage(Level = LogLevel.Information, Message = "SQS: consumidor de {Subscription} en {Queue}")]
    private partial void LogPolling(string subscription, string queue);

    [LoggerMessage(Level = LogLevel.Warning, Message = "SQS: no se pudo sondear {Queue} ({Reason}); se reintenta")]
    private partial void LogPollFailed(string queue, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "SQS: mensaje de {Queue} llevado a {DeadLetter} sin reintento: {Reason}")]
    private partial void LogDeadLetteredNow(string queue, string deadLetter, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "SQS: mensaje de {Queue} descartado sin reintento; la suscripción no declara dead-letter: {Reason}")]
    private partial void LogDiscardedNow(string queue, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "SQS: mensaje de {Queue} descartado tras {Received} recepción(es); la suscripción no declara dead-letter: {Reason}")]
    private partial void LogDiscarded(string queue, int received, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "SQS: mensaje de {Queue} agotó sus {MaxReceive} recepción(es); va a {DeadLetter}: {Reason}")]
    private partial void LogExhausted(string queue, int maxReceive, string deadLetter, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "SQS: fallo procesando un mensaje de {Queue} (recepción {Received}): {Reason}")]
    private partial void LogRetrying(string queue, int received, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "SQS: no se pudo cambiar la visibilidad de un mensaje ({Reason})")]
    private partial void LogVisibilityFailed(string reason);
}`;
}
