# Guía de `INTEGRATION.md`

Estructura exacta del documento que `/keel-integrate` escribe en `docs/<service.name>/INTEGRATION.md`.
Es el contrato **servidor-a-servidor**: un agente que integra este servicio en otro servidor debe
leerlo de forma determinista (encabezados fijos, anchors estables, tablas de un hecho por fila) sin
dejar de ser Markdown legible por una persona. Todo se deriva de `specs/<servicio>/`; si un dato no
sale del diseño, es un **hueco**: repórtalo, no lo inventes.

## Principios (no negociables)

- **Solo servidor-a-servidor.** El documento cubre dos superficies y solo esas: endpoints expuestos a
  otros servidores (`api.audience: services`/`both`) y eventos (publicación + suscripción). **Nada** de
  operaciones `audience: users`, flujos de usuario, OpenAPI, AsyncAPI ni Postman: eso es de
  `/keel-docs`. Este documento es **prosa de integración**; los contratos formales
  (`openapi.yaml`, `asyncapi.yaml`) se enlazan, no se duplican.
- **Determinismo.** Emite exactamente las secciones de este documento, en este orden, con estos
  encabezados literales. Omite §Endpoints si el servicio no tiene M2M; omite §Eventos si no hay
  `messaging`. Si no hay ninguna de las dos superficies, no se escribe el archivo.
- **Anchors estables.** El encabezado de cada operación y evento es su **nombre del DSL en inglés** tal
  cual (`### getProductPrice`, `### ProductCreated`). El anchor (`#getproductprice`) es predecible.
- **Un hecho por fila.** En las tablas de metadatos, cada atributo es su propia fila.
- **Payloads inline.** Solo las formas que viajan por M2M o por eventos, documentadas donde se usan.
- **Coherencia interna.** El front-matter es un índice derivado 1:1 del cuerpo. Y no puede
  contradecir el `openapi.yaml`, el `asyncapi.yaml` ni las colecciones Postman de `/keel-docs`: misma
  fuente de verdad (el diseño).
- **Ejemplos coherentes.** Los valores de ejemplo (ids, skus, nombres) son los mismos a lo largo del documento.

## Mapeo capa fuente → sección

| Sección | Capas fuente |
|---|---|
| Front-matter | `service`, `api`, `security`, `use-cases`, `messaging` (índice de todo) |
| Resumen | `service.description`, `domain` |
| Endpoints M2M (metadatos, request/response, errores, idempotencia) | `api` (`services`/`both`), `use-cases`, `security` |
| Obtención de token M2M, scopes, serviceClients | `security` (`serviceAuth`, `serviceClients`) |
| Eventos (publicados + suscripciones) | `messaging`, `use-cases` (`emits`) |
| Formas de payload | `domain`, `use-cases` |

## Esqueleto del documento

```markdown
---
<front-matter YAML — ver plantilla abajo>
---

# Integración con <service.name>

## Resumen
<un párrafo: qué ofrece este servicio a otros servidores>

## Endpoints expuestos a otros servidores       ← solo si hay endpoints services/both
<cómo obtener el token M2M>
### <operationName>
<tabla de metadatos>
**Request** <bloque ```json + forma de campos>
**Response** <bloque ```json + forma de campos>
<tabla de errores>

## Eventos                                       ← solo si hay messaging
### Publicados
<forma del mensaje: envoltura keel (metadata + data) — intro, una sola vez>
### <EventName>                                  ← canal, garantía, emisores, ejemplo de `data`
### Suscripciones
```

## Plantilla del front-matter

Bloque YAML entre `---` al inicio del archivo. Es **derivado, nunca inventado**, y coincide 1:1 con el
cuerpo. Omite las claves de superficies ausentes (sin `messaging`, no hay `events`; sin M2M, no hay
`endpoints`).

