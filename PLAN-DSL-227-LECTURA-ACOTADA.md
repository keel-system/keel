# DSL 2.27 — la autorización a nivel de fila en lectura

Origen: R3 de `docs/evaluacion-dsl-2.24.md` (R3a, R3b y R3c). Este plan la lleva al DSL y a los cuatro generadores con
la regla de siempre: **el mismo diseño genera servidores equivalentes**. Cada pieza nueva tiene una red que la ejecuta y
un sabotaje que demuestra que esa red la ve.

## Por qué

R3 es la recomendación con más riesgo evitado de la evaluación, porque su fallo es una fuga de datos y no un fallo
visible (OWASP API1, BOLA). Hoy el DSL decide quién **ejecuta** una operación, pero no qué **filas** ve cada uno:

- **`scoping`** solo siembra el proveedor de identidad y el puerto `CallerScope`. La comprobación es prosa:
  `dsl/security.md:102` dice «se escribe como `rule` en cada operación acotada». Ejemplo: `asset-vault/listAssets`
  (`use-cases.keel.yaml:104`).
- **`ownership`** (2.23) solo se aplica a las operaciones que lista. Lo que emite es una nota en el handler
  (`gen/ownership.js`) que dice 403. Ninguna pieza filtra un listado: `F-ORDER-LIST-SCOPING` en
  `fixtures/designs/shop-api/provenance.yaml:293`.
- **No hay `level: optional`** (`common.schema.json:256`). Es la frontera `F-OPTIONAL-AUTH` de
  `fixtures/designs/conduit/provenance.yaml:284`, de la que salieron 6 diferencias de la paridad.
- **Ningún finder ni repositorio** de los cuatro generadores aplica un predicado implícito. `query-filters.js` solo
  conoce los inputs y el `where`.

**Decisiones del usuario (2026-11-09):**

1. R3a entra como **`scoping` estructural**, no como un bloque `tenancy` nuevo. `tenancy` (todas las raíces y unicidad
   por inquilino) queda fuera hasta que lo pida un diseño multiinquilino real.
2. **Un solo plan y una sola versión, 2.27**, con R3c (`level: optional`) como fase propia.

## El DSL

```yaml
# security.keel.yaml
authentication:
  scoping:                       # ya existe (asset-vault)
    claim: vaults
    over: Owner.code
    error: ASSET_OUT_OF_SCOPE
    exemptRoles: [vault-admin]
    exemptClients: [rendering-service]
    reads: [getAsset, listAssets]   # NUEVO: lecturas acotadas por construcción
    readMiss: forbidden             # NUEVO: not-found | forbidden (sin default)

ownership:
  OrderMain:                     # ya existe (shop-api)
    owner: buyerEmail
    error: ORDER_NOT_OWNED
    operations: [cancelOrder]     # escrituras: como en 2.23 (nota y 403)
    reads: [getOrder, listOrders] # NUEVO
    readMiss: forbidden           # NUEVO; shop-api conserva el 403 del legacy (paridad)
    exemptRoles: [employee, manager]

# access (R3c)
rules:
  getArticle: { level: optional } # NUEVO valor del enum authLevel
```

Qué significa cada pieza:

- **Una lectura en `reads`** lleva el predicado en el **adaptador generado**, no en el handler: el listado, la página
  con su total y la lectura por id. Con `ownership`, el predicado es «owner = identidad del llamante», siguiendo el
  camino de relaciones a uno. Con `scoping`, es «`over` ∈ conjunto del claim», por el camino a uno desde la raíz hasta
  la entidad de `over`, que se deriva.
- **Los exentos** (`exemptRoles` y `exemptClients`) no reciben filtro.
- **`readMiss`** decide qué recibe quien pide por id una fila ajena: con `not-found`, el 404 del diseño, que no filtra
  que la fila existe; con `forbidden`, el `error` 403. No tiene default, porque las dos opciones son legítimas (la
  paridad con un legacy frente a no filtrar la existencia).
- **`level: optional`**: sin token, la operación se ejecuta como pública con la identidad nula. Con un token válido,
  hay identidad. Con un token inválido o caducado, `401`, nunca anónimo. No admite `roles`, `permissions` ni
  `scopes`.

## Decisiones (D1-D9)

| # | Decisión | Por qué |
|---|---|---|
| D1 | El borde generado construye un valor neutral `ReadScope` (`unrestricted` \| `ownedBy(v)` \| `within(set)`) a partir del token, y lo estampa en el mensaje (`@JsonIgnore` en keel-spring), igual que `expectedVersions` en 2.25 y `entryGate` | La autorización no depende del agente. Desde otra puerta (evento, despacho, reloj) llega `unrestricted` |
| D2 | El puerto gana parámetros **obligatorios**: `findPage(…, scope)`, `findAll(…, scope)` y `loadScoped(id, scope)` | El compilador obliga al handler a pasar el scope, en los cuatro lenguajes |
| D3 | **Un claim ausente es un conjunto vacío** y no se ve nada. Nunca es `unrestricted`. Solo una exención da `unrestricted` | El fallo seguro. Es el sabotaje más importante del plan |
| D4 | El predicado se compone con `AND` sobre los `criteria` y el `fixed` de `queryFinder`, y **también sobre el conteo** de la página | Que el total de la página no revele filas ajenas |
| D5 | `loadScoped` carga por id y compara en el adaptador, como `loadExpecting`. Fuera de alcance: con `not-found` devuelve «no encontrado» y con `forbidden` lanza el error declarado | Se mide con `db-check` sin necesidad de corrida. Orden de la 2.25: 404 → 403 → 412 |
| D6 | La caché de una lectura en `reads` mete el scope en la clave (`unrestricted` comparte entrada) | Si no, la caché sirve a un llamante la fila de otro |
| D7 | Las escrituras de `ownership.operations` y las acotadas por `scoping` siguen como en 2.23 (nota del handler) | R3 es la lectura. Mover las escrituras al adaptador queda para después |
| D8 | En `reads` solo puede ir una query con `level: required` o `admin`: ni `public` ni `optional` | Con `optional` y sin token no hay a quién acotar. Si se pide, va aparte |
| D9 | Quedan fuera de 2.27: el bloque `tenancy`, la unicidad por inquilino, la *row-level security* del motor, el borrado lógico (R4) y los derivados por llamante (R7) | Ningún diseño los pide todavía. `gen/read-scope.js` se diseña como **el** predicado implícito, así que R4 se le compondrá después (§ 8 de la evaluación) |

En `conduit` (R3c), la personalización (`favorited`, `following`) la sigue escribiendo el agente en el handler, con la
identidad que ahora puede llegar. Su forma estructurada es de R7.

## Reglas mecánicas (keel-core)

Cada regla lleva su id, su entrada en `checks.js` con su `nature`, su mutación en la extensión `readScope` de
`test/design-mutations/catalog.js` (montada sobre `withScoping`/`withOwnership`) y su fila en `design-matrix`.

