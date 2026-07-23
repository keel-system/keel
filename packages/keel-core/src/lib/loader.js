import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LAYERS } from './assets.js';

export const MANIFEST_FILE = 'service.keel.yaml';
export const KEBAB_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Resuelve una referencia de servicio: un nombre kebab-case se busca como
 * specs/<nombre> bajo cwd; cualquier otra cosa se trata como ruta
 * (directorio del servicio o su manifiesto). Devuelve { dir } o { error }.
 */
export function resolveServiceRef(ref, cwd = process.cwd()) {
  if (KEBAB_NAME.test(ref)) {
    const dir = path.join(cwd, 'specs', ref);
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return { dir };
    if (!fs.existsSync(path.resolve(cwd, ref))) {
      return { error: `No existe specs/${ref} (o no contiene ${MANIFEST_FILE}).` };
    }
  }
  return resolveServiceDir(ref);
}

/**
 * Resuelve la ruta dada (directorio del servicio o ruta al manifiesto)
 * al directorio del servicio. Devuelve { dir } o { error }.
 */
export function resolveServiceDir(inputPath) {
  const resolved = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolved)) {
    return { error: `No existe la ruta: ${inputPath}` };
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(resolved, MANIFEST_FILE))) {
      return { error: `El directorio no contiene ${MANIFEST_FILE}: ${inputPath}` };
    }
    return { dir: resolved };
  }
  if (path.basename(resolved) === MANIFEST_FILE) {
    return { dir: path.dirname(resolved) };
  }
  return {
    error:
      `Ruta no reconocida: ${inputPath}\n` +
      `Pasa el directorio del servicio (specs/<servicio>) o su ${MANIFEST_FILE}.`
  };
}

/**
 * Carga el manifiesto y todas las capas declaradas.
 * Devuelve { manifest, layers: { <capa>: doc }, files: { <capa>: ruta }, errors: [..] }.
 * Los errores aquí son de carga (YAML, coherencia layers ↔ disco), no de schema.
 */
export function loadService(dir) {
  const errors = [];
  const layers = {};
  const files = {};

  const manifestPath = path.join(dir, MANIFEST_FILE);
  let manifest;
  try {
    manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { errors: [`${MANIFEST_FILE}: YAML inválido — ${error.message}`] };
  }

  if (manifest && typeof manifest.keel === 'string' && manifest.keel.startsWith('1.')) {
    return {
      errors: [
        `Este spec usa el DSL keel ${manifest.keel} (formato monolítico), no soportado desde keel 2.0.\n` +
          '  Divide el spec en artefactos por capa (specs/<servicio>/*.keel.yaml).\n' +
          '  Mapa de migración: docs/methodology.md'
      ]
    };
  }

  const declared = manifest?.layers && typeof manifest.layers === 'object' ? Object.keys(manifest.layers) : [];

  for (const layer of declared) {
    if (!LAYERS.includes(layer)) continue; // el schema del manifiesto reporta capas desconocidas
    const file = path.join(dir, `${layer}.keel.yaml`);
    if (!fs.existsSync(file)) {
      errors.push(`La capa '${layer}' está declarada en layers pero no existe ${layer}.keel.yaml`);
      continue;
    }
    files[layer] = file;
    try {
      layers[layer] = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${layer}.keel.yaml: YAML inválido — ${error.message}`);
    }
  }

  for (const layer of LAYERS) {
    if (!declared.includes(layer) && fs.existsSync(path.join(dir, `${layer}.keel.yaml`))) {
      errors.push(`Existe ${layer}.keel.yaml pero la capa '${layer}' no está declarada en layers del manifiesto`);
    }
  }

  return { manifest, layers, files, errors };
}
