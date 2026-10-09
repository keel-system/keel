# S3/MinIO — el adaptador `S3FileStorage`

Complementa «Lo que te toca» del SKILL.md. Todo lo que importa el SDK vive en `src/infrastructure/storage/`.

## El cliente

Uno por proceso, construido con la configuración que ya inyecta build (`StorageSettings`):

```ts
import { S3Client } from '@aws-sdk/client-s3';

this.client = new S3Client({
  region: settings.region,
  credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
  // MinIO: el endpoint del compose y path-style. S3 real: sin endpoint (lo resuelve el SDK por región).
  ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
  forcePathStyle: settings.pathStyleAccess
});
```

Créalo en el constructor sin llamar a nada: el servicio tiene que arrancar aunque el almacén no esté.

## Subida, lectura y borrado

```ts
async upload(bucket: string, key: string, content: Uint8Array, contentType: string): Promise<StoredObject> {
  const policy = this.policies.forBucket(bucket);
  await this.client.send(new PutObjectCommand({ Bucket: policy.bucket, Key: key, Body: content, ContentType: contentType, ContentLength: content.length }));
  // Público: la URL estable; privado: null (la URL caduca y se pide al leer con signedUrl).
  return new StoredObject(key, policy.publicRead ? this.publicUrl(bucket, key) : null, contentType, content.length);
}

async download(bucket: string, key: string): Promise<Uint8Array> {
  const response = await this.client.send(new GetObjectCommand({ Bucket: this.policies.forBucket(bucket).bucket, Key: key }));
  return await response.Body!.transformToByteArray();
}

async delete(bucket: string, key: string): Promise<void> {
  await this.client.send(new DeleteObjectCommand({ Bucket: this.policies.forBucket(bucket).bucket, Key: key }));
}
```

`publicUrl` (solo con un bucket público; sin `this.publicUrl` si no existe) se compone desde
`settings.publicBaseUrl` —la que alcanza el CONSUMIDOR, no el `endpoint` con el que hablas tú: en compose
`http://minio:9000` no lo resuelve nadie fuera de la red—:

```ts
publicUrl(bucket: string, key: string): string {
  return `${this.settings.publicBaseUrl}/${this.policies.forBucket(bucket).bucket}/${key}`;
}
```

## URL firmada (`signedUrl`, solo con un bucket privado)

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

async signedUrl(bucket: string, key: string): Promise<string> {
  const policy = this.policies.forBucket(bucket);
  return getSignedUrl(this.client, new GetObjectCommand({ Bucket: policy.bucket, Key: key }), { expiresIn: policy.signedUrlTtlSeconds() });
}
```

**La caducidad no la eliges tú**: es `signedUrlTtlSeconds` del diseño, que llega por `BucketPolicy`. Si el bucket
no la declara, `signedUrlTtlSeconds()` lanza con el motivo: eso es un `designGap`, no un default que rellenar. La
firma incluye el host: un enlace firmado contra `http://minio:9000` no lo abre nadie fuera del compose.

## Errores

Fuera de `infrastructure` no se ve ninguna clase del SDK. Una clave que no existe (`NoSuchKey`) es el error que
declare la operación que lee; si no declara ninguno, `NotFoundException` con `code: 'FILE_NOT_FOUND'` y repórtalo
en `designGaps`. Un almacén caído (conexión rechazada, 5xx agotados los reintentos del SDK) es el error que el
diseño declare para ello (típicamente un 503) o, si no declara ninguno, un fallo técnico (500): nunca «no
encontrado».

## Aprovisionamiento de buckets (`settings.ensureBucketsOnStartup`)

En local los crea el sidecar `minio-init` de `infra/` (y les aplica la lectura pública). El adaptador lleva su
propio aprovisionamiento idempotente para los entornos reales, **tras la guarda** que build siembra por perfil:
`true` en local, `false` en test, `${STORAGE_ENSURE_BUCKETS:true}` en develop y `${STORAGE_ENSURE_BUCKETS:false}`
en producción (crear buckets exige permisos que la plataforma no suele conceder). Hazlo en `onModuleInit` (la
clase implementa `OnModuleInit` de `@nestjs/common`), nunca en el constructor, y que un fallo se registre y no
tumbe el arranque:

```ts
async onModuleInit(): Promise<void> {
  if (!this.settings.ensureBucketsOnStartup) return;
  for (const name of Object.keys(this.settings.buckets)) {
    const policy = this.policies.forBucket(name);
    // HeadBucket; si no existe, CreateBucket; si es público, PutBucketPolicy con s3:GetObject para "*".
  }
}
```

Un bucket creado NO es público: S3 y MinIO los crean privados. Sin la política de lectura, la subida responde
201 y la lectura directa 403.

## Checklist

- [ ] El bucket físico sale de `policies.forBucket(bucket).bucket`, nunca de un literal.
- [ ] Implementas exactamente los métodos que declara el puerto, ni uno más.
- [ ] La subida valida con `allowsContent` y `allowsSize` en el caso de uso, antes de llamar al puerto.
- [ ] La clave del objeto la genera el servicio; el nombre del cliente no entra en ella.
- [ ] La URL firmada caduca en `signedUrlTtlSeconds()`; la pública se compone desde `publicBaseUrl`.
- [ ] El aprovisionamiento va tras `ensureBucketsOnStartup` y en `onModuleInit`.
- [ ] Ninguna clase del SDK sale de `src/infrastructure/storage/`.
