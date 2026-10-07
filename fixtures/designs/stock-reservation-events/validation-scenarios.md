# stock-reservation-events — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/stock-reservation-events v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Es la variante de `stock-reservation` hecha para medir la
> **mensajería** de los dos generadores con el mismo diseño: el encargo sale publicado por el outbox y
> su desenlace llega por tres suscripciones, deduplicadas en los dos órdenes del guard. Cada flujo
> pone a prueba un mecanismo, y ninguno está de adorno.

> **Los caminos caros.** `FL-OBX-001`, `FL-RES-001-C`, `FL-CMP-001-C` y `FL-CNT-001-B` no describen
> casos de negocio distintos de los de arriba: describen los **mismos** casos en las condiciones bajo
> las que estos mecanismos existen — el canal caído, dos peticiones a la vez, dos entregas a la vez y
> la reentrega sin guarda de dominio. Son los únicos que distinguen un servidor que implementa la
> garantía de uno que solo la declara.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). `createdAt` se verifica **por forma**, nunca por valor.
- **Identificadores**: `uuid` canónico. Se verifican por forma y por reutilización simbólica dentro
  del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se omite.
  `releaseReason` y `lastCountedQuantity` son nulos hasta que algo los escribe.
- **Forma del cuerpo de error**: `{timestamp, status, error, code, message, details}` más
  `correlationId`. Los escenarios fijan solo el `code` y el status HTTP.
- **Idempotencia de petición**: `createReservation` declara `idempotency` con `ttlSeconds: 3600`.
  Cada request lleva un `Idempotency-Key` **uuid nuevo**, salvo en el escenario que prueba la
  deduplicación, que repite el anterior a propósito.
- **Eventos entrantes**: llegan en la envoltura Keel de la fuente (`inventory`), y su identidad es
  `metadata.eventId`. «El **mismo** `messageId`» significa el mismo `eventId`: con ids distintos son
  dos hechos distintos, no una reentrega.
- **Disponibilidad del canal**: el broker es infraestructura viva y el arnés lo puede **parar y volver
  a levantar**. Un escenario que lo pare tiene que volver a levantarlo en el mismo flujo, y hasta que
  el sondeo lo dé por listo nada de lo que se afirme sobre el canal cuenta.
- **Efecto único**: donde el `Then` dice «una sola vez», se afirma sobre el estado leído por la API
  **y** sobre el canal (cuántas veces se publicó) o el descarte (que la copia sobrante no acabó ahí),
  nunca sobre una sola superficie.
- **Estado entre flujos**: el arnés deja el estado como recién arrancado al empezar cada flujo (`### FL-*`),
  nunca entre los escenarios de un mismo flujo (`#### FL-*-B`…). Por eso cada `Given` de un flujo fabrica
  su reserva por el camino declarado, y solo los escenarios de dentro de un flujo usan lo que dejó el
  anterior.
- **Concurrencia**: los escenarios de carrera arrancan sus dos ramas a la vez y no afirman **cuál**
  gana. Lo que se afirma es una disyunción **cerrada** de resultados admisibles más un conteo
  posterior: cualquier otra forma convierte una prueba de concurrencia en una lotería.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createReservation | FL-RES-001, FL-RES-001-B, **FL-RES-001-C**, **FL-RES-001-D** | usuarios |
| confirmReservation | FL-RES-002, **FL-OBX-001**, FL-RES-004 | usuarios |
| applyStockReserved | FL-RES-003, FL-RES-003-B, FL-RES-004 | suscripción (interna) |
| noteStockCount | FL-CNT-001, **FL-CNT-001-B** | suscripción (interna) |
| getReservation | FL-RES-001, FL-RES-004 | usuarios |
| releaseReservation | FL-CMP-001, FL-CMP-001-B, **FL-CMP-001-C** | suscripción (interna) |

Y la misma matriz leída por **mecanismo**, que es como se decide si falta algo:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Idempotencia de petición (`idempotency_record`) | FL-RES-001-B (reintento secuencial) | **FL-RES-001-C** (carrera) · **FL-RES-001-D** (la ventana caduca) |
| Idempotencia de consumo, con guarda de dominio | FL-RES-003-B, FL-CMP-001-B (reentrega) | **FL-CMP-001-C** (doble entrega simultánea) |
| Idempotencia de consumo, **sin** guarda de dominio (`tryRecord`) | FL-CNT-001 | **FL-CNT-001-B** (reentrega contra un contador) |
| Outbox | FL-RES-002 (el evento sale) | **FL-OBX-001** (el canal no está) |
| Descarte de lo que no se puede procesar | — | FL-RES-004 Then 3 (el aviso de un pedido desconocido acaba en el descarte) |

