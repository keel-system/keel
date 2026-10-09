# asset-vault — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/asset-vault v1.1.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Este archivo no es un diseño real: es el escenario
> **documental transversal**. Cada flujo existe para poner a prueba, contra Mongo real, una
> pieza que hasta ahora solo se había ejercitado sobre una base relacional — la clave
> natural compuesta que atraviesa una referencia, el registro de idempotencia de petición,
> el de eventos procesados, la caché y el binario en el bucket. La **forma** del documento
> (anidamiento profundo, value objects) no se prueba aquí: eso es `inspection-reports`.

> **Los caminos caros.** `FL-OBX-001`, `FL-AST-001-D`, `FL-AST-001-E`, `FL-QUA-001-C`,
> `FL-THD-001-B`, `FL-REC-001` y los `FL-CLU-*` no describen casos de negocio distintos de
> los de arriba: describen los **mismos** casos en las condiciones bajo las que estos
> mecanismos existen — el canal caído, dos peticiones a la vez, la ventana caducada, dos
> entregas a la vez, la reentrega sin guarda de dominio, el veredicto que envejece y dos
> réplicas compitiendo. Son los únicos que distinguen un servidor que implementa la
> garantía de uno que solo la declara.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). Los instantes que estampa el servicio se verifican **por
  forma**, nunca por valor.
- **Identificadores**: `uuid` v4 canónico, verificados por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se
  omite. `labels` vacío viaja como `[]`, no como nulo.
- **Auditoría**: `audit.timestamps: all` y `audit.authorship: all`, así que el rastro lo
  estampa la infraestructura para operar y auditar, y **no viaja en ningún contrato**: ningún
  `Then` lo afirma en una respuesta (`docs/dsl/persistence.md`).
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios
  fijan solo el `code` y el status HTTP.
- **Idempotencia de petición**: `uploadAsset` declara `idempotency` con `ttlSeconds: 86400`.
  Cada request lleva un `Idempotency-Key` **uuid nuevo**, salvo en el escenario que prueba
  la deduplicación, que repite el anterior a propósito.
- **Proveedores de prueba**: `scanner` y `rendering` son WireMock. Cada flujo programa sus
  respuestas y cuenta las llamadas recibidas; el arnés lo resetea entre flujos.
- **Subida**: `uploadAsset` es `multipart/form-data` — el binario en la parte `binary` y el
  resto de campos en las suyas. **Cada subida lleva un binario distinto** (su contenido cambia
  en al menos un byte) salvo que el escenario diga que repite uno: el `checksum` es único, y dos
  subidas con el mismo binario chocan por él antes que por cualquier otra cosa.
- **Propietarios**: se siembran en la base antes de cada flujo (`ACME` y `OTRO`); el servicio no
  los crea.
- **Credenciales**: salvo que se diga otra cosa, las peticiones las hace un custodio `vault-admin`
  (exento del alcance). Los escenarios del alcance usan un `vault-reader` con el claim `vaults`
  que dicen, y el cliente máquina es `rendering-service`.
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
- **Identidad del mensaje entrante**, y son **dos** contratos distintos que no se pueden
  confundir. `MalwareDetected` llega con envoltura Keel: su identidad es `metadata.eventId`,
  dentro del cuerpo. `ThumbnailDelivered` llega **plano** desde un sistema que no es Keel: su
  identidad es la cabecera nativa `X-Render-Event-Id` (header de Kafka, atributo de SQS,
  property de AMQP — nunca una cabecera HTTP). El escenario que reentrega repite el dato que
  corresponda a **su** contrato; repetir el otro no probaría nada.
- **Reconciliación**: la frecuencia del barrido (cada minuto) y su umbral de paciencia son
  cosas distintas, y el escenario solo toca la antigüedad de la marca —envejece
  `lastScannedAt` directamente en la base—. No se acorta el umbral: eso pondría a todos los
  demás flujos bajo el barrido y mediría un servicio que nadie opera.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| uploadAsset | FL-AST-001, FL-AST-001-B, FL-AST-001-C, **FL-AST-001-D**, **FL-AST-001-E**, FL-AST-001-F, FL-AST-001-G, FL-AST-001-H, FL-AST-001-I | usuarios (multipart) |
| getAsset | FL-AST-003, FL-AST-003-B, FL-AST-003-C, FL-AST-003-D, FL-AST-003-E | usuarios y clientes máquina |
| listAssets | FL-AST-004, FL-AST-004-B | usuarios |
| publishAsset | FL-AST-002, FL-AST-002-B, FL-AST-002-C, **FL-AST-002-D**, FL-AST-002-E, **FL-OBX-001** | usuarios |
| quarantineAsset | FL-QUA-001, FL-QUA-001-B, **FL-QUA-001-C** | suscripción (interna) |
| noteThumbnailDelivery | **FL-THD-001**, **FL-THD-001-B** | suscripción (interna, fuente ajena) |
| reconcileScans | **FL-REC-001**, **FL-REC-001-B** | programada; alcanzable envejeciendo la marca del último veredicto |
| **clúster (2 réplicas)** | **FL-CLU-001**, **FL-CLU-002**, **FL-CLU-003** | outbox, barrido e idempotencia, arbitrados entre procesos |

Y la misma matriz leída por **mecanismo**, que es como se decide si falta algo:

