# DSL 2.30: lotes con resultado por elemento (R5)

**Estado: APROBADO el 2026-11-14.** Incrementos 0 a 10 cerrados el 2026-11-14 (la fase A, `sync`, y la fase B, `async`, en los cuatro generadores, con la fase B neutral en keel-core, y el contrato y el método); el 10b (D15, la idempotencia del lote síncrono) tiene hechas la parte neutral y keel-spring (2026-11-15); le siguen keel-nest, keel-dotnet y keel-go. Al cerrar pasa a `completed_plans/`.

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

## Decisiones (D1-D15)

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
| D9 | **Fase B, chunks sobre el cronómetro.** Cada trabajo arma al crearse, en la misma transacción, un temporizador de una vez en `keel_timer` (`kind: batch:<operación>`, `entity_id` = el id del trabajo), que se reclama con el arriendo y la valla de siempre. Cada disparo procesa un *chunk* de N elementos (`batch.chunk-size`, generador, default 100) y se rearma para ya si quedan, o se borra si no. Por elemento sigue D2, y **el resultado y el avance del cursor de cada elemento van en SU transacción**, con el cursor como valla (`WHERE cursor = :index`): si otra réplica le quitó el trabajo, el elemento revierte entero. Si la réplica cae, otra reanuda desde el cursor (ajustado en el inc. 5: confirmar el cursor solo con el último elemento del chunk reprocesaría lo confirmado antes) | Es el *commit interval* + *restart* de Spring Batch sobre la pieza que ya está medida con dos réplicas (R1, RC-1, R2) y con `SKIP LOCKED` |
| D10 | Fase B: `batch_item_result` (job, índice, estado, code, mensaje, resultado como JSON) se borra con su trabajo por **retención** (parámetro del generador, default 7 días), con una purga del cronómetro como las demás tablas del generador | Igual que `outbox_event` o `processed_event`: sin purga crece sin límite |
| D11 | Acceso: las rutas del trabajo exigen la misma regla de `security` que la operación, y solo las lee **quien lo creó** (el `sub` del llamante, como `authorship`). Otro llamante recibe 404 | Una URL de resultados no debe ser una fuga entre inquilinos. Es lo que hace 2.27 con `readMiss: not-found` |
| D12 | Eventos: cada elemento confirmado publica lo que publicaría la operación sola. El lote **no** publica un evento propio en esta versión | Un «lote completado» sería sintaxis nueva sin un consumidor que lo pida |
| D13 | **Idempotencia del lote (decidida el 2026-11-14).** En `async`, la clave (`client-key` o `payload-hash`) es una columna de `batch_job`, única por (operación, dueño, clave): la repetición responde el MISMO 202 con el mismo `Location` y el trabajo en el estado en que esté (no un 409 mientras corre); la misma clave con otro contenido es `IDEMPOTENCY_KEY_REUSED`, como en una operación sola, y `ttlSeconds` acota cuánto vale la clave (pasada la ventana, la libera el siguiente alta). `payload-field` y `partitionBy` siguen rechazados en un lote. En `sync`, la repetición devuelve el 207 entero guardado en el registro de idempotencia: entra tras la fase B en los cuatro, medida con BA-8 | Es el reintento que más daño hace en un lote (un corte de red tras 500 altas). En `async` el trabajo ya es la respuesta: guardar la clave en él es casi gratis, y la tabla se diseña con ella desde el principio |
| D15 | **Idempotencia del lote `sync` (decidida el 2026-11-15).** La guarda el TRABAJO, como en `async`: un lote síncrono con clave crea su fila en `batch_job` (en una transacción propia, sin temporizador) y cada elemento escribe su efecto, el avance del cursor (la valla) y su resultado en SU transacción; al terminar, `finish`. La respuesta se rehace siempre de lo guardado (`batchStoredBody`), así que es la misma para la primera petición, la repetición y la que reanuda. La repetición: misma firma y terminado, la respuesta guardada; otra firma, `IDEMPOTENCY_KEY_REUSED`; sin terminar y escrito hace menos de `batch.sync-stale-ms` (60 s), **409 `IDEMPOTENCY_KEY_IN_PROGRESS`**; sin terminar y más viejo, lo toma (`takeOver`, con la hora del motor) y sigue desde el cursor. El todo o nada con clave procesa en la transacción del lote y, si falla, borra su trabajo en otra (`discardJob`): la repetición lo vuelve a procesar. Sin capa `security`, el dueño es `BATCH_ANONYMOUS_OWNER` y la clave la acota la operación | Reutiliza las tablas, las sentencias, la valla, la ventana, la clave reutilizada y la purga ya medidas en los cuatro, en vez de cambiar la forma de `idempotency_record` (ya desplegada). Y gana algo que el registro no daba: un reintento tras un corte a mitad de lote reanuda en vez de reprocesar. El 409 en curso es la semántica de una operación sola con clave |
| D14 | `async` solo con `atomicity: per-item` (`CHK-USECASES-BATCH-ASYNC-ATOMIC`) | Un trabajo por chunks no cabe en una transacción: el todo o nada de un lote de minutos sería una transacción de minutos, que el tope de transacción mata. Spring Batch tampoco lo hace. Un lote todo o nada grande se parte en lotes `sync` |

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
| 10b | Idempotencia del lote `sync` (D13): la repetición devuelve el 207 entero guardado. Lo neutral en keel-core y una pieza por generador, como la fase B | BA-8 en `batch-check`, y en `db-check`/`doc-check` de los otros tres, con su sabotaje |
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

Incremento 3 (keel-dotnet `sync`):

