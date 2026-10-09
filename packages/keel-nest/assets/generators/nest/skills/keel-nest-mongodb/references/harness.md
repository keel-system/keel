# El arnés sobre documentos

Las pruebas de flujo (`test/integration/`) importan SOLO de `test/integration/support/flow.ts`. Sobre
MongoDB, lo que en relacional hace `db()` con SQL lo hace `mongoEval()` con un script de mongosh, y con él los
ayudantes que fabrican precondiciones. Son los mismos nombres que el arnés de keel-spring.

| Ayudante | Para qué |
|---|---|
| `resetState()` | deja la base como recién arrancada (vacía los documentos y CONSERVA los índices); `useFlow()` ya lo llama al empezar cada flujo |
| `mongoEval(script)` | un Then que mira el almacén, o una precondición que ninguna operación produce |
| `stallInFlight(barrido, id)` | deja el documento EN VUELO con el reloj rancio: el que dejó una réplica muerta, que el rescate busca |
| `putInFlight(barrido, id)` | lo mismo con el reloj a ahora: el que el rescate NO debe tocar |
| `inFlightWithoutClock(barrido)` | cuántos quedaron en vuelo sin reloj; tiene que valer 0 siempre |
| `ageForReconciliation(activación, id)` | envejece SOLO la marca de espera de ese documento: el barrido lo toma en su próxima pasada |
| `holdFromReconciliation(activación, id)` | el inverso: la marca en el futuro, para que el barrido NO lo tome aunque pasen sus ciclos |
| `deadLetteredEvents()`, `abandonOutboxEvent(tipo)`, `clearAbandonedOutboxEvents()` | el outbox (con mensajería) |

```ts
const output = mongoEval('db.getCollection("jobs").countDocuments({ status: "QUEUED" })');
expect(Number(output.trim())).toBe(0);
```

- Las claves del script son las del DOCUMENTO (`snake_case`, `_id`), y el estado es la CONSTANTE del enum
  (`"QUEUED"`, no `"queued"`).
- Un id va como `UUID("…")`: el `_id` es binario, y un literal que no case deja el script en cero
  modificados SIN fallar.
- La salida es lo que imprime mongosh: `.trim()` y conviértela. Vacío NO es cero.
- Antes de mirar el almacén, comprueba por la API si el servicio lo expone: es lo que haría un cliente.
- `clearAbandonedOutboxEvents()` es **asíncrona** sobre documentos: `await clearAbandonedOutboxEvents();`.
- `ageForReconciliation` y `stallInFlight` no disparan el barrido: lo dispara su cron. Espera el efecto con
  `eventually(...)` y un margen para un tick.
