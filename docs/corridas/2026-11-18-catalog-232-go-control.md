# Corrida de control de la búsqueda (DSL 2.32) — `catalog-extended` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.32, relacional, 8 capas), con `statuses` (`in`), `q` (`search`) y `sortable` en `listProducts`, y `notCategoryId` (`ne`) y `sortable` en `listDraftProducts` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad; telemetría `none`) |
| Generador | `keel-go@0.2.0` (`881268c9`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **67/67 OK**. Primera pasada 65/67: FL-IMG-001-D y FL-PRD-002-F, `culprit: test`, porque las pruebas exigían más que el Then |
| Huella del agente | 368 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 20 del agente (handlers, `_behavior.go`, `hydrate`, fallback, `broker.go`, `storage.go`) · 2 consulta (`product_queries.go` del dominio y del motor) · README · 0 generador · 0 puerta |
| Huecos del diseño | 2 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-232-go-postgre-rabbit\services\catalog-go`. Cuarta corrida de control del
incremento B9; repite la de la 2.26 (`2026-11-09-catalog-226-go-control.md`) con el mismo stack.

## Lo que medía

- **La búsqueda de 2.32 por el contrato.** FL-PRD-005-E y FL-PRD-007-A a I, en verde. Ninguno estuvo entre los dos
  fallos de la primera pasada.
- **Lo que escribe `build` no se toca.** El finder (`f.oneOf`, `f.distinct`, `f.anyLike`), `pageableParam`/`sortParam`
  y `listParam` se quedan como los emitió `build`. La huella es la de la 2.26 (23).
- **El defecto del `in` que destaparon las otras tres no está aquí.** `listParam` deja `nil` cuando la lista no
  viene, y el handler del agente pasa `query.Statuses` tal cual. El arreglo de `8abae313` cambia de todos modos el
  finder a `len(statuses) > 0`, para que FS-11 valga igual en los cuatro.

## Lo que se contrastó

- El informe, contra la matriz, `design-gaps.yaml` y `corrida-metrics.js footprint`.
- **Las dos directivas `//lint:ignore U1000` que el informe señala en archivos generados** (`supplier_price_reader.go`
  y `product.go`) son de `build`, a propósito. Marcan lo que llamará el código del agente (`pricingClient` para la
  `hydrate`, `transitionTo` para los métodos semánticos). El agente de calidad quitó solo las sobrantes del código del
  agente. No es un hueco.

## designGaps

- `upload-type-rejection`: `addProductImage` sin 413/415. Ya visto en la serie.
- `draft-publish-no-op`: ninguna operación lleva un producto de `draft` a `active`. Ya visto en la serie.

Ninguno es de la búsqueda.
