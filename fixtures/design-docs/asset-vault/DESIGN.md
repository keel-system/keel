# asset-vault — Documento de diseño

> specs/asset-vault v1.1.0. Diseño cerrado al preparar la corrida del incremento 13 de keel-nest
> (2026-10-09); las decisiones las tomó quien la preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Custodia los archivos digitales de cada propietario y su ciclo de publicación. Un custodio sube un
binario (PDF, PNG o JPEG, hasta 25 MB). Para publicarlo, el escáner antimalware tiene que darlo por
limpio. Si el escáner encuentra una amenaza después, el archivo pasa a cuarentena y su miniatura se retira
del renderizador. El escáner puede avisarlo o no avisar nunca; en ese caso, un barrido por reloj vuelve a
preguntarle.

Es la silueta **documental** transversal de las fixtures, sobre MongoDB:

- caché de lectura con invalidación por eventos;
- almacenamiento de binarios con subida multipart;
- autoría de las escrituras;
- alcance por recurso;
- idempotencia de petición y de consumo, en los dos órdenes de la guarda;
- compensación con llamada de vuelta al proveedor;
- reconciliación por deriva;
- arbitraje entre réplicas.

Queda fuera, a propósito, la descarga del binario, la creación de revisiones, la retención y el borrado.
Los motivos están en § 7.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `Asset` | raíz de `Vault` | El archivo custodiado: `slug` (único dentro de su propietario), `title`, `checksum` (único: dos propietarios no custodian el mismo binario), `contentType`, `sizeBytes`, `storageKey`, `labels`, contadores de entrega de la miniatura, marca del último veredicto y motivo de la cuarentena. |
| `AssetRevision` | interna de `Vault` | Revisión anidada en el documento del archivo. |
| `Owner` | raíz de `Owners` | El propietario, con su `code` estable, que es contra lo que se mide el alcance. Lo aprovisiona el directorio de la organización. |

Ciclo de vida: `draft` → `published` (el escáner dio `clean`), o → `quarantined` (llegó un hallazgo).
Desde `published` también se pasa a `quarantined`. `quarantined` es terminal.

## 3. Invariantes y reglas clave

- Un `slug` por propietario y un `checksum` en todo el servicio.
  - El servicio calcula el `checksum`: SHA-256 en hexadecimal y en minúsculas.
  - El `slug` solo admite minúsculas, así que no hay variantes de mayúsculas.
- Al subir, el orden de los rechazos es: tamaño, propietario, tipo y unicidades.
  - El tamaño se rechaza al leer la petición.
  - El tipo se comprueba contra lo declarado y contra la firma del contenido: un ejecutable etiquetado como `image/png` no entra.
- Solo un veredicto `clean` publica. Cualquier otro deja el archivo en `draft` con `ASSET_NOT_CLEAN`.
- El estado se comprueba antes de pedir el análisis.
- `lastScannedAt` lo fija el reloj propio al recibir cada veredicto, no el `scannedAt` del escáner. Un archivo `published` siempre la tiene.
- La cuarentena guarda su motivo y publica `AssetQuarantined`.
  - La retirada de la miniatura se encarga **después** de confirmar la cuarentena.
  - Un segundo hallazgo sobre un archivo ya en cuarentena se confirma sin efecto.
- `thumbnailDeliveryCount` cuenta mensajes distintos del renderizador. `lastDeliveredAt` solo avanza.
- Alcance por recurso: el claim `vaults` enumera los `Owner.code` visibles y se compara distinguiendo mayúsculas.
  - `vault-admin` está exento, y es el único que escribe.
  - El cliente máquina `rendering-service` lee cualquier ficha.
  - El listado se filtra por alcance.

## 4. Qué hace

| Operación | Puerta | Éxito | Errores |
|---|---|---|---|
| `uploadAsset` | `POST /api/v1/assets` (multipart, con `Idempotency-Key`) | `201`, el archivo en `draft` con su propietario embebido, y `AssetUploaded` | `413 FILE_TOO_LARGE`, `422 OWNER_NOT_FOUND`, `415 UNSUPPORTED_CONTENT_TYPE`, `409 ASSET_OWNER_SLUG_ALREADY_EXISTS`, `409 ASSET_CHECKSUM_ALREADY_EXISTS`, `409 IDEMPOTENCY_KEY_IN_PROGRESS`/`_REUSED` |
| `getAsset` | `GET /api/v1/assets/{id}` (usuarios y clientes máquina) | `200`, la ficha con miniatura, cacheada 300 s | `404 ASSET_NOT_FOUND`, `403 ASSET_OUT_OF_SCOPE` |
| `listAssets` | `GET /api/v1/assets` | `200`, la página ordenada por `slug` y acotada al alcance, con el propietario embebido | — |
| `publishAsset` | `POST /api/v1/assets/{id}/publish` | `200`, el archivo en `published`, y `AssetPublished` | `404 ASSET_NOT_FOUND`, `422 INVALID_ASSET_STATE`, `422 ASSET_NOT_CLEAN`, `409 CONCURRENT_MODIFICATION`, `502 SCANNER_UNAVAILABLE` |
| `quarantineAsset` | suscripción `MalwareDetected`, y el barrido | el archivo en `quarantined` con su motivo, `AssetQuarantined` y la miniatura retirada | sin archivo → descarte |
| `noteThumbnailDelivery` | suscripción `ThumbnailDelivered` | la entrega anotada | sin archivo → descarte |
| `reconcileScans` | reloj, cada minuto | revalida los `published` con el veredicto más viejo de 900 s: si es limpio, renueva la marca; si no, cuarentena | — |

