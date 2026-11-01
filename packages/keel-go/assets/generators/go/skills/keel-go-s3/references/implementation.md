# Implementación del adaptador S3 (`internal/infrastructure/storage/storage.go`)

El tipo `Storage` ya está construido y cableado: `client` (un `*s3.Client` de `NewClient`, con credenciales, región,
endpoint y path-style puestos), `settings` (lo leído de `storage.yaml`) y `policies` (la política de cada bucket). Tú
escribes el cuerpo de cada método. El bucket que recibe cada método es el LÓGICO del diseño (`domain.Bucket<Nombre>`):
el físico sale de `s.policies.ForBucket(bucket)` → `Bucket()`.

## Subir

```go
func (s *Storage) Upload(ctx context.Context, bucket, key string, content []byte, contentType string) (domain.StoredObject, error) {
	policy, err := s.policies.ForBucket(bucket)
	if err != nil {
		return domain.StoredObject{}, err
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(policy.Bucket()),
		Key:           aws.String(key),
		Body:          bytes.NewReader(content),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(int64(len(content))),
	})
	if err != nil {
		return domain.StoredObject{}, fmt.Errorf("subir %s/%s: %w", policy.Bucket(), key, err)
	}
	stored := domain.StoredObject{StorageKey: key, ContentType: contentType, SizeBytes: int64(len(content))}
	if policy.PublicRead() {
		url, err := s.PublicURL(bucket, key)
		if err != nil {
			return domain.StoredObject{}, err
		}
		stored.URL = &url
	}
	return stored, nil
}
```

- Un `bytes.Reader` se puede rebobinar: el SDK lo necesita para firmar y para reintentar.
- `PublicURL` existe solo si el diseño declara algún bucket público: en un servicio con solo buckets privados, la rama
  `PublicRead()` no hace falta (y `PublicURL` no compila).

## Leer

```go
func (s *Storage) Download(ctx context.Context, bucket, key string) ([]byte, error) {
	policy, err := s.policies.ForBucket(bucket)
	if err != nil {
		return nil, err
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(policy.Bucket()), Key: aws.String(key)})
	if err != nil {
		return nil, fmt.Errorf("leer %s/%s: %w", policy.Bucket(), key, err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}
```

Un objeto que no existe llega como `*types.NoSuchKey` (`github.com/aws/aws-sdk-go-v2/service/s3/types`, con
`errors.As`): si el diseño declara qué responde una lectura de un binario que falta, tradúcelo ahí.

## URLs

**Pública** (bucket `public`): se COMPONE, no se pide al almacén. Con la base que ve el consumidor y el bucket en la
ruta (MinIO en local y un CDN que reescriba igual en producción):

```go
func (s *Storage) PublicURL(bucket, key string) (string, error) {
	policy, err := s.policies.ForBucket(bucket)
	if err != nil {
		return "", err
	}
	return s.settings.PublicBaseURL + "/" + policy.Bucket() + "/" + url.PathEscape(key), nil
}
```

Nunca `s.settings.Endpoint`: es la dirección interna con la que el servicio habla con el almacén (`http://minio:9000`
dentro del compose), y el cliente que recibe la respuesta no la alcanza.

**Firmada** (bucket `private`): caduca con lo que DECLARA el diseño, no con un número del adaptador:

```go
func (s *Storage) SignedURL(ctx context.Context, bucket, key string) (string, error) {
	policy, err := s.policies.ForBucket(bucket)
	if err != nil {
		return "", err
	}
	ttl, err := policy.SignedURLTTL()
	if err != nil {
		return "", err
	}
	signed, err := s3.NewPresignClient(s.client).PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(policy.Bucket()),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("firmar %s/%s: %w", policy.Bucket(), key, err)
	}
	return signed.URL, nil
}
```

## Borrar

`DeleteObject` sobre un objeto que no existe no falla en S3 ni en MinIO: devuelve su error solo si el almacén lo da.

```go
func (s *Storage) Delete(ctx context.Context, bucket, key string) error {
	policy, err := s.policies.ForBucket(bucket)
	if err != nil {
		return err
	}
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(policy.Bucket()), Key: aws.String(key)}); err != nil {
		return fmt.Errorf("borrar %s/%s: %w", policy.Bucket(), key, err)
	}
	return nil
}
```

## Aprovisionar los buckets (`EnsureBuckets`)

Solo con `s.settings.EnsureBucketsOnStartup` (sí en `local` y `develop`, no en `test` ni en `production`). Por cada
bucket de `s.settings.Buckets`: `HeadBucket`; si no existe, `CreateBucket`; y si su `Visibility` es `public`, una
política de lectura anónima (`PutBucketPolicy` con `s3:GetObject` sobre `arn:aws:s3:::<bucket>/*`). Un error se
devuelve: el arranque lo registra y sigue, porque un almacén que no contesta no tumba el servicio (las subidas fallarán
con su error, que es lo que mide un escenario de almacén caído).

## Errores y plazos

- El SDK reintenta por su cuenta (tres intentos): una subida es un `PUT` idempotente, así que es seguro.
- Todo método recibe `ctx`: el plazo lo pone quien llama. No crees contextos nuevos dentro del adaptador.
- Envuelve el error con `%w` y el bucket y la clave: el log del caso de uso es lo que se lee cuando algo falla.
