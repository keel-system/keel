---
name: keel-spring-rabbitmq
description: Guía de implementación de mensajería con RabbitMQ en un proyecto generado por keel-spring — configuración del broker, publishers reales, listeners con DLX/DLQ y validación. Usar cuando keel-stack.json declara broker "rabbitmq".
---

# RabbitMQ (broker: `rabbitmq`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "rabbitmq"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de RabbitMQ.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-amqp`.
- `parameters/<perfil>/rabbitmq.yaml`: host/credenciales por perfil.
- `infra/docker-compose.yaml`: `rabbitmq:4-management` (5672 + UI 15672, guest/guest).
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Configuración del broker (`infrastructure/configurations/broker/RabbitMqConfig`)

Exchange de eventos del servicio + **una cola por canal publicado** + conversor JSON
para publicar/consumir records.

> **La cola no es opcional.** Un exchange topic sin bindings **descarta en silencio**
> todo lo que se publica (`drop_unroutable`): el publisher reporta éxito porque el
> exchange aceptó el mensaje, y el evento no llega a ninguna parte. Además, las
> pruebas de integración leen los eventos con `publishedMessages("<canal>", n)`, que
> en RabbitMQ consulta **la cola cuyo nombre es el del canal** — sin ella toda
> aserción de mensajería falla por timeout, y las aserciones *negativas* ("no se
> publica evento") pasan en falso porque el canal está vacío por el bug, no por el
> escenario. Declara **una cola durable por cada canal de
> `specs/messaging.keel.yaml` § `channels` en el que publique algún evento**,
> nombrada exactamente como el canal, con un binding por cada routing key de los
> eventos de ese canal.

```java
@Configuration
public class RabbitMqConfig {

    public static final String EXCHANGE_NAME = "<servicio>.events";

    @Bean
    public TopicExchange domainEventsExchange() {
        return new TopicExchange(EXCHANGE_NAME, true, false);
    }

    /**
     * Una cola por canal lógico del diseño, con binding a las routing keys de los
     * eventos que publica ese canal. Sin ellas los mensajes se descartan.
     */
    @Bean
    public Declarables publishedChannels(
            TopicExchange domainEventsExchange,
            @Value("${messaging.publishing.routing-keys.<evento-kebab>:<servicio>.<evento-kebab>}") String <evento>Key) {
        Queue <canal> = QueueBuilder.durable("<canal>").build();
        return new Declarables(
                <canal>,
                BindingBuilder.bind(<canal>).to(domainEventsExchange).with(<evento>Key));
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

    /**
     * SIEMPRE vía el configurer de Boot. Un `new SimpleRabbitListenerContainerFactory()`
     * cableado a mano IGNORA por completo `spring.rabbitmq.listener.simple.*` —
     * `retry.*` incluido—, así que el listener no agota reintentos ni cae al descarte
     * y el YAML que los declara es decorado. Es un defecto mudo: la app arranca y el
     * camino feliz funciona; solo un escenario adverso lo descubre.
     */
    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
            SimpleRabbitListenerContainerFactoryConfigurer configurer,
            ConnectionFactory connectionFactory,
            MessageConverter messageConverter,
            @Value("${rabbitmq.listener.recovery-interval-ms:5000}") long recoveryIntervalMillis) {
        SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
        configurer.configure(factory, connectionFactory);
        factory.setMessageConverter(messageConverter);
        // A mano porque NO existe `spring.rabbitmq.listener.simple.recovery-interval`:
        // RabbitProperties no expone esa propiedad, así que declararla en parameters/ no
        // tendría ningún efecto y el contenedor se quedaría con el default invisible de
        // AbstractMessageListenerContainer (5000 ms). Es la misma clave de la que
        // RabbitOutboxDispatcher deriva su deadline — ver la sección «Envío al broker».
        factory.setRecoveryInterval(recoveryIntervalMillis);
        return factory;
    }
}
```

**El `recovery-interval` deja de ser invisible a propósito.** Es el reloj con el que el
contenedor de listeners reintenta la conexión, y el dispatcher del outbox lo necesita para no
pisarlo: los dos comparten `ConnectionFactory`. **Build ya deja la clave**
`rabbitmq.listener.recovery-interval-ms` en `parameters/<perfil>/rabbitmq.yaml` con su
gradiente: léela, no la dupliques ni la sustituyas por un literal. Ese YAML es el único
sitio donde vive el número, y de ahí lo toman los dos — el contenedor por este bean y el
dispatcher para derivar su deadline.

## Envío al broker

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) como un `@Component`.
**No borres `OutboxDispatcherFallbackConfig`**: su bean es `@ConditionalOnMissingBean`, así que se aparta
solo en cuanto exista el tuyo, y sigue ahí para fallar al arrancar si algún día vuelve a faltar. El
payload que recibes **ya es la `EventEnvelope` serializada**: mándalo tal cual, sin volver a
serializar ni envolver.

