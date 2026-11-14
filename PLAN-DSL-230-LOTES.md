# DSL 2.30: lotes con resultado por elemento (R5)

**Estado: APROBADO el 2026-11-14.** Incrementos 0, 1 y 2 cerrados el 2026-11-14; el siguiente es el 3 (keel-dotnet `sync`). Al cerrar pasa a `completed_plans/`.

## Contexto

R5 de `docs/evaluacion-dsl-2.24.md`: «importar 500 filas y que fallen 3» es **inexpresable**. `errors` es por
operación, y una operación con un `list` de entrada falla entera o termina entera. Para responder por elemento hay que
inventar en `fields` una lista de resultados con un `code` libre, fuera del catálogo de errores del contrato.

**¿Será síncrona?** Depende del tamaño, y eso es un hecho del contrato, así que lo declara el diseño. La industria
distingue dos formas y las dos entran, en dos fases:

| Modo | Cuándo | Referentes | Contrato |
|---|---|---|---|
| `sync` (fase A) | Lotes acotados: segundos, el cliente espera | Elasticsearch `_bulk`, SQS `SendMessageBatch`, Salesforce sObject Collections (≤200), Zalando API Guidelines (207 para *bulk*) | `207 Multi-Status` con un resultado por elemento |
| `async` (fase B) | Importaciones grandes: minutos | Salesforce Bulk API 2.0, Shopify `bulkOperation`, Google AIP-151 (LRO), Azure LRO | `202 Accepted` + `Location` del trabajo, sondeo de estado, resultados paginados |

**Decisiones del usuario (2026-11-14):**

1. Entran los dos modos con **una sola sintaxis `batch`**: fase A síncrona, fase B asíncrona.
2. **Spring Batch no entra como librería; entra su semántica.** Chunk con *commit interval*, *skip policy*
   (= `itemErrors`), reintento de lo transitorio y reanudación desde el último chunk confirmado, como datos neutrales
   en `keel-core/gen` y emitidos igual en los cuatro generadores. Es lo que se hizo con el cronómetro (`keel_timer`)
   en vez de Quartz o ShedLock. Los motivos:
   - **Paridad.** Ningún equivalente cubre PostgreSQL, MySQL y MongoDB con licencia permisiva. Hangfire Batches es de
     pago (keel-dotnet lo veta). BullMQ y asynq exigen Redis. pg-boss y River solo funcionan con PostgreSQL, y River es
     MPL (keel-go solo admite la excepción de MySQL).
   - **Un segundo almacén.** El `JobRepository` de Spring Batch 6 (`@EnableJdbcJobRepository` o
     `@EnableMongoJobRepository`, `BATCH_*`) sería otro almacén de trabajos junto a `keel_timer` y los reclamos. Su
     valor por defecto, `ResourcelessJobRepository`, ni siquiera se puede reanudar.
   - **No guarda lo que pedimos.** Spring Batch guarda contadores de *skip*, no el resultado de cada elemento. Haría
     falta la tabla de resultados de todos modos.

## El DSL

```yaml
# use-cases.keel.yaml
importProducts:
  kind: command
  input:
    fields:
      items: { type: ProductDraft, list: true, required: true, constraints: { maxItems: 500 } }
  output: void                     # la respuesta la fija el método (CHK-USECASES-BATCH-OUTPUT)
  batch:
    over: items                    # el campo list del input que se recorre
    atomicity: per-item            # all-or-nothing | per-item
    itemErrors: [SKU_ALREADY_EXISTS, INVALID_PRICE]   # codes de errors[] que fallan SOLO su elemento
    execution: sync                # sync (default) | async   (async: fase B)
    output: { fields: { productId: { type: uuid } } } # opcional: lo que devuelve cada elemento con éxito
```

La forma en el cable la fija `wire-contract.md` § Lotes (es del método, no de cada diseño):

```json
{ "summary": { "total": 500, "succeeded": 497, "failed": 3, "notAttempted": 0 },
  "items": [ { "index": 0, "status": "succeeded", "result": { "productId": "…" }, "error": null, "message": null },
             { "index": 7, "status": "failed", "result": null, "error": "SKU_ALREADY_EXISTS", "message": "…" } ] }
```

## Decisiones (D1-D12)

