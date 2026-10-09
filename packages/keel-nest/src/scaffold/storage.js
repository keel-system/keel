// Almacenamiento de binarios (capa storage, incremento 13g). El mismo reparto que keel-spring: build emite el
// CONTRATO —el puerto FileStorage, lo que el agregado guarda de un binario (StoredObject), la política de cada
// bucket con la comprobación de la FIRMA del contenido, las constantes de los buckets y su configuración— y la
// ENTRADA multipart; el adaptador S3 lo escribe el agente siguiendo la skill keel-nest-s3, sobre el stub que
// deja build y que el módulo ya cablea.
//
// Por qué la firma la emite build (BucketPolicy.allowsContent): el Content-Type de una parte multipart lo elige
// quien sube, así que comprobar solo el tipo declarado deja pasar cualquier binario con la etiqueta correcta, y
// el resultado es indistinguible de una subida buena. Ningún escenario la echa de menos. La tabla es la neutral
// de keel-core (gen/content-signatures.js), la misma que la del ContentSignature de keel-spring.
//
// La configuración (config/parameters/<perfil>/storage.yaml) tiene las MISMAS variables y el mismo gradiente
// que el storage.yaml de keel-spring: un mismo .env sirve para los dos servidores del diseño.

import { CONTENT_SIGNATURES } from 'keel-core/gen/content-signatures';
import { physicalBucketName } from 'keel-core/gen/buckets';
import { declaredErrorFor } from 'keel-core/gen/declared-errors';
import { STORAGE, devtoolsContainer, storageContainer } from 'keel-core/gen/infra-catalog';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { screamingSnake } from 'keel-core/gen';
import { DIRS, classPath, tsModule, tsString } from './render.js';
import { FILE_UPLOAD_TS } from './dtos.js';

const CONFIG_TS = 'src/infrastructure/config/configuration.ts';
const STORAGE_DIR = 'domain/storage';
const INFRA_DIR = 'src/infrastructure/storage';
const PROFILES = ['local', 'develop', 'production', 'test'];

export const STORED_OBJECT_TS = classPath(STORAGE_DIR, 'StoredObject');
export const FILE_STORAGE_TS = classPath(STORAGE_DIR, 'FileStorage');
export const BUCKET_POLICY_TS = classPath(STORAGE_DIR, 'BucketPolicy');
export const CONTENT_SIGNATURE_TS = classPath(STORAGE_DIR, 'ContentSignature');
export const STORAGE_POLICIES_TS = classPath(STORAGE_DIR, 'StoragePolicies');
export const STORAGE_SETTINGS_TS = `${INFRA_DIR}/storage-settings.ts`;
export const CONFIGURED_POLICIES_TS = `${INFRA_DIR}/configured-storage-policies.ts`;
export const S3_FILE_STORAGE_TS = `${INFRA_DIR}/s3-file-storage.ts`;
export const STORAGE_MODULE_TS = `${INFRA_DIR}/storage-module.ts`;
export const MULTIPART_READING_TS = 'src/infrastructure/rest/multipart-reading.ts';

export function usesStorage(model) {
  return Boolean(model.layersPresent?.storage && model.storage);
}

/** ¿Alguna operación con ruta recibe un binario? Entonces la entrada HTTP lee multipart/form-data. */
export function usesMultipart(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).some((operation) => operation.route && operation.multipart));
}

/** El límite de la ENTRADA: el doble del mayor `maxSizeMb`, como el servlet de keel-spring (o 10 MB sin ninguno). */
export function multipartFileLimitBytes(model) {
  const maxSizeMb = model.storage?.maxSizeMb ?? null;
  return (maxSizeMb != null ? maxSizeMb * 2 : 10) * 1024 * 1024;
}

