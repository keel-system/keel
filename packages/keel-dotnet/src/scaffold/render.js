// Utilidades de renderizado C#: DÓNDE vive cada cosa generada y cómo se escribe un archivo.
//
// La solución tiene un proyecto por capa de la arquitectura (PLAN-KEEL-DOTNET.md § 2), y la frontera
// hexagonal la hace cumplir el COMPILADOR: un proyecto solo ve a los que referencia. Por eso el nombre
// y la ruta de cada proyecto salen de UN sitio (`solution`): un emisor que escribiera en
// `src/X.Domain/` mientras otro referencia `src/X.Dominio/` no compilaría.

/** Los proyectos de la solución, en orden de dependencia, con su nombre, su carpeta y su .csproj. */
export function solution(model) {
  const root = model.service.rootNamespace;
  const project = (layer, folder = 'src') => {
    const name = `${root}.${layer}`;
    return { name, dir: `${folder}/${name}`, csproj: `${folder}/${name}/${name}.csproj` };
  };
  return {
    root,
    file: `${root}.slnx`,
    domain: project('Domain'),
    application: project('Application'),
    infrastructure: project('Infrastructure'),
    api: project('Api'),
    unitTests: project('UnitTests', 'tests'),
    // Las pruebas de flujo (FL-*): caja negra contra el servidor arrancado, fuera de `dotnet test`.
    integrationTests: project('IntegrationTests', 'tests')
  };
}

/**
 * Un archivo C# con namespace de archivo (C# 10+): el namespace, los `using` ordenados y sin repetir, y el
 * cuerpo. Los `using` del framework que el SDK ya importa (ImplicitUsings) no se escriben.
 *
 * Los `using` van DENTRO del namespace, no antes: así se consultan antes que los namespaces que lo
 * contienen. Fuera, una entidad del diseño que se llame como un segmento del namespace raíz (`Application`
 * en notification-mailer) resolvía al namespace `NotificationMailer.Application` y no compilaba.
 */
export function csFile({ namespace, usings = [], body, header = null }) {
  const unique = [...new Set(usings)].sort((a, b) => a.localeCompare(b));
  const parts = [];
  if (header) parts.push(header.trimEnd(), '');
  parts.push(`namespace ${namespace};`, '');
  if (unique.length > 0) parts.push(...unique.map((using) => `using ${using};`), '');
  parts.push(body.trim(), '');
  return parts.join('\n');
}

/**
 * Un literal de cadena C# normal (no verbatim): escapa barras, comillas, saltos de línea y los demás
 * caracteres de control como `\uXXXX`. El texto no ASCII se queda tal cual: el fuente se escribe en UTF-8,
 * que el compilador lee sin BOM, y un mensaje en español tiene que poder leerse.
 */
