# stock-reservation — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/stock-reservation v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Este archivo no es un diseño real: es el escenario
> **mínimo** que ejercita la cadena entera de compensación e idempotencia contra
> infraestructura real. Cada flujo existe para poner a prueba uno de los cuatro mecanismos,
> y ninguno está de adorno.

> **Los cinco caminos caros.** Los escenarios `FL-OBX-001`, `FL-RES-001-C`, `FL-CMP-001-C`,
> `FL-REC-001` y `FL-CNT-001-B` no describen casos de negocio distintos de los de arriba:
> describen los **mismos** casos en las condiciones bajo las que estos mecanismos existen —
> el canal caído, dos peticiones a la vez, dos entregas a la vez, el desenlace que no llega y
> la reentrega sin guarda de dominio. Son los únicos que distinguen un servidor que implementa
> la garantía de uno que solo la declara, y cada uno se apoya en una primitiva del arnés
> (`stopBroker`, `raceOf`, `race`, `db`, `stubRequestHeader`) que hasta aquí no usaba nadie.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). `createdAt` se verifica **por forma**, nunca por valor.
- **Identificadores**: `uuid` v4 canónico. Se verifican por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se
  omite. `releaseReason` es nulo hasta que la compensación lo escribe.
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios
  fijan solo el `code` y el status HTTP.
- **Idempotencia de petición**: `createReservation` declara `idempotency` con
  `ttlSeconds: 3600`. Cada request lleva un `Idempotency-Key` **uuid nuevo**, salvo en el
  escenario que prueba la deduplicación, que repite el anterior a propósito.
- **Idempotencia saliente**: la llamada a `inventory.cancelStock` —la única que sale por HTTP;
  `reserveStock` viaja publicada— lleva la cabecera
  `Idempotency-Key` que genera el servicio a partir del contenido. Se verifica sobre el
  proveedor de prueba, no sobre logs.
- **Proveedor de prueba**: `inventory` es WireMock. Cada flujo programa sus respuestas y
  cuenta las llamadas recibidas; el arnés lo resetea entre flujos.
- **Disponibilidad del canal**: el broker es infraestructura viva y el arnés lo puede **parar
  y volver a levantar**. Un escenario que lo pare tiene que volver a levantarlo en el mismo
  flujo, y hasta que el sondeo lo dé por listo nada de lo que se afirme sobre el canal cuenta.
- **Efecto único**: donde el `Then` dice «una sola vez», se afirma sobre **dos** superficies —
  el estado leído por la API y el conteo de llamadas al proveedor—, nunca sobre una. Un
  duplicado que solo se ve en una de las dos es un duplicado que se escapa.
- **Concurrencia**: los escenarios de carrera arrancan sus dos ramas a la vez y no afirman
  **cuál** gana. Lo que se afirma es una disyunción **cerrada** de resultados admisibles más
  un conteo posterior: cualquier otra forma convierte una prueba de concurrencia en una
  lotería que pasa la mitad de las veces.
- **Reconciliación**: la frecuencia del barrido (cada minuto) y su umbral de paciencia son
  cosas distintas, y el escenario solo toca la antigüedad de la fila —retrasa `awaiting_since`
  directamente en la base—. No se acorta el umbral: eso pondría a todos los demás flujos bajo
  el barrido y mediría un servicio que nadie opera.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createReservation | FL-RES-001, FL-RES-001-B, **FL-RES-001-C**, **FL-RES-001-D** | usuarios |
| confirmReservation | FL-RES-002, **FL-OBX-001** | usuarios |
| applyStockReserved | FL-RES-003 | suscripción (interna) |
| noteStockCount | **FL-CNT-001**, **FL-CNT-001-B** | suscripción (interna) |
| getReservation | todos | usuarios |
| releaseReservation | FL-CMP-001, FL-CMP-001-B, **FL-CMP-001-C** | suscripción (interna) |
| reconcileReservations | **FL-REC-001** | programada; alcanzable retrasando el reloj de la fila |
| **clúster (2 réplicas)** | **FL-CLU-001**, **FL-CLU-002**, **FL-CLU-003** | outbox, barrido e idempotencia, arbitrados entre procesos |

