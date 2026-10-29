// La mensajería del servicio (incremento 9): los contratos transversales al broker, los mismos que emiten keel-spring
// (`messaging.js`) y keel-nest, y lo que en el servidor de keel-spring pone Spring sin que nadie lo escriba.
//
// Build genera:
//   · la EventEnvelope (metadata + data) que viaja por el cable, con la EventMetadata que el agregado estampó al
//     emitir: el eventId es la clave de idempotencia del consumidor y no se regenera;
//   · por evento, el <Evento>IntegrationEvent: el gemelo de cable del evento de dominio, desacoplado de él, cuya
//     metadata NO se serializa en `data` (la autoritativa es la de la envoltura);
//   · el puente <Servicio>DomainEventBridge, al que los adaptadores de repositorio entregan los eventos que drenan al
//     guardar: con `reliability: outbox` escribe la fila del outbox DENTRO de la transacción del cambio; con
//     `best-effort` publica DESPUÉS del commit por el puerto I<Evento>Publisher, que mientras el agente no lo
//     implemente es un respaldo que solo avisa;
//   · por suscripción, el mensaje con su lector del cable (FromWire) y su RequireContract(), y la envoltura propia de
//     la fuente cuando `envelope: wrapped`;
//   · la configuración (`config/parameters/<perfil>/messaging.yaml`, el MISMO texto que keel-nest:
//     keel-core/gen/messaging-plan.js) y el registro en el contenedor.
//
// Lo único que depende del broker (`keel-stack.json`) es el ENVÍO y la RECEPCIÓN: la implementación de
// IOutboxDispatcher (outbox) o de I<Evento>Publisher (best-effort) y los listeners. Los escribe el agente siguiendo la
// skill keel-dotnet-<broker>, y los registra en UN solo archivo, `BrokerBindings.cs`: es lo que en Spring hace el
// component-scan. La conexión con el broker y su topología de consumo sí son de build (`rabbitmq.js`), porque en
// Spring las pone Boot.
//
// Solo con persistencia RELACIONAL: el puente sale del adaptador de repositorio y el registro de procesados vive en la
// base. La documental llega con el incremento 12.

import { deadLetterDestination, missingTargetRetryDestinations, subscriptionDestination, subscriptionGroupId } from '@keel-system/keel-core/gen';
import { OUTBOX_RELAY } from '@keel-system/keel-core/gen/messaging-stores';
import { usesMessaging, usesBridge, usesProcessedEvents, usesRabbitMq, usesKafka, usesSnsSqs } from '@keel-system/keel-core/gen/features';
export { usesMessaging, usesBridge, usesProcessedEvents, usesRabbitMq, usesKafka, usesSnsSqs };
import { consumerUnits, consumesFromQueue, messagingYaml, routingKeyName, subscriptionKey } from '@keel-system/keel-core/gen/messaging-plan';
import { acknowledgeNote } from '@keel-system/keel-core/gen/rejection-notes';
import { callsPaymentGateway } from '@keel-system/keel-core/gen/payments-model';
import { csFile, csLocal, csMember, csString, declType, fieldUsings, located, namespaceOf, xmlDoc } from './render.js';
import { configNamespace } from './config.js';
import { wireNamespace } from './wire.js';
import { usesDocument, dbContextClass, persistenceNamespace, rowsNamespace } from './persistence.js';
import { credentialFinderName, resolvedByOf } from './repositories.js';
import { outboxDocumentLiteral } from './document-stores.js';
import { jsonRead, rulesArgs } from './endpoints.js';
import { telemetryNamespace, usesTelemetry } from './telemetry.js';
import { entryGateAssignment } from './services.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

// ─── Qué se genera ───────────────────────────────────────────────────────────────────────────────

/** ¿Va por el outbox? Lo decide el diseño (`reliability: outbox`). */
export function usesDotnetOutbox(model) {
  return usesBridge(model) && model.messaging?.reliability === 'outbox';
}

export const bridgeClass = (model) => `${model.service.rootNamespace}DomainEventBridge`;
export const publisherPort = (event) => `I${event.publisherClass}`;
export const publisherStub = (event) => `${event.publisherClass}Stub`;
export function messagingNamespace(model) {
  return namespaceOf(model, 'messaging');
}

export function generate(model) {
  if (!usesMessaging(model)) return [];
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  const files = [
    ...PROFILES.map((profile) => ({
      path: `config/parameters/${profile}/messaging.yaml`,
      content: messagingYaml(model, profile, { outbox: usesDotnetOutbox(model), processedEvents: usesProcessedEvents(model) })
    })),
    file('messaging', 'EventEnvelope', ['System.Text.Json', wireNamespace(model), namespaceOf(model, 'events'), ...observedUsings(model)], envelopeBody(model)),
    file('messaging', 'MessageContractViolation', [], contractViolationBody()),
    file('messaging', 'MessagingSettings', ['System.Globalization', configNamespace(model)], settingsBody(model)),
    file('messaging', 'InboundContext', [namespaceOf(model, 'events'), namespaceOf(model, 'correlation'), ...observedUsings(model)], inboundContextBody(model)),
    file('messaging', 'BrokerBindings', ['Microsoft.Extensions.DependencyInjection'], bindingsBody(model)),
    registrationFile(model)
  ];
  const outbox = usesDotnetOutbox(model);
  for (const event of model.events ?? []) {
    files.push(file('integrationEvents', event.integrationClass, integrationUsings(model, event), integrationEventBody(model, event)));
    if (usesBridge(model) && !outbox) {
      files.push(file('messaging', publisherPort(event), [namespaceOf(model, 'integrationEvents')], publisherPortBody(event)));
      files.push(file('messaging', publisherStub(event), ['Microsoft.Extensions.Logging', namespaceOf(model, 'integrationEvents')], publisherStubBody(event)));
    }
  }
  if (usesBridge(model)) files.push(bridgeFile(model));
  for (const sub of model.subscriptions ?? []) {
    files.push(messageFile(model, sub));
    if (sub.envelopeRecord) files.push(file('subscriptionMessages', sub.envelopeRecord, ['System.Text.Json', messagingNamespace(model)], wrappedEnvelopeBody(sub)));
  }
  return files;
}

// ─── La envoltura ────────────────────────────────────────────────────────────────────────────────

