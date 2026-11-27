# El barrido de lo que espera desenlace

## Candidatos y reclamo

Los genera build: `<Registro>Repository.claimForPaymentSweep(staleBefore, batchSize)` devuelve los cobros en los estados
que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el `inFlight` de cada acción de
seguimiento— cuyo `awaitingSince` es anterior a `staleBefore`, ya RECLAMADOS. Pásale
`paymentReconciliation.staleBefore(now)` (el umbral del diseño) y `paymentReconciliation.batchSize()` (la cota del lote,
`payments.reconciliation.batch-size`): no los escribas como constantes.

El barrido puede correr en varias réplicas a la vez (el tick del cronómetro es al menos una vez; sin cronómetro,
`@Scheduled` corre en todas), y el método reclama cada candidato con una escritura condicional que renueva
`awaitingSince` solo si sigue esperando y rancio: la réplica que pierde no lo ve. Lo hace en su propia transacción y la
confirma antes de volver. Con el cronómetro, avisa él mismo del lote lleno (`SweepPass.claimed`) y el tick repite la
pasada. **No escribas otro reclamo**: un `@Modifying` en el adaptador hereda el `@Transactional(readOnly = true)` de la
clase y el motor lo rechaza.

## Qué hacer con lo que diga la pasarela

`paymentReconciliation.consult(reference, gatewayPaymentId)` consulta y aplica. Te devuelve el
estado para lo que no es un desenlace:

| Devuelve | Qué haces |
|---|---|
| `PENDING` | Nada: se queda para la siguiente pasada |
| `NOT_FOUND` | Ya aplicado: fallido con `notReceived` |
| `AUTHORIZED` con el cobro en `capturing`/`canceling` | La acción no llegó a hacerse: el cobro vuelve a `authorized` |
| `CAPTURED` con el cobro en `refunding` | La devolución no llegó a hacerse: vuelve a `captured` (sin `refund.reference`; con ella, ver abajo) |
| cualquier otro | Ya aplicado por el aplicador |

## La devolución en vuelo (con `refund.reference`)

Con `partial-refund` un cobro admite varias devoluciones, y la consulta del cobro solo sabe el **acumulado** devuelto: leída
como el desenlace de la devolución en curso, registraría el acumulado como su importe y, si hubo otra devolución antes,
daría por hecha una que nunca llegó a la pasarela (corrida payment-spring). Por eso un candidato en el estado en vuelo de
la devolución NO se consulta con la llamada de arriba sino con

```
paymentReconciliation.consultRefund(reference, refundReference, gatewayPaymentId, alreadyRefunded)
```

`refundReference` es la referencia de la devolución pendiente del cobro (el campo de `payments.refund.reference`) y
`alreadyRefunded` lo que el registro ya cuenta como devuelto, sin esa devolución. Devuelve `REFUNDED` (ya aplicado, con
el importe de ESA devolución), `PENDING` (no hagas nada: sigue en vuelo) o `CAPTURED`: la devolución no llegó a la
pasarela o la rechazó, y el cobro vuelve a `captured` con la devolución en `failed`, como manda el diseño.