Y la misma matriz leída por **mecanismo**, que es como se decide si falta algo:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Idempotencia de petición (`idempotency_record`) | FL-RES-001-B (reintento secuencial) | **FL-RES-001-C** (carrera) · **FL-RES-001-D** (la ventana caduca) |
| Idempotencia de consumo, con guarda de dominio | FL-CMP-001-B (reentrega) | **FL-CMP-001-C** (doble entrega simultánea) |
| Idempotencia de consumo, **sin** guarda de dominio (`tryRecord`) | FL-CNT-001 | **FL-CNT-001-B** (reentrega contra un contador) |
| Idempotencia saliente (`OutboundIdempotency`) | — | **FL-REC-001** Then 3 (la cabecera en el cable) |
| Outbox | FL-RES-002 (el evento sale) | **FL-OBX-001** (el canal no está) |
| Reconciliación | — | **FL-REC-001** |
| Arbitraje ENTRE réplicas | — | **FL-CLU-001** (relay) · **FL-CLU-002** (barrido) · **FL-CLU-003** (clave) |

`reconcileReservations` **ya no es `uncovered`**. Seguía sin flujo no por falta de efecto
observable —lo tiene: saca la reserva de `awaitingStock` y llama al almacén— sino porque un
cron no se alcanza desde fuera. Lo que lo desbloquea no es acortar el cron hasta que quepa en
una prueba, que sería medir un servicio distinto del que se opera: es que el umbral de
paciencia y la frecuencia del barrido son **dos cosas separadas**, y solo la segunda tiene que
ser corta. El escenario mueve la única variable que le queda al arnés —la antigüedad de la
fila— y espera un tick. `infra/check-idempotency.sh` sigue cubriéndolo en estático, que es lo
que verifica lo que el `Then` no puede ver (que el barrido *reclame* con cota en vez de leer).

## Reserva de stock

### FL-RES-001: se registra una reserva

**When**: `POST /api/v1/reservations` con `{orderId: <o1>, sku: "SKU-1", quantity: 2}` y un
`Idempotency-Key` propio `<k1>`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `orderId` = `<o1>`, `status` = `"pending"`,
   `releaseReason` = `null` y `createdAt` con forma de instante.
3. `GET /api/v1/reservations/{id}` devuelve lo mismo.

#### FL-RES-001-B: el cliente reintenta con la misma clave

**When**: se repite **exactamente** el mismo `POST` con el **mismo** `Idempotency-Key` `<k1>`.
**Then**:
1. La respuesta es la **misma** que la primera vez, con el **mismo** `id`: la repetición
   reproduce el resultado, no ejecuta de nuevo.
2. No se crea una segunda reserva: el `orderId` sigue teniendo una sola, y un `POST` con
   `<o1>` y **otra** clave devuelve `409 RESERVATION_ALREADY_EXISTS`.

#### FL-RES-001-C: dos peticiones con la misma clave, a la vez

Lo que FL-RES-001-B **no** prueba. El reintento secuencial llega cuando el registro de la
clave ya está commiteado y lo resuelve una lectura: pasa aunque nada arbitre la ventana
anterior al commit — que es justo la que golpea un cliente con reintentos automáticos, o dos
réplicas del mismo cliente.