- **D3 en keel-dotnet**: no hay DataAnnotations en el borde (el lector es generado), así que el riesgo era el mismo que en
  keel-nest: el lector de la operación lee el SOBRE con `JsonBodyReader.List(…, element => element)` y devuelve un
  `BatchEnvelope<Elemento, Mensaje>` (los `JsonElement` sin leer y `Message(item)`). `Api/Rest/Batch.cs` lee cada elemento
  con el MISMO `ValueReaders.Read<Elemento>`; la guarda llega como `InnerException` de `MalformedRequestException`.
- **El fallo se traduce con `ApiErrorMiddleware.Translate`**, que solo se emite con lotes y pasa antes el error por
  `PersistenceErrors.Translate`: en una transacción abierta el adaptador se une a ella y no traduce. El todo o nada abre
  `IUseCaseTransactions.Run` en el bucle (sin persistencia es el paso directo, siempre registrado), y su `ItemFailure` va
  sin causa, o la traducción de la persistencia (que recorre la cadena de causas) se llevaría el índice.
- **`ba-one-tx` medido**: en PostgreSQL y MySQL cae SOLO en BA-2. EF Core no marca la transacción por un error capturado
  (BA-4 no cae) y abre un savepoint antes de cada `SaveChanges` dentro de una transacción ajena (BA-5 no cae); la fila
  rechazada queda en el change tracker y el elemento siguiente choca con ella (BA-2). En MongoDB, BA-2 y BA-5, como en
  keel-nest. Está en `BATCH_ONE_TX` de `keel-dotnet/scripts/lib/batch-probes.js`. keel-go tendrá que medir lo suyo:
  database/sql no tiene savepoints automáticos y PostgreSQL aborta la transacción.
- La sonda llama al endpoint emitido con un `DefaultHttpContext` y el `ApiErrorMiddleware` delante (el proyecto de sondas
  referencia la API y registra `AddUseCases()` tras la persistencia); un `[Fact]` por caso en la clase de sondas compartida,
  con sku propios (`ZZ<letra>-9xxx`), sin vaciar tablas. BA-7 manda 501 elementos VÁLIDOS y comprueba que ninguno entró.
- Red: `test/batch-parity.test.js` (casos, nota y contrato contra keel-spring y keel-nest, la forma de lo emitido, los
  sabotajes aplicables); `db-check --only=catalog-batch,catalog-batch-atomic` en PostgreSQL y MySQL y
  `doc-check --only=catalog-batch-mongo`, en verde, con los cinco sabotajes cayendo en exactamente sus casos. Sin SDK no se
  ejecuta el bucle; lo ejecutan esas dos redes.

Incremento 4 (keel-go `sync`):

- **D3 en keel-go**: el lector de la operación devuelve `(msg, items []jsontext.Value, err)`: el mensaje con todo lo demás ya
  leído y los elementos sin leer, que el endpoint pone uno a uno en una COPIA del mensaje (`msg := cmd; msg.Item = item`). La
  lista no se lee con `member`: el lector de `jsontext.Value` del cable toma una cadena por un documento serializado, y un
  elemento `"mal"` sería un 400 del lote. Va con `rawList` (`reading.go`, `encoding/json/v2` sin las opciones del cable).
  `batch.go` lee cada elemento con `wire.Unmarshal`, el mismo lector del borde, y el `message` es el del `*domain.Error` con
  `VALIDATION_ERROR` que devuelve la guarda del constructor.
- **El fallo se traduce con `a.errorResponse`**, el que ya existía: en Go la traducción del motor la hace `within` también al
  unirse a una transacción abierta, así que no hace falta pasar antes por la persistencia (lo que sí necesitó keel-dotnet).
- **La transacción del lote**: `UseCases.InTransaction` (emitido con cualquier lote, no solo con el todo o nada: lo usa el
  sabotaje `ba-one-tx`). Su `Within` une a ella cada despacho, y `runAllOrNothing` reinicia los resultados en cada intento.
- **`ba-one-tx` medido**: BA-2 y BA-5 en PostgreSQL y MongoDB, y en MySQL no es observable, como en keel-nest (database/sql no
  marca la transacción por un error capturado, y MySQL no la aborta por un duplicado). Está en `BATCH_ONE_TX` de
  `keel-go/scripts/lib/batch-probes.js`.
- La sonda (`batch_probe_test.go`, en el paquete del almacén) llama al `http.Handler` ENTERO de `httpapi.NewHandler`, con los
  casos de uso de `NewUseCases` sobre las `Transactions` de la sonda: entra por el borde, la tabla de rutas y `writeError`.
- Red: `test/batch-parity.test.js` (casos, nota y contrato contra los otros tres, la forma de lo emitido, los sabotajes
  aplicables); `db-check --only=catalog-batch,catalog-batch-atomic` en PostgreSQL y MySQL y `doc-check --only=catalog-batch-mongo`,
  en verde, con los cinco sabotajes cayendo en exactamente sus casos; los tres sujetos con gofmt, vet y staticcheck vacíos y sus
  pruebas emitidas en verde.

Incremento 5 (fase B en keel-core):

- **D13, D14 y el ajuste de D9** (tabla de decisiones): la idempotencia del lote asíncrono vive en `batch_job`; `async` solo
  con `per-item` (`CHK-USECASES-BATCH-ASYNC-ATOMIC`, con su mutación); y el resultado y el cursor de cada elemento van en
  la transacción del elemento, con el cursor como valla.
