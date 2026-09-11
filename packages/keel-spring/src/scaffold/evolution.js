// El traspaso entre `keel-spring build` y `/keel-generate-spring` cuando el proyecto YA
// estaba generado y algo cambió: el diseño, el stack o el generador.
//
// Sin él, volver a entrar al proyecto era repetir la generación entera a ciegas. El
// agente de código no sabía qué operación había cambiado, el de pruebas volvía a traducir
// todos los escenarios, los conflictos que dejaba `--refresh` en `build/keel-refresh/` no
// los recogía nadie, y el handler que el agente completó para una operación que el
// diseño retiró seguía compilando y respondiendo.
//
// Vive en REFRESH_DIR, junto a las versiones nuevas de los conflictos, y por lo mismo:
// fuera de `src/`, que es lo que leen los gates con `grep -rl`. El coste es que un
// `./gradlew clean` se lo lleva, y el propio documento lo dice.

import fs from 'node:fs';
import path from 'node:path';
import { REFRESH_DIR } from '../lib/generated-manifest.js';

export const EVOLUTION_MD = 'EVOLUTION.md';
export const EVOLUTION_JSON = 'evolution.json';

/**
 * La base del delta: el diseño desde el que se completó el proyecto por última vez.
 *
 * No basta con el snapshot de `specs/`, porque build lo refresca en cada pasada: dos
 * builds seguidos sin que el agente haya entrado harían que el segundo comparara el
 * diseño consigo mismo y borrara la evolución pendiente. La base se congela la primera
 * vez que el diseño cambia y dura hasta que el orquestador cierra la evolución.
 */
export const BASE_SPECS_DIR = 'base-specs';

const byName = (a, b) => a.localeCompare(b);
const posix = (relative) => relative.split(/[\\/]/).join('/');

/** El estado de la evolución: qué tiene que hacer el pipeline, y si hay algo. */
export function evolutionState({
  service,
  delta = null,
  pendingMerge = [],
  toRetire = [],
  pruned = [],
  newWithTodo = [],
  stack = { added: [], removed: [] },
  notes = []
}) {
  const designChanged = Boolean(delta && !delta.empty);
  const state = {
    schemaVersion: 1,
    service,
    from: delta?.from ?? null,
    to: delta?.to ?? service?.version ?? null,
    delta: designChanged ? delta : null,
    pendingMerge: [...pendingMerge].sort(byName),
    toRetire: [...toRetire].sort(byName),
    pruned: [...pruned].sort(byName),
    newWithTodo: [...newWithTodo].sort(byName),
    stack,
    notes
  };
  // `pruned` y `notes` no son trabajo para nadie: son informativos.
  state.pending =
    designChanged ||
    state.pendingMerge.length > 0 ||
    state.toRetire.length > 0 ||
    state.newWithTodo.length > 0 ||
    stack.added.length > 0 ||
    stack.removed.length > 0;
  return state;
}

