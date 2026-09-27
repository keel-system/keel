// El ejecutor del corpus de mutaciones: evalúa un diseño EN MEMORIA contra la puerta mecánica
// y devuelve lo que un test puede afirmar sin depender de la redacción de ningún mensaje.
//
// Dos decisiones que no son de comodidad:
//
//   - Se valida el SCHEMA antes de nada, con el mismo Ajv que `validate-service.js`. Una
//     mutación que el schema rechaza pone el diseño en un estado al que `checkCrossRefs` no
//     llega nunca en la CLI (la validación corta en la capa 1), así que afirmar lo que dispara
//     ahí sería medir un camino que no existe. El test trata un error de schema como una
//     mutación mal escrita, no como un hallazgo.
//   - Los hallazgos SIN id se devuelven aparte. No se pueden citar ni aceptar, pero sí contar:
//     una mutación que dispara su id y además una cadena anónima no está aislada, y el corpus
//     tiene que verlo. Por eso el ruido anónimo por defecto es cero y declararlo exige motivo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import { LAYERS, schemaPathFor } from '../../src/lib/assets.js';
import { loadService } from '../../src/lib/loader.js';
import { checkCrossRefs } from '../../src/lib/crossrefs.js';
import { SCENARIOS_FILE } from '../../src/lib/spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export const BASE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base');

let base = null;

/** El diseño base tal como está en disco: `{ manifest, layers, scenarios }`. Se lee una vez. */
function loadBase() {
  if (base) return base;
  const { manifest, layers, errors } = loadService(BASE_DIR);
  if (!manifest || errors.length > 0) {
    throw new Error(`el diseño base no carga: ${errors.join('; ')}`);
  }
  const scenarios = fs.readFileSync(path.join(BASE_DIR, SCENARIOS_FILE), 'utf8');
  base = { manifest, layers, scenarios };
  return base;
}

/** Una copia del base que una mutación puede modificar sin tocar la de las demás. */
export function freshBase() {
  return structuredClone(loadBase());
}

let validators = null;

function schemaValidators() {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(schemaPathFor('common'), 'utf8')));
  const compile = (name) => ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor(name), 'utf8')));
  validators = { service: compile('service') };
  for (const layer of LAYERS) validators[layer] = compile(layer);
  return validators;
}

/**
 * Evalúa un diseño `{ manifest, layers, scenarios }`.
 *
 * @returns {{
 *   schemaErrors: string[],            // «capa: /ruta mensaje»; vacío si el schema lo acepta
 *   ids: string[],                     // CHK-* y OBL-* disparados, ordenados, con repeticiones
 *   anonymous: { errors: string[], warnings: string[] },
 *   pending: string[]
 * }}
 */
export function evaluate(design) {
  const check = schemaValidators();
  const schemaErrors = [];
  const describe = (file, errors) =>
    (errors ?? []).map((error) => `${file}: ${error.instancePath || '/'} ${error.message}`);
  if (!check.service(design.manifest)) schemaErrors.push(...describe('service', check.service.errors));
  for (const layer of LAYERS) {
    if (!(layer in design.layers)) continue;
    if (!check[layer](design.layers[layer])) schemaErrors.push(...describe(layer, check[layer].errors));
  }

  const result = checkCrossRefs({
    layers: design.layers,
    scenarios: design.scenarios,
    manifest: design.manifest
  });
  const withId = new Set(result.findings.map((finding) => finding.message));
  return {
    schemaErrors,
    ids: [...result.findings.map((finding) => finding.id), ...result.obligations.map((entry) => entry.id)].sort(),
    anonymous: {
      errors: result.errors.filter((message) => !withId.has(message)),
      warnings: result.warnings.filter((message) => !withId.has(message))
    },
    pending: result.pending
  };
}
