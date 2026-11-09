# Corrida de control de la serie `catalog-extended` sobre el cronómetro (DSL 2.26) — keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.0 (DSL 2.26, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad: el diseño no tiene capa security) |
| Generador | `keel-spring@0.3.0` (`2bd081c8` al generar) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **57/57 OK** en la primera generación, sin arbitraje ni ciclos de reparación |
| Huella del agente | 419 archivos registrados por `build`, 0 adoptados, **22 reescritos**, 0 borrados |
| Clasificación de la huella | TODO de handlers, agregados, proyección, adaptador saliente y finders del repositorio de `Product` · 0 generador · 0 puerta |
| Huecos del diseño | 3 en `design-gaps.yaml` (los tres ya vistos en la serie 2.25) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-226-spring-postgre-rabbit\services\catalog-spring`. Repite la corrida
`2026-11-07-catalog-cw-spring-control.md` con el mismo stack, ahora con el outbox, las purgas, los barridos y la
reconciliación sobre el cronómetro (incrementos 7 a 9 del plan).

## Contra la serie 2.25

| | 2.25 (`catalog-cw-spring`) | 2.26 |
|---|---|---|
| Matriz | 55/55 tras la evolución (53/55 en la primera) | 57/57 en la primera |
| Reescritos | 22 | 22 |
| Huecos del generador | 1 (`exchangeWithHeaders`) | 0 |

Los dos escenarios de más son de la fixture v1.1.0 (`d73b095d`), no del cronómetro. Lo que la puerta pedía —igual que
en 2.25— se cumple: FL-OBX-001, FL-CMP-*, FL-DLQ-001 y FL-RTY-* (el outbox, la reconciliación y los reintentos) en verde, y
nada de la huella toca el cronómetro, el relay, las purgas ni el reclamo: lo reescrito es lo de siempre.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`: se leyó el JUnit (22 clases, ninguna con `<failure>`), la huella y `design-gaps.yaml`.

## El orden que el agente adivinó

`listProducts` no declaraba `sort` en la v1.1.0 (`CHK-USECASES-COLLECTION-NO-SORT`, uno de los `undecided` del
`--accept-unready`): el contrato era el orden por id. FL-PRD-003-B y -C afirman `createdAt` descendente, que solo
decía la prosa de la convención «Orden de las colecciones». El agente lo escribió a mano en `ListProductsQueryHandler.java`
(`createdAt` desc, `sku` asc) y no lo reportó como hueco: pasó, pero desviado del spec sin decirlo. La corrida de
keel-dotnet se paró ahí con `culprit: design`, y la fixture lo declara desde la v1.1.1.

## designGaps

- `list-order-in-prose` — `listProducts` sin `sort`: el orden de los escenarios solo estaba en prosa (no reportado; cerrado en la v1.1.1)

- `upload-type-rejection` — `addProductImage` no declara `FILE_TOO_LARGE` (413) ni `UNSUPPORTED_CONTENT_TYPE` (415); el código los usa por convención
- `category-no-create` — no hay operación que cree categorías: los escenarios las siembran por SQL
- `draft-publish-no-op` — el lifecycle permite `draft → active` y ninguna operación la ejecuta
