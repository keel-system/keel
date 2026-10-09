# HTTP clients — los flujos contra el proveedor de prueba

En el perfil `local` cada `base-url` apunta al WireMock de `infra/docker-compose.yaml`. Los flujos lo programan
con los helpers de `test/integration/support/flow.ts` (los mismos que el arnés de keel-spring) y nunca hablan con
el proveedor real. El reset de cada flujo vacía el stub: lo que necesita un escenario se programa en su Given.

## Programar lo que responde

```ts
import { StubResponse, stubConnectionFault, stubFor, stubRequests, stubRequestHeader, stubSequence, useFlow } from './support/flow.js';

await stubFor('DELETE', '/stock/reservations/.*', 200, { cancelled: true });     // respuesta normal
await stubFailure('DELETE', '/stock/reservations/.*', 503);                        // 5xx (o 4xx)
await stubConnectionFault('DELETE', '/stock/reservations/.*');                     // corta la conexión
await stubTimeout('DELETE', '/stock/reservations/.*', 5_000);                      // tarda más que su timeoutMs
```

La ruta es una REGEX sobre el path, sin query. **Elige el fallo que el diseño distingue**: con
`retryOn: [timeout, connection]` un 503 NO se reintenta y un corte de conexión sí; un escenario de reintento con un
503 mediría otra cosa.

## Un reintento, con la misma clave

```ts
await stubSequence('DELETE', '/stock/reservations/.*', StubResponse.connectionFault(), StubResponse.ok(200, { cancelled: true }));
// …la acción que dispara la llamada…
const requests = await stubRequests('DELETE', '/stock/reservations/.*');
expect(requests).toHaveLength(2);
expect(stubRequestHeader(requests[0]!, 'Idempotency-Key')).toBe(stubRequestHeader(requests[1]!, 'Idempotency-Key'));
```

La última respuesta de una secuencia se queda pegada, y una ruta admite UNA secuencia por flujo.

## Lo que se le mandó

`stubCallCount(método, ruta)` dice cuántas veces se llamó (que una activación con `onFailure: ignore` no se
reintentó, por ejemplo); `stubRequests(...)` devuelve las peticiones, y `stubRequestBody(request)` y
`stubRequestHeader(request, nombre)` leen su cuerpo y sus cabeceras sin conocer el formato del stub.

## El circuito

El servidor de cada flujo arranca con el circuito cerrado y su ventana vacía, y los escenarios del mismo flujo lo
comparten. Para abrirlo hacen falta tantas llamadas fallidas como `slidingWindowSize` (con una tasa de fallo >=
`failureRateThreshold`), y un 4xx NO cuenta: es un éxito para el circuito. Con el circuito abierto la llamada ni
sale (`stubCallCount` no sube) y el resultado es el del fallback del diseño.

## Un barrido de reconciliación

El barrido lo dispara su cron, como en producción. Para que tome un encargo concreto sin esperar el plazo real:

```ts
ageForReconciliation('reserveStock', reservationId);   // la marca de espera, infinitamente rancia
await eventually(async () => (await flow.get(`${ROUTE_BASE}/reservations/${reservationId}`)).json().status === 'released', 90_000);
```

Deja margen para un tick del cron. Bajar el umbral por configuración sería global y se llevaría las filas de los
demás escenarios.

Su inverso, `holdFromReconciliation(activación, id)`, deja la marca en el FUTURO: el barrido NO toma esa fila aunque
pasen sus ciclos. Es lo que hace determinista un escenario de «lo que acaba de entrar en espera no se toca»: con el
umbral de prueba en segundos y el cron en minutos, sin él esa fila también estaría rancia cuando llegue el ciclo.
