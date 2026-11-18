# Corrida de control de la búsqueda (DSL 2.32) — `catalog-extended` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.32, relacional, 8 capas), con `statuses` (`in`), `q` (`search`) y `sortable` en `listProducts`, y `notCategoryId` (`ne`) y `sortable` en `listDraftProducts` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad; telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`881268c9`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **67/67 OK** a la primera puntuación (sin arbitrajes) |
| Huella del agente | 395 archivos registrados por `build`, 0 adoptados, **24 reescritos**, 0 borrados |
| Clasificación de la huella | 21 TODO · 2 consulta · README (§ Despliegue en producción, como en la 2.26) · 0 generador · 0 puerta |
| Huecos del diseño | 6 en `design-gaps.yaml` |
| Huecos del generador | 1 de la 2.32, el mismo de keel-spring, rodeado en silencio (la lista ausente de un `in`) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-232-nest-postgre-rabbit\services\catalog-nest`. Segunda corrida de control del
incremento B9; repite la de la 2.26 (`2026-11-09-catalog-226-nest-control.md`) con el mismo stack.

## Lo que medía

- **La búsqueda de 2.32 por el contrato.** FL-PRD-005-E y FL-PRD-007-A a I, en verde a la primera.
- **Lo que escribe `build` no se toca.** El finder, `readPageable`/`readSort` y `text.listOf` se quedan como los emitió
  `build`. Respecto a la 2.26 (51/57 en la primera puntuación, seis `culprit: test`), esta sale 67/67 sin arbitraje y
  con la misma huella, 24.

## Lo que se contrastó

- El informe, contra la matriz que trae, `design-gaps.yaml` y `corrida-metrics.js footprint`.
- Los reescritos, contra un `build` del mismo snapshot con el generador de `881268c9`:
  - **21 de los 23 archivos con TODO.** No se tocaron `inbound-context.ts` ni `outbox-dispatcher-fallback.ts`.
  - **2 de consulta:** `product-repository.ts` y su adaptador, para la regla en prosa de `getProductBySlug`.
  - **El README**, como en la 2.26.

## Huecos del generador

- **La lista ausente de un `in`** (`§ Arreglos tras B9` del plan, arreglado en `8abae313`). El borde pone
  `statuses ?? []`, y el adaptador emitido comparaba con nulo: `if (filter.statuses != null) and('status',
  In(filter.statuses))`. El handler del agente lo rodea con `query.statuses.length > 0 ? [...query.statuses] : null`,
  con un comentario que dice que la vacía es «sin filtro». No lo cuenta el informe. Como el arreglo cae dentro de un
  archivo con TODO, la huella no lo ve.

## designGaps

- `upload-type-rejection`: `addProductImage` sin 413/415 ni su orden de comprobación. Ya visto en la serie.
- `reactivate-awaiting-mark`: no se dice si `reactivateWithdrawnProduct` limpia `recordWithdrawalAwaitingSince`.
- `replica-on-unavailable`: `pricing.supplierPrice` sin `onUnavailable`. Si pricing cae en un listado, el campo se omite.
- `scenario-body-misses-exposed-fields`: FL-PRD-002-B y FL-IMG-001-B/C sin `currentPrice`, `productCost` ni el
  `productId` de la imagen. Lo mismo que vio keel-spring.
- `withdrawal-stub-in-given`: los flujos que retiran un producto no ponen en el Given el stub de `recordWithdrawal`.
- `category-no-create`: ninguna operación crea categorías. Ya visto en la serie.

Ninguno es de la búsqueda.
