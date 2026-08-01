import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const coreDir = path.join(packageRoot, 'assets', 'core');
// Fuente **neutral** de las skills del flujo de diseño: vive fuera de coreDir a
// propósito, porque no se copia — se proyecta a la convención de cada harness
// (ver lib/harness.js). Si estuviera dentro, copyTree la sembraría tal cual.
export const skillsSourceDir = path.join(packageRoot, 'assets', 'skills');
export const schemaDir = path.join(coreDir, 'schema');
export const templatesDir = path.join(coreDir, 'templates', 'service');

// Capas del diseño Keel. Cada capa vive en <capa>.keel.yaml y se valida con <capa>.schema.json.
// dependencies va tras messaging y http-clients: es una capa de síntesis y solo referencia hacia atrás.
export const LAYERS = ['domain', 'use-cases', 'api', 'security', 'messaging', 'http-clients', 'dependencies', 'persistence', 'storage'];
export const REQUIRED_LAYERS = ['domain', 'use-cases'];

export function schemaPathFor(name) {
  return path.join(schemaDir, `${name}.schema.json`);
}

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}

// Versiones del DSL que esta CLI entiende. NO se duplica como constante: es por
// definición el enum del schema del manifiesto, y una copia solo añadiría una
// forma nueva de desincronizarse. (Un generador sí declara su propia lista —ver
// SUPPORTED_DSL en keel-spring—, porque la suya es un subconjunto: lo que sabe
// mapear, que puede ir por detrás del DSL.)
let supportedDslCache;

export function supportedDsl() {
  if (supportedDslCache) return supportedDslCache;
  const schema = JSON.parse(fs.readFileSync(schemaPathFor('service'), 'utf8'));
  const versions = schema?.properties?.keel?.enum;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('service.schema.json no declara properties.keel.enum: no se puede saber qué DSL soporta esta CLI.');
  }
  supportedDslCache = Object.freeze([...versions]);
  return supportedDslCache;
}

/**
 * Archivos del payload que un workspace debe poder editar: la detección de
 * deriva (`keel init --check`) los ignora. La portada de un registry está
 * reescrita a propósito, y el contexto de agente de un workspace se adapta al
 * equipo. `AGENTS.md` es el que lleva el texto; `CLAUDE.md` lo importa en una
 * línea, y también es suyo: si el equipo prefiere separarlos, puede.
 */
export const CUSTOMIZABLE_PAYLOAD = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  '.gitattributes',
  'contracts/README.md'
];

// Generadores conocidos: cada uno es un paquete npm independiente con CLI propia.
// Se instalan con `npm i -g <paquete>` y se preparan con `<paquete> build specs/<servicio>`.
export const KNOWN_GENERATORS = {
  spring: 'keel-spring'
};

export function isKeelWorkspace(dir) {
  return fs.existsSync(path.join(dir, 'schema', 'service.schema.json'));
}
