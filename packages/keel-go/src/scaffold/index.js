// Orquestador del scaffolding determinista de keel-go: construye el modelo desde el diseño validado y
// renderiza todos los artefactos en services/<servicio>-go/.
//
// El modelo es el MISMO que el de keel-spring, keel-nest y keel-dotnet (`buildModel` de keel-core/gen) con la
// proyección Go, y la escritura es la misma (`materializeProject`): lo único de este paquete son los
// renderizadores de abajo.

import path from 'node:path';
import { buildModel } from '@keel-system/keel-core/gen/model';
import { materializeProject } from '@keel-system/keel-core/gen/materialize';
import { baselineChange } from './evolution.js';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
import { checkGatewaySupport } from '@keel-system/keel-core/gen/payment-gateways';
import { checkIdentitySupport } from '@keel-system/keel-core/gen/identity-support';
import { listKeelDocs } from '@keel-system/keel-core/gen/keel-docs';
import { derivedOpenapiFiles } from '@keel-system/keel-core/gen/openapi';
import { packageVersion } from '../lib/assets.js';
import { GO_PROJECTION } from '../lib/go-projection.js';
import { DIGEST_VIEWS } from '../lib/digest-views.js';
import * as project from './project.js';
import * as config from './config.js';
import * as health from './health.js';
import * as wire from './wire.js';
import * as errors from './errors.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as events from './events.js';
import * as domainGuardsCheck from './domain-guards-check.js';
import * as idempotencyCheck from './idempotency-check.js';
import * as conditionalWrites from './conditional-writes.js';
import * as readScope from './read-scope.js';
import * as optionalAuth from './optional-auth.js';
import { readScopeGenerationErrors } from '@keel-system/keel-core/gen/read-scope';
import * as dtos from './dtos.js';
import * as services from './services.js';
import * as mappers from './mappers.js';
import * as useCases from './use-cases.js';
import * as persistence from './persistence.js';
import * as persistenceRuntime from './persistence-runtime.js';
import * as repositories from './repositories.js';
import * as documentPersistence from './document-persistence.js';
import * as documentRepositories from './document-repositories.js';
import * as documentStores from './document-stores.js';
import * as auditActor from './audit-actor.js';
import * as serviceParameters from './service-parameters.js';
import * as httpClients from './http-clients.js';
import * as projections from './projections.js';
import * as mail from './mail.js';
import * as payments from './payments.js';
import * as cache from './cache.js';
import * as afterCommit from './after-commit.js';
import * as storage from './storage.js';
import * as claim from './claim.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import * as requestIdempotency from './request-idempotency.js';
import * as messaging from './messaging.js';
import * as messagingStores from './messaging-stores.js';
import * as rabbitmq from './rabbitmq.js';
import * as kafka from './kafka.js';
import * as snssqs from './snssqs.js';
import * as purge from './purge.js';
import * as scheduling from './scheduling.js';
import * as timer from './timer.js';
import * as dataLifecycle from './data-lifecycle.js';
import * as deadlinesCheck from './deadlines-check.js';
import * as correlation from './correlation.js';
import * as logging from './logging.js';
import * as telemetry from './telemetry.js';
import * as telemetryTests from './telemetry-tests.js';
import * as loggingCheck from './logging-check.js';
import * as telemetryGate from './telemetry-gate.js';
import * as observabilityAssets from './observability-assets.js';
import * as deploy from './deploy.js';
import * as endpoints from './endpoints.js';
import * as restSupport from './rest-support.js';
import * as security from './security.js';
import * as apiTests from './api-tests.js';
import * as tokenContractTest from './token-contract-test.js';
import * as httpapi from './httpapi.js';
import * as server from './server.js';
import * as architecture from './architecture.js';
import * as infra from './infra.js';
import * as integrationTests from './integration-tests.js';
import * as statementCount from './statement-count.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';
import * as longIds from './long-ids.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara. El primero es el contrato formal de
// la API, derivado del modelo neutral (el mismo en los cuatro generadores), salvo que el workspace traiga el de
// /keel-docs: keel-core/gen/openapi.js.
const GENERATORS = [
  { generate: derivedOpenapiFiles },
  project,
  config,
  health,
  correlation,
  logging,
  telemetry,
  telemetryTests,
  wire,
  errors,
  enums,
  valueTypes,
  longIds,
  entities,
  events,
  domainGuardsCheck,
  idempotencyCheck,
  // La escritura condicional (DSL 2.25): Versioned, la comparación, el borde, sus pruebas y el gate.
  conditionalWrites,
  readScope,
  // La identidad opcional (DSL 2.27, level: optional): su prueba emitida en el borde (OA-1 a OA-3).
  optionalAuth,
  dtos,
  services,
  mappers,
  useCases,
  persistence,
  persistenceRuntime,
  repositories,
  documentPersistence,
  documentRepositories,
  auditActor,
  documentStores,
  serviceParameters,
  httpClients,
  projections,
  mail,
  payments,
  cache,
  afterCommit,
  storage,
  claim,
  reconciliationClaim,
  requestIdempotency,
  messaging,
  messagingStores,
  rabbitmq,
  kafka,
  snssqs,
  purge,
  scheduling,
  // El cronómetro del servicio y los plazos de negocio (DSL 2.26): se gatea a sí mismo por el diseño.
  timer,
  dataLifecycle,
  endpoints,
  restSupport,
  security,
  apiTests,
  // El contrato con el token del proveedor de identidad (casos IDT-*).
  tokenContractTest,
  httpapi,
  server,
  architecture,
  infra,
  // El gate de los plazos (DSL 2.26): lo que el agente escribe para que caduquen de verdad.
  deadlinesCheck,
  loggingCheck,
  telemetryGate,
  observabilityAssets,
  deploy,
  statementCount,
  integrationTests,
  readme,
  generatorDocs
];

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el modelo con sus avisos
 * y el árbol de archivos ya renderizado en memoria. Lo comparten `build` (para escribir) y `check` (para no
 * escribir): si se duplicara, las dos pasadas opinarían distinto del mismo diseño.
 */
