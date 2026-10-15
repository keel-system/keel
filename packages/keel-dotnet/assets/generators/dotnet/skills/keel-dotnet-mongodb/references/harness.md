# El arnés sobre documentos

Las pruebas de flujo (`tests/<Servicio>.IntegrationTests/`) heredan de `FlowTest` (`Support/FlowTest.cs`). Sobre MongoDB,
lo que en relacional hace `Db(sql)` lo hace `MongoEval(script)` con un script de mongosh, y con él los ayudantes que
fabrican precondiciones. Son los mismos nombres que el arnés de keel-spring y el de keel-nest, con los mismos scripts.

| Ayudante | Para qué |
|---|---|
| `ResetState()` | deja la base como recién arrancada (vacía los documentos y CONSERVA los índices); la base ya lo llama al empezar cada flujo |
| `MongoEval(script)` | un Then que mira el almacén, o una precondición que ninguna operación produce |
| `StallInFlight(barrido, id)` | deja el documento EN VUELO con el reloj rancio: el que dejó una réplica muerta, que el rescate busca |
| `PutInFlight(barrido, id)` | lo mismo con el reloj a ahora: el que el rescate NO debe tocar |
| `InFlightWithoutClock(barrido)` | cuántos quedaron en vuelo sin reloj; tiene que valer 0 siempre |
| `AgeForReconciliation(activación, id)` | envejece SOLO la marca de espera de ese documento: el barrido lo toma en su próxima pasada |
| `HoldFromReconciliation(activación, id)` | el inverso: la marca en el futuro, para que el barrido NO lo tome aunque pasen sus ciclos |
| `DeadLetteredEvents()`, `AbandonOutboxEvent(tipo)`, `ClearAbandonedOutboxEvents()` | el outbox (con mensajería) |

```csharp
var output = MongoEval("db.getCollection(\"jobs\").countDocuments({ status: \"QUEUED\" })");
Assert.Equal("0", output.Trim());
```

- Las claves del script son las del DOCUMENTO (`snake_case`, `_id`), y el estado es la CONSTANTE del enum (`"QUEUED"`,
  no `"queued"`).
- Un id va como `UUID("…")`: el `_id` es binario, y un literal que no case deja el script en cero modificados SIN fallar.
- La salida es lo que imprime mongosh: `.Trim()` y conviértela. Vacío NO es cero.
- Antes de mirar el almacén, comprueba por la API si el servicio lo expone: es lo que haría un cliente.
- `AgeForReconciliation` y `StallInFlight` no disparan el barrido: lo dispara su cron. Espera el efecto con
  `Eventually(...)` y un margen para un tick.
