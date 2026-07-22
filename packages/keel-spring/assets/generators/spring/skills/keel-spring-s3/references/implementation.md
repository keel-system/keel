# S3/MinIO — patrones de implementación

Complementa el bean y el adaptador del SKILL.md. El puerto `FileStorage`
(upload/download/delete/signedUrl) ya existe en `domain/storage`.

## Claves de objeto

- Estructura: `<bucket-lógico>/<entidad>/<id>/<uuid>.<ext>` — el UUID evita
  colisiones y sobrescrituras; el id de entidad permite borrar en cascada.
- **Nunca** uses el nombre de archivo del cliente como clave (colisiones,
  caracteres problemáticos, path traversal con `../`): guárdalo como metadata
  (`originalFilename`) si el diseño lo necesita.
- Nada de PII en la clave (aparece en URLs y logs).

## Upload

```java
s3Client.putObject(PutObjectRequest.builder()
        .bucket(bucket)
        .key(key)
        .contentType(contentType)           // el detectado, no el declarado
        .contentLength((long) content.length)
        .build(),
    RequestBody.fromBytes(content));
```

- **Valida antes de subir** contra los `buckets` del diseño: content-type
  permitido y tamaño máximo → error de negocio declarado (de `domain/errors`),
  no excepción genérica. No te fíes del `Content-Type` que manda el cliente:
  detecta por magic bytes (p. ej. `Tika` si está disponible, o valida al menos
  la firma del formato) cuando el diseño restrinja tipos.
- Archivos grandes (>100MB, si el diseño los permite): no los cargues en un
  `byte[]` — cambia la firma interna a streaming (`RequestBody.fromInputStream`
  con longitud conocida) o usa `S3TransferManager` para multipart.

## Download y errores

```java
try {
    return s3Client.getObjectAsBytes(b -> b.bucket(bucket).key(key)).asByteArray();
} catch (NoSuchKeyException e) {
    throw new FileNotFoundError(key);   // el error declarado en el diseño
}
```

Mapea las excepciones del SDK a errores del dominio en el adaptador: fuera de
`infrastructure` no debe verse ninguna clase `software.amazon.*`. `S3Exception`
5xx/timeout agotados los reintentos del SDK → deja subir la excepción como
error técnico (500), no lo conviertas en «no encontrado».

## Presigned URLs (`signedUrl`)

```java
try (S3Presigner presigner = S3Presigner.builder()
        .region(region).credentialsProvider(creds)
        .endpointOverride(endpoint)          // solo MinIO, como el cliente
        .serviceConfiguration(S3Configuration.builder()
                .pathStyleAccessEnabled(pathStyle).build())
        .build()) {
    return presigner.presignGetObject(p -> p
            .getObjectRequest(g -> g.bucket(bucket).key(key))
            .signatureDuration(Duration.ofMinutes(expiration)))
        .url().toString();
}
```

- Expiración corta y del **diseño** (política del bucket), no un default
  inventado; para uploads directos del cliente, `presignPutObject` con
  content-type fijado en la petición firmada.
- El presigner puede ser un bean singleton (mismo ciclo que el cliente) en
  vez de try-with-resources por llamada si `signedUrl` es frecuente.
- **Ojo con el host en local**: una URL firmada con `http://minio:9000` no es
  alcanzable desde fuera del compose. El endpoint del presigner debe ser el
  que verá el consumidor (`http://localhost:9000` si valida desde el host);
  la firma incluye el host — no se puede reescribir después.

## Bucket en local

El bucket lo crea la preparación del entorno local, una vez (no la app en cada
arranque, y jamás en production):

```bash
mc alias set local http://minio:9000 minioadmin minioadmin && mc mb -p local/<bucket>
```

Déjalo en un script de `infra/` si los escenarios lo necesitan reproducible.

## Checklist

- [ ] Validación de content-type (real, no declarado) y tamaño → errores del diseño.
- [ ] Claves con UUID, sin nombre del cliente ni PII.
- [ ] `NoSuchKeyException` → error de dominio; ninguna clase del SDK fuera de infrastructure.
- [ ] Presigned con expiración del diseño y host alcanzable por el consumidor.
- [ ] Bucket creado por script de infra en local; nunca por la app en production.
