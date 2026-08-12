# catalog — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/catalog v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Este archivo no es un diseño real: existe para que los tests
> de `keel-spring` ejerciten el andamiaje de pruebas de integración (`src/integrationTest/`) y el
> agente `keel-spring-tests` sobre una silueta con `api`, `messaging` y `storage`. Los huecos que
> señala abajo son del fixture y están declarados a propósito.

> **Huecos conocidos de este diseño** (se declaran, no se resuelven inventando contrato):
> 1. No hay operación para crear categorías, y `createProduct` exige una. Los flujos asumen la
>    categoría `c1` como **dato de arranque** del entorno de validación. En un diseño real esto es
>    un `designGap`: un `Given` inalcanzable por la API.
> 2. `storage.buckets.productImages` declara `maxSizeMb` y `allowedContentTypes`, pero
>    `addProductImage` no declara los errores `FILE_TOO_LARGE` ni `UNSUPPORTED_CONTENT_TYPE`. Los
>    casos borde correspondientes quedan **sin cubrir** hasta que el diseño los declare.
> 3. Ninguna operación declara el error de transición inválida del `lifecycle`, aunque
>    `retireProduct` y `reactivateWithdrawnProduct` declaran sus `transitions`. FL-PRD-004-D lo
>    deja anotado como hueco.
> 4. No hay operación que lleve un producto de `draft` a `active`: la arista existe en el
>    `lifecycle` y nadie la ejecuta (`keel validate` lo avisa). Hueco declarado del fixture.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos (`2026-01-15T10:30:00.000Z`).
  Toda marca de tiempo generada por el servidor (`createdAt`, `occurredAt`) se verifica **por
  forma**, nunca por valor literal.
- **Identificadores**: `uuid` v4 en formato canónico. Se verifican por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se omite.
  Por eso el cuerpo completo es comparable campo a campo.
- **Orden de las colecciones**: `listProducts` ordena por `createdAt` descendente y, ante empate,
  por `sku` ascendente (orden total). `getProductsByIds` devuelve los productos en el **orden de
  los ids del request**. `Product.images` se proyecta ordenada por `position` ascendente.
- **Mayúsculas y acentos**: la unicidad de `sku` es **sensible a mayúsculas** — `ACME-1` y `acme-1`
  son dos productos distintos.
- **Números**: no hay campos decimales en este diseño; `version` y `position` son enteros exactos.
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios fijan
  solo el `code` y el status HTTP; el resto se verifica por presencia y tipo.
- **Idempotencia**: `createProduct` declara `idempotency` con `ttlSeconds: 86400`. Cada request
  lleva un `Idempotency-Key` **uuid nuevo**, salvo en el escenario que prueba la deduplicación.
- **Concurrencia**: `updateProduct` acepta `expectedVersion`. Con un valor distinto del `version`
  actual el diseño no declara error propio: se anota como hueco y no se ejercita.
- **Eventos**: se verifican por el canal de eventos del servicio, con el nombre del evento exacto
  del diseño y su payload declarado. Nunca inspeccionando tablas internas.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createProduct | FL-PRD-001, FL-PRD-002, FL-PRD-003, FL-PRD-004, FL-IMG-001, FL-OBX-001 | usuarios |
| getProductBySlug | FL-PRD-002, FL-AUT-001, FL-CBR-001 | usuarios |
| updateProduct | FL-PRD-002, FL-AUT-003, FL-AUT-004 | usuarios |
| listProducts | FL-PRD-003 | usuarios |
| getProductsByIds | FL-PRD-003 | usuarios |
| retireProduct | FL-PRD-004, FL-CMP-001, FL-AUT-002, FL-RTY-001, FL-RTY-001-B | usuarios |
| projectSupplierPrice | FL-SUB-001 | interna (suscripción) |
| reactivateWithdrawnProduct | FL-CMP-001, FL-DLQ-001 | interna (compensación) |
| addProductImage | FL-IMG-001 | usuarios |
| removeProductImage | FL-IMG-001 | usuarios |

## Productos

### FL-PRD-001: alta de producto, unicidad de sku e idempotencia

**Given**: la categoría `c1` existe (slug `tools`, dato de arranque); no existe ningún producto con
sku `ACME-1`.

#### FL-PRD-001-A: alta correcta

**When**: `createProduct` — `POST /api/v1/products` con
`{"sku": "ACME-1", "name": "Martillo", "categoryId": "<c1>"}` e `Idempotency-Key: <uuid-1>`.
**Then**:
1. Status `201`.
2. Cabecera `Location` con la ruta del producto creado.
3. Cuerpo completo: `id` (uuid, por forma), `sku` = `"ACME-1"`, `name` = `"Martillo"`,
   `status` = `"draft"`, `version` (entero), `createdAt` (instante, por forma),
   `categoryId` = `<c1>`, `images` = `[]`. Ningún campo adicional.
4. Se publica el evento `ProductCreated` con payload `{productId: <id>, sku: "ACME-1",
   occurredAt: <instante>}`.
**Notas de determinación**: `<id>` se reutiliza simbólicamente en los escenarios siguientes del
flujo.

