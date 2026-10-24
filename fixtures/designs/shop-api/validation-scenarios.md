# shop-api — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/shop-api v0.1.0. Contrato de validación para la fase de generación.
> Son escenarios de CARACTERIZACIÓN: cada flujo sale de una grabación de legacy/shop-api y lleva su marca (`keep`, `fix`, `frontier` o `new`).
> Reescritos el 2026-10-23 tras aplicar las respuestas de legacy/shop-api/questions.yaml.
> Revisados el 2026-10-23 al cerrar el diseño: los cuerpos de mergeCart y modifyCartItem son objetos del diseño, la ausencia de un
> campo se afirma como ausencia, y los flujos nuevos (FL-ACC-013 a FL-ACC-015, FL-CRT-013 a FL-CRT-017, FL-ORD-022 a FL-ORD-024,
> FL-SEL-015 y FL-SEL-016) recogen las decisiones del cierre.
> Segunda vuelta del cierre (2026-10-23): el orden de las guardas, los datos, la identidad y la persistencia. Flujos nuevos:
> FL-CAT-009, FL-ACC-016, FL-ACC-017, FL-CRT-018 a FL-CRT-020, FL-ORD-025, FL-ORD-026 y FL-SEL-017 a FL-SEL-021; FL-SEL-005
> pierde su segundo paso, que pasa a FL-SEL-017.
> Tercera vuelta del cierre (2026-10-23): fix-order-amount-max (FL-ORD-027), patrón de productId (FL-SEL-022) y productStock de la línea sin máximo (FL-ORD-026).

## Convenciones de determinación

- **Ausencia vs nulo**: un campo sin valor viaja como `null` (`conventions.nulls: include`); el legacy también lo manda a `null` (`productIcon: null` en R0-034). Un campo que el servicio nuevo ya no devuelve (`password`, `role`) **no viaja**: ni con valor ni como `null`, porque no está en el `output` de ninguna operación. Los flujos que lo demuestran afirman su ausencia; en el bloque `keel-flow` se escribe `null`, que `semantics.absentIsNull` de contract-map.yaml casa con ausente (el lenguaje de los pasos no tiene otra forma de decir «ausente»).
- **Dinero**: `productPrice`, `orderAmount` son decimales de escala 2 con `scalePolicy: reject`: una entrada con más de dos decimales responde `400` (domain-decimal-scale-policy; FL-SEL-014). Un precio de `30.00` y uno de `30` se tratan como el mismo número.
- **Fechas**: `createTime` y `updateTime` son instantes UTC en ISO-8601 con milisegundos y `Z` (contrato del cable, `docs/wire-contract.md`); los escenarios no afirman su valor salvo por forma (`startsWith`) donde el flujo lo demuestra.
- **Identificadores generados**: `id`, `orderId` y `cartId` de lo que crea un flujo se tratan por forma y por reutilización simbólica (`oid`), no por valor. Los ids del seed (`2147483648`...) sí son estables.
- **Orden de las colecciones**: `listProducts` y `listProductsByCategory` ordenan por `productId` ascendente; `listOrders` por `orderStatus`, `createTime` descendente y, para desempatar, `orderId` ascendente. Un enum se ordena por la posición de su declaración (NEW, FINISHED, CANCELED) y no por su nombre; el `createTime` de los pedidos del seed se declara en el Given del flujo que depende de él (FL-ORD-006). Las líneas de un pedido o de un carrito (`products`) salen ordenadas por `id` ascendente, aunque los flujos solo afirman una línea concreta cuando el carrito o el pedido tiene una sola.
- **Mayúsculas y acentos**: el email se compara tal cual (`compare: exact`), y el `productId` también: `B0001` y `b0001` son dos códigos distintos.
- **Mensaje del error**: `message` no es contrato. Los flujos afirman `status` y `code` y la forma del cuerpo de error del cable; el texto y su idioma pueden cambiar.
- **Cuerpos como objetos**: el cuerpo de un paso es el del diseño. `mergeCart` manda `{items: [...]}` y `modifyCartItem` manda `{quantity: n}`; el legacy espera la lista y el número sin envoltura, y es contract-map.yaml el que desenvuelve el cuerpo hacia el legacy (fix-wire-contract).
- **Versión del producto**: `updateProduct` manda la `version` del producto (fix-update-product-version). Un producto del seed tiene `version` 0 y cada escritura la sube 1; el legacy ignora el campo.
- **Estados con nombre**: `orderStatus` viaja como `NEW`, `FINISHED` o `CANCELED` y `productStatus` como `UP` o `DOWN` (fix-status-names); el legacy los manda como 0, 1 y 2, y 0 y 1. Solo FL-CAT-008, FL-ORD-017 y FL-SEL-013 los afirman, para que cada diferencia salga de un único flujo.
- **Forma del cuerpo de error**: la del contrato del cable de Keel (`code`, `message`...); contra el legacy solo se compara el status porque su cuerpo de error es otro (fix-wire-contract).
- **Paginación**: el tamaño por defecto es 10 y el máximo 100 (api-pagination); un `size` mayor que 100 se recorta. Los flujos que comparan con el legacy piden `size` salvo FL-CAT-002, que mide justo el valor por defecto, y cuentan las páginas desde 0 (fix-pagination-envelope).
- **Estado de partida**: cada flujo parte del seed del legacy (src/main/resources/import.sql): 12 productos (`B0001` a `B0005`, `C0001` a `C0003`, `D0001`, `D0002`, `F0001`, `F0002`), 4 categorías, los usuarios `customer1`, `customer2`, `employee1` y `manager1`, carritos vacíos y ocho pedidos, tres de ellos de `customer1` (`2147483648` finalizado, `2147483642` y `2147483640` cancelados).
- **Actores**: `c1` es `customer1@email.com`, `m1` es `manager1@email.com`, `e1` es `employee1@email.com` y `n1` es una persona sin perfil todavía (clase `newcomer`); un paso sin `as` va sin credencial. La identidad la pone el proveedor OIDC (fix-identity-oidc): el servicio nuevo recibe un token con el claim `email`, y el legacy, el JWT que emite su propio login con las cuentas del seed.
- **Campos que solo manda el legacy**: el cuerpo de un paso es el del diseño más lo que el legacy exige y el servicio nuevo ignora (el `email` del alta, que el servicio nuevo toma del token, y las líneas completas de `mergeCart`, de las que solo usa `productId` y `count`). El resto (`password`, `role` y `active` del alta, `password` de la actualización de perfil, `productStatus` de las altas y ediciones de producto) lo añade contract-map.yaml → `extraInput`. El servicio nuevo no recibe `active`: lo fija a `true` (fix-register-active-true), y FL-ACC-014 es el único flujo que lo manda, para que el legacy lo respete.
- **Códigos de estado**: `ok` es 200 en los dos lados; `no-content` es 200 en el legacy y 204 en el servicio nuevo (fix-void-204), y los flujos la usan en checkout, quitar una línea y borrar un producto salvo FL-ORD-018, que fija el cambio con números.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| listProducts | FL-CAT-001, FL-CAT-002, FL-CAT-007, FL-CAT-008 | usuarios |
| getProduct | FL-CAT-003, FL-CAT-004, FL-SEL-022 | usuarios |
| listProductsByCategory | FL-CAT-005, FL-CAT-006, FL-CAT-009 | usuarios |
| register | FL-ACC-001, FL-ACC-002, FL-ACC-004, FL-ACC-005, FL-ACC-012, FL-ACC-014, FL-ACC-016, FL-ACC-017 | usuarios |
| getProfile | FL-ACC-008, FL-ACC-009, FL-ACC-010, FL-ACC-015 | usuarios |
| updateProfile | FL-ACC-010, FL-ACC-011, FL-ACC-012, FL-ACC-013, FL-ACC-015 | usuarios |
| getCart | FL-CRT-001, FL-CRT-002, FL-CRT-014, FL-CRT-019, FL-CRT-020 | usuarios |
| mergeCart | FL-CRT-008, FL-CRT-012, FL-CRT-013, FL-CRT-014, FL-CRT-015, FL-CRT-018, FL-CRT-019 | usuarios |
| addToCart | FL-CRT-003, FL-CRT-004, FL-CRT-005, FL-CRT-006, FL-CRT-007, FL-CRT-013, FL-CRT-014, FL-CRT-018, FL-CRT-020, FL-ORD-026, FL-ORD-027 | usuarios |
| modifyCartItem | FL-CRT-009, FL-CRT-010, FL-CRT-014, FL-CRT-016, FL-CRT-017 | usuarios |
| removeCartItem | FL-CRT-011, FL-CRT-014, FL-ORD-018 | usuarios |
| checkout | FL-ORD-001, FL-ORD-002, FL-ORD-003, FL-ORD-004, FL-ORD-016, FL-ORD-018, FL-ORD-019, FL-ORD-020, FL-ORD-022, FL-ORD-023, FL-ORD-026, FL-ORD-027, FL-CRT-014 | usuarios |
| listOrders | FL-ORD-005, FL-ORD-006, FL-ORD-007, FL-ORD-024 | usuarios |
| getOrder | FL-ORD-008, FL-ORD-009, FL-ORD-017 | usuarios |
| cancelOrder | FL-ORD-013, FL-ORD-014, FL-ORD-015, FL-ORD-017, FL-ORD-021, FL-ORD-025, FL-ORD-026 | usuarios |
| finishOrder | FL-ORD-010, FL-ORD-011, FL-ORD-012, FL-ORD-017 | usuarios |
| createProduct | FL-SEL-001, FL-SEL-002, FL-SEL-003, FL-SEL-004, FL-SEL-005, FL-SEL-013, FL-SEL-014, FL-SEL-015, FL-SEL-017, FL-SEL-019, FL-SEL-020, FL-SEL-022, FL-CRT-020, FL-ORD-026, FL-ORD-027 | usuarios |
| updateProduct | FL-SEL-004, FL-SEL-006, FL-SEL-007, FL-SEL-008, FL-SEL-009, FL-SEL-015, FL-SEL-016, FL-SEL-018, FL-SEL-021, FL-ORD-026 | usuarios |
| deleteProduct | FL-SEL-010, FL-SEL-011, FL-SEL-012, FL-ORD-015, FL-ORD-018, FL-ORD-022 | usuarios |

## Catálogo

### FL-CAT-001: el listado del catálogo va ordenado por código

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-001.json.

**Given**: Los 12 productos del seed.
**When**: `listProducts` (`GET /api/v1/product`) con `size` 3, sin credencial.
**Then**:
1. Status 200.
2. `items` tiene 3 elementos: `B0001`, `B0002` y `B0003`, en ese orden: el catálogo incluye los productos fuera de venta (`B0003`).
3. `totalElements` vale 12.

```keel-flow
actors: {}
steps:
  - op: listProducts
    query: { size: 3 }
    expect:
      status: ok
      body:
        items.length: 3
        items.0.productId: B0001
        items.1.productId: B0002
        items.2.productId: B0003
        totalElements: 12
```

### FL-CAT-002: la paginación de Keel cuenta desde 0 y sustituye lo que está fuera de rango

**Caracterización**: `fix` (`fix-pagination-envelope`: el legacy cuenta las páginas desde 1 y falla con 500 o 400; recordings/round-0/R0-003.json, R0-004.json y R0-005.json).

**Given**: Los 12 productos del seed.
**When**: `listProducts` con `page=0`, con `size=0`, con `page=abc` y con `page=1` y `size=3`, sin credencial.
**Then**:
1. Los tres primeros responden 200 (el legacy responde 500, 500 y 400) con 10 elementos, el primero `B0001`, y `totalElements` 12: el tamaño por defecto es 10.
2. `page=1` con `size=3` responde 200 con `B0004`, `B0005` y `C0001`: la página 1 es la segunda (el legacy devuelve la primera, que empieza en `B0001`).

