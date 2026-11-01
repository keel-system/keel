// Almacenamiento de binarios (capa storage, tramo 13f). El reparto de keel-spring, keel-nest y keel-dotnet: build emite
// el CONTRATO —el puerto domain.FileStorage, lo que el agregado guarda de un binario (StoredObject), la política de cada
// bucket con la comprobación de la FIRMA del contenido y las constantes de los buckets—, su configuración, el cliente S3
// y la ENTRADA multipart; el adaptador lo escribe el agente siguiendo la skill keel-go-s3, en un archivo sin la cabecera
// de código generado que el arranque ya cablea.
//
// Por qué la firma la emite build (BucketPolicy.AllowsContent): el Content-Type de una parte multipart lo elige quien
// sube, así que comprobar solo el tipo declarado deja pasar cualquier binario con la etiqueta correcta, y el resultado es
// indistinguible de una subida buena. Ningún escenario la echa de menos. La tabla es la neutral de keel-core
// (gen/content-signatures.js), la misma que la de los otros tres.
//
// La configuración (config/parameters/<perfil>/storage.yaml) es la neutral de keel-core (gen/storage-config.js): las
// MISMAS variables y el mismo gradiente que el storage.yaml de los otros tres.
//
// Lo que Go obliga a decidir:
//   · el cliente S3 (client.go) lo emite build, no el agente: si solo lo importara el archivo del agente, el go.mod que
//     escribe build tendría un requisito directo que tidy movería hasta que el agente lo usara;
//   · PublicURL devuelve también un error (el bucket que la configuración no declara), así que el mapeo que la usa lo
//     propaga, como cualquier otro mapeo que puede fallar;
//   · el 413 del caso de uso necesita un centinela: si el diseño no declara su error, el dominio lleva ErrFileTooLarge
//     con el code canónico (errors.js).

import { CONTENT_SIGNATURES } from '@keel-system/keel-core/gen/content-signatures';
import { declaredErrorFor, effectiveErrorCode } from '@keel-system/keel-core/gen/declared-errors';
import { storageYaml, multipartFileLimitBytes } from '@keel-system/keel-core/gen/storage-config';
import { STORAGE, devtoolsContainer, storageContainer } from '@keel-system/keel-core/gen/infra-catalog';
import { uploadNotes } from '@keel-system/keel-core/gen/buckets';
import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { FRAMEWORK_RESPONSES as FW } from '@keel-system/keel-core/gen/api-errors';
import { usesMultipart, usesStorage, usesStorageControl } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';

export { usesMultipart, usesStorage, usesStorageControl };

const PROFILES = ['local', 'develop', 'production', 'test'];

/** El import del paquete del almacenamiento, relativo al módulo. */
export const STORAGE_IMPORT = 'internal/infrastructure/storage';

/** El puerto y la política en Dependencies y en el handler. */
export const FILE_STORAGE = { field: 'FileStorage', param: 'fileStorage', type: 'domain.FileStorage' };
export const STORAGE_POLICIES = { field: 'StoragePolicies', param: 'storagePolicies', type: 'domain.StoragePolicies' };

/** El archivo del agente: el adaptador del puerto, sin la cabecera de código generado. */
export const ADAPTER_FILE = 'storage.go';

/** ¿Hay un almacén elegido en el stack? Solo entonces hay configuración, cliente y adaptador que arrancar. */
export function usesStorageAdapter(model) {
  return usesStorage(model) && Boolean(model.stack?.storage);
}

/** La constante del dominio de un bucket del diseño (`productImages` → `BucketProductImages`). */
export function bucketConstant(name) {
  return `Bucket${goExported(name)}`;
}

/** Los nombres de la nota de la subida (keel-core/gen/buckets.js `uploadNotes`) en Go: el handler los lee de `h`. */
export const UPLOAD_NOTE_NAMES_GO = {
  policies: `h.${STORAGE_POLICIES.param}`,
  forBucket: 'ForBucket',
  constant: bucketConstant,
  bucketRef: (constant) => `domain.${constant}`,
  allowsSize: 'AllowsSize',
  allowsContent: 'AllowsContent'
};

/** ¿Sube un binario la operación? Entonces su handler comprueba la política del bucket y llama al puerto. */
export function uploadsFile(model, operation) {
  return usesStorage(model) && uploadNotes(model, operation, { sizeCode: '' }).length > 0;
}

/** Las notas de la subida del handler, con los nombres de Go y el code del 413 que sale por el cable. */
export function uploadHandlerNotes(model, operation) {
  if (!usesStorage(model)) return [];
  return uploadNotes(model, operation, { sizeCode: effectiveErrorCode(model, FRAMEWORK_ERRORS.fileTooLarge), names: UPLOAD_NOTE_NAMES_GO });
}

/**
 * El centinela del 413 del caso de uso cuando el diseño no declara el suyo: sin él, el handler no tendría con qué
 * responder el exceso del bucket (los otros tres lanzan su excepción de framework).
 */
export function storageSentinels(model) {
  if (!usesStorage(model) || declaredErrorFor(model, FRAMEWORK_ERRORS.fileTooLarge)) return [];
  return [
    {
      name: 'ErrFileTooLarge',
      doc: 'la subida supera el tamaño máximo que el diseño declara para su bucket (BucketPolicy.AllowsSize). Lo usa el caso de uso: el diseño no nombra un code propio para este rechazo.',
      ...FRAMEWORK_ERRORS.fileTooLarge
    }
  ];
}

/** Lo que recibe el handler: la política y el puerto si sube un binario; el puerto si su respuesta expone una URL pública. */
export function storageDependencies(model, operation, { publicUrl = false } = {}) {
  if (!usesStorage(model)) return [];
  const deps = [];
  if (uploadsFile(model, operation)) {
    deps.push({
      name: STORAGE_POLICIES.param,
      type: STORAGE_POLICIES.type,
      doc: `${STORAGE_POLICIES.param} da la política de cada bucket (storage.keel.yaml): tamaño, tipos admitidos y firma del contenido.`,
      arg: `deps.${STORAGE_POLICIES.field}`
    });
  }
  if (uploadsFile(model, operation) || publicUrl) {
    deps.push({
      name: FILE_STORAGE.param,
      type: FILE_STORAGE.type,
      doc: `${FILE_STORAGE.param} es el almacenamiento de binarios (capa storage)${publicUrl ? ': también resuelve la URL pública que devuelve el mapeo' : ''}.`,
      arg: `deps.${FILE_STORAGE.field}`
    });
  }
  return deps;
}

