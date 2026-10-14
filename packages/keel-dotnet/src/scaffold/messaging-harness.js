// La mensajería en el ARNÉS de integración de keel-dotnet (incremento 9c): lo que una prueba de flujo usa para entregar
// un mensaje a una suscripción, leer lo publicado y lo descartado, tumbar y levantar el broker, y fabricar las
// precondiciones del outbox. Son los helpers del AbstractFlowIT de keel-spring y de `flow.ts` de keel-nest, con los
// mismos nombres en PascalCase: `Deliver<Sub>`, `PublishedMessages`, `DeadLetterMessages`, `PurgeMessages`,
// `StopBroker`/`StartBroker`, `DeadLetteredEvents` y `AbandonOutboxEvent`.
//
// Los comandos con los que se habla con el broker NO se escriben aquí: salen de keel-core/gen/broker-probes.js —los
// mismos que ejecutan los arneses de keel-spring y keel-nest y los `broker-check`—, renderizados a C# con
// `renderParts`/`spliceBody`. Viajan por el contenedor devtools de infra/, que está en la red del compose.
//
// El servidor es un PROCESO aparte (caja negra), como en keel-spring y no como en keel-nest: lo rendido del outbox y su
// abandono se leen y fabrican en la base (outbox_event), y la espera a que el servidor vuelva a estar conectado tras
// levantar el broker se le pregunta al broker (sus conexiones, por el nombre que la conexión del servicio declara).
//
// Solo RabbitMQ por ahora: Kafka y SNS/SQS llegan en sus tramos (la frontera los rechaza).

import { ENDPOINTS, PROBE_BODY_FILE, deliverParts, expr, hole, purgeParts, rabbitProbeBody, rabbitPublishBody, readParts, renderParts, spliceBody } from 'keel-core/gen/broker-probes';
import { BROKERS, brokerContainer, devtoolsContainer } from 'keel-core/gen/infra-catalog';
import { deadLetterDestination, subscriptionDestination } from 'keel-core/gen';
import { OUTBOX_RELAY, parameterValue } from 'keel-core/gen/messaging-stores';
import { publishedChannels } from 'keel-core/gen/messaging-plan';
import { csFile, csMember, csString } from './render.js';
import { usesDotnetOutbox, usesRabbitMq } from './messaging.js';

/** ¿Lleva el arnés la mensajería? Con el broker que keel-dotnet genera. */
export function usesMessagingHarness(model) {
  return usesRabbitMq(model);
}

/** El nombre con el que la conexión del servicio se presenta al broker: lo busca el arnés entre sus conexiones. */
export function connectionName(model) {
  return model.service.name;
}

const cs = (parts) => renderParts(parts, csString);

