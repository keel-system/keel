---
name: keel-spring-kafka
description: Guía de implementación de mensajería con Apache Kafka en un proyecto generado por keel-spring — publishers reales, listeners de suscripciones y validación del broker. Usar cuando keel-stack.json declara broker "kafka".
---

# Kafka (broker: `kafka`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "kafka"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de Kafka.

## Qué dejó listo build

- `build.gradle`: `spring-kafka` + `spring-kafka-test`.
- `parameters/<perfil>/kafka.yaml`: bootstrap-servers y serializadores JSON por perfil.
- `infra/docker-compose.yaml`: Kafka KRaft single-node con doble listener — `localhost:9092` para la app en el host, `kafka:29092` para clientes dentro de la red (devtools).
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Topología: los topics no los crea la aplicación

**No declares `NewTopic` ni un `KafkaAdmin` con `autoCreate`.** No hay ninguna clase de topología
que escribir: en local y develop los topics los autocrea el broker con **1 partición**, que es el
valor que la infraestructura de prueba quiere; en producción los aprovisiona la plataforma con su
IaC, junto con la retención, las réplicas y las cuotas.

Que el topic no exista hasta el primer PRODUCE es normal y está previsto: el arnés de integración
tolera el `Unknown topic or partition` de la primera lectura. No es una pieza que falte.

Por qué la prohibición es dura, y no una preferencia:

- **`KafkaAdmin` aumenta las particiones de un topic vivo al arrancar la app** si el `NewTopic`
  declara más de las que tiene. Es irreversible —Kafka no reduce particiones— y rompe la afinidad
  key→partición: el orden por key deja de estar garantizado entre lo publicado antes y después.
- Declarar topics exige ACL de `CreateTopics`/`AlterPartitions` sobre el cluster. Un servicio en
  producción debe tener `Describe`/`Write` sobre los suyos y nada más.
- El número de particiones no es decisión del productor: lo fija el consumidor más exigente, y un
  topic con varios consumidores es contrato compartido.
- `modifyTopicConfigs` viene en `false`, así que un `NewTopic` ni siquiera corrige la retención o
  la política de compactación de un topic existente. Toca lo peligroso e ignora lo demás.

Con una sola partición, el orden está garantizado por topic y la **routing key sigue siendo la key
correcta** del mensaje (ver § Envío al broker). Esto es coherente con
`{{keel:docs}}/constitution.md` § Topología de infraestructura, que es la regla general; RabbitMQ
sí declara su topología desde la aplicación porque sus declaraciones son idempotentes y no
modifican recursos compartidos.

## Envío al broker

**El valor que viaja al topic es siempre un `String` de JSON producido por el `ObjectMapper` de la
aplicación** (el bean de `JacksonConfig`, con `TimestampModule`). `parameters/<perfil>/kafka.yaml` deja
el producer con `StringSerializer` en clave y valor precisamente para eso: hay **un único punto de
serialización**. No declares un `JsonSerializer` ni un `KafkaTemplate<String, Object>` — el template lo
volvería a serializar (JSON escapado dos veces, contrato de `docs/asyncapi.yaml` roto) y lo haría con un
`ObjectMapper` por defecto que kafka-clients instancia por reflexión, sin los módulos de la app.

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) como un `@Component`.
**No borres `OutboxDispatcherFallbackConfig`**: su bean es `@ConditionalOnMissingBean`, así que se aparta
solo en cuanto exista el tuyo, y sigue ahí para fallar al arrancar si algún día vuelve a faltar. El
payload que recibes **ya es la `EventEnvelope` serializada** por el bridge: mándalo tal cual
(`KafkaTemplate<String, String>`), sin volver a serializar ni envolver.

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
`EventEnvelope.of(event.metadata(), event, correlationId)`, serializando con el `ObjectMapper`
**inyectado** y enviando el `String` resultante, igual que hace el bridge en modo outbox:

```java
@Component
public class KafkaProductCreatedPublisher implements ProductCreatedPublisher {

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;   // el de JacksonConfig, no uno nuevo

    // ... constructor, @Value del destino y de la routing key ...

    @Override
    public void publish(ProductCreatedEvent event, String correlationId) {
        var envelope = EventEnvelope.of(event.metadata(), toIntegration(event), correlationId);
        try {
            kafkaTemplate.send(destination, routingKey, objectMapper.writeValueAsString(envelope));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("No se pudo serializar " + event.metadata().eventType(), e);
        }
    }
}
```

En ambos casos el topic y la key salen de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination` y `messaging.publishing.routing-keys.<evento-kebab>`), leídos
con `@Value` **y siempre con default** —`@Value("${messaging.publishing.destination:<destino>}")`,
igual que el bridge generado—: un placeholder sin default hace que cualquier contexto que no importe
ese fragmento (el `@SpringBootTest` del perfil `test`, por ejemplo) muera al arrancar con
`PlaceholderResolutionException`. No los escribas literales. **La key del mensaje es la routing key**, no el id del
agregado: es lo que hace que el particionado agrupe por tipo de evento y lo que asume el resto de la
cadena (outbox y arnés incluidos).

## Listener (uno por suscripción, en `infrastructure/messaging/subscriptions`)

```java
@Component
public class StockDepletedListener {