- **El reclamo es el del cronómetro.** Cada trabajo arma al crearse un temporizador de UNA VEZ en `keel_timer`
  (`batch:<operación>`, `entity_id` = el id del trabajo), como un plazo: el arriendo, la valla, los reintentos, el aparcado
  y el despertar del sondeador ya están medidos con dos réplicas, así que `batch-store.js` no tiene sentencia de reclamo
  (el sabotaje `batch-skip-locked` del plan original no tiene a qué aplicarse). `timer-plan.js` gana `batchTimers` y la
  purga de `batch_job`, y `usesTimer` cuenta los lotes asíncronos.
- **`gen/batch-store.js`**: `batch_job` (`next_index` y no `cursor`, `item_index` y `error_code` en la otra: palabras
  reservadas de MySQL) y `batch_item_result` con FK en cascada, las dos en `GENERATOR_TABLES`; sus colecciones documentales
  (la unicidad de la clave es parcial: en MongoDB dos ausentes chocan); los parámetros `batch.chunk-size` (100),
  `batch.retention-days` (7) y `batch.purge.cron`; y las sentencias por motor (alta con la ventana de la clave calculada
  por el motor, repetición, liberación de la clave caducada, lectura del dueño, avance con valla, resultado, final de una
  sola vez, página y purga de lo terminado).
- **Referencias ejecutables** en `gen/batch.js`: `runBatchChunk` (un disparo desde el cursor, con caída simulada),
  `batchJobView` (el trabajo en el cable: `notAttempted` solo en uno `aborted`), `batchJobRepeat` y
  `batchRequestSignature` (D13: la firma es el sha256 de los BYTES del cuerpo; canonizar el JSON igual en los cuatro no
  compensa, y un reintento manda los mismos bytes), `batchJobPaths` (`<ruta>/jobs/{jobId}` y `…/results`), la nota del
  handler asíncrono (sin token; el actor de autoría es el dueño) y `BATCH_JOB_CASES` (BJ-1 a BJ-9) con
  `BATCH_JOB_SABOTAGES` (`bj-no-resume`, `bj-cursor-outside-tx`, `bj-foreign-reader`).
- **Estados**: `queued`, `running`, `completed` y `aborted` (detenido por un elemento, D4). El `failed` del plan original
  desaparece con D14: un trabajo por elemento no se revierte. Un temporizador aparcado deja el trabajo `running`, y lo
  delata la métrica de aparcados del cronómetro.
- **Los resultados** paginados son los de los elementos intentados; los `notAttempted` de un trabajo `aborted` no se
  escriben fila a fila, los cuenta su resumen.
- **`BATCH_JOB_NOT_FOUND`** (404, no sustituible) en `framework-errors.js`: lo ajeno, lo purgado y lo inexistente
  responden igual (D11).
- **La frontera neutral** (`batchFrontierErrors`): en `sync` la idempotencia del lote sigue rechazada (D13: entra tras la
  fase B); en cualquier modo, `payload-field` y `partitionBy`; en `async`, la identidad del llamante como campo del input
  (el trabajo corre sin token y el sobre guardado no la lleva).
- **El contrato**: `wire.js` (`batchJob`, dos reglas, `WIRE_BATCH_JOB_CASES`), `wire-contract.md` § Lotes asíncronos,
  `docs/dsl/use-cases.md` § Lotes asíncronos (cuándo `sync` y cuándo `async`) y `gen/openapi.js` (el 202 con `Location`
  y el esquema `BatchJob`, sin el 409 «en curso», y las dos rutas con su 404).
- **Sujetos** de la fase B en `BATCH_JOB_DESIGNS` (`catalog-batch-async` y `-mongo`, con una capa security con token y
  `client-key`): fuera de `BATCH_DESIGNS` hasta que un generador los genere. Hoy los cuatro los rechazan en su frontera
  (`batchPendingErrors`), y `planService` sobre ellos falla en cada generador porque la purga de `batch_job` no tiene
  todavía emisor: es lo esperado hasta su incremento.
- Red: `test/batch.test.js` (20 casos) y `timer-sql-check` con seis pasos nuevos en PostgreSQL y MySQL (`lote-alta`,
  `lote-ventana`, `lote-valla`, `lote-resultados`, `lote-final`, `lote-purga`) y cuatro sabotajes (`batch-fence`,
  `batch-key-expiry`, `batch-purge-live`, `batch-finish-twice`), cada uno en exactamente su paso.

Incremento 6 (keel-spring `async`):

- **La clave del lote asíncrono sale de la operación en el modelo neutral** (`gen/model.js`): `operation.idempotency` es null
  y la lleva `batch.idempotency` (`{ keySource, ttlSeconds }`). Así ningún generador monta `idempotency_record`, su filtro
  ni su purga para un lote asíncrono (D13), sin tocar cada selector. `openapi.js` e `idempotencyOutcomeCodes` leen las dos,
  y el contrato no cambia.
- **El cronómetro gana un modo**: `TimerHandler.inTransaction()` (por defecto true). El trabajo de un lote lo pone a false:
  el chunk corre FUERA de la transacción del sondeador, cada elemento abre la suya, y el sondeador borra o rearma el
  temporizador después, con la valla. Un fallo cuenta y aparca como el de un plazo. Los otros tres tendrán que dar el
  mismo modo a su sondeador.
- **El alta lee los BYTES del cuerpo** (`@RequestBody byte[]`): la firma de D13 es su sha256, y el sobre se lee con el
  mismo ObjectMapper y se valida con el mismo Validator que el borde. Un sobre mal formado sale por
  `HttpMessageNotReadableException` (el `malformed` del borde) y uno que viola las cotas de la lista por
  `ConstraintViolationException`: el `VALIDATION_ERROR` del lote síncrono, con el mensaje `invalidParams` de
  `api-errors.js` y no `invalidBody` (no hay `MethodParameter` con el que construir la del cuerpo). Los otros tres tienen
  que responder ese mismo mensaje.