```keel-flow
actors: {}
steps:
  - op: listProducts
    query: { page: 0 }
    legacy: { status: 500 }
    expect:
      status: ok
      body:
        items.length: 10
        items.0.productId: B0001
        totalElements: 12
  - op: listProducts
    query: { size: 0 }
    legacy: { status: 500 }
    expect:
      status: ok
      body:
        items.length: 10
        items.0.productId: B0001
        totalElements: 12
  - op: listProducts
    query: { page: abc }
    legacy: { status: 400 }
    expect:
      status: ok
      body:
        items.length: 10
        items.0.productId: B0001
        totalElements: 12
  - op: listProducts
    query: { page: 1, size: 3 }
    legacy:
      status: ok
      body:
        items.0.productId: B0001
        items.2.productId: B0003
    expect:
      status: ok
      body:
        items.length: 3
        items.0.productId: B0004
        items.1.productId: B0005
        items.2.productId: C0001
```

### FL-CAT-003: un producto se recupera por su código

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-006.json.

**Given**: El producto `B0003`.
**When**: `getProduct` con `productId` `B0003`, sin credencial.
**Then**:
1. Status 200.
2. Cuerpo: `productId` `B0003`, `productName` `Head First`, `productPrice` 10, `productStock` 200, `productDescription` `Java EE` y `categoryType` 0.

```keel-flow
actors: {}
steps:
  - op: getProduct
    params: { productId: B0003 }
    expect:
      status: ok
      body:
        productId: B0003
        productName: Head First
        productPrice: 10
        productStock: 200
        productDescription: Java EE
        categoryType: 0
```

### FL-CAT-004: un producto que no existe es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 200 con el cuerpo vacío; recordings/round-0/R0-007.json).

**Given**: Ningún producto con código `NOPE`.
**When**: `getProduct` con `productId` `NOPE`, sin credencial.
**Then**:
1. Falla con status 404 y `code: PRODUCT_NOT_FOUND` (el legacy responde 200 con el cuerpo vacío).

```keel-flow
actors: {}
steps:
  - op: getProduct
    params: { productId: NOPE }
    legacy: { status: ok }
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
```

### FL-CAT-005: los productos de una categoría se listan por código

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-008.json.

**Given**: La categoría de tipo 0 (`Books`) con 5 productos.
**When**: `listProductsByCategory` con `categoryType` 0 y `size` 2, sin credencial.
**Then**:
1. Status 200.
2. `items` tiene 2 elementos: `B0001` y `B0002`, en ese orden.
3. `totalElements` vale 5.

```keel-flow
actors: {}
steps:
  - op: listProductsByCategory
    params: { categoryType: 0 }
    query: { size: 2 }
    expect:
      status: ok
      body:
        items.length: 2
        items.0.productId: B0001
        items.1.productId: B0002
        totalElements: 5
```

### FL-CAT-006: una categoría que no existe es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 500; recordings/round-0/R0-009.json y R0-010.json).

**Given**: Ninguna categoría de tipo 99.
**When**: `listProductsByCategory` con `categoryType` 99 y luego con `categoryType` `abc`, sin credencial.
**Then**:
1. La categoría 99 falla con status 404 y `code: CATEGORY_NOT_FOUND` (el legacy responde 500 con "Category does not exit!").
2. El tipo `abc` falla con status 400 en los dos lados.

```keel-flow
actors: {}
steps:
  - op: listProductsByCategory
    params: { categoryType: 99 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: CATEGORY_NOT_FOUND
  - op: listProductsByCategory
    params: { categoryType: abc }
    expect:
      status: 400
```

### FL-CAT-007: un size mayor que el máximo se recorta

**Caracterización**: `new`. Decisión: api-pagination (el legacy no acota el `size`).

**Given**: Los 12 productos del seed.
**When**: `listProducts` con `size` 1000, sin credencial.
**Then**:
1. Status 200, sin error.
2. El sobre dice `size` 100 (el máximo, no el pedido), `page` 0, `totalElements` 12 y `totalPages` 1.
3. `items` tiene los 12 productos, de `B0001` a `F0002` por código.

### FL-CAT-008: el estado de un producto viaja con nombre

**Caracterización**: `fix` (`fix-status-names`: el legacy manda `productStatus` como 0 y 1; recordings/round-0/R0-001.json).

**Given**: Los productos `B0001` (a la venta) y `B0003` (fuera de venta).
**When**: `listProducts` con `size` 3, sin credencial.
**Then**:
1. Status 200.
2. `items.0.productStatus` vale `UP` (el legacy manda 0) y `items.2.productStatus` vale `DOWN` (el legacy manda 1).

```keel-flow
actors: {}
steps:
  - op: listProducts
    query: { size: 3 }
    legacy:
      status: ok
      body:
        items.0.productStatus: 0
        items.2.productStatus: 1
    expect:
      status: ok
      body:
        items.0.productId: B0001
        items.0.productStatus: UP
        items.2.productId: B0003
        items.2.productStatus: DOWN
```

### FL-CAT-009: los productos de una categoría incluyen los que están fuera de venta

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-008.json (`totalElements` 5 en la categoría 0) y R0-001.json (`B0003` con `productStatus` 1, fuera de venta).

**Given**: La categoría de tipo 0 (`Books`) con 5 productos, uno de ellos `B0003`, fuera de venta (`DOWN`).
**When**: `listProductsByCategory` con `categoryType` 0 y `size` 5, sin credencial.
**Then**:
1. Status 200 y `totalElements` 5: `listProductsByCategory` aplica el mismo filtro de estado que `listProducts`, que no filtra.
2. `items.2` es `B0003`, el producto fuera de venta.

```keel-flow
actors: {}
steps:
  - op: listProductsByCategory
    params: { categoryType: 0 }
    query: { size: 5 }
    expect:
      status: ok
      body:
        totalElements: 5
        items.length: 5
        items.2.productId: B0003
```

## Cuentas y perfil

### FL-ACC-001: un alta válida crea el perfil de un cliente

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-011.json.

**Given**: Una persona `n1` autenticada que todavía no tiene perfil (en el legacy, ningún usuario `new1@x.io`).
**When**: `register` como `n1` con `{email: new1@x.io, name: nuevo, phone: "555", address: "Calle 1"}` (el `email` solo lo exige el legacy: el servicio nuevo toma el del token; y `active` true lo añade el mapa al legacy).
**Then**:
1. Status 200.
2. Cuerpo: `name` `nuevo`, `phone` `555`, `address` `Calle 1` y `active` true.

```keel-flow
actors: { n1: newcomer }
steps:
  - op: register
    as: n1
    input: { email: new1@x.io, name: nuevo, phone: "555", address: Calle 1 }
    expect:
      status: ok
      body:
        name: nuevo
        phone: "555"
        address: Calle 1
        active: true
```

### FL-ACC-002: el alta no acepta un rol

**Caracterización**: `fix` (`fix-register-role-escalation`: el legacy da de alta con el rol que manda el solicitante; recordings/round-0/R0-015.json).

**Given**: Una persona `n1` autenticada sin perfil (en el legacy, ningún usuario `mgr@x.io`).
**When**: `register` como `n1` con `role: ROLE_MANAGER` en el cuerpo.
**Then**:
1. Status 200.
2. El cuerpo no lleva `role`: el campo está ausente, no es `null`; el servicio nuevo no acepta ni devuelve un rol (el legacy responde `role` `ROLE_MANAGER` y el usuario queda como vendedor).

```keel-flow
actors: { n1: newcomer }
steps:
  - op: register
    as: n1
    input: { email: mgr@x.io, name: m, phone: "1", address: b, role: ROLE_MANAGER }
    legacy:
      status: ok
      body:
        role: ROLE_MANAGER
    expect:
      status: ok
      body:
        # Ausente: register no tiene role en su output. Un paso no tiene otra forma de decirlo que null (absentIsNull).
        role: null
```

### FL-ACC-004: un alta con campos vacíos se rechaza

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-013.json.

**Given**: Una persona `n1` autenticada sin perfil.
**When**: `register` como `n1` con todos los campos vacíos.
**Then**:
1. Falla con status 400.

```keel-flow
actors: { n1: newcomer }
steps:
  - op: register
    as: n1
    input: { email: "", password: ab, name: "", phone: "", address: "" }
    expect:
      status: 400
```

### FL-ACC-005: un email repetido es un conflicto

**Caracterización**: `fix` (`fix-register-email-409`: el legacy responde 400 a un email repetido; recordings/round-0/R0-012.json).

**Given**: Una persona `n1` autenticada sin perfil.
**When**: `register` dos veces como `n1` con los mismos datos.
**Then**:
1. El primer alta responde 200.
2. El segundo falla con status 409 y `code: EMAIL_ALREADY_EXISTS` (el legacy responde 400 sin cuerpo).

```keel-flow
actors: { n1: newcomer }
steps:
  - op: register
    as: n1
    input: { email: new1@x.io, name: nuevo, phone: "555", address: Calle 1 }
    expect:
      status: ok
  - op: register
    as: n1
    input: { email: new1@x.io, name: nuevo, phone: "555", address: Calle 1 }
    legacy: { status: 400 }
    expect:
      status: 409
      code: EMAIL_ALREADY_EXISTS
```

### FL-ACC-008: cada usuario lee su propio perfil

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-021.json.

**Given**: El usuario `manager1` del seed.
**When**: `getProfile` con `email` `manager1@email.com` como `m1`.
**Then**:
1. Status 200.
2. Cuerpo: `email` `manager1@email.com`, `name` `manager1`, `phone` `987654321`, `address` `2000 John Road` y `active` true.

```keel-flow
actors: { m1: manager }
steps:
  - op: getProfile
    as: m1
    params: { email: manager1@email.com }
    expect:
      status: ok
      body:
        email: manager1@email.com
        name: manager1
        phone: "987654321"
        address: 2000 John Road
        active: true
```

### FL-ACC-009: el perfil de otro usuario es un 403

**Caracterización**: `fix` (`fix-ownership-403`: el legacy responde 400 sin cuerpo; recordings/round-0/R0-022.json y R0-023.json).

**Given**: Los usuarios `customer1` y `manager1` del seed.
**When**: `getProfile` con `email` `manager1@email.com` como `c1`, y sin credencial.
**Then**:
1. Como `c1` falla con status 403 y `code: PROFILE_NOT_OWNED` (el legacy responde 400).
2. Sin credencial falla con status 401 en los dos lados.

```keel-flow
actors: { c1: customer }
steps:
  - op: getProfile
    as: c1
    params: { email: manager1@email.com }
    legacy: { status: 400 }
    expect:
      status: 403
      code: PROFILE_NOT_OWNED
  - op: getProfile
    params: { email: manager1@email.com }
    expect:
      status: 401
```

### FL-ACC-010: el perfil propio se actualiza

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-024.json.

**Given**: El usuario `customer1` del seed.
**When**: `updateProfile` como `c1` con `{email: customer1@email.com, name: c1b, phone: "999", address: "Otra 2"}` y luego `getProfile` de su email.
**Then**:
1. La actualización responde 200 con `email` `customer1@email.com`, `name` `c1b`, `phone` `999` y `address` `Otra 2`.
2. La lectura devuelve `name` `c1b`.

```keel-flow
actors: { c1: customer }
steps:
  - op: updateProfile
    as: c1
    input: { email: customer1@email.com, name: c1b, phone: "999", address: Otra 2 }
    expect:
      status: ok
      body:
        email: customer1@email.com
        name: c1b
        phone: "999"
        address: Otra 2
  - op: getProfile
    as: c1
    params: { email: customer1@email.com }
    expect:
      status: ok
      body:
        name: c1b
```

### FL-ACC-011: no se actualiza el perfil de otro

**Caracterización**: `fix` (`fix-ownership-403`: el legacy responde 400 sin cuerpo; recordings/round-0/R0-025.json).

**Given**: Los usuarios `customer1` y `manager1` del seed.
**When**: `updateProfile` como `c1` con el email de `manager1`.
**Then**:
1. Falla con status 403 y `code: PROFILE_NOT_OWNED` (el legacy responde 400).

```keel-flow
actors: { c1: customer }
steps:
  - op: updateProfile
    as: c1
    input: { email: manager1@email.com, name: x, phone: "1", address: y }
    legacy: { status: 400 }
    expect:
      status: 403
      code: PROFILE_NOT_OWNED
```

