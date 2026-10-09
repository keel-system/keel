# Capa `payments` — cobros con pasarela (opcional)

Archivo: `specs/<servicio>/payments.keel.yaml` · Schema: [`schema/payments.schema.json`](../../schema/payments.schema.json)

Cobros con tarjeta a través de una pasarela de pago. La capa **no nombra la pasarela**: Stripe, MercadoPago o cualquier otra se elige al generar, igual que el broker. Es la promesa del método aplicada al dinero: un único diseño, y lo que cambia entre pasarelas lo pone el generador.

```yaml
description: Cobra los pedidos con tarjeta, en el acto o con un medio de pago guardado.
flow: authorize-capture
capabilities: [partial-refund, customer-action, off-session]

record:
  entity: Payment
  gatewayRef: gatewayPaymentId     # string: el id que asigna la pasarela
  awaitingSince: awaitingSince     # timestamp: desde cuándo espera sin respuesta (un solo reloj)
  failureReason: failureReason     # enum con el vocabulario neutro
  customerAction: customerAction   # string o json: la acción del cliente (3DS), mientras espera

charge:
  operation: requestCharge
  reference: chargeRequestId       # clave de negocio del cobro
  amount: amount                   # decimal, unidades mayores
  currency: { parameter: currency } # o { input: currency }
  source:
    token: paymentToken            # cliente presente
    saved: paymentMethodRef        # cliente ausente (off-session)

capture: { operation: capturePayment, inFlight: capturing }
void: { operation: cancelPayment, inFlight: canceling }
refund: { operation: refundPayment, amount: amount, inFlight: refunding }
savePaymentMethod: { operation: savePaymentMethod, token: paymentToken, exposedAs: id }

outcomes:
  authorized: markAuthorized
  captured: markCaptured
  failed: markFailed
  actionRequired: markActionRequired
  refunded: markRefunded
  canceled: markCanceled

reconciliation:
  sweep: sweepPendingPayments
  unansweredAfterSeconds: 900
```

## Qué va aquí y qué no

| Va en `payments` (decisión de diseño) | Lo pone el generador (cambia por pasarela) |
|---|---|
| Cuándo se considera cobrado (`flow`) | El contrato HTTP de la pasarela |
| Qué se le exige a la pasarela (`capabilities`) | La firma del aviso y cómo se verifica |
| Qué operación ejecuta cada acción y de qué campos salen sus datos | La unidad del importe (céntimos o unidades) y la escala de cada moneda |
| Quién registra cada desenlace (`outcomes`) | La cabecera de idempotencia y cómo se deriva la clave |
| Qué estado marca cada acción en curso (`inFlight`) | Cómo se guarda un medio de pago (SetupIntent, primer cobro marcado…) |
| Cuánto silencio se tolera antes de consultar (`reconciliation`) | Cómo traduce sus códigos de rechazo al vocabulario neutro |

Si un diseño necesita nombrar una pasarela para funcionar, a esta capa le falta algo. No lo escribas en prosa: es un hueco del DSL.

No confundir con:

- **`http-clients`**: describe un contrato concreto. El de cada pasarela lo genera el generador; no se declara un cliente para ella.
- **`dependencies`**: describe otros servidores Keel. Una pasarela no lo es, ni publica `INTEGRATION.md`.

## El flujo

- **`authorize-capture`**: el cobro se **autoriza** (retiene el importe) y se **captura** después con otra operación. La autorización es un estado por derecho propio: caduca (en tarjeta, del orden de días) y la pasarela la cancela sola. Por eso exige `capture`, `outcomes.authorized` y `outcomes.canceled`.
- **`single-step`**: autorizar y capturar son el mismo acto. No admite `capture` ni `outcomes.authorized`.

## Las capacidades

Son lo que el diseño exige a la pasarela por encima del cobro básico. El generador las contrasta con su matriz de paridad: **una pasarela que no cubre una capacidad declarada no genera**, en vez de cumplirla a medias. Así que cuantas menos se declaren, más pasarelas pueden servir el mismo diseño.