| Mecanismo | Camino feliz | Camino caro |
|---|---|---|
| Idempotencia de petición (`idempotency_record`) | FL-AST-001-B (reintento secuencial) | **FL-AST-001-D** (carrera) · **FL-AST-001-E** (la ventana caduca) |
| Idempotencia de consumo, con guarda de dominio (`alreadyProcessed`+`record`, clave en la envoltura) | FL-QUA-001-B (reentrega) | **FL-QUA-001-C** (doble entrega simultánea) |
| Idempotencia de consumo, **sin** guarda de dominio (`tryRecord`, clave en cabecera nativa) | FL-THD-001 | **FL-THD-001-B** (reentrega contra un contador) |
| Idempotencia saliente (`OutboundIdempotency`) | — | **FL-AST-002** Then 3 (la cabecera en el cable) |
| Outbox | FL-AST-002 (el evento sale) | **FL-OBX-001** (el canal no está) |
| Compensación con llamada de vuelta | FL-QUA-001 (la miniatura se retira) | **FL-QUA-001-C** (sin retirada duplicada) |
| Reconciliación | — | **FL-REC-001** · **FL-REC-001-B** (la amenaza la resuelve el barrido) |
| Arbitraje ENTRE réplicas | — | **FL-CLU-001** (relay) · **FL-CLU-002** (barrido) · **FL-CLU-003** (clave) |

`reconcileScans` **ya no es un hueco declarado**. Seguía sin flujo no por falta de efecto
observable —lo tiene: vuelve a pedir el análisis del binario, y eso llega al proveedor de
prueba— sino porque un cron no se alcanza desde fuera. Lo que lo desbloquea no es acortar el
umbral hasta que quepa en una prueba, que sería medir un servicio distinto del que se opera:
es que el umbral de paciencia y la frecuencia del barrido son **dos cosas separadas**, y solo
la segunda tiene que ser corta. El escenario mueve la única variable que le queda al arnés
—la antigüedad de `lastScannedAt`— y espera un tick. `infra/check-idempotency.sh` sigue
cubriéndolo en estático, que es lo que verifica lo que el `Then` no puede ver (que el barrido
*reclame* con cota en vez de leer).

## Custodia del archivo

### FL-AST-001: se custodia un archivo

**Given**: existe el propietario `<o1>` con `code` = `"ACME"`.

**When**: `POST /api/v1/assets` (multipart) con `ownerId` = `<o1>`, `slug` = `"informe-q1"`,
`title` = `"Informe Q1"`, `labels` = `["finanzas", "2026"]` y un binario PDF, con un
`Idempotency-Key` propio `<k1>`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `slug` = `"informe-q1"`, `status` = `"draft"`,
   `labels` con los dos valores en el orden enviado, y `owner` resuelto con su
   `code`.
3. `thumbnailDeliveryCount` = `0` y `lastDeliveredAt` = `null`: nadie ha servido todavía su
   miniatura.
4. `GET /api/v1/assets/{id}` devuelve el mismo archivo con `ownerId` = `<o1>`.

#### FL-AST-001-B: el cliente reintenta con la misma clave

**When**: se repite **exactamente** el mismo `POST` con el **mismo** `Idempotency-Key` `<k1>`.
**Then**:
1. La respuesta es la **misma** que la primera vez, con el **mismo** `id`: la repetición
   reproduce el resultado, no vuelve a custodiar.
2. `GET /api/v1/assets` sigue devolviendo **un solo** archivo para `<o1>`.

#### FL-AST-001-C: otro intento con el mismo propietario y el mismo nombre

**When**: `POST /api/v1/assets` con el **mismo** `ownerId` y el **mismo** `slug`, otro
binario y un `Idempotency-Key` **nuevo**.
**Then**:
1. Status `409` con `code` = `"ASSET_OWNER_SLUG_ALREADY_EXISTS"`.
2. Es la clave natural compuesta la que lo impide: `[owner_id, slug]`. Sin la traducción
   del índice único (`uk_assets_natural`) a este error, la respuesta sería un `500`.

#### FL-AST-001-D: dos subidas con la misma clave, a la vez

La carrera de la clave de idempotencia de `uploadAsset`, y lo que FL-AST-001-B **no**
prueba. El reintento secuencial llega cuando el registro de la
clave ya está commiteado y lo resuelve una lectura: pasa aunque nada arbitre la ventana
anterior al commit — que es justo la que golpea un cliente con reintentos automáticos, o dos
réplicas del mismo cliente. Y con una subida la ventana es ancha de verdad: el binario tarda
en viajar, así que las dos peticiones se solapan sin esfuerzo.

