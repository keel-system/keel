# SNS/SQS — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md. El mapeo normativo
DSL → código sigue en `{{keel:docs}}/conventions/mapping.md`.

## Topología local (LocalStack): fan-out SNS → SQS

Patrón: la fuente publica en su topic SNS; cada servicio suscriptor tiene su
cola SQS suscrita. Script reproducible (ejecútalo desde devtools o con
`--endpoint-url http://localhost:4566` desde el host):

```bash
aws --endpoint-url http://localstack:4566 --region us-east-1 \
    sns create-topic --name <fuente>-events
aws ... sqs create-queue --queue-name <servicio>-<evento-kebab>-dlq
aws ... sqs create-queue --queue-name <servicio>-<evento-kebab> \
    --attributes '{"VisibilityTimeout":"60","RedrivePolicy":"{\"deadLetterTargetArn\":\"<arn-dlq>\",\"maxReceiveCount\":\"5\"}"}'
aws ... sns subscribe --topic-arn <arn-topic> --protocol sqs \
    --notification-endpoint <arn-cola> --attributes RawMessageDelivery=true
```

- **`RawMessageDelivery=true` es obligatorio** en este proyecto: sin él, SQS
  recibe el sobre JSON de SNS (Type/Message/…) y la conversión al
  `<Evento>Message` falla. Con raw delivery llega el `EventEnvelope` tal cual.
- `maxReceiveCount` = reintentos del `onFailure` del diseño; agotados, SQS
  mueve el mensaje a la DLQ solo (no hay código de retry que escribir).
- **No escribas el script**: `keel-spring build` genera `infra/init-messaging.sh`
  con esta misma receta, derivada del diseño (topics, colas, DLQ con el
  `maxReceiveCount` del `onFailure`, suscripciones con raw delivery y filtro por
  `eventType`). El agente de infraestructura lo ejecuta y `infra/validate-infra.sh`
  verifica que los recursos existan. En AWS real esta topología la crea la
  plataforma (IaC), no la app.

## Envío

Como en el SKILL.md. La fase de publicación (dentro o fuera de la transacción)
ya la resuelve el `<Servicio>DomainEventBridge` generado; lo tuyo es el envío:

- `outbox`: implementas `OutboxDispatcher` y **dejas propagar** la excepción si
  la entrega no se confirma — es lo que hace que el relay reintente. Tragarla
  convierte el outbox en decorado.
- `best-effort`: implementas `<Evento>Publisher`; un fallo se loguea y no
  interrumpe la operación (no hay reintento).
- El ARN va por `@Value` desde el YAML; el nombre lógico del evento viaja como
  **message attribute `eventType`**, que es sobre lo que filtran las suscripciones.
  No es el `Subject` de SNS: con `RawMessageDelivery=true` el Subject se descarta
  y la `FilterPolicy` deja el mensaje fuera de la cola sin decir nada.
- **Publica siempre un `String` con `send`**, en los dos caminos: el outbox ya te
  da el payload serializado; en best-effort lo serializas tú con el `ObjectMapper`
  de la aplicación. `sendNotification` serializa pero no admite message attributes,
  así que aquí no sirve; y un objeto dentro de `withPayload` se publica como su
  `toString()`, sin error visible. Tabla en `SKILL.md § Envío al broker`.

### El resolver por defecto CREA el topic, y eso pierde mensajes

`SnsTemplate` traduce el nombre a ARN con `DefaultTopicArnResolver`, que llama a
`sns:CreateTopic` — idempotente, así que **no falla** si el topic no existe: lo crea.
Suena inofensivo y no lo es. SNS entrega **en el momento**: un topic sin suscriptores
descarta lo que se publique en él, sin error. Así que la primera publicación tras una
caída del broker puede crear ella misma el topic, publicar contra él antes de que
existan las colas y las suscripciones, y **el outbox marca la fila `published_at` y no
vuelve a intentarlo**. El mensaje no está en ningún sitio y nada lo señala.

Publicar contra un topic sin suscriptores es siempre una publicación que no entrega
nada — no es un caso especial de pruebas. Sustituye el resolver por uno que **liste** y
que además exija suscriptor confirmado:

