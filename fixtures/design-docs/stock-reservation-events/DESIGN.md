# stock-reservation-events — Documento de diseño

> specs/stock-reservation-events v1.0.0. Diseño cerrado al preparar la corrida del incremento 9 de
> keel-nest (2026-10-07); las decisiones las tomó quien la preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Reserva stock para un pedido **encargándoselo al almacén por eventos**: la reserva se registra, se
confirma publicando el encargo, y su desenlace llega por un aviso del almacén — que la confirma, la
libera o corrige su recuento. Es la variante de `stock-reservation` que mide la **mensajería** de los
generadores: outbox, consumo deduplicado en los dos órdenes del guard y compensación irrepetible.

Queda fuera, a propósito: la llamada saliente al almacén y la reconciliación por reloj de las reservas
que se quedan esperando (las tiene `stock-reservation`), la autenticación (API interna) y el borrado.
Motivos en § 6.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Reservation` | raíz | La reserva de `quantity` unidades de un `sku` para un pedido (`orderId`, clave natural). |

Ciclo de vida: `pending` → `awaitingStock` (confirmada y encargada) → `confirmed` (el almacén bloqueó el
stock) o `released` (el almacén la rechazó; `releaseReason` dice por qué). Desde `confirmed` también se
puede liberar. `released` es terminal. `lastCountedQuantity` y `adjustmentCount` registran las
correcciones de recuento del almacén, sin mover el estado.

## 3. Invariantes y reglas clave

- Una reserva por pedido: la clave natural es `orderId`.
- Confirmar solo desde `pending`; liberar desde `awaitingStock` o `confirmed`, nunca dos veces.
- Cada recuento suma uno a `adjustmentCount`: aplicar dos veces el mismo es un error que se ve.
- El encargo se publica en la misma transacción que la confirmación (outbox).

## 4. Qué hace

| Operación | Puerta | Éxito | Errores |
|---|---|---|---|
| `createReservation` | `POST /api/v1/reservations` (con `Idempotency-Key`) | `201` con la reserva | `409 RESERVATION_ALREADY_EXISTS`, `409 IDEMPOTENCY_KEY_IN_PROGRESS`/`_REUSED`, `400 VALIDATION_ERROR` |
| `confirmReservation` | `POST /api/v1/reservations/{id}/confirm` | `200`, reserva en `awaitingStock` y `StockReservationRequested` publicado | `404 RESERVATION_NOT_FOUND`, `409 INVALID_STATE_TRANSITION` |
| `getReservation` | `GET /api/v1/reservations/{id}` | `200` con la reserva | `404 RESERVATION_NOT_FOUND` |
| `applyStockReserved` | suscripción `StockReserved` | reserva en `confirmed` | sin reserva → descarte |
| `noteStockCount` | suscripción `StockCountAdjusted` | recuento anotado | sin reserva → descarte |
| `releaseReservation` | suscripción `StockRejected` | reserva en `released` con su motivo | sin reserva → descarte |

## 5. Fronteras e integraciones

Publica `StockReservationRequested` en el canal `stockEvents` y consume del almacén (`inventory`), por el
mismo canal y en la envoltura Keel, `StockReserved`, `StockCountAdjusted` y `StockRejected`. Las tres
suscripciones comparten cola, reintentan el fallo pasajero cinco veces con backoff exponencial y llevan
a su descarte lo que no se puede procesar. No llama a nadie por HTTP.

## 6. Decisiones de diseño (qué / por qué)

- **Outbox**: perder el encargo con el broker caído dejaría la reserva esperando un desenlace que nadie
  va a mandar.
- **Idempotencia solo en `createReservation`**: confirmar la frena su transición.
- **Deduplicación en los dos órdenes del guard**: con guarda de dominio (confirmación y rechazo) se
  registra lo procesado DESPUÉS; sin ella (recuento) ANTES, aceptando perder un recuento si el handler
  falla, porque repetirlo corrompería el contador.
- **Bloqueo optimista en la raíz**: la compensación puede entregarse dos veces a la vez.
- **Sin autenticación**: la API es interna y la llama solo el sistema de pedidos, detrás de su red.
- **Sin reconciliación**: si el almacén no responde nunca, la reserva se queda en `awaitingStock` y se ve
  en `getReservation`. Es la silueta de `stock-reservation`, y aquí se mide otra cosa.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las tres rutas, la forma de la reserva con `null` explícito, los `code`, el evento publicado y
los tres que consume, con su envoltura Keel.
Adaptable: el broker (se elige al generar), la política de reintentos y la cota de los motivos.

### Supuestos y limitaciones

- No hay reconciliación por reloj ni llamada de cancelación al almacén.
- No hay borrado ni retención: una reserva liberada sigue siendo el registro de lo que pasó.
- Sin autenticación ni `cors`.

### Cómo reutilizarlo

Para la versión con reconciliación y cancelación saliente, partir de `stock-reservation`. Para otro
encargo asíncrono, cambiar la entidad y los tres eventos: el patrón (estado de espera, desenlace por
evento, compensación con dos `from`) se mantiene.
