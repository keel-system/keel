import pc from 'picocolors';
import { gateDesign } from 'keel-core/gen/design-gate';
import { readDesignGaps } from 'keel-core/gen/design-gaps';
import { SUPPORTED_DSL } from '../lib/assets.js';
import { checkSupportedFeatures } from '../lib/supported-features.js';
import { planService } from '../scaffold/index.js';
import { gatewayCoverage } from 'keel-core/gen/payment-gateways';
import { PAYMENT_GATEWAYS } from 'keel-core/gen/infra-catalog';

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
  let notices = features.warnings.length + plan.model.warnings.length;
  console.log();
  console.log(pc.bold('Traducción a código'));
  if (plan.model.warnings.length === 0) console.log(pc.dim(`  Sin avisos del modelo. ${plan.files.length} archivos se generarían.`));
  for (const message of plan.model.warnings) console.log(`  ${pc.yellow('•')} ${message}`);

  // Con capa payments, qué pasarelas del catálogo pueden servir este diseño: la portabilidad del diseño de un vistazo
  // (la matriz neutral de keel-core, la misma que enseña keel-spring check).
  if (layers.payments) {
    console.log();
    console.log(pc.bold('Pasarelas de pago'));
    const coverage = gatewayCoverage(layers, Object.keys(PAYMENT_GATEWAYS));
    for (const entry of coverage) {
      const verdict = entry.errors.length === 0 ? pc.green('✔') : pc.red('✘');
      console.log(`  ${verdict} ${entry.id}${entry.errors.length === 0 && entry.warnings.length > 0 ? pc.dim(` — ${entry.warnings.length} sin verificar`) : ''}`);
      for (const message of entry.errors) console.log(`    ${pc.red('•')} ${message}`);
      for (const message of entry.warnings) console.log(`    ${pc.yellow('•')} ${message}`);
      notices += entry.warnings.length;
    }
  }

  // Lo que la última generación encontró y vuelve al diseñador: el design-gaps.yaml que el pipeline
  // escribe en services/<servicio>-nest/. Son avisos, no bloqueos: propuestas sobre el diseño.
  const gaps = readDesignGaps(workspace, manifest, 'nest');
  if (gaps.entries.length > 0 || gaps.error) {
    console.log();
    console.log(pc.bold('Huecos que reportó la generación'));
    if (gaps.error) {
      console.log(`  ${pc.yellow('•')} ${gaps.error}`);
      notices += 1;
    }
    if (gaps.stale) {
      console.log(pc.dim(`  Son de la v${gaps.version} y el diseño va por v${manifest.service?.version}: reléelos antes de darlos por vigentes.`));
    }
    if (gaps.design && gaps.design.ready === false) {
      console.log(
        pc.dim(
          `  El build que los produjo partió de un diseño no listo (v${gaps.design.version}, faltaban: ${gaps.design.missing.join(', ')}): pueden ser del diseño y no del método.`
        )
      );
    }
    for (const gap of gaps.entries) {
      console.log(`  ${pc.yellow('•')} ${pc.cyan(gap.unit ? `${gap.layer}.${gap.unit}` : gap.layer)} [${gap.kind}] ${gap.proposal}`);
      notices += 1;
    }
  }

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