```java
@Bean
public TopicArnResolver topicArnResolver(SnsClient snsClient) {
    TopicArnResolver existingTopic = new TopicsListingTopicArnResolver(snsClient); // ya no crea
    TopicArnResolver subscribedTopic = name -> {
        Arn arn = existingTopic.resolveTopicArn(name);
        boolean hasSubscribers = snsClient
                .listSubscriptionsByTopic(ListSubscriptionsByTopicRequest.builder().topicArn(arn.toString()).build())
                .subscriptions().stream()
                .anyMatch(subscription -> !"PendingConfirmation".equals(subscription.subscriptionArn()));
        if (!hasSubscribers) {
            throw new IllegalStateException("El topic " + name + " todavía no tiene ningún suscriptor confirmado");
        }
        return arn;
    };
    return new CachingTopicArnResolver(subscribedTopic);   // la topología no cambia en caliente
}
```

Mientras no haya suscriptor, la resolución falla como cualquier otro fallo de destino y
el relay reintenta con su backoff: la publicación queda atada al mismo evento que hace
que el mensaje tenga a dónde ir, en vez de adelantársele.

### Acota los timeouts del SDK, o el backoff del relay no gobierna nada

Sin `apiCallAttemptTimeout` explícito, el `SnsClient` reintenta **puertas adentro** con
su propia política (modo LEGACY, hasta 4 intentos con su propio backoff) antes de
devolverte la excepción. Ese tiempo se **suma** al backoff del relay en vez de estar
gobernado por él, y con `outbox.relay.max-attempts` acotado el presupuesto de intentos se
agota en unas pocas llamadas de varios segundos: la fila cae en dead-letter **dentro de la
misma pausa** que causó el fallo, que es justo lo que el outbox existe para evitar.

```java
@Component
public class SnsOutboxClientCustomizer implements SnsClientCustomizer {
    @Override
    public void customize(SnsClientBuilder builder) {
        builder.overrideConfiguration(ClientOverrideConfiguration.builder()
                .apiCallAttemptTimeout(Duration.ofMillis(1500))
                .apiCallTimeout(Duration.ofSeconds(3))
                .retryStrategy(retry -> retry.maxAttempts(2))
                .build());
    }
}
```

Más intentos baratos dentro de la ventana de caída, en vez de menos intentos caros.

## Listener

```java
@Component
public class StockDepletedListener {

    private final UseCaseMediator mediator;

    // ... constructor ...

    @SqsListener("${messaging.subscriptions.stock-depleted.queue:inventory-stock-depleted}")
    public void on(StockDepletedMessage message) {
        mediator.dispatch(new RetireProductCommand(message.productId()));
    }
}
```

- **`queue`, no `topic`.** Del topic se publica; se consume de una **cola**, y su nombre
  lo fija este servicio (dos consumidores del mismo topic necesitan colas distintas).
  `build` declara las dos claves por perfil y `infra/init-messaging.sh` crea la cola con
  ese mismo nombre. Apuntar el `@SqsListener` al topic deja el listener escuchando un
  destino que no existe y **todo escenario de suscripción muere en un timeout mudo**.
- Ack `ON_SUCCESS` (default): una excepción deja el mensaje en la cola y el
  ciclo redrive/DLQ hace el resto. No captures excepciones para «evitar el
  reintento»: rompe la política `onFailure` del diseño.
- Errores de negocio no reintenables: si el diseño declara que un error no
  debe reintentarse, trágalo tras registrarlo (ack) o mándalo tú a la DLQ —
  documenta la decisión; SQS no distingue tipos de excepción.

### El backoff declarado no lo aplica la cola: lo aplicas tú

`onFailure.retry` del diseño trae `backoff`, `initialDelayMs` y `maxDelayMs`. SQS **no
tiene** backoff por reintento: relanzar la excepción deja que gobierne el
`VisibilityTimeout` de la cola, que es **fijo** (30 s por defecto) — muy lejos de una
curva exponencial de 500 ms a 30 s. El código compila, los tests aislados pasan y la
política del diseño simplemente no existe.

Se aplica extendiendo la visibilidad del mensaje en función de cuántas veces se ha
recibido ya:

