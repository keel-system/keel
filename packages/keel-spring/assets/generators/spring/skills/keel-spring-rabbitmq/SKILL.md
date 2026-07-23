---
name: keel-spring-rabbitmq
description: Guía de implementación de mensajería con RabbitMQ en un proyecto generado por keel-spring — configuración del broker, publishers reales, listeners con DLX/DLQ y validación. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de RabbitMQ.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-amqp`.
- `parameters/<perfil>/rabbitmq.yaml`: host/credenciales por perfil.
- `infra/docker-compose.yaml`: `rabbitmq:4-management` (5672 + UI 15672, guest/guest).
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Configuración del broker (`infrastructure/configurations/broker/RabbitMqConfig`)

Exchange de eventos del servicio + conversor JSON para publicar/consumir records:

```java
@Configuration
public class RabbitMqConfig {

    public static final String EXCHANGE_NAME = "<servicio>.events";

    @Bean
    public TopicExchange domainEventsExchange() {
        return new TopicExchange(EXCHANGE_NAME, true, false);
    }

    @Bean
    public MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }

    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory connectionFactory, MessageConverter messageConverter) {
        RabbitTemplate template = new RabbitTemplate(connectionFactory);
        template.setMessageConverter(messageConverter);
        return template;
    }

    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
            ConnectionFactory connectionFactory, MessageConverter messageConverter) {
        SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
        factory.setConnectionFactory(connectionFactory);
        factory.setMessageConverter(messageConverter);
        return factory;
    }
}
```

## Envío al broker

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) y elimina
`OutboxDispatcherStub`. El payload que recibes **ya es la `EventEnvelope` serializada**: mándalo
tal cual, sin volver a serializar ni envolver.

```java
@Component
public class RabbitOutboxDispatcher implements OutboxDispatcher {

    private final RabbitTemplate rabbitTemplate;

    // ... constructor ...

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        MessageProperties props = new MessageProperties();
        props.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        props.setType(eventType);
        rabbitTemplate.send(destination, routingKey,
                MessageBuilder.withBody(payload.getBytes(StandardCharsets.UTF_8)).andProperties(props).build());
    }
}
```

Debe **lanzar** si la entrega no se confirma: el relay cuenta el intento y reintenta en la pasada
siguiente. Tragarse la excepción marcaría como publicado algo que nunca salió.

**`best-effort`** — implementa cada `<Evento>Publisher` en `infrastructure/messaging` (elimina su
stub: dos beans del puerto rompen la inyección) envolviendo con
`EventEnvelope.of(event.metadata(), event, correlationId)` y publicando con
`rabbitTemplate.convertAndSend(exchange, routingKey, envelope)`.

En ambos casos el exchange y la routing key salen de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination` y `messaging.publishing.routing-keys.<evento-kebab>`), leídos
con `@Value`: no los escribas literales. Declara ese exchange en la topología.

## Listener (uno por suscripción)

`@Component` con `@RabbitListener(queues = "${messaging.subscriptions.<evento-kebab>.topic:<fuente>.events}")`
que mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía
`UseCaseMediator` (el javadoc del record generado ya trae el mapeo campo a campo).
La política `onFailure` (retry/DLQ) se implementa con DLX/DLQ:
declara la cola con `x-dead-letter-exchange` y limita reintentos (contador en header
`x-death` o `RetryOperationsInterceptor` en la container factory).

### El `contract` de la suscripción manda

El bloque `contract` del diseño describe la forma real del mensaje que emite la fuente.
Impleméntalo literalmente; no supongas:

- **`envelope: keel`** → deserializa a `EventEnvelope<XxxMessage>` y usa `envelope.data()`.
  **`none`** → el mensaje es el payload. **`wrapped`** → build generó `<Evento>Envelope`
  con el payload colgando de `payloadPath`; si está anidado, completa los niveles
  intermedios (build dejó un TODO).
- **`discriminator`** — la cola recibe varios tipos. Con `location: header`, léelo con
  `@Header("<name>")` y **descarta** (return limpio, sin excepción: una excepción
  dispararía reintentos y DLQ sobre un mensaje que no te toca) lo que no coincida con
  `value`; con `location: field`, recibe `Message`/`JsonNode` y enruta por ese campo.
- **`messageId`** — clave de deduplicación: léela (header/property AMQP o campo) y
  descarta lo ya procesado **antes** de despachar. Con requeue y DLQ la entrega es
  at-least-once.
- **`format: avro|protobuf`** — sustituye el `Jackson2JsonMessageConverter` por el
  converter del formato; `schemaRef` identifica el schema en el registry de la fuente.
- **Canal `external: true`** — el nombre real de la cola/exchange lo pone su dueño: va en
  `parameters/<perfil>`, nunca hardcodeado, y no lo declares tú en la topología.
- Los `@JsonProperty` de alias y `unknownFields` ya vienen resueltos en el record: no los toques.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de añadir propiedades a `parameters/<perfil>/rabbitmq.yaml` (confirms, prefetch, retry, ack-mode) |
| `references/implementation.md` | Al escribir la topología (`Declarables`, quorum, DLX/DLQ), los publishers con confirms y los listeners con reintentos |
| `references/troubleshooting.md` | Si el arranque, la publicación o el consumo fallan (PRECONDITION_FAILED, bucles de requeue, unacked…) |

## Validación

Desde devtools: `curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node`;
la UI de management (localhost:15672) permite inspeccionar exchanges, colas y mensajes.
Recetas completas en `.claude/conventions/infra-validation.md`.
