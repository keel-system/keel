# Corrida `catalog` — keel-spring, de control (la v2 de `2026-10-11-catalog-spring.md`)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0, la copia cerrada de la corrida de keel-nest pasada a DSL 2.21 (relacional, 9 capas) |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-spring@0.1.6` (con los arreglos de la corrida anterior, el reintento del NOT_FOUND, el lote de la réplica, el DSL 2.21 y el puerto de la caché) |
| Diseño listo al generar | sí |
| Matriz final | **66/66 OK** según el informe; **56 escenarios del diseño** (ver § La matriz) |
| Huella del agente | 407 archivos registrados por `build`, 0 adoptados, **28 reescritos**, 0 borrados |
| Huecos del diseño | 4 en design-gaps.yaml (ninguno real del diseño; ver § designGaps) |
| Huecos del generador | 6 en la huella (ver § Arreglos y § Pendiente) |
| Convertidos en id | — |
| Clasificación de la huella | 19 TODO · 3 consulta · 6 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la corrida de keel-nest |

Dos puntuaciones: la primera salió con 2 (22 clases con `initializationError`: la siembra genérica de categorías
rellenaba la sombra `slug_normalized` con `''` y la segunda fila chocaba con `uk_categories_natural`) → 66/66.

## La matriz

**Resuelta la discrepancia que dejó abierta la corrida anterior** (65 en keel-spring, 56 en keel-nest, 64 bloques
en el documento). El documento tiene 64 ids, de los que 8 son encabezados `###` que agrupan sus `####`: quedan
**56 escenarios hoja**, que es lo que puntuó keel-nest. keel-spring llega a 66 porque el agente partió FL-CBR-001
(el circuito que abre y vuelve) en `-A`/`-B`/`-C` y añadió 8 casos `-V*` de validación (400/404) de su checklist.
Ningún escenario del diseño quedó sin ejercitar.

## Lo que midió (frente a la corrida anterior)

De 32 reescritos a 28. Aguantaron: `auto-offset-reset: earliest` (los cuatro `kafka.yaml` ya no se tocan por
eso), el desempate del orden de las imágenes (`ProductJpa` ya no lo lleva a mano), `AfterCommit`, el lote de la
réplica (`SupplierPriceReader.byKeys`, que usan `listProducts` y `getProductsByIds`; los tres archivos de
`SupplierPrice*Repository` intactos), `RETRIES_NOT_FOUND` con `compliance.events` y el puerto de la caché
(`GetProductBySlugQueryHandler` con `OperationCache.getOrLoad`; ningún `ResponseCache` propio).

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (19) | los 12 handlers; `Category`, `Product`, `SupplierPrice`, `ProductImage`; `SupplierPriceProjector`; `PricingHttpAdapter` y `LegacyErpHttpAdapter` (el `lastKnown` y el `degrade`) |
| Consulta de negocio (3) | `ProductRepository`, `ProductJpaRepository`, `ProductRepositoryImpl` (el filtro por nombre, el más reciente de la categoría, la lectura en lote de `getProductsByIds`) |
| Hueco del generador (6) | los cuatro `parameters/*/kafka.yaml` (un TODO que no dejaba nada por hacer); `ProductJpa` (la sombra `name_normalized` del filtro); `GetPriceResult` (la marca `stale`) |

## Arreglos

1. **El TODO de `kafka.yaml`** («topics y deserialización de consumo») ya no tenía nada detrás: el listener lee
   el cuerpo como String con el ObjectMapper de la app y los topics salen de `messaging.subscriptions.*`. El agente
   lo reescribía en los cuatro perfiles para decir eso; ahora lo dice build.
2. **El proyector de la réplica trata un hecho del mismo instante como ya aplicado** (`!isAfter`, `<=` en
   keel-nest). Tercera corrida que lo cambia a mano (las dos de keel-spring y la de keel-nest), y el diseño lo dice
   en su regla: «un hecho con occurredAt anterior o igual al guardado se confirma sin efecto». Con el mismo
   instante no hay orden que decida, y aplicarlo dejaba ganar al último en llegar.
3. **La siembra de una columna sombra**, en la convención de pruebas de los dos generadores: va con el valor
   plegado, nunca con `''`. Le costó una puntuación entera a las dos corridas de catalog.

## Pendiente

- **La sombra de un filtro que no es del campo**: `listProducts.name` declara `compare: ignore-case-accents` y
  `Product.name` no, así que build no emite `name_normalized` y el agente la escribe a mano (columna, migración,
  plegado al guardar). **Segunda corrida de keel-spring**, y keel-nest la resuelve plegando dentro de la consulta
  (`translate(lower(…))`), que es justo lo que la nota del handler de keel-spring prohíbe: dos funciones de
  plegado distintas dejan de casar en silencio. Emitirla desde build cambia el esquema —contrato de los dos
  servidores— y separa dos cosas que hoy van juntas en `fold`: dónde vive la unicidad y por qué columna se ordena
  (una sombra solo de filtro no puede llevarse ninguna de las dos). Es un incremento en los dos generadores, no un
  arreglo de corrida.
- **`GetPriceResult.stale`**: el `lastKnown` de `currentPrice` sirve un precio viejo y el agente le añadió una
  marca para no cachear la ficha con él. Primera vez; se mira si vuelve.

## designGaps

- `shadow-seed-empty` — `Category.slugNormalized`: la normalización la declara `compare` en el dominio y la emite
  build; el fallo fue la siembra del agente (arreglo 3). No es hueco del diseño.
- `update-null-required` — `updateProduct` con `name`/`categoryId` nulos: se respondió 400 `VALIDATION_ERROR`, que
  es lo que el input `required` ya produce. No es hueco.
- `fk-in-use-undeclared` — las FK `fk_categories_parent` y `fk_products_category` sin `*_IN_USE`: ninguna operación
  borra una categoría ni un producto, y el alta contra una categoría inexistente ya es `CATEGORY_NOT_FOUND`. No es
  hueco.
- `response-shape-without-contract` — la forma de la respuesta sin `openapi.yaml`: la fijan el contrato del cable y
  `mapping.md`. Lo mismo que pide la de asset-vault: un contrato formal para asertar en STRICT.