- **La carrera del alta** con la misma clave la arbitra la unicidad del motor: la que pierde vuelve a buscar la clave en
  otra transacción y responde el trabajo de la ganadora (sin el 409 «en curso»).
- **El orden dentro de la transacción del elemento es avance y después resultado**: el avance toma la fila del trabajo y
  es la valla; con el resultado primero, un elemento ya escrito por otra réplica chocaría en la clave primaria antes de
  llegar a la valla. En MongoDB, mover el cursor fuera de la transacción del elemento da un WriteConflict en vez de cero
  filas; el procesador lo trata como un fallo y su transacción de fallo vuelve a chocar con la valla, así que el elemento
  revierte igual.
- **El dueño** es el actor de autoría (`AuditorAware`, que ahora se emite también con lotes asíncronos) y el procesador
  corre con él en el `SecurityContext`, así que la autoría de cada elemento es la de quien creó el trabajo.
- **La frontera de keel-spring** (`batchJobStackErrors`): motor sin sentencias medidas, ruta con parámetros (el trabajo
  guarda el cuerpo) y un mensaje que estampa la petición (identidad, versiones, alcance). El último caso lo cubre en parte
  la frontera neutral; los otros dos son de cada generador.
- `BatchRunner` expone a su paquete `read` y `failureOf` (una sola traducción del fallo por elemento: con dos, el catch-all
  dejaba la pila dos veces en el log), y el bucle síncrono los usa también.
- **Red**: `batch-check` con los sujetos de `BATCH_JOB_DESIGNS` (`src/lib/batch-job-probes.js`): MockMvc sin la cadena de
  seguridad y el dueño puesto a mano; el temporizador disparado a mano con el chunk a 2; la caída a mitad de chunk es un
  almacén envuelto que lanza un `Error` al escribir el resultado del elemento 3 (BJ-4), y la réplica que se lleva el
  trabajo es un gancho del handler que mueve el cursor en otra transacción tras el efecto (BJ-5). BJ-1 a BJ-9 en verde en
  PostgreSQL, MySQL y MongoDB; `bj-no-resume` (empezar en el principio del chunk) cae en BJ-4, `bj-cursor-outside-tx` en
  BJ-4 y BJ-5 y `bj-foreign-reader` en BJ-6, exactamente.
- **Sin fila en la matriz de paridad**: los lotes no la tienen desde el inc. 1, y una fila nueva en el catálogo neutral
  (`gen/mechanisms.js`) obliga a los cuatro generadores. Entra en el inc. 10.

Incremento 7 (keel-nest `async`):

- **`src/scaffold/batch-jobs.js`** emite el almacén (`BatchJobStore` abstracto en `infrastructure/persistence/batch/`, con
  `SqlBatchJobStore` sobre las sentencias de keel-core tal cual más las dos tablas mapeadas solo para el esquema, o
  `MongoBatchJobStore` con sus índices en `DOCUMENT_INDEXES`, la clave única y parcial), `BatchSettings`, `BatchJobs` (el
  alta y las dos rutas), `BatchJobRunner` (el chunk) y un `<Op>BatchJob` por operación, en `infrastructure/rest/batch/`.
  No importa a ningún otro emisor: controllers.js, timer.js y application.js lo importan a él.
- **El alta firma el TEXTO del cuerpo**: con lotes asíncronos, el lector JSON de `http-platform.ts` deja el texto tal como
  llegó en la petición (`rawBody`), y `rawBodyOf` lo lee (sin él, `MalformedRequestError`, como el `byte[]` obligatorio de
  keel-spring). El sobre se lee con el MISMO lector de la operación, que el controlador exporta para que el procesador lo
  vuelva a usar sobre lo guardado; un cuerpo que no es JSON es malformado, y una cota de la lista, el `RequestValidationError`
  rehecho con `source: 'params'` (el mensaje `invalidParams` de keel-spring).
- **El sondeador gana `TimerHandler.inTransaction?: boolean`** (sin el campo, dentro): el trabajo lo pone a false, y el
  sondeador borra o rearma después con la valla (`settle`). Con telemetría la expresión va dentro de una flecha no async:
  la rama nueva va con `.then`, sin `await` (lo destapó `observability-assets.test.js`, que ejecuta el sondeador); y sin
  telemetría va entre paréntesis, o el `await` solo espera a la condición y el fallo de un plazo sale como rechazo sin
  capturar (lo destapó el sujeto `verification-codes` de db-check y doc-check, que hay que pasar al tocar el sondeador).
  La rama fuera de transacción no la ejecuta ninguna sonda por el sondeador: BJ-* dispara el handler a mano, como keel-spring.
- **`batch.ts` exporta `readBatchItem`, `InvalidBatchItem` e `itemFailure`**: una sola lectura y una sola traducción del
  elemento para el lote síncrono y el procesador, como `read`/`failureOf` de keel-spring.
- **Un fallo que no es la valla se traduce**: en TypeScript se captura todo, así que la caída simulada de BJ-4 sale primero
  como un fallo del elemento y vuelve a caer al escribir su resultado de fallo, fuera ya del procesador; el cursor queda
  donde estaba y el siguiente disparo sigue desde él. La valla perdida es `FenceLost`, que revierte la transacción del
  elemento y para el disparo.
- **El almacén documental calcula la hora con `$$NOW`** (como `MongoTimerStore`) y no inyecta `TimerStore`: el módulo de
  persistencia va antes que el del cronómetro y las pruebas emitidas lo levantan sin él.
