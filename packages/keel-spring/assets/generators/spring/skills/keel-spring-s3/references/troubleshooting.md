# S3/MinIO — troubleshooting

Síntoma → causa → arreglo. Sondeo básico en
`.claude/conventions/infra-validation.md`.

## `SignatureDoesNotMatch` contra MinIO

Casi siempre `path-style-access` en `false` (el SDK intenta
`<bucket>.minio:9000`, que no resuelve o firma distinto). Verifica que el
perfil activo carga `storage.yaml` con `path-style-access: true` y el endpoint
correcto. Segunda causa: credenciales distintas de las del compose
(minioadmin/minioadmin).

## `NoSuchBucket`

El bucket no existe en el MinIO local: créalo
(`mc mb -p local/<bucket>`, receta en `references/implementation.md`). Los
volúmenes del compose persisten entre reinicios, pero un
`docker compose down -v` los borra — recrea el bucket tras limpiar volúmenes.

## La presigned URL devuelve 403 (o «expired»)

- **Firma con host interno**: firmada con `http://minio:9000` y consumida
  desde el host (o viceversa): la firma incluye el host, la URL no se puede
  reescribir. Firma con el endpoint que verá el consumidor.
- Expirada de verdad: compara `signatureDuration` con el tiempo del flujo del
  escenario.
- Reloj desviado entre firmante y MinIO (contenedores suspendidos en
  Windows/WSL): reinicia el contenedor; desviaciones >15min invalidan firmas.

## `Unable to load credentials from any of the providers`

El bean usa `DefaultCredentialsProvider` (o las claves del YAML están vacías)
y no hay credenciales en el entorno. En local las claves vienen de
`storage.yaml`; verifica que el perfil activo importa el fragmento. En
production con rol IAM es configuración de despliegue.

## `Connection refused` al subir

MinIO caído o endpoint equivocado: desde la app en el host es
`http://localhost:9000`; desde devtools el host es `minio`. Sondea
`mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local`.

## Funciona con MinIO pero falla contra S3 real

- Quedó `endpoint` o `path-style-access: true` en el perfil real.
- Permisos IAM: `s3:PutObject`/`GetObject`/`DeleteObject` sobre
  `arn:aws:s3:::<bucket>/*` (y `s3:ListBucket` sobre el bucket si listas).
- Región equivocada: el bucket vive en una región concreta; `storage.region`
  debe coincidir (el SDK da `PermanentRedirect` si no).

## El upload de archivos grandes falla o agota memoria

`byte[]` en memoria + `MaxUploadSizeExceededException` de Spring antes de
llegar al adaptador. Alinea `spring.servlet.multipart.max-file-size` con el
límite del diseño (configuration.md) y pasa a streaming/multipart
(implementation.md) si el diseño admite archivos realmente grandes.
