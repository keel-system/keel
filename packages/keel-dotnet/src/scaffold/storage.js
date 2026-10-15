// Almacenamiento de binarios (capa storage, incremento 13g). El reparto de keel-spring y keel-nest: build emite el
// CONTRATO —el puerto IFileStorage, lo que el agregado guarda de un binario (StoredObject), la política de cada bucket
// con la comprobación de la FIRMA del contenido, las constantes de los buckets y su configuración— y la ENTRADA
// multipart; el adaptador S3 lo escribe el agente siguiendo la skill keel-dotnet-s3, sobre el stub que deja build y que
// el registro ya cablea.
//
// Por qué la firma la emite build (BucketPolicy.AllowsContent): el Content-Type de una parte multipart lo elige quien
// sube, así que comprobar solo el tipo declarado deja pasar cualquier binario con la etiqueta correcta, y el resultado es
// indistinguible de una subida buena. Ningún escenario la echa de menos. La tabla es la neutral de keel-core
// (gen/content-signatures.js), la misma que la del ContentSignature de keel-spring y de keel-nest.
//
// La configuración (config/parameters/<perfil>/storage.yaml) es la neutral de keel-core (gen/storage-config.js): las
// MISMAS variables y el mismo gradiente que el storage.yaml de keel-spring y el de keel-nest.

import { CONTENT_SIGNATURES } from 'keel-core/gen/content-signatures';
import { declaredErrorFor } from 'keel-core/gen/declared-errors';
import { storageYaml, multipartFileLimitBytes } from 'keel-core/gen/storage-config';
import { STORAGE, devtoolsContainer, storageContainer } from 'keel-core/gen/infra-catalog';
import { FRAMEWORK_ERRORS } from 'keel-core';
import { FRAMEWORK_RESPONSES as FW } from 'keel-core/gen/api-errors';
import { csFile, csMember, csString, located, namespaceOf } from './render.js';
import { configNamespace } from './config.js';

const PROFILES = ['local', 'develop', 'production', 'test'];

export const FILE_STORAGE_PORT = 'IFileStorage';

/** ¿Declara el diseño la capa storage? Entonces se emite el contrato, aunque el stack no elija almacén. */
export function usesStorage(model) {
  return Boolean(model.layersPresent?.storage && model.storage);
}

/** ¿Hay un almacén elegido en el stack? Solo entonces hay configuración, adaptador y registro que arrancar. */
export function usesStorageAdapter(model) {
  return usesStorage(model) && Boolean(model.stack?.storage);
}

/** ¿Alguna operación con ruta recibe un binario? Entonces la entrada HTTP lee multipart/form-data. */
export function usesMultipart(model) {
  return (model.services ?? []).some((service) => (service.operations ?? []).some((operation) => operation.route && operation.multipart));
}

export function storageNamespace(model) {
  return namespaceOf(model, 'storage');
}

export function storageInfraNamespace(model) {
  return namespaceOf(model, 'storageInfra');
}

/** La constante de StoragePolicies de un bucket del diseño (`assetBinaries` → `AssetBinaries`). */
export function bucketConstant(name) {
  return csMember(name);
}

/** Los nombres de la nota de la subida (keel-core/gen/buckets.js `uploadNotes`) en C#. */
export const UPLOAD_NOTE_NAMES_CS = {
  policies: 'storagePolicies',
  forBucket: 'ForBucket',
  constant: bucketConstant,
  allowsSize: 'AllowsSize',
  allowsContent: 'AllowsContent'
};

