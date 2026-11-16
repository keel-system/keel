# Corrida de control repetida de los lotes (DSL 2.30) — `product-catalog` en keel-spring sobre MySQL, tras el arreglo

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.2.0 (DSL 2.30, relacional, 5 capas), con `importProducts` (`per-item`, `sync`, con clave, hasta 500) e `importCatalog` (`per-item`, `async`, con clave, hasta 50 000), sobre la v1.1.0 con security nueva (rol `catalog-editor`) |
| Stack | `mysql · keycloak` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`09588592`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **36/36 OK** a la primera (el informe no recoge ciclos ni arbitrajes) |
| Huella del agente | 263 archivos registrados por `build`, 0 adoptados, **10 reescritos**, 0 borrados |
| Clasificación de la huella | 8 TODO · 2 consulta · 0 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 (el informe dice «ningún `designGap`» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-230-spring-mysql-v2\services\product-catalog-spring`. Repite
`2026-11-15-product-catalog-230-spring-mysql-control.md` sobre el arreglo de `09588592`: la carrera por la misma clave de
un lote era en MySQL un interbloqueo, y el alta de keel-spring la dejaba salir como 500. Es la corrida que cierra el
incremento 11 de `PLAN-DSL-230-LOTES.md`.

## Lo que medía: el arreglo, sin tocar lo que escribe `build`

- **FL-PRD-008-E y FL-PRD-009-F**, las dos carreras por la misma `Idempotency-Key`, en verde **a la primera**. En la
  corrida anterior fueron las dos únicas en rojo.
- **`KeyedBatches.java` y `BatchJobs.java` intactos**: ya no están entre los reescritos. El reintento del alta
  (`BatchJobSteps.lostKeyRace`) es el que emitió `build`.
- El resto, como en las cuatro corridas de PostgreSQL: el 207 por elemento, la clave del lote síncrono, el trabajo
  asíncrono con su dueño y su repetición, y el 401/403.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 36 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\catalog-230-springmysql2-regen`:
  - Los siete handlers y `Product.java`, desde su TODO, como en las otras cuatro.
  - **Consulta de negocio (2)**: `ProductRepository.java` y `ProductRepositoryImpl.java` ganan `existsBySku(String)`, que
    envuelve el `findBySku` que ya emite `build` (`findBySku(sku).isPresent()`). Es la regla «verificar que el sku no
    existe antes de crear» escrita con otro nombre, como el `existsByChecksum` de la corrida de asset-vault. No es un
    hueco del generador: el finder que hace falta ya existía, y las otras cuatro corridas lo usaron tal cual.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- `baselineTested: PENDING`, como en todas las corridas de keel-spring.

## designGaps

Ninguno.
