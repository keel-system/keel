# stock-reservation — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/stock-reservation v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Este archivo no es un diseño real: es el escenario
> **mínimo** que ejercita la cadena entera de compensación e idempotencia contra
> infraestructura real. Cada flujo existe para poner a prueba uno de los cuatro mecanismos,
> y ninguno está de adorno.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). `createdAt` se verifica **por forma**, nunca por valor.
- **Identificadores**: `uuid` v4 canónico. Se verifican por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se
  omite. `releaseReason` es nulo hasta que la compensación lo escribe.
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios
  fijan solo el `code` y el status HTTP.
- **Idempotencia de petición**: `createReservation` declara `idempotency` con
  `ttlSeconds: 3600`. Cada request lleva un `Idempotency-Key` **uuid nuevo**, salvo en el
  escenario que prueba la deduplicación, que repite el anterior a propósito.
- **Idempotencia saliente**: la llamada a `inventory.reserveStock` viaja con la cabecera
  `Idempotency-Key` que genera el servicio a partir del contenido. Se verifica sobre el
  proveedor de prueba, no sobre logs.
- **Proveedor de prueba**: `inventory` es WireMock. Cada flujo programa sus respuestas y
  cuenta las llamadas recibidas; el arnés lo resetea entre flujos.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createReservation | FL-RES-001, FL-RES-001-B | usuarios |
| confirmReservation | FL-RES-002, FL-RES-002-B | usuarios |
| getReservation | todos | usuarios |
| releaseReservation | FL-CMP-001, FL-CMP-001-B | suscripción (interna) |
| reconcileReservations | — | programada; sin efecto observable declarado |

`reconcileReservations` no tiene flujo: el diseño declara **cuándo** corre, no qué corrige.
Es un hueco declarado de esta fixture — lo que se prueba aquí es que la compensación por
evento funciona, no la reconciliación por silencio.

## Reserva de stock

### FL-RES-001: se registra una reserva

**When**: `POST /api/v1/reservations` con `{orderId: <o1>, sku: "SKU-1", quantity: 2}` y un
`Idempotency-Key` propio `<k1>`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `orderId` = `<o1>`, `status` = `"pending"`,
   `releaseReason` = `null` y `createdAt` con forma de instante.
3. `GET /api/v1/reservations/{id}` devuelve lo mismo.

#### FL-RES-001-B: el cliente reintenta con la misma clave

**When**: se repite **exactamente** el mismo `POST` con el **mismo** `Idempotency-Key` `<k1>`.
**Then**:
1. La respuesta es la **misma** que la primera vez, con el **mismo** `id`: la repetición
   reproduce el resultado, no ejecuta de nuevo.
2. No se crea una segunda reserva: el `orderId` sigue teniendo una sola, y un `POST` con
   `<o1>` y **otra** clave devuelve `409 RESERVATION_ALREADY_EXISTS`.

## Confirmación contra el almacén

### FL-RES-002: confirmar bloquea el stock en el proveedor

**Given**: existe la reserva `<r1>` de FL-RES-001 en `pending`; `inventory.reserveStock`
responde `200 {reserved: true}`.

**When**: `POST /api/v1/reservations/{r1}/confirm`.
**Then**:
1. Status `200` y `status` = `"confirmed"`.
2. El proveedor recibió **exactamente una** llamada a `POST /stock/reservations`.
3. Esa llamada llevaba la cabecera `Idempotency-Key`: es lo que impide que un reintento
   nuestro bloquee el stock dos veces al otro lado.

#### FL-RES-002-B: el almacén no responde

**Given**: existe una reserva `<r2>` en `pending`; `inventory.reserveStock` devuelve `503`.

**When**: `POST /api/v1/reservations/{r2}/confirm`.
**Then**:
1. Status `502` con `code` = `"STOCK_UNAVAILABLE"`.
2. `<r2>` sigue en `pending`: sin bloqueo no hay reserva confirmada.
3. Los reintentos del cliente HTTP repiten la llamada con la **misma** clave de
   idempotencia, no con una nueva.

## Compensación: el almacén rechaza a posteriori

### FL-CMP-001: llega el rechazo y la reserva se libera

Cubre `inventory.compensations[0]` (`undoes: reserveStock`). La operación compensadora es
`releaseReservation`, interna y disparada solo por la suscripción.

**Given**: la reserva `<r1>` está en `confirmed` (FL-RES-002).

**When**: llega el evento entrante `StockRejected` con payload
`{orderId: <o1>, reason: "stock retirado por caducidad"}` y `messageId` `<m1>`.
**Then**:
1. Se ejecuta `releaseReservation`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"released"` y `releaseReason` con el
   motivo del evento: el estado propio vuelve, no se queda donde lo dejó un trabajo que ya
   no existe.

#### FL-CMP-001-B: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `StockRejected`, con idéntico payload y el
**mismo** `messageId` `<m1>`.
**Then**:
1. `<r1>` sigue en `released` y `releaseReason` no cambia: ningún segundo efecto.
2. El servicio **confirma** el mensaje sin volver a procesarlo — no acaba en la DLQ ni
   reintentando: una reentrega es el comportamiento normal de cualquier broker, no un fallo.
3. Es lo que garantizan las dos mitades juntas: `contract.messageId` deduplica en el
   listener, y la transición declarada (`from: [confirmed] → released`) rechaza la segunda
   aplicación aunque el mensaje llegara por otro camino. Sin este escenario, una
   implementación que compensa dos veces pasa FL-CMP-001 sin que nada lo delate.
