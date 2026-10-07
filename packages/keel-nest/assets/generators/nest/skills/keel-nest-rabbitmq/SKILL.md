---
name: keel-nest-rabbitmq
description: Guía de mensajería con RabbitMQ en un proyecto generado por keel-nest — el envío del outbox o de los publishers best-effort y los listeners de las suscripciones, registrados en broker-bindings.ts; la conexión, la topología, el reintento y la DLQ ya los genera build. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

Casi todo lo de RabbitMQ sale **de build**, y es el mismo servidor que el de keel-spring del diseño: mismos
exchanges, colas, DLQ, variables de entorno y tablas. Lo tuyo es poco y concreto: **el envío** y **los
listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/infrastructure/messaging/rabbitmq/rabbit-connection.ts` | Una por proceso; reconecta sola y en cada reconexión vuelve a declarar la topología y a arrancar los consumidores. El servicio arranca SIN broker |
| Topología | `src/infrastructure/messaging/rabbitmq/rabbit-topology.ts` | Consumo: exchange del canal de origen, cola propia (`messaging.subscriptions.<e>.queue`) enlazada con `#`, y su DLQ. Publicación: el exchange del servicio y una cola por canal publicado con el binding de cada routing key |
| Reintento | `rabbit-topology.ts` (`LISTENER_RETRY`, `isRetryable`) | La curva de `onFailure.retry`; NO se reintenta `DomainException` ni `MessageContractViolation`. Agotado o no reintentable: rechazo sin reencolar → DLQ |
| Envoltura y eventos | `event-envelope.ts`, `events/<e>-integration-event.ts` | La `EventEnvelope` del cable (`EventEnvelope.of(...)` y `EventEnvelope.parse(texto)`) |
| Puente | `<servicio>-domain-event-bridge.ts` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `outbox/` | Relay en tres pasos, backoff y rendición; el puerto `OutboxDispatcher` con un respaldo |
| Mensajes | `subscriptions/<e>-message.ts` | `fromWire(data)` y `requireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `idempotency/idempotency-guard.ts` | `alreadyProcessed`/`record`/`tryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `rabbitmq.yaml` | Destino, routing keys, colas, relay y conexión (`RABBITMQ_*`) |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y
  el comentario de cada `subscriptions/<e>-message.ts`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/infrastructure/messaging/rabbitmq/` y se registra en
**`src/infrastructure/messaging/broker-bindings.ts`** (es el component-scan de Spring: nada más lo cablea):

```ts
export const BROKER_ADAPTERS: Provider[] = [{ provide: OutboxDispatcher, useClass: RabbitOutboxDispatcher }];
export const MESSAGE_LISTENERS: Provider[] = [InventoryEventsListener];
```

Lo que registras en `BROKER_ADAPTERS` **sustituye** al respaldo de build por token: no borres los stubs ni el
respaldo del dispatcher (que no deja arrancar fuera de `local`/`test` si un día vuelve a faltar).

### El envío — `reliability: outbox`

El payload que recibes **ya es la `EventEnvelope` serializada**: mándalo tal cual. `publish` resuelve cuando el
broker CONFIRMA y lanza si no hay conexión, si lo rechaza, si el mensaje no tenía cola (`mandatory`) o si vence
el plazo; el relay cuenta ese fallo y reintenta. **No captures nada**: marcar como publicado lo que no salió es
lo que el outbox existe para impedir.

```ts
@Injectable()
export class RabbitOutboxDispatcher extends OutboxDispatcher {
  constructor(@Inject(RabbitConnection) private readonly connection: RabbitConnection) {
    super();
  }

  dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void> {
    return this.connection.publish(destination, routingKey, payload, eventType);
  }
}
```

### El envío — `reliability: best-effort`

Uno por evento, extendiendo su puerto `<Evento>Publisher` (`src/domain/events/`). El puente lo invoca DESPUÉS del
commit; un fallo se registra y el evento se pierde (es lo que el diseño eligió).

```ts
@Injectable()
export class RabbitDailyDigestClosedPublisher extends DailyDigestClosedPublisher {
  constructor(
    @Inject(RabbitConnection) private readonly connection: RabbitConnection,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {
    super();
  }

  publish(event: DailyDigestClosedIntegrationEvent, correlationId: string | null): Promise<void> {
    const payload = toWireJson(EventEnvelope.of(event.metadata, event, correlationId));
    return this.connection.publish(this.settings.destination, this.settings.routingKeys['DailyDigestClosed']!, payload, 'DailyDigestClosed');
  }
}
```

El destino y la routing key salen de `MessagingSettings`, nunca literales; el tipo es el **nombre del evento en
el diseño** (sobre él filtran los consumidores).

### Los listeners — uno por COLA, no por suscripción

Cuenta las colas antes de escribir el primero: varias suscripciones de la misma fuente comparten cola
(`MessagingSettings.subscriptions[<e>].queue`), y dos consumidores de una cola **compiten** — cada mensaje llega
a uno solo. Un listener por cola, que enruta por el tipo:

```ts
@Injectable()
export class InventoryEventsListener implements OnApplicationBootstrap {
  constructor(
    @Inject(RabbitConnection) private readonly connection: RabbitConnection,
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,
    @Inject(IdempotencyGuard) private readonly guard: IdempotencyGuard,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {}

  onApplicationBootstrap(): void {
    this.connection.consume(this.settings.subscriptions['StockReserved']!.queue!, (message) => this.handle(message));
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    const envelope = EventEnvelope.parse(message.content.toString('utf8')); // lanza si no es una envoltura
    await CorrelationContext.runWith(envelope.metadata.correlationId, async () => {
      switch (envelope.metadata.eventType) {
        case 'StockReserved': {
          const payload = StockReservedMessage.fromWire(envelope.data);
          payload.requireContract();
          // El orden que dice el comentario de StockReservedMessage:
          if (await this.guard.alreadyProcessed(InventoryEventsListener.name, envelope.metadata.eventId)) return;
          await this.mediator.dispatch(new ApplyStockReservedCommand({ orderId: payload.orderId! }));
          await this.guard.record(InventoryEventsListener.name, envelope.metadata.eventId);
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

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Retornar confirma y borra el mensaje: un
   cuerpo tuyo que no parsea o incumple el contrato tiene que llegar a la DLQ, y llega lanzando
   (`fromWire`/`requireContract` ya lanzan `MessageContractViolation`, que va al descarte sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del `<Evento>Message`), no tú. Y el reintento en
   memoria repite la MISMA entrega: con `tryRecord` el primer reintento se encuentra el mensaje marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia
   cuando otro camino llegó antes se confirman (y con el orden `record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va a la DLQ sin reintento; cualquier otro error, se reintenta
   con la curva del diseño. No conviertas ni captures para «reintentar».

## Qué no hacer

- **No declares topología** (`assertQueue`, `assertExchange`, `bindQueue`) ni abras otra conexión: build ya
  declara todo y RabbitMQ rechaza con `PRECONDITION_FAILED` una cola redeclarada con otros argumentos.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni otro reintento: son de build.
- **No hagas `channel.ack`/`nack`**: el desenlace lo pone la conexión según lo que haga tu handler.

## Validación

`npm run build` en verde; con la infra arriba, la UI de management (`http://localhost:15672`, guest/guest)
muestra exchanges, colas y mensajes. Las pruebas de flujo usan los helpers del arnés (`deliver<Suscripción>`,
`publishedMessages`, `deadLetterMessages`, `stopBroker`…, `{{keel:docs}}/conventions/integration-tests.md`).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: cola compartida, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
