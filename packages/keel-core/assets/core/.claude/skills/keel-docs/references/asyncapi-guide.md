# Guía de `asyncapi.yaml`

Formato exacto del contrato asíncrono que `/keel-docs` escribe en `docs/<service.name>/asyncapi.yaml`.
Es el análogo de `openapi.yaml` para lo que no viaja por HTTP: **AsyncAPI 3.0.0**, derivado
mecánicamente de `messaging` (+ `domain` para los tipos y `service` para la identidad). Si algo no se
puede derivar, es un hueco del diseño: repórtalo, no lo inventes.

**Sin capa `messaging` declarada no hay nada que escribir**: no generes el archivo ni `asyncapi.html`,
y repórtalo.

## Mapeo capa → documento

| Del diseño | Al documento |
|---|---|
| `service.name` / `version` / `description` | `info.title` / `info.version` / `info.description` |
| `messaging.channels.<c>` | `channels.<c>` (`address` = nombre lógico) |
| `channels.<c>.external: true` | `x-keel-external: true` en el canal |
| `publishing.events.<E>` | `components.messages.<E>` + `operations.publish<E>` (`action: send`) |
| `publishing.events.<E>.payload` | `components.schemas.<E>Payload` |
| `publishing.reliability: outbox` | `x-keel-reliability: outbox` en cada operación `send` |
| `use-cases` con `emits: [E]` | `x-keel-emitted-by: [<operación>, …]` en la operación `send` |
| `subscriptions.<E>` | `components.messages.<E>` + `operations.consume<E>` (`action: receive`) |
| `subscriptions.<E>.source` / `triggers` | `x-keel-source` / `x-keel-triggers` en la operación `receive` |
| `subscriptions.<E>.onFailure` | `x-keel-on-failure` en la operación `receive` |
| `subscriptions.<E>.contract` | forma del `payload`/`headers` del mensaje (ver §Suscripciones) |
| `domain.types` usados en payloads | `components.schemas.<Type>` |

**Sin `servers`.** El broker, su host y su protocolo son decisión de generación y despliegue, nunca del
diseño: el documento no declara `servers`. Deja constancia en `info.description` con la frase
«El broker concreto y los nombres físicos de topic/cola se deciden al generar.»

## Esqueleto

```yaml
asyncapi: 3.0.0
info:
  title: <service.name>
  version: <service.version>
  description: |
    <service.description>

    Contrato asíncrono derivado del diseño Keel (capa messaging). El broker concreto y los
    nombres físicos de topic/cola se deciden al generar, no aquí.
defaultContentType: application/json

channels: {}
operations: {}
components:
  messages: {}
  schemas: {}
  correlationIds: {}
```

## Canales

Un canal por entrada de `messaging.channels`, con la **misma clave** que el DSL (`camelCase`), y
`address` con ese mismo nombre lógico. `messages` lista los mensajes que ese canal transporta
(publicados y consumidos), por `$ref` a `components.messages`.

```yaml
channels:
  productEvents:
    address: productEvents
    title: productEvents
    description: >-
      Ciclo de vida del producto que publica este servicio.
      Nombre lógico: el topic/cola físico que lo respalda es parámetro de despliegue.
    messages:
      ProductCreated: { $ref: '#/components/messages/ProductCreated' }
      ProductRetired: { $ref: '#/components/messages/ProductRetired' }

  inventoryEvents:
    address: inventoryEvents
    x-keel-external: true
    description: >-
      Eventos de inventory-service que este servicio consume. Canal propiedad de otro sistema:
      su nombre físico real se resuelve como parámetro de despliegue.
    messages:
      StockDepleted: { $ref: '#/components/messages/StockDepleted' }
```

**Evento sin `channel`.** `channel` es opcional en el DSL (el enrutado queda a convención del
generador). Agrupa todos esos eventos en un único canal `default` con `address: null` — la forma que
AsyncAPI reserva para «dirección desconocida» — y no inventes un nombre:

```yaml
  default:
    address: null
    title: Canal por convención
    description: >-
      El diseño no declara canal para estos eventos: el enrutado lo resuelve el generador por
      convención.
    messages:
      ProductCreated: { $ref: '#/components/messages/ProductCreated' }
```

## Operaciones

