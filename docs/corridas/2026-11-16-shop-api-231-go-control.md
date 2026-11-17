# Corrida de control de la guarda del agregado (DSL 2.31) — `shop-api` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `shop-api` v0.1.1 (DSL 2.31, relacional, 5 capas), con el `exactlyOne: [cart, order]` de `ProductInOrder`, la cota de `count` como invariante de la línea y U6 (`createProduct` con `input.fields`, `ProductInfo.productStock` sin máximo) |
| Stack | `postgresql · keycloak` (sin broker, caché ni storage; telemetría `none`) |
| Generador | `keel-go@0.2.0` (`ddcd183f` al generar) |
| Diseño listo al generar | no, con --accept-unready (characterized, design-doc, gaps, review, structural) |
| Papel | control |
| Matriz final | **92/92 OK** (el informe no da la primera pasada) |
| Huella del agente | 292 archivos registrados por `build`, 0 adoptados, **25 reescritos**, 0 borrados |
| Clasificación de la huella | 24 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (no hay `design-gaps.yaml`, y el informe no cuenta ninguno) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\shop-231-go-postgre\services\shop-api-go`. Cuarta de las cinco corridas de control del
incremento A9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`. La referencia es `2026-11-11-shop-api-227-go-control.md`.

## Lo que medía

- **`cart-line-sum-over-max` desaparece.** `ProductInOrder.AddCount` suma sin comprobar, con el comentario «una suma que
  pasa del máximo la rechaza la guarda», y ningún handler de `internal/application` repite la cota. No sale como
  `designGap`.
- **Lo que escribe `build` no se toca.** El `EnsureInvariants() error` de las cinco raíces es byte a byte el que emite
  `build` hoy, y ningún adaptador está entre los reescritos.
- **La huella baja de 28 a 25 reescritos**: 24 partían de un TODO (19 handlers y los 5 `*_behavior.go`) y el `README.md`
  gana una sección que no es una decisión. Esta vez `go.mod` solo cambió por los indirectos de `go mod tidy`, y
  `deploy/Dockerfile` no se tocó: los dos «generador» de la 2.27 no vuelven.

## Lo que se contrastó

- La matriz es la de `infra/score-scenarios.sh` (código 0), no hay `design-gaps.yaml`, y la huella la imprime
  `corrida-metrics.js footprint`.
- La guarda, con el mismo script que las otras tres corridas: 5 iguales, 0 distintas, 0 ausentes.
- **La escala de `productPrice`** (el hueco de las corridas de keel-nest y keel-dotnet): el agente no escribió ningún
  `Rescale` en `ProductInfo` y los escenarios de `30` → `30.00` pasan. El `Save` de keel-go relee la fila guardada
  («la fila guardada no se pudo releer»), y la columna `numeric(19,2)` ya trae la escala; keel-spring pasa igual. El hueco es de los dos generadores cuyo `save`
  devuelve la entidad en memoria.

## Hallazgos del agente

El agente de calidad reportó, sin aplicarlos, cuatro N+1 en `cancel_order`, `checkout`, `list_orders` y `merge_cart`
(una consulta por línea o por pedido). En keel-nest el agente los evitó con lecturas por lote (`findAllByIds`), que allí
cuentan como consulta en la huella.

## designGaps

Ninguno: no hay `design-gaps.yaml` y el informe no cuenta ninguno.
