# Capa `use-cases` — casos de uso (obligatoria)

Archivo: `specs/<servicio>/use-cases.keel.yaml` · Schema: [`schema/use-cases.schema.json`](../../schema/use-cases.schema.json)

Cada operación es un caso de uso completo: qué recibe, qué devuelve, qué reglas aplica, qué puede fallar y qué eventos emite. Aquí viven también las políticas que son **semántica del caso de uso** — idempotencia, caché, schedule y las transiciones del `lifecycle` que ejecuta — porque valen igual lo invoque REST o un evento.

```yaml
operations:
  createProduct:
    description: Da de alta un producto en estado draft.
    kind: command
    input:
      fields:
        sku:       { type: SKU, required: true }
        name:      { type: string, required: true }
        price:     { type: Money, required: true }
        catalogId: { type: uuid }
    output: { entity: Product }
    idempotency: { keySource: client-key, ttlSeconds: 86400 }
    rules:
      - El sku se normaliza a mayúsculas antes de validar unicidad.
      - Si se indica catalogId, el catálogo debe existir.
    errors:
      - { code: SKU_ALREADY_EXISTS, when: Ya existe un producto con ese sku., http: 409 }
      - { code: CATALOG_NOT_FOUND, when: El catalogId indicado no existe., http: 422 }
    emits: [ProductCreated]

  getProduct:
    description: Recupera un producto por su id.
    kind: query
    input:
      fields:
        id: { type: uuid, required: true }
    output: { entity: Product }
    cache: { ttlSeconds: 300, keyFields: [id], invalidatedBy: [ProductRetired] }
    errors:
      - { code: PRODUCT_NOT_FOUND, when: No existe producto con ese id., http: 404 }

  getProductsByIds:
    description: Resuelve varios productos por sus identificadores en una sola llamada.
    kind: query
    input:
      fields:
        ids: { type: uuid, list: true, required: true, constraints: { minItems: 1, maxItems: 100 } }
    output: { entity: Product, list: true }
    rules:
      - Los identificadores inexistentes se omiten del resultado, en el mismo orden que la petición.

  reconcilePrices:
    description: Reconcilia precios contra el servicio de pricing cada noche.
    kind: command
    input: "void"
    output: "void"
    schedule: { cron: "0 3 * * *" }
```

## Campos

- `kind`: `command` (muta estado) o `query` (solo lee). Default `command`.
- `input`/`output` admiten tres formas: `"void"`, `{ fields: {...} }`, o `{ entity: Product }` con opcionales `list`, `paginated`, `exclude: [...]`, `embed: [...]`, `sort: [...]`.
- Un campo de un payload `{ fields: {...} }` puede ser una **colección** con `list: true`, y acotarla con `constraints: { minItems, maxItems }` (la cardinalidad de la colección, no del elemento). Es la forma correcta de declarar una entrada por lotes — nunca `type: json` con la cota escrita en prosa. `required: true` sobre un campo `list` significa "presente y no vacío".
- **Una cota se declara en un solo sitio.** Lo que va en `constraints` (o en `required`) lo hace cumplir la validación de forma del generador, que responde con un error genérico de petición mal formada, **sin** `code` de negocio. Si el diseño quiere que esa cota falle con un `code` propio y estable —`EMPTY_ID_LIST`, `TOO_MANY_IDS`—, la cota va como `preconditions` en prosa y **no** como `constraints`: declarar las dos cosas deja el `code` inalcanzable, porque la validación de forma corre antes.
- En un `input` con forma `{ entity: X }`, los campos `generated` y `computed` de la entidad quedan implícitamente fuera: nunca los envía el cliente.
- En los outputs y eventos, los campos `sensitive` de la entidad quedan excluidos por defecto; `exclude` recorta además campos concretos de esa operación (`keel validate` comprueba que existen en la entidad). Para exponer un campo sensible hay que declararlo explícitamente con la forma `{ fields: {...} }`.
- `exclude` admite **dot-paths** para no exponer un campo de una **entidad hija** o de un **value object** anidado (`output: { entity: Order, exclude: [internalNote, lines.costPrice, address.zip] }`). Cada segmento intermedio debe ser una relación (entidad hija) o un value object compuesto; el último, un campo o relación de la entidad/tipo alcanzado. Un dot-path que cruza a otro agregado (relación serializada por id, sin anidamiento) es un warning: no hay nada anidado que excluir.
- `embed` (solo en `output`) proyecta una relación hacia **otro agregado** como objeto anidado en vez de como `<relación>Id`: `output: { entity: Product, embed: [category] }` devuelve `"category": { … }` en lugar de `"categoryId": "…"`. Es la forma de declarar que el consumidor necesita la referencia resuelta y no un id que le obligue a una segunda llamada. Reglas: el destino debe ser la **raíz** de un agregado (una entidad hija ya se proyecta anidada por defecto) y la relación `many-to-one`/`one-to-one`; la auto-referencia es válida (`Category.parent → Category`: apunta a otra instancia, que es su propio agregado). El objeto embebido lleva los campos propios del agregado referenciado **sin sus relaciones**: la proyección se corta a profundidad 1 y no encadena agregado tras agregado.
  - **Coherencia entre operaciones**: `keel validate` avisa cuando unas operaciones que devuelven la misma entidad resuelven una referencia con `embed` y otras la dejan como `<relación>Id` plano. No es un error —proyectar más liviano en un listado que en el detalle es una decisión legítima— pero tiene que ser una decisión: el caso típico es un `getX` con `embed` y un `listX` al que se le olvidó, y el consumidor del listado se queda con un id que le obliga a una segunda llamada. Un `exclude` de esa misma relación no cuenta como asimetría: dejarla fuera del payload es explícito.