#### FL-PRD-001-B: sku duplicado

**When**: `createProduct` — `POST /api/v1/products` con el **mismo** `sku` `ACME-1`, `name`
`"Martillo de bola"` e `Idempotency-Key: <uuid-2>` (clave nueva).
**Then**:
1. Status `409`.
2. Cuerpo de error con `code` = `"SKU_ALREADY_EXISTS"` y `status` = `409`.
3. `listProducts` sigue devolviendo **un** producto con sku `ACME-1`: no hubo segundo efecto.

#### FL-PRD-001-C: unicidad sensible a mayúsculas

**When**: `createProduct` con `sku` `"acme-1"` e `Idempotency-Key: <uuid-3>`.
**Then**:
1. Status `201` — `acme-1` **no** colisiona con `ACME-1`.
2. El cuerpo devuelve `sku` = `"acme-1"` y un `id` distinto del de FL-PRD-001-A.

#### FL-PRD-001-D: categoría inexistente

**When**: `createProduct` con `categoryId` de un uuid que no corresponde a ninguna categoría e
`Idempotency-Key: <uuid-4>`.
**Then**:
1. Status `422`.
2. Cuerpo de error con `code` = `"CATEGORY_NOT_FOUND"`.

#### FL-PRD-001-E: reintento con la misma clave de idempotencia

**When**: `createProduct` con `{"sku": "ACME-9", "name": "Llave", "categoryId": "<c1>"}` e
`Idempotency-Key: <uuid-5>`, y a continuación **la misma llamada con la misma clave**.
**Then**:
1. La primera llamada devuelve `201` y un cuerpo con `id` = `<id9>`.
2. La segunda devuelve el **mismo** status `201` y el **mismo** cuerpo, con `id` = `<id9>`.
3. `listProducts` contiene un único producto con sku `ACME-9`: el reintento no creó un segundo.

**Orden de evaluación**:
1. Existencia de la categoría → `CATEGORY_NOT_FOUND` (`422`).
2. Unicidad de `sku` → `SKU_ALREADY_EXISTS` (`409`).

### FL-PRD-002: consulta pública por slug de categoría, caché e invalidación

**Given**: la categoría `c1` existe (slug `tools`) y la categoría `c2` existe (slug `garden`).

#### FL-PRD-002-A: preparación

**When**: `createProduct` — `POST /api/v1/products` con
`{"sku": "TOOL-1", "name": "Sierra", "categoryId": "<c1>"}` e `Idempotency-Key: <uuid-1>`.
**Then**:
1. Status `201`; el `id` devuelto es `<p1>`.

#### FL-PRD-002-B: lectura pública

**When**: `getProductBySlug` — `GET /api/v1/public/products/tools`.
**Then**:
1. Status `200`.
2. Cuerpo completo del producto `<p1>`: `id` = `<p1>`, `sku` = `"TOOL-1"`, `name` = `"Sierra"`,
   `status` = `"draft"`, `version` (entero), `createdAt` (instante, por forma),
   `categoryId` = `<c1>`, `images` = `[]`.

#### FL-PRD-002-C: lectura repetida (respuesta cacheada)

**When**: se repite `GET /api/v1/public/products/tools`.
**Then**:
1. Status `200`.
2. El cuerpo es **idéntico** al de FL-PRD-002-B, incluido `createdAt`: una marca de tiempo que
   pasa por caché y vuelve serializada debe conservar formato y valor.

#### FL-PRD-002-D: actualización parcial con categoría embebida

**When**: `updateProduct` — `PATCH /api/v1/products/<p1>` con `{"name": "Sierra de mano"}`.
**Then**:
1. Status `200`.
2. Cuerpo completo con `name` = `"Sierra de mano"`, `sku` = `"TOOL-1"` **sin cambios** (campo
   ausente en la entrada conserva su valor) y `category` **embebida** como objeto con `id`, `slug`
   = `"tools"`, `name` y `createdAt`.
3. Se publica el evento `ProductUpdated` con payload `{productId: <p1>, status: "draft"}`.

#### FL-PRD-002-E: la caché quedó invalidada

**When**: se repite `GET /api/v1/public/products/tools`.
**Then**:
1. Status `200`.
2. `name` = `"Sierra de mano"` — el `invalidatedBy: [ProductUpdated]` del diseño se cumplió; una
   invalidación incompleta devolvería `"Sierra"`.

#### FL-PRD-002-F: slug sin producto

**When**: `getProductBySlug` — `GET /api/v1/public/products/garden`.
**Then**:
1. Status `404`.
2. Cuerpo de error con `code` = `"PRODUCT_NOT_FOUND"`.

**Ramas condicionales**: en `updateProduct`, un campo ausente conserva su valor y un campo presente
con valor nulo vacía el campo (regla declarada en `use-cases`). FL-PRD-002-D cubre la ausencia.

### FL-PRD-003: listado paginado y recuperación en lote

**Given**: la categoría `c1` existe.

#### FL-PRD-003-A: preparación

