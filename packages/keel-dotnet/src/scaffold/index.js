// Orquestador del scaffolding determinista de keel-dotnet: construye el modelo desde el diseño validado y
// renderiza todos los artefactos en services/<servicio>-dotnet/.
//
// El modelo es el MISMO que el de keel-spring y keel-nest (`buildModel` de keel-core/gen) con la
// proyección C#, y la escritura es la misma (`materializeProject`): lo único de este paquete son los
// renderizadores de abajo.

import path from 'node:path';
import { buildModel } from 'keel-core/gen/model';
import { materializeProject } from 'keel-core/gen/materialize';
import { resolveStack } from 'keel-core/gen/stack';
import { checkGatewaySupport } from 'keel-core/gen/payment-gateways';
import { listKeelDocs } from 'keel-core/gen/keel-docs';
import { derivedOpenapiFiles } from 'keel-core/gen/openapi';
import { packageVersion } from '../lib/assets.js';
import { CS_PROJECTION } from '../lib/cs-projection.js';
import * as project from './project.js';
import * as config from './config.js';
import * as health from './health.js';
import * as logging from './logging.js';
import * as telemetry from './telemetry.js';
import * as telemetryTests from './telemetry-tests.js';
import * as observabilityAssets from './observability-assets.js';
import * as deploy from './deploy.js';
import * as loggingCheck from './logging-check.js';
import * as telemetryGate from './telemetry-gate.js';
import * as wire from './wire.js';
import * as enums from './enums.js';
import * as exceptions from './exceptions.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as events from './events.js';
import * as dtos from './dtos.js';
import * as mappers from './mappers.js';
import * as services from './services.js';
import * as mediator from './mediator.js';
import * as persistence from './persistence.js';
import * as persistenceRuntime from './persistence-runtime.js';
import * as documentPersistence from './document-persistence.js';
import * as repositories from './repositories.js';
import * as claim from './claim.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import * as requestIdempotency from './request-idempotency.js';
import * as httpClients from './http-clients.js';
import * as mail from './mail.js';
import * as payments from './payments.js';
import * as cache from './cache.js';
import * as storage from './storage.js';
import * as projections from './projections.js';
import * as refResolvers from './ref-resolvers.js';
import * as afterCommit from './after-commit.js';
import * as messaging from './messaging.js';
import * as messagingStores from './messaging-stores.js';
import * as rabbitmq from './rabbitmq.js';
import * as kafka from './kafka.js';
import * as snssqs from './snssqs.js';
import * as messagingTests from './messaging-tests.js';
import * as serviceParameters from './service-parameters.js';
import * as purge from './purge.js';
import * as scheduling from './scheduling.js';
import * as schedulingTests from './scheduling-tests.js';
import * as security from './security.js';
import * as domainGuardsCheck from './domain-guards-check.js';
import * as idempotencyCheck from './idempotency-check.js';
import * as restSupport from './rest-support.js';
import * as endpoints from './endpoints.js';
import * as api from './api.js';
import * as apiTests from './api-tests.js';
import * as tests from './tests.js';
import * as testCredential from './test-credential.js';
import * as infra from './infra.js';
import * as integrationTests from './integration-tests.js';
import * as schemaBaseline from './schema-baseline.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara. El primero es el contrato formal
// de la API, derivado del modelo neutral (el mismo en los tres generadores), salvo que el workspace traiga el de
// /keel-docs: keel-core/gen/openapi.js.
const GENERATORS = [{ generate: derivedOpenapiFiles }, project, config, health, logging, telemetry, telemetryTests, wire, serviceParameters, enums, exceptions, valueTypes, entities, events, domainGuardsCheck, idempotencyCheck, dtos, mappers, services, mediator, persistence, persistenceRuntime, documentPersistence, afterCommit, repositories, claim, reconciliationClaim, requestIdempotency, httpClients, mail, payments, cache, storage, projections, refResolvers, messaging, messagingStores, rabbitmq, kafka, snssqs, messagingTests, purge, scheduling, schedulingTests, security, restSupport, endpoints, api, tests, testCredential, apiTests, infra, integrationTests, schemaBaseline, observabilityAssets, deploy, loggingCheck, telemetryGate, readme, generatorDocs];

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el modelo con sus
 * avisos y el árbol de archivos ya renderizado en memoria. Lo comparten `build` (para escribir) y `check`
 * (para no escribir): si se duplicara, las dos pasadas opinarían distinto del mismo diseño.
 */
export function planService({ manifest, layers, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers);
  // La pasarela elegida tiene que cubrir lo que el diseño exige (la matriz neutral de keel-core). Aquí y no solo en build,
  // para que NINGÚN camino genere un adaptador a medias. La misma puerta que keel-spring y keel-nest.
  if (resolved.paymentGateway) {
    const { errors } = checkGatewaySupport(layers, resolved.paymentGateway);
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
  const model = buildModel({ manifest, layers, stack: resolved, projection: CS_PROJECTION });
  model.stack = resolved;
  // Contratos de /keel-docs presentes en el workspace: build los copia a docs/ del proyecto.
  model.docs = listKeelDocs(workspace, model.service.name);
  return { model, stack: resolved, files: GENERATORS.flatMap((generator) => generator.generate(model)) };
}

export function scaffoldService({
  manifest,
  layers,
  workspace,
  force = false,
  stack = null,
  mode = null,
  prune = false,
  readiness = null,
  acceptedUnready = false
}) {
  const { model, files } = planService({ manifest, layers, workspace, stack });
  const outDir = path.join('services', model.service.projectName);
  const projectDir = path.join(workspace, outDir);
  const written = materializeProject({
    files,
    projectDir,
    generator: `keel-dotnet@${packageVersion()}`,
    force,
    mode,
    prune,
    readiness,
    acceptedUnready
  });
  return {
    outDir: outDir.split(path.sep).join('/'),
    projectDir,
    warnings: model.warnings,
    stack: model.stack,
    docs: model.docs,
    ...written
  };
}