/** Con telemetría, la envoltura y el consumo usan KeelTelemetry (el traceparent y el span CONSUMER). */
function observedUsings(model) {
  return usesTelemetry(model) ? [telemetryNamespace(model)] : [];
}

function envelopeBody(model) {
  const telemetry = usesTelemetry(model);
  return `/// <summary>
/// Envoltura estándar de los eventos: metadata + payload, en el orden del cable (keel-core, WIRE_SHAPES.eventEnvelope). Es
/// la misma que publican y consumen los servidores de keel-spring y keel-nest del diseño.
/// </summary>
/// <remarks>
/// La metadata es la que el agregado estampó al emitir el evento de dominio: conserva el EventId, que es la clave de
/// idempotencia del consumidor. Aquí solo se le añaden la correlación y el contexto de traza de la petición, que el
/// dominio no conoce (${telemetry ? 'el traceparent es el del span en curso: con él el consumidor continúa la traza' : 'este servicio no tiene telemetría: el traceparent viaja a null'}).
/// </remarks>
public sealed record EventEnvelope<T>(EventMetadata Metadata, T Data);

/// <summary>Construir, escribir y leer la envoltura Keel.</summary>
public static class EventEnvelope
{
    /// <summary>La envoltura de un evento que sale, con la correlación de la petición en curso.</summary>
    public static EventEnvelope<T> Of<T>(EventMetadata metadata, T data, string? correlationId)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        return new EventEnvelope<T>(metadata.WithContext(correlationId, ${telemetry ? 'KeelTelemetry.CurrentTraceparent()' : 'null'}), data);
    }

    /// <summary>La envoltura en JSON con el contrato del cable (WireJson): lo que viaja y lo que guarda el outbox.</summary>
    public static string ToWire<T>(EventEnvelope<T> envelope) => JsonSerializer.Serialize(envelope, WireJson.Options);

    /// <summary>
    /// Lee una envoltura Keel del cable (lo que llega a una suscripción con <c>envelope: keel</c>). El <c>Data</c> queda
    /// sin leer: se lee DESPUÉS de filtrar por <c>Metadata.EventType</c>, con el mensaje de la suscripción, porque el
    /// canal transporta también eventos que no son de este servicio. Una envoltura que no lo es incumple el contrato y no
    /// se reintenta (MessageContractViolation).
    /// </summary>
    public static EventEnvelope<JsonElement> Parse(string text)
    {
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(text);
            root = document.RootElement.Clone();
        }
        catch (Exception error) when (error is JsonException or ArgumentException)
        {
            throw new MessageContractViolation("El mensaje no es JSON válido", error);
        }
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("metadata", out var metadata)
            || metadata.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("data", out var data))
        {
            throw new MessageContractViolation("El mensaje no trae la envoltura Keel (metadata + data)");
        }
        DateTimeOffset occurredAt;
        int eventVersion;
        try
        {
            occurredAt = JsonBodyReader.PresentValue(JsonBodyReader.Value<DateTimeOffset?>(metadata, "occurredAt"));
            eventVersion = JsonBodyReader.PresentValue(JsonBodyReader.Value<int?>(metadata, "eventVersion"));
        }
        catch (MalformedRequestException error)
        {
            throw new MessageContractViolation("metadata.occurredAt o metadata.eventVersion no cumplen el contrato del cable", error);
        }
        // El eventId se lee como texto, sin exigirle forma: es la clave de deduplicación, y keel-spring y keel-nest
        // aceptan cualquier texto. Exigir un uuid descartaba aquí mensajes que los otros dos servidores procesan.
        var eventId = Text(metadata, "eventId", required: true)!;
        return new EventEnvelope<JsonElement>(
            new EventMetadata(
                eventId,
                Text(metadata, "eventType", required: true)!,
                eventVersion,
                occurredAt,
                Text(metadata, "source", required: true)!,
                Text(metadata, "correlationId", required: false),
                Text(metadata, "traceparent", required: false)),
            data.Clone());
    }

    private static string? Text(JsonElement metadata, string name, bool required)
    {
        if (!metadata.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            return required ? throw new MessageContractViolation($"La envoltura no trae metadata.{name}") : null;
        }
        return value.ValueKind == JsonValueKind.String ? value.GetString() : throw new MessageContractViolation($"metadata.{name} no es texto");
    }
}`;
}

function contractViolationBody() {
  return `/// <summary>
/// Un mensaje que incumple el contrato de su suscripción: un campo obligatorio que falta, uno fuera de su cota o de su
/// tipo, una envoltura que no lo es. Es el IllegalArgumentException del servidor de keel-spring, y como él NO se
/// reintenta: un mensaje mal formado no se vuelve válido dentro de un segundo, así que va directo al descarte (la DLQ, si
/// la suscripción la declara).
/// </summary>
public sealed class MessageContractViolation : Exception
{
    public MessageContractViolation()
    {
    }

    public MessageContractViolation(string message)
        : base(message)
    {
    }

    public MessageContractViolation(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}`;
}

function inboundContextBody(model) {
  const telemetry = usesTelemetry(model);
  return `/// <summary>
/// Abre el contexto de un mensaje consumido con la metadata de su envoltura Keel: la correlación de origen, que heredan
/// los eventos que provoque. Es lo que el listener envuelve alrededor de TODO el trabajo del mensaje:
/// <c>await InboundContext.Run(envelope.Metadata, () => ...)</c>.${telemetry ? '\n/// Con telemetría abre además el span CONSUMER que continúa la traza del emisor (metadata.traceparent), con su timer.' : ''}
/// </summary>
public static class InboundContext
{
    public static async Task Run(EventMetadata metadata, Func<Task> action)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(action);
        // Sin correlación de origen (o con una que no cumple el formato), una nueva: CorrelationContext.Accept.
        ${telemetry ? `// Lo mismo que la versión con resultado: la correlación y el span del consumo.
        await Run<bool>(metadata, async () =>
        {
            await action();
            return true;
        });` : `using (CorrelationContext.Open(metadata.CorrelationId ?? string.Empty))
        {
            await action();
        }`}
    }

    public static async Task<T> Run<T>(EventMetadata metadata, Func<Task<T>> action)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(action);
        using (CorrelationContext.Open(metadata.CorrelationId ?? string.Empty))
        {
            return ${telemetry ? 'KeelTelemetry.Current is { } telemetry ? await telemetry.Consuming(metadata.EventType, metadata.Traceparent, action) : await action()' : 'await action()'};
        }
    }
}`;
}

