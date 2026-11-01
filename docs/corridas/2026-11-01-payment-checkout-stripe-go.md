# Corrida `payment-checkout` con Stripe — keel-go (incremento 13d)

| Etiqueta | Valor |
|---|---|
| Diseño | `payment-checkout` v1.2.0 (DSL 2.21, relacional, con `payments`) |
| Stack | `postgresql · rabbitmq · keycloak · stripe` |
| Generador | `keel-go@0.1.0` (`87457af1`, incrementos 13b y 13c) |
| Diseño listo al generar | sí |
| Matriz final | **25/25 OK** a la primera (57 casos, sin arbitraje) |
| Huella del agente | 274 archivos registrados por `build`, 0 adoptados, **20 reescritos**, 0 borrados |
| Clasificación de la huella | 18 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 en `design-gaps.yaml` (el agente dio por cubierto `payments-cancel-reason` con la decisión aceptada; ver § Lo que dijo el informe) |
| Huecos del generador | 1, compartido con la corrida de MercadoPago: la puerta por la que entra `requestCharge` (§ Arreglos) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo |

La primera corrida de pagos de keel-go, sobre el diseño y el stack de sus seis gemelas (`*payment-checkout*`, 25/25 en
keel-spring, keel-nest y keel-dotnet). Se lanzó a la vez que la de MercadoPago, cada una en su workspace:
`spring-live-test/corrida-payment-checkout-stripe-go`.

## Antes del pipeline

`keel-go build` escribió 274 archivos con el stack sembrado en `keel-stack.json`, con el aviso esperado de
`CHK-PAYMENTS-OUTCOME-INPUT-UNBACKED` y las skills `keel-go-database`, `keel-go-rabbitmq`, `keel-go-keycloak`,
`keel-go-payments` y `keel-go-stripe`. Sobre una copia, para no tocar la huella: `go mod tidy` sin mover ninguno de los 8
requisitos directos, gofmt, `go vet` y staticcheck vacíos (con y sin `-tags integration`), `go build` sin cgo, `go test ./...`
en verde y `check-idempotency.sh` en ROJO con sus hallazgos del agente (los eventos de dominio y el `OutboxDispatcher`).

## Cómo terminó

