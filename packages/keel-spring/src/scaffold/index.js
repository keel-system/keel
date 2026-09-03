// Orquestador del scaffolding determinista: construye el modelo desde el
// diseño validado y renderiza todos los artefactos en services/<name>-spring/.
// Regeneración segura: sin force solo se escriben archivos que no existen.

import path from 'node:path';
import { buildModel } from '../lib/model.js';
import { classifyGenerated, digestOf } from 'keel-core';
import { writeFiles } from '../lib/writer.js';
import { readManifest, nextManifest, writeManifest, REFRESH_DIR } from '../lib/generated-manifest.js';
import { listKeelDocs } from '../lib/keel-docs.js';
import { packageVersion } from '../lib/assets.js';
import { DATABASES, STACK_DEFAULTS, defaultDatabaseFor } from '../lib/stack-catalog.js';
import { designUsesCache } from '../lib/stack-config.js';
import { defaultGroup } from '../lib/naming.js';
import * as gradle from './gradle.js';
import * as wrapper from './wrapper.js';
import * as application from './application.js';
import * as appTests from './app-tests.js';
import * as integrationTests from './integration-tests.js';
import * as config from './config.js';
import * as migrations from './migrations.js';
import * as docker from './docker.js';
import * as deploy from './deploy.js';
import * as authProvisioning from './auth-provisioning.js';
import * as mediator from './mediator.js';
import * as logging from './logging.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
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
import * as messaging from './messaging.js';
import * as deadLetterConfig from './dead-letter-config.js';
import * as outbox from './outbox.js';
import * as idempotency from './idempotency.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import * as httpIdempotency from './http-idempotency.js';
import * as idempotencyCheck from './idempotency-check.js';
import * as domainGuardsCheck from './domain-guards-check.js';
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
import * as mail from './mail.js';
import * as services from './services.js';
import * as readme from './readme.js';
import * as contextMd from './context-md.js';
import * as generatorDocs from './generator-docs.js';
import * as documentEntities from './document-entities.js';
import * as documentEmbeddables from './document-embeddables.js';
import * as documentRepositories from './document-repositories.js';
import * as documentIndexes from './document-indexes.js';
import * as documentConfig from './document-config.js';

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
  authProvisioning,
  mediator,
  logging,
  enums,
  valueTypes,
  entities,
  embeddables,
  persistenceEntities,
  // Rama documental de la persistencia: cada uno se gatea a sí mismo por
  // model.persistenceKind, igual que sus gemelos relacionales de arriba.
  documentEmbeddables,
  documentEntities,
  documentIndexes,
  documentConfig,
  auditing,
  exceptions,
  repositories,
  documentRepositories,
  dtos,
  mappers,
  refResolvers,
  events,
  correlation,
  messaging,
  deadLetterConfig,
  outbox,
  idempotency,
  // La tabla del reclamo del barrido de reconciliación. Va con las demás tablas del
  // generador (outbox, processed_event, idempotency_record) porque es de la misma
  // familia: mecánica de multi-instancia, no algo que el diseño declare.
  reconciliationClaim,
  httpIdempotency,
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
  mail,
  services,
  // Después de services: su matriz cita clases que los generadores de arriba nombran,
  // aunque el script solo las busque en tiempo de ejecución.
  idempotencyCheck,
  domainGuardsCheck,
  readme,
  contextMd,
  generatorDocs
];

