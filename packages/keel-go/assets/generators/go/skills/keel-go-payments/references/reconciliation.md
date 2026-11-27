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
| `domain.GatewayCaptured` con el cobro devolviéndose | La devolución no llegó a hacerse: vuelve a `captured` (sin `refund.reference`; con ella, ver abajo) |
| cualquier otro | Ya aplicado por el aplicador |

Un fallo con UN cobro (la pasarela no contesta: `*domain.PaymentGatewayUnavailableError`) no para la pasada: anótalo en
el log y sigue con el siguiente; la marca re-estampada lo devolverá a la cola pasado el umbral.

## La devolución en vuelo (con `refund.reference`)

Con `partial-refund` un cobro admite varias devoluciones, y la consulta del cobro solo sabe el **acumulado** devuelto: leída
como el desenlace de la devolución en curso, registraría el acumulado como su importe y, si hubo otra devolución antes,
daría por hecha una que nunca llegó a la pasarela (corrida payment-spring). Por eso un candidato en el estado en vuelo de
la devolución NO se consulta con la llamada de arriba sino con

```go
outcome, err := h.paymentReconciliation.ConsultRefund(ctx, reference, refundReference, gatewayPaymentID, alreadyRefunded)
```

`refundReference` es la referencia de la devolución pendiente del cobro (el campo de `payments.refund.reference`) y
`alreadyRefunded` lo que el registro ya cuenta como devuelto, sin esa devolución (un `wire.Decimal`). Devuelve
`domain.GatewayRefunded` (ya aplicado, con el importe de ESA devolución), `domain.GatewayPending` (no hagas nada: sigue en
vuelo) o `domain.GatewayCaptured`: la devolución no llegó a la pasarela o la rechazó, y el cobro vuelve a `captured` con la
devolución en `failed`, como manda el diseño.
