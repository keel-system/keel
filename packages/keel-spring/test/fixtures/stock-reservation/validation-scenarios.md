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
| confirmReservation | FL-RES-002 | usuarios |
| applyStockReserved | FL-RES-003 | suscripción (interna) |
| getReservation | todos | usuarios |
| releaseReservation | FL-CMP-001, FL-CMP-001-B | suscripción (interna) |
| reconcileReservations | — | programada; no alcanzable en caja negra |

`reconcileReservations` no tiene flujo, y no por falta de efecto observable —lo tiene: saca
la reserva de `awaitingStock` y llama al almacén— sino porque **el arnés es caja negra y un
cron no se alcanza desde fuera**. Es `uncovered` declarado, y lo cubre
`infra/check-idempotency.sh` en estático. El resto del encargo asíncrono sí se ejercita: el
camino feliz (FL-RES-003), el rechazo (FL-CMP-001) y su reentrega (FL-CMP-001-B).

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

## Encargo asíncrono al almacén

### FL-RES-002: confirmar publica el encargo y deja la reserva esperando

**Given**: existe la reserva `<r1>` de FL-RES-001 en `pending`.

**When**: `POST /api/v1/reservations/{r1}/confirm`.
**Then**:
1. Status `200` y `status` = `"awaitingStock"` — **no** `confirmed`: esta operación no
   conoce el desenlace, solo deja la reserva esperándolo.
2. Se publica `StockReservationRequested` en el canal `stockEvents`, con `orderId` = `<o1>`,
   `sku` y `quantity` de la reserva.
3. El proveedor **no** recibe ninguna llamada HTTP: el encargo viaja publicado.
4. `GET /api/v1/reservations/{r1}` sigue devolviendo `awaitingStock` — es el estado en el
   que se queda si el almacén no responde nunca, y el que barre la reconciliación.

### FL-RES-003: el almacén confirma y la reserva sale de la espera

**Given**: `<r1>` está en `awaitingStock` (FL-RES-002).

**When**: llega el evento entrante `StockReserved` con payload `{orderId: <o1>}`.
**Then**:
1. Se ejecuta `applyStockReserved`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"confirmed"` y `releaseReason` =
   `null`.
3. Es el desenlace **bueno** del encargo: sin él la reserva no saldría nunca de la espera
   por la vía normal, y el barrido acabaría rindiéndose con todas.

## Compensación: el almacén rechaza a posteriori

### FL-CMP-001: llega el rechazo y la reserva se libera

Cubre `inventory.compensations[0]` (`undoes: reserveStock`). La operación compensadora es
`releaseReservation`, interna y disparada solo por la suscripción.

**Given**: la reserva `<r1>` está en `confirmed` (FL-RES-003).

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
3. Es lo que garantizan las dos mitades juntas: la envoltura Keel deduplica en el listener
   por `metadata.eventId`, y la transición declarada (`from: [awaitingStock, confirmed] →
   released`) rechaza la segunda aplicación aunque el mensaje llegara por otro camino —
   `released` no está en ningún `from`. Sin este escenario, una
   implementación que compensa dos veces pasa FL-CMP-001 sin que nada lo delate.
