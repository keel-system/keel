# payment-checkout — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/payment-checkout v1.0.0. Contrato de validación para la fase de generación.

> **Un único diseño, cualquier pasarela.** Estos escenarios no nombran ninguna pasarela y tienen
> que pasar igual con todas las del menú de build. Hablan de la **pasarela de prueba**: el doble
> que el generador levanta para la pasarela elegida, que habla su protocolo real y al que el arnés
> le dice qué contestar. Si un escenario necesitara saber cuál es, el hueco sería del diseño.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos (`2026-01-15T10:30:00.000Z`).
  `requestedAt`, `awaitingSince` y el `occurredAt` de los eventos se verifican **por forma**, nunca
  por valor.
- **Identificadores**: `uuid` v4 canónico, verificados por forma y por reutilización simbólica
  dentro del flujo (`<m1>`…): el id que devuelve un escenario es el que usa el siguiente. Los
  `chargeRequestId` los elige el escenario (`ch-001`…), igual que los elige pedidos, y se comparan
  **exactos**: `CH-001` y `ch-001` son referencias distintas.
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo**, en las respuestas y en los
  payloads de evento; nunca se omite (`conventions.nulls: include`). `gatewayPaymentId` es nulo
  mientras la pasarela no ha contestado; `failureReason`, mientras el cobro no ha fallado;
  `cancelReason`, mientras no se ha anulado; `refundedAmount`, mientras no hay devolución;
  `savedPaymentMethodId`, si se cobró con token; y `customerAction`, fuera de `actionRequired`.
- **Importes**: decimales con dos cifras, en la moneda del servicio (`BRL` en las pruebas,
  `service.parameters.currency`). Se comparan **por valor**: `10.5` y `10.50` son el mismo importe.
  Un importe con más de dos decimales se **rechaza** (`scalePolicy: reject`), no se redondea.
- **La acción del cliente**: `customerAction` es **opaca** — su contenido lo define la pasarela y
  lo consume su componente en el navegador. Los escenarios solo afirman si está (no nula) o no.
- **Motivos**: `failureReason` y `cancelReason` son enums; los escenarios afirman el valor exacto.
- **Forma del cuerpo de error**: la del generador, `{timestamp, status, error, code, message,
  details}` más `correlationId`. Los escenarios fijan solo el `code` y el status HTTP.
- **Identidad**: todas las peticiones llevan la credencial de `orders-service`, con sus tres scopes,
  salvo que el `Given` diga otra cosa. El `payerId` de prueba es `cli-1`, y `cli-2` es otro pagador.
- **Canales**: `paymentEvents` es por donde salen los desenlaces; `chargeRequests`, por donde
  pedidos pide cobros con la envoltura Keel.
- **La pasarela de prueba**: autoriza, captura, anula y devuelve por defecto, y contesta en el acto.
  El arnés puede pedirle, antes del `When`, que **rechace** la siguiente operación (con un motivo),
  que **exija autenticación**, que **no conteste** (registrando o no lo que recibió), o que **avise**
  de un desenlace de un cobro que ya conoce. Un aviso de la pasarela va firmado como lo firma ella;
  el servidor nunca toma el desenlace de su contenido: se lo pregunta.
- **El barrido**: `sweepPendingPayments` corre cada 5 minutos. Los escenarios que dependen de él
  esperan **dos ciclos** (11 minutos) después de superar el umbral de `unansweredAfterSeconds`.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| savePaymentMethod | FL-MTH-001, FL-MTH-001-B | **servidores (M2M)** |
