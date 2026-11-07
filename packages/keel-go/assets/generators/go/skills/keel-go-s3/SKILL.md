---
name: keel-go-s3
description: Guía del almacenamiento de binarios S3 (MinIO en local, Amazon S3 en producción, el mismo SDK) en un proyecto generado por keel-go — qué generó build, el adaptador de domain.FileStorage que te toca escribir y cómo se valida una subida. Usar cuando keel-stack.json declara storage "minio" o "s3".
---

# Almacenamiento S3 (storage: `minio` o `s3`)

MinIO y S3 hablan el mismo protocolo: un único adaptador sirve para los dos; la diferencia (endpoint y path-style) vive
en `config/parameters/<perfil>/storage.yaml`. Es el mismo servidor que el de keel-spring, keel-nest y keel-dotnet del
diseño: las mismas variables de entorno, los mismos buckets físicos, el mismo límite de entrada y los mismos errores de
una subida rota.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"storage": "minio"` o `"storage": "s3"`.
- Lee `specs/storage.keel.yaml` (buckets, visibilidad, tipos admitidos, tamaño, caducidad de la URL firmada): el diseño
  es la única fuente de verdad funcional.
- Sigue la frontera de `{{keel:docs}}/architecture.md`: `internal/domain` e `internal/application` no conocen el SDK
  (lo vigila `internal/architecture`); usa los puertos.

## Qué dejó listo build — y qué NO vas a escribir

| Pieza (build) | Dónde |
|---|---|
| El puerto | `internal/domain/file_storage.go` — `FileStorage`. Sus métodos de lectura dependen de la visibilidad del diseño: `Download` y `SignedURL` solo con algún bucket `private`, `PublicURL` solo con alguno `public` |
| Lo que el agregado guarda | `internal/domain/file_storage.go` — `StoredObject{StorageKey, URL, ContentType, SizeBytes}` |
| La política de cada bucket | `internal/domain/bucket_policy.go` — `BucketPolicy` (`AllowsContent`, `AllowsSize`, `SignedURLTTL()`), el puerto `StoragePolicies` (`ForBucket`) y una constante `Bucket<Nombre>` por bucket |
| La firma del binario | `MatchesSignature` en `internal/domain/bucket_policy.go` — la usa `AllowsContent`; la ejecuta `bucket_policy_test.go` |
| El 413 del caso de uso | `domain.ErrFileTooLarge` (o el error que el diseño declare para el exceso de tamaño) en `internal/domain/errors.go` |
| Configuración y políticas | `config/parameters/<perfil>/storage.yaml`, `internal/infrastructure/storage/settings.go` y `internal/infrastructure/storage/policies.go` |
| El cliente S3 | `internal/infrastructure/storage/client.go` — `NewClient`: credenciales, región, endpoint de MinIO y path-style ya puestos |
| El cableado | `cmd/server/main.go` construye el adaptador con `storage.NewStorage`, llama a `EnsureBuckets` y lo pasa a los casos de uso. **No lo toques** |
| La entrada multipart | `internal/httpapi/multipart.go` y el lector de cada subida en su `_endpoints.go`: el binario llega al mensaje como `application.FileUpload` |
| La URL de un bucket público en las respuestas | la función `To<Dto>` que la expone ya llama a `fileStorage.PublicURL` (y recibe el puerto como último parámetro) |
| El handler de la subida | ya recibe `storagePolicies` y `fileStorage`, con una nota del orden de las comprobaciones; el de una respuesta con URL pública, `fileStorage` |
| MinIO en `infra/`, sus buckets (sidecar `minio-init`), su sondeo y su vaciado | `infra/docker-compose.yaml`, `infra/validate-infra.sh`, `infra/reset-db.sh` |
| El arnés | `s.Upload(...)`, `UploadPart` y, con MinIO, `s.StopStorage()`/`s.StartStorage()` en `tests/integration/storage_test.go` |

> El límite de la ENTRADA (el doble del mayor `maxSizeMb`) y sus errores —413 con el `code` del diseño, 400
> `FILE_UNREADABLE` para un cuerpo roto o una parte obligatoria vacía, 400 por la parte que falta, 415 si no es
> multipart— ya los da `internal/httpapi/multipart.go`. No los redeclares en el handler.

## Lo que te toca

**1. El adaptador** (`internal/infrastructure/storage/storage.go`, sin la cabecera de código generado): build dejó el
tipo `Storage` con `client`, `settings` y `policies`, y un error `TODO (agente)` por método. Complétalo con el SDK
(`github.com/aws/aws-sdk-go-v2/service/s3`, ya en `go.mod`). El bucket FÍSICO sale siempre de
`policies.ForBucket(bucket)` → `Bucket()` —es el que crea `minio-init`—, nunca de un literal. Receta completa en
`references/implementation.md`.

**2. El caso de uso de la subida**: valida ANTES de subir, en el orden que fije el diseño, con los errores que declara:

```go
policy, err := h.storagePolicies.ForBucket(domain.BucketAssetBinaries)
if err != nil {
	return UploadAssetResponseDto{}, err
}
// El límite del bucket lo compruebas TÚ: el lector multipart solo corta al doble del mayor maxSizeMb.
if !policy.AllowsSize(cmd.Binary.Size) {
	return UploadAssetResponseDto{}, domain.Errorf(domain.ErrFileTooLarge, "el archivo supera %d MB", policy.MaxSizeMB())
}
// AllowsContent, NO AllowsContentType: comprueba el tipo declarado Y la firma del binario.
if !policy.AllowsContent(cmd.Binary.Content, cmd.Binary.ContentType) {
	// El 415: el centinela lo genera build (o es el del error que declare el diseño), con el texto del contrato.
	return UploadAssetResponseDto{}, domain.Errorf(domain.ErrUnsupportedContentType, "El tipo del archivo no está permitido")
}
key := fmt.Sprintf("assets/%s/%s", assetID, uuid.NewString())
stored, err := h.fileStorage.Upload(ctx, domain.BucketAssetBinaries, key, cmd.Binary.Content, cmd.Binary.ContentType)
if err != nil {
	return UploadAssetResponseDto{}, err
}
```

**Usa `AllowsContent`, no `AllowsContentType`.** El tipo de una parte multipart lo elige quien sube: con solo el tipo
declarado, un ejecutable renombrado a `.png` y enviado como `image/png` se guarda y —en un bucket público— se sirve.
Ningún escenario lo echa de menos: la subida responde exactamente lo mismo.

- **La clave del objeto la eliges tú, nunca el nombre del cliente**: `<entidad>/<id>/<uuid>`. Guarda el `StoredObject`
  (al menos su `StorageKey`) en el agregado.
- **La subida va al final**: lo que se rechaza antes no deja un objeto huérfano.
- **El binario sale del proceso**: si el diseño declara qué pasa con el almacén caído (un 503), traduce el fallo del SDK
  en el adaptador a ese error; y piensa qué queda si la transacción del agregado revierte después de subir (un objeto
  huérfano no rompe nada; un agregado que apunta a un objeto que no existe, sí).
- **Borrar un binario «tras confirmar»**: todo comando recibe `fileStorage`; el borrado va dentro de `afterCommit(ctx, …)`,
  nunca directo en la transacción (ver `references/implementation.md`, § Borrar).

## Referencias

| Referencia | Cuándo leerla |
|---|---|
| `references/implementation.md` | Al escribir el adaptador: subida, lectura, URLs, aprovisionamiento de buckets y errores |
| `references/troubleshooting.md` | Si hay SignatureDoesNotMatch, 403 al leer, NoSuchBucket o una subida que responde 413/400/415 sin entrar al handler |

## Validación

`go test ./...` (incluye `internal/httpapi/api_test.go`, con los casos de la subida: si cae uno, tocaste la entrada; y
`internal/domain/bucket_policy_test.go`, la tabla de firmas). Desde el contenedor devtools de `infra/`:
`mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local`; `mc ls local/<bucket>` para ver los
objetos subidos. En un flujo, `s.Upload(...)` sube como un cliente y, con MinIO, `s.StopStorage()` mide el almacén caído
(restáuralo con `defer s.StartStorage()`).
