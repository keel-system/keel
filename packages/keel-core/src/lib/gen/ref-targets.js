// Qué raíces se leen POR LOTE por su id, y por qué. Neutral: lo comparten keel-spring y keel-nest.
//
// Un agregado solo guarda el id de la raíz ajena (frontera de agregado), así que el `<Raíz>RefDto` de un `embed` no
// se deriva de la entidad: lo produce un resolver, y lo hace por lote —una consulta por raíz referenciada, sea cual
// sea el tamaño de la página—. keel-spring lo emitía desde siempre (`<Raíz>RefResolver` + `findAllById`); keel-nest
// emitía la `RefDto` y su mapper pero no la lectura, y sus dos corridas de asset-vault la escribieron a mano
// (`findAllByIds`, `findAllByIdIn`). El otro caso es una query que RECIBE una lista de ids de la raíz que devuelve
// (`getProductsByIds`): las cuatro corridas de catalog, en los dos generadores, escribieron esa lectura a mano.

/**
 * Las raíces que algún payload embebe (`model.refDtos`), con su `RefDto`. Sin persistencia no hay puerto que
 * consultar; crossrefs ya garantiza que el destino de un embed es raíz de agregado.
 */
export function refTargets(model) {
  const targets = [];
  for (const ref of model.refDtos ?? []) {
    const entity = (model.entities ?? []).find((candidate) => candidate.name === ref.entity);
    if (!entity?.persisted || !entity.isAggregateRoot || !entity.idField) continue;
    targets.push({ ref, entity });
  }
  return targets;
}

/** ¿Embebe algún payload esta raíz? */
export function isRefTarget(model, entityName) {
  return refTargets(model).some((target) => target.entity.name === entityName);
}

/** Las raíces que embebe la respuesta de una operación, incluidas las que embeben los DTO de sus entidades hijas. */
export function refTargetsOf(model, operation) {
  const dto = operation.responseDto;
  if (!dto) return [];
  const byEntity = new Map((model.childDtos ?? []).map((child) => [child.entity, child]));
  const found = new Set();
  const seenChildren = new Set();
  const pending = [dto];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const field of current.fields ?? []) {
      if (field.kind === 'refDto') found.add(field.refEntity);
      if (field.kind === 'childDto' && !seenChildren.has(field.childEntity)) {
        seenChildren.add(field.childEntity);
        const child = byEntity.get(field.childEntity);
        if (child) pending.push(child);
      }
    }
  }
  return refTargets(model).filter((target) => found.has(target.entity.name));
}

/**
 * Las queries que reciben una LISTA de ids de la raíz que devuelven: `ids: { type: uuid, list: true }` en la
 * entrada y una lista (o página) de esa raíz en la salida. El enlace es el que declara el diseño —la operación
 * devuelve esa entidad— y el tipo del id, no el nombre del campo.
 */
export function listedIdQueries(model, entity) {
  const idBase = entity.idField?.base ?? 'uuid';
  return (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .filter(
      (operation) =>
        operation.kind === 'query' &&
        operation.responseDto?.entity === entity.name &&
        (operation.returnsList || operation.paginated) &&
        (operation.bodyFields ?? []).some((field) => field.list && field.base === idBase && field.kind === 'base')
    );
}

/**
 * ¿Necesita esta raíz `findAllById` en su puerto, y por qué? `'embed'` si algún payload la embebe; `'listed-ids'` si
 * una query recibe una lista de sus ids. Null si ninguna de las dos.
 */
export function idBatchReason(model, entity) {
  if (!entity?.persisted || !entity.isAggregateRoot || !entity.idField) return null;
  if (isRefTarget(model, entity.name)) return 'embed';
  if (listedIdQueries(model, entity).length > 0) return 'listed-ids';
  return null;
}

/**
 * La nota del handler de una query que recibe la lista de ids de la raíz que devuelve. `call` es la llamada en el
 * lenguaje del generador, con `{ids}` donde va el campo de la entrada.
 */
export function listedIdsNote(model, operation, { call }) {
  const entity = (model.entities ?? []).find((candidate) => candidate.name === operation.responseDto?.entity);
  if (!entity || !listedIdQueries(model, entity).includes(operation)) return null;
  const idBase = entity.idField?.base ?? 'uuid';
  const field = (operation.bodyFields ?? []).find((candidate) => candidate.list && candidate.base === idBase && candidate.kind === 'base');
  return (
    `Lectura por lote: los ${entity.name} de ${field.name} salen de UNA consulta, ${call.replace('{ids}', field.name)}; ` +
    'nunca un findById por elemento. El orden de salida no está garantizado y un id que no existe no aparece: el orden ' +
    'de la respuesta lo pone el diseño, no el puerto'
  );
}
