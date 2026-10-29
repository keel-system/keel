// El gate del formato de los value types ESCALARES: `infra/check-domain-guards.sh`, el mismo script que emiten
// keel-nest y keel-dotnet (keel-core/gen/domain-guards.js) y con las MISMAS filas que el de keel-spring.
//
// El lector de la petición valida el formato heredado de un value type, pero un evento o una operación interna no
// pasan por él, así que el dominio lo repite. build genera `<Tipo>Format` con la expresión del diseño, pero la
// LLAMADA es del agente, y ese tramo falla en silencio: el servicio compila, arranca y acepta por esas puertas
// valores que el diseño declara imposibles. Se comprueba que la variable exista y que ALGUIEN la llame desde
// código vivo (`SKUFormat.Validate(...)` dentro del dominio, `domain.SKUFormat.Validate(...)` fuera), no DÓNDE.

import { guardedFields, domainGuardsScript } from '@keel-system/keel-core/gen/domain-guards';
import { goFileName, layout } from './render.js';

export function generate(model) {
  if (guardedFields(model).length === 0) return [];
  const { domain } = layout(model);
  const content = domainGuardsScript(model, {
    classFile: (className) => `${domain.dir}/${goFileName(className)}.go`,
    sourceGlob: '*.go',
    importPrefix: 'import ',
    methods: ['Validate', 'Matches'],
    sourceDir: 'internal'
  });
  return [{ path: 'infra/check-domain-guards.sh', content }];
}
