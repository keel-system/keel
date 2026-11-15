# Corrida de control de los lotes (DSL 2.30) — `product-catalog` en keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `product-catalog` v1.2.0 (DSL 2.30, relacional, 5 capas), con `importProducts` (`per-item`, `sync`, con clave, hasta 500) e `importCatalog` (`per-item`, `async`, con clave, hasta 50 000), sobre la v1.1.0 con security nueva (rol `catalog-editor`) |
| Stack | `postgresql · keycloak` (telemetría `none`) |
| Generador | `keel-nest@0.2.0` (`e7a1d4b3`) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **36/36 OK** tras un arbitraje (la primera puntuación, 31/36, con los cinco fallos `culprit: test`) |
| Huella del agente | 238 archivos registrados por `build`, 0 adoptados, **9 reescritos**, 0 borrados |
| Clasificación de la huella | 8 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta (y el README, ver abajo) |
| Huecos del diseño | 0 (el informe dice «ninguno» y no hay `design-gaps.yaml`) |
| Huecos del generador | 0 |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\catalog-230-nest-postgre\services\product-catalog-nest`. Es la segunda de las cinco
corridas de control del incremento 11 de `PLAN-DSL-230-LOTES.md`, gemela de
`2026-11-15-product-catalog-230-spring-control.md`: el mismo diseño y el mismo stack. El baseline
`src/migrations/1000000000000-baseline-schema.ts` se exportó y se verificó en vivo (`baselineTested: OK`).

## Lo que medía

Lo mismo que la gemela de keel-spring, y en verde: el 207 por elemento de FL-PRD-008 (el sku que ya existía, el repetido
dentro del lote y el formato inválido fallan solo su elemento), la clave del lote síncrono (008-B, 008-C), los 400 del
lote entero (008-D), el trabajo asíncrono con su repetición, su clave reutilizada, el dueño y el trabajo inexistente
(FL-PRD-009 a 009-E), el 401/403 (FL-PRD-010, 010-B) y lo de la v1.1.0.

## El arbitraje: enteros sobre `jsonExact()`

La primera puntuación salió con código 1: 31 OK y 5 FALLO (FL-PRD-005, 005-B, 005-C, 008 y 008-B). El árbitro los
clasificó todos `culprit: test`. Las pruebas afirmaban los enteros de la página y del `summary` como números sobre
`jsonExact()`, que devuelve **cada** número como el texto que viajó. El servidor cumplía el Then. Se corrigieron las
pruebas (`summary: { total: '5', … }` en FL-PRD-008) y la segunda puntuación dio código 0.

No es un hueco del generador: el comentario de `jsonExact()` en `test/integration/support/flow.ts` dice «El cuerpo con
CADA número como el texto exacto que viajó», y el de `json()` remite a él solo para la escala de un decimal o un `long`.
El agente usó `jsonExact()` para afirmar `price.amount: '21.50'` (el `21.499` del elemento 3 redondeado a la escala) y
afirmó con la misma lectura los enteros del mismo cuerpo. Si vuelve a pasar en otra corrida, el arreglo es de
documentación: un ejemplo en ese comentario con un entero junto al decimal.

## Los riesgos anotados en el plan

- **El sondeo del trabajo, sin helper nuevo.** El agente escribió `pollJob(flow, jobId)` en su
  `test/integration/support/catalog-helpers.ts`: cada medio segundo hasta `completed` o `aborted`, con tope de 60 s,
  que es exactamente la convención del diseño. La convención bastó, como en keel-spring.
- **Las carreras (FL-PRD-008-E y 009-F)**, en verde sin forzar nada, con dos peticiones en un `Promise.all` (el arnés de
  keel-nest no trae un `race`; la carrera de `createProduct`, FL-PRD-003, se escribe igual). Las aserciones son las del
  escenario: 207/202 o 409 `IDEMPOTENCY_KEY_IN_PROGRESS`, y en 009-F el trabajo sondeado acaba con un solo elemento
  creado. Qué desenlace se dio no queda en la evidencia.
- **Los mismos bytes en la repetición.** El cuerpo se arma una vez como texto (`batchBody`, con `itemsJson` y
  `draftJson`, que componen el JSON a mano) y se manda tal cual en 008 y 008-B. 008-B afirma además que el cuerpo de la
  repetición es igual al de la primera (`toStrictEqual(firstBody)`). No reformateó nada.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- **La matriz**, contra el informe del pipeline: 36 `FL-*` al 100 %, `score-scenarios.sh` con código 0.
- **Las pruebas del agente**, en `test/integration/`: diez archivos de flujo más `support/catalog-helpers.ts`, dos de
  ellos de los lotes (`product-batch-import.test.ts` con FL-PRD-008 a 008-E y `product-catalog-import.test.ts` con
  FL-PRD-009 a 009-F).
- **La huella**, contra una regeneración limpia con el mismo stack y los mismos `specs/`, en
  `D:\keel-tmp\catalog-230-nest-regen`:
  - Los siete handlers partían de un TODO. Los dos de los lotes son el mismo cuerpo que en keel-spring: `command.item`,
    `findBySku` antes de crear, `SkuAlreadyExistsError` y `new <Op>ItemResult({ productId })`, sin capturar nada.
  - `product.ts`: el factory y las transiciones, como en las corridas anteriores sobre este diseño.
  - `README.md` solo gana la sección «Despliegue en producción», que pide la skill del generador y no es una decisión,
    como en la 2.28 y la 2.29.
- La clasificación se hizo a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Pendiente

- Lo que el diseño deja sin escenario (el 409 de un lote síncrono en curso con su reanudación, el trabajo abortado y la
  purga) no lo mide la corrida: lo miden `db-check` (BK-*, BJ-*) y `timer-sql-check`.

## designGaps

Ninguno.
