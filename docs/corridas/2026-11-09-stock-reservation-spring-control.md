# Corrida de control de los plazos (DSL 2.26) — `stock-reservation` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.2.0 (DSL 2.26, relacional), con el plazo `pending → expired` (`reservationHoldMinutes` desde `createdAt`, lo ejecuta `expireReservation`) |
| Stack | `postgresql · rabbitmq` (sin identidad, caché ni storage; telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`2bd081c8` al generar) |
| Diseño listo al generar | sí (`--ready` 13/13, sin `--accept-unready`) |
| Papel | control |
| Matriz final | **23/23 OK** en la primera generación |
| Huella del agente | 297 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Clasificación de la huella | 9 TODO (8 handlers y el agregado `Reservation`) · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\stock-226-spring-postgre-rabbit\services\stock-reservation-spring`. Es la corrida de control
del incremento 13 de `PLAN-DSL-226-PLAZOS.md` en keel-spring.

## Lo que medía

FL-EXP-001 y FL-EXP-001-B en verde, con el rechazo tardío EN EL DOMINIO: `Reservation.transitionTo(target, now, deadlines)`
lanza `ReservationExpiredError` cuando `createdAt + reservationPending <= now` y el destino no es `expired`, tal como lo
dejó build (`lateGuardBlock`); el agente solo rellenó los métodos semánticos. `ConfirmReservationCommandHandler` pasa
`clock.instant()` y `StockReservationDeadlines`, y `ExpireReservationCommandHandler` trata la transición ya hecha como
«nada que caducar». La prueba envejece la reserva con `ageForDeadline` y admite el 410 o, si el cronómetro se adelantó, el
409, como pide el escenario; afirma `releaseReason` nulo.

Nada del cronómetro está en la huella: `TimerPoller`, el almacén JDBC, el handler del plazo, el armado en el `save` y las
purgas siguen como los emitió build.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: se leyó el JUnit (16 clases, ninguna con `<failure>`), la huella y el agregado.

## Incidencia de la generación

FL-REC-002 falló una vez tras el primer pase de calidad: la prueba contaba los `DELETE` justo al ver `released`, que hace
commit antes de `cancelStock`. El árbitro lo clasificó primero como `code` y lo reclasificó como `culprit: test` con el
volcado de WireMock; se corrigió la espera en las tres pruebas de reconciliación, sin tocar `src/main`. Es una carrera de
la prueba, ajena al plazo.

## designGaps

Ninguno.
