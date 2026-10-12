# Corrida `catalog` — keel-nest, de control (la v2 de `2026-10-10-catalog-nest.md`)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.21, relacional, 9 capas), la misma copia que `2026-10-11-catalog-spring-v2.md` |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-nest@0.0.1` con todo lo del 2026-10-11 |
| Diseño listo al generar | sí |
| Matriz final | **56/56 OK** (los 56 escenarios hoja del documento) |
| Huella del agente | 372 archivos registrados por `build`, 0 adoptados, **25 reescritos**, 0 borrados |
| Huecos del diseño | 5 en design-gaps.yaml (ninguno real; ver § designGaps) |
| Huecos del generador | 1 en la huella, 3 en el informe (ver § Arreglos y § Lo que vuelve al método) |
| Convertidos en id | — |
| Clasificación de la huella | 22 TODO · 2 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la corrida de keel-nest |

Dos puntuaciones: 54 OK + 2 FALLO (FL-IMG-001-F y su cascada G, `culprit: code`: el handler no comprobaba el
tamaño de negocio de la imagen) → 56/56.

## Lo que midió (frente a la v1)

De 33 reescritos a 25. **La sombra de filtro aguantó**: el agente filtra con `Like` sobre `nameNormalized` plegando
el término con `TextFold` (en la v1 plegaba en la consulta con `translate(lower(…))`), y `product-orm.ts` ya no se
toca. El proyector de la réplica llega con el guard de «igual = sin efecto» y solo se completan sus dos métodos.

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (22) | `README.md`; los 12 handlers; `category.ts`, `product.ts`, `supplier-price.ts`, `product-image.ts`; `supplier-price-projector.ts` (quitar los casts del TODO); `legacy-erp-http-adapter.ts` y `pricing-http-adapter.ts`; `broker-bindings.ts`; `s3-file-storage.ts` |
| Consulta de negocio (2) | `product-repository.ts` y su adaptador: el filtro por nombre, el más reciente de la categoría y `findAllByIdIn` para `getProductsByIds` |
| Hueco del generador (1) | `get-price-result.ts`: la marca `stale` del último precio conocido |

## Arreglos

1. **La lectura por lote de `getProductsByIds`**: `findAllById` en el puerto de la raíz cuando una query recibe la
   lista de sus ids (`idBatchReason`: `listed-ids`), con la nota en el handler, en los dos generadores.
2. **La subida**: el handler recibe `StoragePolicies` y `FileStorage`, y una nota neutral (`uploadNotes`) que dice
   que el límite del bucket lo comprueba él, lo primero, con `allowsSize` → `FILE_TOO_LARGE`, antes del tipo y de
   subir. En los dos generadores.
3. **Las FK entre agregados en el baseline de keel-nest**: el export las añade con los nombres de keel-spring y el
   verify las exige (y no cuenta como diferencia que TypeORM las quiera quitar). Medido en `db-check` contra
   PostgreSQL y MySQL, y falsado quitándolas de la migración. Al medirlo salió otro defecto: en MySQL, con una
   columna generada, el export rechazaba el INSERT parametrizado de `typeorm_metadata` y el baseline no se podía
   escribir.

## Lo que vuelve al método

- **`GetPriceResult.stale`, segunda corrida** (keel-spring v2 y esta): el `lastKnown` de `currentPrice` sirve un
  precio viejo y los dos agentes le añadieron una marca para no cachear la ficha con él.
- **La lectura por lote de `getProductsByIds`** (`ids: uuid, list` en la entrada, lista de `Product` en la salida):
  la escribieron a mano las cuatro corridas de catalog, en los dos generadores.
- **El tamaño de negocio de una subida**: el lector multipart corta al doble del mayor `maxSizeMb` y el límite del
  bucket lo comprueba el handler con `BucketPolicy.allowsSize`, pero ninguno de los dos generadores lo dice en la
  nota del handler, y la regla del diseño dice «el tamaño se rechaza al leer la petición». El agente de keel-spring
  lo sacó de su skill de S3; el de keel-nest no, y costó un ciclo.
- **Las FK entre agregados** (informe): el baseline de keel-spring lleva `fk_categories_parent` y
  `fk_products_category` (el apéndice de su `export-schema.sh`); el de keel-nest, ninguna, aunque su comentario
  dice que van en el baseline. Es una divergencia de esquema entre los dos servidores, y `db-check` no la ve: solo
  mide las FK de dentro del agregado.

## designGaps

- `response-shape-without-contract` — sin `docs/openapi.yaml`, la forma de `currentPrice`, `productCost`,
  `supplierPrice` y de las entradas del listado se derivó del DSL. **Tercera corrida** (las dos v2 de keel-spring y
  esta); va sin contrato a propósito, porque derivarlo bien es un generador de contratos.
- `page-out-of-range-totals` — FL-PRD-003-D espera `totalElements` 0 fuera de rango. Es la forma de la página
  vacía del contrato del cable, y keel-spring afirma lo mismo. No es hueco.
- `version-on-child-writes` — si añadir o quitar imágenes incrementa `version`. Lo decide el bloqueo optimista de la
  raíz: toda escritura del agregado la incrementa. No es hueco.
- `simultaneous-delivery` — FL-CMP-001-D pide entregas simultáneas y el arnés solo entrega en serie. Del arnés.
- `stub-sequence` — FL-RTY-001: «falla dos veces y a la tercera responde 200» no se expresa con los mappings del
  stub. Sí se expresa: `stubSequence` existe en el arnés de keel-nest (`http-stub.ts`, la misma API que en
  keel-spring) y el agente no lo usó. No es hueco.
