# Informe de generación

Lo que apareció durante la generación de `stock-reservation-spring` y no es de este proyecto, sino
del generador (`keel-spring`) o del diseño (`specs/stock-reservation`). Cada entrada dice de quién es.

## Parches al arnés de pruebas (`keel-spring build` / scaffolding de `infra/`)

`AbstractFlowIT.java`, generado por el scaffolding, tenía tres defectos de fontanería descubiertos
al ejercitar los escenarios `FL-CNT-001-B`, `FL-CMP-001-B` y `FL-CMP-001-C` (síntoma: la aserción
"sin DLQ" de un escenario se contaminaba con mensajes muertos de un flujo anterior, porque el reset
entre clases nunca purgaba `inventory.events.DLT`):

1. **`nextOffset()`/`safeNextOffset()`** solo operaban sobre `EVENT_TOPIC`. Se añadió la sobrecarga
   `nextOffset(String topic)` / `safeNextOffset(String topic)`; las versiones sin argumento delegan
   en `EVENT_TOPIC` (compatible hacia atrás).
2. **`markChannels()`** nunca marcaba los topics de dead-letter. Ahora también marca
   `Set.copyOf(DEAD_LETTER_OF.values())` con `safeNextOffset(topic)`, igual que ya hacía con `CHANNELS`.
3. **`deadLetterMessages(subscription, count)`** leía "los últimos N mensajes" del DLT completo sin
   aislar por escenario. Ahora lee desde `MARKS.get(deadLetterTopic)` (el offset fijado por
   `markChannels()` en el reset de la clase) hasta el final; cae al comportamiento anterior
   (`-count`) solo si no hay marca, por compatibilidad.

Sin este patch, cualquier proyecto generado por `keel-spring` con más de una suscripción compartiendo
un topic de dead-letter (patrón común: varias suscripciones sobre el mismo topic multiplexado)
arrastrará el mismo falso negativo intermitente entre clases de flujo.

## Huecos del diseño detectados (`specs/stock-reservation`)

1. **`messaging.keel.yaml`**: las suscripciones `StockReserved`, `StockCountAdjusted` y `StockRejected`
   comparten el canal `stockEvents`/topic `inventory.events` sin declarar `discriminator`, pese a tener
   payloads distintos. Se resolvió usando `metadata.eventType` de la envoltura Keel como discriminador
   implícito (cada listener con su propio `groupId` ve el topic entero y descarta lo que no es suyo).
   Propuesta: declarar `contract.discriminator: { location: field, field: metadata.eventType, value: <Evento> }`
   en cada suscripción para que quede explícito en el diseño.
2. **`createReservation`**: no hay un `code`/`errors[]` declarado para "la misma clave de idempotencia
   reutilizada con un cuerpo distinto". Se reutilizó `IdempotencyConflictException`
   (`IDEMPOTENCY_KEY_IN_PROGRESS`, 409) en vez de inventar un código nuevo; no hay escenario `FL-*` que
   lo cubra. Propuesta: añadir un error explícito (p. ej. `IDEMPOTENCY_KEY_REUSED`) si se quiere
   distinguir de la carrera concurrente.
3. **`persistence.consistency.optimisticLocking: all`** está declarado, pero `use-cases.keel.yaml` no
   declara un `code`/`http` para el 409 de escritura concurrente sobre la raíz. Se mantuvo el default
   del scaffolding (`OPTIMISTIC_LOCK_CONFLICT`, 409).

## Sin hallazgos adicionales

No hubo probes de infraestructura con veredicto `FALSO-NEGATIVO`, ni hallazgos conductuales
reportados (no aplicados) por el pase de calidad.
