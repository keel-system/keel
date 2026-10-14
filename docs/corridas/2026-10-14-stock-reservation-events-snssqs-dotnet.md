# Corrida `stock-reservation-events` — keel-dotnet con SNS/SQS (incremento 9h: control)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation-events` v1.0.0 (DSL 2.21, relacional, 6 capas) |
| Stack | `postgresql · snssqs` |
| Generador | `keel-dotnet@0.0.1` (con el incremento 9 entero: 9a–9g, `7afbfef`…`b437204`) |
| Diseño listo al generar | sí |
| Matriz final | **19/19 OK** (14 del documento + `FL-RES-001-E`…`I`, ver § Pruebas) |
| Huella del agente | 197 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 1 (el agente de infraestructura no sabía de `init-messaging.sh`, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 9 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de la 9e y las corridas del 2026-10-07 |

La corrida de control del incremento 9 de `PLAN-KEEL-DOTNET.md` (9h). Cambia **una sola variable** respecto a la 9e
(`2026-10-14-stock-reservation-events-dotnet.md`, RabbitMQ, 15/15, huella 9): el broker. Mide si la skill
`keel-dotnet-snssqs` lleva al agente a la misma huella y si el arnés sobre LocalStack (resiembra al levantar el broker,
lectura en barrido, abandono del outbox aparcado) aguanta un pipeline real, que hasta ahora solo había pisado
`broker-check`.

## Cómo terminó

**19/19**, con `score-scenarios.sh` en 0, sin `harnessPatches`, sin `culprit: harness` y sin fixes de `infra/` ni de la
solución. `dotnet test` 121/121 y el baseline de migraciones de `dotnet ef` verificado en vivo (41 elementos del
esquema). Los escenarios de mensajería —`FL-OBX-001` con LocalStack parado y vuelto (la resiembra de `StartBroker()`),
la doble entrega simultánea de `FL-CMP-001-C` (el archivo de cuerpo por llamada de la 9e), la reentrega sin guarda de
dominio de `FL-CNT-001-B` y el descarte a la DLQ de `FL-RES-004`— salieron con los helpers del arnés, sin ninguno
escrito a mano.

## Comparación

| | keel-dotnet · SNS/SQS | keel-dotnet · RabbitMQ (9e) | keel-nest · RabbitMQ | keel-spring · RabbitMQ |
|---|---|---|---|---|
| Matriz | **19/19** | 15/15 | 18/18 | 14/14 |
| Registrados por build | 197 | 196 | 176 | 220 |
| Reescritos | **9** | 9 | 9 | 8 |
| Reescritos por un hueco del generador | **0** | 0 | 0 | 0 |
| Huecos del generador | 1 (doc del agente de infraestructura) | 1 (el arnés) | 1 (un comentario) | 0 |

Los mismos 14 escenarios del documento en los cuatro; la cuenta cambia por los casos de validación que añade el agente
de pruebas (cinco aquí, uno en la 9e, cuatro en keel-nest).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los seis handlers de `Application/UseCases/` | TODO legítimo: la lógica de cada caso de uso |
| `Domain/Aggregate/Reservation.cs` | TODO legítimo: la creación, las transiciones y `NoteStockCount` |
| `Infrastructure/Messaging/BrokerBindings.cs` | TODO legítimo: el registro del dispatcher y de los listeners, el sitio previsto |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

**Los MISMOS nueve archivos que la 9e**, uno a uno: cambiar de broker no movió la huella fuera de `BrokerBindings.cs`.

**Archivos nuevos del agente**: `SnsSqs/SnsOutboxDispatcher.cs` (la línea sobre `SnsSqsConnection.Publish` con
`eventType` y `routingKey` como atributos, la de la skill) y `SnsSqs/Listeners.cs`: **tres** listeners, uno por
suscripción (en la 9e era uno para la cola compartida que enrutaba por tipo), cada uno con `Consume("<Suscripción>")`,
la comprobación del tipo aunque el filtro ya lo garantice, un ámbito de DI por mensaje, el orden del guard de su
mensaje (`AlreadyProcessed`/`Record` en `StockReserved` y `StockRejected`; `TryRecord` en `StockCountAdjusted`) y la
carrera resuelta (`InvalidStateTransitionException` o el 409 `CONCURRENT_MODIFICATION`) confirmada y registrada. Es el
listener de la skill casi literal. Más los ocho flujos, una base común de los flujos de reserva
(`ReservationFlowBase.cs`) y el baseline del pase de calidad. Ningún archivo de mensajería de build tocado: la conexión,
el consumo con la visibilidad, el puente, el relay y el registro de procesados funcionaron tal cual.

## Arreglos

- **El agente de infraestructura no ejecutaba `infra/init-messaging.sh`.** `up.sh` levanta LocalStack vacío, y
  `validate-infra.sh` falla con razón (`Topics: []`) hasta que alguien siembra la topología. El agente lo resolvió
  ejecutando el script —que la skill `keel-dotnet-snssqs` sí nombra— y lo anotó como hueco del generador. Lo es: el
  `keel-spring-infra` tiene un paso «Topología de mensajería» y su `infra-validation.md` una fila para el script;
  `keel-dotnet-infra` y el `infra-validation.md` de keel-dotnet no lo citaban, y la skill del broker no la lee el agente
  de infraestructura. Ahora el paso 3 del agente lo ejecuta tras cada `up.sh` y antes del sondeo, su reporte gana
  `messaging.provisioned`/`topology`, y la convención tiene su sección. Sin efecto en el resultado de esta corrida (el
  agente lo rodeó sin parchear nada), pero sí en lo que cuesta llegar a él.
  - **keel-nest tiene el mismo hueco latente** (`keel-nest-infra.md` no cita `init-messaging.sh`): ninguna corrida de
    keel-nest ha usado SNS/SQS. Sin tocar: queda anotado.
- Cosmético: el comentario de `AddMessageListeners` en `BrokerBindings.cs` juntaba con SNS/SQS dos frases en una línea
  de 190 columnas; ahora parte como con los otros brokers.

## Pruebas

`FL-RES-001-E`…`I` (los 400 `VALIDATION_ERROR` de sku vacío, en blanco y largo, cantidad menor que 1 y sin `orderId`)
los añadió el agente de pruebas por la checklist de `integration-tests.md`; no están en `validation-scenarios.md`. El
informe anota que `FL-RES-001-D` envejece la clave de idempotencia con un `UPDATE idempotency_record SET expires_at`:
es lo mismo que hizo la 9e, y la tabla es del generador (ningún generador trae un helper para envejecerla).

## designGaps

Ninguno.
