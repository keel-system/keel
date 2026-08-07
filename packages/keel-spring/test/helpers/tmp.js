// Fuente única: el helper vive en keel-core (mismo monorepo, paquetes hermanos).
// Este shim solo le da a los tests de spring una ruta de import estable.
export { tmpDir, rawTmpdirUsages } from '../../../keel-core/test/helpers/tmp.js';
