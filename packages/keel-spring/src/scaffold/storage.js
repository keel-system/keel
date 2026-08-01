// Object storage (capa storage): solo el contrato transversal. Build genera el
// puerto de dominio FileStorage; el adaptador (S3/MinIO u otro) y el bean del
// cliente dependen del proveedor elegido (keel-stack.json) y los escribe el
// agente siguiendo la skill keel-spring-s3, parametrizados
// por storage.yaml por perfil.

import { screamingSnake } from '../lib/naming.js';
import { javaFile, javaPath, subPackage } from './render.js';

const DOMAIN_PKG = 'domain.storage';
const INFRA_PKG = 'infrastructure.storage';

export function generate(model) {
  if (!model.layersPresent.storage) return [];
  return [
    renderStoredObject(model),
    renderPort(model),
    renderBucketPolicy(model),
    renderPolicyPort(model),
    renderProperties(model),
    renderPolicyConfig(model)
  ];
}

// La política que el diseño declara por bucket (tamaño máximo, tipos admitidos,
// visibilidad) la necesita la capa APPLICATION para rechazar una subida con el
// error declarado, y esa capa no puede leer @Value sin romper la frontera
// hexagonal. Sin un tipo que la transporte, el handler acaba con los valores
// escritos a mano: un espejo del artefacto que nadie vuelve a sincronizar cuando
// el diseño cambia. Por eso el value object es de dominio y quien lo puebla desde
// la configuración es un adaptador.
function renderBucketPolicy(model) {
  const body = `/**
 * Política declarada para un bucket en storage.keel.yaml. Value object inmutable:
 * lo entrega {@link StoragePolicies} y lo consulta el caso de uso antes de subir.
 *
 * @param name        nombre lógico del bucket, tal como lo nombra el diseño
 * @param bucket      nombre físico en el proveedor
 * @param publicRead  true si el diseño lo declara \`visibility: public\`
 * @param maxSizeMb   tamaño máximo admitido, o null si el diseño no lo acota
 * @param allowedContentTypes MIME admitidos; vacío significa "sin restricción"
 */
public record BucketPolicy(String name, String bucket, boolean publicRead, Integer maxSizeMb,
        List<String> allowedContentTypes) {

    public BucketPolicy {
        allowedContentTypes = allowedContentTypes == null ? List.of() : List.copyOf(allowedContentTypes);
    }

    /** ¿El MIME está admitido? Sin tipos declarados no hay restricción que aplicar. */
    public boolean allowsContentType(String contentType) {
        return allowedContentTypes.isEmpty()
                || (contentType != null && allowedContentTypes.contains(contentType.toLowerCase(Locale.ROOT)));
    }

    /** ¿El tamaño cabe? Sin límite declarado, siempre. */
    public boolean allowsSize(long sizeBytes) {
        return maxSizeMb == null || sizeBytes <= (long) maxSizeMb * 1024L * 1024L;
    }
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'BucketPolicy'),
    content: javaFile(subPackage(model, DOMAIN_PKG), ['java.util.List', 'java.util.Locale'], body)
  };
}

// Puerto de consulta de políticas. Las constantes evitan que el nombre del bucket
// viaje como literal por la capa de aplicación: si el diseño lo renombra, lo que
// falla es la compilación y no una subida en producción.
function renderPolicyPort(model) {
  const buckets = model.storage?.buckets ?? [];
  const constants = buckets
    .map(
      (bucket) => `    /** Bucket \`${bucket.name}\` declarado en storage.keel.yaml. */
    String ${screamingSnake(bucket.name)} = "${bucket.name}";`
    )
    .join('\n\n');
  const body = `/**
 * Acceso a la política declarada de cada bucket. La implementación vive en
 * infrastructure/storage y la puebla la configuración por perfil; el dominio y la
 * aplicación solo dependen de esta interfaz.
 */
public interface StoragePolicies {

${constants}

    /**
     * Política del bucket, por su nombre lógico del diseño.
     *
     * @throws IllegalStateException si la configuración no lo declara: es un fallo
     *         de despliegue, no una condición de negocio
     */
    BucketPolicy forBucket(String name);
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'StoragePolicies'),
    content: javaFile(subPackage(model, DOMAIN_PKG), [], body)
  };
}

