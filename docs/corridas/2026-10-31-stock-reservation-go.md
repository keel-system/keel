# Corrida `stock-reservation` — keel-go (incremento 11e)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation` v1.1.0 (DSL 2.23, relacional, 8 capas: con `http-clients`, `dependencies` y `messaging`) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-go@0.1.0` (con el incremento 11: 11b–11d, `fb572649`…`26e23127`) |
| Diseño listo al generar | sí |
| Matriz final | **21/21 OK** (una ronda de arbitraje: FL-REC-002, `culprit: test`) |
| Huella del agente | 216 archivos registrados por `build`, 0 adoptados, **10 reescritos**, 0 borrados |
| Clasificación de la huella | 10 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-08 |

La corrida del incremento 11 de `PLAN-KEEL-GO.md`, sobre el MISMO diseño y el mismo stack que sus gemelas
(`2026-10-08-stock-reservation-{nest,spring}.md` y `2026-10-14-stock-reservation-dotnet.md`; la fixture solo cambia la
versión del DSL, de 2.21 a 2.23, y el `DESIGN.md` es el de la gemela de keel-dotnet), por la puerta de `--ready` (13/13)
y sin `--accept-unready`. Workspace: `spring-live-test/corrida-stock-reservation-go`. Mide lo que ninguna red mide: el
barrido de reconciliación con `AgeForReconciliation` sobre un cron real, la compensación, el reintento con la MISMA clave
contra el WireMock de `infra/` (FL-REC-002, «exactamente dos»), el circuito, y el clúster de dos réplicas (FL-CLU-*), que
fue lo que paró a mitad la corrida de keel-dotnet y en keel-go nació en el 11d.

## Antes del pipeline

`keel-go build` escribió 216 archivos con el stack sembrado en `keel-stack.json` y las skills `keel-go-database`,
`keel-go-rabbitmq` y `keel-go-httpclient`. `go mod tidy`, `gofmt -l .` vacío, `go vet` y `staticcheck` (con y sin
`-tags integration`), `go build` sin cgo y `go test ./...` (13 paquetes) en verde; `check-idempotency.sh` en ROJO en las
siete familias con trabajo del agente y `outboundIdempotency` en verde (la clave saliente la cablea build), como en
keel-dotnet.

## Cómo terminó

**21/21**, con `score-scenarios.sh` en 0, sin `harnessPatches`, sin `culprit: harness`, sin fixes de `infra/` ni de
`go.mod` y sin `design-gaps.yaml`, en 31 minutos de sesión (12 subagentes). La primera puntuación dejó FL-REC-002 en
FALLO y el árbitro lo atribuyó a la prueba (`culprit: test`): contaba los DELETE antes de que llegara el reintento, que
sale con su backoff después de que el handler confirme `released`. El agente de pruebas lo corrigió esperando al segundo
DELETE con `Eventually` y sosteniendo después que no llega un tercero; la segunda puntuación quedó al 100%.

Reverificado desde fuera, sin volver a ejecutar la suite: el XML de `build/test-results/integration/junit.xml` trae 41
casos (los 21 escenarios, los seis del humo —SMOKE-6 y SMOKE-8 incluidos— y los padres) sin ningún `<failure>` ni
`<skipped>`, en 415 s, y sin volcados en `build/keel-failures/`; `gofmt -l .` vacío; `go vet` y `staticcheck` limpios con
y sin `-tags integration`; `go mod tidy -diff` sin cambios; `go test ./...` en verde; `check-flows.sh` en verde;
**`check-idempotency.sh` en VERDE** en las ocho familias; `specs.sha256` intacto; y `keel-go build --check` dice que el
proyecto está al día con el generador.

## Lo que se usó del arnés del 11d

| Pieza | Dónde |
|---|---|
| `StartReplica`/`StopReplica` | FL-CLU-001, -002 y -003, cada uno con `defer s.StopReplica()` |
| `OnReplica: true` en `ExchangeAll` | FL-CLU-003: la misma clave a la vez contra las dos instancias (y en el ayudante de la carrera de FL-RES-*) |
| `AgeForReconciliation` | los cuatro escenarios del barrido (FL-REC-001…003 y FL-CLU-002) |
| `StubSequence` con `RespondConnectionFault`/`RespondOK`, `StubRequests` y `Header` | FL-REC-002: dos DELETE con la MISMA `Idempotency-Key` |
| `StubFailure`, `StubCallCount`, `StubFor` | FL-REC-003 (el 503 no se repite) y los ayudantes |

Sin usar: `RestartServer` (ningún escenario del diseño cuenta los fallos del circuito) y `HoldFromReconciliation` (ningún
escenario pide «lo que acaba de encargarse no se toca»). Siguen sin medir contra la infra real.

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Matriz | **21/21**, una ronda de arbitraje | 27/27 (con FL-RES-001-V1…V6) | 24/24, una ronda de arbitraje | 21/21 |
| Registrados por build | 216 | 248 | 223 | 252 |
| Reescritos | **10** | 11 | 10 | 10 |
| Reescritos por un hueco del generador | 0 | 1 (`JsonShape.cs`) | 0 | 0 |
| Huecos del generador | **0** | 2 (la réplica y `AssertJson`) | 2 (del gate) | (los mismos) |

La huella es la de keel-nest y keel-spring, y la de keel-dotnet sin su `harnessPatch`.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los siete handlers de `internal/application/` | TODO legítimo: la lógica de cada caso de uso, el barrido y la compensación |
| `internal/domain/reservation_behavior.go` | TODO legítimo: la creación y las transiciones |
| `cmd/server/broker.go` | TODO legítimo: el dispatcher del outbox y los listeners de RabbitMQ |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

**Archivos nuevos del agente**: los cinco de flujos de `tests/integration/` (`compensation_count_test.go`,
`reconciliation_cluster_test.go`, `reservation_creation_test.go`, `reservation_support_test.go`,
`stock_request_test.go`). Nada de los clientes, del circuito, del reclamo de reconciliación, de la persistencia ni del
arnés tocado: el barrido llama a `ClaimForReconcileReservationsReserveStock` tal cual y la clave saliente es la de build.
Una sola sentencia SQL en las pruebas del agente, en FL-RES-001-D, para envejecer la caducidad del registro de
idempotencia («precondición que ninguna operación fabrica»).

## Observaciones

- **Una espera fija en una prueba del agente**: FL-REC-002 sostiene «no llega un tercer DELETE» con un
  `time.Sleep(3 * time.Second)` tras el `Eventually`. Es la forma natural de una aserción negativa y no rompe nada; la
  regla `no-sleep-in-tests` de `go-idioms` vale para lo que emite build, no para las pruebas del agente.
- **El plazo de la suite**: el informe avisa de que puede superar el plazo por defecto de `go test` si se lanza a mano
  (FL-REC-003 espera ~70 s). `score-scenarios.sh` ya pasa `-timeout 30m`; la suite tardó 415 s.
- Fuera de la huella, en la raíz del proyecto: un `excalidraw.log` de un servidor MCP arrancado con ese directorio de
  trabajo. No es del pipeline ni lo registra el manifiesto.

## designGaps

Ninguno (sin `design-gaps.yaml`).
