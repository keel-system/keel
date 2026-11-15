# product-catalog — Documento de diseño

> specs/product-catalog v1.2.0. Fixture de la primera corrida de keel-nest, cerrada como diseño de contraste de
> los lotes en la v1.2.0 (DSL 2.30, incremento 11 de PLAN-DSL-230-LOTES.md, 2026-11-15); las decisiones las tomó
> quien lo preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Gestiona el **catálogo de productos** publicables de una tienda: el equipo de la tienda da de alta productos en
borrador, los publica, los retira, y los importa por lotes, de un formulario de cientos (`importProducts`, que
responde en la misma petición qué pasó con cada uno) o del catálogo entero de un proveedor (`importCatalog`, un
trabajo que se procesa por partes y se consulta después). Es la silueta más simple que un generador sirve entera
(un agregado con su ciclo de vida, unicidad por clave natural, un importe con escala, paginación e idempotencia) y
el contraste de los dos modos de lote.

Queda fuera, a propósito: editar un producto tras el alta, borrar productos, cancelar una importación en marcha, el
evento de «importación terminada» y el consumo desde un navegador (no hay `cors`). Motivos en § 7.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Product` | raíz | Un producto del catálogo: `sku` (clave natural, `^[A-Z]{3}-[0-9]{4}$`), `name` (hasta 120 caracteres), `notes` (opcional), `price` (`Money`: importe con dos decimales y divisa de tres letras), `apiToken` (sensible: entra en el alta y no sale nunca) y `status`. |

El elemento de un lote es el tipo `ProductDraft` (`sku`, `name`, `notes`, `price`): lo que hace falta para un alta,
sin `apiToken`. Campos generados: `id` (uuid del servidor), y la fecha de alta y de última modificación, que no salen
en el contrato.

## 3. Invariantes y reglas clave

- Ciclo de vida: `draft → active | retired`, `active → retired`; `retired` es definitivo.
- Un producto `active` siempre tiene `price.amount` mayor que cero: `activateProduct` lo comprueba después del
  estado.
- Un sku por producto (clave natural): un alta con un sku que ya existe es `409 SKU_ALREADY_EXISTS`, también el de un
  producto retirado.
- Un importe con más decimales se **redondea** a dos (`HALF_UP`): `12.345` es `12.35`.
- **Lotes**: cada elemento pasa por la misma operación que un alta suelta, en orden de índice y en su propia
  transacción. Un sku repetido o un elemento que no cumple su contrato fallan **solo su elemento**; cualquier otro
  fallo detiene el lote, lo anterior queda confirmado y lo siguiente sale `notAttempted`. Dos elementos con el mismo
  sku en un lote fallan siempre en el segundo.
- Un trabajo de `importCatalog` solo lo lee quien lo creó: para cualquier otro no existe.

## 4. Qué hace

| Operación | Ruta | Éxito | Errores |
|---|---|---|---|
| `createProduct` | `POST /api/v1/products` | `201` con el producto y su `Location` | `400 VALIDATION_ERROR`, `409 SKU_ALREADY_EXISTS` |
| `getProduct` | `GET /api/v1/products/{id}` | `200` con el producto | `404 PRODUCT_NOT_FOUND` |
| `listProducts` | `GET /api/v1/products` | `200` con una página (20 por defecto, 100 como máximo), por sku ascendente | — |
| `activateProduct` | `POST /api/v1/products/{id}/activate` | `204` | `404 PRODUCT_NOT_FOUND`, `409 PRODUCT_NOT_DRAFT`, `422 PRODUCT_PRICE_NOT_POSITIVE` |
| `retireProduct` | `POST /api/v1/products/{id}/retire` | `204` | `404 PRODUCT_NOT_FOUND`, `409 PRODUCT_ALREADY_RETIRED` |
| `importProducts` | `POST /api/v1/products/batch` | `207` siempre, con `{summary, items}` y un resultado por elemento (`productId` en los que salen bien) | por elemento, `SKU_ALREADY_EXISTS` y `VALIDATION_ERROR`; del lote entero, `400` si falta `items` o trae más de 500 |
| `importCatalog` | `POST /api/v1/products/imports` | `202` con el trabajo y su `Location`; `GET …/imports/jobs/{jobId}` y `…/results` | `400` del sobre (más de 50000); `404 BATCH_JOB_NOT_FOUND` para quien no lo creó |

Las altas aceptan `Idempotency-Key`: repetirla devuelve la misma respuesta (el mismo `201`, el mismo `207` o el mismo
trabajo), y con otro cuerpo es `409 IDEMPOTENCY_KEY_REUSED`. Todas las operaciones exigen un token válido
(`401 UNAUTHENTICATED`) con el permiso `catalog:manage`, que otorga el rol `catalog-editor` (`403 ACCESS_DENIED`).

## 5. Fronteras e integraciones

Un proveedor de identidad OIDC (Keycloak o Cognito según el stack) emite los tokens; el servicio solo los valida. No
publica ni consume eventos y no llama a nadie. Los trabajos de `importCatalog` los procesa el cronómetro del servicio
por partes (un temporizador por trabajo, reanudable desde el último elemento confirmado si una réplica cae), y el
método guarda cada trabajo y sus resultados en sus tablas (`batch_job`, `batch_item_result`), con su purga.

## 6. Decisiones de diseño (qué / por qué)

- **Idempotencia por clave del cliente en las tres altas**, y ninguna en las transiciones: repetir una publicación o
  una retirada la rechaza el ciclo de vida sin efecto. Sin cabecera, lo que impide el alta doble es el sku.
- **Un lote se repite entero**: la clave vale para el lote, y uno cortado a mitad se reanuda desde el último elemento
  confirmado; mientras el primero sigue, `409 IDEMPOTENCY_KEY_IN_PROGRESS`.
- **Dos tamaños, dos modos**: hasta 500 productos responde en la misma petición; un catálogo de hasta 50000 es un
  trabajo, porque un `207` de miles de elementos es un *timeout*.
- **`207` siempre en el lote síncrono**, también si todo sale bien o todo falla: un solo lector para el cliente.
- **El sku en `itemErrors`**: depende solo del elemento, así que un repetido no detiene la importación.
- **Bloqueo optimista**: publicar y retirar a la vez dejan un `409 CONCURRENT_MODIFICATION` a quien pierde, no un
  pisotón.
- **Fechas de alta y modificación** para conciliar importaciones, fuera del contrato; sin autoría.
- **Sin caché**: quien lee un producto acaba de escribirlo, y una importación lo cambia en cualquier momento.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las siete rutas, la forma del producto sin `apiToken`, el sobre de página, la forma del lote
(`wire-contract.md` § Lotes) y del trabajo, los `code` y los status.
Adaptable: el proveedor de identidad, el formato del sku, las cotas de los campos y los topes de los lotes.

### Supuestos y limitaciones

- Un producto no se edita ni se borra: un error se corrige retirándolo y dando de alta otro sku.
- Una importación en marcha no se cancela; lo que no se quiere se retira después.
- Sin `cors`: lo usa el backoffice de la tienda desde su backend.

### Cómo reutilizarlo

Ajustar el formato del `SKU` y los campos de `Product` y `ProductDraft` a la tienda, y los `maxItems` de los dos lotes
a lo que tarde un alta en su infraestructura. Si nadie importa catálogos enteros, `importCatalog` se quita y con él
los trabajos; si nadie da de alta por lotes, `importProducts`. La clave natural sigue siendo el sku.
