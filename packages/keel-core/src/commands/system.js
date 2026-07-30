import pc from 'picocolors';
import { isKeelWorkspace } from '../lib/assets.js';
import { SYSTEM_FILE, buildSystemPlan, renderPlanTable } from '../lib/system-map.js';

/**
 * Muestra el mapa del sistema: olas de construcción, estado real de cada
 * servicio y el mapa de contextos. No escribe nada: la prosa (SYSTEM.md y los
 * briefs) la produce /keel-decompose.
 */
export function showSystem({ json = false } = {}) {
  const plan = load();
  if (!plan) return;

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(pc.bold(plan.system.name) + pc.dim(` — ${plan.system.description}`));
  if (plan.system.tdr) console.log(pc.dim(`Encargo: ${plan.system.tdr}`));
  console.log();
  console.log(renderPlanTable(plan));

  const contexts = plan.edges;
  if (contexts.length > 0) {
    console.log();
    console.log(pc.bold('Mapa de contextos'));
    for (const edge of contexts) {
      const detail = [edge.kind, edge.strategy, edge.blocking ? null : 'no bloqueante'].filter(Boolean).join(', ');
      console.log(`  ${edge.to} ${pc.dim('←')} ${edge.from} ${pc.dim(`(${detail})`)}: ${edge.what.join(', ')}`);
    }
  }

  const next = plan.services.filter((service) => !service.external && service.status === 'absent' && !service.blockedBy);
  if (next.length > 0) {
    console.log();
    console.log(pc.bold('Se pueden diseñar ya'));
    for (const service of next) {
      const create = service.derivedFrom
        ? `keel new ${service.name} --from registry:${service.derivedFrom}`
        : `keel new ${service.name}`;
      console.log(`  ${create} && /keel-design specs/${service.name}`);
    }
  }

  report(plan.findings);
  if (plan.findings.length > 0) {
    console.log();
    console.log(pc.dim('Detalle y puerta de CI: `keel system check`.'));
  }
}

/**
 * Contrasta el mapa con los diseños reales. Es la única comprobación
 * cross-servicio del método: `keel validate` no puede ver más allá de un
 * servicio. Cualquier hallazgo pone el comando en rojo — igual que en
 * `keel index --check`, un mapa que no coincide con los diseños es un mapa que
 * miente, y da lo mismo si miente por error o por quedarse atrás.
 */
export function checkSystem() {
  const plan = load();
  if (!plan) return;

  const designed = plan.services.filter((service) => service.status === 'designed').length;
  const total = plan.services.filter((service) => !service.external).length;

  if (plan.findings.length === 0) {
    console.log(
      pc.green(`✔ El mapa coincide con los diseños`) +
        pc.dim(` — ${designed}/${total} diseñados en ${plural(plan.waves.length, 'ola', 'olas')}`)
    );
    return;
  }

  report(plan.findings);
  console.log();
  console.error(
    pc.red(`✘ ${plural(plan.findings.length, 'hallazgo', 'hallazgos')} entre el mapa y los diseños.`)
  );
  process.exitCode = 1;
}

function load() {
  const cwd = process.cwd();
  if (!isKeelWorkspace(cwd)) {
    console.error(pc.red('Este directorio no es un workspace Keel. Ejecuta primero: keel init'));
    process.exitCode = 1;
    return null;
  }

  const plan = buildSystemPlan(cwd);
  if (!plan.exists) {
    console.error(pc.red(`No existe ${SYSTEM_FILE} en la raíz del workspace: este workspace no tiene mapa de sistema.`));
    console.error(
      pc.dim('  Un encargo que se reparte en varios servicios se descompone primero con `/keel-decompose`,\n') +
        pc.dim('  que entrevista el documento de requisitos y escribe el mapa. Un workspace de un solo\n') +
        pc.dim('  servicio no necesita mapa: se diseña directo con `/keel-design`.')
    );
    process.exitCode = 1;
    return null;
  }
  if (!plan.system) {
    for (const finding of plan.findings) console.error(pc.red(`✘ ${finding.message}`));
    process.exitCode = 1;
    return null;
  }
  return plan;
}

function report(findings) {
  if (findings.length === 0) return;
  const errors = findings.filter((finding) => finding.level === 'error');
  const warnings = findings.filter((finding) => finding.level === 'warning');

  if (errors.length > 0) {
    console.log();
    console.error(pc.bold(pc.red(`${plural(errors.length, 'error', 'errores')}:`)));
    for (const finding of errors) console.error(`  ${pc.red('✘')} ${finding.message}`);
  }
  if (warnings.length > 0) {
    console.log();
    console.error(pc.bold(pc.yellow(`${plural(warnings.length, 'aviso', 'avisos')}:`)));
    for (const finding of warnings) console.error(`  ${pc.yellow('⚠')} ${finding.message}`);
  }
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
