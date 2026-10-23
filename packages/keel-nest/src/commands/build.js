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
  normalizeTelemetry
} from 'keel-core/gen/stack';
import { writeProjectFiles } from 'keel-core/gen/project-writer';
import { writeSpecsSeal } from 'keel-core/gen/specs-seal';
import { REFRESH_DIR } from 'keel-core/gen/generated-manifest';
import { SKILL, SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures, checkSupportedStack } from '../lib/supported-features.js';
import { scaffoldService } from '../scaffold/index.js';
import { checkGatewaySupport } from 'keel-core/gen/payment-gateways';
import {
  EVOLUTION_MD,
  checkFails,
  designDelta,
  evolveStack,
  persistEvolution,
  planEvolution,
  reportEvolution,
  reportGeneratorDrift
} from 'keel-core/gen/evolution';
import { NEST_EVOLUTION } from '../scaffold/evolution.js';

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
  const { dir, manifest, layers, fixtures, readiness } = gate;

  // Stack: keel-stack.json del proyecto manda; si no existe, cuestionario condicionado por las
  // capas del diseño (o defaults). Una categoría que el diseño empezó a pedir se pregunta sola.
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-nest`);
  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  let stackChanges = { added: [], removed: [] };
  if (stack) {
    // El diseño pudo EVOLUCIONAR bajo el stack persistido (keel-core/gen/evolution.js, igual que
    // keel-spring): lo nuevo se pregunta (solo eso), lo que dejó de aplicar se anula, y los dos
    // cambios llegan a EVOLUTION.md.
    const evolved = await evolveStack({
      stack,
      layers,
      mode,
      telemetry,
      ask: (only) => askStackConfig(manifest, layers, { defaults, only })
    });
    stack = evolved.stack;
    stackChanges = evolved.changes;
    if (evolved.changed && mode !== 'check') stackIsNew = true;
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

  // La pasarela elegida contra lo que el diseño exige (la matriz neutral de keel-core), antes de escribir nada: una
  // capacidad que no cubre no se genera, y una sin verificar se avisa. Lo mismo que keel-spring.
  if (layers.payments) {
    const gateway = stack?.paymentGateway ?? null;
    const support = gateway ? checkGatewaySupport(layers, gateway) : { errors: [], warnings: [] };
    for (const message of support.warnings) console.warn(`${pc.yellow('⚠')} ${message}`);
    if (support.errors.length > 0) {
      console.error(pc.bold(pc.red(`✘ La pasarela '${gateway}' no cubre lo que el diseño exige — ${support.errors.length}:`)));
      for (const message of support.errors) console.error(`  ${pc.red('•')} ${message}`);
      console.error(pc.dim('  Elige otra pasarela (borra paymentGateway de keel-stack.json) o quita la capacidad del diseño.'));
      process.exitCode = 1;
      return;
    }
  }

  // El delta del diseño, ANTES de refrescar el snapshot: contra la base congelada de una evolución
  // sin cerrar o, si no, contra el snapshot, que es el diseño desde el que se completó el proyecto.
  const design = designDelta(projectDir, dir);

  const acceptedUnready = acceptUnready && !readiness.ready;
  const scaffold = scaffoldService({ manifest, layers, fixtures, workspace, force, stack, mode, prune, readiness, acceptedUnready });
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
  reportGeneratorDrift(scaffold, mode, { generator: 'keel-nest' });

  // El traspaso al pipeline cuando el proyecto ya existía y algo cambió (el diseño, el stack o el
  // generador). En la primera generación no hay nada que evolucionar.
  const evolution = planEvolution({ design, manifest, scaffold, stackChanges, mode, prune, projectDir });
  reportEvolution(evolution, scaffold.outDir, mode);

  if (mode === 'check') {
    if (checkFails(scaffold, evolution)) process.exitCode = 1;
    return;
  }

  // La base se congela la primera vez que el diseño cambia, ANTES de refrescar el snapshot: si no,
  // un segundo build compararía el diseño consigo mismo.
  persistEvolution(evolution, design, projectDir, NEST_EVOLUTION);

  // Snapshot del diseño y su sello: el proyecto es autosuficiente, y el snapshot se refresca
  // siempre porque el canónico es specs/<servicio> del workspace.
  const snapshot = copyTree(dir, design.snapshotDir, { force: true });
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
  2. ${pc.cyan('npm install')}
  3. ${pc.cyan(`/${SKILL}`)} ${pc.dim('(sin argumentos: completa el código y lo valida contra los escenarios FL-*)')}`);
  if (evolution?.pending) {
    console.log(
      pc.dim(
        `Como hay ${REFRESH_DIR}/${EVOLUTION_MD}, la skill entra en modo evolución: trabaja sobre lo que cambió y ` +
          'puntúa la suite completa como no-regresión.'
      )
    );
  }
}
