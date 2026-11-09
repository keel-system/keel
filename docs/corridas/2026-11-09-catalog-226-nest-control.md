# Corrida de control de la serie `catalog-extended` sobre el cronómetro (DSL 2.26) — keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.0 (DSL 2.26, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-nest@0.2.0` (`2bd081c8` al generar) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **57/57 OK** (51/57 en la primera puntuación, seis `culprit: test`) |
| Huella del agente | 394 archivos registrados por `build`, 0 adoptados, **24 reescritos**, 0 borrados |
| Clasificación de la huella | TODO de handlers, agregados, proyección, adaptadores (ERP, S3), `broker-bindings.ts`, repositorio de `Product` y README · 0 generador · 0 puerta |
| Huecos del diseño | 6 en `design-gaps.yaml` |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-226-nest-postgre-rabbit\services\catalog-nest`. Repite
`2026-11-07-catalog-cw-nest-control.md` con el mismo stack, con el outbox, las purgas, los barridos y la reconciliación
sobre el cronómetro.

## Contra la serie 2.25

| | 2.25 (`catalog-cw-nest`) | 2.26 |
|---|---|---|
| Matriz | 55/55 (43/55 en la primera, un ciclo `culprit: code`) | 57/57 (51/57 en la primera, solo `culprit: test`) |
| Reescritos | 24 | 24 |
| Huecos del generador | 0 | 0 |

Los dos escenarios de más son de la fixture v1.1.0 (`d73b095d`). FL-OBX-001, FL-CMP-*, FL-DLQ-001 y FL-RTY-* en verde;
la huella no toca el cronómetro, el relay, las purgas ni el reclamo. `baselineTested: OK`.

## La primera puntuación

Seis fallos, todos de prueba y ninguno en `src/`: `seedCategory` no rellenaba `created_at` (FL-PRD-002-D y FL-IMG-001-B,
C y E en cascada), dos aserciones que el Then no fija (FL-IMG-001-D, FL-PRD-002-F) y un cierre exacto de `category`
que no contaba con `recordWithdrawalAwaitingSince` (FL-PRD-002-D).

## designGaps

- `upload-type-rejection` — `addProductImage` no declara 413, 415, `CATEGORY_NOT_FOUND` ni la parte `image` ausente (hoy 400 sin code)
- `category-no-create` — no hay operación que cree categorías (y la siembra tiene que poner `created_at`)
- `slug-single-of-many` — `getProductBySlug` no distingue la categoría inexistente de la vacía
- `awaiting-mark-cleanup` — `updateProduct` deja viajar `category.recordWithdrawalAwaitingSince`, que el diseño llama operativo
- `external-message-id` — el canal externo de `SupplierPriceChanged` no declara `contract.messageId`: FL-SUB-001-B no distingue deduplicación de upsert
- `nulls-omit-wording` — los Then dicen «viaja como nulo» con `conventions.nulls: omit`