// Normaliza el stack: defaults para lo que el diseño necesita y no fue elegido
// (p. ej. tests o scaffolding sin cuestionario), null para lo que no aplica.
export function resolveStack(stack, layers, manifest) {
  const protocol = layers.security?.authentication?.protocol;
  // Un motor que el catálogo no conoce se rechaza en voz alta. El caso real es un
  // `keel-stack.json` con un motor retirado —H2 lo estuvo hasta que se vio que tres de sus
  // mecanismos no se podían probar—: sin esto, `DATABASES[...]` sale `undefined`, el modelo
  // cae al `kind` relacional por defecto y el proyecto se genera a medias con la mitad de la
  // infraestructura sin resolver. Un fallo así aparece lejísimos de su causa.
  if (stack?.database && !DATABASES[stack.database]) {
    throw new Error(
      `El motor '${stack.database}' no está soportado. Los del catálogo son: ${Object.keys(DATABASES).join(', ')}. ` +
        `Si viene de un keel-stack.json anterior, elige uno de esos y vuelve a lanzar el build.`
    );
  }
  return {
    group: stack?.group ?? defaultGroup(manifest),
    // El default sigue al modelo que declara el diseño: sin esto, un diseño
    // `document` sin stack explícito (tests, scaffolding sin cuestionario)
    // generaría JPA en silencio contra una base que no lo entiende.
    database: layers.persistence
      ? (stack?.database ?? defaultDatabaseFor(layers.persistence?.default?.model))
      : null,
    broker: layers.messaging ? (stack?.broker ?? STACK_DEFAULTS.broker) : null,
    auth: protocol === 'oidc' || protocol === 'jwt' ? (stack?.auth ?? STACK_DEFAULTS.auth) : null,
    cache: designUsesCache(layers) ? (stack?.cache ?? STACK_DEFAULTS.cache) : null,
    storage: layers.storage ? (stack?.storage ?? STACK_DEFAULTS.storage) : null
  };
}

export function scaffoldService({ manifest, layers, workspace, force = false, stack = null, mode = null }) {
  const resolved = resolveStack(stack, layers, manifest);
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
  const outDir = path.join('services', model.service.projectName);

  const files = GENERATORS.flatMap((generator) => generator.generate(model));
  const projectDir = path.join(workspace, outDir);

  // Clasificar ANTES de escribir: es lo que separa «este archivo es mío y me he
  // quedado atrás» de «este lo escribió el agente». Con el booleano `force` a solas
  // las dos cosas se ven igual, y por eso hasta ahora un arreglo del generador no
  // podía llegar a un proyecto que ya existe sin destruir trabajo.
  const previous = readManifest(projectDir);
  const buckets = classifyGenerated(files, projectDir, previous);
  const alDia = new Set(buckets.alDia);
  const alDiaDigests = files
    .filter((entry) => alDia.has(entry.path.split(/[\\/]/).join('/')))
    .map((entry) => [entry.path.split(/[\\/]/).join('/'), digestOf(entry)]);

  // Qué se escribe en esta pasada, por modo. `check` no escribe nada; `refresh` pone
  // al día lo que es de build y nadie tocó; sin modo, el comportamiento de siempre.
  let only = null;
  if (mode === 'check') only = new Set();
  else if (mode === 'refresh') only = new Set([...buckets.nuevos, ...buckets.refrescables]);

  const { copied, skipped, digests } = writeFiles(files, projectDir, { force, only });

  // La versión nueva de lo que está en conflicto, para poder compararla con diff. Es
  // exactamente el trabajo que si no hay que hacer a mano: generar el proyecto en otro
  // sitio solo para ver qué cambió el generador en ESE archivo.
  if (mode === 'refresh' && buckets.conflictos.length > 0) {
    const enConflicto = new Set(buckets.conflictos);
    writeFiles(
      files.filter((entry) => enConflicto.has(entry.path.split(/[\\/]/).join('/'))),
      path.join(projectDir, REFRESH_DIR),
      { force: true }
    );
  }

  // El manifiesto se actualiza incluso en `check`, donde `digests` viene vacío: lo que
  // hace ahí es ADOPTAR lo que ya estaba, que es lo que da el aviso a los proyectos
  // anteriores al mecanismo sin tocarles un solo archivo.
  if (mode !== 'check') {
    writeManifest(
      projectDir,
      nextManifest({
        previous,
        generator: `keel-spring@${packageVersion()}`,
        // Lo escrito en esta pasada, MÁS lo que ya era byte a byte idéntico a lo que el
        // generador emite. Eso último importa para los proyectos que existían antes del
        // mecanismo: adoptarlo TODO los dejaba sin poder refrescar nunca —cada archivo
        // quedaba para siempre «sin registro»—, cuando ser idéntico a la salida del
        // generador es la prueba más fuerte que puede haber de que es suya. Lo que de
        // verdad no se puede atribuir es solo lo que ya difiere.
        escritas: [...digests, ...alDiaDigests],
        presentes: [...buckets.adoptados, ...buckets.refrescables, ...buckets.tuyos, ...buckets.conflictos]
      })
    );
  }


  return {
    outDir: outDir.split(path.sep).join('/'),
    copied,
    skipped,
    warnings: model.warnings,
    stack: model.stack,
    docs: model.docs,
    buckets
  };
}
