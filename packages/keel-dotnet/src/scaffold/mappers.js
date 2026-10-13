// Mappers de aplicación: <Entidad>ApplicationMapper traduce el agregado de dominio a los ResponseDto de las
// operaciones cuyos payloads derivan de esa entidad, y a los <Hija>Dto de las hijas que esos payloads
// proyectan. Asignación campo a campo, sin reflexión (el mismo reparto que keel-spring y keel-nest; nada de
// AutoMapper, que además tiene licencia comercial desde la 15).
//
// Lo que el mapper no puede derivar del agregado entra por PARÁMETRO, para que el compilador no deje olvidarlo:
// el agregado embebido de otra raíz (solo guarda su id), el dato de otro servicio y el id de la raíz de una hija
// devuelta suelta. Y un campo del DTO que no sale tal cual de la entidad —no es miembro suyo, su tipo es otro, o
// la entidad lo admite null y el DTO no— sale como `Todo.Value<T>(...)`, que COMPILA y falla en ejecución
// nombrando el campo, en vez de inventar un valor.

import { isPublicBucket } from 'keel-core/gen';
import { domainMembers } from './entities.js';
import { csFile, csLocal, csMember, csString, declType, entityPlace, isNullable, located, namespaceOf, typeUsings } from './render.js';

/** El mapper que necesita el handler de una operación, o null. */
export function mapperOf(model, operation) {
  const entity = operation.responseDto?.entity;
  return entity && model.entities.some((e) => e.name === entity) ? `${entity}ApplicationMapper` : null;
}

/** Los mappers que se emiten, por nombre de clase. */
export function mapperClasses(model) {
  return [...mappersByEntity(model).keys()].filter((name) => model.entities.some((entity) => entity.name === name)).map((name) => `${name}ApplicationMapper`);
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
  const state = { todo: false };
  for (const [entityName, dtos] of mappersByEntity(model)) {
    const entity = model.entities.find((e) => e.name === entityName);
    if (entity) files.push(renderMapper(model, entity, [...dtos.values()], state));
  }
  // El ayudante solo si algún mapper lo usa: sin uso es código muerto en el proyecto.
  if (state.todo) {
    const { namespace, path } = located(model, 'appSupport', 'Todo');
    files.push({ path, content: csFile({ namespace, body: todoBody() }) });
  }
  return files;
}