Una por evento. Nombre determinista: `publish<Evento>` para lo que emite el servicio,
`consume<Evento>` para lo que consume. `messages` referencia **el mensaje dentro del canal**
(`#/channels/<canal>/messages/<Evento>`), nunca `components` directamente.

```yaml
operations:
  publishProductCreated:
    action: send
    channel: { $ref: '#/channels/productEvents' }
    summary: Se emitió un alta de producto.
    messages:
      - $ref: '#/channels/productEvents/messages/ProductCreated'
    x-keel-reliability: outbox        # solo si publishing.reliability es outbox
    x-keel-emitted-by: [createProduct]

  consumeStockDepleted:
    action: receive
    channel: { $ref: '#/channels/inventoryEvents' }
    summary: Retira el producto cuando inventory-service agota su stock.
    messages:
      - $ref: '#/channels/inventoryEvents/messages/StockDepleted'
    x-keel-source: inventory-service
    x-keel-triggers: retireProduct
    x-keel-input: { productId: productId }     # solo si la suscripción declara input
    x-keel-on-failure:
      retry: { maxAttempts: 5, backoff: exponential, initialDelayMs: 1000 }
      deadLetter: true
```

`x-keel-reliability: outbox` es el contrato «ningún evento se pierde si la transacción confirma»; con
`best-effort` no se emite la extensión.

## Mensajes publicados: la envoltura Keel es el contrato

Ningún evento viaja desnudo. El `payload` del mensaje es la **envoltura estándar** (`metadata` +
`data`) documentada en `docs/dsl/messaging.md § La envoltura Keel`: `data` es el `payload` declarado y
`metadata` es transversal e idéntica en todos los eventos. Es justo lo que hace consumible un servicio
Keel desde otro escrito en otra tecnología, así que **debe estar en el contrato formal**.

```yaml
components:
  messages:
    ProductCreated:
      name: ProductCreated
      title: ProductCreated
      contentType: application/json
      summary: Se emitió un alta de producto.
      correlationId: { $ref: '#/components/correlationIds/keelCorrelationId' }
      payload:
        type: object
        required: [metadata, data]
        properties:
          metadata: { $ref: '#/components/schemas/KeelEventMetadata' }
          data:     { $ref: '#/components/schemas/ProductCreatedPayload' }
```

`KeelEventMetadata` se emite **una sola vez** y con esta forma exacta (los seis campos de la
envoltura; `eventType` con el `const` del evento no aplica aquí porque el schema es compartido):

```yaml
  schemas:
    KeelEventMetadata:
      type: object
      description: Metadata transversal de la envoltura Keel; la estampa el servicio al emitir.
      required: [eventId, eventType, eventVersion, occurredAt, source]
      properties:
        eventId:
          type: string
          format: uuid
          description: Id único de esta ocurrencia; clave de deduplicación del consumidor.
        eventType:
          type: string
          description: Nombre del evento en el diseño; discriminador cuando el canal lleva varios tipos.
        eventVersion:
          type: integer
          minimum: 1
          description: Versión del contrato del payload.
        occurredAt:
          type: string
          format: date-time
          description: Instante UTC en que ocurrió el hecho en el dominio, no el del envío.
        source:
          type: string
          description: Nombre del servicio emisor.
        correlationId:
          type: [string, "null"]
          description: Correlación de la petición que originó el hecho; null si no hubo contexto.

  correlationIds:
    keelCorrelationId:
      description: Correlación end-to-end estampada en la envoltura Keel.
      location: '$message.payload#/metadata/correlationId'
```

Y un schema de payload por evento, desde `publishing.events.<E>.payload`:

```yaml
    ProductCreatedPayload:
      type: object
      required: [productId, sku]
      properties:
        productId: { type: string, format: uuid }
        sku:       { $ref: '#/components/schemas/SKU' }
```

### Tipos

Mismas reglas de traducción que ya aplica `openapi.yaml`, sobre `domain.types`:

