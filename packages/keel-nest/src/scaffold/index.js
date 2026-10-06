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
import * as health from './health.js';
import * as appTests from './app-tests.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara.
const GENERATORS = [project, config, wire, application, health, appTests, readme, generatorDocs];

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
