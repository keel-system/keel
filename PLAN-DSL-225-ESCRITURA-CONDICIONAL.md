# DSL 2.25 — la escritura condicional (`ETag` / `If-Match`), de extremo a extremo

Origen: R1 de `docs/evaluacion-dsl-2.24.md`. Este plan la lleva al DSL y a los cuatro generadores con la misma regla de
siempre: **el mismo diseño genera servidores equivalentes**. Cada pieza nueva tiene una red que la ejecuta y un
sabotaje que demuestra que esa red la ve.

## Por qué

`optimisticLocking: all` arbitra dos transacciones que se cruzan **dentro** del servidor. La actualización perdida de
verdad ocurre **entre dos peticiones**: Ana carga la ficha a las 10:00, Luis cambia el precio a las 10:02, y a las 10:05
Ana guarda con el formulario viejo. El PUT de Ana carga la versión de Luis y confirma. El precio de Luis desaparece y
nada falla: ningún escenario lo ve, porque los escenarios de hoy afirman el conflicto de dos escrituras simultáneas.

Hoy no se puede arreglar desde el diseño. Con `all`, la versión no viaja al cliente. Con `declared`, `lockVersion` es
`generated: true` y el cliente nunca la puede devolver. El agente tampoco puede improvisarlo, porque el DSL le prohíbe
aceptar `lockVersion` del cliente.

## El DSL

```yaml
# api.keel.yaml
concurrency:
  conditionalWrites: required        # none (default) | optional | required
  operations: [updateProduct, retireProduct]
```

- **Las escrituras listadas** aceptan `If-Match`. Si la versión no coincide, responden `412 PRECONDITION_FAILED`. Si
  la cabecera falta y la política es `required`, responden `428 PRECONDITION_REQUIRED`. Con `optional`, una escritura
  sin cabecera se comporta como hoy.
- **Las lecturas que dan el `ETag`** no se declaran: se derivan. Son las queries con endpoint cuya salida es la
  representación **única** (ni lista ni página) de la raíz que escribe alguna operación listada. Lo deriva
  `keel-core/gen`, para que los cuatro generadores elijan las mismas.
- **Una escritura listada cuya salida es esa misma representación** devuelve el `ETag` nuevo. Así el cliente puede
  encadenar dos ediciones sin releer.
- **`PRECONDITION_FAILED` y `PRECONDITION_REQUIRED` entran en la lista cerrada** de `framework-errors.md`, con su
  override por `errors`, como los demás.

## Decisiones

Cada decisión se toma aquí para que los cuatro generadores no la tomen cada uno por su cuenta.

| # | Decisión | Por qué |
|---|---|---|
| D1 | ETag **fuerte**, `"<versión>"` entre comillas; el contrato lo declara opaco | Es idéntico en los cuatro sin depender de cómo serializa cada uno el JSON. Un hash del cuerpo saldría distinto en cada generador |
| D2 | Comparación fuerte. `*` se cumple si el recurso existe. Una lista se cumple si coincide cualquiera. Un `W/"…"` o un valor ilegible **no** coincide y da `412` | RFC 9110 § 13.1.1. Que lo ilegible dé 412 y no 400 evita una rama más que medir |
| D3 | Orden: `401` → `403` → `428` → `400` → `404` → `412` → `409` | El `428` no necesita cargar nada: sale en el borde. El `404` va antes que el `412` porque el `NOT_FOUND` del diseño sigue siendo el contrato; un 412 sobre algo que no existe invitaría a releer y recibir un 404 |
| D4 | **La comparación la hace el adaptador generado**, no el handler: el puerto gana `loadExpecting(id, expected)` | Así se mide con `db-check` sin necesidad de una corrida. El handler solo tiene que llamarla, y eso lo vigila un gate |
| D5 | La versión esperada viaja en el mensaje de la operación como un campo que el borde estampa a partir de `If-Match` (`@JsonIgnore` en keel-spring) | Es el mismo patrón de `entryGate` y de la identidad del llamante. Desde otra puerta (evento, despacho, reloj) el campo llega nulo y no se compara |
| D6 | El tipo de retorno de los handlers de las lecturas derivadas y de las escrituras con salida es `Versioned<T>` | El compilador obliga al agente a devolver la versión, en los cuatro lenguajes |
| D7 | Fuera de 2.25: `If-None-Match` y `304`, `If-Unmodified-Since` y `If-None-Match: *` en la creación | Son optimización o un caso que nadie ha pedido |

