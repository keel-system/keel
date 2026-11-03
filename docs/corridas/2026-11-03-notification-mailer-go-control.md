# Corrida `notification-mailer` — keel-go, control (incremento 16)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.1.1 (DSL 2.23, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-go@0.1.0` (`efb10256`) |
| Modelo del agente | Sonnet 5.5 (orquestador y subagentes) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **23/23 OK** (66 casos, sin arbitraje) |
| Huella del agente | 286 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 2, ninguno en la huella (ver § Lo que dijo el informe) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Corrida de control del incremento 16 de `PLAN-KEEL-GO.md`, en el workspace
`spring-live-test/corrida-notification-mailer-go-control-1102`, en unos 57 minutos (sesión `acf5233d`). Es la primera vez que
`notification-mailer` relacional corre en keel-go. La gemela documental, del mismo día:
`2026-11-03-notification-mailer-mongo-go-control.md`.

## Cómo terminó

**23/23 a la primera**, sin arbitraje. Sin `harnessPatches`, sin `culprit: harness`, sin arreglos de `infra/` ni de `go.mod`.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 66 casos, 0 `<failure>`, 0 `<error>` y 0 `<skipped>`, en 1196 s.
- `gofmt -l .` vacío; `go vet` y staticcheck limpios con `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en verde.
- `specs.sha256` intacto y `keel-go build --check` al día.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `internal/application/` | TODO legítimo: la lógica de cada caso de uso, el barrido y el envío |
| `internal/domain/{application,notification,template,template_variable}_behavior.go` | TODO legítimo: constructores, transiciones y guardas |
| `cmd/server/broker.go` | TODO legítimo: el dispatcher del outbox y el listener de RabbitMQ |
| `README.md` | TODO legítimo: la guía de despliegue |
| `internal/domain/template_queries.go` e `internal/infrastructure/postgres/template_queries.go` | Consulta de negocio: `FindLatestVersion`, porque «la versión es la siguiente» está en el diseño en prosa |

La clasificación es del que registra la corrida, leyendo la lista y las consultas; no la hizo un agente de contexto limpio
ni se leyó el diff de cada handler.

## Lo que dijo el informe y lo que resultó ser

- **«El arnés no puede pedir otra audiencia» (la audiencia ajena de FL-NTF-001 sin ejercer)**: falso, y es un hueco del
  generador. `s.ServiceCredential("test-m2m-bad-aud")` lo da, y la corrida documental del mismo día lo usa. A `keel-go-tests`
  le faltaba la regla que keel-spring, keel-nest y keel-dotnet ya tienen: un fixture de infraestructura documentado no es un
  `uncovered`. Arreglado en `assets/agents/keel-go-tests.md`. **La matriz sale 23/23 igualmente, porque este caso borde no es
  un escenario propio, así que esta corrida no midió el 403 por audiencia.**
- **«Los comentarios de `requestNotification` y `acceptNotificationRequest` dicen 404 para `TEMPLATE_NOT_FOUND`, y el diseño
  dice 422»**: cierto, y no es solo de Go. El modelo neutral guarda un `http` por `code` y gana el de la primera operación, y
  los cuatro generadores escriben esa nota: comprobado sobre lo que emiten para este diseño. El agente siguió el diseño, con
  `domain.StatusErrorf`, y los escenarios lo afirman. **Sin arreglar**: mueve la salida de los cuatro generadores.

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Diseño | **v2.1.1** | v2.0.2 | v2.0.2 | v2.0.2 |
| Matriz | 23/23 | 23/23 | 23/23 | 23/23 |
| Registrados por build | 286 | 329 | 304 | 320 |
| Reescritos | 17 | 17 | 17 | 17 |

La misma cifra de huella, sobre versiones distintas del diseño: las gemelas son del 2026-10-18, y la v2.1 reescribió
escenarios. No es la comparación limpia que pedía la puerta del plan (8×23/23).

## designGaps

Ninguno.
