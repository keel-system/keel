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

## Fiabilidad del publisher

- `after-commit`: publica en `TransactionSynchronization.afterCommit` (o
  `@TransactionalEventListener(phase = AFTER_COMMIT)`). El `send()` es
  asíncrono: registra el fallo del future, no lo ignores:

  ```java
  kafkaTemplate.send(TOPIC, key, envelope).whenComplete((result, ex) -> {
      if (ex != null) log.error("Evento {} no publicado", key, ex);
  });
  ```

- `outbox`: el handler escribe el evento en la tabla outbox **dentro** de la
  transacción; un relay (`@Scheduled`) lee pendientes, publica y marca. Es la
  única garantía real de no perder eventos; no lo «simules» con reintentos.
- `best-effort`: send directo; un fallo se loguea y no interrumpe la operación.

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

## Idempotencia de consumo

Kafka es at-least-once: tras un rebalanceo o un crash post-proceso/pre-commit,
el mensaje se reentrega. Si la operación `triggers` no es naturalmente
idempotente, deduplica con el `eventId` del `EventEnvelope` (tabla de
procesados dentro de la transacción del handler, o `SET NX` si hay cache en el
stack). No dependas de «no suele pasar»: los escenarios de validación con
reset lo provocan.

## Observación

- Lag por group: `kcat -b kafka:29092 -L` para metadata; para lag real,
  `kafka-consumer-groups.sh --describe --group <group>` desde el contenedor.
- Los headers del `EventEnvelope` (correlationId) viajan en el payload JSON;
  si el diseño exige propagación por headers Kafka nativos, añade
  `ProducerRecord` con headers y documenta el contrato.

## Checklist

- [ ] Stub del publisher eliminado (dos beans del puerto rompen la inyección).
- [ ] Key elegida según la garantía de orden que exige el diseño.
- [ ] `reliability` aplicada (after-commit / outbox / best-effort) con fallo de publicación registrado.
- [ ] `onFailure` → reintentos acotados + DLT si `deadLetter: true`; errores de negocio excluidos.
- [ ] `ErrorHandlingDeserializer` configurado (poison pills al DLT, no en bucle).
- [ ] Consumo idempotente si la operación puede reintentarse.
