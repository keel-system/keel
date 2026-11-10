# Corrida de control de los plazos (DSL 2.26) — `stock-reservation` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.2.0 (DSL 2.26, relacional), con el plazo `pending → expired` (`reservationHoldMinutes` desde `createdAt`, lo ejecuta `expireReservation`) |
| Stack | `postgresql · rabbitmq` (sin identidad, caché ni storage; telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`2bd081c8` al generar) |
| Diseño listo al generar | sí (`--ready` 13/13, sin `--accept-unready`) |
| Papel | control |
| Matriz final | **23/23 OK** (21/23 en la primera puntuación, dos `culprit: test`) |
| Huella del agente | 307 archivos registrados por `build`, 0 adoptados, **11 reescritos**, 0 borrados |
| Clasificación de la huella | 11 TODO (8 handlers, el agregado `Reservation`, `BrokerBindings.cs` y el README) · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\stock-226-dotnet-postgre-rabbit\services\stock-reservation-dotnet`. Corrida de control del
incremento 13 de `PLAN-DSL-226-PLAZOS.md` en keel-dotnet.

## Lo que medía

FL-EXP-001 y FL-EXP-001-B en verde, con el rechazo tardío EN EL DOMINIO: `Reservation` lanza `ReservationExpiredError`
cuando `CreatedAt + deadlines.ReservationPending <= now`, como lo dejó build. `ConfirmReservationCommandHandler` pasa
`timeProvider.GetUtcNow()` y `StockReservationDeadlines`. La prueba (`ReservationExpiryFlow.cs`) envejece con
`AgeForDeadline`, admite 410 `RESERVATION_EXPIRED` o 409 `INVALID_STATE_TRANSITION`, espera `expired` y compara el JSON
entero. Nada del cronómetro en la huella.

## La primera puntuación

FL-REC-002 y FL-REC-003, `culprit: test`: la misma carrera que en keel-spring, contar las llamadas al proveedor antes de
que el servidor las haga (la liberación se confirma antes de llamar). `WaitForStubCalls` en esas pruebas, en FL-REC-001 y
en FL-CLU-002; el servidor no cambió. Los dos agentes que la vieron (spring y dotnet) la resolvieron en la prueba: es una
espera que el arnés podría ofrecer hecha.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: el informe, la huella, el agregado y la prueba del plazo.

## designGaps

Ninguno.
