# Kafka — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md. El mapeo normativo
DSL → código sigue en `{{keel:docs}}/conventions/mapping.md`.

## Elección de key y orden

Kafka solo garantiza orden **dentro de una partición**; la key decide la
partición. La key por defecto —y la que asume el resto de la cadena, outbox
incluido— es la **routing key** del evento, que agrupa por tipo. Si el diseño
exige orden por entidad (p. ej. eventos del mismo agregado en orden), la key
correcta es el **id del agregado**:

```java
kafkaTemplate.send(destination, event.productId().toString(), payload);
```

Decide una vez por evento y documenta la decisión: cambiar la key en caliente
rompe el orden durante la transición. **`payload` es siempre el `String` que
produjo el `ObjectMapper` de la aplicación** — nunca el objeto Java: el producer
está configurado con `StringSerializer` y pasarle un POJO lo dejaría en
`toString()`, igual que un `JsonSerializer` lo escaparía dos veces.

## Fiabilidad del envío

La fase de publicación (dentro o fuera de la transacción) ya la resuelve el
`<Servicio>DomainEventBridge` generado. Lo que cambia según la `reliability` es
qué implementas y cómo tratas el fallo:

- `outbox`: implementas `OutboxDispatcher`. El `send()` es asíncrono, así que
  **espera el ack** (`.join()`) y deja propagar la excepción: es lo que hace que
  el relay cuente el intento y reintente. Un dispatcher que traga la excepción
  marca como publicado algo que nunca salió y convierte el outbox en decorado.
- `best-effort`: implementas `<Evento>Publisher`. No hay reintento posible, así
  que al menos registra el fallo del future, no lo ignores:

  ```java
  kafkaTemplate.send(destination, routingKey, payload).whenComplete((result, ex) -> {
      if (ex != null) log.error("Evento {} no publicado", routingKey, ex);
  });
  ```

## Reintentos del listener: ya están generados

**`DeadLetterConfig` es de build.** Declara un `DefaultErrorHandler` con los intentos y
el backoff que el diseño puso en `onFailure.retry`, y un `DeadLetterPublishingRecoverer`
que publica en `<topic>.DLT` **solo** para las suscripciones con `deadLetter: true`. No
lo redeclares ni lo sustituyas.

**No uses `@RetryableTopic`.** Es no bloqueante y resulta tentador, pero:

- Crea su propia cadena `<topic>-retry-*` y `<topic>-dlt`, distinta del destino que
  declara la topología y del que lee el arnés (`deadLetterMessages(...)`). La aserción
  de que un mensaje **no** acabó en el descarte pasaría mirando una cola que nadie
  alimenta, que es peor que no tenerla.
- Saca el mensaje de su partición, así que rompe el orden relativo — y el orden por
  partición es justo lo que se conserva con el error handler in-situ.

Lo que sí te toca: excluir lo no reintentable. Un error de negocio declarado en el
diseño no mejora repitiéndolo, y reintentarlo hasta agotar acaba mandando a la DLQ un
mensaje perfectamente válido — ruido operativo que se lee como incidente:

```java
errorHandler.addNotRetryableExceptions(DomainException.class);
```

Y si inyectas un `KafkaTemplate` en tu configuración, **decláralo con los mismos
genéricos que ya usa `DeadLetterConfig`** (`KafkaTemplate<Object, Object>`). Hoy un
`<String, String>` resuelve igual contra el bean autoconfigurado porque Boot lo declara
con los genéricos sin resolver, pero son dos peticiones distintas del mismo bean: en
cuanto alguien declare un template tipado, una de las dos deja de inyectar y el error
aparece en el arranque, lejos de aquí.

## Poison pills

Hay **dos** caminos por los que un mensaje llega roto, y solo uno lo cubre la config.

**El del deserializador.** Con `JsonDeserializer` a pelo un mensaje imparseable revienta
el poll en bucle infinito (el offset nunca avanza). Por eso configuration.md envuelve con
`ErrorHandlingDeserializer`: el fallo llega al error handler como
`DeserializationException` (no reintentable por defecto) y acaba en el DLT con el payload
crudo para inspección.

**El del listener, que es el que te va a tocar.** El stub que genera build recibe el
cuerpo en crudo y lo parsea **dentro** del método, así que el deserializador de arriba no
llega a verlo: el `try/catch` alrededor del `readValue` es tuyo, y ahí es donde se decide
si `onFailure.deadLetter` significa algo.

**Un cuerpo que es tuyo y no parsea se LANZA. Nunca `log.error(...); return;`.** Tragarlo
confirma el offset y el mensaje desaparece: el destino de descarte que declara el diseño
no recibe nada, la aserción de «acabó en el descarte» mira una cola vacía y el único
rastro es una línea de log que nadie está mirando. Lánzalo como no reintentable —repetir
un JSON roto da el mismo JSON roto— y llegará al DLT en el primer intento:

```java
} catch (JsonProcessingException malformed) {
    throw new IllegalArgumentException("<Evento>: cuerpo no parseable", malformed);
}
```

```java
// En tu KafkaConsumerConfig, junto a DomainException:
errorHandler.addNotRetryableExceptions(IllegalArgumentException.class);
```

El tipo que lances y el que excluyas son **el mismo contrato repartido en dos archivos**:
si cambias uno sin el otro, el cuerpo roto pasa a reintentarse cinco veces antes de acabar
donde ya iba a acabar. Deja la referencia cruzada escrita en los dos sitios.

**No lo confundas con descartar lo ajeno**, que es el caso contrario y sí es un `return`
limpio: ahí el mensaje **no es tuyo** —el topic transporta todos los eventos de la fuente
y este es de otro tipo—, parsea perfectamente y mandarlo al descarte sería secuestrar el
mensaje de otro. La regla corta: *no es mío* → `return` sin excepción; *es mío y está
roto* → excepción no reintentable. Los dos viven a tres líneas uno del otro y el javadoc
del `<Evento>Message` dice cuál es cuál.

## Correlación e idempotencia en el listener

Kafka es at-least-once: tras un rebalanceo o un crash post-proceso/pre-commit,
el mensaje se reentrega. No dependas de «no suele pasar»: los escenarios de
validación con reset lo provocan.

Todo listener sigue el mismo esqueleto, y **ambas piezas ya están generadas**:
no escribas un mecanismo propio.

1. **Abre la correlación** con
   `CorrelationContext.runWith(envelope.metadata().correlationId(), () -> { ... })`.
   Así los eventos que provoque este consumo salen con la correlación del
   mensaje de origen y el flujo completo se sigue en los logs. `runWith` cierra
   el contexto pase lo que pase, que es lo que evita que el siguiente mensaje
   atendido por ese hilo del pool herede una correlación ajena.
2. **Descarta duplicados** con el `idempotencyGuard`, pasándole
   `"<NombreDelListener>"` y el `id` que declara el diseño: el `messageId` de la
   suscripción o, si no lo hay, `envelope.metadata().eventId()`. Si dice que ya
   se procesó, confirma el offset y vuelve sin procesar. El guard y su tabla
   `processed_event` viven en `infrastructure/messaging/idempotency/`.
   **El orden lo prescribe el javadoc del `<Evento>Message` que generó build, y
   las dos formas no son intercambiables**: `alreadyProcessed(...)` aquí y
   `record(...)` después de despachar bien si la operación de `triggers` declara
   `transitions`; `tryRecord(...)` aquí si no las declara.
   Si esa clave llega **nula o vacía**, no hay nada con que deduplicar: registra un
   `warn` que lo diga y descarta, en vez de llamar al guard con un id nulo — un
   registro con clave vacía deduplica contra todos los demás mensajes sin clave.
3. **Despacha** la operación `triggers` vía `UseCaseMediator`.

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

En esa rama **no lanzas**: confirmas el mensaje, lo registras a `debug` diciendo por qué, y
—con el orden `record`— llamas a `record(...)` **igualmente**. El mensaje quedó atendido;
lo atendió el otro camino. Sin ese registro, cada reentrega vuelve a atravesar el dominio
entero para terminar en este mismo `catch`.

No es tragarse un error: aquí se sabe *por qué* no se reintenta —el efecto ya está
aplicado— y se dice. `build` lo anota en el javadoc del `<Evento>Message` cuando ve la
carrera; que no lo anote no significa que no exista, significa que el diseño no la declara.

## Observación

- Lag por group: `kcat -b kafka:29092 -L` para metadata; para lag real,
  `kafka-consumer-groups.sh --describe --group <group>` desde el contenedor.
- Los headers del `EventEnvelope` (correlationId) viajan en el payload JSON;
  si el diseño exige propagación por headers Kafka nativos, añade
  `ProducerRecord` con headers y documenta el contrato.

## Checklist

- [ ] Stub del publisher eliminado (dos beans del puerto rompen la inyección).
- [ ] Key elegida según la garantía de orden que exige el diseño.
- [ ] Puerto de envío implementado según `reliability` (`OutboxDispatcher` u `<Evento>Publisher`), con su stub eliminado y el fallo propagado (outbox) o registrado (best-effort).
- [ ] `onFailure` → NO redeclarado (build genera DeadLetterConfig); errores de negocio excluidos con `addNotRetryableExceptions`.
- [ ] `ErrorHandlingDeserializer` configurado (poison pills al DLT, no en bucle).
- [ ] Un cuerpo propio que no parsea **lanza** (y su tipo está en `addNotRetryableExceptions`), nunca `log.error` + `return`; descartar lo ajeno sí es `return` sin excepción.
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
