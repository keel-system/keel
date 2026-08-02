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
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md`; la estructura de paquetes está en `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó dependencias, config por perfil, compose y el puerto (abajo); esta skill cubre solo el código que depende del SDK S3.

## Qué dejó listo build

- `build.gradle`: `software.amazon.awssdk:s3` (AWS SDK v2).
- `parameters/<perfil>/storage.yaml`: provider, endpoint, región, credenciales, `path-style-access` y `ensure-buckets-on-startup` por perfil (local apunta al MinIO del compose; test trae valores de juguete, endpoint local y la guarda a `false`), más la **política de cada bucket del diseño** bajo `storage.buckets.<bucket>`: `visibility`, `max-size-mb` y `allowed-content-types`. Al código entra por el puerto `StoragePolicies`/`BucketPolicy` que genera `build`; no la re-derives ni la hardcodees.
- `spring.servlet.multipart.max-file-size` / `max-request-size` en `application.yaml`, con **holgura** sobre el mayor `maxSizeMb` declarado (sin ningún límite Spring corta en 1MB; con el límite exacto, Tomcat emitiría el 413 antes del caso de uso y ninguna guarda anterior del diseño podría precederlo). El límite de negocio lo comprueba el caso de uso, en el orden que fija el diseño.
- `ApiExceptionHandler` con los handlers de `MaxUploadSizeExceededException` (413 `FILE_TOO_LARGE`) y `MissingServletRequestPartException` (400): no los redeclares.
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

`@Component` que implementa `FileStorage` inyectando `S3Client` y el puerto
`StoragePolicies` (lo genera `build`; su implementación `StorageProperties` bindea
`storage.buckets.*`). **No hay clave `storage.bucket` global**: el nombre físico sale
siempre de `policies.forBucket(StoragePolicies.<BUCKET>).bucket()`, con la constante
del bucket que el diseño declara.

- `upload` → `s3Client.putObject(PutObjectRequest..., RequestBody.fromBytes(content))` y devuelve un `StoredObject`
- `download` → `s3Client.getObjectAsBytes(GetObjectRequest...).asByteArray()`
- `delete` → `s3Client.deleteObject(DeleteObjectRequest...)`
- `signedUrl` → `S3Presigner` con la política de expiración del diseño (buckets privados).

`StoredObject(storageKey, url, contentType, sizeBytes)` es lo que el agregado
guarda; siempre lleva `storageKey`, que es lo que identifica el objeto después.
El campo `url` depende del bucket: con acceso público, la URL estable del
objeto; con acceso firmado, **null** — la URL caduca, así que no se persiste y
se pide al leer con `signedUrl(storageKey)`.

Valida content-type y tamaño **en el caso de uso**, antes de llamar al puerto, para
poder lanzar el error declarado (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`) y no
una excepción genérica del SDK. Los valores no se escriben a mano: el handler
inyecta `StoragePolicies` y pregunta.

```java
BucketPolicy policy = policies.forBucket(StoragePolicies.PRODUCT_IMAGES);
if (!policy.allowsContentType(contentType)) throw new UnsupportedContentTypeError(...);
if (!policy.allowsSize(content.length)) throw new FileTooLargeError(...);
```

Que la aplicación pueda hacer esto sin `@Value` es justo el motivo de que el puerto
exista: `maxSizeMb` y `allowedContentTypes` viven en `storage.keel.yaml`, y copiarlos
como literales en el handler crea un espejo que nadie sincroniza cuando el diseño
cambia.

**Nombre físico del bucket**: sale de la config, nunca lo inventes. Cada bucket
declarado en `storage.keel.yaml` tiene su nombre real en
`storage.buckets.<nombreDelDiseño>.bucket` del fragmento
`parameters/<perfil>/storage.yaml`, y lo devuelve `BucketPolicy.bucket()`. Es el
contrato con el sidecar `minio-init` de `infra/docker-compose.yaml`, que ya ha creado
exactamente esos buckets: si el adaptador usa otro nombre, sube a un bucket que nadie
preparó.

**Bucket `visibility: public`**: crearlo no lo hace público — S3 y MinIO los
crean privados. En el entorno de prueba la policy de lectura anónima ya la
aplica `minio-init`, y `infra/validate-infra.sh` lo comprueba. Aun así la app
lleva su propio `ensureBucket`/`ensurePublicRead` idempotente para los entornos
reales, donde no hay compose que lo haga y sin ello la subida responde `201` y la
lectura directa `403`.

Pero **no es incondicional**: va tras la guarda `storage.ensure-buckets-on-startup`
que `build` siembra por perfil (`false` en `test`, opt-in en production). Sin ella,
arrancar donde no hay S3 alcanzable —empezando por el perfil `test`, con H2 y sin
contenedores— sale a la red y tumba el contexto. Receta completa, con la guarda y
el punto de enganche, en `references/implementation.md`.

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
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
