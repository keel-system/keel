// Montar un workspace de diseño para los tests de keel-go.
//
// Las fixtures son las MISMAS que usan keel-spring, keel-nest y keel-dotnet (fixtures/designs/ en la raíz del
// monorepo): el objetivo es que el mismo diseño genere servidores equivalentes con los cuatro generadores.
// Mientras la frontera de keel-go no cubra una capa, los tests derivan de una fixture real el diseño
// que sí puede generar, quitando esas capas (`withoutLayers`), en vez de inventarse uno.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.join(here, '..', '..', '..');
export const FIXTURES_DIR = path.join(repoRoot, 'fixtures', 'designs');

/** Un workspace Keel vacío: basta el marcador que comprueba `isKeelWorkspace`. */
export function makeWorkspace(prefix = 'keel-go-') {
  const dir = tmpDir(prefix);
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema', 'service.schema.json'), '{}');
  return dir;
}

/**
 * Copia la fixture `name` a `specs/<name>` del workspace quitando `withoutLayers` del manifiesto y de
 * disco. Devuelve la ruta del diseño.
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

/** El diseño que mide go-check: product-catalog entero, con su persistencia relacional (tramo 6b). */
export const GO_READY_DESIGN = { name: 'product-catalog', withoutLayers: [] };

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
 * Los diseños DERIVADOS de la autoría (tramo 13g): lo que ninguna fixture que keel-go genere declara. La política
 * `authorship: all` solo la declaran asset-vault (documental, fuera de la frontera por otras capas) y shop-api
 * (relacional); la autoría `declared`, ninguna. Son los MISMOS parches que mide keel-dotnet (`product-catalog-authorship`
 * en su db-check, `mailer-author` y `mailer-mongo-author` en UNCOVERED_BRANCHES), con otro nombre de servicio: cada
 * sujeto es su propio módulo. Los recorren go-syntax, go-check, db-check y doc-check.
 */
export const AUTHORSHIP_DESIGNS = [
  {
    name: 'product-catalog-authorship',
    from: 'product-catalog',
    mutate(manifest, layers) {
      manifest.service.name = 'product-catalog-authorship';
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'all' };
    }
  },
  ...[
    { name: 'mailer-author', from: 'notification-mailer' },
    { name: 'mailer-mongo-author', from: 'notification-mailer-mongo' }
  ].map(({ name, from }) => ({
    name,
    from,
    mutate(manifest, layers) {
      manifest.service.name = name;
      layers.persistence.audit = { ...(layers.persistence.audit ?? {}), authorship: 'declared' };
      for (const entity of ['Template', 'TemplateVariable']) {
        layers.domain.entities[entity].fields.createdBy = { type: 'string', generated: true };
        layers.domain.entities[entity].fields.updatedBy = { type: 'string', generated: true };
      }
    }
  }))
];
