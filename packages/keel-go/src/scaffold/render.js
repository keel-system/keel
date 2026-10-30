// DÓNDE vive cada cosa generada: el único mapa de paquetes del proyecto (PLAN-KEEL-GO.md § 2).
//
// Un paquete Go es un directorio y una unidad de compilación; su ruta de importación es la del módulo más
// el directorio. Un emisor que escribiera en `internal/platform/conf/` mientras otro importa
// `internal/platform/config` no compilaría, así que la ruta de cada paquete sale de aquí y de ningún otro
// sitio. Lo que en Spring son subpaquetes (`commands/`, `dtos/`, `mappers/`) aquí son ARCHIVOS del mismo
// paquete: `domain` y `application` son un paquete cada uno a propósito, porque partirlos por agregado abre
// ciclos de importación en cuanto dos agregados se refieren.

import { commentLines, goFile, goString } from '../lib/go-source.js';
import { goExported, goUnexported } from '../lib/go-projection.js';
import { storeDir } from '../lib/relational-engine.js';

/** Un paquete del proyecto: su directorio, su ruta de importación y su nombre. */
function pkg(module, dir, name = dir.split('/').at(-1)) {
  return { dir, importPath: `${module}/${dir}`, name };
}

/** Los paquetes del proyecto generado, con la capa a la que pertenece cada uno. */
export function layout(model) {
  const module = model.service.goModule;
  return {
    module,
    // El arranque: solo `main` y `run`, con el cableado explícito (sin contenedor de inyección).
    server: pkg(module, 'cmd/server', 'main'),
    // Los archivos de configuración por perfil, embebidos en el binario (embed.FS): el ejecutable no depende
    // de con qué directorio de trabajo se lance, y la imagen distroless no tiene nada más que él.
    configFiles: pkg(module, 'config'),
    domain: pkg(module, 'internal/domain'),
    application: pkg(module, 'internal/application'),
    httpapi: pkg(module, 'internal/httpapi'),
    config: pkg(module, 'internal/platform/config'),
    health: pkg(module, 'internal/platform/health'),
    // El correlationId de la petición o del mensaje en curso: lo abre la entrada HTTP, viaja en el contexto y lo
    // escriben los logs y el cuerpo de error.
    correlation: pkg(module, 'internal/platform/correlation'),
    // El contrato del cable y los tipos que la biblioteca estándar no tiene (Decimal, Date, Optional[T]). El
    // dominio los usa, así que es lo único de la plataforma que puede importar.
    wire: pkg(module, 'internal/platform/wire'),
    // El pliegue de un texto para comparar como pide el diseño (compare: ignore-case…): el valor de la sombra que guarda
    // la persistencia.
    textfold: pkg(module, 'internal/platform/textfold'),
    // El adaptador del motor relacional (`postgres` o `mysql`): el esquema (migraciones de goose embebidas) y los
    // repositorios. Un paquete por tecnología, como el resto de la infraestructura (PLAN-KEEL-GO.md § 2).
    store: pkg(module, storeDir(model)),
    // La prueba de la frontera hexagonal: `internal/` solo protege frente a otros módulos, no entre capas.
    architecture: pkg(module, 'internal/architecture'),
    // Las pruebas de flujo (FL-*), de caja negra y tras la restricción `integration`: `go test ./...` no las ve.
    integration: pkg(module, 'tests/integration')
  };
}

/**
 * Las capas y a qué paquetes PROPIOS puede importar cada una: la frontera hexagonal que ejecuta
 * `internal/architecture/architecture_test.go`. Un prefijo `internal/platform/` admite cualquiera de sus
 * paquetes. `thirdParty` es la lista blanca de módulos de terceros; null, cualquiera.
 */
export function boundaries() {
  return [
    { layer: 'domain', prefix: 'internal/domain', allows: ['internal/platform/wire'], thirdParty: ['github.com/google/uuid'] },
    {
      layer: 'application',
      prefix: 'internal/application',
      allows: ['internal/domain', 'internal/platform/wire'],
      thirdParty: ['github.com/google/uuid']
    },
    { layer: 'platform', prefix: 'internal/platform/', allows: ['internal/platform/'], thirdParty: null },
    {
      layer: 'httpapi',
      prefix: 'internal/httpapi',
      allows: ['internal/application', 'internal/domain', 'internal/platform/'],
      thirdParty: null
    },
    {
      layer: 'infrastructure',
      prefix: 'internal/infrastructure/',
      allows: ['internal/application', 'internal/domain', 'internal/platform/'],
      thirdParty: null
    }
  ];
}

/**
 * Un archivo Go de un paquete del mapa: la cabecera de código generado y los imports que el cuerpo usa. Con
 * `test`, la prueba de caja negra del paquete.
 */
export function packageFile(model, target, { doc = null, imports = [], body, generated = true, test = false, build = null }) {
  // Una prueba de caja negra va en el paquete `<nombre>_test`: solo ve lo exportado, como cualquier llamante.
  const pkg = test ? `${target.name}_test` : target.name;
  return goFile({ pkg, doc, imports, body, module: model.service.goModule, generated, build });
}

