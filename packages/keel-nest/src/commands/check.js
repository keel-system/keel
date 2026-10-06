import pc from 'picocolors';
import { gateDesign } from 'keel-core/gen/design-gate';
import { SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { planService } from '../scaffold/index.js';

/**
 * La pasada en seco: el mismo tronco que `build` —la puerta del diseño y `planService`— sin
 * escribir NADA, ni en el workspace ni en un proyecto. Dice si el diseño es generable con keel-nest
 * y qué avisos traería, antes de sembrar el proyecto.
 */
export function check(inputPath, { strict = false } = {}) {
  const workspace = process.cwd();
  const gate = gateDesign({
    inputPath,
    workspace,
    generator: { name: 'keel-nest', supportedDsl: SUPPORTED_DSL, checkSupportedFeatures },
    mode: 'check'
  });
  if (!gate) return;
  const { manifest, layers, readiness } = gate;

  let plan;
  try {
    plan = planService({ manifest, layers, workspace });
  } catch (error) {
    console.error(pc.red(`✘ keel-nest no puede construir el proyecto: ${error.message}`));
    process.exitCode = 1;
    return;
  }

  const features = checkSupportedFeatures(manifest, layers);
  const notices = features.warnings.length + plan.model.warnings.length;
  console.log();
  console.log(pc.bold('Traducción a código'));
  if (plan.model.warnings.length === 0) console.log(pc.dim(`  Sin avisos del modelo. ${plan.files.length} archivos se generarían.`));
  for (const message of plan.model.warnings) console.log(`  ${pc.yellow('•')} ${message}`);

  console.log();
  console.log(pc.bold('Resumen'));
  if (!readiness.ready) {
    const missing = readiness.criteria.filter((item) => !item.ok).length;
    console.log(pc.red(`  Generable, pero no listo: faltan ${missing} criterio(s) del cierre. build se negará salvo con --accept-unready.`));
    process.exitCode = 1;
    return;
  }
  if (notices > 0 && strict) {
    console.log(pc.red(`  ${notices} aviso(s), y --strict los trata como bloqueo.`));
    process.exitCode = 1;
    return;
  }
  console.log(notices > 0 ? pc.yellow(`  Factible con ${notices} aviso(s): léelos antes de generar.`) : pc.green('  Factible, sin avisos.'));
}
