---
name: keel-dotnet-s3
description: Guía del almacenamiento de binarios S3 (MinIO en local, Amazon S3 en producción, el mismo SDK) en un proyecto generado por keel-dotnet — qué generó build, el adaptador IFileStorage que te toca escribir y cómo se valida una subida. Usar cuando keel-stack.json declara storage "minio" o "s3".
---

# Almacenamiento S3 (storage: `minio` o `s3`)

MinIO y S3 hablan el mismo protocolo: un único adaptador sirve para los dos; la diferencia (endpoint y path-style) vive
en `config/parameters/<perfil>/storage.yaml`. Es el mismo servidor que el de keel-spring y keel-nest del diseño: las
mismas variables de entorno, los mismos buckets físicos, el mismo límite de entrada y los mismos errores de una subida
rota.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"storage": "minio"` o `"storage": "s3"`.
- Lee `specs/storage.keel.yaml` (buckets, visibilidad, tipos admitidos, tamaño, caducidad de la URL firmada): el diseño
  es la única fuente de verdad funcional.
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`: el proyecto Application
  no conoce el SDK (el compilador lo impide: no lo referencia); usa los puertos.

## Qué dejó listo build — y qué NO vas a escribir

`<Raíz>` es el nombre de la solución (`AssetVault`, por ejemplo).

| Pieza (build) | Dónde |
|---|---|
| El puerto | `src/<Raíz>.Domain/Storage/IFileStorage.cs` — `IFileStorage`. Sus métodos de lectura dependen de la visibilidad del diseño: `Download` y `SignedUrl` solo con algún bucket `private`, `PublicUrl` solo con alguno `public` |
| Lo que el agregado guarda | `src/<Raíz>.Domain/Storage/StoredObject.cs` — `StoredObject(StorageKey, Url, ContentType, SizeBytes)` |
| La política de cada bucket | `src/<Raíz>.Domain/Storage/BucketPolicy.cs` (`AllowsContent`, `AllowsSize`, `SignedUrlTtlSeconds()`) y `src/<Raíz>.Domain/Storage/StoragePolicies.cs` (una constante por bucket y `ForBucket`) |
| La firma del binario | `src/<Raíz>.Domain/Storage/ContentSignature.cs` — la usa `AllowsContent` |
| Configuración | `config/parameters/<perfil>/storage.yaml` y `src/<Raíz>.Infrastructure/Storage/StorageSettings.cs` |
| Registro | `src/<Raíz>.Infrastructure/Storage/StorageRegistration.cs` — ya registra `S3FileStorage` como `IFileStorage` y como servicio de arranque (su `StartAsync` aprovisiona los buckets), y `Program.cs` lo llama. **No lo toques** |
| La entrada multipart | `src/<Raíz>.Api/Rest/MultipartReading.cs` y el lector de cada subida en su archivo de `Endpoints/`: el binario llega al mensaje como `FileUpload` (`src/<Raíz>.Application/Dtos/FileUpload.cs`) |
| La URL de un bucket público en las respuestas | el `<Entidad>ApplicationMapper` ya llama a `PublicUrl` |
| El handler de la subida | ya recibe `StoragePolicies` e `IFileStorage` en su constructor primario, con una nota del orden de las comprobaciones |
| MinIO en `infra/`, sus buckets (sidecar `minio-init`), su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El arnés | `Upload(...)` y, con MinIO, `StopStorage()`/`StartStorage()` en `FlowTest`; `UploadPart` en `tests/<Raíz>.IntegrationTests/Support/Harness.cs` |

> El límite de la ENTRADA (el doble del mayor `maxSizeMb`) y sus errores —413 con el `code` del diseño, 400
> `FILE_UNREADABLE` para un cuerpo roto o una parte obligatoria vacía, 400 por la parte que falta, 415 si no es
> multipart— ya los da `MultipartReading`. No los redeclares en el handler.

## Lo que te toca

**1. El adaptador** (`src/<Raíz>.Infrastructure/Storage/S3FileStorage.cs`): build dejó la clase con `settings` y
`policies` inyectados y un `NotImplementedException` por método. Complétala con `AWSSDK.S3` (ya en el `.csproj` de
Infrastructure). El bucket FÍSICO sale siempre de `policies.ForBucket(bucket).Bucket` —es el que crea `minio-init`—,
nunca de un literal. Receta completa en `references/implementation.md`.

**2. El caso de uso de la subida**: valida ANTES de subir, en el orden que fije el diseño, con los errores que declara:

```csharp
var policy = storagePolicies.ForBucket(StoragePolicies.AssetBinaries);
// El límite del bucket lo compruebas TÚ: el lector multipart solo corta al doble del mayor maxSizeMb.
if (!policy.AllowsSize(command.Binary.Size)) throw new FileTooLargeError(/* … */);
// AllowsContent, NO AllowsContentType: comprueba el tipo declarado Y la firma del binario.
if (!policy.AllowsContent(command.Binary.Content.Span, command.Binary.ContentType)) throw new UnsupportedContentTypeError(/* … */);
var stored = await fileStorage.Upload(StoragePolicies.AssetBinaries, key, command.Binary.Content, command.Binary.ContentType, cancellationToken);
```

**Usa `AllowsContent`, no `AllowsContentType`.** El tipo de una parte multipart lo elige quien sube: con solo el tipo
declarado, un ejecutable renombrado a `.png` y enviado como `image/png` se guarda y —en un bucket público— se sirve.
Ningún escenario lo echa de menos: la subida responde exactamente lo mismo.

- **La clave del objeto la eliges tú, nunca el nombre del cliente**: `<entidad>/<id>/<uuid>.<ext>`. Guarda el
  `StoredObject` (al menos su `StorageKey`) en el agregado.
- **La subida va al final**: lo que se rechaza antes no deja un objeto huérfano.
- **El binario sale del proceso**: si el diseño declara qué pasa con el almacén caído (un 503), traduce el fallo del SDK
  en el adaptador a ese error; y piensa qué queda si la transacción del agregado revierte después de subir (un objeto
  huérfano no rompe nada; un agregado que apunta a un objeto que no existe, sí).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el adaptador: cliente, subida, lectura, URLs, aprovisionamiento de buckets y errores |
| `references/troubleshooting.md` | Si hay SignatureDoesNotMatch, 403 al leer, NoSuchBucket o una subida que responde 413/400/415 sin entrar al handler |

## Validación

`dotnet test` (incluye `ApiTests`, con los casos de la subida: si cae uno, tocaste la entrada). Desde el contenedor
devtools de `infra/`: `mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local`; `mc ls
local/<bucket>` para ver los objetos subidos. En un flujo, `Upload(...)` sube como un cliente y, con MinIO,
`StopStorage()`/`StartStorage()` mide el almacén caído (restáuralo en un `finally`).
