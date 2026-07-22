// Object storage (capa storage). Genera de forma determinista el puerto de
// dominio FileStorage y su adaptador S3 (AWS SDK v2). MinIO y S3 hablan el mismo
// protocolo S3: el único cambio (endpoint / path-style) vive en storage.yaml por
// perfil, así que un ÚNICO adaptador sirve para dev (MinIO) y prod (S3). Por eso
// upload/download/delete son deterministas-correctos; solo signedUrl (URL
// prefirmada = política de negocio, buckets privados) queda como hueco explícito.

import { javaFile, javaPath, subPackage } from './render.js';

const DOMAIN_PKG = 'domain.storage';
const ADAPTER_PKG = 'infrastructure.storage';
const CONFIG_PKG = 'infrastructure.configurations.storage';

export function generate(model) {
  if (!model.layersPresent.storage) return [];
  return [renderPort(model), renderConfig(model), renderAdapter(model)];
}

// Puerto de salida puro (dominio): sin dependencias de infraestructura.
function renderPort(model) {
  const body = `/**
 * Puerto de almacenamiento de archivos. La implementación (S3/MinIO) vive en
 * infrastructure; el dominio solo depende de esta interfaz.
 */
public interface FileStorage {

    void upload(String key, byte[] content, String contentType);

    byte[] download(String key);

    void delete(String key);

    String signedUrl(String key);
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'FileStorage'),
    content: javaFile(subPackage(model, DOMAIN_PKG), [], body)
  };
}

// Bean S3Client parametrizado por storage.yaml. endpoint es opcional (MinIO lo
// define; S3 real lo resuelve el SDK por región) → default vacío.
function renderConfig(model) {
  const body = `@Configuration
public class S3Config {

    @Bean
    public S3Client s3Client(
            @Value("\${storage.region}") String region,
            @Value("\${storage.access-key}") String accessKey,
            @Value("\${storage.secret-key}") String secretKey,
            @Value("\${storage.path-style-access:false}") boolean pathStyleAccess,
            @Value("\${storage.endpoint:}") String endpoint) {
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
}`;
  return {
    path: javaPath(model, CONFIG_PKG, 'S3Config'),
    content: javaFile(subPackage(model, CONFIG_PKG), [
      'java.net.URI',
      'org.springframework.beans.factory.annotation.Value',
      'org.springframework.context.annotation.Bean',
      'org.springframework.context.annotation.Configuration',
      'software.amazon.awssdk.auth.credentials.AwsBasicCredentials',
      'software.amazon.awssdk.auth.credentials.StaticCredentialsProvider',
      'software.amazon.awssdk.regions.Region',
      'software.amazon.awssdk.services.s3.S3Client',
      'software.amazon.awssdk.services.s3.S3ClientBuilder',
      'software.amazon.awssdk.services.s3.S3Configuration'
    ], body)
  };
}

function renderAdapter(model) {
  const body = `@Component
public class S3FileStorage implements FileStorage {

    private final S3Client s3Client;
    private final String bucket;

    public S3FileStorage(S3Client s3Client, @Value("\${storage.bucket}") String bucket) {
        this.s3Client = s3Client;
        this.bucket = bucket;
    }

    @Override
    public void upload(String key, byte[] content, String contentType) {
        s3Client.putObject(
                PutObjectRequest.builder().bucket(bucket).key(key).contentType(contentType).build(),
                RequestBody.fromBytes(content));
    }

    @Override
    public byte[] download(String key) {
        return s3Client.getObjectAsBytes(
                GetObjectRequest.builder().bucket(bucket).key(key).build()).asByteArray();
    }

    @Override
    public void delete(String key) {
        s3Client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
    }

    @Override
    public String signedUrl(String key) {
        // TODO (agente): generar una URL prefirmada con S3Presigner (buckets
        //   privados) según la política de expiración del diseño.
        throw new UnsupportedOperationException("TODO (agente): URL prefirmada para " + key);
    }
}`;
  return {
    path: javaPath(model, ADAPTER_PKG, 'S3FileStorage'),
    content: javaFile(subPackage(model, ADAPTER_PKG), [
      'org.springframework.beans.factory.annotation.Value',
      'org.springframework.stereotype.Component',
      'software.amazon.awssdk.core.sync.RequestBody',
      'software.amazon.awssdk.services.s3.S3Client',
      'software.amazon.awssdk.services.s3.model.DeleteObjectRequest',
      'software.amazon.awssdk.services.s3.model.GetObjectRequest',
      'software.amazon.awssdk.services.s3.model.PutObjectRequest',
      `${subPackage(model, DOMAIN_PKG)}.FileStorage`
    ], body)
  };
}
