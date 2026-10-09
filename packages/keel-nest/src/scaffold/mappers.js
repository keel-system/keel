// Mappers de aplicación: <Entidad>ApplicationMapper traduce el agregado de dominio a los ResponseDto
// de las operaciones cuyos payloads derivan de esa entidad, y a los <Hija>Dto de las hijas que esos
// payloads proyectan. Asignación campo a campo, sin reflexión (el mismo reparto que keel-spring).
//
// Lo que el mapper no puede derivar del agregado entra por PARÁMETRO, para que el compilador no deje
// olvidarlo: el agregado embebido de otra raíz (solo guarda su id), el dato de otro servicio y el id
// de la raíz de una hija devuelta suelta. Y un campo del DTO que no es getter directo de la entidad
// sale como `todo(...)`, que COMPILA y falla en ejecución nombrando el campo: en Java es un `null`
// con comentario, pero en TypeScript estricto un null no cabe en un campo obligatorio.

import { isPublicBucket } from 'keel-core/gen';
import { DIRS, classPath, declType, entityDir, isNullable, tsModule } from './render.js';
import { FILE_STORAGE_TS, STORAGE_POLICIES_TS } from './storage.js';
import { screamingSnake } from 'keel-core/gen';
import { ANNOTATIONS_TS } from './mediator.js';
import { domainMembers } from './entities.js';

export const TODO_TS = classPath(DIRS.appSupport, 'Todo');

/** Las clases mapper con su archivo, para quien las cablea (UseCaseModule). */
export function mapperClasses(model) {
  return [...mappersByEntity(model).keys()]
    .filter((name) => model.entities.some((entity) => entity.name === name))
    .map((name) => ({ symbol: `${name}ApplicationMapper`, from: classPath(DIRS.mappers, `${name}ApplicationMapper`) }));
}

function mappersByEntity(model) {
  const byEntity = new Map();
  const add = (entityName, dto) => {
    if (!byEntity.has(entityName)) byEntity.set(entityName, new Map());
    byEntity.get(entityName).set(dto.name, dto);
  };
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      if (operation.responseDto?.entity) add(operation.responseDto.entity, operation.responseDto);
    }
  }
  // El DTO de referencia de un embed lo produce el mapper del agregado referenciado.
  for (const ref of model.refDtos ?? []) add(ref.entity, ref);
  return byEntity;
}

export function generate(model) {
  const files = [];
  for (const [entityName, dtos] of mappersByEntity(model)) {
    const entity = model.entities.find((e) => e.name === entityName);
    if (entity) files.push(renderMapper(model, entity, [...dtos.values()]));
  }
  // El helper solo si algún mapper lo usa: sin uso es código muerto en el proyecto (corrida profile-directory).
  if (files.some((file) => file.content.includes('support/todo.js'))) files.push({ path: TODO_TS, content: tsModule(TODO_TS, [], todoBody()) });
  return files;
}

function todoBody() {
  return `/**
 * Lo que build no sabe derivar y el agente tiene que escribir. Compila en cualquier sitio (devuelve
 * \`never\`) y falla en ejecución nombrando qué falta, en vez de dejar pasar un valor inventado.
 */
export function todo(what: string): never {
  throw new Error(\`TODO (agente): \${what}\`);
}`;
}

// DTOs de entidad hija alcanzables desde estos DTOs, en cascada.
function reachableChildDtos(model, dtos) {
  const byEntity = new Map((model.childDtos ?? []).map((child) => [child.entity, child]));
  const found = new Map();
  const pending = dtos.flatMap((dto) => dto.fields.filter((f) => f.kind === 'childDto').map((f) => f.childEntity));
  while (pending.length > 0) {
    const name = pending.shift();
    if (found.has(name)) continue;
    const child = byEntity.get(name);
    if (!child) continue;
    found.set(name, child);
    for (const field of child.fields) if (field.kind === 'childDto') pending.push(field.childEntity);
  }
  return [...found.values()];
}

function renderMapper(model, entity, dtos) {
  const className = `${entity.name}ApplicationMapper`;
  const file = classPath(DIRS.mappers, className);
  const imports = [
    { symbol: 'ApplicationComponent', from: ANNOTATIONS_TS },
    { symbol: entity.name, from: classPath(entityDir(entity), entity.name), type: true }
  ];
  const children = reachableChildDtos(model, dtos);
  const methods = dtos.map((dto) => renderMethod(model, entity, dto, imports));
  for (const child of children) {
    const childEntity = model.entities.find((e) => e.name === child.entity);
    if (!childEntity) continue;
    imports.push({ symbol: childEntity.name, from: classPath(entityDir(childEntity), childEntity.name), type: true });
    methods.push(renderMethod(model, childEntity, child, imports));
  }
  // Con un `file` de bucket público, el mapper resuelve su URL: necesita el puerto de almacenamiento.
  const storage = imports.some((imp) => imp.symbol === 'FileStorage');
  const injection = storage
    ? '  static readonly inject = [FileStorage] as const;\n\n  constructor(private readonly fileStorage: FileStorage) {}\n'
    : '  static readonly inject = [] as const;\n';
  const body = `@ApplicationComponent()
export class ${className} {
${injection}
${methods.join('\n\n')}
}`;
  return { path: file, content: tsModule(file, imports, body) };
}

