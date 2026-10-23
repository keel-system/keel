import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import YAML from 'yaml';
import { containerRuntime, resolveRuntime } from '../lib/containers.js';
import { deriveTarget } from '../lib/target.js';

/** `keel-recover target <proyecto>`: el target.yaml de la paridad, del deploy/ en marcha del proyecto generado. */
export function target(project, options) {
  const runtime = options.runtime ?? resolveRuntime();
  if (!runtime) {
    console.error(pc.red('✗ no hay podman ni docker en marcha'));
    process.exit(1);
  }
  const { doc, errors } = deriveTarget(project, { rt: containerRuntime(runtime) });
  if (!doc) {
    for (const e of errors) console.error(pc.red(`✗ ${e}`));
    process.exit(1);
  }
  const text = `# El servicio regenerado contra el que se mide la paridad. Lo escribe keel-recover target desde\n# ${doc.project}/deploy/ en marcha: no se edita a mano.\n${YAML.stringify(doc, { lineWidth: 0 })}`;
  if (!options.out) {
    process.stdout.write(text);
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, text);
  console.log(`${pc.green('✓')} ${options.out}`);
}
