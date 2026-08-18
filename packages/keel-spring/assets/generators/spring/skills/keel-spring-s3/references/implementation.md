# S3/MinIO — patrones de implementación

Complementa el bean y el adaptador del SKILL.md. El puerto `FileStorage` y el
value object `StoredObject` que devuelve `upload` ya existen en `domain/storage`;
qué métodos declara el puerto depende de la visibilidad de los buckets del diseño
(ver abajo).

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

Mapea las excepciones del SDK a errores del dominio en el adaptador: fuera de
`infrastructure` no debe verse ninguna clase `software.amazon.*`. `S3Exception`
5xx/timeout agotados los reintentos del SDK → deja subir la excepción como
error técnico (500), no lo conviertas en «no encontrado».

**Qué lanzar cuando la clave no existe.** Aplica solo si el puerto declara `download`, y
`build` lo declara únicamente cuando el diseño tiene algún bucket `visibility: private`: sobre
un bucket público el binario se lee del borde y ningún caso de uso pide los bytes al servicio,
así que ahí no hay método que implementar ni error que echar en falta. La capa `storage` del
DSL declara buckets y
políticas, **no errores**: no hay ningún `FILE_NOT_FOUND` que copiar de ahí, y buscarlo lleva
al reflejo equivocado de tirar un `IllegalStateException` —que `ApiExceptionHandler` traduce a
500, es decir «el servidor está roto» cuando lo cierto es «esa clave no está»—. La jerarquía:

1. Si **la operación que invoca `download`** declara un error para ese caso en sus `errors`,
   lanza su `<PascalCode>Error`: es el contrato público y lo genera `build`.
2. Si no lo declara, usa la subclase base que `build` genera siempre, con un `code`
   convencional:

```java
try {
    return s3Client.getObjectAsBytes(b -> b.bucket(bucket).key(key)).asByteArray();
} catch (NoSuchKeyException e) {
    // Sin error declarado en el diseño: subclase base + code convencional. Sigue siendo
    // error de dominio (404), no filtra software.amazon.* y no inventa una clase nueva.
    throw new NotFoundException("No existe el archivo " + key, "FILE_NOT_FOUND", 404, null);
}
```

Y repórtalo en `designGaps`: que un `code` del contrato salga de una convención del generador
en vez del diseño es exactamente lo que ese bloque existe para señalar.

## URLs de lectura

**El puerto ya te dice cuál de las dos escribir**, porque sus métodos de lectura
son condicionales por visibilidad:

| El diseño declara | El puerto trae | Escribes |
|---|---|---|
| algún bucket `public` | `publicUrl(bucket, key)` | Concatenación desde `public-base-url`. Sin SDK, sin firma, sin presigner |
| algún bucket `private` | `signedUrl(bucket, key)` y `download(bucket, key)` | El presigner de abajo |
| ambos | los tres | ambas cosas, cada una para su bucket — de ahí el parámetro `bucket` |

No hay caso en que un método haga el trabajo del otro: si solo hay buckets
públicos, `signedUrl` **no existe** y no tienes que decidir nada; el `@Bean
S3Presigner` sobra y con él la configuración (endpoint, region, path-style) que
habría que mantener correcta para nada.

### `publicUrl`

```java
@Override
public String publicUrl(String bucket, String key) {
    return "%s/%s/%s".formatted(
            properties.publicBaseUrl(), policies.forBucket(bucket).bucket(), key);
}
```

`storage.public-base-url` es la base que alcanza **el consumidor** — el CDN o el
borde en un entorno real, `http://localhost:9000` en local. **No es `endpoint`**:
ese es con quien hablas tú, y en compose es `http://minio:9000`, un nombre de red
que fuera del compose no resuelve. Una URL compuesta con el endpoint interno se
guarda, se serializa y solo se descubre rota cuando alguien abre la imagen.

Quien la consume es el `<Entidad>ApplicationMapper` que genera `build`: la key
llega al `ResponseDto` ya resuelta, sin que ni el handler ni el controller
intervengan. Tú solo pones el adaptador.

### Presigned URLs (`signedUrl`)

```java
try (S3Presigner presigner = S3Presigner.builder()
        .region(region).credentialsProvider(creds)
        .endpointOverride(endpoint)          // solo MinIO, como el cliente
        .serviceConfiguration(S3Configuration.builder()
                .pathStyleAccessEnabled(pathStyle).build())
        .build()) {
    return presigner.presignGetObject(p -> p
            .getObjectRequest(g -> g.bucket(bucket).key(key))
            .signatureDuration(policies.forBucket(bucket).signedUrlTtl()))
        .url().toString();
}
```