**When**: `createProduct` tres veces, con skus `LIST-1`, `LIST-2` y `LIST-3` (en ese orden), cada
una con `Idempotency-Key` propio.
**Then**:
1. Las tres devuelven `201`; sus ids son `<l1>`, `<l2>` y `<l3>`.

#### FL-PRD-003-B: primera página

**When**: `listProducts` — `GET /api/v1/products?page=0&size=2`.
**Then**:
1. Status `200`.
2. El cuerpo lleva exactamente dos elementos, ordenados por `createdAt` descendente: `<l3>` y
   luego `<l2>`.
3. Los metadatos de paginación declaran 3 elementos totales y 2 páginas.

#### FL-PRD-003-C: página siguiente

**When**: `GET /api/v1/products?page=1&size=2`.
**Then**:
1. Status `200`.
2. Un único elemento: `<l1>`.

#### FL-PRD-003-D: página vacía

**When**: `GET /api/v1/products?page=5&size=2`.
**Then**:
1. Status `200`.
2. Colección vacía, con los mismos metadatos de total (3 elementos).

#### FL-PRD-003-E: tope de tamaño de página

**When**: `GET /api/v1/products?page=0&size=500` (`maxSize` declarado: 100).
**Then**:
1. Status `200`.
2. La respuesta se acota al tope: el tamaño de página efectivo es `100`, no `500`.

#### FL-PRD-003-F: recuperación en lote respetando el orden pedido

**When**: `getProductsByIds` — `POST /api/v1/products/batch` con `{"ids": ["<l2>", "<l1>"]}`.
**Then**:
1. Status `200`.
2. Lista de dos productos en el **orden de los ids del request**: `<l2>` primero, `<l1>` después.

### FL-PRD-004: retirada del catálogo

**Given**: la categoría `c1` existe.

#### FL-PRD-004-A: preparación

**When**: `createProduct` con sku `RET-1` e `Idempotency-Key` propio.
**Then**:
1. Status `201`; el `id` devuelto es `<r1>`, con `status` = `"draft"`.

#### FL-PRD-004-B: retirada

**When**: `retireProduct` — `POST /api/v1/products/<r1>/retire`.
**Then**:
1. Status `200`.
2. Cuerpo completo del producto con `status` = `"retired"`.
3. Se publica el evento `ProductUpdated` con payload `{productId: <r1>, status: "retired"}`.
4. `GET /api/v1/products` devuelve el producto con `status` = `"retired"`.

#### FL-PRD-004-C: producto inexistente

**When**: `retireProduct` sobre un uuid que no corresponde a ningún producto.
**Then**:
1. Status `404`.
2. Cuerpo de error con `code` = `"PRODUCT_NOT_FOUND"`.

#### FL-PRD-004-D: retirar un producto ya retirado

**When**: `retireProduct` — `POST /api/v1/products/<r1>/retire` sobre el producto ya `retired`.
**Then**:
1. Status `409` con `code` = `PRODUCT_NOT_RETIRABLE`: `retired` no está entre los orígenes
   declarados en `retireProduct.transitions` (`from: [draft, active]`).
2. El producto sigue en `retired` y **el proveedor no recibe una segunda inscripción**: el
   rechazo ocurre en el agregado, antes de encargar nada. Una implementación que llamara al
   registro y comprobara el estado después inscribiría una retirada por cada reintento.

## Proyección del precio de proveedor

### FL-SUB-001: llega un precio de proveedor y alimenta la copia local

Cubre el consumo de `SupplierPriceChanged` (`source: pricing`), que dispara la operación
interna `projectSupplierPrice`. El `When` se materializa con `deliverSupplierPriceChanged(...)`
del arnés, que conoce el canal y la envoltura del contrato.

**Given**: existe un producto con sku `SUP-1`.

#### FL-SUB-001-A: consumo

**When**: llega `SupplierPriceChanged` con payload
`{sku: "SUP-1", amount: 12.50, currency: "EUR", occurredAt: "2026-01-01T00:00:00Z"}`.
**Then**:
1. Se ejecuta `projectSupplierPrice` y la copia local queda con ese precio, observado por
   la API.

#### FL-SUB-001-B: reentrega del mismo mensaje

**When**: se entrega **otra vez** el mismo mensaje, con el **mismo** `messageId`.
**Then**:
1. La copia local sigue con un único precio para `SUP-1` y ningún efecto se repite.
2. El canal `external` de esta suscripción no declara `contract.messageId`, así que la
   deduplicación depende de la envoltura: **hueco declarado del fixture**, y es justo lo que
   este escenario deja a la vista.

## Compensación de la retirada

### FL-CMP-001: el registro regulatorio rechaza una retirada ya inscrita

Cubre la compensación `compliance.compensations[0]` (`undoes: recordWithdrawal`). La operación
compensadora es `reactivateWithdrawnProduct`, interna y disparada solo por la suscripción.

**Given**: la categoría `c1` existe.

#### FL-CMP-001-A: preparación

**When**: `createProduct` con sku `CMP-1` e `Idempotency-Key` propio, y después `retireProduct`
sobre el `id` devuelto `<p1>`.
**Then**:
1. Status `201` y `200` respectivamente; `GET /api/v1/products` devuelve `<p1>` con
   `status` = `"retired"`.

