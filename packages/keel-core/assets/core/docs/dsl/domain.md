# Capa `domain` — modelado del dominio (obligatoria)

Archivo: `specs/<servicio>/domain.keel.yaml` · Schema: [`schema/domain.schema.json`](../../schema/domain.schema.json)

Value types, entidades, agregados, relaciones, ciclo de vida e invariantes. Es la base de todas las demás capas: use-cases referencia sus entidades y tipos; persistence decide cómo se guardan.

## `types` — value types

Tipos con semántica de negocio, definidos una vez y reutilizados en entidades, operaciones y eventos. Nombres en `PascalCase` y **en inglés** — como todo identificador del DSL (regla transversal de `dsl-reference.md`); las `description` van en español. Admiten tres formas:

```yaml
types:
  SKU:                          # escalar: tipo base + restricciones
    base: string
    description: Identificador comercial único del producto.
    constraints: { pattern: "^[A-Z0-9]{4,20}$" }

  ProductStatus:                # enum nominal
    values: [draft, active, retired]

  Money:                        # value object compuesto
    fields:
      amount:   { type: decimal, required: true, constraints: { min: 0, scale: 2 } }
      currency: { type: string, required: true, constraints: { pattern: "^[A-Z]{3}$" } }
```

- **Escalar** (`base` + `constraints`): un tipo base con restricciones y nombre de negocio.
- **Enum nominal** (`values`): conjunto cerrado de valores, reutilizable donde haga falta. Para un enum de un solo uso sigue valiendo el inline en el campo (`type: enum, values: [...]`).
- **Value object compuesto** (`fields`): varios campos que viajan juntos y no tienen identidad propia (Money, Address). Cómo se persiste (embebido, columnas, tabla) lo decide la capa `persistence` al generar.

Tipos base disponibles: `string`, `text`, `int`, `long`, `decimal`, `boolean`, `uuid`, `date`, `timestamp`, `json`, `file`.

El tipo `file` modela un archivo binario (foto, PDF, adjunto). Exige el atributo `bucket`, que referencia un bucket lógico declarado en la capa [`storage`](storage.md) (`type: file, bucket: productImages`). El campo guarda la referencia al objeto, no el binario en sí; el dónde y cómo se almacena lo decide `storage` (agnóstico del proveedor).

## `entities`

```yaml
entities:
  Product:
    description: Artículo vendible del comercio.
    fields:
      id:        { type: uuid, id: true, generated: true }
      sku:       { type: SKU, required: true, unique: true }
      name:      { type: string, required: true, constraints: { maxLength: 120 } }
      price:     { type: Money, required: true }
      slug:      { type: string, computed: Se deriva del name normalizado a kebab-case. }
      apiToken:  { type: string, sensitive: true }
      status:    { type: ProductStatus, default: draft }
      createdAt: { type: timestamp, generated: true }
    relations:
      catalog: { entity: Catalog, cardinality: many-to-one }
    lifecycle:
      field: status
      transitions:
        draft:   [active, retired]
        active:  [retired]
        retired: []
    invariants:
      - Un producto active siempre tiene price mayor que cero.
      - Solo productos active son visibles para consumidores externos.

  Catalog:
    description: Agrupación comercial de productos.
    fields:
      id:   { type: uuid, id: true, generated: true }
      slug: { type: string, required: true, unique: true }
      name: { type: string, required: true }
```

Atributos de campo:

| Atributo | Significado |
|----------|-------------|
| `type` | Tipo base, value type de `types`, o `enum` (exige `values`) |
| `bucket` | Solo (y obligatorio) con `type: file`: bucket de la capa `storage` donde vive el archivo |
| `required` | El campo debe tener valor al crear |
| `unique` | No pueden existir dos registros con el mismo valor |
| `id` | Identificador de la entidad (exactamente uno por entidad) |
| `generated` | Lo asigna la infraestructura (ids, timestamps); nunca lo envía el cliente |
| `computed` | Lo deriva una regla de dominio a partir de otros campos (la regla es el valor del atributo); nunca lo envía el cliente. Excluyente con `generated` |
| `sensitive` | Nunca sale en outputs ni eventos por defecto; solo si un payload lo pide explícitamente vía `fields` |
| `default` | Valor si el cliente no lo provee |
| `constraints` | `min`, `max`, `minLength`, `maxLength`, `pattern`, `scale` |

## `aggregates` — fronteras de consistencia

Un agregado (DDD) agrupa una entidad **raíz** con las entidades internas que cambian siempre con ella en la misma transacción. Un servicio puede tener varios agregados; cada uno declara su raíz y sus entidades internas:

```yaml
aggregates:
  Catalog:
    description: El catálogo posee sus productos; se modifican juntos.
    root: Catalog
    entities: [Product]
```

Reglas semánticas del agregado:

- La **raíz es el único punto de entrada**: toda operación sobre el agregado pasa por ella.
- Las **entidades internas no se referencian desde fuera** del agregado; desde otro agregado se referencia solo la raíz, por id.
- Las **invariantes no cruzan fronteras**: una invariante solo puede depender de campos del propio agregado. La consistencia entre agregados es eventual, vía eventos.
- El agregado es la **unidad transaccional**: es lo que `persistence` respeta con `transactionalBoundary: per-aggregate`, y con lo que el outbox de `messaging` comparte transacción.

El bloque es **opcional**: un servicio sin `aggregates` se comporta como hasta ahora (cada entidad es su propia frontera implícita). Si el servicio tiene más de una entidad y algunas cambian siempre juntas, decláralo.

`keel validate` comprueba que la raíz y las entidades internas existen, que ninguna entidad pertenece a dos agregados, que la raíz no se repite en `entities`, y avisa si una relación apunta a una entidad interna de otro agregado o si, habiendo agregados, una entidad queda fuera de todos.

## `lifecycle` — ciclo de vida

Máquina de estados de la entidad sobre un campo enum (inline o nominal). **Solo las transiciones listadas son válidas**: el generador deriva las guardas mecánicamente y rechaza cualquier cambio de estado no declarado. Un array vacío marca un estado terminal.

```yaml
lifecycle:
  field: status
  transitions:
    draft:   [active, retired]
    active:  [retired]
    retired: []
```

`keel validate` comprueba que `field` existe y es enum, que todo estado origen y destino pertenece a los valores del enum, y avisa si un valor del enum no declara sus transiciones.

Las **invariantes** quedan para las reglas que no se pueden expresar como transición (condiciones sobre otros campos, reglas cruzadas). Escritas en lenguaje natural declarativo y verificable: el generador las traduce a validaciones; el humano las revisa como frases.

## Qué NO va aquí

- Cómo se persisten las entidades (índices, claves naturales, VO embebidos o en tabla) → capa `persistence`.
- Cómo se aplica la frontera transaccional del agregado → capa `persistence` (`transactionalBoundary: per-aggregate`); aquí solo se declara la frontera.
- Qué operaciones las manipulan → capa `use-cases`.
- Qué campos devuelve cada operación → forma del payload en `use-cases` (`exclude`); aquí solo se marca lo estructural (`sensitive`).
