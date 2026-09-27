// `gaps.yaml`: el análisis de huecos, leído y cruzado con el inventario que deriva la máquina.
//
// Espejo de `review-state.js`, y a propósito: es el mismo movimiento aplicado a otra pregunta. La
// revisión juzga la calidad de lo DECLARADO; el análisis de huecos busca lo que el diseño NO dice
// (`gap-analysis.md`). Comparten la caducidad por minor porque el argumento es idéntico: un cambio de
// forma puede abrir huecos donde el barrido anterior no encontró nada.
//
// Lo que aporta: la COBERTURA exigible. Qué clases aplican y qué unidades tiene cada una lo decide
// `gap-classes.js`; aquí se comprueba que el barrido las nombre todas. Una unidad que falta es una
// unidad que nadie recorrió, y sin esta comprobación «recorrí las consultas» valía igual con una
// query de cuatro.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { gapClassFor } from './gap-classes.js';
import { GAPS_FILE } from './spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { GAPS_FILE } from './spec-files.js';

let validator;

function checkSchema(doc) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('gaps'), 'utf8')));
  }
  return validator(doc) ? [] : validator.errors;
}

/**
 * Lee `gaps.yaml` del servicio. Su ausencia NO es un error de carga: a mitad de diseño todavía no
 * existe, y quien decide si su falta cuenta es el criterio `gaps` de `keel validate --ready`.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function loadGaps(dir) {
  const file = path.join(dir, GAPS_FILE);
  if (!fs.existsSync(file)) return { doc: null, errors: [] };

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, errors: [`${GAPS_FILE}: YAML inválido — ${error.message}`] };
  }
  if (doc == null) return { doc: null, errors: [] };

  const schemaErrors = checkSchema(doc);
  if (schemaErrors.length > 0) {
    return {
      doc: null,
      errors: schemaErrors.map((error) => `${GAPS_FILE}: ${error.instancePath || '(raíz)'} ${error.message}`)
    };
  }
  return { doc, errors: [] };
}

// Misma regla que review.yaml y decisions.yaml: caduca con el minor o el major, no con cada patch.
function shape(version) {
  const [major, minor] = String(version ?? '').split('.');
  return `${major}.${minor}`;
}

/** El agente de contexto limpio que hace el barrido de huecos; ver REVIEW_AGENT en review-state.js. */
export const GAPS_AGENT = 'keel-gap-sweep';

export function emptyGaps() {
  return {
    inventory: [],
    missingClasses: [],
    missingUnits: [],
    open: [],
    accepted: [],
    stale: false,
    reviewedAt: null,
    reviewedBy: null,
    orphans: [],
    errors: []
  };
}

/**
 * Cruza el inventario del diseño con el barrido escrito.
 *
 * @param {Array<{class: number, title: string, units: string[]}>} inventory de `gapInventory(layers)`
 * @param {object|null} doc contenido de gaps.yaml ya validado
 * @param {string} serviceVersion service.version del manifiesto
 */
export function resolveGaps(inventory, doc, serviceVersion) {
  const result = {
    ...emptyGaps(),
    inventory: inventory ?? [],
    reviewedAt: doc?.reviewedAt ?? null,
    reviewedBy: doc?.reviewedBy ?? null
  };
  const applicable = new Map((inventory ?? []).map((entry) => [entry.class, entry]));

  const coverage = new Map();
  for (const entry of doc?.coverage ?? []) {
    if (coverage.has(entry.class)) {
      result.errors.push(`${GAPS_FILE}: la clase ${entry.class} aparece dos veces en coverage`);
      continue;
    }
    coverage.set(entry.class, entry);
  }

  for (const finding of doc?.findings ?? []) {
    const catalogued = gapClassFor(finding.class);
    const where = `${GAPS_FILE}: hallazgo de la clase ${finding.class} en '${finding.unit}'`;
    if (finding.state === 'accepted' && catalogued?.acceptable === false) {
      // No hay default seguro: «aceptado» significaría «que lo decida el generador», que es justo lo
      // que el análisis existe para impedir (gap-analysis.md § Cierre).
      result.errors.push(
        `${where}: la clase ${finding.class} (${catalogued.title}) no admite 'accepted' — o se decide en el diseño, o queda 'open'`
      );
    }
    const covered = coverage.get(finding.class);
    if (!covered) {
      result.errors.push(`${where}: la clase no está en coverage — un hallazgo sale de un barrido, y ese barrido no consta`);
    } else if (covered.result === 'clean') {
      result.errors.push(`${where}: coverage dice que la clase salió limpia`);
    }
    if (finding.state === 'open') result.open.push(finding);
    if (finding.state === 'accepted') result.accepted.push(finding);
  }

  // Caduca entero, no clase a clase: una capa nueva puede abrir huecos en clases que otra recorrió.
  if (doc && shape(doc.reviewedAt) !== shape(serviceVersion)) result.stale = true;

  for (const entry of inventory ?? []) {
    const covered = coverage.get(entry.class);
    if (!covered) {
      result.missingClasses.push({ class: entry.class, title: entry.title, units: entry.units });
      continue;
    }
    const walked = new Set(covered.units);
    for (const unit of entry.units) {
      if (!walked.has(unit)) result.missingUnits.push({ class: entry.class, title: entry.title, unit });
    }
    // Unidades escritas que el diseño ya no tiene: una operación borrada, un bucket renombrado. No
    // es un error —el diseño avanzó— pero confunde al siguiente lector, igual que un derivado huérfano.
    const known = new Set(entry.units);
    const gone = covered.units.filter((unit) => !known.has(unit));
    if (gone.length > 0) result.orphans.push({ class: entry.class, units: gone });
  }
  for (const [number] of coverage) {
    if (!applicable.has(number)) result.orphans.push({ class: number, units: coverage.get(number).units });
  }

  return result;
}

/** Cuántas unidades del inventario quedan sin recorrer, contando las de las clases que faltan. */
export function unwalkedCount(gaps) {
  return gaps.missingUnits.length + gaps.missingClasses.reduce((total, entry) => total + entry.units.length, 0);
}
