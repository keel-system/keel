# Los desenlaces

Un desenlace entra siempre como `domain.GatewayOutcome` y lo aplica `application.PaymentOutcomeApplier`, que despacha
por los propios `UseCases` la operación del diseño que le toca (`payments.outcomes`). Puede llegar por tres caminos —la
respuesta síncrona, el aviso, el barrido— y por más de uno a la vez.

## El handler de un desenlace es idempotente

```go
func (h *MarkCapturedCommandHandler) Handle(ctx context.Context, cmd MarkCapturedCommand) error {
	payment, found, err := h.paymentRepository.FindByChargeRequestID(ctx, cmd.ChargeRequestID)
	if err != nil {
		return err
	}
	if !found || payment.Status() != domain.PaymentStatusCapturing {
		return nil // otro camino ya lo aplicó, o llega tarde: no es un error
	}
	if err := payment.MarkCaptured(); err != nil {
		return err
	}
	_, err = h.paymentRepository.Save(ctx, payment)
	return err
}
```

Lo que NO es idempotente es aplicar dos desenlaces **distintos**: eso lo arbitra el bloqueo optimista, y el perdedor
relee.

## Lo que la capa no nombra

Si el diseño hace que un desenlace reciba un dato que la capa no nombra (un motivo de anulación propio, por ejemplo), el
aplicador no lo inventa: llama a un método tuyo en `internal/application/payment_outcome_choices.go` —sin la cabecera de
código generado—, uno por componente (`markCanceledCancelReason`, por ejemplo). Build lo deja devolviendo
`ErrNotImplemented`, que **falla en voz alta** si ese desenlace llega —a diferencia de un valor cero, no deja pasar un
registro a medias—, y el diseño lo habrá aceptado por escrito (`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED` en
`specs/decisions.yaml`, con el motivo). Complétalo con lo que diga esa decisión o las reglas de la operación: el
aplicador lleva el repositorio del registro, así que puedes leer el estado del que viene el cobro.

## Lo que el aplicador exige

Un componente obligatorio de la operación que la pasarela no dio (un `GatewayPaymentID` en un `GatewayAuthorized`, por
ejemplo) hace que `Apply` devuelva un error con el nombre del componente: no se aplica nada a medias. Si lo ves en un
escenario, el doble o el adaptador devolvieron una forma incompleta; no lo tapes con un valor inventado.