```yaml
service: product-service
version: 1.0.0
domain: catalog
basePath: /api/v1
m2mAuth:
  protocol: client-credentials   # client-credentials | api-key
  audience: product-service       # de serviceAuth.audience (o el nombre del servicio)
  validateAudience: true
endpoints:                        # solo audience: services | both
  - name: getProductPrice         # clave de use-cases.operations
    method: GET
    path: /products/{productId}/price
    access: service product:read  # level: service + scopes exigidos
events:
  envelope: keel                  # envoltura de lo publicado: siempre keel (metadata + data)
  published:
    - name: ProductCreated
      channel: productEvents
  consumed:
    - name: StockDepleted
      channel: inventoryEvents
      source: inventory-service
      envelope: wrapped           # contract.envelope de esa suscripción
errors:                           # catálogo deduplicado de las operaciones M2M
  - code: PRODUCT_NOT_FOUND
    http: 404
```

## §Endpoints expuestos a otros servidores

### Cómo obtener el token M2M (intro de la sección)

El proveedor de identidad es agnóstico: el `tokenUrl` real, el `clientId` y el `clientSecret` los
entrega el dueño del servicio por entorno (parámetro de despliegue), nunca están en el diseño.
Documenta el **mecanismo**, no los secretos.

Plantilla para `serviceAuth.protocol: client-credentials`:

```markdown
Los endpoints de esta sección se consumen con un **token de cliente máquina** (OAuth2 client
credentials), no con token de usuario. Cómo obtenerlo:

1. Pide al dueño del servicio tus credenciales de cliente (`clientId` + `clientSecret`) y la URL del
   endpoint de token del proveedor de identidad (`tokenUrl`), que varía por entorno.
2. Solicita un token con `grant_type=client_credentials`, tus credenciales y los `scopes` que tu
   cliente tiene concedidos (ver tabla). Fija la audiencia `aud: product-service` (se valida).

   POST {tokenUrl}
   Content-Type: application/x-www-form-urlencoded

   grant_type=client_credentials&client_id=...&client_secret=...&scope=product:read&audience=product-service

3. Envía el `access_token` recibido en cada llamada como `Authorization: Bearer <access_token>`.

| Cliente | Scopes concedidos | Propósito |
|---|---|---|
| billing-service | product:read | Consulta precios para facturar. |
```

Para `serviceAuth.protocol: api-key` no hay flujo de token: cada consumidor recibe una **API key** del
dueño del servicio y la envía en el header acordado (`X-Api-Key` por defecto); el valor es secreto de
despliegue, no de diseño.

### Metadatos de operación (por endpoint M2M)

Una subsección `### <operationName>` por operación con `audience: services`/`both`. Una fila por atributo:

```markdown
| | |
|---|---|
| Endpoint | `GET /api/v1/products/{productId}/price` |
| Acceso | `service` — scopes `product:read` |
| Idempotencia | no aplica (query) |
```

Para un command M2M idempotente, la fila Idempotencia dice `sí — header Idempotency-Key (...)`. Para
`audience: both`, indícalo y describe que el mismo endpoint acepta también token de usuario.

### Request / Response (forma del payload inline)

Documenta los campos que viajan (nombre + tipo + si es requerido) y un ejemplo JSON realista.

```markdown
**Request** — path `productId: uuid` (requerido).

**Response**

| Campo | Tipo | Notas |
|---|---|---|
| amount | decimal | requerido |
| currency | string | requerido; ISO-4217 |

​```json
{ "amount": 19.90, "currency": "EUR" }
​```
```

### Errores de operación

La columna **Acción recomendada** clasifica cada error para el consumidor: `5xx`/timeout →
*reintentable*; `4xx` de validación (`400`, `422`) → *corregir input*; `409`/`403`/`404` → *no
reintentar*. Usa siempre el status declarado en el diseño, nunca uno supuesto.

```markdown
| Código | HTTP | Cuándo | Acción recomendada |
|---|---|---|---|
| PRODUCT_NOT_FOUND | 404 | No existe producto con ese id. | No reintentar; el recurso no existe. |
```

## §Eventos

### Publicados

Ningún evento viaja desnudo: sale en la envoltura estándar de Keel (`metadata` + `data`), donde `data`
es el payload del evento y `metadata` es transversal, igual para todos. Documéntala **una sola vez**,
como intro en prosa de `### Publicados` y **sin encabezado propio** (los únicos encabezados bajo
§Eventos son `### Publicados`, `### Suscripciones` y el nombre de cada evento, para no romper la regla
de anchors). La definición canónica está en `docs/dsl/messaging.md § La envoltura Keel`: cópiala tal
cual, no la reinventes.