export function generate(model) {
  const files = [];
  if (usesStorage(model)) {
    files.push(
      { path: STORED_OBJECT_TS, content: storedObjectTs() },
      { path: FILE_STORAGE_TS, content: fileStorageTs(model) },
      { path: CONTENT_SIGNATURE_TS, content: contentSignatureTs() },
      { path: BUCKET_POLICY_TS, content: bucketPolicyTs() },
      { path: STORAGE_POLICIES_TS, content: storagePoliciesTs(model) },
      { path: STORAGE_SETTINGS_TS, content: storageSettingsTs(model) },
      { path: CONFIGURED_POLICIES_TS, content: configuredPoliciesTs() },
      { path: S3_FILE_STORAGE_TS, content: s3FileStorageTs(model) },
      { path: STORAGE_MODULE_TS, content: storageModuleTs() },
      ...(model.stack?.storage ? PROFILES.map((profile) => ({ path: `config/parameters/${profile}/storage.yaml`, content: storageYaml(model, profile) })) : [])
    );
  }
  if (usesMultipart(model)) files.push({ path: MULTIPART_READING_TS, content: multipartReadingTs(model) });
  return files;
}

// ─── domain/storage ──────────────────────────────────────────────────────────

function storedObjectTs() {
  const body = `/**
 * Descripción de un binario ya almacenado: lo devuelve el puerto al subir y es lo que el agregado guarda.
 *
 * - \`storageKey\`: la clave del objeto en el proveedor; siempre presente, es la que identifica el binario para
 *   descargarlo o borrarlo.
 * - \`url\`: URL resoluble. En un bucket público viene poblada (la misma que compone \`publicUrl\`); en uno
 *   privado llega null y se pide al leer, con \`signedUrl\`, porque caduca.
 * - \`contentType\`: el MIME del binario (por ejemplo image/png).
 * - \`sizeBytes\`: el tamaño en bytes.
 */
export class StoredObject {
  constructor(
    readonly storageKey: string,
    readonly url: string | null,
    readonly contentType: string,
    readonly sizeBytes: number
  ) {}
}`;
  return tsModule(STORED_OBJECT_TS, [], body);
}

// Dos decisiones que el puerto expresa en su FIRMA, las mismas que keel-spring: cada método toma el bucket
// LÓGICO del diseño, y `download`/`signedUrl` existen solo con un bucket privado y `publicUrl` solo con uno
// público. Un método inalcanzable obliga al agente a implementarlo y a inventarse su error.
function fileStorageTs(model) {
  const storage = model.storage ?? {};
  const download = storage.hasPrivateBucket
    ? `

  /**
   * Trae el binario. Existe porque el diseño declara algún bucket \`visibility: private\`, cuyo contenido no es de
   * lectura directa y tiene que servirlo el propio servicio.
   */
  abstract download(bucket: string, key: string): Promise<Uint8Array>;`
    : '';
  const publicUrl = storage.hasPublicBucket
    ? `

  /**
   * URL absoluta y estable del objeto, para exponerla en una respuesta. Existe porque el diseño declara algún
   * bucket \`visibility: public\`. Se compone desde \`storage.public-base-url\` —la que ve el CONSUMIDOR: el CDN, o el
   * host en local—, nunca desde el endpoint interno con el que el servicio habla con el almacén.
   */
  abstract publicUrl(bucket: string, key: string): string;`
    : '';
  const signedUrl = storage.hasPrivateBucket
    ? `

  /**
   * URL de lectura temporal de un objeto que no es público. Caduca: se pide al leer, no se persiste ni se
   * cachea en una respuesta. **Cuánto dura no lo elige el adaptador**: sale de \`BucketPolicy.signedUrlTtlSeconds()\`,
   * que lo lee de lo que declaró el diseño.
   */
  abstract signedUrl(bucket: string, key: string): Promise<string>;`
    : '';
  const body = `/**
 * Puerto de almacenamiento de archivos. La implementación (el proveedor del stack) vive en
 * infrastructure/storage y la escribe el agente; el dominio y la aplicación solo dependen de esta clase.
 *
 * El parámetro \`bucket\` es el nombre LÓGICO del diseño (las constantes de \`StoragePolicies\`), no el físico
 * del proveedor: traducirlo es cosa del adaptador.
 */
export abstract class FileStorage {
  /** Sube el binario y devuelve cómo quedó almacenado, para que el agregado guarde la referencia. */
  abstract upload(bucket: string, key: string, content: Uint8Array, contentType: string): Promise<StoredObject>;${download}${publicUrl}

  abstract delete(bucket: string, key: string): Promise<void>;${signedUrl}
}`;
  return tsModule(FILE_STORAGE_TS, [{ symbol: 'StoredObject', from: STORED_OBJECT_TS, type: true }], body);
}

