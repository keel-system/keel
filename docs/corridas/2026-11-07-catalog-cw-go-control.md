# Corrida de control de la escritura condicional (DSL 2.25) — `catalog-extended` en keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.0.0 (DSL 2.25, relacional, 8 capas), con `api.concurrency: required` sobre `updateProduct` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-go@0.2.0` (`6324bfda`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **55/55 OK** (a la primera, sin arbitraje) |
| Huella del agente | 354 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 22 TODO · 1 consulta · 0 generador · 0 diseño · 0 puerta (provisional) |
| Huecos del diseño | 6 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Convertidos en id | — |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-cw-go-postgre-rabbit\services\catalog-go`. Generado ya con el 415 de framework.

## Lo que medía

FL-PRD-006 entero y FL-PRD-002 en verde, con pruebas fieles al escenario. `UpdateProductCommandHandler` carga con
`LoadExpecting` y devuelve `Versioned[…]{Version: persistedVersion(saved), …}`. Gate en verde. El handler de subida rechaza
el tipo con `domain.Errorf(domain.ErrUnsupportedContentType, "El tipo del archivo no está permitido")`, el centinela y el
texto que pide la nota. Calidad en OK (govulncheck, staticcheck, gofmt y tidy limpios). El agente señala que el 413 y el
415 no tienen escenario propio.

## designGaps

- `remove-missing-child` — `removeProductImage` de una imagen que el producto no tiene: sin desenlace (hoy 204)
- `update-ref-error-undeclared` — `updateProduct` no declara `CATEGORY_NOT_FOUND` (hoy 422)
- `withdrawal-reason-unsourced` — compliance exige `reason` y `retireProduct` no lo recibe (hoy un literal)
- `slug-single-of-many` — `getProductBySlug` busca por el slug de la categoría y devuelve un solo producto sin decir cuál
- `category-no-create` — no hay operación que cree categorías (hueco declarado en la cabecera de la fixture)
- `given-provider-stubs` — el Given de FL-PRD-004, FL-PRD-005 y FL-CMP-001 no programa el stub de compliance
