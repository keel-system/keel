# Corrida `notification-mailer` — keel-go, audiencia ajena

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer` v2.1.1 (DSL 2.23, relacional, 7 capas) |
| Stack | `postgresql · rabbitmq · keycloak` |
| Generador | `keel-go@0.1.0` (`128448fb`) |
| Modelo del agente | Sonnet 5.5 (orquestador y subagentes) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **23/23 OK** (66 casos, sin arbitraje) |
| Huella del agente | 286 archivos registrados por `build`, 0 adoptados, **17 reescritos**, 0 borrados |
| Clasificación de la huella | 15 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Corrida del pendiente de la audiencia ajena de `PLAN-KEEL-GO.md`, en el workspace
`spring-live-test/corrida-notification-mailer-go-audience-1103`, en unos 78 minutos hasta el informe (sesión `d9c8e54a`). La
[corrida de control anterior](2026-11-03-notification-mailer-go-control.md) también salió 23/23, pero dejó este caso sin ejercer y
de ahí salió la regla de `keel-go-tests`. Esta corrida mide esa regla.

## La pregunta: ¿el agente ejerce la audiencia ajena?

**Sí.** El criterio se fijó antes de lanzarla, y el 23/23 no bastaba porque el caso no es un escenario propio.

- **La prueba la pide y afirma el 403:** `tests/integration/notification_request_test.go:114`, dentro de FL-NTF-001.

  ```go
  s.ExpectStatus(s.Post(RouteBase+"/notifications", fxNotifyBody("valido@cliente.example"), fxAuth(s, "test-m2m-bad-aud")), http.StatusForbidden)
  ```

  `fxAuth` (`support_test.go:26`) es `Bearer(s.ServiceCredential(client))`.
- **`uncovered` no la lleva:** `keel-go-tests` declara «ninguno» y cita como supuesto que `test-m2m-bad-aud` lleva `notification:send`.
- **Se ejecutó y pasó:** `TestNotificationRequest/FL-NTF-001` está en el JUnit, sin `<failure>`.
- **El 403 solo puede venir de la audiencia, por lectura del código:** `infra/init-keycloak.sh` da a ese cliente `aud-wrong` y los
  cinco scopes, y `POST /v1/notifications` solo pide `SCOPE_notification:send`. Sin la comprobación de
  `internal/httpapi/security.go:183`, `judge` dejaría pasar la petición.

**Lo que no se midió:** no se quitó esa comprobación para ver caer la prueba, así que el párrafo anterior es lectura y no un sabotaje.
`security-check` de keel-go mide los tokens de esa matriz, y no el 403 de una ruta.

El escenario dice «un token de `orders-service` emitido para otra audiencia», y la prueba usa `test-m2m-bad-aud`, que es el fixture
documentado para ese caso. La línea 113 prueba además el 403 por falta de scope con `orders-service-ci`.

## Cómo terminó

**23/23 a la primera**, sin arbitraje. Sin `harnessPatches`, sin `culprit: harness`, sin arreglos de `infra/` ni de `go.mod`.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 66 casos, 0 `<failure>`, 0 `<error>` y 0 `<skipped>`, en 1215 s.
- `gofmt -l .` vacío; `go vet` y staticcheck limpios con `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en verde.
- `specs.sha256` intacto y `keel-go build --check` al día.

## La huella, clasificada

Los mismos 17 archivos que la corrida de control:

| Reescrito | Clase |
|---|---|
| los nueve handlers de `internal/application/` | TODO legítimo |
| `internal/domain/{application,notification,template,template_variable}_behavior.go` | TODO legítimo |
| `cmd/server/broker.go` | TODO legítimo |
| `README.md` | TODO legítimo |
| `internal/domain/template_queries.go` e `internal/infrastructure/postgres/template_queries.go` | Consulta de negocio: `FindLatestVersion` |

La clasificación es del que registra la corrida, leyendo la lista; no la hizo un agente de contexto limpio ni se leyó el diff de cada
handler.

## Lo que dijo el informe y lo que resultó ser

- **«`notification.go` y `template.go` llevan `//lint:ignore U1000`, del generador»**: cierto, y no es un defecto. Son directivas de
  `transitionTo` y `raise`, con cabecera de generado, y el agente no puede quitarlas. Con el código ya escrito sobran, sin que
  staticcheck se queje. Sin arreglar.
- **«`fxContains` quedó sin uso»**: cierto, del agente de pruebas. La quitó tras el pase de calidad, y se volvió a puntuar 23/23.

## El entorno

`excalidraw.log` está en la raíz y entró en el commit del proyecto. Es el log de un servidor MCP de la máquina, arrancado con ese
directorio de trabajo; no sale de keel-go.

## designGaps

Ninguno.
