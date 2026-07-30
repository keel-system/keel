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
export { copyTree, diffTree } from './lib/copy.js';