- **El dueño** es `currentActor()` (`audit-actor.ts`, emitido también con lotes asíncronos) y el procesador corre con un
  principal de token cuyo `sub` es el dueño (`SecurityContext.runWith`). `BatchJobs`, `BatchJobRunner` y `BATCH_SETTINGS`
  van en `TimerModule` (global); el almacén, en `PersistenceModule`; los handlers, en `TimerPollerModule`, que importa
  `UseCaseModule` con plazos o con lotes. La purga de `batch_job` es `BatchJobPurgeTimer` (timer.js delega su cuerpo en
  `batchPurgeTimerBody`): no pasa por TablePurges, y `purgeTimerBlock` de las sondas la deja fuera.
- **`batch.yaml`** se emite en los cuatro perfiles; los tres de keel-spring son iguales byte a byte (keel-spring no escribe
  el de `test`).
- Red: `test/batch-jobs.test.js` (frontera, casos, nota, configuración y contrato contra keel-spring, sentencias tal cual,
  índice parcial, cronómetro, el alta, la valla antes del resultado, la frontera de planService y los sabotajes
  aplicables); los sujetos de `BATCH_JOB_DESIGNS` en `DERIVED_SILHOUETTES` (ts-syntax y `ts-check` 13/13); y
  `scripts/lib/batch-job-probes.js` en `db-check --subject=catalog-batch-async` (PostgreSQL y MySQL) y
  `doc-check --subject=catalog-batch-async-mongo`: BJ-1 a BJ-9 en verde, y `bj-no-resume` en BJ-4, `bj-cursor-outside-tx`
  en BJ-4 y BJ-5 y `bj-foreign-reader` en BJ-6, exactamente, en los tres motores. El handler de la sonda es el de la fase A
  con un gancho (`probeHooks.afterEffect`), y la sonda de la fase A deja fuera las operaciones asíncronas.

Incremento 8 (keel-dotnet `async`):

- **Los handlers de los trabajos son de la API, no de `AddTimer`.** El procesador lee el sobre guardado con el lector del
  endpoint (que con un lote asíncrono es público y lee de `ReadOnlyMemory<byte>`) y traduce el fallo con el
  `ApiErrorMiddleware`, y el proyecto de Infrastructure no ve la API. `AddBatchJobs` los registra desde Program.cs, junto a
  `BatchSettings.From`; la purga, que solo necesita el almacén y la configuración, sí va en `AddTimer`.
- **`ITimerHandler.InTransaction`** es un miembro por defecto de la interfaz (true): los plazos no cambian.
- **Cada elemento en su ámbito** (su DbContext o su sesión), con `IUseCaseTransactions.Run`: así lo que deja una transacción
  revertida en el change tracker no llega al elemento siguiente.
- **La traducción sin petición**: `ApiErrorMiddleware.Translate(IServiceProvider, …)`, de la que la de `HttpContext` es un
  atajo. `BatchRunner.ReadItem` y `FailureOf` (nuevo, la regla de qué falla solo su elemento y qué detiene el lote) los
  comparten el lote síncrono y el procesador.
- **El 400 del sobre** usa `ViolationSource.Params` en el lector asíncrono: el mensaje `invalidParams` de keel-spring.
- **Las rutas del trabajo son filas de ApiRoutes** (`<op>Job` y `<op>JobResults`), y el alta asíncrona responde 202 con
  `Location: true` en su fila.
- Red: `test/batch-jobs.test.js` (casos, nota, configuración y contrato contra keel-spring y keel-nest, sentencias tal cual,
  tablas en el paso de esquema, índice parcial, cronómetro, el alta, la valla antes del resultado, la frontera de
  planService y los sabotajes aplicables); los sujetos en `UNCOVERED_BRANCHES` (cs-syntax, uncovered-branches y `cs-check
  --fixtures`: 12/12 ensamblados sin warnings, 235 pruebas); `scripts/lib/batch-job-probes.js` en
  `db-check --only=catalog-batch-async` (PostgreSQL y MySQL) y `doc-check --only=catalog-batch-async-mongo`: BJ-1 a BJ-9 en
  verde, y `bj-no-resume` en BJ-4, `bj-cursor-outside-tx` en BJ-4 y BJ-5 y `bj-foreign-reader` en BJ-6, exactamente, en los
  tres motores. El lote síncrono y el cronómetro (`verification-codes`) siguen en verde en db-check y doc-check.

Incremento 9 (keel-go `async`):

- **La frontera hexagonal decide el reparto**: httpapi no puede importar la infraestructura, así que el puerto
  (`domain.BatchJobStore`, como el registro de idempotencia) va en el dominio, su adaptador en el paquete del almacén
  (`<almacén>/batch_jobs.go`, con las sentencias de keel-core por el `timerSQL` del cronómetro, o MongoDB) y el alta, las dos
  rutas y el procesador en `internal/httpapi/batch_jobs.go`. El temporizador es `timer.NewBatchJob`, que recibe el disparo
  del procesador como FUNCIÓN: el cronómetro no ve la API. El almacén llega a la API por las Dependencies (`BatchJobs`) y
  `UseCases.BatchJobs()`.
- **El dueño lo pone el almacén**: `auditActor(ctx)` en el alta, la clave y `Owned`. `audit_actor.go` se emite también con
  lotes asíncronos, y el procesador corre con un principal de token cuyo `sub` es el dueño (`security.WithPrincipal`).
- **El alta arma el temporizador dentro del `Insert`** del almacén (`armTimer`, en la transacción que abre
  `UseCases.InTransaction`), en vez de pedir el almacén del cronómetro desde la API.
