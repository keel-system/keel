# El barrido de lo que espera desenlace

## Candidatos

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del
cliente, y el `inFlight` de cada acción de seguimiento— cuyo `awaitingSince` es más antiguo que
`payments.reconciliation.unanswered-after-seconds`. Un lote acotado por pasada.

## El reclamo

`@Scheduled` corre en todas las réplicas. Antes de consultar, cada candidato se reclama con una
actualización CONDICIONAL que vuelve a estampar `awaitingSince` (`... where id = ? and
awaiting_since = ?`): la réplica que pierde ve 0 filas y lo salta. Sin reclamo, las N réplicas
consultan el mismo cobro, y si la consulta desencadena una escritura, la hacen N veces.

## Qué hacer con lo que diga la pasarela

`paymentReconciliation.consult(reference, gatewayPaymentId)` consulta y aplica. Te devuelve el
estado para lo que no es un desenlace:

| Devuelve | Qué haces |
|---|---|
| `PENDING` | Nada: se queda para la siguiente pasada |
| `NOT_FOUND` | Ya aplicado: fallido con `notReceived` |
| `AUTHORIZED` con el cobro en `capturing`/`canceling` | La acción no llegó a hacerse: el cobro vuelve a `authorized` |
| `CAPTURED` con el cobro en `refunding` | La devolución no llegó a hacerse: vuelve a `captured` |
| cualquier otro | Ya aplicado por el aplicador |
