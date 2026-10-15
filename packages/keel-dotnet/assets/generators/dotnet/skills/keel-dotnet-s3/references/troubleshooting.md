# S3/MinIO — diagnóstico

## La subida responde antes de llegar al handler

- **413 con el `code` del diseño**: el cuerpo supera el límite de la ENTRADA (el doble del mayor `maxSizeMb`,
  `MultipartReading.LimitBytes` en `src/<Raíz>.Api/Rest/MultipartReading.cs`). El límite de negocio lo comprueba el
  caso de uso con `AllowsSize`, y se alcanza antes.
- **400 `FILE_UNREADABLE`**: el cuerpo multipart está roto (cortado, mal formado) o la parte obligatoria llegó vacía.
- **400 «Falta la parte '…'»**: la parte binaria obligatoria no vino con ese nombre: el nombre de la parte es el del
  campo `file` del diseño.
- **415**: la petición no es `multipart/form-data`. En un flujo, sube con `Upload(...)`, no con `Post`.

## NoSuchBucket

El adaptador subió a un bucket que nadie creó: usa `policies.ForBucket(bucket).Bucket` (el que crea `minio-init` y el
que dice `storage.yaml`). En local, `bash infra/validate-infra.sh` comprueba que existen.

## La subida responde 201 y la lectura de la URL pública, 403

El bucket no tiene la política de lectura anónima. En local la aplica `minio-init`; en un entorno real, el
aprovisionamiento del adaptador (`EnsureBucketsOnStartup`) o la plataforma.

## SignatureDoesNotMatch o 403 en una URL firmada

- La firma incluye el host: una URL firmada contra `http://minio:9000` no se puede abrir desde el host. El cliente que
  firma tiene que usar el endpoint que verá el consumidor.
- `ForcePathStyle` distinto entre el cliente que sube y el que firma, o una región distinta (`AuthenticationRegion`).
- La URL caducó (`signedUrlTtlSeconds` del diseño).

## El servicio no arranca: «storage.buckets.<b>.bucket no está configurado»

`StorageSettings.From` exige el nombre físico de cada bucket del diseño: falta en `config/parameters/<perfil>/storage.yaml`
o la variable `STORAGE_BUCKET_<B>` del perfil. Es un fallo de despliegue a propósito: sin él, la primera subida iría a
un bucket que no existe.

## Inspeccionar el almacén

Desde el contenedor devtools de `infra/`:

```bash
mc alias set local http://minio:9000 minioadmin minioadmin
mc ls local/<bucket-físico>
mc stat local/<bucket-físico>/<clave>
mc anonymous get local/<bucket-físico>
```
