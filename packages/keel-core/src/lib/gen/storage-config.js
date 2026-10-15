// La configuración del almacenamiento de binarios por perfil (`config/parameters/<perfil>/storage.yaml`): el proveedor,
// con quién habla el servicio, las credenciales, la base de las URLs públicas y la política de cada bucket.
//
// La comparten keel-nest y keel-dotnet byte a byte, con las MISMAS claves, variables y gradiente que el storage.yaml de
// keel-spring: los tres servidores del mismo diseño se despliegan con el mismo .env. Estaba escrita en keel-nest; salió
// aquí al llegar el tercer generador (PLAN-KEEL-DOTNET.md, incremento 13g).

import { physicalBucketName } from './buckets.js';
import { screamingSnake } from './naming.js';
import { envValue, envWithDefault } from './profile-values.js';
import { envFor } from './runtime-env.js';

/** El `storage.yaml` de un perfil. Necesita `model.stack.storage` (minio o s3) y `model.storage`. */
export function storageYaml(model, profile) {
  const { stack } = model;
  const isMinio = stack.storage === 'minio';
  const isTest = profile === 'test';
  const lines = ['storage:', `  provider: ${stack.storage}`];
  if (isTest) {
    // El perfil test no tiene almacén: un endpoint local SIEMPRE, también con S3, para que nada salga a Internet.
    lines.push('  endpoint: http://localhost:9000');
  } else if (isMinio) {
    lines.push(`  endpoint: ${envFor('STORAGE_ENDPOINT', profile)}`);
  } else if (profile === 'local') {
    lines.push('  # S3 real: el endpoint lo resuelve el SDK por región; define STORAGE_ENDPOINT solo para un compatible.');
  }
  lines.push(
    `  region: ${envFor('STORAGE_REGION', profile)}`,
    `  access-key: ${envFor('STORAGE_ACCESS_KEY', profile, isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    `  secret-key: ${envFor('STORAGE_SECRET_KEY', profile, isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    isMinio || isTest ? '  path-style-access: true' : '  path-style-access: false'
  );
  if (model.storage?.hasPublicBucket) {
    if (isTest) lines.push('  public-base-url: http://localhost:9000');
    else if (profile === 'local') lines.push(`  public-base-url: ${envFor('STORAGE_PUBLIC_BASE_URL', profile)}`);
    else {
      lines.push(
        '  # URL base con la que el CONSUMIDOR lee los objetos públicos (CDN o borde),',
        '  # no el endpoint interno del almacén.',
        '  public-base-url: ${STORAGE_PUBLIC_BASE_URL}'
      );
    }
  }
  lines.push(
    `  ensure-buckets-on-startup: ${
      isTest ? 'false' : profile === 'local' ? 'true' : profile === 'develop' ? '${STORAGE_ENSURE_BUCKETS:true}' : '${STORAGE_ENSURE_BUCKETS:false}'
    }`
  );
  const buckets = model.storage?.buckets ?? [];
  if (buckets.length > 0) {
    lines.push('  buckets:');
    for (const bucket of buckets) {
      lines.push(
        `    ${bucket.name}:`,
        `      bucket: ${envValue(profile, `STORAGE_BUCKET_${screamingSnake(bucket.name)}`, physicalBucketName(model, bucket))}`,
        `      visibility: ${bucket.visibility}`
      );
      if (bucket.maxSizeMb != null) lines.push(`      max-size-mb: ${bucket.maxSizeMb}`);
      if (bucket.signedUrlTtlSeconds != null) {
        lines.push(`      signed-url-ttl-seconds: ${envWithDefault(profile, `STORAGE_${screamingSnake(bucket.name)}_SIGNED_URL_TTL_SECONDS`, bucket.signedUrlTtlSeconds)}`);
      }
      if (bucket.allowedContentTypes.length > 0) lines.push(`      allowed-content-types: ${bucket.allowedContentTypes.join(',')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** El límite de la ENTRADA multipart: el doble del mayor `maxSizeMb`, como el servlet de keel-spring (o 10 MB sin ninguno). */
export function multipartFileLimitBytes(model) {
  const maxSizeMb = model.storage?.maxSizeMb ?? null;
  return (maxSizeMb != null ? maxSizeMb * 2 : 10) * 1024 * 1024;
}
