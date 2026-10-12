// Nombre físico de los buckets declarados en storage.keel.yaml.
//
// Fuente única para las tres partes que tienen que coincidir o la subida acaba
// en un bucket que nadie creó: la configuración de storage por perfil, el
// sidecar `minio-init` del compose y la comprobación de `infra/validate-infra.sh`. Y entre
// generadores: el servicio de keel-spring y el de keel-nest del mismo diseño usan el mismo bucket.
//
// El diseño nombra los buckets en camelCase (`productImages`) porque son
// identificadores del DSL; S3 exige nombres DNS (minúsculas, guiones), así que
// el nombre físico es su kebab-case, prefijado por el servicio para que dos
// servicios del mismo entorno no colisionen en un bucket llamado "images".

import { kebabCase, screamingSnake } from './naming.js';

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

/**
 * La nota del handler de una operación con SUBIDA: qué comprueba el caso de uso antes de subir, y en qué orden.
 *
 * El lector multipart de los dos generadores corta al DOBLE del mayor `maxSizeMb` del servicio: protege al proceso,
 * no es el límite de negocio. El del bucket lo comprueba el handler con `BucketPolicy.allowsSize`, y eso no lo decía
 * ninguna nota: el agente de keel-spring lo sacó de su skill de S3 y el de keel-nest no (corrida catalog de
 * keel-nest, 2026-10-11: FL-IMG-001-F, un ciclo), con una regla del diseño que dice «el tamaño se rechaza al leer la
 * petición». Neutral: la escriben igual los dos generadores.
 *
 * @param {object} model modelo del servicio
 * @param {object} operation la operación
 * @param {{ sizeCode: string }} codes el `code` del 413 que resuelve el generador (declarado o canónico)
 * @returns {string[]} una nota por campo de subida
 */
export function uploadNotes(model, operation, { sizeCode }) {
  const notes = [];
  for (const field of operation.bodyFields ?? []) {
    if (field.kind !== 'fileUpload' || !field.bucket) continue;
    const bucket = (model.storage?.buckets ?? []).find((candidate) => candidate.name === field.bucket);
    if (!bucket) continue;
    const size = bucket.maxSizeMb != null ? `${bucket.maxSizeMb} MB` : null;
    const types = (bucket.allowedContentTypes ?? []).join(', ');
    notes.push(
      `Subida ${field.name} (bucket ${bucket.name}): la política es storagePolicies.forBucket(StoragePolicies.${screamingSnake(bucket.name)}). ` +
        (size
          ? `El lector multipart solo corta al doble del mayor maxSizeMb del servicio: el límite de este bucket (${size}) ` +
            `lo compruebas TÚ, lo primero, con allowsSize(tamaño) → ${sizeCode} (413) si no cabe. `
          : 'El bucket no declara tamaño máximo. ') +
        (types
          ? `Después allowsContent(bytes, tipo declarado) —el tipo (${types}) y la firma del contenido—; nunca solo el tipo declarado. `
          : '') +
        'Y la subida al almacenamiento, al final: lo que se rechaza antes no deja un objeto huérfano.'
    );
  }
  return notes;
}