**Given**: un pedido `<o2>` sin reserva y una clave `<k2>` sin usar.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/reservations` idénticos, con
`{orderId: <o2>, sku: "SKU-2", quantity: 1}` y el **mismo** `Idempotency-Key` `<k2>`.
**Then**:
1. Una de las dos responde `201`.
2. La otra responde **exactamente una** de estas dos cosas, y ninguna otra: `201` con el
   **mismo** `id` y el mismo cuerpo, o `409` con `code` = `IDEMPOTENCY_KEY_IN_PROGRESS`. Las
   dos son correctas porque son las dos formas legítimas de resolver la carrera —esperar al
   resultado o rebotar al que llega segundo—; lo que no es correcto es un `500`, un `409
   RESERVATION_ALREADY_EXISTS` (que acusa al pedido de un problema que es de la clave) ni un
   `201` con un `id` distinto.
3. `<o2>` tiene **una sola** reserva: `GET /api/v1/reservations/{id}` sobre el `id` devuelto
   por la que respondió `201` funciona, y un `POST` posterior con `<o2>` y otra clave devuelve
   `409 RESERVATION_ALREADY_EXISTS`. El conteo es la mitad que de verdad cierra el escenario:
   sin él, dos `201` con ids distintos pasarían el Then 2.

**Orden de evaluación**: la clave de idempotencia se arbitra **antes** que la unicidad del
pedido. Si el `409` que sale es `RESERVATION_ALREADY_EXISTS`, el registro de la clave no está
mediando y lo que deduplica es la restricción de la base — que funciona aquí por accidente y
no funcionaría en una operación sin clave natural.

#### FL-RES-001-D: la clave vuelve a servir cuando su ventana ha pasado

`idempotency` declara `ttlSeconds: 3600`: pasada esa ventana la clave deja de identificar
nada y vuelve a estar libre. La deduplicación es una promesa **acotada en el tiempo**, y el
diseño fija cuánto dura; si en la práctica durase más —hasta que algo barra el registro— la
ventana la fijaría la purga y no el diseño, que es justo lo que el campo compra.

**Given**: la reserva de FL-RES-001, creada con la clave `<k1>`, cuyo registro de idempotencia
se lleva **más allá de su caducidad** (el escenario envejece `expires_at` directamente sobre
la fila: esperar una hora no es una prueba).

**When**: se hace un `POST /api/v1/reservations` con un pedido **nuevo** `<o6>` y la clave
`<k1>` **reutilizada**.
**Then**:
1. Status `201`: la petición se ejecuta. No es una repetición — la clave está libre.
2. El cuerpo trae un `id` **distinto** del de FL-RES-001 y `orderId` = `<o6>`.
3. La reserva original sigue existiendo y sin cambios.

**Caso límite que este escenario cierra**: el registro caducado **sigue en la tabla** hasta
que la purga lo retire, y la purga va por lotes una vez al día. Si escribir la clave se
limitase a intentar la inserción, chocaría con esa fila y la petición recibiría `409
IDEMPOTENCY_KEY_IN_PROGRESS` — un conflicto con una clave que ya no protege nada, y durante
casi 24 h. Que `find` la ignore por caducada no basta: el que la escribe tiene que retirarla.

## Encargo asíncrono al almacén

### FL-RES-002: confirmar publica el encargo y deja la reserva esperando

**Given**: existe la reserva `<r1>` de FL-RES-001 en `pending`.

**When**: `POST /api/v1/reservations/{r1}/confirm`.
**Then**:
1. Status `200` y `status` = `"awaitingStock"` — **no** `confirmed`: esta operación no
   conoce el desenlace, solo deja la reserva esperándolo.
2. Se publica `StockReservationRequested` en el canal `stockEvents`, con `orderId` = `<o1>`,
   `sku` y `quantity` de la reserva.
3. El proveedor **no** recibe ninguna llamada HTTP: el encargo viaja publicado.
4. `GET /api/v1/reservations/{r1}` sigue devolviendo `awaitingStock` — es el estado en el
   que se queda si el almacén no responde nunca, y el que barre la reconciliación.

### FL-OBX-001: el canal está indisponible cuando se encarga el stock

El escenario que separa `reliability: outbox` de `best-effort`, y el único. FL-RES-002 afirma
que el evento acaba en el canal, y eso lo cumple igual un servidor que publica en línea dentro
de la operación: la diferencia solo se ve cuando el canal **no está** en el instante del
commit. La mitad que importa es la negativa.

**Given**: una reserva `<r3>` en `pending`, creada como en FL-RES-001.

**When**: se **detiene el broker** y, con él parado, se hace
`POST /api/v1/reservations/{r3}/confirm`.
**Then**:
1. La mutación responde **igual que con el canal en pie**: status `200` y `status` =
   `"awaitingStock"`. La disponibilidad del broker no es parte del contrato de la operación —
   si esta petición falla o tarda, el evento se está publicando dentro de la transacción y la
   fiabilidad que se declaró es la del broker, no la nuestra.
2. `GET /api/v1/reservations/{r3}` devuelve `awaitingStock`: el cambio de estado está
   **commiteado**, no pendiente de que el canal vuelva.
3. El canal `stockEvents` sigue **vacío**. Es la afirmación que un servidor que publica en
   línea no puede satisfacer: o habría fallado en el Then 1, o el evento estaría fuera.

**When** (segunda mitad): se vuelve a **levantar el broker** y se espera a que esté listo.
**Then**:
4. `StockReservationRequested` para `<o3>` aparece en `stockEvents` **exactamente una vez**,
   con el `orderId`, `sku` y `quantity` de la reserva. Ni cero —el encargo no se perdió con el
   canal— ni dos —el reintento del relay no duplica lo ya publicado—.

**Caso límite**: si el relay agotara sus intentos mientras el broker está parado, el evento
acabaría en dead-letter y el Then 4 fallaría por «cero». Eso no es un fallo del escenario: es
la política de reintentos declarada siendo más corta que la caída, y se arbitra como diseño.

### FL-RES-003: el almacén confirma y la reserva sale de la espera

**Given**: `<r1>` está en `awaitingStock` (FL-RES-002).

**When**: llega el evento entrante `StockReserved` con payload `{orderId: <o1>}`.
**Then**:
1. Se ejecuta `applyStockReserved`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"confirmed"` y `releaseReason` =
   `null`.
