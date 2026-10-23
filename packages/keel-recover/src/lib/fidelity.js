// `legacy/<servicio>/FIDELITY.md`: el informe de fidelidad del diseño recuperado (paso 5), en los
// dos ejes del plan (§ 0). Corrección: los escenarios contra el legacy en marcha. Completitud: la
// cobertura del legacy bajo las sondas, las rutas que el diseño no recoge y lo no observado. Y la
// procedencia, las diferencias declaradas y la frontera del DSL.
//
// Lo escribe `keel-recover characterize` a partir de lo que ya está escrito (el sello, provenance.yaml,
// la serie de cobertura, surface.yaml, unobserved.yaml, contract-map.yaml): no juzga nada nuevo. Es
// determinista, sin fechas: la fecha está en el historial de git, y un informe que cambia cada vez que
// se escribe no se puede comparar.

import { EXECUTED_MARKS, PROVENANCE_LEVELS } from 'keel-core';

const MEANING = {
  keep: 'el legacy hace lo que el diseño afirma',
  fix: 'el defecto que el diseño corrige sigue en el legacy: el escenario describe un cambio real',
  frontier: 'el legacy lo hace y el DSL no lo puede declarar: contra el servicio nuevo se informa sin contar',
};

const pct = (covered, total) => (total ? `${((100 * covered) / total).toFixed(1).replace('.', ',')} %` : '—');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** `/api/profiles/:username/` y `/api/profiles/{username}` son la misma ruta. */
export const routeKey = (method, path) =>
  `${String(method).toUpperCase()} ${String(path).replace(/:[^/]+|\{[^}]+\}/g, '{}').replace(/(.)\/$/, '$1')}`;

/** Las rutas del legacy que ninguna operación del mapa traduce: superficie que el diseño no recoge. */
export function routesWithoutOperation(surface, map) {
  const routes = surface?.http?.routes;
  if (!Array.isArray(routes)) return null;
  const mapped = new Set(Object.values(map?.legacy?.operations ?? {}).map((m) => routeKey(m.method, m.path)));
  return routes.filter((r) => r.method !== '*' && !mapped.has(routeKey(r.method, r.path))).map((r) => `${String(r.method).toUpperCase()} ${r.path}`);
}

/** unobserved.yaml no tiene forma fija: cada lista de primer nivel, con lo que traiga cada entrada. */
export function unobservedItems(doc) {
  const out = [];
  for (const [section, list] of Object.entries(doc ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object') {
        const head = item.id ?? item.code ?? item.what ?? '';
        const text = [item.id && item.what, item.why ?? item.reason].filter(Boolean).join(' — ');
        out.push({ section, head, text });
      } else out.push({ section, head: String(item), text: '' });
    }
  }
  return out;
}

/** Cuántos elementos hay en cada nivel (una fila con `elements` cuenta cada uno). */
export function levelCounts(provenance) {
  const counts = Object.fromEntries(PROVENANCE_LEVELS.map((l) => [l, 0]));
  for (const row of provenance?.elements ?? []) counts[row.level] = (counts[row.level] ?? 0) + (row.elements?.length ?? 1);
  return counts;
}

/**
 * @param {object} input
 * @param {string} input.service        nombre del diseño (specs/<servicio>)
 * @param {{name, commit?}} input.legacy
 * @param {object[]} input.records      lo que devolvió runCharacterization
 * @param {number} input.newFlows       flujos `new` (no se ejecutan contra el legacy)
 * @param {object|null} input.provenance provenance.yaml
 * @param {object|null} input.coverage  la última entrada de recordings/coverage.json
 * @param {object|null} input.surface   surface.yaml
 * @param {object|null} input.unobserved unobserved.yaml
 * @param {object} input.map            contract-map.yaml
 */