/** Las filas de Dependencies. */
export function storageDependencyRows(model) {
  if (!usesStorage(model)) return [];
  return [
    { text: '\t// StoragePolicies da la política de cada bucket del diseño (storage.keel.yaml).' },
    { indent: '\t', cells: [STORAGE_POLICIES.field, STORAGE_POLICIES.type] },
    { text: '\t// FileStorage es el almacenamiento de binarios: el adaptador S3 que escribe el agente.' },
    { indent: '\t', cells: [FILE_STORAGE.field, FILE_STORAGE.type] }
  ];
}

export function generate(model) {
  const files = [];
  if (usesStorage(model)) {
    const { domain } = layout(model);
    files.push(
      { path: `${domain.dir}/file_storage.go`, content: packageFile(model, domain, { imports: ['context'], body: fileStorageBody(model) }) },
      { path: `${domain.dir}/bucket_policy.go`, content: packageFile(model, domain, { imports: ['bytes', 'fmt', 'slices', 'strings', 'time'], body: bucketPolicyBody(model) }) },
      {
        path: `${domain.dir}/bucket_policy_test.go`,
        content: packageFile(model, domain, { test: true, imports: ['slices', 'strings', 'testing', 'time', 'internal/domain'], body: bucketPolicyTest(model) })
      }
    );
    if (usesStorageAdapter(model)) {
      const { storage } = layout(model);
      files.push(
        { path: `${storage.dir}/settings.go`, content: packageFile(model, storage, { imports: ['fmt', 'strconv', 'strings', 'time', 'internal/platform/config'], body: settingsBody(model) }) },
        { path: `${storage.dir}/policies.go`, content: packageFile(model, storage, { imports: ['fmt', 'internal/domain'], body: policiesBody() }) },
        {
          path: `${storage.dir}/client.go`,
          content: packageFile(model, storage, {
            imports: ['context', 'fmt', 'github.com/aws/aws-sdk-go-v2/aws', 'github.com/aws/aws-sdk-go-v2/config', 'github.com/aws/aws-sdk-go-v2/credentials', 'github.com/aws/aws-sdk-go-v2/service/s3'],
            body: clientBody(model)
          })
        },
        {
          path: `${storage.dir}/${ADAPTER_FILE}`,
          content: packageFile(model, storage, { generated: false, imports: ['context', 'errors', 'github.com/aws/aws-sdk-go-v2/service/s3', 'internal/domain'], body: adapterBody(model) })
        },
        ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/storage.yaml`, content: storageYaml(model, profile) }))
      );
    }
  }
  if (usesMultipart(model)) {
    const { httpapi } = layout(model);
    files.push({
      path: `${httpapi.dir}/multipart.go`,
      content: packageFile(model, httpapi, { imports: ['errors', 'io', 'mime', 'mime/multipart', 'net/http', 'net/url', 'internal/application'], body: multipartBody(model) })
    });
  }
  return files;
}

// ─── internal/domain ─────────────────────────────────────────────────────────────────────────────

// Dos decisiones que el puerto expresa en su FIRMA, las mismas que los otros tres: cada método toma el bucket LÓGICO del
// diseño, y Download/SignedURL existen solo con un bucket privado y PublicURL solo con uno público. Un método inalcanzable
// obliga al agente a implementarlo y a inventarse su error.
function fileStorageBody(model) {
  const storage = model.storage ?? {};
  const methods = [
    '\t// Upload sube el binario y devuelve cómo quedó almacenado, para que el agregado guarde la referencia.\n\tUpload(ctx context.Context, bucket, key string, content []byte, contentType string) (StoredObject, error)'
  ];
  if (storage.hasPrivateBucket) {
    methods.push(
      '\t// Download trae el binario. Existe porque el diseño declara algún bucket visibility: private, cuyo contenido no es de\n\t// lectura directa y tiene que servirlo el propio servicio.\n\tDownload(ctx context.Context, bucket, key string) ([]byte, error)'
    );
  }
  if (storage.hasPublicBucket) {
    methods.push(
      '\t// PublicURL es la URL absoluta y estable del objeto, para exponerla en una respuesta. Existe porque el diseño declara\n\t// algún bucket visibility: public. Se compone desde storage.public-base-url —la que ve el CONSUMIDOR: el CDN, o el\n\t// host en local—, nunca desde el endpoint interno con el que el servicio habla con el almacén. No habla con el almacén;\n\t// el error es un bucket que la configuración no declara.\n\tPublicURL(bucket, key string) (string, error)'
    );
  }
  methods.push('\t// Delete borra el objeto. Borrar uno que no existe no es un error.\n\tDelete(ctx context.Context, bucket, key string) error');
  if (storage.hasPrivateBucket) {
    methods.push(
      '\t// SignedURL es una URL de lectura temporal de un objeto que no es público. Caduca: se pide al leer, no se persiste\n\t// ni se cachea en una respuesta. Cuánto dura NO lo elige el adaptador: sale de BucketPolicy.SignedURLTTL, que lo lee\n\t// de lo que declaró el diseño.\n\tSignedURL(ctx context.Context, bucket, key string) (string, error)'
    );
  }
  return `
// StoredObject describe un binario ya almacenado: lo devuelve el puerto al subir y es lo que el agregado guarda.
type StoredObject struct {
	// StorageKey es la clave del objeto en el proveedor; siempre presente, es la que identifica el binario para
	// descargarlo o borrarlo.
	StorageKey string
	// URL es resoluble en un bucket público (la misma que compone PublicURL); en uno privado llega nil y se pide al leer,
	// con SignedURL, porque caduca.
	URL *string
	// ContentType es el MIME del binario (por ejemplo image/png).
	ContentType string
	// SizeBytes es el tamaño en bytes.
	SizeBytes int64
}

// FileStorage es el puerto de almacenamiento de binarios. La implementación (el proveedor del stack) vive en
// internal/infrastructure/storage y la escribe el agente; el dominio y la aplicación solo dependen de esta interfaz.
//
// El parámetro bucket es el nombre LÓGICO del diseño (las constantes Bucket* de este paquete), no el físico del
// proveedor: traducirlo es cosa del adaptador.
type FileStorage interface {
${methods.join('\n\n')}
}
`;
}

function signatureTable() {
  const hex = (byte) => `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  const rows = Object.entries(CONTENT_SIGNATURES).map(([mime, alternatives]) => {
    const rendered = alternatives.map((parts) => `{${parts.map((part) => `{${part.offset}, []byte{${part.bytes.map(hex).join(', ')}}}`).join(', ')}}`);
    return { indent: '\t', cells: [`${goString(mime)}:`, `{${rendered.join(', ')}},`] };
  });
  return alignRows(rows).join('\n');
}

function bucketPolicyBody(model) {
  const buckets = model.storage?.buckets ?? [];
  const constants = alignRows(
    buckets.flatMap((bucket) => [
      { text: `\t// ${bucketConstant(bucket.name)} es el bucket ${bucket.name} declarado en storage.keel.yaml.` },
      { indent: '\t', cells: [bucketConstant(bucket.name), `= ${goString(bucket.name)}`] }
    ])
  );
  return `
// Los buckets del diseño, por su nombre LÓGICO: el nombre no viaja como literal, así que si el diseño lo renombra lo que
// falla es la compilación.
const (
${constants.join('\n')}
)

// StoragePolicies da la política declarada de cada bucket. La implementación vive en internal/infrastructure/storage y la
// puebla la configuración del perfil; el dominio y la aplicación solo dependen de esta interfaz.
type StoragePolicies interface {
	// ForBucket es la política del bucket, por su nombre lógico (una constante Bucket*). El error es un bucket que la
	// configuración no declara: un fallo de despliegue.
	ForBucket(name string) (BucketPolicy, error)
}

// BucketPolicy es la política declarada para un bucket en storage.keel.yaml. La consulta el caso de uso antes de subir:
// el tamaño, los tipos admitidos y la visibilidad salen del diseño, no del handler.
type BucketPolicy struct {
	name                string
	bucket              string
	publicRead          bool
	maxSizeMB           int
	allowedContentTypes []string
	signedURLTTL        time.Duration
}

// NewBucketPolicy construye la política de un bucket: su nombre lógico, el físico en el proveedor, si es de lectura
// pública, el tamaño máximo en MB (0: sin límite), los MIME admitidos (vacío: sin restricción) y lo que vale su URL
// firmada (0: el diseño no lo declara).
func NewBucketPolicy(name, bucket string, publicRead bool, maxSizeMB int, allowedContentTypes []string, signedURLTTL time.Duration) BucketPolicy {
	allowed := make([]string, 0, len(allowedContentTypes))
	for _, contentType := range allowedContentTypes {
		allowed = append(allowed, strings.ToLower(contentType))
	}
	return BucketPolicy{name: name, bucket: bucket, publicRead: publicRead, maxSizeMB: maxSizeMB, allowedContentTypes: allowed, signedURLTTL: signedURLTTL}
}

// Name es el nombre lógico del bucket, el del diseño.
func (p BucketPolicy) Name() string {
	return p.name
}

// Bucket es el nombre físico del bucket en el proveedor.
func (p BucketPolicy) Bucket() string {
	return p.bucket
}

// PublicRead dice si el diseño declara el bucket visibility: public.
func (p BucketPolicy) PublicRead() bool {
	return p.publicRead
}

// MaxSizeMB es el tamaño máximo admitido en MB, o 0 si el diseño no lo acota.
func (p BucketPolicy) MaxSizeMB() int {
	return p.maxSizeMB
}

// AllowedContentTypes son los MIME admitidos, en minúsculas; vacío significa «sin restricción».
func (p BucketPolicy) AllowedContentTypes() []string {
	return slices.Clone(p.allowedContentTypes)
}

// AllowsContent dice si el binario es admisible en este bucket. Dos preguntas, y las dos son del contrato: el tipo
// DECLARADO está entre los admitidos, y el contenido es de verdad de ese tipo.
//
// Es el método que usa el caso de uso, no AllowsContentType: un ejecutable renombrado a .png y enviado como image/png
// pasa la comprobación del tipo declarado, se guarda y —en un bucket público— se sirve. Devuelve el mismo false en los
// dos casos a propósito: para el cliente el error es el que el diseño declara para un formato no admitido, y distinguir
// «el tipo no vale» de «mentiste sobre el tipo» solo le diría a quien prueba con qué renombrar.
func (p BucketPolicy) AllowsContent(content []byte, declaredContentType string) bool {
	return p.AllowsContentType(declaredContentType) && MatchesSignature(content, declaredContentType)
}

// AllowsContentType dice si el MIME DECLARADO está admitido. Sin tipos declarados no hay restricción. Comprobar solo
// esto es confiar en lo que dice el cliente: usa AllowsContent siempre que tengas los bytes delante.
func (p BucketPolicy) AllowsContentType(contentType string) bool {
	return len(p.allowedContentTypes) == 0 || slices.Contains(p.allowedContentTypes, strings.ToLower(contentType))
}

// AllowsSize dice si el tamaño cabe. Sin límite declarado, siempre.
func (p BucketPolicy) AllowsSize(sizeBytes int64) bool {
	return p.maxSizeMB == 0 || sizeBytes <= int64(p.maxSizeMB)*1024*1024
}

// SignedURLTTL es lo que vale la URL firmada de este bucket según lo declara el diseño
// (storage.buckets.<n>.signedUrlTtlSeconds). Es la ventana que usa el adaptador, no una sugerencia: es contrato con
// quien recibe el enlace. Sin declararla es un error: una firma que no caduca no se emite.
func (p BucketPolicy) SignedURLTTL() (time.Duration, error) {
	if p.signedURLTTL <= 0 {
		return 0, fmt.Errorf("storage.buckets.%s no declara signedUrlTtlSeconds: un bucket privado se lee por URL firmada, y esa firma tiene que caducar", p.name)
	}
	return p.signedURLTTL, nil
}

// signaturePart es un trozo de firma: los bytes esperados a partir de un desplazamiento.
type signaturePart struct {
	offset int
	bytes  []byte
}

// contentSignatures son las firmas por MIME, la tabla neutral de keel-core (la misma que la de los otros tres
// servidores). Cada elemento de la lista exterior es una ALTERNATIVA (un GIF vale con GIF87a o con GIF89a); dentro de
// una alternativa, todos los trozos tienen que casar (un WebP es RIFF al principio y WEBP en el byte 8).
var contentSignatures = map[string][][]signaturePart{
${signatureTable()}
}

// MatchesSignature dice si el contenido casa con el tipo declarado, mirando sus primeros bytes. El Content-Type de una
// parte multipart lo elige el cliente, así que por sí solo no distingue una imagen de un ejecutable renombrado.
//
// Alcance, y es una promesa acotada a propósito: un MIME que no esté en la tabla —texto, SVG, CSV, JSON— se ACEPTA,
// porque no tiene firma que comprobar. Un contenido vacío tampoco se juzga aquí: eso es una subida rota, y su error es
// el de la entrada (FILE_UNREADABLE).
func MatchesSignature(content []byte, declaredContentType string) bool {
	alternatives, known := contentSignatures[strings.ToLower(declaredContentType)]
	if !known || len(content) == 0 {
		return true
	}
	for _, parts := range alternatives {
		if matchesAll(content, parts) {
			return true
		}
	}
	return false
}

// matchesAll dice si todos los trozos de una alternativa casan.
func matchesAll(content []byte, parts []signaturePart) bool {
	for _, part := range parts {
		end := part.offset + len(part.bytes)
		if len(content) < end || !bytes.Equal(content[part.offset:end], part.bytes) {
			return false
		}
	}
	return true
}
`;
}

// La prueba emitida de la política: EJECUTA la tabla de firmas (cada tipo con su firma, con otra, vacío y sin firma
// conocida) y las comprobaciones del bucket. Un sabotaje de la tabla o de AllowsContent cae aquí.
function bucketPolicyTest(model) {
  const samples = Object.entries(CONTENT_SIGNATURES).map(([mime, alternatives]) => {
    const parts = alternatives[0];
    const length = Math.max(...parts.map((part) => part.offset + part.bytes.length)) + 4;
    const placed = parts.map((part) => `\t\t\tplace(content, ${part.offset}, ${part.bytes.map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`).join(', ')})`);
    return `\t\t${goString(mime)}: func() []byte {\n\t\t\tcontent := make([]byte, ${length})\n${placed.join('\n')}\n\t\t\treturn content\n\t\t}(),`;
  });
  return `
// place copia data en content a partir de offset.
func place(content []byte, offset int, data ...byte) {
	copy(content[offset:], data)
}

// TestMatchesSignatureReconoceCadaTipoDeLaTabla: cada MIME con firma conocida casa con su firma, no con otra, y su
// nombre no distingue mayúsculas.
func TestMatchesSignatureReconoceCadaTipoDeLaTabla(t *testing.T) {
	samples := map[string][]byte{
${samples.join('\n')}
	}
	for mime, content := range samples {
		if !domain.MatchesSignature(content, mime) {
			t.Errorf("%s: su propia firma no casa", mime)
		}
		if !domain.MatchesSignature(content, strings.ToUpper(mime)) {
			t.Errorf("%s: el tipo en mayúsculas no casa", mime)
		}
		if domain.MatchesSignature(make([]byte, len(content)), mime) {
			t.Errorf("%s: un contenido de ceros pasa por %s", mime, mime)
		}
		if domain.MatchesSignature(content[:1], mime) {
			t.Errorf("%s: un contenido más corto que su firma pasa", mime)
		}
		for other, sample := range samples {
			if other != mime && domain.MatchesSignature(sample, mime) && !sameSignature(other, mime) {
				t.Errorf("%s: el contenido de %s pasa por %s", mime, other, mime)
			}
		}
	}
}

// sameSignature dice si dos tipos comparten firma (ninguno, hoy: la excepción tendría que escribirse aquí).
func sameSignature(string, string) bool {
	return false
}

// TestMatchesSignatureAceptaLoQueNoPuedeJuzgar: un tipo sin firma conocida y un contenido vacío no se juzgan aquí.
func TestMatchesSignatureAceptaLoQueNoPuedeJuzgar(t *testing.T) {
	if !domain.MatchesSignature([]byte("hola"), "text/plain") {
		t.Error("un tipo sin firma conocida se rechaza")
	}
	if !domain.MatchesSignature(nil, "image/png") {
		t.Error("un contenido vacío se juzga aquí")
	}
}

// TestBucketPolicy: el tipo declarado Y la firma, el tamaño con su límite exacto y la URL firmada que caduca.
func TestBucketPolicy(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00}
	policy := domain.NewBucketPolicy("images", "svc-images", true, 2, []string{"IMAGE/PNG"}, 0)
	if !policy.AllowsContent(png, "image/png") {
		t.Error("un PNG declarado image/png no se admite")
	}
	if policy.AllowsContent([]byte("MZ ejecutable"), "image/png") {
		t.Error("un contenido que no es PNG pasa por declararse image/png")
	}
	if policy.AllowsContent(png, "image/jpeg") {
		t.Error("un tipo que el bucket no admite pasa")
	}
	if !slices.Equal(policy.AllowedContentTypes(), []string{"image/png"}) {
		t.Errorf("los tipos admitidos no se guardan en minúsculas: %v", policy.AllowedContentTypes())
	}
	if !policy.AllowsSize(2*1024*1024) || policy.AllowsSize(2*1024*1024+1) {
		t.Error("el límite de 2 MB no es exacto")
	}
	if _, err := policy.SignedURLTTL(); err == nil {
		t.Error("una URL firmada sin caducidad declarada no es un error")
	}
	open := domain.NewBucketPolicy("any", "svc-any", false, 0, nil, 600*time.Second)
	if !open.AllowsSize(1<<40) || !open.AllowsContentType("application/x-cualquiera") {
		t.Error("sin límite ni tipos declarados, el bucket restringe")
	}
	if ttl, err := open.SignedURLTTL(); err != nil || ttl != 600*time.Second {
		t.Errorf("SignedURLTTL = %v, %v", ttl, err)
	}
}
`;
}

// ─── internal/infrastructure/storage ─────────────────────────────────────────────────────────────

function settingsBody(model) {
  const publicBase = Boolean(model.storage?.hasPublicBucket);
  const buckets = model.storage?.buckets ?? [];
  const reads = buckets.map(
    (bucket) => `	if s.Buckets[${goString(bucket.name)}], err = bucketFrom(text, number, ${goString(bucket.name)}); err != nil {
		return Settings{}, err
	}`
  );
  return `
// BucketSettings es un bucket tal como lo declara storage.yaml.
type BucketSettings struct {
	// Bucket es el nombre FÍSICO en el proveedor (el que crea el sidecar minio-init de infra/).
	Bucket string
	// Visibility es public o private.
	Visibility string
	// MaxSizeMB es el tamaño máximo en MB, o 0 sin límite.
	MaxSizeMB int
	// AllowedContentTypes son los MIME admitidos; vacío, sin restricción.
	AllowedContentTypes []string
	// SignedURLTTL es lo que vale la URL firmada, o 0 si el diseño no lo declara.
	SignedURLTTL time.Duration
}

// Settings es lo que el almacenamiento lee de config/parameters/<perfil>/storage.yaml: las MISMAS claves y variables que
// el storage.yaml de los otros tres servidores (STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY,
// STORAGE_SECRET_KEY, STORAGE_BUCKET_<B>…). Es el único sitio por el que esos valores entran al código.
type Settings struct {
	// Provider es el almacén del stack (minio o s3).
	Provider string
	// Endpoint es con quién habla el servicio (MinIO en local); vacío con S3, que resuelve el endpoint por región.
	Endpoint string
	// Region es la región del almacén.
	Region string
	// AccessKey y SecretKey son las credenciales estáticas; sin ellas, la cadena por defecto del SDK (un rol IAM).
	AccessKey string
	SecretKey string
	// PathStyleAccess es true con MinIO: el bucket va en la ruta, no en el host.
	PathStyleAccess bool${publicBase ? `
	// PublicBaseURL es la base de las URLs públicas: la que alcanza el CONSUMIDOR (CDN, o el host en local), no el
	// endpoint interno. Sin la barra final.
	PublicBaseURL string` : ''}
	// EnsureBucketsOnStartup dice si el arranque crea los buckets (y su lectura pública): sí en local, no en test.
	EnsureBucketsOnStartup bool
	// Buckets son los buckets del diseño, por su nombre lógico.
	Buckets map[string]BucketSettings
}

// SettingsFrom lee storage.* de la configuración del perfil. Un bucket del diseño sin nombre físico, o un número que no
// se entiende, no deja arrancar: es un fallo de despliegue.
func SettingsFrom(cfg *config.Config) (Settings, error) {
	text := func(key, fallback string) string {
		if value, ok := cfg.Value(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}
	number := func(key string) (int, error) {
		value := text(key, "")
		if value == "" {
			return 0, nil
		}
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			return 0, fmt.Errorf("%s tiene que ser un número no negativo: %q", key, value)
		}
		return parsed, nil
	}
	s := Settings{
		Provider:               text("storage.provider", ${goString(model.stack?.storage ?? 'minio')}),
		Endpoint:               text("storage.endpoint", ""),
		Region:                 text("storage.region", "us-east-1"),
		AccessKey:              text("storage.access-key", ""),
		SecretKey:              text("storage.secret-key", ""),
		PathStyleAccess:        strings.EqualFold(text("storage.path-style-access", "false"), "true"),${publicBase ? `
		PublicBaseURL:          strings.TrimRight(text("storage.public-base-url", ""), "/"),` : ''}
		EnsureBucketsOnStartup: strings.EqualFold(text("storage.ensure-buckets-on-startup", "false"), "true"),
		Buckets:                map[string]BucketSettings{},
	}
${reads.length > 0 ? `\tvar err error\n${reads.join('\n')}\n` : ''}	return s, nil
}

// bucketFrom lee storage.buckets.<name>.*. Su nombre físico es obligatorio.
func bucketFrom(text func(key, fallback string) string, number func(key string) (int, error), name string) (BucketSettings, error) {
	prefix := "storage.buckets." + name + "."
	bucket := BucketSettings{Bucket: text(prefix+"bucket", ""), Visibility: text(prefix+"visibility", "private")}
	if bucket.Bucket == "" {
		return BucketSettings{}, fmt.Errorf("%sbucket no está configurado: revisa config/parameters/<perfil>/storage.yaml", prefix)
	}
	var err error
	if bucket.MaxSizeMB, err = number(prefix + "max-size-mb"); err != nil {
		return BucketSettings{}, err
	}
	seconds, err := number(prefix + "signed-url-ttl-seconds")
	if err != nil {
		return BucketSettings{}, err
	}
	bucket.SignedURLTTL = time.Duration(seconds) * time.Second
	// Una lista separada por comas, como la enlaza Spring.
	for _, contentType := range strings.Split(text(prefix+"allowed-content-types", ""), ",") {
		if contentType = strings.TrimSpace(contentType); contentType != "" {
			bucket.AllowedContentTypes = append(bucket.AllowedContentTypes, contentType)
		}
	}
	return bucket, nil
}
`;
}

function policiesBody() {
  return `
// Policies es la política de cada bucket, leída de storage.buckets.*: el adaptador del puerto domain.StoragePolicies.
type Policies struct {
	settings Settings
}

// NewPolicies construye las políticas de la configuración del perfil.
func NewPolicies(settings Settings) *Policies {
	return &Policies{settings: settings}
}

// ForBucket es la política del bucket lógico name.
func (p *Policies) ForBucket(name string) (domain.BucketPolicy, error) {
	bucket, ok := p.settings.Buckets[name]
	if !ok {
		return domain.BucketPolicy{}, fmt.Errorf("storage.buckets.%s no está configurado: revisa config/parameters/<perfil>/storage.yaml", name)
	}
	return domain.NewBucketPolicy(name, bucket.Bucket, bucket.Visibility == "public", bucket.MaxSizeMB, bucket.AllowedContentTypes, bucket.SignedURLTTL), nil
}
`;
}

function clientBody(model) {
  const label = STORAGE[model.stack?.storage]?.label ?? 'S3';
  return `
// NewClient construye el cliente S3 del almacén (${label}) con la configuración del perfil: credenciales estáticas si
// el perfil las da (si no, la cadena por defecto del SDK, para un rol IAM en producción), el endpoint de MinIO si lo hay
// y el estilo de ruta (el bucket en la ruta, no en el host). No habla con el almacén: el servicio arranca sin él.
func NewClient(ctx context.Context, settings Settings) (*s3.Client, error) {
	options := []func(*config.LoadOptions) error{config.WithRegion(settings.Region)}
	if settings.AccessKey != "" {
		options = append(options, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(settings.AccessKey, settings.SecretKey, "")))
	}
	// Cargar la configuración no habla con AWS: lee el entorno y, sin claves, los archivos de la cadena por defecto.
	cfg, err := config.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("configurar el SDK de AWS para el almacenamiento: %w", err)
	}
	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		if settings.Endpoint != "" {
			o.BaseEndpoint = aws.String(settings.Endpoint)
		}
		o.UsePathStyle = settings.PathStyleAccess
	}), nil
}
`;
}

// El adaptador lo escribe el agente (skill keel-go-s3): build deja el tipo que el arranque ya cablea, con lo que necesita
// y un error que lo dice por método. Compila y arranca; lo que llame al puerto antes de que el agente lo complete recibe
// ese error.
function adapterBody(model) {
  const storage = model.storage ?? {};
  const todo = (what) => `errors.New(${goString(`TODO (agente): ${what} — skill keel-go-s3`)})`;
  const methods = [
    `// Upload sube el binario al bucket físico de policies.ForBucket(bucket).