| requestCharge | FL-CHG-001, FL-CHG-001-B, FL-CHG-002, FL-CHG-003, FL-CHG-004, FL-EVT-001, **FL-EVT-001-B**, FL-EVT-002, FL-EVT-003 | **servidores (M2M)** y suscripción |
| getPayment | FL-CHG-001, FL-CHG-002, FL-CHG-004, FL-REC-001 | **servidores (M2M)** |
| capturePayment | FL-STL-001, FL-STL-001-B | **servidores (M2M)** |
| cancelPayment | FL-STL-002, FL-STL-002-B | **servidores (M2M)** |
| refundPayment | FL-STL-003, FL-STL-003-B | **servidores (M2M)** |
| markAuthorized | FL-CHG-001, FL-CHG-002 | interna; desenlace de la pasarela |
| markActionRequired | FL-CHG-002, FL-EVT-002 | interna; desenlace de la pasarela |
| markCaptured | FL-STL-001, FL-REC-002 | interna; desenlace de la pasarela |
| markFailed | FL-CHG-001-B, FL-EVT-001 | interna; desenlace de la pasarela |
| markRefunded | FL-STL-003 | interna; desenlace de la pasarela |
| markCanceled | FL-STL-002, FL-STL-001-B, FL-STL-004 | interna; desenlace de la pasarela |
| sweepPendingPayments | FL-REC-001, FL-REC-002, **FL-REC-002-B**, **FL-CLU-001** | programada; efecto observable en el cobro |
| **outbox (canal indisponible y relay rendido)** | **FL-OBX-001**, **FL-OBX-002** | los desenlaces |

La misma matriz leída por **mecanismo**:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Guarda del doble cargo (`naturalKey` sobre `chargeRequestId`) | FL-CHG-001 | **FL-CHG-003** (la misma referencia otra vez) · **FL-EVT-001-B** (reentrega) |
| Cobro por evento (off-session) | FL-EVT-001 | FL-EVT-002 (exige autenticación) · FL-EVT-003 (rechazo de negocio) |
| Estados en vuelo de las acciones | FL-STL-001 | FL-STL-004-B (dos acciones a la vez) · **FL-REC-002** (respuesta perdida) |
| El aviso de la pasarela | FL-STL-004 | FL-STL-004 (aviso con la firma alterada) |
| Reconciliación | FL-REC-001 | **FL-REC-002-B** (no tocar lo recién en vuelo) · **FL-CLU-001** (dos réplicas) |
| Outbox | FL-CHG-001 (el evento sale) | **FL-OBX-001** (canal indisponible) · **FL-OBX-002** (el relay se rinde) |
| Propiedad del medio guardado | FL-EVT-001 | FL-CHG-004 (medio de otro pagador) |

## Medios de pago

### FL-MTH-001: se guarda un medio de pago

**Given**: un token válido de la pasarela de prueba para `cli-1`.

**When**: `savePaymentMethod` con `{payerId: "cli-1", paymentToken: <token>}`.

**Then**:
1. Status `201` con exactamente `{id: <m1>, payerId: "cli-1"}`: `gatewayReference` **no** aparece.

#### FL-MTH-001-B: lo que no se puede guardar

**Given**: la pasarela de prueba configurada para rechazar el medio, y después para no contestar.

**When**: `savePaymentMethod` con un token en cada caso.

**Then**:
1. Con el rechazo, status `422` con `PAYMENT_METHOD_REJECTED`.
2. Sin respuesta, status `503` con `GATEWAY_UNAVAILABLE`.

## Cobros por HTTP

### FL-CHG-001: un cobro con el cliente presente se autoriza

**Given**: un token válido de la pasarela de prueba.

**When**: `requestCharge` con `{chargeRequestId: "ch-001", orderId: "ped-1", payerId: "cli-1",
amount: 25.90, paymentToken: <token>}`.

**Then**:
1. Status `201` con `status: "authorized"`, `amount: 25.90`, `gatewayPaymentId` no nulo,
   `savedPaymentMethodId: null`, `failureReason: null` y `customerAction: null`.
2. `getPayment` sobre `ch-001` responde lo mismo.
3. `paymentEvents` recibe **exactamente un** `PaymentAuthorized` con `{chargeRequestId: "ch-001",
   orderId: "ped-1", amount: 25.90, occurredAt}`.

**Notas de determinación**: el cobro nace en `pending` y la respuesta llega ya con el desenlace
porque la pasarela de prueba contesta en el acto; FL-REC-001 es el caso en que no.

#### FL-CHG-001-B: la pasarela rechaza el cobro

**Given**: la pasarela de prueba configurada para rechazar el siguiente cobro por fondos insuficientes.