3. Es el desenlace **bueno** del encargo: sin él la reserva no saldría nunca de la espera
   por la vía normal, y el barrido acabaría rindiéndose con todas.

## Compensación: el almacén rechaza a posteriori

### FL-CMP-001: llega el rechazo y la reserva se libera

Cubre `inventory.compensations[0]` (`undoes: reserveStock`). La operación compensadora es
`releaseReservation`, interna y disparada solo por la suscripción.

**Given**: la reserva `<r1>` está en `confirmed` (FL-RES-003).

**When**: llega el evento entrante `StockRejected` con payload
`{orderId: <o1>, reason: "stock retirado por caducidad"}` y `messageId` `<m1>`.
**Then**:
1. Se ejecuta `releaseReservation`.
2. `GET /api/v1/reservations/{r1}` devuelve `status` = `"released"` y `releaseReason` con el
   motivo del evento: el estado propio vuelve, no se queda donde lo dejó un trabajo que ya
   no existe.

#### FL-CMP-001-B: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `StockRejected`, con idéntico payload y el
**mismo** `messageId` `<m1>`.
**Then**:
1. `<r1>` sigue en `released` y `releaseReason` no cambia: ningún segundo efecto.
2. El servicio **confirma** el mensaje sin volver a procesarlo — no acaba en la DLQ ni
   reintentando: una reentrega es el comportamiento normal de cualquier broker, no un fallo.
3. Es lo que garantizan las dos mitades juntas: la envoltura Keel deduplica en el listener
   por `metadata.eventId`, y la transición declarada (`from: [awaitingStock, confirmed] →
   released`) rechaza la segunda aplicación aunque el mensaje llegara por otro camino —
   `released` no está en ningún `from`. Sin este escenario, una
   implementación que compensa dos veces pasa FL-CMP-001 sin que nada lo delate.

#### FL-CMP-001-C: el mismo evento se entrega dos veces a la vez

