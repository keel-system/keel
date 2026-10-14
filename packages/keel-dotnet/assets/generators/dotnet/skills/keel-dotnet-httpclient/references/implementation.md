# Clientes HTTP — lo que se completa en el adaptador

Complementa «Lo que escribes» del SKILL.md. Todo esto vive en `Infrastructure/Clients`, salvo el barrido y la
compensación, que son handlers de `Application/UseCases`.

## La forma de una llamada

Build deja tres métodos por llamada con resiliencia, y cada uno tiene UN trabajo:

```csharp
public async Task<CancelStockResult> CancelStock(Guid orderId, CancellationToken cancellationToken = default)   // el del puerto
{
    try
    {
        return await OutboundResilience.Run(CancelStockPolicy, cancelStockCircuit, () => CancelStockOnce(orderId, cancellationToken), cancellationToken);
    }
    catch (ProviderFailureException failure) when (CancelStockFallback.Contains(failure.Kind))
    {
        // …el log del rechazo…
        return CancelStockUnavailable(orderId, failure);                    // la política del diseño
    }
}

private async Task<CancelStockResult> CancelStockOnce(Guid orderId, CancellationToken cancellationToken)   // UN intento: lo repite el retry
{
    var response = await http.Send(client, new OutboundRequest("DELETE", "/stock/reservations/{orderId}") { … }, cancellationToken);
    …
}
```

- **`<Llamada>Once`** es un intento: lo que pongas aquí se repite en cada reintento. La clave de idempotencia se
  calcula aquí y sale IGUAL en cada uno; no la saques fuera ni le metas nada aleatorio o del instante.
- **`OutboundResilience.Run`** aplica `<Llamada>Policy`, que es la de keel-core (`resiliencePolicy`) ya resuelta. No la
  edites a mano: la decide el diseño (`retry`, `circuitBreaker`) y es la misma que la de los otros dos servidores.
- **`<Llamada>Unavailable`** es la política del diseño. Solo la alcanzan los fallos del proveedor.
- **El transporte no reintenta por su cuenta.** `HttpExchange.DefaultHandler()` corta el reenvío que SocketsHttpHandler
  hace de una petición cuya conexión se cae; no lo cambies por un `HttpClient` propio ni por `IHttpClientFactory`.

## Rechazos con significado

`http.Send` lanza `ProviderStatusException` para todo status que no sea 2xx, con su `Status`, su `Kind`
(`ClientError`, `ServerError`, `UnknownStatus`) y su `Body`. Si el diseño le da significado a un rechazo, tradúcelo
en el intento, antes de que la excepción llegue al fallback:

```csharp
private async Task<GetPriceResult> GetPriceOnce(string sku, CancellationToken cancellationToken)
{
    OutboundResponse response;
    try
    {
        response = await http.Send(client, new OutboundRequest("GET", "/prices/{sku}") { PathParams = … }, cancellationToken);
    }
    catch (ProviderStatusException rejected) when (rejected.Status == 404)
    {
        // 404: el precio NO existe — un hecho del dominio, no una caída. Con el code exacto que declara use-cases.
        throw new PriceNotFoundError($"No hay precio para {sku}");
    }
    …
}
```

Una excepción de dominio no es un fallo del proveedor: el retry no la repite, el circuito la cuenta como éxito y el
fallback la deja pasar. Es lo que se quiere. **Nunca conviertas un 4xx en reintento**: el proveedor contestó, y
repetir la misma petición obtiene la misma respuesta.

## El contrato en prosa

Sin `request`/`response` estructurados, build deja `<Llamada>Response` sin campos y el mapper con un `TODO`:

- declara los campos de `<Llamada>Response` con los nombres y tipos del TERCERO, y léelos en `Read(JsonElement)` con
  `ResponseReading.Required<T>`, `Optional<T?>` o `List<T>` (`ResponseReading.cs`);
- declara los de `<Llamada>Result` (en `Domain/Clients`) con los del DOMINIO, y el mapeo campo a campo en el mapper;
- el DTO del cable refleja al tercero y el resultado al dominio; el mapper es el único puente.

Un cuerpo que no cumple el contrato es `OutboundContractException`: no es «el proveedor no está», no entra al
fallback ni cuenta para el circuito, y sale como 500 con su traza. No lo captures para devolver otra cosa.

## Un fallback `degrade`

Build deja `throw new NotImplementedException("TODO: fallback …")` con la prosa de `onFailure.degradedTo`. Escribe el
resultado degradado, y que se distinga de uno normal (un campo ausente, una marca): un dato plausible pero falso es
peor que fallar. No reintentes ni llames a otro proveedor desde aquí sin que el diseño lo diga.

## Reconciliación

El barrido de un `reconciledBy` es una operación por reloj, despachada SIN transacción abarcadora. El reclamo ya
está generado en el repositorio de la raíz que espera (`I<Raíz>Repository.ClaimFor<Barrido><Activación>`): devuelve
solo los candidatos que ESTA réplica se llevó, con una marca en `reconciliation_claim` que caduca. La nota del handler
dice el orden; el de un barrido que DESHACE el encargo (rendirse y avisar al proveedor) es este:

```csharp
foreach (var reservation in await reservationRepository.ClaimForReconcileReservationsReserveStock(cancellationToken))
{
    reservation.GiveUp(…);                                       // la transición, en el agregado
    try
    {
        await reservationRepository.Save(reservation, cancellationToken);
    }
    catch (ConflictException conflict) when (conflict.Code == "CONCURRENT_MODIFICATION")   // o el error que el diseño declara para ese conflicto
    {
        continue;                                                // ganó el camino feliz: es la carrera resuelta
    }
    await inventoryClient.CancelStock(reservation.OrderId, cancellationToken);   // fuera de toda transacción
}
```

- **No escribas otro reclamo** (un finder por estado, un lock, una marca propia): el gate `check-idempotency.sh` lo
  veta, y un segundo mecanismo en paralelo no reclama nada.
- **No te tragues los errores**: `catch (Exception)` o un `catch` sin tipo no distinguen la carrera de un bug propio,
  y el gate los veta. Captura la excepción CONCRETA de la carrera y deja pasar lo demás.
- Un fallo en un candidato no corta el lote.

## Compensación

La dispara una suscripción (`compensations.onEvent`). La nota del handler dice qué activación deshace y qué estado
devuelve; la guarda contra aplicarla dos veces es la TRANSICIÓN del agregado, que rechaza la segunda desde un estado
que ya no está en su `from`. El estado vuelve con el método semántico del agregado (que llama a `TransitionTo`): el
gate lo comprueba en el agregado, no en el handler.

## Lo que la frontera todavía rechaza

`dependencies.needs`, `auth: oauth2-client-credentials` y un value object compuesto en una llamada: llegan en un
incremento posterior de keel-dotnet. Si llega aquí un diseño con ellos, se generó con otra versión: repórtalo.
