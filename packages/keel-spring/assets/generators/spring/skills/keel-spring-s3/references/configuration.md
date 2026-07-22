# S3/MinIO — configuración y tuning

Claves del bloque `storage:` en `parameters/<perfil>/storage.yaml` (contrato
propio del proyecto, consumido por `S3Config`/`S3FileStorage`). Build ya dejó
provider, bucket, endpoint (MinIO), región, credenciales y
`path-style-access` con el gradiente por perfil: **no las toques**; esta guía
explica qué significan y qué tuning admite el SDK.

## Por qué cada clave es como es

- `endpoint`: **solo MinIO/compatibles** lo definen; contra S3 real debe no
  existir — el SDK resuelve el endpoint regional. Un endpoint de LocalStack o
  MinIO que se cuela en production rompe la firma.
- `path-style-access: true` con MinIO (`http://minio:9000/<bucket>/<key>`);
  `false` con S3 real (virtual-host style, el path style está deprecado en
  AWS). Si ves `SignatureDoesNotMatch` con MinIO, casi siempre es esto.
- Credenciales: estáticas para MinIO local (minioadmin). En production sobre
  AWS con rol IAM: elimina `access-key`/`secret-key` del fragmento y adapta
  `S3Config` para usar `DefaultCredentialsProvider` cuando no haya claves.

## Tuning del SDK (en `S3Config`, no en YAML)

Solo si los escenarios muestran problemas de latencia/timeout:

```java
S3Client.builder()
    .overrideConfiguration(o -> o
        .apiCallTimeout(Duration.ofSeconds(30))       // techo total por llamada
        .apiCallAttemptTimeout(Duration.ofSeconds(10)) // por intento
        .retryStrategy(RetryMode.STANDARD))            // reintentos con backoff (default sano)
    ...
```

- `RetryMode.STANDARD` ya reintenta errores transitorios (5xx, throttling,
  timeouts de conexión): no escribas bucles de retry alrededor del cliente.
- El `S3Client` es thread-safe y caro de crear: un bean singleton (como genera
  build), jamás un cliente por petición.

## Límites de subida

El tamaño máximo por archivo lo dicta el **diseño** (`buckets[].maxSizeBytes`
o equivalente en `storage.keel.yaml`) y se valida en el adaptador antes de
subir. Además, alinea el límite HTTP de Spring para no recibir cuerpos que
igualmente rechazarás:

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB      # = límite del diseño
      max-request-size: 12MB
```

## Por perfil

- **local**: MinIO del compose (`http://localhost:9000` para la app; desde
  devtools el host es `minio`). Consola web en `localhost:9001`.
- **test**: valores dummy ya generados (el bean se crea sin conectar; los
  tests unitarios no tocan storage real).
- **develop/production**: bucket/credenciales por env var (gradiente); recuerda
  quitar `endpoint` si el destino es S3 real.

## Qué no hacer

- No pongas credenciales reales en ningún YAML (ni en develop como default).
- No crees buckets desde la app en production (permiso innecesario y
  peligroso): el bucket lo provee la plataforma; en local se crea una vez
  (ver `references/implementation.md`).
- No sirvas archivos privados proxyeando bytes por el servicio si el diseño
  pide URLs firmadas: presigned URL y que el cliente descargue directo.
