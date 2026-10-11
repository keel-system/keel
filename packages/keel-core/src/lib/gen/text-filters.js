// Las notas de los filtros de TEXTO de una query (`match`/`compare` en su input, DSL 2.14), iguales en los dos
// generadores.
//
// La comparación plegada de un filtro va contra la SOMBRA que build mantiene (`<campo>Normalized`, estampada al
// guardar con `TextFold`), sea del propio campo (`fold`) o del filtro (`filterFold`, model.js § deriveFilterFolds).
// Hasta que esta nota fue neutral, la de keel-nest solo decía «ignorando mayúsculas y acentos» y su agente plegó
// dentro de la consulta con `translate(lower(…))`: otra función de plegado que la de `TextFold`, así que el mismo
// listado podía devolver filas distintas en los dos servidores (corridas de catalog, 2026-10-10 y 2026-10-11).

import { foldedShadow } from './relational.js';

/** Las notas, una por filtro de texto que no sea igualdad exacta. Sin persistencia, solo cómo casa. */
export function textFilterNotes(model, operation) {
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
      const fold = shadow.accents ? 'TextFold.foldCaseAndAccents' : 'TextFold.foldCase';
      notes.push(
        `Filtro ${component.name} (${how}): ${casa}; pliega el parámetro con ${fold}(...) y compáralo contra ` +
          `${entity.name}.${shadow.name}, la sombra que build ya mantiene — nunca contra ${component.name} con ` +
          'lower()/unaccent()/translate() en la consulta: plegar el valor guardado y el buscado con dos funciones distintas ' +
          'deja de casar en silencio con el primer carácter en que difieran'
      );
      continue;
    }
    notes.push(
      `Filtro ${component.name} (${how}): ${casa}, ` +
        (compare === 'exact' ? 'sensible a mayúsculas' : `ignorando ${compare === 'ignore-case-accents' ? 'mayúsculas y acentos' : 'mayúsculas'}`)
    );
  }
  return notes;
}