| Id | Qué detecta |
|---|---|
| `CHK-SECURITY-READS-OPERATION` | Una entrada de `reads` no es una query, o no devuelve la entidad (única, lista o página) |
| `CHK-SECURITY-READS-LEVEL` | Una lectura en `reads` no es `required` ni `admin` (D8) |
| `CHK-SECURITY-READS-MISS-ERROR` | `readMiss: forbidden` sin el `error` 403 declarado en la operación, o `not-found` sin su 404 |
| `CHK-SECURITY-OWNERSHIP-QUERY-IN-OPERATIONS` | Una query listada en `operations` en vez de en `reads`. Obliga a migrar `shop-api` (`getOrder`, `getProfile`) |
| `CHK-SECURITY-SCOPING-READ-PATH` | No hay un camino a uno único desde la raíz de la lectura hasta la entidad de `over` |
| `OBL-READ-SCOPE-UNDECIDED` | Una query expuesta que devuelve una raíz con `ownership` o con camino a `scoping` no está en `reads` ni es `public`. Sin default seguro; se acepta en `decisions.yaml` por operación |
| `CHK-SECURITY-OPTIONAL-RULE` | `optional` con `roles`, `permissions` o `scopes` |
| `CHK-USECASES-OPTIONAL-CALLER-REQUIRED` | El campo de `callerIdentity` va `required` en una operación `optional` |
| `CHK-SCEN-READ-SCOPE-UNCOVERED` | Aviso: una lectura en `reads` sin escenario de la fila ajena |

**Decidido al escribirlas (inc. 0):**

- **`reads: []` es una decisión** y cierra `OBL-READ-SCOPE-UNDECIDED` para el bloque entero: «ninguna lectura se acota por
  construcción». Así un diseño que solo acota escrituras (conduit: los artículos los lee cualquiera) se cierra con una
  línea del DSL y no con una aceptación por operación. La obligación salta solo cuando el bloque no tiene la clave, y no
  sobre las queries que ya están en `ownership.operations` (la nota de la 2.23). `readMiss` es obligatorio solo con
  `reads` no vacío (schema).
- **`CHK-SECURITY-OWNERSHIP-QUERY-IN-OPERATIONS` pasa al incremento 7.** Es un error, y `shop-api` lista hoy
  `getOrder` y `getProfile` en `operations`: entrar en el 0 rompería la fixture, y migrarla a `reads` no es posible hasta
  que los cuatro generadores lo emitan. Entra con su migración.
- **`CHK-SCEN-READ-SCOPE-UNCOVERED` solo lee el `Then`** del escenario: el `Given` ya describe la fila ajena, y casar con
  él daba por cubierto lo que no se afirma (lo destapó su propia mutación).
- **Sin `REV-*` nuevo**: lo que había que juzgar (si una lectura se acota, y con qué desenlace) es mecánico ahora.

Afinan reglas que ya existen:

- `OBL-RESOURCE-SCOPE` (`crossrefs.js:1957`) sabe ya que el 403 de un `readMiss: forbidden` está cubierto.
- El salto por `level === 'public'` de `crossrefs.js:1974` incluye también `optional`.

## Núcleo neutral: `keel-core/src/lib/gen/read-scope.js`

Calcado de `conditional-writes.js` y `deadlines.js`:

- **Derivación desde capas y desde modelo:** qué lecturas, qué predicado, el camino de relaciones, quién está exento y
  el `readMiss`.
- **`model.js`:** `security.readScopes`, y `operation.readScope` en cada query.
- **`query-filters.js`:** `queryFinder` incorpora el predicado. El finder deja de ser `none` cuando solo existe el
  predicado.
- **Nota del handler:** pasar `scope`, no filtrar a mano.
- **Fila del gate**, solo si el compilador no basta.
- **Frontera de los generadores:** `readScopePendingErrors(layers, generator, increment)`, el mismo mensaje en los
  cuatro y llamado desde cada `supported-features.js` hasta que el generador lo emita. Si `cache` + `reads` no se
  mide en algún generador, se rechaza con su motivo.

**Casos** (`READ_SCOPE_CASES`):

| Caso | Qué afirma | Nivel |
|---|---|---|
| RS-1 | El listado devuelve solo las filas del scope | Adaptador, relacional y documental |
| RS-2 | El total y las páginas cuentan solo las filas del scope | Adaptador |
| RS-3 | `unrestricted` lo ve todo | Adaptador |
| RS-4 | `loadScoped` de una fila ajena con `not-found`: no encontrado | Adaptador |
| RS-5 | Lo mismo con `forbidden`: el error declarado, después del 404 de una fila inexistente | Adaptador |
| RS-6 | `within(set)` con varios valores, y con el conjunto vacío no devuelve nada | Adaptador |
| RS-7 | Compone con los `criteria` y el `where` de un finder | Adaptador |
| RS-8 | Owner a través de un camino de relación (`author.subject`): join o subdocumento | Adaptador |
| RS-9 | Dos llamantes no comparten la entrada de caché | `cache-check` |
| RS-10 | El borde: rol exento o cliente exento → `unrestricted`; claim ausente → vacío | Borde emitido o `security-check` |
| RS-11 | `readMiss` sale con su status, su `code` y su `message` del cable | API emitida |

**Casos de R3c** (`OPTIONAL_AUTH_CASES`):

| Caso | Qué afirma |
|---|---|
| OA-1 | Sin token: 200 con la identidad nula |
| OA-2 | Token válido: identidad presente |
| OA-3 | Token inválido o caducado: 401 con la forma del cable |
| OA-4 | El OpenAPI declara `security: [{}, {bearer: []}]` |

**Sabotajes:** cada uno tiene que caer exactamente en sus casos.

| Sabotaje | Qué rompe | Debe caer |
|---|---|---|
| `rs-no-filter` | El listado ignora el scope | RS-1, RS-2 y RS-6 (las filas, el total y el vacío salen de la misma consulta) |
| `rs-count-unscoped` | El conteo ignora el scope | RS-2 |
| `rs-get-leak` | `loadScoped` no compara | RS-4/5 |
| `rs-empty-is-all` | El claim ausente se trata como `unrestricted` | RS-6/10 |
| `rs-finder-replace` | El predicado sustituye a los criterios en vez de sumarse | RS-7 |
| `rs-path` | Compara un campo equivocado del camino | RS-8 |
| `rs-cache-key` | La clave de caché no lleva el scope | RS-9 |
| `oa-degrade` | Un token inválido se trata como anónimo | OA-3 |
| `oa-ignore-token` | Con `optional` nunca hay identidad | OA-2 |

## Trampas que hay que medir antes de suponerlas

- **T1 · el join del camino de relaciones.** Hay que medirlo en JPA, TypeORM, EF Core, el SQL de keel-go y Mongo,
  donde la relación puede estar embebida o referenciada: RS-8.
- **T2 · `embed` de un listado acotado.** `asset-vault/listAssets` hace `embed: [owner]`. La lectura por lote de
  `ref-targets.js` no debe ampliar lo que se ve.
- **T3 · la colación del `within`.** Con texto, el `IN` respeta la colación de unicidad (`caseSensitiveCollation`):
  `asset-vault` compara distinguiendo mayúsculas.
- **T4 · el uuid binario en MySQL.** El `IN (…)` sobre un uuid binario ya mordió en `ref-targets`.
- **T5 · la escritura condicional.** `loadExpecting` y `loadScoped` sobre la misma raíz. El orden de D3 de la 2.25
  (404 → 403 → 412) ya está medido. Si hacen falta las dos, queda para después.
- **T6 · el filtro redundante.** `shop-api/listOrders` recibe hoy `callerEmail` como input. Con `reads`, el input
  sobra: si se deja, `queryFinder` lo une por nombre y duplica el predicado (sin daño). Se retira de la fixture.
