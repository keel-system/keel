// El modelo intermedio del scaffolding de keel-spring.
//
// La interpretación del diseño es NEUTRAL y vive en keel-core/gen: la comparte cualquier generador,
// y es lo que hace que dos servidores del mismo diseño nazcan del mismo modelo. Aquí solo se le
// pasa la proyección Java (java-projection.js) y se reexporta lo que el scaffolding ya importaba
// de este módulo.

import { buildModel as interpretDesign } from 'keel-core/gen/model';
import { JAVA_PROJECTION } from './java-projection.js';

export {
  versionedRouteBase,
  auditPolicies,
  normalizeIndexes,
  accessAuthority,
  RECONCILIATION_BATCH_SIZE,
  reconciliationClaimTimeoutMs
} from 'keel-core/gen/model';
export { sharedExceptionFor, UUID_V7_CALL } from './java-projection.js';

export function buildModel({ manifest, layers, stack = null }) {
  return interpretDesign({ manifest, layers, stack, projection: JAVA_PROJECTION });
}