| # | Decisión | Por qué |
|---|---|---|
| D1 | `sync` responde **siempre 207**, también si todo salió bien. `all-or-nothing` responde 2xx (`successStatus`) o el error de la operación con `index` del elemento culpable | Que el status dependa del desenlace obliga al cliente a dos parsers (Zalando, regla 152). 207 es el código de la industria para *bulk* |
| D2 | `per-item` en `sync`: **una transacción por elemento**, en orden de índice y sin paralelismo. El outbox y la idempotencia de cada elemento van en su transacción | Determinismo: dos elementos con el mismo SKU en el mismo lote siempre fallan en el segundo. Sin *savepoints*, que MongoDB no tiene. ≤1000 transacciones cortas caben en una petición |
| D3 | Una violación de forma de **un elemento** (cotas, formato) es su `failed` con `VALIDATION_ERROR`, no un 400 del lote. Son 400 solo el sobre, exceder `maxItems` o el campo `over` ausente | Es la semántica de *skip* sobre el *reader* y lo que hace Salesforce. Obliga a validar por elemento en los cuatro, no el DTO entero (D2 de riesgo, ver § Riesgos) |
| D4 | Un error **no declarado** en `itemErrors` (infraestructura, interbloqueo agotado, bug) **detiene** el lote: ese elemento queda `failed` con su code de framework, los siguientes `notAttempted`, y la respuesta sigue siendo 207 | Es la excepción que no se puede saltar en Spring Batch: el paso falla. Lo confirmado no se deshace. `notAttempted` dice al cliente qué reenviar |
| D5 | **Idempotencia del lote**: `idempotency` de la operación se aplica al lote entero y la repetición devuelve el mismo 207. Por elemento, la guarda es la `naturalKey` (ya existe) | Reutiliza los tres `keySource` sin sintaxis nueva |
| D6 | `itemErrors` ⊆ `errors[]` de la operación. Un error de `itemErrors` en `all-or-nothing` es incoherente | Sin catálogo nuevo de codes: el contrato sigue cerrado |
| D7 | Tope: `sync` exige `maxItems` y **≤1000**. `async` exige `maxItems` (sin tope fijo del método) | Un 207 de 50 000 elementos es un *timeout*. El tope obliga a elegir `async` a sabiendas |
| D8 | **Fase B, el trabajo es del método.** `async` crea un registro en la tabla del generador `batch_job` (estado `queued → running → completed / failed / aborted`, cursor del último índice confirmado y la entrada serializada) y responde `202` + `Location: …/batch-jobs/{id}`. El generador emite dos rutas: el estado y los resultados paginados con el sobre de `wire.js`. El diseño no declara entidades | Como `change_history` de la 2.29, va fuera del DSL y es neutral como datos (`gen/batch-store.js`). Cada diseño se ahorra modelar su entidad de trabajo |
| D9 | **Fase B, chunks sobre el cronómetro.** Un recurrente de `keel_timer` (`kind: batch`) reclama un trabajo con el arriendo de siempre y procesa un *chunk* de N elementos (`batch.chunk-size`, generador, default 100). Por elemento sigue D2. El cursor y los resultados del chunk se confirman en la transacción del último elemento. Si la réplica cae, otra reanuda desde el cursor | Es el *commit interval* + *restart* de Spring Batch sobre la pieza que ya está medida con dos réplicas (R1, RC-1, R2) y con `SKIP LOCKED` |
| D10 | Fase B: `batch_item_result` (job, índice, estado, code, mensaje, resultado como JSON) se borra con su trabajo por **retención** (parámetro del generador, default 7 días), con una purga del cronómetro como las demás tablas del generador | Igual que `outbox_event` o `processed_event`: sin purga crece sin límite |
| D11 | Acceso: las rutas del trabajo exigen la misma regla de `security` que la operación, y solo las lee **quien lo creó** (el `sub` del llamante, como `authorship`). Otro llamante recibe 404 | Una URL de resultados no debe ser una fuga entre inquilinos. Es lo que hace 2.27 con `readMiss: not-found` |
| D12 | Eventos: cada elemento confirmado publica lo que publicaría la operación sola. El lote **no** publica un evento propio en esta versión | Un «lote completado» sería sintaxis nueva sin un consumidor que lo pida |

**Fuera de la 2.30:** subir un CSV o un archivo (R13, el lote viaja como JSON), paralelismo dentro de un lote,
cancelar un trabajo en marcha, el evento de lote terminado, prioridades entre trabajos y lotes por suscripción.