function contentSignatureTs() {
  const hex = (byte) => `0x${byte.toString(16).padStart(2, '0')}`;
  const entries = Object.entries(CONTENT_SIGNATURES).map(([mime, alternatives]) => {
    const rendered = alternatives.map((parts) => `[${parts.map((part) => `{ offset: ${part.offset}, bytes: [${part.bytes.map(hex).join(', ')}] }`).join(', ')}]`);
    return `  [${tsString(mime)}, [${rendered.join(', ')}]]`;
  });
  const body = `/** Un trozo de firma: los bytes esperados a partir de un desplazamiento. */
interface Magic {
  readonly offset: number;
  readonly bytes: readonly number[];
}

/**
 * Firmas por MIME. Cada elemento de la lista exterior es una ALTERNATIVA (un GIF vale con GIF87a o con
 * GIF89a); dentro de una alternativa, todos los trozos tienen que casar (un WebP es RIFF al principio y WEBP en
 * el byte 8). La tabla es la neutral de keel-core: la misma que la del servidor de keel-spring.
 */
const SIGNATURES: ReadonlyMap<string, readonly (readonly Magic[])[]> = new Map([
${entries.join(',\n')}
]);

/**
 * ¿El contenido de un binario se corresponde con el tipo que dice tener? El Content-Type de una parte
 * multipart lo elige el cliente, así que por sí solo no distingue una imagen de un ejecutable renombrado: esta
 * tabla mira los primeros bytes de los formatos que se pueden reconocer así.
 *
 * **Alcance, y es una promesa acotada a propósito:** un MIME que no esté en la tabla —texto, SVG, CSV, JSON— se
 * ACEPTA, porque no tiene firma que comprobar. Para esos formatos la única comprobación posible es la del tipo
 * declarado.
 */
export const ContentSignature = {
  /**
   * ¿El contenido casa con el tipo declarado? true también cuando el tipo no tiene firma conocida. Un contenido
   * vacío tampoco se juzga aquí: eso es una subida rota, y su error es el del framework (FILE_UNREADABLE).
   */
  matches(content: Uint8Array | null, declaredContentType: string | null): boolean {
    if (declaredContentType == null) return true;
    const alternatives = SIGNATURES.get(declaredContentType.toLowerCase());
    if (alternatives == null) return true;
    if (content == null || content.length === 0) return true;
    return alternatives.some((parts) => parts.every((part) => startsWith(content, part)));
  }
};

function startsWith(content: Uint8Array, part: Magic): boolean {
  if (content.length < part.offset + part.bytes.length) return false;
  return part.bytes.every((byte, index) => content[part.offset + index] === byte);
}`;
  return tsModule(CONTENT_SIGNATURE_TS, [], body);
}

