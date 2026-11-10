# Corrida de control de la serie `catalog-extended` sobre el cronómetro (DSL 2.26) — keel-go

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.26, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-go@0.2.0` (`77a34775` al generar) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **57/57 OK** (56/57 en la primera puntuación, un `culprit: test`) |
| Huella del agente | 368 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | TODO de handlers, comportamiento de los agregados, finders de `Product`, fallback del ERP, storage, `cmd/server/broker.go` y README · 0 generador · 0 puerta |
| Huecos del diseño | 3 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-226-go-postgre-rabbit\services\catalog-go`. Repite
`2026-11-07-catalog-cw-go-control.md` con el mismo stack, con el outbox, las purgas, los barridos y la reconciliación
sobre el cronómetro. Es la única de la serie generada directamente sobre la v1.1.1 (con el `sort` de `listProducts`).

## Contra la serie 2.25

| | 2.25 (`catalog-cw-go`) | 2.26 |
|---|---|---|
| Matriz | 55/55 a la primera | 57/57 (56/57 en la primera, `culprit: test`) |
| Reescritos | 23 | 23 |
| Huecos del generador | 0 | 0 |

FL-OBX-001, FL-CMP-*, FL-DLQ-001 y FL-RTY-* en verde; la huella no toca el cronómetro, el relay, las purgas ni el reclamo.

## La primera puntuación

FL-AUT-004 dependía del orden de la suite: FL-AUT-003 deja en caché un token vigente una hora y el 500 del emisor no se
llegaba a consultar. `RestartServer()` en el Given, como en los otros flujos del circuito. Es la misma familia que
FL-PRD-005 en keel-dotnet (el circuito de compliance abierto por otro flujo): estado de proceso que un flujo hereda de
otro. El agente lo subió además como hueco del escenario.

## designGaps

- `upload-type-rejection` — `addProductImage` no declara `FILE_TOO_LARGE` (413) ni `UNSUPPORTED_CONTENT_TYPE` (415)
- `draft-publish-no-op` — el lifecycle permite `draft → active` y ninguna operación la ejecuta
- `given-token-cache` — el Given de FL-AUT-004 no fija la caché del token OAuth2 vacía
