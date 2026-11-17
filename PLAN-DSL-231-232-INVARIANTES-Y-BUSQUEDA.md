# DSL 2.31 (R7: invariantes y derivados) y DSL 2.32 (R8: búsqueda)

**Estado: aprobado el 2026-11-16, en curso (fase A cerrada; fase B pendiente).** Origen: R7 y R8 de `docs/evaluacion-dsl-2.24.md` (§ 9, puestos 1.º y 2.º).

## Estado

| Inc. | Qué | Estado |
|---|---|---|
| A0 | Medir antes de nada | hecho (2026-11-16, § Medidas de A0) |
| A1 | keel-core: schema, reglas, `INVARIANT_VIOLATED`, docs, enum a 2.31 y la frontera de los cuatro | hecho (2026-11-16) |
| A2 | Lo neutral: `entity-checks.js` (plan, referencia, contrato, casos `IC-*`), `computed.js` (D5, casos `CP-*`), el modelo y el OpenAPI | hecho (2026-11-16) |
| A3 | keel-spring: `ensureInvariants()`, su llamada en el save, el derivado como getter, `InvariantViolatedException` y `invariant-check` | hecho (2026-11-16, § Medidas de A3) |
| A4 | keel-nest: la misma guarda sobre el `Decimal` del proyecto, su llamada en el save de los dos adaptadores y las sondas de db-check/doc-check | hecho (2026-11-16, § Medidas de A4) |
| A5 | keel-dotnet: `EnsureInvariants()` y el derivado como propiedad sobre el `decimal` de .NET, su llamada en el Save de los dos adaptadores y las sondas de db-check/doc-check | hecho (2026-11-16, § Medidas de A5) |
| A6 | keel-go: `EnsureInvariants() error` y el derivado como accesor que calcula sobre el `wire.Decimal` del proyecto, su llamada al principio del Save de los dos adaptadores y las sondas de db-check/doc-check | hecho (2026-11-16, § Medidas de A6) |
| A7 | Contrato y método: las filas `entity-checks` y `computed` de las cuatro matrices, el contrato en los cuatro, `wire-contract.md`, `/keel-design`, `/keel-recover` y los agentes | hecho (2026-11-16, § Medidas de A7) |
| A8 | Fixtures: las invariantes en prosa que caben pasan a `checks`, `shop-api` según U5 y U6, y un `count` real | hecho (2026-11-16, § Medidas de A8) |
| A9 | Corridas de control de `shop-api`: los cuatro generadores en PostgreSQL y keel-nest en MySQL | hecho (2026-11-16, § Medidas de A9) |
| B0 | Medir lo de la fase B | hecho (2026-11-17, § Medidas de B0; U7 y U8 decididas) |
| B1 | keel-core: schema, reglas con sus mutaciones, docs, DSL a 2.32 y la frontera de los cuatro | hecho (2026-11-17, § Medidas de B1) |
| B2 | Lo neutral: los criterios del finder con su referencia (`FS-*`), `readClientSort` (`SO-*`), la lista en la query, el contrato, la clave de la caché y la collation del orden | hecho (2026-11-17, § Medidas de B2) |
| B3-B9 | Fase B: DSL 2.32 (R8) | pendiente |

**Para retomar.** La fase A (DSL 2.31) está cerrada (A9: cinco corridas de `shop-api` en 92/92). Pendiente de ella:
`go-check --fixtures` de keel-go (§ Arreglo de la escala), que se pasa en B6. Fase B: B0 medido (U7 y U8 decididas) y B1
hecho: el DSL es 2.32 y los cuatro generadores rechazan `in`/`ne`/`search`/`sortable` con `searchPendingErrors` hasta su
incremento. B2 hecho (lo neutral, § Medidas de B2). Siguiente: B3, keel-spring. Lo que cada generador recoge en su
incremento, todo de keel-core:
- el finder: `criterion.op` `in`/`ne`/`search`, y `search` con `targets[]` en vez de `target`;
- el lector de `?sort=` contra `operation.sortable` (`readClientSort`, `invalidSortMessage`);
- el de la lista en la query (`readQueryList`);
- la collation de `orderedTextColumns` + `binaryCollationFor` en la baseline, con su aviso en `EVOLUTION.md`;
- `keyExtras` de la caché;
- los sujetos `SEARCH_DESIGNS` (`catalog-search`, `-mongo`) en sus redes, con los casos `FS-*`/`SO-*` y los sabotajes
  `FINDER_SABOTAGES`/`SO_SABOTAGES`.

Ventana conocida, como la de A2: desde B2 el contrato ya no anuncia `sort` en un listado sin `sortable`, y los
servidores lo siguen aceptando hasta su incremento.

## Medidas de B2 (2026-11-17)

Lo neutral, sin red en vivo: `keel-core/test/search.test.js` sobre el sujeto `catalog-search`, más las suites de los
seis paquetes.

- **Finder** (`query-filters.js`). `in` y `ne` son criterios con su `target`. `search` lleva `targets[]`: cada campo de
  `over` con su sombra si el `compare` pliega. `deriveFilterFolds` la deriva también para la búsqueda, solo para filtrar.
  Un subcampo de value object no tiene sombra: la búsqueda plegada sobre él deja la query sin finder, y la nota lo dice.
  Un input con `search` no se enlaza por nombre.
- **Referencia del finder.** `matchesFinder` (con `foldText`, el plegado de `TextFold`) y los nueve casos `FS-*` sobre
  cuatro filas. Tres sabotajes caen en exactamente sus casos: `finder-in`, `finder-ne-null` y `finder-search-literal`.
- **Orden del cliente** (`pagination.js`). `sortable` se resuelve en el modelo con la misma columna que el orden por
  defecto: un `sortTarget` compartido, con sombra plegada, rango del enum y ruta documental. `readClientSort` es la
  referencia de D16, y lo que decide B2:
  - la dirección es estricta (`asc` o `desc`, en minúsculas);
  - más de una coma es 400, y el mismo campo dos veces también;
  - un `?sort=` vacío es 400;
  - el orden del cliente sustituye al del diseño, no se le suma.
- **Casos del orden.** Once `SO-*` y cuatro sabotajes exactos: `so-open`, `so-case`, `so-duplicate` y `so-append`.
- **El 400.** Texto nuevo, `FRAMEWORK_RESPONSES.invalidSort` («No se puede ordenar por '…'»), con code
  `VALIDATION_ERROR`, sin code nuevo.
- **Cable.** Reglas `query-list` y `client-sort`. Los casos `WIRE_QUERY_LIST_CASES` y su referencia `readQueryList`: la
  coma parte (U8), y una lista vacía o con un elemento vacío es 400 (D10). `wire-contract.md` § La query de un listado.
- **Contrato.** El parámetro `sort` solo aparece con `sortable`, con `style: form, explode: true` y un enum de `campo`,
  `campo,asc` y `campo,desc`. Una lista en la query va con `explode: true`, y la de un `in` lleva `minItems: 1`.
- **Caché** (D18). `cacheKeyExtras` suma `page` y `size` a la clave de todo listado paginado, y `sort` si ofrece
  `sortable`. Destapó un hueco previo: la clave de un listado paginado cacheado ya ignoraba la página. Ninguna fixture lo
  declara.
- **Collation** (U7). `binaryCollation` del catálogo: `"C"` en PostgreSQL, `utf8mb4_bin` en MySQL y MariaDB, `_BIN2`
  (razonado) en SQL Server, ninguna en MongoDB. `orderedTextColumns` dice qué columnas de texto (o sombras) se ordenan.
  Va **aparte** de `collation` del campo para no cambiar el esquema de los cuatro a la vez: cada generador la lleva a su
  baseline en su incremento.