## Qué escribe build y qué escribe el agente

| Pieza | Quién | Red |
|---|---|---|
| Leer `If-Match`, dar `428`, estampar la versión esperada en el mensaje | build (borde) | prueba emitida de la API |
| `ETag` en la respuesta, a partir de `Versioned<T>` | build (borde) | prueba emitida de la API |
| `loadExpecting` en el puerto y en los adaptadores, en las dos ramas | build | `db-check` / `doc-check` (keel-spring: `precondition-check`) |
| `save` devuelve la versión **persistida** | build | ídem (CW-4) |
| Mapear la excepción a `412` con su `code` y su `message` | build | prueba emitida de la API |
| `ETag` en las cabeceras expuestas de CORS | build (`security.js`) | prueba emitida de la API |
| La entrada de caché conserva la versión | build (`cache.js`) | `cache-check` |
| Llamar a `loadExpecting` en el handler | agente | gate `check-conditional-writes.sh` + corrida |
| Devolver la versión correcta en `Versioned<T>` | agente | compilador + corrida |

## La medición: un solo vocabulario de sondas

Lo neutral vive en `keel-core/src/lib/gen/conditional-writes.js`:
- qué operaciones y qué lecturas;
- el formato y el análisis de la cabecera, como **casos-dato**;
- los errores;
- la nota del handler;
- las filas del gate;
- los casos `CW-*`.

Los cuatro generadores ejecutan los mismos casos con el mismo id.

| Caso | Qué afirma | Nivel |
|---|---|---|
| CW-1 | cargar con la versión vigente devuelve el agregado | adaptador, las dos ramas |
| CW-2 | cargar con otra versión lanza la excepción de precondición y **no toca** la fila | adaptador |
| CW-3 | cargar con la esperada nula no compara | adaptador |
| CW-4 | `save` devuelve la versión **nueva**, la misma que ve una lectura posterior | adaptador |
| CW-5 | con la esperada correcta y otra escritura entre la carga y el commit, sale `409 CONCURRENT_MODIFICATION` y **no** `412`: las dos garantías siguen separadas | adaptador |
| CW-6 | una escritura sin `If-Match` con `required` da `428` con la forma de error del cable y no llega al mediator | API emitida |
| CW-7 | los casos de cabecera de D2 (`*`, lista, débil, ilegible) | API emitida |
| CW-8 | la excepción de precondición da `412` con el `code` y el `message` de `api-errors.js` | API emitida |
| CW-9 | `ETag` va en las cabeceras expuestas de CORS | API emitida |
| CW-10 | el `ETag` de la lectura tiene el formato de D1 | API emitida, caso del cable |
| CW-11 | un acierto de caché devuelve el **mismo** `ETag` que la lectura que lo llenó | `cache-check` |
| CW-12 | el gate sale **rojo** sobre el proyecto recién generado y verde con la llamada escrita | gate |

### Sabotajes

Llevan el mismo id en los cuatro generadores. **Verde significa que el sabotaje cae en exactamente sus casos.**

| Sabotaje | Qué rompe | Debe caer |
|---|---|---|
| `cw-ignore-expected` | el adaptador no compara | CW-2 |
| `cw-stale-version` | `save` devuelve la versión cargada | CW-4 |
| `cw-collapse-409` | el conflicto de la ventana sale como 412 | CW-5 |
| `cw-no-428` | el borde no exige la cabecera | CW-6 |
| `cw-weak-match` | la comparación acepta `W/` | CW-7 |
| `cw-error-map` | la precondición sale como 409 | CW-8 |
| `cw-cors` | `ETag` no se expone | CW-9 |
| `cw-cache-etag` | la caché guarda solo el cuerpo | CW-11 |
| `cw-gate` | el gate no mira el handler | CW-12 |

## Trampas que hay que medir antes de suponerlas

- **T1 · la versión después del commit.** Con JPA, `@Version` sube en el flush, después del handler. Si el `ETag` de la
  respuesta sale de lo que el handler tenía en memoria, va un número por detrás, y la segunda edición encadenada da 412
  sin que haya ningún conflicto. CW-4 existe para eso. Hay que medirlo en los cuatro, no solo en keel-spring:
  EF Core, TypeORM y el SQL propio de keel-go incrementan en momentos distintos.