```java
@SqsListener("${messaging.subscriptions.withdrawal-rejected.queue:...}")
public void on(WithdrawalRejectedMessage message,
               @Header(SqsHeaders.MessageSystemAttributes.SQS_APPROXIMATE_RECEIVE_COUNT) String receiveCount,
               Visibility visibility) {
    try {
        mediator.dispatch(...);
    } catch (RuntimeException failure) {
        visibility.extend((int) backoffSeconds(Integer.parseInt(receiveCount)));  // initial·2^(n-1), tope max
        throw failure;   // sigue siendo un fallo: el reintento y la DLQ los gobierna la cola
    }
}
```

El `extend` **no sustituye** al relanzamiento: solo cambia cuándo vuelve a estar visible.
Y el número de reintentos sigue siendo el `maxReceiveCount` del redrive, que `build` ya
siembra desde `retry.maxAttempts`.

## FIFO (solo si el diseño exige orden)

SQS estándar no garantiza orden ni exactly-once. Si un flujo del diseño exige
orden por entidad: topic y cola `.fifo`, publica con `MessageGroupId` = id del
agregado y `MessageDeduplicationId` = `eventId` del envelope. FIFO limita
throughput por group — no lo uses «por si acaso».

## Correlación e idempotencia en el listener

At-least-once siempre (visibility timeout vencido, redrives). Ambas piezas ya
están generadas; el listener solo las usa, en este orden:

1. `CorrelationContext.runWith(envelope.metadata().correlationId(), () -> { ... })`,
   para que los eventos que provoque el consumo hereden la correlación del
   mensaje de origen y el contexto se cierre pase lo que pase: los hilos del
   pool se reutilizan.
2. El `idempotencyGuard`, con `"<NombreDelListener>"` y el `id` que declara el
   diseño: el `messageId` de la suscripción o, si no lo hay,
   `envelope.metadata().eventId()`. Si dice que ya se procesó, borra el mensaje
   de la cola y vuelve sin procesar. El guard y su tabla `processed_event` viven
   en `infrastructure/messaging/idempotency/`: no escribas otro mecanismo.
   **El orden lo prescribe el javadoc del `<Evento>Message` que generó build, y
   las dos formas no son intercambiables**: `alreadyProcessed(...)` aquí y
   `record(...)` después de despachar bien si la operación de `triggers` declara
   `transitions`; `tryRecord(...)` aquí si no las declara.
   Si esa clave llega **nula o vacía**, no hay nada con que deduplicar: registra un
   `warn` que lo diga y descarta, en vez de llamar al guard con un id nulo — un
   registro con clave vacía deduplica contra todos los demás mensajes sin clave.
3. Despacho de la operación `triggers` vía `UseCaseMediator`.

Por qué el orden importa: el guard escribe en su **propia** transacción, así que
sobrevive al fallo del handler. Registrar después (`record`) deja que un fallo
transitorio se reintente — el mensaje queda sin marcar y el broker lo reentrega,
y lo que frena la repetición es la transición del agregado. Reclamar antes
(`tryRecord`) cierra la ventana del duplicado, pero un fallo del handler deja el
mensaje marcado y **perdido**. Poner el segundo donde tocaba el primero convierte
un corte de red en trabajo que nadie hizo, y el gate `dedupe` del pase de calidad
lo marca `KO`.

### La carrera ya resuelta no es un fallo

Cuando otro camino —otra suscripción, un barrido, una operación de la API— puede sacar a
la entidad del mismo estado, tu despacho puede fallar sin que nada esté mal. Se rechaza de
**dos** formas, y las dos son la misma carrera:

- **`InvalidStateTransitionException`** — el otro llegó antes y el guard del agregado
  rechaza la transición (carrera secuencial).
- **`OptimisticLockingFailureException`** — llegasteis a la vez y perdiste el commit
  (carrera simultánea, la que provoca la doble entrega del broker).

Van en el **mismo `catch`**, y la segunda se captura por la base de
`org.springframework.dao`: no por la `ObjectOptimisticLockingFailureException` de JPA ni
por la del driver documental. Es la misma carrera con el mismo desenlace en los dos
motores, y capturar solo la de tu motor —o solo la primera de las dos— manda a la DLQ un
mensaje perfectamente válido en cuanto dos entregas coinciden en el tiempo.