### FL-ACC-012: ninguna respuesta de cuenta devuelve la contraseña

**Caracterización**: `fix` (`fix-password-hash-exposure`: el legacy devuelve la contraseña codificada; recordings/round-0/R0-011.json, R0-021.json y R0-024.json).

**Given**: Una persona `n1` sin perfil y los usuarios `manager1` y `customer1` del seed.
**When**: `register` como `n1`, `getProfile` de `manager1@email.com` como `m1` y `updateProfile` como `c1`.
**Then**:
1. Las tres respuestas son 200 y ninguna lleva `password`: el campo está ausente, no es `null` (el legacy devuelve una codificación que empieza por `$2a$`).

```keel-flow
actors: { n1: newcomer, m1: manager, c1: customer }
steps:
  - op: register
    as: n1
    input: { email: new1@x.io, name: nuevo, phone: "555", address: Calle 1 }
    legacy:
      status: ok
      body:
        password: { startsWith: "$2a$" }
    expect:
      status: ok
      body:
        # Ausente: ningún output de cuenta tiene password (null casa con ausente por absentIsNull).
        password: null
  - op: getProfile
    as: m1
    params: { email: manager1@email.com }
    legacy:
      status: ok
      body:
        password: { startsWith: "$2a$" }
    expect:
      status: ok
      body:
        password: null
  - op: updateProfile
    as: c1
    input: { email: customer1@email.com, name: c1b, phone: "999", address: Otra 2 }
    legacy:
      status: ok
      body:
        password: { startsWith: "$2a$" }
    expect:
      status: ok
      body:
        password: null
```

### FL-ACC-013: un campo que no llega al actualizar el perfil se conserva

**Caracterización**: `fix` (`fix-profile-partial-update`: el legacy sustituye nombre, teléfono y dirección con lo que llega y rechaza con 400 una actualización a la que le falta alguno; recordings/round-0/R0-026.json y UserServiceImpl.java:61-70, User.java:34-39).

**Given**: El usuario `customer1` del seed, con teléfono `123456789` y dirección `3200 West Road`.
**When**: `updateProfile` como `c1` con `{email: customer1@email.com, name: solo}` y luego `getProfile` de su email.
**Then**:
1. La actualización responde 200 con `name` `solo`, `phone` `123456789` y `address` `3200 West Road`: lo que no llegó se conserva (el legacy responde 400).
2. La lectura devuelve los mismos tres valores (el legacy responde 200 con el perfil sin tocar).

```keel-flow
actors: { c1: customer }
steps:
  - op: updateProfile
    as: c1
    input: { email: customer1@email.com, name: solo }
    legacy: { status: 400 }
    expect:
      status: ok
      body:
        name: solo
        phone: "123456789"
        address: 3200 West Road
  - op: getProfile
    as: c1
    params: { email: customer1@email.com }
    legacy: { status: ok }
    expect:
      status: ok
      body:
        name: solo
        phone: "123456789"
        address: 3200 West Road
```

### FL-ACC-014: el alta siempre deja la cuenta activa

**Caracterización**: `fix` (`fix-register-active-true`: el legacy respeta el `active` que manda el solicitante, y un usuario con `active` false no inicia sesión; recordings/round-0/R0-016.json).

**Given**: Una persona `n1` autenticada sin perfil (en el legacy, ningún usuario `inact@x.io`).
**When**: `register` como `n1` con `{email: inact@x.io, name: m, phone: "1", address: b, active: false}` (el servicio nuevo ignora `active`: el diseño no lo recibe).
**Then**:
1. Status 200.
2. `active` vale true (el legacy responde false).

```keel-flow
actors: { n1: newcomer }
steps:
  - op: register
    as: n1
    input: { email: inact@x.io, name: m, phone: "1", address: b, active: false }
    legacy:
      status: ok
      body:
        active: false
    expect:
      status: ok
      body:
        active: true
```

### FL-ACC-015: sin perfil no hay nada que leer ni que actualizar

**Caracterización**: `new`. Decisión: gaps clase 2 (updateProfile) y clase 5 (getProfile), 2026-10-23: con la identidad en un proveedor, una persona puede estar autenticada sin haber llamado a `register`, algo imposible en el legacy.

**Given**: Una persona `n1` autenticada que todavía no ha llamado a `register`.
**When**: Como `n1`, `getProfile` de su propio email, `updateProfile` con `{email: <su email>, name: x}`, `register` y `getProfile` otra vez.
**Then**:
1. `getProfile` y `updateProfile` fallan con status 404 y `code: PROFILE_NOT_FOUND`.
2. Tras `register`, `getProfile` responde 200 con su perfil.

### FL-ACC-016: un token sin email es un 401 y el email no verificado no se rechaza

**Caracterización**: `new`. Decisión: gaps clase 9 (register), segunda vuelta del cierre, 2026-10-23: la identidad es el claim `email` del token; el legacy emite su propio JWT con el email como `subject` y no puede producir ninguno de estos dos casos.

**Given**: Dos personas autenticadas sin perfil: una con un token válido que no lleva el claim `email`, y otra cuyo token trae `email` `unverified@x.io` y el proveedor lo marca como no verificado.
**When**: `register` con cada una, con `{name: m, phone: "1", address: b}`.
**Then**:
1. La del token sin `email` falla con status 401 y `code: UNAUTHENTICATED`, y no se crea ningún perfil.
2. La del email no verificado responde 200 con un perfil cuyo `email` es `unverified@x.io`: el servicio no exige que el proveedor haya verificado el email.

### FL-ACC-017: el email se compara tal cual, distinguiendo mayúsculas

**Caracterización**: `new`. Decisión: gaps clase 12 (User.email), segunda vuelta del cierre, 2026-10-23: `User.email` declara `compare: exact`; el legacy no se sondeó con dos emails que difieran solo en mayúsculas.

**Given**: Dos personas autenticadas sin perfil, `n1` con el claim `email` `Bob@x.io` y `n2` con `bob@x.io`.
**When**: `register` como `n1` y como `n2`, y luego `getProfile` de `Bob@x.io` como `n2`.
**Then**:
1. Los dos altas responden 200 y crean dos perfiles distintos: `Bob@x.io` y `bob@x.io` no son el mismo email, así que no hay `EMAIL_ALREADY_EXISTS`.
2. `getProfile` de `Bob@x.io` como `n2` falla con status 403 y `code: PROFILE_NOT_OWNED`: la propiedad también compara tal cual.

## Carrito

### FL-CRT-001: el carrito de un cliente nuevo está vacío

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-028.json.

**Given**: El usuario `customer1` del seed, sin líneas en su carrito.
**When**: `getCart` como `c1`.
**Then**:
1. Status 200.
2. `products` está vacío.

```keel-flow
actors: { c1: customer }
steps:
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 0
```

### FL-CRT-002: el carrito es solo de clientes

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-027.json.

**Given**: Los usuarios `manager1` del seed.
**When**: `getCart` sin credencial y como `m1`.
**Then**:
1. Sin credencial: status 401.
2. Como `m1` (vendedor): status 403.

```keel-flow
actors: { m1: manager }
steps:
  - op: getCart
    expect:
      status: 401
  - op: getCart
    as: m1
    expect:
      status: 403
```

### FL-CRT-003: añadir un producto crea su línea con los datos del catálogo

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-029.json.

**Given**: El carrito vacío de `customer1` y el producto `B0001` con stock 96.
**When**: `addToCart` como `c1` con `productId` `B0001` y `quantity` 2, y luego `getCart`.
**Then**:
1. El alta responde 200.
2. El carrito tiene 1 línea: `productId` `B0001`, `productName` `Core Java`, `productPrice` 30, `productStock` 96 y `count` 2.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0001
        products.0.productName: Core Java
        products.0.productPrice: 30
        products.0.productStock: 96
        products.0.count: 2
```

### FL-CRT-004: añadir dos veces el mismo producto suma las cantidades

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-030.json.

**Given**: El carrito vacío de `customer1`.
**When**: `addToCart` dos veces con `B0001` y `quantity` 2, y luego `getCart`.
**Then**:
1. Las dos altas responden 200.
2. El carrito tiene 1 sola línea de `B0001` con `count` 4.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0001
        products.0.count: 4
```

### FL-CRT-005: añadir un producto que no existe no cambia el carrito

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-031.json.

**Given**: El carrito vacío de `customer1` y ningún producto `NOPE`.
**When**: `addToCart` con `productId` `NOPE` y luego `getCart`.
**Then**:
1. El alta responde 200 (con `added` false en el servicio nuevo).
2. El carrito sigue vacío.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: NOPE, quantity: 1 }
    expect:
      status: ok
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 0
```

### FL-CRT-006: una cantidad o una línea inválidas son un 400

**Caracterización**: `fix` (`fix-cart-quantity-validation`: el legacy responde 200 y no guarda nada; recordings/round-0/R0-032.json y R0-035.json).

**Given**: El carrito vacío de `customer1`.
**When**: `addToCart` con `B0001` y `quantity` 0, luego con -3; `mergeCart` con una línea de `B0001` de `count` 0; y `getCart`.
**Then**:
1. Los tres primeros pasos fallan con status 400 (el legacy responde 200 y no guarda nada).
2. El carrito sigue vacío en los dos lados.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 0 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: -3 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0001, productName: Core Java, productDescription: Books for learning Java, categoryType: 0, productPrice: 30.00, productStock: 96, count: 0 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 0
```

### FL-CRT-007: añadir más que el stock se acepta

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-033.json.

**Given**: El carrito vacío de `customer1` y `B0001` con stock 96.
**When**: `addToCart` con `B0001` y `quantity` 100000 y luego `getCart`.
**Then**:
1. El alta responde 200.
2. El carrito tiene 1 línea de `B0001` con `count` 100000: el stock se decide en el checkout.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 100000 }
    expect:
      status: ok
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 1
        products.0.count: 100000
```

### FL-CRT-008: fusionar el carrito local añade las líneas

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-034.json.

**Given**: El carrito vacío de `customer1`.
**When**: `mergeCart` con una lista vacía y luego con una línea de `B0002` (`count` 3 y los datos del catálogo).
**Then**:
1. La lista vacía responde 200 con `products` vacío.
2. La línea responde 200 con 1 línea: `productId` `B0002`, `productName` `Spring In Action`, `productPrice` 20 y `count` 3.

```keel-flow
actors: { c1: customer }
steps:
  - op: mergeCart
    as: c1
    input: { items: [] }
    expect:
      status: ok
      body:
        products.length: 0
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0002, productName: Spring In Action, productDescription: Learn Spring, categoryType: 0, productPrice: 20.00, productStock: 195, count: 3 }
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0002
        products.0.productName: Spring In Action
        products.0.productPrice: 20
        products.0.count: 3
```

### FL-CRT-009: cambiar la cantidad de una línea devuelve la línea

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-036.json.

**Given**: El carrito de `customer1` con una línea de `B0002` y `count` 1.
**When**: `modifyCartItem` con `productId` `B0002` y cantidad 5.
**Then**:
1. Status 200.
2. Cuerpo: `productId` `B0002`, `productName` `Spring In Action` y `count` 5.

```keel-flow
actors: { c1: customer }
steps:
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0002, productName: Spring In Action, productDescription: Learn Spring, categoryType: 0, productPrice: 20.00, productStock: 195, count: 1 }
    expect:
      status: ok
  - op: modifyCartItem
    as: c1
    params: { productId: B0002 }
    input: { quantity: 5 }
    expect:
      status: ok
      body:
        productId: B0002
        productName: Spring In Action
        count: 5
```

### FL-CRT-010: cambiar la cantidad de una línea que no está es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 200 con el cuerpo vacío; recordings/round-0/R0-037.json).

**Given**: El carrito vacío de `customer1`.
**When**: `modifyCartItem` con `productId` `B0002` y cantidad 5.
**Then**:
1. Falla con status 404 y `code: CART_ITEM_NOT_FOUND` (el legacy responde 200 con el cuerpo vacío y no cambia nada).

```keel-flow
actors: { c1: customer }
steps:
  - op: modifyCartItem
    as: c1
    params: { productId: B0002 }
    input: { quantity: 5 }
    legacy: { status: ok }
    expect:
      status: 404
      code: CART_ITEM_NOT_FOUND