**Given**: el propietario `<o1>`, un `slug` `"acta-2"` sin usar y una clave `<k2>` sin usar.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/assets` idénticos —mismo
`ownerId`, mismo `slug`, mismo binario— con el **mismo** `Idempotency-Key` `<k2>`.
**Then**:
1. Una de las dos responde `201`.
2. La otra responde **exactamente una** de estas dos cosas, y ninguna otra: `201` con el
   **mismo** `id` y el mismo cuerpo, o `409` con `code` = `IDEMPOTENCY_KEY_IN_PROGRESS`. Las
   dos son correctas porque son las dos formas legítimas de resolver la carrera —esperar al
   resultado o rebotar al que llega segundo—; lo que no es correcto es un `500`, un `409
   ASSET_OWNER_SLUG_ALREADY_EXISTS` (que acusa al nombre de un problema que es de la clave)
   ni un `201` con un `id` distinto.
3. `<o1>` tiene **un solo** archivo con `slug` = `"acta-2"`: `GET /api/v1/assets` lo
   devuelve una vez, y un `POST` posterior con el mismo `slug` y otra clave devuelve
   `409 ASSET_OWNER_SLUG_ALREADY_EXISTS`. El conteo es la mitad que de verdad cierra el
   escenario: sin él, dos `201` con ids distintos pasarían el Then 2.

**Orden de evaluación**: la clave de idempotencia se arbitra **antes** que la unicidad del
nombre. Si el `409` que sale es `ASSET_OWNER_SLUG_ALREADY_EXISTS`, el registro de la clave no
está mediando y lo que deduplica es el índice único de la base — que funciona aquí por
accidente y no funcionaría en una operación sin clave natural.

#### FL-AST-001-E: la clave vuelve a servir cuando su ventana ha pasado

`idempotency` declara `ttlSeconds: 86400`: pasada esa ventana la clave deja de identificar
nada y vuelve a estar libre. La deduplicación es una promesa **acotada en el tiempo**, y el
diseño fija cuánto dura; si en la práctica durase más —hasta que algo barra el registro— la
ventana la fijaría la purga y no el diseño, que es justo lo que el campo compra. Con
`86400` no se alcanza esperando: el escenario **envejece el registro**, que es la misma
palanca con la que FL-REC-001 mueve `lastScannedAt`.

**Given**: el archivo de FL-AST-001, custodiado con la clave `<k1>`, cuyo registro de
idempotencia se lleva **más allá de su caducidad** (el escenario envejece `expires_at`
directamente sobre el documento: esperar un día no es una prueba).

**When**: se hace un `POST /api/v1/assets` con un `slug` **nuevo** `"plan-2027"` y la clave
`<k1>` **reutilizada**.
**Then**:
1. Status `201`: la petición se ejecuta. No es una repetición — la clave está libre.
2. El cuerpo trae un `id` **distinto** del de FL-AST-001 y `slug` = `"plan-2027"`.
3. El archivo original sigue existiendo y sin cambios.

**Caso límite que este escenario cierra**: el registro caducado **sigue en la colección**
hasta que la purga lo retire, y la purga va por lotes una vez al día. Si escribir la clave se
limitase a intentar la inserción, chocaría con ese documento y la petición recibiría `409
IDEMPOTENCY_KEY_IN_PROGRESS` — un conflicto con una clave que ya no protege nada, y durante
casi 24 h. Que `find` la ignore por caducada no basta: el que la escribe tiene que retirarla.

#### FL-AST-001-F: el mismo binario con otro nombre

**Given**: el archivo de FL-AST-001 custodiado con su binario PDF.

**When**: `POST /api/v1/assets` con el mismo `ownerId`, un `slug` **nuevo** `"informe-q1-copia"`, el
**mismo** binario y un `Idempotency-Key` nuevo.
**Then**:
1. Status `409` con `code` = `"ASSET_CHECKSUM_ALREADY_EXISTS"`: la huella identifica el contenido con
   independencia del nombre, y ese contenido ya está custodiado.
2. `GET /api/v1/assets` sigue devolviendo un solo archivo con ese binario.

#### FL-AST-001-G: el propietario no existe

**When**: `POST /api/v1/assets` con un `ownerId` que no es de ningún propietario sembrado, `slug` =
`"huerfano"` y un binario nuevo.
**Then**:
1. Status `422` con `code` = `"OWNER_NOT_FOUND"`.
2. No se custodió nada: `GET /api/v1/assets` no trae ningún archivo con `slug` = `"huerfano"`, y no
   sale ningún `AssetUploaded`.

#### FL-AST-001-H: un ejecutable con la etiqueta de una imagen

**When**: `POST /api/v1/assets` con `slug` = `"logo"` y como `binary` un ejecutable (empieza por
`MZ`) enviado como `image/png`.
**Then**:
1. Status `415` con `code` = `"UNSUPPORTED_CONTENT_TYPE"`: el tipo declarado está admitido, pero el
   contenido no es de ese tipo.
2. No se custodió nada con `slug` = `"logo"`.

#### FL-AST-001-I: un binario de más de 25 MB

**When**: `POST /api/v1/assets` con `slug` = `"grande"` y un PDF de 26 MB.
**Then**:
1. Status `413` con `code` = `"FILE_TOO_LARGE"`: el límite es el `maxSizeMb` del bucket.
2. No se custodió nada con `slug` = `"grande"`.

## Publicación

### FL-AST-002: publicar exige veredicto del escáner

**Given**: el archivo `<a1>` de FL-AST-001 está en `draft`, y su ficha está cacheada: se pidió `GET /api/v1/assets/{a1}` con `rendering.getThumbnail`
respondiendo `200 {url: "https://cdn/t/a1.png", width: 320}`, y devolvió `draft`.
`scanner.scanAsset` responde `200 {verdict: "clean", scannedAt: <t>}`.

**When**: `POST /api/v1/assets/{a1}/publish`.
**Then**:
1. Status `200` y `status` = `"published"`.
2. El proveedor recibió **exactamente una** llamada a `POST /scans`, con `assetId` = `<a1>`
   y el `storageKey` del binario custodiado.
3. Esa llamada llevaba cabecera `Idempotency-Key`: es lo que impide que un reintento nuestro
   encargue dos análisis del mismo binario.
4. `GET /api/v1/assets/{a1}` devuelve `published`: la respuesta cacheada de antes de
   publicar **no** sobrevive, porque `AssetPublished` la invalida.
5. La ficha trae `lastScannedAt` estampado (por forma): publicar fija la marca del veredicto,
   que es la que vigila después `reconcileScans`.

#### FL-AST-002-E: el escáner no da el binario por limpio

**Given**: un archivo `<a7>` en `draft`, custodiado como en FL-AST-001 con su propio `slug`;
`scanner.scanAsset` responde `200 {verdict: "infected", scannedAt: <t>}`.

**When**: `POST /api/v1/assets/{a7}/publish`.
**Then**:
1. Status `422` con `code` = `"ASSET_NOT_CLEAN"`.
2. `<a7>` sigue en `draft` y no sale ningún `AssetPublished` para él.

#### FL-AST-002-B: el escáner no responde

**Given**: existe otro archivo `<a2>` en `draft`; `scanner.scanAsset` devuelve `503`.

**When**: `POST /api/v1/assets/{a2}/publish`.
**Then**:
1. Status `502` con `code` = `"SCANNER_UNAVAILABLE"`.
2. `<a2>` sigue en `draft`: sin veredicto no hay publicación (`onFailure: fail`).
3. No se publicó ningún `AssetPublished`.

#### FL-AST-002-C: publicar lo que ya está publicado

**Given**: `<a1>` está en `published` (FL-AST-002).

**When**: `POST /api/v1/assets/{a1}/publish` otra vez.
**Then**:
1. Status `422` con `code` = `"INVALID_ASSET_STATE"`: de `published` no se vuelve a `published`.
2. El escáner **no** recibió una segunda llamada: la transición se comprueba antes de encargar nada.

#### FL-AST-002-D: dos publicaciones del mismo archivo a la vez

**Given**: un archivo `<a6>` en `draft`, custodiado como en FL-AST-001 con su propio `slug`;
`scanner.scanAsset` responde `200 {verdict: "clean", scannedAt: <t>}`.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/assets/{a6}/publish`.
**Then**:
1. Una responde `200` con `status` = `"published"`.
2. La otra responde **exactamente una** de estas dos cosas: `409` con `code` =
   `"CONCURRENT_MODIFICATION"` (perdió la carrera sobre la versión del archivo) o `422` con `code` =
   `"INVALID_ASSET_STATE"` (llegó cuando la primera ya había confirmado). Ni `500` ni un segundo `200`.
