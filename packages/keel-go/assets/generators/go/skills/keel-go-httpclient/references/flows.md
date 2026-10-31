# Clientes HTTP — los flujos contra el proveedor de prueba

En el perfil `local` cada `base-url` apunta al WireMock de `infra/docker-compose.yaml`. Los flujos lo programan con los
métodos del escenario de `tests/integration/http_stub_test.go` (los mismos helpers que los arneses de keel-spring,
keel-nest y keel-dotnet) y nunca hablan con el proveedor real. El reset de cada flujo vacía el stub: lo que necesita un
escenario se programa en su Given o al principio del escenario.

## Programar lo que responde

```go
s.StubFor("DELETE", "/stock/reservations/.*", 200, map[string]any{"cancelled": true}) // respuesta normal
s.StubFailure("DELETE", "/stock/reservations/.*", 503)                                 // 5xx (o 4xx)
s.StubConnectionFault("DELETE", "/stock/reservations/.*")                              // corta la conexión
s.StubTimeout("DELETE", "/stock/reservations/.*", 5*time.Second)                       // tarda más que su timeoutMs
```

La ruta es una REGEX sobre el path, sin query. **Elige el fallo que el diseño distingue**: con
`retryOn: [timeout, connection]` un 503 NO se reintenta y un corte de conexión sí; un escenario de reintento con un 503
mediría otra cosa.

## Un reintento, con la misma clave

```go
s.StubSequence("DELETE", "/stock/reservations/.*", RespondConnectionFault(), RespondOK(200, map[string]any{"cancelled": true}))
// La acción que dispara la llamada, y después:
requests := s.StubRequests("DELETE", "/stock/reservations/.*")
if len(requests) != 2 || requests[0].Header("Idempotency-Key") != requests[1].Header("Idempotency-Key") {
	s.Errorf("quiero dos intentos con la misma clave: %v", requests)
}
```

La última respuesta de una secuencia se queda pegada, y una ruta admite UNA secuencia por flujo. Las respuestas son
`RespondOK`, `RespondFailure`, `RespondTimeout` y `RespondConnectionFault`.

## Lo que se le mandó

`s.StubCallCount(método, ruta)` dice cuántas veces se llamó (que una activación con `onFailure: ignore` no se reintentó,
por ejemplo); `s.StubRequests(...)` devuelve las peticiones (`StubRequest`), y `request.JSON()` y
`request.Header(nombre)` leen su cuerpo y sus cabeceras sin conocer el formato del stub.

## El circuito

El servidor arranca con el circuito cerrado y su ventana vacía, y los flujos lo comparten: lo que falló en un flujo
cuenta para el siguiente. Un flujo que cuente fallos del circuito llama a `s.RestartServer()` en el Given de su
`StartFlow`: reinicia el servidor y la ventana vuelve a estar vacía de verdad. No lo «cierres» con llamadas buenas: la
ventana queda llena de éxitos y el circuito tarda más de lo que dice el diseño en abrir (corrida catalog de keel-dotnet).
Para abrirlo hacen falta tantas llamadas fallidas como `slidingWindowSize` (con una tasa de fallo >=
`failureRateThreshold`), y un 4xx NO cuenta: es un éxito para el circuito. Con el circuito abierto la llamada ni sale
(`StubCallCount` no sube) y el resultado es el del fallback del diseño.

## Un barrido de reconciliación

El barrido lo dispara su cron, como en producción. Para que tome un encargo concreto sin esperar el plazo real:

```go
s.AgeForReconciliation("reserveStock", reservationID) // la marca de espera, infinitamente rancia
s.Eventually(func() bool {
	body, err := s.Get(RouteBase + "/reservations/" + reservationID).JSON()
	object, _ := body.(map[string]any)
	return err == nil && object["status"] == "released"
}, 90*time.Second, "el barrido no liberó la reserva")
```

Deja margen para un tick del cron. Bajar el umbral por configuración sería global y se llevaría las filas de los demás
escenarios.

Su inverso, `s.HoldFromReconciliation(activación, id)`, deja la marca en el FUTURO: el barrido NO toma esa fila aunque
pasen sus ciclos. Es lo que hace determinista un escenario de «lo que acaba de entrar en espera no se toca».

## Dos réplicas

Los escenarios de clúster (`FL-CLU-*`) arrancan una segunda instancia con `s.StartReplica()` y la paran con
`defer s.StopReplica()`. `s.OnReplica(...)` manda una petición a la segunda; para dos peticiones a la vez, una a cada
instancia, `s.ExchangeAll` con `OnReplica: true` en una de ellas.
