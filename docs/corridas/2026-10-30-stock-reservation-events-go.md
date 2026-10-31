# Corrida `stock-reservation-events` — keel-go (incremento 9: mensajería con RabbitMQ)

| Etiqueta | Valor |
|---|---|
| Diseño | `stock-reservation-events` v1.0.0 (DSL 2.23, relacional, 6 capas) |
| Stack | `postgresql · rabbitmq` |
| Generador | `keel-go@0.1.0` (con el incremento 9: 9b-1 a 9d, `64992d83`…`762ed76c`, y los arreglos de la primera pasada, `05545537`) |
| Diseño listo al generar | sí |
| Matriz final | **14/14 OK** |
| Huella del agente | 169 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Clasificación de la huella | 9 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (sin `design-gaps.yaml`) |
| Huecos del generador | 2, los dos de la primera pasada y arreglados antes de la segunda (ver § La primera pasada) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las corridas del 2026-10-07 (careo 4→0; barrido 19; revisión 5; 10 aceptadas / 9 cerradas) |

La corrida que mide el incremento 9 de `PLAN-KEEL-GO.md` (9e): la primera de keel-go con capa `messaging`, por la
puerta de `--ready` y sin `--accept-unready` (el `DESIGN.md` de `fixtures/design-docs/`). Sus gemelas son
`2026-10-07-stock-reservation-events-spring.md`, `2026-10-07-stock-reservation-events-nest.md` y
`2026-10-14-stock-reservation-events-dotnet.md`: el mismo diseño y los mismos escenarios. Workspace:
`spring-live-test/corrida-stock-reservation-events-go`.

## La primera pasada

Paró en la fase 1. `keel-go-infra` y `keel-go-tests` en OK (14 escenarios escritos, `check-flows.sh` en verde) y
`keel-go-code` en KO con dos bloqueos, los dos del generador y los dos sobre archivos con la cabecera de código
generado, que el agente no puede editar. El orquestador no los parcheó a mano: los verificó y propuso arreglar el
generador. Se arreglaron en keel-system sin tocar el proyecto (`05545537`), y `keel-go build --refresh` puso al día
cuatro archivos de build (`use_cases.go`, el handler de `noteStockCount`, `topology.go` y `rabbitmq_test.go`).

1. **`noteStockCount` sin repositorio.** La operación anota un recuento sobre una reserva sin dar señal de entidad: ni
   payload de entidad, ni un nombre que la nombre, ni transiciones. Cae en un grupo de servicio sin entidad, y
   `repositoryOf` (`keel-core/gen/features.js`) no le daba repositorio. **Los cuatro generadores** lo emitían así, pero
   solo keel-go lo sufre: en keel-spring, keel-nest y keel-dotnet el agente añade el repositorio al constructor (el
   contenedor de dependencias lo resuelve; así pasó la corrida de keel-dotnet), y en keel-go el cableado `NewUseCases`
   es de build. Ahora una operación de un grupo sin entidad recibe el repositorio del ÚNICO agregado persistido; con
   varios, ninguno. Lo deciden igual los cuatro, y `keel-core/test/gen-extracted.test.js` sale en rojo sin el arreglo.
2. **`gofmt -l .` no vacío** en `internal/infrastructure/rabbitmq/topology.go` (las filas de `queues` y `published`
   dentro del bloque `var`, un nivel por fuera) y `rabbitmq_test.go` (el mapa de la curva sin alinear). Lo dejó pasar
   **la red**: `go-check --fixtures` generaba sin broker, así que el paquete `rabbitmq` no existía en ninguna fixture,
   y la afirmación del 9b-2 —gofmt vacío sobre `rabbitmq_test.go`— era falsa. Ahora las fixtures con capa
   `messaging` se generan con RabbitMQ (30/30).

## Cómo terminó

**14/14**, con el script en 0 y sin volcados en `build/keel-failures/`. Sin `harnessPatches`, sin `culprit: harness`,
sin fixes de `infra/` ni de `go.mod`, y sin `design-gaps.yaml`. Reverificado desde fuera, sin volver a ejecutar la
suite: el XML de `build/test-results/integration/junit.xml` trae los 14 escenarios sin ningún `<failure>` ni
`<skipped>`; `gofmt -l .` vacío; `go vet` y `staticcheck` limpios con y sin `-tags integration`; `go mod tidy -diff`
sin cambios; `check-flows.sh` en verde. `infra/check-domain-guards.sh` no existe en este proyecto: el diseño no
declara ningún value type con formato.

