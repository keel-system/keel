# Corrida de control de la escritura condicional (DSL 2.25) — `catalog-extended` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.0.0 (DSL 2.25, relacional, 8 capas), con `api.concurrency: required` sobre `updateProduct` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-dotnet@0.2.0` (`6324bfda`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **55/55 OK** (una ronda de arbitraje, `culprit: test`) |
| Huella del agente | 406 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 22 TODO · 1 consulta · 0 generador · 0 diseño · 0 puerta (provisional) |
| Huecos del diseño | 7 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-cw-dotnet-postgre-rabbit\services\catalog-dotnet`. Generado ya con el 415 de framework.

## Lo que medía

FL-PRD-006 entero y FL-PRD-002 en verde, con pruebas fieles al escenario. `UpdateProductCommandHandler` carga con
`LoadExpecting` y devuelve `new Versioned<…>(saved.LockVersion ?? 0, …)`. Gate en verde. El handler de subida rechaza el tipo
con `throw new UnsupportedContentTypeException()`, lo que generó build, y ningún agente lo reportó ya como hueco. Pase de
calidad en OK: 245/245 pruebas unitarias y el baseline de migraciones verificado en vivo.

## El arbitraje

FL-PRD-002-D y FL-AUT-004 fallaban por `culprit: test`: la prueba exigía `category.recordWithdrawalAwaitingSince: null`,
que con `conventions.nulls: omit` no viaja. Lo corrigió el agente de pruebas; no es del generador.

## designGaps

- `withdrawal-reason-unsourced` — compliance exige `reason` y `retireProduct` no lo recibe
- `awaiting-mark-cleanup` — nadie declara si la reinscripción limpia `recordWithdrawalAwaitingSince`
- `update-ref-error-undeclared` — `updateProduct` no declara `CATEGORY_NOT_FOUND` (hoy 422, como `createProduct`)
- `remove-missing-child` — `removeProductImage` de una imagen que el producto no tiene: sin desenlace (hoy 204)
- `list-default-sort` — el orden por defecto de `listProducts` lo fijan los escenarios y las convenciones, no un `sort` del diseño
- `slug-single-of-many` — `getProductBySlug` busca por el slug de la categoría y devuelve un solo producto sin decir cuál
- `remove-deletes-binary` — el diseño no dice si `removeProductImage` borra también el binario del almacén