func (s *Storage) Upload(ctx context.Context, bucket, key string, content []byte, contentType string) (domain.StoredObject, error) {
	return domain.StoredObject{}, ${todo('Upload')}
}`
  ];
  if (storage.hasPrivateBucket) {
    methods.push(`// Download trae el binario.
func (s *Storage) Download(ctx context.Context, bucket, key string) ([]byte, error) {
	return nil, ${todo('Download')}
}`);
  }
  if (storage.hasPublicBucket) {
    methods.push(`// PublicURL compone la URL pública desde settings.PublicBaseURL, sin hablar con el almacén.
func (s *Storage) PublicURL(bucket, key string) (string, error) {
	return "", ${todo('PublicURL')}
}`);
  }
  methods.push(`// Delete borra el objeto; uno que no existe no es un error.
func (s *Storage) Delete(ctx context.Context, bucket, key string) error {
	return ${todo('Delete')}
}`);
  if (storage.hasPrivateBucket) {
    methods.push(`// SignedURL firma una lectura con la caducidad que declara el diseño (policies.ForBucket(bucket) → SignedURLTTL).
func (s *Storage) SignedURL(ctx context.Context, bucket, key string) (string, error) {
	return "", ${todo('SignedURL')}
}`);
  }
  return `
// Storage es el adaptador del puerto domain.FileStorage sobre el protocolo S3. LO ESCRIBE EL AGENTE siguiendo la skill
// keel-go-s3: el cliente ya viene construido (client.go), el bucket FÍSICO sale de policies.ForBucket(bucket).Bucket()
// —el que crea el sidecar minio-init de infra/—, el aprovisionamiento va en EnsureBuckets y, para un bucket privado, la
// URL firmada con la caducidad que declara el diseño (SignedURLTTL).
//
// El arranque (cmd/server) ya lo construye con NewStorage, llama a EnsureBuckets y lo pasa a los casos de uso: no toques
// el cableado.
type Storage struct {
	//lint:ignore U1000 lo usa el adaptador que escribe el agente.
	client   *s3.Client
	settings Settings
	//lint:ignore U1000 lo usa el adaptador que escribe el agente.
	policies domain.StoragePolicies
}

