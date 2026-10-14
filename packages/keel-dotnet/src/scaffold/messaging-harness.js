// La mensajería en el ARNÉS de integración de keel-dotnet (incrementos 9c y 9f): lo que una prueba de flujo usa para
// entregar un mensaje a una suscripción, leer lo publicado y lo descartado, tumbar y levantar el broker, y fabricar las
// precondiciones del outbox. Son los helpers del AbstractFlowIT de keel-spring y de `flow.ts` de keel-nest, con los
// mismos nombres en PascalCase: `Deliver<Sub>`, `PublishedMessages`, `DeadLetterMessages`, `PurgeMessages`,
// `StopBroker`/`StartBroker`, `DeadLetteredEvents` y `AbandonOutboxEvent`. La API es la MISMA con los dos brokers; lo que
// cambia es la fontanería de `BrokerHarness`.
//
// Los comandos con los que se habla con el broker NO se escriben aquí: salen de keel-core/gen/broker-probes.js —los
// mismos que ejecutan los arneses de keel-spring y keel-nest y los `broker-check`—, renderizados a C# con
// `renderParts`/`spliceBody`. Viajan por el contenedor devtools de infra/, que está en la red del compose.
//
// El servidor es un PROCESO aparte (caja negra), como en keel-spring y no como en keel-nest: lo rendido del outbox y su
// abandono se leen y fabrican en la base (outbox_event), y la espera a que el servidor esté conectado se le pregunta al
// broker: en RabbitMQ, sus conexiones, por el nombre que declara la conexión del servicio; en Kafka, sus consumer groups,
// con la API de administración (lo que hace el AbstractFlowIT de keel-spring).
//
// Kafka no tiene purga (kcat no borra registros): el aislamiento entre flujos es una MARCA DE OFFSET por canal y por
// topic de descarte, que se fija al abrir cada flujo — la misma que los arneses de keel-spring y keel-nest.