/** El Support/Messaging.cs del proyecto de flujos. */
export function messagingHarnessCs(model, namespace) {
  if (!usesMessagingHarness(model)) return null;
  const broker = BROKERS.rabbitmq;
  const service = model.service.name;
  const subscriptions = model.subscriptions ?? [];
  const published = publishedChannels(model).map((entry) => entry.channel);
  const deadLetters = subscriptions.filter((sub) => sub.deadLetter);
  const outbox = usesDotnetOutbox(model);

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

  const body = `/// <summary>Un mensaje leído del broker: su routing key, sus propiedades y su cuerpo.</summary>
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
    public string? EventId =>
        Payload is { ValueKind: JsonValueKind.Object } payload && payload.TryGetProperty("metadata", out var metadata) && metadata.TryGetProperty("eventId", out var id)
            ? id.GetString()
            : null;
}

// ── Mensajería (RabbitMQ) ────────────────────────────────────────────────────────────────────────
//
// Los comandos salen de keel-core/gen/broker-probes.js: los mismos que usan los arneses de keel-spring y keel-nest y los
// que ejecuta broker-check. Viajan por el contenedor devtools, que ve el broker por la red del compose.
public abstract partial class FlowTest
{
    /// <summary>
    /// Lo publicado en un canal del diseño desde el último reset (hasta <paramref name="count"/>). Con outbox, espera antes
    /// a que el relay entregue lo que tenga pendiente: si no, lo que se lee depende de la fase del relay. Leer no consume:
    /// un escenario puede afirmar dos veces sobre el mismo mensaje.
    /// </summary>
    protected static async Task<IReadOnlyList<BrokerMessage>> PublishedMessages(string channel, int count = 50)
    {
        if (!BrokerHarness.PublishedChannels.Contains(channel))
        {
            throw new ArgumentException($"'{channel}' no es un canal que este servicio publique. Publicados: {(BrokerHarness.PublishedChannels.Length == 0 ? "(ninguno)" : string.Join(", ", BrokerHarness.PublishedChannels))}");
        }
        await BrokerHarness.AwaitOutboxDrained(channel);
        return BrokerHarness.ReadQueue(channel, count);
    }

    /// <summary>
    /// Lo que acabó en el descarte de una suscripción desde el último reset. Úsalo también —y sobre todo— para la aserción
    /// NEGATIVA: un duplicado absorbido se confirma SIN acabar aquí.
    /// </summary>
    protected static IReadOnlyList<BrokerMessage> DeadLetterMessages(string subscription, int count = 50) =>
        BrokerHarness.DeadLetterOf.TryGetValue(subscription, out var queue)
            ? BrokerHarness.ReadQueue(queue, count)
            : throw new ArgumentException($"La suscripción '{subscription}' no declara onFailure.deadLetter: no hay descarte. Declaradas: {(BrokerHarness.DeadLetterOf.Count == 0 ? "(ninguna)" : string.Join(", ", BrokerHarness.DeadLetterOf.Keys))}");

    /// <summary>
    /// Vacía un canal publicado (o la cola de una suscripción, por su nombre). El reset de estado ya lo hace al abrir el
    /// flujo; repítelo justo antes de la acción cuyo Then afirma que NO se publica nada.
    /// </summary>
    protected static async Task PurgeMessages(string channelOrSubscription)
    {
        var queue = BrokerHarness.QueueOf.GetValueOrDefault(channelOrSubscription) ?? BrokerHarness.DeadLetterOf.GetValueOrDefault(channelOrSubscription) ?? channelOrSubscription;
        await BrokerHarness.AwaitOutboxDrained(channelOrSubscription);
        BrokerHarness.Purge(queue);
    }

    /// <summary>
    /// Publica un mensaje crudo en un exchange (el canal de una fuente), con <paramref name="key"/> como message_id y
    /// routing key. Falla si RabbitMQ no lo enrutó a ninguna cola: lo acepta con 200 y <c>"routed":false</c>, y sin esto
    /// el escenario moriría mucho después en un timeout que habla de otra cosa.
    /// </summary>
    protected static void DeliverMessage(string exchange, string key, string body, IReadOnlyDictionary<string, string>? headers = null) =>
        BrokerHarness.Deliver(exchange, key, body, headers ?? new Dictionary<string, string>());
${subscriptions.map((sub) => deliverMethod(sub)).join('')}
    /// <summary>Detiene el broker (el escenario del canal indisponible). Las lecturas devuelven vacío mientras tanto.</summary>
    protected static Task StopBroker() => BrokerHarness.StopAsync();

    /// <summary>Lo vuelve a levantar y espera a que la conexión del servicio se recupere.</summary>
    protected static Task StartBroker() => BrokerHarness.StartAsync();

    /// <summary>El broker arriba y el servidor conectado a él (con su topología declarada); falla diciéndolo si no llega.</summary>
    protected static Task AssertBrokerConnected() => BrokerHarness.PrepareAsync();
${outbox ? outboxMembers() : ''}}

/// <summary>La fontanería de la mensajería del arnés: el contenedor devtools, el broker y las colas del diseño.</summary>
internal static class BrokerHarness
{
    private const string DevtoolsContainer = ${csString(devtoolsContainer(service))};
    private const string BrokerContainer = ${csString(brokerContainer(service, broker))};
    private const string RabbitApi = ${csString(ENDPOINTS.rabbitmq.queuesApi)};
    private const string RabbitExchangeApi = ${csString(ENDPOINTS.rabbitmq.exchangeApi)};
    private const string ConnectionsApi = ${csString(connections)};
    // Los cuerpos viajan por un archivo del contenedor devtools: UNO POR LLAMADA (el nombre fijo de keel-core más un
    // sufijo único). Con uno fijo, dos entregas lanzadas a la vez por un escenario de carrera se pisaban el cuerpo
    // (corrida stock-reservation-events, FL-CMP-001-C: no falló porque los dos eran iguales).
    private static readonly string BodyFilePrefix = ${csString(PROBE_BODY_FILE.replace(/\.json$/, ''))};
    private const string ConnectionName = ${csString(connectionName(model))};
    private static readonly TimeSpan BrokerTimeout = TimeSpan.FromSeconds(90);

    /// <summary>Los canales que publica este servicio: cada uno es una cola con su nombre (RabbitTopology del servicio).</summary>
    public static readonly string[] PublishedChannels = [${published.map(csString).join(', ')}];

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

    /// <summary>Peek de una cola (leer no consume).</summary>
    public static IReadOnlyList<BrokerMessage> ReadQueue(string queue, int count)
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

    public static void Purge(string queue) => Devtools([${cs(purge)}]);

    public static void Deliver(string exchange, string key, string body, IReadOnlyDictionary<string, string> headers)
    {
        var published = WithBodyFile(${publishBody}, bodyFile => Devtools([${cs(deliver)}]));
        if (!published.Contains("\\"routed\\":true", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"RabbitMQ aceptó la publicación en '{exchange}' pero no la enrutó a ninguna cola (routed:false): ¿arrancó la conexión del servicio y declaró su topología? Respuesta: {published}");
        }
    }

    private static string HeadersJson(IReadOnlyDictionary<string, string> headers) => JsonSerializer.Serialize(headers);

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
${outbox ? outboxPlumbing(model) : `
    public static Task AwaitOutboxDrained(string channel) => Task.CompletedTask;
`}}`;
  return csFile({ namespace, usings: ['System.Globalization', 'System.Text', 'System.Text.Json'], body });
}

