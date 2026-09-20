// `review.yaml`: el veredicto de la revisión semántica, leído y cruzado con el catálogo.
//
// Espejo de `decisions.js`, y a propósito: son el mismo movimiento aplicado a dos cosas
// distintas. `decisions.yaml` registra lo que el diseño decidió NO declarar; `review.yaml`
// registra lo que alguien MIRÓ y con qué resultado. Comparten la regla de caducidad —que
// se reutiliza, no se recalca— porque el argumento es idéntico: un cambio de minor toca la
// forma del diseño, y entonces lo que se juzgó puede haber dejado de ser cierto.
//
// Lo que aporta y hoy no existe: la COBERTURA. Un id aplicable sin veredicto es un hueco
// que nadie echaba de menos, porque un diseño revisado entero y uno revisado a medias se
// escriben igual — no queda rastro de la revisión en ninguna parte.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { reviewFor } from './reviews.js';
import { REVIEW_FILE } from './spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { REVIEW_FILE } from './spec-files.js';

let validator;

function checkSchema(doc) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('review'), 'utf8')));
  }
  return validator(doc) ? [] : validator.errors;
}

/**
 * Lee `review.yaml` del servicio. Su ausencia NO es un error de carga: a mitad de diseño
 * todavía no existe, y quien decide si su falta bloquea es `resolveReviews` según el modo.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function loadReviews(dir) {
  const file = path.join(dir, REVIEW_FILE);
  if (!fs.existsSync(file)) return { doc: null, errors: [] };

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, errors: [`${REVIEW_FILE}: YAML inválido — ${error.message}`] };
  }
  if (doc == null) return { doc: null, errors: [] };

  const schemaErrors = checkSchema(doc);
  if (schemaErrors.length > 0) {
    return {
      doc: null,
      errors: schemaErrors.map((error) => {
        const where = error.instancePath || '(raíz)';
        return `${REVIEW_FILE}: ${where} ${error.message}`;
      })
    };
  }
  return { doc, errors: [] };
}

// Misma regla que `decisions.js`: caduca con el minor o el major, no con cada patch.
// Reafirmar en cada corrección de una errata enseña a subir el número sin leer, que es el
// hábito que estos archivos existen para romper.
function shape(version) {
  const [major, minor] = String(version ?? '').split('.');
  return `${major}.${minor}`;
}

/**
 * Cruza los ids que le TOCAN al diseño con los veredictos escritos.
 *
 * @param {string[]} applicable ids aplicables, de `applicableReviews(layers)`
 * @param {object|null} doc contenido de review.yaml ya validado
 * @param {string} serviceVersion service.version del manifiesto
 * @returns {{ covered: object[], missing: object[], open: object[], accepted: object[],
 *            stale: boolean, reviewedAt: string|null, orphans: object[], errors: string[] }}
 */
export function resolveReviews(applicable, doc, serviceVersion) {
  const result = {
    covered: [],
    missing: [],
    open: [],
    accepted: [],
    stale: false,
    reviewedAt: doc?.reviewedAt ?? null,
    orphans: [],
    errors: []
  };

  const applicableSet = new Set(applicable ?? []);
  const byId = new Map();

  for (const entry of doc?.findings ?? []) {
    const catalogued = reviewFor(entry.id);
    if (!catalogued) {
      // Un id que el catálogo no tiene no se puede leer ni contar: aceptar un veredicto
      // sobre él sería dar por revisada una pregunta que nadie sabe cuál es.
      result.errors.push(
        `${REVIEW_FILE}: '${entry.id}' no está en el catálogo de revisión — ver docs/design-obligations.md`
      );
      continue;
    }
    if (byId.has(entry.id)) {
      result.errors.push(`${REVIEW_FILE}: '${entry.id}' tiene veredicto dos veces`);
      continue;
    }
    byId.set(entry.id, entry);
  }

  // La revisión entera caduca de una vez, no id a id: se hizo leyendo UN diseño, y cuando
  // ese diseño cambia de forma deja de ser la revisión de nada. Un `reviewedAt` por
  // veredicto invitaría a rehacer solo lo que se tocó, que es justo lo que no vale: un
  // cambio en una capa puede invalidar la lectura de otra.
  if (doc && shape(doc.reviewedAt) !== shape(serviceVersion)) result.stale = true;

  for (const id of applicable ?? []) {
    const entry = byId.get(id);
    const catalogued = reviewFor(id);
    if (!entry) {
      result.missing.push({ id, title: catalogued?.title, severity: catalogued?.severity });
      continue;
    }
    const item = { id, title: catalogued?.title, severity: catalogued?.severity, ...entry };
    result.covered.push(item);
    if (entry.verdict === 'open') result.open.push(item);
    if (entry.verdict === 'accepted') result.accepted.push(item);
  }

  for (const [id, entry] of byId) {
    // Un veredicto sobre algo que ya no aplica describe una pregunta que este diseño no se
    // hace. No es un error —la capa pudo desaparecer, y eso es progreso— pero sí basura
    // que confunde al siguiente lector, igual que un derivado huérfano.
    if (!applicableSet.has(id)) result.orphans.push(entry);
  }

  return result;
}