- `sort` (solo en `output`, y solo con `list` o `paginated`) declara el **orden por defecto** de la salida: `output: { entity: Product, paginated: true, sort: [name:asc, createdAt:desc] }`. La dirección es opcional (`asc` por defecto), así que `sort: [name]` es válido.
  - Es **contrato**, no una preferencia de implementación: es lo que recibe quien no pide un orden concreto. Un cliente puede seguir pidiendo otro orden si la API lo permite, igual que `pagination.maxSize` acota el tamaño que pide; lo que no puede es quedarse sin orden.
  - **El id del agregado se añade siempre como último criterio de desempate**, se declare `sort` o no. Sin él, dos páginas consecutivas de la misma consulta pueden repetir u omitir filas: la base de datos no garantiza un orden estable entre consultas cuando el `ORDER BY` empata. Por eso un listado sin `sort` no queda sin orden — queda ordenado por id.
  - **No declararlo avisa.** `keel validate` avisa de toda salida `list`/`paginated` sin `sort`. No es un error: aceptar el orden por id es una decisión legítima. Pero tiene que ser una **decisión**, y el default correcto es justo lo que la esconde — nada se rompe y nada se nota hasta que alguien afirma otro orden en un sitio donde ningún schema lo contrasta (la prosa de `validation-scenarios.md`, o el adaptador que el generador improvisa porque tiene que escribir algo). Es el mismo razonamiento que la coherencia de `embed`: el aviso no persigue una errata, persigue una decisión sin tomar.
  - Un **dot-path** ordena por un campo de otro agregado (`sort: [brand.name:asc]`) y **exige que esa relación esté en `embed`** del mismo payload: ordenar por algo que la respuesta no devuelve deja al consumidor sin poder explicarse el orden que recibe. También admite un subcampo de un value object compuesto (`total.amount`). La profundidad se corta en 1, igual que `embed`.
  - No se puede ordenar por una colección (`list: true`): no define un orden por columna.
- `preconditions` son sobre el estado del mundo; `rules` describen el comportamiento en orden.
- Cada `error` tiene un `code` estable (contrato con integradores), su condición `when` y opcionalmente el status `http`.
- `emits`: eventos publicados — deben existir en `messaging: publishing.events`. Es la única referencia hacia delante permitida: mientras la capa messaging no esté diseñada, `keel validate --wip` la reporta como pendiente (aviso); sin `--wip` es error.

## Políticas del caso de uso

