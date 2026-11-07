# Corrida de control de la escritura condicional (DSL 2.25) — `catalog-extended` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.0.0 (DSL 2.25, relacional, 8 capas), con `api.concurrency: required` sobre `updateProduct` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad: el diseño no tiene capa security) |
| Generador | `keel-spring@0.3.0` (`4545203c` al generar; `6324bfda` en la evolución) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **55/55 OK** tras la evolución (la primera generación se paró en 53/55) |
| Huella del agente | 397 archivos registrados por `build`, 0 adoptados, **22 reescritos**, 0 borrados |
| Clasificación de la huella | 21 TODO · 1 consulta · 0 generador · 0 diseño · 0 puerta (provisional: la hizo quien arregló el generador, no un agente de contexto limpio) |
| Huecos del diseño | 7 en `design-gaps.yaml` (2 de ellos, defectos de escenario de la fixture ya corregidos) |
| Huecos del generador | 1 (`exchangeWithHeaders` solo con CORS), arreglado en `fd024528` |
| Convertidos en id | `UNSUPPORTED_CONTENT_TYPE` (415) en la lista cerrada de framework-errors (`6324bfda`), por la divergencia con keel-nest |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-cw-spring-postgre-rabbit\services\catalog-spring`. Es la corrida de control del
incremento 6 de `PLAN-DSL-225-ESCRITURA-CONDICIONAL.md`: lo único que mide lo que escribe el agente.

## Lo que medía

FL-PRD-006 entero (el 428 sin If-Match, la edición con la versión leída, la edición encadenada sin releer, el 412 con la
lectura vieja, el ETag débil y el 404 antes que el 412) y FL-PRD-002 (el ETag sobrevive a la caché): en verde en la primera
generación, con pruebas fieles al escenario. El agente escribió `updateProduct` con `loadExpecting` y devolvió
`new Versioned<>(saved.getLockVersion(), …)`, la versión de lo que dejó `save`; `getProductBySlug` devuelve `Versioned`
pasando por la caché. `infra/check-conditional-writes.sh` en verde, y en el adaptador el agente solo añadió un finder
(`findLatestByCategoryId`): `loadExpecting` y `forceNewVersion` siguen como los dejó build.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: se leyó el JUnit, se ejecutó el gate (solo lee) y se compararon los tres archivos del
repositorio de `Product` con lo que emite build (ignorando los finales de línea).

## La primera generación y la evolución

La primera generación se paró en el arbitraje con 53/55: dos defectos de escenario que la fixture ya traía, ajenos a la
escritura condicional y bien clasificados por el árbitro como `culprit: design`. FL-PRD-001-A pedía `Location` sin lectura
por id (`CHK-API-CREATED-NO-READ` ya lo avisaba) y FL-PRD-003-D esperaba total 3 en la página vacía, que el contrato del
cable da a 0/0. Se corrigieron en la fixture (`16eb1dad`, junto con el `expectedVersion` de `updateProduct`, redundante con
If-Match) y el proyecto se cerró en modo evolución: reescritas las dos pruebas, fusionado el handler de subida al 415 y
55/55 con el pase de calidad en OK.

## El hueco del generador

`AbstractFlowIT` solo emitía `exchangeWithHeaders` con CORS, así que con escritura condicional y sin seguridad el arnés no
tenía cómo mandar If-Match: el agente de pruebas se escribió un `patchIfMatch`. Arreglado en `fd024528` (se emite también
con `api.concurrency`, `compile-check` en verde). El informe de la evolución arrastra el hallazgo en su § 2, pero el arnés
refrescado ya lo trae.

## designGaps

- `location-without-read` — FL-PRD-001-A pedía `Location` en el 201 sin operación que lea el producto (corregido en la fixture)
- `empty-page-total` — FL-PRD-003-D esperaba el total en la página vacía, contra el contrato del cable (corregido en la fixture)
- `upload-type-rejection` — el tipo de archivo rechazado no tenía código: el agente respondió 400 `UNSUPPORTED_CONTENT_TYPE` (convertido en el 415 de framework)
- `update-ref-error-undeclared` — `updateProduct` no declara `CATEGORY_NOT_FOUND` para un `categoryId` inexistente (sí `createProduct`)
- `expectedversion-redundant` — `updateProduct` aceptaba `expectedVersion` en el cuerpo, redundante con If-Match (quitado de la fixture)
- `slug-single-of-many` — `getProductBySlug` busca por el slug de la categoría y devuelve un solo producto sin decir cuál
- `awaiting-mark-cleanup` — nadie declara quién limpia `recordWithdrawalAwaitingSince` al reconciliar
- `category-no-create` — no hay operación que cree categorías (hueco declarado en la cabecera de la fixture)
- `given-provider-stubs` — el Given de las retiradas no programa compliance ni el del listado pricing
