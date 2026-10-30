# Corrida `product-catalog` — keel-go (primera corrida del generador)

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.1.0 (DSL 2.23, relacional, 4 capas) |
| Stack | `postgresql` |
| Generador | `keel-go@0.1.0` (incremento 7, con la idempotencia de petición adelantada del 10) |
| Modelo del agente | `claude-sonnet-5-5`: orquestador y los cuatro subagentes que corrieron (code, infra, tests, quality) |
| Diseño listo al generar | no, con --accept-unready (design-doc, flow-review, gaps, review, structural, undecided) |
| Matriz final | **23/23 OK** |
| Huella del agente | 132 archivos registrados por `build`, 0 adoptados, **8 reescritos**, 0 borrados |
| Clasificación de la huella | 7 TODO · 0 consulta · 1 generador (`go.mod`, ver abajo) · 0 diseño · 0 puerta |
| Huecos del diseño | 0 |
| Huecos del generador | 1, latente: el `go.mod` que reescribe `go mod tidy` contaba como tocado (arreglado, ver § Del generador) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

El hito del incremento 7 de `PLAN-KEEL-GO.md`: el mismo diseño y los mismos escenarios que las corridas de
keel-spring, keel-nest (2026-10-06) y keel-dotnet (2026-10-14), completados por `/keel-generate-go` con sus agentes
contra la `infra/` real. Workspace: `spring-live-test/corrida-product-catalog-go`.

## Comparación

| | keel-go | keel-dotnet | keel-nest v2 | keel-spring |
|---|---|---|---|---|
| Matriz | **23/23 a la primera** | 23/23 a la primera | 23/23 a la primera | 23/23 |
| Reescritos | **8** (7 del agente + `go.mod` de tidy) | 7 | 7 | 6 |
| Archivos de infraestructura de build tocados | **0** | 0 | 0 | 0 |
| Registro de idempotencia | el generado (`idempotency_record`) | el generado | el generado | `idempotency_record` |

Descontado `go.mod`, la huella es la de keel-dotnet y keel-nest v2 archivo por archivo: los cinco handlers, el
comportamiento del agregado y el `README.md`. `keel-go-validate` no llegó a invocarse: `score-scenarios.sh` salió
con 0 en la primera puntuación.

## Los reescritos, clasificados

| Archivo | Clase | Qué hizo el agente |
|---|---|---|
| `internal/application/create_product_command_handler.go` | TODO legítimo | el algoritmo de la nota del stub: sin clave ejecuta sin deduplicar; con ella, `IdempotencyScope`/`IdempotencySignature` generados, `Find`, `domain.IdempotencyReuse` con otra firma, reproduce desde `ResourceID` y reclama con `Save` ANTES del negocio; después `FindBySku` → `ErrSkuAlreadyExists` |
| `internal/application/{activate,retire,get,list}_…_handler.go` | TODO legítimo | cargar, delegar en el agregado, guardar y mapear; errores con `domain.Errorf(domain.Err…)` |
| `internal/domain/product_behavior.go` | TODO legítimo | `NewProduct(id, …)` con `SKUFormat.Validate`, `Activate()` (estado y después el invariante del precio) y `Retire()`, los dos por `transitionTo`. El id lo recibe en vez de generarlo (el stub decía `uuid.Must(uuid.NewV7())`), porque la idempotencia lo reserva antes; keel-dotnet hizo lo mismo con `Create(id, …)` |
| `README.md` | TODO legítimo | la sección `## Despliegue en producción` |
| `go.mod` | generador | solo los `// indirect` que añade `go mod tidy`, el paso 2 que el propio `build` prescribe; ningún requisito directo se movió (comparado contra una regeneración limpia) |

Fuera de lo registrado por build, el agente añadió lo esperado: cinco archivos en `tests/integration`
(`catalog_helpers_test.go` y cuatro de flujos, una función `Test…` por flujo y un subtest por escenario), y `go.sum`.

## Lo que midió la corrida

- **Los `_behavior.go` funcionan como reparto**: el agente escribió el comportamiento sin tocar `product.go` (con la
  cabecera `DO NOT EDIT`), y ningún archivo con la cabecera aparece en la huella.
- **El registro de idempotencia generado se usó tal cual**: ni tabla, ni firma, ni registro propio. Es el punto en el
  que keel-nest v1 escribió el suyo.
- **`FL-PRD-003` con `s.ExchangeAll`**: las dos altas simultáneas van por el arnés, que cierra la goroutine de cada
  petición en la del escenario; la prueba afirma exactamente el `Then` (201 o 409 con uno de los dos codes, al menos
  un 201, mismo id si hay dos, `totalElements: 1`), igual que la de keel-dotnet.
- **El arnés y los gates, a la primera**: sin `harnessPatches`, sin `culprit: harness`, sin fixes de `infra/` ni de
  `go.mod`. La caja negra (`check-flows.sh`) no estorbó.
- **`keel-go-quality` en verde sin editar nada** (`status: OK`, `issuesFixed: []`). Reverificado después de la
  corrida, desde fuera: `gofmt -l` vacío, `go vet` y `staticcheck` con y sin `-tags integration`, `go mod tidy -diff`,
  `govulncheck`, `check-domain-guards.sh`, `check-flows.sh` y `go test ./...`, todo limpio.

## Del generador

- **`go.mod` tras `go mod tidy` contaba como tocado** (latente; arreglado después de la corrida). `build` no escribe
  los indirectos a propósito (los calcula tidy con MVS); el flujo documentado ejecuta tidy, y desde ese momento la
  huella en disco ya no era la del manifiesto. `--check` decía «al día» mientras el generador no cambiara `go.mod`,
  pero en cuanto un keel-go nuevo subiera un directo, `--refresh` lo habría clasificado como `conflicto` en todos los
  proyectos, y `footprint` le apuntaba al agente un archivo que no escribió. **Arreglo**: las huellas de una ruta se
  calculan sobre la VISTA que da el generador (`viewOf` en `keel-core/src/lib/write.js`, neutral: `classifyGenerated`,
  `pruneOrphans`, el manifiesto y `footprint`). La de keel-go (`src/lib/digest-views.js`) quita los `// indirect` que
  no son el módulo de una herramienta del bloque `tool` y el bloque `require` que queda vacío; es la identidad sobre
  lo que emite build, así que los manifiestos ya escritos siguen valiendo. `footprint` carga las vistas del generador
  que firma el manifiesto: sobre ESTE proyecto, sin regenerar nada, ya da **7 reescritos** (los del agente).
- **Arreglado antes de la corrida**: el mensaje final de `keel-go build` aún decía que el pipeline «llega en el
  incremento 7»; ahora da `/keel-generate-go` como paso 3, como keel-dotnet.

## designGaps

(ninguno)
