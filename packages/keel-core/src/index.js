// API pública de keel-core para los generadores (keel-spring, keel-nest, …).
// Los generadores validan diseños y copian sus assets a través de estas funciones;
// los schemas del DSL viajan dentro de este paquete (assets/core/schema).
export {
  CUSTOMIZABLE_PAYLOAD,
  LAYERS,
  REQUIRED_LAYERS,
  schemaDir,
  schemaPathFor,
  isKeelWorkspace,
  supportedDsl
} from './lib/assets.js';
export { MANIFEST_FILE, resolveServiceDir, resolveServiceRef, loadService } from './lib/loader.js';
export { validateService } from './lib/validate-service.js';
export { summarizeService } from './lib/summarize-service.js';
export { listDerivatives } from './lib/derivatives.js';
export {
  INDEX_FILE,
  INDEX_SCHEMA_VERSION,
  SIDECAR_FILE,
  applyMarkers,
  buildIndex,
  renderIndexJson,
  renderTable
} from './lib/design-index.js';
export { SYSTEM_FILE, buildSystemPlan, loadSystemMap, renderPlanTable } from './lib/system-map.js';
export {
  DEFAULT_REGISTRY_URL,
  REGISTRY_PREFIX,
  baseUrlOf,
  downloadDesign,
  dslMismatchMessage,
  dslSupport,
  findDesign,
  loadRegistryIndex,
  parseRegistryRef,
  resolveSourceUrl,
  searchDesigns
} from './lib/registry-source.js';
export { checkCrossRefs } from './lib/crossrefs.js';
// Los códigos que pone el framework cuando el diseño no nombra el conflicto de un mecanismo.
// Un generador los toma de aquí: escritos a mano en cada uno, cada generación elige el suyo.
export { FRAMEWORK_ERRORS, fixedFrameworkErrors, overrideFor } from './lib/framework-errors.js';
export { copyTree, diffTree } from './lib/copy.js';
// Harnesses de agente: un generador no debe saber si escribe .claude/ o .opencode/,
// solo pedir la proyección de sus skills y sus agentes.
export { HARNESSES, applyTokens, emitHarnessFiles, harnessById, harnessLabels, splitFrontmatter } from './lib/harness.js';
export { diffGenerated, writeFiles } from './lib/write.js';