- `idempotency: { keySource: client-key | payload-hash | payload-field, keyField, ttlSeconds }` — que **repetir la petición** no produzca efectos duplicados. `keySource` dice de dónde sale la clave, y eso decide por qué puertas sirve:

  - **`client-key`** — la manda el cliente en la cabecera `Idempotency-Key`. Solo entra por la superficie HTTP, así que **solo tiene sentido en una operación con endpoint**; y si esa operación además la dispara una suscripción, es **error**: el broker no manda cabeceras, así que la mitad de las entradas se ejecutaría sin deduplicar.
  - **`payload-hash`** — se deriva del contenido de la petición. Tampoco viaja por transporte, pero hace indistinguibles dos peticiones legítimamente idénticas (el mismo aviso enviado dos veces a propósito).
  - **`payload-field`** — la clave **es un campo del contrato**, el que nombra `keyField`. Es la única que llega por igual desde HTTP y desde el canal de eventos, y por tanto la única que cubre una operación con dos disparadores. Se nombra el campo en vez de adivinarlo: cuál identifica la petición es del diseño.

  Con `payload-field` hay además una consecuencia que el diseño no declara sino que **provoca**: si ese campo participa en la `naturalKey` del agregado que la operación escribe, esa constraint ya es la guarda —permanente y común a todas las puertas—, y el generador no emite ningún registro de claves. Es la salida que antes existía pero el DSL no veía.

  Lo que sigue valiendo para las tres: declararla en una operación interna o disparada por evento con `client-key` es error en `keel validate`, porque la clave llega por una puerta que esa operación no tiene. Declararla no la hace obligatoria: sin cabecera el generador ejecuta la operación **sin deduplicar**, porque rechazarla exigiría un `code` público y este campo no lo declara. Si el contrato es que sea obligatoria, decláralo como un error más de la operación (`{ code: IDEMPOTENCY_KEY_REQUIRED, when: …, http: 400 }`): `errors` es el único sitio donde nace un `code` **de negocio**.

  **Los dos conflictos del mecanismo, en cambio, ya tienen nombre.** Encender `idempotency` trae consigo dos desenlaces que el cliente ve y que no los provoca la lógica de la operación sino el propio mecanismo: dos peticiones con la misma clave **a la vez** (`409 IDEMPOTENCY_KEY_IN_PROGRESS`) y la misma clave con un contenido **distinto** (`409 IDEMPOTENCY_KEY_REUSED`). Los pone el generador con el código canónico de `framework-errors.md`, así que no hay que declararlos ni hay que inventarlos — antes de que ese catálogo existiera, cada generación elegía el suyo y el mismo diseño producía contratos públicos distintos. Si el contrato de tu servicio los nombra de otra manera, decláralos en `errors` con un `code` de su familia y el mismo status: el generador usa el tuyo. `keel validate` avisa —sin exigir nada— cuando la operación no los nombra, para que el contrato se vea en el diseño y no solo en el código generado.

  **No confundir con la reentrega de un evento**, que es el otro eje de repetición y tiene su propio mecanismo: un mensaje que el broker entrega dos veces se ataja con `contract.messageId` en `messaging: subscriptions` (o con una `transitions` irrepetible). Son dos cosas distintas hasta en el código generado —dos tablas, `idempotency_record` y `processed_event`—, y `idempotency` no protege la segunda.

  **Ni con el reintento que hacemos nosotros**, que es el tercero: cuando esta operación encarga trabajo a otro servicio y ese canal reintenta, quien duplica el efecto somos nosotros al otro lado. Eso se declara en `http-clients.calls.<c>.idempotency`, y `keel validate` avisa de un `retry` sobre una escritura ajena que no lo declare.

  **Cuándo la echa de menos `keel validate`.** No en todo command expuesto: en el que repetirlo saca el efecto **fuera del proceso**. Un command `POST` o `PATCH` que `emits` un evento o que encarga trabajo a un proveedor (`triggeredBy` de alguna activación), sin `idempotency` y sin una transición irrepetible, es aviso — un reenvío del llamante publica dos veces o pide dos veces el trabajo, y eso ya salió del servicio: ninguna clave natural de `persistence` lo desanda. `PUT` y `DELETE` quedan fuera porque el propio protocolo los define idempotentes, y un efecto que no sale del proceso también, porque ahí una clave natural sí es una salida legítima que el DSL no puede ver.

  **`ttlSeconds` no se contrasta con nada** (límite declarado de la validación mecánica). Es cuánto tiempo se recuerda una clave, y nada del DSL dice cuánto tarda un cliente en reintentar, así que ninguna regla puede juzgar si el plazo da de sí. El criterio es de negocio: tiene que cubrir con holgura la ventana de reintento del llamante más lento — un móvil que recupera cobertura, un job nocturno que reencola lo que falló.

  **Qué se reproduce en la repetición.** El contrato no es rechazar el duplicado sino devolver la respuesta original, y lo que se guarda de la primera ejecución es el id del recurso creado. Con eso se reconstruye la ficha de una entidad; una **lista** o una **página**, no: dependen del estado del resto del sistema al responder, y para la segunda llamada ya cambió. `keel validate` lo avisa.
