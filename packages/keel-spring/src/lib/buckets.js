// Nombre físico de los buckets declarados en storage.keel.yaml.
//
// Fuente única para las tres partes que tienen que coincidir o la subida acaba
// en un bucket que nadie creó: el fragmento `parameters/<perfil>/storage.yaml`
// (config.js), el sidecar `minio-init` del compose (stack-catalog.js) y la
// comprobación de `infra/validate-infra.sh` (devtools.js).
//
// El diseño nombra los buckets en camelCase (`productImages`) porque son
// identificadores del DSL; S3 exige nombres DNS (minúsculas, guiones), así que
// el nombre físico es su kebab-case, prefijado por el servicio para que dos
// servicios del mismo entorno no colisionen en un bucket llamado "images".

import { kebabCase } from './naming.js';

export function physicalBucketName(model, bucket) {
  return `${model.service.artifactId}-${kebabCase(bucket.name)}`;
}

/** Buckets declarados con su nombre físico y su visibilidad. Vacío sin capa storage. */
export function declaredBuckets(model) {
  return (model.storage?.buckets ?? []).map((bucket) => ({
    ...bucket,
    physicalName: physicalBucketName(model, bucket)
  }));
}

// ¿El bucket lógico que nombra un campo `file` es de lectura pública? Es lo que
// decide qué expone el DTO de salida: la URL absoluta (público) o la key
// (privado, cuya lectura la sirve una operación del diseño). Un nombre que no
// está declarado es falso, no una excepción: crossrefs ya lo rechaza antes de
// llegar aquí, y en modo --wip el build tiene que seguir produciendo algo.
export function isPublicBucket(model, name) {
  if (!name) return false;
  return (model.storage?.buckets ?? []).some((bucket) => bucket.name === name && bucket.visibility === 'public');
}
