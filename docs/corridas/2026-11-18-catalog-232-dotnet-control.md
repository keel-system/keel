# Corrida de control de la búsqueda (DSL 2.32) — `catalog-extended` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.32, relacional, 8 capas), con `statuses` (`in`), `q` (`search`) y `sortable` en `listProducts`, y `notCategoryId` (`ne`) y `sortable` en `listDraftProducts` |
| Stack | `postgresql · rabbitmq · redis · minio` (sin identidad; telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`881268c9`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **67/67 OK**. Primera pasada 65/67: FL-PRD-004-B y -D, `culprit: test`, por el circuito de compliance abierto por otro flujo |
| Huella del agente | 431 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Clasificación de la huella | 20 TODO · 2 consulta · README (§ Despliegue en producción, como en la 2.26) · 0 generador · 0 puerta |
| Huecos del diseño | 1 en `design-gaps.yaml` |
| Huecos del generador | 1 de la 2.32, el mismo de keel-spring, rodeado en silencio; 1 previo (`Decimals.SetScale` citado y no emitido) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-232-dotnet-postgre-rabbit\services\catalog-dotnet`. Tercera corrida de control
del incremento B9; repite la de la 2.26 (`2026-11-09-catalog-226-dotnet-control.md`) con el mismo stack.

## Lo que medía

- **La búsqueda de 2.32 por el contrato.** FL-PRD-005-E y FL-PRD-007-A a I salen en verde. Ninguno estuvo entre los
  dos fallos de la primera pasada.
- **Lo que escribe `build` no se toca.** El finder, `PageableReading.Read` con el `sortable` del endpoint y
  `TextValues.List` se quedan como los emitió `build`. La huella es la de la 2.26 (23), y la calidad sale con
  `baselineTested: OK`.

## Lo que se contrastó

- El informe, contra la matriz, `design-gaps.yaml` y `corrida-metrics.js footprint`.
- Los reescritos, contra un `build` del mismo snapshot con el generador de `881268c9`:
  - **20 de los 22 archivos con TODO.** No se tocaron `InboundContext.cs` ni `OutboxDispatcherFallback.cs`.
  - **2 de consulta:** `IProductRepository.cs` y `ProductRepository.cs`, para la regla en prosa de `getProductBySlug`.
  - **El README.**
- **El informe atribuye mal un hallazgo.** Dice que `SupplierPriceReader.cs:45` es código de `build` con
  `Math.Round`, y no lo es: el `Hydrate` era un TODO, y el redondeo lo escribió el agente. Lo que sí es del generador
  es lo que explica por qué el agente redondeó a mano: ver la segunda entrada de § Huecos del generador.

## Huecos del generador

- **La lista ausente de un `in`** (`§ Arreglos tras B9` del plan, arreglado en `8abae313`). El endpoint pone
  `Statuses = statuses ?? []` y el adaptador emitido filtraba con `if (filter.Statuses is { } statuses)`. El agente lo
  rodea en el handler con `query.Statuses.Count == 0 ? null : query.Statuses`. No lo cuenta.
- **Previo: las conventions mandan `Decimals.SetScale` y `build` no emite `Decimals.cs` aquí.** `constitution.md` y
  `domain-modeling.md` prescriben `Decimals.SetScale` (`Domain/Support/Decimals.cs`) para toda escala. `value-types.js`
  solo emite el archivo con value objects o con un mensaje que reescala, y este diseño tiene decimales sin ninguna de
  las dos cosas. El agente redondeó con `Math.Round(…, AwayFromZero)`, que da lo mismo.

## designGaps

- `upload-type-rejection`: `addProductImage` sin 413/415. Ya visto en la serie.

Al revés que en la 2.26, el informe sí cierra con su `design-gaps.yaml`. Los demás huecos conocidos del fixture, las
categorías sin alta y `draft → active` sin operación, el agente los da por aceptados en `decisions.yaml`
(`OBL-ENTITY-UNREACHABLE`) y no los repite.
