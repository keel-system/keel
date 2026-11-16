# DSL 2.31 (R7: invariantes y derivados) y DSL 2.32 (R8: búsqueda)

**Estado: aprobado el 2026-11-16, sin empezar.** Origen: R7 y R8 de `docs/evaluacion-dsl-2.24.md` (§ 9, puestos 1.º y 2.º).

## Estado

| Inc. | Qué | Estado |
|---|---|---|
| A0 | Medir antes de nada | hecho (2026-11-16, § Medidas de A0) |
| A1-A9 | Fase A: DSL 2.31 (R7) | pendiente |
| B0-B9 | Fase B: DSL 2.32 (R8) | pendiente |

**Para retomar.** A0 está medido y movió el plan (§ Medidas de A0): M2 y M3 piden dos decisiones del usuario (U5 y U6)
antes de A1. Con ellas contestadas, A1 desde `main`: schema, reglas con sus mutaciones, `INVARIANT_VIOLATED` y el enum a
2.31.

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

### Decisiones pendientes del usuario

| | Pregunta | Recomendación |
|---|---|---|
| U5 | `computed: { sum }` sin sujeto real (M3, M4): ¿se mantiene el `sum` en la 2.31 con un sujeto sintético, y `orderAmount` de `shop-api` sigue en prosa? | Sí. Abrir el `sum` a relaciones entre agregados contradice D8 y la decisión 3.7 de `shop-api`, y la foto del checkout no es un derivado vivo |
| U6 | Una cota que **no** es invariante (M2): ¿cómo se dice? (a) la cota sale de la entidad y se escribe en el input que la necesita (`createProduct` pasa a `input.fields`), sin DSL nuevo; (b) una marca nueva en `constraints` que la limite a la entrada | (a): la entidad dice lo que es siempre verdad y el input su propio contrato, que es la doctrina de `crossrefs.js` (el input y el almacén son contratos distintos). Una regla mecánica nueva (`REV-` o `CHK-`) recordaría el caso al diseñador |

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
| D9 | El gate derivado `check-domain-guards.sh` gana filas: una por `(entidad, check)` y una por campo acotado escrito por el servidor | Las guardas existen porque el diseño las declara, no porque un escenario las pida |

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
- `CHK-SCEN-CHECK-UNCOVERED` (aviso): ningún escenario provoca el code de un check. Es aviso como todo `CHK-SCEN-*`.
- `REV-DOMAIN-INVARIANT-PROSE` (revisión): una `invariants` en prosa que cabe en el vocabulario de `checks`.
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
- `domain-guards.js`: `guardedFields` gana las filas de D9, y `domainGuardsScript` las mismas filas en los tres que
  lo comparten. keel-spring tiene el suyo.
- `gen/openapi.js`: el 422 de `INVARIANT_VIOLATED` en las escrituras de entidades con checks o cotas. `readOnly` en el
  derivado.
- `relational.js` y `persistedMembers`: la columna del derivado. El documental lo guarda como campo.
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
| D17 | El orden sobre texto usa la misma collation que la unicidad (`caseSensitiveCollation`, binaria). El A0 de esta fase mide que el orden por defecto ya lo cumpla en PostgreSQL, MySQL y MongoDB | Sin esto, dos motores ordenan distinto la misma página |
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
| B6 | keel-go | `db-check`/`doc-check` + `go-check` |
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
