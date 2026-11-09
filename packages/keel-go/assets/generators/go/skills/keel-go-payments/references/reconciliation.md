# El barrido de lo que espera desenlace

## Candidatos

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
estado en vuelo de cada acción de seguimiento— cuyo `AwaitingSince` es anterior a
`h.paymentReconciliation.StaleBefore(time.Now())` (el umbral es `payments.reconciliation.unanswered-after-seconds`; en
local y test, unos segundos). Un lote acotado por pasada —`h.paymentReconciliation.BatchSize()`, que lee
`payments.reconciliation.batch-size`: no lo escribas como constante—, el que más lleva esperando primero.

## El reclamo

El barrido lo dispara el cronómetro en una réplica por tick, pero al menos una vez (si la réplica muere a mitad, otra
repite el tick), y su tarea lo despacha **sin transacción abarcadora** (`application.WithoutTransaction`). Si tu lote
sale lleno, avísalo con `application.SweepClaimed(ctx, reclamados, lote)` y el tick repetirá la pasada. Antes de consultar, cada candidato se reclama con una escritura CONDICIONAL que
vuelve a estampar `AwaitingSince`, y que confirma sola; la réplica que pierde ve 0 filas y lo salta. Sin reclamo, las N
réplicas consultan el mismo cobro, y si la consulta desencadena una escritura, la hacen N veces.

En keel-spring, keel-nest y keel-dotnet el agente añade las dos consultas al puerto y al adaptador del registro. Aquí
los dos llevan la cabecera de código generado, así que van en los dos `<raíz>_queries.go` del registro, sin ella (la
skill de la base explica ese sitio): la firma en la interfaz `domain.<Raíz>Queries`, que el puerto incrusta, y la
implementación en el paquete del motor. El reclamo es **la única escritura** que cabe ahí, a propósito: no cambia el
estado del agregado, solo arrienda el cobro, y por eso no va por `Save`.

```go
// internal/domain/payment_queries.go
type PaymentQueries interface {
	// FindAwaitingBefore son los cobros que esperan desenlace desde antes de staleBefore, el más antiguo primero.
	FindAwaitingBefore(ctx context.Context, staleBefore time.Time, limit int) ([]*Payment, error)
	// ClaimForReconciliation re-estampa AwaitingSince si sigue siendo seen; true si este proceso se quedó el cobro.
	ClaimForReconciliation(ctx context.Context, id uuid.UUID, seen, now time.Time) (bool, error)
}
```

```go
// internal/infrastructure/postgres/payment_queries.go (relacional; en MySQL, con ? en vez de $n)
func (r *PaymentRepository) FindAwaitingBefore(ctx context.Context, staleBefore time.Time, limit int) ([]*domain.Payment, error) {
	return r.load(ctx, "WHERE status IN ($1, $2, $3, $4, $5) AND awaiting_since < $6 ORDER BY awaiting_since LIMIT $7",
		paymentStatusColumn(domain.PaymentStatusPending), paymentStatusColumn(domain.PaymentStatusActionRequired),
		paymentStatusColumn(domain.PaymentStatusCapturing), paymentStatusColumn(domain.PaymentStatusCanceling),
		paymentStatusColumn(domain.PaymentStatusRefunding), staleBefore, limit)
}

func (r *PaymentRepository) ClaimForReconciliation(ctx context.Context, id uuid.UUID, seen, now time.Time) (bool, error) {
	var won bool
	// Sin transacción en el contexto (el barrido va sin ella), write abre una suya y la confirma: el reclamo se ve antes
	// de llamar a la pasarela.
	err := r.tx.write(ctx, func(q DBTX) error {
		result, err := q.ExecContext(ctx, "UPDATE payments SET awaiting_since = $1 WHERE id = $2 AND awaiting_since = $3", now, id, seen)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		won = affected == 1
		return err
	})
	return won, err
}
```

Las tablas, columnas y constantes son las del diseño: míralas en la migración y en `values.go` del paquete del motor.
Con persistencia documental, lo mismo con un `FindOneAndUpdate` sobre `{_id, <marca>: seen}` sin la sesión del caso de
uso (la skill `keel-go-mongodb`).

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