export function generate(model) {
  const files = [];
  const file = (place, name, usings, body) => {
    const { namespace, path } = located(model, place, name);
    return { path, content: csFile({ namespace, usings, body }) };
  };
  if (usesStorage(model)) {
    const domain = storageNamespace(model);
    files.push(
      file('storage', 'StoredObject', [], storedObjectBody()),
      file('storage', FILE_STORAGE_PORT, [], fileStorageBody(model)),
      file('storage', 'ContentSignature', [], contentSignatureBody()),
      file('storage', 'BucketPolicy', ['System.Globalization'], bucketPolicyBody()),
      file('storage', 'StoragePolicies', [], storagePoliciesBody(model)),
      file('storageInfra', 'StorageSettings', ['System.Globalization', configNamespace(model)], settingsBody(model)),
      file('storageInfra', 'ConfiguredStoragePolicies', [domain], configuredPoliciesBody()),
      file('storageInfra', 'S3FileStorage', [domain], s3StubBody(model)),
      file('storageInfra', 'StorageRegistration', ['Microsoft.Extensions.DependencyInjection', domain], registrationBody())
    );
    if (usesStorageAdapter(model)) {
      files.push(...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/storage.yaml`, content: storageYaml(model, profile) })));
    }
  }
  if (usesMultipart(model)) {
    files.push(file('rest', 'MultipartReading', ['Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Http.Features', 'Microsoft.Extensions.Primitives', namespaceOf(model, 'appSupport'), namespaceOf(model, 'dtos'), namespaceOf(model, 'errors')], multipartReadingBody(model)));
  }
  return files;
}

// ─── Domain/Storage ──────────────────────────────────────────────────────────────────────────────

function storedObjectBody() {
  return `/// <summary>Descripción de un binario ya almacenado: lo devuelve el puerto al subir y es lo que el agregado guarda.</summary>
/// <param name="StorageKey">La clave del objeto en el proveedor; siempre presente, es la que identifica el binario para descargarlo o borrarlo.</param>
/// <param name="Url">
/// URL resoluble. En un bucket público viene poblada (la misma que compone PublicUrl); en uno privado llega null y se pide
/// al leer, con SignedUrl, porque caduca.
/// </param>
/// <param name="ContentType">El MIME del binario (por ejemplo image/png).</param>
/// <param name="SizeBytes">El tamaño en bytes.</param>
public sealed record StoredObject(string StorageKey, string? Url, string ContentType, long SizeBytes);`;
}

// Dos decisiones que el puerto expresa en su FIRMA, las mismas que keel-spring y keel-nest: cada método toma el bucket
// LÓGICO del diseño, y Download/SignedUrl existen solo con un bucket privado y PublicUrl solo con uno público. Un método
// inalcanzable obliga al agente a implementarlo y a inventarse su error.
function fileStorageBody(model) {
  const storage = model.storage ?? {};
  const members = [
    `    /// <summary>Sube el binario y devuelve cómo quedó almacenado, para que el agregado guarde la referencia.</summary>
    Task<StoredObject> Upload(string bucket, string key, ReadOnlyMemory<byte> content, string contentType, CancellationToken cancellationToken = default);`
  ];
  if (storage.hasPrivateBucket) {
    members.push(`    /// <summary>
    /// Trae el binario. Existe porque el diseño declara algún bucket <c>visibility: private</c>, cuyo contenido no es de
    /// lectura directa y tiene que servirlo el propio servicio.
    /// </summary>
    Task<byte[]> Download(string bucket, string key, CancellationToken cancellationToken = default);`);
  }
  if (storage.hasPublicBucket) {
    members.push(`    /// <summary>
    /// URL absoluta y estable del objeto, para exponerla en una respuesta. Existe porque el diseño declara algún bucket
    /// <c>visibility: public</c>. Se compone desde <c>storage.public-base-url</c> —la que ve el CONSUMIDOR: el CDN, o el
    /// host en local—, nunca desde el endpoint interno con el que el servicio habla con el almacén.
    /// </summary>
    string PublicUrl(string bucket, string key);`);
  }
  members.push(`    Task Delete(string bucket, string key, CancellationToken cancellationToken = default);`);
  if (storage.hasPrivateBucket) {
    members.push(`    /// <summary>
    /// URL de lectura temporal de un objeto que no es público. Caduca: se pide al leer, no se persiste ni se cachea en una
    /// respuesta. <b>Cuánto dura no lo elige el adaptador</b>: sale de <see cref="BucketPolicy.SignedUrlTtlSeconds"/>, que
    /// lo lee de lo que declaró el diseño.
    /// </summary>
    Task<string> SignedUrl(string bucket, string key, CancellationToken cancellationToken = default);`);
  }
  return `/// <summary>
/// Puerto de almacenamiento de archivos. La implementación (el proveedor del stack) vive en Infrastructure/Storage y la
/// escribe el agente; el dominio y la aplicación solo dependen de esta interfaz.
/// </summary>
/// <remarks>
/// El parámetro <c>bucket</c> es el nombre LÓGICO del diseño (las constantes de <see cref="StoragePolicies"/>), no el
/// físico del proveedor: traducirlo es cosa del adaptador.
/// </remarks>
public interface ${FILE_STORAGE_PORT}
{
${members.join('\n\n')}
}`;
}

function contentSignatureBody() {
  const hex = (byte) => `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  const entries = Object.entries(CONTENT_SIGNATURES).map(([mime, alternatives]) => {
    const rendered = alternatives.map((parts) => `[${parts.map((part) => `new(${part.offset}, [${part.bytes.map(hex).join(', ')}])`).join(', ')}]`);
    return `        [${csString(mime)}] = [${rendered.join(', ')}],`;
  });
  return `/// <summary>
/// ¿El contenido de un binario se corresponde con el tipo que dice tener? El Content-Type de una parte multipart lo elige
/// el cliente, así que por sí solo no distingue una imagen de un ejecutable renombrado: esta tabla mira los primeros
/// bytes de los formatos que se pueden reconocer así.
/// </summary>
/// <remarks>
/// <b>Alcance, y es una promesa acotada a propósito:</b> un MIME que no esté en la tabla —texto, SVG, CSV, JSON— se
/// ACEPTA, porque no tiene firma que comprobar. Para esos formatos la única comprobación posible es la del tipo declarado.
/// La tabla es la neutral de keel-core: la misma que la del servidor de keel-spring y la del de keel-nest.
/// </remarks>
public static class ContentSignature
{
    /// <summary>Un trozo de firma: los bytes esperados a partir de un desplazamiento.</summary>
    private sealed record Magic(int Offset, byte[] Bytes);

    /// <summary>
    /// Firmas por MIME. Cada elemento de la lista exterior es una ALTERNATIVA (un GIF vale con GIF87a o con GIF89a);
    /// dentro de una alternativa, todos los trozos tienen que casar (un WebP es RIFF al principio y WEBP en el byte 8).
    /// </summary>
    private static readonly Dictionary<string, Magic[][]> Signatures = new(StringComparer.Ordinal)
    {
${entries.join('\n')}
    };

    /// <summary>
    /// ¿El contenido casa con el tipo declarado? true también cuando el tipo no tiene firma conocida. Un contenido vacío
    /// tampoco se juzga aquí: eso es una subida rota, y su error es el del framework (FILE_UNREADABLE).
    /// </summary>
    public static bool Matches(ReadOnlySpan<byte> content, string? declaredContentType)
    {
        if (declaredContentType is null || !Signatures.TryGetValue(declaredContentType.ToLowerInvariant(), out var alternatives))
        {
            return true;
        }
        if (content.IsEmpty)
        {
            return true;
        }
        foreach (var parts in alternatives)
        {
            var all = true;
            foreach (var part in parts)
            {
                if (content.Length < part.Offset + part.Bytes.Length || !content.Slice(part.Offset, part.Bytes.Length).SequenceEqual(part.Bytes))
                {
                    all = false;
                    break;
                }
            }
            if (all)
            {
                return true;
            }
        }
        return false;
    }
}`;
}

function bucketPolicyBody() {
  return `/// <summary>
/// Política declarada para un bucket en storage.keel.yaml. La entrega <see cref="StoragePolicies"/> y la consulta el caso
/// de uso antes de subir: el tamaño, los tipos admitidos y la visibilidad salen del diseño, no del handler.
/// </summary>
public sealed class BucketPolicy
{
    private readonly int? signedUrlTtl;

    /// <param name="name">Nombre lógico del bucket, tal como lo nombra el diseño.</param>
    /// <param name="bucket">Nombre físico en el proveedor.</param>
    /// <param name="publicRead">true si el diseño lo declara <c>visibility: public</c>.</param>
    /// <param name="maxSizeMb">Tamaño máximo admitido en MB, o null si el diseño no lo acota.</param>
    /// <param name="allowedContentTypes">MIME admitidos; vacío significa «sin restricción».</param>
    /// <param name="signedUrlTtlSeconds">Cuánto vale la URL firmada, en segundos, o null si el diseño no lo declara.</param>
    public BucketPolicy(string name, string bucket, bool publicRead, int? maxSizeMb, IReadOnlyList<string>? allowedContentTypes, int? signedUrlTtlSeconds)
    {
        Name = name;
        Bucket = bucket;
        PublicRead = publicRead;
        MaxSizeMb = maxSizeMb;
        AllowedContentTypes = [.. (allowedContentTypes ?? []).Select(type => type.ToLowerInvariant())];
        signedUrlTtl = signedUrlTtlSeconds;
    }

    public string Name { get; }

    public string Bucket { get; }

    public bool PublicRead { get; }

    public int? MaxSizeMb { get; }

    /// <summary>MIME admitidos, en minúsculas; vacío significa «sin restricción».</summary>
    public IReadOnlyList<string> AllowedContentTypes { get; }

    /// <summary>
    /// ¿El binario es admisible en este bucket? Dos preguntas, y las dos son del contrato: el tipo DECLARADO está entre
    /// los admitidos, y el contenido es de verdad de ese tipo.
    /// </summary>
    /// <remarks>
    /// <b>Es el método que usa el caso de uso</b>, no <see cref="AllowsContentType"/>: un ejecutable renombrado a .png y
    /// enviado como image/png pasa la comprobación del tipo declarado, se guarda y —en un bucket público— se sirve.
    /// Devuelve el mismo false en los dos casos a propósito: para el cliente el error es el que el diseño declara para un
    /// formato no admitido, y distinguir «el tipo no vale» de «mentiste sobre el tipo» solo le diría a quien prueba con
    /// qué renombrar.
    /// </remarks>
    public bool AllowsContent(ReadOnlySpan<byte> content, string? declaredContentType) =>
        AllowsContentType(declaredContentType) && ContentSignature.Matches(content, declaredContentType);

    /// <summary>
    /// ¿El MIME DECLARADO está admitido? Sin tipos declarados no hay restricción. Comprobar solo esto es confiar en lo que
    /// dice el cliente: usa <see cref="AllowsContent"/> siempre que tengas los bytes delante.
    /// </summary>
    public bool AllowsContentType(string? contentType) =>
        AllowedContentTypes.Count == 0 || (contentType is not null && AllowedContentTypes.Contains(contentType.ToLowerInvariant()));

    /// <summary>¿El tamaño cabe? Sin límite declarado, siempre.</summary>
    public bool AllowsSize(long sizeBytes) => MaxSizeMb is not { } max || sizeBytes <= max * 1024L * 1024L;

    /// <summary>
    /// Cuánto vale la URL firmada de este bucket, en segundos, según lo declara el diseño
    /// (<c>storage.buckets.&lt;n&gt;.signedUrlTtlSeconds</c>). <b>Es la ventana que usa el adaptador, no una
    /// sugerencia</b>: es contrato con quien recibe el enlace.
    /// </summary>
    /// <exception cref="InvalidOperationException">Si el diseño no la declara: una firma que no caduca no se emite.</exception>
    public int SignedUrlTtlSeconds() =>
        signedUrlTtl ?? throw new InvalidOperationException(
            string.Create(CultureInfo.InvariantCulture, $"storage.buckets.{Name} no declara signedUrlTtlSeconds: un bucket privado se lee por URL firmada, y esa firma tiene que caducar. Decláralo en el diseño."));
}`;
}

function storagePoliciesBody(model) {
  const buckets = model.storage?.buckets ?? [];
  const constants = buckets.map((bucket) => `    /// <summary>Bucket <c>${bucket.name}</c> declarado en storage.keel.yaml.</summary>\n    public const string ${bucketConstant(bucket.name)} = ${csString(bucket.name)};`);
  return `/// <summary>
/// Acceso a la política declarada de cada bucket. La implementación vive en Infrastructure/Storage y la puebla la
/// configuración por perfil; el dominio y la aplicación solo dependen de esta clase. Las constantes evitan que el nombre
/// del bucket viaje como literal: si el diseño lo renombra, lo que falla es la compilación.
/// </summary>
public abstract class StoragePolicies
{
${constants.join('\n\n')}

    /// <summary>La política del bucket, por su nombre lógico. Lanza si la configuración no lo declara: es un fallo de despliegue.</summary>
    public abstract BucketPolicy ForBucket(string name);
}`;
}

// ─── Infrastructure/Storage ──────────────────────────────────────────────────────────────────────

function settingsBody(model) {
  const publicBase = Boolean(model.storage?.hasPublicBucket);
  const buckets = model.storage?.buckets ?? [];
  const reads = buckets.map((bucket) => `                [${csString(bucket.name)}] = Bucket(configuration, ${csString(bucket.name)}),`);
  return `/// <summary>Un bucket tal como lo declara storage.yaml.</summary>
public sealed record BucketSettings(string Bucket, string Visibility, int? MaxSizeMb, IReadOnlyList<string> AllowedContentTypes, int? SignedUrlTtlSeconds);

/// <summary>
/// Lo que el almacenamiento lee de config/parameters/&lt;perfil&gt;/storage.yaml: las MISMAS claves y variables que el
/// storage.yaml de keel-spring y el de keel-nest (STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY,
/// STORAGE_SECRET_KEY, STORAGE_BUCKET_&lt;B&gt;…). Es el único sitio por el que esos valores entran al código.
/// </summary>
/// <param name="Provider">El almacén del stack (minio o s3).</param>
/// <param name="Endpoint">Con quién habla el servicio (MinIO en local); null con S3, que resuelve el endpoint por región.</param>
/// <param name="PathStyleAccess">true con MinIO: el bucket va en la ruta, no en el host.</param>${publicBase ? `
/// <param name="PublicBaseUrl">La base de las URLs públicas: la que alcanza el CONSUMIDOR (CDN, o el host en local), no el endpoint interno.</param>` : ''}
/// <param name="EnsureBucketsOnStartup">¿Crea los buckets (y la lectura pública) al arrancar? Decisión de entorno: sí en local, no en test.</param>
/// <param name="Buckets">Los buckets del diseño, por su nombre lógico.</param>
public sealed record StorageSettings(
    string Provider,
    string? Endpoint,
    string Region,
    string AccessKey,
    string SecretKey,
    bool PathStyleAccess,${publicBase ? '\n    string PublicBaseUrl,' : ''}
    bool EnsureBucketsOnStartup,
    IReadOnlyDictionary<string, BucketSettings> Buckets)
{
    /// <summary>Sin almacén: la de las pruebas de build que construyen el contenedor (nadie sube nada ahí).</summary>
    public static StorageSettings Unconfigured { get; } = new(${csString(model.stack?.storage ?? 'minio')}, null, "us-east-1", "", "", true,${publicBase ? ' "",' : ''} false, new Dictionary<string, BucketSettings>());

    public static StorageSettings From(ServiceConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return new StorageSettings(
            Text(configuration, "storage:provider") ?? ${csString(model.stack?.storage ?? 'minio')},
            Text(configuration, "storage:endpoint"),
            Text(configuration, "storage:region") ?? "us-east-1",
            Text(configuration, "storage:access-key") ?? "",
            Text(configuration, "storage:secret-key") ?? "",
            Flag(configuration, "storage:path-style-access", false),${publicBase ? '\n            (Text(configuration, "storage:public-base-url") ?? "").TrimEnd(\'/\'),' : ''}
            Flag(configuration, "storage:ensure-buckets-on-startup", false),
            new Dictionary<string, BucketSettings>(StringComparer.Ordinal)
            {
${reads.join('\n')}
            });
    }

    /// <summary>Un bucket del diseño. Su nombre físico es obligatorio: sin él, el servicio no arranca (fallo de despliegue).</summary>
    private static BucketSettings Bucket(ServiceConfiguration configuration, string name)
    {
        var prefix = $"storage:buckets:{name}:";
        return new BucketSettings(
            Text(configuration, prefix + "bucket") ?? throw new InvalidOperationException($"storage.buckets.{name}.bucket no está configurado: revisa config/parameters/<perfil>/storage.yaml"),
            Text(configuration, prefix + "visibility") ?? "private",
            OptionalNumber(configuration, prefix + "max-size-mb"),
            List(configuration, prefix + "allowed-content-types"),
            OptionalNumber(configuration, prefix + "signed-url-ttl-seconds"));
    }

    private static string? Text(ServiceConfiguration configuration, string key) =>
        configuration.Get(key) is { } value && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    private static bool Flag(ServiceConfiguration configuration, string key, bool fallback) =>
        Text(configuration, key) is { } value ? string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) : fallback;

    private static int? OptionalNumber(ServiceConfiguration configuration, string key)
    {
        var value = Text(configuration, key);
        if (value is null)
        {
            return null;
        }
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"{key.Replace(':', '.')} tiene que ser un número no negativo: '{value}'");
    }

    /// <summary>Una lista separada por comas, como la enlaza Spring.</summary>
    private static string[] List(ServiceConfiguration configuration, string key) =>
        Text(configuration, key) is { } value
            ? [.. value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)]
            : [];
}`;
}

function configuredPoliciesBody() {
  return `/// <summary>La política de cada bucket, leída de <c>storage.buckets.*</c>: el adaptador del puerto StoragePolicies.</summary>
public sealed class ConfiguredStoragePolicies(StorageSettings settings) : StoragePolicies
{
    private readonly StorageSettings settings = settings;

    public override BucketPolicy ForBucket(string name)
    {
        if (!settings.Buckets.TryGetValue(name, out var bucket))
        {
            throw new InvalidOperationException($"storage.buckets.{name} no está configurado: revisa config/parameters/<perfil>/storage.yaml");
        }
        return new BucketPolicy(name, bucket.Bucket, bucket.Visibility == "public", bucket.MaxSizeMb, bucket.AllowedContentTypes, bucket.SignedUrlTtlSeconds);
    }
}`;
}

// El adaptador lo escribe el agente (skill keel-dotnet-s3): build deja la clase que el registro ya cablea, con lo que
// necesita inyectado y un TODO por método. Compila y arranca; lo que llame al puerto antes de que el agente lo complete
// recibe un error que lo dice.
function s3StubBody(model) {
  const storage = model.storage ?? {};
  const todo = (what) => `throw new NotImplementedException("TODO (agente): ${what} — skills/keel-dotnet-s3");`;
  const methods = [
    `    public Task<StoredObject> Upload(string bucket, string key, ReadOnlyMemory<byte> content, string contentType, CancellationToken cancellationToken = default) =>
        ${todo('Upload')}`
  ];
  if (storage.hasPrivateBucket) {
    methods.push(`    public Task<byte[]> Download(string bucket, string key, CancellationToken cancellationToken = default) =>
        ${todo('Download')}`);
  }
  if (storage.hasPublicBucket) {
    methods.push(`    public string PublicUrl(string bucket, string key) =>
        ${todo('PublicUrl')}`);
  }
  methods.push(`    public Task Delete(string bucket, string key, CancellationToken cancellationToken = default) =>
        ${todo('Delete')}`);
  if (storage.hasPrivateBucket) {
    methods.push(`    public Task<string> SignedUrl(string bucket, string key, CancellationToken cancellationToken = default) =>
        ${todo('SignedUrl')}`);
  }
  const label = STORAGE[model.stack?.storage]?.label ?? 'S3';
  return `/// <summary>
/// El adaptador del puerto IFileStorage sobre el protocolo S3 (${label}). LO ESCRIBE EL AGENTE siguiendo la skill
/// keel-dotnet-s3: el cliente de AWSSDK.S3 con la configuración de <c>settings</c> (ServiceURL y ForcePathStyle con MinIO),
/// el bucket FÍSICO de <c>policies.ForBucket(bucket).Bucket</c> —el que crea el sidecar minio-init de infra/—, el
/// aprovisionamiento al arrancar si <c>settings.EnsureBucketsOnStartup</c> y, para un bucket privado, la URL firmada con la
/// caducidad que declara el diseño (<c>SignedUrlTtlSeconds()</c>).
/// </summary>
/// <remarks>StorageRegistration ya lo registra como IFileStorage: no lo registres en otro sitio.</remarks>
public sealed class S3FileStorage(StorageSettings settings, StoragePolicies policies) : ${FILE_STORAGE_PORT}
{
    private readonly StorageSettings settings = settings;
    private readonly StoragePolicies policies = policies;

${methods.join('\n\n')}
}`;
}

function registrationBody() {
  return `/// <summary>
/// El almacenamiento de binarios en el contenedor: la configuración, la política de cada bucket y el adaptador del puerto.
/// Los handlers reciben IFileStorage y StoragePolicies.
/// </summary>
public static class StorageRegistration
{
    public static IServiceCollection AddStorage(this IServiceCollection services, StorageSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        services.AddSingleton(settings);
        services.AddSingleton<StoragePolicies, ConfiguredStoragePolicies>();
        services.AddSingleton<${FILE_STORAGE_PORT}, S3FileStorage>();
        return services;
    }
}`;
}

// ─── Api/Rest/MultipartReading.cs ────────────────────────────────────────────────────────────────

function multipartReadingBody(model) {
  const tooLarge = declaredErrorFor(model, FRAMEWORK_ERRORS.fileTooLarge)?.code ?? FRAMEWORK_ERRORS.fileTooLarge.code;
  const [partBefore, partAfter] = FW.missingPart.message.split('{name}');
  return `// La lectura de una subida multipart/form-data, la de keel-spring y keel-nest: el binario como parte, el resto de la
// entrada como campos del formulario (que se leen como los parámetros de la query), y los fallos del propio cuerpo con el
// status y el \`code\` que da su ApiExceptionHandler. El límite de la entrada es el doble del mayor \`maxSizeMb\` del diseño,
// para que el límite de NEGOCIO —que el caso de uso comprueba con BucketPolicy, en el orden del diseño— se alcance antes
// que el de la red de seguridad.

/// <summary>Lo que trae una subida: los campos simples (repetidos, como lista) y los binarios por nombre de parte.</summary>
public sealed record MultipartForm(IFormCollection Fields, IReadOnlyDictionary<string, FileUpload?> Files);

/// <summary>Falta la parte binaria obligatoria de una subida (el MissingServletRequestPartException de keel-spring): 400 sin code.</summary>
public sealed class MissingPartException(string part) : Exception(${csString(partBefore)} + part + ${csString(partAfter)})
{
    public string Part { get; } = part;
}

/// <summary>Una operación de subida recibió un cuerpo que no es multipart/form-data: 415 sin code.</summary>
public sealed class NotMultipartException() : Exception(${csString(FW.notMultipart.message)});

public static class MultipartReading
{
    /// <summary>El límite de la ENTRADA en bytes: el doble del mayor maxSizeMb del diseño (el del servlet de keel-spring).</summary>
    public const long LimitBytes = ${multipartFileLimitBytes(model)};

    /// <summary>El code del 413: el que declara el diseño para el exceso de tamaño, o el canónico del framework.</summary>
    private const string FileTooLarge = ${csString(tooLarge)};

    private const string FileUnreadable = ${csString(FRAMEWORK_ERRORS.fileUnreadable.code)};

    /// <summary>
    /// Lee la subida entera. Un binario vacío llega como null (como el MultipartFile vacío de Spring): lo que falte lo
    /// decide quien lo pide, con <see cref="RequirePart"/>.
    /// </summary>
    public static async Task<MultipartForm> Read(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasFormContentType || !(request.ContentType ?? "").StartsWith("multipart/form-data", StringComparison.OrdinalIgnoreCase))
        {
            throw new NotMultipartException();
        }
        // Dos redes del mismo límite: la longitud declarada (se rechaza sin leer, como Tomcat) y, para un cuerpo por trozos,
        // el límite de Kestrel en esta petición (su máximo por defecto, 30 MB, es otro número que el del diseño).
        if (request.ContentLength > LimitBytes)
        {
            throw TooLarge();
        }
        if (request.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } bodySize)
        {
            bodySize.MaxRequestBodySize = LimitBytes;
        }
        var cancellation = request.HttpContext.RequestAborted;
        try
        {
            var form = await request.ReadFormAsync(cancellation);
            var files = new Dictionary<string, FileUpload?>(StringComparer.Ordinal);
            foreach (var file in form.Files)
            {
                files[file.Name] = file.Length == 0 ? null : new FileUpload(await Content(file, cancellation), file.FileName, file.ContentType, file.Length);
            }
            return new MultipartForm(form, files);
        }
        catch (BadHttpRequestException error) when (error.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            throw TooLarge(error);
        }
        catch (Exception error) when (error is BadHttpRequestException or InvalidDataException or IOException && !cancellation.IsCancellationRequested)
        {
            // Un cuerpo que no se puede leer: cortado, mal formado o fuera de los límites del lector. Es el FILE_UNREADABLE
            // del catálogo de errores del framework.
            throw new BadRequestException(${csString(FW.fileUnreadable.message)}, FileUnreadable, StatusCodes.Status400BadRequest, cause: error);
        }
    }

    /// <summary>
    /// El valor de texto de un campo: el del formulario y, si no viene ahí, el de la query (el @RequestParam de keel-spring
    /// lee los dos).
    /// </summary>
    public static StringValues Field(HttpRequest request, MultipartForm form, string name)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(form);
        return form.Fields.TryGetValue(name, out var value) ? value : request.Query[name];
    }

    /// <summary>Un campo obligatorio tiene que venir, en el formulario o en la query; vacío cuenta como presente.</summary>
    public static void RequireField(HttpRequest request, MultipartForm form, string name)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(form);
        if (!form.Fields.ContainsKey(name) && !request.Query.ContainsKey(name))
        {
            throw new MissingParameterException(name);
        }
    }

    /// <summary>El binario de una parte obligatoria: si no vino, es el 400 de keel-spring («Falta la parte…»).</summary>
    public static FileUpload RequirePart(MultipartForm form, string name)
    {
        ArgumentNullException.ThrowIfNull(form);
        if (!form.Files.TryGetValue(name, out var file))
        {
            throw new MissingPartException(name);
        }
        // Una parte obligatoria que llega VACÍA (0 bytes) no es «sin archivo»: es una subida rota, el FILE_UNREADABLE del
        // catálogo del framework (corrida asset-vault de keel-nest, VAL-UPL-8).
        return file ?? throw new BadRequestException(${csString(FW.fileEmpty.message)}, FileUnreadable, StatusCodes.Status400BadRequest);
    }

    /// <summary>El binario de una parte opcional: null si no vino o llegó vacía.</summary>
    public static FileUpload? OptionalPart(MultipartForm form, string name)
    {
        ArgumentNullException.ThrowIfNull(form);
        return form.Files.TryGetValue(name, out var file) ? file : null;
    }

    private static PayloadTooLargeException TooLarge(Exception? cause = null) =>
        new(${csString(FW.fileTooLarge.message)}, FileTooLarge, StatusCodes.Status413PayloadTooLarge, cause: cause);

    private static async Task<ReadOnlyMemory<byte>> Content(IFormFile file, CancellationToken cancellationToken)
    {
        var buffer = new byte[file.Length];
        await using var stream = file.OpenReadStream();
        await stream.ReadExactlyAsync(buffer, cancellationToken);
        return buffer;
    }
}`;
}

// ─── Para quien compone otros archivos ───────────────────────────────────────────────────────────

/** Program.cs: lo que añade el almacenamiento al arranque (con un almacén elegido en el stack). */
export function storageProgram(model) {
  if (!usesStorageAdapter(model)) return { usings: [], registration: '' };
  return {
    usings: [storageInfraNamespace(model)],
    registration: `
