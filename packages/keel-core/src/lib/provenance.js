// `provenance.yaml`: de dónde sale cada elemento de un diseño RECUPERADO de un servicio existente
// (keel-recover, PLAN-KEEL-RECOVER.md § 0). Cada elemento lleva su nivel —`measured` (una grabación
// del sistema en marcha), `read` (lectura del código, con archivo:línea), `asked` (lo decidió el
// humano) o `inferred` (el agente lo supuso)— y `inferred` no se admite en el diseño final: «un
// contrato inventado es un diseño incorrecto que parece completo».
//
// Lo que aporta este módulo es el INVENTARIO, derivado de las capas y no de lo que el agente declara.
// Medido en el inc. 1 de keel-recover: en conduit se coló un rol copiado de la forma de una fixture,
// sin fila en la procedencia, y una puerta que solo mirase las filas escritas no lo habría visto. Así
// que la pregunta no es «¿alguna fila es inferred?» sino «¿cada cosa que el diseño afirma tiene fila?».
//
// La presencia del archivo declara que el diseño es recuperado. Un diseño hacia delante no lo tiene
// y el criterio no le aplica; uno cuyo registro estructural ya habla de lo observado en un legacy
// (`origin` en decisions.yaml → structural) y no tiene procedencia, sí, y sale en rojo.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { PROVENANCE_FILE } from './spec-files.js';
import { scenarioIdOf, splitScenarioBlocks } from './scenario-blocks.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { PROVENANCE_FILE } from './spec-files.js';

export const PROVENANCE_LEVELS = ['measured', 'read', 'asked', 'inferred'];

// `read` cita el código: sin `archivo:línea` no se puede ir a mirarlo.
const FILE_LINE = /\S+:\d+/;

const keys = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);

/**
 * Los elementos que un diseño declara, como ids estables con la forma de los scopes de los avisos.
 * Cada colección con nombre de cada capa aporta un elemento por entrada, y cada bloque de
 * configuración de primer nivel uno. Dentro, lo que el legacy puede desmentir por separado: los
 * campos de una entidad o de un value object, su lifecycle y sus invariantes, los errores de una
 * operación, las reglas de acceso y los eventos publicados. Las `description` no cuentan: son prosa.
 */
export function provenanceInventory(layers) {
  const out = [];
  const push = (...ids) => out.push(...ids);
  const map = (prefix, value, inner) => {
    for (const name of keys(value)) {
      push(`${prefix}.${name}`);
      if (inner) inner(`${prefix}.${name}`, value[name]);
    }
  };
  const config = (layer, doc, skip) => {
    for (const key of keys(doc)) if (key !== 'description' && !skip.includes(key)) push(`${layer}.${key}`);
  };

  const domain = layers.domain;
  if (domain) {
    map('domain.types', domain.types, (id, type) => map(`${id}.fields`, type?.fields));
    map('domain.entities', domain.entities, (id, entity) => {
      map(`${id}.fields`, entity?.fields);
      if (entity?.lifecycle) push(`${id}.lifecycle`);
      if (Array.isArray(entity?.invariants) && entity.invariants.length) push(`${id}.invariants`);
    });
    map('domain.aggregates', domain.aggregates);
  }
  const useCases = layers['use-cases'];
  if (useCases) {
    map('use-cases.operations', useCases.operations, (id, op) => {
      for (const err of Array.isArray(op?.errors) ? op.errors : []) if (err?.code) push(`${id}.errors.${err.code}`);
    });
  }
  const persistence = layers.persistence;
  if (persistence) {
    config('persistence', persistence, ['entities']);
    map('persistence.entities', persistence.entities);
  }
  const api = layers.api;
  if (api) {
    config('api', api, ['endpoints']);
    map('api.endpoints', api.endpoints);
  }
  const security = layers.security;
  if (security) {
    config('security', security, ['roles', 'permissions', 'serviceClients', 'roleGrants', 'access']);
    for (const coll of ['roles', 'permissions', 'serviceClients', 'roleGrants']) map(`security.${coll}`, security[coll]);
    if (security.access) {
      if (security.access.default) push('security.access.default');
      map('security.access.rules', security.access.rules);
    }
  }
  const messaging = layers.messaging;
  if (messaging) {
    map('messaging.channels', messaging.channels);
    if (messaging.publishing) {
      if (messaging.publishing.reliability !== undefined) push('messaging.publishing.reliability');
      map('messaging.publishing.events', messaging.publishing.events);
    }
    map('messaging.subscriptions', messaging.subscriptions);
  }
  if (layers.dependencies) map('dependencies.dependencies', layers.dependencies.dependencies);
  if (layers['http-clients']) map('http-clients.clients', layers['http-clients'].clients);
  if (layers.storage) map('storage.buckets', layers.storage.buckets);
  if (layers.mail) config('mail', layers.mail, []);
  if (layers.payments) config('payments', layers.payments, []);
  return [...new Set(out)];
}