En esa rama **no lanzas**: confirmas el mensaje (borrado de la cola), lo registras a
`debug` diciendo por qué, y —con el orden `record`— llamas a `record(...)` **igualmente**.
El mensaje quedó atendido; lo atendió el otro camino. Sin ese registro, cada reentrega
vuelve a atravesar el dominio entero para terminar en este mismo `catch`.

No es tragarse un error: aquí se sabe *por qué* no se reintenta —el efecto ya está
aplicado— y se dice. `build` lo anota en el javadoc del `<Evento>Message` cuando ve la
carrera; que no lo anote no significa que no exista, significa que el diseño no la declara.

## Poison pills: un cuerpo tuyo que no parsea

El listener recibe el cuerpo y lo parsea **dentro** del método, así que ningún
deserializador del contenedor ve el problema: el `try/catch` alrededor del `readValue` es
tuyo, y ahí se decide si el descarte que declara el diseño significa algo.

**Un cuerpo que es tuyo y no parsea se LANZA. Nunca `log.error(...); return;`.** Tragarlo
borra el mensaje de la cola y lo hace desaparecer: la DLQ que cuelga de la `RedrivePolicy`
no recibe nada, la aserción de «acabó en el descarte» mira una cola vacía y el único rastro
es una línea de log que nadie está mirando. Lanzando, el mensaje vuelve a hacerse visible
al vencer el visibility timeout y el `maxReceiveCount` lo acaba llevando a la DLQ, que es
lo que el diseño declaró.

Aquí no hay «no reintentable»: SQS cuenta recepciones, no tipos de excepción. Un cuerpo
roto va a consumir sus `maxReceiveCount` intentos antes de la DLQ y **eso es correcto** —
es el precio de que el descarte lo arbitre el broker y no la aplicación. No lo atajes
borrando el mensaje a mano.

**No lo confundas con descartar lo ajeno.** Con fan-out y `FilterPolicy` por `eventType`,
en tu cola normalmente no hay nada ajeno; si aun así compruebas el tipo, ese caso —mensaje
que no es tuyo— sí es un `return` limpio. La regla corta: *no es mío* → `return` sin
excepción; *es mío y está roto* → excepción.

## Checklist

- [ ] Topología creada por script reproducible en `infra/` (raw delivery, redrive, DLQ).
- [ ] Stub del publisher eliminado; ARN por configuración, no literal.
- [ ] Puerto de envío implementado según `reliability` (`OutboxDispatcher` u `<Evento>Publisher`), con su stub eliminado y el fallo propagado (outbox) o registrado (best-effort).
- [ ] `onFailure` → `maxReceiveCount` + DLQ según el diseño, **y su `backoff` aplicado con
      `Visibility.extend(...)`**: la cola sola solo sabe de un timeout fijo.
- [ ] `@SqsListener` apunta a la clave `queue` de la suscripción, no a `topic`.
- [ ] El `TopicArnResolver` **lista**, no crea, y exige suscriptor confirmado.
- [ ] `apiCallAttemptTimeout`/`apiCallTimeout` acotados en el `SnsClient` del envío.
- [ ] Visibility timeout ≥ 6× el tiempo de proceso del handler.
- [ ] Un cuerpo propio que no parsea **lanza** (el `maxReceiveCount` lo lleva a la DLQ), nunca `log.error` + `return`.
- [ ] La rama «carrera resuelta» captura `InvalidStateTransitionException` **y** `OptimisticLockingFailureException` (la base de `org.springframework.dao`), y con el orden `record` llama a `record(...)` igualmente.
- [ ] Listener envuelto en `CorrelationContext.runWith(...)` y deduplicado con el `IdempotencyGuard` en el orden que prescribe el javadoc del `<Evento>Message` (sin mecanismo propio).

## Si la suscripción alimenta una proyección

Cuando el diseño declara `dependencies` y el evento aparece en el `fedBy` de una réplica, **el listener
no cambia**: sigue siendo `listener → IdempotencyGuard → UseCaseMediator → handler`. El
`<Entidad>Projector` lo invoca ese handler, no tú.

**Nunca llames al Projector desde el listener.** Sería una segunda puerta de entrada al dominio
saltándose el mediator (lo prohíbe `constitution.md`) y duplicaría la deduplicación que ya hace el
guard. La suscripción tiene `triggers` obligatorio precisamente para que esa operación exista.

Detalle completo en `{{keel:docs}}/conventions/dependencies.md`.
