# Capa `messaging` — broker de mensajería (opcional)

Archivo: `specs/<servicio>/messaging.keel.yaml` · Schema: [`schema/messaging.schema.json`](../../schema/messaging.schema.json)

Qué eventos publica el servicio y a cuáles se suscribe, y por qué **canales** lo hace. El broker concreto (Kafka, RabbitMQ…) no se menciona: es decisión de generación.

```yaml
channels:
  productEvents:
    description: Ciclo de vida del producto que publica este servicio.
  inventoryEvents:
    description: Eventos de inventory-service que este servicio consume.
    external: true                 # el canal lo posee otro sistema

publishing:
  reliability: outbox            # outbox | best-effort
  events:
    ProductCreated:
      description: Se emitió un alta de producto.
      channel: productEvents
      payload:
        productId: { type: uuid, required: true }
        sku:       { type: SKU, required: true }
    ProductRetired:
      channel: productEvents
      payload:
        productId: { type: uuid, required: true }

subscriptions:
  StockDepleted:
    source: inventory-service
    channel: inventoryEvents
    contract:
      envelope: wrapped            # keel | wrapped | none
      payloadPath: data
      format: json
      discriminator: { location: header, name: eventType, value: stock.depleted }
      messageId: { location: header, name: messageId }
      unknownFields: ignore
    payload:
      productId: { type: uuid, required: true, wireName: product_id }
    triggers: retireProduct
    input:
      productId: productId
    onFailure:
      retry: { maxAttempts: 5, backoff: exponential, initialDelayMs: 1000 }
      deadLetter: true
```

## Canales

- Un **canal** es un concepto lógico y agnóstico del broker: al generar se materializa en un **topic** (Kafka), una **cola/exchange** (RabbitMQ), etc. — igual que un `bucket` de la capa `storage` se materializa en S3/MinIO. En el diseño solo se declara el nombre lógico y su propósito.
- Se declaran en `channels` (nombres en `camelCase`) y se referencian por nombre desde `publishing.events.<Evento>.channel` y `subscriptions.<Evento>.channel`. `keel validate` comprueba que el canal referenciado exista (referencia cruzada) y avisa de canales declarados que nadie usa (canal huérfano).
- `channel` es **opcional**: un diseño puede dejar el enrutado a convención del generador. Pero si el servicio se integra con otros, declarar el canal deja plasmado el contrato de integración (por dónde emite y de dónde consume).
- `external: true` marca un canal que **posee otro sistema**: el generador no lo crea ni asume sobre él la envoltura de eventos de Keel, y el nombre físico del topic/cola real (que ya existe fuera) se resuelve como **parámetro de despliegue**, no en el spec. Publicar en un canal externo es posible pero se avisa: exige acuerdo con su dueño.

## Publicación

- Todo evento en `emits` de una operación de `use-cases` **debe** estar declarado en `publishing.events`.
- `reliability: outbox` es el contrato "ningún evento se pierde si la transacción confirma"; el mecanismo (tabla + relay, CDC…) lo decide el generador. `best-effort` admite pérdida ante fallos. Si `domain` declara `aggregates`, el evento se escribe en la misma transacción que el agregado que cambió.
- Eventos en pasado y `PascalCase`: `ProductCreated`, no `CreateProduct`.
- Un campo del `payload` (publicado o consumido) puede ser una colección con `list: true`, acotable con `constraints: { minItems, maxItems }`.

## Suscripciones

- Cada suscripción indica su `source`, el `payload` esperado y la operación local que dispara (`triggers`, referencia por nombre a `use-cases`).
- `onFailure` declara la política de consumo: `retry` (reintentos con backoff) y `deadLetter` (tras agotarlos, el mensaje va a una DLQ).
- Si una suscripción reintenta (`maxAttempts > 1`), la operación disparada debería declarar `idempotency` — la skill `/keel-validate` lo comprueba.

### Contrato de recepción (`contract`)

`payload` dice **qué datos** trae el evento; `contract` dice **qué forma tiene el mensaje que llega**. Sin él, el generador tiene que suponer, y suponer solo es seguro cuando la fuente es otro servicio Keel. Al diseñar una suscripción a un sistema ajeno, hay que averiguar con su dueño:

| Pregunta al emisor | Dónde se plasma |
|---|---|
| ¿El mensaje viene envuelto? ¿Dónde está el payload dentro? | `envelope` (`keel` \| `wrapped` \| `none`) + `payloadPath` |
| ¿En qué formato serializa? ¿Hay schema registrado? | `format` + `schemaRef` |
| ¿El canal transporta varios tipos de evento? ¿Cómo se reconoce este? | `discriminator` (`location: header\|field`, `name`, `value`) |
| ¿Qué dato identifica el mensaje para no procesarlo dos veces? | `messageId` (`location`, `name`) |
| ¿Los campos llegan con otro nombre? | `wireName` en cada campo del `payload` |
| ¿Qué hacemos con campos que envía y no declaramos? | `unknownFields` (`ignore` \| `fail`) |

- `envelope: keel` — la fuente es otro servicio Keel y usa la envoltura estándar (metadata + data). `wrapped` — envoltura propia de la fuente, el payload cuelga de `payloadPath` (obligatorio). `none` — el mensaje **es** el payload. Por defecto se asume `keel` si el canal no es `external`, y `none` si lo es.
- `messageId` es la **clave de deduplicación**: con reentregas (`retry`, DLQ, at-least-once) es lo que evita procesar dos veces el mismo evento. Es la contraparte de la `idempotency` de la operación.
- `wireName` solo es válido en contratos de sistemas externos (aquí y en `http-clients`): los identificadores del DSL van en inglés y `camelCase`, y `wireName` guarda el nombre real del cable (`product_id`, `numero_documento`). `keel validate` da error si aparece en una capa interna.

### Del mensaje a la operación (`input`)

`input` mapea **campo del input de la operación disparada → campo del `payload` de la suscripción**. Si se omite, se asume identidad por nombre. `keel validate` comprueba mecánicamente que:

- todo campo `required` del input de `triggers` (que no sea `generated` ni `computed`) llegue en el payload, directamente o vía `input` — si no, **error**: el listener no podría construir la operación;
- las claves de `input` existan en el input de la operación y sus valores en el payload;
- todo campo del payload alimente algo (si no, **aviso**: o sobra en el contrato o falta en la operación).

## Qué NO va aquí

- Qué operación emite cada evento → `use-cases` (`emits`).
- La frontera transaccional que sostiene el outbox → `persistence` (`consistency`).
- El broker concreto y el nombre físico del topic/cola que respalda cada canal → se deciden al **generar**, nunca en el spec. También el de un canal `external`, cuyo nombre real ya existe fuera: entra como parámetro de despliegue, no como dato de diseño.
- El consumer group / la durabilidad de la suscripción y el número de consumidores → decisión de generación y despliegue.
