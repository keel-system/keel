// El modelo intermedio del scaffolding de keel-spring.
//
// La interpretación del diseño es NEUTRAL y vive en keel-core/gen: la comparte cualquier generador,
// y es lo que hace que dos servidores del mismo diseño nazcan del mismo modelo. Aquí solo se le
// pasa la proyección Java (java-projection.js) y se reexporta lo que el scaffolding ya importaba
// de este módulo.

import { buildModel as interpretDesign } from '@keel-system/keel-core/gen/model';
import { JAVA_PROJECTION } from './java-projection.js';

export {
  versionedRouteBase,
  auditPolicies,
  normalizeIndexes,
  accessAuthority,
  RECONCILIATION_BATCH_SIZE,
  reconciliationClaimTimeoutMs
} from '@keel-system/keel-core/gen/model';
export { sharedExceptionFor, UUID_V7_CALL, LONG_ID_CALL } from './java-projection.js';

export function buildModel({ manifest, layers, stack = null }) {
  const model = interpretDesign({ manifest, layers, stack, projection: JAVA_PROJECTION });
  for (const operation of model.services.flatMap((service) => service.operations)) {
    if (operation.batch) shapeBatchOperation(operation);
  }
  return model;
}

/**
 * Una operación por lotes (DSL 2.30) en Java: su handler procesa UN elemento, así que devuelve lo que `batch.output`
 * declara para cada elemento —`<Op>ItemResult`, un DTO más— y su mensaje es un ReturningCommand. El output de la
 * operación es void (CHK-USECASES-BATCH-OUTPUT): la respuesta HTTP es la de BatchResponse (scaffold/batch.js).
 */
function shapeBatchOperation(operation) {
  const { resultFields } = operation.batch;
  if (resultFields.length === 0) return;
  const name = `${operation.name[0].toUpperCase()}${operation.name.slice(1)}ItemResult`;
  operation.responseDto = { name, fields: resultFields, description: `Lo que devuelve cada elemento del lote ${operation.name} que sale bien.` };
  operation.messageKind = 'returningCommand';
}