- **El modo fuera de transacción es una interfaz opcional** (`InTransaction() bool`), que el sondeador consulta con `detached`
  (emitido solo con lotes asíncronos): ejecuta el handler y después `Store.Resolve` con el desenlace ya calculado.
- **El procesador vuelve a leer el sobre** con `http.NewRequestWithContext` sobre el `input` guardado y el MISMO lector de la
  operación; el alta lo hace sobre un clon de la petición con los bytes ya leídos. El 400 del sobre asíncrono usa
  `violations{params: true}` (el mensaje `invalidParams` de keel-spring).
- **`batchFailureOf` (`batch.go`) es la regla compartida** de qué falla solo su elemento, también en el bucle síncrono; el
  sabotaje `ba-continue-on-undeclared` pasa a `stopped = stops`.
- **La sonda** (`scripts/lib/batch-job-probes.js`, `batch_job_probe_test.go`) entra por el `http.Handler` ENTERO con la
  seguridad emitida, un JWKS de `securitytest` y un token por dueño; BJ-4 envuelve el almacén emitido en las Dependencies,
  BJ-5 usa `application.ProbeAfterEffect`, un gancho del handler de la sonda. La sonda síncrona deja fuera las operaciones
  asíncronas. La de los índices vivos de doc-check lee el filtro parcial por tipo de la clave (`partialType`).
- Red: `test/batch-jobs.test.js` (11 casos, contrato byte a byte con los otros tres); `db-check --only=catalog-batch-async`
  en PostgreSQL (35 sondas) y MySQL (36) y `doc-check --only=catalog-batch-async-mongo` (29), en verde, con `bj-no-resume` en
  BJ-4, `bj-cursor-outside-tx` en BJ-4 y BJ-5 y `bj-foreign-reader` en BJ-6, exactamente, en los tres motores. Los sujetos
  de `BATCH_JOB_DESIGNS` en `UNCOVERED_BRANCHES` (go-check y go-syntax).

Incremento 10 (contrato y método):

- **El status de éxito de un lote es una sola función** (`batchSuccessStatus` en `gen/batch.js`: 202 el asíncrono, 207 el
  `per-item`, el de la ruta el resto). La usan `gen/openapi.js` y las tablas de rutas de keel-nest (`ROUTES`), keel-dotnet
  (`ApiRoutes`) y keel-go. Medirlo destapó que las tres decían `200` en un lote `per-item` mientras el contrato y la respuesta
  decían `207`, y que keel-nest no marcaba el `Location` del alta asíncrona. Ninguna red lo veía: las tablas solo deciden
  el 404 frente al 405, y el status real lo pone el endpoint.
- **`keel-nest/test/openapi.test.js`** cubre los cinco sujetos de lotes: el mismo documento en los cuatro, sin `$ref`
  colgados, la tabla de rutas con el mismo status y `Location`, `<Op>BatchResponse`/`BatchSummary`/`<Op>BatchItem`/`BatchJob`
  con las claves de `WIRE_SHAPES` (las cinco del elemento requeridas), los estados de `BATCH_JOB_STATUSES`, las dos rutas del
  trabajo con su 404 `BATCH_JOB_NOT_FOUND`, la misma `security` que el alta y servidas por el controlador de keel-nest, los
  `itemErrors` fuera de las respuestas del lote, y sin deriva para `CHK-DOCS-OPENAPI-DRIFT`.
- **La fila `batch` de la matriz de paridad** (`gen/mechanisms.js`, con la red `batch-check` de keel-spring) en los cuatro:
  verificada y falsada en sus dos ramas con lo medido en los incrementos 1 a 9; `parity.skip` hasta que una fixture la
  declare (inc. 11). keel-go ata sus celdas a `BATCH_SABOTAGE_SPECS` y `BATCH_JOB_SABOTAGE_SPECS` en `FALSIFIED_BY`.
- **Método**: `methodology.md` (cuándo `sync` y cuándo `async`, y el lote en la fila de comportamiento estructural),
  `dsl/use-cases.md` (los cuatro generadores traen los dos modos; la idempotencia del lote síncrono todavía se rechaza), la
  pregunta de `/keel-design` (atomicidad, `itemErrors` y modo), `/keel-docs` y su guía de Postman (el 207 por elemento, el
  sondeo del trabajo con `pm.execution.setNextRequest` y un tope de intentos, el 404 del trabajo ajeno), la fila de evidencia
  de `/keel-recover` y los agentes de código y de calidad de los cuatro (el handler procesa un elemento; nada de bucle,
  transacción ni captura del error).
- **El lint de redocly** de los contratos de lotes no se pasó: el usuario lo dejó fuera. Lo cubren los oráculos de
  `openapi.test.js`, y los documentos salen del mismo `openapi.js` que pasó el lint en la 2.29.
- **D13 en `sync` (BA-8) tenía que entrar «tras la fase B» y no tenía incremento**: pasa a ser el 10b, antes de las corridas,
  para que estas midan la 2.30 sin un hueco conocido.

Incremento 10b, parte neutral (keel-core, D15):

- **El modelo**: un lote con `idempotency` no la lleva en la operación en NINGÚN modo (`operation.idempotency` null), sino en
  `batch.idempotency`; así ningún generador monta `idempotency_record` para un lote síncrono.
  `keyedSyncBatchOperations` y `batchJobStoreOperations` (los asíncronos y los síncronos con clave) dicen quién usa
  `batch_job`, y su purga entra en el cronómetro también sin lotes asíncronos (`generatorPurges`).