function bucketPolicyTs() {
  const body = `/**
 * Política declarada para un bucket en storage.keel.yaml. La entrega \`StoragePolicies\` y la consulta el caso de
 * uso antes de subir: el tamaño, los tipos admitidos y la visibilidad salen del diseño, no del handler.
 */
export class BucketPolicy {
  /** MIME admitidos, en minúsculas; vacío significa «sin restricción». */
  readonly allowedContentTypes: readonly string[];

  constructor(
    /** Nombre lógico del bucket, tal como lo nombra el diseño. */
    readonly name: string,
    /** Nombre físico en el proveedor. */
    readonly bucket: string,
    /** true si el diseño lo declara \`visibility: public\`. */
    readonly publicRead: boolean,
    /** Tamaño máximo admitido en MB, o null si el diseño no lo acota. */
    readonly maxSizeMb: number | null,
    allowedContentTypes: readonly string[] | null,
    /** Cuánto vale la URL firmada, en segundos, o null si el diseño no lo declara. */
    private readonly signedUrlTtl: number | null
  ) {
    this.allowedContentTypes = Object.freeze((allowedContentTypes ?? []).map((type) => type.toLowerCase()));
  }

  /**
   * ¿El binario es admisible en este bucket? Dos preguntas, y las dos son del contrato: el tipo DECLARADO está
   * entre los admitidos, y el contenido es de verdad de ese tipo.
   *
   * **Es el método que usa el caso de uso**, no \`allowsContentType\`: un ejecutable renombrado a \`.png\` y
   * enviado como image/png pasa la comprobación del tipo declarado, se guarda y —en un bucket público— se sirve.
   * Devuelve el mismo false en los dos casos a propósito: para el cliente el error es el que el diseño declara
   * para un formato no admitido, y distinguir «el tipo no vale» de «mentiste sobre el tipo» solo le diría a quien
   * prueba con qué renombrar.
   */
  allowsContent(content: Uint8Array, declaredContentType: string | null): boolean {
    return this.allowsContentType(declaredContentType) && ContentSignature.matches(content, declaredContentType);
  }

  /**
   * ¿El MIME DECLARADO está admitido? Sin tipos declarados no hay restricción. Comprobar solo esto es confiar en
   * lo que dice el cliente: usa \`allowsContent\` siempre que tengas los bytes delante.
   */
  allowsContentType(contentType: string | null): boolean {
    return this.allowedContentTypes.length === 0 || (contentType != null && this.allowedContentTypes.includes(contentType.toLowerCase()));
  }

  /** ¿El tamaño cabe? Sin límite declarado, siempre. */
  allowsSize(sizeBytes: number): boolean {
    return this.maxSizeMb == null || sizeBytes <= this.maxSizeMb * 1024 * 1024;
  }

  /**
   * Cuánto vale la URL firmada de este bucket, en segundos, según lo declara el diseño
   * (\`storage.buckets.<n>.signedUrlTtlSeconds\`). **Es la ventana que usa el adaptador, no una sugerencia**: es
   * contrato con quien recibe el enlace.
   */
  signedUrlTtlSeconds(): number {
    if (this.signedUrlTtl == null) {
      throw new Error(
        \`storage.buckets.\${this.name} no declara signedUrlTtlSeconds: un bucket privado se lee por URL firmada, y esa firma tiene que caducar. Decláralo en el diseño.\`
      );
    }
    return this.signedUrlTtl;
  }
}`;
  return tsModule(BUCKET_POLICY_TS, [{ symbol: 'ContentSignature', from: CONTENT_SIGNATURE_TS }], body);
}

function storagePoliciesTs(model) {
  const buckets = model.storage?.buckets ?? [];
  const constants = buckets.map((bucket) => `  /** Bucket \`${bucket.name}\` declarado en storage.keel.yaml. */\n  static readonly ${screamingSnake(bucket.name)} = ${tsString(bucket.name)};`);
  const body = `/**
 * Acceso a la política declarada de cada bucket. La implementación vive en infrastructure/storage y la puebla la
 * configuración por perfil; el dominio y la aplicación solo dependen de esta clase. Las constantes evitan que el
 * nombre del bucket viaje como literal: si el diseño lo renombra, lo que falla es la compilación.
 */
export abstract class StoragePolicies {
${constants.join('\n\n')}

  /** La política del bucket, por su nombre lógico. Lanza si la configuración no lo declara: es un fallo de despliegue. */
  abstract forBucket(name: string): BucketPolicy;
}`;
  return tsModule(STORAGE_POLICIES_TS, [{ symbol: 'BucketPolicy', from: BUCKET_POLICY_TS, type: true }], body);
}

// ─── infrastructure/storage ──────────────────────────────────────────────────

