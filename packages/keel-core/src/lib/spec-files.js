// Los archivos que acompañan al manifiesto y a las capas dentro de specs/<servicio>/.
//
// Existe porque cada sitio que mueve un diseño (publicar en un registry, derivar
// con `keel new --from`, adoptar con `keel registry get`) enumeraba esos archivos
// a mano, y así fue como `decisions.yaml` se quedó fuera de los dos transportes de
// forma independiente: un diseño que aceptaba obligaciones por escrito llegaba al
// consumidor sin ellas, y su `keel-<tech> build` lo rechazaba por decisiones que el
// autor ya había tomado.
//
// La tabla contesta de una vez las dos preguntas que cada transporte se hacía por
// separado. Módulo hoja a propósito (solo stdlib): las constantes las reexportan
// los módulos donde vivían, así que importar desde aquí no puede crear ciclos.

import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_FILE = 'design.yaml';
export const DECISIONS_FILE = 'decisions.yaml';
export const SCENARIOS_FILE = 'validation-scenarios.md';

/**
 * - `publish` — entra en el `files[]` del índice, que es exactamente lo que
 *   descarga un consumidor remoto. `'derivative'` significa «viaja, pero lo
 *   enumera el catálogo de derivados» (derivatives.js), que además le sigue la
 *   frescura: `filesOf()` no lo añade dos veces.
 * - `derive` — se copia al derivar con `keel new --from`. `'rewrite'` es el caso
 *   de los escenarios, cuya cabecera se reapunta al servicio nuevo.
 *
 * `design.yaml` no viaja al derivar: es metadato de publicación **del origen**.
 * `decisions.yaml` sí, y llega caducado a propósito — el derivado resetea a
 * 0.1.0 y `keel validate` obliga a reafirmar cada aceptación.
 */
export const SPEC_SIDE_FILES = [
  { file: SIDECAR_FILE, publish: true, derive: false },
  { file: DECISIONS_FILE, publish: true, derive: true },
  { file: SCENARIOS_FILE, publish: 'derivative', derive: 'rewrite' }
];

/**
 * Nombres de los archivos de la tabla que existen en `dir` y que el transporte
 * `key` (`'publish'` | `'derive'`) mueve tal cual, en el orden de la tabla.
 * Los valores no booleanos (`'derivative'`, `'rewrite'`) los gestiona quien
 * llama, así que no salen de aquí.
 */
export function sideFilesOf(dir, key) {
  return SPEC_SIDE_FILES.filter((entry) => entry[key] === true)
    .map((entry) => entry.file)
    .filter((file) => fs.existsSync(path.join(dir, file)));
}