**When**: `requestCharge` con `chargeRequestId: "ch-002"` y un token.

**Then**:
1. Status `201` con `status: "failed"` y `failureReason: "insufficientFunds"`: el rechazo no es un
   error de la petición, es el desenlace del cobro.
2. `paymentEvents` recibe **exactamente un** `PaymentFailed` para `ch-002`, con
   `failureReason: "insufficientFunds"`.

### FL-CHG-002: la pasarela pide autenticar al cliente

**Given**: la pasarela de prueba configurada para exigir autenticación en el siguiente cobro.

**When**: `requestCharge` con `chargeRequestId: "ch-003"` y un token.

**Then**:
1. Status `201` con `status: "actionRequired"` y `customerAction` no nula.
2. `getPayment` sobre `ch-003` responde lo mismo, con la misma `customerAction`.
3. `paymentEvents` recibe **exactamente un** `PaymentActionRequired` para `ch-003`, con
   `customerAction` no nula.

**When**: la pasarela de prueba avisa de que el cliente se autenticó y el cobro quedó autorizado.

**Then**:
4. En ≤ 10 s `getPayment` sobre `ch-003` responde `status: "authorized"` y `customerAction: null`.
5. `paymentEvents` recibe **exactamente un** `PaymentAuthorized` para `ch-003`.

### FL-CHG-003: la misma referencia de cobro otra vez

**Given**: el cobro `ch-001` de FL-CHG-001, ya autorizado.

**When**: `requestCharge` con `chargeRequestId: "ch-001"` y otro token.

**Then**:
1. Status `409` con `CHARGE_ALREADY_REQUESTED`.
2. La pasarela de prueba no ha recibido un segundo cobro: hay **uno** para `ch-001`.

### FL-CHG-004: las peticiones de cobro que se rechazan

**Given**: un medio guardado `<m1>` de `cli-1` (FL-MTH-001).

**When**: `requestCharge` en cada uno de estos casos, cada uno con su propio `chargeRequestId`
(`ch-005` … `ch-009`):
- sin `paymentToken` ni `paymentMethodRef`;
- con los dos a la vez;
- con `paymentMethodRef: <m1>` y `payerId: "cli-2"`;
- con un `paymentMethodRef` que no existe;
- con `amount: 10.555`.

**Then**:
1. Los dos primeros: status `422` con `PAYMENT_SOURCE_INVALID`.
2. El tercero y el cuarto: status `422` con `PAYMENT_METHOD_NOT_FOUND`, el mismo code y el mismo
   status en los dos — no se revela que `<m1>` existe.
3. El quinto: status `400` por el importe con tres decimales.
4. La pasarela de prueba no ha recibido ningún cobro, y `getPayment` sobre cualquiera de esas
   referencias responde `404` con `PAYMENT_NOT_FOUND`.

## Cobros por evento

### FL-EVT-001: pedidos pide un cobro sin el cliente delante

**Given**: un medio guardado `<m1>` de `cli-1`.

**When**: llega `ChargeRequested` por `chargeRequests` con `{chargeRequestId: "ch-010", orderId:
"ped-10", payerId: "cli-1", amount: 40.00, paymentMethodRef: <m1>}`.

**Then**:
1. En ≤ 10 s `paymentEvents` recibe **exactamente un** `PaymentAuthorized` para `ch-010`, con
   `amount: 40.00`.
2. `getPayment` sobre `ch-010` responde `status: "authorized"` y `savedPaymentMethodId: <m1>`.

**When**: llega otro `ChargeRequested` para `ch-011`, con la pasarela de prueba configurada para
rechazarlo como tarjeta caducada.

**Then**:
3. En ≤ 10 s `paymentEvents` recibe **exactamente un** `PaymentFailed` para `ch-011`, con
   `failureReason: "expiredCard"`: quien pidió por evento se entera por evento.

#### FL-EVT-001-B: la reentrega del mismo mensaje no cobra dos veces

**Given**: el `ChargeRequested` de `ch-010` del flujo anterior, ya atendido.

