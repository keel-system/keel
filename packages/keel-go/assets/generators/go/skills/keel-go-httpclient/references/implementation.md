# Clientes HTTP — lo que se completa en el adaptador y en los handlers

Complementa «Lo que escribes» del SKILL.md. Lo del adaptador vive en `internal/infrastructure/clients`; el barrido y la
compensación son handlers de `internal/application`.

## La forma de una llamada

Build deja por llamada tres piezas, y cada una tiene UN trabajo:

```go
// CancelStock es la del puerto: la política del diseño alrededor de UN intento.
func (a *InventoryHTTPAdapter) CancelStock(ctx context.Context, orderID uuid.UUID) (domain.CancelStockResult, error) {
	result, err := Run(ctx, inventoryCancelStockPolicy, a.cancelStockCircuit, a.wait, func(ctx context.Context) (domain.CancelStockResult, error) {
		return a.cancelStockOnce(ctx, orderID)
	})
	if failure, ok := AsProviderFailure(err); ok && slices.Contains(inventoryCancelStockFallback, failure.Kind) {
		return a.cancelStockUnavailable(ctx, orderID, failure)
	}
	return result, err
}
```

- **`<llamada>Once`** es un intento: lo que pongas aquí se repite en cada reintento. La clave de idempotencia se calcula
  aquí (`outboundKey`) y sale IGUAL en cada uno; no la saques fuera ni le metas nada aleatorio o del instante.
- **`Run`** aplica `<cliente><Llamada>Policy`, la de keel-core (`resiliencePolicy`) ya resuelta. No la edites a mano: la
  decide el diseño (`retry`, `circuitBreaker`) y es la misma que la de los otros tres servidores.
- **`<llamada>Unavailable`** (en `<cliente>_fallback.go`) es la política del diseño. Solo la alcanzan los fallos del
  proveedor que lista `<cliente><Llamada>Fallback`.
- **El transporte no reintenta por su cuenta.** `NewExchange(nil)` usa `DefaultTransport()`, sin keep-alive; no lo
  cambies por `http.DefaultClient` ni por un transporte propio.

## Rechazos con significado

`Exchange.Send` devuelve un `*ProviderFailure` para todo status que no sea 2xx, con su `Status`, su `Kind` y su `Body`.
Si el diseño le da significado a un rechazo, tradúcelo en el intento, antes de que llegue al fallback:

```go
func (a *PricingHTTPAdapter) getPriceOnce(ctx context.Context, sku string) (domain.GetPriceResult, error) {
	response, err := a.exchange.Send(ctx, a.client, Request{Method: "GET", Path: "/prices/{sku}", PathParams: map[string]string{"sku": sku}})
	if failure, ok := AsProviderFailure(err); ok && failure.Status == http.StatusNotFound {
		// 404: el precio NO existe — un hecho del dominio, no una caída. Con el centinela exacto que declara use-cases.
		return domain.GetPriceResult{}, domain.Errorf(domain.ErrPriceNotFound, "no hay precio para %s", sku)
	}
	if err != nil {
		return domain.GetPriceResult{}, err
	}
	read, err := readPricingGetPriceResponse(response.Body)
	if err != nil {
		return domain.GetPriceResult{}, err
	}
	return toPricingGetPriceResult(read), nil
}
```

Un `*domain.Error` no es un fallo del proveedor: el retry no lo repite, el circuito lo cuenta como éxito y el fallback lo
deja pasar. Es lo que se quiere. **Nunca conviertas un 4xx en reintento**: el proveedor contestó, y repetir la misma
petición obtiene la misma respuesta.

Un cuerpo que no cumple el contrato es un `*ContractError`: no es «el proveedor no está», no entra al fallback ni cuenta
para el circuito, y sale como un 500 con su causa. No lo atrapes para devolver otra cosa.

## Un fallback `degrade`

Build deja en `<cliente>_fallback.go` un `TODO (agente)` con la prosa de `onFailure.degradedTo`. Escribe el resultado
degradado, y que se distinga de uno normal (un campo `nil`, una marca): un dato plausible pero falso es peor que fallar.
No reintentes ni llames a otro proveedor desde aquí sin que el diseño lo diga. Ese archivo no lleva la cabecera de
código generado: build no lo pisa.

## Reconciliación

El barrido de un `reconciledBy` es una operación por reloj, despachada SIN transacción abarcadora
(`application.WithoutTransaction`): cada llamada al repositorio confirma la suya. El reclamo ya está generado en el
repositorio de la raíz que espera (`ClaimFor<Barrido><Activación>` en `internal/domain/<raíz>_repository.go`): devuelve
solo los candidatos que ESTA réplica se llevó, con una marca en `reconciliation_claim` que caduca. La nota del handler
dice el orden; el de un barrido que DESHACE el encargo (rendirse y avisar al proveedor) es este:

```go
func (h *ReconcileReservationsCommandHandler) Handle(ctx context.Context, cmd ReconcileReservationsCommand) error {
	claimed, err := h.reservationRepository.ClaimForReconcileReservationsReserveStock(ctx)
	if err != nil {
		return err
	}
	for _, reservation := range claimed {
		// La transición, en el agregado.
		if err := reservation.GiveUp("sin respuesta del almacén"); err != nil {
			return err
		}
		if err := h.reservationRepository.Save(ctx, reservation); err != nil {
			if errors.Is(err, domain.ErrConcurrentModification) || errors.Is(err, domain.ErrInvalidStateTransition) {
				// Ganó el camino feliz: es la carrera resuelta.
				continue
			}
			return err
		}
		// Fuera de toda transacción.
		if _, err := h.inventoryClient.CancelStock(ctx, reservation.OrderID()); err != nil {
			return err
		}
	}
	return nil
}
```

- **No escribas otro reclamo** (un finder por estado, un lock, una marca propia): el gate `check-idempotency.sh` lo veta,
  y un segundo mecanismo en paralelo no reclama nada.
- **No te tragues los errores**: un `_ =` sobre una llamada de `h.` o un `if err != nil { continue }` sin mirar cuál es
  no distinguen la carrera de un bug propio, y el gate los veta. Reconoce la carrera con `errors.Is` sobre su centinela
  y devuelve lo demás.
- Si un candidato no debe cortar el lote, lo dice la nota del handler: entonces regístralo con el logger y sigue, pero
  nunca en silencio.

## Compensación

La dispara una suscripción (`compensations.onEvent`). La nota del handler dice qué activación deshace y qué estado
devuelve; la guarda contra aplicarla dos veces es la TRANSICIÓN del agregado, que rechaza la segunda desde un estado que
ya no está en su `from` (`ErrInvalidStateTransition`). El estado vuelve con el método semántico del agregado (que llama a
`transitionTo`): el gate lo comprueba en el agregado, no en el handler.

## Lo que la frontera todavía rechaza

`dependencies.needs`, `auth: oauth2-client-credentials` y un value object compuesto en una llamada: llegan en un
incremento posterior de keel-go. Si llega aquí un diseño con ellos, se generó con otra versión: repórtalo.