## Reglas mecánicas (keel-core)

Cada regla lleva su id, su entrada en `checks.js` u `obligations.js` con su `nature`, su mutación en una extensión
`batch` de `test/design-mutations/catalog.js` y su fila en `design-matrix`.

| Id | Qué detecta |
|---|---|
| `CHK-USECASES-BATCH-OVER` | `over` no nombra un campo `list` del input, o el elemento no es un tipo con campos |
| `CHK-USECASES-BATCH-NOT-COMMAND` | `batch` en una query, o en una operación sin endpoint HTTP (por evento no hay a quién devolver el 207) |
| `CHK-USECASES-BATCH-ITEM-ERRORS` | `itemErrors` con un code fuera de `errors[]`, o en `all-or-nothing` (D6) |
| `CHK-USECASES-BATCH-UNBOUNDED` | Falta `maxItems`, o es mayor que 1000 en `sync` (D7) |
| `CHK-USECASES-BATCH-NO-AUTH` | `async` sin capa `security` (D11 necesita al llamante) |
| `OBL-BATCH-ATOMICITY-UNDECIDED` | Hay `batch` sin `atomicity`. No hay default seguro: es contrato. `waivable: false` |
| `CHK-SCEN-BATCH-UNCOVERED` (aviso) | Una operación por lotes sin escenario de fallo parcial |

Además va una pregunta en la clase de huecos que toque (unidades: las operaciones con un input `list` y un endpoint
POST, para preguntar si son lotes) y `REV-BATCH-ITEM-ERRORS` («¿falta en `itemErrors` un rechazo de negocio que solo
afecta al elemento?»).

## Lo neutral (keel-core/src/lib/gen)

- `batch.js`: qué operaciones son lote, `batchPlan(op)`, la forma del 207 y del trabajo como **casos de `wire.js`**,
  la nota del handler (el handler procesa **un** elemento y el bucle lo emite el generador, como con el historial),
  `batchContractClause` para OpenAPI, los casos `BA-*` (sync) y `BJ-*` (async) y sus sabotajes.
- `batch-store.js` (fase B): `batch_job` y `batch_item_result` como datos, sus sentencias por motor (reclamo, cursor,
  página de resultados, purga), su entrada en `GENERATOR_TABLES` de `schema-steps.js` y los parámetros
  (`chunk-size`, retención). Se mide con `npm run timer-sql-check` y `--sabotage=batch-cursor|batch-skip-locked`.
- `timer-plan.js`: añadir el `kind: batch` y su purga.
- `framework-errors.js`: añadir `BATCH_ABORTED` si D4 lo necesita para `notAttempted` (lista cerrada, con su tabla).
- `gen/openapi.js`: el 207 con `BatchResult`, y en `async` el 202 con `Location` y las dos rutas del trabajo.

Se reutiliza: `withTransaction`/`Transactions` de cada generador, el arriendo y `SKIP LOCKED` de `timer-store.js`,
el sobre de página de `wire.js` (`PagedResponse.from`, `pageOf`, `Page<T>.Of`, `NewPage`), el actor de `authorship`
(D11), `declaredErrorFor` y `effectiveErrorCode` (`declared-errors.js`), y `schemaStepFiles` para las bases ya
desplegadas.

## Incrementos

Son secuenciales y desde main, sin worktrees. Cada uno se cierra con «Para retomar» y su commit.

