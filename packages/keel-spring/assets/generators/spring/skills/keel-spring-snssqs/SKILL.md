---
name: keel-spring-snssqs
description: Guía de implementación de mensajería con Amazon SNS/SQS (LocalStack en local) en un proyecto generado por keel-spring — publishers con SnsTemplate, listeners SQS con redrive policy y validación. Usar cuando keel-stack.json declara broker "snssqs".
---

# Amazon SNS/SQS (broker: `snssqs`)

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"broker": "snssqs"`.
- Lee `specs/messaging.keel.yaml`: eventos, suscripciones, `reliability` y `onFailure` — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y contratos (abajo); esta skill cubre solo el código que depende de SNS/SQS.

## Qué dejó listo build

- `build.gradle`: BOM `spring-cloud-aws-dependencies` + starters SNS y SQS (mismo SDK contra LocalStack y AWS real).
- `parameters/<perfil>/snssqs.yaml`: endpoint/región/credenciales por perfil (LocalStack en local).
- `infra/docker-compose.yaml`: `localstack` (puerto 4566, servicios sns+sqs) y el toolbox
  `devtools` con la AWS CLI y sus credenciales dummy.
- `infra/init-messaging.sh`: la topología de prueba (topics, colas, DLQ, suscripciones con
  raw delivery). **No la crees a mano ni escribas otro script**: lo ejecuta el agente de
  infraestructura y `infra/validate-infra.sh` comprueba que los recursos existan.
- Contratos y cadena de publicación **ya generados**: `EventEnvelope` + `EventMetadata`, el record `<Evento>Event` que el agregado emite, su gemelo `<Evento>IntegrationEvent`, el `<Servicio>DomainEventBridge` que traduce uno en otro, y el record `<Evento>Message` por suscripción. Con `reliability: outbox`, además la tabla `outbox_event`, su repositorio y el `OutboxRelay`.
- **Lo único tuyo al publicar es el envío**: implementar `OutboxDispatcher` (si `reliability: outbox`) o `<Evento>Publisher` (si `best-effort`), sustituyendo su stub. No reescribas el bridge, el relay ni el mapeo domain→integración.

## Envío al broker

**Lo que viaja al topic es siempre JSON.** El `SnsTemplate` por defecto **no lleva un
`MessageConverter` Jackson**, así que la API que elijas decide si hay serialización o no:

| Lo que tienes en la mano | API | Qué publica |
|---|---|---|
| `String` ya serializado (el payload del outbox) | `send(destination, MessageBuilder.withPayload(payload)...)` | el `String` tal cual ✅ |
| Objeto Java (`EventEnvelope<…>`) | serializar con el `ObjectMapper` y `send` con `withPayload(json)` | JSON, y admite cabeceras ✅ |
| Objeto Java (`EventEnvelope<…>`) | `sendNotification(topic, envelope, subject)` | JSON del objeto, pero **sin message attributes** ⚠️ |
| Objeto Java (`EventEnvelope<…>`) | `send(destination, MessageBuilder.withPayload(envelope)...)` | **el `toString()` del record** ❌ |

La cuarta fila es el error caro: compila, publica sin lanzar, y el cuerpo del mensaje acaba
siendo `EventEnvelope[metadata=EventMetadata[...], data=...]` — texto plano que ningún consumidor
parsea y que rompe el contrato de `docs/asyncapi.yaml`. **Nunca metas un objeto en
`MessageBuilder.withPayload`.** Si necesitas cabeceras *y* objeto a la vez, serializa tú con el
`ObjectMapper` de la aplicación (el bean de `JacksonConfig`, con `TimestampModule`) y manda el
`String`.

**El tercer argumento de `sendNotification` es el `Subject` de SNS, no un message attribute**, y esa
distinción decide si los mensajes llegan. `infra/init-messaging.sh` suscribe cada cola con
`RawMessageDelivery=true` y una `FilterPolicy` sobre el message attribute **`eventType`**: con raw
delivery el Subject se descarta por completo, así que un mensaje publicado con `sendNotification` no
trae `eventType`, la `FilterPolicy` no casa y la cola **no recibe nada**. No hay error, ni log, ni
excepción: los escenarios de integración simplemente no ven el evento y el fallo parece del arnés.
Por eso `sendNotification` no sirve para publicar aquí, ni siquiera en el camino `best-effort`.

Qué implementas depende de la `reliability` declarada en `messaging.keel.yaml`:

**`outbox`** — implementa `OutboxDispatcher` (`infrastructure/messaging/outbox`) como un `@Component`.
**No borres `OutboxDispatcherFallbackConfig`**: su bean es `@ConditionalOnMissingBean`, así que se aparta
solo en cuanto exista el tuyo, y sigue ahí para fallar al arrancar si algún día vuelve a faltar. El
payload que recibes **ya es la `EventEnvelope` serializada** por el bridge: publícalo como cuerpo
del mensaje, sin volver a serializar ni envolver.

```java
@Component
public class SnsOutboxDispatcher implements OutboxDispatcher {

