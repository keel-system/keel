# Corrida de control de la búsqueda (DSL 2.32) — `catalog-extended` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.32, relacional, 8 capas), con `statuses` (`in`), `q` (`search` sobre `name` y `sku`) y `sortable` en `listProducts`, y `notCategoryId` (`ne`) y `sortable` en `listDraftProducts` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad: el diseño no tiene capa security; telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`881268c9`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **67/67 OK** a la primera (sin arbitrajes; el agente de validación no se invocó) |
| Huella del agente | 421 archivos registrados por `build`, 0 adoptados, **21 reescritos**, 0 borrados |
| Clasificación de la huella | 19 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 7 en `design-gaps.yaml` (dos ya vistos en la serie; cinco nuevos, ver § designGaps) |
| Huecos del generador | 1 de la 2.32, que el agente rodeó en silencio (la lista ausente de un `in`), y 1 previo del contrato (`size` con `maximum`) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-232-spring-postgre-rabbit\services\catalog-spring`. Primera de las cinco corridas
de control del incremento B9 de `PLAN-DSL-231-232-INVARIANTES-Y-BUSQUEDA.md`. Repite la de la 2.26
(`2026-11-09-catalog-226-spring-control.md`) con el mismo stack y los escenarios nuevos FL-PRD-005-E y FL-PRD-007.

## Lo que medía

- **La búsqueda de 2.32 por el contrato.** `ProductSearchFlowIT` escribe FL-PRD-007 tal como lo dice el escenario:
  - `statuses` con un valor, repetido y separado por comas;
  - `?statuses=` y `?statuses=draft,` como 400 `VALIDATION_ERROR`;
  - `q=portatil` por el nombre y `q=srch-3` por el sku;
  - `50%`, `%` y `_` como literales (`_` da la página vacía);
  - filtro y texto sumados;
  - `?sort=name` y `?sort=sku,desc` sustituyendo al orden del diseño;
  - los cuatro `?sort=` inválidos como 400.

  `DraftListingFlowIT` cubre FL-PRD-005-E (`notCategoryId`). Todo en verde.
- **Lo que escribe `build` no se toca.** No se toca ni el finder (`listProducts` y `listDraftProducts` en
  `ProductRepositoryImpl`), ni `QueryParameters`, ni la lista blanca `LIST_PRODUCTS_SORTABLE` del controlador. Los dos
  handlers de los listados solo llaman al finder.

## Lo que se contrastó

- El informe contra el proyecto:
  - la matriz es la de `infra/score-scenarios.sh` (código 0, 67 escenarios);
  - `design-gaps.yaml` existe con 7 huecos;
  - la huella la imprime `corrida-metrics.js footprint`.
- Los reescritos, contra un `build` del mismo snapshot en limpio:
  - **19 de los 20 archivos con TODO.** No se tocó `OutboxDispatcherFallbackConfig`.
  - **2 de consulta:** `ProductRepository` y `ProductRepositoryImpl`, con el método `findLatestByCategoryId`. Lo
    añadió el agente para la regla en prosa de `getProductBySlug` («el más reciente de la categoría»), que no tiene
    finder.
- Respecto a la 2.26: la matriz pasa de 57 a 67 escenarios (los diez de FL-PRD-005-E y FL-PRD-007) y la huella baja de
  22 a 21 reescritos.

## Huecos del generador

- **La lista ausente de un `in` llega al finder como lista vacía (2.32; keel-spring, keel-nest y keel-dotnet).** Por
  el contrato del cable, el record `ListProductsQuery` normaliza una lista no informada a `List.of()`. El finder, en
  cambio, solo deja de filtrar con `null` (`if (filter.statuses() != null)`), y la nota del handler manda pasarle
  `query.statuses()` tal cual. Si el agente hubiera seguido la nota, `GET /products` sin `statuses` sería `status IN ()`:
  la página vacía, y FL-PRD-003 y FL-PRD-007 en rojo. El agente lo vio y lo rodeó en el handler
  (`query.statuses().isEmpty() ? null : …`), y el informe no lo cuenta.

  Ninguna red lo veía: `finder-check` llama al adaptador con `null`, y el handler es del agente. keel-nest y
  keel-dotnet emiten lo mismo (`statuses ?? []` en el borde, el finder comparando con nulo). keel-go no, porque
  `listParam` deja `nil`. Arreglo, en § Arreglos tras B9 del plan.
- **Previo, fuera de la 2.32: `size` anuncia `maximum` en el contrato.** `gen/openapi.js` pone `maximum: maxSize` en
  el parámetro `size`, que un cliente que valide leería como «500 es un 400», y el servidor acota a 100 (FL-PRD-003-E,
  `wire-contract.md`). Lo destapó el `designGap` `size-cap-vs-openapi-maximum`, que el agente puso como contradicción
  del diseño. Es del contrato derivado, el mismo en los cuatro generadores desde la 2.22.

## designGaps

- `draft-publish-no-op`: ninguna operación lleva un producto de `draft` a `active`. Ya visto en la serie; hueco 4
  declarado del fixture.
- `upload-type-rejection`: `addProductImage` no declara `FILE_TOO_LARGE` (413) ni `UNSUPPORTED_CONTENT_TYPE` (415).
  Ya visto en la serie; hueco 2 declarado del fixture.
- `slug-tiebreak-direction`: la regla de `getProductBySlug` dice «ante empate, el id» sin dirección. Se implementó
  ascendente.
- `scenario-body-misses-exposed-fields`: el `Then` de FL-PRD-002-B y FL-AUT-001 enumera el cuerpo sin `currentPrice`
  ni `productCost`, que el contrato expone. Es texto del escenario.
- `scenario-image-misses-product-id`: FL-IMG-001-B enumera cuatro campos de la imagen, y `productId` es obligatorio en
  el contrato. Es texto del escenario.
- `size-cap-vs-openapi-maximum`: lo de § Huecos del generador. No es del diseño.
- `bad-contract-error-code`: FL-CMP-003 solo afirma un 500 con un `code` distinto de `COMPLIANCE_UNAVAILABLE`, y nadie
  fija cuál.

Ninguno es de la búsqueda. `list-order-in-prose` no sale.