- **T7 · la lectura por clave natural.** `conduit/getArticle` carga por `slug` y `shop-api/getProfile` por `email`, no
  por id: `loadScoped(id, scope)` no las cubre tal cual. **Decidido en el incremento 1**: un `loadScopedBy<Clave>(valor,
  scope)` cuando la lectura recibe la clave natural de UN campo, y `loadScoped(id, scope)` cuando recibe el id de la raíz
  (`scopedLoadOf`, neutral). Cualquier otra forma la rechaza la frontera neutral `readScopeGenerationErrors`, con el
  mismo mensaje en los cuatro.
- **T8 · el listado acotado sin finder.** Una query con un input que no enlaza (`finderGaps`) no tiene finder, y su
  búsqueda la escribe el agente: el predicado no llegaría por construcción. **Decidido en el incremento 1**: se rechaza
  en la frontera neutral (`readScopeGenerationErrors`), que rechaza también un salto por una entidad interna, un campo
  acotado que no es texto y dos bloques que acotan la misma raíz. Por eso `conduit-scoped` acota solo `getArticle`:
  los filtros de `listArticles` por autor y favoritos no enlazan.

## Sujetos

En `keel-core/test/helpers/read-scope-designs.js`, con el patrón de `finder-designs.js`:

| Sujeto | Base | Qué mide |
|---|---|---|
| `vault-scoped` | `asset-vault`, pasado a relacional | scoping, `within`, exentos, caché, el salto como subconsulta y un filtro por `status` (RS-7) |
| `vault-scoped-mongo` | `asset-vault`, documental | La rama documental de lo mismo |
| `shop-scoped` | `shop-api` | ownership por rol, `forbidden`, paginado, carga por `email` (T7) y un filtro por `orderStatus` (RS-7) |
| `conduit-scoped` | `conduit` | owner por camino de relación, `not-found`, carga por `slug` (solo `getArticle`, por T8) |
| `conduit-optional` | `conduit` | R3c |

Ninguna fixture declara `reads` u `optional` hasta el incremento 7: los generadores que todavía no lo emitan la
rechazarían.

## Incrementos (secuenciales desde `main`, sin subagentes, un generador cerrado antes del siguiente)

**0. keel-core.**

- Versión 2.27: el enum de `service.schema.json`, la plantilla, las fixtures, la base del corpus y `SUPPORTED_DSL`,
  el `package.json` y el README de los cuatro generadores.
- Schemas: `security.schema.json` (`reads`, `readMiss`) y `common.schema.json` (`optional`).
- Las reglas, las mutaciones y la extensión `readScope` del corpus.
- `gen/read-scope.js` con su test.
- `access-plan.js`: un `kind: 'optional'` en `accessRequirement` y `closingCredentialOf`.
- `api-cases.js` (RS-11 y OA-*), `wire.js` si hace falta.
- La clase de `gap-analysis.md` y `gap-classes.js` que toca la autorización.
- Una fila de `REV-*` si hay prosa que juzgar.
- Docs: `dsl/security.md` (sustituye el párrafo de L102), el historial de `dsl-reference.md` y
  `validation-scenarios.md`.
- `readScopePendingErrors` llamado desde los cuatro `supported-features.js`.
- **Medido con:** la suite de keel-core y `npm run design-matrix`, con todos los ids nuevos `falsado` y ninguno
  `co-disparado`.

**1. keel-spring.**

- `ReadScope` y su estampado en el controller.
- El puerto en `finders.js` (`portFinderMethods`, `jpaFinderMethods`, `mongoFinderMethods`), `repositories.js` y
  `document-repositories.js`.
- `loadScoped`, la clave de `cache.js` y el mapeo de `readMiss` en `ApiExceptionHandler`.
- **Red nueva: `npm run read-scope-check`**, calcada de `precondition-check`. Ejecuta RS-1 a RS-8 en PostgreSQL,
  MySQL y MongoDB; RS-10 y RS-11 con MockMvc; RS-9 con `RedisOperationCache` en memoria. Acepta
  `--sabotage=rs-*`.
- `compile-check` de los sujetos.
- La fila `read-scope` en `engine-support.js`.

**2. keel-nest.**

- Lo mismo sobre TypeORM y el documental.
- **Redes:** `db-check` y `doc-check` (RS-1 a RS-8, con las sondas en `scripts/lib/read-scope-probes.js`),
  `security-check` sobre `vault-scoped` (RS-10), `cache-check` (RS-9) y `ts-check --only` (RS-11).
- Los sabotajes y `test/read-scope-parity.test.js` contra keel-spring.

**3. keel-dotnet.** Lo mismo, con EF Core y MongoDB.Driver. **Redes:** `db-check`, `doc-check`, `security-check`,
`cache-check` y `cs-check`.

**4. keel-go.**

- Lo mismo, con SQL propio y documental. El error de `forbidden` es un centinela comparable con `errors.Is`.
- **Redes:** `db-check`, `doc-check`, `security-check` (montando `vault-scoped`, que hoy no monta), `cache-check` y
  `go-check`.

**5. R3c, `level: optional`, en los cuatro (keel-spring primero).**

| Generador | Dónde se toca |
|---|---|
| keel-spring | `authorizeBlock` y el conversor JWT: un token presente e inválido da 401 aunque la ruta sea pública |
| keel-nest | `verdict`/`authenticate` (`security.js:264-702`) |
| keel-dotnet | `HttpSecurityMiddleware` |
| keel-go | Los `kinds` del middleware |

En los cuatro, el campo de identidad nullable en el mensaje. **Redes:** `security-check` (OA-1 a OA-3), y en
keel-spring `read-scope-check` con MockMvc y un decodificador JWT doble. **Sabotajes:** `oa-*`.

**6. Derivados y documentación.**

- `gen/openapi.js`: la seguridad alternativa de `optional` y los 404/403 de `readMiss`. Sus tres oráculos y
  `redocly lint`.
- La guía de Postman de `/keel-docs`.
- `/keel-design`: cuándo preguntar por `reads`/`readMiss`.
- `/keel-recover`: se diseña con `reads`/`optional` en vez de abrir una frontera.
- Los agentes de código y de calidad de los cuatro.
- `capability-coverage` y una fila nueva en `CLAUDE.md` § Dónde se añade cada cosa.

**7. Fixtures y keel-recover.**

- **`asset-vault`:** `reads` y `readMiss` en vez de la `rule` en prosa.
- **`shop-api`:**
  - `reads: [getOrder, listOrders]` con `forbidden` y `exemptRoles`;
  - `getProfile` pasa a `reads`;
  - se retira `F-ORDER-LIST-SCOPING` de `provenance.yaml` y de `decisions.yaml`/`gaps.yaml`;
  - se quita `callerEmail` del input (T6).
- **`conduit`:** las cuatro lecturas en `optional`, y se retira `F-OPTIONAL-AUTH` y sus `rules`.
- Las tres siguen en `--ready`, con el careo de los flujos tocados.
- `keel-recover parity` de `shop-api` y `conduit`: las 6 diferencias declaradas de `F-OPTIONAL-AUTH` y la del listado
  dejan de estar declaradas y tienen que salir iguales.

