# Los desenlaces

Un desenlace entra siempre como `GatewayOutcome` y lo aplica `PaymentOutcomeApplier`, que despacha
la operación del diseño que le toca (`payments.outcomes`). Puede llegar por tres caminos —la
respuesta síncrona, el aviso, el barrido— y por más de uno a la vez.

## El handler de un desenlace es idempotente

```java
// MarkCapturedCommandHandler
Payment payment = repository.findByChargeRequestId(command.chargeRequestId()).orElse(null);
if (payment == null || payment.getStatus() != PaymentStatus.CAPTURING) {
    return; // otro camino ya lo aplicó, o llega tarde: no es un error
}
payment.markCaptured();
```

Lo que NO es idempotente es aplicar dos desenlaces **distintos**: eso lo arbitra el bloqueo
optimista, y el perdedor relee.

## Lo que el aplicador deja como TODO

Si el diseño hace que un desenlace reciba un dato que la capa no nombra (un motivo de anulación
propio, por ejemplo), el aplicador lo deja como `null /* TODO(keel) */` y el diseño lo habrá
aceptado por escrito (`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED` en `specs/decisions.yaml`, con el
motivo). Complétalo ahí, en el aplicador, que es donde se conoce el estado del que viene el cobro.