```

### FL-CRT-011: quitar una línea la borra y repetirlo no falla

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-038.json.

**Given**: El carrito vacío de `customer1`.
**When**: `addToCart` con `B0001` x2, `removeCartItem` de `B0001` dos veces y `getCart`.
**Then**:
1. Las dos bajas responden sin cuerpo.
2. El carrito queda vacío.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: removeCartItem
    as: c1
    params: { productId: B0001 }
    expect:
      status: no-content
  - op: removeCartItem
    as: c1
    params: { productId: B0001 }
    expect:
      status: no-content
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 0
```

### FL-CRT-012: la línea del carrito toma sus datos del catálogo

**Caracterización**: `fix` (`fix-cart-client-price`: el legacy guarda la línea con los datos y el precio que manda el cliente; recordings/round-0/R0-034.json).

**Given**: El carrito vacío de `customer1`, `B0002` con precio 20 y su icono, y ningún producto `NOPE`.
**When**: `mergeCart` con una línea de `B0002` con `productName` `Hacked`, `productPrice` 0.01 y sin icono; y luego `mergeCart` con una línea de `NOPE`.
**Then**:
1. La primera responde 200 con `productName` `Spring In Action`, `productPrice` 20 y el icono del catálogo (el legacy conserva `Hacked`, 0.01 y `productIcon` null).
2. La segunda falla con status 404 y `code: PRODUCT_NOT_FOUND` (el legacy responde 200 y guarda la línea).

```keel-flow
actors: { c1: customer }
steps:
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0002, productName: Hacked, productDescription: x, categoryType: 0, productPrice: 0.01, productStock: 195, count: 1 }
    legacy:
      status: ok
      body:
        products.0.productName: Hacked
        products.0.productPrice: 0.01
        products.0.productIcon: null
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productName: Spring In Action
        products.0.productPrice: 20
        products.0.productIcon: "https://images-na.ssl-images-amazon.com/images/I/51gHy16h5TL._SX397_BO1,204,203,200_.jpg"
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: NOPE, productName: Ghost, productDescription: x, categoryType: 0, productPrice: 1.00, productStock: 1, count: 1 }
    legacy: { status: ok }
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
```

### FL-CRT-013: un producto fuera de venta no se añade al carrito

**Caracterización**: `fix` (`fix-product-not-available`: el legacy añade al carrito un producto fuera de venta sin mirar su estado; lectura de CartController.java:40-67, sin grabación previa: lo mide la ejecución contra el legacy).

**Given**: El carrito vacío de `customer1` y el producto `B0003`, fuera de venta (`DOWN`).
**When**: Como `c1`, `addToCart` de `B0003` x1, `mergeCart` con una línea de `B0003` x1 y `getCart`.
**Then**:
1. Los dos primeros pasos fallan con status 409 y `code: PRODUCT_NOT_AVAILABLE` (el legacy responde 200 y guarda la línea).
2. El carrito sigue vacío (el legacy tiene una línea de `B0003` con `count` 2).

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0003, quantity: 1 }
    legacy: { status: ok }
    expect:
      status: 409
      code: PRODUCT_NOT_AVAILABLE
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0003, productName: Head First, productDescription: Java EE, categoryType: 0, productPrice: 10.00, productStock: 200, count: 1 }
    legacy: { status: ok }
    expect:
      status: 409
      code: PRODUCT_NOT_AVAILABLE
  - op: getCart
    as: c1
    legacy:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0003
        products.0.count: 2
    expect:
      status: ok
      body:
        products.length: 0
```

### FL-CRT-014: sin perfil no hay carrito

**Caracterización**: `new`. Decisión: gaps clase 2 (mergeCart) y clase 5 (getCart), 2026-10-23: con la identidad en un proveedor, una persona puede estar autenticada sin haber llamado a `register`, y el carrito nace con el perfil.

**Given**: Una persona `n1` con el rol de cliente, autenticada pero sin perfil.
**When**: Como `n1`, `getCart`, `addToCart` de `B0001` x1, `mergeCart` con `{items: []}`, `modifyCartItem` de `B0001` con `{quantity: 1}`, `removeCartItem` de `B0001` y `checkout`.
**Then**:
1. Las seis operaciones fallan con status 404 y `code: CART_NOT_FOUND`.

### FL-CRT-015: fusionar líneas repetidas las suma y la línea existente solo cambia de cantidad

**Caracterización**: `new`. Decisión: gaps clase 4 (mergeCart y addToCart) y clase 14 (ProductInOrder), 2026-10-23: el carrito no tiene dos líneas del mismo producto.

**Given**: El carrito vacío de `customer1` y `B0002` con precio 20.
**When**: Como `c1`, `mergeCart` con `{items: [{productId: B0002, count: 1}, {productId: B0002, count: 2}]}`, `addToCart` de `B0002` x4 y `getCart`.
**Then**:
1. El `mergeCart` responde 200 con una sola línea de `B0002`, con `count` 3 y `productPrice` 20.
2. Tras el `addToCart`, el carrito tiene una sola línea de `B0002` con `count` 7 y `productPrice` 20.

### FL-CRT-016: una cantidad menor que 1 al cambiar una línea es un 400

**Caracterización**: `fix` (`fix-cart-modify-quantity-min`: el legacy no acota la cantidad de modifyCartItem y responde 200 con el cuerpo vacío a la cantidad 0 y a una negativa sobre una línea ausente; recordings/round-0/R0-037.json).

**Given**: El carrito vacío de `customer1`.
**When**: `modifyCartItem` con `productId` `B0002` y cantidad 0, y luego con cantidad -1.
**Then**:
1. Los dos pasos fallan con status 400, antes de buscar la línea: una cantidad menor que 1 no es válida aunque la línea no esté (el legacy responde 200 con el cuerpo vacío).

```keel-flow
actors: { c1: customer }
steps:
  - op: modifyCartItem
    as: c1
    params: { productId: B0002 }
    input: { quantity: 0 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: modifyCartItem
    as: c1
    params: { productId: B0002 }
    input: { quantity: -1 }
    legacy: { status: ok }
    expect:
      status: 400
```

### FL-CRT-017: una cantidad menor que 1 no cambia una línea que sí está

**Caracterización**: `new`. Decisión: fix-cart-modify-quantity-min sobre una línea presente (el legacy no se sondeó con una línea en el carrito: U-MODIFY-CART-ZERO-EXISTING).

**Given**: El carrito de `customer1` con una línea de `B0002` y `count` 1.
**When**: Como `c1`, `modifyCartItem` de `B0002` con `{quantity: 0}`, con `{quantity: -1}` y `getCart`.
**Then**:
1. Los dos pasos fallan con status 400.
2. La línea de `B0002` conserva `count` 1: quitar una línea es `removeCartItem`, no una cantidad 0.

### FL-CRT-018: sin carrito, CART_NOT_FOUND va antes que cualquier guarda de producto

**Caracterización**: `new`. Decisión: orden global de las guardas (REV-USECASES-GUARD-ORDER y gaps clase 2, addToCart y mergeCart), segunda vuelta del cierre, 2026-10-23: la existencia del carrito se comprueba antes que el producto.

**Given**: Una persona `n1` con el rol de cliente, autenticada pero sin perfil (sin carrito), ningún producto `NOPE` y `B0003` fuera de venta (`DOWN`).
**When**: Como `n1`, `addToCart` de `NOPE` x1, `addToCart` de `B0003` x1 y `mergeCart` con `{items: [{productId: NOPE, count: 1}, {productId: B0003, count: 1}]}`.
**Then**:
1. Los tres pasos fallan con status 404 y `code: CART_NOT_FOUND`: sin carrito no se mira el producto, así que `addToCart` de `NOPE` no responde 200 con `added` false, ni `addToCart` de `B0003` un 409 `PRODUCT_NOT_AVAILABLE`, ni `mergeCart` un `PRODUCT_NOT_FOUND`.

### FL-CRT-019: fusionar un producto inexistente y uno fuera de venta es un 404

**Caracterización**: `new`. Decisión: orden global de las guardas (REV-USECASES-GUARD-ORDER, mergeCart), segunda vuelta del cierre, 2026-10-23: la existencia de todas las líneas se comprueba antes que su estado.

**Given**: El carrito vacío de `customer1`, ningún producto `NOPE` y `B0003` fuera de venta (`DOWN`).
**When**: Como `c1`, `mergeCart` con `{items: [{productId: B0003, count: 1}, {productId: NOPE, count: 1}]}`, `mergeCart` con las mismas líneas en el orden contrario y `getCart`.
**Then**:
1. Los dos pasos fallan con status 404 y `code: PRODUCT_NOT_FOUND`, sea cual sea la posición de la línea inexistente (nunca el 409 `PRODUCT_NOT_AVAILABLE`).
2. El carrito sigue vacío: la operación se rechaza entera.

### FL-CRT-020: una línea copia tal cual lo que el producto no tiene

**Caracterización**: `fix` (`fix-cart-line-nullable-fields`: el legacy exige descripción y categoría en la línea y, con un producto sin descripción, no la guarda y responde 200 igualmente; ProductInOrder.java:41-44 y 53-55, y el mismo efecto medido con campos nulos en recordings/round-0/R0-035.json; sin grabación con este producto: lo mide la ejecución contra el legacy).

**Given**: El carrito vacío de `customer1`; ningún producto `N11`.
**When**: Como `m1`, `createProduct` de `N11` con `{productId: N11, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0}` (sin descripción); como `c1`, `addToCart` de `N11` x1 y `getCart`.
**Then**:
1. El alta del producto y `addToCart` responden 200.
2. El carrito tiene 1 línea de `N11` con `productDescription` null: la línea copia el null del producto (el legacy no la guarda y el carrito sigue vacío).

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N11, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: ok
  - op: addToCart
    as: c1
    input: { productId: N11, quantity: 1 }
    expect:
      status: ok
  - op: getCart
    as: c1
    legacy:
      status: ok
      body:
        products.length: 0
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: N11
        products.0.productDescription: null
```

## Checkout y pedidos

### FL-ORD-001: el checkout crea el pedido, baja el stock y vacía el carrito

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-039.json y R0-052.json.

**Given**: El carrito vacío de `customer1` y `B0001` con precio 30 y stock 96.
**When**: `addToCart` con `B0001` x2, `checkout`, `getCart`, `getProduct` de `B0001` y `listOrders` con `size` 10, todo como `c1`.
**Then**:
1. El checkout responde sin cuerpo.
2. El carrito queda vacío.
3. `B0001` tiene `productStock` 94.
4. El primer pedido del listado (el más nuevo de los nuevos) tiene `orderAmount` 60, `buyerEmail` `customer1@email.com` y 1 línea.
5. El listado del cliente tiene 4 pedidos.

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: checkout
    as: c1
    expect:
      status: no-content
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 0
  - op: getProduct
    params: { productId: B0001 }
    expect:
      status: ok
      body:
        productStock: 94
  - op: listOrders
    as: c1
    query: { size: 10 }
    expect:
      status: ok
      body:
        totalElements: 4
        items.0.orderAmount: 60
        items.0.buyerEmail: customer1@email.com
        items.0.products.length: 1
```

### FL-ORD-002: el checkout con el carrito vacío se rechaza

**Caracterización**: `fix` (`fix-checkout-empty-cart`: el legacy crea un pedido de importe 0 y sin líneas; recordings/round-0/R0-040.json, con el orden de R0-066.json).

**Given**: El carrito vacío de `customer1` y sus 3 pedidos del seed.
**When**: `checkout` como `c1` y luego `listOrders` con `size` 10.
**Then**:
1. El checkout falla con status 409 y `code: CART_EMPTY` (el legacy responde 200).
2. El listado sigue teniendo 3 pedidos (el legacy tiene 4: el primero con `orderAmount` 0 y ninguna línea).

```keel-flow
actors: { c1: customer }
steps:
  - op: checkout
    as: c1
    legacy: { status: no-content }
    expect:
      status: 409
      code: CART_EMPTY
  - op: listOrders
    as: c1
    query: { size: 10 }
    legacy:
      status: ok
      body:
        totalElements: 4
        items.0.orderAmount: 0
        items.0.products.length: 0
    expect:
      status: ok
      body:
        totalElements: 3
```

### FL-ORD-003: el checkout que se queda sin stock es un 409 y no deja pedido

**Caracterización**: `fix` (`fix-conflict-status`: el legacy responde 500; recordings/round-0/R0-041.json, sin order_main en el diff).

**Given**: `B0001` con stock 96 y 97 unidades en el carrito de `customer1`.
**When**: `mergeCart` con `B0001` y `count` 97, `checkout` y `listOrders` con `size` 10.
**Then**:
1. El checkout falla con status 409 y `code: PRODUCT_NOT_ENOUGH` (el legacy responde 500).
2. El cliente sigue teniendo sus 3 pedidos.

```keel-flow
actors: { c1: customer }
steps:
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0001, productName: Core Java, productDescription: Books for learning Java, categoryType: 0, productPrice: 30.00, productStock: 96, count: 97 }
    expect:
      status: ok
  - op: checkout
    as: c1
    legacy: { status: 500 }
    expect:
      status: 409
      code: PRODUCT_NOT_ENOUGH
  - op: listOrders
    as: c1
    query: { size: 10 }
    expect:
      status: ok
      body:
        totalElements: 3
