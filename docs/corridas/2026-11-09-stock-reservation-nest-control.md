# Corrida de control de los plazos (DSL 2.26) — `stock-reservation` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.2.0 (DSL 2.26, relacional), con el plazo `pending → expired` (`reservationHoldMinutes` desde `createdAt`, lo ejecuta `expireReservation`) |
| Stack | `postgresql · rabbitmq` (sin identidad, caché ni storage; telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`2bd081c8` al generar) |
| Diseño listo al generar | sí (`--ready` 13/13, sin `--accept-unready`) |
| Papel | control |
| Matriz final | **23/23 OK** en la primera puntuación |
| Huella del agente | 277 archivos registrados por `build`, 0 adoptados, **11 reescritos**, 0 borrados |
| Clasificación de la huella | 11 TODO (8 handlers, el agregado `Reservation`, `broker-bindings.ts` y el README) · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\stock-226-nest-postgre-rabbit\services\stock-reservation-nest`. Corrida de control del
incremento 13 de `PLAN-DSL-226-PLAZOS.md` en keel-nest.

## Lo que medía

FL-EXP-001 y FL-EXP-001-B en verde, con el rechazo tardío EN EL DOMINIO: `Reservation.transitionTo(target, now, deadlines)`
lanza `ReservationExpiredError` cuando `createdAt + reservationPendingMs <= now` y el destino no es `expired`, como lo
dejó build. `confirm-reservation-command-handler.ts` pasa `clock.now()` y `StockReservationDeadlines`. La prueba
(`test/integration/reservation-expiry.test.ts`) envejece con `ageForDeadline`, admite 410 `RESERVATION_EXPIRED` o 409
`INVALID_STATE_TRANSITION` y afirma `releaseReason` nulo. Igual que en keel-spring: nada del cronómetro en la huella.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: el informe, la huella y el agregado. La traza de pila que el informe anotaba en
`npm test` (68/68 en verde) se reprodujo: es el log de la prueba emitida de la API en el perfil `test`, sin base de datos
(«Sin base de datos en este perfil»), que el mediator corta antes del handler. Esperado, no es defecto.

## designGaps

Ninguno.
