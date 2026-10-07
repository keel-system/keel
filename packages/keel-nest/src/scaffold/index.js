// Orquestador del scaffolding determinista de keel-nest: construye el modelo desde el diseño
// validado y renderiza todos los artefactos en services/<name>-nest/.
//
// El modelo es el MISMO que el de keel-spring (`buildModel` de keel-core/gen) con la proyección
// TypeScript, y la escritura es la misma (`materializeProject`): lo único de este paquete son los
// renderizadores de abajo.

import path from 'node:path';
import { buildModel } from 'keel-core/gen/model';
import { materializeProject } from 'keel-core/gen/materialize';
import { resolveStack } from 'keel-core/gen/stack';
import { listKeelDocs } from 'keel-core/gen/keel-docs';
import { packageVersion } from '../lib/assets.js';
import { TS_PROJECTION } from '../lib/ts-projection.js';
import * as project from './project.js';
import * as config from './config.js';
import * as wire from './wire.js';
import * as application from './application.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as ids from './ids.js';
import * as events from './events.js';
import * as exceptions from './exceptions.js';
import * as dtos from './dtos.js';
import * as mappers from './mappers.js';
import * as services from './services.js';
import * as mediator from './mediator.js';
import * as persistenceEntities from './persistence-entities.js';
import * as repositories from './repositories.js';
import * as persistenceRuntime from './persistence-runtime.js';
import * as schemaBaseline from './schema-baseline.js';
import * as requestIdempotency from './request-idempotency.js';
import * as domainGuardsCheck from './domain-guards-check.js';
import * as architecture from './architecture.js';
import * as restSupport from './rest-support.js';
import * as controllers from './controllers.js';
import * as security from './security.js';
import * as testCredential from './test-credential.js';
import * as apiTests from './api-tests.js';
import * as health from './health.js';
import * as appTests from './app-tests.js';
import * as infra from './infra.js';
import * as integrationTests from './integration-tests.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara.
const GENERATORS = [
  project,
  // La frontera hexagonal, como regla ejecutable (npm run check:architecture).
  architecture,
  config,
  wire,
  application,
  health,
  // Dominio (incremento 4): TypeScript puro, sin Nest ni persistencia.
  enums,
  valueTypes,
  entities,
  ids,
  events,
  exceptions,
  // Aplicación: mensajes, handlers, DTOs y mappers; el mediator que los despacha y el módulo que
  // los cablea (este necesita saber qué mappers hay).
  dtos,
  mappers,
  services,
  // Persistencia relacional (incremento 6): las entidades TypeORM sobre el esquema neutral, los
  // puertos con sus adaptadores y el DataSource con su transacción.
  persistenceEntities,
  repositories,
  persistenceRuntime,
  // La idempotencia de petición: el registro, su firma y su contexto (la misma tabla que keel-spring).
  requestIdempotency,
  // El baseline de migraciones: cómo se exporta y cómo se demuestra (lo usa el pase de calidad).
  schemaBaseline,
  { generate: (model) => mediator.generate(model, { mappers: mappers.mapperClasses(model) }) },
  // API REST (incremento 5): correlación, ErrorResponse, lectura de peticiones, filtro de errores y
  // un controlador por grupo.
  restSupport,
  controllers,
  // La seguridad (incremento 8): el hook de la entrada HTTP con el plan de acceso neutral, el JWT, las
  // claves, CORS, la identidad del llamante y el alcance por recurso.
  security,
  // La credencial con la que las pruebas del perfil test pasan la autorización.
  testCredential,
  domainGuardsCheck,
  appTests,
  apiTests,
  // La infraestructura de prueba (neutral, keel-core/gen) y el arnés de integración que puntúa los
  // escenarios FL-* contra ella (incremento 7).
  infra,
  integrationTests,
  readme,
  generatorDocs
];

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el modelo con
 * sus avisos y el árbol de archivos ya renderizado en memoria. Lo comparten `build` (para escribir)
 * y `check` (para no escribir): si se duplicara, las dos pasadas opinarían distinto del mismo diseño.
 */
export function planService({ manifest, layers, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers);
  const model = buildModel({ manifest, layers, stack: resolved, projection: TS_PROJECTION });
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
    generator: `keel-nest@${packageVersion()}`,
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
