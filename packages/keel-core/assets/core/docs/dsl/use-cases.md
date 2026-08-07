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
  - Un **dot-path** ordena por un campo de otro agregado (`sort: [brand.name:asc]`) y **exige que esa relación esté en `embed`** del mismo payload: ordenar por algo que la respuesta no devuelve deja al consumidor sin poder explicarse el orden que recibe. También admite un subcampo de un value object compuesto (`total.amount`). La profundidad se corta en 1, igual que `embed`.
  - No se puede ordenar por una colección (`list: true`): no define un orden por columna.
- `preconditions` son sobre el estado del mundo; `rules` describen el comportamiento en orden.
- Cada `error` tiene un `code` estable (contrato con integradores), su condición `when` y opcionalmente el status `http`.
- `emits`: eventos publicados — deben existir en `messaging: publishing.events`. Es la única referencia hacia delante permitida: mientras la capa messaging no esté diseñada, `keel validate --wip` la reporta como pendiente (aviso); sin `--wip` es error.

## Políticas del caso de uso

- `idempotency: { keySource: client-key | payload-hash, ttlSeconds }` — el **reintento del llamante HTTP** no produce efectos duplicados. `keySource` dice de dónde sale la clave, pero en ambos casos entra por la superficie HTTP (la cabecera `Idempotency-Key`), así que **solo tiene sentido en una operación con endpoint**: declararla en una operación interna o disparada por evento es error en `keel validate`, porque la clave llega por una puerta que esa operación no tiene. Declararla no la hace obligatoria: sin cabecera el generador ejecuta la operación **sin deduplicar**, porque rechazarla exigiría un `code` público y este campo no lo declara. Si el contrato es que sea obligatoria, decláralo como un error más de la operación (`{ code: IDEMPOTENCY_KEY_REQUIRED, when: …, http: 400 }`): `errors` es el único sitio donde nace un `code` del contrato.

  **No confundir con la reentrega de un evento**, que es el otro eje de repetición y tiene su propio mecanismo: un mensaje que el broker entrega dos veces se ataja con `contract.messageId` en `messaging: subscriptions` (o con una `transitions` irrepetible). Son dos cosas distintas hasta en el código generado —dos tablas, `idempotency_record` y `processed_event`—, y `idempotency` no protege la segunda.
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