- **La expiración no la eliges tú**: sale de `signedUrlTtlSeconds` del bucket, que el
  diseño declara y build ya dejó en `parameters/<perfil>/storage.yaml` y en
  `BucketPolicy#signedUrlTtl()`. Es contrato con quien recibe el enlace —cuánto tiene
  para descargar, y durante cuánto le sirve a quien se lo reenvíe—, así que una
  constante aquí (o un `@Value` propio) devuelve al código una decisión que el diseño
  acaba de sacar de él. Si el bucket no la declara, `signedUrlTtl()` falla en caliente
  con el motivo: eso es `designGap`, no un default que rellenar.
  Para uploads directos del cliente, `presignPutObject` con content-type fijado
  en la petición firmada — con la misma ventana, por lo mismo.
- El presigner puede ser un bean singleton (mismo ciclo que el cliente) en
  vez de try-with-resources por llamada si `signedUrl` es frecuente.
- **Ojo con el host en local**: una URL firmada con `http://minio:9000` no es
  alcanzable desde fuera del compose. El endpoint del presigner debe ser el
  que verá el consumidor (`http://localhost:9000` si valida desde el host);
  la firma incluye el host — no se puede reescribir después.

## Aprovisionamiento de buckets: `storage.ensure-buckets-on-startup`

En local **no lo creas tú ni añadas scripts a `infra/`**: el sidecar `minio-init`
del `infra/docker-compose.yaml` que genera `keel-spring build` ya crea cada bucket
declarado al levantar la infraestructura.

Aun así el adaptador lleva su propio aprovisionamiento idempotente, porque en un
entorno real no hay compose que prepare nada. Pero **no es incondicional**: si lo
fuera, arrancar el contexto donde no hay S3 alcanzable —empezando por el perfil
`test` que genera el propio `build`, con H2 y sin contenedores— saldría a la red y
el arranque fallaría. Quién lo hace es una decisión de **entorno**, y viaja en la
config que `build` siembra:

| Perfil | `storage.ensure-buckets-on-startup` | Por qué |
|---|---|---|
| `local` | `true` | Redundante con `minio-init`, pero cubre a quien levante la infra a mano |
| `test` | `false` | No hay nada a lo que llamar; el contexto debe cargar sin red |
| `develop` | `${STORAGE_ENSURE_BUCKETS:true}` | Entorno efímero, normalmente sin plataforma que provisione |
| `production` | `${STORAGE_ENSURE_BUCKETS:false}` | Crear buckets exige `s3:CreateBucket`/`PutBucketPolicy`, permisos que no conviene pedir: lo normal es que el bucket lo provea la plataforma. Opt-in para quien no la tenga |

La guarda va **dentro** del componente, leída con `@Value`, y el punto de enganche
es un `@PostConstruct` de un componente propio — no lo metas en el constructor del
adaptador ni en el del bean `S3Client`: un fallo de red durante la construcción del
bean deja el contexto sin arrancar y sin mensaje útil.

```java
@Component
public class S3BucketBootstrap {

    private static final Logger log = LoggerFactory.getLogger(S3BucketBootstrap.class);

    private final S3Client s3Client;
    private final StoragePolicies policies;
    private final boolean ensureOnStartup;

    public S3BucketBootstrap(S3Client s3Client, StoragePolicies policies,
            @Value("${storage.ensure-buckets-on-startup:false}") boolean ensureOnStartup) {
        this.s3Client = s3Client;
        this.policies = policies;
        this.ensureOnStartup = ensureOnStartup;
    }

    @PostConstruct
    void ensureBuckets() {
        // Sin esta guarda, arrancar en un perfil sin S3 alcanzable (test, o
        // cualquier entorno donde la plataforma ya provee el bucket) sale a la red
        // y tumba el contexto. El default `false` es deliberado: si la propiedad
        // faltara, lo seguro es no tocar nada.
        if (!ensureOnStartup) {
            log.debug("storage.ensure-buckets-on-startup=false: no se aprovisionan buckets");
            return;
        }
        // Una constante por bucket declarado en storage.keel.yaml (las genera build
        // en el puerto StoragePolicies): nunca literales.
        for (String name : List.of(StoragePolicies.<BUCKET>, /* … */)) {
            BucketPolicy policy = policies.forBucket(name);
            ensureBucket(policy.bucket());
            if (policy.publicRead()) {
                ensurePublicRead(policy.bucket());
            }
        }
    }

    private void ensureBucket(String bucket) {
        try {
            s3Client.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
        } catch (NoSuchBucketException e) {
            s3Client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    // ensurePublicRead: ver la sección siguiente.
}
```