export function renderFidelity({ service, legacy, records, newFlows = 0, provenance = null, coverage = null, surface = null, unobserved = null, map }) {
  const out = [];
  const add = (...lines) => out.push(...lines);
  add(
    `# Fidelidad del diseño recuperado: ${service} ← ${legacy.name}${legacy.commit ? ` @ ${legacy.commit}` : ''}`,
    '',
    `> Lo escribe \`keel-recover characterize\` (paso 5 de keel-recover) desde el sello \`specs/${service}/characterized.yaml\`,`,
    '> `provenance.yaml`, la serie de cobertura, `surface.yaml`, `unobserved.yaml` y `contract-map.yaml`. No se edita a',
    '> mano: se vuelve a escribir con cada ejecución.',
    '',
    '## Corrección: los escenarios contra el legacy en marcha',
    '',
    '| Marca | En verde | Qué significa |',
    '|---|---|---|'
  );
  for (const mark of EXECUTED_MARKS) {
    const of = records.filter((r) => r.mark === mark);
    if (of.length === 0 && mark !== 'keep') continue;
    add(`| \`${mark}\` | **${of.filter((r) => r.ok).length} / ${of.length}** | ${MEANING[mark]} |`);
  }
  add(`| \`new\` | no aplica | ${newFlows} flujo(s) que solo existen en el servicio nuevo |`, '');
  const red = records.filter((r) => !r.ok);
  if (red.length) {
    add('**En rojo.** Un `keep` en rojo es el diseño diciendo algo que el legacy no hace: se corrige el diseño, no el escenario.', '');
    for (const r of red) add(`- \`${r.id}\` (${r.mark}): ${cell(r.failures[0])}${r.failures.length > 1 ? ` (y ${r.failures.length - 1} más)` : ''}`);
    add('');
  }
  add(
    'Un `keep` en verde demuestra que el escenario describe al legacy, no que el diseño lo cubra entero: para eso',
    'está la completitud.',
    '',
    '## Completitud',
    ''
  );
  if (coverage?.cumulative) {
    const c = coverage.cumulative;
    const unit = { lines: 'líneas', statements: 'sentencias', functions: 'funciones' }[c.unit ?? coverage.unit] ?? c.unit ?? coverage.unit;
    // Hasta la corrida shop-api la serie guardaba la cobertura de la ronda en `round` y perdía la etiqueta.
    const upTo = typeof coverage.round === 'string' ? `hasta \`${coverage.round}\`` : 'hasta la última ronda';
    const branches = c.branches?.total ? `, ${c.branches.covered}/${c.branches.total} ramas (${pct(c.branches.covered, c.branches.total)})` : '';
    add(`- **Cobertura del legacy bajo las sondas** (acumulada ${upTo}): ${c.covered}/${c.total} ${unit} (${pct(c.covered, c.total)})${branches}.`);
  } else add('- **Cobertura del legacy bajo las sondas**: sin serie (`recordings/coverage.json`); ninguna ronda la volcó.');
  const routes = routesWithoutOperation(surface, map);
  if (routes === null) add('- **Rutas del legacy sin operación en el diseño**: sin `surface.yaml` con rutas; no se puede saber.');
  else if (routes.length === 0) add('- **Rutas del legacy sin operación en el diseño**: ninguna.');
  else {
    add(`- **Rutas del legacy sin operación en el diseño** (${routes.length}): cada una es un \`fix\` que la quita, frontera o un hueco del diseño.`);
    for (const r of routes) add(`  - \`${r}\``);
  }
  const items = unobservedItems(unobserved);
  if (unobserved === null) add('- **Lo no observado**: no hay `unobserved.yaml`.');
  else if (items.length === 0) add('- **Lo no observado** (`unobserved.yaml`): nada.');
  else {
    add('- **Lo no observado** (`unobserved.yaml`):');
    for (const it of items) add(`  - ${it.section}: \`${cell(it.head)}\`${it.text ? ` — ${cell(it.text)}` : ''}`);
  }
  add('', '## Procedencia', '');
  if (provenance) {
    const counts = levelCounts(provenance);
    add(`| ${PROVENANCE_LEVELS.join(' | ')} |`, `|${PROVENANCE_LEVELS.map(() => '---').join('|')}|`, `| ${PROVENANCE_LEVELS.map((l) => (l === 'inferred' ? `**${counts[l]}**` : counts[l])).join(' | ')} |`, '');
  } else add('No hay `provenance.yaml`.', '');
  add('## Diferencias declaradas (`fix`)', '');
  const fixes = provenance?.fixes ?? [];
  if (fixes.length === 0) add('Ninguna.');
  for (const f of fixes) {
    const flows = records.filter((r) => r.mark === 'fix' && r.ref === f.id).map((r) => r.id);
    add(`- \`${f.id}\`: el legacy ${cell(f.legacy)} → ${cell(f.reason)}${flows.length ? ` (${flows.join(', ')})` : ''}`);
  }
  add('', '## Frontera del DSL', '');
  const frontier = provenance?.frontier ?? [];
  if (frontier.length === 0) add('Ninguna.');
  else {
    add('| id | Qué hace el legacy | Por qué el DSL no lo dice |', '|---|---|---|');
    for (const f of frontier) add(`| ${f.id} | ${cell(f.what)} | ${cell(f.why)} |`);
  }
  return `${out.join('\n')}\n`;
}
