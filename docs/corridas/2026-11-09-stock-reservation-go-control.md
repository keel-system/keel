# Corrida de control de los plazos (DSL 2.26) — `stock-reservation` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.2.0 (DSL 2.26, relacional), con el plazo `pending → expired` (`reservationHoldMinutes` desde `createdAt`, lo ejecuta `expireReservation`) |
| Stack | `postgresql · rabbitmq` (sin identidad, caché ni storage; telemetría `none`) |
| Generador | `keel-go@0.2.0` (`2bd081c8` al generar) |
| Diseño listo al generar | sí (`--ready` 13/13, sin `--accept-unready`) |
| Papel | control |
| Matriz final | **23/23 OK** a la primera |
| Huella del agente | 269 archivos registrados por `build`, 0 adoptados, **11 reescritos**, 0 borrados |
| Clasificación de la huella | 11 TODO (8 handlers, `reservation_behavior.go`, `cmd/server/broker.go` y el README) · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 1 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\stock-226-go-postgre-rabbit\services\stock-reservation-go`. Corrida de control del
incremento 13 de `PLAN-DSL-226-PLAZOS.md` en keel-go.

## Lo que medía

FL-EXP-001 y FL-EXP-001-B en verde, con el rechazo tardío EN EL DOMINIO: `reservation.go` (con cabecera de generado,
fuera del alcance del agente) devuelve `ErrReservationExpired` cuando `createdAt + ReservationPending() <= now`; el agente
solo escribió `reservation_behavior.go`. `ConfirmReservationCommandHandler` lleva el `Clock` y los plazos. La prueba
(`tests/integration/reservation_deadline_test.go`) envejece con `AgeForDeadline` y admite 410 `RESERVATION_EXPIRED` o 409
`INVALID_STATE_TRANSITION`. Nada del cronómetro en la huella. Calidad limpia (vet, staticcheck, gofmt, tidy,
govulncheck).

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: el informe, la huella, el dominio y la prueba del plazo.

## designGaps

- `terminal-count-note` — `noteStockCount` sobre una reserva terminal (`released` o `expired`) no declara rechazo ni aceptación; el agente la aplica sin rechazo. `expired` es terminal nuevo de la v1.2.0