// ─── Eventos de integración ──────────────────────────────────────────────────────────────────────

function integrationUsings(model, event) {
  const usings = ['System.Text.Json.Serialization', namespaceOf(model, 'events')];
  for (const field of event.fields) usings.push(...fieldUsings(model, field));
  if (model.service?.omitNulls) usings.push(wireNamespace(model));
  return usings;
}

function integrationEventBody(model, event) {
  const params = event.fields.map((field) => `${declType(field)} ${csMember(field.name)}`);
  const args = event.fields.map((field) => `domainEvent.${csMember(field.name)}`);
  const omit = Boolean(model.service?.omitNulls);
  return `/// <summary>
/// Evento de integración ${event.name}: la proyección de cable del evento de dominio ${event.className}${event.channel ? `, publicado en el canal '${event.channel}'` : ''}.
/// </summary>
/// <remarks>
/// Desacoplado del dominio a propósito: cambiar el broker o la serialización no alcanza a Domain/Events. La metadata se
/// conserva (el puente la necesita para la envoltura) pero NO se serializa: la autoritativa es la de la envoltura, y
/// duplicarla en <c>data</c> confundiría al consumidor.
/// </remarks>
${omit ? '// conventions.nulls: omit — un campo sin valor no viaja (service.keel.yaml).\n[OmitNulls]\n' : ''}public sealed record ${event.integrationClass}(
    [property: JsonIgnore] EventMetadata Metadata${params.length > 0 ? `,\n    ${params.join(',\n    ')}` : ''})
{
    public static ${event.integrationClass} From(${event.className} domainEvent)
    {
        ArgumentNullException.ThrowIfNull(domainEvent);
        return new(domainEvent.Metadata${args.length > 0 ? `, ${args.join(', ')}` : ''});
    }
}`;
}

// ─── Best-effort: el puerto de publicación y su respaldo ─────────────────────────────────────────

function publisherPortBody(event) {
  return `/// <summary>
/// Puerto de publicación del evento de integración ${event.name} (reliability: best-effort). La implementación del broker
/// del stack la escribe el agente (skill keel-dotnet-&lt;broker&gt;) y la registra en BrokerBindings.cs; el único que lo
/// invoca es el puente de eventos, DESPUÉS del commit.
/// </summary>
public interface ${publisherPort(event)}
{
    Task Publish(${event.integrationClass} integrationEvent, string? correlationId, CancellationToken cancellationToken = default);
}`;
}

function publisherStubBody(event) {
  const stub = publisherStub(event);
  return `/// <summary>
/// Respaldo del puerto ${publisherPort(event)} mientras no hay publisher real: satisface la inyección para que el servicio
/// arranque sin broker. Cede el sitio en cuanto BrokerBindings.cs registre otro (se registra con TryAdd, DESPUÉS de lo
/// del agente): no hay que borrar este archivo.
/// </summary>
public sealed partial class ${stub}(ILogger<${stub}> logger) : ${publisherPort(event)}
{
    public Task Publish(${event.integrationClass} integrationEvent, string? correlationId, CancellationToken cancellationToken = default)
    {
        // El publisher real lo escribe el agente (skill keel-dotnet-<broker>: EventEnvelope.Of(integrationEvent.Metadata,
        //   integrationEvent, correlationId), EventEnvelope.ToWire y el destino y la routing key de MessagingSettings) y lo
        //   registra en BrokerBindings.cs, que es donde está su marca de trabajo: este respaldo se queda.
        LogNotImplemented(correlationId);
        return Task.CompletedTask;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Publisher no implementado: ${event.name} no salió del servicio (correlationId={CorrelationId})")]
    private partial void LogNotImplemented(string? correlationId);
}`;
}

// ─── El puente ───────────────────────────────────────────────────────────────────────────────────