// Los sufijos que Go lee en el NOMBRE de un archivo como restricción de compilación (`x_linux.go` solo se
// compila en Linux, `x_test.go` es una prueba). Un archivo del dominio que acabara así desaparecería en silencio.
const GOOS = 'aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows zos';
const GOARCH = '386 amd64 amd64p32 arm arm64 arm64be armbe loong64 mips mips64 mips64le mips64p32 mips64p32le mipsle ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm';
const CONSTRAINT_SUFFIXES = new Set(['test', ...GOOS.split(' '), ...GOARCH.split(' ')]);

/** El nombre de archivo Go de un tipo: `SKUFormat` → `sku_format`, sin caer en una restricción de compilación. */
export function goFileName(name) {
  const base = String(name)
    // Una sigla en plural es una palabra: `GetProductsByIDsQuery` → `get_products_by_ids_query`.
    .replace(/([A-Z]{2,})s(?=[A-Z]|$)/g, (_, initialism) => `_${initialism.toLowerCase()}s_`)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
  return CONSTRAINT_SUFFIXES.has(base.split('_').at(-1)) ? `${base}_type` : base;
}

/** La ruta del archivo de un tipo del dominio. */
export function domainPath(model, name) {
  return `${layout(model).domain.dir}/${goFileName(name)}.go`;
}

/**
 * ¿Puede un campo no tener valor? Lo opcional que no es lista se declara como puntero: en Go un `string` no
 * puede ser null, y el cable distingue `""` de `null` (el mismo criterio que el `?` de keel-dotnet).
 */
export function isOptional(field) {
  return !(field.required || field.isId || field.generated || field.list);
}

/**
 * El tipo Go con el que se DECLARA un campo: la lista ya viene como `[]T` y lo opcional va con `*`. Fuera del
 * dominio (`qualify`), un enum o un value object se nombra por su paquete: `domain.Money`.
 */
export function declType(field, { qualify = false } = {}) {
  let type = field.goType;
  if (qualify && (field.kind === 'enum' || field.kind === 'composite')) {
    type = field.list ? `[]domain.${type.slice(2)}` : `domain.${type}`;
  }
  return isOptional(field) ? `*${type}` : type;
}

/** La ruta del archivo de un tipo de la aplicación. */
export function applicationPath(model, name) {
  return `${layout(model).application.dir}/${goFileName(name)}.go`;
}

/**
 * El nombre Go de una clase que nombra el modelo (`GetByUrlQuery`, `CreateProductResponseDto`): el modelo los
 * compone al estilo de Java, y en Go una sigla va en un solo caso (`GetByURLQuery`).
 */
export function goTypeName(name) {
  return goExported(name);
}

/**
 * El tipo Go con el que la APLICACIÓN declara un campo de un mensaje o un DTO: los enums y value objects por su
 * paquete (`domain.Money`), los DTO de la propia aplicación con su nombre Go, la lista como `[]T` y lo opcional
 * como puntero.
 */
export function appType(field) {
  const element = field.list ? field.goType.slice(2) : field.goType;
  let base = element;
  if (field.kind === 'enum' || field.kind === 'composite') base = `domain.${element}`;
  else if (field.kind === 'childDto' || field.kind === 'refDto' || field.kind === 'needDto') base = goTypeName(element);
  const type = field.list ? `[]${base}` : base;
  return isOptional(field) ? `*${type}` : type;
}

/** Los imports que puede necesitar un campo (las rutas propias van relativas al módulo). */
export function fieldImports(field) {
  return [...(field.goImports ?? [])];
}

/**
 * Un comentario de documentación que empieza por el nombre del identificador, como pide Go: `Product: producto
 * publicable del catálogo.` La prosa del diseño va tal cual detrás, con su primera letra en minúscula salvo que
 * sea una sigla.
 */
export function docComment(name, text, fallback = null, indent = '') {
  const prose = String(text ?? fallback ?? '').trim();
  if (!prose) return '';
  const lowered = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(prose) ? prose[0].toLowerCase() + prose.slice(1) : prose;
  const sentence = /[.!?:]$/.test(lowered) ? lowered : `${lowered}.`;
  return `${commentLines(`${name}: ${sentence}`, indent).join('\n')}\n`;
}

/** Un texto como formato de `Errorf`: el `%` literal se dobla. */
export function formatString(text) {
  return goString(String(text).replaceAll('%', '%%'));
}

// Los paquetes que importa el código del dominio y de la aplicación: un parámetro o una variable local con su
// nombre los ocultaría dentro de la función (`time := …` y después `time.Now()` no compila).
const SHADOWED_PACKAGES = new Set([
  'bytes', 'context', 'errors', 'fmt', 'json', 'jsontext', 'regexp', 'slices', 'strings', 'time', 'utf8', 'uuid', 'wire', 'domain', 'application'
]);

/** Un nombre del diseño como identificador local o campo sin exportar, sin chocar con un paquete ni una palabra reservada. */
export function localName(name) {
  const local = goUnexported(name);
  return SHADOWED_PACKAGES.has(local) ? `${local}Value` : local;
}
