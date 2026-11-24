# El barrido de lo que espera desenlace

## Candidatos y reclamo: ya generados

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
`inFlight` de cada acción de seguimiento— cuyo `AwaitingSince` es anterior a `h.paymentReconciliation.StaleBefore(now)`
(el umbral es `payments.reconciliation.unanswered-after-seconds`, o el parámetro que enlaza
`payments.reconciliation.unansweredAfter`), en un lote acotado —`h.paymentReconciliation.BatchSize()`—, el que más lleva
esperando primero.

No los busques tú: build generó el reclamo en el repositorio del registro (G11 de la corrida payment de prueba-gelsa):

```go
claimed, err := h.paymentRepository.ClaimForPaymentSweep(ctx, h.paymentReconciliation.StaleBefore(time.Now()), h.paymentReconciliation.BatchSize())
if err != nil {
	return err
}
for _, payment := range claimed {
	// fuera de toda transacción: la llamada a la pasarela no puede ir dentro de ninguna
	if _, err := h.paymentReconciliation.Consult(ctx, payment.Reference(), payment.GatewayPaymentID()); err != nil {
		// …
	}
}
```

Devuelve los cobros SIGUIENDO en su estado y con `AwaitingSince` renovado: una escritura condicional por cobro, en su
propia transacción y confirmada antes de volver, así que la réplica que llega tarde no lo ve. Con el cronómetro, ya avisa
del lote lleno (`application.SweepClaimed`) y el tick repetirá la pasada. El barrido corre **sin transacción abarcadora**
(con una abierta, el reclamo devuelve un error). Un segundo reclamo escrito a mano en los `<raíz>_queries.go`, en paralelo
al generado, no reclama nada, solo reparte peor.

## Qué hacer con lo que diga la pasarela

`h.paymentReconciliation.Consult(ctx, reference, gatewayPaymentID)` consulta y aplica. Te devuelve el estado para lo que
no es un desenlace:

| Devuelve | Qué haces |
|---|---|
| `domain.GatewayPending` | Nada: se queda para la siguiente pasada |
| `domain.GatewayNotFound` | Ya aplicado: fallido con `notReceived` |
| `domain.GatewayAuthorized` con el cobro capturándose o anulándose | La acción no llegó a hacerse: el cobro vuelve a `authorized` |
| `domain.GatewayCaptured` con el cobro devolviéndose | La devolución no llegó a hacerse: vuelve a `captured` |
| cualquier otro | Ya aplicado por el aplicador |

Un fallo con UN cobro (la pasarela no contesta: `*domain.PaymentGatewayUnavailableError`) no para la pasada: anótalo en
el log y sigue con el siguiente; la marca re-estampada lo devolverá a la cola pasado el umbral.
