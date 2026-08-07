# asset-vault — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/asset-vault v1.0.0. Contrato de validación para la fase de generación.

> **Fixture de test del repo Keel.** Este archivo no es un diseño real: es el escenario
> **documental transversal**. Cada flujo existe para poner a prueba, contra Mongo real, una
> pieza que hasta ahora solo se había ejercitado sobre una base relacional — la clave
> natural compuesta que atraviesa una referencia, el registro de idempotencia de petición,
> el de eventos procesados, la caché y el binario en el bucket. La **forma** del documento
> (anidamiento profundo, value objects) no se prueba aquí: eso es `inspection-reports`.

## Convenciones de determinación

- **Formato temporal**: instante en UTC ISO-8601 con milisegundos
  (`2026-01-15T10:30:00.000Z`). `createdAt`/`updatedAt` se verifican **por forma**, nunca
  por valor.
- **Identificadores**: `uuid` v4 canónico, verificados por forma y por reutilización
  simbólica dentro del flujo (el `id` que devuelve un escenario es el que usa el siguiente).
- **Ausencia vs nulo**: un campo sin valor **viaja como nulo** en el cuerpo JSON; nunca se
  omite. `labels` vacío viaja como `[]`, no como nulo.
- **Autoría**: `audit.authorship: all`, así que `createdBy`/`updatedBy` los estampa la
  infraestructura desde el principal del token. Se verifican **por forma** (no nulos), no
  por valor: el sujeto depende del usuario con el que el arnés pida el token.
- **Forma del cuerpo de error**: la que impone keel-spring —
  `{timestamp, status, error, code, message, details}` más `correlationId`. Los escenarios
  fijan solo el `code` y el status HTTP.
- **Idempotencia de petición**: `uploadAsset` declara `idempotency` con `ttlSeconds: 86400`.
  Cada request lleva un `Idempotency-Key` **uuid nuevo**, salvo en el escenario que prueba
  la deduplicación, que repite el anterior a propósito.
- **Proveedores de prueba**: `scanner` y `rendering` son WireMock. Cada flujo programa sus
  respuestas y cuenta las llamadas recibidas; el arnés lo resetea entre flujos.
- **Subida**: `uploadAsset` es `multipart/form-data` — el binario en la parte `binary` y el
  resto de campos en las suyas.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| uploadAsset | FL-AST-001, FL-AST-001-B, FL-AST-001-C | usuarios (multipart) |
| getAsset | FL-AST-003, FL-AST-003-B | usuarios y clientes máquina |
| listAssets | FL-AST-004 | usuarios |
| publishAsset | FL-AST-002, FL-AST-002-B | usuarios |
| quarantineAsset | FL-QUA-001, FL-QUA-001-B | suscripción (interna) |
| reconcileScans | — | programada; sin efecto observable declarado |

`reconcileScans` no tiene flujo: el diseño declara **cuándo** corre, no qué corrige. Es un
hueco declarado de esta fixture, igual que en `stock-reservation`.

## Custodia del archivo

### FL-AST-001: se custodia un archivo

**Given**: existe el propietario `<o1>` con `code` = `"ACME"`.

**When**: `POST /api/v1/assets` (multipart) con `ownerId` = `<o1>`, `slug` = `"informe-q1"`,
`title` = `"Informe Q1"`, `labels` = `["finanzas", "2026"]` y un binario PDF, con un
`Idempotency-Key` propio `<k1>`.
**Then**:
1. Status `201`.
2. El cuerpo trae `id` (uuid), `slug` = `"informe-q1"`, `status` = `"draft"`,
   `labels` con los dos valores en el orden enviado, `owner` resuelto con su `code`, y
   `createdAt`/`createdBy` con forma válida.
3. `GET /api/v1/assets/{id}` devuelve el mismo archivo con `ownerId` = `<o1>`.

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

## Publicación

### FL-AST-002: publicar exige veredicto del escáner

**Given**: el archivo `<a1>` de FL-AST-001 está en `draft`; `scanner.scanAsset` responde
`200 {verdict: "clean", scannedAt: <t>}`.