## Comparación

| | keel-go | keel-dotnet | keel-nest | keel-spring |
|---|---|---|---|---|
| Matriz | **14/14** | 15/15 (14 + `-V`) | 18/18 (14 + `-E`…`-H`) | 14/14 |
| Registrados por build | 169 | 196 | 176 | 220 |
| Reescritos | **9** | 9 | 9 | 8 |
| Reescritos por un hueco del generador | **0** | 0 | 0 | 0 |
| Huecos del generador | 2 (bloqueos de la 1.ª pasada, arreglados) | 1 (el arnés) | 1 (un comentario) | 0 |

Los mismos 14 escenarios del documento en los cuatro, y aquí ninguno añadido por el agente de pruebas: no inventó ids
(la regla que entró tras la corrida 8d en `integration-tests.md`).

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los seis handlers de `internal/application/` | TODO legítimo: la lógica de cada caso de uso (el de `noteStockCount`, ya con el repositorio tras el `--refresh`) |
| `internal/domain/reservation_behavior.go` | TODO legítimo: la creación, las transiciones y `NoteCount` |
| `cmd/server/broker.go` | TODO legítimo: el dispatcher y el listener, el sitio previsto |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

Los MISMOS nueve que keel-dotnet (con `BrokerBindings.cs`) y keel-nest (con `broker-bindings.ts`), uno a uno. Ningún
archivo de mensajería de build tocado: la conexión, la topología, el puente, el relay y el registro de procesados
funcionaron tal cual.

**`cmd/server/broker.go`** es la skill `keel-go-rabbitmq` casi literal: el `Dispatcher` del outbox, una línea sobre
`Connection.Publish` que devuelve el error tal cual; UN listener para la cola compartida, que lee la envoltura, abre
`messaging.Inbound` y enruta por `Metadata.EventType`; filtra por tipo ANTES de `RequireContract`; aplica el orden de
la guarda que dicta el comentario de cada mensaje (`AlreadyProcessed`/`Record` en `StockReserved` y `StockRejected`,
con transición; `TryRecord` antes en `StockCountAdjusted`, sin ella); y confirma la carrera resuelta
(`ErrInvalidStateTransition` o `ErrConcurrentModification`) registrándola igual. Es el mismo listener que el de
keel-dotnet, y la misma forma que la sonda de `broker-check`.

## Pruebas

Los flujos usaron solo los helpers del arnés del 9c: `DeliverStockReserved`/`StockRejected`/`StockCountAdjusted`,
`PublishedMessages`, `DeadLetterMessages`, `PurgeMessages`, `StopBroker`/`StartBroker` (`FL-OBX-001`, con el broker
parado y vuelto) y `DeadLetteredEvents`; un `ExchangeAll` para la carrera HTTP de `FL-RES-001-C` y un `Db`. Ninguna
fontanería escrita a mano.

Dos observaciones, ninguna un hueco:

- **`FL-CMP-001-C`** («el mismo evento se entrega dos veces a la vez») publica las dos copias una tras otra, sin
  esperar entre ellas: los métodos del escenario terminan el escenario si fallan y no se llaman desde una goroutine
  (`integration-tests.md` § La mensajería). Con un consumidor por cola, la diferencia no es observable: las dos copias
  llegan a la cola casi en el mismo instante y se procesan de una en una, igual que en keel-dotnet, que las publicaba
  con `Task.WhenAll`. La carrera de verdad, entre réplicas, la arbitra la clave primaria de `processed_event`, y esa la
  miden las sondas de `db-check`.
- **Una espera fija de 3 s** (`settle()`, en `reservation_support_test.go`) antes de las aserciones NEGATIVAS de las
  reentregas: que la segunda entrega no tuvo efecto no deja ninguna señal que esperar. Es su uso legítimo; lo positivo
  se espera con `s.Eventually`.

## Arreglos

Los dos de § La primera pasada, en `05545537`. Nada pendiente.
