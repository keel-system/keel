---
name: keel-nest-snssqs
description: Guía de mensajería con Amazon SNS/SQS (LocalStack en local) en un proyecto generado por keel-nest — el envío del outbox o de los publishers best-effort y un listener por suscripción, registrados en broker-bindings.ts; la conexión, la resolución del topic, el sondeo de las colas, la curva del reintento y la DLQ ya los genera build, y la topología la siembra infra/init-messaging.sh. Usar cuando keel-stack.json declara broker "snssqs".
---

# SNS/SQS (broker: `snssqs`)

Casi todo lo de SNS/SQS sale **de build**, y es el mismo servidor que el de keel-spring del diseño: mismos topics,
colas, DLQ, `maxReceiveCount`, variables de entorno y tablas. Lo tuyo es poco y concreto: **el envío** y **los
listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/infrastructure/messaging/snssqs/snssqs-connection.ts` | Un cliente de SNS y uno de SQS, y un sondeo largo por suscripción. El servicio arranca SIN broker: el sondeo reintenta mientras la cola no existe o LocalStack no responde |
| Publicación | `SnsSqsConnection.publish` | Resuelve el ARN LISTANDO los topics y exigiendo un suscriptor confirmado: nunca crea el topic (un topic sin suscriptores descarta lo publicado sin error) |
| Consumo y reintento | `src/infrastructure/messaging/snssqs/snssqs-consumption.ts` | Por suscripción: su cola, su DLQ y su `maxReceiveCount` (los de `init-messaging.sh`), y la curva de `onFailure.retry` aplicada alargando la VISIBILIDAD del mensaje. NO se reintenta `DomainException` ni `MessageContractViolation`: van directos a la DLQ |
| Topología | `infra/init-messaging.sh` | Topics, colas, DLQ con su RedrivePolicy y suscripciones SNS→SQS con raw delivery y filtro por `eventType`. **No la crees a mano ni escribas otro script** |
| Envoltura y eventos | `event-envelope.ts`, `events/<e>-integration-event.ts` | La `EventEnvelope` del cable (`EventEnvelope.of(...)` y `EventEnvelope.parse(texto)`) |
| Puente | `<servicio>-domain-event-bridge.ts` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `outbox/` | Relay en tres pasos, backoff y rendición; el puerto `OutboxDispatcher` con un respaldo |
| Mensajes | `subscriptions/<e>-message.ts` | `fromWire(data)` y `requireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `idempotency/idempotency-guard.ts` | `alreadyProcessed`/`record`/`tryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `snssqs.yaml` | Destino, routing keys, colas, relay y conexión (`AWS_*`) |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "snssqs"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y
  el comentario de cada `subscriptions/<e>-message.ts`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.
- **Siembra la topología** antes de arrancar nada: `bash infra/init-messaging.sh` (idempotente; LocalStack la
  pierde al reiniciarse) y `bash infra/validate-infra.sh`, que comprueba que cada topic y cada cola existan.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/infrastructure/messaging/snssqs/` y se registra en
**`src/infrastructure/messaging/broker-bindings.ts`** (es el component-scan de Spring: nada más lo cablea):

```ts
export const BROKER_ADAPTERS: Provider[] = [{ provide: OutboxDispatcher, useClass: SnsOutboxDispatcher }];
export const MESSAGE_LISTENERS: Provider[] = [StockReservedListener, StockRejectedListener];
```

Lo que registras en `BROKER_ADAPTERS` **sustituye** al respaldo de build por token: no borres los stubs ni el
respaldo del dispatcher (que no deja arrancar fuera de `local`/`test` si un día vuelve a faltar).

### El envío — `reliability: outbox`

El payload que recibes **ya es la `EventEnvelope` serializada**: publícalo tal cual, con el **tipo del evento
como message attribute `eventType`** (y la routing key como `routingKey`). `publish` resuelve cuando SNS lo
acepta y lanza si el topic no existe, no tiene suscriptor confirmado o SNS no responde; el relay cuenta ese fallo
y reintenta. **No captures nada**.

```ts
@Injectable()
export class SnsOutboxDispatcher extends OutboxDispatcher {
  constructor(@Inject(SnsSqsConnection) private readonly connection: SnsSqsConnection) {
    super();
  }

  dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void> {
    return this.connection.publish(destination, payload, { eventType, routingKey });
  }
}
```

`eventType` no es decorativo: cada cola está suscrita al topic con una `FilterPolicy` sobre ese atributo, y un
mensaje sin él no llega a ninguna — sin error, sin log. Por eso `publish` lanza si falta.

### El envío — `reliability: best-effort`

Uno por evento, extendiendo su puerto `<Evento>Publisher` (`src/domain/events/`). El puente lo invoca DESPUÉS del
commit; un fallo se registra y el evento se pierde (es lo que el diseño eligió).