let validator;

function checkSchema(doc) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('provenance'), 'utf8')));
  }
  return validator(doc) ? [] : validator.errors;
}

/**
 * Lee `provenance.yaml`. `present` dice si el archivo existe aunque no se pueda leer: un diseño que
 * lo trae roto sigue siendo recuperado, y eso es un error, no «no aplica».
 *
 * @returns {{ doc: object|null, present: boolean, errors: string[] }}
 */
export function loadProvenance(dir) {
  const file = path.join(dir, PROVENANCE_FILE);
  if (!fs.existsSync(file)) return { doc: null, present: false, errors: [] };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, present: true, errors: [`${PROVENANCE_FILE}: YAML inválido — ${error.message}`] };
  }
  const schemaErrors = checkSchema(doc ?? {});
  if (schemaErrors.length > 0) {
    return {
      doc: null,
      present: true,
      errors: schemaErrors.map((error) => `${PROVENANCE_FILE}: ${error.instancePath || '(raíz)'} ${error.message}`)
    };
  }
  return { doc, present: true, errors: [] };
}

export function emptyProvenance() {
  return {
    applies: false,
    inventory: [],
    missing: [],
    inferred: [],
    orphans: [],
    unsourced: [],
    structuralUnsourced: [],
    characterization: emptyCharacterization(),
    errors: []
  };
}

// ── paso 4: la caracterización de los escenarios ──────────────────────────────────────────────
//
// En un diseño recuperado cada flujo de validation-scenarios.md dice qué hace con el legacy, en una
// línea «**Caracterización**: `keep`» (el servicio nuevo hace lo mismo), `fix` (corrige a propósito
// un defecto, y nombra el `fix-*` de provenance.yaml), `frontier` (el legacy lo hace y el DSL no lo
// puede decir: nombra el `F-*`) o `new` (solo existe en el servicio nuevo). Sin la marca, quien
// ejecute los escenarios contra el legacy no sabe si un rojo es un defecto del diseño o la corrección.

export const CHARACTERIZATION_MARKS = ['keep', 'fix', 'frontier', 'new'];
const MARK = /\*\*Caracterizaci[oó]n\*\*:\s*`([a-z]+)`(?:\s*\(`([^`]+)`)?/;
const MARK_LINE = /\*\*Caracterizaci[oó]n\*\*:[^\n]*/;
// Una grabación del legacy citada en la línea de la marca: la ruta o el id de una sonda (R0-034).
const LEGACY_EVIDENCE = /recordings\/|\bR\d+-\d{3}\b/;
// El bloque ejecutable de keel-recover (```keel-flow): sin él, el flujo es solo prosa para el arnés del generado.
const FLOW_FENCE = /^```keel-flow[ \t]*$/m;

export function emptyCharacterization() {
  return { flows: [], unmarked: [], unknown: [], unusedFixes: [] };
}

/** Las marcas de cada flujo, cruzadas con los `fix` y la frontera de provenance.yaml. */
export function readCharacterization(scenariosText, doc) {
  const out = emptyCharacterization();
  if (!scenariosText) return out;
  const fixes = new Set((doc?.fixes ?? []).map((f) => f.id));
  // Un fix que ningún flujo HTTP puede ver lo dice con `noFlow` (por qué y cuál es la otra prueba):
  // no cuenta como cambio sin escenario, y que un flujo lo cite contradice lo declarado.
  const withoutFlow = new Set((doc?.fixes ?? []).filter((f) => f.noFlow).map((f) => f.id));
  const frontier = new Set((doc?.frontier ?? []).map((f) => f.id));
  const cited = new Set();
  for (const block of splitScenarioBlocks(scenariosText)) {
    const id = scenarioIdOf(block);
    const m = MARK.exec(block);
    if (!m || !CHARACTERIZATION_MARKS.includes(m[1])) {
      out.unmarked.push(id);
      continue;
    }
    const [, mark, ref = null] = m;
    // Un fix con noFlow puede tener su escenario en prosa, sin bloque: describe el servicio nuevo para el arnés del
    // generado, y la prueba contra el legacy es la de `noFlow.proof`. Con bloque, lo ejecutaría: contradicción.
    const proseOnly = mark === 'fix' && withoutFlow.has(ref) && !FLOW_FENCE.test(block);
    out.flows.push({ id, mark, ref, ...(proseOnly ? { proseOnly: true } : {}) });
    if (mark === 'fix' && !fixes.has(ref)) out.unknown.push(`${id}: fix ${ref ?? '(sin id)'} no está en ${PROVENANCE_FILE} → fixes`);
    if (mark === 'frontier' && !frontier.has(ref)) out.unknown.push(`${id}: frontier ${ref ?? '(sin id)'} no está en ${PROVENANCE_FILE} → frontier`);
    if (mark === 'fix' && ref) cited.add(ref);
    if (mark === 'fix' && withoutFlow.has(ref) && !proseOnly) out.unknown.push(`${id}: fix ${ref} declara noFlow en ${PROVENANCE_FILE} y este flujo lo ejecuta (trae bloque \`\`\`keel-flow)`);
    // `new` es lo que el legacy no tenía. Si la marca cita lo que el legacy hace (una grabación), el legacy lo tenía de
    // otra manera: es un fix, y la lista de fixes es el backlog del refactor. En la corrida show-ticketing la doble
    // reserva del mismo asiento, medida en R0-034 a R0-041, quedó como `new` y fuera de FIDELITY.md.
    if (mark === 'new' && LEGACY_EVIDENCE.test(MARK_LINE.exec(block)[0])) {
      out.unknown.push(`${id}: es new y su marca cita una grabación del legacy: si el legacy hace otra cosa, es un fix (con noFlow si un flujo HTTP no lo ve); si hace lo mismo, keep`);
    }
  }
  out.unusedFixes = [...fixes].filter((id) => !cited.has(id) && !withoutFlow.has(id));
  return out;
}