function storageSettingsTs(model) {
  const publicBase = Boolean(model.storage?.hasPublicBucket);
  const body = `export const STORAGE_SETTINGS = Symbol('STORAGE_SETTINGS');

/** Un bucket tal como lo declara storage.yaml. */
export interface BucketSettings {
  readonly bucket: string;
  readonly visibility: string;
  readonly maxSizeMb: number | null;
  readonly allowedContentTypes: readonly string[];
  readonly signedUrlTtlSeconds: number | null;
}

/**
 * Lo que el almacenamiento lee de config/parameters/<perfil>/storage.yaml: las MISMAS claves y variables que el
 * storage.yaml de keel-spring (STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY,
 * STORAGE_BUCKET_<B>…). Es el único sitio por el que esos valores entran al código.
 */
export interface StorageSettings {
  readonly provider: string;
  /** Con quién habla el servicio (MinIO en local); null con S3, que resuelve el endpoint por región. */
  readonly endpoint: string | null;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly pathStyleAccess: boolean;${publicBase ? `
  /** La base de las URLs públicas: la que alcanza el CONSUMIDOR (CDN, o el host en local), no el endpoint interno. */
  readonly publicBaseUrl: string;` : ''}
  /** ¿Crea los buckets (y la lectura pública) al arrancar? Decisión de entorno: sí en local, no en test. */
  readonly ensureBucketsOnStartup: boolean;
  readonly buckets: Readonly<Record<string, BucketSettings>>;
}

export function storageSettings(configuration: Configuration): StorageSettings {
  const declared = configuration.get('storage.buckets');
  const buckets: Record<string, BucketSettings> = {};
  for (const [name, raw] of Object.entries(isObject(declared) ? declared : {})) {
    const entry = isObject(raw) ? raw : {};
    buckets[name] = {
      bucket: String(entry['bucket'] ?? ''),
      visibility: String(entry['visibility'] ?? 'private'),
      maxSizeMb: optionalNumber(entry['max-size-mb'], \`storage.buckets.\${name}.max-size-mb\`),
      allowedContentTypes: list(entry['allowed-content-types']),
      signedUrlTtlSeconds: optionalNumber(entry['signed-url-ttl-seconds'], \`storage.buckets.\${name}.signed-url-ttl-seconds\`)
    };
  }
  return {
    provider: text(configuration, 'storage.provider') ?? '${model.stack?.storage ?? 'minio'}',
    endpoint: text(configuration, 'storage.endpoint'),
    region: text(configuration, 'storage.region') ?? 'us-east-1',
    accessKey: text(configuration, 'storage.access-key') ?? '',
    secretKey: text(configuration, 'storage.secret-key') ?? '',
    pathStyleAccess: flag(configuration, 'storage.path-style-access', false),${publicBase ? `
    publicBaseUrl: (text(configuration, 'storage.public-base-url') ?? '').replace(/\\/+$/, ''),` : ''}
    ensureBucketsOnStartup: flag(configuration, 'storage.ensure-buckets-on-startup', false),
    buckets
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(configuration: Configuration, key: string): string | null {
  const value = configuration.get(key);
  return value == null || String(value).trim() === '' ? null : String(value);
}

function flag(configuration: Configuration, key: string, fallback: boolean): boolean {
  const value = text(configuration, key);
  return value == null ? fallback : value.toLowerCase() === 'true';
}

function optionalNumber(value: unknown, key: string): number | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(\`\${key} tiene que ser un número no negativo: '\${String(value)}'\`);
  return parsed;
}

/** Una lista de la configuración: la del YAML, o separada por comas (como la enlaza Spring). */
function list(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value.map(String) : String(value).split(',');
  return items.map((item) => item.trim()).filter((item) => item !== '');
}`;
  return tsModule(STORAGE_SETTINGS_TS, [{ symbol: 'Configuration', from: CONFIG_TS, type: true }], body);
}

function configuredPoliciesTs() {
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'BucketPolicy', from: BUCKET_POLICY_TS },
    { symbol: 'StoragePolicies', from: STORAGE_POLICIES_TS },
    { symbol: 'STORAGE_SETTINGS', from: STORAGE_SETTINGS_TS },
    { symbol: 'StorageSettings', from: STORAGE_SETTINGS_TS, type: true }
  ];
  const body = `/** La política de cada bucket, leída de \`storage.buckets.*\`: el adaptador del puerto StoragePolicies. */
@Injectable()
export class ConfiguredStoragePolicies extends StoragePolicies {
  constructor(@Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings) {
    super();
  }

  forBucket(name: string): BucketPolicy {
    const bucket = this.settings.buckets[name];
    if (bucket == null) {
      throw new Error(\`storage.buckets.\${name} no está configurado: revisa config/parameters/<perfil>/storage.yaml\`);
    }
    return new BucketPolicy(name, bucket.bucket, bucket.visibility === 'public', bucket.maxSizeMb, bucket.allowedContentTypes, bucket.signedUrlTtlSeconds);
  }
}`;
  return tsModule(CONFIGURED_POLICIES_TS, imports, body);
}

