import path from 'node:path';
import pc from 'picocolors';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { runCharacterization } from '../lib/characterize.js';
import { ensureTool, prepareParity, targetContext, writeParity } from '../lib/parity-target.js';

// Paso 7: `keel-recover parity legacy/<servicio> --target <target.yaml>`. Ejecuta los flujos contra el
// servicio regenerado (que el humano levantó con su deploy/), compara todos sus datos con los del legacy
// y escribe PARITY-<destino>.md. Sale en rojo con un keep, fix o new en rojo, con una diferencia de
// datos sin declarar o sin nada que comparar.

export async function parity(legacyArg, options) {
  const pp = prepareParity(legacyArg, { spec: options.spec, targetFile: options.target });
  if (pp.errors.length) {
    for (const e of pp.errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ hace falta podman o docker en marcha'));
    process.exit(2);
  }
  const rt = containerRuntime(runtime);
  const tool = ensureTool(rt, pp.target);
  if (!tool.ok) {
    console.error(pc.red(`✗ contenedor de herramientas: ${tool.error}`));
    process.exit(1);
  }
  try {
    const ctx = targetContext(pp.target, pp.prep.map, rt, { fixturesSql: pp.fixturesSql });
    const records = await runCharacterization(ctx, pp.planned, {
      log: (r) => console.log(`${r.ok ? pc.green('✓') : r.mark === 'frontier' ? pc.yellow('·') : pc.red('✗')} ${r.id.padEnd(12)} ${r.mark.padEnd(8)}${r.ok ? '' : `  ${r.failures[0]}`}`),
    });
    const { comparison, verdict, written } = writeParity(pp, records);
    console.log(`\n${comparison.compared} paso(s) comparados; ${comparison.rows.length} diferencia(s), ${comparison.undeclared.length} sin declarar`);
    for (const r of comparison.undeclared.slice(0, 20)) console.log(pc.red(`  ${r.kind.padEnd(14)} ${r.op.padEnd(20)} ${r.path}`));
    for (const f of written) console.log(pc.dim(`  ${path.relative(process.cwd(), f)}`));
    console.log(verdict.ok ? pc.green('\nparidad en verde') : pc.red(`\nparidad en rojo: ${verdict.reasons.join('; ')}`));
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    if (tool.created) rt.remove(pp.target.tool.container);
  }
}
