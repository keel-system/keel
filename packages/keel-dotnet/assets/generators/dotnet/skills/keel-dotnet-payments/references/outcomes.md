# Los desenlaces

Un desenlace entra siempre como `GatewayOutcome` y lo aplica `PaymentOutcomeApplier`, que despacha por el
`ICommandDispatcher` la operación del diseño que le toca (`payments.outcomes`). Puede llegar por tres caminos —la
respuesta síncrona, el aviso, el barrido— y por más de uno a la vez.

## El handler de un desenlace es idempotente

```csharp
// src/<Raíz>.Application/UseCases/MarkCapturedCommandHandler.cs
public async Task Handle(MarkCapturedCommand command, CancellationToken cancellationToken)
{
    var payment = await paymentRepository.FindByChargeRequestId(command.ChargeRequestId, cancellationToken);
    if (payment is null || payment.Status != PaymentStatus.Capturing)
    {
        return; // otro camino ya lo aplicó, o llega tarde: no es un error
    }
    payment.MarkCaptured();
    await paymentRepository.Save(payment, cancellationToken);
}
```

Lo que NO es idempotente es aplicar dos desenlaces **distintos**: eso lo arbitra el bloqueo optimista, y el perdedor
relee.

## Lo que el aplicador deja como TODO

Si el diseño hace que un desenlace reciba un dato que la capa no nombra (un motivo de anulación propio, por ejemplo), el
aplicador lo deja como `Todo<Tipo>("<componente>")`, que compila y **lanza** si ese desenlace llega —a diferencia de un
null o de un `default`, no deja pasar un registro a medias—, y el diseño lo habrá aceptado por escrito
(`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED` en `specs/decisions.yaml`, con el motivo). Complétalo ahí, en
`src/<Raíz>.Application/Payment/PaymentOutcomeApplier.cs`, que es donde se conoce el desenlace: sustituye la llamada a
`Todo` por el valor que diga el diseño y borra el método si ya no se usa.

## Lo que el aplicador exige

Un componente obligatorio de la operación que la pasarela no dio (un `GatewayPaymentId` en un `Authorized`, por ejemplo)
hace que `Apply` lance con el nombre del componente: no se aplica nada a medias. Si lo ves en un escenario, el doble o el
adaptador devolvieron una forma incompleta; no lo tapes con un valor inventado.
