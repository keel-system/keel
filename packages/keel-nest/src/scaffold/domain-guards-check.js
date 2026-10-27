// El gate del formato de los value types ESCALARES: `infra/check-domain-guards.sh`, el mismo que
// emite keel-spring y con las MISMAS filas (guardedFields de keel-core/gen).
//
// El lector de la petición valida el formato heredado de un value type, pero un evento o una operación
// interna no pasan por él, así que el dominio lo repite. build genera `<Tipo>Format` con la regex del
// diseño, pero la LLAMADA es del agente, y ese tramo falla en silencio: el servicio compila, arranca y
// acepta por esas puertas valores que el diseño declara imposibles. Alcance deliberado, como en keel-spring: se comprueba que la clase exista y
// que ALGUIEN la llame desde código vivo, no DÓNDE — un check que exige una ubicación concreta tiene
// como camino de menor resistencia romper el código para callarlo.

import { guardedFields, domainGuardsScript } from '@keel-system/keel-core/gen/domain-guards';
import { DIRS, classPath } from './render.js';

export function usesDomainGuardsCheck(model) {
  return guardedFields(model).length > 0;
}

export function generate(model) {
  const rows = guardedFields(model);
  if (rows.length === 0) return [];
  const content = domainGuardsScript(model, {
    classFile: (className) => classPath(DIRS.valueObjects, className),
    sourceGlob: '*.ts',
    importPrefix: 'import ',
    methods: ['validate', 'matches']
  });
  return [{ path: 'infra/check-domain-guards.sh', content }];
}