Y esto tampoco lo prueba FL-CMP-001-B. La reentrega **secuencial** encuentra la marca de
procesado ya escrita y el agregado ya en `released`: pasa aunque nada cubra la ventana en la
que ninguna de las dos cosas ha ocurrido todavía. Con varias réplicas consumiendo del mismo
canal, esa ventana es el caso frecuente, no el raro — y es donde una compensación se aplica
dos veces de verdad.

**Given**: una reserva `<r4>` en `confirmed`, llegada ahí por el camino de FL-RES-001 →
FL-RES-002 → FL-RES-003 con su propio pedido `<o4>`.

**When**: se entregan **simultáneamente** dos copias del mismo `StockRejected`, con idéntico
payload `{orderId: <o4>, reason: "stock retirado por caducidad"}` y el **mismo** `messageId`
`<m4>`.
**Then**:
1. `GET /api/v1/reservations/{r4}` devuelve `status` = `"released"` y `releaseReason` con el
   motivo — el efecto ocurre, una vez. Que ninguna de las dos llegue a aplicarse es un fallo
   tan grave como que se apliquen las dos: una guarda que se traga el efecto completo
   convierte una compensación en un mensaje descartado.
2. El efecto es **único** en las dos superficies: el estado es `released` (y no volvió a pasar
   por ninguna transición) y el proveedor no recibió ninguna llamada de vuelta duplicada.
3. El servicio no acaba con el mensaje en la DLQ. Que la copia perdedora falle por dentro es
   correcto y esperable —es exactamente lo que hace la guarda—, pero el resultado observable
   de la perdedora es una entrega **confirmada sin efecto**, no un error propagado: una
   entrega doble simultánea es comportamiento normal de un broker at-least-once.

**Orden de evaluación**: aquí actúan tres cosas a la vez y el escenario no dice cuál gana,
solo que el resultado es uno. El registro de procesados cierra la ventana **si** se escribe
antes de que la segunda copia lo lea; la transición de lifecycle rechaza la segunda aplicación
**si** la primera ya commiteó; y el bloqueo optimista de la raíz convierte en conflicto la
escritura sobre una versión que ya cambió. Un servidor que solo tenga la primera pasa
FL-CMP-001-B y falla aquí.

## Corrección de recuento: deduplicar sin guarda de dominio

Los dos escenarios de arriba deduplican con **dos** cosas encima: el registro de procesados y
una transición de lifecycle que ya es irrepetible por sí sola. Eso los hace fáciles de pasar
por el motivo equivocado — un servidor que no deduplicara nada seguiría dando el resultado
correcto, porque `released` no sale de `released`. Este flujo quita esa red: `noteStockCount`
**no declara transiciones** y lo que escribe es un **contador**. Aplicarla dos veces se ve, y
lo único que puede impedirlo es la marca de procesado.

### FL-CNT-001: el almacén corrige el recuento del pedido

**Given**: la reserva `<r1>` existe (FL-RES-001), con `adjustmentCount` = `0` y
`lastCountedQuantity` = `null`.

**When**: llega el evento entrante `StockCountAdjusted` con payload
`{orderId: <o1>, countedQuantity: 5}` y `messageId` `<m5>`.
**Then**:
1. `GET /api/v1/reservations/{r1}` devuelve `lastCountedQuantity` = `5` y `adjustmentCount`
   = `1`.
2. El `status` **no cambia**: un recuento no es un desenlace del encargo. Sigue siendo el que
   tuviera la reserva antes.

#### FL-CNT-001-B: el mismo recuento se reentrega

**When**: se entrega **otra vez** el mismo `StockCountAdjusted`, con idéntico payload y el
**mismo** `messageId` `<m5>`.
**Then**:
1. `adjustmentCount` sigue siendo `1`. Es la afirmación entera del escenario: aquí no hay
   estado terminal que rechace la repetición ni valor que coincida por casualidad — un
   segundo procesamiento suma, y se ve.
