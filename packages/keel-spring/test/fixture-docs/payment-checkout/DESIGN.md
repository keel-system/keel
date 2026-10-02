# payment-checkout — Documento de diseño

> specs/payment-checkout v1.0.0. Diseño cerrado; el porqué de las decisiones se entrevistó al cerrarlo.

## 1. Propósito y alcance

Cobra con tarjeta los pedidos de la tienda **por cuenta del sistema de pedidos**. Pedidos pide un
cobro cuando el cliente confirma, lo captura cuando sirve el pedido, lo anula si no lo sirve y lo
devuelve, entero o en parte, si hace falta. El cobro se pide con el cliente delante (con el token
que produce el componente de la pasarela en su navegador) o sin él (con un medio que el cliente
guardó antes).

Es la fixture de referencia de la capa `payments`: **el diseño no nombra ninguna pasarela**. La
pasarela se elige al generar, como el broker, y estos mismos YAML tienen que producir el mismo
servidor con cualquiera de las del menú.

Queda fuera, a propósito: los métodos de pago asíncronos (PIX, boleto), las disputas y
contracargos, los pagos recurrentes, la captura parcial y retirar un medio guardado. Cada uno tiene
su motivo en § 6.

## 2. Modelo de dominio

Dos agregados, cada uno con una sola entidad:

- **`Payment`** — un cobro. Es la memoria del servicio frente a la pasarela: a él se aplica cada
  desenlace y es lo que barre la reconciliación. Se identifica, para quien lo pidió, por el
  `chargeRequestId` que eligió él.
- **`SavedPaymentMethod`** — un medio de pago guardado, a nombre de su titular. Guarda la referencia
  de la pasarela, que nunca sale del servicio, y entrega su propio id.

El ciclo de vida de un cobro:

```
pending ──► actionRequired ──► authorized ──► capturing ──► captured ──► refunding ──► refunded
   │              │                │  ▲            │                         │
   └──► failed ◄──┘                │  └────────────┘ (no se hizo)            └──► captured (rechazada / no se hizo)
                                   ├──► canceling ──► canceled
                                   └──► canceled (la autorización caducó)
```

`capturing`, `canceling` y `refunding` son **estados en vuelo**: la operación deja el cobro ahí
antes de llamar a la pasarela. Es lo que hace reconciliable una respuesta que se pierde y lo que
impide que dos acciones incompatibles sobre el mismo cobro lleguen las dos a la pasarela.

## 3. Invariantes y reglas clave

- **Un cobro por referencia.** La `naturalKey` sobre `chargeRequestId` es la guarda contra el doble
  cargo, por las dos puertas y sin caducar. La misma referencia otra vez responde
  `CHARGE_ALREADY_REQUESTED`.
- **Nada se repite a ciegas.** Cobrar, capturar, anular y devolver registran su estado (y
  `awaitingSince`) **antes** de llamar a la pasarela. Si la respuesta no llega, el cobro se queda en
  duda y el barrido le pregunta a la pasarela, por `gatewayPaymentId` o por `chargeRequestId` si aún
  no lo tiene.
- **El aviso de la pasarela no decide nada.** Solo dice que algo cambió en un cobro: el desenlace se
  le consulta. Un aviso que no verifica se rechaza con un `4xx`.
- **Los desenlaces son idempotentes** y solo los aplica el servidor (operaciones `internal`): uno
  repetido o tardío no hace nada; dos distintos no se pisan (bloqueo optimista).
- **Un medio guardado solo lo cobra su titular.** Un medio que no existe y uno de otro responden
  igual.
- **Lo devuelto no supera lo cobrado**, y hay una sola devolución por cobro.
- **Los motivos de fallo son un vocabulario neutro cerrado** (`declined`, `insufficientFunds`,
  `expiredCard`, `authenticationFailed`, `fraudSuspected`, `invalidPaymentMethod`, `notReceived`,
  `processingError`): cada pasarela se traduce a él.

## 4. Qué hace