// NewStorage construye el adaptador.
func NewStorage(client *s3.Client, settings Settings, policies domain.StoragePolicies) *Storage {
	return &Storage{client: client, settings: settings, policies: policies}
}

var _ domain.FileStorage = (*Storage)(nil)

${methods.join('\n\n')}

// EnsureBuckets aprovisiona los buckets al arrancar, solo con settings.EnsureBucketsOnStartup (sí en local y develop, no
// en test ni en producción). En local los crea además el sidecar minio-init de infra/. El arranque registra su error y
// sigue: un almacén que no contesta no tumba el servicio.
func (s *Storage) EnsureBuckets(ctx context.Context) error {
	if !s.settings.EnsureBucketsOnStartup {
		return nil
	}
	// TODO (agente): crea los buckets que falten (s.policies.ForBucket(nombre).Bucket() por cada uno de s.settings.Buckets) y,
	// si son públicos, su política de lectura anónima — skill keel-go-s3.
	return nil
}
`;
}

// ─── internal/httpapi/multipart.go ───────────────────────────────────────────────────────────────

function multipartBody(model) {
  const parts = partKinds(model);
  const [partBefore, partAfter] = FW.missingPart.message.split('{name}');
  const REQUIRE_PART = `// requirePart es el binario de una parte obligatoria: si no vino, el 400 de keel-spring («Falta la parte…»); si llegó