| DSL | AsyncAPI (JSON Schema) |
|---|---|
| `string`, `text` | `type: string` |
| `int` / `long` | `type: integer` (`format: int64` en `long`) |
| `decimal` | `type: number` |
| `boolean` | `type: boolean` |
| `uuid` | `type: string, format: uuid` |
| `date` / `timestamp` | `type: string, format: date` / `date-time` |
| `json` | `type: object` |
| `file` | `type: string` + `description` con el bucket lógico (viaja la referencia, no el binario) |
| value type escalar (`base` + `constraints`) | schema propio en `components.schemas.<Type>` |
| enum nominal (`values`) | `type: string, enum: [...]` |
| value object (`fields`) | `type: object` con sus propiedades |
| `list: true` | `type: array, items: <tipo>` (+ `minItems`/`maxItems` de `constraints`) |
| `constraints` | `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`, `multipleOf` (desde `scale`) |
| `required: true` | entrada en `required[]` del objeto |

Solo emite los `components.schemas` de tipos **realmente usados** por algún payload de eventos.

## Suscripciones: manda el `contract`, no la envoltura

Un evento consumido llega con la forma que declara `subscriptions.<E>.contract`. Solo con
`envelope: keel` la forma es la envoltura Keel; en los otros dos casos el mensaje es lo que la fuente
mande.

| `contract.envelope` | `payload` del mensaje |
|---|---|
| `keel` (default si el canal no es `external`) | `{ metadata, data }` igual que un publicado; dedupe por `metadata.eventId` |
| `wrapped` | objeto con la propiedad de `payloadPath` conteniendo el schema de datos; el resto de la envoltura ajena no se modela (`additionalProperties: true`) |
| `none` (default si el canal es `external`) | el schema de datos, tal cual |

Lo demás del contrato se plasma así:

- **`discriminator`** con `location: header` → `headers` del mensaje con esa propiedad y su `const`.
  Con `location: field` → la propiedad va en el `payload` con `const`.
- **`messageId`** → `x-keel-message-id: { location, name }` en el mensaje. Es la clave de
  deduplicación, contraparte de la `idempotency` de la operación disparada.
- **`unknownFields`** → `additionalProperties: true` (`ignore`) o `false` (`fail`) en el objeto de datos.
- **`wireName`** de un campo → la propiedad del schema se llama como el **wireName** (es el nombre del
  cable) y lleva `x-keel-field: <nombre del DSL>`.
- **`format`** distinto de `json` → `contentType` del mensaje acorde; con `schemaRef`, añádelo como
  `externalDocs.url` del mensaje.

Ejemplo completo de la suscripción del DSL de referencia (`envelope: wrapped`, `payloadPath: data`,
discriminador en header, `wireName`):

```yaml
    StockDepleted:
      name: StockDepleted
      title: StockDepleted
      contentType: application/json
      summary: inventory-service agotó el stock de un producto.
      x-keel-message-id: { location: header, name: messageId }
      headers:
        type: object
        required: [eventType]
        properties:
          eventType: { type: string, const: stock.depleted }
          messageId: { type: string }
      payload:
        type: object
        required: [data]
        additionalProperties: true
        properties:
          data:
            type: object
            required: [product_id]
            additionalProperties: true      # unknownFields: ignore
            properties:
              product_id:
                type: string
                format: uuid
                x-keel-field: productId
```

## Validación

```bash
npx --yes @asyncapi/cli@latest validate docs/<service.name>/asyncapi.yaml
```

Corrige hasta que pase, igual que con `redocly lint` sobre el `openapi.yaml`.

## Checklist de cierre

- [ ] `asyncapi: 3.0.0` e `info` derivados del manifiesto; sin `servers`.
- [ ] Un canal por entrada de `messaging.channels`; canal `default` (`address: null`) solo si algún
      evento no declara `channel`; `x-keel-external` en los ajenos.
- [ ] Todo evento de `publishing.events` tiene mensaje y operación `publish<E>` (`action: send`).
- [ ] Toda `subscription` tiene mensaje y operación `consume<E>` (`action: receive`) con `x-keel-source`,
      `x-keel-triggers` y `x-keel-on-failure` si los declara.
- [ ] Los publicados llevan la envoltura Keel completa; `KeelEventMetadata` y `keelCorrelationId`
      aparecen una sola vez.
- [ ] Ningún `wireName` en un evento **publicado** (solo existe en contratos ajenos: suscripciones).
- [ ] Todo `$ref` resuelve y todo canal referenciado por una operación existe.
- [ ] `@asyncapi/cli validate` en verde.
- [ ] Los eventos y payloads coinciden 1:1 con la §Eventos del `INTEGRATION.md` de `/keel-integrate`.
