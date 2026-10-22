import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace } from 'keel-core';
import { planInit, writePlan } from '../lib/init.js';

/** `keel-recover init <repo>`: prepara legacy/<servicio>/ y siembra la skill del sandbox. */
export function init(repo, options) {
  const workspace = path.resolve(options.workspace ?? '.');
  if (!isKeelWorkspace(workspace)) {
    console.error(pc.red(`✗ ${workspace} no es un workspace de diseño de Keel (keel init)`));
    process.exit(1);
  }
  let plan;
  try {
    plan = planInit({ workspace, repo, name: options.name });
  } catch (err) {
    console.error(pc.red(`✗ ${err.message}`));
    process.exit(1);
  }
  writePlan(workspace, plan.files);
  for (const f of plan.files) console.log(`${pc.green('✓')} ${f.path}`);
  if (plan.unsupported) {
    console.error(pc.yellow(`! ${plan.unsupported}`));
    process.exit(2);
  }
  console.log(`\nSiguiente: /keel-recover-sandbox ${plan.base} (Dockerfile, compose, bucles de build y arranque) y, al final, keel-recover verify ${plan.base}/sandbox`);
}