- `cache: { ttlSeconds, keyFields, invalidatedBy: [Evento, ...] }` — solo para queries; `invalidatedBy` referencia eventos de messaging. Si el `output` declara `embed`, la caché proyecta **otro agregado** dentro de la respuesta y ese agregado también tiene que poder invalidarla: `keel validate` da **error** si ningún evento de la entidad embebida está en `invalidatedBy` (y avisa de los eventos de la entidad principal que falten). Sin esa regla, un cambio en la marca embebida en la ficha de producto no se ve hasta que expira el TTL, y nada en el diseño lo delata.
- `schedule: { cron }` — trigger temporal, único trigger que se declara aquí.
- `transitions: [{ entity, from: [estado, ...], to: estado }]` — las transiciones del `lifecycle` de `domain` que **esta** operación ejecuta. Solo en commands.

### `transitions` — qué mueve la operación en la máquina de estados

```yaml
retireProduct:
  kind: command
  transitions:
    - entity: Product
      from: [active]
      to: retired
```

Es el **único enlace del DSL** entre un caso de uso y el `lifecycle` de una entidad, que hasta ahora solo existía en prosa (`rules`). Y no es documentación: el generador deriva del `lifecycle` un guard que rechaza cualquier cambio de estado no declarado, así que una operación que necesita una arista que la máquina de estados no tiene **no falla al generar — falla en cada ejecución**. `keel validate` da error si la entidad no existe, si no declara `lifecycle`, si algún estado no es valor del enum, o si la transición `from` → `to` no está en `domain: <entidad>.lifecycle.transitions`. La inversa es aviso: una transición declarada en `domain` que ninguna operación ejecuta no es contrato, es intención.

`from` es una lista porque un mismo command puede aplicarse desde varios orígenes (`[pending, reserved] → cancelled`). No se declaran las transiciones de **creación**: el estado inicial es el `default` del campo enum, no una arista.

Hay un segundo efecto, y es el que importa en una **compensación**: una transición cuyo `to` **no** está entre sus propios `from` es irrepetible por construcción — al segundo intento la entidad ya está en el destino y el guard lo rechaza. Por eso vale como uno de los dos mecanismos con los que una compensación demuestra que no se puede aplicar dos veces (el otro es `contract.messageId` en la suscripción; `idempotency` **no** sirve para eso, ver abajo).

`idempotency` y `cache` son **decisiones estructurales**: fijan lo que el servicio garantiza (qué se puede repetir sin daño, qué puede llegar rancio), así que las decide el diseñador y no el agente. El agente recomienda con su porqué y pregunta; nunca las escribe en silencio. Ejes de decisión, consecuencias observables y trampas: `references/structural-decisions.md` de la skill `keel-design` §3.2 y §3.3.

## Triggers: quién activa cada operación

La capa que expone la operación la referencia por nombre:

| Trigger | Se declara en |
|---------|---------------|
| Petición HTTP del cliente | `api` → `endpoints` (o `auto: true`) |
| Evento del broker | `messaging` → `subscriptions.<Evento>.triggers` |
| Temporal | aquí, con `schedule` |
| Solo interna | aquí, con `internal: true` |

Una operación sin ninguno de los cuatro es **huérfana**: `keel validate` la reporta como warning.
