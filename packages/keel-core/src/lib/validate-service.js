import fs from 'node:fs';
import path from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { LAYERS, schemaPathFor } from './assets.js';
import { MANIFEST_FILE, loadService } from './loader.js';
import { checkCrossRefs } from './crossrefs.js';
import { loadDecisions, resolveObligations } from './decisions.js';
import { loadReviews, resolveReviews } from './review-state.js';
import { applicableReviews } from './reviews.js';
import { SCENARIOS_FILE } from './spec-files.js';
import { checkFor } from './checks.js';
import { checkDerivedCoherence } from './derived-coherence.js';
import { FLOW_REVIEW_FILE, MAX_PASSES, flowReviewPlan } from './flow-review.js';

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
  dependencies: {
    hint: 'no declara ninguna dependencia',
    isTemplate: (doc) => isEmptyCollection(doc?.dependencies)
  },
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

// El único derivado que la validación mecánica mira. No es una capa del DSL —es prosa—,
// pero hay una obligación que solo se puede comprobar cruzándolo con el diseño: que cada
// compensación tenga sus dos escenarios. Su AUSENCIA no se reporta aquí: que el diseño
// esté cerrado sin escenarios es cosa de /keel-validate, y a mitad de diseño el archivo
// no existe todavía. null significa «no hay documento que cruzar», no «documento vacío».

function readScenarios(dir) {
  try {
    return fs.readFileSync(path.join(dir, SCENARIOS_FILE), 'utf8');
  } catch {
    return null;
  }
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
 *     pending,           // strings: plantillas/placeholders (+ pendientes cross-ref en wip)
 *     obligations        // { open, accepted, stale, orphans, errors } — decisiones con id
 *   }
 *
 * Las obligaciones son el canal que separa «esto está roto» de «esto está sin decidir». Una
 * abierta bloquea igual que un error, porque su desenlace es el mismo —alguien decidirá por el
 * diseño, más tarde y sin dejar rastro— y porque cerrarla es barato: declararla en el DSL, o
 * aceptarla por escrito en decisions.yaml. Con `wip` no bloquean: a mitad de diseño lo normal es
 * tenerlas todas abiertas.
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
    findings: [],
    pending: [],
    obligations: { open: [], accepted: [], stale: [], orphans: [], errors: [] },
    reviews: { covered: [], missing: [], open: [], accepted: [], stale: false, reviewedAt: null, orphans: [], errors: [] }
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
  const {
    errors,
    warnings,
    findings,
    pending: crossRefPending,
    obligations: raised
  } = checkCrossRefs({
    layers: effectiveLayers,
    wip,
    scenarios: readScenarios(dir),
    manifest
  });
  result.crossRefErrors = errors;
  result.warnings = warnings;
  // Los hallazgos CON id: lo que permite citar una comprobación sin depender de su
  // redacción. Lo consume el cruce diseño↔generación de keel-spring.
  result.findings = findings;
  result.pending.push(...crossRefPending);

  // Contratos derivados (`docs/<servicio>/` del workspace): su CONTENIDO contra el diseño.
  // Solo si el servicio vive en `specs/<servicio>` de un workspace — fuera de ahí no hay docs
  // que buscar y adivinar la raíz sería inventarla.
  const docsDir = workspaceDocsDir(dir, manifest);
  if (docsDir) {
    const derived = checkDerivedCoherence({ layers: effectiveLayers, manifest, docsDir, scenarios: readScenarios(dir) });
    for (const finding of derived.findings) {
      result.findings.push(finding);
      result.warnings.push(finding.message);
    }
  }

  // El careo de flujos (keel-flow-review): que exista, que sea de ESTOS escenarios y que no
  // deje hallazgos sin decidir. Solo cuando hay escenarios que carear.
  const flowReview = flowReviewFinding(dir);
  if (flowReview) {
    result.findings.push(flowReview);
    result.warnings.push(flowReview.message);
  }

  // Capa 3: las decisiones que el diseño abrió, cruzadas con el registro que las acepta.
  const { doc, errors: decisionErrors } = loadDecisions(dir);
  result.obligations = resolveObligations(raised, doc, manifest?.service?.version);
  result.obligations.errors.unshift(...decisionErrors);

  const obligationsBlock =
    result.obligations.open.length > 0 ||
    result.obligations.stale.length > 0 ||
    result.obligations.errors.length > 0;

  // Capa 4: la revisión semántica, cruzada con el catálogo de lo que le toca a este
  // diseño. Es lo que distingue un diseño revisado de uno del que nadie miró la mitad:
  // sin veredicto escrito, las dos cosas se escriben igual.
  //
  // Bloquea SOLO por un veredicto `open` o por un error de formato. Lo que falta por
  // revisar (`missing`) y la revisión caducada (`stale`) se reportan y no bloquean —
  // todavía. Poner eso en rojo el primer día dejaría en rojo todos los diseños que ya
  // existen, incluidas las fixtures que son sujeto de las redes en vivo del generador, y
  // un gate que aparece ya roto se aprende a ignorar. Se aprieta cuando los diseños
  // tengan su `review.yaml`; un hallazgo ABIERTO, en cambio, es un hallazgo abierto desde
  // el primer minuto.
  const { doc: reviewDoc, errors: reviewErrors } = loadReviews(dir);
  result.reviews = resolveReviews(applicableReviews(effectiveLayers), reviewDoc, manifest?.service?.version);
  result.reviews.errors.unshift(...reviewErrors);

  const reviewsBlock = result.reviews.open.length > 0 || result.reviews.errors.length > 0;

  result.ok = errors.length === 0 && (wip || (!obligationsBlock && !reviewsBlock));
  return result;
}

