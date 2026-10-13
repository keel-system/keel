# Corrida `catalog` — keel-nest

| Etiqueta | Valor |
|---|---|
| Diseño | `catalog` v0.1.1 (DSL 2.21, relacional, 8 capas) |
| Stack | `postgresql · rabbitmq · keycloak · minio · otel` |
| Generador | `keel-nest@0.0.1` (`f9d8a02`) |
| Diseño listo al generar | sí |
| Matriz final | **194/194 OK** (primera pasada 193: `FL-PRD-030-A`, `culprit: test`) |
| Huella del agente | 392 archivos registrados por `build`, 0 adoptados, **41 reescritos**, 0 borrados |
| Huecos del diseño | 1 en `design-gaps.yaml`, reclasificado: no es hueco (ver § designGaps) |
| Huecos del generador | 4 (ver § Arreglos), uno de ellos sin reportar: el `LikePattern` roto |
| Convertidos en id | — |
| Clasificación de la huella | 35 TODO · 6 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |

Proyecto en `keel-registry/services/catalog-nest` (commit único `c8aab72`). La huella se midió contra un `build`
regenerado del mismo diseño con el mismo stack: los 351 intactos casan byte a byte.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| los 28 handlers de `src/application/usecases/` | TODO legítimo |
| `src/domain/aggregate/{brand,category,product}.ts`, `src/domain/entity/product-image.ts` | TODO legítimo: métodos semánticos e invariantes |
| `src/infrastructure/messaging/broker-bindings.ts` | TODO legítimo: el `RabbitOutboxDispatcher` |
| `src/infrastructure/storage/s3-file-storage.ts` | TODO legítimo: el adaptador S3 (skill `keel-nest-s3`) |
| `README.md` | TODO legítimo |
| `src/domain/repository/{brand,category,product}-repository.ts` y sus tres adaptadores | Consulta de negocio: `search(criteria, pageable)` y `findAllActive()`. Los filtros los estructura el DSL entero (`match`, `compare`, rangos): **candidato a que lo emita build** en los dos generadores |

Archivos nuevos del agente fuera del manifiesto: `rabbit-outbox-dispatcher.ts` (su skill), el baseline de
migraciones (calidad) y `src/infrastructure/persistence/like-pattern.ts`, que estaba **roto** (§ Arreglos).

## Arreglos

- **`LikePattern` del agente, roto y sin escenario que lo viera.** El escape se escribió con un template literal que
  nunca interpolaba (`` `\${character}` ``): `?name=50%` buscaba «50${character}» y devolvía `[]`, y la barra
  invertida no se escapaba. 194/194 porque ningún escenario busca un comodín. Medido en vivo con una sonda sobre una
  copia del proyecto: con el helper del agente, `?name=50%` → `[]`; con el de build, `['Oferta 50%']`, y `?name=_` y
  `?sku=SK_` casan solo con el literal. Arreglo: build emite `like-pattern.ts` (mismo nombre y API que eligió el
  agente) cuando hay un filtro `match: prefix | contains` sobre base relacional, y la nota neutral de
  `keel-core/gen/text-filters.js` dice en los dos generadores que el texto buscado es literal. `filter-fold.test.js`
  ejecuta el helper emitido.
- **Dos copias de Fastify.** `@nestjs/platform-fastify` fija `fastify` exacto (5.12.5) y build declaraba
  `^5.12.5`, que con 5.12.7 publicado resolvía otra copia: `http-platform.ts` no compilaba (`multipartErrors`). El
  agente lo tapó con `npm dedupe`. Arreglo: `overrides: { fastify: "$fastify" }` en el `package.json` emitido
  (reproducido y verificado con `npm install --package-lock-only`).
- **El arnés no contaba sentencias.** Los pasos de coste de `FL-SHP-001` (11) y `FL-M2M-010` (6) acabaron en
  `uncovered`. keel-spring tiene `queryCount()`/`queryExecutions()`; keel-nest no. Arreglo: los dos en `flow.ts`, con
  un suscriptor `beforeQuery` en el `DataSource` que solo cuenta dentro de una petición HTTP (el relay del outbox, las
  purgas y los barridos no ensucian la medida, cosa que en keel-spring hay que cuidar a mano). Medido en vivo: las dos
  pruebas de coste pasan con el código del agente, y con un N+1 metido en `getProductsBatch` las cinco funcionales
  siguen en verde y la de coste sale roja (6 sentencias frente a 105).
- **`tsconfig.build.tsbuildinfo` versionado** (470 KB): el `.gitignore` emitido no lo excluía.

## designGaps

Ninguno en pie. El único reportado (`keel-nest-quality`: las invariantes de imágenes de `Product` lanzan `Error`
genérico) es una aserción de postcondición: las posiciones las renumera el propio agregado y ninguna petición del
contrato llega a ese `throw`. La guía de los dos agentes de calidad distingue ahora la aserción interna del hueco.
