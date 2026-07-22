import fs from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { LAYERS, schemaPathFor } from './assets.js';
import { MANIFEST_FILE, loadService } from './loader.js';
import { checkCrossRefs } from './crossrefs.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

function buildAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(schemaPathFor('common'), 'utf8')));
  return ajv;
}

function compileSchema(ajv, name) {
  return ajv.compile(JSON.parse(fs.readFileSync(schemaPathFor(name), 'utf8')));
}

function isEmptyCollection(value) {
  if (value == null) return true;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

// Capas cuyo contenido central sigue vacío tal como llegan de templates/service/ (todo comentado).
// api y security no aparecen: sus plantillas traen defaults utilizables (auto: true, access.default).
const TEMPLATE_CHECKS = {
  domain: { hint: 'no define ninguna entidad', isTemplate: (doc) => isEmptyCollection(doc?.entities) },
  'use-cases': { hint: 'no define ninguna operación', isTemplate: (doc) => isEmptyCollection(doc?.operations) },
  messaging: {
    hint: 'no define eventos publicados ni suscripciones',
    isTemplate: (doc) => isEmptyCollection(doc?.publishing?.events) && isEmptyCollection(doc?.subscriptions)
  },
  'http-clients': { hint: 'no define ningún cliente', isTemplate: (doc) => isEmptyCollection(doc?.clients) },
  persistence: { hint: 'no menciona ninguna entidad', isTemplate: (doc) => isEmptyCollection(doc?.entities) }
};

// Texto de description que sembraban las plantillas antes de la convención TODO.
const LEGACY_PLACEHOLDER_DESCRIPTION = 'Describe en una frase qué problema de negocio resuelve este servicio.';

function templateStateOf(layer, doc) {
  if (doc == null) return 'el archivo no declara contenido';
  const check = TEMPLATE_CHECKS[layer];
  return check && check.isTemplate(doc) ? check.hint : null;
}

function placeholderDescription(manifest) {
  const description = manifest?.service?.description;
  if (typeof description !== 'string') return false;
  const trimmed = description.trim();
  return /^TODO\b/i.test(trimmed) || trimmed === LEGACY_PLACEHOLDER_DESCRIPTION;
}

/**
 * Valida un servicio multi-artefacto sin efectos de consola ni exitCode.
 * Devuelve:
 *   {
 *     ok,                // true si el diseño es generable (con wip: sin errores duros)
 *     manifest, layers,
 *     loadErrors,        // strings: YAML/coherencia layers ↔ disco (o manifiesto 1.0)
 *     schemaErrors,      // [{ file, errors: <errores Ajv> }]
 *     crossRefErrors,    // strings (solo si schemas pasan)
 *     warnings,          // strings
 *     pending            // strings: plantillas/placeholders (+ pendientes cross-ref en wip)
 *   }
 */
export function validateService(dir, { wip = false } = {}) {
  const result = {
    ok: false,
    manifest: undefined,
    layers: {},
    loadErrors: [],
    schemaErrors: [],
    crossRefErrors: [],
    warnings: [],
    pending: []
  };

  const { manifest, layers, errors: loadErrors } = loadService(dir);
  result.loadErrors = loadErrors;
  if (!manifest) return result;
  result.manifest = manifest;
  result.layers = layers;

  // Capa 0: diseño incompleto — capas en estado plantilla y placeholders.
  // Sin wip son errores; con wip son pendientes esperables a mitad de diseño.
  const templateLayers = new Set();
  for (const layer of LAYERS) {
    if (!(layer in layers)) continue;
    const state = templateStateOf(layer, layers[layer]);
    if (state) {
      templateLayers.add(layer);
      result.pending.push(`${layer}.keel.yaml sigue siendo la plantilla: ${state} — continúa el diseño con /keel-design`);
    }
  }
  if (placeholderDescription(manifest)) {
    result.pending.push(`${MANIFEST_FILE}: service.description sigue siendo un placeholder — descríbelo en una frase real`);
  }

  // Capa 1: schemas por artefacto (las capas en plantilla ya están reportadas con un mensaje propio)
  const ajv = buildAjv();

  const checkManifest = compileSchema(ajv, 'service');
  if (!checkManifest(manifest)) {
    result.schemaErrors.push({ file: MANIFEST_FILE, errors: checkManifest.errors });
  }

  for (const layer of LAYERS) {
    if (!(layer in layers) || templateLayers.has(layer)) continue;
    const check = compileSchema(ajv, layer);
    if (!check(layers[layer])) {
      result.schemaErrors.push({ file: `${layer}.keel.yaml`, errors: check.errors });
    }
  }

  if (result.schemaErrors.length > 0 || loadErrors.length > 0 || (!wip && result.pending.length > 0)) {
    return result;
  }

  // Capa 2: referencias cruzadas mecánicas.
  // En modo wip las capas en plantilla se tratan como ausentes: sus referencias quedan pendientes, no rotas.
  const effectiveLayers = { ...layers };
  for (const layer of templateLayers) delete effectiveLayers[layer];
  const { errors, warnings, pending: crossRefPending } = checkCrossRefs({ layers: effectiveLayers, wip });
  result.crossRefErrors = errors;
  result.warnings = warnings;
  result.pending.push(...crossRefPending);

  result.ok = errors.length === 0;
  return result;
}
