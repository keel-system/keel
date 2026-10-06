// Orquestador del scaffolding determinista: construye el modelo desde el
// diseño validado y renderiza todos los artefactos en services/<name>-spring/.
// Regeneración segura: sin force solo se escriben archivos que no existen.

import path from 'node:path';
import { buildModel } from '../lib/model.js';
import { materializeProject } from 'keel-core/gen/materialize';
import { resolveStack as resolveNeutralStack } from 'keel-core/gen/stack';
import { listKeelDocs } from '../lib/keel-docs.js';
import { packageVersion } from '../lib/assets.js';
import { checkGatewaySupport } from '../lib/gateway-support.js';
import { defaultGroup } from '../lib/naming.js';
import * as gradle from './gradle.js';
import * as wrapper from './wrapper.js';
import * as application from './application.js';
import * as appTests from './app-tests.js';
import * as integrationTests from './integration-tests.js';
import * as config from './config.js';
import * as migrations from './migrations.js';
import * as engineLimits from './engine-limits.js';
import * as docker from './docker.js';
import * as deploy from './deploy.js';
import * as observabilityAssets from './observability-assets.js';
import * as authProvisioning from './auth-provisioning.js';
import * as mediator from './mediator.js';
import * as logging from './logging.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as ids from './ids.js';
import * as embeddables from './embeddables.js';
import * as persistenceEntities from './persistence-entities.js';
import * as auditing from './auditing.js';
import * as exceptions from './exceptions.js';
import { warnUnsupportedDialect } from './claim.js';
import * as repositories from './repositories.js';
import * as dtos from './dtos.js';
import * as mappers from './mappers.js';
import * as refResolvers from './ref-resolvers.js';
import * as events from './events.js';
import * as correlation from './correlation.js';
import * as telemetry from './telemetry.js';
import * as concurrency from './concurrency.js';
import * as messaging from './messaging.js';
import * as deadLetterConfig from './dead-letter-config.js';
import * as outbox from './outbox.js';
import * as idempotency from './idempotency.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import * as httpIdempotency from './http-idempotency.js';
import * as purge from './purge.js';
import * as idempotencyCheck from './idempotency-check.js';
import * as domainGuardsCheck from './domain-guards-check.js';
import * as loggingCheck from './logging-check.js';
import * as telemetryGate from './telemetry-gate.js';
import * as cache from './cache.js';
import * as scheduling from './scheduling.js';
import * as jackson from './jackson.js';
import * as controllers from './controllers.js';
import * as web from './web.js';
import * as security from './security.js';
import * as httpClients from './http-clients.js';
import * as lastKnown from './last-known.js';
import * as dependencies from './dependencies.js';
import * as storage from './storage.js';
import * as serviceParameters from './service-parameters.js';
import * as mail from './mail.js';
import * as payments from './payments.js';
import * as services from './services.js';
import * as readme from './readme.js';
import * as contextMd from './context-md.js';
import * as generatorDocs from './generator-docs.js';
import * as documentEntities from './document-entities.js';
import * as documentEmbeddables from './document-embeddables.js';
import * as documentRepositories from './document-repositories.js';
import * as documentIndexes from './document-indexes.js';
import * as documentConfig from './document-config.js';
import * as textFold from './text-fold.js';