// vacía, no es «sin archivo» sino una subida rota, FILE_UNREADABLE.
func (f *multipartForm) requirePart(name string) (application.FileUpload, error) {
	file, ok := f.files[name]
	if !ok {
		return application.FileUpload{}, &uploadError{status: ${FW.missingPart.status}, phrase: ${goString(FW.missingPart.error)}, message: ${goString(partBefore)} + name + ${goString(partAfter)}}
	}
	if file == nil {
		code := fileUnreadableCode
		return application.FileUpload{}, &uploadError{status: ${FW.fileEmpty.status}, phrase: ${goString(FW.fileEmpty.error)}, code: &code, message: ${goString(FW.fileEmpty.message)}}
	}
	return *file, nil
}

`;
  const OPTIONAL_PART = `// optionalPart es el binario de una parte opcional: nil si no vino o llegó vacía.
func (f *multipartForm) optionalPart(name string) *application.FileUpload {
	return f.files[name]
}

`;
  const tooLarge = effectiveErrorCode(model, FRAMEWORK_ERRORS.fileTooLarge);
  const unreadable = FRAMEWORK_ERRORS.fileUnreadable.code;
  return `
// La lectura de una subida multipart/form-data, la de los otros tres servidores: el binario como parte, el resto de la
// entrada como campos del formulario (que se leen como los parámetros de la query), y los fallos del propio cuerpo con el
// status y el code que da el ApiExceptionHandler de keel-spring. El límite de la entrada es el doble del mayor maxSizeMb
// del diseño, para que el límite de NEGOCIO —que el caso de uso comprueba con BucketPolicy, en el orden del diseño— se
// alcance antes que el de la red de seguridad.

