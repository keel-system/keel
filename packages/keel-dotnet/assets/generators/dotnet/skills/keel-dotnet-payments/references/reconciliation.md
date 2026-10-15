# El barrido de lo que espera desenlace

## Candidatos

Los cobros en los estados que esperan a la pasarela —`pending`, `actionRequired` si hay acción del cliente, y el
`inFlight` de cada acción de seguimiento— cuyo `AwaitingSince` es anterior a `paymentReconciliation.StaleBefore()` (el
umbral es `payments.reconciliation.unanswered-after-seconds`; en local y test, unos segundos). Un lote acotado por
pasada —`paymentReconciliation.BatchSize()`, que lee `payments.reconciliation.batch-size`: no lo escribas como
constante—, el que más lleva esperando primero.

## El reclamo

El scheduler corre en todas las réplicas y despacha el barrido **sin transacción abarcadora**. Antes de consultar, cada
candidato se reclama con una escritura CONDICIONAL que vuelve a estampar `AwaitingSince`, en su propio ámbito y su propia
transacción; la réplica que pierde ve 0 filas y lo salta. Sin reclamo, las N réplicas consultan el mismo cobro, y si la
consulta desencadena una escritura, la hacen N veces.

Las dos mitades, en el puerto y en el adaptador del repositorio (la skill de la base explica cómo ampliarlos; el
adaptador ya tiene la forma en las guardas que emite build, `ClaimFor…`):

```csharp
// src/<Raíz>.Domain/Repository/IPaymentRepository.cs
/// <summary>Re-estampa AwaitingSince si sigue siendo <paramref name="seen"/>; true si este proceso se quedó el cobro.</summary>
Task<bool> ClaimForReconciliation(Guid id, DateTimeOffset seen, DateTimeOffset now, CancellationToken cancellationToken = default);
```

```csharp
// src/<Raíz>.Infrastructure/Persistence/Repositories/PaymentRepository.cs (relacional)
public async Task<bool> ClaimForReconciliation(Guid id, DateTimeOffset seen, DateTimeOffset now, CancellationToken cancellationToken = default)
{
    // En un ámbito y una transacción PROPIOS: el reclamo tiene que verse antes de la llamada a la pasarela.
    await using var scope = scopes.CreateAsyncScope();
    var own = scope.ServiceProvider.GetRequiredService<PaymentCheckoutDbContext>();
    var won = await scope.ServiceProvider.GetRequiredService<PersistenceTransactions>().InTransaction(
        () => own.Database.ExecuteSqlAsync($"UPDATE payments SET awaiting_since = {now} WHERE id = {id} AND awaiting_since = {seen}", cancellationToken),
        readOnly: false,
        cancellationToken);
    return won == 1;
}
```

Con persistencia documental, lo mismo con un `FindOneAndUpdate` sobre `{ _id, awaiting_since: seen }` **sin** la sesión
del caso de uso (la skill `keel-dotnet-mongodb`). Es la única escritura que va sin `Save`, a propósito: no cambia el
estado del agregado, solo arrienda el cobro.

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
