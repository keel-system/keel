---
name: keel-spring-kafka
description: Guía de implementación de mensajería con Apache Kafka en un proyecto generado por keel-spring — publishers reales, listeners de suscripciones y validación del broker. Usar cuando keel-stack.json declara broker "kafka".
---

# Kafka (broker: `kafka`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "kafka"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de Kafka.

## Qué dejó listo build

- `build.gradle`: `spring-kafka` + `spring-kafka-test`.
- `parameters/<perfil>/kafka.yaml`: bootstrap-servers y serializadores JSON por perfil.
- `infra/docker-compose.yaml`: Kafka KRaft single-node con doble listener — `localhost:9092` para la app en el host, `kafka:29092` para clientes dentro de la red (devtools).
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Envío al broker

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) y elimina
`OutboxDispatcherStub`. El payload que recibes **ya es la `EventEnvelope` serializada**: mándalo
como `String` (`KafkaTemplate<String, String>` con `StringSerializer`), sin volver a serializar ni
envolver.

```java
@Component
public class KafkaOutboxDispatcher implements OutboxDispatcher {

    private final KafkaTemplate<String, String> kafkaTemplate;

    // ... constructor ...

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        // join() espera el ack del broker: si falla, el relay reintenta la fila.
        kafkaTemplate.send(destination, routingKey, payload).join();
    }
}
```

Debe **lanzar** si la entrega no se confirma (de ahí el `join()`): tragarse la excepción marcaría
como publicado algo que nunca salió.

**`best-effort`** — implementa cada `<Evento>Publisher` en `infrastructure/messaging` (elimina su
stub: dos beans del puerto rompen la inyección) envolviendo con
`EventEnvelope.of(event.metadata(), event, correlationId)` y enviando con `kafkaTemplate.send(...)`.

En ambos casos el topic y la key salen de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination` y `messaging.publishing.routing-keys.<evento-kebab>`), leídos
con `@Value`: no los escribas literales.

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

- Topic configurable vía propiedad `messaging.subscriptions.<evento-kebab>.topic` (default `<fuente>.events`); groupId = `spring.application.name`. Con un canal `external: true` el nombre real lo pone el dueño del canal: va en `parameters/<perfil>`, nunca hardcodeado.
- `onFailure` del diseño → `@RetryableTopic` (attempts/backoff declarados; `deadLetter: true` → `DltStrategy.FAIL_ON_ERROR`, si no `NO_DLT`).
- Mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía `UseCaseMediator`; el javadoc del record generado ya trae el mapeo campo a campo.

### El `contract` de la suscripción manda

El bloque `contract` del diseño describe la forma real del mensaje que emite la fuente. Impleméntalo literalmente; no supongas:

- **`envelope: keel`** — deserializa a `EventEnvelope<XxxMessage>` y trabaja con `envelope.data()`.
- **`envelope: none`** — el mensaje **es** el payload: deserializa directo a `XxxMessage`.
- **`envelope: wrapped`** — build generó `<Evento>Envelope` con el payload colgando de `payloadPath`: deserializa a la envoltura y saca el payload de ahí. Si `payloadPath` está anidado, completa los niveles intermedios (build dejó un TODO).
- **`discriminator`** — el topic transporta varios tipos de evento. Con `location: header`, filtra por `@Header("<name>")` y **descarta** (return, sin excepción, para no disparar reintentos) lo que no coincida con `value`; con `location: field`, deserializa a `JsonNode` y enruta por ese campo. Sin discriminador, y solo entonces, vale fijar un tipo por topic.
- **`messageId`** — es la clave de deduplicación: léela (header o campo) y descarta el mensaje si ya se procesó, **antes** de despachar. Es lo que hace segura la entrega at-least-once con `retry`/DLQ.
- **`format: avro|protobuf`** — cambia el deserializador y, con `schemaRef`, exige schema registry: configúralo en `parameters/<perfil>/kafka.yaml`.
- **`unknownFields`** y los `@JsonProperty` de alias ya vienen resueltos en el record generado: no los toques.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/kafka.yaml` — incluye resolver el `// TODO (agente)` de la deserialización del consumer (acks, idempotence, trusted packages, poll) |
| `references/implementation.md` | Al escribir publishers (elección de key, reliability, outbox) y listeners (RetryableTopic vs DefaultErrorHandler, poison pills, idempotencia) |
| `references/troubleshooting.md` | Si el consumo no llega, el poll entra en bucle o hay rebalanceos/duplicados |

## Validación

Desde devtools: `kcat -b kafka:29092 -L` (metadata) y `kcat -b kafka:29092 -t <topic> -C -c 1` para inspeccionar eventos publicados. Recetas completas en `.claude/conventions/infra-validation.md`.