- **Las referencias**: `batchSyncRepeat` (create, reused, replay, in-progress, resume) y `batchStoredBody` (el 207 rehecho de
  lo guardado, el mismo que `batchResponse` también tras un corte y una reanudación). La nota del handler gana «Lote con
  clave». La cláusula del contrato lo cuenta sin nombrar el `code` del 409, que el diseño puede sustituir; el 409 en curso y
  el de la clave reutilizada ya salían en el contrato.
- **Las sentencias**: `batchSyncStatements(engine)`, aparte de las del asíncrono para que un proyecto sin lotes síncronos con
  clave no las lleve: `takeOver` (toma un lote sin terminar que nadie escribe desde hace más de `:staleMs`, con la hora del
  motor) y `discardJob` (el todo o nada que falla). El umbral es `BATCH_SYNC_STALE` (`batch.sync-stale-ms`, 60 s), también
  fuera de `BATCH_PARAMETERS` por lo mismo. Medidas en
  `timer-sql-check` (`lote-toma`, `lote-descarte`; 54 pasos) con los sabotajes `batch-takeover-live` y
  `batch-discard-finished`.
- **La frontera**: `batchFrontierErrors(layers, generador, { syncIdempotency })` sigue rechazando la clave del lote síncrono
  (mensaje con D15) hasta que cada generador pasa `true`.
- **Casos y sujetos**: BA-8 remite a `BATCH_KEY_CASES` (BK-1 a BK-5) y `BATCH_KEY_SABOTAGES` (`bk-replay-reprocess`,
  `bk-steal-running`, `bk-no-resume`, `bk-keep-failed`); sujetos en `BATCH_KEY_DESIGNS` (`catalog-batch-keyed`, `-mongo` y
  `catalog-batch-atomic-keyed`, sin capa security: dueño `BATCH_ANONYMOUS_OWNER`).

Incremento 10b en keel-spring (D15):

- **`KeyedBatches`** (`src/scaffold/batch-jobs.js`) es el lote síncrono con clave: crea o encuentra el trabajo en una
  transacción propia (`start`, la repetición de `batchSyncRepeat` con `byKey`, `job` y `takeOver`), procesa desde el cursor y
  responde siempre lo guardado. La carrera del alta la arbitra la unicidad, como en el asíncrono, y la que pierde encuentra
  el trabajo en marcha: 409 en curso. Una valla perdida a mitad de lote (otra petición lo tomó) también es el 409 en curso.
  Sin clave en la petición (la cabecera ausente) es el lote de siempre, sin trabajo.
- **El cuerpo llega en bytes** (`@RequestBody byte[]`, como el alta asíncrona) y el sobre lo lee `KeyedBatches.read` con el
  lector del borde: el 400 del sobre de un lote con clave lleva el mensaje `invalidParams`, como el del asíncrono, y no el
  `invalidBody` del lote sin clave. Los otros tres tienen que hacer lo mismo.
- **`BatchJobSteps`** reúne lo que comparten el procesador asíncrono y el lote con clave: leer y firmar el sobre, el paso de
  un elemento (efecto, avance y resultado en una transacción, ahora con tres desenlaces: `NEXT`, `STOP` y `LOST`, la valla
  perdida) y la respuesta rehecha (`stored`, `batchStoredBody`). `BatchJobs` y `BatchJobRunner` la usan; el sabotaje
  `bj-cursor-outside-tx` apunta ahora a `BatchJobSteps.java`.
- **El todo o nada con clave** reutiliza el bucle de `BatchRunner` con un `Sink` (guardar cada resultado y cerrar el trabajo
  dentro de la transacción del lote; descartarlo si falla). Un fallo al confirmar, que no es de ningún elemento, también
  descarta el trabajo.
- **El dueño**: `BATCH_ANONYMOUS_OWNER` sin capa security; con ella, el actor de autoría (`AuditorAwareConfig` se emite
  también para un lote con clave con security).
- **Lo que se emite solo con clave**: `takeOver`/`discard` en el puerto y en los dos adaptadores, `BatchKeyInProgressException`
  (el code declarado o el canónico) y `batch.sync-stale-ms` en `batch.yaml`. Un proyecto con solo lotes con clave no lleva el
  chunk, ni `BatchJobs`, ni el procesador, ni `TimerKinds` del lote; sí la purga de `batch_job`. La frontera de stack
  (`batchJobStackErrors`) rechaza también un lote con clave sobre un motor sin sentencias.
- Red: `test/batch.test.js` (seis casos nuevos); `batch-check` con los sujetos de `BATCH_KEY_DESIGNS`
  (`src/lib/batch-key-probes.js`, `BatchKeyCheckTest` junto a `BatchCheckTest`): BA-* y BK-1 a BK-4 en verde en PostgreSQL,
  MySQL y MongoDB, y BA-6, BA-7 y BK-5 en PostgreSQL y MySQL; `bk-replay-reprocess` en BK-1, `bk-steal-running` en BK-3,
  `bk-no-resume` en BK-4 (PostgreSQL y MongoDB) y `bk-keep-failed` en BK-5, exactamente. La petición que muere a mitad de
  lote es un `Error` lanzado por el gancho del handler tras el efecto del segundo elemento.

Incremento 10b en keel-nest (D15):

- **`KeyedBatches`** (`src/scaffold/batch-jobs.js` → `infrastructure/rest/batch/keyed-batches.ts`) es el gemelo del de
  keel-spring: crea o encuentra el trabajo en una transacción propia (`releaseKey`, `byKey`, `job`, `takeOver`), procesa
  desde el cursor y responde siempre lo guardado. La carrera del alta la arbitra la unicidad del motor; la que pierde
  encuentra el trabajo en marcha (409 en curso), y una valla perdida a mitad de lote también es el 409 en curso.