3. Sale **exactamente un** `AssetPublished` para `<a6>`: la publicación ocurrió una vez.

## Publicación con el canal caído

### FL-OBX-001: el canal está indisponible cuando se publica

El escenario que separa `reliability: outbox` de `best-effort`, y el único. Que `AssetPublished`
acabe en el canal lo cumple igual un servidor que publica en línea dentro de la operación: la
diferencia solo se ve cuando el canal **no está** en el instante del commit. La mitad que importa
es la negativa.

Se hace sobre `publishAsset` y no sobre `uploadAsset` a propósito: lo que se mide es el canal, y
la subida arrastra el almacenamiento al escenario, que añade una causa de fallo ajena a lo que se
prueba.

**Given**: un archivo `<a3>` en `draft`, custodiado como en FL-AST-001; `scanner.scanAsset`
responde `200 {verdict: "clean", scannedAt: <t>}`.

**When**: se **detiene el broker** y, con él parado, `POST /api/v1/assets/{a3}/publish`.
**Then**:
1. La mutación responde **igual que con el canal en pie**: status `200` y `status` =
   `"published"`. La disponibilidad del broker no es parte del contrato de la operación — si esta
   petición falla o tarda, el evento se está publicando dentro de la transacción y la fiabilidad
   que se declaró es la del broker, no la nuestra.
2. `GET /api/v1/assets/{a3}` devuelve `published`: el cambio de estado está **commiteado**, no
   pendiente de que el canal vuelva.
3. El canal del servicio sigue **vacío**. Es la afirmación que un servidor que publica en línea no
   puede satisfacer: o habría fallado en el Then 1, o el evento estaría fuera.
4. El escáner recibió su llamada con normalidad: que el canal esté caído no cancela el trabajo
   que la operación encarga por HTTP, que no pasa por el outbox.

**When** (segunda mitad): se vuelve a **levantar el broker** y se espera a que esté listo.
**Then**:
5. `AssetPublished` para `<a3>` aparece en el canal **exactamente una vez**, con el `assetId` y
   `status` = `"published"`. Ni cero —la publicación no se perdió con el canal— ni dos —el
   reintento del relay no duplica lo ya publicado—.

**Notas de determinación**: `<a3>` es propio de este flujo y el Then 5 se acota a **ese**
`assetId`; FL-AST-002 publica el mismo evento para otro archivo, así que un «exactamente una vez»
sin acotar mediría otra cosa.

**Caso límite**: si el relay agotara sus intentos mientras el broker está parado, el evento
acabaría en dead-letter y el Then 5 fallaría por «cero». Eso no es un fallo del escenario: es la
política de reintentos declarada siendo más corta que la caída, y se arbitra como diseño.

## Consulta

### FL-AST-003: la ficha se pide al servicio de renderizado

**Given**: `<a1>` está publicado; `rendering.getThumbnail` responde
`200 {url: "https://cdn/t/a1.png", width: 320}`.

**When**: `GET /api/v1/assets/{a1}`.
**Then**:
1. Status `200` con el archivo y su `ownerId` plano (esta operación **no** lleva `embed`).
2. El proveedor recibió una llamada a `GET /thumbnails/{a1}`.
3. La ficha trae `thumbnail` = `{url: "https://cdn/t/a1.png", width: 320}`: la miniatura que se pidió
   viaja en la respuesta (`exposedAs: thumbnail`), que es para lo que se pide.

#### FL-AST-003-B: el servicio de renderizado cae

**Given**: `rendering.getThumbnail` devuelve `503`.

