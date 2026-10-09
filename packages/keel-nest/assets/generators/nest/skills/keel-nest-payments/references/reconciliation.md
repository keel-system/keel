# El barrido de lo que espera desenlace

## Candidatos

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
`inFlight` de cada acción de seguimiento— cuyo `awaitingSince` es anterior a
`this.paymentReconciliation.staleBefore()` (el umbral es `payments.reconciliation.unanswered-after-seconds`; en
local y test, 5 segundos). Un lote acotado por pasada —`this.paymentReconciliation.batchSize()`, que lee
`payments.reconciliation.batch-size`: no lo escribas como constante—, el que más lleva esperando primero.

## El reclamo

El scheduler corre en todas las réplicas y despacha el barrido **sin transacción abarcadora**. Antes de consultar,
cada candidato se reclama con una escritura CONDICIONAL que vuelve a estampar `awaitingSince`, con su propia
transacción; la réplica que pierde ve 0 filas y lo salta. Sin reclamo, las N réplicas consultan el mismo cobro, y si
la consulta desencadena una escritura, la hacen N veces.

Las dos mitades, en el puerto y en el adaptador del repositorio (la skill de la base explica cómo ampliarlos):

```ts
// src/domain/repository/payment-repository.ts
/** Re-estampa awaitingSince si sigue siendo `seen`; true si este proceso se quedó el cobro. */
abstract claimForReconciliation(id: string, seen: Date, now: Date): Promise<boolean>;
```

```ts
// src/infrastructure/persistence/repositories/payment-repository-impl.ts
async claimForReconciliation(id: string, seen: Date, now: Date): Promise<boolean> {
  const result = await this.transactions.inNewTransaction((manager) =>
    manager.createQueryBuilder().update(PaymentOrm).set({ awaitingSince: now }).where({ id, awaitingSince: seen }).execute()
  );
  return Boolean(result.affected);
}
```

Es la única escritura que va sin `save`, a propósito: no cambia el estado del agregado, solo arrienda el cobro.

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