- **Sujetos.** `SEARCH_DESIGNS` (`catalog-search`, `-mongo`, sobre `product-catalog`) va aparte de `FINDER_DESIGNS`,
  porque las redes de los cuatro recorren `FINDER_DESIGNS` y su frontera rechaza la 2.32 hasta su incremento.

## Medidas de B1 (2026-11-17)

- Schema: `filter.op` gana `in` y `ne`; `search` (`over`, `match` con default `contains`, `compare`) excluye `filter`,
  `match` y `compare` en el mismo input; `output.sortable` exige `paginated: true`; `pagination.style` solo `offset`.
- Reglas: `CHK-USECASES-FILTER-IN-NOT-LIST`, `CHK-USECASES-SEARCH-FIELD`, `CHK-USECASES-SORTABLE-FIELD`,
  `CHK-USECASES-SORT-NOT-SORTABLE` (aviso `undecided`, aceptable) y `OBL-QUERY-SORT-UNDECIDED` (clase 5, aceptable);
  `CHK-USECASES-FILTER-TYPE` amplía a `ne` (sin `match` ni `compare`: la desigualdad exacta, decisión de B1), `in` con un
  `match` que no es `exact` y una lista con otro operador. Siete mutaciones sobre la extensión `search` del corpus;
  `design-matrix` sin `sin-mutacion` y con los mismos cinco co-disparados que antes.
- `OBL-QUERY-SORT-UNDECIDED` es una obligación y bloquea `ok`: abre diez listados en seis fixtures (`asset-vault`,
  `catalog-extended` ×2, `conduit` ×2, `inspection-reports`, `product-catalog`, `shop-api` ×3), aceptados en su
  `decisions.yaml` como provisionales hasta B8, que los revisa (`product-catalog` declarará `sortable`). Ninguna fixture
  cambia su `--ready`.
- keel-spring pierde el aviso de `cursor` y su test. Las suites de los seis paquetes, en verde.

## Medidas de B0 (2026-11-17)

Medido leyendo los lectores y adaptadores de los cuatro (lo que dice «leído» se ejecuta en B3-B6 con su sabotaje) y, para
D17, ordenando los mismos 16 textos en contenedores con las imágenes del catálogo (`postgres:16-alpine`, `mysql:8.0`,
`mongo:7`).

| | Medida | Qué cambia en el plan |
|---|---|---|
| M9 | **`?sort=` sobre una propiedad desconocida.** keel-nest (`withStableOrder`), keel-dotnet (`Ordered`, `InvalidOperationException`) y keel-go (`orderBy`, `fmt.Errorf`) la rechazan en el adaptador con un error sin `code`, que el catch-all de la API responde **500**. Lo mismo en las dos ramas documentales (`sortablePaths`). keel-spring relacional: `PropertyReferenceException` de Spring Data, que `ApiExceptionHandler` no traduce: **500** (leído). keel-spring documental: Spring Data MongoDB no valida la ruta y ordena por un campo que no existe: **200** con el orden del id (leído) | U3 corrige un 500 en los cuatro y un 200 silencioso en keel-spring documental. La comprobación va en el BORDE (el lector de `?sort=`), no en el adaptador: el mapa de cada adaptador sigue siendo la lista blanca de columnas, pero ya nunca ve una propiedad que el borde no admitió |
| M10 | **`?sort=` sobre un campo `sensitive` o `personal`.** Las listas blancas de los cuatro son TODOS los miembros persistidos (`sortableProperties`/`sortable`/`sortablePaths`), las sombras plegadas (`<campo>Folded`) y `ranked` incluidos. `product-catalog` pagina `Product`, que lleva `apiToken` (`sensitive`): hoy `?sort=apiToken` responde 200 en los cuatro y sirve de oráculo. También se puede ordenar por una sombra, que no es del contrato | Confirma D15. `sortable` del diseño sustituye a esas listas en el borde |
| M11 | **El orden por defecto sobre texto NO coincide (D17).** Con los mismos 16 textos: PostgreSQL 16-alpine y MongoDB 7 dan el orden por punto de código (`1 A B Z _x a b e f n o z Á á é ñ`). MySQL 8.0 con la collation por defecto de una columna NO única (`utf8mb4_0900_ai_ci`) da `_x 1 a A á Á b B é e f ñ n o z Z`, con `a`/`A`/`á` empatados (los ordena el id). Con `utf8mb4_bin` (la de las columnas únicas, `caseSensitiveCollation`) sale igual que los otros dos. Ojo: PostgreSQL declara `en_US.utf8`, pero la imagen alpine usa musl, que no implementa collation y compara bytes; un PostgreSQL con glibc (Debian, un gestionado) ordenaría lingüístico | D17 no se cumple hoy. Pide **U7**: cómo se fija el orden del texto ordenable en los tres motores |
| M12 | **Una lista en la query** se lee igual en los cuatro: el parámetro repetido, o uno solo partido por comas (`listOf` de keel-nest, `List<T>` de keel-dotnet, `listParam` de keel-go y la conversión `String → List` de Spring). Ninguna fixture lleva hoy una lista en la query de un GET (`getProductsByIds` de `catalog-extended` es un POST con cuerpo). Un `?statuses=` vacío no es 400 en ninguno: keel-nest lo lee como `[null]` | D14 dice «parámetro repetido», pero los cuatro aceptan también la coma, y entonces un `in` sobre texto no puede pedir un valor con coma como único elemento. Pide **U8**. D10 (lista vacía → 400) es nuevo en los cuatro |

### Decisiones del usuario tras B0 (2026-11-17)

Las dos propuestas, aceptadas tal cual.

| | Pregunta | Decisión |
|---|---|---|
| U7 | Cómo se cumple D17 | Toda columna de texto **ordenable** (en `sortable` o en el `sort` de una query) lleva la collation binaria de su motor, como ya la llevan las únicas: `utf8mb4_bin` en MySQL y `"C"` en PostgreSQL (que deja de depender de la imagen). Es un cambio de esquema: va en la baseline y, para una base desplegada, en `EVOLUTION.md` (no un paso de `schema-steps.js`, que solo crea tablas del generador). MongoDB ya compara por punto de código |
| U8 | La coma en una lista de la query | Se conserva la coma (es lo que hace Spring y lo que ya hacen los cuatro), y `wire-contract.md` § Entrada lo dice: un valor con coma solo viaja repitiendo el parámetro. El OpenAPI declara `style: form, explode: true`, que es compatible |

## Arreglo de la escala (2026-11-17, tras A9)

- La regla es neutral: `adjustsInputScale` de `keel-core/gen/constraints.js`. El mensaje pone a su escala un decimal de
  entrada con `scalePolicy: round` (lo redondea, como antes) y también con `reject` (lo rellena: el borde ya rechazó los
  decimales de más, así que la misma operación HALF_UP no cambia el valor). Sin política no se toca. Los cuatro la usan en
  el mismo sitio de siempre (`scaleRoundingLines` en keel-spring, `scaleRounded` en keel-nest, `scaleRounding` en
  keel-dotnet y keel-go, que la aplica también en el lector de la API). `docs/dsl/domain.md` lo dice.
- Medido: `keel-go/test/input-scale.test.js` (la regla y que los cuatro ajustan `productPrice` en `createProduct` y
  `updateProduct` de `shop-api`), las suites de los cinco paquetes, `db-check` de `shop-api` en keel-nest (PostgreSQL),
  keel-dotnet (PostgreSQL y MySQL) y keel-go, y `compile-check` de `shop-api` en keel-spring.
