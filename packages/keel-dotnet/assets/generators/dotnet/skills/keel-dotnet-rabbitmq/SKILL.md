---
name: keel-dotnet-rabbitmq
description: Guía de mensajería con RabbitMQ en un proyecto generado por keel-dotnet — el envío del outbox o de los publishers best-effort y los listeners de las suscripciones, registrados en BrokerBindings.cs; la conexión, la topología, el reintento y la DLQ ya los genera build. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

Casi todo lo de RabbitMQ sale **de build**, y es el mismo servidor que los de keel-spring y keel-nest del diseño:
mismos exchanges, colas, DLQ, variables de entorno y tablas. Lo tuyo es poco y concreto: **el envío** y **los
listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/<Raíz>.Infrastructure/Messaging/RabbitMq/RabbitConnection.cs` | Una por proceso, con recuperación automática; al conectar declara la topología y arranca los consumidores registrados. El servicio arranca SIN broker |
| Topología | `src/<Raíz>.Infrastructure/Messaging/RabbitMq/RabbitTopology.cs` | Consumo: exchange del canal de origen, cola propia (`messaging.subscriptions.<e>.queue`) enlazada con `#`, y su DLQ. Publicación: el exchange del servicio y una cola por canal publicado con el binding de cada routing key |
| Reintento | `RabbitTopology.cs` (`Retry`, `IsRetryable`) | La curva de `onFailure.retry`; NO se reintenta `DomainException` ni `MessageContractViolation`. Agotado o no reintentable: rechazo sin reencolar → DLQ |
| Envoltura y eventos | `src/<Raíz>.Infrastructure/Messaging/EventEnvelope.cs`, `Messaging/Events/` | La envoltura del cable (`EventEnvelope.Of`, `EventEnvelope.ToWire`, `EventEnvelope.Parse`) |
| Puente | `src/<Raíz>.Infrastructure/Messaging/<Raíz>DomainEventBridge.cs` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `src/<Raíz>.Infrastructure/Messaging/Outbox/` | Relay en tres pasos, backoff y rendición; el puerto `IOutboxDispatcher` con un respaldo |
| Mensajes | `src/<Raíz>.Infrastructure/Messaging/Subscriptions/` | `FromWire(data)` y `RequireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `src/<Raíz>.Infrastructure/Messaging/Idempotency/IdempotencyGuard.cs` | `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `rabbitmq.yaml` | Destino, routing keys, colas, relay y conexión (`RABBITMQ_*`), en `MessagingSettings` |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje de `Messaging/Subscriptions/`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/<Raíz>.Infrastructure/Messaging/RabbitMq/` y se registra en
**`src/<Raíz>.Infrastructure/Messaging/BrokerBindings.cs`** (es el component-scan de Spring: nada más lo cablea):

```csharp
public static class BrokerBindings
{
    public static void AddBrokerAdapters(IServiceCollection services) =>
        services.AddSingleton<IOutboxDispatcher, RabbitOutboxDispatcher>();