| Operación | Qué hace | Puerta |
|---|---|---|
| `savePaymentMethod` | Guarda un medio de pago y devuelve su id | HTTP (M2M) |
| `requestCharge` | Pide un cobro (autoriza) con token o medio guardado | HTTP (M2M) y evento `ChargeRequested` |
| `getPayment` | Consulta un cobro por su referencia | HTTP (M2M) |
| `capturePayment` | Captura lo autorizado | HTTP (M2M) |
| `cancelPayment` | Anula la autorización | HTTP (M2M) |
| `refundPayment` | Devuelve todo o parte de lo capturado | HTTP (M2M) |
| `markAuthorized` … `markCanceled` | Aplican cada desenlace y publican su evento | internas |
| `sweepPendingPayments` | Pregunta por lo que lleva demasiado esperando | cada 5 minutos |

Un rechazo de la pasarela no es un error de la petición: es un cobro `failed` con su motivo. Si la
pasarela pide autenticar al cliente, el cobro queda en `actionRequired` con la acción guardada
(`customerAction`), que sale en la respuesta, en `getPayment` y en el evento.

## 5. Fronteras e integraciones

- **Pedidos** es el único llamante, con credencial máquina (`orders-service`) y tres scopes
  (`payment:charge`, `payment:read`, `payment:settle`). Fija el importe y el `payerId`.
- **Por evento**, pedidos pide cobros sin el cliente delante por `chargeRequests` (envoltura Keel).
  Solo se cobra un medio guardado; un rechazo de negocio se registra como cobro `failed` y sale
  `PaymentFailed`, porque por esa puerta no hay a quién responder un 422.
- **Los desenlaces** salen por `paymentEvents` con outbox: `PaymentAuthorized`,
  `PaymentActionRequired` (con la acción del cliente), `PaymentCaptured`, `PaymentFailed` (con su
  motivo), `PaymentRefunded` y `PaymentCanceled` (anulada o caducada).
- **La pasarela** no aparece en el diseño. El generador pone su contrato, la verificación de sus
  avisos, la unidad del importe, la cabecera de idempotencia (derivada de `chargeRequestId`) y la
  traducción de sus códigos al vocabulario neutro.
- **El navegador del cliente** no habla con este servicio: habla con el componente de la pasarela,
  que le da un token o le presenta la acción de autenticación.

## 6. Decisiones de diseño (qué / por qué)

- **Autorizar al pedir y capturar al servir** (`authorize-capture`): el cliente no paga un pedido
  que no se le sirve, y anular una retención no cuesta lo que cuesta una devolución.
- **Sin captura parcial**: no la cubren todas las pasarelas del menú, y declararla habría estrechado
  las que pueden servir el diseño. Este servicio captura siempre el pedido entero; lo parcial va por
  la devolución.
- **La guarda del doble cargo es la clave natural, no una idempotencia**: una cabecera no llega por
  el broker y un almacén de claves caduca. La idempotencia hacia la pasarela la deriva el generador
  de la misma referencia.
- **Estados en vuelo y barrido de todo lo que espera**: una captura o una devolución cuya respuesta
  se pierde está tan en duda como un cobro; repetirla a ciegas puede capturar o devolver dos veces.
- **La acción del cliente se guarda**: sin ella, un cobro pedido por evento que exige autenticación
  no se podría completar nunca.
- **Un rechazo por evento es un cobro fallido**: quien pide por evento se entera por evento.
- **Varios cobros por pedido**: tras un fallo, pedidos pide otro con otra referencia. Qué cobro vale
  para un pedido es de pedidos.
- **Moneda única de dos decimales**, como parámetro de despliegue: no es elección del cliente.
- **Sin retirar medios guardados en v1.0.0**: solo pedidos los cobra y solo a su titular; un medio
  caducado lo rechaza la pasarela. Entra con el caso de uso de baja de cliente.
- **Fuera**: métodos asíncronos, disputas, recurrentes y payouts. Entrarán cuando un diseño los
  necesite y su forma se haya contrastado con más de una pasarela.

## 7. Ficha de reutilización

- **Para qué sirve**: el cobro con tarjeta de un sistema de pedidos o de reservas que ya decide qué
  y cuánto cobrar, y quiere poder cambiar de pasarela sin rediseñar.
- **Qué hay que ajustar al adoptarlo**: la moneda (`service.parameters.currency`), el umbral de la
  reconciliación (`unansweredAfterSeconds`) y el cliente máquina que llama.
- **Qué no cubre**: ver § 1 y § 6.
