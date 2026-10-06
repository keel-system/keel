// Utilidades de renderizado TypeScript: DÓNDE vive cada tipo generado y cómo se importa.
//
// En Java un import es el paquete más el nombre; en TypeScript con ESM es una ruta RELATIVA con la
// extensión `.js` (module: nodenext no resuelve sin ella). Calcularla a mano en cada emisor es la
// forma segura de que un archivo nombre `../dtos/x.js` mientras el otro se escribió en `dto/x.ts`:
// aquí hay UN mapa de tipos a archivos (`typeLocations`) y una sola función que compone los imports.

import path from 'node:path';

/**
 * Nombre de archivo de una clase: `SKUFormat` → `sku-format`, `CreateProductCommand` →
 * `create-product-command`. Separa también los acrónimos, que el kebab del modelo deja pegados.
 */
export function fileName(className) {
  return String(className)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** Ruta del archivo de una clase dentro de `src/<dir>/`. */
export function classPath(dir, className) {
  return `src/${dir}/${fileName(className)}.ts`;
}

// Los directorios de la arquitectura (PLAN-KEEL-NEST.md § 2). Un solo sitio: un emisor que
// escribiera `domain/value-object` frente a otro que importara de `domain/valueobject` no compila.
export const DIRS = {
  enums: 'domain/enums',
  valueObjects: 'domain/valueobject',
  aggregates: 'domain/aggregate',
  entities: 'domain/entity',
  events: 'domain/events',
  errors: 'domain/errors',
  identity: 'domain/identity',
  support: 'domain/support',
  interfaces: 'application/interfaces',
  annotations: 'application/annotations',
  commands: 'application/commands',
  queries: 'application/queries',
  usecases: 'application/usecases',
  dtos: 'application/dtos',
  mappers: 'application/mappers',
  appSupport: 'application/support',
  portOut: 'application/port/out',
  usecase: 'infrastructure/usecase'
};

export function entityDir(entity) {
  return entity.isAggregateRoot ? DIRS.aggregates : DIRS.entities;
}

/**
 * Mapa nombre de tipo → archivo, para todo lo que build genera con nombre propio y puede aparecer
 * como tipo de un campo. Se construye UNA vez por modelo.
 */
export function typeLocations(model) {
  if (model.__tsTypeLocations) return model.__tsTypeLocations;
  const map = new Map();
  const put = (name, dir) => {
    if (name && !map.has(name)) map.set(name, classPath(dir, name));
  };
  for (const e of model.enums ?? []) put(e.name, DIRS.enums);
  for (const vo of model.valueObjects ?? []) put(vo.name, DIRS.valueObjects);
  for (const type of model.formatTypes ?? []) put(type.className, DIRS.valueObjects);
  for (const entity of model.entities ?? []) put(entity.name, entityDir(entity));
  for (const event of model.events ?? []) put(event.className, DIRS.events);
  for (const error of model.errors ?? []) put(error.exceptionClass, DIRS.errors);
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.responseDto) put(operation.responseDto.name, DIRS.dtos);
    }
  }
  for (const list of [model.childDtos, model.refDtos, model.refVariants, model.needDtos]) {
    for (const dto of list ?? []) put(dto.name, DIRS.dtos);
  }
  put('PagedResponse', DIRS.dtos);
  put('FileUpload', DIRS.dtos);
  Object.defineProperty(model, '__tsTypeLocations', { value: map, enumerable: false });
  return map;
}

/**
 * Los imports que necesita el TIPO de un campo: los que puso la proyección (Decimal, RawJson) y el
 * de la clase generada que nombra, si la hay.
 */
export function fieldImports(model, field) {
  const imports = (field.imports ?? []).map((imp) => ({ ...imp }));
  const name = field.elementTsType ?? field.tsType;
  const location = typeLocations(model).get(String(name).replace(/\[\]$/, ''));
  if (location) imports.push({ symbol: String(name).replace(/\[\]$/, ''), from: location });
  return imports;
}