**When**: se vacía la caché (`clearCache()` del arnés) y se pide `GET /api/v1/assets/{a1}`.
**Then**:
1. Status `200` igualmente: la miniatura es un adorno de la ficha, no la ficha
   (`onUnavailable: degrade` del need `rendering.thumbnail`).
2. La ficha llega completa con `thumbnail` = `null`: el campo viaja, nulo, y así el consumidor sabe
   que no hay miniatura.
3. La ficha degradada no se queda servida (`getAsset` no la cachea): se vuelve a programar
   `rendering.getThumbnail` con `200 {url: "https://cdn/t/a1.png", width: 320}` y el siguiente
   `GET /api/v1/assets/{a1}` trae otra vez la miniatura, dentro de los 300 s del TTL.

#### FL-AST-003-E: el renderizador lee cualquier ficha

**When**: el cliente máquina `rendering-service` pide `GET /api/v1/assets/{a1}` con su token
(sin claim `vaults`).
**Then**:
1. Status `200` con la ficha: el alcance es de los custodios, y el renderizador genera las
   miniaturas de todos los propietarios.

#### FL-AST-003-C: un archivo que no existe

**When**: `GET /api/v1/assets/{id}` con un `id` que no es de ningún archivo.
**Then**:
1. Status `404` con `code` = `"ASSET_NOT_FOUND"`.
2. El renderizador **no** recibió ninguna llamada por ese `id`: no se pide la miniatura de algo que no
   existe.

#### FL-AST-003-D: un archivo de un propietario fuera del alcance

**Given**: un custodio con rol `vault-reader` cuyo token enumera `vaults` = `["OTRO"]`; `<a1>` es de
`ACME`, y su ficha está cacheada: un `vault-admin` acaba de pedir `GET /api/v1/assets/{a1}` con
`rendering.getThumbnail` respondiendo `200 {url: "https://cdn/t/a1.png", width: 320}`.

**When**: ese custodio pide `GET /api/v1/assets/{a1}`.
**Then**:
1. Status `403` con `code` = `"ASSET_OUT_OF_SCOPE"`.
2. Ni la ficha cacheada se le sirve: el alcance se comprueba en cada respuesta, también en la que sale
   de la caché (la del `Given`).

### FL-AST-004: el listado va ordenado y trae el propietario

**Given**: `<o1>` custodia tres archivos con `slug` `"acta"`, `"informe-q1"` y `"plan"`.

**When**: `GET /api/v1/assets?page=0&size=2`.
**Then**:
1. Status `200`, dos elementos, y el orden es por `slug` ascendente: `"acta"` primero.
2. Cada elemento trae `owner` resuelto (`embed: [owner]`) con su `code` y su `displayName`.
3. `GET /api/v1/assets?page=1&size=2` devuelve el tercero y **ninguno repetido**: el
   desempate por id lo añade el adaptador aunque el orden declarado no lo pida.

#### FL-AST-004-B: el listado se acota al alcance

**Given**: los tres archivos de `ACME` de FL-AST-004 y un custodio `vault-reader` cuyo token
enumera `vaults` = `["OTRO"]`.

**When**: ese custodio pide `GET /api/v1/assets?page=0&size=20`.
**Then**:
1. Status `200` y **ningún** archivo de `ACME` en la página: solo ve los de los propietarios que
   enumera su token.

## Cuarentena: el escáner encuentra algo después

### FL-QUA-001: llega el hallazgo, el archivo se pone en cuarentena y su miniatura se retira

Cubre `security-scanner.compensations[0]` (`undoes: scanAsset`). La operación compensadora
es `quarantineAsset`, interna y disparada solo por la suscripción.

**Given**: `<a1>` está en `published` (FL-AST-002), y su ficha está cacheada: se pidió `GET /api/v1/assets/{a1}` con `rendering.getThumbnail`
respondiendo `200 {url: "https://cdn/t/a1.png", width: 320}`, y devolvió `published`.
`rendering.purgeThumbnail` responde `204`.

**When**: llega el evento entrante `MalwareDetected` con payload
`{assetId: <a1>, reason: "firma conocida en el binario"}` y `metadata.eventId` `<m1>`.
**Then**:
1. Se ejecuta `quarantineAsset`.
2. `GET /api/v1/assets/{a1}` devuelve `status` = `"quarantined"` y `quarantineReason` =
   `"firma conocida en el binario"`, aunque la ficha estaba cacheada: `AssetQuarantined` la invalida.
3. El proveedor recibió **exactamente un** `DELETE /thumbnails/{a1}`. Es la mitad de la
   compensación que vive **fuera**: sin ella el renderizador sigue sirviendo la miniatura de
   un binario infectado, y deshacer a medias deja al proveedor y a nosotros contando
   historias distintas. Un servidor que solo mueva el estado propio pasa el Then 2 y falla
   aquí.
4. En el canal del servicio sale **exactamente un** `AssetQuarantined` con `assetId` = `<a1>` y
   `reason` = `"firma conocida en el binario"`: quien supo por `AssetPublished` que el archivo
   se podía servir se entera de que ya no.

#### FL-QUA-001-B: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `MalwareDetected`, con idéntico payload y el
**mismo** `metadata.eventId` `<m1>`.
**Then**:
1. `<a1>` sigue en `quarantined` y nada más cambia: ningún segundo efecto, ni un segundo
   `AssetQuarantined`.
2. El proveedor **no** recibió un segundo `DELETE /thumbnails/{a1}`: sigue habiendo uno.
3. El servicio **confirma** el mensaje sin volver a procesarlo — no acaba en la DLQ ni
   reintentando: una reentrega es el comportamiento normal de cualquier broker.