## Reserva de stock

### FL-RES-001: se registra una reserva

**When**: `POST /api/v1/reservations` con `{orderId: <o1>, sku: "SKU-1", quantity: 2}` y un
`Idempotency-Key` propio `<k1>`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `orderId` = `<o1>`, `sku` = `"SKU-1"`, `quantity` = `2`, `status` =
   `"pending"`, `releaseReason` = `null`, `lastCountedQuantity` = `null`, `adjustmentCount` = `0` y
   `createdAt` con forma de instante.
3. `GET /api/v1/reservations/{id}` devuelve lo mismo.

#### FL-RES-001-B: el cliente reintenta con la misma clave

**When**: se repite **exactamente** el mismo `POST` con el **mismo** `Idempotency-Key` `<k1>`.
**Then**:
1. La respuesta es la **misma** que la primera vez: **`201`**, el **mismo** `id` y el mismo cuerpo, y
   la cabecera `Location` **repetida** con esa misma ruta. La repetición reproduce el resultado, no
   ejecuta de nuevo.
2. No se crea una segunda reserva: el `orderId` sigue teniendo una sola, y un `POST` con `<o1>` y
   **otra** clave devuelve `409 RESERVATION_ALREADY_EXISTS`.

#### FL-RES-001-C: dos peticiones con la misma clave, a la vez

Lo que FL-RES-001-B **no** prueba. El reintento secuencial llega cuando el registro de la clave ya
está commiteado y lo resuelve una lectura: pasa aunque nada arbitre la ventana anterior al commit —
que es justo la que golpea un cliente con reintentos automáticos.

**Given**: un pedido `<o2>` sin reserva y una clave `<k2>` sin usar.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/reservations` idénticos, con
`{orderId: <o2>, sku: "SKU-2", quantity: 1}` y el **mismo** `Idempotency-Key` `<k2>`.
**Then**:
1. Una de las dos responde `201`.
2. La otra responde **exactamente una** de estas dos cosas, y ninguna otra: `201` con el **mismo**
   `id` y el mismo cuerpo, o `409` con `code` = `IDEMPOTENCY_KEY_IN_PROGRESS`. Lo que no es correcto
   es un `500`, un `409 RESERVATION_ALREADY_EXISTS` (que acusa al pedido de un problema que es de la
   clave) ni un `201` con un `id` distinto.
3. `<o2>` tiene **una sola** reserva: `GET /api/v1/reservations/{id}` sobre el `id` devuelto por la
   que respondió `201` funciona, y un `POST` posterior con `<o2>` y otra clave devuelve
   `409 RESERVATION_ALREADY_EXISTS`.

**Orden de evaluación**: la clave de idempotencia se arbitra **antes** que la unicidad del pedido. Si
el `409` que sale es `RESERVATION_ALREADY_EXISTS`, el registro de la clave no está mediando y lo que
deduplica es la restricción de la base.

#### FL-RES-001-D: la clave vuelve a servir cuando su ventana ha pasado

`idempotency` declara `ttlSeconds: 3600`: pasada esa ventana la clave deja de identificar nada y
vuelve a estar libre.

**Given**: la reserva de FL-RES-001, creada con la clave `<k1>`, cuyo registro de idempotencia se
lleva **más allá de su caducidad** (el escenario envejece `expires_at` directamente sobre la fila:
esperar una hora no es una prueba).

**When**: se hace un `POST /api/v1/reservations` con un pedido **nuevo** `<o6>` y la clave `<k1>`
**reutilizada**.
**Then**:
1. Status `201`: la petición se ejecuta. No es una repetición — la clave está libre.
2. El cuerpo trae un `id` **distinto** del de FL-RES-001 y `orderId` = `<o6>`.
3. La reserva original sigue existiendo y sin cambios.

**Caso límite que este escenario cierra**: el registro caducado **sigue en la tabla** hasta que la
purga lo retire. Si escribir la clave se limitase a intentar la inserción, chocaría con esa fila y la
petición recibiría `409 IDEMPOTENCY_KEY_IN_PROGRESS`: el que la escribe tiene que retirarla.

## Encargo asíncrono al almacén

### FL-RES-002: confirmar publica el encargo y deja la reserva esperando

**Given**: una reserva `<r1>` con su pedido `<o1>`, `sku` = `"SKU-1"` y `quantity` = `2`, creada como en
FL-RES-001 y todavía en `pending`.

**When**: `POST /api/v1/reservations/{r1}/confirm`.
**Then**:
1. Status `200` y `status` = `"awaitingStock"` — **no** `confirmed`: esta operación no conoce el
   desenlace, solo deja la reserva esperándolo.
2. Se publica `StockReservationRequested` en el canal `stockEvents`, **una vez**, con `orderId` =
   `<o1>`, `sku` = `"SKU-1"` y `quantity` = `2`.
3. `GET /api/v1/reservations/{r1}` sigue devolviendo `awaitingStock`: es el estado en el que se queda
   hasta que el almacén responda.

### FL-OBX-001: el canal está indisponible cuando se encarga el stock

El escenario que separa `reliability: outbox` de `best-effort`, y el único. FL-RES-002 afirma que el
evento acaba en el canal, y eso lo cumple igual un servidor que publica en línea dentro de la
operación: la diferencia solo se ve cuando el canal **no está** en el instante del commit.

**Given**: una reserva `<r3>` con su pedido `<o3>`, en `pending`, creada como en FL-RES-001.

**When**: se **detiene el broker** y, con él parado, se hace `POST /api/v1/reservations/{r3}/confirm`.
**Then**:
1. La mutación responde **igual que con el canal en pie**: status `200` y `status` =
   `"awaitingStock"`. La disponibilidad del broker no es parte del contrato de la operación.
2. `GET /api/v1/reservations/{r3}` devuelve `awaitingStock`: el cambio de estado está
   **commiteado**, no pendiente de que el canal vuelva.
3. El canal `stockEvents` sigue **vacío**. Es la afirmación que un servidor que publica en línea no
   puede satisfacer: o habría fallado en el Then 1, o el evento estaría fuera.

**When** (segunda mitad): se vuelve a **levantar el broker** y se espera a que esté listo.
**Then**:
4. `StockReservationRequested` para `<o3>` aparece en `stockEvents` **exactamente una vez**, con el
   `orderId`, `sku` y `quantity` de la reserva. Ni cero —el encargo no se perdió con el canal— ni dos
   —el reintento del relay no duplica lo ya publicado—.
5. El outbox no se rindió con ningún evento: ninguno quedó abandonado tras agotar sus reintentos.

**Caso límite**: si el relay agotara sus intentos mientras el broker está parado, el evento quedaría
abandonado y fallarían los Then 4 y 5. Eso no es un fallo del escenario: es la política de reintentos
del perfil más corta que la caída, y se arbitra como tal.

### FL-RES-003: el almacén confirma y la reserva sale de la espera

**Given**: una reserva `<r1>` con su pedido `<o1>` en `awaitingStock`, llegada ahí por el camino de
FL-RES-001 → FL-RES-002.

**When**: llega el evento entrante `StockReserved` con payload `{orderId: <o1>}` y `messageId` `<m2>`.
**Then**:
1. Se ejecuta `applyStockReserved`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"confirmed"` y `releaseReason` = `null`.

