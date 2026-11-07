# Corrida de control de la escritura condicional (DSL 2.25) — `catalog-extended` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.0.0 (DSL 2.25, relacional, 8 capas), con `api.concurrency: required` sobre `updateProduct` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-nest@0.2.0` (`16eb1dad` al generar; `6324bfda` en la evolución) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **55/55 OK** (43/55 en la primera puntuación, un ciclo de `culprit: code`) |
| Huella del agente | 375 archivos registrados por `build`, 0 adoptados, **24 reescritos**, 0 borrados |
| Clasificación de la huella | 23 TODO · 1 consulta · 0 generador · 0 diseño · 0 puerta (provisional) |
| Huecos del diseño | 8 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Convertidos en id | `UNSUPPORTED_CONTENT_TYPE` (415): su 400 `VALIDATION_ERROR` frente al 400 `UNSUPPORTED_CONTENT_TYPE` de keel-spring destapó la divergencia |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-cw-nest-postgre-rabbit\services\catalog-nest`. Generado sobre la fixture ya corregida
(sin los dos escenarios que pararon la primera de keel-spring).

## Lo que medía

FL-PRD-006 entero y FL-PRD-002 en verde, con pruebas fieles al escenario (el 428 también con la cabecera vacía, el 412 sin
contar ningún `ProductUpdated`, el `W/`, tres ETag distintos). `updateProduct` carga con `loadExpecting` y devuelve
`versioned(saved.lockVersion ?? 0, …)`; `getProductBySlug` devuelve `Versioned` por la caché. Gate en verde; en el
adaptador el agente solo añadió `findLatestByCategoryId`, el mismo finder que escribió el de keel-spring.

## La primera puntuación

43/55 por una causa única, arbitrada como `culprit: code`: `SupplierPriceReader.hydrate` dejaba subir el fallo de pricing a
`listProducts` y `getProductsByIds`. Un ciclo del agente de código.

## La evolución

Tras `6324bfda` el proyecto se refrescó y cerró en modo evolución con una sola fusión, el handler de subida: el tipo
rechazado pasa de 400 `VALIDATION_ERROR` a `UnsupportedContentTypeException` (415). 55/55 y `npm test` 92/92. Ningún
escenario cubre el tipo rechazado.

## designGaps

- `upload-type-rejection` — el tipo de archivo rechazado no tenía código: el agente respondió 400 `VALIDATION_ERROR` (convertido en el 415 de framework)
- `remove-missing-child` — `removeProductImage` de una imagen que el producto no tiene: sin desenlace declarado (hoy 204)
- `withdrawal-reason-unsourced` — compliance exige `reason` y `retireProduct` no lo recibe (hoy un literal)
- `withdrawal-unanswered-outcome` — el barrido de retiradas sin respuesta reinscribe y no dice cuándo para
- `slug-single-of-many` — `getProductBySlug` busca por el slug de la categoría y devuelve un solo producto sin decir cuál
- `patch-null-required` — la regla de `updateProduct` («un nulo vacía el campo») promete más de lo que el dominio admite
- `need-onunavailable` — `supplierPrice` no declara `onUnavailable` (`keel validate` lo avisaba)
- `category-no-create` — no hay operación que cree categorías (hueco declarado en la cabecera de la fixture)