/** `docs/<servicio>/` del workspace cuando el diseño vive en `specs/<servicio>/`; null si no. */
function workspaceDocsDir(dir, manifest) {
  const absolute = path.resolve(dir);
  if (path.basename(path.dirname(absolute)) !== 'specs') return null;
  const name = manifest?.service?.name ?? path.basename(absolute);
  return path.join(path.dirname(path.dirname(absolute)), 'docs', name);
}

function flowReviewFinding(dir) {
  const scenariosPath = path.join(dir, SCENARIOS_FILE);
  if (!fs.existsSync(scenariosPath)) return null;
  const plan = flowReviewPlan(dir, fs.readFileSync(scenariosPath));
  if (plan.status === 'ok') return null;

  // El mensaje dice QUÉ hacer, y son dos cosas distintas: carear (y cuánto) o decidir. Con una
  // sola redacción, el careo se relanza entero cada vez que alguien toca una coma — que es el
  // bucle que este presupuesto existe para cortar.
  const alcance = plan.full ? 'todos los flujos' : plan.scope.join(', ');
  const message = {
    missing: `${FLOW_REVIEW_FILE}: no hay careo de flujos — ningún agente de contexto limpio ha ejecutado los escenarios contra el diseño; lánzalo con keel-flow-review (paso 5b de /keel-design), pasada 1 de ${MAX_PASSES}`,
    invalid: `${FLOW_REVIEW_FILE}: ${plan.detail}`,
    stale: `${FLOW_REVIEW_FILE}: el careo no describe los escenarios de ahora — recarea ${alcance} con keel-flow-review (pasada ${plan.nextPass} de ${MAX_PASSES}). ${plan.detail}`,
    open: `${FLOW_REVIEW_FILE}: ${plan.detail} — cada uno se cierra en el escenario, en el diseño o aceptándolo con su motivo`,
    exhausted:
      `${FLOW_REVIEW_FILE}: ${plan.detail}. NO lances otra pasada: decide lo que queda (scenario, design o accepted con su motivo). ` +
      `Si siguen apareciendo contradicciones de clases nuevas, lo que dice el careo es que el diseño no está listo para cerrarse`
  }[plan.status];

  const id = plan.status === 'exhausted' ? 'CHK-SCEN-FLOW-REVIEW-EXHAUSTED' : 'CHK-SCEN-FLOW-REVIEW-STALE';
  return { id, severity: checkFor(id).severity, message };
}
