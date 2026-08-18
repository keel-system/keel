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
        List<String> allowedContentTypes, Integer signedUrlTtlSeconds) {

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

    /**
     * Cuánto vale la URL firmada de este bucket, según lo declara el diseño
     * ({@code storage.buckets.<n>.signedUrlTtlSeconds}).
     *
     * <p><b>Es la ventana que usa el adaptador, no una sugerencia.</b> Es contrato con
     * quien recibe el enlace: cuánto tiempo tiene para descargar, y durante cuánto le
     * sirve a quien se lo reenvíe. Elegir aquí otro número al escribir el adaptador
     * devuelve la decisión al código, que es de donde el diseño acaba de sacarla.
     */
    public Duration signedUrlTtl() {
        if (signedUrlTtlSeconds == null) {
            throw new IllegalStateException(
                    "storage.buckets." + name + " no declara signedUrlTtlSeconds: un bucket privado se lee por"
                            + " URL firmada, y esa firma tiene que caducar. Decláralo en el diseño.");
        }
        return Duration.ofSeconds(signedUrlTtlSeconds);
    }
}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'BucketPolicy'),
    content: javaFile(subPackage(model, DOMAIN_PKG), ['java.time.Duration', 'java.util.List', 'java.util.Locale'], body)
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
  // `public-base-url` solo con algún bucket público. Es la base con la que el
  // adaptador compone `publicUrl`, y es la que ve el CONSUMIDOR (CDN, o el host
  // en local): distinta del `endpoint` con el que el servicio habla con el
  // almacén, que en compose es un nombre de red que fuera no resuelve.
  const publicBaseUrl = model.storage?.hasPublicBucket
    ? `String publicBaseUrl, `
    : '';
  const publicBaseUrlDoc = model.storage?.hasPublicBucket
    ? `
 *
 * <p>{@code publicBaseUrl} es la base de las URLs que devuelve {@code publicUrl}
 * del puerto: la que alcanza el consumidor, no el endpoint interno.`
    : '';
  const body = `/**
 * Política de los buckets, leída de \`storage.buckets.*\`. El fragmento por perfil
 * lo genera \`keel-spring build\` desde storage.keel.yaml: esta clase es el único
 * sitio donde esos valores entran al código.${publicBaseUrlDoc}
 */
@ConfigurationProperties("storage")
public record StorageProperties(${publicBaseUrl}Map<String, BucketProperties> buckets) implements StoragePolicies {

    public record BucketProperties(String bucket, String visibility, Integer maxSizeMb,
            List<String> allowedContentTypes, Integer signedUrlTtlSeconds) {
    }

    @Override
    public BucketPolicy forBucket(String name) {
        BucketProperties properties = buckets == null ? null : buckets.get(name);
        if (properties == null) {
            throw new IllegalStateException(
                    "storage.buckets." + name + " no está configurado: revisa parameters/<perfil>/storage.yaml");
        }
        return new BucketPolicy(name, properties.bucket(), "public".equals(properties.visibility()),
                properties.maxSizeMb(), properties.allowedContentTypes(), properties.signedUrlTtlSeconds());
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
 * @param url        URL resoluble. En un bucket público viene poblada (la misma
 *                   que compone {@code publicUrl}); en uno privado llega null y
 *                   se obtiene al leer, con {@code signedUrl}, porque caduca
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
//
// Dos decisiones que el puerto expresa en su FIRMA, no en un párrafo de la skill:
//
// 1. Cada método toma el `bucket` LÓGICO (el nombre del diseño, el mismo que
//    indexa StoragePolicies.forBucket). Con un solo bucket sobra, pero en cuanto
//    el diseño declara dos el adaptador no puede decidir nada a partir de la key:
//    ni a qué bucket sube ni si una lectura se firma o se compone.
//
// 2. `download`, `publicUrl` y `signedUrl` son CONDICIONALES por visibilidad.
//    Declararlos siempre obliga al agente a implementar un @Override inalcanzable
//    —y a reportar como hueco del diseño el error que le falta, p. ej. el
//    FILE_NOT_FOUND de una descarga que nadie hace—. Peor aún era el caso de la
//    URL: con `signedUrl` incondicional, la única forma de resolver la key de un
//    bucket público era que ese método compusiera la URL pública, semántica
//    invisible en el nombre que el agente no encuentra y suple inventando un
//    método propio. Con `publicUrl` presente si y solo si hay bucket público, lo
//    que necesita está donde lo busca y se llama como lo que hace.
function renderPort(model) {
  const storage = model.storage ?? {};

  const download = storage.hasPrivateBucket
    ? `
    /**
     * Trae el binario: solo existe porque el diseño declara algún bucket
     * visibility: private, cuyo contenido no es de lectura directa y tiene que
     * servirlo el propio servicio.
     */
    byte[] download(String bucket, String key);
`
    : '';

  const publicUrl = storage.hasPublicBucket
    ? `
    /**
     * URL absoluta y estable del objeto, para exponerla en un ResponseDto. Solo
     * existe porque el diseño declara algún bucket visibility: public, cuyo
     * contenido se lee directamente del borde.
     *
     * <p>Se compone desde \`storage.public-base-url\` (la que ve el CONSUMIDOR:
     * el CDN, o localhost en local), nunca desde el endpoint interno con el que
     * el servicio habla con el almacén — esa URL no la resuelve nadie fuera de
     * la red del compose.
     */
    String publicUrl(String bucket, String key);
`
    : '';

  const signedUrl = storage.hasPrivateBucket
    ? `
    /**
     * URL de lectura temporal de un objeto que no es público. Solo existe
     * porque el diseño declara algún bucket visibility: private. Caduca: se
     * pide al leer y no se persiste ni se cachea en una respuesta.
     *
     * <p><b>Cuánto dura no lo elige el adaptador</b>: sale de
     * {@code BucketPolicy#signedUrlTtl()}, que lo lee de lo que declaró el diseño. Es
     * contrato con quien recibe el enlace —cuánto tiene para descargar, y durante cuánto
     * le sirve a quien se lo reenvíe—, así que una constante en el adaptador devolvería
     * esa decisión al código.
     */
    String signedUrl(String bucket, String key);
`
    : '';

  const body = `/**
 * Puerto de almacenamiento de archivos. La implementación (proveedor del
 * stack) vive en infrastructure/storage; la escribe el agente. El dominio
 * solo depende de esta interfaz.
 *
 * <p>El parámetro {@code bucket} es el nombre LÓGICO del diseño (las constantes
 * de {@link StoragePolicies}), no el físico del proveedor: traducirlo es cosa
 * del adaptador.
 */
public interface FileStorage {

    /**
     * Sube el binario y devuelve cómo quedó almacenado, para que el agregado
     * pueda guardar la referencia.
     */
    StoredObject upload(String bucket, String key, byte[] content, String contentType);
${download}${publicUrl}
    void delete(String bucket, String key);
${signedUrl}}`;
  return {
    path: javaPath(model, DOMAIN_PKG, 'FileStorage'),
    content: javaFile(subPackage(model, DOMAIN_PKG), [], body)
  };
}
