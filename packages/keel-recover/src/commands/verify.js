import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadSandbox, composeProject } from '../lib/sandbox.js';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { verify as judge } from '../lib/verify.js';

/**
 * `keel-recover verify <sandbox>`: el juez del paso 0f. Imprime cada criterio, escribe
 * `verify.json` junto a sandbox.yaml (lo que el paso 1 comprueba antes de sondear) y sale en
 * rojo si alguno falla. El sandbox se queda arriba: las sondas del paso 1 corren contra él.
 */
export async function verify(target, options) {
  const sandbox = loadSandbox(target ?? '.');
  if (sandbox.errors.length) {
    for (const e of sandbox.errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ verify necesita podman o docker en marcha'));
    process.exit(2);
  }
  const rt = containerRuntime(runtime);
  const report = await judge(sandbox, rt, {
    up: options.up !== false,
    snapshot: options.snapshot !== false,
    log: (c) => console.log(`${c.ok ? pc.green('✓') : c.skipped ? pc.dim('·') : pc.red('✗')} ${c.id}  ${c.detail}`),
  });
  if (report.snapshot) console.log(report.snapshot.ok ? `${pc.green('✓')} snapshot  ${report.snapshot.where}` : `${pc.red('✗')} snapshot  ${report.snapshot.error}`);
  if (options.write !== false) {
    fs.writeFileSync(path.join(sandbox.dir, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.down) rt.compose(sandbox.composeFile, composeProject(sandbox), ['down', '-v']);
  console.log(report.ok ? pc.green('\nsandbox en verde: lo que se grabe en él es comportamiento del legacy') : pc.red('\nsandbox en rojo: no se sondea'));
  process.exit(report.ok ? 0 : 1);
}
