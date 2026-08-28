# RabbitMQ — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md con los patrones
completos. El mapeo normativo DSL → código sigue en
`{{keel:docs}}/conventions/mapping.md`.

## Topología en código, idempotente

Declara exchanges, colas y bindings como beans `Declarable` en `RabbitMqConfig`:
el admin de Spring los declara al conectar y la operación es idempotente **si
los argumentos no cambian** (cambiar args de una cola existente rompe con
`PRECONDITION_FAILED`; ver troubleshooting).

De las **dos** topologías del servicio solo una es tuya —la de publicación—, y
olvidarla es el fallo silencioso más caro de este stack:

1. **Publicación** — una cola durable por canal de `messaging.keel.yaml` §
   `channels` en el que publique algún evento, **nombrada como el canal**, con un
   binding por cada routing key de sus eventos (ver SKILL.md § Configuración del
   broker). Sin ella el exchange descarta los mensajes sin error visible y las
   pruebas de integración, que leen con `publishedMessages("<canal>", n)`, no
   tienen de dónde leer.
2. **Suscripción** — **no la declares tú**: la genera `build` en
   `RabbitTopologyConfig` (exchange de origen + cola propia + binding, y la DLQ
   donde el diseño declare `onFailure.deadLetter`).

> **El nombre de la cola de una suscripción NO lo eliges tú.** Está en
> `messaging.subscriptions.<evento>.queue` de `application-*.yaml`, lo declara
> `RabbitTopologyConfig` y de ahí lo leen también `infra/reset-db.sh` (que la
> purga entre flujos) y el arnés de integración (que entrega en su exchange). Inventar
> otro nombre no rompe nada visible: el servicio arranca, declara SU cola, y los
> mensajes del arnés se quedan en la del otro nombre. Lo que se ve es un escenario de
> suscripción que muere en un timeout mudo, y un «AVISO: no se pudo purgar» en cada
> reset que nadie lee. Costó una corrida entera.

Tu trabajo en la suscripción es el **listener**: leer de esa cola
(`@RabbitListener(queues = "${messaging.subscriptions.<evento>.queue}")`) y enrutar
por `eventType`. El binding que emite build es `"#"`, así que por esa cola llega
**todo** lo que publique el emisor: lo que no te corresponde se descarta sin lanzar.

- **Quorum vs classic**: `quorum()` para colas de trabajo durables (tolerantes a
  caída del nodo); classic solo para colas efímeras/exclusivas. Las quorum no
  soportan `x-max-priority` ni colas exclusivas. Aplica a las colas que declares
  tú (publicación); las de suscripción las emite build.

## Fiabilidad del publisher

Con `reliability: after-commit`, publica en `TransactionSynchronization.afterCommit`
(o `@TransactionalEventListener(phase = AFTER_COMMIT)`): nunca dentro de la
transacción JPA. Con confirms activados (ver `references/configuration.md`),
registra los callbacks una sola vez:

```java
rabbitTemplate.setConfirmCallback((correlation, ack, cause) -> {
    if (!ack) log.error("Publicación NACK: {} ({})", correlation, cause);
});
rabbitTemplate.setReturnsCallback(returned ->
    log.error("Mensaje no enrutable: exchange={} routingKey={}",
        returned.getExchange(), returned.getRoutingKey()));
```

Un NACK o un returned en modo `best-effort` es pérdida de evento: al menos
déjalo en el log como error, que es todo lo que se puede hacer cuando el envío ya
volvió.

**En modo `outbox` estos callbacks NO bastan, y confundirlo es el error caro.**
Son asíncronos: se ejecutan cuando el dispatcher ya devolvió el control y el relay
ya marcó la fila como publicada, así que loguean una pérdida que nadie va a
reparar. La garantía se obtiene **esperando** el confirm con la `CorrelationData`
de esa publicación —el snippet canónico está en `SKILL.md § Envío al broker`— y
lanzando desde `dispatch(...)`, que es lo único que hace al relay contar el intento
y reintentar en la pasada siguiente. Con la espera puesta, los callbacks quedan
para **observar**, no para decidir.

Los *returns* **solo llegan si el mensaje se publica como obligatorio**, así que
enciéndelo: `template.setMandatory(true)` (o
`spring.rabbitmq.template.mandatory: true`). Sin él, un mensaje que ningún binding
recoge se descarta sin `ReturnsCallback`, sin log y sin error — el publisher
reporta éxito y el evento no existió nunca. Es el modo de fallo que hace pasar en
falso las aserciones de "no se publica evento".