// El adaptador lo escribe el agente (skill keel-nest-s3): build deja la clase que el módulo ya cablea, con lo
// que necesita inyectado y un TODO por método. Compila y arranca; lo que llame al puerto antes de que el agente
// lo complete recibe un error que lo dice.
function s3FileStorageTs(model) {
  const storage = model.storage ?? {};
  const imports = [
    { symbol: 'Inject', from: '@nestjs/common' },
    { symbol: 'Injectable', from: '@nestjs/common' },
    { symbol: 'FileStorage', from: FILE_STORAGE_TS },
    { symbol: 'StoredObject', from: STORED_OBJECT_TS, type: true },
    { symbol: 'StoragePolicies', from: STORAGE_POLICIES_TS },
    { symbol: 'STORAGE_SETTINGS', from: STORAGE_SETTINGS_TS },
    { symbol: 'StorageSettings', from: STORAGE_SETTINGS_TS, type: true }
  ];
  const todo = (what) => `    throw new Error('TODO (agente): ${what} — skills/keel-nest-s3');`;
  const methods = [
    `  async upload(bucket: string, key: string, content: Uint8Array, contentType: string): Promise<StoredObject> {
    void [bucket, key, content, contentType];
${todo('upload')}
  }`
  ];
  if (storage.hasPrivateBucket) {
    methods.push(`  async download(bucket: string, key: string): Promise<Uint8Array> {
    void [bucket, key];
${todo('download')}
  }`);
  }
  if (storage.hasPublicBucket) {
    methods.push(`  publicUrl(bucket: string, key: string): string {
    void [bucket, key];
${todo('publicUrl')}
  }`);
  }
  methods.push(`  async delete(bucket: string, key: string): Promise<void> {
    void [bucket, key];
${todo('delete')}
  }`);
  if (storage.hasPrivateBucket) {
    methods.push(`  async signedUrl(bucket: string, key: string): Promise<string> {
    void [bucket, key];
${todo('signedUrl')}
  }`);
  }
  const body = `/**
 * El adaptador del puerto FileStorage sobre el protocolo S3 (${STORAGE[model.stack?.storage]?.label ?? 'S3'}). LO ESCRIBE EL AGENTE siguiendo la
 * skill keel-nest-s3: el cliente de @aws-sdk/client-s3 con la configuración de \`settings\` (endpoint y
 * path-style con MinIO), el bucket FÍSICO de \`policies.forBucket(bucket).bucket\` —el que crea el sidecar
 * minio-init de infra/—, el aprovisionamiento al arrancar si \`settings.ensureBucketsOnStartup\` y, para un bucket
 * privado, la URL firmada con la caducidad que declara el diseño (\`signedUrlTtlSeconds()\`).
 *
 * El módulo de almacenamiento ya lo cablea como FileStorage: no lo registres en otro sitio.
 */
@Injectable()
export class S3FileStorage extends FileStorage {
  constructor(
    @Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings,
    @Inject(StoragePolicies) private readonly policies: StoragePolicies
  ) {
    super();
    void [this.settings, this.policies];
  }

${methods.join('\n\n')}
}`;
  return tsModule(S3_FILE_STORAGE_TS, imports, body);
}

function storageModuleTs() {
  const imports = [
    { symbol: 'Global', from: '@nestjs/common' },
    { symbol: 'Module', from: '@nestjs/common' },
    { symbol: 'DynamicModule', from: '@nestjs/common', type: true },
    { symbol: 'Configuration', from: CONFIG_TS, type: true },
    { symbol: 'FileStorage', from: FILE_STORAGE_TS },
    { symbol: 'StoragePolicies', from: STORAGE_POLICIES_TS },
    { symbol: 'STORAGE_SETTINGS', from: STORAGE_SETTINGS_TS },
    { symbol: 'storageSettings', from: STORAGE_SETTINGS_TS },
    { symbol: 'ConfiguredStoragePolicies', from: CONFIGURED_POLICIES_TS },
    { symbol: 'S3FileStorage', from: S3_FILE_STORAGE_TS }
  ];
  const body = `/**
 * El almacenamiento de binarios: la configuración, la política de cada bucket y el adaptador del puerto. Global:
 * los handlers inyectan FileStorage y StoragePolicies sin importarlo.
 */
@Global()
@Module({})
export class StorageModule {
  static register(configuration: Configuration): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        { provide: STORAGE_SETTINGS, useValue: storageSettings(configuration) },
        { provide: StoragePolicies, useClass: ConfiguredStoragePolicies },
        { provide: FileStorage, useClass: S3FileStorage }
      ],
      exports: [FileStorage, StoragePolicies, STORAGE_SETTINGS]
    };
  }
}`;
  return tsModule(STORAGE_MODULE_TS, imports, body);
}

