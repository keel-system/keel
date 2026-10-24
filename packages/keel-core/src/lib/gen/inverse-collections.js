// Las colecciones de una respuesta que se leen por la FK INVERSA: una uno-a-muchos hacia otra raíz (`Cart.products` hacia
// la raíz `ProductInOrder`), que el agregado no guarda porque sus filas son de la otra raíz. Neutral: la misma lectura y la
// misma nota en los tres generadores.
//
// El modelo la proyecta como lista de `<Destino>Dto` marcada `inverse` (model.js, `relationPayloadFields`), y el mapper la
// recibe como parámetro, como un `RefDto`. Lo que falta para que nadie la escriba a mano es la LECTURA: el puerto del
// destino gana `findAllBy<Inversa>Id(id)`, que devuelve las filas cuya FK inversa es ese id —una consulta por agregado, o
// por página con `findAllBy<Inversa>IdIn(ids)`—, y el handler una nota que dice cuál llamar. Salió con shop-api
// (2026-10-23): la respuesta de getCart salía sin sus líneas en keel-spring, keel-nest y keel-dotnet, y el agente de
// código de keel-dotnet añadió las seis a mano.

const capitalize = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Los campos `inverse` de un DTO de respuesta (solo el primer nivel: un DTO anidado no arrastra otra lectura). */
export function inverseFieldsOf(dto) {
  return (dto?.fields ?? []).filter((field) => field.kind === 'childDto' && field.inverse);
}

/** El finder de una inversa en el puerto del destino: `findAllByCartId`. */
export function inverseFinderName(inverse) {
  return `findAllBy${capitalize(inverse.relation)}Id`;
}

/**
 * Los finders que gana el puerto de cada raíz destino, sin repetir: `{ entity, relation, finder, owner }`. Solo con
 * persistencia: sin ella no hay puerto que consultar.
 */
export function inverseFinders(model) {
  if (!model.layersPresent?.persistence) return [];
  const found = new Map();
  for (const group of model.services ?? []) {
    for (const operation of group.operations ?? []) {
      for (const field of inverseFieldsOf(operation.responseDto)) {
        const key = `${field.inverse.entity}.${field.inverse.relation}`;
        if (!found.has(key)) found.set(key, { entity: field.inverse.entity, relation: field.inverse.relation, owner: field.inverse.owner, finder: inverseFinderName(field.inverse) });
      }
    }
  }
  return [...found.values()].sort((a, b) => `${a.entity}.${a.relation}`.localeCompare(`${b.entity}.${b.relation}`));
}

/** Los finders de una raíz concreta, para su puerto y sus adaptadores. */
export function inverseFindersOf(model, entityName) {
  return inverseFinders(model).filter((finder) => finder.entity === entityName);
}

/**
 * La nota del handler de una operación cuya respuesta lleva colecciones inversas. `port(entity)` es cómo se nombra en el
 * lenguaje del generador el repositorio de esa raíz (`productInOrderRepository`), y `id` la expresión del id del agregado.
 */
export function inverseCollectionsNote(operation, { port, id }) {
  const fields = inverseFieldsOf(operation.responseDto);
  if (fields.length === 0) return null;
  const reads = fields.map((field) => `${field.name} con ${port(field.inverse.entity)}.${inverseFinderName(field.inverse)}(${id})`);
  const listing = operation.paginated || operation.returnsList
    ? ' En un listado es una lectura por elemento de la página: el finder por lote todavía no existe, así que mantén la página acotada.'
    : '';
  return `La respuesta lleva ${fields.map((field) => field.name).join(' y ')}, filas de OTRA raíz que el agregado no guarda: léelas por su FK inversa (${reads.join('; ')}) y pásalas al mapper.${listing}`;
}
