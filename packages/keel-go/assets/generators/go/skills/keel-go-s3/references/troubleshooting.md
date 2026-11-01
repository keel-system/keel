# Problemas frecuentes con el almacenamiento S3

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| `SignatureDoesNotMatch` contra MinIO | el bucket va en el host (virtual-hosted) y MinIO lo espera en la ruta | `path-style-access: true` en `storage.yaml` (ya lo está con MinIO): no construyas otro cliente, usa el de `NewClient` |
| `NoSuchBucket` al subir | el bucket físico no existe: se usó el nombre lógico, o `minio-init` no corrió | el físico sale de `policies.ForBucket(bucket)` → `Bucket()`; en local, `bash infra/up.sh` lo crea, y `EnsureBuckets` también |
| 403 al leer una URL pública | el bucket no tiene la política de lectura anónima | la pone el sidecar `minio-init` en local y `EnsureBuckets` con `ensure-buckets-on-startup`; en producción, la infraestructura |
| La URL pública apunta a `http://minio:9000/...` | se compuso con `settings.Endpoint` | se compone con `settings.PublicBaseURL` (`STORAGE_PUBLIC_BASE_URL`) |
| Una URL firmada que no caduca nunca, o en un plazo inventado | la ventana la eligió el adaptador | `policy.SignedURLTTL()`: lo que declara el diseño, y error si no lo declara |
| La subida responde 415 sin entrar al handler | el cliente no mandó `multipart/form-data` | es el contrato de la entrada (`internal/httpapi/multipart.go`) |
| La subida responde 413 sin entrar al handler | el cuerpo pasa del límite de la ENTRADA (el doble del mayor `maxSizeMb`) | también es contrato: el límite del bucket, menor, lo comprueba el handler con `AllowsSize` |
| 400 `FILE_UNREADABLE` | el cuerpo multipart está cortado o la parte obligatoria llegó con cero bytes | contrato de la entrada; no lo atrapes en el handler |
| 400 «Falta la parte '…'» | la parte binaria no viene, o viene como campo de texto (sin `filename`) | en un flujo, sube con `s.Upload(...)`: manda el binario como archivo |
| Una subida aceptada con un binario que no es del tipo declarado | el handler comprobó `AllowsContentType` | `AllowsContent(bytes, tipo)`: el tipo Y la firma |