const dtoPath = (name) => classPath(DIRS.dtos, name);

function renderMethod(model, entity, dto, imports) {
  imports.push({ symbol: dto.name, from: dtoPath(dto.name) });
  const refFields = dto.fields.filter((field) => field.kind === 'refDto');
  const needFields = dto.fields.filter((field) => field.kind === 'needDto');
  const parentFields = dto.fields.filter((field) => field.kind === 'parentId');
  // Con recorte el campo es una variante <E>SummaryDto, pero el parámetro sigue siendo el <E>RefDto
  // completo que da el resolver: el recorte se hace aquí.
  const refParamType = (ref) => {
    const name = ref.refSource ?? ref.tsType;
    return declType({ ...ref, tsType: name, elementTsType: name });
  };
  for (const ref of refFields) {
    imports.push({ symbol: ref.tsType, from: dtoPath(ref.tsType) });
    if (ref.refSource) imports.push({ symbol: ref.refSource, from: dtoPath(ref.refSource), type: true });
  }
  for (const need of needFields) imports.push({ symbol: need.elementTsType ?? need.tsType, from: dtoPath(need.elementTsType ?? need.tsType), type: true });

  const params = [
    `entity: ${entity.name}`,
    ...refFields.map((ref) => `${ref.name}: ${refParamType(ref)}`),
    ...needFields.map((need) => `${need.name}: ${declType(need)}`),
    ...parentFields.map((parent) => `${parent.name}: ${declType(parent)}`)
  ].join(', ');

  const gettable = new Set(domainMembers(model, entity).map((m) => m.name));
  let usesTodo = false;
  const todo = (what) => {
    usesTodo = true;
    return `todo(${JSON.stringify(what)})`;
  };
  const values = dto.fields.map((field) => {
    if (field.kind === 'refDto' && field.refSource) return `${field.tsType}.from(${field.name})`;
    if (field.kind === 'refDto' || field.kind === 'needDto' || field.kind === 'parentId') return field.name;
    if (!gettable.has(field.name)) return todo(`${field.name} no es getter directo de ${entity.name}; mapéalo (¿subcampo de value object?)`);
    const getter = `entity.${field.name}`;
    // Un `file` de bucket público expone la URL, no la key: la resuelve FileStorage con el bucket del diseño (sus
    // constantes en StoragePolicies, nunca un literal), como el mapper de keel-spring.
    if (field.base === 'file' && !field.list && isPublicBucket(model, field.bucket)) {
      imports.push({ symbol: 'FileStorage', from: FILE_STORAGE_TS }, { symbol: 'StoragePolicies', from: STORAGE_POLICIES_TS });
      const url = `this.fileStorage.publicUrl(StoragePolicies.${screamingSnake(field.bucket)}, ${getter})`;
      return isNullable(field) ? `${getter} != null ? ${url} : null` : url;
    }
    if (field.kind === 'childDto') {
      const childDto = (model.childDtos ?? []).find((child) => child.entity === field.childEntity);
      const parentField = (childDto?.fields ?? []).find((f) => f.kind === 'parentId');
      const carriesParent = Boolean(parentField) && parentField.parentEntity === entity.name;
      if (parentField && !carriesParent) {
        return todo(`${field.name} proyecta ${field.elementTsType}, que pide el id de ${parentField.parentEntity}, y aquí solo hay un ${entity.name}`);
      }
      const method = `to${field.elementTsType}`;
      const extra = carriesParent ? ', entity.id' : '';
      if (field.list) return `${getter}.map((child) => this.${method}(child${extra}))`;
      return `${getter} == null ? null : this.${method}(${getter}${extra})`;
    }
    return getter;
  });
  if (usesTodo) imports.push({ symbol: 'todo', from: TODO_TS });
  const assignments = dto.fields.map((field, index) => `      ${field.name}: ${values[index]}`).join(',\n');
  return `  to${dto.name}(${params}): ${dto.name} {
    return new ${dto.name}({
${assignments}
    });
  }`;
}
