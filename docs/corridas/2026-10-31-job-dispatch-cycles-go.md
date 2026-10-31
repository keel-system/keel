# Corrida `job-dispatch-cycles` — keel-go (incremento 10e)

| Etiqueta | Valor |
|---|---|
| Diseño | `job-dispatch-cycles` v1.0.1 (DSL 2.23, relacional, 5 capas) |
| Stack | `postgresql` |
| Generador | `keel-go@0.1.0` (con el incremento 10: 10b–10d, `56219401`…`1b1a3f7e`) |
| Diseño listo al generar | sí |
| Matriz final | **12/12 OK** |
| Huella del agente | 145 archivos registrados por `build`, 0 adoptados, **6 reescritos**, 0 borrados |
| Clasificación de la huella | 6 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 |

La corrida del incremento 10 de `PLAN-KEEL-GO.md`, sobre el MISMO diseño y el mismo stack que sus gemelas
(`2026-10-07-job-dispatch-cycles-{nest,spring}.md` y `2026-10-14-job-dispatch-cycles-dotnet.md`; la fixture solo cambia
la versión del DSL, de 2.21 a 2.23), por la puerta de `--ready` y sin `--accept-unready`. Workspace:
`spring-live-test/corrida-job-dispatch-cycles-go`. Mide lo que ninguna red mide: que un tick del reloj dispare de verdad
el handler contra la base, que el reclamo de la cola y el rescate generados se usen tal cual, que el arnés del rescate
(`StallInFlight`, `PutInFlight`, `InFlightWithoutClock`) aguante un pipeline real y que el gate `check-idempotency.sh`
del 10d pase de rojo a verde con el código del agente.

## Antes del pipeline

`keel-go check` factible y sin avisos; `keel-go build -y` escribió 145 archivos. `go mod tidy`, `go build`, `go vet` y
`staticcheck` (con y sin `-tags integration`), `gofmt -l .` vacío, `go test ./...` (13 paquetes) y `check-flows.sh` en
verde; `check-idempotency.sh` en ROJO en `sweepClaim` (`dispatchJobs` aún no llamaba a sus reclamos), como debe.

## Cómo terminó

**12/12 a la primera**, con `score-scenarios.sh` en 0, sin `harnessPatches`, sin `culprit: harness`, sin fixes de
`infra/` ni de `go.mod` y sin `design-gaps.yaml`. Reverificado desde fuera, sin volver a ejecutar la suite: el XML de
`build/test-results/integration/junit.xml` trae 24 casos (los 12 escenarios, los cuatro del humo, el `Given` compartido
del arnés y los padres) sin ningún `<failure>` ni `<skipped>`, y sin volcados en `build/keel-failures/`; `gofmt -l .`
vacío; `go vet` y `staticcheck` limpios con y sin `-tags integration`; `go mod tidy -diff` sin cambios; `go test ./...`
en verde; `check-flows.sh` en verde; **`check-idempotency.sh` en VERDE** (`sweepClaim OK`); `specs.sha256` intacto; y
`keel-go build --check` dice que el proyecto está al día con el generador.

Los escenarios del reloj esperaron al cron real: `FL-DSP-001` 49 s, `FL-RSC-001` 60 s y `FL-RSC-002` 76 s. Los del
rescate fabrican su precondición con `StallInFlight` y `PutInFlight` y comprueban que `InFlightWithoutClock` vale cero;
las pruebas del agente (`job_dispatch_test.go`, `job_enqueue_test.go`, `jobs_helpers_test.go`) no llevan una línea de
SQL.

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Matriz | **12/12** a la primera | 12/12 a la primera | 12/12, una ronda de arbitraje | 12/12 |
| Registrados por build | 145 | 167 | 148 | 177 |
| Reescritos | **6** | 6 | 6 | 5 |
| Reescritos por un hueco del generador | 0 | 0 | 0 | 0 |
| Huecos del generador | **0** | 1 (la nota del rescate) | 1 (la regex de `inFlightWithoutClock`) | 0 |

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los cuatro handlers de `internal/application/` | TODO legítimo: la lógica de cada caso de uso |
| `internal/domain/job_behavior.go` | TODO legítimo: el constructor, los invariantes y las transiciones (`Dispatch`, `Complete`, `Abandon`) |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

Los mismos seis que keel-dotnet y keel-nest, archivo por archivo. **Archivos nuevos del agente**: los tres de flujos de
`tests/integration/`. Nada del reloj, del reclamo, de la persistencia ni del arnés tocado: el barrido
(`DispatchJobsCommandHandler`) llama a `ClaimForDispatchJobsRunning` y a `ClaimForStalledDispatchJobsAbandoned` tal
cual, la transición del rescatado la hace el dominio (`Abandon`) y el rescate **no corta el lote** por el fallo de una
fila: el conflicto de versión se salta y lo demás se junta con `errors.Join`. Es el hueco que destapó la corrida de
keel-dotnet (la nota del rescate no lo decía); la nota de keel-go ya nació con esa frase, y el agente la siguió.

Fuera de la huella, en la raíz del proyecto: un `excalidraw.log` de un servidor MCP arrancado con ese directorio de
trabajo. No es del pipeline ni lo registra el manifiesto.

## designGaps

Ninguno (sin `design-gaps.yaml`).