```markdown
**Forma del mensaje.** Todo evento de esta sección viaja en la envoltura estándar de Keel. El payload
del evento es el contenido de `data`; `metadata` es la misma para todos.

​```json
{
  "metadata": {
    "eventId": "9f1c3b6e-2d4a-4a91-b0f2-5c7d8e0a1b23",
    "eventType": "ProductCreated",
    "eventVersion": 1,
    "occurredAt": "2026-03-14T09:21:07.482Z",
    "source": "product-service",
    "correlationId": "1f7b0a52-33c9-4a1e-9a44-6c0f2b8d55e1"
  },
  "data": { "productId": "3d2e1f00-8a44-4c9b-9f01-77b6c2d4e5a9", "sku": "SKU-10493" }
}
​```

| Campo | Tipo | Descripción |
|---|---|---|
| metadata.eventId | uuid | Id único de esta ocurrencia. **Úsalo como clave de deduplicación**: la entrega es at-least-once y una reentrega repite el mismo `eventId`. |
| metadata.eventType | string | Nombre del evento (`ProductCreated`). Discriminador si el canal transporta varios tipos. |
| metadata.eventVersion | int | Versión del contrato de `data`. Sube solo al romper compatibilidad. |
| metadata.occurredAt | timestamp | ISO-8601 UTC del instante en que ocurrió el hecho, no el del envío. |
| metadata.source | string | Servicio emisor: `product-service`. |
| metadata.correlationId | string \| null | Correlación de la petición que originó el hecho; propágala para conservar la traza end-to-end. `null` si no hubo contexto de petición. |
| data | objeto | Payload del evento; su forma depende del `eventType` (ver cada evento abajo). |
```

Sustituye `source`, el `eventType` y el ejemplo de `data` por los del servicio real. Después, por
evento de `messaging.publishing.events`:

- **Canal lógico** y su propósito (el broker/topic real es decisión de despliegue, no se documenta).
- **Garantía de entrega**: si `reliability: outbox`, "ningún evento se pierde si la transacción
  confirma"; si `best-effort`, dilo.
- **Emitido por**: qué operaciones lo declaran en `emits`.
- **Payload de ejemplo** en bloque ```json (con la forma de sus campos): es el contenido de `data`,
  **no** el mensaje completo — la envoltura ya está documentada arriba y no se repite por evento.

### Suscripciones

Por evento de `messaging.subscriptions` — esto es lo que **debe publicar** quien quiera activar una
operación de este servicio:

- **Origen** (`source`) y **canal**.
- **Contrato de recepción**: `envelope` (+ `payloadPath` si `wrapped`), `discriminator` (cómo se
  reconoce este tipo en el canal), `messageId` (**clave de deduplicación**), `format`. Con
  `envelope: keel` no repitas la forma: remite a §Publicados → *Forma del mensaje* (es la misma
  envoltura, ahora del lado de quien publica hacia este servicio). Con `wrapped`/`none`, descríbela
  aquí, que es propia de la fuente.
- **Payload esperado** (con `wireName` si el campo llega con otro nombre en el cable).
- **Operación disparada** (`triggers`) y política `onFailure` (retry/backoff, deadLetter).

## Checklist de cierre

- [ ] El servicio tiene superficie servidor-a-servidor; si no, no se escribió el archivo.
- [ ] Front-matter YAML válido y coherente 1:1 con el cuerpo; sin claves de superficies ausentes.
- [ ] Encabezados y orden exactos (endpoints M2M → eventos); cada operación/evento con su anchor en inglés.
- [ ] §Endpoints abre con la obtención del token M2M; cada endpoint con tabla de metadatos (scopes),
      request/response con forma de payload y tabla de errores con acción recomendada.
- [ ] §Eventos con publicados y suscripciones (contrato de recepción + onFailure) si hay `messaging`.
- [ ] §Publicados abre con *Forma del mensaje* (envoltura `metadata` + `data` y tabla de metadata,
      copiada de `docs/dsl/messaging.md`); los ejemplos por evento son el contenido de `data`, no el
      mensaje completo, y la envoltura no se repite por evento.
- [ ] Nada de operaciones `audience: users`, OpenAPI ni Postman en el documento.
- [ ] Ningún dato inventado: los huecos del diseño se reportan, no se rellenan.
