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
- Contratos: `EventEnvelope`/`EventMetadata`, puerto `<Evento>Publisher` (en `domain/events`) con stub `<Evento>PublisherStub`, record `<Evento>Message` por suscripción.

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

## Publisher (sustituye cada `<Evento>PublisherStub`)

`@Component` en `infrastructure/messaging` que implementa el puerto: envuelve con
`EventEnvelope.of(...)` y publica con `rabbitTemplate.convertAndSend(RabbitMqConfig.EXCHANGE_NAME,
"<servicio>.<evento-kebab>", envelope)` (routing key = servicio + evento en kebab-case).
Elimina el stub al añadir la implementación. Aplica la `reliability` del diseño
(`after-commit` → publicar tras confirmar la transacción; `outbox` → tabla outbox + relay).

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
