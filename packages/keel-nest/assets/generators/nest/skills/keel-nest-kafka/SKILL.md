---
name: keel-nest-kafka
description: Guía de mensajería con Apache Kafka en un proyecto generado por keel-nest — el envío del outbox o de los publishers best-effort y un listener por suscripción, registrados en broker-bindings.ts; la conexión, los consumer groups, el reintento y el descarte en <topic>.DLT ya los genera build. Usar cuando keel-stack.json declara broker "kafka".
---

# Kafka (broker: `kafka`)

Casi todo lo de Kafka sale **de build**, y es el mismo servidor que el de keel-spring del diseño: mismos topics,
consumer groups, curva de reintento, descarte en `<topic>.DLT`, variables de entorno y tablas. Lo tuyo es poco y
concreto: **el envío** y **los listeners**. No reescribas lo demás.

| Pieza (build) | Dónde | Qué hace |
|---|---|---|
| Conexión | `src/infrastructure/messaging/kafka/kafka-connection.ts` | Un productor (acks de todas las réplicas, idempotente) y un consumidor por suscripción. El servicio arranca SIN broker: se conecta en segundo plano y reintenta; después librdkafka se reconecta solo |
| Consumo | `src/infrastructure/messaging/kafka/kafka-consumption.ts` | Por suscripción: su topic, su consumer group (`messaging.subscriptions.<e>.group-id`) y si descarta en `<topic>.DLT` |
| Reintento y descarte | `kafka-consumption.ts` (`LISTENER_RETRY`, `isRetryable`) y la conexión | La curva de `onFailure.retry`; NO se reintenta `DomainException` ni `MessageContractViolation`. Agotado o no reintentable: a `<topic>.DLT` si el topic lo declara, o se registra y se confirma |
| Envoltura y eventos | `event-envelope.ts`, `events/<e>-integration-event.ts` | La `EventEnvelope` del cable (`EventEnvelope.of(...)` y `EventEnvelope.parse(texto)`) |
| Puente | `<servicio>-domain-event-bridge.ts` | Los repositorios ya le entregan los eventos al guardar: escribe el outbox o publica tras el commit. **No lo llames tú** |
| Outbox | `outbox/` | Relay en tres pasos, backoff y rendición; el puerto `OutboxDispatcher` con un respaldo |
| Mensajes | `subscriptions/<e>-message.ts` | `fromWire(data)` y `requireContract()`; su comentario dice **el orden del guard y el mapeo al comando** de esa suscripción |
| Deduplicación | `idempotency/idempotency-guard.ts` | `alreadyProcessed`/`record`/`tryRecord`, en su propia transacción |
| Configuración | `config/parameters/<perfil>/messaging.yaml` y `kafka.yaml` | Destino, routing keys, topics, grupos, relay y conexión (`KAFKA_*`) |

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "kafka"`.
- Lee `specs/messaging.keel.yaml` (eventos, `reliability`, suscripciones con su `contract` y `onFailure`) y
  el comentario de cada `subscriptions/<e>-message.ts`: es el contrato de recepción ya traducido.
- Sigue `{{keel:docs}}/conventions/mapping.md` § `messaging`.

## Topología: los topics no los crea la aplicación

**No crees topics** (ni con el admin del cliente ni con ninguna otra cosa). En `infra/` los autocrea el broker
con el PRIMER mensaje, con una partición, que es lo que la infraestructura de prueba quiere; en producción los
aprovisiona la plataforma con su retención, sus réplicas y sus particiones. Que un topic no exista hasta el primer
mensaje es normal: el perfil `local` refresca los metadatos cada 2 s para que el consumidor lo vea enseguida, y el
arnés lee un topic inexistente como «no hay mensajes». El porqué entero (las particiones no se reducen nunca, y
crear topics exige permisos que un servicio no debe tener) está en la skill `keel-spring-kafka` § Topología: es
la misma regla.

## Lo que escribes, y el único sitio donde se registra

Todo va en `src/infrastructure/messaging/kafka/` y se registra en
**`src/infrastructure/messaging/broker-bindings.ts`** (es el component-scan de Spring: nada más lo cablea):

```ts
export const BROKER_ADAPTERS: Provider[] = [{ provide: OutboxDispatcher, useClass: KafkaOutboxDispatcher }];
export const MESSAGE_LISTENERS: Provider[] = [StockReservedListener, StockRejectedListener];
```

Lo que registras en `BROKER_ADAPTERS` **sustituye** al respaldo de build por token: no borres los stubs ni el
respaldo del dispatcher (que no deja arrancar fuera de `local`/`test` si un día vuelve a faltar).

### El envío — `reliability: outbox`

El payload que recibes **ya es la `EventEnvelope` serializada**: mándalo tal cual, con la **routing key como
clave del registro**. `publish` resuelve cuando el broker CONFIRMA y lanza si no hay conexión o si vence
`delivery.timeout.ms`; el relay cuenta ese fallo y reintenta. **No captures nada**: marcar como publicado lo que no
salió es lo que el outbox existe para impedir.

```ts
@Injectable()
export class KafkaOutboxDispatcher extends OutboxDispatcher {
  constructor(@Inject(KafkaConnection) private readonly connection: KafkaConnection) {
    super();
  }

