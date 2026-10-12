// El traspaso entre `build` y la skill del proyecto cuando el proyecto YA estaba generado y
// algo cambió: el diseño, el stack o el generador (keel-core/gen).
//
// Sin él, volver a entrar al proyecto era repetir la generación entera a ciegas. El agente de
// código no sabía qué operación había cambiado, el de pruebas volvía a traducir todos los
// escenarios, los conflictos que dejaba `--refresh` en REFRESH_DIR no los recogía nadie, y el
// handler que el agente completó para una operación que el diseño retiró seguía compilando y
// respondiendo.
//
// NEUTRAL: la base congelada, el delta, qué es trabajo y qué es informativo, y el documento son
// la misma decisión para cualquier generador. Lo único que cambia entre keel-spring y keel-nest
// son unos pocos textos de su PLATAFORMA (el comando que se llevaría `build/`, dónde viven las
// pruebas de los escenarios), y entran por parámetro.
//
// Vive en REFRESH_DIR, junto a las versiones nuevas de los conflictos, y por lo mismo: fuera
// del árbol de fuentes, que es lo que leen los gates con `grep -rl`. El coste es que limpiar
// `build/` se lo lleva, y el propio documento lo dice.

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { copyTree } from '../copy.js';
import { diffDesigns } from '../design-delta.js';
import { MANIFEST_FILE as DESIGN_MANIFEST } from '../loader.js';
import { REFRESH_DIR } from './generated-manifest.js';
import { STACK_FILE, describeStack, normalizeTelemetry, stackDrift } from './stack.js';

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

/**
 * Los textos de cada plataforma. `generator` y `skill` nombran las dos mitades del traspaso;
 * `keepBuild` es la advertencia de no limpiar REFRESH_DIR con la herramienta del proyecto;
 * `scenarioWork`, cómo se localiza y se rehace la prueba de un flujo; `duplicateStub`, qué pasa
 * si un stub vuelve junto a su implementación real.
 */
export const EVOLUTION_PLATFORM_KEYS = ['generator', 'skill', 'keepBuild', 'scenarioWork', 'duplicateStub'];

function assertPlatform(platform) {
  const missing = EVOLUTION_PLATFORM_KEYS.filter((key) => typeof platform?.[key] !== 'string');
  if (missing.length > 0) throw new Error(`plataforma de evolución incompleta: falta ${missing.join(', ')}`);
}

const byName = (a, b) => a.localeCompare(b);
const hasDesign = (candidate) => fs.existsSync(path.join(candidate, DESIGN_MANIFEST));