**When**: se reentrega el mismo mensaje (el mismo `metadata.eventId`), y en otra prueba llega un
mensaje distinto con el mismo `chargeRequestId`.

**Then**:
1. La pasarela de prueba sigue teniendo **un** cobro para `ch-010`: no hay segundo efecto.
2. `paymentEvents` no recibe ningún desenlace más para `ch-010`.

### FL-EVT-002: un cobro sin cliente que exige autenticación

**Given**: un medio guardado `<m1>` de `cli-1` y la pasarela de prueba configurada para exigir
autenticación en el siguiente cobro.

**When**: llega `ChargeRequested` para `ch-012` con `paymentMethodRef: <m1>`.

**Then**:
1. En ≤ 10 s `paymentEvents` recibe **exactamente un** `PaymentActionRequired` para `ch-012`, con
   `customerAction` no nula: pedidos tiene con qué traer al cliente.
2. `getPayment` sobre `ch-012` responde `status: "actionRequired"` y la misma `customerAction`.

**Notas de determinación**: el servicio no reintenta ni lo da por fallido; pedidos decide si trae
al cliente, y si nunca vuelve, la pasarela acaba dando el cobro por fallido y el barrido lo recoge.

### FL-EVT-003: un cobro por evento con un medio que no es del pagador

**Given**: un medio guardado `<m1>` de `cli-1`.

**When**: llega `ChargeRequested` para `ch-013` con `payerId: "cli-2"` y `paymentMethodRef: <m1>`.

**Then**:
1. En ≤ 10 s `paymentEvents` recibe **exactamente un** `PaymentFailed` para `ch-013`, con
   `failureReason: "invalidPaymentMethod"`.
2. `getPayment` sobre `ch-013` responde `status: "failed"`, y la pasarela de prueba no ha recibido
   ningún cobro para `ch-013`.

## Liquidación

### FL-STL-001: se captura un cobro autorizado

**Given**: el cobro `ch-001` autorizado (FL-CHG-001).

**When**: `capturePayment` sobre `ch-001`.

**Then**:
1. Status `200` con `status: "captured"`: el cobro pasó por `capturing` y la pasarela confirmó en
   el acto.
2. `paymentEvents` recibe **exactamente un** `PaymentCaptured` para `ch-001`, con `amount: 25.90`.

#### FL-STL-001-B: lo que no se puede capturar

**Given**: el cobro `ch-001` ya capturado, y un cobro `ch-020` autorizado cuya autorización la
pasarela de prueba da por caducada.

**When**: `capturePayment` sobre `ch-001`, sobre `ch-999` (no existe) y sobre `ch-020`.

**Then**:
1. `ch-001`: status `409` con `PAYMENT_NOT_CAPTURABLE`.
2. `ch-999`: status `404` con `PAYMENT_NOT_FOUND`.
3. `ch-020`: status `409` con `PAYMENT_NOT_CAPTURABLE`, y `getPayment` lo da en `canceled` con
   `cancelReason: "expired"`.

### FL-STL-002: se anula una autorización

**Given**: un cobro `ch-021` autorizado.

**When**: `cancelPayment` sobre `ch-021`.

**Then**:
1. Status `200` con `status: "canceled"` y `cancelReason: "requested"`: pasó por `canceling` y la
   pasarela confirmó en el acto.
2. `paymentEvents` recibe **exactamente un** `PaymentCanceled` para `ch-021`, con
   `cancelReason: "requested"`.

#### FL-STL-002-B: lo que no se puede anular

**Given**: el cobro `ch-021` ya anulado.

**When**: `cancelPayment` sobre `ch-021` y sobre `ch-999`.

**Then**:
1. `ch-021`: status `409` con `PAYMENT_NOT_CANCELABLE`.
2. `ch-999`: status `404` con `PAYMENT_NOT_FOUND`.

### FL-STL-003: una devolución parcial

**Given**: el cobro `ch-001` capturado por 25.90 (FL-STL-001).

**When**: `refundPayment` sobre `ch-001` con `amount: 10.00`.

**Then**:
1. Status `200` con `status: "refunded"` y `refundedAmount: 10.00`: pasó por `refunding` y la
   pasarela confirmó en el acto.
