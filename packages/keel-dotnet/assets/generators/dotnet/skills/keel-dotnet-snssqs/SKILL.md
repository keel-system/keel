---
name: keel-dotnet-snssqs
description: Guía de mensajería con Amazon SNS/SQS (LocalStack en local) en un proyecto generado por keel-dotnet — el envío del outbox o de los publishers best-effort y un listener por suscripción, registrados en BrokerBindings.cs; la conexión, la resolución del topic, el sondeo de las colas, la curva del reintento y la DLQ ya los genera build, y la topología la siembra infra/init-messaging.sh. Usar cuando keel-stack.json declara broker "snssqs".
---

# SNS/SQS (broker: `snssqs`)

Casi todo lo de SNS/SQS sale **de build**, y es el mismo servidor que los de keel-spring y keel-nest del diseño: mismos
topics, colas, DLQ, `maxReceiveCount`, variables de entorno y tablas. Lo tuyo es poco y concreto: **el envío** y **los
listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/<Raíz>.Infrastructure/Messaging/SnsSqs/SnsSqsConnection.cs` | Un cliente de SNS y uno de SQS del SDK oficial de AWS, y un sondeo largo por suscripción. El servicio arranca SIN broker: el sondeo reintenta mientras la cola no existe o LocalStack no responde |
| Publicación | `SnsSqsConnection.Publish` | Resuelve el ARN LISTANDO los topics y exigiendo un suscriptor confirmado: nunca crea el topic (un topic sin suscriptores descarta lo publicado sin error) |
| Consumo y reintento | `src/<Raíz>.Infrastructure/Messaging/SnsSqs/SnsSqsConsumption.cs` | Por suscripción: su cola, su DLQ y su `maxReceiveCount` (los de `init-messaging.sh`), y la curva de `onFailure.retry` aplicada alargando la VISIBILIDAD del mensaje. NO se reintenta `DomainException` ni `MessageContractViolation`: van directos a la DLQ |
| Topología | `infra/init-messaging.sh` | Topics, colas, DLQ con su RedrivePolicy y suscripciones SNS→SQS con raw delivery y filtro por `eventType`. **No la crees a mano ni escribas otro script** |
| Envoltura y eventos | `src/<Raíz>.Infrastructure/Messaging/EventEnvelope.cs`, `Messaging/Events/` | La envoltura del cable (`EventEnvelope.Of`, `EventEnvelope.ToWire`, `EventEnvelope.Parse`) |
| Puente | `src/<Raíz>.Infrastructure/Messaging/<Raíz>DomainEventBridge.cs` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `src/<Raíz>.Infrastructure/Messaging/Outbox/` | Relay en tres pasos, backoff y rendición; el puerto `IOutboxDispatcher` con un respaldo |
| Mensajes | `src/<Raíz>.Infrastructure/Messaging/Subscriptions/` | `FromWire(data)` y `RequireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `src/<Raíz>.Infrastructure/Messaging/Idempotency/IdempotencyGuard.cs` | `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `snssqs.yaml` | Destino, routing keys, colas, relay y conexión (`AWS_*`), en `MessagingSettings` |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "snssqs"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje de `Messaging/Subscriptions/`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.
- **Siembra la topología** antes de arrancar nada: `bash infra/init-messaging.sh` (idempotente; LocalStack la pierde al
  reiniciarse) y `bash infra/validate-infra.sh`, que comprueba que cada topic y cada cola existan.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/<Raíz>.Infrastructure/Messaging/SnsSqs/` y se registra en
**`src/<Raíz>.Infrastructure/Messaging/BrokerBindings.cs`** (es el component-scan de Spring: nada más lo cablea):

```csharp
public static class BrokerBindings
{
    public static void AddBrokerAdapters(IServiceCollection services) =>
        services.AddSingleton<IOutboxDispatcher, SnsOutboxDispatcher>();

    public static void AddMessageListeners(IServiceCollection services)
    {
        services.AddHostedService<StockReservedListener>();
        services.AddHostedService<StockRejectedListener>();
    }
}
```

`AddBrokerAdapters` se llama ANTES que los respaldos de build, que entran con `TryAdd`: lo tuyo ocupa el hueco. No
borres los respaldos (`<Evento>PublisherStub`, `OutboxDispatcherFallback`, que no deja arrancar fuera de `local`/`test`
si un día vuelve a faltar el dispatcher).

### El envío — `reliability: outbox`

El payload que recibes **ya es la envoltura serializada**: publícalo tal cual, con el **tipo del evento como message
attribute `eventType`** (y la routing key como `routingKey`). `Publish` termina cuando SNS lo acepta y lanza
`BrokerUnavailableException` si el topic no existe, no tiene suscriptor confirmado o SNS no responde; el relay cuenta ese
fallo y reintenta. **No captures nada**: marcar como publicado lo que no salió es lo que el outbox existe para impedir.

```csharp
public sealed class SnsOutboxDispatcher(SnsSqsConnection connection) : IOutboxDispatcher
{
    public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default) =>
        connection.Publish(destination, payload, new Dictionary<string, string> { ["eventType"] = eventType, ["routingKey"] = routingKey }, cancellationToken);
}
```