4. Lo garantizan las dos mitades juntas: la envoltura Keel deduplica en el listener por
   `metadata.eventId` (colección `processed_event`), y la transición declarada rechaza la
   segunda aplicación aunque el mensaje llegara por otro camino — de `quarantined` no sale
   ninguna transición.

#### FL-QUA-001-C: el mismo evento se entrega dos veces a la vez

Y esto tampoco lo prueba FL-QUA-001-B. La reentrega **secuencial** encuentra la marca de
procesado ya escrita y el archivo ya en `quarantined`: pasa aunque nada cubra la ventana en
la que ninguna de las dos cosas ha ocurrido todavía. Con varias réplicas consumiendo del
mismo canal, esa ventana es el caso frecuente, no el raro — y es donde una compensación se
aplica dos veces de verdad.

**Given**: un archivo `<a4>` en `published`, llegado ahí por el camino de FL-AST-001 →
FL-AST-002 con su propio `slug`; `rendering.purgeThumbnail` responde `204`.

**When**: se entregan **simultáneamente** dos copias del mismo `MalwareDetected`, con
idéntico payload `{assetId: <a4>, reason: "firma conocida en el binario"}` y el **mismo**
`metadata.eventId` `<m4>`.
**Then**:
1. `GET /api/v1/assets/{a4}` devuelve `status` = `"quarantined"` — el efecto ocurre, una
   vez. Que ninguna de las dos llegue a aplicarse es un fallo tan grave como que se apliquen
   las dos: una guarda que se traga el efecto completo convierte una compensación en un
   mensaje descartado.
2. El efecto es **único** en las dos superficies: el estado es `quarantined` (y no volvió a
   pasar por ninguna transición) y el proveedor recibió **exactamente un**
   `DELETE /thumbnails/{a4}`. Una retirada duplicada es una llamada real a un sistema ajeno:
   la retirada se encarga **después** de confirmar la cuarentena, así que la copia que pierde
   la carrera no llega al renderizador — por eso lo que se cuenta son las llamadas
   **recibidas** y no su efecto. Y sale **exactamente un** `AssetQuarantined` con `assetId` =
   `<a4>`.
3. El servicio no acaba con el mensaje en la DLQ. Que la copia perdedora falle por dentro es
   correcto y esperable —es exactamente lo que hace la guarda—, pero el resultado observable
   de la perdedora es una entrega **confirmada sin efecto**, no un error propagado: una
   entrega doble simultánea es comportamiento normal de un broker at-least-once.

**Orden de evaluación**: aquí actúan tres cosas a la vez y el escenario no dice cuál gana,
solo que el resultado es uno. El registro de procesados cierra la ventana **si** se escribe
antes de que la segunda copia lo lea; la transición de lifecycle rechaza la segunda
aplicación **si** la primera ya commiteó; y el bloqueo optimista de la raíz
(`optimisticLocking: all`) convierte en conflicto la escritura sobre una versión que ya
cambió. Un servidor que solo tenga la primera pasa FL-QUA-001-B y falla aquí.

## Telemetría del renderizador: deduplicar sin guarda de dominio y sin envoltura

Los dos escenarios de arriba deduplican con **dos** cosas encima: el registro de procesados y
una transición de lifecycle que ya es irrepetible por sí sola. Eso los hace fáciles de pasar
por el motivo equivocado — un servidor que no deduplicara nada seguiría dando el resultado
correcto, porque `quarantined` no sale de `quarantined`. Este flujo quita esa red por partida
doble: `noteThumbnailDelivery` **no declara transiciones** y lo que escribe es un
**contador**; y el mensaje llega **sin envoltura Keel**, así que la clave de deduplicación no
es `metadata.eventId` sino la cabecera nativa que la fuente estampa. Aplicar la operación dos
veces se ve, y lo único que puede impedirlo es la marca de procesado leída del sitio correcto.

### FL-THD-001: el renderizador comunica que sirvió la miniatura

**Given**: el archivo `<a1>` existe (FL-AST-001), y su ficha está cacheada: se pidió `GET /api/v1/assets/{a1}` con `rendering.getThumbnail`
respondiendo `200 {url: "https://cdn/t/a1.png", width: 320}`, y devolvió `thumbnailDeliveryCount` = `0` y
`lastDeliveredAt` = `null`.

**When**: llega el evento entrante `ThumbnailDelivered` **plano** (sin envoltura) con cuerpo
`{assetId: <a1>, deliveredAt: <t5>}` y la cabecera `X-Render-Event-Id` = `<m5>`.
**Then**:
1. `GET /api/v1/assets/{a1}` devuelve `thumbnailDeliveryCount` = `1` y `lastDeliveredAt` =
   `<t5>`. La ficha está cacheada y el contador viaja en ella, así que este `Then` también
   afirma que la caché la invalida un evento **consumido** (`ThumbnailDelivered`): sin eso la
   respuesta seguiría diciendo `0` durante cinco minutos y el escenario mediría la caché en
   vez del contador.
2. El `status` **no cambia**: servir una miniatura no es un desenlace de nada. Sigue siendo
   el que tuviera el archivo antes.

#### FL-THD-001-B: la misma entrega se reentrega

**When**: se entrega **otra vez** el mismo `ThumbnailDelivered`, con idéntico cuerpo y la
**misma** cabecera `X-Render-Event-Id` = `<m5>`.
**Then**:
1. `thumbnailDeliveryCount` sigue siendo `1`. Es la afirmación entera del escenario: aquí no
   hay estado terminal que rechace la repetición ni valor que coincida por casualidad — un
   segundo procesamiento suma, y se ve.