export function csString(value) {
  const escaped = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  const visible = escaped.replace(/[\x00-\x1f\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  return `"${visible}"`;
}

// ─── Dónde vive cada tipo ────────────────────────────────────────────────────────────────────────

// Las carpetas de cada proyecto (PLAN-KEEL-DOTNET.md § 2). El namespace sigue a la carpeta, que es la
// convención de .NET: `ProductCatalog.Domain.ValueObject` vive en `src/ProductCatalog.Domain/ValueObject/`.
export const PLACES = {
  enums: ['domain', 'Enums'],
  valueObjects: ['domain', 'ValueObject'],
  aggregates: ['domain', 'Aggregate'],
  entities: ['domain', 'Entity'],
  events: ['domain', 'Events'],
  errors: ['domain', 'Errors'],
  domainSupport: ['domain', 'Support'],
  abstractions: ['application', 'Abstractions'],
  ports: ['application', 'Ports'],
  commands: ['application', 'Commands'],
  queries: ['application', 'Queries'],
  useCases: ['application', 'UseCases'],
  dtos: ['application', 'Dtos'],
  mappers: ['application', 'Mappers'],
  appSupport: ['application', 'Support'],
  // El puerto de persistencia de cada raíz y la página que nombra: dominio puro (incremento 6).
  repositories: ['domain', 'Repository'],
  useCaseInfra: ['infrastructure', 'UseCase'],
  correlation: ['infrastructure', 'Correlation'],
  // La persistencia relacional (EF Core): el contexto y su tiempo de ejecución, las filas con su mapeo y un
  // adaptador por puerto.
  persistence: ['infrastructure', 'Persistence'],
  rows: ['infrastructure', 'Persistence/Rows'],
  repositoryAdapters: ['infrastructure', 'Persistence/Repositories'],
  // La entrada HTTP: la infraestructura REST común y un archivo de endpoints por grupo de operaciones.
  rest: ['api', 'Rest'],
  endpoints: ['api', 'Endpoints']
};

/** El namespace y la ruta de un tipo `className` en el sitio `place` (una clave de PLACES). */
export function located(model, place, className) {
  const [layer, folder] = PLACES[place];
  const project = solution(model)[layer];
  // Una carpeta anidada (`Persistence/Rows`) es un namespace anidado (`.Persistence.Rows`).
  return { namespace: `${project.name}.${folder.replaceAll('/', '.')}`, path: `${project.dir}/${folder}/${className}.cs` };
}

export function namespaceOf(model, place) {
  return located(model, place, 'X').namespace;
}

export function entityPlace(entity) {
  return entity.isAggregateRoot ? 'aggregates' : 'entities';
}

/**
 * Mapa nombre de tipo → namespace, para todo lo que build genera con nombre propio y puede aparecer como
 * tipo de un campo. Se construye UNA vez por modelo: de aquí salen los `using` de cada archivo.
 */
export function typeLocations(model) {
  if (model.__csTypeLocations) return model.__csTypeLocations;
  const map = new Map();
  const put = (name, place) => {
    if (name && !map.has(name)) map.set(name, located(model, place, name).namespace);
  };
  for (const e of model.enums ?? []) put(e.name, 'enums');
  for (const vo of model.valueObjects ?? []) put(vo.name, 'valueObjects');
  for (const type of model.formatTypes ?? []) put(type.className, 'valueObjects');
  for (const entity of model.entities ?? []) put(entity.name, entityPlace(entity));
  for (const event of model.events ?? []) put(event.className, 'events');
  for (const error of model.errors ?? []) put(error.exceptionClass, 'errors');
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) if (operation.responseDto) put(operation.responseDto.name, 'dtos');
  }
  for (const list of [model.childDtos, model.refDtos, model.refVariants, model.needDtos]) {
    for (const dto of list ?? []) put(dto.name, 'dtos');
  }
  put('PagedResponse', 'dtos');
  put('FileUpload', 'dtos');
  Object.defineProperty(model, '__csTypeLocations', { value: map, enumerable: false });
  return map;
}

/** Los `using` que necesita el tipo de un campo: los del framework (proyección) y el del tipo generado. */
export function fieldUsings(model, field) {
  const usings = [...(field.usings ?? [])];
  const namespace = typeLocations(model).get(field.elementCsType ?? field.csType);
  if (namespace) usings.push(namespace);
  return usings;
}

/** Los `using` de unos nombres de tipo generados (los que no se generan se ignoran). */
export function typeUsings(model, names) {
  const locations = typeLocations(model);
  return names.map((name) => locations.get(name)).filter(Boolean);
}

/** ¿Admite null? Una lista nunca: sin elementos es una lista vacía. */
export function isNullable(field) {
  return !(field.required || field.isId || field.generated || field.list);
}

/** El tipo con el que se DECLARA un campo: la lista ya viene como IReadOnlyList; el opcional, con `?`. */
export function declType(field) {
  return isNullable(field) ? `${field.csType}?` : field.csType;
}

// Palabras reservadas de C#: un parámetro o una variable con ese nombre se escribe con `@` delante.
const KEYWORDS = new Set(
  ('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum ' +
    'event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace ' +
    'new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc ' +
    'static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while').split(' ')
);

/** Un nombre del diseño como identificador local C# (camelCase), escapado si es palabra reservada. */
export function csLocal(name) {
  const local = String(name)[0].toLowerCase() + String(name).slice(1);
  return KEYWORDS.has(local) ? `@${local}` : local;
}

/** Un nombre del diseño como miembro público C# (PascalCase): `sku` → `Sku`, `lockVersion` → `LockVersion`. */
export function csMember(name) {
  return String(name)[0].toUpperCase() + String(name).slice(1);
}

/** Comentario de documentación XML (`/// <summary>`) a partir de líneas de prosa; vacío si no hay nada. */
export function xmlDoc(text, indent = '') {
  const lines = (Array.isArray(text) ? text : [text]).filter((line) => line != null && line !== '').flatMap((line) => String(line).split('\n'));
  if (lines.length === 0) return '';
  const escaped = lines.map((line) => line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  if (escaped.length === 1) return `${indent}/// <summary>${escaped[0]}</summary>\n`;
  return `${indent}/// <summary>\n${escaped.map((line) => `${indent}/// ${line}`.trimEnd()).join('\n')}\n${indent}/// </summary>\n`;
}

/** Literal de cadena literal (verbatim) de C#: para expresiones regulares, donde `\` no escapa. */
export function csVerbatim(value) {
  return `@"${String(value).replaceAll('"', '""')}"`;
}
