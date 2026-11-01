# Corrida `notification-mailer-mongo` — keel-go (incremento 12e)

| Etiqueta | Valor |
|---|---|
| Diseño | `notification-mailer-mongo` v2.1.1 (DSL 2.23, documental, 7 capas) |
| Stack | `mongodb · rabbitmq · keycloak` |
| Generador | `keel-go@0.1.0` (`a7d0d803`, con los arreglos de los dos intentos parados) |
| Diseño listo al generar | sí |
| Matriz final | **23/23 OK** (66 casos; una ronda de arbitraje: FL-NTF-001, `culprit: test`) |
| Huella del agente | 262 archivos registrados por `build`, 0 adoptados, **15 reescritos**, 0 borrados |
| Clasificación de la huella | 15 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el único de `design-gaps.yaml` es del generador: ver § Lo que dijo el informe) |
| Huecos del generador | 5: cuatro de los dos intentos parados y uno de esta (ver § Arreglos) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | la v2.1.1 es un parche con resello acotado de FL-TPL-001 (la 2.1 ya había gastado sus tres pasadas) |

La corrida del incremento 12 de `PLAN-KEEL-GO.md`, sobre el par del MVP en su variante documental y con el stack de sus
gemelas (`2026-10-18-notification-mailer-mongo-{spring,nest,dotnet}-control.md`, sobre la v2.0.2). Es la primera corrida
de la **v2.1.0** del par en cualquier generador, y por eso destapó un defecto de la fixture (§ Los intentos parados).
Workspace: `spring-live-test/corrida-notification-mailer-mongo-go-1101`, en un espacio nuevo tras dos intentos parados en
`spring-live-test/corrida-notification-mailer-mongo-go`, que queda como registro.

## Los intentos parados

**Primer intento, parado en la fase 1.** El agente de código reportó dos bloqueos y rodeó el primero con un `peers.go` sin
cablear:

- `NewUseCases` es de build, así que lo que no le pase a un handler el agente no lo alcanza. Le pasaba solo el repositorio
  de SU agregado: `requestNotification` no podía leer la aplicación ni la plantilla, ni interpolar el asunto sin el
  renderizador. En los otros tres la inyección de dependencias le da cualquier repositorio.
- `sendAcceptedNotification` es interna y nada la dispara. Los otros tres emiten un `CommandDispatcher` inyectable en
  cualquier handler; keel-go solo pasaba `uc` a quien declara `dispatches`, así que el barrido no podía despacharla.

**Segundo intento, parado en la fase 2b** con 14 OK, 8 FALLO y 1 OMITIDO, y dos causas que el árbitro clasificó bien:

- `openTx` miraba la marca de `WithoutTransaction`, así que la transacción que abría el `Save` de un caso de uso despachado
  sin transacción (el envío que despacha el barrido) era invisible para su outbox. El correo salía y el envío revertía: sin
  `sentAt` ni `NotificationSent`. Seis escenarios.
- La v2.1.0 de la fixture afirmaba `templateId` en cada variable de FL-TPL-001 («una entidad hija lleva siempre el id de su
  raíz»). Lo había metido la pasada 1 del careo, pero ningún generador lo emite, el dominio no lo declara y el OpenAPI
  derivado no lo admite. Tres escenarios.

## Arreglos

| # | Hueco | Arreglo |
|---|---|---|
| 1 | Los handlers solo recibían el repositorio de su agregado | `handlerDependencies` en `src/scaffold/use-cases.js`, fuente única del handler y de su cableado: todos los repositorios (el suyo primero) y el renderizador si hay plantillas (`4996a60e`) |
| 2 | Una operación interna huérfana no tenía quien la despachara | `uc *UseCases` a todo handler salvo la huérfana si `orphanInternalOperations` no está vacía, con su nota (`4996a60e`) |
| 3 | `retry = nil` sin tipo en la topología de RabbitMQ (latente: lo destapó `go-check` al recalcular las fixtures) | `retry *ListenerRetry` (`4996a60e`) |
| 4 | `openTx` ocultaba la transacción de una escritura bajo la marca de `WithoutTransaction` (los dos modelos) | la marca la aplica `Within` una vez y `openTx` ya no la mira; prueba emitida `transactions_test.go`, falsada con cuatro sabotajes (`2c6ddeff`) |
| 5 | Una consulta de negocio que el puerto no trae no tenía sitio (esta corrida) | `<raíz>_queries.go` del agente en `internal/domain` (la interfaz `<Raíz>Queries`, que el puerto incrusta) y en el paquete del motor, enseñado por las dos skills de la base de datos |

Y en la fixture, la **v2.1.1** del par (`5b0628a9`): FL-TPL-001 vuelve a afirmar solo los campos de `TemplateVariable`.
Como la 2.1 había gastado sus tres pasadas de careo, el flujo se reselló de forma acotada: un hallazgo `response-shape`
resuelto `scenario`, con su `sealAfter`.

Fuera de la huella, govulncheck avisaba de GO-2025-4188 en `logrus` v1.8.1, que arrastra `mailgun/raymond` (no alcanzable).
build lo fija ahora a v1.8.3 como `// indirect` en todo proyecto con plantillas de correo, y la vista del manifiesto lo
conserva solo con esa versión. El otro aviso, GO-2026-5932 en `golang.org/x/crypto` (por go-mail), no tiene versión
corregida y tampoco es alcanzable.