#### FL-CMP-001-B: llega el rechazo y se compensa

**When**: llega el evento entrante `WithdrawalRejected` (source `compliance`) con payload
`{productId: <p1>, reason: "documentación incompleta"}`.
**Then**:
1. Se ejecuta `reactivateWithdrawnProduct`.
2. `GET /api/v1/products` devuelve `<p1>` con `status` = `"active"`: el estado propio vuelve a
   donde estaba antes de encargar la inscripción, no se queda donde lo dejó un trabajo que ya no
   existe.
3. **El proveedor recibe un `DELETE /withdrawals/{p1}`**: la compensación tiene dos mitades y
   esta es la que no se ve desde nuestra base. Devolver solo el estado propio deja el registro
   regulatorio con la inscripción de una retirada que ya no existe — una deuda ajena que, por
   construcción, ninguna consulta a nuestro servicio delata.
4. Esa llamada lleva cabecera `Idempotency-Key` no vacía: es una escritura con reintentos
   contra un sistema ajeno, y una cancelación repetida por un timeout podría anular una
   inscripción **nueva** del mismo producto creada entretanto.

#### FL-CMP-001-C: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `WithdrawalRejected` con idéntico payload.
**Then**:
1. `<p1>` sigue con `status` = `"active"`, y no hay ningún segundo efecto observable.
2. El proveedor **no** recibe una segunda cancelación: sigue con **exactamente una**. Es la
   mitad del efecto único que vive fuera, y la que un `Then` que solo mire el estado propio no
   ve — precisamente porque el estado propio ya era correcto antes de la reentrega.
3. Es lo que garantiza la transición declarada (`from: [retired] → active`): con el producto ya en
   `active`, el guard del agregado rechaza reaplicarla. Sin este escenario, una implementación que
   compensa dos veces pasa FL-CMP-001-B sin que nada lo delate.

#### FL-CMP-001-D: el mismo evento se entrega dos veces a la vez

Lo que FL-CMP-001-C no prueba. La reentrega secuencial encuentra la marca de procesado ya
escrita y el producto ya en `active`: pasa aunque nada cubra la ventana en la que ninguna de
las dos cosas ha ocurrido todavía, que con varias réplicas consumiendo es el caso frecuente.

**Given**: un producto `<p2>` con sku `CMP-2`, retirado como en FL-CMP-001-A.

**When**: se entregan **simultáneamente** dos copias del mismo `WithdrawalRejected` con
idéntico payload `{productId: <p2>, reason: "documentación incompleta"}` y el mismo
identificador de mensaje.
**Then**:
1. `<p2>` queda en `status` = `"active"` — el efecto ocurre, una vez. Que ninguna de las dos
   llegue a aplicarse es tan grave como que se apliquen las dos.
2. El efecto es único en las **dos** superficies: el estado propio, y **exactamente una**
   cancelación recibida por el proveedor. Un duplicado que solo se ve en una de las dos es un
   duplicado que se escapa.
3. El servicio no acaba con el mensaje en la cola de dead-letter: que la copia perdedora falle
   por dentro es lo que hace la guarda, pero el resultado observable de esa entrega es una
   confirmación sin efecto, no un error propagado.

## Publicación con el canal caído

### FL-OBX-001: el canal está indisponible cuando se da de alta un producto

El escenario que separa `reliability: outbox` de `best-effort`, y el único. `FL-PRD-001-A` Then 4
afirma que `ProductCreated` acaba en el canal, y eso lo cumple igual un servidor que publica en
línea dentro de la operación: la diferencia solo se ve cuando el canal **no está** en el instante
del commit. La mitad que importa es la negativa.

**Given**: la categoría `c1` existe; no existe ningún producto con sku `OBX-1`.

**When**: se **detiene el broker** y, con él parado, `createProduct` — `POST /api/v1/products` con
`{"sku": "OBX-1", "name": "Cincel", "categoryId": "<c1>"}` e `Idempotency-Key` propia.
**Then**:
1. La mutación responde **igual que con el canal en pie**: status `201` y el cuerpo completo del
   contrato, con `sku` = `"OBX-1"` y `status` = `"draft"`. La disponibilidad del broker no es
   parte del contrato de la operación — si esta petición falla o tarda, el evento se está
   publicando dentro de la transacción y la fiabilidad que se declaró es la del broker, no la
   nuestra.
2. `getProductsByIds` con `<id>` devuelve el producto: el alta está **commiteada**, no pendiente
   de que el canal vuelva. Es la lectura por id que el diseño declara — no hay
   `GET /products/{id}`, y el listado público va por slug de categoría.
3. El canal del servicio sigue **vacío**. Es la afirmación que un servidor que publica en línea no
   puede satisfacer: o habría fallado en el Then 1, o el evento estaría fuera.

**When** (segunda mitad): se vuelve a **levantar el broker** y se espera a que esté listo.
**Then**:
4. `ProductCreated` para `<id>` aparece en el canal **exactamente una vez**, con el `productId` y
   el `sku` `"OBX-1"` del alta. Ni cero —el alta no se perdió con el canal— ni dos —el reintento
   del relay no duplica lo ya publicado—.