    private static final String EVENT_TYPE = "StockDepleted";

    private final UseCaseMediator mediator;

    // ... constructor ...

    // Sin @RetryableTopic: los reintentos y el descarte los aplica el
    // DefaultErrorHandler que build ya declaró (ver DeadLetterConfig).
    @KafkaListener(topics = "${messaging.subscriptions.stock-depleted.topic:inventory-service.events}",
            groupId = "${spring.application.name}-stock-depleted")
    public void on(EventEnvelope<StockDepletedMessage> envelope) {
        // El topic transporta TODOS los eventos de la fuente: lo que no es tuyo se
        // descarta con return, nunca con excepción (dispararía los reintentos).
        if (!EVENT_TYPE.equals(envelope.metadata().eventType())) {
            return;
        }
        mediator.dispatch(new RetireProductCommand(envelope.data().productId()));
    }
}
```

- Topic configurable vía propiedad `messaging.subscriptions.<evento-kebab>.topic` (default `<fuente>.events`). Con un canal `external: true` el nombre real lo pone el dueño del canal: va en `parameters/<perfil>`, nunca hardcodeado.
- **`groupId` con sufijo por suscripción** (`${spring.application.name}-<evento-kebab>`), no el nombre de la app a secas. El destino por convención es `<fuente>.events`, así que dos suscripciones de la MISMA fuente comparten topic: con un único grupo serían dos consumidores del mismo grupo sobre el mismo topic y Kafka les repartiría las particiones — cada listener vería solo un trozo del tráfico y el resto se perdería en silencio. Un grupo por suscripción hace que cada listener reciba el topic entero, que es lo que asume el resto de la cadena (`infra/check-idempotency.sh` solo agrupa por cola en RabbitMQ, precisamente por esto).
- `onFailure` del diseño → **ya está generado**: build emite `DeadLetterConfig` con un
  `DefaultErrorHandler` (attempts y backoff del diseño) y un `DeadLetterPublishingRecoverer` que
  publica en `<topic>.DLT` solo para las suscripciones que declaran `deadLetter: true`.
  **No añadas `@RetryableTopic`.** Crea su propia cadena de topics `<topic>-retry-*` y
  `<topic>-dlt`, así que el mensaje acabaría en un destino distinto del que la topología declara
  y del que el arnés lee (`deadLetterMessages(...)`): la aserción de que el mensaje NO acabó en
  el descarte saldría verde mirando una cola que nadie alimenta.
- Mapea el `<Evento>Message` al mensaje de la operación `triggers` y despacha vía `UseCaseMediator`; el javadoc del record generado ya trae el mapeo campo a campo.

### El `contract` de la suscripción manda

El bloque `contract` del diseño describe la forma real del mensaje que emite la fuente. Impleméntalo literalmente; no supongas:

- **`envelope: keel`** — deserializa a `EventEnvelope<XxxMessage>` y trabaja con `envelope.data()`.
- **`envelope: none`** — el mensaje **es** el payload: deserializa directo a `XxxMessage`.
- **`envelope: wrapped`** — build generó `<Evento>Envelope` con el payload colgando de `payloadPath`: deserializa a la envoltura y saca el payload de ahí. Si `payloadPath` está anidado, completa los niveles intermedios (build dejó un TODO).
- **`discriminator`** — el topic transporta varios tipos de evento. Con `location: header`, filtra por `@Header("<name>")` y **descarta** (return, sin excepción, para no disparar reintentos) lo que no coincida con `value`; con `location: field`, deserializa a `JsonNode` y enruta por ese campo.
- **Sin `discriminator` y con `envelope: keel`, el discriminador es `metadata.eventType`, y filtrar por él es OBLIGATORIO.** Que el diseño no declare nada no significa que el topic traiga un solo tipo: significa que la envoltura Keel ya trae el campo y no hay que describirlo. El destino es `<fuente>.events` y por ahí van **todos** los eventos que publica esa fuente, consumas tú uno o tres. Un listener sin filtro deserializa un evento ajeno contra tu record (campos a `null`, o peor: encajan) y despacha tu operación con datos que no son de ese hecho. El javadoc del `<Evento>Message` que generó build dice el valor exacto a comparar. Fijar un tipo por topic sin filtro solo vale con `envelope: none` sobre un canal que su dueño garantiza monotipo.
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

Desde devtools: `kcat -b kafka:29092 -L` (metadata) y `kcat -b kafka:29092 -t <topic> -C -c 1` para inspeccionar eventos publicados. Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
