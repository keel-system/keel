import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { schemaPathFor } from './assets.js';
import { obligationFor } from './obligations.js';
import { checkFor } from './checks.js';
import { DECISIONS_FILE, REVIEW_FILE } from './spec-files.js';

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

  // `coverage` se mudó a `review.yaml`. Como el schema cierra `additionalProperties`, un
  // archivo anterior a la mudanza falla con un Ajv opaco («must NOT have additional
  // properties») que no dice ni qué propiedad ni a dónde se fue. Se contesta antes.
  if (Object.hasOwn(doc, 'coverage')) {
    return {
      doc: null,
      errors: [
        `${DECISIONS_FILE}: 'coverage' se mudó a ${REVIEW_FILE} — «qué se miró» pertenece al archivo de la ` +
          `revisión, no al de lo que se aceptó. Mueve el bloque tal cual; el formato no cambia`
      ]
    };
  }

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
export function versionShape(version) {
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
  // Las entradas CHK-* son avisos aceptados, y las resuelve `resolveUndecided`.
  const entries = (doc?.decisions ?? []).filter((entry) => !isCheckId(entry.id));
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
    if (versionShape(entry.since) !== versionShape(serviceVersion)) {
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

const isCheckId = (id) => String(id ?? '').startsWith('CHK-');

/**
 * Cruza los avisos que son DECISIONES NO TOMADAS (`nature: 'undecided'` en checks.js) con las
 * aceptaciones CHK-* de decisions.yaml.
 *
 * Es el mismo movimiento que las obligaciones, aplicado a los avisos: un `POST` sin
 * `successStatus` no es un error del diseño, es una pregunta sin contestar, y hasta aquí no
 * había forma de contestarla por escrito — solo de dejar el aviso ahí, que es lo mismo que
 * dejársela al generador. La diferencia con una obligación está en quién la mira: esto no
 * bloquea la generación (`validateService().ok` no lo cuenta), bloquea `keel validate --ready`.
 *
 * La clave es `id` + `scope`, y el scope es por UNIDAD (`api.endpoints.createOrder`): aceptar
 * una decisión sobre un endpoint no la acepta sobre los demás.
 *
 * @param {Array<{id: string, scope?: string, message: string}>} findings los de crossrefs
 * @param {object|null} doc contenido de decisions.yaml ya validado
 * @param {string} serviceVersion service.version del manifiesto
 * @returns {{ open: object[], accepted: object[], stale: object[], orphans: object[], errors: string[] }}
 */
export function resolveUndecided(findings, doc, serviceVersion) {
  const result = { open: [], accepted: [], stale: [], orphans: [], errors: [] };
  const byKey = new Map();

  for (const entry of (doc?.decisions ?? []).filter((item) => isCheckId(item.id))) {
    const catalogued = checkFor(entry.id);
    if (!catalogued) {
      result.errors.push(`${DECISIONS_FILE}: '${entry.id}' no está en el catálogo de comprobaciones (checks.js)`);
      continue;
    }
    if (catalogued.nature !== 'undecided') {
      // Una incoherencia no es una pregunta: aceptarla sería dejar el diseño roto con permiso.
      result.errors.push(
        `${DECISIONS_FILE}: '${entry.id}' (${catalogued.title}) es una incoherencia: se corrige en el diseño, no se acepta`
      );
      continue;
    }
    if (catalogued.waivable === false) {
      result.errors.push(
        `${DECISIONS_FILE}: '${entry.id}' (${catalogued.title}) no admite aceptación: ahí no hay default seguro, ` +
          `así que aceptarla sería dejársela al generador. Decídela en el diseño — ${catalogued.closes}`
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
  for (const finding of findings ?? []) {
    if (checkFor(finding.id)?.nature !== 'undecided') continue;
    const item = { id: finding.id, scope: finding.scope, message: finding.message, waivable: checkFor(finding.id).waivable !== false };
    const key = keyOf(item.id, item.scope);
    raisedKeys.add(key);
    const entry = byKey.get(key);
    if (!entry) {
      result.open.push(item);
      continue;
    }
    if (versionShape(entry.since) !== versionShape(serviceVersion)) {
      result.stale.push({ ...item, since: entry.since, reason: entry.reason });
      continue;
    }
    result.accepted.push({ ...item, since: entry.since, reason: entry.reason });
  }

  for (const [key, entry] of byKey) {
    if (!raisedKeys.has(key)) result.orphans.push(entry);
  }
  return result;
}

/**
 * Cruza los avisos que son INCOHERENCIAS (`nature: 'incoherence'` en checks.js) con los falsos
 * positivos que decisions.yaml declara (`falsePositives`).
 *
 * Una incoherencia no se acepta: se corrige. Pero los detectores leen prosa y heurísticas, y un
 * detector se equivoca; sin salida, un falso positivo bloquearía `keel validate --ready` hasta que
 * alguien arreglase el detector. Esta es esa salida, y no es una aceptación: declara que el
 * DETECTOR se equivocó, con el motivo, y cada entrada es deuda de keel-core. Hasta el
 * 2026-09-28 las incoherencias no contaban en ninguna puerta, y un diseño en 10/10 cruzó a
 * generación con tres a la vista que lo dejaron en rojo (`asset-vault`, corrida R8).
 *
 * La clave es `id` + `match`: el aviso casa si su mensaje contiene `match` (la unidad que nombra,
 * `roles.vault-custodian`, `FL-AST-003`). Caduca con el minor, como las aceptaciones.
 *
 * @param {Array<{id: string, severity: string, message: string}>} findings los de crossrefs
 * @param {object|null} doc contenido de decisions.yaml ya validado
 * @param {string} serviceVersion service.version del manifiesto
 * @returns {{ open: object[], excused: object[], stale: object[], orphans: object[], errors: string[] }}
 */
export function resolveIncoherences(findings, doc, serviceVersion) {
  const result = { open: [], excused: [], stale: [], orphans: [], errors: [] };
  const entries = [];
  for (const entry of doc?.falsePositives ?? []) {
    const catalogued = checkFor(entry.id);
    if (!catalogued) {
      result.errors.push(`${DECISIONS_FILE}: falsePositives '${entry.id}' no está en el catálogo de comprobaciones (checks.js)`);
      continue;
    }
    if (catalogued.nature !== 'incoherence' || catalogued.severity !== 'warning') {
      result.errors.push(
        `${DECISIONS_FILE}: falsePositives '${entry.id}' no es un aviso de incoherencia — ` +
          (catalogued.nature === 'undecided' ? `es una decisión: se acepta en 'decisions' con su scope` : 'un error no admite excusa')
      );
      continue;
    }
    entries.push({ entry, used: false });
  }

  for (const finding of findings ?? []) {
    const catalogued = checkFor(finding.id);
    if (finding.severity !== 'warning' || catalogued?.nature !== 'incoherence') continue;
    const item = { id: finding.id, message: finding.message };
    const hit = entries.find(({ entry }) => entry.id === finding.id && finding.message.includes(entry.match));
    if (!hit) {
      result.open.push(item);
      continue;
    }
    hit.used = true;
    const excuse = { ...item, match: hit.entry.match, since: hit.entry.since, reason: hit.entry.reason };
    if (versionShape(hit.entry.since) !== versionShape(serviceVersion)) result.stale.push(excuse);
    else result.excused.push(excuse);
  }

  for (const { entry, used } of entries) if (!used) result.orphans.push(entry);
  return result;
}

/**
 * Los avisos tal como se enseñan al diseñador: sin los que decisions.yaml ya acepta, y con la
 * pista que cierra cada decisión abierta o caducada.
 *
 * Es fuente única para `keel validate` y para los generadores (`build`, `check`). Mientras
 * cada uno los imprimía a su manera, `build` enseñaba en amarillo decisiones que `keel
 * validate` daba por contestadas, y un aviso que se repite después de contestarlo enseña a no
 * leer los avisos.
 *
 * @param {string[]} warnings los de validateService
 * @param {{ open: object[], accepted: object[], stale: object[] }} undecided los de resolveUndecided
 * @param {{ open: object[], excused: object[], stale: object[] }} [incoherences] los de resolveIncoherences
 * @returns {{ shown: Array<{ message: string, hint: string|null }>, accepted: number, excused: number }}
 */
export function classifyWarnings(warnings, undecided, incoherences = null) {
  const byMessage = new Map();
  for (const item of incoherences?.excused ?? []) byMessage.set(item.message, { item, state: 'excused' });
  for (const item of incoherences?.stale ?? []) byMessage.set(item.message, { item, state: 'excused-stale' });
  for (const item of incoherences?.open ?? []) byMessage.set(item.message, { item, state: 'incoherent' });
  for (const item of undecided?.accepted ?? []) byMessage.set(item.message, { item, state: 'accepted' });
  for (const item of undecided?.stale ?? []) byMessage.set(item.message, { item, state: 'stale' });
  for (const item of undecided?.open ?? []) byMessage.set(item.message, { item, state: 'open' });

  const shown = [];
  let accepted = 0;
  let excused = 0;
  for (const message of warnings ?? []) {
    const decision = byMessage.get(message);
    if (decision?.state === 'accepted') {
      accepted += 1;
      continue;
    }
    if (decision?.state === 'excused') {
      excused += 1;
      continue;
    }
    shown.push({ message, hint: decision ? hintFor(decision) : null });
  }
  return { shown, accepted, excused };
}

function hintFor({ item, state }) {
  if (state === 'incoherent') {
    return `incoherencia (${item.id}): corrígela en el diseño; si el que se equivoca es el detector, decláralo en ${DECISIONS_FILE} → falsePositives`;
  }
  if (state === 'excused-stale') return `falso positivo declarado en v${item.since}: el diseño cambió, reafírmalo en ${DECISIONS_FILE}`;
  if (state === 'stale') return `aceptada en v${item.since}: el diseño cambió, reafírmala en ${DECISIONS_FILE}`;
  if (item.waivable) {
    return `decisión sin tomar: ciérrala en el DSL o acéptala en ${DECISIONS_FILE} — id: ${item.id}, scope: ${item.scope}`;
  }
  return `decisión sin tomar (${item.id}): no admite aceptación, decídela en el DSL`;
}