**25/25** en la primera puntuación, sin `harnessPatches`, sin `culprit: harness` y sin fixes de `infra/` ni de `go.mod`.
`keel-go-quality` en verde: vet, staticcheck, gofmt, `go mod tidy -diff` y govulncheck; quitó 34 `//lint:ignore U1000`
que build deja en los campos de cada handler y que el agente ya usaba.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 57 casos, 0 `<failure>` y 0 `<skipped>`, en 1425 s.
- gofmt vacío; `go vet` y staticcheck limpios con y sin `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en VERDE.
- `specs.sha256` intacto y `keel-go build --check` al día.

Lo nuevo de Go, en el código del agente:
- **El reclamo del barrido** en los dos `payment_queries.go`, como enseña la skill: `ClaimForReconciliation(ctx, id, seen,
  now)` con `r.tx.write` y `UPDATE payments SET awaiting_since = $1 WHERE id = $2 AND awaiting_since = $3`, y los candidatos
  con `FindAwaitingBefore` sobre los cinco estados en vuelo. FL-CLU-001 (dos réplicas) en verde.
- **`payment_outcome_choices.go`**: el `cancelReason` de la decisión aceptada (`requested` si el cobro venía de `canceling`,
  `expired` si no), leyendo el cobro con el repositorio del registro.

## Comparación

| | keel-go Stripe | keel-go MercadoPago | keel-dotnet Stripe | keel-nest Stripe | keel-spring Stripe |
|---|---|---|---|---|---|
| Diseño | v1.2.0 | v1.2.0 | v1.2.0 | v1.1.0 | v1.1.0 |
| Matriz | 25/25 a la primera | 25/25 a la primera | 25/25 (21 en la primera) | 25/25 | 25/25 |
| Registrados por build | 274 | 274 | 322 | — | — |
| Reescritos | **20** | **20** | 21 | 20 | 20 |
| Del generador | 0 | 0 | 1 | — | — |

La huella de las gemelas, archivo por archivo: los mismos 20 con las dos pasarelas, y la misma clasificación que keel-dotnet
sin su archivo del generador (18 TODO · 2 consulta).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los trece handlers de `internal/application/` | TODO legítimo |
| `internal/domain/{payment,saved_payment_method}_behavior.go` | TODO legítimo |
| `internal/application/payment_outcome_choices.go` | TODO legítimo: el `cancelReason` que la capa no nombra (el aceptado en `decisions.yaml`) |
| `cmd/server/broker.go` | TODO legítimo: el dispatcher del outbox y el listener de RabbitMQ |
| `README.md` | TODO legítimo |
| `internal/domain/payment_queries.go` e `internal/infrastructure/postgres/payment_queries.go` | Consulta de negocio: el reclamo y los candidatos del barrido, los de `references/reconciliation.md` |

**Archivos nuevos del agente**: `internal/application/payment_support.go` (lo común de los handlers: revertir un cobro en
vuelo, releerlo, la pasarela que no contestó… y el marcador `FromEvent`, ver § Arreglos) y los siete de flujos de
`tests/integration/`.

## Arreglos

- **La puerta por la que entra `requestCharge`: keel-go no la emitía.** El diseño distingue «por HTTP» (una precondición
  incumplida es un 422) de «por la suscripción» (el cobro queda `failed` y sale su evento). Los otros tres generadores llevan
  desde `2b7c60e5` la pieza neutral `keel-core/gen/entry-gates.js` —el mensaje lleva `entryGate`, que el endpoint fija a
  HTTP— porque cinco corridas lo habían resuelto a mano de cinco formas; keel-go se construyó sin ella. Las dos corridas de
  Go la reinventaron: aquí un marcador de contexto `FromEvent(ctx)` que pone el listener, y en MercadoPago `ViaSubscription`.
  Ahora keel-go emite `internal/application/entry_gate.go` (el tipo `EntryGate` con sus cuatro constantes), el campo
  `EntryGate` con `json:"-"` en el mensaje (es el cuerpo de la petición: sin eso un cliente elegiría por dónde entra), el
  endpoint que lo fija a `EntryGateHTTP`, la nota del handler y la de la suscripción con `EntryGateSubscription`, y el reloj
  con `EntryGateSchedule`. Como Go no exige un campo en un literal, `NewUseCases` envuelve el handler con `requireEntryGate`,
  que se niega a despachar un mensaje sin su puerta (prueba emitida `entry_gate_test.go`). Lo compara con los otros tres
  `keel-dotnet/test/entry-gate.test.js`, ahora a cuatro.

## Lo que dijo el informe y lo que resultó ser

- **«Sin huecos de diseño nuevos: el límite de `cancelPayment` ya está decidido en `decisions.yaml`»**: a medias. La
  decisión pide `expired` cuando la pasarela RECHAZA la anulación porque la autorización caducó, pero el adaptador que
  genera build traduce ese rechazo al mismo `GatewayCanceled` que una anulación confirmada, y el aplicador, que ve el cobro
  en `canceling`, elige `requested`. La decisión no es realizable con la capa de hoy: es `payments-cancel-reason`, el que
  la corrida de MercadoPago sí reportó (ver allí).
- **«Dos `score-scenarios.sh` simultáneos dieron falsos FALLO en FL-REC-*»**: cierto y esperado. Comparten servidor, base
  e infra; no es un defecto.
- **«La suite supera los 20 min»**: cierto (1425 s). Los FL-REC esperan el umbral del barrido.

## Observaciones

- Fuera de la huella, en la raíz del proyecto: un `excalidraw.log` de un servidor MCP arrancado con ese directorio de
  trabajo, como en la 12e.

## designGaps

Ninguno en `design-gaps.yaml`. El que existe es `payments-cancel-reason` (registrado en la corrida de MercadoPago).
