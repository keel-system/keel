# Los flujos contra la pasarela de prueba

En el perfil `local`, `payments.gateway.base-url` apunta al WireMock de `infra/docker-compose.yaml`, y los flujos lo
programan con los helpers de `FlowTest` (los mismos nombres que los arneses de keel-spring y keel-nest; por debajo,
`tests/<Raíz>.IntegrationTests/Support/PaymentGateway.cs`). La API es **neutra**: no nombra la pasarela, y el mismo
flujo vale con cualquiera. El reset de cada flujo vacía el stub: lo que necesita un escenario se programa en su Given.

## Programar el desenlace de un cobro

```csharp
await GatewayAuthorizes("order-1");                      // el cobro de esa referencia queda autorizado
await GatewayCharges("order-2");                         // cobrado en el acto
await GatewayRequiresAction("order-3");                  // exige 3DS: ActionRequired con su acción
await GatewayDeclines("order-4", "insufficientFunds");   // rechazado, con un motivo del vocabulario neutro
await GatewayDoesNotAnswer(GatewayCall.Charge);          // corta la conexión: el cobro queda EN DUDA
```

Cada helper de cobro casa **solo** con la petición que lleva esa referencia: varios cobros conviven en el mismo flujo.
`GatewayIdFor(referencia)` es el id que la pasarela de prueba le asigna, determinista, para nombrarlo antes de pedir el
cobro.

## Lo que pasa después

- `GatewayReports(referencia, "CAPTURED" | "NOT_FOUND" | …)`: lo que contesta cuando se le pregunta (por id y por
  referencia) — lo que lee el aviso y el barrido.
- `GatewayCaptures`, `GatewayCancels`, `GatewayRefunds(referencia, "5.00")`: las acciones de seguimiento.
- `GatewayExpiresAuthorization(referencia)`: la autorización caducó antes de capturarse — la captura se rechaza y el cobro
  queda anulado. Ningún escenario puede esperar los días reales.
- `GatewayRejects(GatewayCall.Refund)`: la pasarela rechaza esa llamada (4xx). **Tras rechazar una captura, una
  anulación o una devolución, el servidor le pregunta el estado real del cobro** (el rechazo no lo dice; lo hacen los
  adaptadores de los tres generadores), así que el Given programa las dos cosas:

  ```csharp
  await GatewayRejects(GatewayCall.Capture);
  await GatewayReports("ch-022", "AUTHORIZED");   // sigue autorizado: el rechazo no movió nada
  ```

  Sin el `GatewayReports`, la consulta no encuentra el cobro (`NotFound`) y el handler no puede distinguir el rechazo
  de un cobro que la pasarela no conoce. **No lo arregles en el adaptador**: la pasarela real sí conoce el cobro, y el
  adaptador es el mismo servidor que el de keel-spring y keel-nest.
- `GatewaySavesPaymentMethod()`: guardar un medio de pago funciona.
- `GatewayCallCount(GatewayCall.Charge)` y `GatewayRequests(...)`: cuántas veces y qué se le mandó (la clave de
  idempotencia viaja en la cabecera de la pasarela: `StubRequestHeader(request, "<cabecera>")`).

## El aviso

```csharp
await GatewayReports("order-1", "CAPTURED");
var response = await SendGatewayNotice("order-1");          // firmado como lo firma la pasarela
Assert.Equal(200, response.Status);
Assert.Equal(401, (await SendForgedGatewayNotice("order-1")).Status); // firma alterada: no se consulta nada
```

## El barrido

El barrido lo dispara su cron, como en producción. Para que tome un cobro concreto sin esperar el umbral real:
`AgeForReconciliation("<barrido>", id)` deja rancia su `AwaitingSince` (el nombre es el de
`payments.reconciliation.sweep`), y después se espera con `Eventually` a que el estado cambie. No escribas un UPDATE a
mano para eso.

Para lo contrario —un cobro que acaba de entrar en vuelo y que el barrido NO tiene que tocar—,
`HoldFromReconciliation("<barrido>", id)` deja su `AwaitingSince` en el futuro. Con el umbral local en segundos y el cron
en minutos, sin él ese cobro también estaría rancio cuando llegue el ciclo:

```csharp
AgeForReconciliation("sweepPendingPayments", atascado);       // el que el barrido tiene que rescatar
HoldFromReconciliation("sweepPendingPayments", recienEnVuelo); // el que tiene que dejar en paz
await Eventually(async () => (await GatewayRequests(GatewayCall.Status)).Count >= 1, TimeSpan.FromMinutes(6));
```

## Lo que el arnés no programa solo

La pasarela de prueba **no tiene respuesta por defecto**: lo que un escenario no programa, el WireMock lo contesta con un
404, que el adaptador lee como un cobro `Failed` (o como `NotFound` si es una consulta). Cada Given programa la respuesta
de su referencia; «un token válido de la pasarela de prueba» en un escenario es `GatewayAuthorizes` (o `GatewayCharges`)
sobre esa referencia.