// MultipartLimitBytes es el límite de la ENTRADA de una subida: el doble del mayor maxSizeMb del diseño (el del servlet
// de keel-spring). El borde lo pone en lugar de MaxBodyBytes a todo cuerpo multipart/form-data.
const MultipartLimitBytes = ${multipartFileLimitBytes(model)}

const (
	// fileTooLargeCode es el code del 413: el que declara el diseño para el exceso de tamaño, o el canónico.
	fileTooLargeCode = ${goString(tooLarge)}
	// fileUnreadableCode es el de un cuerpo multipart roto o una parte obligatoria vacía.
	fileUnreadableCode = ${goString(unreadable)}
)

// uploadError es un fallo de la propia subida, con su respuesta ya decidida: la parte que falta (400 sin code), un cuerpo
// que no es multipart (415 sin code), demasiado grande (413) o ilegible (400 FILE_UNREADABLE).
type uploadError struct {
	status  int
	phrase  string
	code    *string
	message string
	cause   error
}

// Error es el mensaje de la respuesta.
func (e *uploadError) Error() string {
	return e.message
}

// Unwrap es el motivo, si lo hay.
func (e *uploadError) Unwrap() error {
	return e.cause
}

// bodyLimit es el tope del cuerpo de r: el de la subida para un multipart/form-data, MaxBodyBytes para todo lo demás.
func bodyLimit(r *http.Request) int64 {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err == nil && mediaType == "multipart/form-data" {
		return MultipartLimitBytes
	}
	return MaxBodyBytes
}

