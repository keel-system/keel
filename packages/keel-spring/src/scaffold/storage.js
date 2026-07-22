// Object storage (capa storage): solo el contrato transversal. Build genera el
// puerto de dominio FileStorage; el adaptador (S3/MinIO u otro) y el bean del
// cliente dependen del proveedor elegido (keel-stack.json) y los escribe el
// agente siguiendo la skill .claude/skills/keel-spring-s3/, parametrizados
// por storage.yaml por perfil.

import { javaFile, javaPath, subPackage } from './render.js';

const DOMAIN_PKG = 'domain.storage';

export function generate(model) {
  if (!model.layersPresent.storage) return [];
  return [renderPort(model)];
}

// Puerto de salida puro (dominio): sin dependencias de infraestructura.
function renderPort(model) {
  const body = `/**
 * Puerto de almacenamiento de archivos. La implementación (proveedor del
 * stack) vive en infrastructure/storage; la escribe el agente. El dominio
 * solo depende de esta interfaz.
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