**Notas de determinación**: el sku es propio de este flujo y el Then 4 se acota a **este**
`productId`. Todos los demás flujos crean productos y publican el mismo evento, así que un
«exactamente una vez» sin acotar mediría otra cosa.

**Caso límite**: si el relay agotara sus intentos mientras el broker está parado, el evento
acabaría en dead-letter y el Then 4 fallaría por «cero». Eso no es un fallo del escenario: es la
política de reintentos declarada siendo más corta que la caída, y se arbitra como diseño.

## El fallback del proveedor

Los tres escenarios de esta sección ejercitan el **fallback estrecho** del adaptador HTTP:
`recordWithdrawal` declara `onFailure: fail` con `COMPLIANCE_UNAVAILABLE`, así que el desenlace
de cada modo de fallo es observable desde fuera. Ninguno necesita primitivas nuevas del arnés.

### FL-CMP-002: el circuito se abre y sigue contestando lo que el diseño declara

El camino que nunca se ha ejecutado en vivo. Cuando el circuito abre, resilience4j lanza
`CallNotPermittedException`, que **no** es una excepción del proveedor ni de Spring: si el
fallback no la atiende, sale cruda al llamante y el rechazo declarado se convierte en un 500.
Con `slidingWindowSize: 5` y `failureRateThreshold: 50`, cinco fallos seguidos lo abren.

**Given**: la categoría `c1` existe y el proveedor de compliance contesta `503` de forma
sostenida (`stubFailure("POST", "/withdrawals", 503)`).

**When**: se ejecuta `retireProduct` sobre cinco productos recién creados, y después una vez
más sobre un sexto.

**Then**:
1. Las seis peticiones responden el error declarado `COMPLIANCE_UNAVAILABLE` con su status.
   **Ninguna responde 500**: el circuito abierto es un modo de fallo previsto, no un defecto.
2. La sexta ya no llega al proveedor — `stubCallCount` deja de crecer. Es lo que distingue un
   circuito que abre de uno configurado y nunca aplicado.
3. Ningún producto queda en `retired`: `onFailure: fail` dice que sin inscripción la retirada
   no puede darse por buena, y eso vale igual cuando quien rechaza es el circuito.

### FL-CMP-003: un cuerpo que viola el contrato no es una caída del proveedor

El escenario que separa el comportamiento nuevo del viejo, y el que reproduce el defecto que
motivó estrechar el fallback: un fallo de **integración nuestro** disfrazado de caída ajena.

**Given**: la categoría `c1` existe y el proveedor contesta `200` con un cuerpo que no encaja
en el contrato declarado (`stubFor("POST", "/withdrawals", 200, "{\"registrationId\": {}}")`).

**When**: se ejecuta `retireProduct` sobre un producto recién creado.

**Then**:
1. La respuesta **no** es `COMPLIANCE_UNAVAILABLE`. El proveedor contestó, y a tiempo: acusarle
   de estar caído es un diagnóstico falso que manda a mirar sus logs en vez de los nuestros.
2. El fallo sube sin traducir (500) y el error de deserialización queda en el log del servidor.
   Es un defecto del adaptador y el 500 dice la verdad: el contrato wire no describe lo que el
   proveedor devuelve, y eso se arregla en `<X>Response`, no en el fallback.
3. `stubCallCount` es 1: no se reintenta. Un cuerpo mal formado no mejora repitiéndolo, y
   `retryOn` no lo incluye.

### FL-CMP-004: un rechazo del proveedor sigue teniendo el desenlace declarado

No-regresión. Un 4xx **sí** entra al fallback —el proveedor contestó, y hay que decidir qué
hacer— aunque no cuente para la ventana del circuito: que nos rechacen no es que estén caídos.

**Given**: la categoría `c1` existe y el proveedor contesta `400`
(`stubFailure("POST", "/withdrawals", 400)`).

**When**: se ejecuta `retireProduct` sobre un producto recién creado.

**Then**:
1. La respuesta es el error declarado `COMPLIANCE_UNAVAILABLE`: el desenlace es exactamente el
   de siempre.
2. El producto no queda en `retired`.
3. `stubCallCount` es 1: los 4xx nunca se reintentan.

## Imágenes de producto

### FL-IMG-001: subida y borrado de imágenes en el bucket público

**Given**: la categoría `c1` existe; el bucket `productImages` es público, admite `image/png` e
`image/jpeg` y tiene un máximo de 5 MB.

#### FL-IMG-001-A: preparación

**When**: `createProduct` con sku `IMG-1` e `Idempotency-Key` propio.
**Then**:
1. Status `201`; el `id` devuelto es `<i1>` y `images` = `[]`.

#### FL-IMG-001-B: subida de imagen

**When**: `addProductImage` — `POST /api/v1/products/<i1>/images` como multipart, con la parte
`image` (un PNG de 1 KB) y `position` = `0`.
**Then**:
1. Status `201`.
2. `GET /api/v1/public/products/tools` devuelve el producto `<i1>` con `images` de un elemento:
   `id` (uuid, por forma), `storageKey` (cadena no vacía), `position` = `0`, `primary` = `false`.