```

### FL-ORD-004: repetir el checkout con el carrito ya vacío se rechaza

**Caracterización**: `fix` (`fix-checkout-empty-cart`: el legacy crea un segundo pedido vacío; recordings/round-0/R0-042.json y R0-066.json).

**Given**: El carrito vacío de `customer1`.
**When**: `addToCart` con `B0001` x2, `checkout` dos veces (sin Idempotency-Key) y `listOrders` con `size` 10.
**Then**:
1. El primer checkout responde sin cuerpo.
2. El segundo falla con status 409 y `code: CART_EMPTY` (el legacy responde 200 y crea un pedido vacío).
3. El listado tiene 4 pedidos y el primero tiene `orderAmount` 60 (el legacy tiene 5: el más nuevo con `orderAmount` 0 y ninguna línea, y el siguiente con 60).

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: checkout
    as: c1
    expect:
      status: no-content
  - op: checkout
    as: c1
    legacy: { status: no-content }
    expect:
      status: 409
      code: CART_EMPTY
  - op: listOrders
    as: c1
    query: { size: 10 }
    legacy:
      status: ok
      body:
        totalElements: 5
        items.0.orderAmount: 0
        items.0.products.length: 0
        items.1.orderAmount: 60
    expect:
      status: ok
      body:
        totalElements: 4
        items.0.orderAmount: 60
        items.0.products.length: 1
```

### FL-ORD-005: un cliente solo ve sus pedidos

**Caracterización**: `frontier` (`F-ORDER-LIST-SCOPING`: recordings/round-0/R0-044.json).

**Given**: Los 3 pedidos de `customer1` y los 5 de `customer2` del seed.
**When**: `listOrders` como `c1` con `size` 2.
**Then**:
1. Status 200 y `totalElements` 3.
2. `items` tiene 2 elementos: `2147483648` y `2147483642`, ambos con `buyerEmail` `customer1@email.com`.

```keel-flow
actors: { c1: customer }
steps:
  - op: listOrders
    as: c1
    query: { size: 2 }
    expect:
      status: ok
      body:
        totalElements: 3
        items.length: 2
        items.0.orderId: 2147483648
        items.0.buyerEmail: customer1@email.com
        items.1.orderId: 2147483642
        items.1.buyerEmail: customer1@email.com
```

### FL-ORD-006: empleados y vendedores ven todos los pedidos, los nuevos primero

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-045.json.

**Given**: Los 8 pedidos del seed, con estos `orderStatus` y `createTime` (todos del 2018-03-15, tal como los guarda el seed): nuevos `2147483649` (12:58:23.824), `2147483645` (12:52:29.007) y `2147483643` (12:52:20.439); finalizado `2147483648` (13:01:06.943); cancelados `2147483642` (13:01:21.135), `2147483640` (13:01:16.271), `2147483647` (12:52:35.289) y `2147483641` (12:52:07.428). Ningún par de pedidos comparte estado y `createTime`, así que el desempate por `orderId` no interviene.
**When**: `listOrders` con `size` 10 como `m1` y como `e1`.
**Then**:
1. Status 200 y `totalElements` 8 en ambos.
2. El orden es el de la posición de declaración del enum (NEW, FINISHED, CANCELED) y no el alfabético, y dentro de cada estado el `createTime` más reciente primero: `2147483649`, `2147483645`, `2147483643` (nuevos), `2147483648` (finalizado) y luego los cancelados `2147483642`, `2147483640`, `2147483647` y `2147483641`.

```keel-flow
actors: { m1: manager, e1: employee }
steps:
  - op: listOrders
    as: m1
    query: { size: 10 }
    expect:
      status: ok
      body:
        totalElements: 8
        items.0.orderId: 2147483649
        items.1.orderId: 2147483645
        items.2.orderId: 2147483643
        items.3.orderId: 2147483648
        items.4.orderId: 2147483642
        items.5.orderId: 2147483640
        items.6.orderId: 2147483647
        items.7.orderId: 2147483641
  - op: listOrders
    as: e1
    query: { size: 10 }
    expect:
      status: ok
      body:
        totalElements: 8
        items.0.orderId: 2147483649
        items.7.orderId: 2147483641
```

### FL-ORD-007: los pedidos exigen credencial

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-043.json.

**Given**: Los pedidos del seed.
**When**: `listOrders` y `getOrder` de `2147483643` sin credencial.
**Then**:
1. Los dos fallan con status 401.

```keel-flow
actors: {}
steps:
  - op: listOrders
    expect:
      status: 401
  - op: getOrder
    params: { orderId: 2147483643 }
    expect:
      status: 401
```

### FL-ORD-008: un pedido que no existe es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 500; recordings/round-0/R0-046.json y R0-048.json, el 400 lo graba un vendedor).

**Given**: El pedido `2147483648` de `customer1` (finalizado, importe 134, una línea de `B0001`).
**When**: `getOrder` de `2147483648` como `c1`, de `1` y de `abc`.
**Then**:
1. El pedido propio responde 200: `orderAmount` 134, `buyerEmail` `customer1@email.com`, `buyerName` `customer1` y 1 línea con `productId` `B0001`.
2. El pedido `1` falla con status 404 y `code: ORDER_NOT_FOUND` (el legacy responde 500).
3. El id `abc` falla con status 400 en los dos lados.

```keel-flow
actors: { c1: customer }
steps:
  - op: getOrder
    as: c1
    params: { orderId: 2147483648 }
    expect:
      status: ok
      body:
        orderId: 2147483648
        orderAmount: 134
        buyerEmail: customer1@email.com
        buyerName: customer1
        products.length: 1
        products.0.productId: B0001
  - op: getOrder
    as: c1
    params: { orderId: 1 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: ORDER_NOT_FOUND
  - op: getOrder
    as: c1
    params: { orderId: abc }
    expect:
      status: 400
```

### FL-ORD-009: un cliente no ve el pedido de otro (403) pero un vendedor sí

**Caracterización**: `fix` (`fix-ownership-403`: el legacy responde 401 sin cuerpo; recordings/round-0/R0-047.json).

**Given**: El pedido `2147483643` de `customer2`.
**When**: `getOrder` de `2147483643` como `c1` y como `m1`.
**Then**:
1. Como `c1` falla con status 403 y `code: ORDER_NOT_OWNED` (el legacy responde 401).
2. Como `m1` responde 200 con `buyerEmail` `customer2@email.com` y `orderAmount` 100.

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: getOrder
    as: c1
    params: { orderId: 2147483643 }
    legacy: { status: 401 }
    expect:
      status: 403
      code: ORDER_NOT_OWNED
  - op: getOrder
    as: m1
    params: { orderId: 2147483643 }
    expect:
      status: ok
      body:
        buyerEmail: customer2@email.com
        orderAmount: 100
```

### FL-ORD-010: un empleado finaliza un pedido nuevo y repetirlo es un 409

**Caracterización**: `fix` (`fix-conflict-status`: el legacy responde 500 a un pedido que no está nuevo; recordings/round-0/R0-049.json).

**Given**: El pedido `2147483643` nuevo.
**When**: `finishOrder` de `2147483643` dos veces como `e1`.
**Then**:
1. El primero responde 200 con `orderId` `2147483643`.
2. El segundo falla con status 409 y `code: INVALID_STATE_TRANSITION` (el legacy responde 500).

```keel-flow
actors: { e1: employee }
steps:
  - op: finishOrder
    as: e1
    params: { orderId: 2147483643 }
    expect:
      status: ok
      body:
        orderId: 2147483643
  - op: finishOrder
    as: e1
    params: { orderId: 2147483643 }
    legacy: { status: 500 }
    expect:
      status: 409
      code: INVALID_STATE_TRANSITION