## 5. Fronteras e integraciones

**Mensajería.**

- Publica, por outbox, `AssetUploaded`, `AssetPublished` y `AssetQuarantined` en el canal por defecto del servicio.
- Consume `MalwareDetected` del escáner, en la envoltura Keel, deduplicado por `metadata.eventId` y además frenado por su transición.
- Consume `ThumbnailDelivered` del renderizador:
  - llega plano por su canal `renderingTelemetry`;
  - se deduplica por la cabecera nativa `X-Render-Event-Id`, marcada antes del efecto.
- Las dos suscripciones reintentan cinco veces y descartan a la DLQ.

**Llamadas HTTP.**

- Al escáner (`scanner.scanAsset`, `POST /scans`), desde la publicación y el barrido:
  - lleva `Idempotency-Key` por encargo;
  - timeout de 4 s, reintento solo de timeout y corte, y circuito;
  - si falla, la publicación responde `SCANNER_UNAVAILABLE`, y el barrido deja el archivo para la pasada siguiente.
- Al renderizador:
  - `getThumbnail` (`GET /thumbnails/{assetId}`) se pide bajo demanda en `getAsset`. Si no contesta, la ficha sale con `thumbnail` nulo y no se cachea.
  - `purgeThumbnail` (`DELETE /thumbnails/{assetId}`) se llama en la cuarentena. Si falla, se ignora.

**Almacenamiento.** El bucket `assetBinaries` es privado: solo lo lee el servicio.

**Seguridad.**

- OIDC, con los roles `vault-admin` (escribe y lee) y `vault-reader` (lee).
- El cliente máquina `rendering-service` entra por client-credentials, con la audiencia validada.

## 6. Decisiones de diseño (qué / por qué)

- **Outbox**: `AssetPublished` y `AssetQuarantined` dicen al resto de la organización qué se puede servir y qué no. Perder uno, o emitirlo sin commit, es servir lo que no se debe.
- **Idempotencia de petición solo en la subida**: es la única operación cuyo reintento crea otra cosa. Publicar dos veces lo frena la transición.
- **Caché en `getAsset` invalidada por cuatro eventos**:
  - `AssetQuarantined` es el publicado y no el hallazgo entrante, porque la cuarentena también la despacha el barrido.
  - La ficha degradada no se cachea.
- **Revalidar en vez de rendirse**: preguntar otra vez al escáner no tiene efecto acumulable, así que el barrido reencarga el análisis y resuelve él mismo la amenaza. La cadencia (cada minuto) y el umbral (900 s) son dos cosas distintas.
- **Compensación hasta el proveedor**: deshacer a medias deja al renderizador sirviendo la miniatura de un binario infectado. Que no conteste no detiene la cuarentena: la miniatura huérfana es un coste menor.
- **Bloqueo optimista en la raíz**: sobre un archivo escriben a la vez la publicación, la cuarentena, la telemetría y el barrido. Con «último gana», una publicación tardía podría deshacer una cuarentena.
- **Dos órdenes de la guarda de consumo**:
  - La cuarentena registra lo procesado después, y la frena su transición.
  - El contador registra antes, y acepta perder una entrega si el handler falla.
- **Autoría y marcas de tiempo por política**: quién subió y quién publicó es la pregunta de una auditoría de custodia.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

**Estable:**

- las cuatro rutas, la forma de la ficha y los `code`;
- los tres eventos publicados y los dos consumidos, con sus dos contratos de identidad;
- las dos llamadas al renderizador y la del escáner;
- el alcance por `vaults`.

**Adaptable:**

- el broker y el proveedor de almacenamiento, que se eligen al generar;
- el TTL de la caché;
- el umbral de revalidación;
- la resiliencia de las llamadas;
- los tipos admitidos y el tamaño del bucket.

### Supuestos y limitaciones

- No hay descarga del binario en esta versión: el bucket solo lo lee el servicio.
- Ninguna operación crea revisiones: existen para la silueta documental anidada.
- Los propietarios los aprovisiona el directorio. Un cambio de `code` se aplica a la vez allí, en los tokens y en esta base.
- No hay retención ni borrado: la custodia lo guarda todo, también lo que está en cuarentena.
- La exención del cliente máquina sobre el alcance vive en una regla de `getAsset`: el DSL no puede enumerarla. Es candidata a un `exemptClients`.

### Cómo reutilizarlo

Para otra custodia con verificación externa, hay que cambiar:

- la entidad;
- el escáner (cualquier verificador con veredicto);
- el bucket.

El patrón se mantiene:

- veredicto que publica;
- marca de veredicto con barrido de deriva;
- compensación que llega al proveedor;
- evento de retirada que invalida la caché.

Sin almacenamiento ni caché, partir de `stock-reservation`.
