# product-catalog — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/product-catalog v1.1.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la silueta más simple que un generador tiene que servir
> entera: un agregado con su lifecycle, unicidad por clave natural, un value object monetario con
> escala, paginación y la idempotencia del alta. Es el diseño de la primera corrida de keel-nest, y el
> mismo documento tiene que pasar al 100% contra el servidor de keel-spring.

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
- **Orden de los listados**: `listProducts` no declara orden. Los escenarios del listado afirman **qué
  elementos** trae cada página y sus metadatos, nunca en qué posición viene cada uno.
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
   `items`, cada uno con la forma de la respuesta de `getProduct` (sin `apiToken`).

#### FL-PRD-005-B: la segunda página trae el resto

**When**: `GET /api/v1/products?page=1&size=2`.
**Then**:
1. `{items, page: 1, size: 2, totalElements: 3, totalPages: 2}`, con **un** elemento.
2. Entre las dos páginas están los tres skus, cada uno una sola vez.

#### FL-PRD-005-C: sin tamaño, la página es la del diseño

**When**: `GET /api/v1/products`.
**Then**:
1. `size: 20` (el `defaultSize` de `api.keel.yaml`), `page: 0`, `totalElements: 3`, `totalPages: 1` y
   los tres productos en `items`.

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

## Lo que no tiene escenario, y por qué

- **Un `Idempotency-Key` caducado.** El `ttlSeconds` es de 24 horas: ningún flujo puede esperarlo, y
  envejecer el registro exigiría escribir en el almacén.