3. El archivo es recuperable por la referencia devuelta: al ser el bucket `public`, el acceso es
   directo y no requiere firma.
**Notas de determinación**: el `id` de la imagen es `<img1>` para el escenario siguiente; el
`storageKey` se verifica por forma, nunca por valor literal (lo compone el generador).

#### FL-IMG-001-C: borrado de imagen

**When**: `removeProductImage` — `DELETE /api/v1/products/<i1>/images/<img1>`.
**Then**:
1. Status `204`, sin cuerpo.
2. `GET /api/v1/public/products/tools` devuelve el producto `<i1>` con `images` = `[]`.

#### FL-IMG-001-D: producto inexistente

**When**: `addProductImage` sobre un uuid que no corresponde a ningún producto.
**Then**:
1. Status `404`.
2. Cuerpo de error con `code` = `"PRODUCT_NOT_FOUND"`.

**Casos borde sin cubrir**: rechazo por tamaño (>5 MB) y por content-type no permitido. El diseño
declara las políticas en `storage.buckets` pero no los `errors` correspondientes en
`addProductImage`, así que el `code` y el status esperados no están fijados. Hueco del diseño.

## Autenticación saliente

Los cuatro modos de auth que declara `http-clients` acaban en una cabecera del request que sale, y
esa cabecera **no la mira nadie**: el proveedor de prueba contesta igual con credencial que sin
ella, así que un cliente mal configurado —una property vacía, un `defaultHeader` que el builder
nunca aplicó, un interceptor no registrado— pasa todos los escenarios anteriores en verde y falla
el día del despliegue contra el proveedor real. Estos flujos afirman la credencial **en el cable**,
con `stubRequests(...)` y `stubRequestHeader(...)`.

Ninguno necesita primitivas nuevas del arnés.

### FL-AUT-001: las credenciales de lectura viajan en la petición

Un solo `getProductBySlug` dispara los dos `need` on-demand del diseño —`pricing.currentPrice` y
`legacy-erp.productCost`—, así que cubre de una vez los dos modos de auth de lectura, que además
son los dos que se configuran de forma distinta (`defaultHeader` suelto contra `setBasicAuth`).

**Given**: la categoría `c1` existe y hay un producto `<a1>` con sku `AUT-1` recuperable por el
slug `tools`; ambos proveedores contestan `200` con un cuerpo válido
(`stubFor("GET", "/prices/.*", 200, …)` y `stubFor("GET", "/costs/.*", 200, …)`); la caché de
lecturas está vacía (`clearCache()`).

**When**: `GET /api/v1/public/products/tools`.

**Then**:
1. Status `200` y el producto `<a1>`.
2. La petición que recibió `/prices/{sku}` lleva la cabecera `X-Api-Key` **no vacía** — el nombre
   exacto que declara `auth.headerName`, no el `X-Api-Key` por defecto de casualidad.
3. La petición que recibió `/costs/{sku}` lleva `Authorization` empezando por `Basic ` y, **una vez
   decodificado el base64**, el usuario y la contraseña del perfil `local`. Comprobar solo el
   prefijo es lo mismo que no comprobar nada: `setBasicAuth` con credenciales vacías produce un
   `Basic ` perfectamente formado.

**Notas de determinación**: el `Given` limpia la caché porque `getProductBySlug` declara
`ttlSeconds: 300` sobre `keyFields: [slug]` — una lectura servida de caché no llama a ningún
proveedor y el `Then` mediría un request de otro flujo.

### FL-AUT-002: la credencial estática de escritura viaja en la petición

**Given**: la categoría `c1` existe, un producto `<a2>` con sku `AUT-2`, y el registro regulatorio
contesta `200` con un cuerpo válido.

**When**: `retireProduct` sobre `<a2>`.

**Then**:
1. Status `200` y el producto en `retired`.
2. La petición que recibió `POST /withdrawals` lleva `Authorization` = `Bearer <token>` con el
   token del perfil `local` — no una cadena vacía detrás del prefijo.

### FL-AUT-003: OAuth2 pide el token una vez y lo reutiliza

El único modo de auth cuya credencial **no** sale de configuración: hay que ir a buscarla a otro
endpoint antes de la llamada de negocio. Dos cosas pueden salir mal y ninguna se ve desde el
resultado de la operación — que el token no se pida (y la llamada salga sin `Authorization`), y que
se pida en **cada** llamada (que funciona, y castiga al proveedor de identidad con una petición por
operación).

**Given**: la categoría `c1` existe y dos productos `<a3>` y `<a4>`; el endpoint de token contesta
`200` con `{"access_token": "tok-partner-1", "token_type": "Bearer", "expires_in": 3600}`
(`stubFor("POST", "/oauth2/token", 200, …)`) y `POST /partner/catalog-changes` contesta `200` con
un cuerpo válido.

**When**: `updateProduct` sobre `<a3>` y, a continuación, sobre `<a4>`.

