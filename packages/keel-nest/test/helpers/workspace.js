// Montar un workspace de diseño para los tests de keel-nest.
//
// Las fixtures son las MISMAS que usa keel-spring (fixtures/designs/ en la raíz del monorepo): el
// objetivo es que el mismo diseño genere servidores equivalentes con los dos generadores. Mientras
// la frontera de keel-nest no cubra una capa, los tests derivan de una fixture real el diseño que
// sí puede generar, quitando esas capas (`withoutLayers`), en vez de inventarse uno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.join(here, '..', '..', '..');
export const FIXTURES_DIR = path.join(repoRoot, 'fixtures', 'designs');

/** Un workspace Keel vacío: basta el marcador que comprueba `isKeelWorkspace`. */
export function makeWorkspace(prefix = 'keel-nest-') {
  const dir = tmpDir(prefix);
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}');
  return dir;
}

/**
 * Copia la fixture `name` a `specs/<name>` del workspace quitando `withoutLayers` del manifiesto y
 * de disco. Devuelve la ruta del diseño.
 */
export function mountDesign(workspace, name, { withoutLayers = [] } = {}) {
  const specDir = path.join(workspace, 'specs', name);
  fs.cpSync(path.join(FIXTURES_DIR, name), specDir, { recursive: true });
  const manifestFile = path.join(specDir, 'service.keel.yaml');
  let manifest = fs.readFileSync(manifestFile, 'utf8');
  for (const layer of withoutLayers) {
    const line = new RegExp(`^\\s*${layer}:\\s*(\\S+)\\s*$`, 'm');
    const match = manifest.match(line);
    if (!match) throw new Error(`${name} no declara la capa ${layer}`);
    fs.rmSync(path.join(specDir, match[1]));
    manifest = manifest.replace(line, '').replace(/\n{2,}$/, '\n');
  }
  fs.writeFileSync(manifestFile, manifest);
  return specDir;
}

/**
 * El diseño que keel-nest sabe generar entero hoy: product-catalog, con su persistencia relacional
 * (incremento 6). Es una fixture COMPLETA: dominio, casos de uso, API y persistencia.
 */
export const NEST_READY_DESIGN = { name: 'product-catalog', withoutLayers: [] };

/** Ejecuta un comando de la CLI en `workspace`, en silencio, y devuelve su exitCode y lo que imprimió. */
export async function runCommand(workspace, command, ...args) {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const output = [];
  console.log = console.warn = console.error = (...parts) => output.push(parts.join(' '));
  process.chdir(workspace);
  process.exitCode = undefined;
  try {
    await command(...args);
    return { exitCode: process.exitCode, output: output.join('\n') };
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    Object.assign(console, saved);
  }
}

/**
 * Un diseño FUERA de la frontera de keel-nest. Desde el incremento 13j todas las fixtures entran enteras, así que se
 * deriva uno de stock-reservation con lo único que keel-nest todavía rechaza: un value object compuesto en la
 * respuesta de una llamada saliente. Devuelve la ruta del diseño (specs/<nombre>).
 */
export async function mountOutsideFrontier(workspace) {
  const { parse, stringify } = await import('yaml');
  const name = 'stock-reservation';
  const specDir = mountDesign(workspace, name);
  const edit = (file, change) => {
    const target = path.join(specDir, file);
    const document = parse(fs.readFileSync(target, 'utf8'));
    change(document);
    fs.writeFileSync(target, stringify(document));
  };
  edit('domain.keel.yaml', (domain) => {
    domain.types = { ...(domain.types ?? {}), Refund: { description: 'Importe devuelto.', fields: { amount: { type: 'decimal' }, currency: { type: 'string' } } } };
  });
  edit('http-clients.keel.yaml', (layer) => {
    layer.clients.inventory.calls.cancelStock.response.fields.refund = { type: 'Refund' };
  });
  return `specs/${name}`;
}
