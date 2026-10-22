import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateDoc } from './schema.js';

// Lectura del sandbox de un legacy: `sandbox.yaml` (el contrato con el juez), el compose que
// declara y los runtime.yaml / environment.yaml de los pasos 0a-0b. No arranca nada.

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * `{ dir, file, spec, compose, composeFile, runtime, environment, errors }`. Un error aquí no es
 * un criterio del juez sino un sandbox que no se puede juzgar: verify sale antes de mirar nada.
 */
export function loadSandbox(target) {
  const abs = path.resolve(target);
  const file = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'sandbox.yaml') : abs;
  const dir = path.dirname(file);
  const out = { dir, file, spec: null, compose: null, composeFile: null, runtime: null, environment: null, errors: [] };
  if (!fs.existsSync(file)) {
    out.errors.push(`no existe ${file}`);
    return out;
  }
  try {
    out.spec = readYaml(file);
  } catch (err) {
    out.errors.push(`sandbox.yaml no es YAML: ${err.message}`);
    return out;
  }
  const schemaErrors = validateDoc(out.spec ?? {});
  if (schemaErrors.length) {
    out.errors.push(...schemaErrors.map((e) => `sandbox.yaml: ${e}`));
    return out;
  }
  out.composeFile = path.resolve(dir, out.spec.compose);
  try {
    out.compose = readYaml(out.composeFile);
  } catch (err) {
    out.errors.push(`${out.spec.compose}: ${err.code === 'ENOENT' ? 'no existe' : err.message}`);
    return out;
  }
  for (const [key, fallback] of [
    ['runtime', '../runtime.yaml'],
    ['environment', '../environment.yaml'],
  ]) {
    const p = path.resolve(dir, out.spec[key] ?? fallback);
    if (fs.existsSync(p)) {
      try {
        out[key] = readYaml(p);
      } catch {
        out.errors.push(`${path.relative(dir, p)} no es YAML`);
      }
    }
  }
  return out;
}

/** Nombre del proyecto compose: el `name:` del archivo o, si no lo trae, el del directorio. */
export function composeProject(sandbox) {
  return sandbox.compose.name ?? path.basename(sandbox.dir);
}

/** Contenedor de un servicio: su `container_name` (obligatorio para los que el juez usa). */
export function containerOf(sandbox, service) {
  return sandbox.compose.services?.[service]?.container_name ?? null;
}