**Then**:
1. Las dos responden `200`.
2. El proveedor recibió **dos** `POST /partner/catalog-changes`, una por operación.
3. Las dos llevan `Authorization` = `Bearer tok-partner-1`: exactamente el token que devolvió el
   endpoint de token, no uno inventado ni el `client-secret` colado en su lugar.
4. El endpoint de token recibió **exactamente una** petición. Es la mitad que distingue un cliente
   OAuth2 correcto de uno que funciona: el `OAuth2AuthorizedClientManager` cachea la concesión
   mientras no caduque, y `expires_in: 3600` garantiza que no lo hace dentro del flujo.

**Notas de determinación**: el token es un literal propio de este flujo (`tok-partner-1`) para que
el Then 3 sea una igualdad y no una comprobación de forma.

### FL-AUT-004: el proveedor de identidad caído no se convierte en un 500 propio

El modo de fallo que la capa `dependencies` ya declara, por un camino que ningún escenario
recorre: aquí no falla el proveedor de negocio sino **el emisor del token**, y el fallo ocurre
antes de que salga la primera petición de negocio. Si el adaptador no lo atiende, la excepción de
la obtención del token sale cruda y `onFailure: ignore` se convierte en un 500.

**Given**: la categoría `c1` existe y un producto `<a5>`; el endpoint de token contesta `500`
(`stubFailure("POST", "/oauth2/token", 500)`).

**When**: `updateProduct` sobre `<a5>`.

**Then**:
1. Status `200` y el producto actualizado. `notifyPartner` declara `onFailure: ignore`: que el
   socio no se entere no puede bloquear la edición de nuestra propia ficha.
2. `ProductUpdated` sale por el canal del servicio. El cambio ocurrió; lo que no ocurrió es el
   anuncio.
3. El proveedor **no** recibió ninguna `POST /partner/catalog-changes`: sin token no se sale, y
   una llamada sin `Authorization` sería peor que ninguna —el socio la rechazaría y el diagnóstico
   apuntaría a él—.

## Reintento y circuito

### FL-RTY-001: el reintento hace los intentos que declara, todos con la misma clave

`recordWithdrawal` declara `retry.maxAttempts: 3` e `idempotency: {keyFrom: payload-hash}`. Las dos
cosas son una sola garantía y ningún escenario las mide: un retry que hace más intentos de los
declarados castiga a un proveedor caído, y un retry cuyos intentos llevan claves **distintas**
inscribe la misma retirada tres veces en el registro regulatorio — que es exactamente la deuda que
la compensación de FL-CMP-001 tendría luego que ir a deshacer, sin saber que son tres.

**El modo de fallo importa y no es intercambiable**: esa llamada declara
`retryOn: [timeout, connection]` y **excluye 5xx a propósito** —repetir una escritura que el
proveedor pudo llegar a procesar arriesga la doble inscripción—. Así que el Given corta la
conexión; con un 503 el retry no se aplicaría y el escenario estaría midiendo lo contrario de lo
que el diseño declara.

**Given**: la categoría `c1` existe, un producto `<r1>` con sku `RTY-1`, y el registro regulatorio
**no contesta**: corta la conexión antes de responder
(`stubConnectionFault("POST", "/withdrawals")`).

**When**: `retireProduct` sobre `<r1>`.

**Then**:
1. La respuesta es el error declarado `COMPLIANCE_UNAVAILABLE` y `<r1>` no queda en `retired`.
2. El proveedor recibió **exactamente 3** peticiones: ni 1 (el retry no se aplicó) ni 5 (el
   `maxAttempts` que se lee es el de otro sitio). El circuito no interfiere: con
   `slidingWindowSize: 5` tres registros no lo abren.
3. Las **tres** llevan `Idempotency-Key` y es la **misma** en las tres. Un reintento con clave
   nueva es un alta nueva vista desde el otro lado, y el proveedor no tiene forma de saberlo.

#### FL-RTY-001-B: un 5xx en esa misma llamada NO se reintenta

La mitad negativa, y la que convierte al escenario anterior en una medida de `retryOn` en vez de
una medida de «hay retry». Sin ella, una configuración que reintentara todo pasaría el A.

**Given**: lo mismo, pero el proveedor contesta `503` (`stubFailure("POST", "/withdrawals", 503)`)
y un producto `<r2>` con sku `RTY-2`.

**When**: `retireProduct` sobre `<r2>`.

**Then**:
1. La respuesta sigue siendo `COMPLIANCE_UNAVAILABLE`: el desenlace no cambia con el modo de fallo.
2. El proveedor recibió **exactamente 1** petición. El 5xx está fuera del `retryOn` declarado.

**Notas de determinación**: los dos escenarios corren tras `resetState()`, así que el conteo del
stub empieza en cero. Sin ese reset, el Then 2 sumaría las llamadas de los flujos de compensación.

**Hueco del arnés, declarado**: la variante «falla dos veces y a la tercera responde 200» —que
probaría que el retry además *se recupera*— no es expresable hoy: los mappings del stub programan
una respuesta fija y el arnés no expone los escenarios con estado de WireMock. Se deja anotado en
vez de escribir un `Then` que la implementación no pueda satisfacer.