2. `lastCountedQuantity` sigue siendo `5`.
3. El mensaje se confirma sin volver a procesarse: ni DLQ ni reintentos.

**Orden de evaluación**: sin transición detrás, la marca de procesado tiene que escribirse
**antes** de aplicar el efecto. Es el orden contrario al de la compensación, y no son
intercambiables: allí procesar primero es correcto porque un fallo transitorio se reintenta y
la repetición la frena el agregado; aquí no hay nada que la frene, así que la ventana se cierra
antes a cambio de perder el mensaje si el handler revienta. Un servidor que use el orden de la
compensación aquí pasa FL-CNT-001 y falla FL-CNT-001-B en cuanto las dos entregas se solapan.

## Clúster: dos réplicas sobre la misma base

Tres de las garantías de este diseño no dicen «esto es correcto», dicen «esto es correcto
**aunque haya varias instancias**»: el relay del outbox reclama filas con bloqueo de escritura
y `SKIP LOCKED`, el barrido corre en todas las réplicas y por eso reclama en vez de leer, y el
registro de la clave de idempotencia lo arbitra la clave primaria «aunque las dos peticiones ni
siquiera estén en el mismo proceso».

Los escenarios de arriba no las tocan. Dos hilos de la misma JVM comparten pool de conexiones,
planificador y reloj: pasan igual con un servidor que no reclamara nada. Estos tres arrancan
una **segunda instancia del servicio** —un proceso aparte, contra la misma base y el mismo
canal— y es lo único que separa la afirmación de su prueba.

**Convención**: el escenario que arranca la réplica la para en un `finally`; una réplica viva
sigue publicando y barriendo, y contaminaría los flujos siguientes.

### FL-CLU-001: dos relays del outbox no publican el mismo evento dos veces

**Given**: la segunda réplica arrancada, y **cinco** reservas en `pending` con pedidos
distintos.

**When**: se confirman las cinco, de modo que las dos réplicas encuentran cinco filas
pendientes en el outbox a la vez.
**Then**:
1. En el canal `stockEvents` hay **exactamente cinco** `StockReservationRequested`, uno por
   pedido: ni uno más. Sin reclamo, los dos relays leen el mismo lote y publican diez.
2. Los cinco `orderId` son los de las cinco reservas, sin repetidos.
3. Las cinco reservas quedan en `awaitingStock`.

**Por qué cinco y no una**: con una sola fila la ventana en que los dos relays coinciden es
tan estrecha que el escenario pasaría casi siempre por suerte. Cinco filas y dos relays con la
misma cadencia hacen que el solape sea el caso normal, no el afortunado.

### FL-CLU-002: dos barridos no cancelan el mismo encargo dos veces

**Given**: la segunda réplica arrancada, y **cinco** reservas en `awaitingStock` cuya espera se
ha llevado por encima del umbral.

**When**: pasa un tick del barrido, que corre en las **dos** réplicas.
**Then**:
1. Las cinco acaban en `released`.
2. El proveedor recibió **exactamente cinco** `DELETE /stock/reservations/{orderId}`, uno por
   pedido. Diez significaría que las dos réplicas se llevaron las mismas filas, y cada
   cancelación repetida es una llamada real a un sistema ajeno.
3. Ninguna reserva ajena al escenario se ve afectada.

**Nota sobre la idempotencia saliente**: aunque hubiera duplicados, el proveedor los absorbería
por la cabecera `Idempotency-Key` — por eso el `Then` cuenta las llamadas **recibidas** y no su
efecto. Lo que se mide aquí es el reclamo, no la red que hay debajo.

### FL-CLU-003: la misma clave, a la vez, contra dos procesos distintos

Lo que `FL-RES-001-C` no puede probar. Allí las dos peticiones salen de la misma JVM y
comparten el pool de conexiones; aquí van a **procesos distintos**, que es el caso que el
registro existe para cerrar y el que ocurre de verdad detrás de un balanceador.

