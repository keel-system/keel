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
  optimisticLocking: all                 # all | declared | none
```

- Cada clave de `entities` debe existir en `domain` (referencia por nombre, validada por `keel validate`).
- `naturalKey`: campos que identifican la entidad para el negocio, además del `id` técnico.
- `indexes`: índices sugeridos por los patrones de consulta de `use-cases`; cada índice es la lista de miembros que lo componen.
- Los miembros de `naturalKey` e `indexes` nombran, en ambos casos: un **campo** (`sku`), una **relación** —indistintamente por su nombre (`category`) o con el sufijo del id (`categoryId`)— o el **subcampo de un value type compuesto** con dot-path (`price.amount`). El generador resuelve la columna real; `keel validate` comprueba que el miembro existe en la entidad de `domain`.
- `consistency.transactionalBoundary` es la frontera que el generador debe respetar; si `messaging` declara `reliability: outbox`, la escritura del evento comparte esta frontera.
- `per-aggregate`: cada transacción abarca como máximo un agregado declarado en `domain: aggregates` (raíz + entidades internas). Exige que `domain` los declare — `keel validate` lo comprueba. `per-operation`: la transacción es la operación completa, sin frontera de agregado.
- **La frontera la decide el diseñador**, no el agente: con `per-aggregate` un cambio puede confirmar y el otro no, y eso es consistencia eventual aceptada — una decisión de negocio, no un ajuste de rendimiento. Ejes de decisión: `.claude/skills/keel-design/references/structural-decisions.md` §3.7.
- `consistency.optimisticLocking` decide qué pasa cuando **dos escrituras concurrentes** caen sobre la misma raíz de agregado. También es decisión de negocio, y también observable: cambia el status que ve el cliente.
  - `all` (por defecto): toda raíz de agregado lleva control de versión. Una escritura sobre una versión obsoleta es un **conflicto** y el cliente recibe un error de concurrencia (en HTTP, `409`), no un éxito silencioso. Es lo correcto cuando perder una edición ajena tiene coste: inventario, saldos, estados con máquina de transiciones.
  - `declared`: solo las raíces que declaren el campo reservado **`lockVersion`** en `domain`. Útil cuando conviven agregados con y sin necesidad de conflicto. El campo se declara en la raíz del agregado y lo lleva la infraestructura, nunca el cliente:

    ```yaml
    entities:
      Product:
        fields:
          lockVersion: { type: int, generated: true }
    ```

    `lockVersion` es el **único nombre** que reconoce esta política: es una convención del método, no un nombre libre. `keel validate` avisa si `declared` no encuentra ninguna raíz que lo declare, porque tal como queda el diseño es indistinguible de `none`.
  - `none`: **último escritor gana**. Ninguna escritura falla por concurrencia y la última en confirmar prevalece. Es una decisión legítima —una edición de ficha de catálogo, una preferencia de usuario— pero deliberada: se acepta perder la escritura intermedia.
- La elección tiene que ser **coherente con `validation-scenarios.md`**: un escenario que ejercita dos mutaciones concurrentes y espera dos respuestas de éxito exige `none`; uno que espera un conflicto exige `all` o `declared`. Declararlo en prosa dentro de `rules` no basta — ningún generador lee prosa, y el resultado es un servidor que contradice su propio escenario.

## Qué NO va aquí

- La forma de las entidades (campos, tipos, invariantes) → capa `domain`.
- Caché de resultados de queries → `use-cases` (`cache`).