/** El estado de la evolución: qué tiene que hacer el pipeline, y si hay algo. */
export function evolutionState({
  service,
  delta = null,
  pendingMerge = [],
  toRetire = [],
  pruned = [],
  notRecreated = [],
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
    notRecreated: [...notRecreated].sort(byName),
    newWithTodo: [...newWithTodo].sort(byName),
    stack,
    notes
  };
  // `pruned`, `notRecreated` y `notes` no son trabajo para nadie: son informativos.
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
    // Lo que sigue sin estar: si alguien lo restauró con --force, deja de ser noticia.
    notRecreated: union(state.notRecreated, (previous.notRecreated ?? []).filter((relative) => !exists(relative))),
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
export function renderEvolutionMarkdown(state, platform) {
  assertPlatform(platform);
  const { service, delta } = state;
  const version = state.from && state.from !== state.to ? `v${state.from} → v${state.to}` : `v${state.to}`;
  const out = [
    `# Evolución pendiente — ${service.name} ${version}`,
    '',
    `> Lo escribe \`${platform.generator} build\` y lo consume \`/${platform.skill}\` en **modo evolución**. No lo edites: ` +
      `se regenera en cada build. ${platform.keepBuild}, porque vive en ` +
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
      `Solo esto es trabajo del agente de pruebas: ${platform.scenarioWork} Las demás no se tocan: la puntuación ` +
        'corre la suite COMPLETA, y ellas son la no-regresión.',
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

  if (state.notRecreated.length > 0) {
    out.push(
      '## No recreado (lo borraste tú)',
      '',
      'Archivos que build escribió en su día y que ya no están. **No se recrean**: el caso normal es un stub ' +
        `sustituido por su implementación real —${platform.duplicateStub}—, y devolverlo ` +
        'deshace ese trabajo. Si el borrado fue un error, `--force` los vuelve a escribir. Informativo.',
      '',
      ...state.notRecreated.map((relative) => `- ${code(relative)}`),
      ''
    );
  }

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
      `\`${platform.generator} build --check\` sale en rojo.`,
    `2. Borra \`${REFRESH_DIR}/\` entero: este documento, la base del delta y las versiones nuevas de los conflictos.`,
    `3. Commit: \`Evolucionado desde specs/${service.name} ${version}\`.`,
    ''
  );

  return out.join('\n');
}

/** Escribe el traspaso, o lo retira si ya no queda nada pendiente. */
export function writeEvolution(projectDir, state, platform) {
  const dir = path.join(projectDir, REFRESH_DIR);
  const md = path.join(dir, EVOLUTION_MD);
  const json = path.join(dir, EVOLUTION_JSON);
  if (!state.pending) {
    for (const file of [md, json]) fs.rmSync(file, { force: true });
    fs.rmSync(path.join(dir, BASE_SPECS_DIR), { recursive: true, force: true });
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(md, renderEvolutionMarkdown(state, platform));
  const { pending, ...serializable } = state;
  fs.writeFileSync(json, JSON.stringify(serializable, null, 2) + '\n');
  return true;
}

// ── El cableado en `build`, el mismo para los dos generadores ─────────────────────────────

/**
 * El delta del diseño, calculado ANTES de refrescar el snapshot: contra la base congelada si
 * una evolución anterior sigue sin cerrar, o si no contra el snapshot, que es el diseño desde
 * el que se completó el proyecto por última vez. `projectExisted` dice si hay algo que evolucionar:
 * en la primera generación todo es nuevo y el pipeline ya lo sabe.
 */
export function designDelta(projectDir, designDir) {
  const snapshotDir = path.join(projectDir, 'specs');
  const baseDir = path.join(projectDir, REFRESH_DIR, BASE_SPECS_DIR);
  const projectExisted = hasDesign(snapshotDir);
  const deltaBase = hasDesign(baseDir) ? baseDir : projectExisted ? snapshotDir : null;
  let delta = null;
  if (deltaBase) {
    delta = diffDesigns(deltaBase, designDir);
    if (delta.error) {
      console.warn(`${pc.yellow('⚠')} No se pudo comparar con el diseño anterior del proyecto: ${delta.error}`);
      delta = null;
    }
  }
  return { delta, projectExisted, deltaBase, snapshotDir, baseDir };
}

/** Lo que el diseñador tiene que saber de esta pasada y no es trabajo del agente. */
export function evolutionNotes(mode, prune, buckets) {
  const notes = [];
  if (mode !== 'refresh' && buckets.conflictos.length > 0) {
    notes.push(
      `${buckets.conflictos.length} conflicto(s) sin materializar: con \`--refresh\` su versión nueva queda en ` +
        `\`${REFRESH_DIR}/\` y pasan a la sección 1.`
    );
  }
  if (mode !== 'refresh' && buckets.refrescables.length > 0) {
    notes.push(`${buckets.refrescables.length} archivo(s) de build sin poner al día: vuelve a lanzar con \`--refresh\`.`);
  }
  if (!prune && buckets.huerfanos.length > 0) {
    notes.push('Con `--refresh --prune`, build retira él mismo los huérfanos que nadie tocó.');
  }
  return notes;
}

/**
 * El estado de la evolución de esta pasada, a partir de lo que devolvió `materializeProject`,
 * fusionado con el de una pasada anterior sin cerrar. `null` en la primera generación.
 */
export function planEvolution({ design, manifest, scaffold, stackChanges, mode, prune, projectDir }) {
  if (!design.projectExisted) return null;
  return mergePrevious(
    evolutionState({
      service: { name: manifest.service?.name, version: manifest.service?.version },
      delta: design.delta,
      pendingMerge: scaffold.pendingMerge,
      // Con --prune lo intacto ya se fue: queda lo tocado. Sin él, todo huérfano que
      // siga en disco es algo que el diseño ya no tiene.
      toRetire: scaffold.pruned ? scaffold.pruned.modificados : scaffold.huerfanosVivos,
      pruned: scaffold.pruned?.borrados ?? [],
      // Informativo, como `pruned`: no es trabajo del agente, es constancia de que build
      // vio el borrado y lo respetó. Sin decirlo, un stub que no vuelve se lee como un
      // archivo que build dejó de emitir.
      notRecreated: scaffold.buckets.retirados,
      newWithTodo: scaffold.nuevosConTodo,
      stack: stackChanges,
      notes: evolutionNotes(mode, prune, scaffold.buckets)
    }),
    readPreviousEvolution(projectDir),
    projectDir
  );
}

/**
 * Congela la base y escribe (o retira) el traspaso. Va ANTES de refrescar el snapshot: si no,
 * un segundo build compararía el diseño consigo mismo.
 */
export function persistEvolution(evolution, design, projectDir, platform) {
  if (!evolution) return;
  if (evolution.delta && design.deltaBase === design.snapshotDir) copyTree(design.snapshotDir, design.baseDir, { force: true });
  writeEvolution(projectDir, evolution, platform);
}

/** El resumen de consola de la evolución pendiente. */
export function reportEvolution(evolution, outDir, mode) {
  if (!evolution?.pending) return;
  console.log();
  const version =
    evolution.from && evolution.from !== evolution.to ? ` — diseño v${evolution.from} → v${evolution.to}` : '';
  console.log(
    pc.bold(
      pc.yellow(
        mode === 'check'
          ? `Evolución pendiente${version} (no se escribe nada con --check):`
          : `Evolución pendiente${version} → ${outDir}/${REFRESH_DIR}/${EVOLUTION_MD}`
      )
    )
  );
  const scenarios = evolution.delta?.scenarios;
  const lines = [
    ['fusión(es) pendiente(s)', evolution.pendingMerge.length],
    ['huérfano(s) a retirar por el agente', evolution.toRetire.length],
    ['sección(es) del diseño cambiada(s)', evolution.delta?.sections.length ?? 0],
    [
      'escenario(s) añadido(s), cambiado(s) o quitado(s)',
      scenarios ? scenarios.added.length + scenarios.changed.length + scenarios.removed.length : 0
    ],
    ['archivo(s) nuevo(s) con TODO', evolution.newWithTodo.length],
    ['cambio(s) de stack', evolution.stack.added.length + evolution.stack.removed.length],
    ['archivo(s) retirado(s) por --prune', evolution.pruned.length]
  ];
  for (const [label, count] of lines) if (count > 0) console.log(`  ${pc.yellow('•')} ${count} ${label}`);
  for (const note of evolution.notes) console.log(pc.dim(`  ${note.replace(/`/g, '')}`));
}

/**
 * El stack persistido frente a un diseño que pudo EVOLUCIONAR bajo él: una capa nueva que pide
 * tecnología se pregunta (solo ella, con `ask`), y la que dejó de aplicar se anula. `--telemetry`
 * sobre un stack ya persistido es el único modo de cambiarla —no hay capa cuya aparición la pida—
 * y se reporta como cualquier otro cambio, así EVOLUTION.md lo recoge. Con `check` no se pregunta
 * ni se cambia nada, pero los cambios se calculan igual: son lo que `--check` tiene que decir.
 */
export async function evolveStack({ stack, layers, mode, telemetry = null, ask }) {
  const changes = { added: [], removed: [] };
  const drift = stackDrift(stack, layers);
  if (drift.missing.length + drift.stale.length > 0) {
    const before = stack;
    if (mode !== 'check') {
      const answers = drift.missing.length > 0 ? await ask(drift.missing) : {};
      stack = { ...stack };
      for (const category of drift.missing) stack[category] = answers[category] ?? null;
      for (const category of drift.stale) stack[category] = null;
    }
    changes.added = drift.missing.map((category) => ({ category, value: stack[category] ?? null }));
    changes.removed = drift.stale.map((category) => ({ category, value: before[category] }));
  }
  const currentTelemetry = normalizeTelemetry(stack.telemetry);
  if (telemetry != null && telemetry !== currentTelemetry) {
    if (mode !== 'check') stack = { ...stack, telemetry };
    if (currentTelemetry !== 'none') changes.removed.push({ category: 'telemetry', value: currentTelemetry });
    if (telemetry !== 'none') changes.added.push({ category: 'telemetry', value: telemetry });
  }
  console.log();
  console.log(pc.dim(`Stack (${STACK_FILE}): ${describeStack(stack)}`));
  for (const { category, value } of changes.added) {
    console.log(`  ${pc.yellow('+')} ${category}: ${value ?? pc.dim('(sin elegir: --check no pregunta)')}`);
  }
  for (const { category, value } of changes.removed) {
    const why = category === 'telemetry' ? '(retirada con --telemetry none)' : '(el diseño ya no lo pide)';
    console.log(`  ${pc.yellow('-')} ${category}: ${value} ${pc.dim(why)}`);
  }
  return { stack, changes, changed: changes.added.length + changes.removed.length > 0 };
}

/**
 * Qué se ha quedado atrás respecto al generador instalado, y de quién es cada cosa.
 *
 * El vocabulario es el de `keel init --check`, que resuelve el problema hermano en el
 * workspace de diseño: `~` desfasado, `○` ausente. Se le añade `!` para el conflicto,
 * que allí no existe porque el payload no lo edita nadie a medias.
 *
 * Lo que este reporte hace y `--force` no puede: nombrar los archivos. Un `--force` a
 * ciegas propaga el arreglo Y destruye el trabajo del agente sin decir cuál era cuál.
 */
export function reportGeneratorDrift(scaffold, mode, { generator }) {
  const { refrescables, conflictos, adoptados, retirados } = scaffold.buckets;
  // Con --prune lo intacto ya se fue: solo queda por decir lo que alguien tocó.
  const huerfanos = scaffold.pruned ? scaffold.pruned.modificados : scaffold.huerfanosVivos;
  if (refrescables.length + conflictos.length + huerfanos.length + adoptados.length + retirados.length === 0) {
    if (mode === 'check') console.log(pc.green('✔ El proyecto está al día con el generador instalado.'));
    return;
  }

  const separar = () => console.log();
  if (refrescables.length > 0) {
    separar();
    const puestos = mode === 'refresh';
    console.log(
      pc.bold(
        puestos
          ? pc.green(`${refrescables.length} archivo(s) del generador puestos al día:`)
          : pc.yellow(`${refrescables.length} archivo(s) del generador se han quedado atrás:`)
      )
    );
    for (const file of refrescables) console.log(`  ${puestos ? pc.green('+') : pc.yellow('~')} ${file}`);
  }

  if (conflictos.length > 0) {
    separar();
    console.log(pc.bold(pc.yellow(`${conflictos.length} archivo(s) en conflicto — los tocaste Y el generador cambió:`)));
    for (const file of conflictos) console.log(`  ${pc.yellow('!')} ${file}`);
    console.log(
      pc.dim(
        mode === 'refresh'
          ? `  La versión nueva queda en ${REFRESH_DIR}/ para compararla con diff. Ninguno se ha tocado.`
          : '  No se tocan: la decisión es tuya. Con --refresh se deja la versión nueva al lado para compararla.'
      )
    );
  }

  if (huerfanos.length > 0) {
    separar();
    console.log(
      pc.dim(
        scaffold.pruned
          ? `${huerfanos.length} archivo(s) que el generador ya no emite y alguien tocó: no se borran, pasan al agente vía ${EVOLUTION_MD}: ${huerfanos.join(', ')}`
          : `${huerfanos.length} archivo(s) que el generador ya no emite (no se borran; --refresh --prune retira los que nadie tocó): ${huerfanos.join(', ')}`
      )
    );
  }

  if (retirados.length > 0) {
    separar();
    console.log(
      pc.dim(
        `${retirados.length} archivo(s) que build escribió y ya no están: NO se recrean —borrarlos fue una decisión, ` +
          `y el caso normal es un stub sustituido por su implementación real—. Si el borrado fue un error, --force los ` +
          `devuelve: ${retirados.join(', ')}`
      )
    );
  }

  if (adoptados.length > 0) {
    separar();
    console.log(
      pc.dim(
        `${adoptados.length} archivo(s) sin registro de quién los escribió: se avisa de ellos, pero no se refrescan. ` +
          'Un proyecto generado antes de este mecanismo los adopta enteros; salen de ahí cuando un --force los reescribe.'
      )
    );
  }

  if (refrescables.length > 0 && mode !== 'refresh') {
    separar();
    console.log(pc.dim(`Ponlos al día con ${pc.cyan(`${generator} build <ruta> --refresh`)}.`));
  }
}

/** Si `--check` tiene que salir en rojo: el proyecto se quedó atrás o hay una evolución sin cerrar. */
export function checkFails(scaffold, evolution) {
  return scaffold.buckets.refrescables.length > 0 || scaffold.buckets.conflictos.length > 0 || Boolean(evolution?.pending);
}
