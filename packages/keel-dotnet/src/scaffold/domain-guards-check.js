// El gate del formato de los value types ESCALARES: `infra/check-domain-guards.sh`, el mismo script que
// emite keel-nest (keel-core/gen/domain-guards.js) y con las MISMAS filas que el de keel-spring.
//
// El lector de la petición valida el formato heredado de un value type, pero un evento o una operación
// interna no pasan por él, así que el dominio lo repite. build genera `<Tipo>Format` con la expresión del
// diseño, pero la LLAMADA es del agente, y ese tramo falla en silencio: el servicio compila, arranca y
// acepta por esas puertas valores que el diseño declara imposibles. Se comprueba que la clase exista y que
// ALGUIEN la llame desde código vivo, no DÓNDE.

import { guardedFields, domainGuardsScript } from 'keel-core/gen/domain-guards';
import { located } from './render.js';

export function generate(model) {
  if (guardedFields(model).length === 0) return [];
  const content = domainGuardsScript(model, {
    classFile: (className) => located(model, 'valueObjects', className).path,
    sourceGlob: '*.cs',
    importPrefix: 'using ',
    methods: ['Validate', 'Matches']
  });
  return [{ path: 'infra/check-domain-guards.sh', content }];
}
