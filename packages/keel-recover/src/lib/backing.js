// El respaldo de la procedencia: que lo que `provenance.yaml` dice que se midió o se preguntó tenga detrás algo que exista.
//
// El criterio `provenance` de keel-core mira el diseño y nada más: que cada elemento tenga fila, que ninguna sea
// `inferred` y que una `read` cite archivo:línea. No puede ver el legacy, así que una fila `asked` podía decir «lo decidió
// el humano» sin que el humano lo hubiera decidido, y una `measured` citar una grabación que no existe. Pasó en la
// corrida de control de shop-api (2026-10-23): el diseñador tomó decisiones que no estaban en las respuestas, las llamó
// «extrapolaciones» en su reporte —que no queda en disco— y nadie las confirmó. Aquí, que ve el diseño y el legacy:
//   · `asked` cita el id de una pregunta CONTESTADA de questions.yaml, o el registro del cierre (gaps.yaml,
//     decisions.yaml, «gaps clase N»). Una decisión que no está en ninguna es una pregunta nueva, no una fila `asked`;
//   · `measured` cita al menos una grabación que existe: una ruta bajo recordings/, el id de una sonda (R0-012) que
//     tenga su grabación, o un artefacto del legacy que lo mide (surface.yaml, runtime.yaml, environment.yaml, sandbox/…).
//
// Aplica a las recuperaciones hechas con la herramienta, que son las que tienen questions.yaml (el diseñador lo escribe
// siempre: es donde deja lo que solo puede decidir el humano). Una recuperación anterior, hecha a mano (conduit), no.
// Medido sobre shop-api: 50 de 52 filas `asked` citaban una pregunta contestada, las 2 restantes el cierre, y 95 de 95
// `measured` una grabación existente; la regla separa lo honesto de lo no respaldado sin tocar lo bueno.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const CLOSING = /gaps\.yaml|decisions\.yaml|gaps clase \d+/i;
const RECORDING_PATH = /recordings\/[^\s,;)"']+/g;
const PROBE_ID = /\bR\d+-\d+\b/g;
const LEGACY_ARTIFACT = /\b(?:surface|runtime|environment)\.yaml\b|\bsandbox\/[^\s,;)"']+/g;

/** Todas las grabaciones por id de sonda (`R0-012` → recordings/round-0/R0-012.json), para resolver un id suelto. */
function recordedProbes(legacyDir) {
  const ids = new Set();
  const root = path.join(legacyDir, 'recordings');
  if (!fs.existsSync(root)) return ids;
  for (const round of fs.readdirSync(root)) {
    const dir = path.join(root, round);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) if (file.endsWith('.json')) ids.add(file.slice(0, -'.json'.length));
  }
  return ids;
}

/** ¿Cita la evidencia de una fila `measured` alguna grabación que exista? */
function measuredBacked(evidence, legacyDir, probes) {
  // Lo medido del entorno (el motor y su versión, la superficie) tiene su respaldo en los artefactos del legacy.
  for (const [ref] of evidence.matchAll(LEGACY_ARTIFACT)) if (fs.existsSync(path.join(legacyDir, ref.replace(/[.:]+$/, '')))) return true;
  for (const [ref] of evidence.matchAll(RECORDING_PATH)) {
    const file = path.join(legacyDir, ref.replace(/[.:]+$/, ''));
    if (fs.existsSync(file) || fs.existsSync(`${file}.json`)) return true;
  }
  for (const [id] of evidence.matchAll(PROBE_ID)) if (probes.has(id)) return true;
  return false;
}

/**
 * Las filas de la procedencia de `specDir` sin respaldo en `legacyDir`, con las preguntas ya leídas.
 * @returns {{ applies: boolean, asked: { element, evidence }[], measured: { element, evidence }[] }}
 */
export function provenanceBacking(specDir, legacyDir, questions) {
  const none = { applies: false, asked: [], measured: [] };
  const file = path.join(specDir, 'provenance.yaml');
  if (!fs.existsSync(path.join(legacyDir, 'questions.yaml')) || !fs.existsSync(file)) return none;
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return none; // el YAML roto lo dice el criterio provenance de keel-core
  }
  const answered = (questions ?? []).filter((q) => q.answer != null).map((q) => q.id);
  const cites = (evidence, id) => new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(evidence);
  const probes = recordedProbes(legacyDir);
  const out = { applies: true, asked: [], measured: [] };
  for (const row of doc?.elements ?? []) {
    const element = row.element ?? (row.elements ?? []).join(', ');
    const evidence = String(row.evidence ?? '');
    if (row.level === 'asked' && !answered.some((id) => cites(evidence, id)) && !CLOSING.test(evidence)) out.asked.push({ element, evidence });
    if (row.level === 'measured' && !measuredBacked(evidence, legacyDir, probes)) out.measured.push({ element, evidence });
  }
  return out;
}
