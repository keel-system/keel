---
name: keel-spring-s3
description: Guía de implementación de object storage S3 (MinIO en dev, Amazon S3 en prod, mismo SDK) en un proyecto generado por keel-spring — bean del cliente, adaptador FileStorage y validación. Usar cuando keel-stack.json declara storage "minio" o "s3".
---

# Object storage S3 (storage: `minio` o `s3`)

MinIO y S3 hablan el mismo protocolo: un único adaptador sirve para dev (MinIO)
y prod (S3); la diferencia (endpoint / path-style) vive en `storage.yaml` por perfil.

## Antes de empezar

- Aplica solo si `keel-stack.json` declara `"storage": "minio"` o `"storage": "s3"`.
- Lee `specs/storage.keel.yaml`: buckets, políticas de acceso y validaciones — el diseño es la única fuente de verdad funcional.
- Sigue estrictamente `.claude/conventions/mapping.md`; la estructura de paquetes está en `.claude/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y el puerto (abajo); esta skill cubre solo el código que depende del SDK S3.

## Qué dejó listo build

- `build.gradle`: `software.amazon.awssdk:s3` (AWS SDK v2).
- `parameters/<perfil>/storage.yaml`: provider, endpoint, región, credenciales, bucket y `path-style-access` por perfil (local apunta al MinIO del compose; test trae valores dummy).
- `infra/docker-compose.yaml`: MinIO (9000 + consola 9001, minioadmin/minioadmin) — solo con `storage: minio`.
- Puerto `FileStorage` en `domain/storage` (upload/download/delete/signedUrl) y el value object `StoredObject` que devuelve `upload`.

## Bean del cliente (`infrastructure/configurations/storage/S3Config`)

```java
@Configuration
public class S3Config {

    @Bean
    public S3Client s3Client(
            @Value("${storage.region}") String region,
            @Value("${storage.access-key}") String accessKey,
            @Value("${storage.secret-key}") String secretKey,
            @Value("${storage.path-style-access:false}") boolean pathStyleAccess,
            @Value("${storage.endpoint:}") String endpoint) {
        S3ClientBuilder builder = S3Client.builder()
                .region(Region.of(region))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(accessKey, secretKey)))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(pathStyleAccess)
                        .build());
        if (endpoint != null && !endpoint.isBlank()) {
            builder = builder.endpointOverride(URI.create(endpoint));
        }
        return builder.build();
    }
}
```

`endpoint` es opcional: MinIO lo define; S3 real lo resuelve el SDK por región.

## Adaptador (`infrastructure/storage/S3FileStorage`)

`@Component` que implementa `FileStorage` inyectando `S3Client` y `@Value("${storage.bucket}")`:

- `upload` → `s3Client.putObject(PutObjectRequest..., RequestBody.fromBytes(content))` y devuelve un `StoredObject`
- `download` → `s3Client.getObjectAsBytes(GetObjectRequest...).asByteArray()`
- `delete` → `s3Client.deleteObject(DeleteObjectRequest...)`
- `signedUrl` → `S3Presigner` con la política de expiración del diseño (buckets privados).

`StoredObject(storageKey, url, contentType, sizeBytes)` es lo que el agregado
guarda; siempre lleva `storageKey`, que es lo que identifica el objeto después.
El campo `url` depende del bucket: con acceso público, la URL estable del
objeto; con acceso firmado, **null** — la URL caduca, así que no se persiste y
se pide al leer con `signedUrl(storageKey)`.

Valida content-type y tamaño según los `buckets` declarados en `storage.keel.yaml`
antes de subir (error de negocio, no excepción genérica).

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/storage.yaml` o el tuning del SDK (endpoint/path-style, retries, límites de subida) |
| `references/implementation.md` | Al escribir el adaptador (claves de objeto, validación de content-type, presigned URLs, streaming) |
| `references/troubleshooting.md` | Si hay SignatureDoesNotMatch, 403 en presigned, NoSuchBucket o fallos solo contra S3 real |

## Validación

Desde devtools: `mc alias set local http://minio:9000 minioadmin minioadmin && mc ready local`;
`mc ls local/<bucket>` para inspeccionar objetos subidos.
Recetas completas en `.claude/conventions/infra-validation.md`.