2. `paymentEvents` recibe **exactamente un** `PaymentRefunded` para `ch-001` con
   `refundedAmount: 10.00`.

#### FL-STL-003-B: lo que no se puede devolver

**Given**: el cobro `ch-001` ya devuelto, un cobro `ch-023` capturado por 15.00, un cobro `ch-024`
capturado cuya devolución la pasarela de prueba rechaza, y un cobro `ch-025` autorizado.

**When**: `refundPayment` sobre `ch-001`, sobre `ch-023` con `amount: 20.00`, sobre `ch-024`, sobre
`ch-025` y sobre `ch-999`.

**Then**:
1. `ch-001`: status `409` con `PAYMENT_NOT_REFUNDABLE` — una sola devolución por cobro.
2. `ch-023`: status `422` con `REFUND_EXCEEDS_CAPTURED`, y la pasarela no ha recibido nada.
3. `ch-024`: status `422` con `REFUND_REJECTED`, y `getPayment` lo vuelve a dar en `captured`.
4. `ch-025`: status `409` con `PAYMENT_NOT_REFUNDABLE` — no está capturado.
5. `ch-999`: status `404` con `PAYMENT_NOT_FOUND`.

### FL-STL-004: la autorización caduca y la pasarela avisa

**Given**: un cobro `ch-026` autorizado que nadie captura.

**When**: la pasarela de prueba avisa de que la autorización de `ch-026` caducó.

**Then**:
1. En ≤ 10 s `getPayment` sobre `ch-026` responde `status: "canceled"` y `cancelReason: "expired"`.
2. `paymentEvents` recibe **exactamente un** `PaymentCanceled` para `ch-026`, con
   `cancelReason: "expired"`.

**When**: llega un aviso sobre un cobro `ch-027` autorizado, con la firma alterada.

**Then**:
3. El servidor responde al aviso con un `4xx` y no consulta nada a la pasarela: `ch-027` sigue en
   `authorized`.

#### FL-STL-004-B: dos acciones sobre el mismo cobro a la vez

**Given**: un cobro `ch-028` autorizado.

**When**: a la vez, `capturePayment` y `cancelPayment` sobre `ch-028`.

**Then**:
1. Gana una: el cobro queda en `captured` o en `canceled`, nunca pisado por la otra.
2. La otra responde `409` (`PAYMENT_NOT_CAPTURABLE`, `PAYMENT_NOT_CANCELABLE` o
   `CONCURRENT_MODIFICATION`), y la pasarela de prueba recibió **una sola** de las dos acciones.
3. `paymentEvents` recibe **un solo** desenlace para `ch-028`.

## Reconciliación

### FL-REC-001: un cobro sin respuesta se resuelve preguntando

**Given**: la pasarela de prueba configurada para no contestar al siguiente cobro, pero
registrándolo.

**When**: `requestCharge` con `chargeRequestId: "ch-030"` y un token.

**Then**:
1. Status `201` con `status: "pending"` y `gatewayPaymentId: null`: el servicio no sabe todavía si
   se cobró, y no lo reintenta.

**When**: la pasarela de prueba vuelve a contestar —sabe que `ch-030` quedó autorizado—, pasa el
umbral de `unansweredAfterSeconds` y corren dos ciclos de `sweepPendingPayments`.

**Then**:
2. `getPayment` sobre `ch-030` responde `status: "authorized"` con `gatewayPaymentId` no nulo, y
   `paymentEvents` recibe **exactamente un** `PaymentAuthorized` para `ch-030`.
3. La pasarela de prueba tiene **un** cobro para `ch-030`: el barrido lo consultó por su
   referencia, no volvió a cobrar.

**When**: lo mismo para `ch-031`, pero la pasarela de prueba **no** llegó a registrarlo.

**Then**:
4. `getPayment` sobre `ch-031` responde `status: "failed"` con `failureReason: "notReceived"`, y
   `paymentEvents` recibe un `PaymentFailed` para `ch-031`.

### FL-REC-002: una captura cuya respuesta se pierde

