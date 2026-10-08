# stock-reservation — Documento de diseño

> specs/stock-reservation v1.1.0. Diseño cerrado al preparar la corrida del incremento 11 de keel-nest
> (2026-10-07); las decisiones las tomó quien la preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Reserva stock para un pedido **encargándoselo al almacén**: la reserva se registra, se confirma publicando
el encargo, y su desenlace llega por un aviso del almacén — que la confirma, la libera o corrige su
recuento. Si el aviso **no llega nunca**, un barrido por reloj se rinde: libera la reserva y le cancela el
bloqueo al almacén con una llamada HTTP. Es el diseño que mide la cadena entera de compensación e
idempotencia de los generadores: idempotencia de petición, outbox, consumo deduplicado en los dos órdenes
del guard, compensación irrepetible, reconciliación con reclamo entre réplicas y llamada saliente
resiliente con clave de idempotencia.

Queda fuera, a propósito: la autenticación (API interna), la caché, el almacenamiento de archivos y el
borrado. Motivos en § 6.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Reservation` | raíz | La reserva de `quantity` unidades de un `sku` para un pedido (`orderId`, clave natural). |

Ciclo de vida: `pending` → `awaitingStock` (confirmada y encargada; `reserveStockAwaitingSince` dice desde
cuándo espera) → `confirmed` (el almacén bloqueó el stock) o `released` (el almacén la rechazó, o el barrido
se rindió; `releaseReason` dice por qué). Desde `confirmed` también se puede liberar. `released` es
terminal. `lastCountedQuantity` y `adjustmentCount` registran las correcciones de recuento del almacén,
sin mover el estado.

## 3. Invariantes y reglas clave

- Una reserva por pedido: la clave natural es `orderId`.
- Confirmar solo desde `pending`; liberar desde `awaitingStock` o `confirmed`, nunca dos veces.
- Cada recuento suma uno a `adjustmentCount`: aplicar dos veces el mismo es un error que se ve.
- El encargo se publica en la misma transacción que la confirmación (outbox).
- Una reserva que lleva más de 30 minutos esperando al almacén se libera con el motivo «sin respuesta del
  almacén», y se le cancela el bloqueo al almacén; las que esperan menos no se tocan.

## 4. Qué hace

| Operación | Puerta | Éxito | Errores |
|---|---|---|---|
| `createReservation` | `POST /api/v1/reservations` (con `Idempotency-Key`) | `201` con la reserva | `409 RESERVATION_ALREADY_EXISTS`, `409 IDEMPOTENCY_KEY_IN_PROGRESS`/`_REUSED`, `400 VALIDATION_ERROR` |
| `confirmReservation` | `POST /api/v1/reservations/{id}/confirm` | `200`, reserva en `awaitingStock` y `StockReservationRequested` publicado | `404 RESERVATION_NOT_FOUND`, `409 INVALID_STATE_TRANSITION` |
| `getReservation` | `GET /api/v1/reservations/{id}` | `200` con la reserva | `404 RESERVATION_NOT_FOUND` |
| `applyStockReserved` | suscripción `StockReserved` | reserva en `confirmed` | sin reserva → descarte; ya liberada → sin efecto |
| `noteStockCount` | suscripción `StockCountAdjusted` | recuento anotado | sin reserva → descarte |
| `releaseReservation` | suscripción `StockRejected` | reserva en `released` con su motivo | sin reserva → descarte |
| `reconcileReservations` | reloj, cada minuto | las reservas atascadas, en `released`, y su bloqueo cancelado | — |

## 5. Fronteras e integraciones

Publica `StockReservationRequested` en el canal `stockEvents` y consume del almacén (`inventory`), por el
mismo canal y en la envoltura Keel, `StockReserved`, `StockCountAdjusted` y `StockRejected`. Las tres
suscripciones reintentan el fallo pasajero cinco veces con backoff exponencial y llevan a su descarte lo
que no se puede procesar.

Llama al almacén por HTTP en un solo sitio: `DELETE /stock/reservations/{orderId}` (`inventory.cancelStock`),
desde el barrido. La llamada lleva `Idempotency-Key` (la misma en cada reintento), corta a los 3 s, se
reintenta hasta tres veces solo ante timeout o corte de conexión —un 5xx no se repite—, tiene circuito
(50 % de fallos sobre 10 llamadas lo abre 20 s) y, si no sale, se ignora: la reserva se libera igual.

## 6. Decisiones de diseño (qué / por qué)

- **Outbox**: perder el encargo con el broker caído dejaría la reserva esperando un desenlace que nadie
  va a mandar.
- **Idempotencia en `createReservation` y clave saliente en `cancelStock`**: confirmar la frena su
  transición; una cancelación reintentada sin la misma clave sería otra cancelación para el almacén.
- **Deduplicación en los dos órdenes del guard**: con guarda de dominio (confirmación y rechazo) se
  registra lo procesado DESPUÉS; sin ella (recuento) ANTES, aceptando perder un recuento si el handler
  falla, porque repetirlo corrompería el contador.
- **Reconciliación que se rinde**: un encargo sin desenlace no produce ningún evento; solo un barrido lo
  ve. Se rinde en vez de reencargar, porque un segundo encargo con otro `eventId` sería otro para el
  almacén. Corre en todas las réplicas y reclama con una marca persistida y caducable.
- **La cancelación no repite un 5xx y se ignora si falla**: es una escritura ajena (repetir un 5xx puede
  ejecutarla dos veces) sobre un encargo cuyo desenlace ya no sabemos; el bloqueo huérfano es del almacén.
- **Bloqueo optimista en la raíz**: la compensación puede entregarse dos veces a la vez, y el barrido
  puede coincidir con el desenlace del almacén.
- **Sin autenticación**: la API es interna y la llama solo el sistema de pedidos, detrás de su red.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las tres rutas, la forma de la reserva con `null` explícito, los `code`, el evento publicado y
los tres que consume, con su envoltura Keel, y la llamada de cancelación con su clave de idempotencia.
Adaptable: el broker y el motor (se eligen al generar), la política de reintentos, el umbral de paciencia
del barrido (`unansweredAfterSeconds`) y la resiliencia de la llamada.

### Supuestos y limitaciones

- La marca de espera no sale en ninguna respuesta: que se estampe al encargar no se comprueba en caja
  negra, lo vigila el gate estático.
- No hay borrado ni retención: una reserva liberada sigue siendo el registro de lo que pasó.
- Sin autenticación ni `cors`.

### Cómo reutilizarlo

Para otro encargo asíncrono, cambiar la entidad, los tres eventos y la llamada de cancelación: el patrón
(estado de espera con su marca, desenlace por evento, compensación con dos `from`, barrido que se rinde y
deshace) se mantiene. Sin reconciliación ni llamada saliente, partir de `stock-reservation-events`.
