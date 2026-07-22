# Capa `persistence` — base de datos (opcional)

Archivo: `specs/<servicio>/persistence.keel.yaml` · Schema: [`schema/persistence.schema.json`](../../schema/persistence.schema.json)

Cómo se persisten las entidades del dominio. Agnóstica del motor: se declara el **modelo de almacenamiento** (`relational`, `document`, `key-value`), nunca el producto (PostgreSQL, MongoDB…). Un servicio sin estado propio no declara esta capa.

```yaml
default:
  model: relational              # relational | document | key-value

entities:
  Product:
    persisted: true
    naturalKey: [sku]
    indexes: [[status], [catalogId, status]]
  Catalog:
    naturalKey: [slug]

consistency:
  transactionalBoundary: per-operation   # per-operation | per-aggregate
```

- Cada clave de `entities` debe existir en `domain` (referencia por nombre, validada por `keel validate`).
- `naturalKey`: campos que identifican la entidad para el negocio, además del `id` técnico.
- `indexes`: índices sugeridos por los patrones de consulta de `use-cases`; cada índice es la lista de campos que lo componen.
- `consistency.transactionalBoundary` es la frontera que el generador debe respetar; si `messaging` declara `reliability: outbox`, la escritura del evento comparte esta frontera.
- `per-aggregate`: cada transacción abarca como máximo un agregado declarado en `domain: aggregates` (raíz + entidades internas). Exige que `domain` los declare — `keel validate` lo comprueba. `per-operation`: la transacción es la operación completa, sin frontera de agregado.

## Qué NO va aquí

- La forma de las entidades (campos, tipos, invariantes) → capa `domain`.
- Caché de resultados de queries → `use-cases` (`cache`).