```ts
@Injectable()
export class SnsDailyDigestClosedPublisher extends DailyDigestClosedPublisher {
  constructor(
    @Inject(SnsSqsConnection) private readonly connection: SnsSqsConnection,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {
    super();
  }

  publish(event: DailyDigestClosedIntegrationEvent, correlationId: string | null): Promise<void> {
    const payload = toWireJson(EventEnvelope.of(event.metadata, event, correlationId));
    const routingKey = this.settings.routingKeys['DailyDigestClosed']!;
    return this.connection.publish(this.settings.destination, payload, { eventType: 'DailyDigestClosed', routingKey });
  }
}
```

El destino y la routing key salen de `MessagingSettings`, nunca literales; el tipo es el **nombre del evento en
el diseño**.

### Los listeners — uno por SUSCRIPCIÓN, cada uno sobre su cola

Cada suscripción tiene su **cola propia** (`MessagingSettings.subscriptions[<e>].queue`), suscrita al topic de la
fuente con un filtro por su `eventType`: a la cola de una suscripción solo le llegan los mensajes de su tipo. Un
listener por suscripción, que se registra con `connection.consume('<Suscripción>', …)`:

```ts
@Injectable()
export class StockReservedListener implements OnApplicationBootstrap {
  private static readonly HANDLER = 'StockReservedListener';

  constructor(
    @Inject(SnsSqsConnection) private readonly connection: SnsSqsConnection,
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,
    @Inject(IdempotencyGuard) private readonly guard: IdempotencyGuard
  ) {}

  onApplicationBootstrap(): void {
    // La suscripción por su NOMBRE en el diseño: la cola la pone la conexión.
    this.connection.consume('StockReserved', (message) => this.handle(message));
  }

  private async handle(message: InboundMessage): Promise<void> {
    const envelope = EventEnvelope.parse(message.body); // lanza si no es una envoltura
    // El filtro de la suscripción ya deja fuera los demás tipos; comprobarlo cuesta una línea y no depende de él.
    if (envelope.metadata.eventType !== 'StockReserved') return;
    await CorrelationContext.runWith(envelope.metadata.correlationId, async () => {
      const payload = StockReservedMessage.fromWire(envelope.data);
      payload.requireContract();
      // El orden que dice el comentario de StockReservedMessage:
      if (await this.guard.alreadyProcessed(StockReservedListener.HANDLER, envelope.metadata.eventId)) return;
      await this.mediator.dispatch(new ApplyStockReservedCommand({ orderId: payload.orderId! }));
      await this.guard.record(StockReservedListener.HANDLER, envelope.metadata.eventId);
    });
  }
}
```

Las cuatro reglas que deciden si un mensaje se pierde, en `references/listeners.md` con su porqué:

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Retornar borra el mensaje de la cola: un
   cuerpo tuyo que no parsea o incumple el contrato tiene que llegar a la DLQ, y llega lanzando
   (`fromWire`/`requireContract` ya lanzan `MessageContractViolation`, que va a la DLQ sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del `<Evento>Message`), no tú. Y la siguiente
   recepción del mismo mensaje lleva el mismo `eventId`: con `tryRecord`, la segunda lo encuentra marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia
   cuando otro camino llegó antes se confirman (y con el orden `record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va a la DLQ sin reintento; cualquier otro error, vuelve a la cola
   con la curva del diseño y, al agotar `maxReceiveCount`, la RedrivePolicy lo lleva a la DLQ.

## Qué no hacer

- **No crees topics ni colas** ni escribas otro aprovisionamiento: es de `init-messaging.sh`, y en AWS real de la
  plataforma. Tampoco publiques con algo que cree el topic al resolverlo.
- **No uses el `MessageId` de SQS para deduplicar**: cambia en cada reenvío a la cola. La clave es la del
  contrato (con envoltura Keel, `metadata.eventId`).
- **No borres mensajes ni cambies su visibilidad a mano**, ni escribas otro reintento: el desenlace lo pone la
  conexión según lo que haga tu handler.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No dejes una promesa sin esperar** (`void this.connection.publish(...)`): con el broker caído es un rechazo
  sin manejar, y en Node eso tumba el proceso.

## Validación

`npm run build` en verde; con la infra arriba y la topología sembrada, desde devtools:
`aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` y
`… sqs receive-message --queue-url http://localstack:4566/000000000000/<cola>` para inspeccionar. Las pruebas de
flujo usan los helpers del arnés (`deliver<Suscripción>`, `publishedMessages`, `deadLetterMessages`,
`stopBroker`…, `{{keel:docs}}/conventions/integration-tests.md`): `startBroker` vuelve a sembrar la topología y
espera a que la suscripción entregue antes de devolver el control.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: la cola de la suscripción, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va a la DLQ o el outbox se rinde |
