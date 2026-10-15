---
name: keel-dotnet-kafka
description: Guía de mensajería con Apache Kafka en un proyecto generado por keel-dotnet — el envío del outbox o de los publishers best-effort y un listener por suscripción, registrados en BrokerBindings.cs; la conexión, los consumer groups, el reintento y el descarte en <topic>.DLT ya los genera build. Usar cuando keel-stack.json declara broker "kafka".
---

# Kafka (broker: `kafka`)

Casi todo lo de Kafka sale **de build**, y es el mismo servidor que los de keel-spring y keel-nest del diseño: mismos
topics, consumer groups, curva de reintento, descarte en `<topic>.DLT`, variables de entorno y tablas. Lo tuyo es poco
y concreto: **el envío** y **los listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/<Raíz>.Infrastructure/Messaging/Kafka/KafkaConnection.cs` | Un productor (acks de todas las réplicas, idempotente) y un consumidor por suscripción, cada uno en su hilo. El servicio arranca SIN broker: librdkafka conecta en segundo plano y se reconecta solo |
| Consumo | `src/<Raíz>.Infrastructure/Messaging/Kafka/KafkaConsumption.cs` | Por suscripción: su topic, su consumer group (`messaging.subscriptions.<e>.group-id`) y si descarta en `<topic>.DLT` |
| Reintento y descarte | `KafkaConsumption.cs` (`Retry`, `IsRetryable`) y la conexión | La curva de `onFailure.retry`; NO se reintenta `DomainException` ni `MessageContractViolation`. Agotado o no reintentable: a `<topic>.DLT` (con los headers de Spring Kafka) si el topic lo declara, o se registra y se confirma |
| Envoltura y eventos | `src/<Raíz>.Infrastructure/Messaging/EventEnvelope.cs`, `Messaging/Events/` | La envoltura del cable (`EventEnvelope.Of`, `EventEnvelope.ToWire`, `EventEnvelope.Parse`) |
| Puente | `src/<Raíz>.Infrastructure/Messaging/<Raíz>DomainEventBridge.cs` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `src/<Raíz>.Infrastructure/Messaging/Outbox/` | Relay en tres pasos, backoff y rendición; el puerto `IOutboxDispatcher` con un respaldo |
| Mensajes | `src/<Raíz>.Infrastructure/Messaging/Subscriptions/` | `FromWire(data)` y `RequireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `src/<Raíz>.Infrastructure/Messaging/Idempotency/IdempotencyGuard.cs` | `AlreadyProcessed`/`Record`/`TryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `kafka.yaml` | Destino, routing keys, topics, grupos, relay y conexión (`KAFKA_*`), en `MessagingSettings` |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "kafka"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y el
  comentario de cada mensaje de `Messaging/Subscriptions/`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.

## Topología: los topics no los crea la aplicación

**No crees topics** (ni con el `AdminClient` ni con ninguna otra cosa). En `infra/` los autocrea el broker con el
PRIMER mensaje, con una partición, que es lo que la infraestructura de prueba quiere; en producción los aprovisiona la
plataforma con su retención, sus réplicas y sus particiones. Que un topic no exista hasta el primer mensaje es normal:
el perfil `local` refresca los metadatos cada 2 s para que el consumidor lo vea enseguida, y el arnés lee un topic
inexistente como «no hay mensajes». Es la misma regla que la skill `keel-spring-kafka` § Topología: las particiones no
se reducen nunca, y crear topics exige permisos que un servicio no debe tener.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/<Raíz>.Infrastructure/Messaging/Kafka/` y se registra en
**`src/<Raíz>.Infrastructure/Messaging/BrokerBindings.cs`** (es el component-scan de Spring: nada más lo cablea):