function bridgeFile(model) {
  const { namespace, path } = located(model, 'messaging', bridgeClass(model));
  const outbox = usesDotnetOutbox(model);
  // Sobre documentos, la fila del outbox se INSERTA en la sesión del cambio, y eso es asíncrono: Publish devuelve Task.
  const document = usesDocument(model);
  const usings = [namespaceOf(model, 'events'), namespaceOf(model, 'integrationEvents'), namespaceOf(model, 'correlation')];
  const ctor = [];
  if (outbox && document) {
    usings.push(persistenceNamespace(model), 'MongoDB.Bson', 'MongoDB.Driver');
    ctor.push('PersistenceTransactions transactions', 'MessagingSettings settings');
  } else if (outbox) {
    usings.push(persistenceNamespace(model), rowsNamespace(model));
    ctor.push(`${dbContextClass(model)} db`, 'MessagingSettings settings');
  } else {
    usings.push(persistenceNamespace(model));
    ctor.push('PersistenceTransactions transactions');
    for (const event of model.events) ctor.push(`${publisherPort(event)} ${csLocal(event.publisherClass)}`);
  }
  // La etiqueta del sobre (`event_type` de la fila) es el NOMBRE del evento en el diseño, el mismo literal que estampa
  // EventMetadata.Now(...): es sobre ese valor que filtran los consumidores. Con el nombre de la clase, no casaría.
  const branches = model.events.map((event) => {
    const delivery = outbox
      ? `Append(settings.RoutingKeys[${csString(event.name)}], ${csString(event.name)}, EventEnvelope.ToWire(EventEnvelope.Of(e.Metadata, integration, correlationId)));`
      : `transactions.AfterCommit(() => ${csLocal(event.publisherClass)}.Publish(integration, correlationId, CancellationToken.None));`;
    return `            case ${event.className} e:
            {
                var integration = ${event.integrationClass}.From(e);
                ${delivery}
                return;
            }`;
  });
  const append = outbox && document
    ? `

    /// <summary>
    /// La fila del outbox, en la sesión de la transacción del cambio: el documento del evento y el del agregado confirman o
    /// abortan juntos. Sin transacción abierta no hay cambio al que atarlo, y es un error.
    /// </summary>
    private void Append(string routingKey, string eventType, string payload) =>
        pending.Add(${outboxDocumentLiteral()});

    private readonly List<BsonDocument> pending = [];

    private async Task Flush(CancellationToken cancellationToken)
    {
        if (pending.Count == 0)
        {
            return;
        }
        var session = transactions.Session
            ?? throw new InvalidOperationException("El outbox se escribe dentro de la transacción del cambio, y no hay ninguna abierta");
        var rows = pending.ToList();
        pending.Clear();
        await transactions.Collection(${csString('outbox_event')}).InsertManyAsync(session, rows, cancellationToken: cancellationToken);
    }`
    : outbox
    ? `

    /// <summary>La fila del outbox, en la transacción del cambio: el evento y el cambio confirman o revierten juntos.</summary>
    private void Append(string routingKey, string eventType, string payload) =>
        db.Set<OutboxEventRow>().Add(new OutboxEventRow
        {
            Id = Guid.CreateVersion7(),
            Destination = settings.Destination,
            RoutingKey = routingKey,
            EventType = eventType,
            Payload = payload,
            CreatedAt = DateTimeOffset.UtcNow,
            Attempts = 0
        });`
    : '';
  const publish = document
    ? `    /// <summary>Lo llama el adaptador de repositorio al guardar, dentro de la transacción del caso de uso.</summary>
    public async Task Publish(IReadOnlyList<IDomainEvent> events, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(events);
        foreach (var domainEvent in events)
        {
            Route(domainEvent);
        }
        ${outbox ? 'await Flush(cancellationToken);' : 'await Task.CompletedTask;'}
    }`
    : `    /// <summary>Lo llama el adaptador de repositorio al guardar, dentro de la transacción del caso de uso.</summary>
    public void Publish(IReadOnlyList<IDomainEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);
        foreach (var domainEvent in events)
        {
            Route(domainEvent);
        }
    }`;
  const body = `/// <summary>
/// Traduce cada evento de dominio a su evento de integración y lo entrega ${
    outbox
      ? 'al outbox DENTRO de la transacción que provocó el\n/// cambio: la fila y el cambio del agregado confirman o revierten juntos (reliability: outbox). El relay la publica\n/// después, fuera de ella.'
      : 'tras confirmar la transacción (reliability:\n/// best-effort): un rollback no publica nada, pero un fallo del broker sí pierde el evento.'
  }
/// </summary>
/// <remarks>
/// Los eventos llegan aquí porque los adaptadores de repositorio drenan PullDomainEvents() al guardar el agregado, antes
/// de SaveChanges y dentro de la transacción del caso de uso. Nadie más publica eventos.
/// </remarks>
public sealed class ${bridgeClass(model)}(${ctor.join(', ')})
{
${publish}

    private void Route(IDomainEvent domainEvent)
    {
        var correlationId = CorrelationContext.Get();
        switch (domainEvent)
        {
${branches.join('\n')}
        }
        // Un evento de dominio sin evento de integración es un hueco del scaffolding: que no pase en silencio.
        throw new InvalidOperationException($"El evento {domainEvent.Metadata.EventType} no tiene ruta de integración");
    }${append}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

// ─── Mensajes de suscripción ─────────────────────────────────────────────────────────────────────

const PRESENCE_RULES = new Set(['notNull', 'notBlank', 'notEmpty']);

/** El tipo con el que el mensaje DECLARA un campo: todo admite null salvo la lista (la presencia la juzga RequireContract). */
function messageType(field) {
  if (field.list) return field.csType;
  return `${field.elementCsType ?? field.csType}?`;
}

function messageFile(model, sub) {
  const { namespace, path } = located(model, 'subscriptionMessages', sub.messageRecord);
  const usings = ['System.Text.Json', wireNamespace(model), namespaceOf(model, 'errors'), messagingNamespace(model)];
  for (const field of sub.fields) usings.push(...fieldUsings(model, field));
  const required = sub.fields.filter((field) => field.required);
  // Las cotas del diseño (no la presencia, que se comprueba aparte y con su propio mensaje), como en keel-spring.
  const bounded = sub.fields
    .map((field) => ({ field, rules: (field.inputValidation ?? field.validation ?? []).filter((rule) => !PRESENCE_RULES.has(rule.rule)) }))
    .filter(({ rules }) => rules.length > 0);
  const params = sub.fields.map((field) => `${messageType(field)} ${csMember(field.name)}`);
  const reads = sub.fields.map((field) => {
    const read = jsonRead(field, 'fields', field.wireName ?? field.name);
    return `                ${field.list ? `${read} ?? []` : read}`;
  });
  const known = sub.fields.map((field) => csString(field.wireName ?? field.name));
  const unknownCheck =
    sub.unknownFields === 'fail'
      ? `
            // unknownFields: fail — un campo que el contrato no conoce rechaza el mensaje.
            string[] known = [${known.join(', ')}];
            foreach (var property in data.EnumerateObject())
            {
                if (!known.Contains(property.Name, StringComparer.Ordinal))
                {
                    throw new MessageContractViolation($"${sub.name}: el mensaje trae '{property.Name}', que el contrato no declara");
                }
            }`
      : '';
  const presence = required.map(
    (field) => `        if (${csMember(field.name)} is null)
        {
            throw new MessageContractViolation(${csString(`${sub.name}: el mensaje no trae '${field.name}', que el contrato declara obligatorio`)});
        }`
  );
  const bounds =
    bounded.length > 0
      ? `        try
        {
            var checks = new InputViolations(ViolationSource.Body);
${bounded.map(({ field, rules }) => `            checks.Check(${csString(field.name)}, ${csMember(field.name)}, ${rulesArgs(rules)});`).join('\n')}
            checks.ThrowIfAny();
        }
        catch (RequestValidationException error)
        {
            var first = error.Details.Count > 0 ? error.Details[0] : string.Empty;
            var space = first.IndexOf(' ', StringComparison.Ordinal);
            var (field, detail) = space < 0 ? (first, string.Empty) : (first[..space], first[(space + 1)..]);
            throw new MessageContractViolation($"${sub.name}: el mensaje incumple el contrato en '{field}': {detail}", error);
        }`
      : '';
  const contract = [...presence, bounds].filter(Boolean);
  const requireContract =
    contract.length > 0
      ? `

    /// <summary>
    /// El contrato de la fuente: los campos que el diseño declara obligatorios tienen que venir, y dentro de sus cotas.
    /// Llámalo DESPUÉS de filtrar por el tipo del mensaje — uno ajeno del canal compartido se descarta SIN lanzar, y
    /// lanzar aquí lo mandaría al descarte. Lo que incumple el contrato lanza MessageContractViolation, que va al
    /// descarte SIN reintentos.
    /// </summary>
    public void RequireContract()
    {
${contract.join('\n')}
    }`
      : '';
  const body = `${xmlDoc([`Payload del evento ${sub.name}${sub.source ? ` (fuente: ${sub.source})` : ''}.`])}/// <remarks>
${contractDoc(model, sub)}/// </remarks>
public sealed record ${sub.messageRecord}(
    ${params.join(',\n    ')})
{
    /// <summary>
    /// Lee el payload del cable${sub.fields.some((f) => f.wireName) ? ' (con los nombres de la fuente: wireName)' : ''}. Un valor que no es de su tipo incumple el contrato y no se
    /// reintenta. ${sub.unknownFields === 'fail' ? 'Un campo de más también (unknownFields: fail).' : 'Los campos de más se ignoran (unknownFields: ignore).'} La PRESENCIA no se comprueba aquí: la comprueba
    /// RequireContract(), después de filtrar.
    /// </summary>
    public static ${sub.messageRecord} FromWire(JsonElement data)
    {
        try
        {
            if (data.ValueKind != JsonValueKind.Object)
            {
                throw new MalformedRequestException();
            }${unknownCheck}
            JsonElement? fields = data;
            return new ${sub.messageRecord}(
${reads.join(',\n')});
        }
        catch (Exception error) when (error is MalformedRequestException or DomainException)
        {
            throw new MessageContractViolation(${csString(`${sub.name}: el payload no cumple el contrato del cable`)}, error);
        }
    }${requireContract}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

function wrappedEnvelopeBody(sub) {
  const path = sub.payloadPath.split('.');
  const fields = [`JsonElement? ${csMember(path[0])}`];
  const reads = [`Property(root, ${csString(path[0])})`];
  for (const part of [sub.discriminator, sub.messageId]) {
    if (part?.location === 'field' && !part.name.includes('.')) {
      fields.push(`string? ${csMember(part.name)}`);
      reads.push(`Property(root, ${csString(part.name)}) is { ValueKind: JsonValueKind.String } ${csLocal(part.name)} ? ${csLocal(part.name)}.GetString() : null`);
    }
  }
  const descend =
    path.length > 1
      ? `        // payloadPath anidado: se desciende por '${sub.payloadPath}'.
        var node = ${csMember(path[0])} ?? default;
        foreach (var key in (string[])[${path.slice(1).map(csString).join(', ')}])
        {
            node = node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var next) ? next : default;
        }
        return ${sub.messageRecord}.FromWire(node);`
      : `        return ${sub.messageRecord}.FromWire(${csMember(path[0])} ?? default);`;
  return `/// <summary>
/// Envoltura con la que ${sub.source ?? 'la fuente'} publica ${sub.name}: el payload cuelga de '${sub.payloadPath}'. Los campos que no se
/// nombran se ignoran.
/// </summary>
public sealed record ${sub.envelopeRecord}(
    ${fields.join(',\n    ')})
{
    /// <summary>Lee la envoltura del cable; el payload queda sin leer hasta que se sepa que el mensaje es nuestro.</summary>
    public static ${sub.envelopeRecord} Parse(string text)
    {
        JsonElement root;
        try
        {
            using var document = JsonDocument.Parse(text);
            root = document.RootElement.Clone();
        }
        catch (Exception error) when (error is JsonException or ArgumentException)
        {
            throw new MessageContractViolation(${csString(`${sub.name}: el mensaje no es la envoltura de la fuente`)}, error);
        }
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new MessageContractViolation(${csString(`${sub.name}: el mensaje no es la envoltura de la fuente`)});
        }
        return new ${sub.envelopeRecord}(
            ${reads.join(',\n            ')});
    }

    /// <summary>El payload, leído con el contrato de ${sub.messageRecord}.</summary>
    public ${sub.messageRecord} Message()
    {
${descend}
    }

    private static JsonElement? Property(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;
}`;
}

// El contrato de recepción, escrito donde lo va a leer el agente al escribir el listener. Es el de keel-spring
// (`contractJavadoc`) y el de keel-nest, con los nombres de keel-dotnet.
function contractDoc(model, sub) {
  const lines = [];
  if (sub.envelope === 'wrapped') {
    lines.push(`Llega envuelto en ${sub.envelopeRecord} (${sub.envelopeRecord}.Parse); el payload cuelga de '${sub.payloadPath}'.`);
  } else if (sub.envelope === 'keel') {
    lines.push('Llega en la EventEnvelope estándar de Keel (metadata + data): EventEnvelope.Parse, y después FromWire(envelope.Data).');
  } else {
    lines.push('Llega plano: el mensaje es este payload (FromWire sobre el cuerpo ya leído como JSON).');
  }
  if (sub.format !== 'json') lines.push(`Formato: ${sub.format}${sub.schemaRef ? ` (schema '${sub.schemaRef}')` : ''}.`);
  if (sub.discriminator) {
    lines.push(
      `Se reconoce por ${sub.discriminator.location} '${sub.discriminator.name}' == '${sub.discriminator.value}': el canal transporta más tipos, descarta el resto SIN lanzar.`
    );
  } else if (sub.envelope === 'keel') {
    const shared = (model.subscriptions ?? []).filter((other) => other.name !== sub.name && other.topicDefault === sub.topicDefault).map((other) => other.name);
    lines.push(
      `Se reconoce por Metadata.EventType == '${sub.name}': '${sub.topicDefault}' transporta todos los eventos de ${sub.source ?? 'la fuente'}, ` +
        'así que descarta el resto SIN lanzar (una excepción dispara el reintento y acaba mandando al descarte un mensaje válido que no era para ti).' +
        (shared.length > 0 ? ` En este diseño el destino lo comparten ${shared.join(', ')}.` : '')
    );
  }
  const dedupeKey = sub.messageId
    ? `${sub.messageId.location} '${sub.messageId.name}'`
    : sub.envelope === 'keel'
      ? 'Metadata.EventId de la envoltura (lo estampa el emisor en el Raise y viaja intacto)'
      : null;
  if (dedupeKey) {
    lines.push(`Deduplica por ${dedupeKey} antes de despachar (la entrega es at-least-once).`);
    const guardReason =
      sub.triggerGuardKind === 'natural-key'
        ? 'la clave de idempotencia participa en la clave natural del agregado, así que esa constraint ES la guarda'
        : 'la operación declara transiciones, así que la repetición la frena el agregado';
    lines.push(
      sub.triggerHasDomainGuard
        ? `Orden: IdempotencyGuard.AlreadyProcessed(...) antes de despachar y Record(...) DESPUÉS de que el handler termine bien: ${guardReason}, y lo que no puede perderse es el mensaje — registrar ANTES haría que un fallo terminal se viera como «ya procesado» y su reintento no llegara nunca al descarte.`
        : 'Orden: IdempotencyGuard.TryRecord(...) antes de despachar — la operación no declara ninguna guarda de dominio que frene la repetición, así que la ventana se cierra reclamando antes. Un fallo del handler deja el mensaje marcado y perdido; si eso no es tolerable, lo que falta es la guarda de dominio en el diseño.'
    );
    lines.push(
      'La deduplicación tiene VENTANA: el registro se purgará a los processed-event.purge.retention-days (default 14; la purga es de build, por lotes), así que una reentrega posterior se procesa como nueva.' +
        (sub.triggerHasDomainGuard ? ' Aquí es inocuo: la guarda de dominio sigue rechazándola, y esa no caduca.' : ' Aquí NO es inocuo: sin guarda de dominio, pasada la retención el efecto se vuelve a aplicar.')
    );
  }
  const broker = model.stack?.broker;
  if (broker && missingTargetRetryDestinations(model, broker).includes(subscriptionDestination(broker, model, sub))) {
    lines.push(
      'Un «no existe» (NotFoundException) del caso de uso SÍ se reintenta: aquí suele ser la carrera de orden de un consumo asíncrono —el mensaje llega antes que el hecho del que depende— y el reintento la resuelve; agotado, va al descarte igual. Deja que lance: no lo confirmes ni lo trates como un rechazo más.'
    );
  }
  if (sub.identity) {
    lines.push(
      `Identidad del emisor: resuelve ${sub.identity.field} desde ${sub.identity.from.location === 'header' ? `el header '${sub.identity.from.name}'` : `el campo '${sub.identity.from.name}' del mensaje`}, y pásala YA RESUELTA a la operación. No la leas del payload.` +
        (sub.identity.resolvedBy ? resolvedByNote(resolvedByOf(sub.identity.resolvedBy)) : ' Se resuelve 1:1: el valor leído ES la clave natural del recurso que identifica.')
    );
    lines.push(
      sub.identity.onUnresolved === 'deadLetter'
        ? 'Un emisor que no corresponda a nadie registrado va al descarte (onUnresolved: deadLetter): NO lo proceses y NO lo confirmes en silencio.'
        : 'Un emisor que no corresponda a nadie registrado se descarta (onUnresolved: discard): confirma el mensaje y déjalo en el log. Es un fallo PERMANENTE.'
    );
  }
  if ((sub.triggerRaces ?? []).length > 0) {
    lines.push(
      `Compite con ${sub.triggerRaces.join(', ')}: sacan la entidad del mismo estado. Si al despachar la transición se rechaza porque otro llegó antes, es la carrera resuelta y NO un fallo — confirma el mensaje y no lo reintentes.`,
      'Se rechaza de DOS formas y las dos son esta carrera: InvalidStateTransitionException (otro camino ya movió el estado) y el 409 de concurrencia (llegasteis a la vez y perdió el commit) — trátalas juntas.'
    );
    if (sub.triggerHasDomainGuard) lines.push('Esa rama termina igualmente en IdempotencyGuard.Record(...): el mensaje quedó atendido, por el otro camino.');
  }
  if (sub.deadLetter) {
    lines.push(
      broker === 'rabbitmq' || !broker
        ? 'Con onFailure.deadLetter: tras agotar los reintentos el broker lo mueve al descarte de su cola. La topología la genera build — NO la declares tú.'
        : `Con onFailure.deadLetter: su descarte es ${deadLetterDestination(broker, model, sub)}. La conexión con el broker es de build — NO lo publiques tú.`
    );
  }
  const acknowledged = acknowledgeNote(sub);
  if (acknowledged) lines.push(acknowledged);
  const unit = consumerUnits(model).find((entry) => entry.subscriptions.includes(sub.name));
  let consumer;
  if (unit?.group) consumer = `el listener de su consumer group (${unit.group}), que recibe el topic ${unit.topic} entero`;
  else if (unit && unit.subscriptions.length > 1)
    consumer = `el listener de la cola ${unit.queue}, que comparte con ${unit.subscriptions.filter((name) => name !== sub.name).join(', ')} y enruta por el tipo del mensaje`;
  else consumer = `el listener de su cola${unit ? ` (${unit.queue})` : ''}`;
  if (sub.trigger) {
    const paymentToken = model.payments?.charge?.operation === sub.trigger ? model.payments.charge.source.token : null;
    const argument = (a) =>
      a.from === 'envelope'
        ? `envelope.Metadata.${csMember(a.source)}`
        : a.from === 'identity'
          ? 'la identidad resuelta'
          : a.source
            ? `message.${csMember(a.source)}`
            : a.component === paymentToken
              ? 'null (por evento no hay cliente delante: solo se cobra un medio guardado)'
              : 'TODO (agente)';
    const gate = entryGateAssignment(model, sub.trigger, 'SUBSCRIPTION');
    const args = [...sub.triggerArguments.map((a) => `${csMember(a.component)} = ${argument(a)}`), ...(gate ? [gate] : [])].join(', ');
    const via = callsPaymentGateway(model, sub.trigger)
      ? 'IUseCaseMediator.DispatchWithoutTransaction(...) —llama a la pasarela: registra y confirma antes de llamarla—'
      : 'el IUseCaseMediator, en un ámbito de DI propio por mensaje';
    lines.push(
      `Lo consume ${consumer} (lo escribe el agente y lo registra en BrokerBindings.cs), despachando ${sub.triggerMessageClass ?? sub.trigger}${args ? ` { ${args} }` : ''} por ${via}.`
    );
  } else {
    lines.push(`Lo consume ${consumer} (lo escribe el agente y lo registra en BrokerBindings.cs).`);
  }
  return lines
    .map((line) => line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
    .map((line) => `/// <para>${line}</para>\n`)
    .join('');
}

// ─── La configuración ────────────────────────────────────────────────────────────────────────────

/** La clave de configuración (`a:b:c`) de una clave neutral con puntos (`a.b.c`). */
const configKey = (key) => key.replaceAll('.', ':');

function settingsBody(model) {
  const outbox = usesDotnetOutbox(model);
  const events = model.events ?? [];
  const subscriptions = model.subscriptions ?? [];
  const relayEntries = Object.entries(OUTBOX_RELAY);
  const queueOf = (sub) => (consumesFromQueue(model) ? csString(subscriptionDestination(model.stack.broker, model, sub)) : 'null');
  const groupOf = (sub) => (model.stack?.broker === 'kafka' ? csString(subscriptionGroupId(model, sub)) : 'null');
  const subscriptionRead = (sub) => {
    const key = `messaging:subscriptions:${subscriptionKey(sub)}`;
    const queue = consumesFromQueue(model) ? `Text(configuration, ${csString(`${key}:queue`)}, ${queueOf(sub)})` : 'null';
    const group = model.stack?.broker === 'kafka' ? `Text(configuration, ${csString(`${key}:group-id`)}, ${groupOf(sub)})` : 'null';
    return `                [${csString(sub.name)}] = new SubscriptionSettings(Text(configuration, ${csString(`${key}:topic`)}, ${csString(sub.topicDefault)}), ${queue}, ${group}),`;
  };
  return `/// <summary>Una suscripción del perfil activo.</summary>
/// <param name="Topic">El canal (exchange o topic) de la fuente.</param>
/// <param name="Queue">La cola propia de la que consume este servicio (RabbitMQ, SNS/SQS); null en Kafka.</param>
/// <param name="GroupId">El consumer group de la suscripción (Kafka); null en los demás brokers.</param>
public sealed record SubscriptionSettings(string Topic, string? Queue, string? GroupId);

/// <summary>El relay del outbox: las claves de keel-core/gen/messaging-stores.js (OUTBOX_RELAY).</summary>
public sealed record OutboxRelaySettings(${relayEntries.map(([name]) => `int ${csMember(name)}`).join(', ')});

/// <summary>
/// La mensajería del perfil activo, con las claves de config/parameters/&lt;perfil&gt;/messaging.yaml: las MISMAS que los
/// servidores de keel-spring y keel-nest del diseño.
/// </summary>
/// <param name="Destination">El destino (exchange o topic) donde se publican los eventos de este servicio.</param>
/// <param name="RoutingKeys">La routing key de cada evento, por su NOMBRE en el diseño.</param>
/// <param name="Subscriptions">Cada suscripción, por su NOMBRE en el diseño.</param>
/// <param name="OutboxRelay">El relay del outbox (reliability: outbox); null si los eventos salen best-effort.</param>
public sealed record MessagingSettings(
    string Destination,
    IReadOnlyDictionary<string, string> RoutingKeys,
    IReadOnlyDictionary<string, SubscriptionSettings> Subscriptions,
    OutboxRelaySettings? OutboxRelay)
{
    /// <summary>Los valores del diseño, sin configuración: los de un perfil que no declara nada (las pruebas de build).</summary>
    public static MessagingSettings Defaults { get; } = Read(null);

    /// <summary>
    /// Lee y valida la mensajería del perfil al ARRANCAR: un valor que no es un entero positivo no deja arrancar, en vez
    /// de dejar el relay parado o en bucle apretado. Lo que el perfil no declara toma el default de keel-core.
    /// </summary>
    public static MessagingSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return Read(configuration);
    }

    private static MessagingSettings Read(ServiceConfiguration? configuration) =>
        new(
            Text(configuration, "messaging:publishing:destination", ${csString(events[0]?.destinationDefault ?? '')}),
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
${events.map((event) => `                [${csString(event.name)}] = Text(configuration, ${csString(`messaging:publishing:routing-keys:${routingKeyName(event)}`)}, ${csString(event.routingKeyDefault)}),`).join('\n')}
            },
            new Dictionary<string, SubscriptionSettings>(StringComparer.Ordinal)
            {
${subscriptions.map(subscriptionRead).join('\n')}
            },
            ${outbox ? `new OutboxRelaySettings(\n${relayEntries.map(([, parameter]) => `                Positive(configuration, ${csString(configKey(parameter.key))}, ${parameter.default})`).join(',\n')})` : 'null'});

    private static string Text(ServiceConfiguration? configuration, string key, string fallback) =>
        configuration?.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    private static int Positive(ServiceConfiguration? configuration, string key, int fallback)
    {
        var value = configuration?.Get(key);
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

// ─── El cableado ─────────────────────────────────────────────────────────────────────────────────

function bindingsBody(model) {
  const outbox = usesDotnetOutbox(model);
  const kafka = model.stack?.broker === 'kafka';
  const perSubscription = kafka || model.stack?.broker === 'snssqs';
  const ports = [];
  if (outbox) ports.push('IOutboxDispatcher (el envío de cada fila del outbox al broker)');
  if (usesBridge(model) && !outbox) for (const event of model.events) ports.push(`${publisherPort(event)} (best-effort)`);
  const listeners = consumerUnits(model).map((unit) =>
    unit.group ? `uno para ${unit.subscriptions[0]} (consumer group ${unit.group})` : `uno para la cola ${unit.queue} (${unit.subscriptions.join(', ')})`
  );
  return `// EL ÚNICO SITIO donde se registra lo que escribe el agente para el broker de keel-stack.json (skill
// keel-dotnet-<broker>). Build lo genera una vez y no lo pisa: es el equivalente del component-scan de Spring, que en
// keel-spring recoge esas clases sin que nadie las nombre.

/// <summary>Lo que el agente escribe para el broker, registrado en el contenedor.</summary>
public static class BrokerBindings
{
    /// <summary>
    /// Las implementaciones de los puertos de salida del broker${ports.length > 0 ? `:\n${ports.map((port) => `    ///   · ${port}`).join('\n')}` : ' (este diseño no publica nada)'}.
    /// Se registran ANTES que los respaldos de build, que entran con TryAdd: el del agente ocupa el hueco.
    /// </summary>
    public static void AddBrokerAdapters(IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);${ports.length > 0 ? '\n        // TODO (agente): una implementación por puerto, con la skill keel-dotnet-<broker>.' : ''}
    }

    /// <summary>
    /// Los listeners de las suscripciones, ${perSubscription ? 'UNO POR SUSCRIPCIÓN' : 'UNO POR COLA y no uno por suscripción'}${listeners.length > 0 ? `:\n${listeners.map((line) => `    ///   · ${line}`).join('\n')}` : ' (este diseño no consume nada)'}.
${model.stack?.broker === 'snssqs'
  ? `    /// Cada suscripción tiene su cola propia, suscrita al topic de la fuente con filtro por su tipo: a cada listener
    /// solo le llega lo suyo.`
  : kafka
  ? `    /// Cada suscripción tiene su consumer group, que recibe el topic entero: dos de la misma fuente leen el mismo topic y
    /// cada una descarta lo que no es suyo por el tipo del mensaje.`
  : `    /// Dos consumidores de la misma cola compiten y cada mensaje llega a uno solo: el de una cola compartida enruta por
    /// el tipo del mensaje.`} Cada uno es un IHostedService que se registra en la conexión al arrancar y abre un ámbito de
    /// DI por mensaje para despachar por el IUseCaseMediator.
    /// </summary>
    public static void AddMessageListeners(IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);${listeners.length > 0 ? '\n        // TODO (agente): los listeners de arriba, con la skill keel-dotnet-<broker>.' : ''}
    }
}`;
}

function registrationFile(model) {
  const { namespace, path } = located(model, 'messaging', 'MessagingRegistration');
  const outbox = usesDotnetOutbox(model);
  const bridge = usesBridge(model);
  const processed = usesProcessedEvents(model);
  const rabbit = usesRabbitMq(model);
  const kafka = usesKafka(model);
  const snssqs = usesSnsSqs(model);
  const usings = ['Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.DependencyInjection.Extensions', configNamespace(model)];
  const lines = ['        services.AddDomainEvents(settings);'];
  if (outbox) {
    usings.push('Microsoft.Extensions.Logging', namespaceOf(model, 'outbox'));
    lines.push(
      '        // El respaldo del dispatcher: no deja arrancar fuera de local y test (OutboxDispatcherFallback).',
      '        services.TryAddSingleton<IOutboxDispatcher>(provider => OutboxDispatcherFallback.Create(configuration.Profiles, provider.GetRequiredService<ILogger<OutboxDispatcherFallback>>()));',
      '        services.AddSingleton<OutboxRelayStore>();',
      '        services.AddSingleton<OutboxRelay>();',
      '        services.AddHostedService(provider => provider.GetRequiredService<OutboxRelay>());'
    );
  }
  if (processed) {
    usings.push(namespaceOf(model, 'messageIdempotency'));
    lines.push('        services.AddSingleton<IdempotencyGuard>();');
  }
  if (rabbit) {
    usings.push(namespaceOf(model, 'rabbitmq'));
    lines.push(
      '        services.AddSingleton(RabbitMqSettings.From(configuration));',
      '        services.AddSingleton<RabbitConnection>();',
      '        services.AddHostedService(provider => provider.GetRequiredService<RabbitConnection>());'
    );
  }
  if (kafka) {
    usings.push(namespaceOf(model, 'kafka'));
    lines.push(
      '        services.AddSingleton(KafkaSettings.From(configuration));',
      '        services.AddSingleton<KafkaConnection>();',
      '        services.AddHostedService(provider => provider.GetRequiredService<KafkaConnection>());'
    );
  }
  if (snssqs) {
    usings.push(namespaceOf(model, 'snssqs'));
    lines.push(
      '        services.AddSingleton(SnsSqsSettings.From(configuration));',
      '        services.AddSingleton<SnsSqsConnection>();',
      '        services.AddHostedService(provider => provider.GetRequiredService<SnsSqsConnection>());'
    );
  }
  const domainEvents = [];
  if (bridge) {
    domainEvents.push(`        services.AddScoped<${bridgeClass(model)}>();`);
    if (!outbox) for (const event of model.events) domainEvents.push(`        services.TryAddSingleton<${publisherPort(event)}, ${publisherStub(event)}>();`);
  }
  const body = `/// <summary>
/// La mensajería en el contenedor: la configuración del perfil, el puente de eventos${outbox ? ', el outbox con su relay' : ''}${processed ? ', el registro de mensajes procesados' : ''}${rabbit ? ' y la conexión con RabbitMQ' : ''}${kafka ? ' y la conexión con Kafka' : ''}${snssqs ? ' y la conexión con SNS/SQS' : ''}.
/// El ÚNICO sitio que la registra.
/// </summary>
/// <remarks>
/// Lo que escribe el agente para el broker (BrokerBindings.cs) entra PRIMERO: los respaldos de build se registran con
/// TryAdd y solo ocupan el hueco que el agente deja libre.
/// </remarks>
public static class MessagingRegistration
{
    public static IServiceCollection AddMessaging(this IServiceCollection services, ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var settings = MessagingSettings.From(configuration);
        BrokerBindings.AddBrokerAdapters(services);
${lines.join('\n')}
        BrokerBindings.AddMessageListeners(services);
        return services;
    }

    /// <summary>
    /// Lo que necesitan los adaptadores de repositorio para entregar sus eventos: la configuración y el puente. Lo usan
    /// también las pruebas del cableado, sin broker.
    /// </summary>
    public static IServiceCollection AddDomainEvents(this IServiceCollection services, MessagingSettings settings)
    {
        services.AddSingleton(settings);
${domainEvents.join('\n')}${domainEvents.length > 0 ? '\n' : ''}        return services;
    }
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

/**
 * La nota de la identidad del emisor resuelta contra VARIAS credenciales (resolvedBy, DSL 2.17), la de keel-nest. El diseño
 * escribe `Entidad.campo` como texto: leído como objeto, la nota salía con `undefined` (corrida de control de 2026-10-18).
 */
function resolvedByNote({ entity, field }) {
  return ` El valor leído es UNA de las credenciales de ${entity} (resolvedBy: ${entity}.${field}), no su clave natural: búscalo con I${entity}Repository.${credentialFinderName(field)}(...), que build ya generó, y pasa la clave natural del ${entity} encontrado (lo mismo que hace la puerta HTTP). Buscar por la clave natural resuelve solo la credencial que coincide con ella.`;
}
