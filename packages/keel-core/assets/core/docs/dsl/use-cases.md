# Capa `use-cases` — casos de uso (obligatoria)

Archivo: `specs/<servicio>/use-cases.keel.yaml` · Schema: [`schema/use-cases.schema.json`](../../schema/use-cases.schema.json)

Cada operación es un caso de uso completo: qué recibe, qué devuelve, qué reglas aplica, qué puede fallar y qué eventos emite. Aquí viven también las políticas que son **semántica del caso de uso** — idempotencia, caché y schedule — porque valen igual lo invoque REST o un evento.

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

  reconcilePrices:
    description: Reconcilia precios contra el servicio de pricing cada noche.
    kind: command
    input: "void"
    output: "void"
    schedule: { cron: "0 3 * * *" }
```

## Campos

- `kind`: `command` (muta estado) o `query` (solo lee). Default `command`.
- `input`/`output` admiten tres formas: `"void"`, `{ fields: {...} }`, o `{ entity: Product }` con opcionales `list`, `paginated`, `exclude: [...]`.
- En un `input` con forma `{ entity: X }`, los campos `generated` y `computed` de la entidad quedan implícitamente fuera: nunca los envía el cliente.
- En los outputs y eventos, los campos `sensitive` de la entidad quedan excluidos por defecto; `exclude` recorta además campos concretos de esa operación (`keel validate` comprueba que existen en la entidad). Para exponer un campo sensible hay que declararlo explícitamente con la forma `{ fields: {...} }`.
- `preconditions` son sobre el estado del mundo; `rules` describen el comportamiento en orden.
- Cada `error` tiene un `code` estable (contrato con integradores), su condición `when` y opcionalmente el status `http`.
- `emits`: eventos publicados — deben existir en `messaging: publishing.events`. Es la única referencia hacia delante permitida: mientras la capa messaging no esté diseñada, `keel validate --wip` la reporta como pendiente (aviso); sin `--wip` es error.

## Políticas del caso de uso

- `idempotency: { keySource: client-key | payload-hash, ttlSeconds }` — la operación puede repetirse sin efectos duplicados. Obligatoria de considerar en commands disparados por subscriptions con reintentos.
- `cache: { ttlSeconds, keyFields, invalidatedBy: [Evento, ...] }` — solo para queries; `invalidatedBy` referencia eventos de messaging.
- `schedule: { cron }` — trigger temporal, único trigger que se declara aquí.

## Triggers: quién activa cada operación

La capa que expone la operación la referencia por nombre:

| Trigger | Se declara en |
|---------|---------------|
| Petición HTTP del cliente | `api` → `endpoints` (o `auto: true`) |
| Evento del broker | `messaging` → `subscriptions.<Evento>.triggers` |
| Temporal | aquí, con `schedule` |
| Solo interna | aquí, con `internal: true` |

Una operación sin ninguno de los cuatro es **huérfana**: `keel validate` la reporta como warning.