/** config/parameters/<perfil>/storage.yaml: las mismas claves, variables y gradiente que el de keel-spring. */
function storageYaml(model, profile) {
  const { stack } = model;
  const isMinio = stack.storage === 'minio';
  const isTest = profile === 'test';
  const lines = ['storage:', `  provider: ${stack.storage}`];
  if (isTest) {
    // El perfil test no tiene almacén: un endpoint local SIEMPRE, también con S3, para que nada salga a Internet.
    lines.push('  endpoint: http://localhost:9000');
  } else if (isMinio) {
    lines.push(`  endpoint: ${envValue(profile, 'STORAGE_ENDPOINT', 'http://localhost:9000')}`);
  } else if (profile === 'local') {
    lines.push('  # S3 real: el endpoint lo resuelve el SDK por región; define STORAGE_ENDPOINT solo para un compatible.');
  }
  lines.push(
    `  region: ${envValue(profile, 'STORAGE_REGION', 'us-east-1')}`,
    `  access-key: ${envValue(profile, 'STORAGE_ACCESS_KEY', isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    `  secret-key: ${envValue(profile, 'STORAGE_SECRET_KEY', isTest ? 'test' : isMinio ? 'minioadmin' : 'changeme')}`,
    isMinio || isTest ? '  path-style-access: true' : '  path-style-access: false'
  );
  if (model.storage?.hasPublicBucket) {
    if (isTest) lines.push('  public-base-url: http://localhost:9000');
    else if (profile === 'local') lines.push(`  public-base-url: ${envValue(profile, 'STORAGE_PUBLIC_BASE_URL', 'http://localhost:9000')}`);
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

function envValue(profile, name, value) {
  if (profile === 'local' || profile === 'test') return String(value);
  if (profile === 'develop') return `\${${name}:${value}}`;
  return `\${${name}}`;
}

function envWithDefault(profile, name, value) {
  if (profile === 'local') return String(value);
  return `\${${name}:${value}}`;
}

// ─── infrastructure/rest/multipart-reading.ts ────────────────────────────────

function multipartReadingTs(model) {
  const tooLarge = declaredErrorFor(model, FRAMEWORK_ERRORS.fileTooLarge)?.code ?? FRAMEWORK_ERRORS.fileTooLarge.code;
  const imports = [
    { symbol: 'FastifyRequest', from: 'fastify', type: true },
    { symbol: 'FileUpload', from: FILE_UPLOAD_TS },
    { symbol: 'BadRequestException', from: classPath(DIRS.errors, 'BadRequestException') },
    { symbol: 'PayloadTooLargeException', from: classPath(DIRS.errors, 'PayloadTooLargeException') },
    { symbol: 'MissingPartError', from: 'src/infrastructure/rest/request-errors.ts' },
    { symbol: 'UnsupportedMediaTypeError', from: 'src/infrastructure/rest/request-errors.ts' }
  ];
  const body = `// La lectura de una subida multipart/form-data, la de keel-spring: el binario como parte, el resto de la entrada
// como campos del formulario (que se leen como los parámetros de la query), y los fallos del propio cuerpo con el
// status y el \`code\` que da su ApiExceptionHandler. El límite de la entrada lo fija http-platform.ts: el doble del
// mayor \`maxSizeMb\` del diseño, para que el límite de NEGOCIO —que el caso de uso comprueba con BucketPolicy, en el
// orden del diseño— se alcance antes que el de la red de seguridad.

/** Lo que trae una subida: los campos simples (repetidos, como lista) y los binarios por nombre de parte. */
export interface MultipartForm {
  readonly fields: Record<string, unknown>;
  readonly files: Readonly<Record<string, FileUpload | null>>;
}

/** El code del 413: el que declara el diseño para el exceso de tamaño, o el canónico del framework. */
const FILE_TOO_LARGE = ${tsString(tooLarge)};
const FILE_UNREADABLE = ${tsString(FRAMEWORK_ERRORS.fileUnreadable.code)};

/**
 * Lee la subida entera. Un binario vacío llega como null (como el MultipartFile vacío de Spring): lo que falte lo
 * decide quien lo pide, con \`requirePart\`.
 */
export async function readMultipart(request: FastifyRequest): Promise<MultipartForm> {
  if (!request.isMultipart()) throw new UnsupportedMediaTypeError();
  const fields: Record<string, unknown> = {};
  const files: Record<string, FileUpload | null> = {};
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const content = await part.toBuffer();
        files[part.fieldname] = content.length === 0 ? null : new FileUpload(new Uint8Array(content), part.filename, part.mimetype, content.length);
      } else {
        const value = part.value;
        const previous = fields[part.fieldname];
        fields[part.fieldname] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new PayloadTooLargeException('El archivo supera el tamaño máximo permitido', { code: FILE_TOO_LARGE });
    }
    // Todo lo demás es un cuerpo que no se puede leer: cortado (ERR_STREAM_PREMATURE_CLOSE), mal formado (busboy) o
    // fuera de los límites del lector (FST_*). Es el FILE_UNREADABLE del catálogo de errores del framework.
    throw new BadRequestException('No se pudo leer el archivo enviado', { code: FILE_UNREADABLE, httpStatus: 400, cause: error });
  }
  return { fields, files };
}

