# Corrida `notification-mailer-mongo` — keel-go, control (incremento 16)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.1.1 (DSL 2.23, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-go@0.1.0` (`efb10256`) |
| Modelo del agente | Sonnet 5.5 (orquestador y subagentes) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **23/23 OK** (66 casos, sin arbitraje) |
| Huella del agente | 288 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 1, fuera de la huella: la nota del 404, ver `2026-11-03-notification-mailer-go-control.md` |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Corrida de control del incremento 16 de `PLAN-KEEL-GO.md`, en el workspace
`spring-live-test/corrida-notification-mailer-mongo-go-control-1102`, en unos 57 minutos (sesión `ff591293`). La gemela
relacional del mismo día lleva la comparación y los hallazgos: `2026-11-03-notification-mailer-go-control.md`.

## Cómo terminó

**23/23 a la primera**, sin arbitraje. Sin `harnessPatches`, sin `culprit: harness`, sin arreglos de `infra/` ni de `go.mod`.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 66 casos, 0 `<failure>`, 0 `<error>` y 0 `<skipped>`, en 1191 s.
- `gofmt -l .` vacío; `go vet` y staticcheck limpios con `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en verde.
- `specs.sha256` intacto y `keel-go build --check` al día.

Aquí el agente de pruebas sí ejercitó la audiencia ajena de FL-NTF-001, con `test-m2m-bad-aud`.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `internal/application/` | TODO legítimo |
| `internal/domain/{application,notification,template,template_variable}_behavior.go` | TODO legítimo |
| `cmd/server/broker.go` | TODO legítimo |
| `README.md` | TODO legítimo |
| `internal/domain/template_queries.go` e `internal/infrastructure/mongo/template_queries.go` | Consulta de negocio: `LatestVersion` |

La clasificación es del que registra la corrida, leyendo la lista y las consultas; no la hizo un agente de contexto limpio
ni se leyó el diff de cada handler.

## Comparación con la corrida del 2026-11-01

Es la misma versión del diseño: esta es la comparación limpia. La de ayer salió 23/23 con una ronda de arbitraje y huella 15
(262 archivos), sin consulta de negocio, porque no tenía sitio y el agente la rodeó en su handler. Con los `<raíz>_queries.go`
la escribe donde toca: la huella sube de 15 a 17 por esos dos archivos, los mismos que las gemelas de los otros generadores. Y
esta vez no hubo arbitraje.

| | 2026-11-03 | 2026-11-01 | keel-dotnet (v2.0.2) | keel-nest (v2.0.2) | keel-spring (v2.0.2) |
|---|---|---|---|---|---|
| Matriz | 23/23 | 23/23 | 23/23 | 23/23 | 23/23 |
| Registrados por build | 288 | 262 | 318 | 294 | 305 |
| Reescritos | 17 | 15 | 18 | 17 | 17 |

## designGaps

Ninguno.
