# Escenarios de caracterización (paso 4)

`validation-scenarios.md` es el contrato de equivalencia de Keel, y en un diseño recuperado sus flujos salen de las **grabaciones**: cada uno dice qué hace el legacy y si el servicio nuevo hará lo mismo. Se escriben con las reglas de siempre (`{{keel:skills}}/keel-design/references/scenario-authoring.md`: Given/When/Then por operación del diseño, nunca por ruta del legacy) más una línea que solo existe aquí, justo debajo del título del flujo:

```markdown
### FL-PRF-002: un username ocupado es un conflicto
**Caracterización**: `fix` (`fix-unique-409`: el legacy responde `422`). Evidencia: recordings/round-1/R1-001.
**Given**: …
```

| Marca | Qué afirma | Qué la sostiene |
|---|---|---|
| `keep` | el servicio nuevo hace **lo mismo** que el legacy | la grabación que el flujo cita; contra el legacy en marcha tiene que pasar |
| `fix` (`fix-*`) | el legacy hace otra cosa, y el nuevo la **corrige a propósito** | una entrada en `provenance.yaml → fixes` con lo que hace el legacy, el porqué y quién lo decidió |
| `frontier` (`F-*`) | el legacy lo hace y el DSL **no lo puede decir** | una entrada en `provenance.yaml → frontier`; contra el nuevo se informa sin contar |
| `new` | solo existe en el servicio nuevo (una decisión `asked` que el legacy no tenía) | la decisión del humano |

`keel validate --ready` (criterio `provenance`) sale en rojo con un flujo sin marca, con un `fix` o un `F-*` que no existen en `provenance.yaml`, y con un `fix` que ningún flujo demuestra: un cambio sin escenario no es un cambio. La única salida es `noFlow` en la entrada del `fix` (`why` y `proof`), para lo que un flujo HTTP no puede ver: un defecto que solo vive en la base (huérfanos), uno que necesita más volumen del que carga un escenario (más de una página máxima) o uno de arquitectura (dónde vive la credencial). Lo decide el humano como el propio `fix`, y un flujo que cite un `fix` con `noFlow` es una contradicción que la puerta también caza.

## Cómo se decide

1. **Por defecto, `keep`.** Lo que el legacy hace y nadie ha dicho que esté mal es comportamiento del sistema, aunque sea raro.
2. **Un `fix` lo decide el humano, nunca tú.** Propónlo con la grabación delante («el legacy responde 422 a un username repetido; Keel exige 409 para una unicidad: ¿se corrige?») y pregunta con `AskUserQuestion`. Para un refactor, la lista de `fix` **es** su backlog: que se vea entera.
3. **Lo que exige el método no es opcional**, pero sigue siendo un `fix`: el contrato del cable (envolturas, forma del error, paginación), la identidad delegada en un proveedor OIDC, el 409 de una unicidad. Se declaran igual, con su flujo, para que la paridad del paso 7 sepa que esa diferencia es buscada.
4. **Un `keep` que no puedes demostrar con una grabación no es un `keep`**: es una sonda que falta. Escríbela en la ronda siguiente antes de escribir el flujo.

## Los pasos ejecutables: el bloque ```` ```keel-flow ````

Todo flujo `keep`, `fix` o `frontier` lleva, **dentro de su bloque** y después del Then, los mismos pasos que cuenta su prosa en un bloque de código ```` ```keel-flow ```` (schema `flow.schema.json` de keel-recover). Va dentro del flujo a propósito: el sello del flujo (el mismo del careo) cubre lo que se ejecuta, y tocar un paso después de ejecutarlo lo deja sin ejecutar. Los `new` no lo necesitan: no existen en el legacy.

````markdown
#### FL-PRF-002: un username ocupado es un conflicto

**Caracterización**: `fix` (`fix-unique-409`: el legacy responde `422`). Evidencia: recordings/round-1/R1-001.

**Given**: `alice` con perfil; `bob` sin perfil.
**When**: `registerProfile` con el token de `bob` y `{"username":"alice"}`.
**Then**: Status `409` con `code: USERNAME_ALREADY_EXISTS`.

```keel-flow
actors: { alice: profile, bob: none }
steps:
  - op: registerProfile
    as: bob
    input: { username: alice }
    legacy: { status: 422 }
    expect: { status: 409, code: USERNAME_ALREADY_EXISTS }
