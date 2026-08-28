import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { obligationFor } from './obligations.js';
import { DECISIONS_FILE } from './spec-files.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export { DECISIONS_FILE } from './spec-files.js';

let validator;

function checkSchema(doc) {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor('decisions'), 'utf8')));
  }
  return validator(doc) ? [] : validator.errors;
}

/**
 * Lee `decisions.yaml` del servicio. Su ausencia NO es un error: un diseño que cierra todas sus
 * obligaciones en el DSL no necesita el archivo, y a mitad de diseño todavía no existe.
 *
 * @returns {{ doc: object|null, errors: string[] }}
 */
export function loadDecisions(dir) {
  const file = path.join(dir, DECISIONS_FILE);
  if (!fs.existsSync(file)) return { doc: null, errors: [] };

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, errors: [`${DECISIONS_FILE}: YAML inválido — ${error.message}`] };
  }
  if (doc == null) return { doc: null, errors: [] };

  const schemaErrors = checkSchema(doc);
  if (schemaErrors.length > 0) {
    return {
      doc: null,
      errors: schemaErrors.map((error) => {
        const where = error.instancePath || '(raíz)';
        return `${DECISIONS_FILE}: ${where} ${error.message}`;
      })
    };
  }
  return { doc, errors: [] };
}

// La aceptación caduca al cambiar el minor o el major, no con cada patch. El criterio no es de
// rigor sino de a quién le sirve: reafirmar en cada corrección de una errata enseña a subir el
// número sin leer, que es exactamente el hábito que este archivo existe para romper. Un cambio
// de minor sí toca la forma del diseño, y entonces la asunción que sostenía la aceptación puede
// haber dejado de ser cierta.
function shape(version) {
  const [major, minor] = String(version ?? '').split('.');
  return `${major}.${minor}`;
}

function keyOf(id, scope) {
  return `${id}\u0000${scope}`;
}

/**
 * Cruza las obligaciones que el diseño levanta con el registro de decisiones.
 *
 * @param {Array<{id: string, scope: string, message: string}>} raised lo que emitió crossrefs
 * @param {object|null} doc contenido de decisions.yaml ya validado
 * @param {string} serviceVersion service.version del manifiesto
 * @returns {{ open: object[], accepted: object[], stale: object[], orphans: object[], errors: string[] }}
 */
export function resolveObligations(raised, doc, serviceVersion) {
  const result = { open: [], accepted: [], stale: [], orphans: [], errors: [] };
  const entries = doc?.decisions ?? [];
  const byKey = new Map();

  for (const entry of entries) {
    const catalogued = obligationFor(entry.id);
    if (!catalogued) {
      // Un id que el catálogo no tiene no se puede leer ni contar: dejarlo pasar sería aceptar
      // una obligación que nadie sabe cuál es.
      result.errors.push(
        `${DECISIONS_FILE}: '${entry.id}' no está en el catálogo de obligaciones — ver docs/design-obligations.md`
      );
      continue;
    }
    if (catalogued.waivable === false) {
      result.errors.push(
        `${DECISIONS_FILE}: '${entry.id}' (${catalogued.title}) no admite aceptación: ahí no hay default seguro, ` +
          `así que aceptarla sería dejársela al generador. Ciérrala en el diseño`
      );
      continue;
    }
    const key = keyOf(entry.id, entry.scope);
    if (byKey.has(key)) {
      result.errors.push(`${DECISIONS_FILE}: '${entry.id}' sobre '${entry.scope}' está declarada dos veces`);
      continue;
    }
    byKey.set(key, entry);
  }

  const raisedKeys = new Set();
  for (const item of raised ?? []) {
    const key = keyOf(item.id, item.scope);
    raisedKeys.add(key);
    const entry = byKey.get(key);
    if (!entry) {
      result.open.push(item);
      continue;
    }
    if (shape(entry.since) !== shape(serviceVersion)) {
      result.stale.push({ ...item, since: entry.since, reason: entry.reason });
      continue;
    }
    result.accepted.push({ ...item, since: entry.since, reason: entry.reason });
  }

  for (const [key, entry] of byKey) {
    // Una decisión sobre algo que el diseño ya no levanta describe un hueco que no existe. No es
    // un error —cerrarlo en el DSL es justo lo que se quería—, pero sí basura que confunde al
    // siguiente lector, igual que un derivado huérfano.
    if (!raisedKeys.has(key)) result.orphans.push(entry);
  }

  return result;
}