## Antes del pipeline

`keel-go build` escribió 262 archivos con el stack sembrado en `keel-stack.json` y las skills `keel-go-mongodb`,
`keel-go-rabbitmq`, `keel-go-keycloak` y `keel-go-mail`. Sobre una copia, para no tocar la huella: `go mod tidy` sin mover
ningún directo, `gofmt`, `go vet` y staticcheck vacíos (con y sin `-tags integration`), `go build` sin cgo y
`go test ./...` en verde, y `check-idempotency.sh` en ROJO con sus 11 hallazgos del agente.

## Cómo terminó

**23/23**. La primera puntuación dejó FL-NTF-001 en FALLO y el árbitro lo atribuyó a la prueba (`culprit: test`): la
petición sin idioma llevaba `Idempotency-Key`, y la prueba esperaba como `dedupeKey` el id de la notificación, que solo
vale sin clave. El agente de pruebas lo corrigió y la segunda puntuación quedó al 100%. `keel-go-quality` en verde: vet,
staticcheck, gofmt, `go mod tidy -diff`, govulncheck, índices 11/11 y las guardas de dominio e idempotencia.

Reverificado desde fuera, sin volver a ejecutar la suite:
- `build/test-results/integration/junit.xml`: 66 casos, 0 `<failure>` y 0 `<skipped>`, en 1178 s.
- `gofmt -l .` vacío; `go vet` y staticcheck limpios con y sin `-tags integration`; `go mod tidy -diff` sin cambios.
- `check-idempotency.sh` en VERDE en sus siete familias.
- `specs.sha256` intacto (13 archivos) y `keel-go build --check` al día.
- Sin `harnessPatches`, sin `culprit: harness` ni fixes de `infra/`.

Lo que estrenan los arreglos, en el código del agente: el barrido reclama su lote con
`ClaimForQueueAcceptedNotifications` y despacha cada envío con
`h.useCases.SendAcceptedNotification.Handle(WithoutTransaction(ctx), …)`; las precondiciones sobre otros agregados usan
los repositorios que ahora recibe cada handler (`handler_support.go`); y el outbox del envío encuentra su transacción
(FL-OBX-001/002, FL-EVT-001 en verde).

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Diseño | v2.1.1 | v2.0.2 | v2.0.2 | v2.0.2 |
| Matriz | **23/23**, una ronda de arbitraje | 23/23 | 23/23 | 23/23 |
| Registrados por build | 262 | 318 | 294 | 305 |
| Reescritos | **15** | 18 | 17 | 17 |
| Consulta de negocio | 0 (no tenía sitio: arreglo 5) | 2 | 2 | 3 |

La diferencia con las gemelas es justo la consulta de negocio: allí el agente añadió `findLatestVersion` al puerto y al
adaptador (dos o tres reescritos clasificados como consulta); aquí los dos llevaban la cabecera de código generado, y el
agente la rodeó en su handler. Con el arreglo 5 la escribirá en sus `_queries.go`.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los nueve handlers de `internal/application/` | TODO legítimo: la lógica de cada caso de uso, el barrido y el envío |
| `internal/domain/{application,notification,template,template_variable}_behavior.go` | TODO legítimo: constructores, transiciones y guardas |
| `cmd/server/broker.go` | TODO legítimo: el dispatcher del outbox y el listener de RabbitMQ |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

**Archivos nuevos del agente**: `internal/application/handler_support.go` (lo común a la vía HTTP y a la de eventos: la
aplicación activa, la plantilla propia, el registro y el truncado del asunto) y los cinco de flujos de
`tests/integration/`.

## Lo que dijo el informe y lo que resultó ser

- **«Falta un finder de la última versión de plantilla» (`design-gaps.yaml`, `missing-query`)**: no es del diseño. «La
  versión es la siguiente» está escrita, y las tres gemelas la resolvieron con una consulta de negocio en el puerto. Es
  el hueco del generador del arreglo 5. El agente calcula la versión siguiente probando versiones desde la 1
  (`register_template_command_handler.go`): correcto, con la unicidad de la clave natural arbitrando la carrera, pero con
  una lectura por versión existente.
- **«`TEMPLATE_NOT_FOUND` con 404 y con 422»**: es una nota del propio build, no una decisión del agente. El diseño lo
  declara así por operación.
- **govulncheck «avisa de una en un paquete importado y otra en un módulo requerido»**: cierto, y ninguna alcanzable. La
  primera es la de `logrus`, ya fijada.

## Observaciones

- **El modo evolución no existe todavía en keel-go** (incremento 15): el primer intento se reanudó con
  `build --refresh --prune` sin `EVOLUTION.md`, y quien sabía qué había cambiado era el orquestador humano. Por eso esta
  corrida se repitió en un espacio nuevo en vez de evolucionar el anterior.
- Fuera de la huella, en la raíz del proyecto: un `excalidraw.log` de un servidor MCP arrancado con ese directorio de
  trabajo. No es del pipeline ni lo registra el manifiesto.

## designGaps

Ninguno. El único de `design-gaps.yaml` (`template-latest-version`) es un hueco del generador (§ Arreglos, 5).
