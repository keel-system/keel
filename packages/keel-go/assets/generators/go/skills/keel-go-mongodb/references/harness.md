# El almacén desde una prueba de flujo

Lo que se ve por HTTP se comprueba por HTTP. Para lo que no —que una escritura llegó de verdad al documento, o la
precondición de un escenario que ninguna operación del diseño puede fabricar— el escenario tiene `s.MongoEval(script)`:
un script de mongosh contra la base de prueba, que devuelve su salida en crudo.

```go
got := strings.TrimSpace(s.MongoEval(`db.getCollection("jobs").countDocuments({ status: "QUEUED" })`))
```

- Los nombres son los del DOCUMENTO: snake_case y `_id`. Un enum va por su CONSTANTE (`"QUEUED"`), no por el valor
  del cable.
- Un id va como `UUID("…")`: el `_id` es un binario de subtipo 4, y un texto no casa con nada **sin fallar** (el
  script devuelve cero y el escenario sale verde sin haber probado nada).
- El script viaja por archivo y envuelto en un `print`: devuelve el valor de la expresión, sin `print` tuyo.

Los ayudantes del rescate (`StallInFlight`, `PutInFlight`, `InFlightWithoutClock`) y los del outbox
(`DeadLetteredEvents`, `AbandonOutboxEvent`, `ClearAbandonedOutboxEvents`) ya llevan sus scripts: se usan, no se
reescriben. `infra/reset-db.sh` vacía las colecciones conservando los índices.
