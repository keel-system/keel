// Qué cambió entre dos versiones de un mismo diseño.
//
// Lo necesita quien ya generó un servidor desde la versión anterior: sin esto, volver a
// entrar al proyecto con el diseño nuevo es repetir la generación entera a ciegas —el
// agente de código no sabe qué operación cambió, el de pruebas vuelve a traducir todos
// los escenarios y el endpoint de una operación que el diseño retiró sigue vivo—.
//
// Agnóstico del generador a propósito: compara DISEÑOS, no código. Qué hacer con el
// delta es cosa de cada generador.
//
// Puro y determinista (sin consola, sin escrituras, sin timestamps): dos llamadas sobre
// los mismos directorios dan el mismo objeto, igual que `design-index.js`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadService } from './loader.js';
import { SCENARIOS_FILE } from './spec-files.js';
import { splitScenarioBlocks, scenarioIdOf, scenarioFamilyOf, scenarioBody } from './scenario-blocks.js';

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byName = (a, b) => a.localeCompare(b);

/** Serialización estable: el orden de las claves del YAML no es un cambio de diseño. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isMap(value)) {
    return `{${Object.keys(value)
      .sort(byName)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameValue = (a, b) => canonical(a) === canonical(b);

/**
 * Las secciones de una capa que cambiaron. Una sección que es un mapa (`operations`,
 * `entities`, `endpoints`…) se compara clave a clave, porque lo que le interesa a quien
 * genera es QUÉ operación o QUÉ entidad; una que no lo es (una lista, un escalar) se
 * compara entera.
 */
function diffLayer(layer, prevDoc, nextDoc) {
  const prev = isMap(prevDoc) ? prevDoc : {};
  const next = isMap(nextDoc) ? nextDoc : {};
  const sections = [];

  for (const section of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort(byName)) {
    const before = prev[section];
    const after = next[section];
    if (sameValue(before, after)) continue;

    if ((isMap(before) || before === undefined) && (isMap(after) || after === undefined)) {
      const a = before ?? {};
      const b = after ?? {};
      sections.push({
        layer,
        section,
        added: Object.keys(b).filter((key) => !(key in a)).sort(byName),
        removed: Object.keys(a).filter((key) => !(key in b)).sort(byName),
        changed: Object.keys(b).filter((key) => key in a && !sameValue(a[key], b[key])).sort(byName)
      });
    } else {
      sections.push({ layer, section, replaced: true });
    }
  }
  return sections;
}

function readScenarios(dir) {
  const file = path.join(dir, SCENARIOS_FILE);
  if (!fs.existsSync(file)) return new Map();
  const byId = new Map();
  for (const block of splitScenarioBlocks(fs.readFileSync(file, 'utf8'))) {
    const id = scenarioIdOf(block);
    // Un id repetido es un error del documento, no del delta: se concatena para que
    // cualquier cambio en cualquiera de las dos copias siga viéndose.
    const body = scenarioBody(block);
    byId.set(id, { family: scenarioFamilyOf(block), body: byId.has(id) ? `${byId.get(id).body}\n${body}` : body });
  }
  return byId;
}

const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

function diffScenarios(prevDir, nextDir) {
  const prev = readScenarios(prevDir);
  const next = readScenarios(nextDir);
  const added = [...next.keys()].filter((id) => !prev.has(id)).sort(byName);
  const removed = [...prev.keys()].filter((id) => !next.has(id)).sort(byName);
  const changed = [...next.keys()]
    .filter((id) => prev.has(id) && hashOf(prev.get(id).body) !== hashOf(next.get(id).body))
    .sort(byName);
  const familyOf = (id) => (next.get(id) ?? prev.get(id)).family;
  const families = [...new Set([...added, ...removed, ...changed].map(familyOf))].sort(byName);
  return { added, removed, changed, families };
}

/**
 * El delta entre el diseño de `prevDir` y el de `nextDir` (dos directorios de servicio).
 *
 * Devuelve `{ error }` si alguno no se puede cargar, o:
 *
 *   {
 *     from, to,                      // service.version de cada lado
 *     layers:    { added, removed }, // capas declaradas
 *     sections:  [{ layer, section, added, removed, changed } | { layer, section, replaced: true }],
 *     scenarios: { added, removed, changed, families },
 *     empty                          // nada de lo anterior cambió
 *   }
 *
 * Una capa añadida aparece también en `sections` con todo `added` —y una quitada con
 * todo `removed`—: quien lea el delta no tiene que ir a buscar qué traía.
 */
export function diffDesigns(prevDir, nextDir) {
  const prev = loadService(prevDir);
  const next = loadService(nextDir);
  if (!prev.manifest || !next.manifest) {
    const errors = [...(prev.errors ?? []), ...(next.errors ?? [])];
    return { error: errors.join('; ') || 'no se pudo cargar el diseño' };
  }

  const prevLayers = Object.keys(prev.layers ?? {});
  const nextLayers = Object.keys(next.layers ?? {});
  const layers = {
    added: nextLayers.filter((layer) => !prevLayers.includes(layer)).sort(byName),
    removed: prevLayers.filter((layer) => !nextLayers.includes(layer)).sort(byName)
  };

  const sections = [...new Set([...prevLayers, ...nextLayers])]
    .sort(byName)
    .flatMap((layer) => diffLayer(layer, prev.layers[layer], next.layers[layer]));

  const scenarios = diffScenarios(prevDir, nextDir);
  const from = prev.manifest.service?.version ?? null;
  const to = next.manifest.service?.version ?? null;

  const empty =
    from === to &&
    layers.added.length === 0 &&
    layers.removed.length === 0 &&
    sections.length === 0 &&
    scenarios.added.length + scenarios.removed.length + scenarios.changed.length === 0;

  return { from, to, layers, sections, scenarios, empty };
}