const GENERATORS = [
  gradle,
  wrapper,
  application,
  appTests,
  integrationTests,
  config,
  migrations,
  docker,
  deploy,
  // El panel y las alertas del backend de prueba: se gatea a si mismo por telemetria.
  observabilityAssets,
  authProvisioning,
  mediator,
  logging,
  enums,
  valueTypes,
  entities,
  // El helper de ids UUID v7 con el que nacen las raíces (ver ids.js).
  ids,
  embeddables,
  persistenceEntities,
  // Rama documental de la persistencia: cada uno se gatea a sí mismo por
  // model.persistenceKind, igual que sus gemelos relacionales de arriba.
  documentEmbeddables,
  documentEntities,
  documentIndexes,
  documentConfig,
  // La función de plegado de la sombra de un campo con `compare` (DSL 2.14): la usan
  // los adaptadores de las DOS ramas, así que se gatea por el diseño y no por el modelo.
  textFold,
  auditing,
  exceptions,
  repositories,
  documentRepositories,
  dtos,
  mappers,
  refResolvers,
  events,
  correlation,
  // Solo con `telemetry: otel`: se gatea a sí mismo, como los documentales.
  telemetry,
  // El executor que propaga el contexto a las tareas paralelas: con y sin telemetría.
  concurrency,
  messaging,
  deadLetterConfig,
  outbox,
  idempotency,
  // La tabla del reclamo del barrido de reconciliación. Va con las demás tablas del
  // generador (outbox, processed_event, idempotency_record) porque es de la misma
  // familia: mecánica de multi-instancia, no algo que el diseño declare.
  reconciliationClaim,
  httpIdempotency,
  // La purga POR LOTES que comparten las cuatro tablas de arriba en la rama relacional.
  purge,
  cache,
  // El TaskScheduler de hilos de plataforma. Va junto a los mecanismos de arriba porque
  // sirve a todos: los @Scheduled que emiten outbox, idempotency, reconciliationClaim y el
  // <Servicio>Scheduler comparten scheduler, y con hilos virtuales el que pone Boot los
  // deja clavados en el driver JDBC.
  scheduling,
  jackson,
  controllers,
  web,
  security,
  httpClients,
  // Después de httpClients: su almacén lo inyectan los adaptadores que genera aquel.
  lastKnown,
  dependencies,
  storage,
  serviceParameters,
  mail,
  // La pasarela de pago: el puerto, el adaptador de la elegida y el aviso con su firma.
  payments,
  services,
  // Después de services: su matriz cita clases que los generadores de arriba nombran,
  // aunque el script solo las busque en tiempo de ejecución.
  idempotencyCheck,
  domainGuardsCheck,
  loggingCheck,
  telemetryGate,
  readme,
  contextMd,
  generatorDocs,
  engineLimits
];

// Normaliza el stack: defaults para lo que el diseño necesita y no fue elegido
// (p. ej. tests o scaffolding sin cuestionario), null para lo que no aplica. La normalización es
// neutral (keel-core/gen/stack.js); lo de Java es el grupo, que va delante.
export function resolveStack(stack, layers, manifest) {
  return { group: stack?.group ?? defaultGroup(manifest), ...resolveNeutralStack(stack, layers) };
}

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el
 * modelo con sus avisos y el árbol de archivos ya renderizado en memoria.
 *
 * Existe aparte porque hay dos consumidores con intenciones distintas. `scaffoldService`
 * lo usa para escribir; `keel-spring check` lo usa para no escribir — y el valor de esa
 * segunda pasada es justo lo que esta función incluye: `buildModel` cosecha en
 * `model.warnings` las familias cuya causa raíz está en el DISEÑO (el rescate sin reloj,
 * la reconciliación con dos entidades esperando, la llamada sin method/path), y
 * `generate()` revienta si una plantilla no cuadra. Las dos cosas se descubrían solo al
 * generar, o sea con el diseño ya dado por cerrado y el stack ya elegido.
 *
 * No lee nada del proyecto generado —ni manifiesto, ni digests— a propósito: eso es
 * estado del destino, y aquí todavía no hay destino.
 */
export function planService({ manifest, layers, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers, manifest);
  // La pasarela elegida tiene que cubrir lo que el diseño exige (gateway-support.js). Se
  // comprueba aquí y no solo en build para que NINGÚN camino genere un adaptador a medias.
  if (resolved.paymentGateway) {
    const { errors } = checkGatewaySupport(layers, resolved.paymentGateway);
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
  const model = buildModel({ manifest, layers, stack: resolved });
  model.stack = resolved;
  // Contratos de /keel-docs presentes en el workspace: el README los enlaza y
  // build.js los copia a docs/ del proyecto (la copia no pasa por writeFiles
  // aquí porque se refresca siempre, al margen de --force).
  model.docs = listKeelDocs(workspace, model.service.name);
  // El motor elegido puede no repartir candidatos entre réplicas. No impide generar
  // —el reclamo sigue siendo correcto— pero el diseñador tiene que saberlo antes de
  // desplegar replicado, que es lo único que hace un barrido.
  warnUnsupportedDialect(model);
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

  // Qué se escribe, qué se deja al lado como conflicto, qué se poda y cómo queda el registro: es
  // la misma decisión para cualquier generador y vive en keel-core/gen/materialize.js.
  const written = materializeProject({
    files,
    projectDir,
    generator: `keel-spring@${packageVersion()}`,
    force,
    mode,
    prune,
    readiness,
    acceptedUnready
  });

  return {
    outDir: outDir.split(path.sep).join('/'),
    copied: written.copied,
    skipped: written.skipped,
    warnings: model.warnings,
    stack: model.stack,
    docs: model.docs,
    buckets: written.buckets,
    huerfanosVivos: written.huerfanosVivos,
    pruned: written.pruned,
    pendingMerge: written.pendingMerge,
    nuevosConTodo: written.nuevosConTodo
  };
}