function todoBody() {
  return `/// <summary>
/// Lo que build no sabe derivar y el agente tiene que escribir. Compila en cualquier sitio y falla en ejecución
/// nombrando qué falta, en vez de dejar pasar un valor inventado.
/// </summary>
public static class Todo
{
    public static T Value<T>(string what) => throw new NotImplementedException($"TODO (agente): {what}");
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

function renderMapper(model, entity, dtos, state) {
  const className = `${entity.name}ApplicationMapper`;
  const { namespace, path } = located(model, 'mappers', className);
  const usings = [namespaceOf(model, entityPlace(entity))];
  const methods = dtos.map((dto) => renderMethod(model, entity, dto, usings, state));
  for (const child of reachableChildDtos(model, dtos)) {
    const childEntity = model.entities.find((e) => e.name === child.entity);
    if (!childEntity) continue;
    usings.push(namespaceOf(model, entityPlace(childEntity)));
    methods.push(renderMethod(model, childEntity, child, usings, state));
  }
  const body = `/// <summary>Traduce ${entity.name} a los DTOs de las operaciones que lo devuelven.</summary>
public sealed class ${className}
{
${methods.join('\n\n')}
}`;
  return { path, content: csFile({ namespace, usings, body }) };
}

const baseType = (type) => type.replace(/\?$/, '');

function renderMethod(model, entity, dto, usings, state) {
  usings.push(...typeUsings(model, [dto.name]));
  const refFields = dto.fields.filter((field) => field.kind === 'refDto');
  const needFields = dto.fields.filter((field) => field.kind === 'needDto');
  const parentFields = dto.fields.filter((field) => field.kind === 'parentId');
  // Con recorte el campo es una variante <E>SummaryDto, pero el parámetro sigue siendo el <E>RefDto completo que
  // da el resolver: el recorte se hace aquí.
  const refParamType = (ref) => {
    const name = ref.refSource ?? ref.elementCsType ?? ref.csType;
    if (ref.list) return `IReadOnlyList<${name}>`;
    return isNullable(ref) ? `${name}?` : name;
  };
  for (const ref of refFields) usings.push(...typeUsings(model, [ref.elementCsType ?? ref.csType, ref.refSource].filter(Boolean)));
  for (const need of needFields) usings.push(...typeUsings(model, [need.elementCsType ?? need.csType]));
  for (const field of dto.fields) usings.push(...(field.usings ?? []), ...typeUsings(model, [field.elementCsType ?? field.csType]));

  const params = [
    `${entity.name} entity`,
    ...refFields.map((ref) => `${refParamType(ref)} ${csLocal(ref.name)}`),
    ...needFields.map((need) => `${declType(need)} ${csLocal(need.name)}`),
    ...parentFields.map((parent) => `${declType(parent)} ${csLocal(parent.name)}`)
  ].join(', ');

  const members = new Map(domainMembers(model, entity).map((member) => [member.name, member]));
  const todo = (field, what) => {
    state.todo = true;
    usings.push(namespaceOf(model, 'appSupport'));
    return `Todo.Value<${declType(field)}>(${csString(what)})`;
  };
  const values = dto.fields.map((field) => {
    if (field.kind === 'refDto' && field.refSource) {
      if (field.list) return todo(field, `${field.name}: recorta cada ${field.refSource} a ${field.elementCsType}`);
      const variant = `${field.elementCsType ?? field.csType}.From(${csLocal(field.name)})`;
      return isNullable(field) ? `${csLocal(field.name)} is null ? null : ${variant}` : variant;
    }
    if (field.kind === 'refDto' || field.kind === 'needDto' || field.kind === 'parentId') return csLocal(field.name);
    const member = members.get(field.name);
    if (!member) return todo(field, `${field.name} no es miembro directo de ${entity.name}; mapéalo (¿subcampo de value object?)`);
    const getter = `entity.${csMember(member.name)}`;
    // Un `file` de bucket público expone la URL, no la clave: la resuelve el almacenamiento (incremento 13).
    if (field.base === 'file' && !field.list && isPublicBucket(model, field.bucket)) {
      return todo(field, `${field.name} es un archivo de bucket público: expón su URL con el almacenamiento, no la clave`);
    }
    if (field.kind === 'childDto') return childValue(model, entity, field, member, getter, todo);
    if (baseType(member.type) !== baseType(declType(field))) {
      return todo(field, `${field.name}: ${entity.name} lo guarda como ${member.type} y el DTO lo pide como ${declType(field)}`);
    }
    if (field.list) return `[.. ${getter}]`;
    if (member.type.endsWith('?') && !declType(field).endsWith('?')) {
      return `${getter} ?? ${todo(field, `${field.name} es opcional en ${entity.name} y obligatorio en el DTO: decide qué sale si falta`)}`;
    }
    return getter;
  });
  const assignments = dto.fields.map((field, index) => `            ${csMember(field.name)} = ${values[index]},`).join('\n');
  return `    public ${dto.name} To${dto.name}(${params}) =>
        new()
        {
${assignments}
        };`;
}

function childValue(model, entity, field, member, getter, todo) {
  const childDto = (model.childDtos ?? []).find((child) => child.entity === field.childEntity);
  const parentField = (childDto?.fields ?? []).find((f) => f.kind === 'parentId');
  const carriesParent = Boolean(parentField) && parentField.parentEntity === entity.name;
  if (parentField && !carriesParent) {
    return todo(field, `${field.name} proyecta ${field.elementCsType}, que pide el id de ${parentField.parentEntity}, y aquí solo hay un ${entity.name}`);
  }
  const method = `To${field.elementCsType}`;
  const extra = carriesParent ? ', entity.Id' : '';
  if (field.list) return `[.. ${getter}.Select(child => ${method}(child${extra}))]`;
  if (member.type.endsWith('?')) {
    return `${getter} is { } child ? ${method}(child${extra}) : ${isNullable(field) ? 'null' : todo(field, `${field.name} es opcional en ${entity.name} y obligatorio en el DTO`)}`;
  }
  return `${method}(${getter}${extra})`;
}