/** ¿El campo admite null en el código generado? Una lista nunca: sin elementos es `[]`. */
export function isNullable(field) {
  return !(field.required || field.isId || field.generated || field.list);
}

/** El tipo con el que se DECLARA un campo: lista como `readonly T[]`, opcional como `T | null`. */
export function declType(field) {
  if (field.list) return `readonly ${field.elementTsType ?? String(field.tsType).replace(/\[\]$/, '')}[]`;
  return isNullable(field) ? `${field.tsType} | null` : field.tsType;
}

/** Especificador relativo de `target` (ruta desde la raíz del proyecto) visto desde `from`. */
export function relativeSpecifier(from, target) {
  const withJs = target.replace(/\.ts$/, '.js');
  let rel = path.posix.relative(path.posix.dirname(from), withJs);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * Un archivo TypeScript: imports agrupados por módulo y ordenados (los paquetes antes que los
 * módulos propios), y el cuerpo. `imports` es una lista de `{ symbol, from, type? }` (`symbol` puede
 * llevar alias: `NotFoundException as RouteNotFound`): `from` es un
 * paquete (`@nestjs/common`, `node:crypto`) o una ruta desde la raíz (`src/...ts` o `.js`). Un
 * símbolo que el propio archivo declara no se importa.
 */
export function tsModule(filePath, imports, body) {
  const byModule = new Map();
  for (const imp of imports.filter(Boolean)) {
    const isLocal = imp.from.startsWith('src/');
    const target = isLocal ? imp.from.replace(/\.js$/, '.ts') : imp.from;
    if (isLocal && target === filePath) continue;
    const specifier = isLocal ? relativeSpecifier(filePath, target) : imp.from;
    if (!byModule.has(specifier)) byModule.set(specifier, { local: isLocal, symbols: new Map() });
    const entry = byModule.get(specifier).symbols;
    // Un símbolo que se usa como valor en algún sitio no puede quedarse como `import type`.
    entry.set(imp.symbol, (entry.get(imp.symbol) ?? true) && Boolean(imp.type));
  }
  const lines = [...byModule.entries()]
    .sort(([a, ea], [b, eb]) => Number(ea.local) - Number(eb.local) || a.localeCompare(b))
    .map(([specifier, { symbols }]) => {
      const names = [...symbols.entries()].sort(([a], [b]) => a.localeCompare(b));
      const allTypes = names.every(([, type]) => type);
      const list = names.map(([name, type]) => (type && !allTypes ? `type ${name}` : name)).join(', ');
      return `import ${allTypes ? 'type ' : ''}{ ${list} } from '${specifier}';`;
    });
  return `${lines.length > 0 ? `${lines.join('\n')}\n\n` : ''}${body.trimEnd()}\n`;
}

/** Comentario de documentación TSDoc a partir de líneas de prosa (vacío si no hay nada). */
export function tsdoc(text, indent = '') {
  const lines = (Array.isArray(text) ? text : [text]).filter((line) => line != null && line !== '');
  if (lines.length === 0) return '';
  const body = lines.flatMap((line) => String(line).split('\n'));
  if (body.length === 1) return `${indent}/** ${escapeComment(body[0])} */\n`;
  return `${indent}/**\n${body.map((line) => `${indent} * ${escapeComment(line)}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

function escapeComment(text) {
  return String(text).replaceAll('*/', '*\\/');
}

/** Literal de cadena TypeScript seguro (comillas simples, escapes de JSON). */
export function tsString(value) {
  return `'${JSON.stringify(String(value)).slice(1, -1).replaceAll("\\\"", '"').replaceAll("'", "\\'")}'`;
}

export function capitalize(name) {
  return name[0].toUpperCase() + name.slice(1);
}

export function decapitalize(name) {
  return name[0].toLowerCase() + name.slice(1);
}
