# Corrida `catalog` — keel-nest (incremento 13, la silueta relacional transversal)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.20, relacional, 9 capas), copia cerrada de la fixture `catalog-extended` |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-nest@0.0.1` (incremento 13j) |
| Diseño listo al generar | sí |
| Matriz final | **56/56 OK** |
| Huella del agente | 370 archivos registrados por `build`, 0 adoptados, **33 reescritos**, 0 borrados |
| Huecos del diseño | 1 en design-gaps.yaml, que no lo es |
| Huecos del generador | 3: el `code` de idempotencia de todo el servicio, el finder plegado y la relación obligatoria (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 25 TODO · 3 consulta · 5 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 18→8→2; barrido 36; revisión 20; 17 aceptadas / 19 cerradas (del barrido) |

La fixture `catalog-extended` es a propósito una silueta con huecos declarados, y de ella dependen 37 archivos de
test. Por eso se cerró **una copia** en el workspace de la corrida y no la fixture. Al cerrarla se añadieron:
- la capa `security`;
- `activateProduct`;
- la regla de que solo se retira lo que está `active`;
- un barrido que confirma la inscripción y sale, en vez de reinscribirla cada hora;
- el límite de 20 imágenes;
- `onMiss: degrade` en la réplica.

Es la segunda de las dos corridas del incremento 13; la otra es `2026-10-10-asset-vault-nest.md`.

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (25) | `README.md`; los 13 handlers; `category.ts`, `product.ts`, `supplier-price.ts`, `product-image.ts`; el proyector y el lector de la réplica; `pricing-http-adapter.ts` y `legacy-erp-http-adapter.ts` (los fallbacks `lastKnown` y `degrade`, que build deja como TODO cuando dos políticas salen por la misma llamada); `broker-bindings.ts`; `s3-file-storage.ts`; `get-price-result.ts` (la marca `stale` para no cachear lo servido de memoria) |
| Consulta de negocio (3) | `product-repository.ts` y su adaptador (el filtro `nameContains` del listado, que build deja con nota en los dos generadores, y `findLatestByCategorySlug`, de una regla); `supplier-price-repository.ts` (`findBySkus`, la lectura en lote de la réplica para un listado) |
| Hueco del generador (5) | `idempotency-conflict-exception.ts`, `idempotency-store.ts`, `idempotency-store-impl.ts` (el `code` de la carrera); `product-v1-controller.ts` (la relación obligatoria); `persistence-module.ts` (el `AfterCommit`, que ahora emite build) |

Queda un candidato sin arreglar. El lector de una réplica que se expone en un **listado** necesita leer en lote, y build
solo le da el finder de una clave.

## Arreglos

Los tres afectan a los dos generadores:

1. **El `code` del conflicto de idempotencia era de todo el servicio.**
   - `declaredErrorFor` buscaba entre los errores de todas las operaciones, así que el `PRODUCT_KEY_IN_PROGRESS` de `createProduct` salía también en la carrera de `removeProductImage`. Lo destapó FL-IMG-001-G.
   - Ahora `idempotencyOutcomeCodes` (`keel-core/gen/declared-errors.js`) busca operación a operación, y las dos excepciones lo resuelven por la operación que encabeza el `scope`. Así no cambia ninguna firma que use el agente.
   - Lo miden `keel-core/test/idempotency-outcome-codes.test.js`, la prueba de keel-nest que ejecuta la excepción (`request-idempotency.test.js`) y `generation-regressions.test.js` de keel-spring.
2. **El finder de una clave natural con `compare: ignore-case` comparaba el valor crudo.**
   - `findBySlug` usaba `slug` y no la sombra que indexa la unicidad, así que «Tools» no encontraba «tools». El agente lo esquivó y no lo corrigió.
   - Las cuatro ramas tenían el mismo defecto (keel-nest y keel-spring, relacional y documental).
   - Ahora el puerto sigue recibiendo el valor y el adaptador lo pliega: en keel-spring, Spring Data deriva `findBySlugNormalized`.
   - Lo mide `keel-nest/test/folded-finder.test.js`, en las cuatro ramas.
3. **Una relación `required` de la entrada no se validaba.**
   - Sin `categoryId`, el alta respondía 500 en vez de 400.
   - Ahora una relación obligatoria de la entrada toma sus reglas de la proyección, como cualquier campo (`keel-core/gen/model.js`).
   - Lo mide `keel-nest/test/input-bounds.test.js`.

## Lo que vuelve al método

- `docs/dsl/use-cases.md` decía que con `nulls: omit` también se omite la colección vacía, contra `wire-contract.md` y
  contra lo que emiten los dos generadores. El careo lo levantó en cuatro flujos y se corrigió antes de generar
  (`5ceb771`).

## designGaps

- `file-too-large-undeclared` — el agente pedía declarar `FILE_TOO_LARGE` en `addProductImage`. No es un hueco: es un `code` canónico de `framework-errors.md`, y el escenario ya lo afirma.
