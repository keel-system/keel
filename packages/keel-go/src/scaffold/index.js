// Orquestador del scaffolding determinista de keel-go: construye el modelo desde el diseño validado y
// renderiza todos los artefactos en services/<servicio>-go/.
//
// El modelo es el MISMO que el de keel-spring, keel-nest y keel-dotnet (`buildModel` de keel-core/gen) con la
// proyección Go, y la escritura es la misma (`materializeProject`): lo único de este paquete son los
// renderizadores de abajo.

import path from 'node:path';
import { buildModel } from '@keel-system/keel-core/gen/model';
import { materializeProject } from '@keel-system/keel-core/gen/materialize';
import { resolveStack } from '@keel-system/keel-core/gen/stack';
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
import * as dtos from './dtos.js';
import * as services from './services.js';
import * as mappers from './mappers.js';
import * as useCases from './use-cases.js';
import * as persistence from './persistence.js';
import * as persistenceRuntime from './persistence-runtime.js';
import * as repositories from './repositories.js';
import * as requestIdempotency from './request-idempotency.js';
import * as messaging from './messaging.js';
import * as messagingStores from './messaging-stores.js';
import * as rabbitmq from './rabbitmq.js';
import * as kafka from './kafka.js';
import * as correlation from './correlation.js';
import * as endpoints from './endpoints.js';
import * as restSupport from './rest-support.js';
import * as security from './security.js';
import * as apiTests from './api-tests.js';
import * as httpapi from './httpapi.js';
import * as server from './server.js';
import * as architecture from './architecture.js';
import * as infra from './infra.js';
import * as integrationTests from './integration-tests.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara. El primero es el contrato formal de
// la API, derivado del modelo neutral (el mismo en los cuatro generadores), salvo que el workspace traiga el de
// /keel-docs: keel-core/gen/openapi.js.
const GENERATORS = [
  { generate: derivedOpenapiFiles },
  project,
  config,
  health,
  correlation,
  wire,
  errors,
  enums,
  valueTypes,
  entities,
  events,
  domainGuardsCheck,
  dtos,
  services,
  mappers,
  useCases,
  persistence,
  persistenceRuntime,
  repositories,
  requestIdempotency,
  messaging,
  messagingStores,
  rabbitmq,
  kafka,
  endpoints,
  restSupport,
  security,
  apiTests,
  httpapi,
  server,
  architecture,
  infra,
  integrationTests,
  readme,
  generatorDocs
];

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el modelo con sus avisos
 * y el árbol de archivos ya renderizado en memoria. Lo comparten `build` (para escribir) y `check` (para no
 * escribir): si se duplicara, las dos pasadas opinarían distinto del mismo diseño.
 */
export function planService({ manifest, layers, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers);
  const model = buildModel({ manifest, layers, stack: resolved, projection: GO_PROJECTION });
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
    ...written
  };
}
