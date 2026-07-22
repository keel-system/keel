# Kafka (broker: `kafka`)

## Qué dejó listo build

- `build.gradle`: `spring-kafka` + `spring-kafka-test`.
- `parameters/<perfil>/kafka.yaml`: bootstrap-servers y serializadores JSON por perfil.
- `docker-compose.yaml`: Kafka KRaft single-node con doble listener — `localhost:9092` para la app en el host, `kafka:29092` para clientes dentro de la red (devtools).
- Contratos: `EventEnvelope`/`EventMetadata`, puerto `<Evento>Publisher` (en `domain/events`) con stub `<Evento>PublisherStub`, record `<Evento>Message` por suscripción.

## Publisher (sustituye cada `<Evento>PublisherStub`)

Un `@Component` por evento en `infrastructure/messaging` que implementa el puerto:

```java
@Component
public class ProductCreatedKafkaPublisher implements ProductCreatedPublisher {

    private static final String TOPIC = "<servicio>.events";

    private final KafkaTemplate<String, Object> kafkaTemplate;

    // ... constructor ...

    @Override
    public void publish(ProductCreatedEvent event, String correlationId) {
        EventEnvelope<ProductCreatedEvent> envelope =
                EventEnvelope.of("ProductCreated", event, correlationId);
        kafkaTemplate.send(TOPIC, "ProductCreated", envelope);
    }
}
```

- Topic: el canal declarado en `messaging.keel.yaml` (default `<servicio>.events`); key = nombre del evento.
- Elimina el stub al añadir la implementación (dos beans del puerto rompen la inyección).
- Aplica la `reliability` del diseño: `after-commit` → publicar con `TransactionSynchronization.afterCommit` (o `@TransactionalEventListener`); `outbox` → tabla outbox + relay. `best-effort` → envío directo como arriba.

## Listener (uno por suscripción, en `infrastructure/messaging/subscriptions`)

```java
@Component
public class StockDepletedListener {

    private final UseCaseMediator mediator;

    // ... constructor ...

    @RetryableTopic(attempts = "5", backoff = @Backoff(delay = 1000, multiplier = 2.0),
            dltStrategy = DltStrategy.FAIL_ON_ERROR)
    @KafkaListener(topics = "${messaging.subscriptions.stock-depleted.topic:inventory-service.events}",
            groupId = "${spring.application.name}")
    public void on(StockDepletedMessage message) {
        mediator.dispatch(new RetireProductCommand(message.productId()));
    }
}
```

- Topic configurable vía propiedad `messaging.subscriptions.<evento-kebab>.topic` (default `<fuente>.events`); groupId = `spring.application.name`.
- `onFailure` del diseño → `@RetryableTopic` (attempts/backoff declarados; `deadLetter: true` → `DltStrategy.FAIL_ON_ERROR`, si no `NO_DLT`).
- Mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía `UseCaseMediator`; añade idempotencia de consumo si la operación puede reintentarse.

## Validación

Desde devtools: `kcat -b kafka:29092 -L` (metadata) y `kcat -b kafka:29092 -t <topic> -C -c 1` para inspeccionar eventos publicados. Ver `conventions/infra-validation.md`.
