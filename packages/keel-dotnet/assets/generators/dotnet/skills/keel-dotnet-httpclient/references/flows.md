# Clientes HTTP — los flujos contra el proveedor de prueba

En el perfil `local` cada `base-url` apunta al WireMock de `infra/docker-compose.yaml`. Los flujos lo programan con
los helpers de `FlowTest` (`tests/<Raíz>.IntegrationTests/Support/HttpStub.cs`, los mismos que los arneses de
keel-spring y keel-nest) y nunca hablan con el proveedor real. El reset de cada flujo vacía el stub: lo que necesita
un escenario se programa en su Given.

## Programar lo que responde

```csharp
await StubFor("DELETE", "/stock/reservations/.*", 200, new { cancelled = true });    // respuesta normal
await StubFailure("DELETE", "/stock/reservations/.*", 503);                           // 5xx (o 4xx)
await StubConnectionFault("DELETE", "/stock/reservations/.*");                        // corta la conexión
await StubTimeout("DELETE", "/stock/reservations/.*", 5000);                          // tarda más que su timeoutMs
```

La ruta es una REGEX sobre el path, sin query. **Elige el fallo que el diseño distingue**: con
`retryOn: [timeout, connection]` un 503 NO se reintenta y un corte de conexión sí; un escenario de reintento con un
503 mediría otra cosa.

## Un reintento, con la misma clave

```csharp
await StubSequence("DELETE", "/stock/reservations/.*", StubResponse.ConnectionFault(), StubResponse.Ok(200, new { cancelled = true }));
// …la acción que dispara la llamada…
var requests = await StubRequests("DELETE", "/stock/reservations/.*");
Assert.Equal(2, requests.Count);
Assert.Equal(StubRequestHeader(requests[0], "Idempotency-Key"), StubRequestHeader(requests[1], "Idempotency-Key"));
```

La última respuesta de una secuencia se queda pegada, y una ruta admite UNA secuencia por flujo.

## Lo que se le mandó

`StubCallCount(método, ruta)` dice cuántas veces se llamó (que una activación con `onFailure: ignore` no se reintentó,
por ejemplo); `StubRequests(...)` devuelve las peticiones, y `StubRequestBody(request)` y
`StubRequestHeader(request, nombre)` leen su cuerpo y sus cabeceras sin conocer el formato del stub.

## El circuito

El servidor arranca con el circuito cerrado y su ventana vacía, y los escenarios lo comparten. Para abrirlo hacen
falta tantas llamadas fallidas como `slidingWindowSize` (con una tasa de fallo >= `failureRateThreshold`), y un 4xx
NO cuenta: es un éxito para el circuito. Con el circuito abierto la llamada ni sale (`StubCallCount` no sube) y el
resultado es el del fallback del diseño.

## Un barrido de reconciliación

El barrido lo dispara su cron, como en producción. Para que tome un encargo concreto sin esperar el plazo real:

```csharp
AgeForReconciliation("reserveStock", reservationId);   // la marca de espera, infinitamente rancia
await Eventually(async () => (await Get($"{RouteBase}/reservations/{reservationId}")).Json().GetProperty("status").GetString() == "released", TimeSpan.FromSeconds(90));
```

Deja margen para un tick del cron. Bajar el umbral por configuración sería global y se llevaría las filas de los demás
escenarios.

Su inverso, `HoldFromReconciliation(activación, id)`, deja la marca en el FUTURO: el barrido NO toma esa fila aunque
pasen sus ciclos. Es lo que hace determinista un escenario de «lo que acaba de entrar en espera no se toca».