| Inc. | Qué | Red |
|---|---|---|
| 0 | DSL 2.30: schema (`batch` en `use-cases.schema.json`), reglas y mutaciones, `docs/dsl/use-cases.md`, `wire-contract.md` § Lotes, `gen/batch.js` (solo `sync`), modelo (`operation.batch`). Sube el DSL en las fixtures y en los cuatro `SUPPORTED_DSL`. Sujetos en `test/helpers/batch-designs.js` (`catalog-batch` relacional y `-mongo`) | `npm test` de keel-core, `design-matrix` |
| 1 | keel-spring `sync`: `src/scaffold/batch.js` (bucle, validación por elemento, 207), la nota del handler, OpenAPI. Sondas `src/lib/batch-probes.js` con `BA-1…BA-n` | `npm run batch-check` nuevo (PostgreSQL, MySQL y MongoDB), `--sabotage=ba-one-tx\|ba-validate-whole\|ba-continue-on-undeclared\|ba-status` |
| 2-4 | keel-nest, keel-dotnet y keel-go `sync`, cada uno con su `src/scaffold/batch.js` y `test/batch-parity.test.js` contra los demás | `db-check` y `doc-check` de cada uno con `scripts/lib/batch-probes.js` y los mismos sabotajes |
| 5 | Fase B en keel-core: `execution: async`, `batch-store.js`, sentencias, `timer-plan`, reglas `-NO-AUTH`, casos `BJ-*` | `timer-sql-check --sabotage=batch-*` |
| 6-9 | Fase B en los cuatro: el trabajo, el procesador por chunks en el cronómetro, las dos rutas, la purga y D11 | Sonda de dos réplicas (reanudación tras matar una a mitad de chunk) y `--sabotage=bj-no-resume\|bj-cursor-outside-tx\|bj-foreign-reader` |
| 10 | Contrato y método: `keel-nest/test/openapi.test.js` en los cuatro, guía Postman de `/keel-docs`, pregunta de `/keel-design`, tabla de `/keel-recover`, agentes de código y de calidad. `methodology.md` documenta cuándo `sync` y cuándo `async` | Pruebas de cadenas y lint de redocly |
| 11 | Diseño de contraste `product-catalog` v-siguiente con `importProducts` (`per-item`, sync) y `importCatalog` (async). Corridas de control en los cuatro generadores (PostgreSQL y una con MySQL o MongoDB) | 5 corridas en verde, `docs/corridas/` |

## Riesgos que medir pronto

- **D3 contra Bean Validation, class-validator, DataAnnotations y el lector de Go.** Los cuatro validan el DTO entero
  en el borde. El lote tiene que validar el **sobre** en el borde y **cada elemento** dentro del bucle con las mismas
  `inputRules` (`gen/constraints.js`). Hay que medirlo en el incremento 1 antes de copiarlo a los otros tres.
- **El tope de transacción de keel-spring** (`spring.transaction.default-timeout`) se aplica por elemento, no por
  lote. Es correcto con D2, pero lo tiene que afirmar una sonda.
- **La caché** (`cache-plan.js`): un lote invalida una vez al final, no por elemento. Hay que confirmar que la tabla
  `CACHE_INVALIDATIONS` lo admite.

## Decidido en los incrementos y no previsto en el plan original

Incremento 0 (keel-core):

- **`output: void`** en toda operación por lotes, con `CHK-USECASES-BATCH-OUTPUT`, que también rechaza un `per-item` con
  un `successStatus` distinto de 207. Lo que devuelve cada elemento va en `batch.output`. En la capa api, un lote cuenta
  como respuesta con cuerpo y un `per-item` no pide `successStatus` (no abre `CHK-API-POST-NO-STATUS`).
- **Forma estable del elemento**: las cinco claves (`index`, `status`, `result`, `error`, `message`) siempre, con `null`
  donde no aplica e independiente de `conventions.nulls`, como el cuerpo de error. Un solo lector en los cuatro.
- **`all-or-nothing`** sin fallos responde el mismo cuerpo con el `successStatus` del endpoint; con un fallo, el error del
  culpable con su ruta en `details` (`items[7]`). El cuerpo de error no gana ninguna clave.
- **`BATCH_ABORTED`** entra en `framework-errors.js` (http 500, no sustituible): es el `error` del elemento que detiene el
  lote sin `code` propio. Uno que lo detiene con un `code` fuera de `itemErrors` lleva ese `code`. El texto es
  `BATCH_ABORTED_MESSAGE` de `gen/batch.js`.
- **`CHK-USECASES-BATCH-NO-AUTH`** entra ya en el inc. 0, no en el 5: el schema admite `async` desde ahora. Sale
  co-disparada con `CHK-API-NO-SECURITY` por construcción, como `CHK-PERSIST-HISTORY-NO-SECURITY`.
- **`-NOT-COMMAND`** cubre también las otras puertas: `internal`, `schedule`, una suscripción que la dispara y un
  `dispatches` que la nombra.
- La pregunta de huecos va en la **clase 15** (Superficie HTTP), cuyas unidades ya son todas las operaciones expuestas:
  ningún `gaps.yaml` queda huérfano. `REV-BATCH-ITEM-ERRORS` va en la clase 2 (guardas ↔ errores).