| Capacidad | Pieza que la usa |
|---|---|
| `partial-capture` | `capture.amount` |
| `partial-refund` | `refund.amount` |
| `customer-action` | `record.customerAction` y `outcomes.actionRequired` |
| `off-session` | `savePaymentMethod` y `charge.source.saved` |

La relación va en los dos sentidos (`CHK-PAYMENTS-CAPABILITY-UNBACKED`): una capacidad sin su pieza estrecha sin motivo las pasarelas que sirven el diseño, y una pieza sin su capacidad se generaría en una pasarela que no la cubre.

## El registro (`record`)

La entidad del dominio que recuerda cada cobro frente a la pasarela. Sus campos (`CHK-PAYMENTS-RECORD-UNKNOWN`):

- **`gatewayRef`** (string): el id que asigna la pasarela. Correlaciona un aviso con el registro y permite consultarle el estado. Está vacío mientras la pasarela no ha contestado: entonces el cobro se consulta por su `charge.reference`, que el generador manda a la pasarela como referencia externa en la petición de cobro. Por eso un cobro sin respuesta sigue siendo reconciliable.
- **`awaitingSince`** (timestamp): **desde cuándo** el cobro espera **sin respuesta** un desenlace. Lo estampa cada acción al entrar en su estado en vuelo —el cobro al nacer en `pending` y la captura, la anulación o la devolución al entrar en el suyo—, y lo **renueva el barrido** cada vez que reclama el cobro para consultarlo: así otra réplica no lo toma en la misma pasada. Por eso no dice cuándo empezó la espera, sino cuánto lleva sin que nadie obtenga respuesta. Es el único reloj que mira el barrido.
- **`failureReason`**: por qué falló un cobro. Su tipo es un enum del dominio con **exactamente** el vocabulario neutro (`CHK-PAYMENTS-FAILURE-VOCABULARY`):

  | Valor | Cuándo |
  |---|---|
  | `declined` | el emisor rechazó sin motivo útil |
  | `insufficientFunds` | sin fondos o sin crédito |
  | `expiredCard` | la tarjeta caducó |
  | `authenticationFailed` | el cliente no completó la autenticación, o la falló |
  | `fraudSuspected` | lo paró el antifraude |
  | `invalidPaymentMethod` | el medio no sirve: token inválido o caducado, medio retirado o de otro titular |
  | `notReceived` | la pasarela no conoce el cobro: la petición no llegó nunca |
  | `processingError` | fallo de la pasarela o de la red de tarjetas, no del medio |

  Cada adaptador traduce a estos valores los códigos de su pasarela. Con texto libre, cada pasarela escribiría el suyo y el mismo diseño fallaría distinto según con cuál se generase. La lista es cerrada: un motivo nuevo es un cambio del DSL, no de un adaptador. El generador la toma de `FAILURE_REASONS` (`keel-core`).
- **`customerAction`** (string o json; exige `customer-action`): la acción que el cliente tiene que hacer para completar el cobro (3DS, redirección), guardada **mientras el cobro está en `actionRequired`** y vacía en cualquier otro estado. Su contenido es opaco: lo define la pasarela y lo consume su componente en el navegador. **El servidor es portable, el frontend no.** Guardarla es lo que permite recuperarla cuando el cobro se pidió sin el cliente delante: sale en la lectura del cobro y conviene que viaje también en el evento del desenlace `actionRequired`. Con tipo `json` viaja embebida como objeto, no como cadena (ver el tipo `json` en [`domain`](domain.md)).

### Lo que conserva un cobro `failed`

Un cobro fallido conserva lo que **llegó a existir**, y nada más:

| Cómo falló | `gatewayRef` | Medio guardado anotado | `failureReason` | `customerAction` |
|---|---|---|---|---|
| **Antes de llamar a la pasarela** (medio inexistente, de otro titular, ausente o doble, por la puerta del evento) | vacío | **vacío** | el que corresponda (`invalidPaymentMethod`) | vacío |
| **Lo rechazó la pasarela** | el que asignó | el medio con el que se intentó | el traducido | vacío |
| **La pasarela no lo conoce** (barrido) | vacío | el medio con el que se intentó | `notReceived` | vacío |

