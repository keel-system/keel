// Object storage (capa storage): solo el contrato transversal. Build genera el
// puerto de dominio FileStorage; el adaptador (S3/MinIO u otro) y el bean del
// cliente dependen del proveedor elegido (keel-stack.json) y los escribe el
// agente siguiendo la skill .claude/skills/keel-spring-s3/, parametrizados
// por storage.yaml por perfil.

import { javaFile, javaPath, subPackage } from './render.js';

const DOMAIN_PKG = 'domain.storage';

export function generate(model) {
  if (!model.layersPresent.storage) return [];
  return [renderStoredObject(model), renderPort(model)];
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
