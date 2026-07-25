// Mappers de aplicación (patrón del prototipo): <Entidad>ApplicationMapper
// traduce el agregado de dominio a los ResponseDto de las operaciones cuyos
// payloads derivan de esa entidad, y a los <Hija>Dto de las entidades hijas que
// esos payloads proyectan. Asignación campo a campo, sin reflexión.

import { javaFile, javaPath, subPackage } from './render.js';
import { domainMembers, domainSubPackage, capitalize } from './entities.js';
import { ANNOTATIONS_PKG } from './mediator.js';

const MAPPER_PKG = 'application.mappers';

export function generate(model) {
  // Agrupa los responseDto derivados de entidad por entidad de origen.
  const byEntity = new Map();
  for (const service of model.services) {
    for (const operation of service.operations) {
      const dto = operation.responseDto;
      if (!dto?.entity) continue;
      if (!byEntity.has(dto.entity)) byEntity.set(dto.entity, new Map());
      byEntity.get(dto.entity).set(dto.name, dto);
    }
  }

  const files = [];
  for (const [entityName, dtos] of byEntity) {
    const entity = model.entities.find((e) => e.name === entityName);
    if (!entity) continue;
    files.push(renderMapper(model, entity, [...dtos.values()]));
  }
  return files;
}

// DTOs de entidad hija alcanzables desde estos DTOs, en cascada: cada uno se
// mapea en el mismo mapper del agregado que los proyecta.
function reachableChildDtos(model, dtos) {
  const byEntity = new Map((model.childDtos ?? []).map((child) => [child.entity, child]));
  const found = new Map();
  const pending = dtos.flatMap((dto) => dto.fields.filter((f) => f.kind === 'childDto').map((f) => f.childEntity));

  while (pending.length > 0) {
    const entityName = pending.shift();
    if (found.has(entityName)) continue;
    const child = byEntity.get(entityName);
    if (!child) continue;
    found.set(entityName, child);
    for (const field of child.fields) {
      if (field.kind === 'childDto') pending.push(field.childEntity);
    }
  }
  return [...found.values()];
}

function renderMapper(model, entity, dtos) {
  const imports = new Set([
    `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`
  ]);

  const children = reachableChildDtos(model, dtos);
  const methods = dtos.map((dto) => renderMethod(model, entity, dto, imports));

  for (const child of children) {
    const childEntity = model.entities.find((e) => e.name === child.entity);
    if (!childEntity) continue;
    imports.add(`${subPackage(model, domainSubPackage(childEntity))}.${childEntity.name}`);
    methods.push(renderMethod(model, childEntity, child, imports));
  }

  const body = `@ApplicationComponent
public class ${entity.name}ApplicationMapper {

${methods.join('\n\n')}
}`;

  return {
    path: javaPath(model, MAPPER_PKG, `${entity.name}ApplicationMapper`),
    content: javaFile(subPackage(model, MAPPER_PKG), [...imports], body)
  };
}

function renderMethod(model, entity, dto, imports) {
  imports.add(`${subPackage(model, 'application.dtos')}.${dto.name}`);

  // Getters directos disponibles en la entidad de dominio; un campo del DTO que
  // no corresponda (p. ej. subcampo de value object o derivado) lo completa el agente.
  const gettable = new Set(domainMembers(model, entity).map((m) => m.name));
  const args = dto.fields.map((field) => {
    if (!gettable.has(field.name)) {
      return `null /* TODO (agente): ${field.name} no es getter directo de ${entity.name}; mapéalo (¿subcampo de value object?) */`;
    }
    const getter = `entity.get${capitalize(field.name)}()`;
    // Entidad hija: se proyecta con su propio DTO, nunca con el del padre.
    if (field.kind === 'childDto') {
      return field.list
        ? `${getter}.stream().map(this::to${field.elementJavaType}).toList()`
        : `${getter} != null ? to${field.elementJavaType}(${getter}) : null`;
    }
    return getter;
  });

  return `    public ${dto.name} to${dto.name}(${entity.name} entity) {
        return new ${dto.name}(
                ${args.join(',\n                ')});
    }`;
}
