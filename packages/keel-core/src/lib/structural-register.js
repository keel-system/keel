// El registro de decisiones estructurales (`structural:` en decisions.yaml), cruzado con el diseño.
//
// El problema (R4.2 de recomendaciones-diseno.md). `/keel-design` cierra cada capa con un bloque de
// decisiones estructurales —qué se eligió de cada entrada § 3.x del catálogo, qué se descartó y por
// qué—, y ese bloque solo existía en el chat. En el YAML no se ve: un `reliability: best-effort`
// decidido y uno asumido se escriben igual. Así que moría con la conversación, y con él lo que
// dependía de él: la clase 16 del análisis de huecos, que audita QUIÉN decidió cada cosa y sin los
// bloques tenía que volver a preguntarlas todas, y `/keel-handoff`, que reconstruía el porqué al
// final entrevistando otra vez al diseñador.
//
// Este módulo es su lector mecánico, y es lo que evita que acabe como la cobertura del análisis de
// huecos, que se persistió dos veces sin que nadie la leyera. Deriva qué secciones aplican —el mismo
// inventario que la clase 16, no una copia— y dice cuáles faltan, cuáles caducaron y cuáles
// contradicen lo que el YAML dice. Lo compone el criterio `structural` de `keel validate --ready`.
//
// Lo que NO puede comprobar: que la pregunta se hiciera. Igual que `CHK-MODEL-IMPLICIT-DEFAULT`
// obliga a escribir el campo y no a preguntarlo, esto obliga a escribir el porqué. Pero un porqué
// escrito se puede leer, citar y discutir; uno reconstruido de memoria, no.

import { GAP_CLASSES } from './gap-classes.js';
import { STRUCTURAL_DEFAULTS } from './structural-defaults.js';
import { versionShape } from './decisions.js';
import { DECISIONS_FILE } from './spec-files.js';

/**
 * Las entradas del catálogo, con el título de su encabezado `### 3.x` en
 * `assets/skills/keel-design/references/structural-decisions.md` (lo ata `test/structural-register.test.js`).
 */
export const STRUCTURAL_SECTIONS = [
  { section: '3.1', title: 'Fiabilidad de publicación' },
  { section: '3.2', title: 'Idempotencia' },
  { section: '3.3', title: 'Caché de una query' },
  { section: '3.4', title: 'Superficie M2M' },
  { section: '3.5', title: 'Política de fallo de una suscripción' },
  { section: '3.6', title: 'Resiliencia de una llamada saliente' },
  { section: '3.7', title: 'Frontera transaccional' },
  { section: '3.8', title: 'Paginación de una colección' },
  { section: '3.9', title: 'Concurrencia sobre la misma entidad' },
  { section: '3.9b', title: 'Rastro de auditoría' },
  { section: '3.10', title: 'Visibilidad de un bucket' },
  { section: '3.11', title: 'Compensación' }
];

const TITLES = new Map(STRUCTURAL_SECTIONS.map((entry) => [entry.section, entry.title]));

/** La frontera transaccional no tiene default en el schema: solo se compara si está escrita. */
const BOUNDARY = { section: '3.7', scope: 'persistence.consistency.transactionalBoundary' };

/** `messaging.publishing.reliability` → el valor en las capas (la primera parte es la capa). */
function valueAt(layers, scope) {
  let node = layers;
  for (const part of scope.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Los campos escalares del catálogo que este diseño tiene, con el valor efectivo: el escrito, o el
 * default del schema si falta (que es lo que aplicará el generador).
 * @returns {Map<string, { section: string, value: unknown }>}
 */
function concreteFields(layers) {
  const fields = new Map();
  for (const entry of STRUCTURAL_DEFAULTS) {
    for (const unit of entry.units(layers)) {
      const written = valueAt(layers, unit.scope);
      fields.set(unit.scope, { section: entry.section, value: written === undefined ? entry.default : written });
    }
  }
  const boundary = valueAt(layers, BOUNDARY.scope);
  if (layers.persistence && boundary !== undefined) fields.set(BOUNDARY.scope, { section: BOUNDARY.section, value: boundary });
  return fields;
}

export function emptyStructural() {
  return { inventory: [], missing: [], stale: [], mismatched: [], orphans: [], recorded: 0, errors: [] };
}

/**
 * Cruza el registro `structural:` de decisions.yaml con las secciones del catálogo que aplican.
 *
 * - `missing` — sección aplicable sin ninguna entrada: nadie escribió qué se decidió.
 * - `stale` — entrada de otra versión (minor o major): la asunción puede haber cambiado, se reafirma.
 * - `mismatched` — `scope` nombra un campo escalar del catálogo y `chosen` no es lo que dice el YAML.
 *   Un registro que contradice al diseño es peor que ninguno: `/keel-handoff` lo contaría como cierto.
 * - `orphans` — entrada de una sección que ya no aplica. Se informa, no cuenta en contra.
 * - `errors` — sección fuera del catálogo, o la misma sección y scope dos veces.
 *
 * @param {object|null} doc decisions.yaml ya validado (null si no existe o no se pudo leer)
 * @param {object} layers las capas del diseño
 * @param {string} serviceVersion service.version del manifiesto
 */
export function resolveStructural(doc, layers, serviceVersion) {
  const result = emptyStructural();
  const applicable = GAP_CLASSES[16].units(layers);
  result.inventory = applicable.map((section) => ({ section, title: TITLES.get(section) }));

  const fields = concreteFields(layers);
  const seen = new Set();
  const covered = new Set();

  for (const entry of doc?.structural ?? []) {
    const label = `§${entry.section}${entry.scope ? ` (${entry.scope})` : ''}`;
    if (!TITLES.has(entry.section)) {
      result.errors.push(`${DECISIONS_FILE}: structural ${label} no es una entrada del catálogo — ver structural-decisions.md § 3`);
      continue;
    }
    const key = `${entry.section}\u0000${entry.scope ?? ''}`;
    if (seen.has(key)) {
      result.errors.push(`${DECISIONS_FILE}: structural ${label} está registrada dos veces`);
      continue;
    }
    seen.add(key);
    result.recorded += 1;

    if (!applicable.includes(entry.section)) {
      result.orphans.push(entry);
      continue;
    }
    covered.add(entry.section);

    if (versionShape(entry.since) !== versionShape(serviceVersion)) result.stale.push(entry);

    const field = entry.scope ? fields.get(entry.scope) : undefined;
    if (field && field.section === entry.section && String(field.value) !== String(entry.chosen).trim()) {
      result.mismatched.push({ ...entry, actual: field.value });
    }
  }

  result.missing = result.inventory.filter((item) => !covered.has(item.section));
  return result;
}
