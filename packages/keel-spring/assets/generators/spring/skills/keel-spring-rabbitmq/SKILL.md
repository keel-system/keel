---
name: keel-spring-rabbitmq
description: Guía de implementación de mensajería con RabbitMQ en un proyecto generado por keel-spring — configuración del broker, publishers reales, listeners con DLX/DLQ y validación. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/skills/keel-generate-spring/conventions/mapping.md`; la estructura de paquetes está en `conventions/project-layout.md`.
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
`UseCaseMediator`. La política `onFailure` (retry/DLQ) se implementa con DLX/DLQ:
declara la cola con `x-dead-letter-exchange` y limita reintentos (contador en header
`x-death` o `RetryOperationsInterceptor` en la container factory).

## Validación

Desde devtools: `curl -sf -u guest:guest http://rabbitmq:15672/api/healthchecks/node`;
la UI de management (localhost:15672) permite inspeccionar exchanges, colas y mensajes.
Recetas completas en `.claude/skills/keel-generate-spring/conventions/infra-validation.md`.
