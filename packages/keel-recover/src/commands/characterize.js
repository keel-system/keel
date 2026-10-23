import path from 'node:path';
import pc from 'picocolors';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { runCharacterization, tally } from '../lib/characterize.js';
import { legacyContext, prepareCharacterization, verifyGate, writeCharacterization } from '../lib/characterize-legacy.js';

// Paso 5: `keel-recover characterize legacy/<servicio>`. Ejecuta los flujos keep, fix y frontier de
// specs/<servicio>/validation-scenarios.md contra el sandbox en verde y escribe el sello, las
// grabaciones y FIDELITY.md. Sale en rojo con cualquier flujo en rojo.

export async function characterize(legacyArg, options) {
  const prep = prepareCharacterization(legacyArg, { spec: options.spec });
  if (prep.errors.length) {
    for (const e of prep.errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const gate = verifyGate(prep);
  if (!gate.ok) {
    console.error(pc.red(`✗ ${gate.id}  ${gate.detail}`));
    process.exit(1);
  }
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ hace falta podman o docker en marcha'));
    process.exit(2);
  }
  const only = options.only ? new Set(String(options.only).split(',')) : null;
  const planned = only ? prep.planned.filter((p) => only.has(p.id)) : prep.planned;
  const ctx = legacyContext(prep, containerRuntime(runtime), { snapshotHash: gate.snapshotHash });
  const pre = ctx.preflight();
  if (!pre.ok) {
    console.error(pc.red(`✗ ${pre.error}`));
    process.exit(1);
  }

  const records = await runCharacterization(ctx, planned, {
    log: (r) => console.log(`${r.ok ? pc.green('✓') : pc.red('✗')} ${r.id.padEnd(12)} ${r.mark.padEnd(8)}${r.ok ? '' : pc.red(`  ${r.failures[0]}`)}`),
  });
  // Con --only no hay sello ni informe: un sello parcial diría que lo no ejecutado no existe.
  const written = writeCharacterization(prep, records, { seal: !only, snapshotHash: gate.snapshotHash });

  const t = tally(records);
  console.log(`\nkeep ${t.keep.ok}/${t.keep.total} · fix ${t.fix.ok}/${t.fix.total} (el defecto sigue en el legacy) · frontier ${t.frontier.ok}/${t.frontier.total} · new ${prep.newFlows} (no aplica)`);
  for (const f of written.filter((w) => !w.includes(`${path.sep}characterization${path.sep}`))) console.log(pc.dim(`  ${path.relative(process.cwd(), f)}`));
  const ok = records.every((r) => r.ok);
  console.log(ok ? pc.green('\ncaracterización en verde') : pc.red('\ncaracterización en rojo: un keep en rojo se corrige en el diseño, no en el escenario'));
  process.exit(ok ? 0 : 1);
}
