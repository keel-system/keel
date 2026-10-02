import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { resolveServiceRef } from '../lib/loader.js';
import { SCENARIOS_FILE } from '../lib/spec-files.js';
import { flowSeals, renderFlowSeals } from '../lib/flow-review.js';

/**
 * Imprime los sellos del careo de un diseño, listos para flow-review.yaml. Solo lee: el archivo lo
 * escribe el agente de careo (keel-flow-review), que es quien sabe qué careó.
 */
export function seals(ref, { json = false } = {}) {
  const resolved = resolveServiceRef(ref);
  if (resolved.error) {
    console.error(pc.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const file = path.join(resolved.dir, SCENARIOS_FILE);
  if (!fs.existsSync(file)) {
    console.error(pc.red(`No hay ${SCENARIOS_FILE} en ${resolved.dir}: no hay nada que sellar.`));
    process.exitCode = 1;
    return;
  }
  const result = flowSeals(fs.readFileSync(file, 'utf8'));
  console.log(json ? JSON.stringify(result, null, 2) : renderFlowSeals(result));
}