- Frontera: `batchPendingErrors(layers, generador, { syncIncrement, asyncIncrement })`, con keel-spring 1/6, keel-nest
  2/7, keel-dotnet 3/8 y keel-go 4/9. Cuando un generador trae un modo, pasa `null` en ese modo.
- La respuesta tiene referencia ejecutable (`batchResponse`) y sus casos son datos del cable (`WIRE_BATCH_CASES`, tres
  reglas `batch-*`). Los casos `BA-1`…`BA-9` y los cuatro sabotajes del inc. 1 están en `BATCH_CASES`/`BATCH_SABOTAGES`.
- Sujetos: `catalog-batch` (relacional, `per-item`), `catalog-batch-mongo` y `catalog-batch-atomic` (`all-or-nothing`),
  todos sobre product-catalog, en `keel-core/test/helpers/batch-designs.js`.

Incremento 1 (keel-spring `sync`):

- **D3 medido y resuelto así**: el cuerpo es un sobre `<Op>BatchRequest` cuyo campo `over` es `List<JsonNode>` con la
  validación de la LISTA (`@NotEmpty @Size(max)`); con `List<<Elemento>>`, Jackson construye todos los value objects al
  leer el cuerpo y la primera guarda que salta es un 400 del lote. `BatchRunner` lee cada elemento con el MISMO
  `ObjectMapper` (las guardas del constructor incluidas) y el MISMO `Validator` que el borde, así que «mal formado»
  significa lo mismo dentro del lote que fuera. Un elemento `null` también es su `failed` con `VALIDATION_ERROR`. Su
  `message` es el de la guarda del value object, o `BATCH_ITEM_MALFORMED_MESSAGE` (nuevo en `gen/batch.js`) si no la hay.
- **El fallo de un elemento se traduce con el propio `ApiExceptionHandler`** (`ExceptionHandlerMethodResolver` sobre la
  excepción): el `code` y el `message` son los que daría la operación sola, también una unicidad que el motor viola y que
  el handler traduce al error declarado. El catch-all no lleva `code`, y por eso sale `BATCH_ABORTED`.
- **El handler procesa un elemento**: el mensaje lleva `item` en vez de la lista y devuelve `<Op>ItemResult` (un DTO más)
  cuando hay `batch.output`. Lo hace el modelo de keel-spring (`shapeBatchOperation` en `src/lib/model.js`), no el
  neutral. Valorar en el inc. 2 si se sube a `gen/model.js`.
- **`per-item` despacha cada elemento por el mediator**: una transacción por elemento con su reintento del conflicto
  transitorio, su log de frontera y su invalidación de caché (el riesgo de la caché: invalida por elemento, de más y no de
  menos). `all-or-nothing` abre una transacción alrededor y los despachos se unen a ella; un fallo al confirmar no es de
  ningún elemento y sale sin índice.
- **`ba-one-tx` cae también en BA-5**: en una transacción, el duplicado del mismo lote la marca para revertir y el commit
  del lote entero falla. `BATCH_SABOTAGES` lo dice. Y hay un quinto sabotaje, `ba-atomic-no-tx` (BA-6), que falsa el
  `all-or-nothing`.
- **BA-8 y BA-9 no se ejecutan todavía**: ningún sujeto declara `idempotency` ni eventos. La idempotencia del lote entero
  (D5) se **rechaza** con `batchFrontierErrors` (neutral, el mismo mensaje en los cuatro): el handler procesa un elemento,
  y la de la operación sola deduplicaría elementos y no el lote. Pendiente de decidir en qué incremento entra, con un
  sujeto que la declare; BA-9 entra con el diseño de contraste del inc. 11 o con un sujeto con mensajería.
- **El contrato** (`gen/openapi.js`): `per-item` responde `207` con `<Op>BatchResponse` (`BatchSummary`, `<Op>BatchItem`
  con `result` de `<Op>ItemResult` o null) y el 400 del sobre; los errores del diseño no salen como respuestas del lote
  porque viajan en su elemento. `batchContractClause` lo cuenta en la descripción.
- Red: `npm run batch-check` (catalog-batch en PostgreSQL y MySQL, catalog-batch-mongo y catalog-batch-atomic), en
  verde, y los cinco sabotajes cayendo en exactamente sus casos (`ba-one-tx` medido también en MongoDB).

