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

## Corrida de control (con `1b8d927`)

Mismo diseño y stack, regenerado con los arreglos (commit `dfdfe65` del proyecto). **198/198**, primera pasada
188 (10 fallos, todos `culprit: test`). Huella: 393 registrados (el nuevo es `like-pattern.ts`), **41 reescritos**,
los mismos 41 que la primera; 352 intactos.

- Los tres arreglos se cumplen: los tres adaptadores importan `LikePattern` de build sin tocarlo; FL-SHP-001-K y
  FL-M2M-010-F afirman el coste con `queryCount()` (`<= small`) en vez de quedar `uncovered`; `tsbuildinfo` ya no se
  versiona, y nadie tuvo que deduplicar Fastify.
- **Los 10 fallos de la primera pasada salieron de dos huecos de documentación**, no del diseño, aunque el agente los
  escribió como `designGaps`: (a) 9 por afirmar `Location` con `toBe(<ruta>)` cuando los dos servidores la emiten
  absoluta —la convención de keel-spring lo enseña con `endsWith`; la de keel-nest solo lo tenía en un ejemplo—;
  (b) uno por afirmar 400 con `size=0`/`page=-1`, cuando los dos servidores normalizan como Spring Data y
  `dsl/api.md` solo documentaba el tope superior. Es el mismo caso que la página vacía de la corrida `catalog`:
  hueco del documento reportado como hueco del diseño. Arreglo: `dsl/api.md` (`Location` absoluta y cotas inferiores)
  y la tabla del contrato de `conventions/integration-tests.md` de keel-nest.
- Hallazgos «del generador» del informe, contrastados: el PATCH que deja pasar `null` en `name`/`sku`/… **es el
  contrato de los dos generadores** (ausente conserva, `null` vacía; keel-spring con `JsonNullable`), y la regla de
  catalog vive en prosa; candidato a derivarlo: un opcional del PATCH cuyo campo del dominio es `required` no puede
  vaciarse, así que `null` ahí es 400 en los dos. `IDEMPOTENCY_KEY_REQUIRED` después de la validación del cuerpo:
  igual en los dos (el código lo declara el diseño y lo comprueba el handler); orden sin decidir, no defecto. El
  comentario «contradictorio» de `IdempotencyContext` ya dice «salvo que el diseño declare el error que la exige»;
  el del hook de `http-platform.ts` no lo dice. Los `TODO` residuales (`outbox-dispatcher-fallback.ts`, `unsupported()`
  de `request-reading.ts`) están en archivos que el agente no debe tocar: ruido para quien barre TODOs.

Aplicado después (sin corrida que lo mida todavía):

- **`null` en un PATCH sobre un campo que el dominio exige → 400**, en los dos generadores. `derivePatchNotNull`
  (`keel-core/gen/model.js`) marca `patchNotNull` en el opcional del cuerpo de un PATCH cuyo campo homónimo de la
  entidad del grupo es `required`, o es la FK de una many-to-one requerida (el mismo enlace por nombre que
  `deriveFilterFolds`). keel-spring emite `JsonNullable<@NotNull …>` (ejecutado con Hibernate Validator: ausente
  pasa, `null` falla, el no marcado sigue vaciando); keel-nest añade `notNull` al lector, y `Violations.check` deja de
  mirar un `undefined`, que solo es el ausente de un PATCH. `keel-nest/test/patch-not-null.test.js`, falsado por las
  dos mitades; documentado en `wire-contract.md`.
- **Los `TODO` en archivos permanentes de build**: los dos respaldos del broker de keel-nest señalan a
  `broker-bindings.ts`, que lleva ahora la marca (solo cuando hay puertos o listeners que registrar);
  `unsupported()`, que no usaba ningún emisor, se borra. `keel-nest/test/build-residue.test.js`, sobre todas las
  fixtures. Los comentarios del hook y del contexto de idempotencia (keel-nest y keel-spring) dicen ya «salvo que
  el diseño declare el error que la exige».

## designGaps

Ninguno en pie. El único reportado (`keel-nest-quality`: las invariantes de imágenes de `Product` lanzan `Error`
genérico) es una aserción de postcondición: las posiciones las renumera el propio agregado y ninguna petición del
contrato llega a ese `throw`. La guía de los dos agentes de calidad distingue ahora la aserción interna del hueco.