- **Pendiente: `npm run go-check --workspace packages/keel-go -- --fixtures`.** En keel-go el `db-check` solo compila el
  paquete del almacén, y el ajuste vive en `internal/application` (el mensaje) y `internal/httpapi` (el lector): lo
  compilan, formatean y analizan gofmt, vet y staticcheck en `go-check`. Se corta para no esperar ~20 min y se pasa en B6,
  que ya ejecuta `go-check`.
- Para llevarlo a un proyecto ya generado: `build --refresh` actualiza el mensaje (es de build); el `setScale` que el
  agente escribió a mano en la entidad sigue siendo correcto y deja de hacer falta.

## Medidas de A9 (2026-11-16)

| Corrida | Matriz | Primera pasada | Reescritos (2.27 → 2.31) | Clasificación | designGaps |
|---|---|---|---|---|---|
| keel-spring · PostgreSQL | 92/92 | 92/92 | 32 → 27 | 27 TODO | 0 |
| keel-nest · PostgreSQL | 92/92 | 82/92 | 30 → 30 | 25 TODO · 4 consulta | 0 |
| keel-dotnet · PostgreSQL | 92/92 | no consta | 28 → 26 | 25 TODO | 0 |
| keel-go · PostgreSQL | 92/92 | no consta | 28 → 25 | 24 TODO | 0 |
| keel-nest · MySQL | 92/92 | 84/92 | — (primera en MySQL) | 25 TODO · 4 consulta | 0 |

- `cart-line-sum-over-max`, que salió en las cuatro corridas de la 2.27, no sale en ninguna (`corrida-metrics.js
  series`). En las cinco, el agente escribió la suma de la línea sin comprobación y dejó la cota a la guarda.
- El `ensureInvariants()` de las cinco raíces es byte a byte el que emite `build` en las cinco, y ningún adaptador perdió
  su llamada.
- **Hueco del generador, fuera de la 2.31: la escala de un decimal de entrada con `scalePolicy: reject`.** Un
  `productPrice` de `30` tiene que salir `30.00`. keel-spring y keel-go pasan porque su `save` relee la fila; keel-nest y
  keel-dotnet devuelven la entidad en memoria con la escala que llegó, y su agente escala a mano en `ProductInfo` (en la
  2.27 ya pasaba). Arreglo propuesto: rellenar la escala al leer la entrada también con `reject`, en los cuatro.
- Hueco del arnés, fuera de la 2.31 (corrida de keel-spring): `tokenAs` no puede dar un email sin verificar
  (FL-ACC-016).

## Medidas de A8 (2026-11-16)

- `--ready` igual que antes en todas las fixtures tocadas: las listas (`product-catalog`, `payment-checkout`,
  `job-dispatch-cycles`) siguen listas y las demás no empeoran; `shop-api` mejora un criterio (el aviso
  `CHK-USECASES-INPUT-DEFAULT-OVERRIDABLE` de `createProduct` queda decidido por el input explícito).
- Dos checks llevan el `error` que la operación ya declaraba para esa misma regla: `price.amount > 0` en `active` es
  `PRODUCT_PRICE_NOT_POSITIVE` (`activateProduct`) y `refundedAmount ≤ amount` es `REFUND_EXCEEDS_CAPTURED`
  (`refundPayment`). Sin él, la guarda respondería otro code que el handler.
- La invariante del `payerId` del medio guardado de `payment-checkout` cruza agregados (D8) y sigue en prosa.
- La familia «campo con default en la entrada derivada» de `design-generation-delta` solo la disparaba `createProduct`
  de `shop-api`; ahora la dispara `inspection-reports` (`confidential`, con default y elegible por el cliente).
- Las muestras de las sondas en vivo rellenan cada campo y cada relación, y la guarda las rechazaba (`exactlyOne` de la
  línea de `shop-api`). La regla es neutral: `sampleBlanks` de `gen/entity-checks.js` (de un `exactlyOne` queda una, un
  `forbids` va a nulo; con `keep`, la FK que fija la sonda del finder inverso), probada contra todas las fixtures en
  cualquier estado y usada por keel-nest, keel-dotnet y keel-go.
- Destapó cinco defectos previos de las redes, ninguno de lo emitido (A4-A6 solo pasaron el sujeto de la guarda):
  - keel-nest y keel-dotnet parcheaban solo el handler del PRIMER lote, y `product-catalog` declara dos (la sonda de los
    trabajos no compilaba o no encontraba su gancho); keel-dotnet además construía `BatchSettings` sin `SyncStaleMs`.
  - keel-dotnet y keel-go esperaban que el MOTOR rechazara un texto por encima de su cota; desde A5/A6 lo rechaza antes la
    guarda (D25). Con la cota guardada, la sonda espera `INVARIANT_VIOLATED`; la longitud de la columna ya la mide la
    comparación con el catálogo.
  - keel-dotnet y keel-go muestreaban el elemento de una lista sin su formato heredado (el hueco que A4 cerró en
    keel-nest): `notification-mailer-mongo` no guardaba su muestra.
  - keel-go comparaba el predicado de un índice parcial por su literal, y el de la vida de la fila (`deleted_at IS NULL`)
    no tiene: `profile-directory` salía en rojo.
  - keel-go corría las sondas de lotes, que van por el `http.Handler` sin token, también sobre `product-catalog`, que tiene
    seguridad: ahora solo sobre sus sujetos (`catalog-batch*`).
  - keel-spring: la sonda DL-8 de `timer-check` construía la entidad con todo opcional a nulo y la llevaba a `verified`;
    con el `requires` de `verifiedAt`, sus argumentos rellenan lo que un `requires` exige. `claim-check` (`job-dispatch`,
    `-mongo`) y `finder-check` (`product-catalog-finder`) siguen en verde.
- Redes pasadas: `db-check` (PostgreSQL y MySQL) y `doc-check` enteros en keel-nest, keel-dotnet y keel-go; en
  keel-spring, las que usan fixtures tocadas. El `DR-1` de keel-nest sobre `notification-mailer` salió una vez en rojo
  con la máquina cargada y en verde al repetirlo solo (es de tiempos; A8 no toca esa fixture).

## Medidas de A7 (2026-11-16)

- Ninguna red nueva: las celdas declaran lo que midieron A3-A6. En keel-go, `test/engine-support.test.js` comprueba que
  cada sabotaje nombrado existe en `INVARIANT_SABOTAGE_SPECS`; `ic-after-write` falsa solo la rama relacional (en
  documental queda enmascarado entero en los cuatro).
- El contrato sale el mismo byte a byte en los cuatro para `catalog-invariants` y `-mongo`, sin deriva para
  `CHK-DOCS-OPENAPI-DRIFT`. El derivado viaja `readOnly` en los ocho `*ResponseDto` que lo llevan y en ningún cuerpo de
  entrada.

## Medidas de A6 (2026-11-16)

- `db-check --only=catalog-invariants`: 30/30 sondas en PostgreSQL y en MySQL. `doc-check --only=catalog-invariants-mongo`:
  30/30. El sujeto, emitido, pasa gofmt, vet, staticcheck y sus pruebas emitidas a la primera en los dos modelos.
- Los 12 sabotajes caen en exactamente sus casos en PostgreSQL y en MongoDB, y los tres que dependen del motor
  (`ic-no-call`, `ic-after-write`, `cp-no-overflow`) también en MySQL. Lo mismo que en los otros tres: `ic-after-write`
  no lo ve IC-10 (el Save es transaccional en los dos modelos: la guarda dentro de la transacción revierte la fila), y en
  documental tampoco CP-4 (Decimal128 admite la suma); ahí el sabotaje queda enmascarado entero, y db-check y doc-check lo
  dicen con su motivo en vez de pedir una sonda que no puede existir.
