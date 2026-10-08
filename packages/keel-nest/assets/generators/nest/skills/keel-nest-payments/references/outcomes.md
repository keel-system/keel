# Los desenlaces

Un desenlace entra siempre como `GatewayOutcome` y lo aplica `PaymentOutcomeApplier`, que despacha por el
`CommandDispatcher` la operación del diseño que le toca (`payments.outcomes`). Puede llegar por tres caminos —la
respuesta síncrona, el aviso, el barrido— y por más de uno a la vez.

## El handler de un desenlace es idempotente

```ts
// src/application/usecases/mark-captured-command-handler.ts
async handle(command: MarkCapturedCommand): Promise<void> {
  const payment = await this.paymentRepository.findByChargeRequestId(command.chargeRequestId);
  if (payment == null || payment.status !== PaymentStatus.CAPTURING) {
    return; // otro camino ya lo aplicó, o llega tarde: no es un error
  }
  payment.markCaptured();
  await this.paymentRepository.save(payment);
}
```

Lo que NO es idempotente es aplicar dos desenlaces **distintos**: eso lo arbitra el bloqueo optimista, y el
perdedor relee.

## Lo que el aplicador deja como TODO

Si el diseño hace que un desenlace reciba un dato que la capa no nombra (un motivo de anulación propio, por
ejemplo), el aplicador lo deja como `todo<Tipo>('<componente>')`, que compila y **lanza** si ese desenlace llega
—a diferencia de un null, no deja pasar un registro a medias—, y el diseño lo habrá aceptado por escrito
(`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED` en `specs/decisions.yaml`, con el motivo). Complétalo ahí, en
`src/application/payment/payment-outcome-applier.ts`, que es donde se conoce el desenlace: sustituye la llamada a
`todo` por el valor que diga el diseño y borra la función si ya no se usa.

## Lo que el aplicador exige

Un componente obligatorio de la operación que la pasarela no dio (un `gatewayPaymentId` en un `AUTHORIZED`, por
ejemplo) hace que `apply` lance con el nombre del componente: no se aplica nada a medias. Si lo ves en un
escenario, el doble o el adaptador devolvieron una forma incompleta; no lo tapes con un valor inventado.