```

### FL-ORD-011: no se finaliza un pedido que no existe ni uno cancelado

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 500; recordings/round-0/R0-051.json). El pedido cancelado es además `fix-conflict-status`.

**Given**: El pedido `2147483641` cancelado y ningún pedido `1`.
**When**: `finishOrder` de `1` y de `2147483641` como `m1`.
**Then**:
1. El pedido `1` falla con status 404 y `code: ORDER_NOT_FOUND` (el legacy responde 500).
2. El pedido cancelado falla con status 409 y `code: INVALID_STATE_TRANSITION` (el legacy responde 500).

```keel-flow
actors: { m1: manager }
steps:
  - op: finishOrder
    as: m1
    params: { orderId: 1 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: ORDER_NOT_FOUND
  - op: finishOrder
    as: m1
    params: { orderId: 2147483641 }
    legacy: { status: 500 }
    expect:
      status: 409
      code: INVALID_STATE_TRANSITION
```

### FL-ORD-012: un cliente no finaliza pedidos

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-050.json.

**Given**: El pedido `2147483643` nuevo.
**When**: `finishOrder` de `2147483643` como `c1`.
**Then**:
1. Falla con status 403.

```keel-flow
actors: { c1: customer }
steps:
  - op: finishOrder
    as: c1
    params: { orderId: 2147483643 }
    expect:
      status: 403
```

### FL-ORD-013: cancelar un pedido nuevo devuelve el stock y repetirlo es un 409

**Caracterización**: `fix` (`fix-conflict-status`: el legacy responde 500 a un pedido que no está nuevo; recordings/round-0/R0-052.json).

**Given**: El carrito vacío de `customer1` y `B0001` con stock 96.
**When**: `addToCart` x2 de `B0001`, `checkout`, `listOrders` (guardando el id del primero como `oid`), `cancelOrder` de `oid`, `getProduct` de `B0001` y `cancelOrder` otra vez, todo como `c1`.
**Then**:
1. La cancelación responde 200 con `orderAmount` 60.
2. `B0001` vuelve a tener `productStock` 96.
3. La segunda cancelación falla con status 409 y `code: INVALID_STATE_TRANSITION` (el legacy responde 500).

```keel-flow
actors: { c1: customer }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: checkout
    as: c1
    expect:
      status: no-content
  - op: listOrders
    as: c1
    query: { size: 10 }
    save: { oid: items.0.orderId }
    expect:
      status: ok
  - op: cancelOrder
    as: c1
    params: { orderId: "{{oid}}" }
    expect:
      status: ok
      body:
        orderAmount: 60
  - op: getProduct
    params: { productId: B0001 }
    expect:
      status: ok
      body:
        productStock: 96
  - op: cancelOrder
    as: c1
    params: { orderId: "{{oid}}" }
    legacy: { status: 500 }
    expect:
      status: 409
      code: INVALID_STATE_TRANSITION
```

### FL-ORD-014: un cliente no cancela el pedido de otro (403) y un vendedor sí

**Caracterización**: `fix` (`fix-ownership-403`: el legacy responde 401 sin cuerpo; recordings/round-0/R0-053.json y R0-054.json). Los pasos de un pedido inexistente o finalizado son además `fix-not-found-404` y `fix-conflict-status`.

**Given**: Los pedidos `2147483643` y `2147483645` (nuevos) de `customer2`, `2147483648` finalizado y ningún pedido `1`.
**When**: `cancelOrder` de `2147483643` como `c1`; como `m1`, de `2147483645`, de `1` y de `2147483648`.
**Then**:
1. Como `c1` falla con status 403 y `code: ORDER_NOT_OWNED` (el legacy responde 401).
2. Como `m1`, `2147483645` responde 200.
3. El pedido `1` falla con status 404 y `code: ORDER_NOT_FOUND` (el legacy responde 500).
4. El finalizado falla con status 409 y `code: INVALID_STATE_TRANSITION` (el legacy responde 500).

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: cancelOrder
    as: c1
    params: { orderId: 2147483643 }
    legacy: { status: 401 }
    expect:
      status: 403
      code: ORDER_NOT_OWNED
  - op: cancelOrder
    as: m1
    params: { orderId: 2147483645 }
    expect:
      status: ok
      body:
        orderId: 2147483645
  - op: cancelOrder
    as: m1
    params: { orderId: 1 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: ORDER_NOT_FOUND
  - op: cancelOrder
    as: m1
    params: { orderId: 2147483648 }
    legacy: { status: 500 }
    expect:
      status: 409
      code: INVALID_STATE_TRANSITION
```

### FL-ORD-015: cancelar un pedido cuyo producto se borró omite el stock

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-055.json.

**Given**: El carrito vacío de `customer1` y `B0001` en el catálogo.
**When**: Como `c1`, `addToCart` x2 de `B0001`, `checkout` y `listOrders` (guardando `oid`); como `m1`, `deleteProduct` de `B0001`; como `c1`, `cancelOrder` de `oid`.
**Then**:
1. El borrado responde sin cuerpo.
2. La cancelación responde 200 y la línea de `B0001` sigue en el pedido.

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: checkout
    as: c1
    expect:
      status: no-content
  - op: listOrders
    as: c1
    query: { size: 10 }
    save: { oid: items.0.orderId }
    expect:
      status: ok
  - op: deleteProduct
    as: m1
    params: { id: B0001 }
    expect:
      status: no-content
  - op: cancelOrder
    as: c1
    params: { orderId: "{{oid}}" }
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0001
```

### FL-ORD-016: comprar exactamente el stock disponible es válido

**Caracterización**: `fix` (`fix-conflict-status`: el legacy rechaza el checkout que deja el stock en 0, porque exige que quede más de 0; recordings/round-0/R0-041.json y ProductServiceImpl.java:68-69).

**Given**: `B0001` con stock 96 y el carrito vacío de `customer1`.
**When**: `mergeCart` con `B0001` y `count` 96, `checkout`, `getProduct` de `B0001` y `listOrders` con `size` 10, todo como `c1`.
**Then**:
1. El checkout responde sin cuerpo (el legacy responde 500).
2. `B0001` tiene `productStock` 0 (el legacy sigue con 96).
3. El cliente tiene 4 pedidos y el primero tiene `orderAmount` 2880 (el legacy sigue con 3).

```keel-flow
actors: { c1: customer }
steps:
  - op: mergeCart
    as: c1
    input:
      items:
        - { productId: B0001, productName: Core Java, productDescription: Books for learning Java, categoryType: 0, productPrice: 30.00, productStock: 96, count: 96 }
    expect:
      status: ok
  - op: checkout
    as: c1
    legacy: { status: 500 }
    expect:
      status: no-content
  - op: getProduct
    params: { productId: B0001 }
    legacy:
      status: ok
      body:
        productStock: 96
    expect:
      status: ok
      body:
        productStock: 0
  - op: listOrders
    as: c1
    query: { size: 10 }
    legacy:
      status: ok
      body:
        totalElements: 3
    expect:
      status: ok
      body:
        totalElements: 4
        items.0.orderAmount: 2880
```

### FL-ORD-017: el estado de un pedido viaja con nombre

**Caracterización**: `fix` (`fix-status-names`: el legacy manda `orderStatus` como 0, 1 y 2; recordings/round-0/R0-046.json, R0-049.json y R0-052.json).

**Given**: Los pedidos `2147483649`, `2147483643` y `2147483645` del seed, los tres nuevos.
**When**: `getOrder` de `2147483649` como `m1`, `finishOrder` de `2147483643` como `e1` y `cancelOrder` de `2147483645` como `m1`.
**Then**:
1. El pedido nuevo responde `orderStatus` `NEW` (el legacy manda 0).
2. El pedido finalizado responde `orderStatus` `FINISHED` (el legacy manda 1).
3. El pedido cancelado responde `orderStatus` `CANCELED` (el legacy manda 2).

```keel-flow
actors: { m1: manager, e1: employee }
steps:
  - op: getOrder
    as: m1
    params: { orderId: 2147483649 }
    legacy:
      status: ok
      body:
        orderStatus: 0
    expect:
      status: ok
      body:
        orderStatus: NEW
  - op: finishOrder
    as: e1
    params: { orderId: 2147483643 }
    legacy:
      status: ok
      body:
        orderStatus: 1
    expect:
      status: ok
      body:
        orderStatus: FINISHED
  - op: cancelOrder
    as: m1
    params: { orderId: 2147483645 }
    legacy:
      status: ok
      body:
        orderStatus: 2
    expect:
      status: ok
      body:
        orderStatus: CANCELED
```

### FL-ORD-018: checkout, quitar una línea y borrar un producto responden 204

**Caracterización**: `fix` (`fix-void-204`: el legacy responde 200 con el cuerpo vacío; recordings/round-0/R0-038.json, R0-039.json y R0-064.json).

**Given**: El carrito vacío de `customer1` y el producto `B0003`.
**When**: Como `c1`, `addToCart` de `B0001` x2, `removeCartItem` de `B0001`, `addToCart` de `B0001` x2 y `checkout`; como `m1`, `deleteProduct` de `B0003`.
**Then**:
1. Quitar la línea, el checkout y el borrado responden 204 (el legacy responde 200).

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: removeCartItem
    as: c1
    params: { productId: B0001 }
    legacy: { status: 200 }
    expect:
      status: 204
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: checkout
    as: c1
    legacy: { status: 200 }
    expect:
      status: 204
  - op: deleteProduct
    as: m1
    params: { id: B0003 }
    legacy: { status: 200 }
    expect:
      status: 204
```

### FL-ORD-019: un reintento del checkout con la misma clave no duplica el pedido

**Caracterización**: `new`. Decisión: structural-3-2 (el legacy no tiene idempotencia).

**Given**: El carrito de `customer1` con 2 unidades de `B0001` (stock 96) y sus 3 pedidos del seed.
**When**: `checkout` como `c1` con la cabecera `Idempotency-Key` `k-1`, y otra vez con la misma clave `k-1`.
**Then**:
1. Los dos responden 204 sin cuerpo: el reintento devuelve la respuesta original.
2. `listOrders` con `size` 10 da 4 pedidos, no 5, y el primero tiene `orderAmount` 60.
3. `B0001` tiene `productStock` 94, no 92.
4. Un tercer `checkout` con otra clave `k-2` y el carrito ya vacío falla con status 409 y `code: CART_EMPTY`.

### FL-ORD-020: dos checkouts simultáneos con la misma clave dejan un solo pedido

**Caracterización**: `new`. Decisión: structural-3-2.

**Given**: El carrito de `customer1` con 2 unidades de `B0001` y sus 3 pedidos del seed.
**When**: Dos `checkout` como `c1` con la misma `Idempotency-Key` `k-1`, a la vez.
**Then**:
1. Cada respuesta es 204, o 409 con `code: IDEMPOTENCY_KEY_IN_PROGRESS` para la que pierde la carrera; no hay otro desenlace.
2. Al menos una responde 204.
3. Independientemente de cuál gane, `listOrders` con `size` 10 da exactamente 4 pedidos y `B0001` tiene `productStock` 94.

### FL-ORD-021: dos escrituras concurrentes sobre un pedido no se pisan en silencio

**Caracterización**: `new`. Decisión: structural-3-9 (el legacy gana la última escritura).

**Given**: El pedido `2147483643` nuevo.
**When**: A la vez, `finishOrder` como `e1` y `cancelOrder` como `m1` sobre `2147483643`.
**Then**:
1. Exactamente una de las dos responde 200; la otra responde 409 con `code: INVALID_STATE_TRANSITION` o `CONCURRENT_MODIFICATION`: ninguna escritura se pierde sin avisar.
2. Independientemente de cuál gane, `getOrder` de `2147483643` como `m1` da `orderStatus` `FINISHED` o `CANCELED`, y no `NEW`.

### FL-ORD-022: el checkout de un carrito con un producto que ya no existe se rechaza

**Caracterización**: `fix` (`fix-product-not-available`: el legacy responde 500 al descontar el stock de un producto que ya no existe y no deja pedido; lectura de ProductServiceImpl.java:64-66 y CartServiceImpl.java:86-100, sin grabación previa: U-CHECKOUT-PRODUCT-MISSING).

**Given**: El carrito vacío de `customer1`, `B0001` en el catálogo y los 3 pedidos del seed de `customer1`.
**When**: Como `c1`, `addToCart` de `B0001` x2; como `m1`, `deleteProduct` de `B0001`; como `c1`, `checkout`, `listOrders` con `size` 10 y `getCart`.
**Then**:
1. El checkout falla con status 409 y `code: PRODUCT_NOT_AVAILABLE` (el legacy responde 500).
2. No se crea ningún pedido: el cliente sigue teniendo sus 3.
3. El carrito conserva su línea de `B0001`: el checkout rechazado no cambia nada.

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: addToCart
    as: c1
    input: { productId: B0001, quantity: 2 }
    expect:
      status: ok
  - op: deleteProduct
    as: m1
    params: { id: B0001 }
    expect:
      status: no-content
  - op: checkout
    as: c1
    legacy: { status: 500 }
    expect:
      status: 409
      code: PRODUCT_NOT_AVAILABLE
  - op: listOrders
    as: c1
    query: { size: 10 }
    expect:
      status: ok
      body:
        totalElements: 3
  - op: getCart
    as: c1
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: B0001
```

### FL-ORD-023: el checkout de un carrito con un producto que pasó a fuera de venta se rechaza

**Caracterización**: `new`. Decisión: fix-product-not-available sobre un producto que se pone `DOWN` después de añadirse al carrito (el legacy no mira el estado en el checkout).

**Given**: El carrito vacío de `customer1`, `B0001` a la venta con stock 96 y los 3 pedidos del seed de `customer1`.
**When**: Como `c1`, `addToCart` de `B0001` x2; como `e1`, `updateProduct` de `B0001` con `{productId: B0001, productName: Core Java, productPrice: 30, productStock: 96, productStatus: DOWN, categoryType: 0, version: 0}`; como `c1`, `checkout`, `getProduct` de `B0001`, `listOrders` con `size` 10 y `getCart`.
**Then**:
1. La edición responde 200 con `productStatus` `DOWN`.
2. El checkout falla con status 409 y `code: PRODUCT_NOT_AVAILABLE`.
3. `B0001` sigue con `productStock` 96, el cliente sigue teniendo sus 3 pedidos y el carrito conserva su línea.

### FL-ORD-024: quien no tiene ningún rol conocido no lista pedidos

**Caracterización**: `new`. Decisión: gaps clase 9 (listOrders), 2026-10-23: el alcance del listado es de tres roles; el legacy no tiene identidades sin rol.

**Given**: Una persona autenticada con un token válido que no lleva ninguno de los roles `customer`, `employee` ni `manager`.
**When**: `listOrders` con esa credencial.
**Then**:
1. Falla con status 403 y `code: ACCESS_DENIED`, sin ningún pedido en el cuerpo: la ausencia de rol no equivale a «todos».

### FL-ORD-025: la propiedad se comprueba antes que la existencia y el estado

**Caracterización**: `new`. Decisión: orden global de las guardas (REV-USECASES-GUARD-ORDER y gaps clase 2, cancelOrder), segunda vuelta del cierre, 2026-10-23: propiedad, luego existencia, luego estado.

**Given**: El pedido `2147483647` de `customer2`, cancelado, y ningún pedido `1`.
**When**: `cancelOrder` de `2147483647` como `c1`, de `1` como `c1` y de `2147483647` como `m1`.
**Then**:
1. Como `c1`, el pedido de `customer2` falla con status 403 y `code: ORDER_NOT_OWNED` aunque no esté en `NEW`: un cliente no averigua el estado del pedido de otro (nunca el 409 `INVALID_STATE_TRANSITION`).
2. Como `c1`, el pedido `1` falla con status 404 y `code: ORDER_NOT_FOUND`: un pedido que no existe no tiene dueño que comparar.
3. Como `m1`, que no está sujeto a la propiedad, el pedido cancelado falla con status 409 y `code: INVALID_STATE_TRANSITION`.

### FL-ORD-026: la devolución de stock no la limita el máximo de productStock

**Caracterización**: `new`. Decisión: gaps clase 2 (cancelOrder), segunda vuelta del cierre, 2026-10-23: el máximo de 1.000.000 acota lo que manda quien crea o edita el producto, no la devolución de una cancelación; el legacy no tiene tope.

**Given**: El carrito vacío de `customer1` y ningún producto `N12`.
**When**: Como `m1`, `createProduct` de `N12` con `productStock` 1000000; como `c1`, `addToCart` de `N12` x2, `checkout` y `listOrders` (guardando `oid`); como `e1`, `updateProduct` de `N12` con `productStock` 1000000 y `version` 1; como `c1`, `cancelOrder` de `oid` y `getProduct` de `N12`.
**Then**:
1. El alta y la edición responden 200 con `productStock` 1000000 (la edición llevó el stock de 999998 al máximo).
2. La cancelación responde 200.
3. `N12` tiene `productStock` 1000002: la devolución supera el máximo y no se rechaza ni se recorta.
4. Un `addToCart` de `N12` x1 como `c1` responde 200: la línea copia el stock de 1000002 sin rechazarlo, porque `ProductInOrder.productStock` no lleva máximo de entrada (dato derivado; decidido el 2026-10-23, tercera vuelta del cierre).

### FL-ORD-027: el checkout cuyo importe supera el máximo se rechaza entero

**Caracterización**: `fix` (`fix-order-amount-max`: el legacy no limita `orderAmount` y crea el pedido; src/main/java/me/zhulin/shopapi/entity/OrderMain.java:74-76, sin grabación: lo mide la ejecución contra el legacy con un carrito de 1.001.000.000).

**Given**: El carrito vacío de `customer1`, ningún producto `N13` y los 3 pedidos del seed de `customer1`.
**When**: Como `m1`, `createProduct` de `N13` con `productPrice` 1000000 y `productStock` 2000; como `c1`, `addToCart` de `N13` x1001, `checkout`, `listOrders` con `size` 10, `getCart` y como `m1` `getProduct` de `N13`.
**Then**:
1. El checkout falla con status 409 y `code: ORDER_AMOUNT_EXCEEDED` (el legacy responde 200 y crea el pedido).
2. No se crea ningún pedido: el cliente sigue teniendo sus 3 (el legacy tiene 4).
3. El carrito conserva su línea de `N13` y el stock sigue en 2000: el checkout rechazado no cambia nada (el legacy crea el pedido y vacía el carrito, pero medido contra él el stock sigue en 2000).

```keel-flow
actors: { c1: customer, m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N13, productName: n, productPrice: 1000000, productStock: 2000, categoryType: 0 }
    expect:
      status: ok
  - op: addToCart
    as: c1
    input: { productId: N13, quantity: 1001 }
    expect:
      status: ok
  - op: checkout
    as: c1
    legacy: { status: no-content }
    expect:
      status: 409
      code: ORDER_AMOUNT_EXCEEDED
  - op: listOrders
    as: c1
    query: { size: 10 }
    legacy:
      status: ok
      body:
        totalElements: 4
    expect:
      status: ok
      body:
        totalElements: 3
  - op: getCart
    as: c1
    legacy:
      status: ok
      body:
        products.length: 0
    expect:
      status: ok
      body:
        products.length: 1
        products.0.productId: N13
  - op: getProduct
    as: m1
    params: { productId: N13 }
    legacy:
      status: ok
      body:
        productStock: 2000
    expect:
      status: ok
      body:
        productStock: 2000
```

## Mantenimiento del catálogo

### FL-SEL-001: solo un vendedor crea productos

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-056.json.

**Given**: Ningún producto `N1`.
**When**: `createProduct` sin credencial, como `c1` y como `e1`.
**Then**:
1. Sin credencial: status 401.
2. Como `c1` y como `e1`: status 403.

```keel-flow
actors: { c1: customer, e1: employee }
steps:
  - op: createProduct
    input: { productId: N1, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: 401
  - op: createProduct
    as: c1
    input: { productId: N1, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: 403
  - op: createProduct
    as: e1
    input: { productId: N1, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: 403
```

### FL-SEL-002: un vendedor da de alta un producto y se lee

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-057.json.

**Given**: Ningún producto `N1`.
**When**: `createProduct` como `m1` con `{productId: N1, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0}` y luego `getProduct` de `N1`.
**Then**:
1. El alta responde 200 con esos campos, `productDescription` null y `productIcon` null.
2. La lectura devuelve los mismos valores.

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N1, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: ok
      body:
        productId: N1
        productName: n
        productPrice: 1.5
        productStock: 5
        categoryType: 0
        productDescription: null
        productIcon: null
  - op: getProduct
    params: { productId: N1 }
    expect:
      status: ok
      body:
        productId: N1
        productName: n
        productPrice: 1.5
        productStock: 5
```

### FL-SEL-003: un código de producto repetido es un 409

**Caracterización**: `fix` (`fix-conflict-status`: el legacy responde 500; recordings/round-0/R0-058.json).

**Given**: El producto `B0001` del seed.
**When**: `createProduct` como `m1` con `productId` `B0001`.
**Then**:
1. Falla con status 409 y `code: PRODUCT_ID_ALREADY_EXISTS` (el legacy responde 500).

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: B0001, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    legacy: { status: 500 }
    expect:
      status: 409
      code: PRODUCT_ID_ALREADY_EXISTS
```

### FL-SEL-004: un producto que no cumple las validaciones es un 400

**Caracterización**: `fix` (`fix-product-validation-400`: el legacy responde 500; recordings/round-0/R0-059.json y R0-063.json).

**Given**: Ningún producto `N2`, `N3` ni `B0002` modificado.
**When**: Como `m1`: `createProduct` con `productStock` -1 y `createProduct` sin nombre ni precio; como `e1`: `updateProduct` de `B0002` con `productStock` -5.
**Then**:
1. Los tres fallan con status 400 (el legacy responde 500 con "Type definition error").

```keel-flow
actors: { m1: manager, e1: employee }
steps:
  - op: createProduct
    as: m1
    input: { productId: N2, productName: n, productPrice: 1.5, productStock: -1, categoryType: 0 }
    legacy: { status: 500 }
    expect:
      status: 400
  - op: createProduct
    as: m1
    input: { productId: N3, productStock: 1, categoryType: 0 }
    legacy: { status: 500 }
    expect:
      status: 400
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: x, productPrice: 1, productStock: -5, categoryType: 0, version: 0 }
    legacy: { status: 500 }
    expect:
      status: 400
```

### FL-SEL-005: una categoría inexistente es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 500; recordings/round-0/R0-060.json).

**Given**: Ninguna categoría de tipo 77.
**When**: `createProduct` como `m1` con `categoryType` 77.
**Then**:
1. El tipo 77 falla con status 404 y `code: CATEGORY_NOT_FOUND` (el legacy responde 500).

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N4, productName: n, productPrice: 1.5, productStock: 5, categoryType: 77 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: CATEGORY_NOT_FOUND
```

### FL-SEL-006: editar un producto conserva su fecha de alta

**Caracterización**: `fix` (`fix-edit-keeps-create-time`: el legacy deja `createTime` a null; recordings/round-0/R0-061.json).

**Given**: El producto `B0002` con descripción e icono y fecha de alta del 2018-03-10.
**When**: `updateProduct` de `B0002` como `e1` con `{productId: B0002, productName: "Spring 2", productPrice: 25, productStock: 10, categoryType: 0, version: 0}` y luego `getProduct`.
**Then**:
1. La edición responde 200 con `productName` `Spring 2`, `productPrice` 25, `productStock` 10, `productDescription` null y `productIcon` null: los campos que no llegan se pierden.
2. `createTime` conserva la fecha de alta, que empieza por `2018-03-10` (el legacy la deja a null).
3. La lectura devuelve los mismos valores.

```keel-flow
actors: { e1: employee }
steps:
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 2, productPrice: 25, productStock: 10, categoryType: 0, version: 0 }
    legacy:
      status: ok
      body:
        productName: Spring 2
        productDescription: null
        productIcon: null
        createTime: null
    expect:
      status: ok
      body:
        productId: B0002
        productName: Spring 2
        productPrice: 25
        productStock: 10
        productDescription: null
        productIcon: null
        createTime: { startsWith: "2018-03-10" }
  - op: getProduct
    params: { productId: B0002 }
    legacy:
      status: ok
      body:
        productName: Spring 2
        productDescription: null
        createTime: null
    expect:
      status: ok
      body:
        productName: Spring 2
        productDescription: null
        createTime: { startsWith: "2018-03-10" }
```

### FL-SEL-007: un cliente no edita productos

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-062.json.

**Given**: El producto `B0002`.
**When**: `updateProduct` de `B0002` como `c1`.
**Then**:
1. Falla con status 403.

```keel-flow
actors: { c1: customer }
steps:
  - op: updateProduct
    as: c1
    params: { id: B0002 }
    input: { productId: B0002, productName: x, productPrice: 1, productStock: 1, categoryType: 0, version: 0 }
    expect:
      status: 403
```

### FL-SEL-008: el código del cuerpo debe ser el de la ruta

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-063.json.

**Given**: Los productos `B0002` y `B0003`.
**When**: `updateProduct` con `id` `B0002` y `productId` `B0003` en el cuerpo, como `e1`.
**Then**:
1. Falla con status 400 y `code: ID_NOT_MATCHED`.

```keel-flow
actors: { e1: employee }
steps:
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0003, productName: x, productPrice: 1, productStock: 1, categoryType: 0, version: 0 }
    expect:
      status: 400
      code: ID_NOT_MATCHED
```

### FL-SEL-009: editar un producto que no existe es un 404

**Caracterización**: `fix` (`fix-update-product-no-upsert`: el legacy crea el producto que se edita si no existe; recordings/round-0/R0-063.json).

**Given**: Ningún producto `ZZ9`.
**When**: `updateProduct` de `ZZ9` como `e1` y luego `getProduct`.
**Then**:
1. La edición falla con status 404 y `code: PRODUCT_NOT_FOUND`: dar de alta es `createProduct` (el legacy responde 200 con `productId` `ZZ9` y `productName` `x`, y crea el producto).
2. La lectura falla con status 404 y `code: PRODUCT_NOT_FOUND` (el legacy devuelve el producto creado).

```keel-flow
actors: { e1: employee }
steps:
  - op: updateProduct
    as: e1
    params: { id: ZZ9 }
    input: { productId: ZZ9, productName: x, productPrice: 1, productStock: 1, categoryType: 0, version: 0 }
    legacy:
      status: ok
      body:
        productId: ZZ9
        productName: x
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
  - op: getProduct
    params: { productId: ZZ9 }
    legacy:
      status: ok
      body:
        productId: ZZ9
        productName: x
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
```

### FL-SEL-010: un vendedor borra un producto y borrarlo otra vez es un 404

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 500; recordings/round-0/R0-064.json).

**Given**: El producto `B0003`.
**When**: `deleteProduct` de `B0003` dos veces como `m1`.
**Then**:
1. El primero responde sin cuerpo.
2. El segundo falla con status 404 y `code: PRODUCT_NOT_FOUND` (el legacy responde 500).

```keel-flow
actors: { m1: manager }
steps:
  - op: deleteProduct
    as: m1
    params: { id: B0003 }
    expect:
      status: no-content
  - op: deleteProduct
    as: m1
    params: { id: B0003 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
```

### FL-SEL-011: un producto borrado es un 404 al leerlo

**Caracterización**: `fix` (`fix-not-found-404`: el legacy responde 200 con el cuerpo vacío; recordings/round-0/R0-064.json).

**Given**: El producto `B0003`.
**When**: `deleteProduct` de `B0003` como `m1` y luego `getProduct` de `B0003`.
**Then**:
1. El borrado responde sin cuerpo.
2. La lectura falla con status 404 y `code: PRODUCT_NOT_FOUND` (el legacy responde 200 con el cuerpo vacío).

```keel-flow
actors: { m1: manager }
steps:
  - op: deleteProduct
    as: m1
    params: { id: B0003 }
    expect:
      status: no-content
  - op: getProduct
    params: { productId: B0003 }
    legacy: { status: ok }
    expect:
      status: 404
      code: PRODUCT_NOT_FOUND
```

### FL-SEL-012: solo un vendedor borra productos

**Caracterización**: `keep`. Evidencia: recordings/round-0/R0-065.json.

**Given**: El producto `B0002`.
**When**: `deleteProduct` de `B0002` como `e1` y como `c1`.
**Then**:
1. Los dos fallan con status 403.

```keel-flow
actors: { c1: customer, e1: employee }
steps:
  - op: deleteProduct
    as: e1
    params: { id: B0002 }
    expect:
      status: 403
  - op: deleteProduct
    as: c1
    params: { id: B0002 }
    expect:
      status: 403
```

### FL-SEL-013: un estado de producto que no es UP ni DOWN es un 400

**Caracterización**: `fix` (`fix-status-names`: el legacy acepta 0 y 1 y responde 500 a un estado mayor que 1; recordings/round-0/R0-060.json). Es además la consecuencia de `fix-conflict-status` sobre el estado inválido: un enum cerrado se rechaza como validación (400), no como un 422 de negocio.

**Given**: Ningún producto `N5`.
**When**: `createProduct` como `m1` con `productStatus` 2.
**Then**:
1. Falla con status 400 (el legacy responde 500 con "Status is incorrect!").

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N5, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0, productStatus: 2 }
    legacy: { status: 500 }
    expect:
      status: 400
```

### FL-SEL-014: un precio con más de dos decimales se rechaza

**Caracterización**: `new`. Decisión: domain-decimal-scale-policy (el legacy no se sondeó con más de dos decimales: U-DECIMAL-SCALE).

**Given**: Ningún producto `N7` ni `N8`.
**When**: `createProduct` como `m1` con `productPrice` 1.555 y luego con `productPrice` 1.55.
**Then**:
1. El de 1.555 falla con status 400 y no crea el producto.
2. El de 1.55 responde 200 con `productPrice` 1.55.

### FL-SEL-015: un producto sin estado queda a la venta

**Caracterización**: `new`. Decisión: fix-product-not-available (el legacy no aplica el default de la columna y desreferencia un estado nulo: U-PRODUCT-STATUS-NULL).

**Given**: Ningún producto `N9` y el producto `B0002` a la venta con `version` 0.
**When**: Como `m1`, `createProduct` con `{productId: N9, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0}`, sin `productStatus`; como `e1`, `updateProduct` de `B0002` con `productStatus` `DOWN` y `version` 0, y otra vez de `B0002` sin `productStatus` y con `version` 1.
**Then**:
1. El alta responde 200 con `productStatus` `UP`.
2. La primera edición responde 200 con `productStatus` `DOWN`: pasar de UP a DOWN es válido.
3. La segunda edición responde 200 con `productStatus` `UP`: una edición que no manda el estado lo deja a la venta, y pasar de DOWN a UP es válido.

### FL-SEL-016: editar un producto con una versión vieja se rechaza

**Caracterización**: `fix` (`fix-update-product-version`: el legacy gana la última escritura y la edición pisa el stock que descontó un checkout; ProductServiceImpl.java:106-116 y recordings/round-0/R0-061.json).

**Given**: El producto `B0002` con `version` 0.
**When**: Como `e1`, `updateProduct` de `B0002` con `version` 0, otra vez con `version` 0 y otra con `version` 1.
**Then**:
1. La primera edición responde 200 (la `version` pasa a 1).
2. La segunda falla con status 409 y `code: CONCURRENT_MODIFICATION`: la `version` 0 ya no es la vigente y no se pisa nada (el legacy ignora la versión y responde 200).
3. La tercera responde 200: la `version` 1 sí era la vigente.

```keel-flow
actors: { e1: employee }
steps:
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 2, productPrice: 25, productStock: 10, categoryType: 0, version: 0 }
    expect:
      status: ok
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 3, productPrice: 25, productStock: 10, categoryType: 0, version: 0 }
    legacy: { status: ok }
    expect:
      status: 409
      code: CONCURRENT_MODIFICATION
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 4, productPrice: 25, productStock: 10, categoryType: 0, version: 1 }
    expect:
      status: ok
