# Amazon SNS/SQS (broker: `snssqs`)

## Qué dejó listo build

- `build.gradle`: BOM `spring-cloud-aws-dependencies` + starters SNS y SQS (mismo SDK contra LocalStack y AWS real).
- `parameters/<perfil>/snssqs.yaml`: endpoint/región/credenciales por perfil (LocalStack en local).
- `docker-compose.yaml`: `localstack` (puerto 4566, servicios sns+sqs).
- Contratos: `EventEnvelope`/`EventMetadata`, puerto `<Evento>Publisher` (en `domain/events`) con stub `<Evento>PublisherStub`, record `<Evento>Message` por suscripción.

## Publisher (sustituye cada `<Evento>PublisherStub`)

`@Component` en `infrastructure/messaging` que implementa el puerto e inyecta `SnsTemplate`:

```java
snsTemplate.sendNotification(topicArn, EventEnvelope.of("<Evento>", event, correlationId), "<Evento>");
```

- El ARN/nombre del topic de destino se resuelve desde `parameters/<perfil>/snssqs.yaml`
  vía `@Value` (no lo escribas literal); crea el topic en LocalStack para local.
- Elimina el stub al añadir la implementación. Aplica la `reliability` del diseño
  (`after-commit` → publicar tras confirmar la transacción; `outbox` → tabla outbox + relay).

## Listener (uno por suscripción)

`@Component` con `@SqsListener("${messaging.subscriptions.<evento-kebab>.topic:<fuente>.events}")`
que mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía
`UseCaseMediator`. La política `onFailure` se implementa con la redrive policy de la
cola (`maxReceiveCount` = reintentos del diseño + DLQ); suscribe la cola al topic SNS
correspondiente de la fuente.

## Validación

Desde devtools:
`aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` y
`... sqs receive-message --queue-url <url>` para inspeccionar mensajes.
Ver `conventions/infra-validation.md`.