/** El evolution.json de una pasada anterior que el orquestador todavía no ha cerrado. */
export function readPreviousEvolution(projectDir) {
  const file = path.join(projectDir, REFRESH_DIR, EVOLUTION_JSON);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Arrastra lo que una pasada anterior anotó y esta ya no puede ver.
 *
 * Un archivo nuevo solo es `nuevo` en el build que lo crea: si el diseñador vuelve a
 * lanzar build antes de entrar al proyecto, el segundo ya no lo sabe. Lo mismo con lo
 * podado. Se conserva lo que sigue siendo cierto: el archivo nuevo que aún tiene TODO,
 * y lo podado que sigue sin existir.
 */
export function mergePrevious(state, previous, projectDir) {
  if (!previous) return state;
  const exists = (relative) => fs.existsSync(path.join(projectDir, relative));
  const stillTodo = (relative) => exists(relative) && fs.readFileSync(path.join(projectDir, relative), 'utf8').includes('TODO');
  const union = (a, b) => [...new Set([...a, ...b])].sort(byName);
  const addedBefore = previous.stack?.added ?? [];
  const removedBefore = previous.stack?.removed ?? [];
  return evolutionState({
    service: state.service,
    delta: state.delta ?? null,
    pendingMerge: state.pendingMerge,
    toRetire: state.toRetire,
    pruned: union(state.pruned, (previous.pruned ?? []).filter((relative) => !exists(relative))),
    newWithTodo: union(state.newWithTodo, (previous.newWithTodo ?? []).filter(stillTodo)),
    stack: {
      added: mergeByCategory(addedBefore, state.stack.added),
      removed: mergeByCategory(removedBefore, state.stack.removed)
    },
    notes: state.notes
  });
}

function mergeByCategory(before, now) {
  const merged = new Map(before.map((change) => [change.category, change]));
  for (const change of now) merged.set(change.category, change);
  return [...merged.values()].sort((a, b) => byName(a.category, b.category));
}

const code = (value) => `\`${value}\``;
const list = (items) => items.map(code).join(', ');

function renderDeltaSections(delta) {
  const lines = [];
  if (delta.layers.added.length > 0) lines.push(`- Capas **añadidas**: ${list(delta.layers.added)}`);
  if (delta.layers.removed.length > 0) lines.push(`- Capas **quitadas**: ${list(delta.layers.removed)}`);
  for (const entry of delta.sections) {
    const where = `${code(entry.layer)} › ${code(entry.section)}`;
    if (entry.replaced) {
      lines.push(`- ${where}: cambiado`);
      continue;
    }
    const parts = [];
    if (entry.added.length > 0) parts.push(`añadidas ${list(entry.added)}`);
    if (entry.removed.length > 0) parts.push(`quitadas ${list(entry.removed)}`);
    if (entry.changed.length > 0) parts.push(`cambiadas ${list(entry.changed)}`);
    lines.push(`- ${where}: ${parts.join(' · ')}`);
  }
  return lines.length > 0 ? lines : ['- Solo cambió la versión del contrato.'];
}

function section(title, why, items) {
  return [`## ${title}`, '', why, '', ...(items.length > 0 ? items : ['- Ninguno.']), ''];
}

/** El documento que lee el orquestador. Determinista: sin fechas. */
export function renderEvolutionMarkdown(state) {
  const { service, delta } = state;
  const version = state.from && state.from !== state.to ? `v${state.from} → v${state.to}` : `v${state.to}`;
  const out = [
    `# Evolución pendiente — ${service.name} ${version}`,
    '',
    '> Lo escribe `keel-spring build` y lo consume `/keel-generate-spring` en **modo evolución**. No lo edites: ' +
      'se regenera en cada build. **No ejecutes `./gradlew clean` hasta cerrar la evolución**, porque vive en ' +
      `\`${REFRESH_DIR}/\` junto a la base del delta y a las versiones nuevas de los conflictos.`,
    ''
  ];

  out.push(
    ...section(
      '1. Fusiones pendientes',
      'Archivos que build generó, que el agente completó, y que el generador ha vuelto a cambiar. La versión nueva ' +
        `está en \`${REFRESH_DIR}/<ruta>\`: parte de la versión actual (la completada) y porta lo que cambió en la ` +
        'nueva, guiándote por el delta de la sección 3. No hay base de tres vías: el delta es lo que dice qué portar.',
      state.pendingMerge.map((relative) => `- ${code(relative)} ← ${code(`${REFRESH_DIR}/${relative}`)}`)
    )
  );

  out.push(
    ...section(
      '2. Huérfanos a retirar',
      'Archivos que build generó y ya no emite: el diseño retiró lo que los justificaba. Se tocaron, así que build no ' +
        'los borra. Retíralos junto con lo que dependa de ellos; si siguen ahí, el servidor expone algo que el diseño ya no tiene.',
      state.toRetire.map((relative) => `- ${code(relative)}`)
    )
  );

  out.push(
    ...section(
      '3. Cambios del diseño',
      'Lo que cambió en `specs/` desde la última vez que se completó el proyecto. Una operación, entidad o evento ' +
        '**cambiado** obliga a revisar su handler aunque no tenga TODO: build no reescribe el código completado.',
      delta ? renderDeltaSections(delta) : []
    )
  );

  const scenarios = delta?.scenarios ?? { added: [], changed: [], removed: [], families: [] };
  out.push(
    ...section(
      '4. Escenarios',
      'Solo esto es trabajo del agente de pruebas: crear las clases de los añadidos, reescribir las de las familias ' +
        'cambiadas y borrar las de los quitados. La clase de un flujo se localiza buscando su id en ' +
        '`src/integrationTest/`. Las demás no se tocan: la puntuación corre la suite COMPLETA, y ellas son la no-regresión.',
      [
        ...(scenarios.added.length > 0 ? [`- Añadidos: ${list(scenarios.added)}`] : []),
        ...(scenarios.changed.length > 0 ? [`- Cambiados: ${list(scenarios.changed)}`] : []),
        ...(scenarios.removed.length > 0 ? [`- Quitados: ${list(scenarios.removed)}`] : []),
        ...(scenarios.families.length > 0 ? [`- Familias afectadas: ${list(scenarios.families)}`] : [])
      ]
    )
  );

  out.push(
    ...section(
      '5. Archivos nuevos con TODO',
      'Stubs que build acaba de crear. `grep -rn "TODO" src` los encuentra igual, pero esta es la lista de lo NUEVO.',
      state.newWithTodo.map((relative) => `- ${code(relative)}`)
    )
  );

  const stackLines = [
    ...state.stack.added.map((change) => `- ${code(change.category)}: añadido → ${code(change.value)}`),
    ...state.stack.removed.map((change) => `- ${code(change.category)}: retirado (era ${code(change.value)})`)
  ];
  out.push(
    ...section(
      '6. Stack',
      'Categorías de `keel-stack.json` que el diseño empezó a pedir o dejó de pedir. Una categoría nueva trae infraestructura ' +
        'y skills por tecnología nuevas: el agente de infraestructura la levanta y el de código lee su skill.',
      stackLines
    )
  );

  if (state.pruned.length > 0) {
    out.push(
      '## Retirado por build',
      '',
      'Huérfanos que nadie había tocado: `--prune` los borró. Informativo.',
      '',
      ...state.pruned.map((relative) => `- ${code(relative)}`),
      ''
    );
  }

  if (state.notes.length > 0) out.push('## Avisos', '', ...state.notes.map((note) => `- ${note}`), '');

  out.push(
    '## Cierre (lo hace el orquestador)',
    '',
    '1. Con la suite de integración al 100% y el pase de calidad en verde, quita de `pendingMerge` en ' +
      '`keel-generated.json` las rutas de la sección 1 que se fusionaron. Mientras quede una, ' +
      '`keel-spring build --check` sale en rojo.',
    `2. Borra \`${REFRESH_DIR}/\` entero: este documento, la base del delta y las versiones nuevas de los conflictos.`,
    `3. Commit: \`Evolucionado desde specs/${service.name} ${version}\`.`,
    ''
  );

  return out.join('\n');
}

/** Escribe el traspaso, o lo retira si ya no queda nada pendiente. */
export function writeEvolution(projectDir, state) {
  const dir = path.join(projectDir, REFRESH_DIR);
  const md = path.join(dir, EVOLUTION_MD);
  const json = path.join(dir, EVOLUTION_JSON);
  if (!state.pending) {
    for (const file of [md, json]) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(dir, BASE_SPECS_DIR), { recursive: true, force: true });
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(md, renderEvolutionMarkdown(state));
  const { pending, ...serializable } = state;
  fs.writeFileSync(json, JSON.stringify(serializable, null, 2) + '\n');
  return true;
}

/** Rutas relativas en forma POSIX, para comparar con los cubos del manifiesto. */
export { posix as toPosixPath };