  dispatch(destination: string, routingKey: string, eventType: string, payload: string): Promise<void> {
    return this.connection.publish(destination, routingKey, payload);
  }
}
```

La clave es la routing key y no el id del agregado: es lo que agrupa por tipo de evento y lo que asume el resto
de la cadena (el arnés incluido). Si el diseño exige orden por entidad, la clave correcta es el id del agregado —
decídelo una vez por evento y dilo en el código: cambiarla en caliente rompe el orden durante la transición.

### El envío — `reliability: best-effort`

Uno por evento, extendiendo su puerto `<Evento>Publisher` (`src/domain/events/`). El puente lo invoca DESPUÉS del
commit; un fallo se registra y el evento se pierde (es lo que el diseño eligió).

```ts
@Injectable()
export class KafkaDailyDigestClosedPublisher extends DailyDigestClosedPublisher {
  constructor(
    @Inject(KafkaConnection) private readonly connection: KafkaConnection,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {
    super();
  }

  publish(event: DailyDigestClosedIntegrationEvent, correlationId: string | null): Promise<void> {
    const payload = toWireJson(EventEnvelope.of(event.metadata, event, correlationId));
    const routingKey = this.settings.routingKeys['DailyDigestClosed']!;
    return this.connection.publish(this.settings.destination, routingKey, payload);
  }
}
```

El destino y la routing key salen de `MessagingSettings`, nunca literales.

### Los listeners — uno por SUSCRIPCIÓN, cada uno con su consumer group

Al revés que con RabbitMQ: cada suscripción tiene su **propio consumer group**
(`<servicio>-<evento>`, en `MessagingSettings.subscriptions[<e>].groupId`), y cada grupo recibe el topic
**entero**. Dos suscripciones de la misma fuente leen el mismo topic, y cada listener descarta lo que no es suyo
por el tipo. Un listener para dos suscripciones con un solo grupo haría que Kafka les repartiera las
particiones: cada una vería un trozo del tráfico, y el resto se perdería sin un error.

```ts
@Injectable()
export class StockReservedListener implements OnApplicationBootstrap {
  private static readonly HANDLER = 'StockReservedListener';

  constructor(
    @Inject(KafkaConnection) private readonly connection: KafkaConnection,
    @Inject(UseCaseMediator) private readonly mediator: UseCaseMediator,
    @Inject(IdempotencyGuard) private readonly guard: IdempotencyGuard
  ) {}

  onApplicationBootstrap(): void {
    // La suscripción por su NOMBRE en el diseño: el topic y el grupo los pone la conexión.
    this.connection.consume('StockReserved', (message) => this.handle(message));
  }

  private async handle(message: InboundMessage): Promise<void> {
    const envelope = EventEnvelope.parse(message.value); // lanza si no es una envoltura
    // El topic transporta TODOS los eventos de la fuente: lo ajeno se confirma sin efecto, SIN lanzar.
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

1. **Lo ajeno se descarta con `return`; lo propio roto se LANZA.** Retornar confirma (el offset avanza): un
   cuerpo tuyo que no parsea o incumple el contrato tiene que llegar a `<topic>.DLT`, y llega lanzando
   (`fromWire`/`requireContract` ya lanzan `MessageContractViolation`, que va al descarte sin reintento).
2. **El orden del guard lo dicta el diseño** (el comentario del `<Evento>Message`), no tú. Y el reintento en
   memoria repite la MISMA entrega: con `tryRecord` el primer reintento se encuentra el mensaje marcado.
3. **La carrera ya resuelta no es un fallo**: `InvalidStateTransitionException` o el conflicto de concurrencia
   cuando otro camino llegó antes se confirman (y con el orden `record`, se registran igual).
4. **Lanzar es fallar**: un `DomainException` va al descarte sin reintento; cualquier otro error, se reintenta
   con la curva del diseño. No conviertas ni captures para «reintentar».

## Qué no hacer

- **No crees topics** ni otra cadena de reintento (`<topic>-retry`, otro `.DLT`): el descarte es `<topic>.DLT`,
  el que declara build y el que lee el arnés. Uno con otro nombre haría que «no acabó en el descarte» mirara un
  topic que nadie alimenta.
- **No abras otro productor ni otro consumidor**, ni compongas un `group.id`: el grupo es el de
  `messaging.subscriptions.<e>.group-id`, y el arnés espera a ESOS grupos.
- **No llames al puente ni al relay**, ni escribas en `outbox_event`: los eventos salen solos al guardar.
- **No escribas otro registro de procesados** ni confirmes offsets a mano: el desenlace lo pone la conexión
  según lo que haga tu handler.
- **No dejes una promesa sin esperar** (`void this.connection.publish(...)`): con el broker caído es un rechazo
  sin manejar, y en Node eso tumba el proceso.

## Validación

`npm run build` en verde; con la infra arriba, kafka-ui (`http://localhost:8081`, si la `infra/` la trae) o, desde
devtools, `kcat -b kafka:29092 -L` (metadatos) y `kcat -b kafka:29092 -C -t <topic> -o beginning -e` (lo
publicado). Las pruebas de flujo usan los helpers del arnés (`deliver<Suscripción>`, `publishedMessages`,
`deadLetterMessages`, `stopBroker`…, `{{keel:docs}}/conventions/integration-tests.md`): con Kafka no hay purga, y
el aislamiento entre flujos es una marca de offset que el arnés pone solo.

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/listeners.md` | Al escribir un listener: un grupo por suscripción, contratos `keel`/`wrapped`/`none`, el orden del guard, la carrera y la identidad del emisor |
| `references/troubleshooting.md` | Si un mensaje no llega, llega dos veces, no va al descarte o el outbox se rinde |