- **`BatchJobSteps`** (`batch-job-steps.ts`) reúne lo que compartían el alta y el procesador asíncrono (la firma, el texto
  del cuerpo, la cabecera, el lector del sobre, la clave reutilizada y el resultado guardado) y el paso de un elemento con
  tres desenlaces (`next`, `stop`, `lost`). Es una clase SIN inyección: la construyen `BatchJobRunner` y `KeyedBatches` con
  el almacén que reciben, así las sondas que les pasan un almacén que cae (BJ-4, BK-3, BK-4) siguen funcionando. El
  sabotaje `bj-cursor-outside-tx` apunta ahora a `batch-job-steps.ts`.
- **El cuerpo como texto**: el controlador de un lote con clave recibe `(params, query, request, reply)`, firma
  `rawBodyOf(request)` (http-platform.ts lo guarda en cuanto hay almacén de trabajos) y lee el sobre con
  `KeyedBatches.read`: el 400 del sobre lleva `invalidParams`, como el asíncrono y como keel-spring.
- **El todo o nada con clave** reutiliza `allOrNothing` de batch.ts con un `AtomicSink` (`kept`, `completed`) dentro de la
  transacción del lote, y `KeyedBatches` descarta el trabajo si falla o si no se confirma. El controlador no inyecta
  `TransactionContext` para un lote con clave.
- **Lo que se emite solo con clave**: `takeOver`/`discard` en el puerto y en los dos almacenes, `syncStaleMs` en
  `BatchSettings`, `batch.sync-stale-ms` en `batch.yaml` (línea a línea el de keel-spring, sin `chunk-size` si no hay
  asíncronos). `usesBatchJobs` significa ahora «almacén de trabajos» (asíncronos o síncronos con clave); el alta, el
  procesador y su temporizador son de `usesAsyncBatchJobs`, y `KeyedBatches` lo provee `TimerModule` como `BatchJobs`. El
  dueño sin capa security es `BATCH_ANONYMOUS_OWNER`; con ella, el actor de autoría (audit-actor.ts se emite para todo
  lote con trabajo y security).
- **La muerte a mitad de lote** de la sonda no puede ser un error del handler, como en keel-spring: en TypeScript se
  captura todo y sería el fallo de su elemento. Es un almacén que lanza al escribir el resultado del SEGUNDO elemento,
  que vuelve a caer al escribir el de fallo y escapa del lote sin mover el cursor (como BJ-4).
- Red: `test/batch-keys.test.js` (10 casos: frontera, casos BK, nota, `batch.yaml` y contrato byte a byte con keel-spring,
  sentencias tal cual, lo que no se emite sin asíncronos, sabotajes aplicables); los sujetos de `BATCH_KEY_DESIGNS` en las
  siluetas (`ts-syntax`), en `db-check` (`catalog-batch-keyed`, `catalog-batch-atomic-keyed`) y en `doc-check`
  (`catalog-batch-keyed-mongo`) con `scripts/lib/batch-key-probes.js`. BK-1 a BK-5 y BA-* en verde en PostgreSQL, MySQL y
  MongoDB; `bk-replay-reprocess` en BK-1, `bk-steal-running` en BK-3, `bk-no-resume` en BK-4 (también en MySQL) y
  `bk-keep-failed` en BK-5, exactamente.

## Para retomar

Inc. 10b en keel-dotnet y keel-go, uno tras otro desde main (keel-spring y keel-nest hechos). En cada uno: el lote
síncrono con clave (D15) sobre el almacén de trabajos que ya emite para el asíncrono (`usesBatchJobs` pasa a
`batchJobStoreOperations`), sin temporizador; la repetición con `batchSyncRepeat` resuelta por `byKey`, `job` y `takeOver` (las de `batchSyncStatements`, con `BATCH_SYNC_STALE` en su configuración);
el 207 rehecho con `batchStoredBody`; el todo o nada con `discardJob`; `syncIdempotency: true` en su frontera; los sujetos de
`BATCH_KEY_DESIGNS` en su red (`batch-check` en keel-spring, `db-check`/`doc-check` en los otros) con BK-1 a BK-5 y los
cuatro `bk-*` cayendo exactamente en sus casos; y su paridad contra los anteriores. La muerte a mitad de lote de la sonda
no es un error del handler en ninguno de los dos (C# y Go capturan como TypeScript): un almacén que lanza al escribir el
resultado del segundo elemento, como en keel-nest. El contrato de `BATCH_KEY_DESIGNS` entra en `keel-nest/test/openapi.test.js`
cuando los cuatro lo generen (hoy lo compara `batch-keys.test.js` solo con keel-spring). Cuando los cuatro lo generen, los
sujetos pasan a `BATCH_DESIGNS`, la huella golden de keel-nest se regenera (`wire-contract.md` cambió) y sigue el inc. 11
(diseño de contraste y corridas). Las filas de `capability-coverage` de los lotes se borran en el inc. 11.

## Verificación

- `npm test` en la raíz: el corpus de mutaciones sin `sin-mutacion`, y `capability-coverage` con una fixture que
  declare `batch` (los dos modos).
- Las redes en vivo de cada incremento, en verde y con cada sabotaje en rojo **exactamente** en sus casos.
- `node packages/keel-core/src/cli.js validate fixtures/designs/product-catalog --ready` en verde.
- Corridas de control (inc. 11) registradas con la huella de `corrida-metrics.js`. La puerta de cierre son las cinco
  en verde, sin un `designGap` nuevo sin clasificar.