```java
@Component
public class RabbitOutboxDispatcher implements OutboxDispatcher {

    /**
     * Deadline único del intento (send + espera del confirm), POR ENCIMA del
     * `recovery-interval` del contenedor de listeners: ver la nota de abajo.
     */
    private static final Duration DISPATCH_DEADLINE = Duration.ofSeconds(6);

    private final RabbitTemplate rabbitTemplate;
    private final long recoveryIntervalMillis;
    private final AtomicLong lastConnectionResetAt = new AtomicLong(0L);
    private final ExecutorService dispatchExecutor =
            Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("outbox-dispatch-", 0).factory());

    // ... constructor: @Value("${rabbitmq.listener.recovery-interval-ms:5000}") ...

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        // El intento va en un hilo aparte que se ABANDONA al agotar el plazo. Sin este
        // envoltorio, una reconexión en curso deja el send síncrono bloqueado dentro del
        // cliente AMQP (creación de canal, recuperación de la conexión compartida) sin
        // lanzar nunca: el hilo del @Scheduled queda varado en un único intento en vez de
        // reintentar con backoff, y la recuperación deja de ser predecible.
        Future<Void> attempt = dispatchExecutor.submit(() -> {
            sendAndAwaitConfirm(destination, routingKey, eventType, payload);
            return null;
        });
        try {
            attempt.get(DISPATCH_DEADLINE.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timedOut) {
            attempt.cancel(true);
            resetConnectionAfterFailure();
            throw new AmqpException("Sin confirmación del broker para " + routingKey + " en "
                    + DISPATCH_DEADLINE + " (¿reconexión en curso?)", timedOut);
        } catch (ExecutionException failed) {
            resetConnectionAfterFailure();
            Throwable cause = failed.getCause();
            throw cause instanceof AmqpException amqp ? amqp
                    : new AmqpException("Fallo entregando " + routingKey, cause);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            attempt.cancel(true);
            resetConnectionAfterFailure();
            throw new AmqpException("Interrumpido esperando la confirmación de " + routingKey, interrupted);
        }
    }

    /**
     * Descarta la conexión y el canal cacheados tras un fallo — pero NO si ya se
     * descartaron hace menos de un `recovery-interval`: el contenedor de listeners
     * comparte esta `ConnectionFactory` y tiene su propio ciclo de recuperación, y
     * resetear en cada timeout le reinicia el reloj antes de que termine. Ese es el
     * patrón que no converge.
     */
    private void resetConnectionAfterFailure() {
        if (!(rabbitTemplate.getConnectionFactory() instanceof CachingConnectionFactory caching)) {
            return;
        }
        long now = System.currentTimeMillis();
        long previous = lastConnectionResetAt.get();
        if (now - previous < recoveryIntervalMillis) {
            return;
        }
        if (lastConnectionResetAt.compareAndSet(previous, now)) {
            caching.resetConnection();
        }
    }

    private void sendAndAwaitConfirm(String destination, String routingKey, String eventType, String payload) {
        MessageProperties props = new MessageProperties();
        props.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        props.setType(eventType);
        // La CorrelationData no es decorativa: es lo que convierte el confirm asíncrono
        // en algo que este método puede esperar, y lo que trae de vuelta el mensaje si
        // ningún binding lo recogió.
        CorrelationData confirmation = new CorrelationData(eventType + ":" + routingKey);
        rabbitTemplate.send(destination, routingKey,
                MessageBuilder.withBody(payload.getBytes(StandardCharsets.UTF_8)).andProperties(props).build(),
                confirmation);
        try {
            CorrelationData.Confirm confirm =
                    confirmation.getFuture().get(DISPATCH_DEADLINE.toMillis(), TimeUnit.MILLISECONDS);
            if (confirm == null || !confirm.isAck()) {
                throw new AmqpException("El broker no confirmó la entrega en " + destination
                        + " (" + routingKey + "): " + (confirm == null ? "sin respuesta" : confirm.getReason()));
            }
            // Un ack dice «lo recibí», no «lo entregué a alguien». Un exchange topic
            // descarta sin destinatario y confirma igual: el returned es lo único que
            // distingue las dos cosas, y llega antes que el confirm.
            if (confirmation.getReturned() != null) {
                throw new AmqpException("Publicado en " + destination + " sin binding para "
                        + routingKey + ": el mensaje volvió sin entregar");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AmqpException("Interrumpido esperando la confirmación de " + routingKey, interrupted);
        } catch (ExecutionException | TimeoutException notConfirmed) {
            throw new AmqpException("Sin confirmación del broker para " + routingKey, notConfirmed);
        }
    }
}
```

**El deadline va por encima del `recovery-interval`, y no es tuning: es lo que hace que la
recuperación converja.** Dispatcher y contenedor de listeners comparten `ConnectionFactory`. Si
el plazo del intento es más corto que el ciclo de recuperación, cada intento que caiga en medio
de una reconexión agota su plazo, fuerza el reset, y ese reset reinicia el reloj — el siguiente
vuelve a caer en medio, indefinidamente. En un entorno algo más lento (podman en Windows, CI
compartida) es lo que convierte «el broker vuelve» en «la fila no sale nunca». De ahí las tres
piezas juntas: `recovery-interval` explícito, deadline derivado de él con holgura, y guarda de
cooldown en el reset.