// El almacenamiento de binarios (capa storage): la política de cada bucket y el adaptador S3 que escribe el agente.
builder.Services.AddStorage(StorageSettings.From(configuration));`
  };
}

// ─── El arnés: la palanca del almacenamiento caído ───────────────────────────────────────────────

/** ¿Se puede parar el almacenamiento en un flujo? Solo con un almacén que levanta contenedor (minio). */
export function usesStorageControl(model) {
  return usesStorage(model) && model.stack?.storage === 'minio';
}

/**
 * Los miembros de FlowTest: `Upload(...)` con una subida en el diseño (el `multipart(...)` del AbstractFlowIT de
 * keel-spring y el `flow.upload` de keel-nest) y, con MinIO, `StopStorage()`/`StartStorage()`, la palanca de los escenarios
 * de bucket caído. Sin ellos el agente escribía sus propios helpers (asset-vault, R8).
 */
export function storageFlowMembers(model) {
  const members = [];
  if (usesMultipart(model)) {
    members.push(`    /// <summary>
    /// Una subida multipart/form-data (POST): el binario como la parte <c>file.Part</c> y el resto de la entrada como campos
    /// del formulario (una lista, como el campo repetido). El mismo contrato que el <c>multipart(...)</c> del AbstractFlowIT
    /// de keel-spring y el <c>flow.upload</c> de keel-nest.
    /// </summary>
    protected static Task<FlowResponse> Upload(string path, UploadPart file, IReadOnlyDictionary<string, object?>? fields = null, Dictionary<string, string>? headers = null) =>
        Harness.UploadAsync(path, file, fields, headers, TestContext.Current.CancellationToken);`);
  }
  if (usesStorageControl(model)) {
    const storage = STORAGE[model.stack.storage];
    const hint = csString('¿Está la infraestructura arriba (bash infra/up.sh)?');
    members.push(`    private const string StorageContainer = ${csString(storageContainer(model.service.name, storage))};

    /// <summary>
    /// Detiene el contenedor del almacenamiento: la palanca de los escenarios de BUCKET CAÍDO. Con él parado, una subida
    /// tiene que responder el error que el diseño declara y no custodiar nada. El escenario que lo llama lo restaura en un
    /// <c>finally</c> con <see cref="StartStorage"/>.
    /// </summary>
    protected static Task StopStorage()
    {
        Run(Harness.ContainerRuntime(), ["stop", StorageContainer], ${hint});
        return AwaitStorage(false);
    }

    /// <summary>Levanta el almacenamiento y ESPERA a que sirva: arrancado no es listo. El sondeo es el de infra/validate-infra.sh.</summary>
    protected static Task StartStorage()
    {
        Run(Harness.ContainerRuntime(), ["start", StorageContainer], ${hint});
        return AwaitStorage(true);
    }

    private static async Task AwaitStorage(bool up)
    {
        var until = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < until)
        {
            if (StorageAccepts() == up) return;
            await Task.Delay(500, TestContext.Current.CancellationToken);
        }
        throw new InvalidOperationException(up ? ${csString(`${storage.label} no volvió a servir en 90 s`)} : ${csString(`${storage.label} no dejó de servir en 90 s`)});
    }

    /// <summary>Sondeo de disponibilidad: aquí el fallo es la respuesta, no un error.</summary>
    private static bool StorageAccepts()
    {
        try
        {
            Run(Harness.ContainerRuntime(), ["exec", ${csString(devtoolsContainer(model.service.name))}, "sh", "-c", ${csString(storage.cliValidateCmd)}]);
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }`);
  }
  return members;
}

/** La parte binaria de una subida, en Support/Harness.cs (la usan Upload y quien escribe el flujo). */
export function uploadPartRecord(model) {
  if (!usesMultipart(model)) return '';
  return `/// <summary>La parte binaria de una subida: su nombre de parte, el del archivo, el tipo DECLARADO y los bytes.</summary>
public sealed record UploadPart(string Part, string Filename, string ContentType, byte[] Content);

`;
}

/** Harness.UploadAsync: la subida de verdad, con su evidencia (los campos con su valor y el binario por tamaño, nunca los bytes). */
export function uploadHarnessSection(model) {
  if (!usesMultipart(model)) return null;
  return `    /// <summary>Una subida multipart/form-data al servidor del flujo. Nunca lanza por un 4xx/5xx: el status es una aserción.</summary>
    public static async Task<FlowResponse> UploadAsync(string path, UploadPart file, IReadOnlyDictionary<string, object?>? fields, IReadOnlyDictionary<string, string>? headers, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(file);
        if (string.IsNullOrEmpty(FlowServer.BaseUrl)) throw new InvalidOperationException("El servidor no está arrancado: la prueba de flujo hereda de FlowTest.");
        using var form = new MultipartFormDataContent();
        var described = new List<string>();
        foreach (var (name, value) in fields ?? new Dictionary<string, object?>())
        {
            foreach (var field in FieldValues(value))
            {
                form.Add(new StringContent(field, Encoding.UTF8), name);
                described.Add(name + "=" + field);
            }
        }
        var binary = new ByteArrayContent(file.Content);
        if (!string.IsNullOrEmpty(file.ContentType)) binary.Headers.TryAddWithoutValidation("Content-Type", file.ContentType);
        form.Add(binary, file.Part, file.Filename);
        described.Add($"{file.Part}=<{file.Content.Length} bytes, {file.ContentType}>");
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(FlowServer.BaseUrl), path)) { Content = form };
        var sent = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Accept"] = "application/json" };
        foreach (var (name, value) in headers ?? new Dictionary<string, string>())
        {
            if (!name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) sent[name] = value;
        }
        foreach (var (name, value) in sent) request.Headers.TryAddWithoutValidation(name, value);
        sent["Content-Type"] = "multipart/form-data";
        using var response = await Http.SendAsync(request, cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        var received = new Dictionary<string, string>();
        foreach (var header in response.Headers.Concat(response.Content.Headers)) received[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
        FailureCapture.RecordExchange(new ExchangeRecord("POST", path, sent, "multipart: " + string.Join("; ", described), (int)response.StatusCode, received, text));
        return new FlowResponse((int)response.StatusCode, received, text);
    }

    /// <summary>Los valores de un campo del formulario: una lista viaja como el campo repetido; un nulo no viaja.</summary>
    private static IEnumerable<string> FieldValues(object? value) =>
        value switch
        {
            null => [],
            string text => [text],
            bool flag => [flag ? "true" : "false"],
            System.Collections.IEnumerable many => many.Cast<object?>().SelectMany(FieldValues),
            _ => [Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? ""]
        };`;
}