**Given**: un cobro `ch-032` autorizado y la pasarela de prueba configurada para no contestar a la
siguiente captura, pero haciéndola.

**When**: `capturePayment` sobre `ch-032`.

**Then**:
1. Status `200` con `status: "capturing"`: no se sabe si capturó, y no se repite.

**When**: la pasarela vuelve a contestar, pasa el umbral y corren dos ciclos del barrido.

**Then**:
2. `getPayment` sobre `ch-032` responde `status: "captured"` y `paymentEvents` recibe **exactamente
   un** `PaymentCaptured` para `ch-032`.

**When**: lo mismo con una anulación de un cobro `ch-033` que la pasarela **no** llegó a hacer.

**Then**:
3. El cobro pasa por `canceling` y el barrido lo devuelve a `authorized`: se puede volver a anular.

#### FL-REC-002-B: lo que acaba de entrar en vuelo no se toca

**Given**: el barrido **detenido** desde antes de que `ch-034` entrara en `capturing`, así que ningún
ciclo lo ha consultado todavía; `ch-034` lleva en `capturing` más del umbral, y un cobro `ch-035`
entró en `capturing` hace segundos, los dos sin respuesta de la pasarela de prueba. Se reanuda el
barrido.

**When**: corre un ciclo de `sweepPendingPayments`.

**Then**:
1. La pasarela de prueba recibe una consulta de estado para `ch-034` y **ninguna** para `ch-035`:
   el barrido rescata lo atascado y no le roba el trabajo a la captura que sigue en curso.

### FL-CLU-001: con dos réplicas, cada cobro en duda se pregunta una vez

`sweepPendingPayments` corre en **todas** las réplicas, y su consulta a la pasarela sale de la
transacción.

**Given**: dos réplicas del servicio vivas contra el mismo almacén, y cinco cobros `ch-040` …
`ch-044` en `pending` que la pasarela de prueba registró sin contestar.

**When**: pasa el umbral y corren dos ciclos del barrido en las dos réplicas.

**Then**:
1. La pasarela de prueba recibe **exactamente una** consulta de estado por cada uno de los cinco.
2. Los cinco quedan en `authorized`, y `paymentEvents` recibe **exactamente un**
   `PaymentAuthorized` por cada uno: cinco, ni uno más.

## Outbox

### FL-OBX-001: el desenlace sobrevive a un canal indisponible

**Given**: el canal `paymentEvents` sin mensajes y el canal de eventos **indisponible**.

**When**: `requestCharge` con `chargeRequestId: "ch-050"` y un token.

**Then**:
1. Status `201` con `status: "authorized"`: la indisponibilidad del canal no llega a pedidos.
2. `paymentEvents` no ha recibido **ningún** mensaje todavía.

**When**: el canal vuelve a estar disponible.

**Then**:
3. En ≤ 10 s `paymentEvents` recibe **exactamente un** `PaymentAuthorized` para `ch-050`.

### FL-OBX-002: el desenlace que el relay abandona no se pierde en silencio

**Given**: el canal indisponible y un cobro ya autorizado con su `PaymentAuthorized` pendiente de
salir.

**When**: se agota el presupuesto de reintentos de ese evento.

**Then**:
1. El servidor lo dice: informa de **un** evento abandonado.
2. Restablecido el canal, ese evento **no** se publica: el relay respeta que se rindió.

## Lo que no tiene escenario, y por qué

- **El fallo pasajero de la suscripción y su cola de descarte.** `ChargeRequested` reintenta y
  descarta en la DLQ los mensajes que no puede atender; un rechazo de negocio no se reintenta, se
  registra como cobro `failed` (FL-EVT-003). Provocar un fallo **pasajero** en caja negra exigiría
  tumbar la base de datos a mitad del consumo, y el resultado observable —el cobro sale igual— es
  el de FL-EVT-001.
- **Que un medio guardado no se pueda cobrar tras un error al guardarlo.** Un 422 o un 503 de
  `savePaymentMethod` no devuelve id, y no hay lectura de medios guardados: no hay nada que un
  escenario de caja negra pueda intentar cobrar.