**Esperar el confirm no es opcional aquí, y es la diferencia con los otros dos brokers.**
`send(...)` vuelve en cuanto el mensaje sale al socket; los confirms de RabbitMQ son
**asíncronos**, así que sin `CorrelationData` y sin esperar el future nadie los mira: el relay
marca la fila como publicada por el mero hecho de no haber petado, y un `nack` del broker o una
routing key sin binding se pierden con el outbox en verde. Kafka tiene esa garantía por el
`.join()` del `send`, y SNS por ser síncrono; RabbitMQ es el único donde hay que pedirla.

Requiere los tres ajustes de `parameters/<perfil>/rabbitmq.yaml` que documenta
`references/configuration.md` —`publisher-confirm-type: correlated`, `publisher-returns: true` y
`template.mandatory: true`—: **sin `mandatory` no hay `getReturned()`**, y el caso «publicado en un
exchange que no tiene a quién dárselo» se cuela como éxito. Los callbacks globales
(`setConfirmCallback`/`setReturnsCallback`) siguen valiendo para **observar**, no para decidir:
loguean después de que este método ya haya vuelto.

Debe **lanzar** si la entrega no se confirma: el relay cuenta el intento y reintenta en la pasada
siguiente. Tragarse la excepción marcaría como publicado algo que nunca salió. El modo de fallo que
esto sí introduce —publicar dos veces cuando el confirm llega tarde— es el que el diseño ya tolera:
la entrega es at-least-once y el consumidor deduplica.

**`best-effort`** — implementa cada `<Evento>Publisher` en `infrastructure/messaging` (elimina su
stub: dos beans del puerto rompen la inyección) envolviendo con
`EventEnvelope.of(event.metadata(), event, correlationId)` y publicando con
`rabbitTemplate.convertAndSend(exchange, routingKey, envelope)`.

En ambos casos el exchange y la routing key salen de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination` y `messaging.publishing.routing-keys.<evento-kebab>`), leídos
con `@Value`: no los escribas literales. Declara ese exchange en la topología.

## Listener (uno por COLA, no uno por suscripción)

`@Component` con `@RabbitListener(queues = "${messaging.subscriptions.<evento-kebab>.topic:<fuente>.events}")`
que mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía
`UseCaseMediator` (el javadoc del record generado ya trae el mapeo campo a campo).

**Cuenta las colas antes de escribir el primero.** El destino sale de la FUENTE, así que
varias suscripciones del mismo servicio de origen —o del mismo `channel`— resuelven a la
**misma cola**. Y varios `@RabbitListener` sobre una cola no son varios oyentes: son
consumidores **compitiendo**. El broker reparte, cada mensaje llega a uno solo y los demás
no lo ven nunca; el que lo recibe suele ser el de otro tipo, que lo descarta o lo
deserializa con los campos a null. El síntoma no es un error: son mensajes que se pierden
en silencio y escenarios que fallan como si el handler no hubiera hecho su trabajo.

Con la cola compartida, escribe **un solo listener** que enrute por el tipo del mensaje
(`metadata.eventType` con envoltura Keel, o el `discriminator` que declare el `contract`) y
despache al `<Evento>Message` que corresponda. Aquí no aplica lo de descartar lo ajeno: en
esa cola no hay nada ajeno, todo es tuyo y va a una rama distinta.

Esto es propio de RabbitMQ y no se traslada: en Kafka cada listener tiene su grupo y
recibe el topic entero, y en SNS/SQS cada suscripción tiene cola propia colgada del topic.
En los dos, un listener por suscripción es lo correcto.
**La cola de la suscripción y su descarte los declara build**, en `DeadLetterConfig`:
`QueueBuilder.durable(<destino>)` con `x-dead-letter-exchange` vacío y
`x-dead-letter-routing-key` apuntando a `<destino>-dlq`, más la propia `-dlq`.

**No las redeclares.** No es una cuestión de estilo: RabbitMQ rechaza con
`PRECONDITION_FAILED` una segunda declaración de la misma cola con argumentos distintos,
y el contenedor de listeners **no arranca**. Si además la declaras sin los argumentos de
descarte, el mensaje agotado se pierde en silencio y `deadLetterMessages(...)` lee una
cola vacía: el escenario daría por bueno un descarte que sí ocurrió.

Lo que sí te toca: acotar los reintentos (contador en el header `x-death`, o un
`RetryOperationsInterceptor` en la container factory) y **rechazar sin reencolar**
(`basicNack` con `requeue=false`) al agotarlos — es lo que hace que el broker aplique el
descarte que la cola ya tiene configurado.

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
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