#### FL-RES-003-B: el mismo aviso del almacén se reentrega

**When**: se entrega **otra vez** el mismo `StockReserved`, con idéntico payload y el **mismo**
`messageId` `<m2>`.
**Then**:
1. `GET /api/v1/reservations/{r1}` sigue devolviendo `status` = `"confirmed"`: ningún segundo efecto.
2. El mensaje **no** acaba en el descarte de `StockReserved`: una reentrega es el comportamiento
   normal de un broker, no un fallo.

**Qué prueba y qué no**: aquí hay **dos** guardas, y el escenario no distingue cuál actuó — la
deduplicación del listener por el `messageId` y la transición `awaitingStock → confirmed`, que es
irrepetible y rechaza el segundo intento. Basta con que el efecto no se repita y el mensaje no se
descarte.

### FL-RES-004: lo que se pide sobre una reserva que no existe

**Given**: un id `<rx>` y un pedido `<ox>` que no corresponden a ninguna reserva.

**When**: `GET /api/v1/reservations/{rx}`.
**Then**:
1. Status `404` y `code` = `RESERVATION_NOT_FOUND`.

**When**: `POST /api/v1/reservations/{rx}/confirm`.
**Then**:
2. Status `404` y `code` = `RESERVATION_NOT_FOUND`. No se publica nada en `stockEvents`.

**When**: llega `StockReserved` con payload `{orderId: <ox>}` y un `messageId` nuevo.
**Then**:
3. El mensaje acaba en el descarte de `StockReserved`. `applyStockReserved` responde
   `RESERVATION_NOT_FOUND`, que es un rechazo de negocio: reintentarlo no hará aparecer la reserva, así
   que va al descarte sin agotar los reintentos, que es donde el almacén puede verlo.

## Compensación: el almacén rechaza a posteriori

### FL-CMP-001: llega el rechazo y la reserva se libera

La operación compensadora es `releaseReservation`, interna y disparada solo por la suscripción.

