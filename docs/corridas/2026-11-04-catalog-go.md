# Corrida `catalog` del registry — keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v0.1.4 (DSL 2.23, relacional, 8 capas), el de `keel-registry/specs/catalog` |
| Stack | `postgresql · rabbitmq · keycloak · minio · otel` |
| Generador | `keel-go@0.1.0` (`8617608a`) |
| Modelo del agente | Sonnet 5.5 (orquestador y subagentes) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** (`score-scenarios.sh` con código 0; 100 casos en 255 s, sin arbitraje) |
| Huella del agente | 376 archivos registrados por `build`, 0 adoptados, **35 reescritos**, 0 borrados |
| Clasificación de la huella | 35 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (provisional: ver § La huella) |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 1, fuera de la huella (ver § El hueco) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Proyecto en `keel-registry/services/catalog-go`, 28 minutos (sesión `0b1a11cd`). La clasificó quien arregló el generador, no un
agente de contexto limpio, así que no cuenta para H1.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`, porque reescribe los resultados: se leyó el JUnit que dejó (32 flujos de 32, 0 fallos, 0
omitidos). El sello de `specs/` está íntegro y coincide con `specs/catalog`. Las cuatro puertas estáticas, `go vet` con y sin
`integration`, staticcheck, gofmt y `go mod tidy -diff` se ejecutaron y están limpios. govulncheck es lo que declara el informe.

## El intento anterior

Una sesión previa con Haiku (`02a73bef`, 41 min) paró en la fase 2b con 29 OK, 2 fallos y 1 sin ejercitar. Señaló la página fuera
de rango y `description: null`, los dos asuntos de la v0.1.4 del diseño. Esta corrida cambia a la vez el diseño y el modelo, así que
la mejora no se puede atribuir a uno solo.

## El hueco

`TestUnaSubidaCompletaLlegaASuHandlerLeyendoLosCamposYElBinario`, de `internal/httpapi/api_test.go`, subía el archivo sin
`Idempotency-Key`. El diseño la exige, el handler responde 400 con razón, y la prueba da por malo cualquier 400: `go test ./...` quedó
en rojo y el agente, como manda la skill, no hizo commit.

- **Por qué no saltó antes:** recién generado, el handler responde 500, y la red `go-check` ejecuta los handlers sin implementar.
  `asset-vault` también sube con `client-key`, pero con un campo con `pattern` esta prueba no se emite.
- **Solo keel-go:** se midió sobre `catalog`, con una traza en el handler. En keel-nest y keel-dotnet el mediator abre antes la
  transacción y sale 500 sin llegar al handler, con o sin la cabecera.
- **Arreglo:** `d329a4ed`, con la variante `catalog-extended-upload-client-key`. Propagado con `--refresh`: solo cambió `api_test.go`,
  y `go test ./...` queda en verde.

**Lo que no cubre:** ninguna prueba del generador ejecuta Go con un handler con guarda. Si la cabecera se perdiera, lo cazaría la
comprobación de texto de `uncovered-branches.test.js`; el rojo real solo saldría en una corrida.

## Lo que dijo el informe, contrastado

Coincide con la huella y con el JUnit. Solo falla en el detalle del arreglo: pedía además un PNG y decía que el PDF daría 415. Con la
cabecera basta, porque el servidor de esa prueba no tiene dependencias y responde 500 antes de mirar el formato.

## La huella

| Reescrito | Clase |
|---|---|
| 28 `*_handler.go` | TODO |
| 4 `*_behavior.go` | TODO |
| `cmd/server/broker.go` | TODO |
| `internal/infrastructure/storage/storage.go` | TODO |
| `README.md` | TODO |

Es provisional: los archivos se clasificaron por su sitio, y se leyeron solo `add_product_image`, `remove_product_image`,
`create_product`, parte de `product_behavior.go`, `product_image_behavior.go`, `storage.go` y `broker.go`. Lo leído sigue el diseño.
De los flujos, se comparó con su escenario solo `FL-IMG-020`.

**Sigue sin medir que el binario desaparezca de MinIO.** `removeProductImage` lo borra con `afterCommit` (leído en el handler), pero
ningún escenario lo afirma, igual que en `2026-11-02-catalog-go-v2.md`.

## designGaps