```

### FL-SEL-017: un producto sin categoría es un 400

**Caracterización**: `fix` (`fix-product-category-required`: el legacy responde 500 `CATEGORY_NOT_FOUND` a un producto sin `categoryType`; recordings/round-0/R0-060.json, tercera petición).

**Given**: Ningún producto `N10`.
**When**: `createProduct` como `m1` con `{productId: N10, productName: n, productPrice: 1.5, productStock: 5}`, sin `categoryType`.
**Then**:
1. Falla con status 400: `categoryType` es obligatorio al crear, y no es una categoría que no existe (el legacy responde 500).

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: N10, productName: n, productPrice: 1.5, productStock: 5 }
    legacy: { status: 500 }
    expect:
      status: 400
```

### FL-SEL-018: editar un producto sin categoryType conserva su categoría

**Caracterización**: `fix` (`fix-product-category-required`: el legacy responde 500 `CATEGORY_NOT_FOUND` a una edición sin `categoryType`, porque `update` busca la categoría con el valor que llega; ProductServiceImpl.java:106-116 y CategoryServiceImpl.java:33-37, sin grabación de la edición: lo mide la ejecución contra el legacy).

**Given**: El producto `B0002`, de la categoría 0 y con `version` 0; ninguna categoría de tipo 77.
**When**: `updateProduct` de `B0002` como `e1` con `{productId: B0002, productName: Spring 5, productPrice: 25, productStock: 10, version: 0}`, sin `categoryType`; luego `getProduct` de `B0002`; y luego `updateProduct` con `categoryType` 77 y `version` 1.
**Then**:
1. La edición sin `categoryType` responde 200 con `categoryType` 0: se conserva (el legacy responde 500).
2. La lectura devuelve `categoryType` 0.
3. La edición con el tipo 77 falla con status 404 y `code: CATEGORY_NOT_FOUND`: solo sale si el tipo llega y no existe (el legacy responde 500).