**8. Corridas de control.** Las lanza el usuario, dos a la vez como mucho: `asset-vault` y `shop-api` en los cuatro
generadores con Keycloak, y cuatro más con Cognito, cruzadas (decisión del usuario, 2026-11-11): cada generador una vez y
cada diseño dos, con el mismo stack que su gemela de Keycloak, así que lo único que cambia es el proveedor. Se registran en
`docs/corridas/` con la huella y los `designGaps`.

| Workspace (`D:\keel-example\`) | Diseño | Generador | Proveedor | Lo que añade |
|---|---|---|---|---|
| `vault-227-spring-mongo-rabbit` | asset-vault | keel-spring | Keycloak | hecha (32/32) |
| `shop-227-spring-postgre` | shop-api | keel-spring | Keycloak | hecha (92/92) |
| `vault-227-nest-mongo-rabbit` | asset-vault | keel-nest | Keycloak | hecha (32/32, 2026-11-11, a la primera) |
| `vault-227-{dotnet,go}-mongo-rabbit` | asset-vault | keel-dotnet, keel-go | Keycloak | la gemela de keel-spring |
| `shop-227-{nest,dotnet,go}-postgre` | shop-api | los otros tres | Keycloak | la gemela de keel-spring |
| `vault-227-spring-mongo-rabbit-cognito` | asset-vault | keel-spring | Cognito | hecha (32/32, 2026-11-11): D6 y D3 en verde por el emulador |
| `vault-227-go-mongo-rabbit-cognito` | asset-vault | keel-go | Cognito | lo mismo en keel-go |
| `shop-227-nest-postgre-cognito` | shop-api | keel-nest | Cognito | hecha (92/92, 2026-11-11): D5 y las personas de `tokenAs` en verde por el emulador |
| `shop-227-dotnet-postgre-cognito` | shop-api | keel-dotnet | Cognito | lo mismo en keel-dotnet |

Las de Cognito miden contra el emulador, no contra un pool real (fase 5 de `PLAN-PROVEEDOR-IDENTIDAD.md`): un verde dice
que el servidor cumple el contrato del token que el emulador reproduce, con el disparador que exigen D5 y D6 dado por
hecho.

## Puerta de cierre

- Las suites de los cinco paquetes en verde.
- `design-matrix` sin ningún id `sin-mutacion`.
- La fila `read-scope` (y la de `optional-auth`) de las cuatro matrices `verificado` y `falsified: true`, en las dos
  ramas.
- Cada sabotaje cae solo en sus casos, en cada generador.
- La paridad de `shop-api` y `conduit` sin las dos fronteras.
- Las corridas de control en verde.

Un generador que no llegue a la puerta rechaza la capacidad en su `supported-features.js` con su motivo.

## Cómo se ejecuta

- Desde `main`, sin subagentes ni worktrees, y keel-spring primero: las pruebas de paridad de los otros tres comparan con lo que emite keel-spring.
- Cada incremento termina con una sección «Para retomar» y un commit en `main`.
- Las redes en vivo, de una en una.
- Los temporales en `D:`.

## Estado

| Incremento | Estado | Medido con |
|---|---|---|
| 0. keel-core | hecho (2026-11-10) | suites de los cinco paquetes en verde; `design-matrix`: los 8 ids nuevos falsados (205), ningún co-disparado nuevo, ningún `sin-mutacion` |
| 1. keel-spring | hecho (2026-11-10) | `read-scope-check` en los cuatro sujetos (PostgreSQL, MySQL y MongoDB) y los siete sabotajes, cada uno en exactamente sus casos; suites de keel-core y keel-spring |
| 2. keel-nest | hecho (2026-11-10) | `db-check` (PostgreSQL y MySQL) y `doc-check` en los cuatro sujetos, con los siete sabotajes cada uno en exactamente sus casos; RS-9 a RS-11 ejecutando lo emitido; `ts-check`; suites de los cinco paquetes |
| 3. keel-dotnet | hecho (2026-11-10) | `db-check` (PostgreSQL y MySQL) y `doc-check` en los cuatro sujetos, con los siete sabotajes cada uno en exactamente sus casos; RS-9 a RS-11 en la prueba emitida `ReadScopeTests` con `cs-check --fixtures --only`, falsada con `rs-cache-key` y `rs-empty-is-all`; suite de keel-dotnet |
| 4. keel-go | hecho (2026-11-10) | `db-check` (PostgreSQL y MySQL) y `doc-check` en los cuatro sujetos, con los seis sabotajes del adaptador cada uno en exactamente sus casos y en ninguna otra sonda; RS-9 a RS-11 en las pruebas emitidas con `go-check --read-scope`, falsadas con `rs-cache-key` y `rs-empty-is-all`; gofmt, vet, staticcheck y pruebas emitidas de los cuatro; suite de keel-go |
| 5. `level: optional` | hecho (2026-11-10) | OA-1 a OA-3 sobre `conduit-optional` en los cuatro, con `oa-degrade` y `oa-ignore-token` cada uno en exactamente su caso: keel-spring `read-scope-check` (MockMvc con la cadena generada, 12/12); keel-nest `test/optional-auth.test.js` (el hook, las reglas, el JWT y el lector emitidos sobre Fastify); keel-dotnet la prueba emitida `OptionalAuthTests` con `cs-check --fixtures --only=conduit-optional`; keel-go `optional_auth_test.go` con `go-check --read-scope` (8/8); suites de los cinco paquetes |
| 6. derivados y docs | hecho (2026-11-10) | `keel-nest/test/openapi.test.js` sobre los cinco sujetos: el mismo documento en los cuatro generadores, OA-4, el 404/403 de `readMiss` y el listado acotado, sin deriva para `CHK-DOCS-OPENAPI-DRIFT`; falsado (sin la alternativa vacía cae solo `conduit-optional`; sin la cláusula de `not-found`, solo `conduit-scoped`); `redocly lint` válido en los cinco (los avisos, los mismos que en las fixtures base); suites de los cinco paquetes |
| 7. fixtures y keel-recover | hecho, salvo la paridad en vivo (2026-11-10) | `keel validate --ready` de las tres fixtures con los mismos criterios que antes (asset-vault 12/13, el que falta es DESIGN.md fuera de un workspace; shop-api y conduit con los mismos rojos previos y FL-ART-009 sin ejecutar); `design-matrix` 206 falsados, ninguno `sin-mutacion`; suites de los seis paquetes; `db-check` de keel-go sobre shop-api en PostgreSQL y MySQL, con `rank-sort` cayendo en `TestOrderMain_SortsByOrderStatusRank`. La paridad de shop-api y conduit necesita los servicios regenerados en marcha: pasa al inc. 8 |
| 8. corridas de control | en curso: keel-spring hecho (asset-vault 32/32, shop-api 92/92, 2026-11-10); keel-spring con Cognito hecho (asset-vault 32/32, 2026-11-11); keel-nest: asset-vault con Keycloak (32/32) y shop-api con Cognito (92/92), 2026-11-11; faltan cuatro de Keycloak (shop-api en keel-nest; las dos de keel-dotnet y de keel-go) y dos de Cognito (keel-go y keel-dotnet) | `docs/corridas/2026-11-10-*-227-spring-control.md`, `2026-11-11-*-227-*.md` |

## Para retomar

- Plan escrito el 2026-11-09.
- **Incremento 0 hecho (2026-11-10).** DSL 2.27 en el schema, la plantilla, las 20 fixtures, el corpus y los cuatro
  generadores. `reads`/`readMiss` en `security.schema.json` (con `readMiss` obligatorio si `reads` no está vacío) y
  `optional` en `authLevel`. `gen/read-scope.js`: la derivación desde las capas (el modelo la llama con las mismas:
  `operation.readScope`, `security.readScopes` y `finder.scope`, que hace que un listado acotado tenga finder aunque no
  filtre nada más), `readScopeFor`/`scopeAdmits`/`scopedLoadOutcome` como referencia ejecutable de D1, D3 y D5, la
  nota, los casos y sabotajes, y `readScopePendingErrors`/`optionalAuthPendingErrors` en los cuatro
  `supported-features.js` (y la fila del README de keel-go). `access-plan.js`: `kind: 'optional'`, y con él de cierre
  el humo entra sin credencial. Ocho ids nuevos con su mutación (extensiones `scopedReads`, `ownedReads`,
  `optionalAuth`; `scoping` y `ownership` declaran `reads: []` para seguir en silencio). Fixtures: `asset-vault` y
  `shop-api` aceptan `OBL-READ-SCOPE-UNDECIDED` hasta el inc. 7; `conduit` declara `reads: []` en Article y Comment.
  Sujetos en `test/helpers/read-scope-designs.js` y `test/read-scope.test.js` (12 casos).
- **Desviaciones del plan**, con su motivo en § Reglas mecánicas y § Trampas: `reads: []` cierra la obligación;
  `CHK-SECURITY-OWNERSHIP-QUERY-IN-OPERATIONS` pasa al inc. 7; sin `REV-*` nuevo. **Pospuesto a su consumidor**: los
  casos RS-11 y OA-* en `api-cases.js` (inc. 1 y 5, cuando una prueba emitida los ejecute) y la seguridad alternativa
  del OpenAPI (inc. 6). Abiertos para el inc. 1: T7 (lectura por clave natural) y T8 (listado acotado sin finder).
- **Incremento 1 hecho (2026-11-10).** keel-spring genera la lectura acotada entera (`src/scaffold/read-scope.js`):
  `ReadScope` sellado en `domain.repository` (con su `cacheKey()`, la de `readScopeCacheKey` de keel-core); `ReadScopes`
  en el borde, que construye el scope desde el token (scoping con `CallerScope`, propiedad con los roles exentos y
  `CallerIdentity`) y el controller estampa en el mensaje (`@JsonIgnore`); el finder acotado con el scope obligatorio
  como último parámetro y el predicado SUMADO a su Specification o su Criteria, que da también el total; el salto a otra
  raíz como subconsulta (JPA) o resolviendo los ids de la otra colección (MongoDB); `loadScoped` y `loadScopedBy<Clave>`,
  que cargan y preguntan al motor con el MISMO predicado (`exists`); el scope en la clave de caché; la nota neutral en el
  handler. Una raíz cuyos listados paginados están todos acotados ya no tiene `list(Pageable)` sin scope en su puerto.
  Neutral nuevo en keel-core: `scopedLoadOf` (T7), `readScopeGenerationErrors` (T7, T8 y compañía, que keel-spring llama
  desde `planService` porque necesita el modelo), `readScopePath`, `readScopeCacheKey` con `READ_SCOPE_KEY_CASES` y
  `readMissMessage` (el 403 sale con el `when` del error declarado). Red: `npm run read-scope-check` (sondas en
  `src/lib/read-scope-probes.js`); fila `read-scope` en las cuatro matrices (`pending` en las otras tres) y la red en
  el catálogo neutral.
- **Desviaciones del inc. 1**: (1) `vault-scoped` pasa a relacional (asset-vault es documental: los dos sujetos de vault
  medían la misma rama), y vault y shop ganan un filtro opcional para medir RS-7; (2) `conduit-scoped` acota solo
  `getArticle` (T8); (3) en una raíz con salto, las aserciones que solo son verdad con el camino correcto (la fila
  propia, la ajena, el total, `within` con varios valores) son RS-8, y `read-scope-check` traduce RS-1/RS-2 a RS-8 al
  calcular qué tiene que caer; (4) RS-6 se mide en el listado (en la carga, el vacío es una fila ajena más, la de
  RS-4/RS-5), y `rs-no-filter` cae en RS-1, RS-2 y RS-6, que salen de la misma consulta; (5) la mitad RS-10 de
  `rs-empty-is-all` es el claim ausente, que solo existe con `scoping`; (6) RS-11 se mide con el
  `ApiExceptionHandler` generado, porque keel-spring no emite pruebas de la API: los casos de `api-cases.js` siguen
  pospuestos al inc. 2 (keel-nest). **Una trampa medida**: la siembra daba el mismo texto a todos los campos del dueño, y
  `rs-path` (comparar otro campo del camino) salía VERDE; el campo acotado se siembra ahora con un valor propio.
- **Incremento 2 hecho (2026-11-10).** keel-nest genera la lectura acotada entera (`src/scaffold/read-scope.js`):
  `ReadScope` como unión discriminada en `domain/repository` (con `cacheKey`, la misma forma que keel-spring);
  `ReadScopes` en `infrastructure/security`, que el controlador llama antes del lector y estampa en el mensaje (con
  `resolvedBy`, el dueño es la identidad ya resuelta); el finder acotado con el scope obligatorio y el predicado sumado al
  `where` de TypeORM —el salto, como subconsulta del QueryBuilder de la otra raíz dentro de un `Raw`, para que TypeORM ponga
  nombres y comillas de cada motor— o al filtro del driver, resolviendo los ids de la otra colección; `loadScoped` y
  `loadScopedBy<Clave>` con `count` sobre el MISMO predicado; el scope en la clave de caché. Neutral nuevo en keel-core:
  `listsUnscoped` (`gen/features.js`, la raíz cuyos listados están todos acotados no da `list(pageable)`; keel-spring lo
  usa también) y la nota de la caché, que con `reads` ya no dice «la clave no es el llamante». Redes: `db-check` (vault-scoped
  y shop-scoped, PostgreSQL y MySQL) y `doc-check` (vault-scoped-mongo y conduit-scoped), con `scripts/lib/read-scope-probes.js`
  y los sabotajes `rs-*` cada uno en exactamente sus casos; RS-9 a RS-11 EJECUTANDO lo emitido en `test/read-scope.test.js`
  (la clave, ReadScopes con un principal y el 403 del `ApiExceptionFilter`), falsados con `rs-cache-key` y la mitad del
  borde de `rs-empty-is-all`, que es además la comparación de paridad con keel-spring (cargas, constructores del borde y
  lecturas). Los cuatro sujetos entran en `DERIVED_SILHOUETTES` (ts-syntax y ts-check).
- **Desviaciones del inc. 2**: RS-9, RS-10 y RS-11 no van por `cache-check`, `security-check` y `ts-check`: ejecutar lo
  emitido transpilado mide la misma pieza sin contenedores (la clave es una función pura; ReadScopes lee el principal del
  `SecurityContext`, y el `JwtCallerScope` que lee el claim ya lo midió `security-check` contra Keycloak; el 403 es el filtro
  de errores). La paridad va en `test/read-scope.test.js` y no en un archivo aparte. **Dos cosas medidas**: `doc-check`
  cazó un error de tipos que ts-syntax no ve (la colección de la otra raíz sin tipar), y con `rs-path` la carga de la fila
  propia lanza el 403, así que la sonda lo cuenta como «no cargó» en vez de morir.
- **Incremento 3 hecho (2026-11-10).** keel-dotnet genera la lectura acotada entera (`src/scaffold/read-scope.js`):
  `ReadScope` (Domain/Repository, con `CacheKey()`, la forma de keel-core); `ReadScopes` (Infrastructure/Security), que el
  LECTOR del endpoint estampa en el mensaje (`public required ReadScope ReadScope`; con resolvedBy, el dueño es la
  identidad ya resuelta); el finder acotado con el scope obligatorio y `Scoped(query, scope)` sumado tras sus criterios
  —el salto, una subconsulta de EF (un `IN` por salto)— o `Scoped(filter, …)` con `ReadScopeFilter` en documental, que
  resuelve los `_id` de la otra colección; `LoadScoped` y `LoadScopedBy<Clave>` con `AdmittedOrMiss` sobre el MISMO
  predicado; el scope en la clave de caché. Redes: `db-check` (vault-scoped y shop-scoped, PostgreSQL y MySQL) y
  `doc-check` (vault-scoped-mongo y conduit-scoped) con `scripts/lib/read-scope-probes.js`, un `[Fact]` por caso con el id
  en el nombre, y `--sabotage=rs-*`; RS-9 a RS-11, la prueba emitida `ReadScopeTests` (la clave de keel-core y la que
  compone `CachedOperations` con dos scopes, ReadScopes desde un principal, el 403 por el `ApiErrorMiddleware`), ejecutada
  por `cs-check --fixtures --only=<diseños>` (opción nueva: las sondas comunes de cs-check no caben con un subconjunto) y
  falsada con `rs-cache-key` (RS-9) y la mitad del borde de `rs-empty-is-all` (RS-10). Paridad con keel-spring y keel-nest
  en `test/read-scope.test.js`.
- **Desviaciones del inc. 3**: RS-9 a RS-11 no van por `cache-check` ni `security-check`, sino en la prueba emitida que
  ejecuta `cs-check` (la misma pieza sin contenedores, como en keel-nest). **Tres cosas medidas**: (1) RS-7 con «un valor
  del enum que ninguna fila tiene» salía rojo en MySQL con la suite entera y verde aislado —el estado de las filas sembradas
  no es estable entre sondas—, y ahora afirma que, para CADA valor, todo lo que sale lo lleva; (2) un sabotaje que no toca
  a un sujeto (`rs-path` sin salto, los del listado en conduit-scoped) no tiene que caer en nada, y el veredicto solo
  traduce RS-1/RS-2 a RS-8 si hay un listado acotado; (3) **abierto**: conduit no era sujeto de `doc-check`, y sus sondas
  GENERALES fallan (la clave natural de dos referencias de Follow y Favorite, con todas las muestras apuntando a la misma
  raíz asegurada, y el conflicto transitorio de Profile). Es un hueco de las sondas, no de la lectura acotada: en
  conduit-scoped `doc-check` juzga solo los RS (`readScopeOnly`) hasta que alguien lo cierre.
- **Incremento 4 hecho (2026-11-10).** keel-go genera la lectura acotada entera (`src/scaffold/read-scope.js`):
  `domain.ReadScope` (con `CacheKey()`, la forma de keel-core) cuyo valor CERO es el conjunto vacío —Go no obliga a dar un
  campo en un literal, así que un mensaje que nadie estampó no ve nada, que es la forma de D2 y D3 en Go—; el scope del
  borde en `internal/httpapi/read_scope.go` (`readScopeScoping` sobre `security.CallerScope`, `readScopeOwnerOf<Entidad>`
  con `callerIdentity` y los roles exentos; un token sin la identidad es el 401 de siempre), que el endpoint estampa en el
  mensaje tras el lector; el finder acotado con el scope obligatorio y `scoped` sumado al `filters` tras sus criterios —el
  salto, una subconsulta `IN` por salto; el `IN` sin valores es `1 = 0`— o a las condiciones del documento, resolviendo los
  `_id` de la otra colección; `LoadScoped` y `LoadScopedBy<Clave>` con `admittedOrMiss` sobre el MISMO predicado (el 403 es
  el centinela del error declarado, comparable con `errors.Is`); el scope en la clave de caché. Redes: `db-check`
  (vault-scoped y shop-scoped, PostgreSQL y MySQL) y `doc-check` (vault-scoped-mongo y conduit-scoped) con
  `scripts/lib/read-scope-probes.js` y `--sabotage=rs-*`, cada uno en exactamente sus casos y en ninguna otra sonda; RS-9 a
  RS-11, las pruebas emitidas (`internal/domain/read_scope_test.go`, `internal/application/read_scope_cache_test.go`,
  `internal/httpapi/read_scope_test.go`), con `go-check --read-scope` (opción nueva) y falsadas con `rs-cache-key` y la
  mitad del borde de `rs-empty-is-all` (`test/helpers/read-scope-sabotages.js`). Paridad con los otros tres en
  `test/read-scope.test.js`. La fila `read-scope` de las cuatro matrices queda `verificado` y falsada en las dos ramas.
- **Desviaciones del inc. 4**: RS-9 a RS-11 no van por `cache-check` ni `security-check` (que hoy no monta vault-scoped),
  sino en pruebas emitidas que ejecuta `go-check`, como en keel-nest y keel-dotnet. `rs-cache-key` y la mitad del borde de
  `rs-empty-is-all` son de `go-check`; los demás, de `db-check`/`doc-check`. **Dos cosas medidas**: (1) `rs-finder-replace`
  escrito como «el predicado sustituye a los criterios» tiraba además la sonda 2.22 del finder, que pide con
  `UnrestrictedScope`; el veredicto de keel-go no admite sondas de más, así que el sabotaje sustituye solo con un scope;
  (2) en Go, conduit-scoped pasa las sondas GENERALES de `doc-check`: el hueco que keel-dotnet anotó en el inc. 3 es de sus
  sondas, no del diseño.
- **Incremento 5, tramo keel-spring (2026-11-10).** Lo que se midió antes de escribir: en Spring un bearer inválido ya es 401
  en una ruta `permitAll` (lo decide `BearerTokenAuthenticationFilter`, con los manejadores de error de la cadena), y
  keel-nest hace lo mismo a propósito; así que en la cadena `optional` es `permitAll()` (`accessAuthority`) y lo único
  que cambia es la identidad. Neutral nuevo en keel-core: `operation.optionalAuth` (`isOptionalAuth`, la regla de la
  operación o la de cierre), `optionalIdentityNote` (la nota del handler, con el «vacío» de cada lenguaje) y
  `optionalAuthFrontierErrors`, que rechaza `optional` sobre una identidad que no es un token: con `api-key`, una clave
  equivocada pasa el filtro sin autenticar y la ruta la trataría como anónima, justo lo que OA-3 prohíbe. keel-spring:
  `CallerIdentity.resolveOptional()` (null sin `JwtAuthenticationToken`; con un token, lo mismo que `resolve()`), que el
  controller estampa en las operaciones optional, y la nota en el handler. Red: `read-scope-check conduit-optional`, sin
  base, con una clase JUnit nueva (`OptionalAuthEdgeCheckTest` en `src/lib/read-scope-probes.js`): un contexto de Spring
  con la `SecurityConfig`, los manejadores y los controllers GENERADOS, el mediator como doble y un `JwtDecoder` doble,
  por MockMvc con `springSecurityFilterChain` delante. Sabotajes: `oa-degrade` (un `BearerTokenResolver` que da null si
  el token no decodifica) y `oa-ignore-token` (`resolveOptional` siempre null).
- **Desviaciones del inc. 5 (keel-spring)**: (1) sin `security-check` en keel-spring (no lo tiene): MockMvc con la cadena
  real mide la misma pieza; (2) **sin fila `optional-auth` en las matrices de paridad**: la matriz es solo de lo que
  bifurca por modelo o por motor, y la identidad opcional no bifurca (cadena y controller, iguales en relacional y
  documental); la puerta de cierre que la pedía queda cubierta por los sabotajes `oa-*` de cada generador; (3) OA-4
  (el OpenAPI) es del inc. 6.
- **Incremento 5 hecho en los cuatro (2026-11-10).** keel-nest: la exigencia `optional` (concedida en `verdict`, como
  `public`; el bearer inválido ya era 401 en `authenticate`), `CallerIdentity.resolveOptional()` en el lector y la nota; su
  red EJECUTA lo emitido en `test/optional-auth.test.js` (Fastify real con `installSecurity`, `JwtAuthenticator` sobre una
  clave de la prueba y el lector del controlador con un sustituto de `@nestjs/common`) y se falsa a sí misma. keel-dotnet:
  `optional` caía en `Requirement.Authenticated` (la rama por defecto) y ahora es `PermitAll`; `CallerIdentity.ResolveOptional()`
  (también delante del `CallerIdentityResolver`) y la prueba emitida `OptionalAuthTests` (el servidor en memoria con el
  mediator sustituido por un doble que registra el mensaje y `TestCredential`), ejecutada por `cs-check`, con `oa-degrade` y
  `oa-ignore-token` en `FIXTURE_SABOTAGES`. keel-go: `permitAll`, `optionalCallerIdentity` (el lector solo estampa si hay
  identidad) y la prueba emitida `internal/httpapi/optional_auth_test.go` (`a.edge(a.secure(mux))` con el
  `JWTAuthenticator` real y rutas que llaman al LECTOR emitido), sujeto nuevo de `go-check --read-scope`.
- **Desviaciones y medidas del inc. 5 (los tres)**: (1) en keel-dotnet y keel-go `oa-degrade` tumba además la prueba de la
  API del token roto en una ruta ABIERTA (`UnTokenQueNoValidaEs401TambienEnUnaRutaAbierta`): es la misma propiedad, y OA-3
  es su caso optional; keel-go lo declara en `fails`; (2) keel-go destapó que un campo de identidad OPCIONAL (`*string`)
  recibía un `string` (`msg.X, err = callerIdentity(...)`): no compilaba, y ninguna fixture tenía el campo opcional; el
  lector lo estampa ahora con `&credential`, optional o no; (3) en keel-go el claim de la identidad puede ser el propio
  `sub`, y el literal de los claims de la prueba no puede repetir clave (lo vio `go test`, no `go-syntax`).
- **Incremento 6 hecho (2026-11-10).** `gen/openapi.js`: con `level: optional`, `security: [{}, {bearerAuth: []}]` (OA-4)
  y solo el 401 del token roto (sin `403 ACCESS_DENIED`: no exige permiso); la lectura de una fila amplía el error de su
  `readMiss` (con `not-found`, el 404 es también el de la fila ajena sin revelar cuál; con `forbidden`, el 403 es el de la
  ajena, después del 404 de la inexistente), y el listado acotado lo dice en su respuesta de éxito (y que el total cuenta
  solo esas). Oráculo: un bloque nuevo en `keel-nest/test/openapi.test.js` sobre `READ_SCOPE_DESIGNS`, como el de la
  escritura condicional. Docs: `/keel-docs` (el bullet del openapi y una sección de la guía de Postman: `optional` sin
  cabecera —`Bearer ` vacío es un 401—, el segundo llamante `token_<rol>-other` para leer una fila ajena, el status de
  `readMiss`), `/keel-design` (la pregunta de `reads`/`readMiss`/`optional` en el paso de security; `gap-analysis.md` ya
  la tenía del inc. 0), `/keel-recover` (fuera la «autorización por propietario» de las fronteras, y dos filas de
  evidencia: la sonda de las dos personas → `reads`/`readMiss`, la lectura que se personaliza → `optional`, con un token
  inválido tratado como anónimo como `fix`), los agentes de código de los cuatro (pasar el scope, nunca `findById`) y los
  de calidad (auditoría estática de la carga de la ficha, a `remaining`). `capability-coverage`: los motivos de las tres
  filas puestos al día en los cuatro (keel-nest y keel-dotnet aún decían que su frontera la rechazaba); se borran en el
  inc. 7. Fila de `CLAUDE.md` ampliada.
- **Desviaciones del inc. 6**: (1) **sin gate** de la lectura acotada: el compilador obliga a pasar el scope al finder
  acotado, pero no a cargar la ficha con `loadScoped`; un `findById` en el handler compila y pasa todo escenario de un
  solo llamante. Lo cubren el escenario de la fila ajena (`CHK-SCEN-READ-SCOPE-UNCOVERED`) y la auditoría del agente de
  calidad, sin clave de estado nueva en su reporte. Si una corrida del inc. 8 lo destapa, el gate es el de
  `check-conditional-writes.sh` (una fila por lectura, la llamada fuera de un comentario). (2) La guía de Postman nombra
  `token_<rol>-other` para el segundo llamante; `auth-collection.json` es del equipo y no lo comprueba nadie
  (`CHK-DOCS-POSTMAN-DRIFT` no la mira).
- **Incremento 7 hecho (2026-11-10), salvo la paridad en vivo.** Las tres fixtures declaran 2.27:
  - `asset-vault` v1.1.3: `scoping.reads: [getAsset, listAssets]` con `readMiss: forbidden` (el 403 ASSET_OUT_OF_SCOPE de
    siempre); fuera las dos aceptaciones de `OBL-READ-SCOPE-UNDECIDED` y la prosa de las rules. FL-AST-003-D y FL-AST-004-B
    nombran la operación (sin eso `CHK-SCEN-READ-SCOPE-UNCOVERED` no los reconocía) y FL-AST-004-B afirma `totalElements` 0.
    DESIGN.md al día.
  - `shop-api` v0.1.1: `OrderMain.reads: [getOrder, listOrders]` con `forbidden` y los roles exentos; `User.reads:
    [getProfile]` con **`not-found`** (decisión del usuario: con `forbidden`, el 404 de un email sin perfil frente al 403 de
    uno con perfil revela qué emails tienen cuenta; antes el diseño daba 403 a todo email ajeno). Fix nuevo
    `fix-profile-other-404`; FL-ACC-009 y FL-ACC-017 pasan a 404 PROFILE_NOT_FOUND. Fuera `callerEmail` de las tres
    lecturas (T6), la frontera `F-ORDER-LIST-SCOPING` (FL-ORD-005 pasa a `keep`) y su aceptación.
  - `conduit` v0.1.2: `optional` en `getProfile`, `listArticles`, `getArticle` y `listComments`, con `callerSubject` opcional;
    fuera la frontera `F-OPTIONAL-AUTH`. Flujo nuevo FL-ART-009 (`keep`, R1-014): con token, las cuatro lecturas se
    personalizan. En el laboratorio (`keel-recover-lab/realworld-node`): el flujo en `characterization.yaml` y fuera la
    diferencia declarada de `favorited|following` en `contract-map.yaml`.
  - Versiones de **patch** en las tres: un minor caduca `review.yaml`, el careo y las decisiones aceptadas, y reafirmarlas
    era decidir por el diseñador. El careo de asset-vault y shop-api tenía el presupuesto agotado: los flujos tocados se
    carearon a mano y se resellaron con hallazgos `resolution: scenario` + `sealAfter`.
  - `CHK-SECURITY-OWNERSHIP-QUERY-IN-OPERATIONS` (error) con su mutación; la de `ERROR-UNDECLARED` usa ahora un command.
  - Fuera: las filas de `capability-coverage` de los cuatro, `readScopePendingErrors` y `optionalAuthPendingErrors` (ya no
    las llamaba nadie). Los sujetos de `read-scope-designs.js` siguen midiendo lo mismo: `shop-scoped` repone
    `PROFILE_NOT_OWNED` para seguir con `forbidden` en las dos raíces, y `conduit-scoped` devuelve a `public` las otras
    tres lecturas.
  - Las pruebas de los generadores que daban por hecho las fixtures de antes (la nota de la 2.23 en `getOrder`/`getProfile`,
    `CallerScope.Covers` en la ficha de asset-vault, conduit sin `optional`, la clave de caché sin el scope) parten ahora de
    la fixture con el cambio deshecho, o afirman lo nuevo. El lector de la `SecurityConfig` de keel-spring
    (`normalizeRequirement`) lee `optional` como `public`: en la cadena los dos son `permitAll`.
  - **Medido**: en keel-go la sonda del orden por rango (`rankProbes` de `db-check`, el sabotaje `rank-sort`) solo existía
    con `List(pageable)`, y OrderMain de shop-api ya no lo tiene: el orden por la posición del enum de `listOrders` se quedaba
    sin medir. La sonda va ahora por la página acotada con `UnrestrictedScope()`.
- **Redes en vivo de las fixtures tocadas (2026-11-10, tras el commit del inc. 7)**: keel-nest `db-check` (PostgreSQL
  140/140, MySQL 71/71) y `doc-check` (25/25); keel-dotnet `db-check --only=shop-api` (56 sondas por motor), `doc-check
  --only=asset-vault` (58 sondas e índices vivos) y `security-check` (34/34); keel-go `doc-check` de asset-vault (55
  sondas) y de conduit (24) y `security-check` (56/56). Todo en verde. **Hueco previo, ajeno al plan**: `security-check` de
  keel-nest sale en rojo en su primer sujeto (profile-directory, no en asset-vault, que pasa entero) desde `7fcc7a99`:
  `score-scenarios.sh` marca `AJENO` los flujos que el documento no declara, y su sonda escribe `FL-SEC-001-*` sin
  declararlos, así que ni puntúan ni el sabotaje sale con 1. **Arreglado** como en keel-dotnet: el documento de escenarios
  del proyecto declara solo la sonda y su línea sale del sello; el falsado exige además que caiga SOLO FL-SEC-001-C.
  `security-check` de keel-nest: 32/32 en verde.
- **Pendiente del inc. 7, al 8**: `keel-recover characterize` de los flujos tocados (FL-ART-009, FL-ORD-005 y FL-ACC-009) contra los sandboxes, y `keel-recover
  parity` de shop-api y conduit contra los servicios regenerados: sin las dos fronteras, las diferencias de `favorited` y
  `following` y la del listado tienen que salir iguales.
- **Incremento 8 preparado (2026-11-10, `260c908c`)**: ocho workspaces en `D:\keel-example\` con `keel init`, el diseño en
  `specs/`, su DESIGN.md en `docs/` (asset-vault), el `keel-stack.json` sembrado y `build` hecho:
  `vault-227-<generador>-mongo-rabbit` (asset-vault v1.1.3: MongoDB, RabbitMQ, Keycloak, Redis y MinIO; `--ready` en verde)
  y `shop-227-<generador>-postgre` (shop-api v0.1.1: PostgreSQL y Keycloak; con `--accept-unready`, estampado, por los
  cinco criterios previos al plan). Cada corrida: `cd services/<servicio>-<generador>` y `/keel-generate-<generador>`; se
  registra en `docs/corridas/` con la huella. La paridad de keel-recover (shop-api y conduit) se valida después.
- **Corridas de keel-spring hechas (2026-11-10)**: asset-vault 32/32 y shop-api 92/92, registradas en `docs/corridas/`. Tres defectos del generador arreglados antes de las otras seis: `max-part-count` de keel-spring a dos veces el máximo válido; `ensurePersona` rechaza en los cuatro un `sub` de más de 36 caracteres (`PERSONA_SUB_MAX`, `gen/identity-realm.js`); y la skill de los cuatro da la forma de `design-gaps.yaml` (`DESIGN_GAPS_FORM`, atada al schema). Medido con las seis suites, `compile-check` de keel-spring y `security-check` de keel-dotnet y keel-go; la guarda, falsada en `keel-nest/test/persona-sub.test.js`. Pendiente, menor: el comentario de `test-credentials.env` sobre el secreto del recurso acotado. Los seis workspaces restantes, refrescados con `build --refresh`.
- **Corridas pendientes puestas al día (2026-11-11).** Los seis workspaces de Keycloak sin correr se refrescaron con
  `build --refresh --prune` (shop-api con `--accept-unready`): ganan lo de las fases 2 a 4 del plan del proveedor (la
  prueba del contrato del token, `docs/keel/identity-contract.md` y, en shop-api, el arnés que reconcilia el rol de la
  persona). Sus diseños son los de las fixtures de hoy. Y cuatro workspaces nuevos con Cognito, copia del de Keycloak del
  mismo diseño con `auth: cognito` en `keel-stack.json` (tabla del § 8). **Lo que destapó prepararlos**: el aviso de lo que
  el proveedor tiene que traer configurado (`checkIdentitySupport`, D5/D6) solo lo imprimía el `build` de keel-spring; en
  los otros tres quedó dentro del `if (layers.payments)` de la pasarela. Arreglado, con una red en
  `keel-go/test/identity-providers.test.js` que ejecuta el `build` de los cuatro (falsada: sin el arreglo cae solo ese
  generador).
- Siguiente: **incremento 8, corridas de control** (las lanza el usuario). Cada una: `cd D:\keel-example\<workspace>\services\<servicio>-<generador>`
  y `/keel-generate-<generador>`; en keel-nest, `npm install` antes.
- **Corridas de keel-nest (2026-11-11)**: asset-vault con Keycloak 32/32 a la primera (huella 14, 13 TODO) y shop-api con
  Cognito 92/92 (huella 30: 25 TODO y las 4 consultas por lote de keel-spring). `quarantine-last-scanned-at` y
  `cart-line-sum-over-max` vuelven: la serie los da ya como candidatos a id. Un hueco menor del generador: el paso 7 del
  agente de infra ejecuta `reset-db.sh` antes del primer arranque, y con `fixtures.sql` la carga falla porque el esquema
  aún no existe. Arreglado en los tres agentes de infra (keel-spring no tiene el paso): `reset: N/A` con ese motivo
  (`4da2c080`), y las siete corridas pendientes refrescadas con `build --refresh --prune` para que lo lleven.

