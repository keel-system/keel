# SNS/SQS — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md. El mapeo normativo
DSL → código sigue en `.claude/conventions/mapping.md`.

## Topología local (LocalStack): fan-out SNS → SQS

Patrón: la fuente publica en su topic SNS; cada servicio suscriptor tiene su
cola SQS suscrita. Script reproducible (ejecútalo desde devtools o con
`--endpoint-url http://localhost:4566` desde el host):

```bash
aws --endpoint-url http://localstack:4566 --region us-east-1 \
    sns create-topic --name <fuente>-events
aws ... sqs create-queue --queue-name <servicio>-<evento-kebab>-dlq
aws ... sqs create-queue --queue-name <servicio>-<evento-kebab> \
    --attributes '{"VisibilityTimeout":"60","RedrivePolicy":"{\"deadLetterTargetArn\":\"<arn-dlq>\",\"maxReceiveCount\":\"5\"}"}'
aws ... sns subscribe --topic-arn <arn-topic> --protocol sqs \
    --notification-endpoint <arn-cola> --attributes RawMessageDelivery=true
```

- **`RawMessageDelivery=true` es obligatorio** en este proyecto: sin él, SQS
  recibe el sobre JSON de SNS (Type/Message/…) y la conversión al
  `<Evento>Message` falla. Con raw delivery llega el `EventEnvelope` tal cual.
- `maxReceiveCount` = reintentos del `onFailure` del diseño; agotados, SQS
  mueve el mensaje a la DLQ solo (no hay código de retry que escribir).
- Deja el script en `infra/` (p. ej. `infra/init-messaging.sh`) para que la
  validación sea reproducible; en AWS real esta topología la crea la
  plataforma (IaC), no la app.

## Publisher

Como en el SKILL.md (`SnsTemplate.sendNotification`). Fiabilidad:

- `after-commit`: publica en `TransactionSynchronization.afterCommit`, nunca
  dentro de la transacción JPA.
- `outbox`: tabla outbox + relay `@Scheduled` que publica y marca; única
  garantía real contra pérdida.
- El ARN va por `@Value` desde el YAML; el nombre lógico del evento viaja como
  subject/atributo para filtrado.

## Listener

```java
@Component
public class StockDepletedListener {

    private final UseCaseMediator mediator;

    // ... constructor ...

    @SqsListener("${messaging.subscriptions.stock-depleted.topic:inventory-service-stock-depleted}")
    public void on(StockDepletedMessage message) {
        mediator.dispatch(new RetireProductCommand(message.productId()));
    }
}
```

- Ack `ON_SUCCESS` (default): una excepción deja el mensaje en la cola y el
  ciclo redrive/DLQ hace el resto. No captures excepciones para «evitar el
  reintento»: rompe la política `onFailure` del diseño.
- Errores de negocio no reintenables: si el diseño declara que un error no
  debe reintentarse, trágalo tras registrarlo (ack) o mándalo tú a la DLQ —
  documenta la decisión; SQS no distingue tipos de excepción.

## FIFO (solo si el diseño exige orden)

SQS estándar no garantiza orden ni exactly-once. Si un flujo del diseño exige
orden por entidad: topic y cola `.fifo`, publica con `MessageGroupId` = id del
agregado y `MessageDeduplicationId` = `eventId` del envelope. FIFO limita
throughput por group — no lo uses «por si acaso».

## Idempotencia de consumo

At-least-once siempre (visibility timeout vencido, redrives): deduplica con el
`eventId` del `EventEnvelope` si la operación no es naturalmente idempotente
(tabla de procesados o `SET NX` si hay cache en el stack).

## Checklist

- [ ] Topología creada por script reproducible en `infra/` (raw delivery, redrive, DLQ).
- [ ] Stub del publisher eliminado; ARN por configuración, no literal.
- [ ] `reliability` aplicada (after-commit / outbox / best-effort).
- [ ] `onFailure` → `maxReceiveCount` + DLQ según el diseño.
- [ ] Visibility timeout ≥ 6× el tiempo de proceso del handler.
- [ ] Consumo idempotente si la operación puede reintentarse.