// Binding tipado de `storage.buckets.*` (parameters/<perfil>/storage.yaml). Es el
// adaptador del puerto: no depende del proveedor elegido, solo de la config, así
// que lo genera build y no el agente.
function renderProperties(model) {
  const domainPkg = subPackage(model, DOMAIN_PKG);
  const body = `/**
 * Política de los buckets, leída de \`storage.buckets.*\`. El fragmento por perfil
 * lo genera \`keel-spring build\` desde storage.keel.yaml: esta clase es el único
 * sitio donde esos valores entran al código.
 */
@ConfigurationProperties("storage")
public record StorageProperties(Map<String, BucketProperties> buckets) implements StoragePolicies {

    public record BucketProperties(String bucket, String visibility, Integer maxSizeMb,
            List<String> allowedContentTypes) {
    }

    @Override
    public BucketPolicy forBucket(String name) {
        BucketProperties properties = buckets == null ? null : buckets.get(name);
        if (properties == null) {
            throw new IllegalStateException(
                    "storage.buckets." + name + " no está configurado: revisa parameters/<perfil>/storage.yaml");
        }
        return new BucketPolicy(name, properties.bucket(), "public".equals(properties.visibility()),
                properties.maxSizeMb(), properties.allowedContentTypes());
    }
}`;
  return {
    path: javaPath(model, INFRA_PKG, 'StorageProperties'),
    content: javaFile(
      subPackage(model, INFRA_PKG),
      [
        `${domainPkg}.BucketPolicy`,
        `${domainPkg}.StoragePolicies`,
        'java.util.List',
        'java.util.Map',
        'org.springframework.boot.context.properties.ConfigurationProperties'
      ],
      body
    )
  };
}

function renderPolicyConfig(model) {
  const body = `/** Registra {@link StorageProperties} como bean para poder inyectar el puerto. */
@Configuration
@EnableConfigurationProperties(StorageProperties.class)
public class StoragePolicyConfig {
}`;
  return {
    path: javaPath(model, INFRA_PKG, 'StoragePolicyConfig'),
    content: javaFile(
      subPackage(model, INFRA_PKG),
      [
        'org.springframework.boot.context.properties.EnableConfigurationProperties',
        'org.springframework.context.annotation.Configuration'
      ],
      body
    )
  };
}

// Lo que el dominio necesita recordar de un binario subido. Sin esto, un
// agregado que guarda una imagen no tiene qué persistir: la clave la conoce
// solo el adaptador.
function renderStoredObject(model) {
  const body = `/**
 * Descripción de un binario ya almacenado. Value object inmutable: lo devuelve
 * el puerto al subir y es lo que el agregado guarda.
 *
 * @param storageKey clave del objeto en el proveedor; siempre presente y es la
 *                   que identifica el binario para descargarlo o borrarlo
 * @param url        URL resoluble. En almacenes públicos viene poblada; en los
 *                   de URL firmada llega null y se obtiene al leer, con
 *                   {@code signedUrl(storageKey)}, porque caduca
 * @param contentType MIME del binario (por ejemplo image/png)
 * @param sizeBytes  tamaño en bytes
 */
public record StoredObject(String storageKey, URI url, String contentType, Long sizeBytes) {
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'StoredObject'),
    content: javaFile(subPackage(model, DOMAIN_PKG), ['java.net.URI'], body)
  };
}

// Puerto de salida puro (dominio): sin dependencias de infraestructura.
function renderPort(model) {
  const body = `/**
 * Puerto de almacenamiento de archivos. La implementación (proveedor del
 * stack) vive en infrastructure/storage; la escribe el agente. El dominio
 * solo depende de esta interfaz.
 */
public interface FileStorage {

    /**
     * Sube el binario y devuelve cómo quedó almacenado, para que el agregado
     * pueda guardar la referencia.
     */
    StoredObject upload(String key, byte[] content, String contentType);

    byte[] download(String key);

    void delete(String key);

    String signedUrl(String key);
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'FileStorage'),
    content: javaFile(subPackage(model, DOMAIN_PKG), [], body)
  };
}