    public static void AddMessageListeners(IServiceCollection services) =>
        services.AddHostedService<InventoryEventsListener>();
}
```

`AddBrokerAdapters` se llama ANTES que los respaldos de build, que entran con `TryAdd`: lo tuyo ocupa el hueco. No
borres los respaldos (`<Evento>PublisherStub`, `OutboxDispatcherFallback`, que no deja arrancar fuera de `local`/`test`
si un día vuelve a faltar el dispatcher).

### El envío — `reliability: outbox`

El payload que recibes **ya es la envoltura serializada**: mándalo tal cual. `Publish` termina cuando el broker
CONFIRMA y lanza `BrokerUnavailableException` si no hay conexión, si lo rechaza, si el mensaje no tenía cola
(`mandatory`) o si vence el plazo; el relay cuenta ese fallo y reintenta. **No captures nada**: marcar como publicado
lo que no salió es lo que el outbox existe para impedir.

```csharp
public sealed class RabbitOutboxDispatcher(RabbitConnection connection) : IOutboxDispatcher
{
    public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default) =>
        connection.Publish(destination, routingKey, payload, eventType, cancellationToken: cancellationToken);
}
```

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `I<Evento>Publisher` (`Messaging/`). El puente lo invoca DESPUÉS del commit;
un fallo se registra y el evento se pierde (es lo que el diseño eligió).

```csharp
public sealed class RabbitDailyDigestClosedPublisher(RabbitConnection connection, MessagingSettings settings) : IDailyDigestClosedPublisher
{
    public Task Publish(DailyDigestClosedIntegrationEvent integrationEvent, string? correlationId, CancellationToken cancellationToken = default)
    {
        var payload = EventEnvelope.ToWire(EventEnvelope.Of(integrationEvent.Metadata, integrationEvent, correlationId));
        return connection.Publish(settings.Destination, settings.RoutingKeys["DailyDigestClosed"], payload, "DailyDigestClosed", cancellationToken: cancellationToken);
    }
}
```

Se registra con `services.AddSingleton<IDailyDigestClosedPublisher, RabbitDailyDigestClosedPublisher>()`. El destino y
la routing key salen de `MessagingSettings`, nunca literales; el tipo es el **nombre del evento en el diseño** (sobre
él filtran los consumidores).

### Los listeners — uno por COLA, no por suscripción

Cuenta las colas antes de escribir el primero: varias suscripciones de la misma fuente comparten cola
(`MessagingSettings.Subscriptions[<e>].Queue`, y la lista de cada cola en `BrokerBindings.cs`), y dos consumidores de
una cola **compiten** — cada mensaje llega a uno solo. Un listener por cola, un `IHostedService` que enruta por el tipo
y abre un ámbito de DI por mensaje para despachar:

```csharp
public sealed class InventoryEventsListener(RabbitConnection connection, IServiceScopeFactory scopes, IdempotencyGuard guard, MessagingSettings settings) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        connection.Consume(settings.Subscriptions["StockReserved"].Queue!, Handle);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task Handle(RabbitMessage message, CancellationToken cancellationToken)
    {
        var envelope = EventEnvelope.Parse(message.Body); // lanza MessageContractViolation si no es una envoltura
        await InboundContext.Run(envelope.Metadata, async () =>
        {
            switch (envelope.Metadata.EventType)
            {
                case "StockReserved":
                {
                    var payload = StockReservedMessage.FromWire(envelope.Data);
                    payload.RequireContract();
                    var eventId = envelope.Metadata.EventId;
                    // El orden que dice el comentario de StockReservedMessage:
                    if (await guard.AlreadyProcessed(nameof(InventoryEventsListener), eventId, cancellationToken)) return;
                    await using (var scope = scopes.CreateAsyncScope())
                    {
                        await scope.ServiceProvider.GetRequiredService<IUseCaseMediator>()
                            .Dispatch(new ApplyStockReservedCommand { OrderId = payload.OrderId!.Value }, cancellationToken);
                    }
                    await guard.Record(nameof(InventoryEventsListener), eventId, cancellationToken);
                    return;
                }
                default:
                    return; // un evento de la fuente que este servicio no consume: se confirma sin efecto
            }
        });
    }
}
```

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Retornar confirma y borra el mensaje: un cuerpo
   tuyo que no parsea o incumple el contrato tiene que llegar a la DLQ, y llega lanzando (`FromWire`/`RequireContract`
   ya lanzan `MessageContractViolation`, que va al descarte sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del mensaje), no tú. Y el reintento en memoria repite la
   MISMA entrega: con `TryRecord` el primer reintento se encuentra el mensaje marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia cuando
   otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va a la DLQ sin reintento; cualquier otro error se reintenta con la curva
   del diseño. No conviertas ni captures para «reintentar».

## Qué no hacer

- **No declares topología** (`ExchangeDeclareAsync`, `QueueDeclareAsync`, `QueueBindAsync`) ni abras otra conexión o
  canal: build ya declara todo y RabbitMQ rechaza con `PRECONDITION_FAILED` una cola redeclarada con otros argumentos.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni otro reintento: son de build.
- **No hagas `BasicAckAsync`/`BasicNackAsync`**: el desenlace lo pone la conexión según lo que haga tu handler.
- **No uses MassTransit** ni otra capa encima: pasó a licencia comercial, y el contrato ya está entero.

## Validación

`dotnet build` sin warnings; con la infra arriba, la UI de management (`http://localhost:15672`, guest/guest) muestra
exchanges, colas, mensajes y la conexión del servicio (con el nombre del servicio). Las pruebas de flujo usan los
helpers del arnés (`Deliver<Suscripción>`, `PublishedMessages`, `DeadLetterMessages`, `StopBroker`…,
`{{keel:docs}}/conventions/integration-tests.md`).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: cola compartida, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
