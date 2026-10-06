// Elecciones tecnológicas del servicio generado, persistidas en
// services/<name>-spring/keel-stack.json.
//
// El cuestionario, la deriva y la normalización son neutrales y viven en keel-core/gen/stack.js:
// las categorías y sus opciones son las mismas para cualquier generador, porque la
// infraestructura es la misma. Lo único de Java es la pregunta de identidad del proyecto —el
// grupo (groupId)—, que se le pasa al cuestionario como `identity`.

import { askStackConfig as askNeutralStackConfig } from 'keel-core/gen/stack';
import { promptText } from 'keel-core/gen/prompt';
import { defaultGroup, isValidPackage } from './naming.js';

export {
  STACK_FILE,
  readStackConfig,
  writeStackConfig,
  designUsesCache,
  stackDrift,
  normalizeTelemetry,
  describeStack
} from 'keel-core/gen/stack';

/** El cuestionario del stack, con la pregunta del grupo de Java delante. */
export async function askStackConfig(manifest, layers, options = {}) {
  return askNeutralStackConfig(manifest, layers, {
    ...options,
    identity: async ({ defaults }) => ({ group: await askGroup(manifest, defaults) })
  });
}

function askGroup(manifest, defaults) {
  return promptText('¿Qué grupo (groupId) usará el proyecto? Ej. com.example', {
    defaultValue: defaultGroup(manifest),
    validate: (value) => {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return undefined; // vacío → se usa el default
      if (!isValidPackage(trimmed)) return 'Grupo inválido: usa minúsculas y segmentos separados por punto (com.example).';
    },
    defaults
  });
}
