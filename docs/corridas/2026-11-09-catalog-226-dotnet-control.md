# Corrida de control de la serie `catalog-extended` sobre el cronómetro (DSL 2.26) — keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.0, evolucionado a v1.1.1 (DSL 2.26, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad) |
| Generador | `keel-dotnet@0.2.0` (`2bd081c8` al generar; `77a34775` en la evolución) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **57/57 OK** tras la evolución (la primera generación se paró en 55/57, `culprit: design`) |
| Huella del agente | 430 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | TODO de handlers, agregados, proyección, adaptadores (ERP, S3), `BrokerBindings.cs`, repositorio de `Product` y README · 0 generador · 0 puerta |
| Huecos del diseño | 1 (el orden de `listProducts`), cerrado en la fixture v1.1.1; `design-gaps.yaml` no se escribió |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-226-dotnet-postgre-rabbit\services\catalog-dotnet`. Repite
`2026-11-07-catalog-cw-dotnet-control.md` con el mismo stack, con el outbox, las purgas, los barridos y la
reconciliación sobre el cronómetro.

## Contra la serie 2.25

| | 2.25 (`catalog-cw-dotnet`) | 2.26 |
|---|---|---|
| Matriz | 55/55 (un arbitraje, `culprit: test`) | 57/57 tras una evolución por un hueco del diseño |
| Reescritos | 23 | 23 |
| Huecos del generador | 0 | 0 |

FL-OBX-001, FL-CMP-*, FL-DLQ-001 y FL-RTY-* en verde; la huella no toca el cronómetro, el relay, las purgas ni el reclamo.
Baseline de migraciones verificado en vivo.

## La parada y la evolución

La primera generación quedó en 55/57: FL-PRD-003-B y -C afirman `createdAt` descendente y `listProducts` no declaraba
`sort` (`CHK-USECASES-COLLECTION-NO-SORT`, uno de los `undecided` del `--accept-unready`), así que el servidor ordenaba
por id, que es el contrato. El árbitro lo dio por `culprit: design` y la corrida se paró sin desviarse del spec: es la
única de las tres que no improvisó el orden. Antes de parar arregló cinco fallos de prueba (una aserción de un 400 no
declarado en FL-PRD-002-F; el circuito de compliance abierto por otro flujo en FL-PRD-005-A..D, con
`RestartServerAsync()` en el `Given`).

La fixture lo declara desde la v1.1.1 (`77a34775`): `build --refresh --prune` y `/keel-generate-dotnet` en modo
evolución. Con el `sort` declarado, build emite el orden por defecto en el endpoint, así que el agente no cambió código
y la suite completa dio 57/57.

## designGaps

- `list-order-in-prose` — `listProducts` sin `sort`: el orden de los escenarios solo estaba en prosa (cerrado en la v1.1.1)

Los otros que los agentes de código y de pruebas anotaron en la primera generación no llegaron a `design-gaps.yaml`:
la corrida se paró antes del informe y la evolución solo ve el delta. Es una pérdida del método: un `designGap` vive
en la memoria del orquestador hasta el informe.
