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
    indexes:
      # Unicidad CONDICIONADA: como máximo un catálogo publicado por slug, sin
      # impedir que convivan las versiones retiradas con ese mismo slug.
      - fields: [slug]
        unique: true
        when: { field: status, equals: published }

audit:
  timestamps: all                        # all | declared | none
  authorship: none                       # all | declared | none

consistency:
  transactionalBoundary: per-operation   # per-operation | per-aggregate
  optimisticLocking: all                 # all | declared | none
```

- Cada clave de `entities` debe existir en `domain` (referencia por nombre, validada por `keel validate`).
- `naturalKey`: campos que identifican la entidad para el negocio, además del `id` técnico.
- `indexes`: índices sugeridos por los patrones de consulta de `use-cases`; cada índice es la **lista de miembros** que lo componen (forma corta) o un **objeto** que además declara unicidad y la condición bajo la que aplica (ver «Unicidad condicionada» más abajo).
- **Unicidad condicionada** (`{ fields, unique: true, when: { field, equals } }`): la segunda forma de un elemento de `indexes`, para el invariante que la forma corta no sabe expresar. «Como máximo **una versión activa** por clave» no es una unicidad de columnas: con `unique` a secas sobre `[application, key, locale]` no podrías tener nunca dos versiones, y sin nada la ventana de dos publicaciones simultáneas queda abierta — la comprobación previa del caso de uso produce el error de negocio en el caso normal, pero no cierra esa ventana.

  ```yaml
  indexes:
    - fields: [application, key, locale]
      unique: true
      when: { field: status, equals: active }   # solo las filas con status = active
  ```

  - `unique: true` es **obligatorio** con `when`: un índice condicionado que no restringe nada solo acelera consultas, y para eso la condición sobra. El schema lo exige.
  - La condición es `campo = valor` y nada más — sin `AND`, sin comparaciones, sin expresiones. Una condición libre sería SQL dentro del diseño, y el diseño es agnóstico del motor. `equals` admite una cadena, un número o un booleano.
  - Si el campo es un **enum**, `equals` tiene que ser uno de sus valores declarados, escrito **igual que en `domain`** (`active`, no `ACTIVE`: la traducción al valor que guarda el motor es cosa del generador). `keel validate` da **error** si no lo es, y no es celo: un valor que el enum no tiene produce un índice que se crea sin fallar y no casa con ninguna fila, así que el invariante queda sin efecto **en silencio** — no lo delata el arranque, ni las migraciones, ni ningún escenario, porque la ausencia de un rechazo no rompe ninguna prueba.
  - **No todos los motores lo sostienen**, y eso cambia lo que el invariante vale: PostgreSQL (índice parcial) y SQL Server (índice filtrado) sí; en MySQL, MariaDB y Oracle el generador **avisa** y la garantía se queda entera en el caso de uso, que no cierra la ventana de concurrencia. Declararlo sigue mereciendo la pena —el aviso es lo que hace visible la decisión— pero si esa ventana importa, el motor es parte del diseño y no solo del despliegue.
  - El objeto admite además `description`, para dejar escrito el invariante en las palabras del negocio.
- **El barrido de una reconciliación es el patrón de consulta que se escapa de ese criterio**, porque no está en `use-cases` como una operación que alguien invoca: es un `schedule`. Una entidad con `reconciledBy` (ver `dependencies`) se consulta cada N minutos con el mismo predicado —`<campo de lifecycle> = '<espera>' AND <awaitingSince> < <umbral>` —el campo que la activación declara en `awaitingSince`—— y quiere su índice compuesto, en ese orden: **la igualdad primero y el rango después**, que es lo único que un B-tree aprovecha entero. Al revés, o con un índice solo sobre el estado, la base filtra por estado y evalúa la marca fila a fila. Mientras la espera sea corta y poco poblada no se nota; cuando el estado acumula —o cuando no es selectivo, porque la mayoría de las filas está ahí— pasa a ser un recorrido de la tabla de negocio cada N minutos, compitiendo con el tráfico real. Es un fallo que ninguna prueba ve, porque en pruebas la tabla tiene diez filas. Por eso `keel validate` **avisa** cuando ninguno de los `indexes` de una entidad que un barrido barre empieza por su campo de lifecycle: es lo único de este apartado que se puede comprobar mecánicamente, y el único aviso del método que habla de coste y no de corrección.
- Los miembros de `naturalKey` e `indexes` nombran, en ambos casos: un **campo** (`sku`), una **relación** —indistintamente por su nombre (`category`) o con el sufijo del id (`categoryId`)— o el **subcampo de un value type compuesto** con dot-path (`price.amount`). El generador resuelve la columna real; `keel validate` comprueba que el miembro existe en la entidad de `domain`.
- Con `default.model: document` hay una forma más: el **campo de una entidad del mismo agregado** con dot-path (`sections.status`). Solo ahí tiene sentido, y es una consecuencia directa del modelo: en el documental la entidad hija va anidada dentro del registro de su raíz, así que es una ruta real de ese registro; en el relacional vive en otra tabla y ningún índice la alcanza. Lo que **no** cambia con el modelo es la frontera del agregado: de un agregado ajeno solo se guarda su id, así que `customer.email` es error en los dos —índexa por `customerId`, o por un campo propio—.
- `audit` decide **qué se registra automáticamente de cada escritura**, en dos ejes independientes: `timestamps` (cuándo se creó y modificó la fila) y `authorship` (quién). Cada uno toma `all`, `declared` o `none`.
  - `all`: toda entidad persistida lo lleva. Las columnas las pone la infraestructura, **no se nombran en `domain`** y no aparecen en ningún contrato: existen para operar y auditar, no para que las lea un cliente. Es el defecto de `timestamps`.
  - `declared`: solo las entidades que declaren los **campos reservados** en `domain`. Es la política a elegir cuando la auditoría es parte del contrato — al estar en `domain`, los `output` que la proyecten la devuelven al cliente. Los nombres son fijos y llevan siempre `generated: true`, porque los asigna la infraestructura y jamás pueden venir del cliente:

    ```yaml
    entities:
      Product:
        fields:
          createdAt: { type: timestamp, generated: true }
          updatedAt: { type: timestamp, generated: true }
          createdBy: { type: string, generated: true }
          updatedBy: { type: string, generated: true }
    ```

  - `none`: no se registra nada. Es el defecto de `authorship`.
  - **Un eje se declara de una sola forma**: nombrar un campo reservado bajo `all` o `none` es un error de validación, igual que elegir `declared` y no declarar ninguno. Lo que decide si la columna existe es la política, nunca cómo se llamen los campos.
  - `authorship` distinto de `none` **exige la capa `security`**: el autor es el principal autenticado. Sin ella no hay actor y `keel validate` lo rechaza; para la trazabilidad puramente técnica ya está el correlation id, que todo generador propaga sin que el diseño lo pida. En las escrituras que no nacen de una petición (relay de eventos, procesos programados) no hay principal: el generador registra un valor centinela, no `null`.
- `consistency.transactionalBoundary` es la frontera que el generador debe respetar; si `messaging` declara `reliability: outbox`, la escritura del evento comparte esta frontera.
- `per-aggregate`: cada transacción abarca como máximo un agregado declarado en `domain: aggregates` (raíz + entidades internas). Exige que `domain` los declare — `keel validate` lo comprueba. `per-operation`: la transacción es la operación completa, sin frontera de agregado.
- **La frontera la decide el diseñador**, no el agente: con `per-aggregate` un cambio puede confirmar y el otro no, y eso es consistencia eventual aceptada — una decisión de negocio, no un ajuste de rendimiento. Ejes de decisión: `references/structural-decisions.md` de la skill `keel-design` §3.7.
- `consistency.optimisticLocking` decide qué pasa cuando **dos escrituras concurrentes** caen sobre la misma raíz de agregado. También es decisión de negocio, y también observable: cambia el status que ve el cliente.
  - `all` (por defecto): toda raíz de agregado lleva control de versión. Una escritura sobre una versión obsoleta es un **conflicto** y el cliente recibe un error de concurrencia —`409 CONCURRENT_MODIFICATION`, el código canónico de `framework-errors.md`—, no un éxito silencioso. Ese código es contrato público aunque el diseño no lo declare; para usar otro, declara en `errors` un `code` de su familia con status `409` y el generador usará el tuyo. Es lo correcto cuando perder una edición ajena tiene coste: inventario, saldos, estados con máquina de transiciones.
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
