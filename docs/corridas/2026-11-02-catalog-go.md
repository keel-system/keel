# Corrida `catalog` — keel-go (incremento 13i)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.23, relacional, 9 capas), la copia de `2026-10-19-catalog-dotnet.md` con `keel` 2.21→2.23 |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-go@0.1.0` (`2a7f8ff2`, sin los arreglos de esta corrida) |
| Diseño listo al generar | sí |
| Matriz final | **56/56 OK** (`score-scenarios.sh` con código 0; 108 casos en 991 s) |
| Huella del agente | 344 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 21 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 2, los dos del informe (ver § Arreglos) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas |

La corrida de control relacional del incremento 13 de `PLAN-KEEL-GO.md`: PostgreSQL con Kafka, caché, almacenamiento, réplica
y clientes salientes. Es el mismo resultado que su gemela de keel-dotnet (`2026-10-16-catalog-dotnet.md`: 56/56, huella 23,
21 TODO y 2 consultas). Workspace: `spring-live-test/corrida-catalog-go`.

La clasificación la hizo quien arregló el generador, leyendo los reescritos, y no un agente de contexto limpio: es una
corrida de control del generador y no cuenta para H1.

## La huella

| Reescritos | Clase |
|---|---|
| 12 handlers de `internal/application` | TODO |
| 4 `<entidad>_behavior.go` | TODO |
| `legacy_erp_fallback.go`, `pricing_fallback.go` | TODO |
| `storage.go`, el adaptador S3 | TODO |
| `cmd/server/broker.go` | TODO |
| `README.md` | TODO |
| `product_queries.go`, en `internal/domain` y en `postgres` (`FindLatestByCategory`) | consulta |

## Lo que dijo el informe, contrastado

Coincide con la huella y con el JUnit de `build/test-results/integration/junit.xml`. Los dos huecos que anota son ciertos, y
el agente no editó ningún archivo generado ni rodeó nada. Dos precisiones:

- Dice que dejar el binario huérfano es un «caso que el diseño admite». El diseño lo admite **si el borrado falla**; aquí
  queda huérfano **siempre**, en toda `removeProductImage`. La matriz no lo ve: ningún escenario afirma el borrado.
- La espera de `awaitStatus` subió a 70 s en `tests/integration/support_test.go`, del agente de pruebas: `FL-CMP-001-B`
  tardó 43 s por lo del § Arreglos, punto 2.

**Esta corrida no cumple la regla de borrado de `removeProductImage`**, y seguirá sin cumplirla hasta rehacer ese handler. El
56/56 no incluye esa regla.

## Arreglos

1. **`removeProductImage` no podía borrar el binario tras confirmar.** Dos capas. El handler no recibía `domain.FileStorage`,
   que solo llegaba a las subidas y a quien responde con una URL pública, y `NewUseCases` es de build: el agente no puede
   añadirlo. Y no había vía para «después del commit»: `afterUseCase` existía solo con caché, y ninguna doc lo nombraba. Es
   la misma parada que keel-dotnet en su corrida de catalog, de la que salió `IAfterCommit`.
   Ahora `src/scaffold/after-commit.js` emite `internal/application/after_commit.go`: `settle` envuelve toda operación con
   persistencia, y `afterCommit(ctx, efecto)` corre tras el commit, nunca si revierte, con el contexto sin cancelar, y
   registra su fallo sin devolverlo. Todo comando recibe `fileStorage`. Lo enseñan `constitution.md` y la skill `keel-go-s3`.
   Lo miden `test/after-commit.test.js`, la prueba emitida `after_commit_test.go` y los sabotajes `after-commit-*` de `go-check`,
   cada uno en rojo con sus pruebas. Esa prueba cazó un defecto del propio arreglo: el logger se leía cuando el asentamiento ya
   se había cerrado, y el fallo del efecto salía por el logger por defecto.
2. **Con Kafka, el servidor reiniciado tardaba unos 45 s en consumir.** `RestartServer` mata el proceso, no hay LeaveGroup, y
   el miembro muerto retiene la partición hasta que vence su sesión. Ahora `kafka.consumer.session-timeout-ms` vale 6 s en
   el perfil local (`config/parameters/local/kafka-group.yaml`, aparte porque `kafka.yaml` es idéntico en keel-dotnet) y 45 s
   por defecto. Lo mide `FL-BRK-001-J` de `broker-check`, falsado con el sabotaje `session-timeout`.

## Medido tras los arreglos

`npm test` de keel-go 1063/1063, `go-check` entero **160/160** (lanzado por el usuario, con `-race` y los sabotajes `after-commit-*`) y
`broker-check --broker=kafka` 30/30. **Sin medir**: la regla de borrado ejecutada de punta a punta: ni un
handler que borre el binario contra un MinIO real, ni un escenario que lo afirme. Para eso hace falta rehacer
`removeProductImage` en esta corrida, con `build --refresh` y una pasada del agente de código.

## Sin arreglar

- `reconcile_withdrawals_command_handler.go` registra con `slog.WarnContext` global. Un handler no recibe logger y el servidor
  no fija `slog.SetDefault`, así que esas líneas salen por el logger por defecto, sin el JSON ni la correlación del servicio.
  No lo vigila nada ni lo reportó el agente.

## designGaps