- **T2 · la caché.** `CachedOperations` (keel-spring) y sus hermanos guardan **el JSON de la respuesta**. Sin la versión
  en la entrada, un acierto de caché sale sin `ETag` o con uno viejo. `catalog-extended` es el sujeto de `cache-check`
  en tres generadores, así que se mide sin fixture nueva.
- **T3 · la repetición por `Idempotency-Key`.** La respuesta repetida tiene que llevar el mismo `ETag`. Si ningún sujeto
  combina `keySource: client-key` con una escritura condicional, la combinación se **rechaza en una frontera neutral**
  con su motivo, como `messaging-frontier.js`, hasta que un diseño la pida.
- **T4 · el alcance y la propiedad.** `loadExpecting` tiene que respetar `scoping` y `ownership`: quien no ve la fila
  recibe 404/403 **antes** del 412 (D3). Si no, el 412 confirma que existe algo que el llamante no puede ver.
- **T5 · `declared`.** Con `lockVersion` declarado en el dominio (`int`), el tipo y el nombre no son los de `all`
  (`Long`, de infraestructura). El modelo neutral tiene que dar una sola lectura de «la versión de esta raíz».
- **T6 · un proxy que debilita el ETag.** Un nginx con gzip convierte un ETag fuerte en `W/`. Con D2, eso sería un 412
  permanente. `deploy/` no tiene proxy hoy: va en la documentación, y en `deploy-check` si algún día lo tiene.

## Sujetos

- **Relacional:** `catalog-extended` declara `concurrency` sobre `updateProduct` (PATCH). Ya es sujeto de `db-check`,
  de `cache-check` y de los finders. Sus escenarios ganan los `FL-*` del 412, del 428 y de la edición encadenada.
- **Documental:** un diseño derivado de `catalog-extended` con `persistence.default.model: document`, en
  `keel-core/test/helpers/conditional-write-designs.js`, el mismo patrón que `finder-designs.js`. Es uno solo para los
  cuatro generadores.
- **No se toca el par del MVP** (`notification-mailer`/`-mongo`): obligaría a recarear y a revalidar el 10/10 sin que
  aporte una rama nueva.

## Incrementos

### 0. keel-core: el DSL y su puerta

- `api.schema.json` (`concurrency`). Versión 2.25: enum, plantilla, fixtures, base del corpus, y en los cuatro
  generadores `SUPPORTED_DSL` con su `package.json` y su README.
- `crossrefs.js`, cada regla con su id, su entrada en `checks.js` y su mutación en la extensión `concurrency` del corpus:
  - `CHK-API-CONCURRENCY-OP-UNKNOWN` (error): la operación no existe o no tiene endpoint.
  - `CHK-API-CONCURRENCY-UNVERSIONED` (error): escribe sobre una raíz sin versión (`none`, o `declared` sin
    `lockVersion`).
  - `CHK-API-CONCURRENCY-CREATE` (error): no recibe el id de la raíz, así que no hay versión previa que comparar.
  - `CHK-API-CONCURRENCY-NO-READER` (error): ninguna lectura derivada da el `ETag`, así que el cliente no tiene de
    dónde sacarlo.
  - `CHK-SCEN-PRECONDITION-UNCOVERED` (aviso, como todo `CHK-SCEN-*`): una operación listada sin escenario del 412.
- `OBL-API-CONCURRENCY-UNDECIDED`: un `PUT`/`PATCH` sobre una raíz con versión en un diseño sin `concurrency`. Se
  acepta en `decisions.yaml` por operación, por ejemplo «el cliente es una máquina que no edita formularios».
  `STRUCTURAL_DEFAULTS` la clasifica en `COVERED_ELSEWHERE`.
- `framework-errors.js` y `.md` (los dos códigos), `api-errors.js` (su frase), `wire.js` y `wire-contract.md` (D1 y D2
  como casos).
- Clase 4 de `gap-analysis.md` (concurrencia entre peticiones) y sus unidades en `gap-classes.js`.
- Docs: `dsl/api.md`, el historial de `dsl-reference.md` y `validation-scenarios.md` (cómo se escribe el escenario del
  412).
- Núcleo neutral `gen/conditional-writes.js` con su test: operaciones, lecturas derivadas, casos `CW-*`, nota del
  handler y filas del gate. `api-cases.js` gana los casos CW-6 a CW-10.