## Retry escalonado con DLX + TTL (backoffs largos)

El retry en memoria (configuration.md) bloquea el consumidor. Para esperas
largas, encadena: cola de trabajo → (reject) → exchange de retry → cola de
espera con `x-message-ttl` y `x-dead-letter-exchange` de vuelta a la cola de
trabajo. Limita los ciclos leyendo el header `x-death`:

```java
@RabbitListener(queues = "...")
public void on(Message raw, StockDepletedMessage message) {
    long attempts = countDeaths(raw.getMessageProperties().getHeader("x-death"));
    if (attempts >= MAX_ATTEMPTS) {
        throw new AmqpRejectAndDontRequeueException("agotado → DLQ");
    }
    mediator.dispatch(new RetireProductCommand(message.productId()));
}
```

`x-death` es una lista de mapas (uno por cola); cuenta el campo `count` de la
entrada de tu cola, no el tamaño de la lista.

## Errores en el listener

- Excepción del handler → reject; con `default-requeue-rejected: false` va al
  DLX (o se descarta si no hay). Para forzar el descarte puntual aunque el
  requeue global sea true: `AmqpRejectAndDontRequeueException`.
- Errores de **conversión** (JSON malformado, tipo desconocido) son fatales por
  defecto (`ConditionalRejectingErrorHandler`): no se reintentan. No los
  captures para «reintentar»: un mensaje imparseable no mejora al repetirlo.
- Ese default solo actúa cuando convierte **el contenedor**. Si tu listener recibe
  `Message` o `String` y parsea **dentro** del método —que es lo normal cuando una
  cola compartida obliga a enrutar por tipo—, el `try/catch` alrededor del
  `readValue` es tuyo, y ahí se decide si el descarte que declara el diseño
  significa algo. **Un cuerpo que es tuyo y no parsea se LANZA:
  `AmqpRejectAndDontRequeueException`, que lo manda al DLX en el primer intento.
  Nunca `log.error(...); return;`** — eso hace ack del mensaje y lo borra: la `-dlq`
  que build declaró no recibe nada, la aserción de «acabó en el descarte» mira una
  cola vacía y el único rastro es una línea de log que nadie está mirando.
  **No lo confundas con enrutar por tipo en una cola compartida**: ahí el mensaje
  parsea bien y va a otra rama del `switch`, no al descarte. La regla corta: *no es
  de esta rama* → sigue; *es mío y está roto* → `AmqpRejectAndDontRequeueException`.
- **Correlación e idempotencia**: RabbitMQ garantiza at-least-once (un `nack`
  con requeue o una reconexión reentregan). Ambas piezas ya están generadas; el
  listener solo las usa, en este orden:
  1. `CorrelationContext.runWith(envelope.metadata().correlationId(), () -> { ... })`,
     para que los eventos que provoque el consumo hereden la correlación de
     origen y el contexto se cierre pase lo que pase (los hilos del pool se
     reutilizan).
  2. El `idempotencyGuard`, con `"<NombreDelListener>"` y el `messageId`
     declarado en la suscripción o, si no lo hay,
     `envelope.metadata().eventId()`; si dice que ya se procesó, ack y return sin
     procesar. El guard vive en `infrastructure/messaging/idempotency/`: no
     escribas otro mecanismo. **El orden lo prescribe el javadoc del
     `<Evento>Message` que generó build, y las dos formas no son
     intercambiables**: `alreadyProcessed(...)` aquí y `record(...)` después de
     despachar bien si la operación de `triggers` declara `transitions`;
     `tryRecord(...)` aquí si no las declara. Si esa clave llega **nula o vacía**,
     no hay nada con que deduplicar: registra un `warn` que lo diga y descarta, en
     vez de llamar al guard con un id nulo — un registro con clave vacía deduplica
     contra todos los demás mensajes sin clave.
  3. Despacho de la operación `triggers` vía `UseCaseMediator`.

  Por qué el orden importa: el guard escribe en su **propia** transacción, así
  que sobrevive al fallo del handler. Registrar después (`record`) deja que un
  fallo transitorio se reintente — el mensaje queda sin marcar y el broker lo
  reentrega, y lo que frena la repetición es la transición del agregado.
  Reclamar antes (`tryRecord`) cierra la ventana del duplicado, pero un fallo del
  handler deja el mensaje marcado y **perdido**. Poner el segundo donde tocaba el
  primero convierte un corte de red en trabajo que nadie hizo, y el gate `dedupe`
  del pase de calidad lo marca `KO`.

  Ojo con una fuente de confusión: si el listener tiene activado el retry
  declarativo de Spring AMQP (`spring.rabbitmq.listener.simple.retry`), esos
  reintentos **no son reentregas del broker** — reinvocan tu handler dentro de la
  MISMA entrega, con el mismo `eventId` y sin volver a pasar por el guard. Eso NO
  cambia el orden que te toca: lo dicta el diseño. Lo detalla
  `references/configuration.md` § el retry en memoria no es una reentrega.