La primera fila es la que suele quedar sin decir: una rule que anota el medio «con `paymentMethodRef`, siempre» choca con el invariante que ata el medio a su titular justo en la rama que rechaza un medio ajeno. O la escritura se rechaza (y no hay cobro `failed` ni evento de desenlace) o la anotación se omite, y el diseño tiene que decir cuál: la doctrina es omitirla, porque el invariante manda. Lo pregunta `REV-PAYMENTS-FAILED-RECORD`.

De la misma familia: **`awaitingSince` solo tiene valor mientras el cobro espera un desenlace** (`pending`, `actionRequired` y los estados en vuelo). La operación del desenlace lo vacía al salir, y también el barrido o la acción rechazada que devuelve el cobro al estado del que salió; si se conserva, un cobro terminado parece seguir esperando para cualquiera que lo lea, aunque el barrido no lo vuelva a seleccionar.

## El cobro (`charge`)

- **`reference`** es la clave de negocio de la petición de cobro (`chargeRequestId`, `orderId`). Es **la** guarda contra el doble cargo, y por eso tiene que ser miembro de la `naturalKey` de la entidad de `record` (o `unique` en `domain`) por nombre, igual que el `keyField` de `payload-field` (`CHK-PAYMENTS-REFERENCE-UNGUARDED`). De ella deriva el generador la clave de idempotencia hacia la pasarela y la referencia externa con la que se consulta un cobro sin `gatewayRef`. Así las dos puertas del cobro y los reintentos convergen en la misma clave también al otro lado.
- **La idempotencia de la pasarela no es una guarda permanente.** Guarda también los errores con su clave (reintentar un 500 devuelve el mismo 500) y la olvida pasado un tiempo. Lo que no caduca es la constraint sobre `reference`.
- **El cobro se registra antes de llamar a la pasarela**, en `pending` y con `awaitingSince` estampado. Si la respuesta no llega, el cobro se queda en duda y lo resuelve el barrido: **no se reintenta a ciegas**.
- **`amount`** es un campo `decimal` en unidades mayores (12.50). La conversión a la unidad de cada pasarela es del generador.
- **`currency`** sale de un campo del input o de un parámetro de despliegue (`service.parameters`) cuando el servicio opera en una sola moneda.
- **`source`** dice con qué se paga, siempre como **referencia opaca** y nunca como datos de tarjeta:
  - `token` es el que produce el componente de la pasarela en el navegador (cliente presente);
  - `saved` es la referencia a un medio guardado (cliente ausente, exige `off-session`). Puede ser un `string` con la referencia opaca de la pasarela o un `uuid` con el id de un registro propio. Lo recomendable es el registro propio, porque permite atar el medio a su titular (`REV-PAYMENTS-SAVED-OWNERSHIP`) sin que la referencia de la pasarela salga del servicio.

### Dos puertas sobre el mismo cobro

La operación de `charge` puede tener endpoint **y** suscripción a la vez (`nature: request`). Para que eso funcione:

- **Por evento no hay cliente presente**, así que solo se puede cobrar un medio guardado: la capa tiene que declarar `off-session` (`CHK-PAYMENTS-ASYNC-NEEDS-OFF-SESSION`). Si la pasarela exige autenticación a un cobro sin cliente, el desenlace es `actionRequired` y la acción queda guardada: quien pidió el cobro decide si trae al cliente.
- **Quien pide por evento no recibe respuesta HTTP**: se entera de cada desenlace por lo que publican las operaciones de `outcomes` (`CHK-PAYMENTS-OUTCOME-SILENT`). Un rechazo de negocio por esa puerta (un medio que no es del pagador) conviene registrarlo como cobro `failed` con su motivo: si solo se descarta, quien lo pidió no se entera nunca.
- **La deduplicación entre puertas** la da la `naturalKey` sobre `reference`. Si además se declara `idempotency`, que sea `keySource: payload-field` sobre ese mismo campo: `client-key` no llega por el broker, y un `keyField` fuera de la clave natural lo avisa `CHK-USECASES-IDEM-KEYFIELD-NOT-NATURAL`.

