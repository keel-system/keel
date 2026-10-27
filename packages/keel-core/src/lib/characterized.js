// `characterized.yaml`: el sello de la ejecución de los escenarios de caracterización de un diseño
// RECUPERADO contra el legacy en marcha (keel-recover, PLAN-KEEL-RECOVER.md § Paso 5). Es el eje de
// corrección de la fidelidad: un `keep` dice «el servicio nuevo hace lo mismo que el legacy», y eso
// solo es verdad si se ha comprobado contra el legacy; un `fix` dice «el legacy hace otra cosa», y
// eso también se comprueba, o el escenario describiría un cambio imaginado.
//
// Lo escribe `keel-recover characterize` y no el agente, y va sellado por FLUJO con el mismo sello que
// el careo (`flowDigests`): un flujo tocado después de ejecutarlo vuelve a estar sin ejecutar, y
// recomprobar cuesta solo lo que cambió. Las convenciones de determinación rigen todos los `Then`, así
// que cambiarlas deja sin ejecutar el documento entero.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { CHARACTERIZED_FILE } from './spec-files.js';
import { conventionsDigest, flowDigests } from './flow-review.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { CHARACTERIZED_FILE } from './spec-files.js';

/** Las marcas que se ejecutan contra el legacy. `new` no existe en él. */
export const EXECUTED_MARKS = ['keep', 'fix', 'frontier'];

let validator;

function checkSchema(doc) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('characterized'), 'utf8')));
  }
  return validator(doc) ? [] : validator.errors;
}

/** Lee `characterized.yaml`: `{ doc, present, errors }`, como loadProvenance. */
export function loadCharacterized(dir) {
  const file = path.join(dir, CHARACTERIZED_FILE);
  if (!fs.existsSync(file)) return { doc: null, present: false, errors: [] };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, present: true, errors: [`${CHARACTERIZED_FILE}: YAML inválido — ${error.message}`] };
  }
  const schemaErrors = checkSchema(doc ?? {});
  if (schemaErrors.length > 0) {
    return {
      doc: null,
      present: true,
      errors: schemaErrors.map((error) => `${CHARACTERIZED_FILE}: ${error.instancePath || '(raíz)'} ${error.message}`)
    };
  }
  return { doc, present: true, errors: [] };
}

export function emptyCharacterized() {
  return { applies: false, present: false, expected: [], passed: [], failed: [], notRun: [], changed: [], orphans: [], conventionsChanged: false, errors: [] };
}

/**
 * Cruza el sello con los flujos que el documento marca hoy.
 *
 * - `expected` — los flujos marcados keep, fix o frontier (los que tienen que ejecutarse).
 * - `passed` / `failed` — ejecutados sobre el texto de hoy, en verde o en rojo (`{ id, mark, failures }`).
 * - `notRun` — marcados y sin fila en el sello.
 * - `changed` — con fila, pero el bloque o la marca cambiaron desde la ejecución.
 * - `orphans` — filas de flujos que el documento ya no marca para ejecutar.
 * - `conventionsChanged` — la sección de convenciones cambió: nada de lo ejecutado vale.
 *
 * @param {{ doc, present, errors }} loaded lo que devolvió loadCharacterized
 * @param {string|null} scenariosText validation-scenarios.md
 * @param {{ id, mark }[]} marked las marcas del paso 4 (provenance.characterization.flows)
 * @param {string|null} legacyName el `legacy.name` de provenance.yaml
 */
export function resolveCharacterized(loaded, scenariosText, marked, legacyName = null) {
  const result = emptyCharacterized();
  result.applies = true;
  result.present = loaded.present;
  result.errors.push(...loaded.errors);
  result.expected = marked.filter((flow) => EXECUTED_MARKS.includes(flow.mark) && !flow.proseOnly);
  if (!loaded.doc) {
    result.notRun = loaded.present ? [] : result.expected.map((flow) => flow.id);
    return result;
  }

  const { doc } = loaded;
  if (legacyName && doc.legacy.name !== legacyName) {
    result.errors.push(`${CHARACTERIZED_FILE} se ejecutó contra ${doc.legacy.name} y provenance.yaml habla de ${legacyName}`);
  }
  result.conventionsChanged = doc.conventionsSha256 !== conventionsDigest(scenariosText ?? '');
  const digests = new Map(flowDigests(scenariosText ?? '').map((entry) => [entry.id, entry.digest]));
  const sealed = new Map();
  for (const row of doc.flows) {
    if (sealed.has(row.id)) result.errors.push(`${CHARACTERIZED_FILE}: ${row.id} tiene dos filas`);
    sealed.set(row.id, row);
  }

  const expectedIds = new Set(result.expected.map((flow) => flow.id));
  for (const flow of result.expected) {
    const row = sealed.get(flow.id);
    if (!row) result.notRun.push(flow.id);
    else if (row.mark !== flow.mark || row.sha256 !== digests.get(flow.id) || result.conventionsChanged) result.changed.push(flow.id);
    else if (row.ok) result.passed.push(flow.id);
    else result.failed.push({ id: flow.id, mark: flow.mark, failures: row.failures ?? [] });
  }
  result.orphans = doc.flows.filter((row) => !expectedIds.has(row.id)).map((row) => row.id);
  return result;
}
