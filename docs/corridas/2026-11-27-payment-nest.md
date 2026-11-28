# Corrida de `payment` con keel-nest en keel-registry (Stripe)

| Etiqueta | Valor |
|---|---|
| Papel | control |
| Diseño | `payment` v0.2.3 (DSL 2.33, relacional, capa `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-nest@0.3.0` |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** (primera pasada 30/32: FL-MTH-003 y FL-STL-005) |
| Huella del agente | 392 archivos registrados por `build`, 0 adoptados, **29 reescritos**, 0 borrados |
| Huecos del diseño | 1 (`refundedAmount` sin escala) → `/keel-evolve` |
| Huecos del generador | 2, arreglados en keel-nest |
| Agujeros de la puerta | 0 |
| Convertidos en id | ninguno |

Proyecto en `C:\Users\antonio.suarez\proyectos\keel\keel-registry\services\payment-nest`, commit `1c3c3e3` («Generado
desde specs/payment v0.2.3»). La evalué regenerando EN MEMORIA con `planService` y comparando archivo a archivo con el
proyecto, y después con payment-spring, payment-dotnet y payment-go (el mismo diseño). El informe del agente
(`INFORME-GENERACION.md`) daba dos defectos del generador. Uno lo era. El otro (la escala) es del diseño. Y no contaba
el segundo defecto real, que solo aparece comparando con los otros tres.

## Huecos del generador

- **El relevo de un índice único condicionado sobre una HIJA.** `PaymentMethod` lleva `unique` sobre `[wallet]` con
  `when: { field: isDefault, equals: true }`, y el agregado `Wallet` se guarda con UN `save` en cascada. TypeORM inserta
  la hija nueva antes de actualizar las que ya existían, y un índice parcial no se puede diferir: cambiar el medio
  preferente moría con un 409 en el camino feliz (FL-MTH-003). El agente añadió a mano un `UPDATE` previo en
  `wallet-repository-impl.ts`. El handler no puede ordenar las escrituras de las hijas, y `relievingOperations` de
  keel-core solo ve el relevo por transiciones de lifecycle, así que tampoco había nota. Ahora el `save` relacional de la
  raíz deja en la base, antes de la cascada, lo que sale de la condición (`childReliefs` en
  `keel-nest/src/scaffold/repositories.js`, con el valor de `storedWhenValue`).
- **El `save` que abre su transacción devolvía el error crudo del motor.** Un handler despachado sin transacción
  (`requestCharge`, `refundPayment`, el barrido) no podía capturar la carrera perdida por la clave natural
  (`ChargeRequestConflictError`), porque en keel-nest solo la traduce el filtro HTTP. El agente añadió `trySave` al
  PUERTO de dominio. keel-dotnet (`PersistenceTransactions.InTransaction`) y keel-go (`translate`) ya lo traducían, y sus
  agentes hacen `catch (ChargeRequestConflictError)`. Ahora el `save` de la raíz pasa `{ translate: asContractError }` a
  la transacción. Solo se aplica cuando la abre él: unida a la del mediator no cambia nada, así que lo que ven los
  listeners y la telemetría no se mueve. La skill `keel-nest-payments` y `conventions/mapping.md` lo dicen.

Redes: `test/save-contract.test.js` (forma del relevo y las dos `TransactionContext` emitidas, ejecutadas con
sustitutos), la silueta `mailer-child-conditional` (`keel-core/test/helpers/child-conditional-designs.js`, en
`DERIVED_SILHOUETTES`) y `db-check`/`doc-check`: el bloque del relevo (`--sabotage=child-relief`) y los casos que guardan
fuera de transacción, que ahora esperan el error del diseño desde el `save` (`--sabotage=raw-own-tx`).

Medido sobre `mailer-child-conditional`: en verde en PostgreSQL y MySQL. `child-relief` tira los cuatro casos del relevo en
MySQL. En PostgreSQL tira los dos de la hija NUEVA: pasar la condición entre dos hijas que ya existían sale bien sin el
relevo, porque ahí son dos UPDATE y TypeORM los escribe en un orden que no choca. `raw-own-tx` tira exactamente los casos
de versión, clave natural e índice condicionado de las tres raíces, en los dos motores, y lo mismo en `doc-check` sobre
`notification-mailer-mongo`. Las redes completas, en verde: `db-check` 236/236 y `doc-check` 47/47.

La primera pasada de las redes completas destapó tres cosas de las sondas. CW-5 esperaba el error crudo. PD-2 lo necesita
para medir el log del filtro, y ahora guarda dentro de una transacción abierta. La tercera no venía del cambio: la muestra
de un `int` era `min + contador`, con el contador del módulo, así que en la red completa el `expMonth` de
`payment-checkout` pasaba de 12 y su sonda no llegaba a correr (con `--subject` solo no se veía). Ahora respeta el `max`.

## Lo que no es del generador

- **`refunded_amount` en `numeric(38,2)`** y no `numeric(19,3)`: `Payment.refundedAmount` se declara `type: decimal`
  sin escala, y los cuatro generadores emiten el mismo `numeric(38,2)` por defecto (payment-spring, -dotnet y -go
  también). Se corrige en el diseño: `type: Amount` o `constraints: { scale: 3 }`.
- FL-STL-005 (`culprit: test`), el registro del dispatcher de RabbitMQ en `broker-bindings.ts`, la sección de producción
  del README y `PaymentFollowUp` en `use-case-module.ts`: lo que le toca al agente.

## designGaps

- `refunded-amount-scale`: `refundedAmount` sin escala, cuando suma importes de escala 3. Pendiente de `/keel-evolve`
  en keel-registry/specs/payment, junto con `refund.reference: refundRequestId`.