// multipartForm es lo que trae una subida: los campos simples (repetidos, como lista) y los binarios por nombre de parte.
// Un binario que llegó vacío está, con nil.
type multipartForm struct {
	fields url.Values
	files  map[string]*application.FileUpload
}

// readMultipart lee la subida entera, LO PRIMERO (como el DispatcherServlet de Spring, que resuelve el multipart antes
// que los argumentos): un cuerpo que no es multipart/form-data, que pasa del límite por su longitud declarada o al
// leerlo, o que no se puede leer, se rechaza antes de convertir nada.
func readMultipart(r *http.Request) (*multipartForm, error) {
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return nil, &uploadError{status: ${FW.notMultipart.status}, phrase: ${goString(FW.notMultipart.error)}, message: ${goString(FW.notMultipart.message)}}
	}
	// La longitud declarada se rechaza sin leer, como Tomcat; un cuerpo por trozos lo corta el tope del borde.
	if r.ContentLength > MultipartLimitBytes {
		return nil, fileTooLarge(nil)
	}
	if params["boundary"] == "" {
		return nil, fileUnreadable(errors.New("multipart/form-data sin boundary"))
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	form := &multipartForm{fields: url.Values{}, files: map[string]*application.FileUpload{}}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return form, nil
		}
		if err != nil {
			return nil, unreadableOrTooLarge(err)
		}
		content, err := io.ReadAll(part)
		if err != nil {
			return nil, unreadableOrTooLarge(err)
		}
		name := part.FormName()
		switch {
		case name == "":
			continue
		case part.FileName() == "":
			form.fields.Add(name, string(content))
		case len(content) == 0:
			// Un binario vacío llega como nil (como el MultipartFile vacío de Spring): lo que falte lo decide quien lo pide.
			form.files[name] = nil
		default:
			form.files[name] = &application.FileUpload{Content: content, Filename: part.FileName(), ContentType: part.Header.Get("Content-Type"), Size: int64(len(content))}
		}
	}
}

// withFields devuelve r con los campos del formulario como su query: el @RequestParam de keel-spring lee los dos, y los
// lectores de la query sirven así a la subida tal cual. El del formulario gana.
func (f *multipartForm) withFields(r *http.Request) *http.Request {
	query := r.URL.Query()
	for name, values := range f.fields {
		query[name] = values
	}
	merged := *r.URL
	merged.RawQuery = query.Encode()
	clone := r.Clone(r.Context())
	clone.URL = &merged
	return clone
}

${parts.require ? REQUIRE_PART : ''}${parts.optional ? OPTIONAL_PART : ''}// unreadableOrTooLarge clasifica un fallo al leer el cuerpo: el tope del borde es el 413, lo demás lo ilegible.
func unreadableOrTooLarge(err error) error {
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return fileTooLarge(err)
	}
	return fileUnreadable(err)
}

// fileTooLarge es el 413 de la entrada, con el code del diseño.
func fileTooLarge(cause error) error {
	code := fileTooLargeCode
	return &uploadError{status: ${FW.fileTooLarge.status}, phrase: ${goString(FW.fileTooLarge.error)}, code: &code, message: ${goString(FW.fileTooLarge.message)}, cause: cause}
}

// fileUnreadable es un cuerpo multipart que no se puede leer: cortado o mal formado.
func fileUnreadable(cause error) error {
	code := fileUnreadableCode
	return &uploadError{status: ${FW.fileUnreadable.status}, phrase: ${goString(FW.fileUnreadable.error)}, code: &code, message: ${goString(FW.fileUnreadable.message)}, cause: cause}
}
`;
}

/** Qué partes leen las subidas del servicio: obligatorias, opcionales o las dos (un lector sin usar no pasa staticcheck). */
function partKinds(model) {
  const files = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter((operation) => operation.route && operation.multipart)
    .flatMap((operation) => (operation.bodyFields ?? []).filter((field) => field.kind === 'fileUpload'));
  return { require: files.some((field) => field.required), optional: files.some((field) => !field.required) };
}

// ─── Para quien compone otros archivos ───────────────────────────────────────────────────────────

/** Lo que el arranque (cmd/server) añade con el almacenamiento: la configuración, la política, el cliente y el adaptador. */
export function storageServerWiring(model) {
  if (!usesStorageAdapter(model)) return '';
  return `	storageSettings, err := storage.SettingsFrom(cfg)
	if err != nil {
		return fmt.Errorf("configuración del almacenamiento: %w", err)
	}
	storagePolicies := storage.NewPolicies(storageSettings)
	storageClient, err := storage.NewClient(ctx, storageSettings)
	if err != nil {
		return err
	}
	fileStorage := storage.NewStorage(storageClient, storageSettings, storagePolicies)
	// El aprovisionamiento de los buckets (solo con ensure-buckets-on-startup): un almacén que no contesta no tumba el arranque.
	if err := fileStorage.EnsureBuckets(ctx); err != nil {
		logger.ErrorContext(ctx, "aprovisionar los buckets", "error", err)
	}
`;
}

/** Las filas de Dependencies que pone el arranque. */
export function storageServerRows(model) {
  if (!usesStorageAdapter(model)) return [];
  return [
    { indent: '\t\t', cells: [`${STORAGE_POLICIES.field}:`, 'storagePolicies,'] },
    { indent: '\t\t', cells: [`${FILE_STORAGE.field}:`, 'fileStorage,'] }
  ];
}

// ─── El arnés: Upload y la palanca del almacenamiento caído ──────────────────────────────────────

/** El archivo del arnés con la subida y, con MinIO, StopStorage/StartStorage. */
export const STORAGE_HARNESS_FILE = 'storage_test.go';

/**
 * `s.Upload(...)` con una subida en el diseño (el `multipart(...)` de keel-spring, el `flow.upload` de keel-nest y el
 * `Upload(...)` de keel-dotnet) y, con MinIO, `s.StopStorage()`/`s.StartStorage()`, la palanca de los escenarios de
 * bucket caído. Sin ellos el agente escribía sus propios helpers (asset-vault, R8).
 */
export function storageHarnessBody(model, { replica = false } = {}) {
  const sections = [];
  if (usesMultipart(model)) {
    sections.push(`