Incremento 2 (keel-nest `sync`):

- **`shapeBatchOperation` sube al modelo neutral** (`gen/model.js`): el `<Op>ItemResult` y el `returningCommand` del handler
  de un elemento son los mismos en los cuatro. keel-spring deja de hacerlo en su `src/lib/model.js`.
- **D3 en keel-nest**: el lector de la operación lee el SOBRE y devuelve `{ items: unknown[], message(item) }`; la lista se
  lee con `json.listOf<unknown>((value) => value)` y solo se validan sus reglas (presencia y `maxItems`). `batch.ts` lee cada
  elemento con el MISMO `read<Elemento>` del borde. Para que el `message` sea el de la guarda, `valueObject` conserva el
  error del constructor como `cause` de `MalformedRequestError` (cambia `request-reading.ts` y `request-errors.ts` de
  todos los proyectos; la respuesta HTTP no cambia).
- **El fallo se traduce con `ApiExceptionFilter.translate`**, que el filtro solo emite cuando hay lotes. Per-item responde
  con `@HttpCode(207)`, fijo; all-or-nothing abre la transacción en el controlador (`TransactionContext`) y pone el status
  del culpable en el `reply`.
- **`ba-one-tx` no cae donde en keel-spring.** En TypeORM y en el driver de MongoDB un error capturado no marca la
  transacción para revertir, así que un lote en UNA transacción solo se distingue cuando el MOTOR la aborta tras un
  duplicado. La sonda de keel-nest guarda sin buscar el sku antes (el duplicado lo rechaza la unicidad y lo traduce el
  filtro al error declarado), y entonces `ba-one-tx` cae en BA-2 y BA-5 en PostgreSQL y MongoDB, y en MySQL no es
  observable (`BATCH_ONE_TX` de `scripts/lib/batch-probes.js`; el veredicto lo dice en voz alta). Medido. keel-dotnet y
  keel-go tendrán que medir lo suyo: EF Core y database/sql se parecen más a TypeORM que a Spring en esto.
- **El status per-item lo lee solo BA-1** (del metadato del decorador): es fijo, no depende del desenlace.
- Red: `test/batch-parity.test.js` (los mismos casos que keel-spring, la nota, el contrato byte a byte, y el bucle emitido
  EJECUTADO contra `batchResponse`); `db-check --subject=catalog-batch,catalog-batch-atomic` en PostgreSQL y MySQL y
  `doc-check --subject=catalog-batch-mongo`, en verde, con los cinco sabotajes cayendo en exactamente sus casos; `ts-check`
  13/13 con los tres sujetos como siluetas derivadas.

## Para retomar

Inc. 3, keel-dotnet `sync`. Calcar el 2: el sobre con los elementos sin leer (en keel-dotnet el lector del DTO valida el
cuerpo entero con DataAnnotations: el mismo riesgo D3), cada elemento con el mismo lector y las mismas reglas que el borde,
el despacho por elemento con su transacción, el fallo traducido con el mismo traductor que el borde y `batchResponse` como
oráculo. `syncIncrement: null` y `batchFrontierErrors` en `keel-dotnet/src/lib/supported-features.js`. La red es `db-check`
y `doc-check` con `scripts/lib/batch-probes.js` y los cinco sabotajes, más `test/batch-parity.test.js` contra los otros dos.
Medir primero dónde cae `ba-one-tx` con EF Core en cada motor (ver lo decidido en el inc. 2). La huella golden de keel-nest
está atrasada desde antes de la 2.30 (`npm run golden --workspace packages/keel-nest -- --check`): regenerarla en su propio
commit. Las filas de `capability-coverage` de los lotes se borran en el inc. 11.

## Verificación

- `npm test` en la raíz: el corpus de mutaciones sin `sin-mutacion`, y `capability-coverage` con una fixture que
  declare `batch` (los dos modos).
- Las redes en vivo de cada incremento, en verde y con cada sabotaje en rojo **exactamente** en sus casos.
- `node packages/keel-core/src/cli.js validate fixtures/designs/product-catalog --ready` en verde.
- Corridas de control (inc. 11) registradas con la huella de `corrida-metrics.js`. La puerta de cierre son las cinco
  en verde, sin un `designGap` nuevo sin clasificar.