```csharp
public static class BrokerBindings
{
    public static void AddBrokerAdapters(IServiceCollection services) =>
        services.AddSingleton<IOutboxDispatcher, KafkaOutboxDispatcher>();

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

El payload que recibes **ya es la envoltura serializada**: mándalo tal cual, con la **routing key como clave del
registro**. `Publish` termina cuando el broker CONFIRMA y lanza `BrokerUnavailableException` si no hay broker o si vence
`delivery.timeout.ms`; el relay cuenta ese fallo y reintenta. **No captures nada**: marcar como publicado lo que no
salió es lo que el outbox existe para impedir.

```csharp
public sealed class KafkaOutboxDispatcher(KafkaConnection connection) : IOutboxDispatcher
{
    public Task Dispatch(string destination, string routingKey, string eventType, string payload, CancellationToken cancellationToken = default) =>
        connection.Publish(destination, routingKey, payload, cancellationToken: cancellationToken);
}
```

La clave es la routing key y no el id del agregado: es lo que agrupa por tipo de evento y lo que asume el resto de la
cadena (el arnés incluido). Si el diseño exige orden por entidad, la clave correcta es el id del agregado — decídelo
una vez por evento y dilo en el código: cambiarla en caliente rompe el orden durante la transición.

### El envío — `reliability: best-effort`

Uno por evento, implementando su puerto `I<Evento>Publisher` (`Messaging/`). El puente lo invoca DESPUÉS del commit;
un fallo se registra y el evento se pierde (es lo que el diseño eligió).

```csharp
public sealed class KafkaDailyDigestClosedPublisher(KafkaConnection connection, MessagingSettings settings) : IDailyDigestClosedPublisher
{
    public Task Publish(DailyDigestClosedIntegrationEvent integrationEvent, string? correlationId, CancellationToken cancellationToken = default)
    {
        var payload = EventEnvelope.ToWire(EventEnvelope.Of(integrationEvent.Metadata, integrationEvent, correlationId));
        return connection.Publish(settings.Destination, settings.RoutingKeys["DailyDigestClosed"], payload, cancellationToken: cancellationToken);
    }
}
```

Se registra con `services.AddSingleton<IDailyDigestClosedPublisher, KafkaDailyDigestClosedPublisher>()`. El destino y
la routing key salen de `MessagingSettings`, nunca literales.

### Los listeners — uno por SUSCRIPCIÓN, cada uno con su consumer group

Al revés que con RabbitMQ: cada suscripción tiene su **propio consumer group** (`<servicio>-<evento>`, en
`MessagingSettings.Subscriptions[<e>].GroupId`), y cada grupo recibe el topic **entero**. Dos suscripciones de la misma
fuente leen el mismo topic, y cada listener descarta lo que no es suyo por el tipo. Un listener para dos suscripciones
con un solo grupo haría que Kafka les repartiera las particiones: cada una vería un trozo del tráfico, y el resto se
perdería sin un error.

```csharp
public sealed class StockReservedListener(KafkaConnection connection, IServiceScopeFactory scopes, IdempotencyGuard guard) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        // La suscripción por su NOMBRE en el diseño: el topic y el grupo los pone la conexión.
        connection.Consume("StockReserved", Handle);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task Handle(KafkaMessage message, CancellationToken cancellationToken)
    {
        var envelope = EventEnvelope.Parse(message.Value); // lanza MessageContractViolation si no es una envoltura
        // El topic transporta TODOS los eventos de la fuente: lo ajeno se confirma sin efecto, SIN lanzar.
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

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Terminar confirma (el offset avanza): un cuerpo tuyo
   que no parsea o incumple el contrato tiene que llegar a `<topic>.DLT`, y llega lanzando (`FromWire`/`RequireContract`
   ya lanzan `MessageContractViolation`, que va al descarte sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del mensaje), no tú. Y el reintento en memoria repite la
   MISMA entrega: con `TryRecord` el primer reintento se encuentra el mensaje marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia cuando
   otro camino llegó antes se confirman (y con el orden `Record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va al descarte sin reintento; cualquier otro error se reintenta con la
   curva del diseño. No conviertas ni captures para «reintentar».

## Qué no hacer

- **No crees topics** ni otra cadena de reintento (`<topic>-retry`, otro `.DLT`): el descarte es `<topic>.DLT`, el que
  usa build y el que lee el arnés. Uno con otro nombre haría que «no acabó en el descarte» mirara un topic que nadie
  alimenta.
- **No abras otro productor ni otro consumidor**, ni compongas un `group.id`: el grupo es el de
  `messaging.subscriptions.<e>.group-id`, y el arnés espera a ESOS grupos.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni guardes offsets a mano: el desenlace lo pone la conexión según lo que
  haga tu handler.
- **No uses MassTransit** ni otra capa encima: pasó a licencia comercial, y el contrato ya está entero.

## Validación

`dotnet build` sin warnings; con la infra arriba, desde devtools, `kcat -b kafka:29092 -L` (metadatos) y
`kcat -b kafka:29092 -C -t <topic> -o beginning -e` (lo publicado). Las pruebas de flujo usan los helpers del arnés
(`Deliver<Suscripción>`, `PublishedMessages`, `DeadLetterMessages`, `StopBroker`…,
`{{keel:docs}}/conventions/integration-tests.md`): con Kafka no hay purga, y el aislamiento entre flujos es una marca de
offset que el arnés pone solo.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: un grupo por suscripción, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va al descarte o el outbox se rinde |
