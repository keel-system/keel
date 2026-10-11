# Corrida `catalog` — keel-spring (la gemela de la corrida de keel-nest del incremento 13)

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v1.0.0 (DSL 2.20, relacional, 9 capas), la copia cerrada de la corrida de keel-nest |
| Stack | `postgresql · kafka · keycloak · redis · minio` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **65/65 OK** (según el informe; ver § La matriz) |
| Huella del agente | 402 archivos registrados por `build`, 0 adoptados, **32 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml (1 real del método, 2 que no lo son) |
| Huecos del generador | 2 en la huella y 1 como archivo nuevo (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 21 TODO · 6 consulta · 5 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la corrida de keel-nest (careo 18→8→2; barrido 36; revisión 20) |

Tres puntuaciones: 47 OK, 11 FALLO, 8 NO_EJERCITADO (la siembra de las pruebas: columnas sombra y de
auditoría) → 48 OK, 17 FALLO → 65/65 (fetch join, límite y `created_at` de la siembra).

## La matriz

El informe dice 65 escenarios; el documento tiene 64 bloques `FL-` y la corrida de keel-nest puntuó 56. **No se
pudo comprobar**: al analizar la corrida se lanzó `infra/score-scenarios.sh` en este proyecto y en el de keel-nest
creyendo que solo leía el JUnit, y lo que hace es ejecutar la suite; con la infra apagada se quedó en el humo y
dejó los dos `build/test-results/` con el XML del humo nada más. El código, el informe y `design-gaps.yaml` están
intactos. Para saber de dónde sale la diferencia hay que volver a pasar las dos suites.

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (21) | `README.md`; los 12 handlers; `Category`, `Product`, `SupplierPrice`, `ProductImage`; `SupplierPriceProjector` y `SupplierPriceReader` (la réplica); `PricingHttpAdapter` y `LegacyErpHttpAdapter` (los fallbacks `lastKnown` y `degrade`) |
| Consulta de negocio (6) | `ProductRepository`, `ProductJpaRepository`, `ProductRepositoryImpl` (el filtro por nombre del listado, `findLatestByCategoryId`, la lectura en lote para `getProductsByIds`, la confirmación del barrido); `SupplierPriceRepository`, `SupplierPriceJpaRepository`, `SupplierPriceRepositoryImpl` (`findAllBySkuIn`, la lectura en lote de la réplica) |
| Hueco del generador (5) | `ProductJpa.java` (el desempate del orden y la sombra `name_normalized` del filtro); los cuatro `parameters/*/kafka.yaml` (`auto-offset-reset: earliest`) |

## Arreglos

1. **`auto-offset-reset: earliest`** lo escribe build en los cuatro perfiles. Lo reescribía a mano cada corrida de
   Kafka con keel-spring (también `corrida-live-kafka` y `corrida-claim-kafka`); keel-nest ya lo emitía
   (`fromBeginning: true`). La skill `keel-spring-kafka` deja de pedirlo.
2. **El orden de una colección hija desempata por id**: «dos imágenes pueden compartir position, y el orden entre
   ellas lo desempata su id» estaba en una regla y ninguno de los dos generadores lo hacía. Ahora
   `orderingTieBreakerOf` (`keel-core/gen/relational.js`) lo da a la `@OrderBy` de keel-spring, al `Comparator` de
   su rama documental y al `sort` del adaptador de keel-nest.
3. **`AfterCommit`**, igual que en asset-vault: lo escribieron las dos corridas de keel-spring a mano.

No se tocó la sombra `name_normalized`: la comparación plegada del filtro es del agente en los dos generadores (build
deja la nota). keel-nest pliega dentro de la consulta (`translate(lower(…))`) y keel-spring añadió una columna;
los dos cumplen, y es una divergencia de implementación a mirar si vuelve.

## Lo que vuelve al método

- **El lector de réplica en lote para un listado** (`findAllBySkuIn`), segunda corrida: build solo da el finder de
  una clave. Era uno de los pendientes aplazados «salvo que se repita»; se ha repetido.
- **Un rechazo de negocio en una suscripción no se reintenta**, y aquí el diseño cuenta con lo contrario:
  `WithdrawalRejected` puede llegar antes que la retirada que compensa (`PRODUCT_NOT_FOUND`), y el comentario del
  diseño dice que «los reintentos absorben esa carrera». Los dos generadores marcan `DomainException` como no
  reintentable (`DeadLetterConfig` en keel-spring, `isRetryable` en keel-nest), así que el mensaje va directo al
  descarte. FL-DLQ-001 pasa igual porque solo mira el descarte final. Hay que decidir si un NOT_FOUND en una
  suscripción se reintenta, o si el diseño tiene que dejar de contar con ello.
- **La caché del agente**: `ResponseCache` + `SpringResponseCache`, otro puerto propio con otro nombre que el de
  asset-vault (`GetAssetCache`). keel-nest lo emite desde build.

## designGaps

- `SupplierPrice` — pedía fijar la forma pública de `supplierPrice` además de `amount` y `currency`. Lo fija el
  contrato del cable (`wire-contract.md`); no es hueco.
- `WithdrawalRejected` — **real**, pero del método y no del diseño: es la decisión de arriba sobre el reintento.
- `Product.name` — el agente pedía declarar `compare` en el dominio para la sombra. El diseño ya lo declara donde
  importa (el filtro de `listProducts`); la sombra es una implementación posible. No es hueco.