**Given**: una reserva `<r1>` con su pedido `<o1>` en `confirmed`, llegada ahí por el camino de
FL-RES-001 → FL-RES-002 → FL-RES-003.

**When**: llega el evento entrante `StockRejected` con payload
`{orderId: <o1>, reason: "stock retirado por caducidad"}` y `messageId` `<m1>`.
**Then**:
1. Se ejecuta `releaseReservation`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"released"` y `releaseReason` =
   `"stock retirado por caducidad"`: el estado propio vuelve, no se queda donde lo dejó un trabajo que
   ya no existe.

#### FL-CMP-001-B: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `StockRejected`, con idéntico payload y el **mismo**
`messageId` `<m1>`.
**Then**:
1. `<r1>` sigue en `released` y `releaseReason` no cambia: ningún segundo efecto.
2. El mensaje **no** acaba en el descarte de `StockRejected`.
3. Es lo que garantizan las dos mitades juntas: la envoltura Keel deduplica en el listener por
   `metadata.eventId`, y la transición declarada (`from: [awaitingStock, confirmed] → released`)
   rechaza la segunda aplicación aunque el mensaje llegara por otro camino.

#### FL-CMP-001-C: el mismo evento se entrega dos veces a la vez

Y esto tampoco lo prueba FL-CMP-001-B. La reentrega **secuencial** encuentra la marca de procesado ya
escrita y el agregado ya en `released`: pasa aunque nada cubra la ventana en la que ninguna de las dos
cosas ha ocurrido todavía.

**Given**: una reserva `<r4>` en `confirmed`, llegada ahí por el camino de FL-RES-001 → FL-RES-002 →
FL-RES-003 con su propio pedido `<o4>`.

**When**: se entregan **simultáneamente** dos copias del mismo `StockRejected`, con idéntico payload
`{orderId: <o4>, reason: "stock retirado por caducidad"}` y el **mismo** `messageId` `<m4>`.
**Then**:
1. `GET /api/v1/reservations/{r4}` devuelve `status` = `"released"` y `releaseReason` con el motivo —
   el efecto ocurre, una vez. Que ninguna de las dos llegue a aplicarse es un fallo tan grave como que
   se apliquen las dos.
2. Ninguna de las dos copias acaba en el descarte de `StockRejected`. Que la perdedora falle por
   dentro es correcto y esperable —es lo que hace la guarda—, pero su resultado observable es una
   entrega **confirmada sin efecto**, no un error propagado.

**Orden de evaluación**: aquí actúan tres cosas a la vez y el escenario no dice cuál gana, solo que el
resultado es uno: el registro de procesados, la transición de lifecycle y el bloqueo optimista de la
raíz, que convierte en conflicto la escritura sobre una versión que ya cambió.

## Corrección de recuento: deduplicar sin guarda de dominio

Los escenarios de arriba deduplican con **dos** cosas encima: el registro de procesados y una
transición de lifecycle que ya es irrepetible por sí sola. Este flujo quita esa red: `noteStockCount`
**no declara transiciones** y lo que escribe es un **contador**. Aplicarla dos veces se ve, y lo único
que puede impedirlo es la marca de procesado.

### FL-CNT-001: el almacén corrige el recuento del pedido

**Given**: una reserva `<r6>` con su pedido `<o6>`, creada como en FL-RES-001 y todavía en `pending`,
con `adjustmentCount` = `0` y `lastCountedQuantity` = `null`.

**When**: llega el evento entrante `StockCountAdjusted` con payload `{orderId: <o6>, countedQuantity: 5}`
y `messageId` `<m5>`.
**Then**:
1. `GET /api/v1/reservations/{r6}` devuelve `lastCountedQuantity` = `5` y `adjustmentCount` = `1`.
2. El `status` **no cambia**: un recuento no es un desenlace del encargo.

#### FL-CNT-001-B: el mismo recuento se reentrega

**When**: se entrega **otra vez** el mismo `StockCountAdjusted`, con idéntico payload y el **mismo**
`messageId` `<m5>`.
**Then**:
1. `adjustmentCount` sigue siendo `1`. Es la afirmación entera del escenario: aquí no hay estado
   terminal que rechace la repetición — un segundo procesamiento suma, y se ve.
2. `lastCountedQuantity` sigue siendo `5`.
3. El mensaje **no** acaba en el descarte de `StockCountAdjusted`.

**Orden de evaluación**: sin transición detrás, la marca de procesado tiene que escribirse **antes** de
aplicar el efecto. Es el orden contrario al de la compensación, y no son intercambiables: allí procesar
primero es correcto porque un fallo transitorio se reintenta y la repetición la frena el agregado; aquí
no hay nada que la frene, así que la ventana se cierra antes a cambio de perder el mensaje si el handler
revienta.
