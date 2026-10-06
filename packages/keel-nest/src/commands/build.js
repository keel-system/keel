import path from 'node:path';
import pc from 'picocolors';
import { copyTree } from 'keel-core';
import { gateDesign } from 'keel-core/gen/design-gate';
import {
  STACK_FILE,
  readStackConfig,
  writeStackConfig,
  askStackConfig,
  describeStack,
  stackDrift,
  normalizeTelemetry
} from 'keel-core/gen/stack';
import { writeProjectFiles } from 'keel-core/gen/project-writer';
import { writeSpecsSeal } from 'keel-core/gen/specs-seal';
import { REFRESH_DIR } from 'keel-core/gen/generated-manifest';
import { SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures, checkSupportedStack } from '../lib/supported-features.js';
import { scaffoldService } from '../scaffold/index.js';

export async function build(
  inputPath,
  { force = false, defaults = false, check = false, refresh = false, prune = false, telemetry = null, acceptUnready = false } = {}
) {
  // `check` gana a `refresh`: no escribir es la promesa más fuerte de las dos.
  const mode = check ? 'check' : refresh ? 'refresh' : null;
  const workspace = process.cwd();

  if (telemetry != null) {
    try {
      normalizeTelemetry(telemetry);
    } catch (error) {
      console.error(pc.red(error.message));
      process.exitCode = 1;
      return;
    }
  }
  if (prune && mode !== 'refresh') {
    console.error(pc.red('--prune solo se admite junto a --refresh (y nunca con --check, que no escribe).'));
    process.exitCode = 1;
    return;
  }

  // La puerta del diseño es la misma que la de keel-spring (keel-core/gen/design-gate.js): un
  // diseño que uno rechaza no lo genera el otro, y uno no listo solo se genera a sabiendas.
  const gate = gateDesign({
    inputPath,
    workspace,
    generator: { name: 'keel-nest', supportedDsl: SUPPORTED_DSL, checkSupportedFeatures },
    mode,
    acceptUnready
  });
  if (!gate) return;
  const { dir, manifest, layers, readiness } = gate;

  // Stack: keel-stack.json del proyecto manda; si no existe, cuestionario condicionado por las
  // capas del diseño (o defaults). Una categoría que el diseño empezó a pedir se pregunta sola.
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-nest`);
  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  if (stack) {
    const drift = stackDrift(stack, layers);
    if (mode !== 'check' && drift.missing.length + drift.stale.length > 0) {
      const answers = drift.missing.length > 0 ? await askStackConfig(manifest, layers, { defaults, only: drift.missing }) : {};
      stack = { ...stack };
      for (const category of drift.missing) stack[category] = answers[category] ?? null;
      for (const category of drift.stale) stack[category] = null;
      stackIsNew = true;
    }
    if (telemetry != null && mode !== 'check') {
      stack = { ...stack, telemetry };
      stackIsNew = true;
    }
    console.log();
    console.log(pc.dim(`Stack (${STACK_FILE}): ${describeStack(stack)}`));
  } else {
    stack = await askStackConfig(manifest, layers, { defaults, telemetry });
    stackIsNew = true;
  }

  // Lo que el stack pide y keel-nest todavía no genera se rechaza antes de escribir nada.
  const stackSupport = checkSupportedStack(stack);
  if (stackSupport.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ El stack pide lo que keel-nest todavía no genera — ${stackSupport.errors.length}:`)));
    for (const message of stackSupport.errors) console.error(`  ${pc.red('•')} ${message}`);
    process.exitCode = 1;
    return;
  }

  const acceptedUnready = acceptUnready && !readiness.ready;
  const scaffold = scaffoldService({ manifest, layers, workspace, force, stack, mode, prune, readiness, acceptedUnready });
  if (stackIsNew && mode !== 'check') {
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
        (scaffold.skipped.length > 0 ? ' (usa --refresh para poner al día lo del generador, o --force para sobrescribir)' : '')
    )
  );
  const behind = reportDrift(scaffold.buckets, mode);

  if (mode === 'check') {
    if (behind) process.exitCode = 1;
    return;
  }

  // Snapshot del diseño y su sello: el proyecto es autosuficiente, y el snapshot se refresca
  // siempre porque el canónico es specs/<servicio> del workspace.
  const snapshot = copyTree(dir, path.join(projectDir, 'specs'), { force: true });
  writeSpecsSeal(projectDir);
  console.log(pc.dim(`Snapshot del diseño → ${scaffold.outDir}/specs/ (${snapshot.copied.length} archivo(s), refrescado en cada build)`));

  if (scaffold.docs.files.length > 0) {
    const docs = writeProjectFiles(scaffold.docs.files, path.join(projectDir, 'docs'), { force: true });
    console.log(pc.dim(`Snapshot de los contratos → ${scaffold.outDir}/docs/ (${docs.copied.length} archivo(s))`));
  }

  console.log();
  console.log(pc.bold(pc.green('✔ Scaffolding generado.')) + pc.dim(` — ${manifest.service?.name} v${manifest.service?.version}`));
  console.log(`
Siguiente paso, dentro del proyecto:
  1. ${pc.cyan(`cd ${scaffold.outDir}`)}
  2. ${pc.cyan('npm install && npm run typecheck && npm test')}

${pc.dim(`El pipeline de agentes de /${SKILL} llega en el incremento 7 de PLAN-KEEL-NEST.md.`)}`);
}

/** Lo que se quedó atrás respecto al generador instalado. Devuelve si hay algo que poner al día. */
function reportDrift(buckets, mode) {
  const { refrescables, conflictos, retirados } = buckets;
  if (refrescables.length > 0) {
    console.log();
    const puestos = mode === 'refresh';
    console.log(
      pc.bold(
        puestos
          ? pc.green(`${refrescables.length} archivo(s) del generador puestos al día:`)
          : pc.yellow(`${refrescables.length} archivo(s) del generador se han quedado atrás (ponlos al día con --refresh):`)
      )
    );
    for (const file of refrescables) console.log(`  ${puestos ? pc.green('+') : pc.yellow('~')} ${file}`);
  }
  if (conflictos.length > 0) {
    console.log();
    console.log(pc.bold(pc.yellow(`${conflictos.length} archivo(s) en conflicto — los tocaste Y el generador cambió:`)));
    for (const file of conflictos) console.log(`  ${pc.yellow('!')} ${file}`);
    console.log(
      pc.dim(mode === 'refresh' ? `  La versión nueva queda en ${REFRESH_DIR}/. Ninguno se ha tocado.` : '  No se tocan: con --refresh se deja la versión nueva al lado.')
    );
  }
  if (retirados.length > 0) {
    console.log();
    console.log(pc.dim(`${retirados.length} archivo(s) que build escribió y ya no están: no se recrean (--force los devuelve): ${retirados.join(', ')}`));
  }
  if (mode === 'check' && refrescables.length + conflictos.length === 0) {
    console.log(pc.green('✔ El proyecto está al día con el generador instalado.'));
  }
  return refrescables.length + conflictos.length > 0;
}