**Given**: la segunda réplica arrancada, un pedido `<o7>` sin reserva y una clave `<k7>` sin
usar.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/reservations` idénticos con el mismo
`Idempotency-Key` `<k7>`, uno contra **cada** réplica.
**Then**:
1. Una de las dos responde `201`.
2. La otra responde **exactamente una** de estas dos cosas: `201` con el **mismo** `id`, o
   `409` con `code` = `IDEMPOTENCY_KEY_IN_PROGRESS`. Ni `500`, ni
   `409 RESERVATION_ALREADY_EXISTS`, ni `201` con otro `id`.
3. `<o7>` tiene **una sola** reserva.

**Lo que este escenario añade sobre FL-RES-001-C**: que el árbitro sea la base y no un candado
en memoria. Un servidor que dedujera la carrera con un `synchronized`, un `ConcurrentHashMap` o
un caché local pasaría FL-RES-001-C y fallaría aquí — y es una implementación que se escribe
sola si nadie la prueba.

## Reconciliación: el desenlace que no llega

### FL-REC-001: el almacén nunca responde y el barrido se rinde

La pata del **silencio**, y el único mecanismo de los cinco que hasta aquí no tenía forma de
observarse. No hay excepción que capturar ni evento al que reaccionar: una ausencia no produce
ningún hecho. Lo único que la ve es algo que corre solo.

**Given**: una reserva `<r5>` en `awaitingStock` con su pedido `<o5>`, llegada ahí por
FL-RES-001 → FL-RES-002, sobre la que **no** se entrega ni `StockReserved` ni `StockRejected`.
El proveedor está programado para responder `200 {cancelled: true}` a
`DELETE /stock/reservations/{orderId}`.

**When**: se retrasa `reserveStockAwaitingSince` de `<r5>` por encima del umbral de paciencia —el escenario
lo hace directamente sobre la fila, que es la única variable a su alcance: el reloj del
servicio no se toca y el umbral tampoco— y se espera a que pase un tick del barrido.
**Then**:
1. `GET /api/v1/reservations/{r5}` acaba devolviendo `status` = `"released"`. El barrido saca
   la reserva de la espera; rendirse es una decisión, no una omisión.
2. El proveedor recibió **exactamente un** `DELETE /stock/reservations/{o5}`. Rendirse no es
   solo mover el estado propio: es decírselo al almacén, que pudo bloquear el stock sin que su
   respuesta llegara nunca. Un barrido que solo cambia el estado deja stock bloqueado para
   siempre y ninguna otra cláusula lo vería.
3. Esa llamada llevaba cabecera `Idempotency-Key` no vacía. Es el **único** punto de todo el
   contrato donde la idempotencia saliente se verifica sobre el cable y no sobre el código, y
   está especialmente bien traída aquí: el barrido cancela un bloqueo del que ya no sabemos
   nada, con `retry` declarado, y una segunda cancelación por timeout de red podría anular un
   bloqueo **nuevo** del mismo pedido creado entretanto.
4. Las reservas de los demás flujos **no** se ven afectadas: solo se barre lo que lleva
   esperando más que el umbral, y el escenario solo envejeció a `<r5>`.

**Caso límite**: si el proveedor responde error, `cancelStock` declara `onFailure: ignore` y
`fallback`, así que el Then 1 se cumple igual —la reserva se libera de todos modos— y el
bloqueo huérfano queda del lado del almacén. Es lo que el diseño dice, y conviene saber que
el Then 2 no distingue por sí solo «llamé y falló» de «llamé y funcionó»: lo que afirma es
que la llamada **salió**.

**Lo que este escenario sigue sin ver**: que el barrido *reclame* las filas con una cota en
vez de leerlas enteras. Con una fila el resultado es el mismo, y montar volumen aquí mediría
la máquina, no el diseño. Eso lo cubre `infra/check-idempotency.sh` en estático, familia
`reconciliation` — los dos gates son complementarios y ninguno sustituye al otro.
