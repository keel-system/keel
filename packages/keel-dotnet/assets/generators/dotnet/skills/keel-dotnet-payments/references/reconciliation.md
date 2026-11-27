# El barrido de lo que espera desenlace

## Candidatos y reclamo: ya generados

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
`inFlight` de cada acción de seguimiento— cuyo `AwaitingSince` es anterior a `paymentReconciliation.StaleBefore(now)`
(el umbral es `payments.reconciliation.unanswered-after-seconds`, o el parámetro que enlaza
`payments.reconciliation.unansweredAfter`; el del diseño también en local y test: el arnés envejece la marca a mano), en un lote acotado
—`paymentReconciliation.BatchSize()`—, el que más lleva esperando primero.

No los busques tú: build generó el reclamo en el repositorio del registro (G11 de la corrida payment de prueba-gelsa):

```csharp
var claimed = await paymentRepository.ClaimForPaymentSweep(
    paymentReconciliation.StaleBefore(DateTimeOffset.UtcNow),
    paymentReconciliation.BatchSize(),
    cancellationToken);
foreach (var payment in claimed)
{
    // fuera de toda transacción: la llamada a la pasarela no puede ir dentro de ninguna
    await paymentReconciliation.Consult(payment.Reference, payment.GatewayPaymentId, cancellationToken);
}
```

Devuelve los cobros SIGUIENDO en su estado y con `AwaitingSince` renovado: una escritura condicional por cobro, en su
propia transacción y confirmada antes de volver, así que la réplica que llega tarde no lo ve. Con el cronómetro, ya
avisa del lote lleno (`SweepPass.Claimed`) y el tick repetirá la pasada. El barrido corre **sin transacción
abarcadora** (si hay una abierta, el reclamo se niega). Un segundo reclamo escrito a mano en paralelo al generado no
reclama nada, solo reparte peor.

## Qué hacer con lo que diga la pasarela

`paymentReconciliation.Consult(reference, gatewayPaymentId, cancellationToken)` consulta y aplica. Te devuelve el
estado para lo que no es un desenlace:

| Devuelve | Qué haces |
|---|---|
| `Pending` | Nada: se queda para la siguiente pasada |
| `NotFound` | Ya aplicado: fallido con `notReceived` |
| `Authorized` con el cobro en `capturing`/`canceling` | La acción no llegó a hacerse: el cobro vuelve a `authorized` |
| `Captured` con el cobro en `refunding` | La devolución no llegó a hacerse: vuelve a `captured` |
| cualquier otro | Ya aplicado por el aplicador |

Un fallo con UN cobro (la pasarela no contesta: `PaymentGatewayUnavailableException`) no para la pasada: anótalo y sigue
con el siguiente; la marca re-estampada lo devolverá a la cola pasado el umbral.