```keel-flow
actors: { e1: employee }
steps:
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 5, productPrice: 25, productStock: 10, version: 0 }
    legacy: { status: 500 }
    expect:
      status: ok
      body:
        categoryType: 0
  - op: getProduct
    params: { productId: B0002 }
    expect:
      status: ok
      body:
        categoryType: 0
  - op: updateProduct
    as: e1
    params: { id: B0002 }
    input: { productId: B0002, productName: Spring 5, productPrice: 25, productStock: 10, categoryType: 77, version: 1 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: CATEGORY_NOT_FOUND
```

### FL-SEL-019: un código de producto de más de 64 caracteres se rechaza

**Caracterización**: `fix` (`fix-product-id-length`: el legacy acepta un `productId` de hasta 255 caracteres, la longitud de su columna; surface.yaml y recordings/round-0/R0-057.json, sin grabación con un código de más de 64: lo mide la ejecución contra el legacy).

**Given**: Ningún producto con un código de 64 ni de 65 caracteres.
**When**: `createProduct` como `m1` con un `productId` de 65 caracteres (`P` repetida) y luego con uno de 64 (`Q` repetida), ambos con `{productName: n, productPrice: 1.5, productStock: 5, categoryType: 0}`.
**Then**:
1. El de 65 caracteres falla con status 400 (el legacy responde 200 y lo crea).
2. El de 64 caracteres responde 200: el máximo es 64 inclusive.

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: createProduct
    as: m1
    input: { productId: QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: ok
```

### FL-SEL-020: con una categoría inexistente y un código repetido sale el 404

**Caracterización**: `fix` (`fix-create-product-guard-order`: el legacy comprueba el código repetido antes que la categoría y responde 500 al repetido, sin llegar a mirar la categoría; ProductController.java:50-57 y recordings/round-0/R0-058.json).

**Given**: El producto `B0001` del seed y ninguna categoría de tipo 77.
**When**: `createProduct` como `m1` con `{productId: B0001, productName: n, productPrice: 1.5, productStock: 5, categoryType: 77}`.
**Then**:
1. Falla con status 404 y `code: CATEGORY_NOT_FOUND`: la existencia se comprueba antes que el conflicto, así que no sale el 409 `PRODUCT_ID_ALREADY_EXISTS` (el legacy responde 500 por el código repetido).

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: B0001, productName: n, productPrice: 1.5, productStock: 5, categoryType: 77 }
    legacy: { status: 500 }
    expect:
      status: 404
      code: CATEGORY_NOT_FOUND
```

### FL-SEL-021: el orden de las guardas de la edición de un producto

**Caracterización**: `new`. Decisión: orden global de las guardas (REV-USECASES-GUARD-ORDER, updateProduct), segunda vuelta del cierre, 2026-10-23: la forma de la petición, luego la existencia (el producto antes que la categoría) y por último el conflicto de versión.

**Given**: El producto `B0002` con `version` 0, ningún producto `ZZ9` y ninguna categoría de tipo 77.
**When**: Como `e1`, `updateProduct` de `B0002` con `productId` `B0003` en el cuerpo, `categoryType` 77 y `version` 5; `updateProduct` de `ZZ9` con `categoryType` 77; `updateProduct` de `B0002` con `categoryType` 77 y `version` 5; y `updateProduct` de `B0002` con `categoryType` 0 y `version` 5.
**Then**:
1. El primero falla con status 400 y `code: ID_NOT_MATCHED`.
2. El segundo falla con status 404 y `code: PRODUCT_NOT_FOUND`, no `CATEGORY_NOT_FOUND`.
3. El tercero falla con status 404 y `code: CATEGORY_NOT_FOUND`, no `CONCURRENT_MODIFICATION`.
4. El cuarto falla con status 409 y `code: CONCURRENT_MODIFICATION`.

### FL-SEL-022: un código de producto con caracteres fuera de [A-Za-z0-9_-] se rechaza

**Caracterización**: `fix` (`fix-product-id-charset`: el legacy acepta cualquier carácter en `productId`; src/main/java/me/zhulin/shopapi/entity/ProductInfo.java, sin grabación: lo mide la ejecución contra el legacy).

**Given**: Ningún producto con el código `N 14` ni `N_14-a`.
**When**: `createProduct` como `m1` con `productId` `N 14` y luego con `N_14-a`, ambos con `{productName: n, productPrice: 1.5, productStock: 5, categoryType: 0}`; después `getProduct` de `N 14`.
**Then**:
1. El de `N 14` falla con status 400 (el legacy responde 200 y lo crea).
2. El de `N_14-a` responde 200: guion y guion bajo son válidos.
3. `getProduct` de un código con carácter fuera del patrón falla con status 400 en la ruta.

```keel-flow
actors: { m1: manager }
steps:
  - op: createProduct
    as: m1
    input: { productId: "N 14", productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    legacy: { status: ok }
    expect:
      status: 400
  - op: createProduct
    as: m1
    input: { productId: N_14-a, productName: n, productPrice: 1.5, productStock: 5, categoryType: 0 }
    expect:
      status: ok
  - op: getProduct
    as: m1
    params: { productId: "N$14" }
    legacy: { status: ok }
    expect:
      status: 400
```
