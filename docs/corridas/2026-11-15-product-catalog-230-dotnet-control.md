# Corrida de control de los lotes (DSL 2.30) — `product-catalog` en keel-dotnet

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.2.0 (DSL 2.30, relacional, 5 capas), con `importProducts` (`per-item`, `sync`, con clave, hasta 500) e `importCatalog` (`per-item`, `async`, con clave, hasta 50 000), sobre la v1.1.0 con security nueva (rol `catalog-editor`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-dotnet@0.2.0` (`e7a1d4b3`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **36/36 OK** a la primera (el informe no recoge arbitrajes) |
| Huella del agente | 269 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Clasificación de la huella | 8 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe dice «sin huecos del diseño» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-230-dotnet-postgre\services\product-catalog-dotnet`. Es la tercera de las cinco
corridas de control del incremento 11 de `PLAN-DSL-230-LOTES.md`, gemela de las de keel-spring y keel-nest del mismo
día. Calidad en verde según el informe: 132/132 pruebas unitarias, `baseline: OK` y `baselineTested: OK`.

## Lo que medía

Lo mismo que las gemelas, y en verde: el 207 por elemento de FL-PRD-008 (el sku que ya existía, el repetido dentro del
lote y el formato inválido fallan solo su elemento), la clave del lote síncrono (008-B, 008-C), los 400 del lote entero
(008-D), el trabajo asíncrono con su repetición, su clave reutilizada, el dueño y el trabajo inexistente (FL-PRD-009 a
009-E), el 401/403 (FL-PRD-010, 010-B) y lo de la v1.1.0.

## Los riesgos anotados en el plan

- **El sondeo del trabajo, sin helper nuevo.** El agente escribió `PollJob(jobPath)` en su clase base `CatalogFlow`,
  con un `Task.Delay(500)` entre lecturas: la convención del diseño. Las tres corridas resuelven el sondeo con la
  convención, cada una con su helper de unas diez líneas.
- **Las carreras (FL-PRD-008-E y 009-F)**, en verde sin forzar nada, con dos peticiones en un `Task.WhenAll`. Las
  aserciones son las del escenario: 207/202 o 409 `IDEMPOTENCY_KEY_IN_PROGRESS`, y en 009-F el trabajo de la `Location`
  ganadora acaba con un solo elemento creado. Qué desenlace se dio no queda en la evidencia.
- **Los mismos bytes en la repetición.** El cuerpo es una constante (`Batch` en `ProductBatchFlow`, `Catalog` en
  `CatalogImportFlow`), un raw string literal de C#, y se manda tal cual en 008/008-B y en 009/009-B. No reformateó nada.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 36 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **Las pruebas del agente**, en `tests/ProductCatalog.IntegrationTests/`: diez flujos más la base `CatalogFlow.cs`,
  dos de ellos de los lotes (`ProductBatchFlow.cs` y `CatalogImportFlow.cs`).
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\catalog-230-dotnet-regen`:
  - Los siete handlers partían de un TODO. Los dos de los lotes tienen el mismo cuerpo que en keel-spring y keel-nest:
    `command.Item`, `FindBySku` antes de crear, `SkuAlreadyExistsError` y `new <Op>ItemResult { ProductId = … }`, sin
    capturar nada.
  - `Product.cs`: el factory y las transiciones, como en las corridas anteriores sobre este diseño.
  - `README.md` solo gana la sección «Despliegue en producción», que pide la skill del generador y no es una decisión,
    como en keel-nest.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- Lo que el diseño deja sin escenario (el 409 de un lote síncrono en curso con su reanudación, el trabajo abortado y la
  purga) no lo mide la corrida: lo miden `db-check` (BK-*, BJ-*) y `timer-sql-check`.

## designGaps

Ninguno.
