# Los flujos contra la pasarela de prueba

En el perfil `local`, `payments.gateway.base-url` apunta al WireMock de `infra/docker-compose.yaml`, y los flujos lo
programan con los helpers de `test/integration/support/flow.ts` (los mismos nombres que el arnés de keel-spring; por
debajo, `test/integration/support/payment-gateway.ts`). La API es **neutra**: no nombra la pasarela, y el mismo
flujo vale con cualquiera. El reset de cada flujo vacía el stub: lo que necesita un escenario se programa en su
Given.

## Programar el desenlace de un cobro

```ts
import { gatewayAuthorizes, gatewayDeclines, gatewayDoesNotAnswer, GatewayCall, gatewayIdFor, useFlow } from './support/flow.js';

await gatewayAuthorizes('order-1');                     // el cobro de esa referencia queda autorizado
await gatewayCharges('order-2');                        // cobrado en el acto
await gatewayRequiresAction('order-3');                 // exige 3DS: ACTION_REQUIRED con su acción
await gatewayDeclines('order-4', 'insufficientFunds');  // rechazado, con un motivo del vocabulario neutro
await gatewayDoesNotAnswer(GatewayCall.CHARGE);         // corta la conexión: el cobro queda EN DUDA
```

Cada helper de cobro casa **solo** con la petición que lleva esa referencia: varios cobros conviven en el mismo
flujo. `gatewayIdFor(referencia)` es el id que la pasarela de prueba le asigna, determinista, para nombrarlo antes
de pedir el cobro.

## Lo que pasa después

- `gatewayReports(referencia, 'CAPTURED' | 'NOT_FOUND' | …)`: lo que contesta cuando se le pregunta (por id y por
  referencia) — lo que lee el aviso y el barrido.
- `gatewayCaptures`, `gatewayCancels`, `gatewayRefunds(referencia, '5.00')`: las acciones de seguimiento.
- `gatewayExpiresAuthorization(referencia)`: la autorización caducó antes de capturarse — la captura se rechaza y
  el cobro queda anulado. Ningún escenario puede esperar los días reales.
- `gatewayRejects(GatewayCall.REFUND)`: la pasarela rechaza esa llamada (4xx).
- `gatewaySavesPaymentMethod()`: guardar un medio de pago funciona.
- `gatewayCallCount(GatewayCall.CHARGE)` y `gatewayRequests(...)`: cuántas veces y qué se le mandó (la clave de
  idempotencia viaja en la cabecera de la pasarela: `stubRequestHeader(request, '<cabecera>')`).

## El aviso

```ts
const flow = useFlow();
await gatewayReports('order-1', 'CAPTURED');
const response = await sendGatewayNotice(flow, 'order-1');        // firmado como lo firma la pasarela
expect(response.status).toBe(200);
expect((await sendForgedGatewayNotice(flow, 'order-1')).status).toBe(401); // firma alterada: no se consulta nada
```

## El barrido

El barrido lo dispara su cron, como en producción. Para que tome un cobro concreto sin esperar el umbral real:
`ageForReconciliation('<barrido>', id)` deja rancia su `awaitingSince` (el nombre es el de
`payments.reconciliation.sweep`), y después se espera con `eventually` a que el estado cambie. No escribas un
UPDATE a mano para eso.

Para lo contrario —un cobro que acaba de entrar en vuelo y que el barrido NO tiene que tocar—,
`holdFromReconciliation('<barrido>', id)` deja su `awaitingSince` en el futuro. Con el umbral local en segundos y el
cron en minutos, sin él ese cobro también estaría rancio cuando llegue el ciclo:

```ts
ageForReconciliation('sweepPendingPayments', atascado);      // el que el barrido tiene que rescatar
holdFromReconciliation('sweepPendingPayments', recienEnVuelo); // el que tiene que dejar en paz
await eventually(async () => (await gatewayRequests(GatewayCall.STATUS)).length >= 1, 6 * 60_000);
```

## Lo que el arnés no programa solo

La pasarela de prueba **no tiene respuesta por defecto**: lo que un escenario no programa, el WireMock lo contesta
con un 404, que el adaptador lee como un cobro `FAILED` (o como `NOT_FOUND` si es una consulta). Cada Given programa
la respuesta de su referencia; «un token válido de la pasarela de prueba» en un escenario es `gatewayAuthorizes`
(o `gatewayCharges`) sobre esa referencia.
