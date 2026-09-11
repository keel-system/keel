import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  isKeelWorkspace,
  resolveServiceDir,
  loadService,
  validateService,
  copyTree,
  diffDesigns,
  DECISIONS_FILE,
  MANIFEST_FILE as DESIGN_MANIFEST
} from 'keel-core';
import { SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { scaffoldService } from '../scaffold/index.js';
import { writeFiles } from '../lib/writer.js';
import {
  STACK_FILE,
  readStackConfig,
  writeStackConfig,
  askStackConfig,
  describeStack,
  stackDrift
} from '../lib/stack-config.js';
import { REFRESH_DIR } from '../lib/generated-manifest.js';
import {
  BASE_SPECS_DIR,
  EVOLUTION_MD,
  evolutionState,
  mergePrevious,
  readPreviousEvolution,
  writeEvolution
} from '../scaffold/evolution.js';

function listSpecs(workspace) {
  const specsDir = path.join(workspace, 'specs');
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function printSchemaErrors(file, ajvErrors) {
  console.error(pc.bold(pc.red(`✘ ${file}`)));
  for (const error of ajvErrors) {
    const where = error.instancePath || '(raíz)';
    console.error(`  ${pc.red('•')} ${pc.cyan(where)} ${error.message}`);
  }
}

export async function build(
  inputPath,
  { force = false, defaults = false, check = false, refresh = false, prune = false } = {}
) {
  // Tres modos y no dos banderas sueltas: `check` gana porque no escribir es la promesa
  // más fuerte de las dos, y pedir las dos a la vez es una contradicción que vale más
  // resolver aquí que dejar a medias en el sistema de archivos.
  const mode = check ? 'check' : refresh ? 'refresh' : null;
  const workspace = process.cwd();

  // Podar es refrescar en la otra dirección: solo tiene sentido donde build ya decide
  // archivo a archivo de quién es cada cosa.
  if (prune && mode !== 'refresh') {
    console.error(pc.red('--prune solo se admite junto a --refresh (y nunca con --check, que no escribe).'));
    process.exitCode = 1;
    return;
  }

  if (!isKeelWorkspace(workspace)) {
    console.error(pc.red('Este directorio no es un workspace Keel (falta schema/service.schema.json).'));
    console.error(`Ejecuta primero ${pc.cyan('keel init')}.`);
    process.exitCode = 1;
    return;
  }

  if (!inputPath) {
    console.error(pc.red('Falta el servicio a preparar: keel-spring build specs/<servicio>'));
    const services = listSpecs(workspace);
    if (services.length > 0) {
      console.error('Servicios en specs/:');
      for (const name of services) console.error(`  ${pc.cyan(`specs/${name}`)}`);
    }
    process.exitCode = 1;
    return;
  }

  const { dir, error: resolveError } = resolveServiceDir(inputPath);
  if (resolveError) {
    console.error(pc.red(resolveError));
    process.exitCode = 1;
    return;
  }

  // Compatibilidad DSL: este generador solo sabe mapear las versiones declaradas en SUPPORTED_DSL.
  const { manifest, layers, errors: loadErrors } = loadService(dir);
  if (!manifest) {
    for (const message of loadErrors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }
  if (!SUPPORTED_DSL.includes(manifest.keel)) {
    console.error(
      pc.red(`✘ DSL keel ${manifest.keel ?? '(sin declarar)'} no soportado por keel-spring (soporta: ${SUPPORTED_DSL.join(', ')}).`)
    );
    console.error(pc.dim('  Actualiza keel-spring o ajusta el diseño a una versión soportada.'));
    process.exitCode = 1;
    return;
  }

  // Frontera del generador: lo que el DSL declara y keel-spring no sabe mapear se
  // rechaza o se avisa aquí, antes de sembrar nada y antes de preguntar el stack.
  const features = checkSupportedFeatures(manifest, layers);
  for (const message of features.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (features.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ El diseño usa capacidades que keel-spring no genera — ${features.errors.length}:`)));
    for (const message of features.errors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return;
  }

  // El workspace de diseño no recibe nada del generador: la skill, los agentes,
  // las conventions y las skills por tecnología se instalan solo en el proyecto
  // generado (el asset del paquete npm es su fuente, leída directamente). La
  // generación se ejecuta siempre con el cwd en services/<servicio>-spring/.

  // Un diseño en progreso no es generable: validación estricta, sin --wip.
  const {
    loadErrors: fullLoadErrors,
    schemaErrors,
    crossRefErrors,
    warnings,
    pending,
    obligations,
    ok
  } = validateService(dir, { wip: false });

  for (const { file, errors } of schemaErrors) printSchemaErrors(file, errors);
  for (const message of fullLoadErrors) console.error(pc.red(`✘ ${message}`));
  if (pending.length > 0) {
    console.error(pc.bold(pc.red(`✘ Diseño incompleto — ${pending.length} pendiente(s):`)));
    for (const message of pending) console.error(`  ${pc.red('•')} ${message}`);
  }
  for (const message of warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  if (crossRefErrors.length > 0) {
    console.error(pc.bold(pc.red(`✘ Referencias cruzadas — ${crossRefErrors.length} error(es):`)));
    for (const message of crossRefErrors) console.error(`  ${pc.red('•')} ${message}`);
  }

  // Las decisiones de diseño sin cerrar bloquean como un error, así que el
  // veredicto genérico de abajo tiene que decir cuáles: mientras esto no se
  // imprimía, un diseño rechazado por una obligación abierta era indistinguible
  // de uno roto, y la causa solo se veía ejecutando `keel validate` a mano.
  const sinCerrar = [...obligations.open, ...obligations.stale];
  if (obligations.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ ${DECISIONS_FILE} — ${obligations.errors.length} error(es):`)));
    for (const message of obligations.errors) console.error(`  ${pc.red('•')} ${message}`);
  }
  if (sinCerrar.length > 0) {
    console.error(pc.bold(pc.red(`✘ Decisiones de diseño sin cerrar — ${sinCerrar.length}:`)));
    for (const item of sinCerrar) {
      const caducada = item.since ? pc.dim(` (aceptada en v${item.since}: el diseño cambió, reafírmala)`) : '';
      console.error(`  ${pc.red('•')} ${pc.cyan(item.id)} ${item.scope}: ${item.message}${caducada}`);
    }
    console.error(
      pc.dim(
        `  Ciérralas en el diseño, o acéptalas por escrito en ${DECISIONS_FILE} con su motivo — ver docs/design-obligations.md`
      )
    );
  }

  if (!ok || pending.length > 0) {
    console.error();
    console.error(pc.red('El diseño aún no es generable. Termina el diseño (/keel-design) y valida con keel validate.'));
    process.exitCode = 1;
    return;
  }

  // Stack tecnológico: keel-stack.json del proyecto generado manda; si no
  // existe, cuestionario condicionado por las capas del diseño (o defaults).
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-spring`);
  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  let stackChanges = { added: [], removed: [] };
  if (stack) {
    // El stack persistido se reutiliza, pero el diseño pudo EVOLUCIONAR bajo él: una capa
    // nueva que pide tecnología se pregunta (solo ella), y la que dejó de aplicar se anula.
    const drift = stackDrift(stack, layers);
    if (drift.missing.length + drift.stale.length > 0) {
      const before = stack;
      if (mode !== 'check') {
        const answers =
          drift.missing.length > 0 ? await askStackConfig(manifest, layers, { defaults, only: drift.missing }) : {};
        stack = { ...stack };
        for (const category of drift.missing) stack[category] = answers[category] ?? null;
        for (const category of drift.stale) stack[category] = null;
      }
      stackChanges = {
        added: drift.missing.map((category) => ({ category, value: stack[category] ?? null })),
        removed: drift.stale.map((category) => ({ category, value: before[category] }))
      };
    }
    console.log();
    console.log(pc.dim(`Stack (${STACK_FILE}): ${describeStack(stack)}`));
    for (const { category, value } of stackChanges.added) {
      console.log(`  ${pc.yellow('+')} ${category}: ${value ?? pc.dim('(sin elegir: --check no pregunta)')}`);
    }
    for (const { category, value } of stackChanges.removed) {
      console.log(`  ${pc.yellow('-')} ${category}: ${value} ${pc.dim('(el diseño ya no lo pide)')}`);
    }
  } else {
    stack = await askStackConfig(manifest, layers, { defaults });
    stackIsNew = true;
  }

  // El delta de diseño se calcula ANTES de refrescar el snapshot, contra la base congelada
  // si una evolución anterior sigue sin cerrar, o si no contra el snapshot: es el diseño
  // desde el que se completó el proyecto por última vez.
  const snapshotDir = path.join(projectDir, 'specs');
  const baseDir = path.join(projectDir, REFRESH_DIR, BASE_SPECS_DIR);
  const hasDesign = (candidate) => fs.existsSync(path.join(candidate, DESIGN_MANIFEST));
  const projectExisted = hasDesign(snapshotDir);
  const deltaBase = hasDesign(baseDir) ? baseDir : projectExisted ? snapshotDir : null;
  let delta = null;
  if (deltaBase) {
    delta = diffDesigns(deltaBase, dir);
    if (delta.error) {
      console.warn(`${pc.yellow('⚠')} No se pudo comparar con el diseño anterior del proyecto: ${delta.error}`);
      delta = null;
    }
  }

  // Scaffolding transversal al stack: todo lo derivable mecánicamente del
  // diseño cuyo código no depende de la infra puntual elegida (el resto lo
  // escribe el agente con las skills por tecnología). Regeneración segura: sin --force
  // solo se escriben archivos que no existen.
  const scaffold = scaffoldService({ manifest, layers, workspace, force, stack, mode, prune });
  const stackChanged = stackChanges.added.length + stackChanges.removed.length > 0;
  if (stackIsNew || (stackChanged && mode !== 'check')) {
    writeStackConfig(projectDir, scaffold.stack);
    console.log();
    console.log(pc.dim(`Stack elegido: ${describeStack(scaffold.stack)} → ${STACK_FILE}`));
  }
  console.log();
  console.log(pc.bold(`Scaffolding ${scaffold.outDir}/`));
  for (const file of scaffold.copied) console.log(`  ${pc.green('+')} ${file}`);
  for (const file of scaffold.skipped) console.log(`  ${pc.yellow('=')} ${file} ${pc.dim('(ya existía, omitido)')}`);
  for (const message of scaffold.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
  console.log(
    pc.dim(
      `${scaffold.copied.length} archivo(s) generado(s), ${scaffold.skipped.length} omitido(s)` +
        (scaffold.skipped.length > 0 ? ' (usa --force para sobrescribir)' : '')
    )
  );

  reportGeneratorDrift(scaffold, projectDir, workspace, mode);

  // El traspaso al pipeline cuando el proyecto ya existía y algo cambió. En la primera
  // generación no hay nada que evolucionar: todo es nuevo y el pipeline lo sabe.
  const evolution = projectExisted
    ? mergePrevious(
        evolutionState({
          service: { name: manifest.service?.name, version: manifest.service?.version },
          delta,
          pendingMerge: scaffold.pendingMerge,
          // Con --prune lo intacto ya se fue: queda lo tocado. Sin él, todo huérfano que
          // siga en disco es algo que el diseño ya no tiene.
          toRetire: scaffold.pruned ? scaffold.pruned.modificados : scaffold.huerfanosVivos,
          pruned: scaffold.pruned?.borrados ?? [],
          newWithTodo: scaffold.nuevosConTodo,
          stack: stackChanges,
          notes: evolutionNotes(mode, prune, scaffold.buckets)
        }),
        readPreviousEvolution(projectDir),
        projectDir
      )
    : null;
  reportEvolution(evolution, scaffold.outDir, mode);

  if (mode === 'check') {
    if (scaffold.buckets.refrescables.length > 0 || scaffold.buckets.conflictos.length > 0 || evolution?.pending) {
      process.exitCode = 1;
    }
    return;
  }

  if (evolution) {
    // La base se congela la primera vez que el diseño cambia, ANTES de refrescar el
    // snapshot: si no, un segundo build compararía el diseño consigo mismo.
    if (evolution.delta && deltaBase === snapshotDir) copyTree(snapshotDir, baseDir, { force: true });
    writeEvolution(projectDir, evolution);
  }

  // Snapshot del diseño dentro del proyecto: junto con el conocimiento del agente hace el repo
  // autosuficiente (quien lo clone finaliza la generación sin el workspace).
  // Siempre se refresca: el canónico es specs/<servicio> del workspace.
  const snapshot = copyTree(dir, snapshotDir, { force: true });
  console.log(
    pc.dim(
      `Snapshot del diseño → ${path.relative(workspace, snapshotDir).split(path.sep).join('/')}/ ` +
        `(${snapshot.copied.length} archivo(s), refrescado en cada build)`
    )
  );

  // Snapshot de los contratos formales (/keel-docs) junto al del diseño: quien
  // clone el proyecto tiene openapi/asyncapi, las colecciones Postman y el panel
  // sin el workspace. Solo lo que produce /keel-docs — DESIGN.md e INTEGRATION.md
  // viven en el mismo directorio pero son de otras skills. También se refresca
  // siempre: el canónico es docs/<servicio>/ del workspace.
  const docsDir = path.join(projectDir, 'docs');
  if (scaffold.docs.files.length > 0) {
    const docsSnapshot = writeFiles(scaffold.docs.files, docsDir, { force: true });
    console.log(
      pc.dim(
        `Snapshot de los contratos → ${path.relative(workspace, docsDir).split(path.sep).join('/')}/ ` +
          `(${docsSnapshot.copied.length} archivo(s), refrescado en cada build)`
      )
    );
  } else {
    console.warn(
      `${pc.yellow('⚠')} El servicio aún no tiene contratos generados (docs/${manifest.service?.name}/). ` +
        `Ejecuta ${pc.cyan(`/keel-docs ${path.relative(workspace, dir).split(path.sep).join('/')}`)} y vuelve a ` +
        'lanzar el build para incluirlos en el proyecto.'
    );
  }

  console.log();
  console.log(pc.bold(pc.green('✔ Scaffolding generado.')) + pc.dim(` — ${manifest.service?.name} v${manifest.service?.version}`));
  console.log(`
Siguiente paso — la generación se completa dentro del proyecto:
  1. ${pc.cyan(`cd ${scaffold.outDir}`)}
  2. abre tu agente ahí y ejecuta ${pc.cyan(`/${SKILL}`)} ${pc.dim('(sin argumentos)')}

Orquesta el completado: código + infraestructura en paralelo, validación funcional de los
escenarios contra el servidor real y pase de calidad al final.`);
  if (evolution?.pending) {
    console.log(
      pc.dim(
        `Como hay ${REFRESH_DIR}/${EVOLUTION_MD}, la skill entra en modo evolución: trabaja sobre lo que cambió y ` +
          'puntúa la suite completa como no-regresión.'
      )
    );
  }
}

/** Lo que el diseñador tiene que saber de esta pasada y no es trabajo del agente. */
function evolutionNotes(mode, prune, buckets) {
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

function reportEvolution(evolution, outDir, mode) {
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
 * Qué se ha quedado atrás respecto al generador instalado, y de quién es cada cosa.
 *
 * El vocabulario es el de `keel init --check`, que resuelve el problema hermano en el
 * workspace de diseño: `~` desfasado, `○` ausente. Se le añade `!` para el conflicto,
 * que allí no existe porque el payload no lo edita nadie a medias.
 *
 * Lo que este reporte hace y `--force` no puede: nombrar los archivos. Un `--force` a
 * ciegas propaga el arreglo Y destruye el trabajo del agente sin decir cuál era cuál.
 */
function reportGeneratorDrift(scaffold, projectDir, workspace, mode) {
  const { refrescables, conflictos, adoptados } = scaffold.buckets;
  // Con --prune lo intacto ya se fue: solo queda por decir lo que alguien tocó.
  const huerfanos = scaffold.pruned ? scaffold.pruned.modificados : scaffold.huerfanosVivos;
  if (refrescables.length + conflictos.length + huerfanos.length + adoptados.length === 0) {
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
    console.log(pc.dim(`Ponlos al día con ${pc.cyan('keel-spring build <ruta> --refresh')}.`));
  }
}