### La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, una operación de la API— puede sacar a
la entidad del mismo estado, tu despacho puede fallar sin que nada esté mal. Se rechaza de
**dos** formas, y las dos son la misma carrera:

- **`InvalidStateTransitionException`** — el otro llegó antes y el guard del agregado
  rechaza la transición (carrera secuencial).
- **`OptimisticLockingFailureException`** — llegasteis a la vez y perdiste el commit
  (carrera simultánea, la que provoca la doble entrega del broker).

Van en el **mismo `catch`**, y la segunda se captura por la base de
`org.springframework.dao`: no por la `ObjectOptimisticLockingFailureException` de JPA ni
por la del driver documental. Es la misma carrera con el mismo desenlace en los dos
motores, y capturar solo la de tu motor —o solo la primera de las dos— manda al DLX un
mensaje perfectamente válido en cuanto dos entregas coinciden en el tiempo.

En esa rama **no lanzas**: haces ack, lo registras a `debug` diciendo por qué, y —con el
orden `record`— llamas a `record(...)` **igualmente**. El mensaje quedó atendido; lo
atendió el otro camino. Sin ese registro, cada reentrega vuelve a atravesar el dominio
entero para terminar en este mismo `catch`.

No es tragarse un error: aquí se sabe *por qué* no se reintenta —el efecto ya está
aplicado— y se dice. `build` lo anota en el javadoc del `<Evento>Message` cuando ve la
carrera; que no lo anote no significa que no exista, significa que el diseño no la declara.

## Checklist

- [ ] Topología completa en `Declarables` (nada declarado a mano).
- [ ] Stub del publisher eliminado (dos beans del puerto rompen la inyección).
- [ ] Puerto de envío implementado según `reliability` (`OutboxDispatcher` u `<Evento>Publisher`), con su stub eliminado y el fallo propagado (outbox) o registrado (best-effort).
- [ ] Con `outbox`, el `dispatch(...)` **espera** el confirm (`CorrelationData` + future) y lanza si hay nack, timeout o returned. Los callbacks globales no cuentan: son asíncronos.
- [ ] El bean del listener container factory pasa por `SimpleRabbitListenerContainerFactoryConfigurer`. Sin él, `spring.rabbitmq.listener.simple.*` (incluido `retry.*`) no llega al contenedor y el YAML es decorado.
- [ ] El `recovery-interval` del contenedor se fija a mano (`factory.setRecoveryInterval`, clave propia `rabbitmq.listener.recovery-interval-ms`: la propiedad de Boot no existe) y el `DISPATCH_DEADLINE` del dispatcher queda por encima.
- [ ] `onFailure` implementado con reintentos acotados y DLQ si `deadLetter: true`.
- [ ] Un cuerpo propio que no parsea lanza `AmqpRejectAndDontRequeueException`, nunca `log.error` + `return`.
- [ ] Listener envuelto en `CorrelationContext.runWith(...)` y deduplicado con el `IdempotencyGuard` en el orden que prescribe el javadoc del `<Evento>Message` (sin mecanismo propio).

## Si la suscripción alimenta una proyección

Cuando el diseño declara `dependencies` y el evento aparece en el `fedBy` de una réplica, **el listener
no cambia**: sigue siendo `listener → IdempotencyGuard → UseCaseMediator → handler`. El
`<Entidad>Projector` lo invoca ese handler, no tú.

**Nunca llames al Projector desde el listener.** Sería una segunda puerta de entrada al dominio
saltándose el mediator (lo prohíbe `constitution.md`) y duplicaría la deduplicación que ya hace el
guard. La suscripción tiene `triggers` obligatorio precisamente para que esa operación exista.

Detalle completo en `{{keel:docs}}/conventions/dependencies.md`.