2. `lastDeliveredAt` sigue siendo `<t5>`.
3. El mensaje se confirma sin volver a procesarse: no acaba en la DLQ.
4. Y se comprueba que la clave que deduplica es **la cabecera**: una tercera entrega con el
   mismo cuerpo y una cabecera `X-Render-Event-Id` **distinta** sí suma
   (`thumbnailDeliveryCount` = `2`). Sin este contraste, un servidor que dedujera la
   identidad del cuerpo —o que no dedujera nada y se apoyara en una coincidencia— pasaría
   los tres primeros `Then`.

**Orden de evaluación**: sin transición detrás, la marca de procesado tiene que escribirse
**antes** de aplicar el efecto. Es el orden contrario al de la compensación, y no son
intercambiables: allí procesar primero es correcto porque un fallo transitorio se reintenta y
la repetición la frena el agregado; aquí no hay nada que la frene, así que la ventana se
cierra antes a cambio de perder el mensaje si el handler revienta. Un servidor que use el
orden de la compensación aquí pasa FL-THD-001 y falla FL-THD-001-B en cuanto las dos entregas
se solapan.

**Fuente ajena**: el listener de este canal no puede suponer nada de lo que suponen los
otros. No hay `metadata`, no hay `eventType` que discrimine y no hay `eventId` en el cuerpo;
lo que hay es un JSON plano y una cabecera del transporte. Un servidor que aplique aquí el
mismo desenvuelto que a `MalwareDetected` falla al deserializar, o —peor— cuela campos a null
y procesa un evento que no era el suyo.

## Clúster: dos réplicas sobre la misma base

Tres de las garantías de este diseño no dicen «esto es correcto», dicen «esto es correcto
**aunque haya varias instancias**»: el relay del outbox reclama documentos con `findAndModify`
y un reclamo caducable, el barrido corre en todas las réplicas y por eso reclama en vez de
leer, y el registro de la clave de idempotencia lo arbitra la clave primaria «aunque las dos
peticiones ni siquiera estén en el mismo proceso».

Los escenarios de arriba no las tocan. Dos hilos de la misma JVM comparten pool de
conexiones, planificador y reloj: pasan igual con un servidor que no reclamara nada. Estos
tres arrancan una **segunda instancia del servicio** —un proceso aparte, contra la misma base
y el mismo canal— y es lo único que separa la afirmación de su prueba.

**Convención**: el escenario que arranca la réplica la para en un `finally`; una réplica viva
sigue publicando y barriendo, y contaminaría los flujos siguientes.

### FL-CLU-001: dos relays del outbox no publican el mismo evento dos veces

**Given**: la segunda réplica arrancada, **cinco** archivos en `draft` con `slug` distintos y
`scanner.scanAsset` respondiendo `200 {verdict: "clean", scannedAt: <t>}`.

**When**: se publican los cinco, de modo que las dos réplicas encuentran cinco documentos
pendientes en el outbox a la vez.
**Then**:
1. En el canal del servicio hay **exactamente cinco** `AssetPublished`, uno por archivo: ni
   uno más. Sin reclamo, los dos relays leen el mismo lote y publican diez.
2. Los cinco `assetId` son los de los cinco archivos, sin repetidos.
3. Los cinco quedan en `published`.

**Por qué cinco y no uno**: con un solo documento la ventana en que los dos relays coinciden
es tan estrecha que el escenario pasaría casi siempre por suerte. Cinco documentos y dos
relays con la misma cadencia hacen que el solape sea el caso normal, no el afortunado.

**Propio de la rama documental**: aquí el relay no bloquea la fila, la **marca**
(`claimed_at`) con una caducidad. Una réplica que muera con documentos reclamados los
retendría hasta que esa caducidad pase, y es el parámetro que fija la ventana en la que las
dos pueden entregar el mismo. El escenario no lo mide; lo que mide es que el reclamo exista.

### FL-CLU-002: dos barridos no reencargan el mismo análisis dos veces

El barrido es `reconcileScans`, y corre en las dos réplicas a la vez.

**Given**: la segunda réplica arrancada, **cinco** archivos en `published` cuyo
`lastScannedAt` se ha envejecido por encima del umbral, y un sexto `<a6x>` en `published` sin
envejecer. `scanner.scanAsset` responde
`200 {verdict: "clean", scannedAt: <t>}`.

**When**: pasa un tick del barrido, que corre en las **dos** réplicas.
**Then**:
1. Desde el envejecimiento, el proveedor recibió **exactamente cinco** `POST /scans`, uno por
   archivo (las cinco de la publicación del `Given` no cuentan). Diez
   significaría que las dos réplicas se llevaron los mismos documentos, y cada análisis
   repetido es trabajo real encargado a un sistema ajeno.
2. Los cinco archivos quedan con `lastScannedAt` renovado en el listado (`GET /api/v1/assets`,
   que no se cachea): el barrido no solo pregunta, apunta que preguntó — si no, la pasada
   siguiente vuelve a llevárselos.
3. El sexto archivo no recibió ningún `POST /scans` desde el envejecimiento y su `lastScannedAt`
   no cambió.

**Nota sobre la idempotencia saliente**: aunque hubiera duplicados, el proveedor los
absorbería por la cabecera `Idempotency-Key` que `scanAsset` declara — por eso el `Then`
cuenta las llamadas **recibidas** y no su efecto. Lo que se mide aquí es el reclamo, no la red
que hay debajo.

