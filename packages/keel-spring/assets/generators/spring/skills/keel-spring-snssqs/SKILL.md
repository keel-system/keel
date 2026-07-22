---
name: keel-spring-snssqs
description: Guía de implementación de mensajería con Amazon SNS/SQS (LocalStack en local) en un proyecto generado por keel-spring — publishers con SnsTemplate, listeners SQS con redrive policy y validación. Usar cuando keel-stack.json declara broker "snssqs".
---

# Amazon SNS/SQS (broker: `snssqs`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "snssqs"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de SNS/SQS.

## Qué dejó listo build

- `build.gradle`: BOM `spring-cloud-aws-dependencies` + starters SNS y SQS (mismo SDK contra LocalStack y AWS real).
- `parameters/<perfil>/snssqs.yaml`: endpoint/región/credenciales por perfil (LocalStack en local).
- `infra/docker-compose.yaml`: `localstack` (puerto 4566, servicios sns+sqs).
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

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/snssqs.yaml` (listener SQS, visibility timeout, acknowledgement, perfiles) |
| `references/implementation.md` | Al crear la topología local (fan-out SNS→SQS, raw delivery, redrive/DLQ), publishers, listeners y FIFO |
| `references/troubleshooting.md` | Si los mensajes no llegan, llegan envueltos, se duplican o la DLQ se comporta raro |

## Validación

Desde devtools:
`aws --endpoint-url http://localstack:4566 --region us-east-1 sns list-topics` y
`... sqs receive-message --queue-url <url>` para inspeccionar mensajes.
Recetas completas en `.claude/conventions/infra-validation.md`.