- **Medido con:** la suite de keel-core y `npm run design-matrix`, con cada id nuevo `falsado` y ninguno
  `co-disparado`.

### 1. keel-dotnet (primer generador: fija el contrato neutral con el bucle de medida más corto)

- Borde (`endpoints`), mensaje con su campo, `Versioned<T>`, `LoadExpecting` en EF Core y en MongoDB.Driver,
  middleware de errores, CORS, caché y gate.
- **Redes:**
  - `db-check` en PostgreSQL y MySQL: CW-1 a CW-5.
  - `doc-check`: CW-1 a CW-5 en la rama documental.
  - `cs-check --fixtures`: CW-6 a CW-10 en la prueba emitida.
  - `cache-check`: CW-11.
  - `harness-check`: CW-12.
- **Falseo:** los nueve sabotajes, cada uno en sus casos.
- Fila `conditional-write` en `MECHANISM_CATALOG` y la suya en `engine-support.js`, sin celdas `razonado`.

### 2. keel-nest

- Lo mismo sobre TypeORM y el documental.
- **Redes:** `db-check` en PostgreSQL y MySQL, `doc-check`, `ts-check` (API emitida), `cache-check` y `harness-check`.
- **Falseo:** los mismos nueve.
- `keel-nest/test/conditional-writes-parity.test.js` compara su nota, su gate y sus rutas con keel-dotnet.

### 3. keel-go

- Lo mismo en SQL propio y en el documental. `loadExpecting` lleva el `SELECT … WHERE version` y no la comparación en
  memoria; si se hace en memoria, CW-5 lo distingue.
- **Redes:** `db-check` en PostgreSQL y MySQL, `doc-check`, `go-check` (API emitida, `go vet` y `staticcheck` vacíos),
  `cache-check` y `harness-check`.
- **Falseo:** los mismos nueve.
- La idiomática de § 3 de `PLAN-KEEL-GO.md`: el error de precondición es un valor centinela comparable con
  `errors.Is`.

### 4. keel-spring

- Controller (`If-Match`, el campo con `@JsonIgnore` que estampa en todas sus ramas), `Versioned<T>`, el handler de
  `ApiExceptionHandler`, `loadExpecting` en JPA y en Spring Data MongoDB, CORS, `CachedOperations` y la familia del gate
  en `idempotency-check.js` o en un gate propio.
- **Red nueva: `npm run precondition-check`**, calcada de `finder-check`. Ejecuta CW-1 a CW-5 en PostgreSQL, MySQL y
  MongoDB, y CW-11 contra un Redis real, porque keel-spring no tiene `cache-check`.
- CW-6 a CW-10:
  - van en `compile-check` si ejecuta las pruebas emitidas;
  - si solo compila, van en `precondition-check` con un `@WebMvcTest` del controller.
  - Se decide al abrir el incremento, mirando qué hace `compile-check`, sin suponerlo.
- **Falseo:** los mismos nueve.
- Los `*-parity.test.js` de keel-nest, keel-dotnet y keel-go pasan a comparar también contra lo que emite keel-spring.

### 5. Derivados y documentación

- `gen/openapi.js`:
  - documenta `ETag` en las lecturas, `If-Match` (requerido u opcional) en las escrituras y los 412/428;
  - tiene que pasar sus tres oráculos, ser byte a byte igual en los cuatro y no dar deriva en
    `CHK-DOCS-OPENAPI-DRIFT`;
  - después, `redocly lint`.
- Skill `/keel-docs`: la colección de Postman captura el `ETag` en una variable y lo manda en `If-Match`
  (`CHK-DOCS-POSTMAN-DRIFT`).
- Las convenciones del agente en los cuatro generadores: cargar con `loadExpecting` y devolver `Versioned<T>`.
- La skill `/keel-design`: cuándo preguntar por la política.
- `keel-recover`: solo la guía de la skill, para que un legacy que ya responde `ETag` se diseñe con `concurrency` y no
  con prosa. La paridad de cabeceras queda fuera hasta que un legacy del banco lo pida.
- `capability-coverage` de los cuatro, y una fila nueva en `CLAUDE.md` § Dónde se añade cada cosa.

### 6. Corrida de control

