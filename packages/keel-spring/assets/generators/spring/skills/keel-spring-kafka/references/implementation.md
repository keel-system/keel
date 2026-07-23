# Kafka — patrones de implementación

Complementa las secciones Publisher/Listener del SKILL.md. El mapeo normativo
DSL → código sigue en `.claude/conventions/mapping.md`.

## Elección de key y orden

Kafka solo garantiza orden **dentro de una partición**; la key decide la
partición. La key por defecto del SKILL.md (nombre del evento) agrupa por tipo;
si el diseño exige orden por entidad (p. ej. eventos del mismo agregado en
orden), la key correcta es el **id del agregado**:

```java
kafkaTemplate.send(TOPIC, event.productId().toString(), envelope);
```

Decide una vez por evento y documenta la decisión: cambiar la key en caliente
rompe el orden durante la transición.

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
  kafkaTemplate.send(topic, key, envelope).whenComplete((result, ex) -> {
      if (ex != null) log.error("Evento {} no publicado", key, ex);
  });
  ```

## Reintentos del listener: `@RetryableTopic` vs `DefaultErrorHandler`

- **`@RetryableTopic`** (el default de esta skill, no bloqueante): reintentos
  vía topics `<topic>-retry-*` y DLT `<topic>-dlt`, creados automáticamente.
  El consumidor sigue procesando otros mensajes mientras el fallido espera.
- **`DefaultErrorHandler`** (en la container factory, bloqueante): reintenta
  in-situ con `FixedBackOff`/`ExponentialBackOffWithMaxRetries` y entrega a
  `DeadLetterPublishingRecoverer`. Úsalo si el orden por partición debe
  sobrevivir al fallo (RetryableTopic saca el mensaje de su partición y rompe
  el orden relativo).

En ambos, excluye lo no reintentable — un error de negocio declarado en el
diseño no mejora reintentando:

```java
@RetryableTopic(attempts = "5", backoff = @Backoff(delay = 1000, multiplier = 2.0),
        dltStrategy = DltStrategy.FAIL_ON_ERROR,
        exclude = { DomainException.class })  // directo al DLT, sin reintentos
```

(Con `DefaultErrorHandler`: `errorHandler.addNotRetryableExceptions(DomainException.class)`.)

## Poison pills

Un mensaje imparseable con `JsonDeserializer` a pelo revienta el poll en bucle
infinito (el offset nunca avanza). Por eso configuration.md envuelve con
`ErrorHandlingDeserializer`: el fallo llega al error handler como
`DeserializationException` (no reintentable por defecto) y acaba en el DLT con
el payload crudo para inspección.

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
2. **Descarta duplicados** con
   `idempotencyGuard.tryRecord("<NombreDelListener>", id)`, donde `id` es el
   `messageId` declarado en la suscripción o, si no lo hay,
   `envelope.metadata().eventId()`. Si devuelve `false`, confirma el offset y
   vuelve sin procesar. El guard y su tabla `processed_event` viven en
   `infrastructure/messaging/idempotency/`.
3. **Despacha** la operación `triggers` vía `UseCaseMediator`.

Cuándo registrar: si la operación puede fallar de forma transitoria y debe
reintentarse, llama a `tryRecord` **después** de despachar. Registrar antes
convierte un fallo pasajero en un mensaje perdido, porque el guard escribe en su
propia transacción.

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
- [ ] `onFailure` → reintentos acotados + DLT si `deadLetter: true`; errores de negocio excluidos.
- [ ] `ErrorHandlingDeserializer` configurado (poison pills al DLT, no en bucle).
- [ ] Listener envuelto en `CorrelationContext.runWith(...)` y deduplicado con `IdempotencyGuard.tryRecord(...)` (sin mecanismo propio).