### FL-CBR-001: el circuito se abre y vuelve

`FL-CMP-002` ya prueba que un circuito **abre**. Que vuelva a cerrarse no lo prueba nadie, y es la
mitad que convierte al circuito en un mecanismo de recuperación en vez de en un interruptor de un
solo uso: un `waitDurationInOpenState` mal traducido —o un circuito que nunca pasa a semiabierto—
deja al proveedor descartado para siempre después de una caída de tres segundos.

`legacy-erp.getCost` existe para esto: `slidingWindowSize: 4`, `failureRateThreshold: 50` y
`waitDurationMs: 3000`, sin `retry` que multiplique los registros de la ventana.

**Given**: la categoría `c1` existe y un producto `<b1>` recuperable por el slug `tools`; el ERP
contesta `503` de forma sostenida (`stubFailure("GET", "/costs/.*", 503)`); el proveedor de precios
contesta `200`.

**When**: se ejecuta `GET /api/v1/public/products/tools` cuatro veces, con `clearCache()` antes de
cada una.

**Then**:
1. Las cuatro responden `200` con el producto. `getCost` declara `fallback` y su `need` es un
   enriquecimiento: que el ERP esté caído no puede tumbar la lectura.
2. `stubCallCount("GET", "/costs/.*")` es 4.

**When** (segunda mitad): el ERP vuelve a contestar `200` con un cuerpo válido y se ejecuta una
quinta lectura **inmediatamente**, con la caché limpia.

**Then**:
3. La lectura responde `200` y `stubCallCount` **sigue siendo 4**: el circuito está abierto y la
   llamada no sale. Es lo que separa un circuito abierto de un proveedor que simplemente había
   vuelto.

**When** (tercera mitad): se espera a que pase la ventana de `waitDurationMs` (3 s) y se ejecuta
una sexta lectura con la caché limpia.

**Then**:
4. `stubCallCount` es 5: la llamada **sí** sale. El circuito pasó a semiabierto y dejó pasar la
   petición de prueba, que es la diferencia entre un mecanismo de recuperación y un interruptor
   de un solo uso.

**Notas de determinación**: la espera se hace con la primitiva de espera del arnés sobre una
condición observable, nunca con una pausa fija — 3 s es el mínimo, no el tiempo que tarda. Los
`clearCache()` son obligatorios: `getProductBySlug` cachea 300 s y una lectura servida de caché no
llama al ERP, así que sin ellos el flujo mediría una sola llamada y cuatro aciertos de caché.

**Hueco del diseño, declarado** (y del DSL, no solo de este fixture): el flujo se mide entero por
el conteo de llamadas porque **el dato del `need` no es observable en la respuesta**.
`getProductBySlug` declara `output: { entity: Product }`, y esa forma de payload no admite campos
extra (`additionalProperties: false` en el schema), así que un `need` con `strategy: on-demand`
y `usedBy: [getProductBySlug]` no tiene por dónde llegar al cuerpo. Le pasa igual a
`pricing.currentPrice`, que lleva en el diseño desde antes. Mientras eso no se pueda expresar, el
`Then` que afirmaría «el coste llegó hasta la respuesta» no se puede escribir, y afirmarlo de
todos modos sería pedirle a la implementación algo que el contrato no tiene.

## El descarte

### FL-DLQ-001: la entrega que agota sus reintentos acaba en el descarte

Hasta aquí la cola de descarte solo se comprueba **vacía** (FL-CMP-001-C, FL-CMP-001-D). Una
aserción negativa sobre un destino que nunca recibe nada da verde exactamente igual que una sobre
un destino que funciona: si la política de `onFailure` no llegara a configurarse —o el destino no
existiera— todos esos `Then` seguirían pasando. Este flujo es la mitad positiva que los sostiene.

`WithdrawalRejected` declara `retry.maxAttempts: 5` con backoff exponencial y `deadLetter: true`.

**Given**: la categoría `c1` existe. No existe ningún producto con el id `<x1>` (un uuid que no
corresponde a nada).

**When**: llega el evento entrante `WithdrawalRejected` con payload
`{productId: <x1>, reason: "documentación incompleta"}` — una compensación de un producto que no
está. Es el caso que el propio diseño anota como carrera posible (la compensación puede llegar
antes que el hecho que compensa), llevado a su desenlace: aquí el hecho no llega nunca.

**Then**:
1. `reactivateWithdrawnProduct` falla en cada intento; el consumo se reintenta hasta agotar los 5
   que declara el diseño.
2. El mensaje aparece en el destino de descarte de la suscripción — `deadLetterMessages` para
   `WithdrawalRejected` devuelve el mensaje, con el `productId` `<x1>` que se entregó.
3. Ningún producto del catálogo cambia de estado: el descarte no es un efecto parcial, es la
   ausencia de efecto con constancia.

**Notas de determinación**: el `productId` es propio de este flujo, así que el Then 2 se acota a
**este** mensaje y no cuenta descartes de otros. Con backoff exponencial desde 500 ms, los cinco
intentos consumen unos 7,5 s: la espera es sobre la aparición del mensaje en el descarte, no sobre
un plazo fijo.