- `cp-stale` en Go es el UPDATE con `COALESCE(columna, $n)`: el SQL propio no tiene una línea del derivado que quitar, y
  conservar lo que la fila traía es exactamente el defecto. En documental, la entrada del derivado fuera del codificador.
- El sujeto documental de keel-go quita la réplica del precio del proveedor (rechazo escrito de su frontera), como el de
  la escritura condicional: no toca nada de la guarda.
- La paridad de errores de `test/domain.test.js` no veía la excepción de keel-spring (el code en su constante `CODE`), el
  mismo hueco que A5 cerró en keel-dotnet.

## Medidas de A5 (2026-11-16)

- `db-check --only=catalog-invariants`: 30/30 sondas en PostgreSQL y en MySQL, con el catálogo del motor igual al esquema
  emitido. `doc-check --only=catalog-invariants-mongo`: 30/30, con los índices vivos del contrato. Lo emitido compila con
  `TreatWarningsAsErrors` a la primera.
- Los 12 sabotajes caen en exactamente sus casos en PostgreSQL y en MongoDB, y los tres que dependen del motor
  (`ic-no-call`, `ic-after-write`, `cp-no-overflow`) también en MySQL. Lo mismo que en keel-spring y keel-nest:
  `ic-after-write` no lo ve IC-10 (Save transaccional en los dos modelos), y en documental tampoco CP-4 (Decimal128
  admite la suma).
- `cp-stale` en keel-dotnet es quitar la línea del derivado de `Apply`: EF no toca la columna de una fila rastreada que
  nadie asignó (conserva la de antes), y el `$set` del documento no lleva el campo.
- La red se equivocó dos veces, lo emitido ninguna: `ic-null-fails` tocaba también el `item.X is null ||` del bucle de la
  suma (lo emitido saboteado dejaba de compilar; ahora solo casa con un miembro de la entidad), y `doc-check` no tenía
  registrados los sabotajes. Y el lector de errores de `test/domain.test.js` no veía la excepción de keel-spring ni la de
  keel-nest, que llevan el code en su constante `CODE`.

## Medidas de A4 (2026-11-16)

- `db-check --subject=catalog-invariants`: 102/102 en PostgreSQL y en MySQL (el esquema y los 30 vectores). `doc-check
  --subject=catalog-invariants-mongo`: 43/43. Ese sujeto solo ejecuta sus vectores: la muestra de los demás bloques no
  cumple sus checks a propósito, y lo demás de catalog-extended ya lo mide su propio sujeto.
- Los 12 sabotajes caen en exactamente sus casos en PostgreSQL y en MongoDB, y los tres que dependen del motor
  (`ic-no-call`, `ic-after-write`, `cp-no-overflow`) también en MySQL. Lo mismo que midió A3 en keel-spring:
  `ic-after-write` no lo ve IC-10 (el save es transaccional en los dos modelos), y en documental tampoco CP-4
  (Decimal128 admite la suma); `invariantMasks` lo dice con su motivo.
- `cp-stale` en keel-nest es quitar la línea del derivado del mapeo: TypeORM no toca una columna `undefined` al
  actualizar (conserva la de antes), y el `$set` del documento no lleva el campo.
- Lo destapó la guarda: el generador de muestras de las sondas ignoraba el formato del ELEMENTO de una lista (su
  `text` es nulo; el formato es el heredado del value type), y `notification-mailer-mongo` dejaba de guardar su muestra
  en `document-persistence.test.js`. Arreglado en `scripts/lib/samples.js`.

## Medidas de A3 (2026-11-16)

- `invariant-check`: 30/30 en PostgreSQL, MySQL y MongoDB (`catalog-invariants` sin la réplica del precio del proveedor,
  que deja el `main` sin compilar recién generado, como en precondition-check). Los 12 sabotajes caen en exactamente sus
  casos en PostgreSQL y en MongoDB; en MySQL se pasaron los tres que dependen del motor (`ic-no-call`, `ic-after-write`,
  `cp-no-overflow`).
- Dos correcciones a lo que declaraba A2 sobre los sabotajes del generador: `ic-no-call` no puede tumbar IC-7 (sus dos
  vectores se cumplen, con o sin guarda) y sí tumba CP-4 (sin la llamada nadie comprueba que la suma quepa);
  `ic-after-write` tumba IC-10 **y** CP-4 (el desbordamiento llega a la base antes que la guarda).
- **En keel-spring `ic-after-write` no lo puede ver IC-10**: el save es `@Transactional` en los dos modelos del sujeto
  y revierte la fila que la guarda rechaza después de escribirla, así que el orden de D21 lo sostiene también la
  transacción. Lo ve CP-4 en relacional (la columna `numeric(19,2)` rechaza la suma con otro error antes de la guarda);
  en documental no cae nada, porque Decimal128 admite la suma. El script lo lee de lo emitido y lo dice con su motivo.
- La «prueba emitida» de la tabla de incrementos es en keel-spring la red `invariant-check` (una clase JUnit que el
  script escribe dentro del proyecto, como history-check): build no deja en el proyecto una prueba de los vectores.
- Consecuencia ya conocida (ventana de A8): casi todas las fixtures ganan la guarda por sus cotas (U1, U6). La cota de
  `ProductInfo.productStock` de `shop-api` responde 422 en `cancelOrder` por encima del máximo hasta que A8 la mueva al
  input.

## Medidas de A0 (2026-11-16)

Medido con `build -y --accept-unready` de los cuatro generadores sobre `shop-api` en un workspace de usar y tirar, y con
un recorrido de las `domain.keel.yaml` de las 19 fixtures.

