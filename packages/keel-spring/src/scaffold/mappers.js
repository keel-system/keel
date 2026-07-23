// Mappers de aplicación (patrón del prototipo): <Entidad>ApplicationMapper
// traduce el agregado de dominio a los ResponseDto de las operaciones cuyos
// payloads derivan de esa entidad. Asignación campo a campo, sin reflexión.

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

function renderMapper(model, entity, dtos) {
  const imports = new Set([
    `${subPackage(model, ANNOTATIONS_PKG)}.ApplicationComponent`,
    `${subPackage(model, domainSubPackage(entity))}.${entity.name}`
  ]);

  // Getters directos disponibles en la entidad de dominio; un campo del DTO que
  // no corresponda (p. ej. subcampo de value object o derivado) lo completa el agente.
  const gettable = new Set(domainMembers(model, entity).map((m) => m.name));

  const methods = dtos.map((dto) => {
    imports.add(`${subPackage(model, 'application.dtos')}.${dto.name}`);
    const args = dto.fields.map((field) =>
      gettable.has(field.name)
        ? `entity.get${capitalize(field.name)}()`
        : `null /* TODO (agente): ${field.name} no es getter directo de ${entity.name}; mapéalo (¿subcampo de value object?) */`
    );
    return `    public ${dto.name} to${dto.name}(${entity.name} entity) {
        return new ${dto.name}(
                ${args.join(',\n                ')});
    }`;
  });

  const body = `@ApplicationComponent
public class ${entity.name}ApplicationMapper {

${methods.join('\n\n')}
}`;

  return {
    path: javaPath(model, MAPPER_PKG, `${entity.name}ApplicationMapper`),
    content: javaFile(subPackage(model, MAPPER_PKG), [...imports], body)
  };
}
