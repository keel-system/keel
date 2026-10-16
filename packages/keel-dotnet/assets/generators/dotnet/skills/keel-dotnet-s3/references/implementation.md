# S3/MinIO — el adaptador `S3FileStorage`

Complementa «Lo que te toca» del SKILL.md. Todo lo que usa el SDK vive en `src/<Raíz>.Infrastructure/Storage/`.

## El cliente

Uno por proceso (el adaptador es singleton), construido con la configuración que ya inyecta build (`StorageSettings`):

```csharp
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

private readonly AmazonS3Client client = new(
    new BasicAWSCredentials(settings.AccessKey, settings.SecretKey),
    settings.Endpoint is { } endpoint
        // MinIO: el endpoint del compose y path-style. S3 real: sin endpoint (lo resuelve el SDK por región).
        ? new AmazonS3Config { ServiceURL = endpoint, ForcePathStyle = settings.PathStyleAccess, AuthenticationRegion = settings.Region }
        : new AmazonS3Config { RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(settings.Region), ForcePathStyle = settings.PathStyleAccess });
```

Créalo sin llamar a nada: el servicio tiene que arrancar aunque el almacén no esté.

## Subida, lectura y borrado

```csharp
public async Task<StoredObject> Upload(string bucket, string key, ReadOnlyMemory<byte> content, string contentType, CancellationToken cancellationToken = default)
{
    var policy = policies.ForBucket(bucket);
    using var body = new MemoryStream(content.ToArray(), writable: false);
    await client.PutObjectAsync(new PutObjectRequest { BucketName = policy.Bucket, Key = key, InputStream = body, ContentType = contentType }, cancellationToken);
    // Público: la URL estable; privado: null (la URL caduca y se pide al leer con SignedUrl).
    return new StoredObject(key, policy.PublicRead ? PublicUrl(bucket, key) : null, contentType, content.Length);
}

public async Task<byte[]> Download(string bucket, string key, CancellationToken cancellationToken = default)
{
    using var response = await client.GetObjectAsync(policies.ForBucket(bucket).Bucket, key, cancellationToken);
    using var buffer = new MemoryStream();
    await response.ResponseStream.CopyToAsync(buffer, cancellationToken);
    return buffer.ToArray();
}

public Task Delete(string bucket, string key, CancellationToken cancellationToken = default) =>
    client.DeleteObjectAsync(policies.ForBucket(bucket).Bucket, key, cancellationToken);
```

`PublicUrl` (solo con un bucket público; no lo escribas si el puerto no lo declara) se compone desde
`settings.PublicBaseUrl` —la que alcanza el CONSUMIDOR, no el `Endpoint` con el que hablas tú: en compose
`http://minio:9000` no lo resuelve nadie fuera de la red—:

```csharp
public string PublicUrl(string bucket, string key) => $"{settings.PublicBaseUrl}/{policies.ForBucket(bucket).Bucket}/{key}";
```

## URL firmada (`SignedUrl`, solo con un bucket privado)

```csharp
public Task<string> SignedUrl(string bucket, string key, CancellationToken cancellationToken = default)
{
    var policy = policies.ForBucket(bucket);
    return client.GetPreSignedURLAsync(new GetPreSignedUrlRequest
    {
        BucketName = policy.Bucket,
        Key = key,
        Verb = HttpVerb.GET,
        Expires = DateTime.UtcNow.AddSeconds(policy.SignedUrlTtlSeconds())
    });
}
```

**La caducidad no la eliges tú**: es `signedUrlTtlSeconds` del diseño, que llega por `BucketPolicy`. Si el bucket no la
declara, `SignedUrlTtlSeconds()` lanza con el motivo: eso es un `designGap`, no un default que rellenar. La firma
incluye el host: un enlace firmado contra `http://minio:9000` no lo abre nadie fuera del compose. Con un endpoint `http`,
el SDK firma en `https` salvo que `AmazonS3Config.UseHttp = true` o el `ServiceURL` lleve el esquema: compruébalo.

## Errores

Fuera de `Infrastructure` no se ve ninguna clase del SDK. Una clave que no existe (`AmazonS3Exception` con
`ErrorCode == "NoSuchKey"`) es el error que declare la operación que lee; si no declara ninguno, `NotFoundException` con
code `FILE_NOT_FOUND` y repórtalo en `designGaps`. Un almacén caído (conexión rechazada, 5xx agotados los reintentos del
SDK) es el error que el diseño declare para ello (típicamente un 503) o, si no declara ninguno, un fallo técnico (500):
nunca «no encontrado». La cancelación de la petición (`OperationCanceledException`) se deja pasar.

## Aprovisionamiento de buckets (`settings.EnsureBucketsOnStartup`)

En local los crea el sidecar `minio-init` de `infra/` (y les aplica la lectura pública). El adaptador lleva su propio
aprovisionamiento idempotente para los entornos reales, **tras la guarda** que build siembra por perfil: `true` en local,
`false` en test, `${STORAGE_ENSURE_BUCKETS:true}` en develop y `${STORAGE_ENSURE_BUCKETS:false}` en producción (crear
buckets exige permisos que la plataforma no suele conceder). Va en el `StartAsync` del propio `S3FileStorage`, que build
ya deja como `IHostedService` con la guarda puesta y **registrado** en `StorageRegistration` (no toques el registro);
nunca en el constructor, y que un fallo se registre y no tumbe el arranque:

```csharp
public async Task StartAsync(CancellationToken cancellationToken)
{
    if (!settings.EnsureBucketsOnStartup) return;
    foreach (var name in settings.Buckets.Keys)
    {
        var policy = policies.ForBucket(name);
        // ¿Existe? (Amazon.S3.Util.AmazonS3Util.DoesS3BucketExistV2Async); si no, PutBucketAsync;
        // si es público, PutBucketPolicyAsync con s3:GetObject para "*".
    }
}
```

Un bucket creado NO es público: S3 y MinIO los crean privados. Sin la política de lectura, la subida responde 201 y la
lectura directa 403.

## Checklist

- [ ] El bucket físico sale de `policies.ForBucket(bucket).Bucket`, nunca de un literal.
- [ ] Implementas exactamente los métodos que declara el puerto, ni uno más.
- [ ] La subida valida con `AllowsSize` y `AllowsContent` en el caso de uso, antes de llamar al puerto.
- [ ] La clave del objeto la genera el servicio; el nombre del cliente no entra en ella.
- [ ] La URL firmada caduca en `SignedUrlTtlSeconds()`; la pública se compone desde `PublicBaseUrl`.
- [ ] El aprovisionamiento va en el `StartAsync` del adaptador, tras `EnsureBucketsOnStartup`; el registro no se toca.
- [ ] Ninguna clase del SDK sale de `src/<Raíz>.Infrastructure/Storage/`.
