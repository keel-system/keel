---
name: keel-nest-s3
description: Guía del almacenamiento de binarios S3 (MinIO en local, Amazon S3 en producción, el mismo SDK) en un proyecto generado por keel-nest — qué generó build, el adaptador FileStorage que te toca escribir y cómo se valida una subida. Usar cuando keel-stack.json declara storage "minio" o "s3".
---

# Almacenamiento S3 (storage: `minio` o `s3`)

MinIO y S3 hablan el mismo protocolo: un único adaptador sirve para los dos; la diferencia (endpoint y
path-style) vive en `config/parameters/<perfil>/storage.yaml`. Es el mismo servidor que el de keel-spring del
diseño: las mismas variables de entorno, los mismos buckets físicos, el mismo límite de entrada y los mismos
errores de una subida rota.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"storage": "minio"` o `"storage": "s3"`.
- Lee `specs/storage.keel.yaml` (buckets, visibilidad, tipos admitidos, tamaño, caducidad de la URL firmada):
  el diseño es la única fuente de verdad funcional.
- Sigue `{{keel:docs}}/conventions/mapping.md` y la frontera de `{{keel:docs}}/architecture.md`:
  `src/application` no importa el SDK; usa los puertos.

## Qué dejó listo build — y qué NO vas a escribir

| Pieza (build) | Dónde |
|---|---|
| El puerto | `src/domain/storage/file-storage.ts` — `FileStorage`. Sus métodos de lectura dependen de la visibilidad del diseño: `download` y `signedUrl` solo con algún bucket `private`, `publicUrl` solo con alguno `public` |
| Lo que el agregado guarda | `src/domain/storage/stored-object.ts` — `StoredObject(storageKey, url, contentType, sizeBytes)` |
| La política de cada bucket | `src/domain/storage/bucket-policy.ts` (`allowsContent`, `allowsSize`, `signedUrlTtlSeconds`) y `src/domain/storage/storage-policies.ts` (una constante por bucket y `forBucket`) |
| La firma del binario | `src/domain/storage/content-signature.ts` — la usa `allowsContent` |
| Configuración | `config/parameters/<perfil>/storage.yaml` y `src/infrastructure/storage/storage-settings.ts` |
| Módulo | `src/infrastructure/storage/storage-module.ts` — global; ya cablea `S3FileStorage` como `FileStorage` |
| La entrada multipart | `src/infrastructure/rest/multipart-reading.ts` y el lector de cada subida en su controlador: el binario llega al mensaje como `FileUpload` (`src/application/dtos/file-upload.ts`) |
| La URL de un bucket público en las respuestas | el `<Entidad>ApplicationMapper` ya llama a `publicUrl` |
| MinIO en `infra/`, sus buckets (sidecar `minio-init`), su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El arnés | `flow.upload(...)` y, con MinIO, `stopStorage()`/`startStorage()` en `test/integration/support/flow.ts` |

> El límite de la ENTRADA (el doble del mayor `maxSizeMb`) y sus errores —413 con el `code` del diseño, 400
> `FILE_UNREADABLE`, 400 por la parte que falta— ya los da la entrada multipart. No los redeclares en el handler.

## Lo que te toca

**1. El adaptador** (`src/infrastructure/storage/s3-file-storage.ts`): build dejó la clase con `settings` y
`policies` inyectados y un TODO por método. Complétala con `@aws-sdk/client-s3` (ya en `package.json`; con un
bucket privado, también `@aws-sdk/s3-request-presigner`). El bucket FÍSICO sale siempre de
`this.policies.forBucket(bucket).bucket` —es el que crea `minio-init`—, nunca de un literal. Receta completa en
`references/implementation.md`.

**2. El caso de uso de la subida**: inyecta `StoragePolicies` y `FileStorage` (añádelos a `static readonly inject`
y al constructor) y valida ANTES de subir, en el orden que fije el diseño, con los errores que declara:

```ts
const policy = this.storagePolicies.forBucket(StoragePolicies.ASSET_BINARIES);
// allowsContent, NO allowsContentType: comprueba el tipo declarado Y la firma del binario.
if (!policy.allowsContent(command.binary.content, command.binary.contentType)) throw new UnsupportedContentTypeError(/* … */);
if (!policy.allowsSize(command.binary.size)) throw new FileTooLargeError(/* … */);
const stored = await this.fileStorage.upload(StoragePolicies.ASSET_BINARIES, key, command.binary.content, command.binary.contentType);
```

**Usa `allowsContent`, no `allowsContentType`.** El tipo de una parte multipart lo elige quien sube: con solo el
tipo declarado, un ejecutable renombrado a `.png` y enviado como `image/png` se guarda y —en un bucket público— se
sirve. Ningún escenario lo echa de menos: la subida responde exactamente lo mismo.

- **La clave del objeto la eliges tú, nunca el nombre del cliente**: `<entidad>/<id>/<uuid>.<ext>`. Guarda el
  `StoredObject` (al menos su `storageKey`) en el agregado.
- **El binario sale del proceso**: si el diseño declara qué pasa con el almacén caído (un 503), traduce el fallo
  del SDK en el adaptador a ese error; y piensa qué queda si la transacción del agregado revierte después de subir
  (un objeto huérfano no rompe nada; un agregado que apunta a un objeto que no existe, sí).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el adaptador: cliente, subida, lectura, URLs, aprovisionamiento de buckets y errores |
| `references/troubleshooting.md` | Si hay SignatureDoesNotMatch, 403 al leer, NoSuchBucket o una subida que responde 413/400 sin entrar al handler |

## Validación

Desde el contenedor devtools de `infra/`: `mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local`;
`mc ls local/<bucket>` para ver los objetos subidos. En un flujo, `flow.upload(...)` sube como un cliente y, con
MinIO, `stopStorage()`/`startStorage()` mide el almacén caído (restáuralo en un `finally`).