/**
 * Cruza la procedencia con el inventario del diseño.
 *
 * - `missing` — elemento del diseño sin fila: nadie dijo de dónde sale.
 * - `inferred` — fila `inferred`: el agente lo supuso; se convierte en hueco declarado o se mide.
 * - `orphans` — fila de un elemento que el diseño ya no declara: la procedencia habla de otro diseño.
 * - `unsourced` — fila `read` sin `archivo:línea`.
 * - `characterization` — flujos sin marca keep/fix/frontier/new, marcas que citan un `fix-*` o un
 *   `F-*` que no existe, y `fix-*` que ningún flujo demuestra (un cambio sin escenario no es un cambio).
 * - `structuralUnsourced` — en un diseño recuperado, entrada de decisions.yaml → structural sin
 *   `origin` (observed, omitted o contradicted; principio 4 del plan).
 * - `errors` — formato, o el mismo elemento en dos filas.
 *
 * @param {{ doc, present, errors }} loaded lo que devolvió loadProvenance
 * @param {object} layers las capas del diseño
 * @param {object|null} decisions decisions.yaml ya validado
 * @param {string|null} scenariosText validation-scenarios.md, para las marcas del paso 4
 */
export function resolveProvenance(loaded, layers, decisions, scenariosText = null) {
  const result = emptyProvenance();
  const structural = decisions?.structural ?? [];
  const recoveredByRegister = structural.some((entry) => entry.origin);
  result.applies = loaded.present || recoveredByRegister;
  if (!result.applies) return result;

  result.errors.push(...loaded.errors);
  if (!loaded.present) result.errors.push(`no hay ${PROVENANCE_FILE} y decisions.yaml → structural habla de lo observado en un legacy (origin)`);
  result.inventory = provenanceInventory(layers);
  result.structuralUnsourced = structural.filter((entry) => !entry.origin).map((entry) => `§${entry.section}${entry.scope ? ` (${entry.scope})` : ''}`);
  if (!loaded.doc) {
    result.missing = loaded.present ? [] : [...result.inventory];
    return result;
  }

  const declared = new Set(result.inventory);
  const seen = new Set();
  for (const row of loaded.doc.elements ?? []) {
    for (const element of row.elements ?? [row.element]) {
      if (seen.has(element)) {
        result.errors.push(`${PROVENANCE_FILE}: ${element} tiene dos filas`);
        continue;
      }
      seen.add(element);
      if (!declared.has(element)) result.orphans.push(element);
      if (row.level === 'inferred') result.inferred.push(element);
      if (row.level === 'read' && !FILE_LINE.test(row.evidence)) result.unsourced.push(element);
    }
  }
  result.missing = result.inventory.filter((element) => !seen.has(element));
  result.characterization = readCharacterization(scenariosText, loaded.doc);
  return result;
}
