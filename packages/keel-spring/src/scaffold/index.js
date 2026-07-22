// Orquestador del scaffolding determinista: construye el modelo desde el
// diseño validado y renderiza todos los artefactos en services/<name>-spring/.
// Regeneración segura: sin force solo se escriben archivos que no existen.

import path from 'node:path';
import { buildModel } from '../lib/model.js';
import { writeFiles } from '../lib/writer.js';
import { STACK_DEFAULTS } from '../lib/stack-catalog.js';
import { designUsesCache } from '../lib/stack-config.js';
import { defaultGroup } from '../lib/naming.js';
import * as gradle from './gradle.js';
import * as wrapper from './wrapper.js';
import * as application from './application.js';
import * as appTests from './app-tests.js';
import * as config from './config.js';
import * as docker from './docker.js';
import * as mediator from './mediator.js';
import * as logging from './logging.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as persistenceEntities from './persistence-entities.js';
import * as exceptions from './exceptions.js';
import * as repositories from './repositories.js';
import * as dtos from './dtos.js';
import * as mappers from './mappers.js';
import * as events from './events.js';
import * as messaging from './messaging.js';
import * as controllers from './controllers.js';
import * as security from './security.js';
import * as httpClients from './http-clients.js';
import * as storage from './storage.js';
import * as services from './services.js';
import * as readme from './readme.js';

const GENERATORS = [
  gradle,
  wrapper,
  application,
  appTests,
  config,
  docker,
  mediator,
  logging,
  enums,
  valueTypes,
  entities,
  persistenceEntities,
  exceptions,
  repositories,
  dtos,
  mappers,
  events,
  messaging,
  controllers,
  security,
  httpClients,
  storage,
  services,
  readme
];

// Normaliza el stack: defaults para lo que el diseño necesita y no fue elegido
// (p. ej. tests o scaffolding sin cuestionario), null para lo que no aplica.
export function resolveStack(stack, layers, manifest) {
  const protocol = layers.security?.authentication?.protocol;
  return {
    group: stack?.group ?? defaultGroup(manifest),
    database: layers.persistence ? (stack?.database ?? STACK_DEFAULTS.database) : null,
    broker: layers.messaging ? (stack?.broker ?? STACK_DEFAULTS.broker) : null,
    auth: protocol === 'oidc' || protocol === 'jwt' ? (stack?.auth ?? STACK_DEFAULTS.auth) : null,
    cache: designUsesCache(layers) ? (stack?.cache ?? STACK_DEFAULTS.cache) : null,
    storage: layers.storage ? (stack?.storage ?? STACK_DEFAULTS.storage) : null
  };
}

export function scaffoldService({ manifest, layers, workspace, force = false, stack = null }) {
  const resolved = resolveStack(stack, layers, manifest);
  const model = buildModel({ manifest, layers, stack: resolved });
  model.stack = resolved;
  const outDir = path.join('services', model.service.projectName);

  const files = GENERATORS.flatMap((generator) => generator.generate(model));
  const { copied, skipped } = writeFiles(files, path.join(workspace, outDir), { force });

  return {
    outDir: outDir.split(path.sep).join('/'),
    copied,
    skipped,
    warnings: model.warnings,
    stack: model.stack
  };
}
