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

Un NACK o un returned con `after-commit` es pérdida de evento: al menos déjalo
en el log como error; si el diseño exige garantía real, el patrón correcto es
`outbox` (tabla + relay que publica y marca), no más reintentos en memoria.

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
- **Idempotencia de consumo**: RabbitMQ garantiza at-least-once; si la operación
  destino no es naturalmente idempotente, deduplica con el `eventId` del
  `EventEnvelope` (tabla de procesados o `SET NX` si hay cache en el stack).

## Checklist

- [ ] Topología completa en `Declarables` (nada declarado a mano).
- [ ] Stub del publisher eliminado (dos beans del puerto rompen la inyección).
- [ ] `reliability` del diseño aplicada (after-commit / outbox / best-effort).
- [ ] `onFailure` implementado con reintentos acotados y DLQ si `deadLetter: true`.
- [ ] Consumo idempotente si la operación puede reintentarse.
