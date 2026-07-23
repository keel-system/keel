# RabbitMQ — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md con los patrones
completos. El mapeo normativo DSL → código sigue en
`.claude/conventions/mapping.md`.

## Topología en código, idempotente

Declara exchanges, colas y bindings como beans `Declarable` en `RabbitMqConfig`:
el admin de Spring los declara al conectar y la operación es idempotente **si
los argumentos no cambian** (cambiar args de una cola existente rompe con
`PRECONDITION_FAILED`; ver troubleshooting).

```java
@Bean
public Declarables subscriptionTopology() {
    Queue queue = QueueBuilder.durable("<servicio>.<evento-kebab>")
            .quorum()                                      // colas replicadas (default sano)
            .deadLetterExchange("<servicio>.dlx")
            .build();
    TopicExchange source = new TopicExchange("<fuente>.events", true, false);
    Queue dlq = QueueBuilder.durable("<servicio>.<evento-kebab>.dlq").build();
    FanoutExchange dlx = new FanoutExchange("<servicio>.dlx", true, false);
    return new Declarables(
            queue, source, dlq, dlx,
            BindingBuilder.bind(queue).to(source).with("<fuente>.<evento-kebab>"),
            BindingBuilder.bind(dlq).to(dlx));
}
```

- **Quorum vs classic**: `quorum()` para colas de trabajo durables (tolerantes a
  caída del nodo); classic solo para colas efímeras/exclusivas. Las quorum no
  soportan `x-max-priority` ni colas exclusivas.
- Una cola **por suscripción** del diseño, nombrada `<servicio>.<evento-kebab>`;
  el binding usa la routing key con la que publica la fuente.

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
déjalo en el log como error. En modo `outbox` no lo tragues: deja propagar la
excepción desde `OutboxDispatcher` para que el relay cuente el intento y
reintente — esa es la garantía real, no más reintentos en memoria.

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
- **Correlación e idempotencia**: RabbitMQ garantiza at-least-once (un `nack`
  con requeue o una reconexión reentregan). Ambas piezas ya están generadas; el
  listener solo las usa, en este orden:
  1. `CorrelationContext.runWith(envelope.metadata().correlationId(), () -> { ... })`,
     para que los eventos que provoque el consumo hereden la correlación de
     origen y el contexto se cierre pase lo que pase (los hilos del pool se
     reutilizan).
  2. `idempotencyGuard.tryRecord("<NombreDelListener>", id)` con el `messageId`
     declarado en la suscripción o, si no lo hay,
     `envelope.metadata().eventId()`; si devuelve `false`, ack y return sin
     procesar. El guard vive en `infrastructure/messaging/idempotency/`: no
     escribas otro mecanismo.
  3. Despacho de la operación `triggers` vía `UseCaseMediator`.

  Si la operación puede fallar de forma transitoria y debe reintentarse, llama a
  `tryRecord` **después** de despachar: el guard escribe en su propia
  transacción y registrar antes convertiría un fallo pasajero en un mensaje
  perdido.

## Checklist

- [ ] Topología completa en `Declarables` (nada declarado a mano).
- [ ] Stub del publisher eliminado (dos beans del puerto rompen la inyección).
- [ ] Puerto de envío implementado según `reliability` (`OutboxDispatcher` u `<Evento>Publisher`), con su stub eliminado y el fallo propagado (outbox) o registrado (best-effort).
- [ ] `onFailure` implementado con reintentos acotados y DLQ si `deadLetter: true`.
- [ ] Listener envuelto en `CorrelationContext.runWith(...)` y deduplicado con `IdempotencyGuard.tryRecord(...)` (sin mecanismo propio).
