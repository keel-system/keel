import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const coreDir = path.join(packageRoot, 'assets', 'core');
export const schemaDir = path.join(coreDir, 'schema');
export const templatesDir = path.join(coreDir, 'templates', 'service');

// Capas del diseño 2.0. Cada capa vive en <capa>.keel.yaml y se valida con <capa>.schema.json.
export const LAYERS = ['domain', 'use-cases', 'api', 'security', 'messaging', 'http-clients', 'persistence', 'storage'];
export const REQUIRED_LAYERS = ['domain', 'use-cases'];

export function schemaPathFor(name) {
  return path.join(schemaDir, `${name}.schema.json`);
}

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}

// Generadores conocidos: cada uno es un paquete npm independiente con CLI propia.
// Se instalan con `npm i -g <paquete>` y se preparan con `<paquete> build specs/<servicio>`.
export const KNOWN_GENERATORS = {
  spring: 'keel-springboot'
};

export function isKeelWorkspace(dir) {
  return fs.existsSync(path.join(dir, 'schema', 'service.schema.json'));
}