```
````

- **`op`** es una operación del **diseño**, nunca una ruta del legacy; `params`, `query` e `input` van en la forma del diseño. `save: { slug: slug }` guarda un dato de la respuesta como `{{slug}}` para los pasos siguientes.
- **`expect`** es lo que el escenario afirma: `status` (un número o una clase, `ok`/`created`/`no-content`, que cada lado traduce), `code` y `body` como ruta con puntos → valor sobre los **datos** ya sin envoltura (`items.length: 2`, `author.username: alice`). `{ startsWith: … }` para lo aleatorio y `{ sameMembers: [...] }` para una lista sin orden afirmado.
- **`legacy`**, solo en un `fix`: lo que hace el legacy hoy. Contra el legacy se comprueba eso, para demostrar que el defecto existe; un `fix` sin ningún `legacy:` no se ejecuta.
- **`hypothesis: <archivo:línea>`**, en el paso cuya expectativa del lado legacy (`legacy` en un fix, `expect` en keep y frontier) sale de **leer el código** y no de una grabación. `characterize` la confirma —y pasa a estar medida— o la informa como **hipótesis refutada** con lo que el legacy respondió de verdad, en la salida y en `FIDELITY.md`. Refutada, el flujo sigue en rojo y se corrige ese paso con lo observado (quitando la marca). Sin `archivo:línea` el bloque no valida, y una hipótesis sin expectativa del lado legacy es un defecto del flujo.
- Un paso sin `expect` es preparación, pero **un 5xx lo saca en rojo**: un paso sin aserción no es un paso sin comprobar. Un flujo sin ninguna expectativa no se ejecuta.
- **Ninguna línea del bloque puede empezar por `# `**: para Markdown es un encabezado y corta el flujo (y su sello). Sangra los comentarios.

## `legacy/<servicio>/contract-map.yaml`

Los escenarios se escriben una vez, en operaciones del diseño; el mapa los traduce a cada lado (schema `contract-map.schema.json`). Vive con la evidencia, no con el diseño: cita rutas del legacy. Cada diferencia de forma entre el legacy y Keel (envolturas, paginación, la credencial) es un `fix` declarado.

```yaml
kind: contract-map
schema: 1
semantics: { absentIsNull: true }        # el legacy omite lo que Keel manda como null
legacy:
  statusClasses: { ok: 200, created: 200, no-content: 204 }
  auth: { scheme: Token }                # Authorization: Token <jwt>
  # errorCode: error.code                # solo si el legacy lleva un code; si no, el code no se compara
  actors:
    profile: { via: op, op: registerProfile, input: { username: "{{actor}}" }, token: token }
    none: { via: forge, secret: <el de la configuración de desarrollo del repo>, claims: { id: "{{random}}", username: ghost } }
  operations:
    registerProfile: { method: POST, path: /api/users, wrap: user, extraInput: { email: "{{username}}@x.io", password: pw }, result: user }
    getProfile: { method: GET, path: "/api/profiles/{username}", result: profile }
    listArticles: { method: GET, path: /api/articles, page: { items: articles, total: articlesCount } }
    mergeCart: { method: POST, path: /api/cart, unwrap: items }   # el legacy recibe la lista desnuda, no { items: […] }
```

`wrap` mete el input del diseño en un objeto (`{ user: … }`); `unwrap` hace lo contrario: manda solo un campo del input,
porque el legacy recibe una lista o un escalar sin envoltura. Los parámetros de la ruta van en `params` del paso. En la
respuesta, `result` elige dónde está el recurso, y `resultAs: <campo>` pone un cuerpo desnudo del legacy (un `true`, una
lista) en el campo del diseño: `addToCart: { …, resultAs: added }` cuando el legacy responde `true` y el diseño `{ added }`.

Dos piezas más que la paridad necesita y que se escriben al diseñar, no al ver la paridad en rojo:

- `semantics.unordered`: las colecciones que el legacy NO ordena (`^products\[\]$`, `^items\[\]\.products\[\]$`), por su
  ruta normalizada. Si repetir una sonda cambia el orden de una lista, o el código la guarda en un conjunto, va aquí: la
  paridad la compara como conjunto y no elemento a elemento. El diseño puede fijar un orden; el legacy no lo tenía.