    private final SnsTemplate snsTemplate;

    // ... constructor ...

    @Override
    public void dispatch(String destination, String routingKey, String eventType, String payload) {
        // `payload` es un String: por eso withPayload + send es correcto aquí.
        // Con un objeto en su lugar, esto publicaría su toString(). Ver la tabla de arriba.
        snsTemplate.send(destination, MessageBuilder.withPayload(payload)
                .setHeader("eventType", eventType)
                .setHeader("routingKey", routingKey)
                .build());
    }
}
```

Debe **lanzar** si la entrega no se confirma: el relay cuenta el intento y reintenta.

**`best-effort`** — implementa cada `<Evento>Publisher` en `infrastructure/messaging` (elimina su
stub). Aquí tienes el objeto, no un `String`, y además necesitas la cabecera `eventType`: serializa
con el `ObjectMapper` de la aplicación y envía con `send`, que es la única API que fija message
attributes.

```java
@Component
public class Sns<Evento>Publisher implements <Evento>Publisher {

    private static final String EVENT_TYPE = "<Evento>";

    private final SnsTemplate snsTemplate;
    private final ObjectMapper objectMapper;
    private final String topic;

    public Sns<Evento>Publisher(SnsTemplate snsTemplate, ObjectMapper objectMapper,
                                // Siempre con default: sin él, un contexto que no importe
                                // parameters/<perfil>/messaging.yaml (el @SpringBootTest del
                                // perfil test) muere con PlaceholderResolutionException.
                                @Value("${messaging.publishing.destination:<servicio>.events}") String topic) {
        this.snsTemplate = snsTemplate;
        this.objectMapper = objectMapper;
        this.topic = topic;
    }

    @Override
    public void publish(<Evento>IntegrationEvent event, String correlationId) {
        try {
            String payload = objectMapper.writeValueAsString(
                    EventEnvelope.of(event.metadata(), event, correlationId));
            // eventType como message ATTRIBUTE: es sobre lo que filtra la FilterPolicy
            // que siembra infra/init-messaging.sh. Sin él la cola descarta el mensaje
            // en silencio. El Subject de sendNotification no vale: raw delivery lo tira.
            snsTemplate.send(topic, MessageBuilder.withPayload(payload)
                    .setHeader("eventType", EVENT_TYPE)
                    .build());
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("No se pudo serializar " + EVENT_TYPE, exception);
        }
    }
}
```

El `ObjectMapper` que inyectas es el bean de la aplicación (`JacksonConfig`, con `TimestampModule`):
no construyas uno nuevo, o los instantes del sobre saldrán con otro formato que el que declara
`docs/asyncapi.yaml`.

En ambos casos el ARN/nombre del topic sale de `parameters/<perfil>/messaging.yaml`
(`messaging.publishing.destination`) leído con `@Value`, nunca literal. La topología local (topic,
colas, DLQ y suscripciones) la deja `infra/init-messaging.sh`, que genera `keel-spring build`:
ejecútalo y verifica el resultado, no crees los recursos a mano.

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
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