/** El binario de una parte obligatoria: si no vino, es el 400 de keel-spring («Falta la parte…»). */
export function requirePart(files: Readonly<Record<string, FileUpload | null>>, name: string): FileUpload | null {
  if (!(name in files)) throw new MissingPartError(name);
  return files[name] ?? null;
}`;
  return tsModule(MULTIPART_READING_TS, imports, body);
}

// ─── El arnés: la palanca del almacenamiento caído ───────────────────────────

/** ¿Se puede parar el almacenamiento en un flujo? Solo con un almacén que levanta contenedor (minio). */
export function usesStorageControl(model) {
  return usesStorage(model) && model.stack?.storage === 'minio';
}

/**
 * `stopStorage()`/`startStorage()` en flow.ts: la palanca de los escenarios de «bucket caído», la misma que el
 * AbstractFlowIT de keel-spring. Sin ella el agente escribía sus propios helpers (asset-vault, R8).
 */
export function storageHarnessSection(model) {
  if (!usesStorageControl(model)) return '';
  const storage = STORAGE[model.stack.storage];
  return `
const STORAGE_CONTAINER = ${tsString(storageContainer(model.service.name, storage))};
const STORAGE_DEVTOOLS = ${tsString(devtoolsContainer(model.service.name))};
const STORAGE_READY_TIMEOUT_MS = 90_000;

/**
 * Detiene el contenedor del almacenamiento: la palanca de los escenarios de BUCKET CAÍDO. Con él parado, una
 * subida tiene que responder el error que el diseño declara y no custodiar nada. El escenario que lo llama lo
 * restaura en un \`finally\` con \`startStorage()\`.
 */
export async function stopStorage(): Promise<void> {
  run(containerRuntime(), ['stop', STORAGE_CONTAINER], '¿Está la infraestructura arriba (bash infra/up.sh)?');
  await awaitStorage(false);
}

/** Levanta el almacenamiento y ESPERA a que sirva: arrancado no es listo. El sondeo es el de infra/validate-infra.sh. */
export async function startStorage(): Promise<void> {
  run(containerRuntime(), ['start', STORAGE_CONTAINER], '¿Está la infraestructura arriba (bash infra/up.sh)?');
  await awaitStorage(true);
}

async function awaitStorage(up: boolean): Promise<void> {
  const until = Date.now() + STORAGE_READY_TIMEOUT_MS;
  while (Date.now() < until) {
    if (storageAccepts() === up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(\`${storage.label} no \${up ? 'volvió a servir' : 'dejó de servir'} en \${STORAGE_READY_TIMEOUT_MS / 1000} s\`);
}

/** Sondeo de disponibilidad: aquí el fallo es la respuesta, no un error. */
function storageAccepts(): boolean {
  try {
    run(containerRuntime(), ['exec', STORAGE_DEVTOOLS, 'sh', '-c', ${tsString(storage.cliValidateCmd)}]);
    return true;
  } catch {
    return false;
  }
}
`;
}