**When**: `POST /api/v1/assets/{a1}/publish`.
**Then**:
1. Status `200` y `status` = `"published"`.
2. El proveedor recibió **exactamente una** llamada a `POST /scans`, con `assetId` = `<a1>`
   y el `storageKey` del binario custodiado.
3. Esa llamada llevaba cabecera `Idempotency-Key`: es lo que impide que un reintento nuestro
   encargue dos análisis del mismo binario.
4. `GET /api/v1/assets/{a1}` devuelve `published`: la respuesta cacheada de antes de
   publicar **no** sobrevive, porque `AssetPublished` la invalida.

#### FL-AST-002-B: el escáner no responde

**Given**: existe otro archivo `<a2>` en `draft`; `scanner.scanAsset` devuelve `503`.

**When**: `POST /api/v1/assets/{a2}/publish`.
**Then**:
1. Status `502` con `code` = `"SCANNER_UNAVAILABLE"`.
2. `<a2>` sigue en `draft`: sin veredicto no hay publicación (`onFailure: fail`).
3. No se publicó ningún `AssetPublished`.

## Consulta

### FL-AST-003: la ficha se pide al servicio de renderizado

**Given**: `<a1>` está publicado; `rendering.getThumbnail` responde
`200 {url: "https://cdn/t/a1.png", width: 320}`.

**When**: `GET /api/v1/assets/{a1}`.
**Then**:
1. Status `200` con el archivo y su `ownerId` plano (esta operación **no** lleva `embed`).
2. El proveedor recibió una llamada a `GET /thumbnails/{a1}`.

#### FL-AST-003-B: el servicio de renderizado cae

**Given**: `rendering.getThumbnail` devuelve `503`.

**When**: `GET /api/v1/assets/{a1}` con la caché ya invalidada.
**Then**:
1. Status `200` igualmente: la miniatura es un adorno de la ficha, no la ficha
   (`fallback: Devolver la ficha sin miniatura`).
2. La respuesta no trae miniatura, y el archivo llega completo.

### FL-AST-004: el listado va ordenado y trae el propietario

**Given**: `<o1>` custodia tres archivos con `slug` `"acta"`, `"informe-q1"` y `"plan"`.

**When**: `GET /api/v1/assets?page=0&size=2`.
**Then**:
1. Status `200`, dos elementos, y el orden es por `slug` ascendente: `"acta"` primero.
2. Cada elemento trae `owner` resuelto (`embed: [owner]`) con su `code` y su `displayName`,
   y el propietario se resuelve **una sola vez** para los dos elementos.
3. `GET /api/v1/assets?page=1&size=2` devuelve el tercero y **ninguno repetido**: el
   desempate por id lo añade el adaptador aunque el orden declarado no lo pida.

## Cuarentena: el escáner encuentra algo después

### FL-QUA-001: llega el hallazgo y el archivo se pone en cuarentena

Cubre `security-scanner.compensations[0]` (`undoes: scanAsset`). La operación compensadora
es `quarantineAsset`, interna y disparada solo por la suscripción.

**Given**: `<a1>` está en `published` (FL-AST-002).

**When**: llega el evento entrante `MalwareDetected` con payload
`{assetId: <a1>, reason: "firma conocida en el binario"}` y `messageId` `<m1>`.
**Then**:
1. Se ejecuta `quarantineAsset`.
2. `GET /api/v1/assets/{a1}` devuelve `status` = `"quarantined"`.

#### FL-QUA-001-B: el mismo evento se reentrega

**When**: se entrega **otra vez** el mismo `MalwareDetected`, con idéntico payload y el
**mismo** `messageId` `<m1>`.
**Then**:
1. `<a1>` sigue en `quarantined` y nada más cambia: ningún segundo efecto.
2. El servicio **confirma** el mensaje sin volver a procesarlo — no acaba en la DLQ ni
   reintentando: una reentrega es el comportamiento normal de cualquier broker.
3. Lo garantizan las dos mitades juntas: `contract.messageId` deduplica en el listener
   (colección `processed_event`), y la transición declarada rechaza la segunda aplicación
   aunque el mensaje llegara por otro camino.
