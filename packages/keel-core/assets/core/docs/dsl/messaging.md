# Capa `messaging` — broker de mensajería (opcional)

Archivo: `specs/<servicio>/messaging.keel.yaml` · Schema: [`schema/messaging.schema.json`](../../schema/messaging.schema.json)

Qué eventos publica el servicio y a cuáles se suscribe, y por qué **canales** lo hace. El broker concreto (Kafka, RabbitMQ…) no se menciona: es decisión de generación.

```yaml
channels:
  productEvents:
    description: Ciclo de vida del producto que publica este servicio.
  inventoryEvents:
    description: Eventos de inventory-service que este servicio consume.

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
    payload:
      productId: { type: uuid, required: true }
    triggers: retireProduct
    onFailure:
      retry: { maxAttempts: 5, backoff: exponential, initialDelayMs: 1000 }
      deadLetter: true
```

## Canales

- Un **canal** es un concepto lógico y agnóstico del broker: al generar se materializa en un **topic** (Kafka), una **cola/exchange** (RabbitMQ), etc. — igual que un `bucket` de la capa `storage` se materializa en S3/MinIO. En el diseño solo se declara el nombre lógico y su propósito.
- Se declaran en `channels` (nombres en `camelCase`) y se referencian por nombre desde `publishing.events.<Evento>.channel` y `subscriptions.<Evento>.channel`. `keel validate` comprueba que el canal referenciado exista (referencia cruzada) y avisa de canales declarados que nadie usa (canal huérfano).
- `channel` es **opcional**: un diseño puede dejar el enrutado a convención del generador. Pero si el servicio se integra con otros, declarar el canal deja plasmado el contrato de integración (por dónde emite y de dónde consume).

## Publicación

- Todo evento en `emits` de una operación de `use-cases` **debe** estar declarado en `publishing.events`.
- `reliability: outbox` es el contrato "ningún evento se pierde si la transacción confirma"; el mecanismo (tabla + relay, CDC…) lo decide el generador. `best-effort` admite pérdida ante fallos. Si `domain` declara `aggregates`, el evento se escribe en la misma transacción que el agregado que cambió.
- Eventos en pasado y `PascalCase`: `ProductCreated`, no `CreateProduct`.

## Suscripciones

- Cada suscripción indica su `source`, el `payload` esperado y la operación local que dispara (`triggers`, referencia por nombre a `use-cases`).
- `onFailure` declara la política de consumo: `retry` (reintentos con backoff) y `deadLetter` (tras agotarlos, el mensaje va a una DLQ).
- Si una suscripción reintenta (`maxAttempts > 1`), la operación disparada debería declarar `idempotency` — la skill `/keel-validate` lo comprueba.

## Qué NO va aquí

- Qué operación emite cada evento → `use-cases` (`emits`).
- La frontera transaccional que sostiene el outbox → `persistence` (`consistency`).
- El broker concreto y el nombre físico del topic/cola que respalda cada canal → se deciden al **generar**, nunca en el spec.