function deliverMethod(sub) {
  const headers = [];
  if (sub.discriminator?.location === 'header') headers.push(`[${csString(sub.discriminator.name)}] = ${csString(sub.discriminator.value ?? sub.name)}`);
  // El tipo como atributo nativo, además de donde lo lleve la envoltura: es lo que estampa un emisor real.
  if (sub.discriminator?.location !== 'header' || sub.discriminator.name !== 'eventType') headers.push(`["eventType"] = ${csString(sub.name)}`);
  if (sub.messageId?.location === 'header') headers.push(`[${csString(sub.messageId.name)}] = messageId`);
  const delivery = sub.identityDelivery;
  if (delivery?.placement === 'header') headers.push(`[${csString(delivery.name)}] = source`);
  const topicEnv = sub.topicProperty.toUpperCase().replace(/[.-]/g, '_');
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
        var destination = Environment.GetEnvironmentVariable(${csString(topicEnv)}) ?? ${csString(sub.topicDefault)};
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
        Harness.Db($"UPDATE outbox_event SET attempts = ${ABANDONED} WHERE event_type = '{type}' AND published_at IS NULL");
    }
`;
}

/** El caso del humo: el broker responde y el servidor está conectado a él. */
export function messagingSmokeCase(model) {
  if (!usesMessagingHarness(model)) return null;
  return `    [Scenario("SMOKE-6: el broker responde y el servidor está conectado a él")]
    public Task ElServidorEstaConectadoAlBroker() =>
        // Sin ella, toda entrega se queda en la cola y los Then de los flujos de mensajería agotan su espera.
        AssertBrokerConnected();`;
}