export function planService({ manifest, layers, fixtures = null, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers);
  // La pasarela elegida tiene que cubrir lo que el diseño exige (la matriz neutral de keel-core). Aquí y no solo en
  // build, para que NINGÚN camino genere un adaptador a medias. La misma puerta que los otros tres.
  if (resolved.paymentGateway) {
    const { errors } = checkGatewaySupport(layers, resolved.paymentGateway);
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
  // Y el proveedor de identidad, lo que el diseño lee del token (keel-core/gen/identity-support.js), con la misma razón.
  const identityErrors = checkIdentitySupport(layers, resolved.auth).errors;
  if (identityErrors.length > 0) throw new Error(identityErrors.join('\n'));
  const model = buildModel({ manifest, layers, stack: resolved, projection: GO_PROJECTION });
  model.stack = resolved;
  // El estado de partida de los escenarios (specs/<servicio>/fixtures.yaml): lo carga infra/reset-db.sh.
  model.fixtures = fixtures;
  // Contratos de /keel-docs presentes en el workspace: build los copia a docs/ del proyecto.
  model.docs = listKeelDocs(workspace, model.service.name);
  // Los plazos (DSL 2.26) necesitan un motor con las sentencias del cronómetro medidas: lo que depende del stack.
  const timerErrors = timer.timerStackErrors(model);
  if (timerErrors.length > 0) throw new Error(timerErrors.join('\n'));
  // El ciclo de vida del dato (DSL 2.28) que keel-go no sabe generar: lo que no sabe anonimizar.
  const lifecycleErrors = dataLifecycle.lifecycleStackErrors(model);
  if (lifecycleErrors.length > 0) throw new Error(lifecycleErrors.join('\n'));
  // La lectura acotada (DSL 2.27) que no se puede generar por construcción (T7, T8 y compañía): la frontera neutral.
  const scopeErrors = readScopeGenerationErrors(model);
  if (scopeErrors.length > 0) throw new Error(scopeErrors.join('\n'));
  return { model, stack: resolved, files: GENERATORS.flatMap((generator) => generator.generate(model)) };
}

export function scaffoldService({
  manifest,
  layers,
  fixtures = null,
  workspace,
  force = false,
  stack = null,
  mode = null,
  prune = false,
  readiness = null,
  acceptedUnready = false
}) {
  const { model, files } = planService({ manifest, layers, fixtures, workspace, stack });
  const outDir = path.join('services', model.service.projectName);
  const projectDir = path.join(workspace, outDir);
  // Los pasos de esquema de build: se deciden leyendo las migraciones de disco, así que van ANTES de escribir (en
  // keel-go build reescribe la baseline: la de disco es todavía la que aplicó la base desplegada).
  const schema = persistence.schemaSteps(model, projectDir);
  // Antes de escribir: después, el manifiesto ya registra la baseline nueva. Lo que ya crea el paso no es un cambio.
  const coveredBaseline = schema.tables.length > 0 ? persistence.baselineSql(model, { without: schema.tables }) : null;
  const schemaChange = baselineChange(files, projectDir, { coveredBaseline });
  const written = materializeProject({
    files: [...files, ...schema.files],
    projectDir,
    generator: `keel-go@${packageVersion()}`,
    force,
    mode,
    prune,
    readiness,
    acceptedUnready,
    // go.mod se compara sin lo que añade `go mod tidy`, el paso que el propio build prescribe.
    views: DIGEST_VIEWS
  });
  return {
    outDir: outDir.split(path.sep).join('/'),
    projectDir,
    warnings: model.warnings,
    stack: model.stack,
    docs: model.docs,
    schemaChange,
    ...written,
    schema: { added: schema.added, work: schema.work }
  };
}