import {
  ENDPOINTS,
  PROBE_BODY_FILE,
  RECORD_FORMAT,
  UNKNOWN_TOPIC,
  deliverParts,
  deliverShell,
  expr,
  hole,
  offsetsParts,
  purgeParts,
  rabbitProbeBody,
  rabbitPublishBody,
  readParts,
  renderParts,
  shellQuote,
  spliceBody
} from 'keel-core/gen/broker-probes';
import { BROKERS, KAFKA_PRODUCER_TIMEOUTS, brokerContainer, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { deadLetterDestination, subscriptionDestination } from 'keel-core/gen';
import { OUTBOX_RELAY, parameterValue } from 'keel-core/gen/messaging-stores';
import { groupEnv, kafkaConsumption, publishedChannels, topicEnv } from 'keel-core/gen/messaging-plan';
import { csFile, csMember, csString } from './render.js';
import { usesDotnetOutbox, usesKafka, usesRabbitMq } from './messaging.js';

/** ¿Lleva el arnés la mensajería? Con los brokers que keel-dotnet genera. */
export function usesMessagingHarness(model) {
  return usesRabbitMq(model) || usesKafka(model);
}

/** El nombre con el que la conexión del servicio se presenta al broker: lo busca el arnés entre sus conexiones. */
export function connectionName(model) {
  return model.service.name;
}

const cs = (parts) => renderParts(parts, csString);

/** El Support/Messaging.cs del proyecto de flujos. */
export function messagingHarnessCs(model, namespace) {
  if (!usesMessagingHarness(model)) return null;
  const kafka = usesKafka(model);
  const body = `${brokerMessageBody()}

// ── Mensajería (${kafka ? 'Kafka' : 'RabbitMQ'}) ────────────────────────────────────────────────────────────────────────
//
// Los comandos salen de keel-core/gen/broker-probes.js: los mismos que usan los arneses de keel-spring y keel-nest y los
// que ejecuta broker-check. Viajan por el contenedor devtools, que ve el broker por la red del compose.
${flowTestBody(model)}

${kafka ? kafkaHarnessBody(model) : rabbitHarnessBody(model)}`;
  const usings = ['System.Globalization', 'System.Text', 'System.Text.Json'];
  if (kafka) usings.push('Confluent.Kafka', 'Confluent.Kafka.Admin');
  return csFile({ namespace, usings, body });
}

function brokerMessageBody() {
  return `/// <summary>Un mensaje leído del broker: su routing key (en Kafka, la clave del registro), sus propiedades (en Kafka, sus headers) y su cuerpo.</summary>
public sealed record BrokerMessage(string RoutingKey, JsonElement Properties, string Body)
{
    /// <summary>El cuerpo leído como JSON (la envoltura Keel: <c>Payload.GetProperty("metadata")</c>), o null si no lo es.</summary>
    public JsonElement? Payload
    {
        get
        {
            try
            {
                using var document = JsonDocument.Parse(Body);
                return document.RootElement.Clone();
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    /// <summary>El <c>metadata.eventId</c> de la envoltura Keel, o null.</summary>
    public string? EventId => Metadata("eventId");

    /// <summary>El <c>metadata.eventType</c> de la envoltura Keel, o null.</summary>
    public string? EventType => Metadata("eventType");

    private string? Metadata(string name) =>
        Payload is { ValueKind: JsonValueKind.Object } payload && payload.TryGetProperty("metadata", out var metadata) && metadata.TryGetProperty(name, out var value)
            ? value.GetString()
            : null;
}`;
}

function flowTestBody(model) {
  const kafka = usesKafka(model);
  const outbox = usesDotnetOutbox(model);
  return `public abstract partial class FlowTest
{
    /// <summary>
    /// Lo publicado en un canal del diseño desde el último reset (hasta <paramref name="count"/>). Con outbox, espera antes
    /// a que el relay entregue lo que tenga pendiente: si no, lo que se lee depende de la fase del relay. Leer no consume:
    /// un escenario puede afirmar dos veces sobre el mismo mensaje.
    /// </summary>
    protected static Task<IReadOnlyList<BrokerMessage>> PublishedMessages(string channel, int count = 50) => BrokerHarness.PublishedAsync(channel, count);

    /// <summary>
    /// Lo que acabó en el descarte de una suscripción desde el último reset. Úsalo también —y sobre todo— para la aserción
    /// NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
    /// </summary>
    protected static IReadOnlyList<BrokerMessage> DeadLetterMessages(string subscription, int count = 50) => BrokerHarness.DeadLetters(subscription, count);

    /// <summary>
    /// ${kafka ? '«Vacía» un canal publicado o el descarte de una suscripción: Kafka no borra, así que mueve su marca al final y lo\n    /// anterior deja de leerse.' : 'Vacía un canal publicado (o la cola de una suscripción, por su nombre).'} El reset de estado ya lo hace al abrir el flujo; repítelo
    /// justo antes de la acción cuyo Then afirma que NO se publica nada.
    /// </summary>
    protected static Task PurgeMessages(string channelOrSubscription) => BrokerHarness.PurgeAsync(channelOrSubscription);

    /// <summary>
    /// ${kafka
      ? 'Publica un mensaje crudo en un topic (el de una fuente), con <paramref name="key"/> como clave del registro. El cuerpo\n    /// se colapsa a una línea: kcat manda un mensaje por línea.'
      : 'Publica un mensaje crudo en un exchange (el canal de una fuente), con <paramref name="key"/> como message_id y routing\n    /// key. Falla si RabbitMQ no lo enrutó a ninguna cola: lo acepta con 200 y <c>"routed":false</c>, y sin esto el escenario\n    /// moriría mucho después en un timeout que habla de otra cosa.'}
    /// </summary>
    protected static void DeliverMessage(string destination, string key, string body, IReadOnlyDictionary<string, string>? headers = null) =>
        BrokerHarness.Deliver(destination, key, body, headers ?? new Dictionary<string, string>());
${(model.subscriptions ?? []).map((sub) => deliverMethod(sub)).join('')}
    /// <summary>Detiene el broker (el escenario del canal indisponible). Las lecturas devuelven vacío mientras tanto.</summary>
    protected static Task StopBroker() => BrokerHarness.StopAsync();

    /// <summary>Lo vuelve a levantar y espera a que la conexión del servicio se recupere.</summary>
    protected static Task StartBroker() => BrokerHarness.StartAsync();

    /// <summary>El broker arriba y el servidor conectado a él; falla diciéndolo si no llega.</summary>
    protected static Task AssertBrokerConnected() => BrokerHarness.PrepareAsync();
${outbox ? outboxMembers() : ''}}`;
}

// ── Lo común a los dos brokers ───────────────────────────────────────────────────────────────────

function commonPlumbing(model, broker) {
  const service = model.service.name;
  return `    private const string DevtoolsContainer = ${csString(devtoolsContainer(service))};
    private const string BrokerContainer = ${csString(brokerContainer(service, broker))};
    // Los cuerpos viajan por un archivo del contenedor devtools: UNO POR LLAMADA (el nombre fijo de keel-core más un
    // sufijo único). Con uno fijo, dos entregas lanzadas a la vez por un escenario de carrera se pisaban el cuerpo
    // (corrida stock-reservation-events, FL-CMP-001-C: no falló porque los dos eran iguales).
    private static readonly string BodyFilePrefix = ${csString(PROBE_BODY_FILE.replace(/\.json$/, ''))};
    private static readonly TimeSpan BrokerTimeout = TimeSpan.FromSeconds(90);

    /// <summary>Los canales que publica este servicio.</summary>
    public static readonly string[] PublishedChannels = [${publishedChannels(model).map((entry) => csString(entry.channel)).join(', ')}];

    private static bool brokerStopped;

    public static string Devtools(IEnumerable<string> arguments, string? input = null)
    {
        List<string> all = ["exec"];
        if (input is not null) all.Add("-i");
        all.Add(DevtoolsContainer);
        all.AddRange(arguments);
        return Harness.Run(Harness.ContainerRuntime(), all, "¿Está la infraestructura arriba (bash infra/up.sh)?", input);
    }

    /// <summary>Un archivo dentro del contenedor devtools: los cuerpos viajan así, nunca embebidos en la línea de comandos.</summary>
    private static void CopyToDevtools(string content, string file) => Devtools(["sh", "-c", $"cat > {file}"], content);

    /// <summary>Un archivo propio de esta llamada en devtools, con <paramref name="content"/>; se borra al terminar.</summary>
    private static T WithBodyFile<T>(string content, Func<string, T> use)
    {
        var bodyFile = $"{BodyFilePrefix}-{Guid.NewGuid():N}.json";
        CopyToDevtools(content, bodyFile);
        try
        {
            return use(bodyFile);
        }
        finally
        {
            try
            {
                Devtools(["rm", "-f", bodyFile]);
            }
            catch (InvalidOperationException)
            {
                // Un archivo temporal que no se pudo borrar no invalida la lectura ni la entrega.
            }
        }
    }

    private static void RequirePublished(string channel)
    {
        if (!PublishedChannels.Contains(channel))
        {
            throw new ArgumentException($"'{channel}' no es un canal que este servicio publique. Publicados: {(PublishedChannels.Length == 0 ? "(ninguno)" : string.Join(", ", PublishedChannels))}");
        }
    }

    private static string RequireDeadLetter(string subscription) =>
        DeadLetterOf.TryGetValue(subscription, out var destination)
            ? destination
            : throw new ArgumentException($"La suscripción '{subscription}' no declara onFailure.deadLetter: no hay descarte. Declaradas: {(DeadLetterOf.Count == 0 ? "(ninguna)" : string.Join(", ", DeadLetterOf.Keys))}");

    public static async Task StopAsync()
    {
        Harness.Run(Harness.ContainerRuntime(), ["stop", BrokerContainer]);
        brokerStopped = true;
        await Harness.EventuallyAsync(() => Task.FromResult(!Accepts()), BrokerTimeout, "el broker sigue aceptando conexiones tras detenerlo", CancellationToken.None);
    }

    public static async Task StartAsync()
    {
        Harness.Run(Harness.ContainerRuntime(), ["start", BrokerContainer]);
        await Harness.EventuallyAsync(() => Task.FromResult(Accepts()), BrokerTimeout, "el broker no volvió a aceptar conexiones", CancellationToken.None);
        brokerStopped = false;
        await AwaitServerConnectedAsync();
    }

    private static bool Accepts()
    {
        try
        {
            Devtools(["sh", "-c", ${csString(broker.cliValidateCmd)}]);
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
${usesDotnetOutbox(model) ? outboxPlumbing(model) : `
    public static Task AwaitOutboxDrained(string channel) => Task.CompletedTask;
`}`;
}

// ── RabbitMQ ─────────────────────────────────────────────────────────────────────────────────────

function rabbitHarnessBody(model) {
  const broker = BROKERS.rabbitmq;
  const subscriptions = model.subscriptions ?? [];
  const deadLetters = subscriptions.filter((sub) => sub.deadLetter);
  const read = readParts('rabbitmq', { destination: expr('queue'), bodyFile: expr('bodyFile'), base: expr('RabbitApi') });
  const purge = purgeParts('rabbitmq', { destination: expr('queue'), base: expr('RabbitApi') });
  const deliver = deliverParts('rabbitmq', { destination: expr('exchange'), bodyFile: expr('bodyFile'), base: expr('RabbitExchangeApi') });
  const probeBody = spliceBody(rabbitProbeBody(hole(0)), ['count.ToString(CultureInfo.InvariantCulture)'], csString);
  const publishBody = spliceBody(
    rabbitPublishBody({ routingKey: hole(0), key: hole(1), headersJson: hole(2), payloadBase64: hole(3) }),
    ['key', 'key', 'HeadersJson(headers)', 'Convert.ToBase64String(Encoding.UTF8.GetBytes(body))'],
    csString
  );
  const connections = `${ENDPOINTS.rabbitmq.queuesApi.replace(/queues\/%2F\/$/, '')}connections`;
  return `/// <summary>La fontanería de la mensajería del arnés: el contenedor devtools, el broker y las colas del diseño.</summary>
internal static class BrokerHarness
{
    private const string RabbitApi = ${csString(ENDPOINTS.rabbitmq.queuesApi)};
    private const string RabbitExchangeApi = ${csString(ENDPOINTS.rabbitmq.exchangeApi)};
    private const string ConnectionsApi = ${csString(connections)};
    private const string ConnectionName = ${csString(connectionName(model))};

    /// <summary>Suscripción → la cola de la que consume este servicio.</summary>
    public static readonly IReadOnlyDictionary<string, string> QueueOf = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${subscriptions.map((sub) => `        [${csString(sub.name)}] = ${csString(subscriptionDestination('rabbitmq', model, sub))},`).join('\n')}
    };

    /// <summary>Suscripción → su cola de descarte (las que declaran onFailure.deadLetter).</summary>
    public static readonly IReadOnlyDictionary<string, string> DeadLetterOf = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${deadLetters.map((sub) => `        [${csString(sub.name)}] = ${csString(deadLetterDestination('rabbitmq', model, sub))},`).join('\n')}
    };

${commonPlumbing(model, broker)}
    /// <summary>Lo publicado en un canal: la cola del canal, que se llama como él (RabbitTopology del servicio).</summary>
    public static async Task<IReadOnlyList<BrokerMessage>> PublishedAsync(string channel, int count)
    {
        RequirePublished(channel);
        await AwaitOutboxDrained(channel);
        return ReadQueue(channel, count);
    }

    public static IReadOnlyList<BrokerMessage> DeadLetters(string subscription, int count) => ReadQueue(RequireDeadLetter(subscription), count);

    public static async Task PurgeAsync(string channelOrSubscription)
    {
        var queue = QueueOf.GetValueOrDefault(channelOrSubscription) ?? DeadLetterOf.GetValueOrDefault(channelOrSubscription) ?? channelOrSubscription;
        await AwaitOutboxDrained(channelOrSubscription);
        Devtools([${cs(purge)}]);
    }

    /// <summary>Peek de una cola (leer no consume).</summary>
    private static IReadOnlyList<BrokerMessage> ReadQueue(string queue, int count)
    {
        string raw;
        try
        {
            raw = WithBodyFile(${probeBody}, bodyFile => Devtools([${cs(read)}]));
        }
        catch (InvalidOperationException) when (brokerStopped)
        {
            // Con el broker parado POR EL ESCENARIO, «no hay mensajes» es la lectura correcta.
            return [];
        }
        using var document = JsonDocument.Parse(raw);
        var messages = new List<BrokerMessage>();
        foreach (var message in document.RootElement.EnumerateArray())
        {
            messages.Add(new BrokerMessage(
                message.TryGetProperty("routing_key", out var routingKey) ? routingKey.GetString() ?? "" : "",
                message.TryGetProperty("properties", out var properties) ? properties.Clone() : default,
                message.TryGetProperty("payload", out var payload) ? payload.GetString() ?? "" : ""));
        }
        return messages;
    }

    public static void Deliver(string exchange, string key, string body, IReadOnlyDictionary<string, string> headers)
    {
        var published = WithBodyFile(${publishBody}, bodyFile => Devtools([${cs(deliver)}]));
        if (!published.Contains("\\"routed\\":true", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"RabbitMQ aceptó la publicación en '{exchange}' pero no la enrutó a ninguna cola (routed:false): ¿arrancó la conexión del servicio y declaró su topología? Respuesta: {published}");
        }
    }

    private static string HeadersJson(IReadOnlyDictionary<string, string> headers) => JsonSerializer.Serialize(headers);

    /// <summary>Al abrir cada flujo: el broker arriba (un flujo anterior pudo dejarlo parado) y el servidor conectado.</summary>
    public static async Task PrepareAsync()
    {
        if (!Accepts()) await StartAsync();
        brokerStopped = false;
        await AwaitServerConnectedAsync();
    }

    /// <summary>
    /// Espera a que el servidor esté conectado al broker (y su topología, declarada): entre las conexiones del broker, la
    /// que se presenta con el nombre del servicio, abierta. Lo es desde que la conexión del servicio se recupera.
    /// </summary>
    public static Task AwaitServerConnectedAsync() =>
        Harness.EventuallyAsync(() => Task.FromResult(ServerConnected()), BrokerTimeout, "la conexión del servicio con RabbitMQ no se recuperó", CancellationToken.None);

    private static bool ServerConnected()
    {
        string raw;
        try
        {
            raw = Devtools(["curl", "-sf", "-u", ${csString(ENDPOINTS.rabbitmq.credentials)}, ConnectionsApi]);
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        using var document = JsonDocument.Parse(raw);
        foreach (var connection in document.RootElement.EnumerateArray())
        {
            if (connection.TryGetProperty("client_properties", out var client)
                && client.TryGetProperty("connection_name", out var name) && name.GetString() == ConnectionName
                && connection.TryGetProperty("state", out var state) && state.GetString() == "running")
            {
                return true;
            }
        }
        return false;
    }
}`;
}

// ── Kafka ────────────────────────────────────────────────────────────────────────────────────────
//
// El servicio publica en UN topic (messaging.publishing.destination) con la routing key como clave, y los canales del
// diseño se distinguen por el tipo del evento; cada suscripción consume del topic de su fuente con su consumer group, y
// descarta en `<topic>.DLT` si el topic lo declara. Sin purga: marca de offset.

function kafkaHarnessBody(model) {
  const broker = BROKERS.kafka;
  const subscriptions = model.subscriptions ?? [];
  const consumption = kafkaConsumption(model);
  const eventTypes = model.messaging?.eventTypesByChannel ?? {};
  const read = readParts('kafka', { destination: expr('topic'), offset: expr('offset'), format: RECORD_FORMAT });
  const offsets = offsetsParts({ destination: expr('topic') });
  // La cabeza de la línea de kcat, del mismo constructor que ejecuta broker-check: el destino, la clave y los headers
  // los añade el arnés, que es quien los comilla en tiempo de ejecución.
  const produce = deliverShell({ destination: '', key: '', bodyFile: '' }).split(shellQuote(''))[0];
  const env = (name, fallback) => `Environment.GetEnvironmentVariable(${csString(name)}) ?? ${csString(fallback)}`;
  return `/// <summary>La fontanería de la mensajería del arnés: el contenedor devtools, el broker, los topics y los grupos del diseño.</summary>
internal static class BrokerHarness
{
    private const string KcatProduce = ${csString(produce)};
    private const string UnknownTopic = ${csString(UNKNOWN_TOPIC)};
    /// <summary>Lo que espera el arnés a que cada consumidor reciba sus particiones al abrir el flujo.</summary>
    private static readonly TimeSpan AssignmentTimeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// El topic FÍSICO donde publica este servicio, que no es el canal del diseño: todos los eventos comparten el destino y
    /// se distinguen por su tipo. Como el perfil local: la variable si está, y si no el default.
    /// </summary>
    private static readonly string EventTopic = ${env('MESSAGING_DESTINATION', model.messaging?.destinationDefault ?? '')};

    /// <summary>Canal → el metadata.eventType de sus eventos: lo que separa los canales dentro del topic único.</summary>
    private static readonly IReadOnlyDictionary<string, string[]> ChannelEventTypes = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
${Object.entries(eventTypes).map(([channel, names]) => `        [${csString(channel)}] = [${names.map(csString).join(', ')}],`).join('\n')}
    };

    /// <summary>Suscripción → el topic de su fuente, del que consume directamente.</summary>
    public static readonly IReadOnlyDictionary<string, string> TopicOf = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${subscriptions.map((sub) => `        [${csString(sub.name)}] = ${env(topicEnv(sub), sub.topicDefault)},`).join('\n')}
    };

    /// <summary>Suscripción → su topic de descarte (<c>&lt;topic&gt;.DLT</c>), las que lo declaran (por topic, como en keel-spring).</summary>
    public static readonly IReadOnlyDictionary<string, string> DeadLetterOf = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${consumption.filter((entry) => entry.deadLetter).map((entry) => `        [${csString(entry.subscription)}] = TopicOf[${csString(entry.subscription)}] + ".DLT",`).join('\n')}
    };

    /// <summary>Suscripción → su consumer group: el del perfil local, o su variable.</summary>
    private static readonly IReadOnlyDictionary<string, string> GroupOf = new Dictionary<string, string>(StringComparer.Ordinal)
    {
${subscriptions.map((sub) => `        [${csString(sub.name)}] = ${env(groupEnv(sub), consumption.find((entry) => entry.subscription === sub.name).groupId)},`).join('\n')}
    };

    /// <summary>Desde qué offset lee cada canal y cada descarte: la marca de su último reset o purga.</summary>
    private static readonly Dictionary<string, long> Marks = new(StringComparer.Ordinal);

${commonPlumbing(model, broker)}
    public static async Task<IReadOnlyList<BrokerMessage>> PublishedAsync(string channel, int count)
    {
        RequirePublished(channel);
        await AwaitOutboxDrained(channel);
        var types = ChannelEventTypes.GetValueOrDefault(channel) ?? [];
        var messages = ReadTopic(EventTopic, Marks.TryGetValue(channel, out var mark) ? mark.ToString(CultureInfo.InvariantCulture) : $"-{count}");
        return [.. messages.Where(message => types.Length == 0 || types.Contains(message.EventType)).Take(count)];
    }

    public static IReadOnlyList<BrokerMessage> DeadLetters(string subscription, int count)
    {
        var topic = RequireDeadLetter(subscription);
        return [.. ReadTopic(topic, Marks.TryGetValue(topic, out var mark) ? mark.ToString(CultureInfo.InvariantCulture) : $"-{count}").Take(count)];
    }

    /// <summary>El topic de una suscripción no se vacía: lo que publicó la fuente, ahí sigue.</summary>
    public static async Task PurgeAsync(string channelOrSubscription)
    {
        if (PublishedChannels.Contains(channelOrSubscription))
        {
            await AwaitOutboxDrained(channelOrSubscription);
            Marks[channelOrSubscription] = NextOffset(EventTopic);
            return;
        }
        if (DeadLetterOf.TryGetValue(channelOrSubscription, out var deadLetter))
        {
            Marks[deadLetter] = NextOffset(deadLetter);
            return;
        }
        if (TopicOf.ContainsKey(channelOrSubscription))
        {
            return;
        }
        Marks[channelOrSubscription] = NextOffset(channelOrSubscription);
    }

    public static void Deliver(string topic, string key, string body, IReadOnlyDictionary<string, string> headers)
    {
        var command = new StringBuilder(KcatProduce).Append(Quote(topic)).Append(" -k ").Append(Quote(key));
        foreach (var (name, value) in headers)
        {
            command.Append(" -H ").Append(Quote($"{name}={value}"));
        }
        // kcat manda UN mensaje por línea del archivo: un JSON escrito en varias se publicaría troceado.
        var singleLine = string.Join(' ', body.Split(['\\r', '\\n'], StringSplitOptions.RemoveEmptyEntries));
        WithBodyFile(singleLine, bodyFile => Devtools(["sh", "-c", $"{command} -l {bodyFile}"]));
    }

    /// <summary>Comilla un valor para la shell del contenedor (una clave o un header, nunca un cuerpo).</summary>
    private static string Quote(string value) => "'" + value.Replace("'", "'\\\\''", StringComparison.Ordinal) + "'";

    /// <summary>
    /// Lee un topic desde un offset, un registro por línea (clave, headers y valor). Kafka crea el topic con el PRIMER
    /// mensaje: leer antes es «no hay mensajes», no una avería.
    /// </summary>
    private static List<BrokerMessage> ReadTopic(string topic, string offset)
    {
        string raw;
        try
        {
            raw = Devtools([${cs(read)}]);
        }
        catch (InvalidOperationException error) when (error.Message.Contains(UnknownTopic, StringComparison.Ordinal) || brokerStopped)
        {
            return [];
        }
        var messages = new List<BrokerMessage>();
        foreach (var line in raw.Split('\\n'))
        {
            var text = line.TrimEnd('\\r');
            if (text.Trim().Length == 0) continue;
            var first = text.IndexOf('\\t', StringComparison.Ordinal);
            var second = first < 0 ? -1 : text.IndexOf('\\t', first + 1);
            var routingKey = first < 0 ? "" : text[..first];
            var headerText = first < 0 || second < 0 ? "" : text[(first + 1)..second];
            var body = second < 0 ? text : text[(second + 1)..];
            var headers = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in headerText.Split(','))
            {
                var equals = pair.IndexOf('=', StringComparison.Ordinal);
                if (equals > 0) headers[pair[..equals]] = pair[(equals + 1)..];
            }
            messages.Add(new BrokerMessage(routingKey, JsonSerializer.SerializeToElement(headers), body));
        }
        return messages;
    }

    /// <summary>
    /// El offset en el que caerá lo siguiente que se publique en <paramref name="topic"/>: el último existente más uno.
    /// Asume UNA partición por topic, que es la decisión de infra/: con varias, una marca escalar no aísla.
    /// </summary>
    private static long NextOffset(string topic)
    {
        string raw;
        try
        {
            raw = Devtools([${cs(offsets)}]);
        }
        catch (InvalidOperationException error) when (error.Message.Contains(UnknownTopic, StringComparison.Ordinal) || brokerStopped)
        {
            return 0;
        }
        var last = -1L;
        foreach (var line in raw.Split('\\n'))
        {
            if (long.TryParse(line.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var value)) last = value;
        }
        return last + 1;
    }

    /// <summary>
    /// Marca todos los canales y todos los topics de descarte: la parte del reset que el script no puede hacer. Los
    /// descartes entran por lo mismo que los canales, y su fallo es peor de ver: la aserción típica sobre un descarte es
    /// NEGATIVA, así que un mensaje muerto de un flujo anterior haría fallar uno posterior por algo que no hizo.
    /// </summary>
    private static void MarkChannels()
    {
        var offset = NextOffset(EventTopic);
        foreach (var channel in PublishedChannels) Marks[channel] = offset;
        foreach (var topic in DeadLetterOf.Values.Distinct()) Marks[topic] = NextOffset(topic);
    }

    /// <summary>Al abrir cada flujo: el broker arriba, los consumidores del servidor con sus particiones y la marca de cada canal.</summary>
    public static async Task PrepareAsync()
    {
        if (!Accepts()) await StartAsync();
        brokerStopped = false;
        await AwaitServerConnectedAsync();
        MarkChannels();
    }

    /// <summary>Los topics que existen ahora en el broker (kcat -L).</summary>
    private static HashSet<string> ExistingTopics()
    {
        try
        {
            var listing = Devtools(["sh", "-c", ${csString(broker.cliValidateCmd)}]);
            return [.. System.Text.RegularExpressions.Regex.Matches(listing, "topic \\"([^\\"]+)\\"").Select(match => match.Groups[1].Value)];
        }
        catch (InvalidOperationException)
        {
            return [];
        }
    }

    /// <summary>
    /// Espera a que cada consumer group del servidor cuyo topic YA existe tenga un miembro con particiones asignadas: hasta
    /// entonces, lo que se le entregue espera al reparto del grupo, y un escenario que entrega y mira enseguida lo vería
    /// tarde. El de un topic que aún no existe no se espera: lo recibirá cuando lo cree el primer mensaje (el perfil local
    /// refresca los metadatos cada pocos segundos). Se pregunta al broker con la API de administración: el servidor es
    /// otro proceso.
    /// </summary>
    public static async Task AwaitServerConnectedAsync()
    {
        var topics = ExistingTopics();
        var groups = GroupOf.Where(entry => topics.Contains(TopicOf[entry.Key])).Select(entry => entry.Value).Distinct().ToList();
        if (groups.Count == 0) return;
        var bootstrap = Environment.GetEnvironmentVariable("KAFKA_BOOTSTRAP_SERVERS") ?? "localhost:9092";
        using var admin = new AdminClientBuilder(new AdminClientConfig { BootstrapServers = bootstrap }).Build();
        IReadOnlyList<string> pending = groups;
        var until = DateTime.UtcNow + AssignmentTimeout;
        while (true)
        {
            pending = await PendingGroups(admin, groups);
            if (pending.Count == 0) return;
            if (DateTime.UtcNow > until)
            {
                // Un grupo que no llega nunca es casi siempre una suscripción SIN listener: nadie se une a él.
                throw new TimeoutException($"los consumer groups del servicio no recibieron sus particiones: {string.Join(", ", pending)} (¿falta el listener de su suscripción en BrokerBindings.cs?)");
            }
            await Task.Delay(300);
        }
    }

    /// <summary>Los grupos que todavía no tienen un miembro con particiones asignadas.</summary>
    private static async Task<IReadOnlyList<string>> PendingGroups(IAdminClient admin, List<string> groups)
    {
        try
        {
            var described = await admin.DescribeConsumerGroupsAsync(groups, new DescribeConsumerGroupsOptions { RequestTimeout = TimeSpan.FromSeconds(5) });
            return [.. described.ConsumerGroupDescriptions
                .Where(group => group.State != ConsumerGroupState.Stable || !group.Members.Any(member => member.Assignment.TopicPartitions.Count > 0))
                .Select(group => group.GroupId)];
        }
        catch (KafkaException)
        {
            // El grupo aún no existe o el coordinador no contesta: se reintenta hasta el plazo.
            return groups;
        }
    }
}`;
}

function deliverMethod(sub) {
  const headers = [];
  if (sub.discriminator?.location === 'header') headers.push(`[${csString(sub.discriminator.name)}] = ${csString(sub.discriminator.value ?? sub.name)}`);
  // El tipo como atributo nativo, además de donde lo lleve la envoltura: es lo que estampa un emisor real.
  if (sub.discriminator?.location !== 'header' || sub.discriminator.name !== 'eventType') headers.push(`["eventType"] = ${csString(sub.name)}`);
  if (sub.messageId?.location === 'header') headers.push(`[${csString(sub.messageId.name)}] = messageId`);
  const delivery = sub.identityDelivery;
  if (delivery?.placement === 'header') headers.push(`[${csString(delivery.name)}] = source`);
  const params = delivery ? 'string messageId, string source, string payloadJson' : 'string messageId, string payloadJson';
  const json = (expression) => `JsonSerializer.Serialize(${expression})`;
  let body;
  if (sub.envelope === 'keel') {
    // La envoltura COMPLETA, como la publica cualquier servicio Keel: la metadata en el orden del cable.
    const source = delivery?.placement === 'metadata' && delivery.name === 'source' ? 'source' : csString(sub.source ?? 'keel-harness');
    body = `"{\\"metadata\\":{\\"eventId\\":" + ${json('messageId')} + ",\\"eventType\\":" + ${json(csString(sub.name))} + ",\\"eventVersion\\":1,\\"occurredAt\\":" + ${json('DateTimeOffset.UtcNow.ToString("yyyy-MM-dd\'T\'HH:mm:ss.fff\'Z\'", CultureInfo.InvariantCulture)')} + ",\\"source\\":" + ${json(source)} + ",\\"correlationId\\":null,\\"traceparent\\":null},\\"data\\":" + payloadJson + "}"`;
  } else if (sub.envelope === 'wrapped') {
    const fields = [];
    if (sub.discriminator?.location === 'field') fields.push(`${csString(`"${sub.discriminator.name}":`)} + ${json(csString(sub.discriminator.value ?? sub.name))}`);
    if (sub.messageId?.location === 'field') fields.push(`${csString(`"${sub.messageId.name}":`)} + ${json('messageId')}`);
    if (delivery?.placement === 'envelopeField') fields.push(`${csString(`"${delivery.name}":`)} + ${json('source')}`);
    fields.push(`${csString(`"${sub.payloadPath}":`)} + payloadJson`);
    body = `"{" + ${fields.join(' + "," + ')} + "}"`;
  } else {
    body = 'payloadJson';
  }
  const identity =
    sub.envelope === 'keel' ? 'el eventId de la envoltura Keel' : sub.messageId ? `el ${sub.messageId.location === 'header' ? 'header' : 'campo'} '${sub.messageId.name}' del contrato` : null;
  return `
    /// <summary>
    /// Entrega ${sub.name} en su canal real, con la envoltura que declara el contrato (${sub.envelope}). <paramref name="messageId"/>
    /// es la identidad del mensaje${identity ? `, que viaja en ${identity}` : ''}: llamar dos veces con el MISMO valor es la REENTREGA que el
    /// consumidor debe absorber sin segundo efecto.${identity ? '' : ' OJO: el contrato no declara messageId ni usa la envoltura Keel, así que el consumidor no tiene con qué deduplicar.'}${
      delivery ? ` <paramref name="source"/> es la identidad de quien pide el trabajo (${sub.identity.from.name}).` : ''
    } <paramref name="payloadJson"/> es el payload ya escrito como JSON.
    /// </summary>
    protected static void Deliver${csMember(sub.name)}(${params})
    {
        var destination = Environment.GetEnvironmentVariable(${csString(topicEnv(sub))}) ?? ${csString(sub.topicDefault)};
        DeliverMessage(destination, messageId, ${body}, new Dictionary<string, string> { ${headers.join(', ')} });
    }
`;
}

// ── El outbox ────────────────────────────────────────────────────────────────────────────────────

// Muy por encima de cualquier `outbox.relay.max-attempts`: el abandono no depende del perfil (el mismo número que el
// arnés de keel-spring).
const ABANDONED = 1000000;

function outboxMembers() {
  return `
    /// <summary>
    /// Cuántos eventos se rindió el outbox: agotaron sus reintentos y no salieron nunca. El Then natural de casi cualquier
    /// escenario del outbox es que esto siga en CERO: entregar tarde es correcto, rendirse es perder.
    /// </summary>
    protected static long DeadLetteredEvents() => BrokerHarness.DeadLetteredEvents();

    /// <summary>
    /// Agota el presupuesto de reintentos de los eventos pendientes de tipo <paramref name="eventType"/> (el NOMBRE del
    /// evento en el diseño): la precondición del escenario de la rendición, que de verdad costaría max-attempts intentos.
    /// El relay sigue corriendo y deja de reclamarlos. Deja el contador sucio hasta el siguiente reset: emparéjalo con
    /// <see cref="ClearAbandonedOutboxEvents"/> o pon el escenario el último de su flujo.
    /// </summary>
    protected static void AbandonOutboxEvent(string eventType) => BrokerHarness.AbandonOutboxEvent(eventType);

    /// <summary>Retira lo que AbandonOutboxEvent rindió: la purga no lo borra (solo lo publicado), y ensuciaría a los demás.</summary>
    protected static void ClearAbandonedOutboxEvents() => Harness.Db("DELETE FROM outbox_event WHERE published_at IS NULL AND attempts >= ${ABANDONED}");
`;
}

function outboxPlumbing(model) {
  const maxAttempts = parameterValue(OUTBOX_RELAY.maxAttempts, 'local');
  return `
    private static readonly TimeSpan OutboxDrainTimeout = TimeSpan.FromSeconds(15);

    /// <summary>El destino de los eventos del servidor arrancado: el de su configuración local, o MESSAGING_DESTINATION.</summary>
    private static string Destination => Environment.GetEnvironmentVariable("MESSAGING_DESTINATION") ?? ${csString(model.messaging?.destinationDefault ?? '')};

    /// <summary>Los intentos antes de rendirse del servidor arrancado (perfil local), o OUTBOX_RELAY_MAX_ATTEMPTS.</summary>
    private static int MaxAttempts =>
        int.TryParse(Environment.GetEnvironmentVariable(${csString(OUTBOX_RELAY.maxAttempts.env)}), NumberStyles.None, CultureInfo.InvariantCulture, out var configured) && configured > 0
            ? configured
            : ${maxAttempts};

    /// <summary>Un número de una consulta de una sola fila: la última línea. Vacío NO es cero.</summary>
    private static long CountOf(string output)
    {
        var last = output.Trim().Split('\\n').LastOrDefault() ?? "";
        var digits = new string([.. last.Where(char.IsAsciiDigit)]);
        return digits.Length > 0 ? long.Parse(digits, CultureInfo.InvariantCulture) : throw new InvalidOperationException($"La consulta de outbox_event no devolvió un número (salida: '{output.Trim()}')");
    }

    private static string Quoted(string value) => value.Replace("'", "''", StringComparison.Ordinal);

    /// <summary>
    /// Espera a que no queden filas del outbox sin entregar para este servicio. Un canal que no publicamos no pasa por
    /// nuestro outbox, y con el broker parado por el escenario las filas esperan a propósito. La fila RENDIDA no cuenta: no
    /// va a salir nunca.
    /// </summary>
    public static async Task AwaitOutboxDrained(string channel)
    {
        if (!PublishedChannels.Contains(channel) || brokerStopped) return;
        var until = DateTime.UtcNow + OutboxDrainTimeout;
        while (DateTime.UtcNow < until && CountOf(Harness.Db($"SELECT COUNT(*) FROM outbox_event WHERE destination = '{Quoted(Destination)}' AND published_at IS NULL AND attempts < {MaxAttempts}")) > 0)
        {
            await Task.Delay(150);
        }
    }

    public static long DeadLetteredEvents() =>
        CountOf(Harness.Db($"SELECT COUNT(*) FROM outbox_event WHERE published_at IS NULL AND attempts >= {MaxAttempts}"));

    public static void AbandonOutboxEvent(string eventType)
    {
        var type = Quoted(eventType);
        if (CountOf(Harness.Db($"SELECT COUNT(*) FROM outbox_event WHERE event_type = '{type}' AND published_at IS NULL")) == 0)
        {
            throw new InvalidOperationException($"No hay ningún evento {eventType} pendiente en el outbox que abandonar");
        }
        Harness.Db($"UPDATE outbox_event SET attempts = ${ABANDONED} WHERE event_type = '{type}' AND published_at IS NULL");${kafkaInFlightWait(model)}
    }
`;
}

// Con Kafka, el envío que el relay tenía EN VUELO cuando se abandona el evento sigue en el buffer del productor hasta su
// plazo de entrega: si el escenario levanta el broker antes, ese envío se completa y el evento abandonado SALE (y el relay
// lo marca publicado). Es la K2 de las corridas payment-checkout de keel-spring, que espera lo mismo: el plazo del perfil
// local, del catálogo neutral, más un margen.
function kafkaInFlightWait(model) {
  if (!usesKafka(model)) return '';
  return `
        // Un envío del relay que seguía en vuelo caduca en delivery.timeout.ms (${KAFKA_PRODUCER_TIMEOUTS.delivery.local} ms en local); hasta
        // entonces, levantar el broker lo entregaría.
        Thread.Sleep(TimeSpan.FromMilliseconds(${KAFKA_PRODUCER_TIMEOUTS.delivery.local + 2000}));`;
}

/** El caso del humo: el broker responde y el servidor está conectado a él. */
export function messagingSmokeCase(model) {
  if (!usesMessagingHarness(model)) return null;
  return `    [Scenario("SMOKE-6: el broker responde y el servidor está conectado a él")]
    public Task ElServidorEstaConectadoAlBroker() =>
        // Sin ella, toda entrega se queda en la cola y los Then de los flujos de mensajería agotan su espera.
        AssertBrokerConnected();`;
}