`eventType` no es decorativo: cada cola está suscrita al topic con una `FilterPolicy` sobre ese atributo, y un mensaje
sin él no llega a ninguna — sin error, sin log. Por eso `Publish` lanza si falta.

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `I<Evento>Publisher` (`Messaging/`). El puente lo invoca DESPUÉS del commit; un
fallo se registra y el evento se pierde (es lo que el diseño eligió).

```csharp
public sealed class SnsDailyDigestClosedPublisher(SnsSqsConnection connection, MessagingSettings settings) : IDailyDigestClosedPublisher
{
    public Task Publish(DailyDigestClosedIntegrationEvent integrationEvent, string? correlationId, CancellationToken cancellationToken = default)
    {
        var payload = EventEnvelope.ToWire(EventEnvelope.Of(integrationEvent.Metadata, integrationEvent, correlationId));
        var attributes = new Dictionary<string, string> { ["eventType"] = "DailyDigestClosed", ["routingKey"] = settings.RoutingKeys["DailyDigestClosed"] };
        return connection.Publish(settings.Destination, payload, attributes, cancellationToken);
    }
}
```

Se registra con `services.AddSingleton<IDailyDigestClosedPublisher, SnsDailyDigestClosedPublisher>()`. El destino y la
routing key salen de `MessagingSettings`, nunca literales; el tipo es el **nombre del evento en el diseño**.

### Los listeners — uno por SUSCRIPCIÓN, cada uno sobre su cola

Cada suscripción tiene su **cola propia** (`MessagingSettings.Subscriptions[<e>].Queue`), suscrita al topic de la fuente
con un filtro por su `eventType`: a la cola de una suscripción solo le llegan los mensajes de su tipo. Un listener por
suscripción, que se registra con `connection.Consume("<Suscripción>", …)`:

```csharp
public sealed class StockReservedListener(SnsSqsConnection connection, IServiceScopeFactory scopes, IdempotencyGuard guard) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        // La suscripción por su NOMBRE en el diseño: la cola la pone la conexión.
        connection.Consume("StockReserved", Handle);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task Handle(SqsMessage message, CancellationToken cancellationToken)
    {
        var envelope = EventEnvelope.Parse(message.Body); // lanza MessageContractViolation si no es una envoltura
        // El filtro de la suscripción ya deja fuera los demás tipos; comprobarlo cuesta una línea y no depende de él.
        if (envelope.Metadata.EventType != "StockReserved") return;
        await InboundContext.Run(envelope.Metadata, async () =>
        {
            var payload = StockReservedMessage.FromWire(envelope.Data);
            payload.RequireContract();
            var eventId = envelope.Metadata.EventId;
            // El orden que dice el comentario de StockReservedMessage:
            if (await guard.AlreadyProcessed(nameof(StockReservedListener), eventId, cancellationToken)) return;
            await using (var scope = scopes.CreateAsyncScope())
            {
                await scope.ServiceProvider.GetRequiredService<IUseCaseMediator>()
                    .Dispatch(new ApplyStockReservedCommand { OrderId = payload.OrderId!.Value }, cancellationToken);
            }
            await guard.Record(nameof(StockReservedListener), eventId, cancellationToken);
        });
    }
}
```

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Terminar borra el mensaje de la cola: un cuerpo tuyo
   que no parsea o incumple el contrato tiene que llegar a la DLQ, y llega lanzando (`FromWire`/`RequireContract` ya
   lanzan `MessageContractViolation`, que va a la DLQ sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del mensaje), no tú. Y la siguiente recepción del mismo
   mensaje lleva el mismo `EventId`: con `TryRecord`, la segunda lo encuentra marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia cuando
   otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va a la DLQ sin reintento; cualquier otro error vuelve a la cola con la
   curva del diseño y, al agotar `maxReceiveCount`, la RedrivePolicy lo lleva a la DLQ.

## Qué no hacer

- **No crees topics ni colas** ni escribas otro aprovisionamiento: es de `init-messaging.sh`, y en AWS real de la
  plataforma. Tampoco publiques con algo que cree el topic al resolverlo (`CreateTopic` es idempotente y por eso
  tienta: devuelve un topic sin suscriptores).
- **No uses el `MessageId` de SQS para deduplicar**: cambia en cada reenvío a la cola. La clave es la del contrato (con
  envoltura Keel, `Metadata.EventId`).
- **No borres mensajes ni cambies su visibilidad a mano**, ni escribas otro reintento: el desenlace lo pone la conexión
  según lo que haga tu handler.
- **No abras otro cliente de SNS o SQS**: la conexión ya trae las credenciales, los endpoints de LocalStack y los
  tiempos de cada perfil.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No uses MassTransit** ni otra capa encima: pasó a licencia comercial, y el contrato ya está entero.

## Validación

`dotnet build` sin warnings; con la infra arriba y la topología sembrada, desde devtools:
`aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` y
`… sqs receive-message --queue-url http://localstack:4566/000000000000/<cola>` para inspeccionar. Las pruebas de flujo
usan los helpers del arnés (`Deliver<Suscripción>`, `PublishedMessages`, `DeadLetterMessages`, `StopBroker`…,
`{{keel:docs}}/conventions/integration-tests.md`): `StartBroker` vuelve a sembrar la topología y espera a que la
suscripción entregue antes de devolver el control.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: la cola de la suscripción, el ámbito de DI, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
