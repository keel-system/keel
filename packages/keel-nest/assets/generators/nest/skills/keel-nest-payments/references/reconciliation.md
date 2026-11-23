# El barrido de lo que espera desenlace

## Candidatos y reclamo: ya generados

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
`inFlight` de cada acción de seguimiento— cuyo `awaitingSince` es anterior a
`this.paymentReconciliation.staleBefore(now)` (el umbral es `payments.reconciliation.unanswered-after-seconds`, o el
parámetro que enlaza `payments.reconciliation.unansweredAfter`; en local y test, 5 segundos), en un lote acotado
—`this.paymentReconciliation.batchSize()`—, el que más lleva esperando primero.

No los busques tú: build generó el reclamo en el repositorio del registro (G11 de la corrida payment de prueba-gelsa):

```ts
const claimed = await this.paymentRepository.claimForPaymentSweep(
  this.paymentReconciliation.staleBefore(new Date()),
  this.paymentReconciliation.batchSize()
);
for (const payment of claimed) {
  // fuera de toda transacción: la llamada a la pasarela no puede ir dentro de ninguna
  await this.paymentReconciliation.consult(payment.reference, payment.gatewayPaymentId);
}
```

Devuelve los cobros SIGUIENDO en su estado y con `awaitingSince` renovado: una escritura condicional por cobro, en su
propia transacción y confirmada antes de volver, así que la réplica que llega tarde no lo ve. Con el cronómetro, ya
avisa del lote lleno (`SweepPass.claimed`) y el tick repetirá la pasada. El barrido corre **sin transacción
abarcadora**. Un segundo reclamo escrito a mano en paralelo al generado no reclama nada, solo reparte peor.

## Qué hacer con lo que diga la pasarela

`this.paymentReconciliation.consult(reference, gatewayPaymentId)` consulta y aplica. Te devuelve el estado para lo
que no es un desenlace:

| Devuelve | Qué haces |
|---|---|
| `PENDING` | Nada: se queda para la siguiente pasada |
| `NOT_FOUND` | Ya aplicado: fallido con `notReceived` |
| `AUTHORIZED` con el cobro en `capturing`/`canceling` | La acción no llegó a hacerse: el cobro vuelve a `authorized` |
| `CAPTURED` con el cobro en `refunding` | La devolución no llegó a hacerse: vuelve a `captured` |
| cualquier otro | Ya aplicado por el aplicador |

Un fallo con UN cobro (la pasarela no contesta: `PaymentGatewayUnavailableException`) no para la pasada: anótalo y
sigue con el siguiente; la marca re-estampada lo devolverá a la cola pasado el umbral.