- `declaredDifferences[].flows`: la consecuencia de un `fix` en una lectura POSTERIOR del mismo flujo (el legacy rechaza
  la edición y la lectura que sigue devuelve el producto sin editar) se declara solo para ese flujo, con el `fix` que la
  explica, sin tapar la misma ruta en los demás.

Las credenciales salen del repo y nunca de producción: la propia API (`via: op`), un JWT firmado con el secreto de desarrollo (`via: forge`) o ninguna (`via: none`). Del lado `keel`, el regenerado delega la identidad (`via: idp`), y si el diseño identifica al llamante por un claim que no es el `sub` (el email), el actor lo dice: `customer: { via: idp, email: customer1@email.com, roles: [customer] }` (`email: null`, una persona sin email). La paridad la da de alta así en el proveedor del regenerado.

### El estado de partida: `data` y `keel-recover fixtures`

Cada flujo parte del snapshot del legacy, y lo que haya en él (un seed, los registros de referencia) es su estado de partida. Si algún `Given` cuenta con esos datos —un producto del seed, un pedido con su id—, el regenerado tiene que partir de lo mismo, y eso viaja en `specs/<servicio>/fixtures.yaml`. No se escribe a mano: se dice en `contract-map.yaml → data` de qué tabla sale cada entidad, solo con las excepciones, y `keel-recover fixtures legacy/<servicio>` lo deriva del snapshot.

```yaml
data:
  ProductCategory: { table: product_category, reference: true }   # ninguna operación crea categorías
  User:            { table: users, drop: [password, role] }       # la identidad pasa al proveedor
  Cart:            { table: cart, columns: { cartId: user_id, user: user_id } }
  OrderMain:       { table: order_main, values: { orderStatus: { 0: NEW, 1: FINISHED, 2: CANCELED } } }
  ProductInfo:     { table: product_info, values: { productStatus: { 0: UP, 1: DOWN } }, defaults: { version: 0 } }
  ProductInOrder:  { table: product_in_order, columns: { cart: cart_user_id } }
```

Un campo es su columna en snake_case y una relación a-uno, `<relación>_id`; `columns` dice las que no. Toda columna del legacy se lleva o se descarta en `drop`, y todo valor guardado con otro nombre se traduce en `values`: lo que quede sin decidir es un error y `fixtures.yaml` no se escribe. Lo que sale lo cruza keel-core con las capas, y los generadores lo cargan en `infra/reset-db.sh` tras vaciar; la paridad carga ese mismo `infra/fixtures.sql`.

## Ejecutarlos: `keel-recover characterize legacy/<servicio>`

Con el sandbox en verde (`verify.json` con snapshot), cada flujo parte del snapshot de la base —y se comprueba su huella tras restaurarla—, obtiene las credenciales de sus actores y ejecuta sus pasos. Escribe:

- `specs/<servicio>/characterized.yaml`: el sello, flujo a flujo. Lo lee el criterio `characterized` de `keel validate --ready`, que exige todo `keep`, `fix` y `frontier` ejecutado en verde sobre el texto de hoy. No viaja, no se edita.
- `legacy/<servicio>/recordings/characterization/<FL>.json`: los pasos con sus datos, en la forma del diseño (la paridad del paso 7 los compara enteros).
- `legacy/<servicio>/FIDELITY.md`: corrección, cobertura, rutas del legacy que ninguna operación recoge, lo no observado, procedencia, `fix` y frontera.

`--only FL-A,FL-B` ejecuta un subconjunto para iterar, sin sello ni informe. **Si un `keep` falla, el diseño dice algo que el legacy no hace: se corrige el diseño, no el escenario.** Ajustar la expectativa hasta que pase convierte el escenario en una descripción de lo que salió, que es lo contrario de caracterizar.

## Después de regenerar: `keel-recover parity`

El mismo documento sirve para el paso 7. Con el servicio regenerado en marcha (su `deploy/`) y descrito en un `target.yaml`, `keel-recover parity legacy/<servicio> --target target.yaml` ejecuta contra él los mismos flujos —los `new` también— por el lado `keel` de `contract-map.yaml`, y compara **todos** los datos de cada paso con lo que grabó `characterize` del legacy. Por eso los bloques se escriben en operaciones del diseño y nunca en rutas de un lado. Una diferencia que la comparación encuentra y nadie ha declarado es un defecto del diseño recuperado hasta que se explique: se corrige el diseño, o se declara en `contract-map.yaml → declaredDifferences` con el `fix-*` o el `F-*` que la explica.
