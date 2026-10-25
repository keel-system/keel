import pc from 'picocolors';
import { PHASES, recoveryStatus } from '../lib/status.js';

/** `keel-recover status <legacy>`: la fase siguiente de la recuperación, derivada de lo que hay en disco. */
export function status(legacy, options) {
  let result;
  try {
    result = recoveryStatus(legacy, { spec: options.spec });
  } catch (err) {
    console.error(pc.red(`✗ ${err.message}`));
    process.exit(1);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const index = PHASES.indexOf(result.phase);
  console.log(
    PHASES.map((phase, i) => (i < index ? pc.green(`✓ ${phase}`) : i === index ? pc.bold(pc.yellow(`→ ${phase}`)) : pc.dim(`  ${phase}`))).join('\n')
  );
  console.log(`\n${pc.bold(result.phase)}: ${result.reason}`);
  console.log(`siguiente: ${result.action}`);
  const pending = result.details?.pending ?? [];
  if (pending.length) {
    console.log(pc.yellow(`\n${pending.length} sonda(s) de clase que pide la superficie, sin grabar ni descartar (exploration.yaml → waived):`));
    for (const probe of pending) console.log(`  ${probe.key}: ${probe.why}`);
  }
  const hypotheses = result.details?.hypotheses ?? [];
  if (hypotheses.length) {
    console.log(pc.yellow(`\n${hypotheses.length} paso(s) con una expectativa del legacy leída del código (hypothesis): grábalos antes de caracterizar`));
    for (const h of hypotheses) console.log(`  ${h.id} paso ${h.step} (${h.op}): ${h.at}`);
  }
}
