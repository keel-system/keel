// Las notas de los filtros de TEXTO de una query (`match`/`compare` en su input, DSL 2.14), iguales en los dos
// generadores.
//
// La comparación plegada de un filtro va contra la SOMBRA que build mantiene (`<campo>Normalized`, estampada al
// guardar con `TextFold`), sea del propio campo (`fold`) o del filtro (`filterFold`, model.js § deriveFilterFolds).
// Hasta que esta nota fue neutral, la de keel-nest solo decía «ignorando mayúsculas y acentos» y su agente plegó
// dentro de la consulta con `translate(lower(…))`: otra función de plegado que la de `TextFold`, así que el mismo
// listado podía devolver filas distintas en los dos servidores (corridas de catalog, 2026-10-10 y 2026-10-11).

import { foldedShadow } from './relational.js';

// Y el texto buscado de un `match: prefix | contains` es LITERAL: un `%`, un `_` o una barra del parámetro casan
// consigo mismos. El agente de keel-nest escribió su escape con un template literal que nunca interpolaba
// (`?name=50%` buscaba «50${character}») y no escapaba la barra; ningún escenario buscaba un comodín, así que la
// corrida cerró 194/194 con el filtro roto (corrida catalog-nest, 2026-10-13).
const LITERAL =
  'el texto buscado es LITERAL: un %, un _ o una barra invertida del parámetro casan consigo mismos, no son comodines ' +
  '(escápalos antes de componer el patrón, y el carácter de escape también)';

/** ¿Tiene la operación algún filtro que case por patrón (`match: prefix | contains`)? */
export function hasPatternFilter(operation) {
  if (operation.kind !== 'query') return false;
  return [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])].some((component) => (component.match ?? 'exact') !== 'exact');
}

/**
 * Las notas, una por filtro de texto que no sea igualdad exacta. Sin persistencia, solo cómo casa. `names` pone la
 * grafía de la plataforma: la función de plegado y el miembro de la sombra (keel-dotnet escribe `FoldCaseAndAccents` y
 * `NameNormalized`; con la grafía de Java su agente no encontraba ninguno de los dos, corrida catalog-dotnet 2026-10-16).
 */
export function textFilterNotes(model, operation, { names = (symbol) => symbol } = {}) {
  if (operation.kind !== 'query') return [];
  const owner = (model.services ?? []).find((service) => service.operations.includes(operation))?.entity;
  const entity = (model.entities ?? []).find((candidate) => candidate.name === owner);
  const notes = [];
  for (const component of [...(operation.pathParams ?? []), ...(operation.bodyFields ?? [])]) {
    const match = component.match ?? 'exact';
    const compare = component.compare ?? 'exact';
    if (match === 'exact' && compare === 'exact') continue;
    const how = `match: ${match}, compare: ${compare}`;
    const casa = match === 'exact' ? 'igualdad' : match === 'prefix' ? 'empieza por' : 'contiene';
    const field = entity?.persisted ? entity.fields.find((candidate) => candidate.name === component.name) : null;
    const shadow = compare !== 'exact' && field ? foldedShadow(field) : null;
    if (shadow) {
      const fold = `TextFold.${names(shadow.accents ? 'foldCaseAndAccents' : 'foldCase')}`;
      notes.push(
        `Filtro ${component.name} (${how}): ${casa}; pliega el parámetro con ${fold}(...) y compáralo contra ` +
          `${entity.name}.${names(shadow.name)}, la sombra que build ya mantiene — nunca contra ${component.name} con ` +
          'lower()/unaccent()/translate() en la consulta: plegar el valor guardado y el buscado con dos funciones distintas ' +
          'deja de casar en silencio con el primer carácter en que difieran' +
          (match === 'exact' ? '' : `; ${LITERAL}`)
      );
      continue;
    }
    notes.push(
      `Filtro ${component.name} (${how}): ${casa}, ` +
        (compare === 'exact' ? 'sensible a mayúsculas' : `ignorando ${compare === 'ignore-case-accents' ? 'mayúsculas y acentos' : 'mayúsculas'}`) +
        (match === 'exact' ? '' : `; ${LITERAL}`)
    );
  }
  return notes;
}