- `catalog-extended` en los cuatro generadores, con los handlers escritos por el agente. Es lo único que mide lo que
  escribe el agente: que llame a `loadExpecting` y que devuelva la versión correcta.
- Se registra en `docs/corridas/` con la huella de cada generador y sus `designGaps`.

## Puerta de cierre

- Suite verde en los cinco paquetes.
- `design-matrix` sin ids `sin-mutacion`.
- La fila `conditional-write` de las cuatro matrices, en las dos ramas, `verificado` y `falsified: true`.
- Los nueve sabotajes medidos en cada generador, cada uno cayendo solo en sus casos.
- La corrida de control en verde en los cuatro, con los `FL-*` del 412, del 428 y de la edición encadenada.

Un generador que no llegue a la puerta rechaza la capacidad en su frontera (`supported-features.js`) con su motivo,
nunca la emite a medias.

## Estado (2026-11-07)

| Incremento | Estado | Medido con |
|---|---|---|
| 0. keel-core | hecho | suite de keel-core; `design-matrix`: los seis ids nuevos `falsado`, ninguno `co-disparado` |
| 1. keel-dotnet | hecho | `db-check` (PostgreSQL y MySQL) y `doc-check` CW-1 a CW-5; pruebas emitidas CW-6 a CW-11 en las variantes; CW-12 ejecutado en Node; los nueve sabotajes |
| 2. keel-nest | hecho | `db-check` (PostgreSQL y MySQL) y `doc-check` CW-1 a CW-5; `ts-check --only` CW-6 a CW-10 en las siluetas; CW-11 y CW-12 ejecutados en Node; los nueve sabotajes |
| 3. keel-go | hecho | `db-check` (PostgreSQL y MySQL, `catalog-conditional` y `shop-conditional`) y `doc-check` CW-1 a CW-5; `go-check --fixtures` 107/107 con las siluetas en todas sus variantes; CW-6 a CW-11 en las pruebas emitidas; CW-12 ejecutado en Node; los nueve sabotajes |
| 4. keel-spring | hecho | `precondition-check` (nuevo): CW-1 a CW-5 en PostgreSQL, MySQL y MongoDB y CW-6 a CW-11 en el borde, sobre los tres diseños (23/23 cada uno); CW-12 en Node; los nueve sabotajes |
| 5. derivados y docs | hecho | `gen/openapi.js` (If-Match, ETag, 412/428) igual byte a byte en los cuatro y sin deriva (`keel-nest/test/openapi.test.js`), `redocly lint` sin errores; `CHK-DOCS-POSTMAN-DRIFT` ve la escritura `required` sin If-Match (`test/derived-coherence.test.js`); agentes de código y de calidad de los cuatro; `/keel-recover` |
| 6. corrida de control | pendiente | — |

## Lo que se decidió al construir (incrementos 0 y 1)

Decisiones que el plan no fijaba, o que cambian lo que decía. Los incrementos 2 a 4 las heredan.

