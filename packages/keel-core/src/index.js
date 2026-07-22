// API pública de keel-core para los generadores (keel-spring, keel-nest, …).
// Los generadores validan diseños y copian sus assets a través de estas funciones;
// los schemas del DSL viajan dentro de este paquete (assets/core/schema).
export { LAYERS, REQUIRED_LAYERS, schemaDir, schemaPathFor, isKeelWorkspace } from './lib/assets.js';
export { MANIFEST_FILE, resolveServiceDir, loadService } from './lib/loader.js';
export { validateService } from './lib/validate-service.js';
export { checkCrossRefs } from './lib/crossrefs.js';
export { copyTree } from './lib/copy.js';
