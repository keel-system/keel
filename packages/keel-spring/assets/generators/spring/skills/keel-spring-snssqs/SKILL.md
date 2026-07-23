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
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Envío al broker

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) y elimina
`OutboxDispatcherStub`. El payload que recibes **ya es la `EventEnvelope` serializada**: publícalo
como cuerpo del mensaje, sin volver a serializar ni envolver.

```java
@Component
public class SnsOutboxDispatcher implements OutboxDispatcher {

    private final SnsTemplate snsTemplate;

    // ... constructor ...

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        snsTemplate.send(destination, MessageBuilder.withPayload(payload)
                .setHeader("eventType", eventType)
                .setHeader("routingKey", routingKey)
                .build());
    }
}
```

Debe **lanzar** si la entrega no se confirma: el relay cuenta el intento y reintenta.

**`best-effort`** — implementa cada `<Evento>Publisher` en `infrastructure/messaging` (elimina su
stub) con
`snsTemplate.sendNotification(topic, EventEnvelope.of(event.metadata(), event, correlationId), "<Evento>")`.

En ambos casos el ARN/nombre del topic sale de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination`) leído con `@Value`, nunca literal; crea el topic en LocalStack
para local.

## Listener (uno por suscripción)

`@Component` con `@SqsListener("${messaging.subscriptions.<evento-kebab>.topic:<fuente>.events}")`
que mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía
`UseCaseMediator` (el javadoc del record generado ya trae el mapeo campo a campo).
La política `onFailure` se implementa con la redrive policy de la
cola (`maxReceiveCount` = reintentos del diseño + DLQ); suscribe la cola al topic SNS
correspondiente de la fuente.

### El `contract` de la suscripción manda

El bloque `contract` del diseño describe la forma real del mensaje que emite la fuente.
Impleméntalo literalmente; no supongas:

- **`envelope: keel`** → deserializa a `EventEnvelope<XxxMessage>` y usa `envelope.data()`.
  **`none`** → el mensaje es el payload. **`wrapped`** → build generó `<Evento>Envelope`
  con el payload colgando de `payloadPath`; si está anidado, completa los niveles
  intermedios (build dejó un TODO).
- **Ojo con la doble envoltura de SNS→SQS**: sin *raw message delivery*, SNS mete el
  mensaje real dentro de su propio sobre (`Message`, `MessageAttributes`). Eso es
  **infraestructura, no diseño**: no lo confundas con `envelope: wrapped`. Activa raw
  delivery o desenvuelve el sobre SNS antes de aplicar el `contract`.
- **`discriminator`** — la cola recibe varios tipos. Con `location: header`, léelo del
  message attribute correspondiente (`@Header("<name>")`) y **descarta** (return limpio,
  sin excepción: una excepción cuenta como recepción fallida y acaba en la DLQ un mensaje
  que no te toca) lo que no coincida con `value`; con `location: field`, deserializa a
  `JsonNode` y enruta por ese campo.
- **`messageId`** — clave de deduplicación: léela (message attribute o campo; **no** el
  `MessageId` que asigna SQS, que cambia por reentrega) y descarta lo ya procesado antes
  de despachar. SQS estándar es at-least-once por definición.
- **`format: avro|protobuf`** — el cuerpo no es JSON: deserializa con el formato declarado;
  `schemaRef` identifica el schema en el registry de la fuente.
- **Canal `external: true`** — el ARN/nombre real del topic y de la cola los pone su dueño:
  van en `parameters/<perfil>`, nunca hardcodeados.
- Los `@JsonProperty` de alias y `unknownFields` ya vienen resueltos en el record: no los toques.

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