- **La versión esperada es una LISTA** (`expectedVersions`, `IReadOnlyList<long>?` en C#). D5 hablaba de «la versión
  esperada», en singular, pero D2 admite `If-Match: "5", "7"`. `null` no compara (sin cabecera, vacía, `*` u otra
  puerta) y `[]` no casa con nada: una cabecera débil o ilegible da 412. Lo que estampa el borde de cada caso está en
  `WIRE_IF_MATCH_CASES` (`keel-core/src/lib/gen/wire.js`).
- **Una cabecera vacía cuenta como ausente**: 428 con `required`, sin comparación con `optional`.
- **`OBL-API-CONCURRENCY-UNDECIDED` solo salta sin `concurrency`**. Declarar el bloque, con cualquier política, es
  pronunciarse para todo el servicio; la obligación pregunta por PUT y PATCH y no por los POST de transición, que se
  pueden listar igual. Su scope es `api.concurrency.<op>`.
- **`COVERED_ELSEWHERE` admite una obligación** como cubridora (antes, solo un `CHK` `undecided`): `§3.12` del catálogo
  estructural la cubre `OBL-API-CONCURRENCY-UNDECIDED`.
- **Los casos de la prueba emitida que no llevan If-Match no eligen una escritura condicional `required`**
  (`apiCases` en `api-cases.js`): con D3, el uuid mal formado de su ruta da 428 y no 400. Lo destapó la prueba emitida.
- **CORS sale de un sitio neutral**: `corsExposedHeaders` (añade `ETag`) y `corsAllowedHeaders` (añade `If-Match` si no
  es `*`), en `conditional-writes.js`.
- **El gate es neutral** (`conditionalWritesGateScript`): bash puro, que ignora las líneas de comentario —la nota del
  handler nombra `loadExpecting`—, y sale con 2 si no encuentra un handler.
- **Sujetos**: hasta que los cuatro generadores generen la capacidad, ninguna fixture declara `concurrency` (los otros
  tres la rechazarían). Son los diseños de `keel-core/test/helpers/conditional-write-designs.js`: `catalog-conditional`
  (relacional), `catalog-conditional-mongo` (documental) y `shop-conditional` (seguridad, CORS e id de texto; su
  `pattern` deja a CW-6 sin URL de muestra, así que ahí se miden CW-7 a CW-10).
- **CW-12 se mide ejecutando el gate en una prueba de Node** (`keel-dotnet/test/conditional-writes.test.js`), como
  `check-idempotency.sh`, y no en `harness-check`, que no lleva gates.
- **CW-11 se mide en la prueba emitida `OperationCacheTests`** (store en memoria): lo que cambia es el TIPO que guarda la
  caché (`Versioned<T>`), y el codec y el adaptador son los que ya mide `cache-check` contra Redis.
- **Fronteras**: los generadores que todavía no la generan la rechazan con `conditionalWritesPendingErrors` (el mismo
  mensaje en los cuatro); la combinación con `keySource: client-key` (T3) la rechaza `conditionalWritesFrontierErrors`.
  La fila `conditional-write` de la matriz es `pending` en keel-nest, keel-go y keel-spring (keel-spring y las pruebas de
  paridad de los tres aprendieron a saltar una fila `pending`).
- **`OBL-API-CONCURRENCY-UNDECIDED` salta en dos fixtures** (`catalog-extended` y `shop-api`, las dos sobre su
  `updateProduct`) y se cerró aceptándola en su `decisions.yaml`, con su motivo: la primera, hasta que los cuatro
  generadores la generen; la segunda, porque es un legacy que no responde ETag y la paridad compara contra él. El par
  del MVP no la abre (sigue 10/10).
- **§3.12 es unidad de la clase 16** (`gap-classes.js`) cuando el diseño declara `concurrency` o abre la obligación, y
  entra en `STRUCTURAL_SECTIONS` (`structural-register.js`).
- **Hallazgo sin resolver**: en `shop-api`, `cancelOrder` (`PATCH /order/cancel/{orderId}`) escribe `OrderMain`, y la
  regla de `idParamNames` solo reconoce `{id}` y `{orderMainId}`. Es la misma regla que ya usa `Location`; ampliarla es
  otra decisión.

## Lo que se decidió en keel-nest (incremento 2)

- **If-Match lo lee el controlador**, con `@Headers('if-match')`, antes de llamar al lector puro `(params, query, body)`,
  y se lo pasa como cuarto argumento: así el 428 sale antes que todo 400 del lector (D3). Un cuerpo que no es JSON lo
  rechaza Fastify antes de la ruta, como Spring: ese 400 sí va antes que el 428.
- **`Versioned<T>` es una interfaz** (`{ version, value }`, application/interfaces), y la entrada de la caché se escribe en
  ese orden, el mismo que el record de keel-dotnet. El codec de la caché rechaza una entrada sin versión (miss, no un
  ETag inventado).
- **`expectedVersions` es opcional en las props del mensaje** (`?? null`): quien lo construye desde otra puerta no tiene
  que nombrarla.
- **Redes nuevas**: `ts-check` gana `--only=<silueta>` y `--sabotage=cw-*` (los del borde); las sondas CW-1 a CW-5 viven en
  `scripts/lib/conditional-probes.js`, compartidas por `db-check` y `doc-check`; `sampleResponse` pasó de `cache.test.js`
  a `test/helpers/response-samples.js`.

## Lo que se decidió en keel-go (incremento 3)

- **La lista de versiones es un `[]int64`**: nil no compara (sin cabecera, vacía, `*` u otra puerta) y una lista vacía no
  casa con ninguna, la misma distinción que null frente a `[]` en los otros tres. El campo del mensaje es
  `ExpectedVersions []int64` con `json:"-"`.
- **La comparación es `domain.CheckVersion`**, genérica sobre la versión (`*int64` con `all`, `*int32` con `declared`, T5),
  y la llaman los dos adaptadores desde `LoadExpecting`, que carga con su `FindByID`. El plan pedía en Go el
  `SELECT … WHERE version`; no se hizo: con una lista de versiones obligaría a una segunda lectura para distinguir el 404
  del 412 (D3), y CW-5 no distingue las dos formas, porque la carrera que mide está entre la carga y el guardado, que es
  lo que arbitra el `UPDATE … WHERE lock_version` de `Save`. Es la misma comparación que hacen keel-dotnet y keel-nest.
- **`LoadExpecting` devuelve `(*Raíz, bool, error)`** como `FindByID`: `found == false` es el 404 del diseño, y la
  precondición es un error del dominio.
- **Los dos errores son centinelas del dominio** (`ErrPreconditionFailed`, `ErrPreconditionRequired`), comparables con
  `errors.Is` (§ 3.2 de `PLAN-KEEL-GO.md`), con status propio (412 y 428 no tienen categoría) y el texto de
  `api-errors.js` en la ocurrencia. Si el diseño declara un code de su familia, el centinela es el suyo.
- **`Versioned[T]` tiene su lector, que exige la versión**: una entrada de la caché que solo guarda el cuerpo es ilegible
  (un miss), y la versión 0 es legítima. La caché genérica no se toca; su prueba emitida aprende a construir la muestra de
  un `Versioned` campo a campo (`isVersioned`).
- **CW-11 se mide en la prueba emitida `versioned_test.go`** (el lector ejecutado con el codec del cable), como keel-dotnet
  la mide en `OperationCacheTests`: lo que cambia es el tipo que guarda la caché, y el store lo mide `cache-check`.
- **La silueta documental pide el precio en el momento**: la réplica sobre documentos es un rechazo escrito de keel-go, así
  que en `UNCOVERED_BRANCHES` `catalog-conditional-mongo` cambia `supplierPrice` a `on-demand`. No toca nada de la
  escritura condicional: las escrituras y la lectura derivadas son las mismas que en keel-nest
  (`test/conditional-writes.test.js` lo compara).
- **Redes**: CW-1 a CW-5 en `scripts/lib/conditional-probes.js` (una función de prueba por caso, dentro de `rootProbes`,
  así que las comparten `db-check` y `doc-check`); los sabotajes del adaptador van en `db-sabotages.js` y `doc-sabotages.js`
  y se corren con `--only=<silueta>` (`cw-collapse-409` nombra el centinela de la precondición, que solo existe ahí); los
  del borde, en `test/helpers/conditional-sabotages.js`, los ejecuta `go-check` sobre su silueta.

## Lo que se decidió en keel-spring (incremento 4)

- **El 428 lo da un interceptor** (`IfMatchInterceptor`, con `@RequiresIfMatch` en el método): el `preHandle` corre antes
  de resolver los argumentos, así que va antes que todo 400 de la ruta o del cuerpo, también del JSON mal formado (D3).
  Solo se emite con `required`.
- **El ETag se escribe en la `HttpServletResponse`**, no con `ResponseEntity.eTag(...)`: en un GET,
  `HttpEntityMethodProcessor` evaluaría `If-None-Match` y podría responder 304, que está fuera de 2.25 (D7).
- **Cada escritura aceptada sube la versión**, también la que no cambia nada. Medido: Hibernate no vuelca una entidad sin
  cambios, así que su `@Version` se quedaba quieta mientras los otros tres la suben siempre. El adaptador JPA de las raíces
  con escritura condicional hace `saveAndFlush` (T1) y, si el flush no la subió, `forceNewVersion` la sube con
  `PESSIMISTIC_FORCE_INCREMENT`, que compara la versión cargada (otra escritura en medio sigue siendo el 409).
- **Hibernate ignora el `lockVersion` que trae el dominio** sobre una entidad gestionada de otra transacción (medido: el
  guardado con la versión rancia pisó el cambio de otro). En un handler no importa —cargar y guardar ocurren en la
  transacción del mediator, con la misma entidad gestionada—, y por eso CW-5 se mide así: carga y guardado en una
  transacción, la otra escritura en `REQUIRES_NEW`. En Mongo, `save` ya compara la versión del documento.
- **`Versioned<T>` lleva `@JsonProperty(required = true)` en la versión**: una entrada de la caché sin ella no se lee (miss).
- **CW-6 a CW-11 los ejecuta `precondition-check`** (keel-spring no emite pruebas de la API y `compile-check` solo compila):
  CW-6 con MockMvc sobre el controller, el interceptor y el `ApiExceptionHandler` generados y el mediator doblado; CW-11 con
  `RedisOperationCache` sobre un `CacheManager` en memoria, como keel-dotnet y keel-go.
- **Los diseños de catalog-extended piden el precio en el momento en `precondition-check`**: con la réplica el `main` no
  compila recién generado (`main-compilable.js`). No toca la escritura condicional.

## Para retomar

- Incremento 1 (keel-dotnet) hecho y medido: `db-check --only=catalog-conditional` en PostgreSQL y MySQL, `doc-check
  --only=catalog-conditional-mongo`, las variantes compiladas y probadas con su SDK, y los nueve sabotajes cayendo cada
  uno en su caso CW (`cw-collapse-409` cae además en la sonda previa de la versión obsoleta, que mide el mismo 409).
- No se ha corrido `cs-check --fixtures` entero (todas las fixtures y variantes, muy lento): los sabotajes del borde se
  midieron sobre las variantes con el mismo reemplazo que registra `FIXTURE_SABOTAGES`. Conviene correrlo una vez.
- Las convenciones y la skill del agente (cargar con `LoadExpecting`, devolver `Versioned<T>`, ejecutar
  `infra/check-conditional-writes.sh`) son del incremento 5; hasta entonces, el agente lo sabe solo por la nota del
  handler y por el gate.
- Incremento 2 (keel-nest) hecho y medido igual que el 1; su fila de la matriz ya no es `pending`.
- Incremento 3 (keel-go) hecho y medido: `db-check --only=catalog-conditional` y `--only=shop-conditional` en PostgreSQL y
  MySQL, `doc-check --only=catalog-conditional-mongo`, `go-check --fixtures` (107/107) y el bloque de la escritura
  condicional de `go-check` (las pruebas emitidas del borde y de la caché, con vet y staticcheck, y sus cinco sabotajes).
  Los tres del adaptador caen cada uno en su caso en los tres motores (`cw-ignore-expected` en CW-2 y CW-3, que mide la
  lista vacía). No se ha corrido `go-check` entero (la carrera, la frontera falsada, govulncheck…): lo que cambió para el
  resto de las fixtures es nada (74 sin cambios en la caché), y el bloque nuevo se ejecutó aparte con el mismo código.
- La matriz de keel-go ya no tiene filas `pending`.
- Incremento 4 (keel-spring) hecho y medido: `npm run precondition-check` (los cuatro diseños-motor, 23/23), los nueve
  sabotajes cayendo cada uno en su caso (los tres del adaptador en los tres motores), `compile-check` de los tres diseños y
  `test/conditional-writes.test.js`. La fila `conditional-write` de las cuatro matrices ya no es `pending`.
- Incremento 5 hecho: el OpenAPI derivado documenta `If-Match` (requerido con `required`), el `ETag` de lo que devuelve la
  versión y los 412/428, el mismo en los cuatro; la guía de Postman de `/keel-docs` captura el `ETag` y lo manda en
  `If-Match`, y `CHK-DOCS-POSTMAN-DRIFT` avisa de la escritura `required` sin la cabecera (salvo la que afirma el 428); los
  agentes de código de los cuatro nombran `loadExpecting`/`Versioned` y los de calidad ejecutan
  `infra/check-conditional-writes.sh` (familia `conditionalWrites`), con la frase neutral `conditionalWritesAgentNote` en el
  contexto del proyecto; `/keel-recover` distingue un ETag de caché de una escritura condicional. `/keel-design` ya lo
  cubría desde el incremento 0 (§3.12). La fila de `CLAUDE.md` existía desde el 0; ahora cita `precondition-check`.
- Siguiente: incremento 6 (corrida de control). Ninguna fixture declara todavía `concurrency`: catalog-extended la
  declara con la corrida de control (incremento 6), y entonces se borran las filas de capability-coverage que lo dicen y la
  decisión aceptada de `OBL-API-CONCURRENCY-UNDECIDED` en su `decisions.yaml`.
