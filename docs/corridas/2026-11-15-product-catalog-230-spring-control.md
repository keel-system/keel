# Corrida de control de los lotes (DSL 2.30) — `product-catalog` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.2.0 (DSL 2.30, relacional, 5 capas), con `importProducts` (`per-item`, `sync`, con clave, hasta 500) e `importCatalog` (`per-item`, `async`, con clave, hasta 50 000), sobre la v1.1.0 con security nueva (rol `catalog-editor`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`e7a1d4b3`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **36/36 OK** a la primera (sin arbitrajes) |
| Huella del agente | 263 archivos registrados por `build`, 0 adoptados, **8 reescritos**, 0 borrados |
| Clasificación de la huella | 8 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «sin `designGaps`» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-230-spring-postgre\services\product-catalog-spring`. Es la primera de las cinco
corridas de control del incremento 11 de `PLAN-DSL-230-LOTES.md`. Los cinco agentes en verde a la primera; el de
validación no se invocó (matriz al 100 %), y los gates `check-idempotency`, `check-domain-guards` y `check-logging`, en
verde.

## Lo que medía

- **El lote síncrono por elemento** (FL-PRD-008): 207 con tres elementos fallidos de cinco (el sku que ya existía, el
  repetido dentro del mismo lote, que falla en el segundo, y el formato inválido del sku, que es `VALIDATION_ERROR` del
  elemento y no un 400 del lote) y los otros dos creados, con el `summary` y las cinco claves de cada elemento.
  En verde.
- **La clave del lote síncrono (D15)**: la repetición con los mismos bytes devuelve el mismo 207 (FL-PRD-008-B), otra
  petición con la misma clave da 409 `IDEMPOTENCY_KEY_REUSED` (008-C), y los 400 del lote entero (sin `items`, vacío,
  más de 500) en 008-D. En verde.
- **El lote asíncrono** (FL-PRD-009): 202 con `Location`, el trabajo sondeado hasta `completed`, los resultados por
  índice, la repetición con la misma clave devuelve el mismo trabajo (009-B), otro catálogo con la misma clave es 409
  (009-C), otro usuario con el mismo rol no ve el trabajo ajeno (009-D, 404 `BATCH_JOB_NOT_FOUND` en las dos rutas) y un
  trabajo que no existe (009-E). En verde.
- **El 401 y el 403** de la security nueva (FL-PRD-010 y 010-B), y lo de la v1.1.0 (FL-PRD-001 a 007), con el orden de
  `listProducts` que la v1.2.0 fija por `sku`. En verde.

## Los riesgos anotados en el plan

- **El sondeo del trabajo, sin helper nuevo.** El agente escribió `awaitJob(jobId)` en su `CatalogFlowSupport`, sobre el
  `await` genérico del arnés: lee la ruta del trabajo hasta `completed` o `aborted`, con tope de 60 s. Sondea cada
  200 ms, que es el intervalo del `await` del arnés, no el de 0,5 s que propone la convención: no cambia el resultado.
  La convención bastó y no hace falta un helper como `ageDeletion`.
- **Las carreras (FL-PRD-008-E y 009-F)**, en verde sin forzar nada, con `raceOf(2, …)` del arnés y las aserciones
  tal como las escribe el escenario: cada respuesta es 207/202 o 409 `IDEMPOTENCY_KEY_IN_PROGRESS`, al menos una gana,
  si ganan las dos traen los mismos `productId` (la misma `Location` en el asíncrono), y queda exactamente un producto
  por sku. **Qué desenlace se dio no se puede saber desde aquí**: el XML de JUnit no guarda las respuestas de esas dos
  clases. El 409 de la clave en curso sí aparece en el de `ConcurrentCreationFlowIT` (la carrera de `createProduct`).
- **Los mismos bytes en la repetición.** El agente guarda el cuerpo en una constante (`BATCH_BODY` en
  `ProductBatchImportFlowIT`, otra en `CatalogImportFlowIT`) y la manda tal cual en 008/008-B y en 009/009-B, con el
  comentario «la firma del lote es la de los bytes». No reformateó nada.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 36 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **Las pruebas del agente**, en `src/integrationTest/.../flows/`: doce clases de flujo más `CatalogFlowSupport.java`,
  cuatro de ellas de los lotes (`ProductBatchImportFlowIT`, `CatalogImportFlowIT`, `ConcurrentBatchImportFlowIT` y
  `ConcurrentCatalogImportFlowIT`).
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\catalog-230-spring-regen`. Los ocho reescritos partían de un TODO:
  - Los siete handlers. Los dos de los lotes hacen lo que dice su nota: leen `command.item()`, comprueban el sku con
    `findBySku` y lanzan `SkuAlreadyExistsError`, y devuelven `<Op>ItemResult` con el `productId`. No capturan nada,
    no tocan el bucle ni la clave. El sku repetido dentro del mismo lote falla en el segundo porque cada elemento va en
    su transacción, que es lo que dice la nota.
  - `createProduct` sigue el orden de la nota de idempotencia (reclamar la clave antes del negocio).
  - `Product.java`: el factory `create(...)`, `activate()` y `retire()`, como en las corridas anteriores sobre este diseño.
- Los archivos que escribió el agente van en CRLF; los de `build`, en LF. Para el diff hay que usar
  `--strip-trailing-cr`, o todos los reescritos salen distintos enteros.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- `baselineTested: PENDING`: la prueba del baseline `V1__baseline_schema.sql` sobre una base sin esquema la hace el
  diseñador. Es lo mismo que en todas las corridas de keel-spring.
- Lo que el diseño deja sin escenario (el 409 de un lote síncrono en curso con su reanudación, el trabajo abortado y la
  purga) no lo mide la corrida: lo miden `batch-check` (BK-*, BJ-*) y `timer-sql-check`.

## designGaps

Ninguno.