| | Medida | Qué cambia en el plan |
|---|---|---|
| M1 | **Ningún generador emite guarda de cotas en la entidad.** `ProductInOrder` sale de `build` con estado, rehidratación y getters en los cuatro (Java, TS, C# y Go), sin un solo mutador ni comprobación de `min`/`max`. El 400 de keel-go (`AddCount` con `ErrInvalidValue`) y la suma sin guarda de keel-dotnet son código **del agente**, no de `build` | U1 no cambia nada que `build` emita hoy: no hace falta aviso de contrato en `EVOLUTION.md` por este lado. El riesgo «si keel-spring o keel-nest ya ponían la guarda con otro code» queda descartado |
| M2 | **Una cota del dominio no siempre es invariante.** `shop-api` declara `ProductInfo.productStock` con `max: 1000000`, y su descripción y la regla de `cancelOrder` dicen que la devolución de stock **puede dejarlo por encima**. El `max` vive en la entidad solo para que `createProduct` (`input: { entity: ProductInfo }`) lo herede; `updateProduct` ya lo repite en su `input.fields`. `ProductInOrder.productStock` ya resolvió lo mismo quitando el `max` | Con «las cotas del dominio son invariantes de la entidad», `cancelOrder` respondería 422 donde el legacy (flujo `keep`) acepta. Pide la decisión **U6** |
| M3 | **`ProductInOrder` no es hija de `OrderMain`.** `shop-api` no declara `aggregates` (decisión humana, `decisions.yaml` 3.7: la línea cambia de propietario del carrito al pedido). Sin agregados, `OrderMain.products` es una colección hacia otro agregado: el modelo la clasifica `unsupported` y **no existe** en la entidad de ninguno de los cuatro. Además `orderAmount` es una foto «en el momento del checkout», no un derivado vivo | `computed: { sum }` sobre `OrderMain.products` no cabe en D4/D8. Pide la decisión **U5**. `exactlyOne: [cart, order]` sí cabe: son dos relaciones a-uno de la propia `ProductInOrder` |
| M4 | **Ninguna fixture tiene un `sum` natural.** Las hijas internas a-muchos son `Asset.revisions`, `Product.images` (catalog-extended), `Article.comments`, `InspectionReport.sections` y `Template.variables` (el par del MVP); ningún campo numérico que sumar (`revisionNumber` y `position` son ordinales) | El sujeto del `sum` es sintético (`keel-core/test/helpers/entity-check-designs.js`, como los demás `*-designs.js`). El `count` sí tiene sujetos reales: `catalog-extended` o `inspection-reports` |
| M5 | **Inventario: 16 `invariants` en prosa, 11 caben en `checks`.** Caben: «en X tiene Y» (`job-dispatch`, `job-dispatch-mongo`, `job-dispatch-cycles` ×2, `payout-runs` con dos estados, el par `verification-codes`), `refundedAmount ≤ amount`, `customerAction` solo en `actionRequired`, `awaitingSince` solo en cinco estados (un `forbids … unless` que el plan no contaba) y `price.amount > 0` si `active`. No caben: el `username` en minúsculas de conduit (normalización, no comprobación), el `payerId` del medio guardado (cruza agregados, D8), las dos de `metering-digest` (suma de otro agregado e inmutabilidad) y el `orderAmount` de `shop-api` (M3) | A8 crece: `job-dispatch-cycles` y la `awaitingSince` de `payment-checkout` también pasan a `checks` |
| M6 | **De los cinco `computed` en prosa, ninguno cabe** en la forma estructurada: `following`/`favorited` dependen del llamante, `favoritesCount` cuenta otro agregado (D8), `slug` y `cartId` no son agregaciones | Ningún derivado de fixture migra en A8; el `count` entra en una fixture por declaración nueva (M4) |
| M7 | **Dos huecos de semántica que D1-D9 no deciden.** `refundedAmount` es opcional: ¿qué hace `lte` con un operando ausente? `customerAction` es `json`: ¿cuándo cuenta un json como ausente para `forbids`? | Se añaden D19 y D20 a la tabla de decisiones |
| M8 | **Los mutadores de la entidad son del agente** (consecuencia de M1): `build` emite estado, rehidratación y getters, nada más. «Al final de cada mutación» (D2) no tiene un punto de `build` dentro de la entidad; el único punto de `build` por el que pasa toda escritura es el `save` del adaptador | Propuesta para A2 (se mide en cada generador antes de fijarla): `build` emite en la entidad `ensureInvariants()` (checks y cotas) y el derivado como getter que calcula desde las hijas; el `save` generado llama a `ensureInvariants()` y persiste el valor del getter. Así la guarda y su llamada son las dos de `build`, y la fila de D9 en `check-domain-guards.sh` sobra para los checks |

### Decisiones del usuario tras A0 (2026-11-16)

| | Decisión |
|---|---|
| U5 | `computed: { sum, count }` se queda en la 2.31 solo sobre hijas del mismo agregado. El `sum` se mide con un sujeto sintético y el `orderAmount` de `shop-api` sigue en prosa |
| U6 | Una cota de la entidad es siempre verdad. La que solo vale en la entrada sale de la entidad y se escribe en el input que la necesita: `createProduct` pasa a `input.fields` y `ProductInfo.productStock` pierde el `max`. Sin DSL nuevo. Lo recuerda al diseñador `REV-DOMAIN-BOUND-SERVER-WRITTEN`: un campo acotado que alguna operación escribe con un valor calculado en el servidor |

## Contexto

`docs/evaluacion-dsl-2.24.md` § 9 pone R7 y R8 a la cabeza de lo pendiente, y los dos tienen ya evidencia propia:

- **R7.** El `designGap` `cart-line-sum-over-max` salió en cuatro corridas de `shop-api`. `addToCart`/`mergeCart` hacen
  `count += quantity`, y el diseño no dice qué pasa si la suma pasa del `max` de `count`. Hoy da **dos servidores
  distintos**: keel-go rechaza con 400 y keel-dotnet acepta sin guarda. Eso rompe la regla de equivalencia. Además, las
  invariantes de las fixtures son prosa con cuatro formas que se repiten:
  - «en `running` tiene `runningSince`»: job-dispatch ×3, payout-runs y verification-codes ×2;
  - «`customerAction` solo en `actionRequired`»;
  - «`refundedAmount` no supera `amount`»;
  - «un `active` tiene `price.amount > 0`».

  Y hay derivados en prosa: `orderAmount = Σ productPrice × count`. Hoy esas guardas las escribe el agente, y solo
  donde un escenario las pide.
- **R8.** Hay cuatro problemas:
  - `pagination.style: cursor` valida y ningún generador lo sirve, lo que incumple una regla escrita del método.
  - Los cuatro generadores aceptan `?sort=prop,dir` sobre **cualquier** propiedad: `pageableParam` de keel-go,
    `ReadSort` de keel-dotnet, `readSort` de keel-nest y el `Pageable` de Spring. Además `gen/openapi.js:126` anuncia
    `sort` en todo listado paginado. Es un contrato que nadie decidió, y deja ordenar por un campo `sensitive` o
    `personal`, que sirve de oráculo para adivinar su valor.
  - El `designGap` `list-order-in-prose` salió en tres corridas de `catalog`.
  - 2.22 dejó fuera por escrito `in`, `ne` y la búsqueda libre: una query con un input sin enlazar se queda **sin
    finder entero**.

Resultado buscado:
- el mismo diseño da las mismas guardas, los mismos derivados y la misma búsqueda en los cuatro generadores;
- cada pieza tiene su red en vivo y su sabotaje;
- las corridas de control cierran sin que el agente toque lo que escribe `build`.

## Decisiones del usuario (2026-11-16)

| | Decisión |
|---|---|
| U1 | Una cota del dominio rota por un valor que **no** viene del cliente responde con un code **de framework 422**, `INVARIANT_VIOLATED`. Entra en la lista cerrada de `framework-errors.md` y se puede sustituir con `errors`. La guarda va en la entidad, en los cuatro generadores |
| U2 | `pagination.style: cursor` **se retira** del enum. Se reabre con su contrato cuando un diseño lo pida |
| U3 | `?sort=` pasa a ser contrato. Sin `sortable`, el listado no ofrece `sort` (el OpenAPI lo quita) y todo `?sort=` es **400**. Con `sortable`, solo valen esos campos y cualquier otro es 400 |
| U4 | Un plan con dos versiones seguidas: **2.31 = R7** y después **2.32 = R8**. Cada una cierra con sus redes y sus corridas antes de empezar la siguiente |

Reglas de siempre (memoria del proyecto):
- incrementos secuenciales desde `main`, sin subagentes ni worktrees;
- un generador cerrado antes de empezar el siguiente;
- cada incremento cierra con «Para retomar» y su propio commit;
- se mide antes de suponer.

---

## Fase A: DSL 2.31, invariantes y derivados (R7)

### El DSL

```yaml
# domain.keel.yaml
entities:
  Job:
    checks:
      - { requires: runningSince, when: { field: status, in: [running] } }           # presente en esos estados
      - { forbids: customerAction, unless: { field: status, in: [actionRequired] } } # ausente fuera de esos estados
      - { field: refundedAmount, op: lte, than: amount, error: REFUND_EXCEEDS_AMOUNT } # campo contra campo
      - { field: price.amount, op: gt, value: 0, when: { field: status, in: [active] } } # campo contra literal
      - { exactlyOne: [cart, order] }                                                # relaciones o campos excluyentes
  OrderMain:
    fields:
      orderAmount: { type: decimal, computed: { sum: lines.productPrice, times: count } }
      lineCount:   { type: int, computed: { count: lines } }
```

- `checks[]` reutiliza los dos vocabularios que el DSL ya tiene: los operadores de `filter` (2.22) y la condición
  `when` de los índices (2.9). Si `error` falta, el error es `INVARIANT_VIOLATED`, 422 (U1).
- `computed` acepta su forma actual en prosa **o** un objeto: `sum` (con `times` opcional, un solo factor) o `count`,
  siempre sobre una relación a-muchos **del mismo agregado**. Lo que no quepa en esa forma sigue en prosa.
- Las **cotas** de un campo del dominio (`min`, `max`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`)
  pasan a ser invariantes de la entidad. Se cumplen en cada escritura, no solo en el borde. Esto cierra
  `cart-line-sum-over-max`.

### Decisiones (D1-D9)

| | Decisión | Por qué |
|---|---|---|
| D1 | Una cota que rompe la ENTRADA sigue siendo `VALIDATION_ERROR` 400, en el borde. La rompe un valor calculado en el servidor: `INVARIANT_VIOLATED` 422 en la entidad | El cliente no mandó nada inválido. 422 es «entendí y no puedo» |
| D2 | La guarda se evalúa en la **entidad**, al final de cada mutación (constructor, método de transición o `apply`), antes de guardar. No va en el handler ni en la base | Un solo sitio por generador. La base no da el code del diseño |
| D3 | Un `check` sobre la raíz y sus hijas se evalúa sobre el agregado entero al guardar | `exactlyOne` y los derivados cruzan la raíz y sus hijas |
| D4 | `computed` estructurado se **persiste** como columna o campo y se recalcula en la entidad en cada mutación de la relación. Nunca viene del cliente (como hoy). Sale en el output | Se puede filtrar y ordenar (R8). La lectura no recalcula |
| D5 | La aritmética de `sum` usa el tipo del campo: un `decimal` con su `scale` y `HALF_UP`, un entero exacto. El desbordamiento es `INVARIANT_VIOLATED` | Si cada lenguaje redondeara a su manera, los servidores divergirían |
| D6 | `requires`/`forbids` cuentan como «ausente» el valor nulo, la lista vacía y la cadena vacía. Igual que `required` en el borde (`required-value-blank`) | Una definición única de vacío para las dos guardas |
| D7 | `when`/`unless` solo admiten `field` + `in` (o `equals`) sobre un campo del mismo agregado. No hay disyunciones anidadas | Vocabulario cerrado. Lo que no quepa sigue en `invariants` |
| D8 | Quedan fuera: lo que cruza agregados (el `count` de `Favorite` de conduit, el `totalKwh` de metering), los derivados que dependen del llamante (`favorited`, `following`) y la aritmética más allá de `sum`/`times`/`count` | La referencia prohíbe las invariantes entre agregados. Lo del llamante necesita la lectura de otra raíz por identidad, que es otro primitivo |
| D19 | Un operador de orden (`lt`, `lte`, `gt`, `gte`) con un operando ausente **se cumple**. Si el diseño quiere el campo presente, lo dice con `requires` | Es la semántica de un `CHECK` de SQL con NULL, y no obliga a duplicar el `when` en cada comparación (M7) |
| D20 | Un `json` cuenta como ausente solo si es nulo; `{}` y `[]` son presentes | El json es opaco (lo define un tercero): el servidor no puede saber que `{}` significa «nada» (M7) |
| ~~D9~~ | ~~El gate derivado `check-domain-guards.sh` gana filas~~ **Descartada en A2 por D21**: la guarda y su llamada las escribe build, así que no hay nada del agente que un gate tenga que vigilar | — |
| D21 | `build` emite en la raíz `ensureInvariants()`, que recalcula los derivados y comprueba las cotas y los checks del agregado entero, y el `save` generado (relacional y documental) la llama antes de escribir nada: antes del armado de plazos, del historial y de drenar eventos. El derivado es un getter que calcula desde las hijas, y el `save` persiste su valor | M8: en los cuatro, cada raíz tiene un único `save` por adaptador y toda escritura pasa por él; los mutadores son del agente. Un `save` rechazado deja la transacción sin escribir (IC-10) |
| D22 | `eq`/`ne` con un operando ausente también se cumplen, como los de orden (D19) | La misma regla para toda comparación: la de un CHECK de SQL con NULL |
| D23 | El orden de la guarda es contrato, porque decide el `code` cuando se rompen dos: las hijas antes que su padre, y en cada entidad los derivados, las cotas en el orden de sus campos y los checks en el del diseño | Sin orden fijo, dos servidores responderían codes distintos al mismo estado |
| D24 | En un `sum`, una hija con el sumando o el factor ausente aporta cero (como `SUM` en SQL). Un `decimal` sin `scale` declarada redondea a entero. La longitud de un texto se cuenta en puntos de código | Las tres son preguntas que D5 y D6 no contestaban y la referencia tenía que decidir |
| D25 | Las cotas que se hacen cumplir son las de `validationRules` sin la presencia (`size`, `pattern`, `min`, `max`, también por elemento de una lista), con el `pattern` heredado del value type incluido. Fuera el id, lo generado y los value objects compuestos, cuyo constructor ya guarda las suyas | Una cota de la entidad es siempre verdad (U6). La clase `<Tipo>Format` y su gate siguen: dicen DÓNDE se normaliza y valida la entrada que no pasa por el borde |

### Reglas mecánicas (keel-core)

Cada una con su id, su entrada en `checks.js` con `nature` y su mutación en `test/design-mutations/catalog.js`
(extensión `checks`). Después, `npm run design-matrix`.

- `CHK-DOMAIN-CHECK-FIELD-UNKNOWN` (error): un `check` nombra un campo o relación que no existe, o el `when` sale del
  agregado.
- `CHK-DOMAIN-CHECK-OP-TYPE` (error): un operador de orden sobre algo que no es número ni instante, o tipos
  incomparables entre `field` y `than`.
- `CHK-DOMAIN-CHECK-WHEN-STATE` (error): el `in` nombra un valor que no está en el enum o lifecycle del campo.
- `CHK-DOMAIN-COMPUTED-PATH` (error): `sum`/`count` sobre una relación que no es a-muchos del mismo agregado, o un
  `sum` que no es numérico.
- `CHK-DOMAIN-CHECK-ERROR-UNDECLARED` (aviso, `incoherence`): el `error` de un check no aparece en `errors` de ninguna
  operación que escriba la entidad, con su `http`.
- ~~`CHK-SCEN-CHECK-UNCOVERED`~~ **descartado en A1**: el `error` de un check lo declaran sus operaciones
  (`CHK-DOMAIN-CHECK-ERROR-UNDECLARED`), y desde ahí su escenario ya lo pide `CHK-SCEN-ERROR-UNCOVERED`. Sería un
  co-disparo sin señal propia. Un check sin `error` (`INVARIANT_VIOLATED`) guarda un defecto del servidor, que ningún
  cliente provoca: su red es la prueba emitida con los casos `IC-*`, no un escenario.
- `REV-DOMAIN-INVARIANT-PROSE` (revisión): una `invariants` en prosa que cabe en el vocabulario de `checks`.
- `REV-DOMAIN-BOUND-SERVER-WRITTEN` (revisión, U6): un campo acotado de la entidad que alguna operación escribe con un
  valor calculado en el servidor. El lector confirma que la cota es siempre verdad, o la mueve al input.
- `INVARIANT_VIOLATED` en `keel-core/src/lib/framework-errors.js` y en la tabla de
  `assets/core/docs/framework-errors.md`, el dato y su doc (un test ata las dos).

### Lo neutral (`keel-core/src/lib/gen`)

- `entity-checks.js`, nuevo:
  - `checksOf(entity)`, el modelo ya resuelto;
  - `evaluateChecks(aggregate)` como **referencia ejecutable**;
  - `boundGuards(entity)`, las cotas que se hacen cumplir en la entidad (reutiliza `constraints.js`: `validationRules`
    y la mezcla tipo → campo);
  - la nota del handler;
  - los casos `IC-*` con sus sabotajes `ic-*`.
- `computed.js`, nuevo: `computedSpec(field)`, `evaluateComputed(aggregate)` como referencia ejecutable con D5, y los
  casos `CP-*`.
- `gen/model.js` (`buildModel`): `entity.checks` y `field.computedSpec`. La proyección de cada lenguaje no cambia.
- ~~`domain-guards.js`: `guardedFields` gana las filas de D9~~ (descartado en A2 por D21).
- `gen/openapi.js`: el 422 de `INVARIANT_VIOLATED` en las escrituras de entidades con checks o cotas. `readOnly` en el
  derivado.
- `relational.js` y `persistedMembers`: sin cambios. Medido en A2: un `computed` ya era un campo persistido (la prosa lo
  guardaba igual); lo nuevo es quién lo escribe.
- `wire.js`: sin cambios. El derivado viaja como cualquier campo de su tipo.

### Generadores

En cada uno, `src/scaffold/entity-checks.js` engancha la guarda y el recálculo en la entidad:
- keel-spring: `entities.js`, donde ya están `lateGuardBlock` y las guardas de los value objects;
- keel-nest, keel-dotnet y keel-go: su emisor de entidades.

En los cuatro:
- la traducción de `INVARIANT_VIOLATED` en su manejador de errores;
- una **prueba emitida** con los casos `IC-*`/`CP-*`, que el toolchain de cada uno ejecuta.

La paridad: `keel-go/test/entity-checks-parity.test.js` compara los cuatro contra el YAML y contra
`evaluateChecks`/`evaluateComputed`, como hacen `error-notes.test.js` y `history-parity`.

### Incrementos de la fase A

| Inc. | Qué | Red que lo cierra |
|---|---|---|
| A0 | **Medir antes de nada.** Qué hace hoy cada generador con una cota rota en la entidad: keel-go la rechaza y keel-dotnet no, ¿y keel-spring y keel-nest? Si `ProductInOrder` es hija de `OrderMain` (contraste del `sum`). Inventariar las `invariants` de las 19 fixtures y cuáles caben. Copiar el plan al repo | Tabla de medidas en el plan |
| A1 | keel-core: schema (`domain`, `common`: `checks`, el objeto `computed`), las reglas de arriba con sus mutaciones, `framework-errors`, `dsl/domain.md`, la fila de `dsl-reference.md` y el enum a **2.31** (con `SUPPORTED_DSL` y las fixtures) | `npm test -w keel-core`, `design-matrix` |
| A2 | Lo neutral: `entity-checks.js`, `computed.js`, el modelo, el gate, el OpenAPI y los casos `IC-*`/`CP-*` | `test/entity-checks.test.js`, `test/computed.test.js` |
| A3 | keel-spring: guarda, recálculo, columna, traducción y prueba emitida | `compile-check` + nuevo `npm run invariant-check` (ejecuta `IC-*`/`CP-*` contra PostgreSQL, MySQL y MongoDB, `--sabotage=ic-*\|cp-*`) |
| A4 | keel-nest | `ts-check` + `db-check`/`doc-check` con `scripts/lib/invariant-probes.js` (`--sabotage=ic-*`) |
| A5 | keel-dotnet | `cs-check` + `db-check`/`doc-check` con sus sondas |
| A6 | keel-go | `go-check` + `db-check`/`doc-check` con sus sondas |
| A7 | Contrato y método: `keel-nest/test/openapi.test.js` en los cuatro, `wire-contract.md` (el 422), la pregunta de `/keel-design` (clase de huecos de invariantes), la tabla de `/keel-recover`, los agentes de código y de calidad de los cuatro y `/keel-validate` (`REV-DOMAIN-INVARIANT-PROSE`) | Pruebas de cadenas, `test/capability-coverage.test.js` |
| A8 | Fixtures: `shop-api` declara `exactlyOne` y la cota de `count` pasa a guardarse en la entidad (cierra `cart-line-sum-over-max`); `orderAmount` y la cota de `ProductInfo.productStock`, según U5 y U6 (M2, M3). `job-dispatch`/`-mongo`/`-cycles`, `payout-runs` y `verification-codes` pasan sus «en X tiene Y» a `checks`, y `payment-checkout` (con `awaitingSince`) y `product-catalog` sus comparaciones (M5). Un `count` real en `catalog-extended` o `inspection-reports` (M4). Siguen en `--ready` | `test/mvp-ready.test.js`, `keel validate --ready` |
| A9 | Corridas de control de `shop-api` en los cuatro generadores (PostgreSQL) y una en MySQL | `docs/corridas/…-231-*`: verdes, huella del agente sin crecer y `cart-line-sum-over-max` desaparecido |

---

## Fase B: DSL 2.32, búsqueda (R8)

### El DSL

```yaml
# use-cases.keel.yaml
searchProducts:
  kind: query
  input:
    fields:
      statuses: { type: ProductStatus, list: true, filter: { field: status, op: in } }
      notBrand: { type: uuid, filter: { field: brand, op: ne } }
      q:        { type: string, search: { over: [name, description], match: contains, compare: ignore-case-accents } }
  output: { entity: Product, paginated: true, sort: [name:asc], sortable: [name, price.amount, createdAt] }
```

```yaml
# api.keel.yaml: pagination.style pierde `cursor` (U2); solo queda `offset`
```

### Decisiones (D10-D18)

| | Decisión | Por qué |
|---|---|---|
| D10 | `op: in` exige un input `list: true` del tipo del campo. La lista ausente es un filtro ausente; la lista **vacía** es 400 (`minItems: 1` implícito) | Una lista vacía significaría «nada», y eso nunca es lo que se quiere pedir |
| D11 | `op: ne` **incluye** las filas con el campo nulo o ausente. En SQL es `IS DISTINCT FROM` o su equivalente en MySQL; en Mongo, `$ne` | Es la semántica de MongoDB. Sin decidirla, los motores dan resultados distintos |
| D12 | `in` sobre texto pliega cada elemento con el `compare` del input y solo admite `match: exact` | La sombra plegada ya existe (`foldedShadow`) |
| D13 | `search.over` es un OR de `match` sobre cada campo, con un solo `compare` para todos. Cada campo necesita su sombra con ese plegado (`deriveFilterFolds` se extiende). Se resuelve con `LIKE` sobre la sombra, o con una expresión regular escapada en Mongo. Sin índice de texto completo | Determinista en los tres motores. La relevancia queda fuera |
| D14 | Una lista en la query viaja como **parámetro repetido** (`?statuses=active&statuses=draft`). Se escribe en `wire-contract.md` § Entrada, y el OpenAPI usa `style: form, explode: true` | El cable tiene que decirlo una sola vez para los cuatro |
| D15 | `sortable[]` son campos o subcampos de value object de la entidad de la salida. No admiten campos `sensitive` ni `personal`, ni rutas de otro agregado. El id se añade siempre como desempate (como hoy) | Cierra el oráculo por orden. La ruta embebida necesitaría un join que el finder no tiene |
| D16 | U3: sin `sortable`, `?sort=` es 400 y el OpenAPI no lo ofrece. Con `sortable`, es 400 una propiedad fuera de la lista o una dirección que no sea `asc`/`desc`. Lo que **no se puede leer** de `page`/`size` sigue siendo indulgente | Ahora es contrato. La indulgencia de la página es de Spring Data y no cambia |
| D17 | El orden sobre texto usa la misma collation que la unicidad, binaria (U7): `utf8mb4_bin` en MySQL y `"C"` en PostgreSQL en toda columna de texto ordenable. B0 midió que hoy MySQL no lo cumple (M11) | Sin esto, dos motores ordenan distinto la misma página |
| D18 | La clave de la caché (`cache-plan.js`) incluye el orden pedido. El alcance (2.27) y la vida de la fila (2.28) se componen como hoy en `implicitPredicates` | Si no, dos órdenes compartirían la misma entrada |

### Reglas mecánicas

- `CHK-USECASES-FILTER-IN-NOT-LIST` y `CHK-USECASES-FILTER-OP-TYPE`, que amplía el de 2.22 (error).
- `CHK-USECASES-SEARCH-FIELD` (error): `over` nombra algo que no es texto de la entidad.
- `CHK-USECASES-SORTABLE-FIELD` (error): `sortable` nombra algo que no existe, un campo `sensitive` o `personal`, una
  ruta embebida o una lista.
- `CHK-USECASES-SORT-NOT-SORTABLE` (aviso): el `sort` por defecto de una query con `sortable` no está en la lista.
- `CHK-API-PAGINATION-CURSOR`: no hace falta, porque el schema ya lo rechaza. Se retira el aviso de
  `keel-spring/src/lib/supported-features.js` y su test.
- `OBL-QUERY-SORT-UNDECIDED` (`undecided`): un listado paginado de una API con `audience: users` sin `sortable` ni
  aceptación, porque U3 le quita el orden al cliente. Se puede aceptar en `decisions.yaml`.
- Mutaciones en la extensión `search` del corpus.

### Lo neutral

- `query-filters.js`: los operadores `in`/`ne` (`RANGE_OPERATORS` no cambia), el criterio `search` con sus sombras y
  `criterionText`/`finderNote` para lo nuevo. Las sondas de texto (`finderTextProbes`) cubren `search`.
- `gen/pagination.js`: `sortableOf(operation)`, `readClientSort` como **referencia ejecutable** de D16 (lo que se
  acepta, lo que es 400 y el desempate) y los casos `SO-*`.
- `gen/openapi.js`: el parámetro `sort` solo con `sortable` (enum de `campo,asc|desc`), las listas con
  `explode: true`, y el 400.
- `wire.js` + `wire-contract.md` § Entrada: la lista repetida y el orden del cliente.
- `keel-core/test/helpers/finder-designs.js` gana los sujetos `in`, `ne`, `search` y `sortable`, que comparten las
  redes de los cuatro.

### Generadores

- El lector de `?sort=` de cada uno (`pageableParam`/`sortParam` en keel-go, `ReadSort` en keel-dotnet, `readSort` en
  keel-nest y el `Pageable` del controller en keel-spring) valida contra `sortable` y devuelve 400.
- Los finders (`src/scaffold/finders.js` y `document-repositories.js`) emiten `IN`, `IS DISTINCT FROM` y el OR de la
  búsqueda.
- La lectura de una lista repetida en la query.

### Incrementos de la fase B

| Inc. | Qué | Red que lo cierra |
|---|---|---|
| B0 | **Medir.** Qué hace hoy cada generador con `?sort=` sobre una propiedad desconocida y sobre una `sensitive` (en Spring, ¿500?). Si el orden por defecto sobre texto coincide en los tres motores (D17). Cómo lee hoy cada uno una lista en la query | Tabla de medidas |
| B1 | keel-core: schema (`op` con `in`/`ne`, `search`, `sortable`, fuera `cursor`), reglas con sus mutaciones, `dsl/use-cases.md`, `dsl/api.md`, el enum a **2.32** y las fixtures | `npm test -w keel-core`, `design-matrix` |
| B2 | Lo neutral: `query-filters.js`, `pagination.js`, `openapi.js`, `wire.js` y los casos `SO-*` y del finder | `test/query-filters.test.js`, `test/pagination.test.js`, `test/wire-contract.test.js` |
| B3 | keel-spring | `npm run finder-check` (sujetos nuevos, `--sabotage=finder-in\|finder-ne-null\|finder-search-literal\|sort-open`) |
| B4 | keel-nest | `db-check`/`doc-check` `--subject=<nuevos>` con los mismos sabotajes, más `test/empty-page.test.js` |
| B5 | keel-dotnet | `db-check`/`doc-check` |
| B6 | keel-go | `db-check`/`doc-check` + `go-check` (y `go-check --fixtures`, pendiente del arreglo de la escala) |
| B7 | Contrato y método: `openapi.test.js` en los cuatro, la guía Postman de `/keel-docs`, la pregunta de `/keel-design` (clase 5, el orden), `/keel-recover` y los agentes. El README de cada generador quita el aviso de `cursor` | Pruebas de cadenas, `npx @redocly/cli lint` |
| B8 | Fixtures: `catalog-extended` declara la búsqueda que 2.22 dejó fuera, `in`, `ne` y `sortable`. `product-catalog` declara `sortable` en su listado (cierra `list-order-in-prose`). Las que no ofrezcan orden aceptan `OBL-QUERY-SORT-UNDECIDED` | `--ready` donde ya lo estaban |
| B9 | Corridas de control de `catalog-extended` (o `product-catalog`) en los cuatro generadores y una en MySQL | `docs/corridas/…-232-*` |

---

## Riesgos que medir pronto

- **A0/B0 pueden mover el plan**: si keel-spring o keel-nest ya ponían la guarda de la cota con otro code, U1 cambia su
  respuesta observable. Se anota como cambio de contrato en `EVOLUTION.md` (`gen/evolution.js`).
- **El derivado persistido en una base ya desplegada**: su columna es un paso de esquema (`gen/schema-steps.js`) y su
  valor inicial lo calcula un backfill. Se decide en A2 si el backfill entra en el paso o queda en `EVOLUTION.md`.
- **U3 rompe clientes** que hoy ordenan por cualquier campo. Va en `EVOLUTION.md` como cambio de contrato, y la
  `OBL-QUERY-SORT-UNDECIDED` fuerza la pregunta.
- **`ne` con nulos en MySQL**: `<=>` niega mal. La sonda tiene que cubrir la fila con nulo (sabotaje
  `finder-ne-null`).
- **La sombra de `search` multiplica columnas**: una por campo y plegado. Se mide el número en `catalog-extended`.

## Verificación de punta a punta

1. `npm test` en la raíz (los cinco paquetes) y `npm run design-matrix --workspace packages/keel-core`, sin
   `sin-mutacion`.
2. `npm run matrix` en keel-nest, keel-dotnet y keel-go, con las filas `entity-checks`, `computed`, `finder-in-ne`,
   `search` y `sortable` verificadas y falsadas.
3. Las redes en vivo de cada incremento, en verde, y cada sabotaje en rojo en exactamente sus casos.
4. `keel validate --ready` en `shop-api` y `catalog-extended`.
5. Corridas de control A9 y B9 registradas en `docs/corridas/` con `corrida-metrics.js footprint`, y
   `corrida-metrics.js series` sin `cart-line-sum-over-max` ni `list-order-in-prose` en las nuevas.
6. Actualizar el estado de R7 y R8 en `docs/evaluacion-dsl-2.24.md` (§ 0 y § 9).

## Fuera de este plan

- El cursor (U2: se reabre con un diseño que lo pida).
- Facetas, agregaciones y relevancia.
- El índice de texto completo.
- Los derivados por llamante y los que cruzan agregados (D8).
- Las expresiones arbitrarias.
- `If-None-Match`.