`headBucket` + `createBucket` en vez de `createBucket` a secas: crear un bucket que
ya existe responde `BucketAlreadyOwnedByYou` en S3 real pero `BucketAlreadyExists`
contra otros compatibles, y distinguir por excepción es más frágil que preguntar.

## `visibility: public` — crear el bucket **no** lo hace público

S3 y MinIO crean los buckets **privados**. Un bucket declarado
`visibility: public` en `storage.keel.yaml` (lo verás en la config generada, en
`storage.buckets.<bucket>.visibility`) necesita además una **bucket policy de
lectura anónima**; sin ella el síntoma es engañoso: la subida responde `201`, el
evento se publica y todo parece bien, pero el `GET` directo a la URL devuelve
`403` y el Then del escenario falla.

En el entorno de prueba **ya está hecho**: `keel-spring build` genera el sidecar
`minio-init` en `infra/docker-compose.yaml`, que al levantar la infraestructura
ejecuta, por cada bucket declarado,

```bash
mc mb --ignore-existing local/<bucket>
mc anonymous set download local/<bucket>   # solo los visibility: public
```

y `infra/validate-infra.sh` comprueba que quedaron así. No lo repliques a mano
ni edites el compose para ello.

Lo que sigue siendo tuyo es aplicarla desde la app, de forma **idempotente y en
cada arranque en que la guarda de la sección anterior lo permita** — no solo
cuando el bucket se acaba de crear: los buckets preexistentes también deben quedar
bien —, para cada bucket con `visibility: public`:

```java
private void ensurePublicRead(String bucket) {
    String policy = """
            {"Version":"2012-10-17","Statement":[{
              "Effect":"Allow","Principal":"*","Action":["s3:GetObject"],
              "Resource":["arn:aws:s3:::%s/*"]}]}
            """.formatted(bucket);
    s3Client.putBucketPolicy(PutBucketPolicyRequest.builder()
            .bucket(bucket).policy(policy).build());
}
```

`putBucketPolicy` sobrescribe la policy completa, así que es idempotente por
naturaleza: llamarlo en cada arranque deja siempre el mismo estado. Los buckets
`visibility: private` **no** la llevan — su lectura va por `signedUrl` o mediada
por el servicio.

Sí: en local eso **reemplaza** el preset `download` que había puesto `minio-init`
por esta policy, que es más restrictiva (solo `s3:GetObject`, sin listado público
del bucket). Es lo correcto y no hay nada que alinear — `infra/validate-infra.sh`
comprueba el **efecto** (un GET anónimo que responde 200), no el nombre del preset.
Si ves un `FALLO` de bucket, contrástalo con una lectura anónima real antes de
tocar nada: un rojo con la lectura en verde es un defecto del sondeo del generador
(va a `blockers`), no de tu adaptador.

## Checklist

- [ ] Validación de content-type (real, no declarado) y tamaño → errores del diseño.
- [ ] Claves con UUID, sin nombre del cliente ni PII.
- [ ] `NoSuchKeyException` → error de dominio (el `<PascalCode>Error` de la operación si lo declara; si no, `NotFoundException` con `code` `FILE_NOT_FOUND`, **nunca `IllegalStateException`**); ninguna clase del SDK fuera de infrastructure.
- [ ] Presigned con expiración del diseño y host alcanzable por el consumidor.
- [ ] Nombre de bucket leído del puerto `StoragePolicies` (`forBucket(...).bucket()`), nunca literal en el código ni por `@Value("${storage.bucket}")`, que ya no existe.
- [ ] `maxSizeMb` y `allowedContentTypes` consultados con `BucketPolicy`, no copiados como constantes en el caso de uso.
- [ ] En local, el bucket lo prepara `minio-init` (compose); la app lo asegura igualmente para entornos reales.
- [ ] El aprovisionamiento de la app va tras la guarda `@Value("${storage.ensure-buckets-on-startup:false}")` y en un `@PostConstruct`, nunca en el constructor de un bean. Verificable: `PROFILE=test` (o `./gradlew test`) debe arrancar el contexto sin tocar la red.
- [ ] Cada bucket `visibility: public` con su bucket policy de lectura anónima aplicada (idempotente, también sobre buckets ya existentes).