### FL-CLU-003: la misma clave, a la vez, contra dos procesos distintos

Lo que `FL-AST-001-D` no puede probar. Allí las dos peticiones salen de la misma JVM y
comparten el pool de conexiones; aquí van a **procesos distintos**, que es el caso que el
registro existe para cerrar y el que ocurre de verdad detrás de un balanceador.

**Given**: la segunda réplica arrancada, el propietario `<o1>`, un `slug` `"informe-q3"` sin
usar y una clave `<k7>` sin usar.

**When**: se lanzan **simultáneamente** dos `POST /api/v1/assets` idénticos con el mismo
`Idempotency-Key` `<k7>`, uno contra **cada** réplica.
**Then**:
1. Una de las dos responde `201`.
2. La otra responde **exactamente una** de estas dos cosas: `201` con el **mismo** `id`, o
   `409` con `code` = `IDEMPOTENCY_KEY_IN_PROGRESS`. Ni `500`, ni
   `409 ASSET_OWNER_SLUG_ALREADY_EXISTS`, ni `201` con otro `id`.
3. `<o1>` tiene **un solo** archivo con ese `slug`.

**Lo que este escenario añade sobre FL-AST-001-D**: que el árbitro sea la base y no un candado
en memoria. Un servidor que resolviera la carrera con un `synchronized`, un
`ConcurrentHashMap` o una caché local pasaría FL-AST-001-D y fallaría aquí — y es una
implementación que se escribe sola si nadie la prueba.

## Reconciliación: el veredicto que envejece

### FL-REC-001: el escáner no vuelve a decir nada y el barrido revalida

Lo hace `reconcileScans` cuando la marca del último veredicto está envejecida más allá de
`unansweredAfterSeconds`: la espera del escáner lleva demasiado tiempo sin desenlace.

La pata del **silencio**, en su variante de **deriva**. No hay excepción que capturar ni
evento al que reaccionar: el escáner dio su veredicto en el acto y puede encontrar la amenaza
más tarde sin publicarla nunca. Lo que envejece aquí no es un encargo sin desenlace sino una
**creencia**, y lo único que la ve es algo que corre solo.

**Given**: dos archivos en `published`, `<a5>` y `<a9>`, llegados ahí por FL-AST-001 → FL-AST-002
con su propio `slug`, sobre los que **no** llega ningún `MalwareDetected`. `scanner.scanAsset` está programado para
responder `200 {verdict: "clean", scannedAt: <t>}`.

**When**: se envejece `lastScannedAt` de `<a5>` por encima del umbral de paciencia —el
escenario lo hace directamente sobre el documento, que es la única variable a su alcance: el
reloj del servicio no se toca y el umbral tampoco— y se espera a que pase un tick del
barrido.
**Then**:
1. El proveedor recibió **al menos un** `POST /scans` con `assetId` = `<a5>` posterior al
   envejecido. Revalidar es una decisión, no una omisión: sin el barrido, un archivo
   publicado con un veredicto de hace meses sigue publicado y nadie vuelve a preguntar.
2. El listado (`GET /api/v1/assets`, que no se cachea) acaba devolviendo `<a5>` con `lastScannedAt`
   renovado: el barrido apunta
   que preguntó. Sin eso la pasada siguiente vuelve a llevarse el mismo archivo y el trabajo
   encargado al escáner crece sin tope.
3. `<a5>` sigue en `published`: el veredicto vino limpio, así que revalidar no cambia el
   estado. Si el escáner respondiera con amenaza, el propio barrido lo pone en cuarentena: es
   FL-REC-001-B.
4. `<a9>`, que no se envejeció, **no** recibió ningún `POST /scans` posterior al envejecido de
   `<a5>` y su `lastScannedAt` en el listado no cambió: solo se barre lo que lleva sin revalidar
   más que el umbral. Un barrido que revalidara todo lo publicado fallaría aquí.

**Lo que este escenario sigue sin ver**: que el barrido *reclame* los documentos con una cota
en vez de leerlos enteros. Con un archivo el resultado es el mismo, y montar volumen aquí
mediría la máquina, no el diseño. Eso lo cubre `infra/check-idempotency.sh` en estático,
familia `reconciliation` — los dos gates son complementarios y ninguno sustituye al otro.

#### FL-REC-001-B: la revalidación encuentra una amenaza

La otra mitad de rendirse, y la que no puede esperar a que el escáner publique nada: su veredicto
ya no es limpio, y lo que tiene que pasar es la cuarentena por el mismo camino que la compensación.

**Given**: un archivo `<a8>` en `published`, llegado ahí por FL-AST-001 → FL-AST-002 con su propio
`slug`, y la marca de su último veredicto envejecida más allá del umbral (la espera lleva
demasiado tiempo sin desenlace). `scanner.scanAsset` responde
`200 {verdict: "infected", scannedAt: <t>}` y `rendering.purgeThumbnail` responde `204`.

**When**: pasa un tick de `reconcileScans`.
**Then**:
1. `GET /api/v1/assets/{a8}` acaba devolviendo `status` = `"quarantined"` con `quarantineReason` =
   `"revalidación - infected"`: el estado propio. También si la ficha estaba cacheada, porque la
   invalida `AssetQuarantined` y no el hallazgo entrante, que aquí no hay.
2. El renderizador recibió **exactamente un** `DELETE /thumbnails/{a8}`: el mensaje que sale al
   proveedor. Las dos mitades, como en FL-QUA-001.
3. Sale **exactamente un** `AssetQuarantined` con `assetId` = `<a8>`.
