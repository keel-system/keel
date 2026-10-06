// Los `designGaps` que dejó la última generación de un servicio: el pipeline de agentes los escribe en
// `design-gaps.yaml` en la raíz del proyecto generado, y el `check` de cada generador los imprime desde
// el workspace, que es donde se corrige el diseño. Es el mismo archivo y el mismo schema
// (`design-gaps.schema.json`) con cualquier generador, así que se lee en un solo sitio.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readManifest } from './generated-manifest.js';

export const DESIGN_GAPS_FILE = 'design-gaps.yaml';

/**
 * Los `designGaps` del proyecto `services/<servicio>-<projectSuffix>/`, si existe.
 *
 * Tolerante a propósito: un archivo ausente, mal formado o de otra versión no puede impedir que se
 * compruebe el diseño — lo que aporta es contexto, no veredicto. Un YAML roto se dice en voz alta y
 * se sigue; callarlo dejaría al diseñador creyendo que la generación no encontró nada.
 */
export function readDesignGaps(workspace, manifest, projectSuffix) {
  const empty = { entries: [], stale: false, version: null, error: null, design: null };
  const service = manifest?.service?.name;
  if (!service) return empty;

  const projectDir = path.join(workspace, 'services', `${service}-${projectSuffix}`);
  const file = path.join(projectDir, DESIGN_GAPS_FILE);
  if (!fs.existsSync(file)) return empty;

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ...empty, error: `${DESIGN_GAPS_FILE}: YAML inválido — ${error.message}` };
  }
  if (!doc || !Array.isArray(doc.gaps)) return empty;

  return {
    entries: doc.gaps,
    version: doc.version ?? null,
    stale: Boolean(doc.version) && doc.version !== manifest.service?.version,
    error: null,
    design: readManifest(projectDir)?.design ?? null
  };
}