// UploadPart es la parte binaria de una subida: su nombre de parte, el del archivo, el tipo DECLARADO y los bytes.
type UploadPart struct {
	Part        string
	Filename    string
	ContentType string
	Content     []byte
}

// Upload es una subida multipart/form-data (POST) al servidor del flujo: el binario como la parte file.Part y el resto de
// la entrada como campos del formulario (un []string viaja como el campo repetido; nil no viaja). El mismo contrato que el
// multipart(...) de keel-spring. Nunca falla por un 4xx o un 5xx: el status es una aserción del escenario.
func (s *Scenario) Upload(path string, file UploadPart, fields map[string]any, headers http.Header) *Response {
	s.Helper()
	return s.upload(server.url(), path, file, fields, headers)
}
${replica ? `
// UploadOnReplica es Upload contra la SEGUNDA réplica (s.StartReplica).
func (s *Scenario) UploadOnReplica(path string, file UploadPart, fields map[string]any, headers http.Header) *Response {
	s.Helper()
	if replica.url() == "" {
		s.Fatal("la réplica no está arrancada: llama antes a s.StartReplica()")
	}
	return s.upload(replica.url(), path, file, fields, headers)
}
` : ''}
// upload arma la subida y la manda a baseURL, con su evidencia: los campos con su valor y el binario por tamaño, nunca
// sus bytes.
func (s *Scenario) upload(baseURL, path string, file UploadPart, fields map[string]any, headers http.Header) *Response {
	s.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	var described []string
	for _, name := range slices.Sorted(maps.Keys(fields)) {
		for _, value := range formValues(fields[name]) {
			if err := writer.WriteField(name, value); err != nil {
				s.Fatal(err)
			}
			described = append(described, name+"="+value)
		}
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf("form-data; name=%q; filename=%q", file.Part, file.Filename))
	if file.ContentType != "" {
		header.Set("Content-Type", file.ContentType)
	}
	part, err := writer.CreatePart(header)
	if err == nil {
		_, err = part.Write(file.Content)
	}
	if err == nil {
		err = writer.Close()
	}
	if err != nil {
		s.Fatal(err)
	}
	described = append(described, fmt.Sprintf("%s=<%d bytes, %s>", file.Part, len(file.Content), file.ContentType))
	request, err := http.NewRequestWithContext(s.Context(), http.MethodPost, baseURL+path, &body)
	if err != nil {
		s.Fatal(err)
	}
	request.Header.Set("Accept", "application/json")
	for name, values := range headers {
		if !strings.EqualFold(name, "Content-Type") {
			request.Header[http.CanonicalHeaderKey(name)] = values
		}
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	text := "multipart: " + strings.Join(described, "; ")
	sent := requestReport{Method: http.MethodPost, Path: path, Headers: flatten(request.Header, false), Body: &text}
	response, err := httpClient.Do(request)
	if err != nil {
		s.Fatalf("POST %s: la petición no llegó: %v", path, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		s.Fatalf("POST %s: leer la respuesta: %v", path, err)
	}
	got := &Response{Status: response.StatusCode, Header: response.Header, Body: string(data)}
	capture.recordExchange(sent, responseReport{Status: got.Status, Headers: flatten(response.Header, true), Body: got.Body})
	return got
}

// formValues son los valores de un campo del formulario: una lista viaja como el campo repetido; nil no viaja.
func formValues(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return []string{typed}
	case []string:
		return typed
	case []any:
		var out []string
		for _, item := range typed {
			out = append(out, formValues(item)...)
		}
		return out
	default:
		return []string{fmt.Sprint(typed)}
	}
}
`);
  }
  if (usesStorageControl(model)) {
    const storage = STORAGE[model.stack.storage];
    sections.push(`
// storageContainer es el contenedor del almacenamiento de infra/ (${storage.label}).
const storageContainer = ${goString(storageContainer(model.service.name, storage))}

// storageDevtools es el contenedor de infra/ desde el que se sondea el almacenamiento, en la red del compose.
const storageDevtools = ${goString(devtoolsContainer(model.service.name))}

// storageProbe es el sondeo de infra/validate-infra.sh.
const storageProbe = ${goString(storage.cliValidateCmd)}

// StopStorage detiene el contenedor del almacenamiento: la palanca de los escenarios de BUCKET CAÍDO. Con él parado, una
// subida tiene que responder el error que el diseño declara y no custodiar nada. El escenario que lo llama lo restaura
// con defer s.StartStorage().
func (s *Scenario) StopStorage() {
	s.Helper()
	if _, err := runCommand(s.Context(), containerRuntime(), []string{"stop", storageContainer}, "¿Está la infraestructura arriba (bash infra/up.sh)?", ""); err != nil {
		s.Fatal(err)
	}
	s.awaitStorage(false)
}

// StartStorage levanta el almacenamiento y ESPERA a que sirva: arrancado no es listo.
func (s *Scenario) StartStorage() {
	s.Helper()
	if _, err := runCommand(s.Context(), containerRuntime(), []string{"start", storageContainer}, "¿Está la infraestructura arriba (bash infra/up.sh)?", ""); err != nil {
		s.Fatal(err)
	}
	s.awaitStorage(true)
}

// awaitStorage espera hasta 90 s a que el almacenamiento sirva (up) o deje de servir. Aquí el fallo del sondeo es la
// respuesta, no un error.
func (s *Scenario) awaitStorage(up bool) {
	s.Helper()
	s.Eventually(func() bool {
		_, err := runCommand(s.Context(), containerRuntime(), []string{"exec", storageDevtools, "sh", "-c", storageProbe}, "", "")
		return (err == nil) == up
	}, 90*time.Second, ${goString(`${storage.label}: no cambió de estado`)})
}
`);
  }
  return sections.length > 0 ? sections.join('') : null;
}

/** ¿Lleva el arnés el archivo de la subida? */
export function usesStorageHarness(model) {
  return usesMultipart(model) || usesStorageControl(model);
}
