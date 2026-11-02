# Corrida `asset-vault` — keel-go (incremento 13i)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.2 (DSL 2.23, documental, 9 capas), la de la fixture con su `DESIGN.md` |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-go@0.1.0` (`3baae545`, con el arreglo del intento parado) |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** (`score-scenarios.sh` con código 0; 62 casos en 413 s) |
| Huella del agente | 306 archivos registrados por `build`, 0 adoptados, **16 reescritos**, 0 borrados |
| Clasificación de la huella | 14 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`) |
| Huecos del generador | 1, del intento parado (ver § El intento parado) |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |
| Coste del diseño | sin coste nuevo: el diseño es el de las gemelas |

La corrida de control documental del incremento 13 de `PLAN-KEEL-GO.md`: almacenamiento, caché, alcance por recurso y
reconciliación sobre MongoDB. Misma matriz que su gemela de keel-dotnet (`2026-10-16-asset-vault-dotnet.md`: 32/32, huella 21),
con 5 reescritos menos: los 5 que allí eran huecos del generador. Workspace: `spring-live-test/corrida-asset-vault-go-1102`.

La clasificación la hizo quien arregló el generador, leyendo los reescritos, y no un agente de contexto limpio: es una
corrida de control del generador y no cuenta para H1.

## El intento parado

`spring-live-test/corrida-asset-vault-go`, con el generador `ea87c88a`, parado en la fase 1 y sin puntuar; queda como registro.
`listAssets` no recibía `CallerScope`: solo lo recibía quien declara el error del alcance, y un listado filtra y responde 200. Su
regla acota el listado y `FL-AST-004-B` lo afirma, y `NewUseCases` es de build, así que el agente no tenía cómo cumplirla. El
defecto entró en el 13h-b. Ahora lo reciben todos los handlers. Se repitió en un espacio nuevo porque `--refresh` dejaría sin
compilar los constructores que el agente ya había escrito.

## La huella

| Reescritos | Clase |
|---|---|
| 7 handlers de `internal/application` | TODO |
| 3 `<entidad>_behavior.go` | TODO |
| `rendering_fallback.go` | TODO |
| `storage.go`, el adaptador S3 | TODO |
| `cmd/server/broker.go` | TODO |
| `README.md` | TODO |
| `asset_queries.go`, en `internal/domain` y en `mongo` (`ListByOwnerIDs`) | consulta |

## Lo que dijo el informe, contrastado

Coincide con la huella y con el JUnit: los 32 ids de `specs/validation-scenarios.md` están en `junit.xml`, ninguno de más, con 0
fallos. Una precisión: llama «literal» a una matriz que resume por rangos.

Lo que el informe no cuenta, leído en el código:

- **El arreglo del alcance se cumple.** `listAssets` usa `IsExempt` y, si no, `ScopedValues` con el `$in` en la base
  (`ListByOwnerIDs`). `FL-AST-004-B` lo afirma con `TokenWithScope("vault-reader", "OTRO")`: página vacía.
- **Primer uso real de `afterCommit`.** `quarantineAsset` retira la miniatura tras confirmar, sin que nada se lo pidiera en concreto,
  y `FL-QUA-001` lo ejecuta de punta a punta. Mide el camino bueno; que no ocurra si revierte lo mide la prueba emitida. El borrado
  de un binario tras confirmar sigue sin medir: aquí ninguna regla lo pide.
- **`settlementLogger(ctx)`.** `uploadAsset` lo usa para registrar el fallo de la limpieza del binario. Nació como detalle interno
  de `afterCommit`, y resuelve el hueco anotado en `2026-11-02-catalog-go.md` (un handler no recibe logger) sin que ninguna doc lo
  enseñe. Falta enseñarlo o darle un nombre de verdad.

## Sin arreglar

- Los campos que el agente sí usa conservan `//lint:ignore U1000 lo usa la lógica que escribe el agente (el TODO de Handle)`. No rompe
  nada: el comentario queda viejo. En `catalog` el agente los reescribió a mano.
- Del primer intento: el agente de pruebas entregó cuatro archivos sin `gofmt`; el orquestador lo comprobó vacío después.

## designGaps
