import path from 'node:path';
import pc from 'picocolors';
import { copyTree } from '@keel-system/keel-core';
import { gateDesign } from '@keel-system/keel-core/gen/design-gate';
import { STACK_FILE, readStackConfig, writeStackConfig, askStackConfig, describeStack, normalizeTelemetry } from '@keel-system/keel-core/gen/stack';
import { writeProjectFiles } from '@keel-system/keel-core/gen/project-writer';
import { writeSpecsSeal } from '@keel-system/keel-core/gen/specs-seal';
import { checkFails, evolveStack, reportGeneratorDrift } from '@keel-system/keel-core/gen/evolution';
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

  // La puerta del diseño es la misma que la de keel-spring, keel-nest y keel-dotnet (keel-core/gen/design-gate.js): un
  // diseño que uno rechaza no lo genera otro, y uno no listo solo se genera a sabiendas.
  const gate = gateDesign({
    inputPath,
    workspace,
    generator: { name: 'keel-go', supportedDsl: SUPPORTED_DSL, checkSupportedFeatures },
    mode,
    acceptUnready
  });
  if (!gate) return;
  const { dir, manifest, layers, readiness } = gate;

  // Stack: keel-stack.json del proyecto manda; si no existe, cuestionario condicionado por las capas del
  // diseño (o defaults). Una categoría que el diseño empezó a pedir se pregunta sola (keel-core/gen/evolution.js).
  const projectDir = path.join(workspace, 'services', `${manifest.service?.name}-go`);
  let stack = readStackConfig(projectDir);
  let stackIsNew = false;
  if (stack) {
    const evolved = await evolveStack({
      stack,
      layers,
      mode,
      telemetry,
      ask: (only) => askStackConfig(manifest, layers, { defaults, only })
    });
    stack = evolved.stack;
    if (evolved.changed && mode !== 'check') stackIsNew = true;
  } else {
    stack = await askStackConfig(manifest, layers, { defaults, telemetry });
    stackIsNew = true;
  }

  // Lo que el stack pide y keel-go todavía no genera se rechaza antes de escribir nada.
  const stackSupport = checkSupportedStack(stack);
  if (stackSupport.errors.length > 0) {
    console.error(pc.bold(pc.red(`✘ El stack pide lo que keel-go todavía no genera — ${stackSupport.errors.length}:`)));
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
  reportGeneratorDrift(scaffold, mode, { generator: 'keel-go' });

  // La evolución del proyecto cuando cambia el diseño (EVOLUTION.md) llega en el incremento 15.
  if (mode === 'check') {
    if (checkFails(scaffold, null)) process.exitCode = 1;
    return;
  }

  // Snapshot del diseño y su sello: el proyecto es autosuficiente, y el snapshot se refresca siempre
  // porque el canónico es specs/<servicio> del workspace.
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
  2. ${pc.cyan('go mod tidy')} ${pc.dim('(la primera vez: resuelve las dependencias indirectas y escribe go.sum)')}
  3. ${pc.cyan('go test ./...')}

${pc.dim(`El pipeline de agentes de /${SKILL} llega en el incremento 7 de PLAN-KEEL-GO.md.`)}`);
}