## Las acciones que siguen al cobro, y su estado en vuelo

`capture`, `void` y `refund` también llaman a la pasarela, y su respuesta también se puede perder: ¿capturó o no? Cada una declara su **`inFlight`**: el estado del lifecycle en el que la operación deja el cobro **antes** de llamar a la pasarela (`capturing`, `canceling`, `refunding`). De ahí sale el desenlace (`CHK-PAYMENTS-INFLIGHT-INVALID`). El estado en vuelo da tres cosas:

- **Reconciliable**: si la respuesta no llega, el cobro se queda en su estado en vuelo, la operación responde con el cobro en ese estado y el barrido pregunta.
- **Excluyente**: una captura y una anulación simultáneas no llegan las dos a la pasarela. La segunda encuentra el cobro ya en vuelo y responde que no está en un estado que lo permita.
- **Observable**: quien consulta el cobro ve que hay una acción en curso.

Las acciones:

- **`capture`**: obligatoria con `authorize-capture`. Con `amount` captura un importe menor (exige `partial-capture`), y el resto se libera.
- **`void`**: anula una autorización que no se va a capturar. Exige `outcomes.canceled`.
- **`refund`**: devuelve lo cobrado. Con `amount` devuelve una parte (exige `partial-refund`). Exige `outcomes.refunded`.
- **`savePaymentMethod`**: guarda un medio de pago para cobrar sin el cliente. Es una operación propia, y no un efecto lateral del cobro, porque cada pasarela lo hace de una forma distinta. `exposedAs` es el campo de la respuesta con el que sale la referencia guardada; es lo que después llega a `charge.source.saved`.

### Cuando la pasarela contesta que NO (`onRejected`)

Una acción de seguimiento tiene **tres** desenlaces, no dos: la pasarela confirma, no contesta, o **contesta que no** (la anulación ya no se puede hacer, la devolución supera lo cobrado). Los dos primeros los resuelve la capa —el desenlace y el barrido—; el tercero lo decide el diseño en `onRejected`, porque las dos respuestas son defendibles:

```yaml
capture: { operation: capturePayment, inFlight: capturing, onRejected: { error: PAYMENT_NOT_CAPTURABLE } }
void:    { operation: cancelPayment, inFlight: canceling, onRejected: { error: PAYMENT_NOT_CANCELABLE } }
refund:  { operation: refundPayment, amount: amount, inFlight: refunding, onRejected: reconcile }
```

- **`{ error: <code> }`**: el cobro sale del estado en vuelo y **vuelve al de origen** (`canceling` → `authorized`), y la operación responde ese error, que tiene que estar en sus `errors` (`CHK-PAYMENTS-REJECTED-ERROR-UNKNOWN`). El llamante sabe en la respuesta que no se hizo. Si la pasarela dice que el cobro ya está en otro desenlace (la autorización caducó: está anulado), se aplica ese desenlace en vez de volver.
- **`reconcile`**: el cobro se queda en vuelo, la operación responde con él y el barrido lo devuelve a su estado al consultar. Más lento, y el llamante no se entera en la respuesta.

Sin declararlo, `OBL-PAYMENTS-FOLLOWUP-REJECTED`, que no se acepta: lo que no vale es que cada servidor elija la suya. Las cuatro corridas `payment-checkout` del 2026-10-09 lo destaparon así —keel-spring devolvió el cobro a `authorized` con un 409 y keel-nest lo dejó en `canceling` con un 200, y las dos formas pasaban todos los escenarios—.

## Los desenlaces (`outcomes`)

Cada desenlace lo aplica una operación propia, que el generador dispara cuando lo conoce: por la respuesta de la pasarela, por su aviso o por el barrido.

