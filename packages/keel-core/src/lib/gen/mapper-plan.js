// Qué mapeadores hacen falta, por agregado: los DTO de respuesta de sus operaciones, los de referencia de un `embed` y
// los de hija alcanzables desde ellos, en cascada. Es el inventario, no el código del mapeador; vivía copiado en
// keel-nest y keel-dotnet (auditoría del inc. 1 de PLAN-KEEL-GO.md).

/** Los DTO que mapea cada entidad: `Map<entidad, Map<nombreDto, dto>>`. El de referencia de un embed lo produce el mapper del agregado referenciado. */
export function mappersByEntity(model) {
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

/** Los DTO de entidad hija alcanzables desde estos DTO, en cascada. */
export function reachableChildDtos(model, dtos) {
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
