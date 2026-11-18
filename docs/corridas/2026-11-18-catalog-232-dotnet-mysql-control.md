# Corrida de control de la búsqueda (DSL 2.32) — `catalog-extended` en keel-dotnet sobre MySQL

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog-extended` (servicio `catalog`) v1.1.1 (DSL 2.32, relacional, 8 capas), con `statuses` (`in`), `q` (`search`) y `sortable` en `listProducts`, y `notCategoryId` (`ne`) y `sortable` en `listDraftProducts` |
| Stack | `mysql · rabbitmq · redis · minio` (sin identidad; telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`881268c9`, antes de los arreglos de `8abae313` y `74fb2bf5`) |
| Diseño listo al generar | no, con --accept-unready (coverage-matrix, design-doc, flow-review, gaps, incoherences, review, structural, undecided) |
| Papel | control |
| Matriz final | **67/67 OK** a la primera (sin arbitrajes) |
| Huella del agente | 431 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados, y un archivo nuevo del agente (`Application/Support/Amounts.cs`) |
| Clasificación de la huella | 20 TODO · 2 consulta · README · 0 generador · 0 puerta |
| Huecos del diseño | 3 en `design-gaps.yaml` |
| Huecos del generador | los dos de la corrida de PostgreSQL, ya arreglados, rodeados de nuevo en silencio |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-232-dotnet-mysql-rabbit\services\catalog-dotnet`. Quinta y última corrida de
control del incremento B9. Es la primera de keel-dotnet sobre MySQL desde la 2.21; la de MySQL de A9 fue de keel-nest y
la de la 2.30, de keel-spring.

## Lo que medía

- **La búsqueda de 2.32 en el motor donde el orden del texto es distinto.** MySQL ordena el texto no único con
  `utf8mb4_0900_ai_ci` (B0). La baseline de EF que exportó el agente lleva `utf8mb4_bin` en `name` y `sku` (U7), tal
  como lo pide `build`.
  - FL-PRD-007-H (`?sort=name`, `?sort=sku,desc`) en verde.
  - FL-PRD-007-E/F (`q` sin acentos ni mayúsculas, y `%`/`_` literales sobre las sombras plegadas) en verde.
  - FL-PRD-005-E en verde.
- **Lo que escribe `build` no se toca.** La huella es la misma que en PostgreSQL (23), con `baselineTested: OK`
  (103 elementos del esquema).

## Lo que se contrastó

- El informe, contra la matriz, `design-gaps.yaml` y `corrida-metrics.js footprint`.
- **Los dos huecos del generador de la corrida de PostgreSQL vuelven a salir.** Esta corrida se generó antes de los
  arreglos, a propósito, para no esperar a medirlos en vivo.
  - **La lista ausente de un `in`:** el handler la rodea igual
    (`query.Statuses.Count == 0 ? null : query.Statuses`).
  - **`Decimals.cs`:** esta vez el agente se escribió su propio ayudante, `Application/Support/Amounts.cs`, con
    `Math.Round(…, AwayFromZero)`. Es un archivo fuera de lo que registra `build`, así que la huella no lo cuenta.
  - Ningún informe de las corridas lo cuenta.

## designGaps

- `upload-type-rejection`: `addProductImage` sin 413/415. Ya visto en la serie.
- `withdrawal-empty-body`: no se dice qué hacer con un `recordWithdrawal` que contesta sin cuerpo (FL-CMP-003). Es
  el mismo que `bad-contract-error-code` de keel-spring.
- `slug-tiebreak-direction`: la dirección del desempate de `getProductBySlug`. Es el mismo que el de keel-spring.

Ninguno es de la búsqueda.