- **El aviso de la pasarela solo dice que algo cambió en un cobro; el desenlace se le consulta.** No es una precaución: en alguna pasarela la firma del aviso no cubre su contenido, y quien lo altere en tránsito decidiría el estado del cobro. Por eso la capa declara desenlaces y no webhooks.
- **Un aviso que no verifica se rechaza** con un 4xx y no se consulta nada. Es lo único que hace observable la verificación: si se consultara igual, un aviso falso y uno verdadero acabarían en el mismo estado.
- **Lo que responde el aviso lo fija el generador, no el diseño**: `POST /webhooks/payments` (fuera de la API versionada, sin credencial) responde **200 vacío** al aviso que verifica —aunque no hable de ningún cobro— y **401 vacío** al que no. Es contrato con la pasarela, que reintenta lo que no recibe un 2xx, y es el mismo en los dos generadores.

### Un cobro por evento con una referencia que ya tiene cobro

Cuando una suscripción dispara `charge.operation`, puede llegar un mensaje **distinto** (otro `metadata.eventId`, así que la deduplicación por mensaje no lo ve) con una `charge.reference` que ya tiene cobro. La `naturalKey` impide el segundo cobro; lo que queda por decidir es qué se hace con el **mensaje**: confirmarlo como un duplicado ya resuelto, o descartarlo para que alguien lo mire. Se declara en la suscripción con `onFailure.acknowledgeOn` (ver `messaging.md`), nombrando el error de la referencia repetida; sin declararlo, `OBL-PAYMENTS-REFERENCE-REUSED`, que se puede aceptar por escrito si la decisión es el descarte.

Reglas de los desenlaces:

- `captured` y `failed` son obligatorios; `authorized` con `authorize-capture`; `actionRequired` con `customer-action`; `refunded` con `refund`; `canceled` con `void` o `authorize-capture` (`CHK-PAYMENTS-OUTCOME-MISSING`).
- Tienen que ser **`internal: true`** (`CHK-PAYMENTS-OUTCOME-EXPOSED`): una operación de desenlace con puerta propia deja a un cliente marcar un cobro como pagado sin que la pasarela haya dicho nada.
- Tienen que mover el lifecycle de la entidad de `record` (`CHK-PAYMENTS-OUTCOME-NO-TRANSITION`): si no, el desenlace no queda registrado y el barrido vuelve a encontrar el cobro esperando.
- **Reciben solo lo que la capa nombra** (`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED`): la referencia, el id de la pasarela, el motivo de fallo, la acción del cliente y, en `refunded`, el importe devuelto. Cuando el desenlace llega por el aviso o por el barrido, cualquier otro dato no tiene de dónde salir; si el diseño lo necesita, lo decide el handler y se acepta por escrito.
- **Son idempotentes**: un desenlace que llega repetido o tarde (el cobro ya no está en el estado de origen, porque otro camino ya lo aplicó) no hace nada y no es un error. Lo mismo vale para el aviso de la pasarela, la respuesta síncrona y el barrido, que pueden traer el mismo desenlace. Lo que sí arbitra el bloqueo optimista es que dos desenlaces **distintos** no se pisen.

## La reconciliación (obligatoria)

`reconciliation.sweep` es una operación con `schedule` (`CHK-PAYMENTS-SWEEP-INVALID`) que consulta a la pasarela todo lo que lleva más de `unansweredAfterSeconds` esperando un desenlace, según `record.awaitingSince`:

- el cobro en `pending`;
- el que espera al cliente en `actionRequired`;
- y el estado en vuelo de cada acción de seguimiento.

Aplica el desenlace que diga la pasarela con su operación de `outcomes`. Un cobro que la pasarela no conoce se da por fallido con `notReceived`. Es obligatoria en el schema, no por prudencia: es lo único que resuelve una acción cuya respuesta no llegó, porque repetirla a ciegas puede cobrar o devolver dos veces.

## Lo que no entra (todavía)

- El nombre de la pasarela, sus credenciales y sus URLs: dato de despliegue.
- Los métodos de pago asíncronos (PIX, boleto) y su estado `pending` prolongado.
- Las disputas y contracargos.
- Los pagos recurrentes y los payouts.

Cada uno entrará cuando un diseño lo necesite y su forma se haya contrastado con más de una pasarela: una capa escrita mirando una sola acaba con la forma de esa pasarela.
