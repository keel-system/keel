# product-catalog — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/product-catalog v1.2.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la silueta más simple que un generador tiene que servir
> entera: un agregado con su lifecycle, unicidad por clave natural, un value object monetario con
> escala, paginación y la idempotencia del alta. Es el diseño de la primera corrida de keel-nest, y el
> mismo documento tiene que pasar al 100% contra el servidor de keel-spring. La v1.2.0 (DSL 2.30) le añade
> los dos lotes: `importProducts`, que responde `207` por elemento, e `importCatalog`, un trabajo asíncrono
> atado a quien lo crea, y con él un token en toda la API.

## Convenciones de determinación

- **Identificadores**: uuid generado por el servidor. Se verifican por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** (`conventions.nulls` no se declara, así
  que vale el default `include`). `notes` es nulo si el alta no lo trae.
- **Importes**: `price.amount` viaja con **exactamente dos decimales** (`12.50`, nunca `12.5`). Un
  importe con más decimales se **redondea** a dos (`constraints.scalePolicy: round` en el tipo `Money`)
  con `HALF_UP`: `12.345` es `12.35`. La escala se afirma sobre el texto del número, no sobre su valor.
- **Datos sensibles**: `apiToken` se acepta en el alta y **nunca** aparece en ninguna respuesta.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details, correlationId}`.
  Los escenarios fijan el `code` y el status; el resto se verifica por presencia.
- **Idempotencia de petición**: `createProduct` declara `idempotency` (`client-key`, `ttlSeconds:
  86400`). Cada alta lleva un `Idempotency-Key` **uuid nuevo**, salvo en los escenarios que prueban la
  deduplicación, que repiten el anterior a propósito.
- **Orden de los listados**: `listProducts` ordena por `sku` ascendente (`sort: [sku:asc]`), así que los
  escenarios del listado afirman también la posición de cada elemento. Los resultados de un trabajo de
  `importCatalog` van en orden de índice.
- **Autenticación**: toda petición lleva `Authorization: Bearer <token>` de un usuario con el rol
  `catalog-editor` (el **titular**). FL-PRD-009-D usa el de **otro** usuario con el mismo rol, distinto del
  titular; FL-PRD-010 prueba la petición sin token, y FL-PRD-010-B, la de un usuario autenticado **sin
  ningún rol**.
- **Repetir una petición** es mandar los **mismos bytes** de cuerpo: la firma con la que un lote reconoce su
  repetición es la de los bytes tal como llegan, así que el mismo JSON reformateado es otra petición.
- **Lotes**: la respuesta de `importProducts` es siempre `207` con `{summary, items}`, y cada elemento de
  `items` lleva sus cinco claves (`index`, `status`, `result`, `error`, `message`), con `null` donde no
  aplica (`wire-contract.md` § Lotes). Los escenarios fijan `status`, `error` y `result.productId` por
  elemento; `message` se verifica por presencia cuando el elemento falla.
- **Trabajos asíncronos**: `importCatalog` responde `202` con el trabajo y no procesa nada en la petición.
  Los escenarios **sondean** `GET /api/v1/products/imports/jobs/<jobId>` cada medio segundo hasta que su
  `status` sea `completed` o `aborted`, durante como mucho 60 segundos; agotar la espera es un fallo del
  escenario. `createdAt` y `finishedAt` se verifican por forma.
- **Mayúsculas**: el formato de `SKU` (`^[A-Z]{3}-[0-9]{4}$`) solo admite mayúsculas, así que `acm-0001`
  no colisiona con `ACM-0001`: se rechaza por formato antes.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createProduct | FL-PRD-001, FL-PRD-002, FL-PRD-003 | usuarios |
| getProduct | FL-PRD-001, FL-PRD-004, FL-PRD-006, FL-PRD-007 | usuarios |
| listProducts | FL-PRD-003, FL-PRD-005 | usuarios |
| activateProduct | FL-PRD-007 | usuarios |
| retireProduct | FL-PRD-006, FL-PRD-007 | usuarios |
| importProducts | FL-PRD-008 | usuarios |
| importCatalog | FL-PRD-009 | usuarios |

## Alta de productos

### FL-PRD-001: se da de alta un producto

**When**: `createProduct` — `POST /api/v1/products` con `Idempotency-Key: <k1>` y
`{"sku": "ACM-0001", "name": "Martillo de carpintero", "price": {"amount": 12.50, "currency": "EUR"}, "apiToken": "tok-123"}`.
**Then**:
1. Status `201`.
2. Cabecera `Location` que termina en `/api/v1/products/<id>`.
3. El cuerpo es exactamente `{id, sku: "ACM-0001", name: "Martillo de carpintero", notes: null,
   price: {amount: 12.50, currency: "EUR"}, status: "draft"}`: `id` con forma de uuid, `amount` con dos
   decimales, y **sin** `apiToken`.
**Notas de determinación**: el producto nace en `draft`, el estado inicial del lifecycle.

#### FL-PRD-001-B: el producto creado se puede leer

**When**: `getProduct` — `GET /api/v1/products/<id>` con el `id` del escenario anterior.
**Then**:
1. Status `200`.
2. El cuerpo es el mismo de FL-PRD-001 (mismo `id`, `notes: null`, `amount` `12.50`, `status:
   "draft"`) y **sin** `apiToken`.

#### FL-PRD-001-C: un sku que ya existe se rechaza

**Given**: el producto `ACM-0001` de FL-PRD-001.
**When**: `createProduct` con un `Idempotency-Key` **nuevo** y
`{"sku": "ACM-0001", "name": "Otro martillo", "price": {"amount": 9.99, "currency": "EUR"}}`.
**Then**:
1. Status `409` con `code: SKU_ALREADY_EXISTS`.
2. `GET /api/v1/products?size=20` sigue trayendo **un** producto con el sku `ACM-0001`
   (`totalElements: 1`).

#### FL-PRD-001-D: el importe se redondea a la escala del tipo

**When**: `createProduct` con un `Idempotency-Key` nuevo y
`{"sku": "ACM-0002", "name": "Destornillador", "notes": "Punta plana", "price": {"amount": 12.345, "currency": "EUR"}}`.
**Then**:
1. Status `201`.
2. `price.amount` es `12.35` (dos decimales, `HALF_UP`) y `notes` es `"Punta plana"`.

#### FL-PRD-001-E: la entrada que incumple el contrato es 400

**When** (cada una con un `Idempotency-Key` nuevo), `createProduct` con:
1. `sku: "acm-0003"` (formato del tipo `SKU`);
2. `sku: "ACME-00031"` (más de 8 caracteres);
3. `price.amount: -1.00` (mínimo `0`);
4. `price.currency: "EURO"` (exactamente 3 caracteres);
5. `name` de 121 caracteres (máximo `120`);
6. sin `sku` (obligatorio).
**Then**:
1. Las seis responden `400` con `code: VALIDATION_ERROR`.
2. Ninguna crea nada: `GET /api/v1/products?size=20` trae solo los dos productos de este flujo
   (`ACM-0001` y `ACM-0002`, `totalElements: 2`).

## Idempotencia del alta

### FL-PRD-002: el cliente reintenta el alta con la misma clave

**When**: `createProduct` con `Idempotency-Key: <k2>` y
`{"sku": "BRD-0001", "name": "Broca de 8 mm", "price": {"amount": 3.20, "currency": "EUR"}}`.
**Then**:
1. Status `201` con el cuerpo de la creación (`sku: "BRD-0001"`, `amount` `3.20`, `status: "draft"`).

#### FL-PRD-002-B: la misma petición con la misma clave reproduce la respuesta

**When**: se repite **exactamente** la petición anterior con el **mismo** `Idempotency-Key: <k2>`.
**Then**:
1. Status `201`, el **mismo** `id` y el mismo cuerpo, y la misma cabecera `Location`.
2. No hay un segundo producto: `GET /api/v1/products?size=20` trae `totalElements: 1`.

#### FL-PRD-002-C: el mismo contenido con otra clave es un alta nueva, y choca

**When**: la misma petición con **otro** `Idempotency-Key`.
**Then**:
1. Status `409` con `code: SKU_ALREADY_EXISTS`: con otra clave no es una repetición, y el sku ya existe.

### FL-PRD-003: dos altas con la misma clave, a la vez

Lo que FL-PRD-002-B no prueba: la repetición secuencial encuentra el registro de la clave ya
confirmado; la simultánea cae en la ventana anterior.

**Given**: una clave `<k3>` sin usar y ningún producto `CLV-0001`.
**When**: se lanzan **simultáneamente** dos `createProduct` idénticos, con `Idempotency-Key: <k3>` y
`{"sku": "CLV-0001", "name": "Clavo de 40 mm", "price": {"amount": 0.05, "currency": "EUR"}}`.
**Then**:
1. Cada respuesta es una de: `201` con el cuerpo de la creación, o `409` con un `code` de conflicto
   (`IDEMPOTENCY_KEY_IN_PROGRESS`, el canónico aceptado en `decisions.yaml`, o `SKU_ALREADY_EXISTS`).
   No se afirma cuál de las dos gana.
2. Al menos una de las dos es `201`, y si las dos lo son, traen el **mismo** `id`.
3. `listProducts` — `GET /api/v1/products?size=20` trae **exactamente un** producto `CLV-0001`
   (`totalElements: 1`).

## Consultas

### FL-PRD-004: un producto que no existe

**When**: `getProduct` — `GET /api/v1/products/0192f1d2-0000-7000-8000-000000000001`.
**Then**:
1. Status `404` con `code: PRODUCT_NOT_FOUND`.

#### FL-PRD-004-B: un id que no es un uuid

**When**: `getProduct` — `GET /api/v1/products/no-es-un-uuid`.
**Then**:
1. Status `400` con `code: VALIDATION_ERROR`.

### FL-PRD-005: el catálogo se lista por páginas

**Given**: tres productos creados en este flujo (`PAG-0001`, `PAG-0002`, `PAG-0003`), cada uno con su
`Idempotency-Key`.
**When**: `listProducts` — `GET /api/v1/products?page=0&size=2`.
**Then**:
1. Status `200`.
2. El cuerpo es `{items, page: 0, size: 2, totalElements: 3, totalPages: 2}`, con **dos** elementos en
   `items`, `PAG-0001` y `PAG-0002` en ese orden, cada uno con la forma de la respuesta de `getProduct`
   (sin `apiToken`).

#### FL-PRD-005-B: la segunda página trae el resto

**When**: `GET /api/v1/products?page=1&size=2`.
**Then**:
1. `{items, page: 1, size: 2, totalElements: 3, totalPages: 2}`, con **un** elemento: `PAG-0003`.
2. Entre las dos páginas están los tres skus, cada uno una sola vez y en orden ascendente.

#### FL-PRD-005-C: sin tamaño, la página es la del diseño

**When**: `GET /api/v1/products`.
**Then**:
1. `size: 20` (el `defaultSize` de `api.keel.yaml`), `page: 0`, `totalElements: 3`, `totalPages: 1` y
   los tres productos en `items`, ordenados por sku: `PAG-0001`, `PAG-0002`, `PAG-0003`.

## Retirada

### FL-PRD-006: un producto en draft se retira

**Given**: un producto `RET-0001` recién creado (en `draft`).
**When**: `retireProduct` — `POST /api/v1/products/<id>/retire`.
**Then**:
1. Status `204`, sin cuerpo.
2. `getProduct` lo devuelve con `status: "retired"` y el resto de campos sin cambios.
**Orden de evaluación**:
1. El producto existe → si no, `404 PRODUCT_NOT_FOUND`.
2. No está ya `retired` → si lo está, `409 PRODUCT_ALREADY_RETIRED`.

#### FL-PRD-006-B: retirar uno ya retirado es 409

**When**: `retireProduct` sobre el mismo producto otra vez.
**Then**:
1. Status `409` con `code: PRODUCT_ALREADY_RETIRED`.
2. `getProduct` sigue devolviendo `status: "retired"`.

#### FL-PRD-006-C: retirar uno que no existe es 404

**When**: `retireProduct` — `POST /api/v1/products/0192f1d2-0000-7000-8000-000000000002/retire`.
**Then**:
1. Status `404` con `code: PRODUCT_NOT_FOUND`: la existencia se comprueba antes que el estado.

## Publicación

### FL-PRD-007: un producto en draft con precio se publica

**Given**: un producto `PUB-0001` recién creado (en `draft`) con `price.amount` `10.00`.
**When**: `activateProduct` — `POST /api/v1/products/<id>/activate`.
**Then**:
1. Status `204`, sin cuerpo.
2. `getProduct` lo devuelve con `status: "active"` y el resto de campos sin cambios.
**Orden de evaluación**:
1. El producto existe → si no, `404 PRODUCT_NOT_FOUND`.
2. Está en `draft` → si no, `409 PRODUCT_NOT_DRAFT`.
3. Su precio es mayor que cero → si no, `422 PRODUCT_PRICE_NOT_POSITIVE`.

#### FL-PRD-007-B: publicar uno que ya está activo es 409

**When**: `activateProduct` sobre el mismo producto otra vez.
**Then**:
1. Status `409` con `code: PRODUCT_NOT_DRAFT`.
2. `getProduct` sigue devolviendo `status: "active"`.

#### FL-PRD-007-C: un producto activo se retira

**When**: `retireProduct` — `POST /api/v1/products/<id>/retire` sobre el mismo producto.
**Then**:
1. Status `204`.
2. `getProduct` lo devuelve con `status: "retired"`.

#### FL-PRD-007-D: un producto con precio cero no se publica

**Given**: un producto `PUB-0002` recién creado (en `draft`) con `price.amount` `0.00`.
**When**: `activateProduct` sobre él.
**Then**:
1. Status `422` con `code: PRODUCT_PRICE_NOT_POSITIVE`.
2. `getProduct` sigue devolviendo `status: "draft"`.

#### FL-PRD-007-E: el estado se comprueba antes que el precio

**Given**: el producto `PUB-0002` (precio `0.00`) retirado con `retireProduct` (`204`).
**When**: `activateProduct` sobre él.
**Then**:
1. Status `409` con `code: PRODUCT_NOT_DRAFT`, no el `422` del precio: con las dos guardas fallando,
   responde la que el diseño pone antes.

#### FL-PRD-007-F: publicar uno que no existe es 404

**When**: `activateProduct` — `POST /api/v1/products/0192f1d2-0000-7000-8000-000000000003/activate`.
**Then**:
1. Status `404` con `code: PRODUCT_NOT_FOUND`.

## Lote de altas

### FL-PRD-008: un lote en el que fallan tres elementos

**Given**: el producto `LOT-0002` dado de alta con `createProduct` (`201`).
**When**: `importProducts` — `POST /api/v1/products/batch` con `Idempotency-Key: <k8>` y
`{"items": [
  {"sku": "LOT-0001", "name": "Llave inglesa", "price": {"amount": 8.00, "currency": "EUR"}},
  {"sku": "LOT-0002", "name": "Llave repetida", "price": {"amount": 8.00, "currency": "EUR"}},
  {"sku": "lot-0003", "name": "Formato inválido", "price": {"amount": 8.00, "currency": "EUR"}},
  {"sku": "LOT-0004", "name": "Llave de vaso", "notes": "Juego de 12", "price": {"amount": 21.499, "currency": "EUR"}},
  {"sku": "LOT-0001", "name": "Repetida en el lote", "price": {"amount": 8.00, "currency": "EUR"}}
]}`.
**Then**:
1. Status `207`, también con elementos fallidos.
2. `summary` es `{total: 5, succeeded: 2, failed: 3, notAttempted: 0}`.
3. `items` trae los cinco elementos en orden de índice:
   - `0`: `succeeded`, `result.productId` con forma de uuid, `error: null`, `message: null`;
   - `1`: `failed` con `error: SKU_ALREADY_EXISTS` y `result: null` (el sku ya existía);
   - `2`: `failed` con `error: VALIDATION_ERROR` y `result: null`: el formato del `SKU` falla solo su
     elemento, no es un `400` del lote;
   - `3`: `succeeded` con su `result.productId`;
   - `4`: `failed` con `error: SKU_ALREADY_EXISTS`: dos elementos con el mismo sku en el lote fallan siempre
     en el segundo.
4. `getProduct` con el `productId` del elemento `0` devuelve `LOT-0001` en `draft`, y con el del `3`,
   `LOT-0004` con `price.amount` `21.50` y `notes: "Juego de 12"`: cada elemento pasa por la misma
   operación que un alta suelta.
5. Lo que falló no deshace lo anterior: `GET /api/v1/products?size=20` trae `LOT-0001`, `LOT-0002` y
   `LOT-0004`, y ningún `LOT-0003`.
**Notas de determinación**: el lote se procesa en orden de índice, un elemento por transacción.

#### FL-PRD-008-B: repetir el lote con la misma clave devuelve la misma respuesta

**When**: se repite **exactamente** la petición de FL-PRD-008 con el **mismo** `Idempotency-Key: <k8>`.
**Then**:
1. Status `207` con el **mismo** cuerpo: el mismo `summary` y los mismos cinco elementos, con los mismos
   `productId` en `0` y `3`.
2. No se dio de alta nada más: `GET /api/v1/products?size=20` sigue trayendo un solo `LOT-0001` y un solo
   `LOT-0004`.

#### FL-PRD-008-C: la misma clave con otro lote se rechaza

**When**: `importProducts` con el **mismo** `Idempotency-Key: <k8>` y
`{"items": [{"sku": "LOT-0005", "name": "Otro lote", "price": {"amount": 1.00, "currency": "EUR"}}]}`.
**Then**:
1. Status `409` con `code: IDEMPOTENCY_KEY_REUSED`.
2. No se procesó nada: no existe ningún `LOT-0005`.

#### FL-PRD-008-D: lo que es un 400 del lote entero

**When** (cada una con un `Idempotency-Key` nuevo), `importProducts` con:
1. `{}` (sin el campo `items`);
2. `{"items": [...]}` con **501** elementos válidos (`LOT-1000` a `LOT-1500`), uno más que el `maxItems`.
**Then**:
1. Las dos responden `400` con `code: VALIDATION_ERROR`.
2. No se procesó ningún elemento: no existe ningún producto `LOT-1000`.

### FL-PRD-008-E: dos lotes con la misma clave, a la vez

Lo que FL-PRD-008-B no prueba: la repetición secuencial encuentra el lote ya terminado; la simultánea cae
mientras el primero sigue en marcha.

**Given**: una clave `<k8e>` sin usar y ningún producto `RAC-0001` ni `RAC-0002`.
**When**: se lanzan **simultáneamente** dos `importProducts` idénticos, con `Idempotency-Key: <k8e>` y
`{"items": [{"sku": "RAC-0001", "name": "Tuerca M6", "price": {"amount": 0.10, "currency": "EUR"}},
{"sku": "RAC-0002", "name": "Tuerca M8", "price": {"amount": 0.12, "currency": "EUR"}}]}`.
**Then**:
1. Cada respuesta es una de: `207` con `summary` `{total: 2, succeeded: 2, failed: 0, notAttempted: 0}`, o
   `409` con `code: IDEMPOTENCY_KEY_IN_PROGRESS` (el canónico aceptado en `decisions.yaml`). No se afirma
   cuál de las dos gana.
2. Al menos una de las dos es `207`, y si las dos lo son, traen los **mismos** `productId`.
3. `listProducts` — `GET /api/v1/products?size=20` trae **exactamente un** `RAC-0001` y **exactamente un**
   `RAC-0002`.

## Importación del catálogo

### FL-PRD-009: el catálogo se importa como un trabajo

**Given**: el producto `IMP-0002` dado de alta con `createProduct` (`201`).
**When**: `importCatalog` — `POST /api/v1/products/imports` con `Idempotency-Key: <k9>` y
`{"items": [
  {"sku": "IMP-0001", "name": "Sierra de calar", "price": {"amount": 59.90, "currency": "EUR"}},
  {"sku": "IMP-0002", "name": "Sierra repetida", "price": {"amount": 59.90, "currency": "EUR"}},
  {"sku": "IMP-0003", "name": "Lijadora orbital", "price": {"amount": 45.00, "currency": "EUR"}}
]}`.
**Then**:
1. Status `202` con cabecera `Location` que termina en `/api/v1/products/imports/jobs/<jobId>`, y el
   cuerpo es el trabajo: `{id: <jobId>, status, summary, createdAt, finishedAt}`, con `summary.total: 3`.
2. Sondeando `GET /api/v1/products/imports/jobs/<jobId>` (ver Convenciones), el trabajo acaba
   `completed` con `summary` `{total: 3, succeeded: 2, failed: 1, notAttempted: 0}` y `finishedAt` con
   forma de instante.
3. `GET /api/v1/products/imports/jobs/<jobId>/results` responde `200` con el sobre de página
   (`items`, `page: 0`, `totalElements: 3`), y sus elementos tienen la forma de cada elemento del `207` de
   `importProducts`, en orden de índice: `0` `succeeded` con su `result.productId`, `1` `failed` con
   `error: SKU_ALREADY_EXISTS` y `2` `succeeded`.
4. `getProduct` con el `productId` del elemento `2` devuelve `IMP-0003` en `draft`, y
   `GET /api/v1/products?size=20` trae un solo `IMP-0002`, el del Given.

#### FL-PRD-009-B: repetir la importación con la misma clave devuelve el mismo trabajo

**When**: se repite **exactamente** la petición de FL-PRD-009 con el **mismo** `Idempotency-Key: <k9>`.
**Then**:
1. Status `202` con la **misma** cabecera `Location` y el mismo `id`, y el trabajo en el estado en que
   está (`completed`, con el mismo `summary`).
2. No se importó nada otra vez: `GET /api/v1/products?size=20` sigue trayendo un solo `IMP-0001` y un solo
   `IMP-0003`.

#### FL-PRD-009-C: la misma clave con otro catálogo se rechaza

**When**: `importCatalog` con el **mismo** `Idempotency-Key: <k9>` y
`{"items": [{"sku": "IMP-0004", "name": "Otro catálogo", "price": {"amount": 1.00, "currency": "EUR"}}]}`.
**Then**:
1. Status `409` con `code: IDEMPOTENCY_KEY_REUSED`, y no existe ningún `IMP-0004`.

#### FL-PRD-009-D: solo quien creó el trabajo lo lee

**When**: con el token de **otro** usuario con el rol `catalog-editor`, distinto del titular,
`GET /api/v1/products/imports/jobs/<jobId>` y `GET /api/v1/products/imports/jobs/<jobId>/results` del
trabajo de FL-PRD-009.
**Then**:
1. Las dos responden `404` con `code: BATCH_JOB_NOT_FOUND`: para otro usuario el trabajo no existe.
2. Con el token del titular, las dos siguen respondiendo `200`.

#### FL-PRD-009-E: un trabajo que no existe

**When**: `GET /api/v1/products/imports/jobs/0192f1d2-0000-7000-8000-000000000009`.
**Then**:
1. Status `404` con `code: BATCH_JOB_NOT_FOUND`.

### FL-PRD-009-F: dos importaciones con la misma clave, a la vez

**Given**: una clave `<k9f>` sin usar y ningún producto `RAC-0003`.
**When**: se lanzan **simultáneamente** dos `importCatalog` idénticos, con `Idempotency-Key: <k9f>` y
`{"items": [{"sku": "RAC-0003", "name": "Arandela", "price": {"amount": 0.05, "currency": "EUR"}}]}`.
**Then**:
1. Cada respuesta es una de: `202` con el trabajo y su `Location`, o `409` con
   `code: IDEMPOTENCY_KEY_IN_PROGRESS`. No se afirma cuál de las dos gana.
2. Al menos una de las dos es `202`, y si las dos lo son, traen la **misma** `Location`: hay un solo trabajo.
3. Sondeando ese trabajo, acaba `completed` con `summary` `{total: 1, succeeded: 1, failed: 0,
   notAttempted: 0}`, y `GET /api/v1/products?size=20` trae **exactamente un** `RAC-0003`.

## Autenticación

### FL-PRD-010: sin token no se entra

**When**: sin cabecera `Authorization`, `GET /api/v1/products`, `POST /api/v1/products` con un alta
válida (`sku: "SEC-0001"`), `POST /api/v1/products/batch` con un lote de un elemento válido
(`sku: "SEC-0002"`) y `POST /api/v1/products/imports` con otro (`sku: "SEC-0003"`).
**Then**:
1. Las cuatro responden `401` con `code: UNAUTHENTICATED`.
2. Ninguna crea nada: con el token del titular, no existe ningún producto `SEC-0001`, `SEC-0002` ni
   `SEC-0003`.

#### FL-PRD-010-B: un usuario sin el rol no entra

**When**: con el token de un usuario autenticado **sin ningún rol**, `GET /api/v1/products` y
`POST /api/v1/products/batch` con un lote de un elemento válido (`sku: "SEC-0004"`).
**Then**:
1. Las dos responden `403` con `code: ACCESS_DENIED`.
2. No se creó nada: con el token del titular, no existe ningún producto `SEC-0004`.

## Lo que no tiene escenario, y por qué

- **Un `Idempotency-Key` caducado.** El `ttlSeconds` es de 24 horas: ningún flujo puede esperarlo, y
  envejecer el registro exigiría escribir en el almacén.
- **La repetición de un lote mientras el primero sigue en marcha** (`409 IDEMPOTENCY_KEY_IN_PROGRESS`) y
  **la que reanuda un lote cortado a mitad**. Las dos piden detener el servidor dentro de un lote, que una
  petición de caja negra no puede hacer; las mide la red de cada generador (BK-3 y BK-4).
- **Un trabajo `aborted`.** Un elemento que detiene el lote es un fallo de infraestructura o un defecto, no
  algo que una petición válida provoque.
- **La purga de los trabajos y de sus resultados.** Su retención es de días, como la de la clave.
